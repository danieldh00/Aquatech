// Etiketten met streepjescode voor artikelen: sjablonen (instelling labelTemplates, Beheer > Instellingen > Etiketten)
// en een PDF op het formaat van het etiket, één etiket per pagina. Zo print een labelprinter (bijv. Zebra) via het gewone
// afdrukvenster van de computer, zonder ZPL of eigen stuurprogramma. Streepjescode: de EAN van het artikel (EAN-13/EAN-8)
// of de eigen artikelcode als Code 128 (frontend/shared/barcode.js).
const path = require('path');
const express = require('express');
const { createPdf, wrap } = require('../verkoop/pdf');
const { FRONTEND_DIR } = require('../paths');
const Barcode = require(path.join(FRONTEND_DIR, 'shared', 'barcode.js'));

/** Punten per millimeter (PDF rekent in 1/72 inch). */
const POINTS_PER_MM = 72 / 25.4;
/** Hoeveel sjablonen een organisatie hoogstens heeft. */
const MAX_TEMPLATES = 10;
/** Hoeveel etiketten één PDF hoogstens heeft (en hoeveel verschillende artikelen). */
const MAX_LABELS = 500;
const MAX_ITEMS = 200;
/** Smalste streep die een gewone labelprinter (203 dpi) en scanner nog goed aankunnen, in mm. */
const MIN_MODULE_MM = 0.19;
/** Breedste streep (groter wordt de code niet leesbaarder, alleen breder), in mm. */
const MAX_MODULE_MM = 0.5;
/** Witruimte links en rechts van de code, in modules (EAN vraagt er minstens 7 à 11). */
const QUIET_MODULES = 10;
/** Standaardsjablonen: gangbare rollen voor een Zebra-printer. */
const DEFAULT_TEMPLATES = [
  { key: 'zebra-57x32', name: 'Zebra 57 × 32 mm', widthMm: 57, heightMm: 32, barcode: 'auto', showName: true, showCode: true, showPrice: true, price: 'incl' },
  { key: 'zebra-102x51', name: 'Zebra 102 × 51 mm', widthMm: 102, heightMm: 51, barcode: 'auto', showName: true, showCode: true, showPrice: true, price: 'incl' },
];

/**
 * Maakt van een naam een sleutel (kleine letters, cijfers en streepjes).
 * @param {string} name De naam.
 * @returns {string} De sleutel.
 */
const keyOf = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * Een maat in mm binnen de grenzen (op een halve mm).
 * @param {*} value De invoer.
 * @param {number} fallback De standaard.
 * @returns {number} De maat.
 */
const sizeMm = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(150, Math.max(15, Math.round(number * 2) / 2));
};

/**
 * Schoont de instelling labelTemplates op: hoogstens tien sjablonen met naam, maat (15-150 mm), soort streepjescode en
 * welke gegevens erop staan. Zonder sjablonen gelden de standaardsjablonen.
 * @param {*} raw De invoer.
 * @returns {{ templates: object[], defaultKey: string }} De sjablonen en het standaardsjabloon.
 */
function sanitizeLabelTemplates(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const given = Array.isArray(input.templates) && input.templates.length ? input.templates : DEFAULT_TEMPLATES;
  const seen = new Set();
  const templates = [];
  for (const entry of given.slice(0, MAX_TEMPLATES)) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const name = String(source.name == null ? '' : source.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Etiket';
    let key = keyOf(source.key) || keyOf(name) || 'etiket';
    for (let suffix = 2; seen.has(key); suffix += 1) key = `${keyOf(source.key) || keyOf(name) || 'etiket'}-${suffix}`;
    seen.add(key);
    templates.push({
      key, name, widthMm: sizeMm(source.widthMm, 57), heightMm: sizeMm(source.heightMm, 32),
      barcode: ['auto', 'ean', 'code128'].includes(source.barcode) ? source.barcode : 'auto',
      showName: source.showName !== false, showCode: source.showCode !== false, showPrice: source.showPrice !== false,
      price: source.price === 'excl' ? 'excl' : 'incl',
    });
  }
  // defaultIndex: het standaardsjabloon op volgorde (voor een nieuw sjabloon dat nog geen sleutel heeft).
  const byIndex = Number.isInteger(input.defaultIndex) && templates[input.defaultIndex] ? templates[input.defaultIndex].key : null;
  const defaultKey = byIndex || (templates.some((template) => template.key === input.defaultKey) ? input.defaultKey : templates[0].key);
  return { templates, defaultKey };
}

/**
 * Een bedrag als euro's voor op het etiket.
 * @param {number} amount Het bedrag.
 * @returns {string} Bijv. "€ 12,50".
 */
const euro = (amount) => `€ ${amount.toFixed(2).replace('.', ',')}`;

/**
 * Tekent één etiket op de huidige pagina: naam (hoogstens twee regels), code en prijs, en de streepjescode met de cijfers eronder.
 * @param {object} pdf Het document (createPdf).
 * @param {object} template Het sjabloon.
 * @param {object} item Het artikel (code, name, ean, salePrice, vatRate).
 * @param {{ type: string, text: string, modules: string }} code De streepjescode (Barcode.forItem).
 * @returns {void}
 */
function drawLabel(pdf, template, item, code) {
  const width = template.widthMm * POINTS_PER_MM;
  const height = template.heightMm * POINTS_PER_MM;
  const margin = 2 * POINTS_PER_MM;
  const inner = width - 2 * margin;
  // Lettergrootte groeit mee met het etiket, maar blijft leesbaar op een klein etiket.
  const nameSize = Math.min(11, Math.max(6.5, height / 11));
  const smallSize = Math.max(6, nameSize - 1.5);
  let top = margin;
  if (template.showName && item.name) {
    const lines = wrap(item.name, inner, nameSize, true).slice(0, 2);
    for (const line of lines) { pdf.text(line, margin, top, { size: nameSize, bold: true, color: '#000000' }); top += nameSize * 1.15; }
    top += 0.5;
  }
  const price = template.showPrice && item.salePrice != null
    ? (template.price === 'excl' ? `${euro(item.salePrice)} excl. btw` : euro(Math.round(item.salePrice * (1 + (item.vatRate ?? 21) / 100) * 100) / 100))
    : '';
  if ((template.showCode && item.code) || price) {
    if (template.showCode && item.code) pdf.text(item.code, margin, top, { size: smallSize, color: '#000000' });
    if (price) pdf.text(price, width - margin, top, { size: smallSize + 1, bold: true, color: '#000000', align: 'right' });
    top += (smallSize + 1) * 1.2;
  }
  // De streepjescode vult de rest; de cijfers staan eronder.
  const digitsSize = Math.max(6, Math.min(8, height / 14));
  const barTop = top + 1;
  const barHeight = Math.max(6, height - margin - digitsSize * 1.1 - barTop);
  const modules = code.modules.length + 2 * QUIET_MODULES;
  const moduleWidth = Math.min(MAX_MODULE_MM * POINTS_PER_MM, inner / modules);
  const codeWidth = moduleWidth * code.modules.length;
  const left = (width - codeWidth) / 2;
  for (const bar of Barcode.bars(code.modules)) pdf.rect(left + bar.start * moduleWidth, barTop, bar.width * moduleWidth, barHeight, { fill: '#000000' });
  pdf.text(code.text, width / 2, barTop + barHeight + 0.5, { size: digitsSize, color: '#000000', align: 'center' });
}

/**
 * Of een streepjescode op dit etiket breed genoeg past om te scannen.
 * @param {object} template Het sjabloon.
 * @param {{ modules: string }} code De streepjescode.
 * @returns {boolean} true als de smalste streep minstens MIN_MODULE_MM is.
 */
const fitsLabel = (template, code) => (template.widthMm - 4) / (code.modules.length + 2 * QUIET_MODULES) >= MIN_MODULE_MM;

/**
 * Maakt de PDF met etiketten: per artikel het gevraagde aantal, elk op een eigen pagina van het etiketformaat.
 * @param {object} template Het sjabloon (sanitizeLabelTemplates).
 * @param {{ item: object, qty: number }[]} entries De artikelen met aantallen.
 * @returns {{ pdf: Buffer, count: number }|{ error: string, codes?: string[] }} De PDF, of waarom het niet kan.
 */
function buildLabelPdf(template, entries) {
  const problems = [];
  const prepared = [];
  for (const { item, qty } of entries) {
    const code = Barcode.forItem(item, template.barcode);
    if (!code) { problems.push(`${item.code}: ${template.barcode === 'ean' ? 'geen geldige EAN' : 'code niet te coderen'}`); continue; }
    if (!fitsLabel(template, code)) { problems.push(`${item.code}: de code is te lang voor een etiket van ${template.widthMm} mm breed`); continue; }
    prepared.push({ item, qty, code });
  }
  if (problems.length) return { error: `Niet af te drukken: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (en ${problems.length - 5} meer)` : ''}.`, codes: problems };
  const pdf = createPdf({ title: 'Etiketten', author: 'AquaTech', pageSize: { width: template.widthMm * POINTS_PER_MM, height: template.heightMm * POINTS_PER_MM } });
  let count = 0;
  for (const { item, qty, code } of prepared) {
    for (let copy = 0; copy < qty; copy += 1) { pdf.addPage(); drawLabel(pdf, template, item, code); count += 1; }
  }
  return { pdf: pdf.toBuffer(), count };
}

/**
 * Leest de artikelen voor de etiketten in één query (alleen de nodige kolommen).
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string[]} ids De artikel-id's.
 * @returns {object[]} De artikelen (id, code, name, ean, salePrice, vatRate, hasVariants).
 */
function itemsForLabels(db, tenantId, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT i.id, i.code, i.name, i.ean, i.sale_price, i.vat_rate, i.has_variants, i.variant_values, p.name AS parent_name FROM stock_items i
      LEFT JOIN stock_items p ON p.tenant_id = i.tenant_id AND p.id = i.parent_id
      WHERE i.tenant_id = ? AND i.id IN (${ids.map(() => '?').join(', ')})`).all(tenantId, ...ids)
    .map((row) => {
      let values = {};
      try { values = JSON.parse(row.variant_values || '{}') || {}; } catch { values = {}; }
      const label = Object.values(values).join(' / ');
      return { id: row.id, code: row.code, name: row.parent_name && label ? `${row.parent_name} ${label}` : row.name, ean: row.ean || null,
        salePrice: row.sale_price == null ? null : Number(row.sale_price), vatRate: Number(row.vat_rate ?? 21), hasVariants: Boolean(Number(row.has_variants)) };
    });
}

/**
 * Registreert de routes voor etiketten (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ db: object, requireRight: Function, settingsOf: Function, audit: Function, limiter: Function }} ctx De database, de rechtencontrole,
 *   de instellingen van de omgeving, het auditlog en een begrenzer per gebruiker.
 * @returns {void}
 */
function registerLabelRoutes(app, { db, requireRight, settingsOf, audit, limiter }) {
  const requireStock = requireRight('voorraad');

  app.get('/api/stock/label-templates', requireStock, (req, res) => {
    res.json(sanitizeLabelTemplates(settingsOf(req).get('labelTemplates')));
  });

  app.post('/api/stock/labels', express.json({ limit: '32kb' }), requireStock, limiter, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const config = sanitizeLabelTemplates(settingsOf(req).get('labelTemplates'));
    const template = config.templates.find((entry) => entry.key === body.template) || config.templates.find((entry) => entry.key === config.defaultKey);
    const wanted = new Map();
    for (const entry of (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS)) {
      const id = String((entry && entry.id) || '').slice(0, 64);
      const qty = Math.floor(Number(entry && entry.qty));
      if (id && qty >= 1) wanted.set(id, Math.min(MAX_LABELS + 1, (wanted.get(id) || 0) + qty));
    }
    if (!wanted.size) return res.status(400).json({ error: 'no_items', message: 'Kies minstens één artikel en een aantal.' });
    const total = [...wanted.values()].reduce((sum, qty) => sum + qty, 0);
    if (total > MAX_LABELS) return res.status(400).json({ error: 'too_many', message: `Hoogstens ${MAX_LABELS} etiketten per keer.` });
    const items = itemsForLabels(db, req.tenantId, [...wanted.keys()]);
    if (items.length !== wanted.size) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    const parent = items.find((item) => item.hasVariants);
    if (parent) return res.status(400).json({ error: 'has_variants', message: `${parent.code} heeft varianten: druk de etiketten per variant af.` });
    const out = buildLabelPdf(template, items.map((item) => ({ item, qty: wanted.get(item.id) })));
    if (out.error) return res.status(400).json({ error: 'not_printable', message: out.error });
    audit(req, 'etiketten_afgedrukt', { sjabloon: template.key, artikelen: items.length, etiketten: out.count });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="etiketten.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.pdf);
  });
}

module.exports = { sanitizeLabelTemplates, buildLabelPdf, registerLabelRoutes, itemsForLabels, DEFAULT_TEMPLATES, MAX_LABELS, POINTS_PER_MM };
