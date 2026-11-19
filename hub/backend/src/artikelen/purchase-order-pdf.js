// De inkooporder als PDF voor de leverancier (bijlage bij de mail en download): kop uit de documentopmaak van de organisatie,
// leverancier en ordergegevens, regels met het artikelnummer van de leverancier, totaal excl. btw en de opmerking. Alleen Nederlands:
// leveranciers krijgen dit document, geen klanten (die hebben een documenttaal).
const { createPdf } = require('../verkoop/pdf');
const { sanitizeDocumentLayout, paletteOf, drawHeader, drawFooter } = require('../verkoop/document-layout');

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

/**
 * Bedrag in euro's in Nederlandse notatie.
 * @param {*} value Het bedrag.
 * @returns {string} Bijvoorbeeld "€ 12,50".
 */
const money = (value) => EUR.format(Number(value) || 0);

/**
 * Een aantal met hooguit drie decimalen en een komma.
 * @param {*} quantity Het aantal.
 * @returns {string} Bijvoorbeeld "2,5".
 */
const qtyText = (quantity) => String(Math.round((Number(quantity) || 0) * 1000) / 1000).replace('.', ',');

/**
 * Een ISO-datum als dag-maand-jaar.
 * @param {string} iso De datum of het tijdstip (alleen het datumdeel telt).
 * @returns {string} Bijvoorbeeld "5-3-2026", of leeg.
 */
const day = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${Number(match[3])}-${Number(match[2])}-${match[1]}` : '';
};

/**
 * De bestandsnaam van de PDF, bijvoorbeeld "Inkooporder IO2026-0001.pdf".
 * @param {{ number: string }} order De inkooporder.
 * @returns {string} De bestandsnaam zonder vreemde tekens.
 */
function purchaseOrderFileName(order) {
  return `Inkooporder ${order.number}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * Maakt de inkooporder als PDF.
 * @param {object} order De order zoals purchaseOrders.get() hem geeft (met regels).
 * @param {{ profile?: object, supplier?: object, colors?: object, layout?: object }} [options] Het bedrijfsprofiel (quoteProfile), de leverancier (naam, contactpersoon, adres), de themakleuren en de documentopmaak.
 * @returns {Buffer} De PDF.
 */
function purchaseOrderPdf(order, { profile = {}, supplier = {}, colors = {}, layout = null } = {}) {
  const company = profile || {};
  const documentLayout = sanitizeDocumentLayout(layout);
  const palette = paletteOf(documentLayout, colors);
  const pdf = createPdf({ title: `Inkooporder ${order.number}`, author: company.companyName || '', font: documentLayout.font });
  const { wrap } = pdf;
  const leftEdge = 42;
  const rightEdge = pdf.A4.width - 42;
  const bottom = pdf.A4.height - 64;
  let top = 0;

  /**
   * Begint een pagina met de kop uit de documentopmaak.
   * @param {boolean} first Of het de eerste pagina is.
   * @returns {void}
   */
  function header(first) {
    pdf.addPage();
    top = drawHeader(pdf, documentLayout, { palette, company, first, continuedTitle: `Inkooporder ${order.number} (vervolg)` }) + 24;
  }
  header(true);

  const recipientLines = [supplier.contactName ? `t.a.v. ${supplier.contactName}` : '', ...String(supplier.address || '').split(/\r?\n/)].map((entry) => entry.trim()).filter(Boolean);
  pdf.text('Aan', leftEdge, top, { size: 8, color: palette.muted });
  pdf.text(supplier.name || order.supplierName || '', leftEdge, top + 12, { size: 10.5, bold: true });
  let recipientY = top + 26;
  for (const recipientLine of recipientLines.slice(0, 6)) { pdf.text(recipientLine, leftEdge, recipientY, { size: 9.5 }); recipientY += 12.5; }
  const info = [
    ['Ordernummer', order.number],
    ['Datum', day(order.orderedAt || order.createdAt)],
    ...(order.expectedDate ? [['Gewenste levering', day(order.expectedDate)]] : []),
    ...(order.supplierReference ? [['Uw referentie', order.supplierReference]] : []),
  ];
  let infoY = top;
  const infoX = 330;
  for (const [label, value] of info) {
    pdf.text(label, infoX, infoY, { size: 9, color: palette.muted });
    const valueLines = wrap(value, rightEdge - infoX - 92, 9.5, true);
    valueLines.slice(0, 2).forEach((valueLine, index) => pdf.text(valueLine, infoX + 92, infoY + index * 12, { size: 9.5, bold: true }));
    infoY += 13 + (Math.min(valueLines.length, 2) - 1) * 12;
  }
  top = Math.max(recipientY, infoY) + 18;
  pdf.text(`Inkooporder ${order.number}`, leftEdge, top, { size: 18, bold: true, color: palette.navy });
  top += 30;

  const col = { sku: leftEdge + 4, desc: leftEdge + 96, qty: 425, price: 490, total: rightEdge - 4 };
  const descWidth = 360 - col.desc;
  /** Tekent de kop van de regeltabel. */
  function tableHead() {
    pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
    const headStyle = { size: 8.5, bold: true, color: palette.navy };
    pdf.text('Uw art.nr.', col.sku, top + 5, headStyle);
    pdf.text('Omschrijving', col.desc, top + 5, headStyle);
    pdf.text('Aantal', col.qty, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Prijs', col.price, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Bedrag', col.total, top + 5, { ...headStyle, align: 'right' });
    top += 22;
  }
  tableHead();
  let total = 0;
  let unpriced = false;
  for (const orderLine of order.lines) {
    const description = wrap(`${orderLine.name}${orderLine.code ? ` (${orderLine.code})` : ''}`, descWidth, 9);
    const rowHeight = description.length * 11.5 + 5;
    if (top + rowHeight > bottom) { header(false); tableHead(); }
    const priced = orderLine.unitCost !== null && orderLine.unitCost !== undefined;
    const amount = priced ? orderLine.qty * orderLine.unitCost : 0;
    if (priced) total += amount; else unpriced = true;
    pdf.text(orderLine.supplierSku || '', col.sku, top, { size: 9 });
    description.forEach((entry, index) => pdf.text(entry, col.desc, top + index * 11.5, { size: 9 }));
    pdf.text(`${qtyText(orderLine.qty)} ${orderLine.unit || ''}`.trim(), col.qty, top, { size: 9, align: 'right' });
    pdf.text(priced ? money(orderLine.unitCost) : '', col.price, top, { size: 9, align: 'right' });
    pdf.text(priced ? money(amount) : '', col.total, top, { size: 9, align: 'right' });
    top += rowHeight;
    pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
  }
  top += 8;
  if (top + 40 > bottom) header(false);
  pdf.line(330, top, rightEdge, top, { color: palette.navy, width: 1.4 });
  top += 6;
  pdf.text('Totaal excl. btw', 330, top, { size: 11, bold: true });
  pdf.text(money(total), col.total, top, { size: 11, bold: true, align: 'right' });
  top += 18;
  if (unpriced) {
    pdf.text('Regels zonder prijs: graag uw actuele prijs vermelden op de orderbevestiging.', leftEdge, top, { size: 8.5, color: palette.muted });
    top += 18;
  }
  if (order.notes) {
    top += 6;
    for (const noteLine of wrap(order.notes, rightEdge - leftEdge, 9.5)) {
      if (top + 14 > bottom) header(false);
      pdf.text(noteLine, leftEdge, top, { size: 9.5 });
      top += 13;
    }
  }

  const companyLine = [company.companyName, company.kvk ? `KvK ${company.kvk}` : '', company.vatNumber ? `BTW ${company.vatNumber}` : ''].filter(Boolean).join(' · ');
  const count = pdf.pageCount;
  for (let index = 0; index < count; index++) {
    pdf.setPage(index);
    drawFooter(pdf, documentLayout, { palette, companyLine, pageLabel: count > 1 ? `Pagina ${index + 1} van ${count}` : '' });
  }
  return pdf.toBuffer();
}

module.exports = { purchaseOrderPdf, purchaseOrderFileName };
