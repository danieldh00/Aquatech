// Pakbonnen van webshopbestellingen (punt 8): de pakbon als PDF (zonder prijzen, regels gesorteerd op magazijnlocatie
// zodat er in één ronde gepickt kan worden) en de lijst Te picken (bestellingen met status Nieuw die klaarstaan:
// bij online betalen alleen de betaalde). Eén bestelling of meer in één PDF ("Alles afdrukken"). Het afdrukken wordt
// vastgelegd bij de bestelling (`data.packingSlip`). Routes onder /api/admin/web-orders (recht beheer).
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { createPdf, wrap } = require('../verkoop/pdf');

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
 * De regels van de pakbon: per orderregel naam, code, aantal en magazijnlocatie, gesorteerd op locatie (zonder locatie onderaan), dan naam.
 * Een regel in een verpakking toont erbij hoeveel basiseenheden dat zijn.
 * @param {object} order De bestelling (lines).
 * @param {Map<string, string>} locations De magazijnlocatie per artikel-id.
 * @returns {{ name: string, code: string, qty: number, unit: string, location: string, baseQty: number|null }[]} De regels.
 */
function slipLines(order, locations) {
  const lines = (order.lines || []).map((line) => ({
    name: String(line.name || line.code || '-'), code: String(line.code || ''), qty: Number(line.qty) || 0, unit: String(line.unit || ''),
    location: String((line.itemId && locations.get(String(line.itemId))) || ''),
    baseQty: line.stockPer ? Math.round((Number(line.qty) || 0) * Number(line.stockPer) * 100) / 100 : null,
  }));
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
function packingSlipsPdf(orders, { profile = {}, colors = {}, logo = null, locations = new Map() } = {}) {
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
    const col = { location: leftEdge + 4, article: leftEdge + 74, qty: rightEdge - 62, unit: rightEdge - 54 };
    const articleWidth = col.qty - col.article - 34;
    /** Tekent de kop van de regeltabel. */
    const tableHead = () => {
      pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
      const headStyle = { size: 8.5, bold: true, color: palette.navy };
      pdf.text(translate('packing.location'), col.location, top + 5, headStyle);
      pdf.text(translate('packing.article'), col.article, top + 5, headStyle);
      pdf.text(translate('packing.qty'), col.qty, top + 5, { ...headStyle, align: 'right' });
      pdf.text(translate('packing.unit'), col.unit, top + 5, headStyle);
      top += 22;
    };
    tableHead();
    for (const line of slipLines(order, locations)) {
      const article = wrap(line.name, articleWidth, 9);
      const detail = [line.code, line.baseQty !== null ? translate('packing.baseQty', { qty: quantityText(line.baseQty, language) }) : ''].filter(Boolean).join(' · ');
      const rowHeight = article.length * 11.5 + (detail ? 10.5 : 0) + 5;
      if (top + rowHeight > bottom) { header(false); tableHead(); }
      pdf.text(line.location, col.location, top, { size: 9, bold: true });
      article.forEach((entry, i) => pdf.text(entry, col.article, top + i * 11.5, { size: 9 }));
      if (detail) pdf.text(detail, col.article, top + article.length * 11.5, { size: 7.5, color: palette.muted });
      pdf.text(quantityText(line.qty, language), col.qty, top, { size: 9, bold: true, align: 'right' });
      pdf.text(line.unit, col.unit, top, { size: 9 });
      top += rowHeight;
      pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
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
  slipStarts.forEach((slip, index) => {
    const lastPage = (index + 1 < slipStarts.length ? slipStarts[index + 1].firstPage : pdf.pageCount) - 1;
    const count = lastPage - slip.firstPage + 1;
    const foot = [company.companyName, company.kvk ? `KvK ${company.kvk}` : ''].filter(Boolean).join(' · ');
    for (let page = slip.firstPage; page <= lastPage; page++) {
      pdf.setPage(page);
      pdf.line(leftEdge, pageHeight - 46, rightEdge, pageHeight - 46, { color: palette.teal, width: 1.2 });
      pdf.text(foot, leftEdge, pageHeight - 38, { size: 7.5, color: palette.muted });
      if (count > 1) pdf.text(DocText.text(slip.language, 'packing.page', { page: page - slip.firstPage + 1, count }), rightEdge, pageHeight - 38, { size: 7.5, color: palette.muted, align: 'right' });
    }
  });
  return pdf.toBuffer();
}

/**
 * Maakt de opslag en de routes voor pakbonnen.
 * @param {object} db De database.
 * @param {{ orders: object, settingsFor: Function, colorsOf?: Function }} deps De bestellingen (web-orders.js), settingsFor(tenantId) en colorsOf(tenantId) = kleuren van het thema.
 * @returns {{ toPick: Function, pdfFor: Function }} De functies.
 */
function createPackingSlips(db, { orders, settingsFor, colorsOf = () => ({}) }) {
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
   * @returns {object[]} Per bestelling: id, nummer, klant, datum, verzendmethode, aantal regels, aantal stuks, opmerking en of de pakbon al is afgedrukt.
   */
  function toPick(tenantId) {
    return orders.listToPick(tenantId).map((order) => ({
      id: order.id, number: order.number, customerName: order.customerName, createdAt: order.createdAt,
      shippingLabel: order.shipping ? order.shipping.label : '', pickup: !!(order.shipping && order.shipping.method === 'ophalen'),
      lineCount: order.lines.length, pieces: order.lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0),
      note: order.note || '', printedAt: order.packingSlip ? order.packingSlip.printedAt : null, address: addressLines(order).join(', '),
    }));
  }

  /**
   * Maakt één PDF met de pakbonnen van de gevraagde bestellingen en legt vast dat ze zijn afgedrukt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} ids Ids van de bestellingen (hoogstens MAX_SLIPS).
   * @param {{ markPrinted?: boolean, user?: object|null }} [options] Of het afdrukken wordt vastgelegd en door wie.
   * @returns {{ pdf?: Buffer, fileName?: string, orders?: object[], error?: string, status?: number }} De PDF of een foutmelding.
   */
  function pdfFor(tenantId, ids, { markPrinted = true, user = null } = {}) {
    if (!Array.isArray(ids) || !ids.length) return { error: 'Kies minstens één bestelling.', status: 400 };
    if (ids.length > MAX_SLIPS) return { error: `Hoogstens ${MAX_SLIPS} pakbonnen tegelijk.`, status: 400 };
    const found = orders.getMany(tenantId, ids).filter((order) => order.status !== 'geannuleerd');
    if (!found.length) return { error: 'Geen bestelling gevonden om een pakbon van te maken.', status: 404 };
    const settings = settingsFor(tenantId);
    const pdf = packingSlipsPdf(found, { profile: settings.get('quoteProfile'), colors: colorsOf(tenantId), locations: locationsOf(tenantId, found) });
    if (markPrinted) orders.markPackingSlipsPrinted(tenantId, found.map((order) => order.id), user ? user.display_name || user.displayName || '' : '');
    return { pdf, fileName: slipFileName(found), orders: found };
  }

  return { toPick, pdfFor };
}

/**
 * Registreert de routes voor pakbonnen onder /api/admin/web-orders (het recht beheer wordt al door /api/admin afgedwongen).
 * @param {object} app De Express-app.
 * @param {{ slips: object, audit: Function, requireJson: Function }} deps De pakbonopslag, het auditlogboek en de JSON-controle.
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
    res.json({ items: slips.toPick(req.tenantId) });
  });

  // Eén pakbon (opnieuw afdrukken telt ook). Een POST, want het afdrukken wordt vastgelegd.
  app.post('/api/admin/web-orders/:id/packing-slip', requireJson, (req, res) => {
    const out = slips.pdfFor(req.tenantId, [req.params.id], { user: req.user });
    if (out.error) return res.status(out.status || 400).json({ error: 'packing_slip_failed', message: out.error });
    audit(req, 'webshop_pakbon', { number: out.orders[0].number });
    sendPdf(res, out);
  });

  // Meerdere pakbonnen in één PDF (Alles afdrukken).
  app.post('/api/admin/web-orders/packing-slips', requireJson, (req, res) => {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.filter((id) => typeof id === 'string').slice(0, 500) : [];
    const out = slips.pdfFor(req.tenantId, ids, { user: req.user });
    if (out.error) return res.status(out.status || 400).json({ error: 'packing_slip_failed', message: out.error });
    audit(req, 'webshop_pakbonnen', { count: out.orders.length });
    sendPdf(res, out);
  });
}

module.exports = { createPackingSlips, registerPackingSlipRoutes, packingSlipsPdf, slipLines, MAX_SLIPS };
