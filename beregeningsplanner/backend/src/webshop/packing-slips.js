// Pakbonnen van webshopbestellingen (punt 8): de pakbon als PDF (zonder prijzen, regels gesorteerd op magazijnlocatie
// zodat er in één ronde gepickt kan worden) en de lijst Te picken (bestellingen met status Nieuw die klaarstaan:
// bij online betalen alleen de betaalde). Eén bestelling of meer in één PDF ("Alles afdrukken"). Het afdrukken wordt
// vastgelegd bij de bestelling (`data.packingSlip`). Routes onder /api/admin/web-orders (recht beheer).
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { createPdf, wrap } = require('../verkoop/pdf');
const { assemblePdf } = require('./order-slips');

const DocText = require(path.join(FRONTEND_DIR, 'shared', 'doc-text.js'));

/** Hoogstens zoveel pakbonnen in één PDF. */
const MAX_SLIPS = 50;

let logoCache = null;
/**
 * Het standaardlogo (wit op navy), één keer van schijf gelezen.
 * @returns {Buffer} De PNG, of een lege buffer als het bestand ontbreekt.
 */
function defaultLogo() {
  if (!logoCache) {
    try { logoCache = fs.readFileSync(path.join(FRONTEND_DIR, 'shared', 'logo-white.png')); } catch { logoCache = Buffer.alloc(0); }
  }
  return logoCache;
}

/**
 * Zet een ISO-datum om naar de schrijfwijze van de documenttaal.
 * @param {string} iso Datum als ISO-tekst (alleen het datumdeel telt).
 * @param {string} language Documenttaal.
 * @returns {string} Bijv. "5-3-2026" (nl) of "05/03/2026" (en), of leeg.
 */
function dayOf(iso, language) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return '';
  return DocText.clean(language) === 'en' ? `${match[3]}/${match[2]}/${match[1]}` : `${Number(match[3])}-${Number(match[2])}-${match[1]}`;
}

/**
 * Aantal met hooguit twee decimalen en het decimaalteken van de documenttaal.
 * @param {*} quantity Het aantal.
 * @param {string} language Documenttaal.
 * @returns {string} Bijv. "2,5" (nl) of "2.5" (en).
 */
function quantityText(quantity, language) {
  const text = String(Math.round((Number(quantity) || 0) * 100) / 100);
  return DocText.clean(language) === 'en' ? text : text.replace('.', ',');
}

/**
 * Of de pakbon backorderkolommen krijgt (besteld, eerder geleverd, nu, backorder): er is al eerder geleverd of er blijft iets achter.
 * @param {object} order De bestelling, met `fulfilment` (web-orders.js withFulfilment).
 * @returns {boolean} true als er een deellevering of backorder is.
 */
function hasBackorderColumns(order) {
  return Boolean(order.fulfilment) && order.fulfilment.lines.some((entry) => entry.shipped > 0 || entry.backorder > 0);
}

/**
 * De regels van de pakbon: per orderregel naam, code, aantal en magazijnlocatie, gesorteerd op locatie (zonder locatie onderaan), dan naam.
 * Een regel in een verpakking toont erbij hoeveel basiseenheden dat zijn.
 * @param {object} order De bestelling (lines).
 * @param {Map<string, string>} locations De magazijnlocatie per artikel-id.
 * @returns {{ name: string, code: string, qty: number, unit: string, location: string, baseQty: number|null, ordered?: number, shipped?: number, backorder?: number, expected?: string }[]} De regels (met `fulfilment` van de bestelling ook besteld, eerder geleverd, backorder en verwachte datum).
 */
function slipLines(order, locations) {
  const plan = hasBackorderColumns(order) ? order.fulfilment.lines : null;
  const lines = (order.lines || []).map((line, index) => {
    const status = plan ? plan[index] : null;
    // Met backorderkolommen is `qty` wat nu wordt geleverd; zonder is het het bestelde aantal (alles gaat mee).
    const qty = status ? status.ready : Number(line.qty) || 0;
    return {
      name: String(line.name || line.code || '-'), code: String(line.code || ''), qty, unit: String(line.unit || ''),
      location: String((line.itemId && locations.get(String(line.itemId))) || ''),
      baseQty: line.stockPer ? Math.round(qty * Number(line.stockPer) * 100) / 100 : null,
      ...(status ? { ordered: status.ordered, shipped: status.shipped, backorder: status.backorder, expected: status.expected } : {}),
    };
  });
  return lines.sort((left, right) => (left.location && !right.location ? -1 : !left.location && right.location ? 1
    : left.location.localeCompare(right.location, 'nl', { numeric: true }) || left.name.localeCompare(right.name, 'nl')));
}

/**
 * Het afleveradres als regels tekst (leeg bij ophalen).
 * @param {object} order De bestelling (address, shipping).
 * @returns {string[]} De regels: straat, postcode en plaats, eventueel het land.
 */
function addressLines(order) {
  const address = order.address || {};
  if (!address.street && !address.city) return [];
  const country = address.country && address.country !== 'NL' ? address.country : '';
  return [address.street, [address.postcode, address.city].filter(Boolean).join(' '), country].filter(Boolean);
}

/**
 * Bestandsnaam van de pakbon van één bestelling, of van meerdere.
 * @param {object[]} orders De bestellingen.
 * @returns {string} Bijv. "Pakbon WEB2026-0001.pdf" of "Pakbonnen 2026-11-12.pdf".
 */
function slipFileName(orders) {
  const name = orders.length === 1 ? `Pakbon ${orders[0].number}` : `Pakbonnen ${new Date().toISOString().slice(0, 10)}`;
  return `${name}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * Maakt één PDF met een pakbon per bestelling (elke bestelling begint op een nieuwe pagina).
 * @param {object[]} orders De bestellingen (shapeFull van web-orders).
 * @param {{ profile?: object, colors?: object, logo?: Buffer|null, locations?: Map<string, string> }} [options] Bedrijfsprofiel, kleuren van het thema, logo (PNG) en de magazijnlocatie per artikel-id.
 * @returns {Buffer} De PDF.
 */
function packingSlipsPdf(orders, options = {}) {
  return packingSlipsPdfWithRanges(orders, options).buffer;
}

/**
 * Zoals packingSlipsPdf, maar met erbij welke pagina's bij welke bestelling horen (om er pakbonnen van klanten tussen te kunnen zetten).
 * @param {object[]} orders De bestellingen (shapeFull van web-orders).
 * @param {{ profile?: object, colors?: object, logo?: Buffer|null, locations?: Map<string, string> }} [options] Bedrijfsprofiel, kleuren van het thema, logo (PNG) en de magazijnlocatie per artikel-id.
 * @returns {{ buffer: Buffer, ranges: { orderId: string, first: number, last: number }[] }} De PDF en per bestelling de eerste en laatste pagina (vanaf 0).
 */
function packingSlipsPdfWithRanges(orders, { profile = {}, colors = {}, logo = null, locations = new Map() } = {}) {
  const company = profile || {};
  const palette = { navy: '#172f5e', green: '#19924f', greenSoft: '#e6f4ec', teal: '#2cb0c0', text: '#1d2733', muted: '#6b7785', line: '#d0d6de', ...colors };
  const pdf = createPdf({ title: DocText.text('nl', 'packing.title'), author: company.companyName || '' });
  const pageWidth = pdf.A4.width;
  const pageHeight = pdf.A4.height;
  const leftEdge = 42;
  const rightEdge = pageWidth - 42;
  const bottom = pageHeight - 64;
  const slipStarts = [];

  for (const order of orders) {
    const language = DocText.clean(order.language);
    /**
     * Een vaste tekst in de taal van deze bestelling.
     * @param {string} key Sleutel uit DocText.
     * @param {object} [values] Waarden voor {naam}.
     * @returns {string} De tekst.
     */
    const translate = (key, values) => DocText.text(language, key, values);
    const firstPage = pdf.pageCount;
    slipStarts.push({ firstPage, order, language });
    let top = 0;

    /**
     * Begint een pagina van deze pakbon: groot met bedrijfsgegevens op de eerste, smal met het bestelnummer op de vervolgpagina's.
     * @param {boolean} first Of het de eerste pagina van deze pakbon is.
     * @returns {void}
     */
    const header = (first) => {
      pdf.addPage();
      const headerHeight = first ? 92 : 52;
      pdf.rect(0, 0, pageWidth, headerHeight, { fill: palette.navy });
      const logoHeight = first ? 40 : 26;
      if (!pdf.image(logo || defaultLogo(), leftEdge, (headerHeight - logoHeight) / 2, logoHeight * (321 / 66), logoHeight)) {
        pdf.text(company.companyName, leftEdge, headerHeight / 2 - 8, { size: 16, bold: true, color: '#ffffff' });
      }
      if (first) {
        const lines = [...String(company.address || '').split(/\r?\n/), [company.phone, company.email].filter(Boolean).join(' · '), company.website].map((entry) => String(entry || '').trim()).filter(Boolean);
        let lineTop = 16;
        pdf.text(company.companyName, rightEdge, lineTop, { size: 10, bold: true, color: '#ffffff', align: 'right' });
        for (const addressLine of lines.slice(0, 5)) {
          lineTop += 12.5;
          pdf.text(addressLine, rightEdge, lineTop, { size: 8.5, color: '#ffffff', align: 'right' });
        }
      } else {
        pdf.text(`${translate('packing.title')} ${order.number} (${translate('packing.continued')})`, rightEdge, 20, { size: 10, bold: true, color: '#ffffff', align: 'right' });
      }
      top = headerHeight + 24;
    };
    header(true);

    // ---------- Afleveradres en bestelgegevens ----------
    const pickup = order.shipping && order.shipping.method === 'ophalen';
    const recipient = [order.customer && order.customer.company, order.customer && order.customer.name].filter(Boolean);
    const recipientLines = pickup ? [translate('packing.pickup')] : [...recipient, ...addressLines(order)];
    pdf.text(translate(pickup ? 'packing.customer' : 'packing.deliverTo'), leftEdge, top, { size: 8, color: palette.muted });
    let recipientTop = top + 12;
    recipientLines.slice(0, 7).forEach((entry, i) => {
      pdf.text(entry, leftEdge, recipientTop, { size: i === 0 ? 10.5 : 9.5, bold: i === 0 });
      recipientTop += i === 0 ? 14 : 12.5;
    });
    if (pickup) {
      for (const entry of recipient.slice(0, 2)) { pdf.text(entry, leftEdge, recipientTop, { size: 9.5 }); recipientTop += 12.5; }
    }
    const info = [
      [translate('packing.order'), order.number],
      [translate('packing.orderedOn'), dayOf(order.createdAt, language)],
      [translate('packing.shipping'), order.shipping ? order.shipping.label : ''],
      ...(order.customer && order.customer.phone ? [[translate('packing.phone'), order.customer.phone]] : []),
    ].filter((entry) => entry[1]);
    let infoTop = top;
    const infoLeft = 330;
    for (const [label, value] of info) {
      pdf.text(label, infoLeft, infoTop, { size: 9, color: palette.muted });
      const valueLines = wrap(value, rightEdge - infoLeft - 92, 9.5, true);
      valueLines.slice(0, 2).forEach((valueLine, i) => pdf.text(valueLine, infoLeft + 92, infoTop + i * 12, { size: 9.5, bold: true }));
      infoTop += 13 + (Math.min(valueLines.length, 2) - 1) * 12;
    }
    top = Math.max(recipientTop, infoTop) + 18;
    pdf.text(`${translate('packing.title')} ${order.number}`, leftEdge, top, { size: 18, bold: true, color: palette.navy });
    top += 30;

    // ---------- Regels ----------
    const extended = hasBackorderColumns(order);
    const col = { location: leftEdge + 4, article: leftEdge + 74, qty: rightEdge - 62, unit: rightEdge - 54 };
    // Met backorder: vier getallenkolommen (besteld, eerder, nu, backorder) in plaats van aantal en eenheid.
    const numbers = { ordered: rightEdge - 150, shipped: rightEdge - 100, now: rightEdge - 50, backorder: rightEdge };
    const articleWidth = extended ? numbers.ordered - col.article - 58 : col.qty - col.article - 34;
    /** Tekent de kop van de regeltabel. */
    const tableHead = () => {
      pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
      const headStyle = { size: 8.5, bold: true, color: palette.navy };
      pdf.text(translate('packing.location'), col.location, top + 5, headStyle);
      pdf.text(translate('packing.article'), col.article, top + 5, headStyle);
      if (extended) {
        pdf.text(translate('packing.ordered'), numbers.ordered, top + 5, { ...headStyle, align: 'right' });
        pdf.text(translate('packing.delivered'), numbers.shipped, top + 5, { ...headStyle, align: 'right' });
        pdf.text(translate('packing.now'), numbers.now, top + 5, { ...headStyle, align: 'right' });
        pdf.text(translate('packing.backorder'), numbers.backorder, top + 5, { ...headStyle, align: 'right' });
      } else {
        pdf.text(translate('packing.qty'), col.qty, top + 5, { ...headStyle, align: 'right' });
        pdf.text(translate('packing.unit'), col.unit, top + 5, headStyle);
      }
      top += 22;
    };
    tableHead();
    for (const line of slipLines(order, locations)) {
      const article = wrap(line.name, articleWidth, 9);
      const detail = [line.code, extended ? line.unit : '', line.baseQty !== null ? translate('packing.baseQty', { qty: quantityText(line.baseQty, language) }) : '',
        extended && line.backorder > 0 && line.expected ? translate('packing.expectedOn', { date: dayOf(line.expected, language) }) : ''].filter(Boolean).join(' · ');
      const rowHeight = article.length * 11.5 + (detail ? 10.5 : 0) + 5;
      if (top + rowHeight > bottom) { header(false); tableHead(); }
      pdf.text(line.location, col.location, top, { size: 9, bold: true });
      article.forEach((entry, i) => pdf.text(entry, col.article, top + i * 11.5, { size: 9 }));
      if (detail) pdf.text(detail, col.article, top + article.length * 11.5, { size: 7.5, color: palette.muted });
      if (extended) {
        pdf.text(quantityText(line.ordered, language), numbers.ordered, top, { size: 9, align: 'right' });
        pdf.text(quantityText(line.shipped, language), numbers.shipped, top, { size: 9, align: 'right', color: palette.muted });
        pdf.text(quantityText(line.qty, language), numbers.now, top, { size: 9, bold: true, align: 'right' });
        pdf.text(quantityText(line.backorder, language), numbers.backorder, top, { size: 9, bold: line.backorder > 0, align: 'right', color: line.backorder > 0 ? palette.navy : palette.muted });
      } else {
        pdf.text(quantityText(line.qty, language), col.qty, top, { size: 9, bold: true, align: 'right' });
        pdf.text(line.unit, col.unit, top, { size: 9 });
      }
      top += rowHeight;
      pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
    }

    if (extended && order.fulfilment.lines.some((entry) => entry.backorder > 0)) {
      top += 8;
      if (top + 28 > bottom) header(false);
      for (const noteLine of wrap(translate('packing.backorderNote'), rightEdge - leftEdge, 9)) {
        pdf.text(noteLine, leftEdge, top, { size: 9, color: palette.muted });
        top += 12;
      }
    }

    // ---------- Opmerking van de klant ----------
    if (order.note) {
      top += 8;
      if (top + 40 > bottom) header(false);
      pdf.text(translate('packing.note'), leftEdge, top, { size: 8, color: palette.muted });
      top += 12;
      for (const noteLine of wrap(order.note, rightEdge - leftEdge, 9.5)) {
        if (top + 14 > bottom) header(false);
        pdf.text(noteLine, leftEdge, top, { size: 9.5 });
        top += 13;
      }
    }
  }

  // Voetregel en paginanummer per pakbon (telt alleen de pagina's van die bestelling).
  const ranges = [];
  slipStarts.forEach((slip, index) => {
    const lastPage = (index + 1 < slipStarts.length ? slipStarts[index + 1].firstPage : pdf.pageCount) - 1;
    ranges.push({ orderId: slip.order.id, first: slip.firstPage, last: lastPage });
    const count = lastPage - slip.firstPage + 1;
    const foot = [company.companyName, company.kvk ? `KvK ${company.kvk}` : ''].filter(Boolean).join(' · ');
    for (let page = slip.firstPage; page <= lastPage; page++) {
      pdf.setPage(page);
      pdf.line(leftEdge, pageHeight - 46, rightEdge, pageHeight - 46, { color: palette.teal, width: 1.2 });
      pdf.text(foot, leftEdge, pageHeight - 38, { size: 7.5, color: palette.muted });
      if (count > 1) pdf.text(DocText.text(slip.language, 'packing.page', { page: page - slip.firstPage + 1, count }), rightEdge, pageHeight - 38, { size: 7.5, color: palette.muted, align: 'right' });
    }
  });
  return { buffer: pdf.toBuffer(), ranges };
}

/**
 * De bestelling zoals één zending hem op de pakbon zet: `fulfilment` krijgt per regel besteld, eerder geleverd, nu (deze zending) en wat er
 * daarna nog op backorder staat. Zo klopt de pakbon met wat de picker echt heeft gepickt, ook als dat minder was dan de berekende voorraad.
 * @param {object} order De bestelling (shapeFull) met regels en alle zendingen.
 * @param {{ lines: { index: number, qty: number }[] }} shipment De zending.
 * @param {Map<number, string>} expected De verwachte leverdatum per regelnummer (leeg als onbekend of niet meer open).
 * @returns {object} De bestelling met `fulfilment`.
 */
function orderForShipment(order, shipment, expected) {
  const nowByIndex = new Map(shipment.lines.map((entry) => [entry.index, Number(entry.qty) || 0]));
  const before = new Map();
  const position = order.shipments.findIndex((entry) => entry.id === shipment.id);
  for (const earlier of order.shipments.slice(0, Math.max(0, position))) {
    for (const entry of earlier.lines) before.set(entry.index, (before.get(entry.index) || 0) + (Number(entry.qty) || 0));
  }
  const lines = order.lines.map((line, index) => {
    const now = nowByIndex.get(index) || 0;
    const ordered = Number(line.qty) || 0;
    const shipped = before.get(index) || 0;
    const backorder = Math.max(0, Math.round((ordered - shipped - now) * 1000) / 1000);
    return { index, ordered, shipped, remaining: backorder + now, ready: now, backorder, expected: backorder > 0 ? expected.get(index) || '' : '' };
  });
  return { ...order, fulfilment: { lines, canShip: false, complete: lines.every((entry) => entry.backorder === 0), backorder: lines.some((entry) => entry.backorder > 0) } };
}

/**
 * Maakt de opslag en de routes voor pakbonnen.
 * @param {object} db De database.
 * @param {{ orders: object, slips: object, settingsFor: Function, colorsOf?: Function }} deps De bestellingen (web-orders.js), de pakbonnen van klanten bij dropshipping (order-slips.js), settingsFor(tenantId) en colorsOf(tenantId) = kleuren van het thema.
 * @returns {{ toPick: Function, pdfFor: Function }} De functies.
 */
function createPackingSlips(db, { orders, slips, settingsFor, colorsOf = () => ({}) }) {
  /**
   * De magazijnlocatie per artikel voor de regels van de bestellingen (één query).
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} list De bestellingen.
   * @returns {Map<string, string>} De locatie per artikel-id (alleen gevulde).
   */
  function locationsOf(tenantId, list) {
    const itemIds = Array.from(new Set(list.flatMap((order) => (order.lines || []).map((line) => line.itemId)).filter(Boolean).map(String)));
    const map = new Map();
    for (let start = 0; start < itemIds.length; start += 200) {
      const chunk = itemIds.slice(start, start + 200);
      const rows = db.prepare(`SELECT id, location FROM stock_items WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`).all(tenantId, ...chunk);
      for (const row of rows) if (row.location) map.set(String(row.id), String(row.location));
    }
    return map;
  }

  /**
   * De bestellingen die gepickt moeten worden, met per bestelling het aantal regels en stuks.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[], waitingForSlip: object[], waitingForStock: object[], truncated: boolean }} Per bestelling: id, nummer, klant, datum, verzendmethode, aantal regels, aantal stuks, opmerking, of het dropshipping is en of de pakbon al is afgedrukt; en de dropshippingbestellingen die nog op de pakbon van de klant wachten.
   */
  function toPick(tenantId) {
    const { items, truncated, waitingForSlip, waitingForStock } = orders.listToPick(tenantId);
    return { truncated, waitingForSlip, waitingForStock, items: items.map((order) => ({
      id: order.id, number: order.number, customerName: order.customerName, createdAt: order.createdAt,
      shippingLabel: order.shipping ? order.shipping.label : '', pickup: !!(order.shipping && order.shipping.method === 'ophalen'),
      lineCount: order.fulfilment.lines.filter((entry) => entry.ready > 0).length, pieces: order.fulfilment.lines.reduce((sum, entry) => sum + entry.ready, 0),
      partial: order.fulfilment.backorder, backorderReadyAt: order.backorderReadyAt || null, hadShipments: order.shipments.length > 0,
      note: order.note || '', dropshipping: !!order.dropshipping, printedAt: order.packingSlip ? order.packingSlip.printedAt : null, address: addressLines(order).join(', '),
    })) };
  }

  /**
   * Maakt één PDF met de pakbonnen van de gevraagde bestellingen en legt vast dat ze zijn afgedrukt. Bij een dropshippingbestelling
   * staat in plaats van onze pakbon de pakbon van de klant in de PDF (met het bestelnummer erop).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} ids Ids van de bestellingen (hoogstens MAX_SLIPS).
   * @param {{ markPrinted?: boolean, shipmentId?: string }} [options] Of het afdrukken wordt vastgelegd; met `shipmentId` (één bestelling) is het de pakbon van die zending, na het verzenden, met de aantallen die echt zijn gepickt.
   * @returns {Promise<{ pdf?: Buffer, fileName?: string, orders?: object[], error?: string, status?: number }>} De PDF of een foutmelding.
   */
  async function pdfFor(tenantId, ids, { markPrinted = true, shipmentId = '' } = {}) {
    if (!Array.isArray(ids) || !ids.length) return { error: 'Kies minstens één bestelling.', status: 400 };
    if (ids.length > MAX_SLIPS) return { error: `Hoogstens ${MAX_SLIPS} pakbonnen tegelijk.`, status: 400 };
    if (shipmentId && ids.length !== 1) return { error: 'Een zending hoort bij één bestelling.', status: 400 };
    let found = orders.withFulfilment(tenantId, orders.getMany(tenantId, ids).filter((order) => order.status !== 'geannuleerd'));
    if (shipmentId && found.length) {
      const shipment = found[0].shipments.find((entry) => entry.id === shipmentId);
      if (!shipment) return { error: 'Zending niet gevonden.', status: 404 };
      const expected = new Map(found[0].fulfilment ? found[0].fulfilment.lines.map((entry) => [entry.index, entry.expected]) : []);
      found = [orderForShipment(found[0], shipment, expected)];
    }
    if (!found.length) return { error: 'Geen bestelling gevonden om een pakbon van te maken.', status: 404 };
    // Een nieuwe online bestelling die nog niet betaald is wordt niet gepickt: geen pakbon tot de betaling binnen is.
    const unpaid = found.filter((order) => order.status === 'nieuw' && order.payment === 'online' && !(order.pay && order.pay.status === 'betaald'));
    if (unpaid.length) return { error: `Nog niet betaald, dus nog geen pakbon: ${unpaid.map((order) => order.number).join(', ')}.`, status: 409 };
    // Een open bestelling waar nu niets van leverbaar is (of niet alles, zonder deellevering) heeft nog geen pakbon: eerst voorraad.
    const waiting = shipmentId ? [] : found.filter((order) => order.status === 'nieuw' && order.fulfilment && !order.fulfilment.canShip);
    if (waiting.length) return { error: `Wacht op voorraad, dus nog geen pakbon: ${waiting.map((order) => order.number).join(', ')}.`, status: 409 };
    const dropshipped = found.filter((order) => order.dropshipping);
    const customerSlips = slips.readMany(tenantId, dropshipped.map((order) => order.id));
    const missing = dropshipped.filter((order) => !customerSlips.has(order.id));
    if (missing.length) return { error: `De klant heeft nog geen pakbon geüpload voor dropshipping: ${missing.map((order) => order.number).join(', ')}.`, status: 409 };
    const settings = settingsFor(tenantId);
    const ours = found.filter((order) => !order.dropshipping);
    const own = ours.length ? packingSlipsPdfWithRanges(ours, { profile: settings.get('quoteProfile'), colors: colorsOf(tenantId), locations: locationsOf(tenantId, ours) }) : null;
    let pdf = own ? own.buffer : null;
    if (dropshipped.length) {
      const rangeOf = new Map((own ? own.ranges : []).map((range) => [range.orderId, range]));
      const sequence = found.map((order) => (order.dropshipping
        ? { type: 'slip', bytes: customerSlips.get(order.id).bytes, label: `${order.number} - dropshipping` }
        : { type: 'ours', first: rangeOf.get(order.id).first, last: rangeOf.get(order.id).last }));
      pdf = await assemblePdf(sequence, own ? own.buffer : null);
    }
    if (markPrinted) orders.markPackingSlipsPrinted(tenantId, found.map((order) => order.id));
    return { pdf, fileName: slipFileName(found), orders: found };
  }

  return { toPick, pdfFor };
}

/**
 * Registreert de routes voor pakbonnen onder /api/admin/web-orders (het recht beheer wordt al door /api/admin afgedwongen).
 * @param {object} app De Express-app.
 * @param {{ slips: object, audit: Function, requireJson: Function }} deps De pakbonnen (createPackingSlips), het auditlogboek en de JSON-controle.
 * @returns {void}
 */
function registerPackingSlipRoutes(app, { slips, audit, requireJson }) {
  /**
   * Stuurt een PDF als download.
   * @param {object} res Het antwoord.
   * @param {{ pdf: Buffer, fileName: string }} out De PDF en de bestandsnaam.
   * @returns {void}
   */
  const sendPdf = (res, out) => {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${out.fileName.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
    res.send(out.pdf);
  };

  // Vóór /:id in web-orders.js: de lijst met te picken bestellingen.
  app.get('/api/admin/web-orders/to-pick', (req, res) => {
    res.json(slips.toPick(req.tenantId));
  });

  // Eén pakbon (opnieuw afdrukken telt ook). Een POST, want het afdrukken wordt vastgelegd.
  app.post('/api/admin/web-orders/:id/packing-slip', requireJson, async (req, res) => {
    const out = await slips.pdfFor(req.tenantId, [req.params.id]);
    if (out.error) return res.status(out.status || 400).json({ error: 'packing_slip_failed', message: out.error });
    audit(req, 'webshop_pakbon', { number: out.orders[0].number });
    sendPdf(res, out);
  });

  // Meerdere pakbonnen in één PDF (Alles afdrukken).
  app.post('/api/admin/web-orders/packing-slips', requireJson, async (req, res) => {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.filter((id) => typeof id === 'string').slice(0, 500) : [];
    const out = await slips.pdfFor(req.tenantId, ids);
    if (out.error) return res.status(out.status || 400).json({ error: 'packing_slip_failed', message: out.error });
    audit(req, 'webshop_pakbonnen', { count: out.orders.length });
    sendPdf(res, out);
  });
}

module.exports = { createPackingSlips, registerPackingSlipRoutes, packingSlipsPdf, slipLines, orderForShipment, MAX_SLIPS };
