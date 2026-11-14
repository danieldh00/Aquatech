// De factuur als PDF (bijlage bij de e-mail en downloaden), in dezelfde opzet
// als de afdrukversie in frontend/facturen/facturen.js (documentHtml): kop
// met logo en bedrijfsgegevens, klant en factuurgegevens, regels, totalen,
// betaaltekst en een voetregel met KvK, btw en IBAN. Kleuren uit het
// kleurthema van de organisatie.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { createPdf, textWidth } = require('./pdf');
const { sanitizeDocumentLayout, paletteOf, drawHeader, drawFooter } = require('./document-layout');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));
const DocText = require(path.join(FRONTEND_DIR, 'shared', 'doc-text.js'));

const EUR = { nl: new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }), en: new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }) };
/**
 * Bedrag in euro's in de notatie van de documenttaal.
 * @param {*} value Het bedrag.
 * @param {string} [language] Documenttaal ('nl' of 'en').
 * @returns {string} Bijv. "€ 12,50" (nl) of "€12.50" (en).
 */
const eur = (value, language) => EUR[DocText.clean(language)].format(Number(value) || 0);
/**
 * Zet een ISO-datum om naar de schrijfwijze van de documenttaal.
 * @param {string} iso Datum als ISO-tekst (alleen het datumdeel telt).
 * @param {string} [language] Documenttaal.
 * @returns {string} Bijv. "5-3-2026" (nl) of "05/03/2026" (en), of leeg.
 */
const day = (iso, language) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return '';
  return DocText.clean(language) === 'en' ? `${match[3]}/${match[2]}/${match[1]}` : `${Number(match[3])}-${Number(match[2])}-${match[1]}`;
};
/**
 * Aantal met hooguit twee decimalen en de decimaalteken van de documenttaal.
 * @param {*} quantity Het aantal.
 * @param {string} [language] Documenttaal.
 * @returns {string} Bijv. "2,5" (nl) of "2.5" (en).
 */
const qtyText = (quantity, language) => {
  const text = String(Math.round((Number(quantity) || 0) * 100) / 100);
  return DocText.clean(language) === 'en' ? text : text.replace('.', ',');
};

/**
 * Bestandsnaam van de PDF, bijv. "Factuur F2026-0001.pdf".
 * @param {object} invoice De factuur.
 * @returns {string} De bestandsnaam zonder vreemde tekens.
 */
function invoiceFileName(invoice) {
  const kind = DocText.text(invoice.data && invoice.data.language, invoice.kind === 'credit' ? 'invoice.credit' : 'invoice.title');
  return `${kind} ${invoice.number || 'concept'}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * Maakt de factuur als PDF.
 * @param {object} invoice De factuur zoals invoices.get() hem geeft (met data).
 * @param {object} [options] profile (bedrijfsprofiel), settings (factuurinstellingen), colors ({ navy, green, greenSoft, teal }) en layout (documentopmaak van de organisatie, zie document-layout.js).
 * @returns {Buffer} De PDF.
 */
function invoicePdf(invoice, { profile = {}, settings = null, colors = {}, layout = null } = {}) {
  const company = profile || {};
  const invoicing = settings && settings.categories ? settings : Core.sanitizeSettings(settings);
  const documentLayout = sanitizeDocumentLayout(layout);
  const palette = paletteOf(documentLayout, colors);
  const details = invoice.data;
  const totals = Core.totals(details, invoicing);
  const credit = invoice.kind === 'credit';
  const lang = DocText.clean(details.language);
  /**
   * Een vaste tekst in de taal van het document.
   * @param {string} key Sleutel uit DocText.
   * @param {object} [values] Waarden voor {naam}.
   * @returns {string} De tekst.
   */
  const translate = (key, values) => DocText.text(lang, key, values);
  /**
   * Bedrag in de notatie van de documenttaal.
   * @param {*} value Het bedrag.
   * @returns {string} Het bedrag als tekst.
   */
  const money = (value) => eur(value, lang);
  const kind = translate(credit ? 'invoice.credit' : 'invoice.title');
  const pdf = createPdf({ title: `${kind} ${invoice.number || translate('invoice.draft')}`, author: company.companyName || '', font: documentLayout.font });
  const { wrap } = pdf;
  const pageWidth = pdf.A4.width;
  const pageHeight = pdf.A4.height;
  const leftEdge = 42;
  const rightEdge = pageWidth - 42;
  const BOTTOM = pageHeight - 64;
  let top = 0;

  // ---------- Kop ----------
  /**
   * Begint een pagina met de kop uit de documentopmaak: groot met adres op de eerste pagina, smal met het factuurnummer op de vervolgpagina's.
   * @param {boolean} first Of het de eerste pagina is.
   */
  function header(first) {
    pdf.addPage();
    const continuedTitle = `${kind} ${invoice.number || `(${translate('invoice.draft')})`} (${translate('invoice.continued')})`;
    top = drawHeader(pdf, documentLayout, { palette, company, first, continuedTitle }) + 24;
  }
  header(true);

  // ---------- Klant en factuurgegevens ----------
  const recipientLines = [details.customer.contact ? `${translate('invoice.attn')} ${details.customer.contact}` : '', ...String(details.customer.address || '').split(/\r?\n/)].map((x) => x.trim()).filter(Boolean);
  pdf.text(translate('invoice.to'), leftEdge, top, { size: 8, color: palette.muted });
  pdf.text(details.customer.name, leftEdge, top + 12, { size: 10.5, bold: true });
  let recipientY = top + 26;
  for (const recipientLine of recipientLines.slice(0, 6)) { pdf.text(recipientLine, leftEdge, recipientY, { size: 9.5 }); recipientY += 12.5; }
  const info = [
    [translate(credit ? 'invoice.creditNumber' : 'invoice.numberLabel'), invoice.number || translate('invoice.concept')],
    [translate('invoice.dateLabel'), day(details.date, lang)],
    ...(credit ? [[translate('invoice.creditOf'), details.creditOfNumber]] : [[translate('invoice.dueDate'), day(details.dueDate, lang)]]),
    ...(invoice.debtorNumber ? [[translate('invoice.debtor'), String(invoice.debtorNumber)]] : []),
    ...(details.workOrderNumber ? [[translate('invoice.workOrder'), details.workOrderNumber]] : []),
    ...(details.reference ? [[translate('invoice.about'), details.reference]] : []),
    ...(details.customer.vatNumber ? [[translate('invoice.customerVat'), details.customer.vatNumber]] : []),
  ];
  let infoY = top;
  const infoX = 330;
  for (const [label, value] of info) {
    pdf.text(label, infoX, infoY, { size: 9, color: palette.muted });
    const valueLines = wrap(value, rightEdge - infoX - 92, 9.5, true);
    valueLines.slice(0, 2).forEach((valueLine, i) => pdf.text(valueLine, infoX + 92, infoY + i * 12, { size: 9.5, bold: true }));
    infoY += 13 + (Math.min(valueLines.length, 2) - 1) * 12;
  }
  top = Math.max(recipientY, infoY) + 18;

  pdf.text(`${kind}${invoice.number ? ` ${invoice.number}` : ` (${translate('invoice.draft')})`}`, leftEdge, top, { size: 18, bold: true, color: credit ? palette.teal : palette.navy });
  top += 30;
  /**
   * Schrijft een alinea met regelafbreking; begint zo nodig een nieuwe pagina.
   * @param {string} text De tekst.
   * @param {number} [size] Lettergrootte.
   * @param {string} [color] Tekstkleur.
   */
  const paragraph = (text, size = 9.5, color = palette.text) => {
    for (const wrappedLine of wrap(text, rightEdge - leftEdge, size)) {
      if (top + size * 1.4 > BOTTOM) header(false);
      pdf.text(wrappedLine, leftEdge, top, { size, color });
      top += size * 1.4;
    }
    top += 6;
  };
  if (details.intro) paragraph(details.intro);

  // ---------- Regels ----------
  const col = { desc: leftEdge + 4, qty: 352, unit: 358, price: 448, vat: 488, total: rightEdge - 4 };
  const descW = 340 - leftEdge - 8;
  /** Tekent de kop van de regeltabel. */
  function tableHead() {
    pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
    const headStyle = { size: 8.5, bold: true, color: palette.navy };
    pdf.text(translate('col.description'), col.desc, top + 5, headStyle);
    pdf.text(translate('col.qty'), col.qty, top + 5, { ...headStyle, align: 'right' });
    pdf.text(translate('col.unit'), col.unit, top + 5, headStyle);
    pdf.text(translate('col.price'), col.price, top + 5, { ...headStyle, align: 'right' });
    pdf.text(translate('col.vat'), col.vat, top + 5, { ...headStyle, align: 'right' });
    pdf.text(translate('col.amount'), col.total, top + 5, { ...headStyle, align: 'right' });
    top += 22;
  }
  tableHead();
  for (const invoiceLine of details.lines) {
    const desc = wrap(`${invoiceLine.description || ''}${invoiceLine.code ? ` (${invoiceLine.code})` : ''}`, descW, 9);
    const rowHeight = desc.length * 11.5 + 5;
    if (top + rowHeight > BOTTOM) { header(false); tableHead(); }
    desc.forEach((x, i) => pdf.text(x, col.desc, top + i * 11.5, { size: 9 }));
    pdf.text(qtyText(invoiceLine.qty, lang), col.qty, top, { size: 9, align: 'right' });
    pdf.text(invoiceLine.unit, col.unit, top, { size: 9 });
    pdf.text(money(invoiceLine.price), col.price, top, { size: 9, align: 'right' });
    pdf.text(`${invoiceLine.vat}%`, col.vat, top, { size: 9, align: 'right' });
    pdf.text(money(Core.lineTotal(invoiceLine)), col.total, top, { size: 9, align: 'right' });
    top += rowHeight;
    pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
  }
  top += 8;

  // ---------- Totalen ----------
  const rows = [
    [translate('invoice.subtotal'), money(totals.subtotal)],
    ...(totals.discount ? [[Core.discountCaption(totals, translate('invoice.discount'), qtyText(totals.discountPct, lang)), `- ${money(totals.discount)}`]] : []),
    ...totals.vat.map((vatGroup) => [translate('invoice.vatOver', { rate: vatGroup.rate, base: money(vatGroup.base) }), money(vatGroup.amount)]),
  ];
  if (top + rows.length * 14 + 30 > BOTTOM) header(false);
  const totalsX = 330;
  for (const [label, amount] of rows) {
    pdf.text(label, totalsX, top, { size: 9.5 });
    pdf.text(amount, col.total, top, { size: 9.5, align: 'right' });
    top += 14;
  }
  pdf.line(totalsX, top, rightEdge, top, { color: palette.navy, width: 1.4 });
  top += 6;
  pdf.text(translate('invoice.total'), totalsX, top, { size: 11, bold: true });
  pdf.text(money(totals.total), col.total, top, { size: 11, bold: true, align: 'right' });
  top += 28;

  if (details.notes) paragraph(details.notes);
  const pay = invoice.status === 'betaald'
    ? translate('invoice.paid', { when: invoice.paidAt ? translate('invoice.paidOn', { date: day(invoice.paidAt, lang) }) : '' })
    : !credit ? Core.paymentText(invoicing, { number: invoice.number, iban: company.iban, dueDate: day(details.dueDate, lang), days: details.paymentDays, language: lang }) : '';
  if (pay) {
    const payLines = wrap(pay, rightEdge - leftEdge - 24, 9.5);
    const payHeight = payLines.length * 13 + 14;
    if (top + payHeight > BOTTOM) header(false);
    pdf.rect(leftEdge, top, rightEdge - leftEdge, payHeight, { fill: palette.greenSoft });
    pdf.rect(leftEdge, top, 3, payHeight, { fill: palette.green });
    payLines.forEach((x, i) => pdf.text(x, leftEdge + 14, top + 8 + i * 13, { size: 9.5 }));
    top += payHeight + 14;
  }
  if (invoicing.footer) paragraph(invoicing.footer, 8, palette.muted);

  // ---------- Voet op elke pagina ----------
  const companyLine = [company.companyName, company.kvk ? `KvK ${company.kvk}` : '', company.vatNumber ? `${translate('col.vat')} ${company.vatNumber}` : '', company.iban ? `IBAN ${company.iban}` : ''].filter(Boolean).join(' · ');
  const count = pdf.pageCount;
  for (let i = 0; i < count; i++) {
    pdf.setPage(i);
    drawFooter(pdf, documentLayout, { palette, companyLine, pageLabel: count > 1 ? translate('invoice.page', { page: i + 1, count }) : '' });
  }
  return pdf.toBuffer();
}

module.exports = { invoicePdf, invoiceFileName, textWidth, eur, day };
