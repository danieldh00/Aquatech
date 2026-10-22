// De factuur als PDF (bijlage bij de e-mail en downloaden), in dezelfde opzet
// als de afdrukversie in frontend/facturen/facturen.js (documentHtml): kop
// met logo en bedrijfsgegevens, klant en factuurgegevens, regels, totalen,
// betaaltekst en een voetregel met KvK, btw en IBAN. Kleuren uit het
// kleurthema van de organisatie.
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { createPdf, wrap, textWidth } = require('./pdf');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

let logoCache = null;
/**
 * Het standaardlogo (wit op navy), één keer van schijf gelezen.
 * @returns {Buffer} De PNG, of een lege buffer als het bestand ontbreekt.
 */
const defaultLogo = () => {
  if (!logoCache) {
    try { logoCache = fs.readFileSync(path.join(FRONTEND_DIR, 'shared', 'logo-white.png')); } catch { logoCache = Buffer.alloc(0); }
  }
  return logoCache;
};

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
/**
 * Bedrag in euro's.
 * @param {*} value Het bedrag.
 * @returns {string} Bijv. "€ 12,50".
 */
const eur = (value) => EUR.format(Number(value) || 0);
/**
 * Zet een ISO-datum om naar de Nederlandse schrijfwijze.
 * @param {string} iso Datum als ISO-tekst (alleen het datumdeel telt).
 * @returns {string} Bijv. "5-3-2026", of leeg.
 */
const day = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${Number(match[3])}-${Number(match[2])}-${match[1]}` : '';
};
/**
 * Aantal met hooguit twee decimalen en een komma.
 * @param {*} quantity Het aantal.
 * @returns {string} Bijv. "2,5".
 */
const qtyText = (quantity) => String(Math.round((Number(quantity) || 0) * 100) / 100).replace('.', ',');

/**
 * Bestandsnaam van de PDF, bijv. "Factuur F2026-0001.pdf".
 * @param {object} invoice De factuur.
 * @returns {string} De bestandsnaam zonder vreemde tekens.
 */
function invoiceFileName(invoice) {
  const kind = invoice.kind === 'credit' ? 'Creditfactuur' : 'Factuur';
  return `${kind} ${invoice.number || 'concept'}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * Maakt de factuur als PDF.
 * @param {object} invoice De factuur zoals invoices.get() hem geeft (met data).
 * @param {object} [options] profile (bedrijfsprofiel), settings (factuurinstellingen), colors ({ navy, green, greenSoft, teal }) en logo (PNG-buffer).
 * @returns {Buffer} De PDF.
 */
function invoicePdf(invoice, { profile = {}, settings = null, colors = {}, logo = null } = {}) {
  const company = profile || {};
  const invoicing = settings && settings.categories ? settings : Core.sanitizeSettings(settings);
  const palette = { navy: '#172f5e', green: '#19924f', greenSoft: '#e6f4ec', teal: '#2cb0c0', text: '#1d2733', muted: '#6b7785', line: '#d0d6de', ...colors };
  const details = invoice.data;
  const totals = Core.totals(details, invoicing);
  const credit = invoice.kind === 'credit';
  const kind = credit ? 'Creditfactuur' : 'Factuur';
  const pdf = createPdf({ title: `${kind} ${invoice.number || 'concept'}`, author: company.companyName || '' });
  const pageWidth = pdf.A4.width;
  const pageHeight = pdf.A4.height;
  const leftEdge = 42;
  const rightEdge = pageWidth - 42;
  const BOTTOM = pageHeight - 64;
  let top = 0;

  // ---------- Kop ----------
  /**
   * Tekent de kop van een pagina: groot met adres op de eerste pagina, smal met het factuurnummer op de vervolgpagina's.
   * @param {boolean} first Of het de eerste pagina is.
   */
  function header(first) {
    pdf.addPage();
    const headerHeight = first ? 92 : 52;
    pdf.rect(0, 0, pageWidth, headerHeight, { fill: palette.navy });
    const logoH = first ? 40 : 26;
    if (!pdf.image(logo || defaultLogo(), leftEdge, (headerHeight - logoH) / 2, logoH * (321 / 66), logoH)) {
      pdf.text(company.companyName, leftEdge, headerHeight / 2 - 8, { size: 16, bold: true, color: '#ffffff' });
    }
    if (first) {
      const lines = [...String(company.address || '').split(/\r?\n/), [company.phone, company.email].filter(Boolean).join(' · '), company.website].map((x) => String(x || '').trim()).filter(Boolean);
      let lineY = 16;
      pdf.text(company.companyName, rightEdge, lineY, { size: 10, bold: true, color: '#ffffff', align: 'right' });
      for (const addressLine of lines.slice(0, 5)) {
        lineY += 12.5;
        pdf.text(addressLine, rightEdge, lineY, { size: 8.5, color: '#ffffff', align: 'right' });
      }
    } else {
      pdf.text(`${kind} ${invoice.number || '(concept)'} (vervolg)`, rightEdge, 20, { size: 10, bold: true, color: '#ffffff', align: 'right' });
    }
    top = headerHeight + 24;
  }
  header(true);

  // ---------- Klant en factuurgegevens ----------
  const recipientLines = [details.customer.contact ? `t.a.v. ${details.customer.contact}` : '', ...String(details.customer.address || '').split(/\r?\n/)].map((x) => x.trim()).filter(Boolean);
  pdf.text('Aan', leftEdge, top, { size: 8, color: palette.muted });
  pdf.text(details.customer.name, leftEdge, top + 12, { size: 10.5, bold: true });
  let recipientY = top + 26;
  for (const recipientLine of recipientLines.slice(0, 6)) { pdf.text(recipientLine, leftEdge, recipientY, { size: 9.5 }); recipientY += 12.5; }
  const info = [
    [credit ? 'Creditnummer' : 'Factuurnummer', invoice.number || 'CONCEPT'],
    ['Factuurdatum', day(details.date)],
    ...(credit ? [['Credit van', details.creditOfNumber]] : [['Vervaldatum', day(details.dueDate)]]),
    ...(invoice.debtorNumber ? [['Debiteurnummer', String(invoice.debtorNumber)]] : []),
    ...(details.workOrderNumber ? [['Werkorder', details.workOrderNumber]] : []),
    ...(details.reference ? [['Betreft', details.reference]] : []),
    ...(details.customer.vatNumber ? [['Btw-nummer klant', details.customer.vatNumber]] : []),
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

  pdf.text(`${kind}${invoice.number ? ` ${invoice.number}` : ' (concept)'}`, leftEdge, top, { size: 18, bold: true, color: credit ? palette.teal : palette.navy });
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
    pdf.text('Omschrijving', col.desc, top + 5, headStyle);
    pdf.text('Aantal', col.qty, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Eenh.', col.unit, top + 5, headStyle);
    pdf.text('Prijs', col.price, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Btw', col.vat, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Bedrag', col.total, top + 5, { ...headStyle, align: 'right' });
    top += 22;
  }
  tableHead();
  for (const invoiceLine of details.lines) {
    const desc = wrap(`${invoiceLine.description || ''}${invoiceLine.code ? ` (${invoiceLine.code})` : ''}`, descW, 9);
    const rowHeight = desc.length * 11.5 + 5;
    if (top + rowHeight > BOTTOM) { header(false); tableHead(); }
    desc.forEach((x, i) => pdf.text(x, col.desc, top + i * 11.5, { size: 9 }));
    pdf.text(qtyText(invoiceLine.qty), col.qty, top, { size: 9, align: 'right' });
    pdf.text(invoiceLine.unit, col.unit, top, { size: 9 });
    pdf.text(eur(invoiceLine.price), col.price, top, { size: 9, align: 'right' });
    pdf.text(`${invoiceLine.vat}%`, col.vat, top, { size: 9, align: 'right' });
    pdf.text(eur(Core.lineTotal(invoiceLine)), col.total, top, { size: 9, align: 'right' });
    top += rowHeight;
    pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
  }
  top += 8;

  // ---------- Totalen ----------
  const rows = [
    ['Subtotaal', eur(totals.subtotal)],
    ...(totals.discount ? [[`Korting ${String(totals.discountPct).replace('.', ',')}%`, `- ${eur(totals.discount)}`]] : []),
    ...totals.vat.map((vatGroup) => [`Btw ${vatGroup.rate}% over ${eur(vatGroup.base)}`, eur(vatGroup.amount)]),
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
  pdf.text('Totaal', totalsX, top, { size: 11, bold: true });
  pdf.text(eur(totals.total), col.total, top, { size: 11, bold: true, align: 'right' });
  top += 28;

  if (details.notes) paragraph(details.notes);
  const pay = invoice.status === 'betaald'
    ? `Deze factuur is voldaan${invoice.paidAt ? ` op ${day(invoice.paidAt)}` : ''}. Dank u wel.`
    : !credit ? Core.paymentText(invoicing, { number: invoice.number, iban: company.iban, dueDate: day(details.dueDate) }) : '';
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
  const foot = [company.companyName, company.kvk ? `KvK ${company.kvk}` : '', company.vatNumber ? `Btw ${company.vatNumber}` : '', company.iban ? `IBAN ${company.iban}` : ''].filter(Boolean).join(' · ');
  const count = pdf.pageCount;
  for (let i = 0; i < count; i++) {
    pdf.setPage(i);
    pdf.line(leftEdge, pageHeight - 46, rightEdge, pageHeight - 46, { color: palette.teal, width: 1.2 });
    pdf.text(foot, leftEdge, pageHeight - 38, { size: 7.5, color: palette.muted });
    if (count > 1) pdf.text(`Pagina ${i + 1} van ${count}`, rightEdge, pageHeight - 38, { size: 7.5, color: palette.muted, align: 'right' });
  }
  return pdf.toBuffer();
}

module.exports = { invoicePdf, invoiceFileName, textWidth };
