// Blokken van een pagina in de webshop (Beheer > Webshop-inhoud > Pagina's): tekst, afbeelding,
// artikelen, veelgestelde vragen en een knop (call-to-action). Dit bestand saneert de invoer
// en haalt de vragen voor FAQPage-gegevens uit de blokken; het tekenen staat in storefront-pages.js.
// Alles wat de bezoeker ziet komt uit dezelfde blokken als wat in de gegevens voor zoekmachines
// staat (geen verborgen tekst).

/** Grenzen: blokken per pagina, vragen per FAQ-blok, artikelen per artikelblok. */
const MAX_BLOCKS = 40;
const MAX_FAQ_ITEMS = 40;
const MAX_PRODUCTS = 12;
const MIN_PRODUCTS = 3;
const BLOCK_TYPES = ['text', 'image', 'products', 'faq', 'cta'];
/** Namen van de blokken in Beheer. */
const BLOCK_LABELS = { text: 'Tekst', image: 'Afbeelding', products: 'Artikelen', faq: 'Veelgestelde vragen', cta: 'Knop met tekst' };

/**
 * Maakt van de ingevoerde blokken een geldige lijst; onbekende of lege blokken vallen weg.
 * @param {*} input De ingevoerde lijst blokken.
 * @param {{ cleanText: Function, imageRef: Function, linkRef: Function, sanitizeHtml: Function, cleanCodes: Function }} helpers De saneerfuncties van shop-content.js.
 * @returns {{ blocks?: object[], error?: string, message?: string }} De blokken, of een fout.
 */
function normalizeBlocks(input, helpers) {
  if (!Array.isArray(input)) return { blocks: [] };
  if (input.length > MAX_BLOCKS) return { error: 'too_many_blocks', message: `Een pagina kan maximaal ${MAX_BLOCKS} blokken hebben.` };
  const blocks = [];
  for (const raw of input) {
    const block = normalizeBlock(raw, helpers);
    if (block) blocks.push(block);
  }
  return { blocks };
}

/**
 * Saneert één blok.
 * @param {*} raw Het ingevoerde blok.
 * @param {object} helpers Zie normalizeBlocks.
 * @returns {object|null} Het blok, of null als het onbekend of leeg is.
 */
function normalizeBlock(raw, helpers) {
  const { cleanText, imageRef, linkRef, sanitizeHtml, cleanCodes } = helpers;
  if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.includes(raw.type)) return null;
  if (raw.type === 'text') {
    const html = sanitizeHtml(raw.html);
    return html ? { type: 'text', html } : null;
  }
  if (raw.type === 'image') {
    const image = imageRef(raw.image, '');
    if (!image) return null;
    return { type: 'image', image, alt: cleanText(raw.alt, 160), caption: cleanText(raw.caption, 200), link: linkRef(raw.link) };
  }
  if (raw.type === 'products') {
    const mode = raw.mode === 'category' ? 'category' : 'codes';
    const limit = Number.isFinite(Number(raw.limit)) ? Math.max(MIN_PRODUCTS, Math.min(MAX_PRODUCTS, Math.round(Number(raw.limit)))) : 6;
    const codes = cleanCodes(raw.codes).slice(0, MAX_PRODUCTS);
    const category = /^[a-z0-9][a-z0-9-]{0,80}$/.test(String(raw.category || '')) ? String(raw.category) : '';
    if (mode === 'codes' ? !codes.length : !category) return null;
    return { type: 'products', title: cleanText(raw.title, 120), mode, codes: mode === 'codes' ? codes : [], category: mode === 'category' ? category : '', limit };
  }
  if (raw.type === 'faq') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_FAQ_ITEMS)
      .map((item) => ({ question: cleanText(item && item.question, 200), answer: cleanAnswer(item && item.answer) }))
      .filter((item) => item.question && item.answer);
    return items.length ? { type: 'faq', title: cleanText(raw.title, 120), items } : null;
  }
  const title = cleanText(raw.title, 120);
  const button = cleanText(raw.button, 60);
  const link = linkRef(raw.link);
  if (!title && !button) return null;
  return { type: 'cta', title, text: cleanText(raw.text, 400), button: link ? button : '', link: button ? link : '' };
}

/**
 * Een antwoord op een vraag: gewone tekst met lege regels tussen alinea's.
 * @param {*} value De invoer.
 * @returns {string} De tekst (maximaal 2000 tekens, zonder stuurtekens).
 */
function cleanAnswer(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
}

/**
 * De blokken van een pagina; een pagina die nog alleen een tekst (body) heeft telt als één tekstblok.
 * @param {{ blocks?: object[], body?: string }} page De pagina.
 * @returns {object[]} De blokken.
 */
function blocksOf(page) {
  if (Array.isArray(page.blocks)) return page.blocks;
  return page.body ? [{ type: 'text', html: page.body }] : [];
}

/**
 * Alle vragen met antwoord uit de FAQ-blokken van een pagina, in de volgorde van de pagina.
 * @param {object[]} blocks De blokken van de pagina.
 * @returns {{ question: string, answer: string }[]} De vragen.
 */
function faqEntriesOfBlocks(blocks) {
  return blocks.filter((block) => block.type === 'faq').flatMap((block) => block.items.map((item) => ({ question: item.question, answer: item.answer.replace(/\s*\n\s*/g, ' ') })));
}

module.exports = { MAX_BLOCKS, MAX_FAQ_ITEMS, MAX_PRODUCTS, MIN_PRODUCTS, BLOCK_TYPES, BLOCK_LABELS, normalizeBlocks, blocksOf, faqEntriesOfBlocks };
