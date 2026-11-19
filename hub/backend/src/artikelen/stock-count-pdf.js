// De voorraadtelling als PDF: de telstaat (verslag voor de boekhouding en de beheerder: verwacht aantal op het telmoment, geteld, verschil en
// waarde per regel) en het blanco telformulier (voor tellen op papier: per locatie een blad met alleen artikel, eenheid en een leeg vak, zonder
// verwacht aantal of prijs). Kop en voet komen uit de documentopmaak van de organisatie. Alleen Nederlands (intern document).
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
 * Een aantal met hooguit drie decimalen en een komma; leeg als er geen aantal is.
 * @param {*} quantity Het aantal (null of undefined = leeg).
 * @returns {string} Bijvoorbeeld "2,5", of een lege tekst.
 */
const qtyText = (quantity) => (quantity === null || quantity === undefined ? '' : String(Math.round(Number(quantity) * 1000) / 1000).replace('.', ','));

/**
 * Een verschil met teken (+3, -2).
 * @param {*} quantity Het verschil (null of undefined = leeg).
 * @returns {string} Bijvoorbeeld "+3" of "-2,5", of een lege tekst.
 */
const signedText = (quantity) => (quantity === null || quantity === undefined ? '' : `${Number(quantity) > 0 ? '+' : ''}${qtyText(quantity)}`);

/**
 * Een ISO-datum als dag-maand-jaar.
 * @param {string} iso De datum of het tijdstip (alleen het datumdeel telt).
 * @returns {string} Bijvoorbeeld "5-3-2026", of leeg.
 */
const day = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${Number(match[3])}-${Number(match[2])}-${match[1]}` : '';
};

const STATUS_NAMES = { tellen: 'Loopt', afgesloten: 'Afgesloten', geannuleerd: 'Geannuleerd' };

/**
 * De bestandsnaam van een telling-PDF, bijvoorbeeld "Telstaat VT2026-0001.pdf".
 * @param {{ number: string }} count De telling.
 * @param {'telstaat'|'telformulier'} kind Welk document.
 * @returns {string} De bestandsnaam zonder vreemde tekens.
 */
function stockCountFileName(count, kind) {
  return `${kind === 'telformulier' ? 'Telformulier' : 'Telstaat'} ${count.number}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * Zet het gemeenschappelijke begin van elk document klaar: het PDF-document, de kleuren, de kop en de voet.
 * @param {object} count De telling.
 * @param {string} title De titel van het document.
 * @param {{ profile?: object, colors?: object, layout?: object }} options Het bedrijfsprofiel, de themakleuren en de documentopmaak.
 * @returns {{ pdf: object, palette: object, company: object, documentLayout: object, newPage: Function, finish: Function }} De hulpmiddelen.
 */
function startDocument(count, title, { profile = {}, colors = {}, layout = null } = {}) {
  const company = profile || {};
  const documentLayout = sanitizeDocumentLayout(layout);
  const palette = paletteOf(documentLayout, colors);
  const pdf = createPdf({ title: `${title} ${count.number}`, author: company.companyName || '', font: documentLayout.font });
  let first = true;
  /**
   * Begint een nieuwe pagina met de kop uit de documentopmaak.
   * @returns {number} De y-positie waar de inhoud begint.
   */
  function newPage() {
    pdf.addPage();
    const top = drawHeader(pdf, documentLayout, { palette, company, first, continuedTitle: `${title} ${count.number} (vervolg)` }) + 24;
    first = false;
    return top;
  }
  /**
   * Zet de voet met paginanummers op alle pagina's en geeft de PDF.
   * @returns {Buffer} De PDF.
   */
  function finish() {
    const companyLine = [company.companyName, company.kvk ? `KvK ${company.kvk}` : '', company.vatNumber ? `BTW ${company.vatNumber}` : ''].filter(Boolean).join(' · ');
    const pages = pdf.pageCount;
    for (let index = 0; index < pages; index++) {
      pdf.setPage(index);
      drawFooter(pdf, documentLayout, { palette, companyLine, pageLabel: pages > 1 ? `Pagina ${index + 1} van ${pages}` : '' });
    }
    return pdf.toBuffer();
  }
  return { pdf, palette, company, documentLayout, newPage, finish };
}

/**
 * Maakt de telstaat: het verslag van een telling met samenvatting en per regel het verwachte aantal op het telmoment, het getelde aantal, het
 * verschil en de waarde van het verschil. Voor beheerders (recht `voorraad`); bevat prijzen.
 * @param {{ count: object, lines: object[] }} report Het verslag zoals stockCounts.report() het geeft.
 * @param {{ profile?: object, colors?: object, layout?: object, onlyDifferences?: boolean }} [options] Bedrijfsprofiel, themakleuren, documentopmaak en of alleen regels met een verschil komen.
 * @returns {Buffer} De PDF.
 */
function stockCountReportPdf(report, { profile = {}, colors = {}, layout = null, onlyDifferences = false } = {}) {
  const { count } = report;
  const { pdf, palette, newPage, finish } = startDocument(count, 'Telstaat', { profile, colors, layout });
  const { wrap } = pdf;
  const leftEdge = 42;
  const rightEdge = pdf.A4.width - 42;
  const bottom = pdf.A4.height - 64;
  let top = newPage();

  pdf.text(`Telstaat ${count.number}`, leftEdge, top, { size: 18, bold: true, color: palette.navy });
  top += 28;
  const totals = count.totals || {};
  const closed = count.status === 'afgesloten';
  const info = [
    ['Soort', count.kind === 'jaar' ? 'Jaartelling' : 'Tussentijdse telling'],
    ['Peildatum', day(count.referenceDate)],
    ['Status', STATUS_NAMES[count.status] || count.status],
    ...(closed ? [['Afgesloten', `${day(count.closedAt)}${count.closedByName ? ` door ${count.closedByName}` : ''}`]] : []),
  ];
  const figures = [
    ['Artikelregels', String(totals.lines ?? '')],
    ['Geteld', String(totals.counted ?? '')],
    ['Met verschil', String(totals.withDifference ?? '')],
    ['Voorraadwaarde bij peildatum', money(totals.valueBefore)],
    ['Waarde van de verschillen', money(totals.differenceValue)],
    ...(totals.noCostWithStock ? [['Regels met voorraad zonder prijs', String(totals.noCostWithStock)]] : []),
  ];
  let infoY = top;
  for (const [label, value] of info) {
    pdf.text(label, leftEdge, infoY, { size: 9, color: palette.muted });
    pdf.text(value, leftEdge + 90, infoY, { size: 9.5, bold: true });
    infoY += 13;
  }
  let figureY = top;
  for (const [label, value] of figures) {
    pdf.text(label, 300, figureY, { size: 9, color: palette.muted });
    pdf.text(value, rightEdge, figureY, { size: 9.5, bold: true, align: 'right' });
    figureY += 13;
  }
  top = Math.max(infoY, figureY) + 8;
  if (count.note) {
    for (const noteLine of wrap(count.note, rightEdge - leftEdge, 9)) { pdf.text(noteLine, leftEdge, top, { size: 9, color: palette.muted }); top += 12; }
  }
  if (onlyDifferences) { pdf.text('Alleen regels met een verschil.', leftEdge, top, { size: 9, color: palette.muted }); top += 12; }
  top += 8;

  const col = { name: leftEdge + 4, expected: 380, counted: 435, difference: 485, value: rightEdge - 4 };
  const nameWidth = 330 - col.name;
  /** Tekent de kop van de regeltabel. */
  function tableHead() {
    pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
    const headStyle = { size: 8.5, bold: true, color: palette.navy };
    pdf.text('Artikel', col.name, top + 5, headStyle);
    pdf.text('Verwacht', col.expected, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Geteld', col.counted, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Verschil', col.difference, top + 5, { ...headStyle, align: 'right' });
    pdf.text('Waarde', col.value, top + 5, { ...headStyle, align: 'right' });
    top += 22;
  }
  tableHead();
  let location = null;
  let drawn = 0;
  for (const line of report.lines) {
    if (onlyDifferences && !line.difference) continue;
    const description = wrap(`${line.name} (${line.code})`, nameWidth, 9);
    const rowHeight = description.length * 11.5 + 5;
    const locationRow = line.location !== location;
    if (top + rowHeight + (locationRow ? 20 : 0) > bottom) { top = newPage(); tableHead(); }
    if (locationRow) {
      location = line.location;
      pdf.text(location || 'Geen locatie', col.name, top, { size: 9, bold: true, color: palette.navy });
      top += 16;
    }
    const expected = line.expectedAtCount != null ? line.expectedAtCount : line.expectedQty;
    description.forEach((entry, index) => pdf.text(entry, col.name, top + index * 11.5, { size: 9 }));
    pdf.text(`${qtyText(expected)}${line.unit ? ` ${line.unit}` : ''}`, col.expected, top, { size: 9, align: 'right' });
    pdf.text(line.countedQty == null ? (line.status === 'hertellen' ? 'hertellen' : '—') : qtyText(line.countedQty), col.counted, top, { size: 9, align: 'right' });
    pdf.text(signedText(line.difference), col.difference, top, { size: 9, bold: Boolean(line.difference), align: 'right' });
    pdf.text(line.difference ? money(line.differenceValue) : '', col.value, top, { size: 9, align: 'right' });
    top += rowHeight;
    pdf.line(leftEdge, top - 3, rightEdge, top - 3, { color: palette.line, width: 0.4 });
    drawn += 1;
  }
  if (!drawn) { pdf.text('Geen regels om te tonen.', leftEdge, top, { size: 9.5, color: palette.muted }); }
  return finish();
}

/**
 * Maakt het blanco telformulier: per locatie een blad met de artikelen, de eenheid en een leeg vak om het getelde aantal in te schrijven. Bevat nooit
 * een verwacht aantal of een prijs, zodat het ook bij blind tellen op papier gebruikt kan worden.
 * @param {{ count: object, lines: object[] }} report Het verslag zoals stockCounts.report() het geeft (alleen artikel, eenheid en locatie worden gebruikt).
 * @param {{ profile?: object, colors?: object, layout?: object, location?: string }} [options] Bedrijfsprofiel, themakleuren, documentopmaak en eventueel één locatie (leeg = "geen locatie", undefined = alle).
 * @returns {Buffer} De PDF.
 */
function stockCountFormPdf(report, { profile = {}, colors = {}, layout = null, location } = {}) {
  const { count } = report;
  const { pdf, palette, newPage, finish } = startDocument(count, 'Telformulier', { profile, colors, layout });
  const { wrap } = pdf;
  const leftEdge = 42;
  const rightEdge = pdf.A4.width - 42;
  const bottom = pdf.A4.height - 64;
  const col = { code: leftEdge + 4, name: leftEdge + 100, unit: 400, box: rightEdge - 90 };
  const nameWidth = 390 - col.name;

  const groups = new Map();
  for (const line of report.lines) {
    if (location !== undefined && line.location !== location) continue;
    if (!groups.has(line.location)) groups.set(line.location, []);
    groups.get(line.location).push({ code: line.code, name: line.name, unit: line.unit, ean: line.ean });
  }
  if (!groups.size) {
    const top = newPage();
    pdf.text(`Telformulier ${count.number}`, leftEdge, top, { size: 18, bold: true, color: palette.navy });
    pdf.text('Geen artikelen op deze locatie.', leftEdge, top + 30, { size: 10, color: palette.muted });
    return finish();
  }
  for (const [groupLocation, lines] of groups) {
    let top = newPage();
    /** Tekent de titel van de locatie en de kop van de tabel. */
    const heading = () => {
      pdf.text(`Telformulier ${count.number}`, leftEdge, top, { size: 11, bold: true, color: palette.navy });
      pdf.text(`Peildatum ${day(count.referenceDate)}`, rightEdge, top + 2, { size: 9, color: palette.muted, align: 'right' });
      top += 22;
      pdf.text(groupLocation || 'Geen locatie', leftEdge, top, { size: 20, bold: true, color: palette.navy });
      top += 32;
      pdf.rect(leftEdge, top, rightEdge - leftEdge, 18, { fill: palette.greenSoft });
      const headStyle = { size: 8.5, bold: true, color: palette.navy };
      pdf.text('Code', col.code, top + 5, headStyle);
      pdf.text('Omschrijving', col.name, top + 5, headStyle);
      pdf.text('Eenheid', col.unit, top + 5, headStyle);
      pdf.text('Geteld', col.box, top + 5, headStyle);
      top += 24;
    };
    heading();
    for (const line of lines) {
      const description = wrap(`${line.name}${line.ean ? `  (${line.ean})` : ''}`, nameWidth, 9);
      const rowHeight = Math.max(description.length * 11.5, 14) + 12;
      if (top + rowHeight > bottom) { top = newPage(); heading(); }
      pdf.text(line.code, col.code, top, { size: 9 });
      description.forEach((entry, index) => pdf.text(entry, col.name, top + index * 11.5, { size: 9 }));
      pdf.text(line.unit || '', col.unit, top, { size: 9 });
      pdf.rect(col.box, top - 3, rightEdge - col.box, rowHeight - 8, { stroke: palette.navy, lineWidth: 0.6 });
      top += rowHeight;
      pdf.line(leftEdge, top - 4, col.box - 6, top - 4, { color: palette.line, width: 0.4 });
    }
  }
  return finish();
}

module.exports = { stockCountReportPdf, stockCountFormPdf, stockCountFileName };
