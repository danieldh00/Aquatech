// De factuur als PDF (bijlage bij de e-mail en downloaden), in dezelfde opzet
// als de afdrukversie in frontend/facturen/facturen.js (documentHtml): kop
// met logo en bedrijfsgegevens, klant en factuurgegevens, regels, totalen,
// betaaltekst en een voetregel met KvK, btw en IBAN. Kleuren uit het
// kleurthema van de organisatie.
const fs = require('fs');
const path = require('path');
const { createPdf, wrap, textWidth } = require('./pdf');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));

let logoCache = null;
const defaultLogo = () => {
  if (!logoCache) {
    try { logoCache = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'shared', 'logo-white.png')); } catch { logoCache = Buffer.alloc(0); }
  }
  return logoCache;
};

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const eur = (v) => EUR.format(Number(v) || 0);
const day = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}-${Number(m[2])}-${m[1]}` : '';
};
const qtyText = (q) => String(Math.round((Number(q) || 0) * 100) / 100).replace('.', ',');

/** Bestandsnaam van de PDF, bijv. "Factuur F2026-0001.pdf". */
function invoiceFileName(inv) {
  const kind = inv.kind === 'credit' ? 'Creditfactuur' : 'Factuur';
  return `${kind} ${inv.number || 'concept'}.pdf`.replace(/[^\w .()-]/g, '');
}

/**
 * inv: factuur zoals invoices.get() hem geeft (met data). opts: { profile
 * (bedrijfsprofiel), settings (factuurinstellingen), colors ({ navy, green,
 * greenSoft, teal }), logo (PNG-buffer) }.
 */
function invoicePdf(inv, { profile = {}, settings = null, colors = {}, logo = null } = {}) {
  const p = profile || {};
  const s = settings && settings.categories ? settings : Core.sanitizeSettings(settings);
  const c = { navy: '#172f5e', green: '#19924f', greenSoft: '#e6f4ec', teal: '#2cb0c0', text: '#1d2733', muted: '#6b7785', line: '#d0d6de', ...colors };
  const d = inv.data;
  const t = Core.totals(d, s);
  const credit = inv.kind === 'credit';
  const kind = credit ? 'Creditfactuur' : 'Factuur';
  const pdf = createPdf({ title: `${kind} ${inv.number || 'concept'}`, author: p.companyName || '' });
  const W = pdf.A4.width;
  const H = pdf.A4.height;
  const L = 42;
  const R = W - 42;
  const BOTTOM = H - 64;
  let top = 0;

  // ---------- Kop ----------
  function header(first) {
    pdf.addPage();
    const h = first ? 92 : 52;
    pdf.rect(0, 0, W, h, { fill: c.navy });
    const logoH = first ? 40 : 26;
    if (!pdf.image(logo || defaultLogo(), L, (h - logoH) / 2, logoH * (321 / 66), logoH)) {
      pdf.text(p.companyName, L, h / 2 - 8, { size: 16, bold: true, color: '#ffffff' });
    }
    if (first) {
      const lines = [...String(p.address || '').split(/\r?\n/), [p.phone, p.email].filter(Boolean).join(' · '), p.website].map((x) => String(x || '').trim()).filter(Boolean);
      let ty = 16;
      pdf.text(p.companyName, R, ty, { size: 10, bold: true, color: '#ffffff', align: 'right' });
      for (const l of lines.slice(0, 5)) {
        ty += 12.5;
        pdf.text(l, R, ty, { size: 8.5, color: '#ffffff', align: 'right' });
      }
    } else {
      pdf.text(`${kind} ${inv.number || '(concept)'} (vervolg)`, R, 20, { size: 10, bold: true, color: '#ffffff', align: 'right' });
    }
    top = h + 24;
  }
  header(true);

  // ---------- Klant en factuurgegevens ----------
  const to = [d.customer.contact ? `t.a.v. ${d.customer.contact}` : '', ...String(d.customer.address || '').split(/\r?\n/)].map((x) => x.trim()).filter(Boolean);
  pdf.text('Aan', L, top, { size: 8, color: c.muted });
  pdf.text(d.customer.name, L, top + 12, { size: 10.5, bold: true });
  let ly = top + 26;
  for (const l of to.slice(0, 6)) { pdf.text(l, L, ly, { size: 9.5 }); ly += 12.5; }
  const info = [
    [credit ? 'Creditnummer' : 'Factuurnummer', inv.number || 'CONCEPT'],
    ['Factuurdatum', day(d.date)],
    ...(credit ? [['Credit van', d.creditOfNumber]] : [['Vervaldatum', day(d.dueDate)]]),
    ...(inv.debtorNumber ? [['Debiteurnummer', String(inv.debtorNumber)]] : []),
    ...(d.workOrderNumber ? [['Werkorder', d.workOrderNumber]] : []),
    ...(d.reference ? [['Betreft', d.reference]] : []),
    ...(d.customer.vatNumber ? [['Btw-nummer klant', d.customer.vatNumber]] : []),
  ];
  let iy = top;
  const ix = 330;
  for (const [k, v] of info) {
    pdf.text(k, ix, iy, { size: 9, color: c.muted });
    const vl = wrap(v, R - ix - 92, 9.5, true);
    vl.slice(0, 2).forEach((l, i) => pdf.text(l, ix + 92, iy + i * 12, { size: 9.5, bold: true }));
    iy += 13 + (Math.min(vl.length, 2) - 1) * 12;
  }
  top = Math.max(ly, iy) + 18;

  pdf.text(`${kind}${inv.number ? ` ${inv.number}` : ' (concept)'}`, L, top, { size: 18, bold: true, color: credit ? c.teal : c.navy });
  top += 30;
  const paragraph = (txt, size = 9.5, color = c.text) => {
    for (const l of wrap(txt, R - L, size)) {
      if (top + size * 1.4 > BOTTOM) header(false);
      pdf.text(l, L, top, { size, color });
      top += size * 1.4;
    }
    top += 6;
  };
  if (d.intro) paragraph(d.intro);

  // ---------- Regels ----------
  const col = { desc: L + 4, qty: 352, unit: 358, price: 448, vat: 488, total: R - 4 };
  const descW = 340 - L - 8;
  function tableHead() {
    pdf.rect(L, top, R - L, 18, { fill: c.greenSoft });
    const o = { size: 8.5, bold: true, color: c.navy };
    pdf.text('Omschrijving', col.desc, top + 5, o);
    pdf.text('Aantal', col.qty, top + 5, { ...o, align: 'right' });
    pdf.text('Eenh.', col.unit, top + 5, o);
    pdf.text('Prijs', col.price, top + 5, { ...o, align: 'right' });
    pdf.text('Btw', col.vat, top + 5, { ...o, align: 'right' });
    pdf.text('Bedrag', col.total, top + 5, { ...o, align: 'right' });
    top += 22;
  }
  tableHead();
  for (const l of d.lines) {
    const desc = wrap(`${l.description || ''}${l.code ? ` (${l.code})` : ''}`, descW, 9);
    const h = desc.length * 11.5 + 5;
    if (top + h > BOTTOM) { header(false); tableHead(); }
    desc.forEach((x, i) => pdf.text(x, col.desc, top + i * 11.5, { size: 9 }));
    pdf.text(qtyText(l.qty), col.qty, top, { size: 9, align: 'right' });
    pdf.text(l.unit, col.unit, top, { size: 9 });
    pdf.text(eur(l.price), col.price, top, { size: 9, align: 'right' });
    pdf.text(`${l.vat}%`, col.vat, top, { size: 9, align: 'right' });
    pdf.text(eur(Core.lineTotal(l)), col.total, top, { size: 9, align: 'right' });
    top += h;
    pdf.line(L, top - 3, R, top - 3, { color: c.line, width: 0.4 });
  }
  top += 8;

  // ---------- Totalen ----------
  const rows = [
    ['Subtotaal', eur(t.subtotal)],
    ...(t.discount ? [[`Korting ${String(t.discountPct).replace('.', ',')}%`, `- ${eur(t.discount)}`]] : []),
    ...t.vat.map((v) => [`Btw ${v.rate}% over ${eur(v.base)}`, eur(v.amount)]),
  ];
  if (top + rows.length * 14 + 30 > BOTTOM) header(false);
  const tx = 330;
  for (const [k, v] of rows) {
    pdf.text(k, tx, top, { size: 9.5 });
    pdf.text(v, col.total, top, { size: 9.5, align: 'right' });
    top += 14;
  }
  pdf.line(tx, top, R, top, { color: c.navy, width: 1.4 });
  top += 6;
  pdf.text('Totaal', tx, top, { size: 11, bold: true });
  pdf.text(eur(t.total), col.total, top, { size: 11, bold: true, align: 'right' });
  top += 28;

  if (d.notes) paragraph(d.notes);
  const pay = inv.status === 'betaald'
    ? `Deze factuur is voldaan${inv.paidAt ? ` op ${day(inv.paidAt)}` : ''}. Dank u wel.`
    : !credit ? Core.paymentText(s, { number: inv.number, iban: p.iban, dueDate: day(d.dueDate) }) : '';
  if (pay) {
    const pl = wrap(pay, R - L - 24, 9.5);
    const ph = pl.length * 13 + 14;
    if (top + ph > BOTTOM) header(false);
    pdf.rect(L, top, R - L, ph, { fill: c.greenSoft });
    pdf.rect(L, top, 3, ph, { fill: c.green });
    pl.forEach((x, i) => pdf.text(x, L + 14, top + 8 + i * 13, { size: 9.5 }));
    top += ph + 14;
  }
  if (s.footer) paragraph(s.footer, 8, c.muted);

  // ---------- Voet op elke pagina ----------
  const foot = [p.companyName, p.kvk ? `KvK ${p.kvk}` : '', p.vatNumber ? `Btw ${p.vatNumber}` : '', p.iban ? `IBAN ${p.iban}` : ''].filter(Boolean).join(' · ');
  const count = pdf.pageCount;
  for (let i = 0; i < count; i++) {
    pdf.setPage(i);
    pdf.line(L, H - 46, R, H - 46, { color: c.teal, width: 1.2 });
    pdf.text(foot, L, H - 38, { size: 7.5, color: c.muted });
    if (count > 1) pdf.text(`Pagina ${i + 1} van ${count}`, R, H - 38, { size: 7.5, color: c.muted, align: 'right' });
  }
  return pdf.toBuffer();
}

module.exports = { invoicePdf, invoiceFileName, textWidth };
