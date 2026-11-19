// Offertesjablonen: vaste teksten (inleiding, voorwaarden) en standaardregels die een medewerker op een offerte kan kiezen
// in plaats van te typen. Instelling quoteTemplates per organisatie, alleen via /api/quote-templates.
const path = require('path');
const crypto = require('crypto');
const { FRONTEND_DIR } = require('../paths');
const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));

/** Hoeveel sjablonen een organisatie hoogstens heeft. */
const MAX_TEMPLATES = 30;
/** Hoeveel regels een sjabloon hoogstens heeft. */
const MAX_TEMPLATE_LINES = 60;

/**
 * Kort een tekst in op een maximale lengte.
 * @param {*} value De ruwe waarde.
 * @param {number} max Maximale lengte.
 * @returns {string} De tekst, of leeg als het geen tekst was.
 */
const limitText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * Schoont één sjabloonregel op met de regelkern van de offerte; interne notities en de keuze van de klant horen niet in een sjabloon.
 * @param {object} line De ruwe regel.
 * @returns {object} De opgeschoonde regel (met id).
 */
function cleanTemplateLine(line) {
  const clean = Core.sanitizeLine(line);
  return { ...clean, selected: false, note: '', noteChecked: false };
}

/**
 * Schoont één sjabloon op.
 * @param {object} raw Het ruwe sjabloon.
 * @returns {object|null} { id, name, intro, terms, lines }, of null zonder naam of zonder inhoud.
 */
function cleanTemplate(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = limitText(input.name, 80).trim();
  if (!name) return null;
  const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, MAX_TEMPLATE_LINES).map(cleanTemplateLine);
  const intro = limitText(input.intro, 4000);
  const terms = limitText(input.terms, 6000);
  if (!intro.trim() && !terms.trim() && !lines.length) return null;
  const id = /^[a-z0-9-]{8,40}$/.test(String(input.id || '')) ? String(input.id) : crypto.randomUUID();
  return { id, name, intro, terms, lines };
}

/**
 * Schoont de instelling quoteTemplates op: hoogstens dertig sjablonen met een unieke naam (hoofdletters tellen niet mee).
 * @param {*} raw De ruwe instelling.
 * @returns {{ templates: object[] }} De opgeschoonde instelling.
 */
function sanitizeQuoteTemplates(raw) {
  const list = Array.isArray(raw && raw.templates) ? raw.templates : [];
  const seen = new Set();
  const templates = [];
  for (const entry of list) {
    const template = cleanTemplate(entry);
    if (!template || seen.has(template.name.toLowerCase())) continue;
    seen.add(template.name.toLowerCase());
    templates.push(template);
    if (templates.length >= MAX_TEMPLATES) break;
  }
  return { templates };
}

/**
 * Zet een sjabloon op zijn plek: zelfde id of zelfde naam vervangt het bestaande, anders komt het erbij.
 * @param {{ templates: object[] }} current De huidige instelling.
 * @param {object} raw Het ruwe sjabloon.
 * @returns {{ config: { templates: object[] }, template: object }|{ error: string }} De nieuwe instelling en het bewaarde sjabloon, of een foutcode.
 */
function upsertTemplate(current, raw) {
  const template = cleanTemplate(raw);
  if (!template) return { error: 'invalid_template' };
  const templates = current.templates.filter((existing) => existing.id !== template.id);
  const sameName = templates.findIndex((existing) => existing.name.toLowerCase() === template.name.toLowerCase());
  if (sameName >= 0) {
    template.id = templates[sameName].id;
    templates[sameName] = template;
  } else {
    if (templates.length >= MAX_TEMPLATES) return { error: 'too_many' };
    templates.push(template);
  }
  return { config: { templates }, template };
}

module.exports = { sanitizeQuoteTemplates, upsertTemplate, MAX_TEMPLATES, MAX_TEMPLATE_LINES };
