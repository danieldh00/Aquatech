// Inhoud van de eigen webshop (storefront.js) die de beheerder zelf bewerkt:
// de blokken op de startpagina (mededeling, hero, voordelen, merken, zakelijk
// blok), de contactgegevens in kop en voet, en vaste pagina's met een
// eenvoudige tekst-editor.
//
// Opslag per tenant (tabel shop_content): per onderdeel een concept (draft),
// de gepubliceerde versie (published) en de vorige gepubliceerde versie
// (previous). De shop toont alleen wat gepubliceerd is; zonder gepubliceerde
// versie geldt de standaard (DEFAULT_SITE, de tekst van aquatechshop.nl).
// Geüploade afbeeldingen staan versleuteld in shop_images (vault.sealBytes).
// Alle invoer wordt hier gesaneerd; pagina-HTML via een eigen whitelist.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { inspectImage, fromBase64 } = require('../uitvoering/photos');
const { createImageCache } = require('../platform/image-cache');
const { legalDefaults } = require('./legal-pages');
const { GROUP_SLUGS, GROUP_NAMES, slugify } = require('./storefront-data');
const { DEFAULT_TREE } = require('./category-tree');

/** Bestanden in assets/ die als standaardafbeelding gekozen mogen worden. */
const ASSET_NAMES = new Set(fs.readdirSync(path.join(__dirname, 'assets')).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)));
/** Hoe lang (ms) de gepubliceerde inhoud per tenant onthouden wordt. */
const CACHE_MS = 30 * 1000;
/** Grenzen: afbeeldingen per tenant, grootte van een afbeelding, lengte van pagina-HTML en aantal pagina's. */
const MAX_IMAGES = 100;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;
const MAX_HTML = 100000;
const MAX_PAGES = 30;
/** Sleutel van het onderdeel met de blokken van de startpagina, kop en voet. */
const SITE_KEY = 'site';
/** Sleutel van het onderdeel met de menuboom (categorieën). */
const MENU_KEY = 'menu';
/** Grenzen van de menuboom: aantal categorieën en aantal niveaus onder een hoofdcategorie. */
const MAX_TREE_NODES = 600;
const MAX_TREE_DEPTH = 6;

/** De kleuren voor de mededelingenbalk (sleutel → naam in Beheer); de shop kent bij elke sleutel een vaste, goed leesbare achtergrond (storefront.css). */
const NOTICE_COLORS = { purple: 'Paars', navy: 'Donkerblauw', green: 'Groen', teal: 'Turquoise', orange: 'Oranje', red: 'Rood', grey: 'Grijs' };

/** Standaardinhoud: precies wat de shop toonde voordat deze te bewerken was. */
const DEFAULT_SITE = {
  notice: { enabled: true, color: 'purple', text: 'Welkom op onze webshop! Momenteel zijn wij nog volop producten aan het toevoegen. Mocht er wat ontbreken wat u zoekt, neem contact op!' },
  // Zoals aquatechshop.nl: een grote afbeelding zonder tekst (kop, tekst en knop zijn optioneel).
  hero: { image: 'asset:hero-tuin.jpg', title: '', text: '', button: '', link: '' },
  // Twee afbeeldingen naast elkaar met een kop en een knop.
  banners: {
    enabled: true,
    items: [
      { image: 'asset:banner-druppelslang.jpg', title: 'Efficiënt bewateren met een druppelslang', button: 'Druppelslangen bekijken', link: 'groep/beregening/' },
      { image: 'asset:banner-pomp.jpg', title: 'De beste beregeningspomp voor jouw sproei installatie', button: 'Beregeningspompen bekijken', link: 'groep/pomp-techniek/' },
    ],
  },
  // Kolommen met een kop en drie producten: uit een productgroep of een eigen lijst artikelcodes.
  columns: {
    enabled: true,
    items: [
      { title: 'Beregening', group: 'beregening', codes: [] },
      { title: 'Speciale producten', group: '', codes: [] },
      { title: 'Uitverkoop', group: '', codes: [] },
    ],
  },
  benefits: {
    enabled: true,
    items: [
      { image: 'asset:usp-assortiment.png', title: 'Zeer compleet assortiment', text: 'Direct alles voor jouw project in huis' },
      { image: 'asset:usp-bezorgd.png', title: 'Bezorgd op iedere locatie', text: 'Jouw producten op locatie bezorgd' },
      { image: 'asset:usp-prijzen.png', title: 'Scherpe zakelijke prijzen', text: 'Vraag jouw zakelijk account aan' },
    ],
  },
  brands: {
    enabled: true,
    title: 'Onze merken',
    items: [
      { image: 'asset:merk-ebara.png', name: 'Ebara' }, { image: 'asset:merk-metzerplas.jpg', name: 'Metzerplas' },
      { image: 'asset:merk-grundfos.jpg', name: 'Grundfos' }, { image: 'asset:merk-rainbird.png', name: 'Rain Bird' },
      { image: 'asset:merk-dab.webp', name: 'DAB' }, { image: 'asset:merk-pedrollo.webp', name: 'Pedrollo' },
    ],
  },
  quote: { enabled: true, text: 'Duurzaamheid door kwaliteit!' },
  business: { enabled: true, image: 'asset:zakelijk-achtergrond.jpg', title: 'Vraag direct een zakelijk account aan!', text: 'En ontvang interessante prijzen!', button: 'Account aanmaken', link: '', form: true },
  contact: { phone: '06 47212019', email: 'info@aquatechshop.nl', kvk: '88438252', address: 'Oenenburgweg 218, 8072 GP Nunspeet' },
  footer: { about: 'Beregening, leidingen en pompen voor tuin en bedrijf, van AquaTech Service in Nunspeet.' },
};

/** Tekst van de standaardpagina Over ons als startpunt voor de editor. */
const DEFAULT_ABOUT_BODY = '<h2>Aquatechshop.nl</h2><p>Aquatechshop.nl is ontstaan vanuit HVT Beregening, een gespecialiseerd bedrijf in beregenings- en watertechniek. Dankzij de ervaring in de sector kunnen wij onze klanten optimaal van dienst zijn. Korte lijnen, klanttevredenheid en efficiëntie zijn onze uitgangspunten.</p>'
  + '<h2>Scherpe tarieven</h2><p>Wij zijn totaalleverancier voor bedrijven, particulieren en organisaties. Door de goede en veelal rechtstreekse relaties met fabrikanten en leveranciers kunnen wij bewezen materialen en techniek leveren tegen zeer scherpe prijzen. Met ons koopt u als het ware de vruchten van een goed netwerk in combinatie met vakkennis en ervaring.</p>'
  + '<h2>Eigen technische dienst</h2><p>HVT Beregening is onze eigen technische dienst. Voor installatie en/of uitgebreid advies kunt u daarom ook bij ons terecht: <a href="https://www.hvtberegening.nl">www.hvtberegening.nl</a></p>'
  + '<h2>Waarom Aquatechshop?</h2><ul><li><strong>Kwaliteit</strong>: bewezen en beproefde producten</li><li><strong>Betrouwbaar</strong>: verbeter uw werk door samen te werken met een ervaren en betrouwbare partner.</li><li><strong>Levering op locatie</strong>: bezorging bij u op locatie, om u te ontzorgen</li><li><strong>Persoonlijke aandacht</strong>: of je nu een professional, ondernemer of particulier bent, maatwerk vinden wij belangrijk.</li></ul>'
  + '<p><strong>Kwaliteit, service en betaalbaarheid komen bij ons samen.</strong></p>';

// ---------- Saneren ----------

/**
 * Kort een tekst in na het weghalen van stuurtekens.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte.
 * @param {string} fallback Waarde als de invoer geen tekst is.
 * @returns {string} De opgeschoonde tekst (zonder witruimte aan de randen).
 */
function cleanText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * Een verwijzing naar een afbeelding: een standaardbestand ('asset:naam') of
 * een geüploade afbeelding ('media:<id>').
 * @param {*} value De invoer.
 * @param {string} fallback Waarde bij ongeldige invoer.
 * @returns {string} De verwijzing.
 */
function imageRef(value, fallback) {
  if (typeof value !== 'string') return fallback;
  if (/^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return value;
  const asset = /^asset:([\w.-]+)$/.exec(value);
  return asset && ASSET_NAMES.has(asset[1]) ? value : fallback;
}

/**
 * Een link van een knop: leeg (= standaard), een https-adres of een pad binnen de shop.
 * @param {*} value De invoer.
 * @returns {string} De link of een lege tekst.
 */
function linkRef(value) {
  const link = cleanText(value, 300);
  if (/^https?:\/\/[^\s"'<>]+$/i.test(link)) return link;
  return /^[a-z0-9][a-z0-9/_-]*\/?$/.test(link) ? link : '';
}

/**
 * Een lijst van blokken saneren; zonder lijst in de invoer blijft de terugvalwaarde.
 * @param {*} input De ingevoerde lijst.
 * @param {object[]} fallback Terugvalwaarde.
 * @param {number} max Maximaal aantal items.
 * @param {Function} cleanItem Maakt van een ingevoerd item een geldig item (of null om het te laten vallen).
 * @returns {object[]} De opgeschoonde lijst.
 */
function cleanList(input, fallback, max, cleanItem) {
  if (!Array.isArray(input)) return fallback;
  return input.slice(0, max).map((item) => cleanItem(item && typeof item === 'object' ? item : {})).filter(Boolean);
}

/**
 * Artikelcodes uit een lijst of een tekst met komma's: hoofdletters, geldige tekens, uniek, maximaal 6.
 * @param {*} value Een lijst of een tekst met komma's of regeleinden.
 * @returns {string[]} De codes.
 */
function cleanCodes(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]+/) : [];
  return [...new Set(list.map((code) => cleanText(String(code), 40).toUpperCase()).filter((code) => /^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code)))].slice(0, 6);
}

/**
 * Maakt van de ingevoerde blokken een geldige set (ontbrekende velden = de standaard).
 * @param {*} input De ingevoerde blokken.
 * @param {object} [base] Waar ontbrekende velden vandaan komen.
 * @returns {object} De opgeschoonde blokken (zie DEFAULT_SITE voor de vorm).
 */
function normalizeSite(input, base = DEFAULT_SITE) {
  const given = input && typeof input === 'object' ? input : {};
  /**
   * Eén onderdeel uit de invoer.
   * @param {string} name Naam van het onderdeel (bijv. 'hero').
   * @returns {object} Het onderdeel, of een leeg object als het ontbreekt.
   */
  const section = (name) => (given[name] && typeof given[name] === 'object' ? given[name] : {});
  /**
   * Een aan/uit-waarde uit de invoer.
   * @param {*} value De invoer.
   * @param {boolean} fallback Waarde als de invoer geen waar/onwaar is.
   * @returns {boolean} De waarde.
   */
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const notice = section('notice');
  const hero = section('hero');
  const benefits = section('benefits');
  const brands = section('brands');
  const banners = section('banners');
  const columns = section('columns');
  const quote = section('quote');
  const business = section('business');
  const contact = section('contact');
  const footer = section('footer');
  const email = cleanText(contact.email, 120, base.contact.email);
  return {
    notice: { enabled: flag(notice.enabled, base.notice.enabled), color: Object.hasOwn(NOTICE_COLORS, notice.color) ? notice.color : base.notice.color, text: cleanText(notice.text, 300, base.notice.text) },
    hero: {
      image: imageRef(hero.image, base.hero.image), title: cleanText(hero.title, 120, base.hero.title), text: cleanText(hero.text, 300, base.hero.text),
      button: cleanText(hero.button, 40, base.hero.button), link: 'link' in hero ? linkRef(hero.link) : base.hero.link,
    },
    banners: {
      enabled: flag(banners.enabled, base.banners.enabled),
      items: cleanList(banners.items, base.banners.items, 4, (item) => {
        const image = imageRef(item.image, '');
        return image ? { image, title: cleanText(item.title, 120), button: cleanText(item.button, 40), link: linkRef(item.link) } : null;
      }),
    },
    columns: {
      enabled: flag(columns.enabled, base.columns.enabled),
      items: cleanList(columns.items, base.columns.items, 3, (item) => {
        const title = cleanText(item.title, 60);
        return title ? { title, group: GROUP_SLUGS.includes(item.group) ? item.group : '', codes: cleanCodes(item.codes) } : null;
      }),
    },
    quote: { enabled: flag(quote.enabled, base.quote.enabled), text: cleanText(quote.text, 200, base.quote.text) },
    benefits: {
      enabled: flag(benefits.enabled, base.benefits.enabled),
      items: cleanList(benefits.items, base.benefits.items, 6, (item) => {
        const title = cleanText(item.title, 80);
        return title ? { image: imageRef(item.image, ''), title, text: cleanText(item.text, 160) } : null;
      }),
    },
    brands: {
      enabled: flag(brands.enabled, base.brands.enabled), title: cleanText(brands.title, 80, base.brands.title),
      items: cleanList(brands.items, base.brands.items, 16, (item) => {
        const image = imageRef(item.image, '');
        return image ? { image, name: cleanText(item.name, 60) } : null;
      }),
    },
    business: {
      enabled: flag(business.enabled, base.business.enabled), image: business.image === '' ? '' : imageRef(business.image, base.business.image),
      title: cleanText(business.title, 120, base.business.title), text: cleanText(business.text, 300, base.business.text),
      button: cleanText(business.button, 40, base.business.button), link: 'link' in business ? linkRef(business.link) : base.business.link,
      form: flag(business.form, base.business.form),
    },
    contact: {
      phone: cleanText(contact.phone, 30, base.contact.phone).replace(/[^0-9 +()-]/g, ''),
      email: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : base.contact.email,
      kvk: cleanText(contact.kvk, 20, base.contact.kvk).replace(/[^0-9A-Za-z .-]/g, ''),
      address: cleanText(contact.address, 120, base.contact.address),
    },
    footer: { about: cleanText(footer.about, 300, base.footer.about) },
  };
}

/**
 * Maakt van de ingevoerde menuboom een geldige boom: één hoofdcategorie per productgroep (ontbrekende
 * groepen komen uit de basis), met per categorie naam, vaste slug (het adres), uitleg, afbeelding,
 * verborgen-vlag en de webshopcategorieën waarop producten worden ingedeeld.
 * @param {*} input De ingevoerde lijst hoofdcategorieën (met `group` en `children`).
 * De vier koppen tellen niet mee voor de grens van MAX_TREE_NODES categorieën; bij `strict` wordt een te grote boom geweigerd
 * (fout met `code: 'tree_too_large'`) in plaats van stil ingekort, zodat een opgeslagen concept nooit categorieën verliest.
 * @param {object[]} [base] Waar ontbrekende hoofdcategorieën vandaan komen (standaard de boom van Aquatechshop.nl).
 * @param {{ strict?: boolean }} [options] strict = weiger een boom met meer dan MAX_TREE_NODES categorieën.
 * @returns {object[]} De opgeschoonde boom, hoofdcategorieën in vaste volgorde.
 */
function normalizeTree(input, base = DEFAULT_TREE, options = {}) {
  const given = Array.isArray(input) ? input : [];
  const used = new Set();
  const needSlug = [];
  let count = 0;
  /**
   * Maakt van een invoerknoop een geldige knoop met kinderen (of null als hij vervalt).
   * @param {*} item De ingevoerde knoop.
   * @param {number} depth Diepte (0 = hoofdcategorie).
   * @returns {?object} De knoop.
   */
  const cleanNode = (item, depth) => {
    if (!item || typeof item !== 'object' || depth > MAX_TREE_DEPTH) return null;
    const name = cleanText(item.name, 80);
    if (!name) return null;
    if (depth > 0) count += 1;
    const node = { name, slug: '' };
    const wanted = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (/^[a-z0-9_-]{1,60}$/.test(wanted) && !used.has(wanted)) { node.slug = wanted; used.add(wanted); } else needSlug.push(node);
    const intro = cleanText(item.intro, 2000);
    if (intro) node.intro = intro;
    const image = imageRef(item.image, '');
    if (image) node.image = image;
    if (item.hidden === true) node.hidden = true;
    const match = Array.isArray(item.match) ? [...new Set(item.match.map((entry) => cleanText(String(entry), 80)).filter(Boolean))].slice(0, 8) : [];
    if (match.length) node.match = match;
    const children = Array.isArray(item.children) ? item.children.map((child) => cleanNode(child, depth + 1)).filter(Boolean) : [];
    if (children.length) node.children = children;
    return node;
  };
  const roots = [];
  for (const group of GROUP_SLUGS.filter((slug) => slug !== 'overig')) {
    const givenRoot = given.find((root) => root && root.group === group);
    // Een aangeleverde kop met een lege of ongeldige naam telt niet: dan blijft de kop uit de basis (bijv. de gepubliceerde) staan.
    const root = (givenRoot && cleanNode(givenRoot, 0)) || cleanNode(base.find((entry) => entry.group === group), 0);
    if (root) roots.push({ ...root, group });
  }
  if (options.strict && count > MAX_TREE_NODES) throw Object.assign(new Error(`De menuboom heeft maximaal ${MAX_TREE_NODES} categorieën.`), { code: 'tree_too_large' });
  for (const node of needSlug) {
    const stem = slugify(node.name) || 'categorie';
    let slug = stem.slice(0, 60);
    // Het achtervoegsel past binnen de 60 tekens: de stam wordt ingekort, niet het resultaat afgekapt (anders blijft de slug gelijk).
    for (let counter = 2; used.has(slug); counter += 1) slug = `${stem.slice(0, 60 - String(counter).length - 1)}-${counter}`;
    node.slug = slug;
    used.add(slug);
  }
  return roots;
}

/** Elementen die in pagina's mogen blijven; de rest vervalt (de tekst erin blijft). */
const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'br', 'blockquote', 'a', 'img']);
/** Andere elementen die we omzetten naar een toegestaan element. */
const TAG_ALIASES = { b: 'strong', i: 'em', h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', div: 'p' };
/** Elementen waarvan ook de inhoud vervalt. */
const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'head', 'title']);
const MAX_DEPTH = 20;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#160': ' ' };

/**
 * Zet de gangbare HTML-entiteiten om naar tekens (in één keer, zodat een
 * ontsnapte entiteit niet dubbel wordt omgezet).
 * @param {string} text Tekst met entiteiten.
 * @returns {string} De tekst met tekens.
 */
const decodeEntities = (text) => text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27|#160);/g, (_, name) => ENTITIES[name]);

/**
 * Maakt tekst veilig voor in HTML (tekst en attributen).
 * @param {string} text De tekst.
 * @returns {string} De ontsnapte tekst.
 */
const escapeText = (text) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/**
 * Leest de attributen uit de tekst van een openend element.
 * @param {string} raw Alles tussen de elementnaam en '>'.
 * @returns {object} Attribuutnaam (kleine letters) → waarde zonder entiteiten.
 */
function attributesOf(raw) {
  const attributes = {};
  for (const match of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Saneert de HTML van een pagina met een whitelist: alleen opmaak (kopjes,
 * alinea's, lijsten, vet, cursief, citaat), links (https, mailto, tel) en
 * eigen afbeeldingen (src="media:<id>"). Scripts, stijlen, gebeurtenis- en
 * andere attributen verdwijnen; open elementen worden gesloten.
 * @param {*} html De ingevoerde HTML.
 * @returns {string} Schone HTML.
 */
function sanitizeHtml(html) {
  const source = String(html ?? '').slice(0, MAX_HTML * 2);
  const output = [];
  const open = [];
  let skipping = '';
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)|</g)) {
    const [whole, slash, rawName, rawAttributes, text] = match;
    if (text !== undefined) { if (!skipping) output.push(escapeText(decodeEntities(text))); continue; }
    if (rawName === undefined) { if (!skipping && whole === '<') output.push('&lt;'); continue; }
    const closing = slash === '/';
    let name = rawName.toLowerCase();
    if (skipping) { if (closing && name === skipping) skipping = ''; continue; }
    if (BLOCKED_TAGS.has(name)) { if (!closing && !whole.endsWith('/>')) skipping = name; continue; }
    name = TAG_ALIASES[name] || name;
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      const position = open.lastIndexOf(name);
      if (position >= 0) while (open.length > position) output.push(`</${open.pop()}>`);
      continue;
    }
    const attributes = attributesOf(rawAttributes);
    if (name === 'br') { output.push('<br>'); continue; }
    if (name === 'img') {
      if (/^media:[0-9a-f-]{36}$/.test(attributes.src || '') && imageRef(attributes.src, '')) output.push(`<img src="${attributes.src}" alt="${escapeText(cleanText(attributes.alt, 200))}">`);
      continue;
    }
    if (open.length >= MAX_DEPTH) continue;
    if (name === 'a') {
      const href = (attributes.href || '').replace(/[\u0000-\u001f\u007f\s]+/g, '');
      if (!/^(https?:\/\/[^"'<>]{1,500}|mailto:[^"'<>]{1,200}|tel:[+0-9()-]{3,30})$/i.test(href)) continue;
      output.push(`<a href="${escapeText(href)}" rel="noopener noreferrer">`);
    } else {
      output.push(`<${name}>`);
    }
    open.push(name);
  }
  while (open.length) output.push(`</${open.pop()}>`);
  return output.join('');
}

/**
 * Maakt van de ingevoerde velden van een pagina een geldige pagina.
 * @param {string} slug De naam in het adres (a-z, 0-9, streepjes).
 * @param {*} input De ingevoerde velden (title, description, body, menu, footer, order).
 * @returns {{ page?: object, error?: string, message?: string }} De pagina, of een fout.
 */
function normalizePage(slug, input) {
  const given = input && typeof input === 'object' ? input : {};
  if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) return { error: 'invalid_slug', message: 'De naam in het adres bestaat uit 3 tot 60 kleine letters, cijfers en streepjes.' };
  const title = cleanText(given.title, 120);
  if (!title) return { error: 'title_required', message: 'Geef de pagina een titel.' };
  if (typeof given.body === 'string' && given.body.length > MAX_HTML) return { error: 'too_long', message: 'De tekst is te lang.' };
  const body = sanitizeHtml(given.body);
  if (body.length > MAX_HTML) return { error: 'too_long', message: 'De tekst is te lang.' };
  const order = Number.isFinite(Number(given.order)) ? Math.max(0, Math.min(999, Math.round(Number(given.order)))) : 100;
  return { page: { slug, title, description: cleanText(given.description, 200), body, menu: given.menu === true, footer: given.footer !== false, order } };
}

// ---------- Opslag ----------

/**
 * Leest JSON uit een kolom.
 * @param {*} text De opgeslagen tekst.
 * @returns {object|null} Het object, of null bij leeg of ongeldig.
 */
function parseJson(text) {
  if (!text) return null;
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Maakt de opslag voor de inhoud van de webshop.
 * @param {object} db De database.
 * @param {{ vault: object }} stores De kluis (sealBytes/openBytes).
 * @returns {object} Functies voor concept en publiceren (`state`, `saveDraft`, `publish`, `discard`, `revert`, `removePage`), de openbare inhoud (`publicContent`) en afbeeldingen (`addImage`, `listImages`, `imageFile`, `removeImage`, `forgetImages`).
 */
function createShopContentStore(db, { vault }) {
  /** Gepubliceerde inhoud per tenant (korte cache). */
  const cache = new Map();
  /** Ontsleutelde afbeeldingen in het geheugen: elke bezoeker van de shop vraagt dezelfde op. */
  const memory = createImageCache({ maxBytes: 24 * 1024 * 1024 });
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const COLUMNS = 'key, draft, published, previous, updated_at, updated_by, published_at';

  /**
   * Alle onderdelen van een tenant.
   * @param {string} tenantId Id van de tenant.
   * @returns {object[]} Rijen met key, draft, published, previous en tijdstippen.
   */
  const rowsOf = (tenantId) => prepare(`SELECT ${COLUMNS} FROM shop_content WHERE tenant_id = ? ORDER BY key`).all(tenantId);
  /**
   * Eén onderdeel van een tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key 'site' of 'page:<slug>'.
   * @returns {object|undefined} De rij.
   */
  const rowOf = (tenantId, key) => prepare(`SELECT ${COLUMNS} FROM shop_content WHERE tenant_id = ? AND key = ?`).get(tenantId, key);
  /**
   * Vergeet de onthouden gepubliceerde inhoud van een tenant.
   * @param {string} tenantId Id van de tenant.
   * @returns {void}
   */
  const forget = (tenantId) => { cache.delete(tenantId); };

  /**
   * Beschrijft een onderdeel voor Beheer.
   * @param {object} row De rij uit shop_content.
   * @returns {object} draft, published (objecten of null), hasDraft, canRevert, updatedAt en publishedAt.
   */
  function describe(row) {
    const draft = parseJson(row.draft);
    const published = parseJson(row.published);
    return { draft, published, hasDraft: Boolean(draft), canRevert: Boolean(row.previous), updatedAt: row.updated_at, publishedAt: row.published_at || null };
  }

  /**
   * Alle bewerkbare inhoud van een tenant voor Beheer: blokken en pagina's met concept en gepubliceerde versie.
   * @param {string} tenantId Id van de tenant.
   * @returns {{ site: object, menu: object, pages: object[] }} De blokken en de menuboom (draft/published/…) en de pagina's (met slug).
   */
  function state(tenantId) {
    const rows = rowsOf(tenantId);
    const siteRow = rows.find((row) => row.key === SITE_KEY);
    const site = siteRow ? describe(siteRow) : { draft: null, published: null, hasDraft: false, canRevert: false, updatedAt: null, publishedAt: null };
    const menuRow = rows.find((row) => row.key === MENU_KEY);
    const menu = menuRow ? describe(menuRow) : { draft: null, published: null, hasDraft: false, canRevert: false, updatedAt: null, publishedAt: null };
    const pages = rows.filter((row) => row.key.startsWith('page:')).map((row) => ({ slug: row.key.slice(5), ...describe(row) }));
    return { site, menu, pages };
  }

  /**
   * Slaat een concept op (nieuw onderdeel of wijziging); de gepubliceerde versie blijft ongemoeid.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key 'site' of 'page:<slug>'.
   * @param {object} data De al gesaneerde inhoud.
   * @param {string|null} userId Wie het opslaat.
   * @returns {{ error?: string, message?: string }} Leeg bij succes.
   */
  function saveDraft(tenantId, key, data, userId) {
    const now = currentTimestamp();
    const existing = rowOf(tenantId, key);
    if (existing) {
      prepare('UPDATE shop_content SET draft = ?, updated_at = ?, updated_by = ? WHERE tenant_id = ? AND key = ?').run(JSON.stringify(data), now, userId, tenantId, key);
    } else {
      if (key.startsWith('page:') && rowsOf(tenantId).filter((row) => row.key.startsWith('page:')).length >= MAX_PAGES) return { error: 'too_many', message: `Er kunnen maximaal ${MAX_PAGES} pagina's zijn.` };
      prepare('INSERT INTO shop_content (id, tenant_id, key, draft, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), tenantId, key, JSON.stringify(data), now, userId);
    }
    return {};
  }

  /**
   * Maakt het concept de gepubliceerde versie; de vorige gepubliceerde versie blijft bewaard voor terugzetten.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key 'site' of 'page:<slug>'.
   * @param {string|null} userId Wie publiceert.
   * @returns {{ error?: string, message?: string }} Leeg bij succes.
   */
  function publish(tenantId, key, userId) {
    const row = rowOf(tenantId, key);
    if (!row || !row.draft) return { error: 'no_draft', message: 'Er is geen concept om te publiceren.' };
    const now = currentTimestamp();
    prepare('UPDATE shop_content SET previous = ?, published = ?, draft = NULL, published_at = ?, published_by = ?, updated_at = ? WHERE tenant_id = ? AND key = ?')
      .run(row.published, row.draft, now, userId, now, tenantId, key);
    forget(tenantId);
    return {};
  }

  /**
   * Gooit het concept weg. Een onderdeel dat nooit is gepubliceerd verdwijnt dan helemaal.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key 'site' of 'page:<slug>'.
   * @returns {{ error?: string, message?: string }} Leeg bij succes.
   */
  function discard(tenantId, key) {
    const row = rowOf(tenantId, key);
    if (!row) return { error: 'not_found', message: 'Niet gevonden.' };
    if (!row.published) prepare('DELETE FROM shop_content WHERE tenant_id = ? AND key = ?').run(tenantId, key);
    else prepare('UPDATE shop_content SET draft = NULL, updated_at = ? WHERE tenant_id = ? AND key = ?').run(currentTimestamp(), tenantId, key);
    forget(tenantId);
    return {};
  }

  /**
   * Zet de vorige gepubliceerde versie terug (de huidige wordt de "vorige"); een concept vervalt.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key 'site' of 'page:<slug>'.
   * @param {string|null} userId Wie het terugzet.
   * @returns {{ error?: string, message?: string }} Leeg bij succes.
   */
  function revert(tenantId, key, userId) {
    const row = rowOf(tenantId, key);
    if (!row || !row.previous) return { error: 'no_previous', message: 'Er is geen vorige versie.' };
    const now = currentTimestamp();
    prepare('UPDATE shop_content SET published = ?, previous = ?, draft = NULL, published_at = ?, published_by = ?, updated_at = ? WHERE tenant_id = ? AND key = ?')
      .run(row.previous, row.published, now, userId, now, tenantId, key);
    forget(tenantId);
    return {};
  }

  /**
   * Verwijdert een pagina helemaal (ook de gepubliceerde versie).
   * @param {string} tenantId Id van de tenant.
   * @param {string} slug De naam in het adres.
   * @returns {boolean} true als de pagina bestond.
   */
  function removePage(tenantId, slug) {
    const changes = prepare('DELETE FROM shop_content WHERE tenant_id = ? AND key = ?').run(tenantId, `page:${slug}`).changes;
    forget(tenantId);
    return changes > 0;
  }

  /**
   * De inhoud voor de shop: blokken en pagina's, gepubliceerd of (voorbeeld) het concept.
   * @param {string} tenantId Id van de tenant.
   * @param {{ preview?: boolean }} [options] preview: concept gaat voor de gepubliceerde versie (niet onthouden).
   * @returns {{ site: object, pages: object[], tree: object[] }} site = alle blokken (standaard waar niets is opgeslagen), pages = pagina's op volgorde en tree = de menuboom (standaard waar niets is opgeslagen).
   */
  function publicContent(tenantId, { preview = false } = {}) {
    const hit = !preview && cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const pages = [];
    let site = DEFAULT_SITE;
    let tree = DEFAULT_TREE;
    for (const row of rowsOf(tenantId)) {
      const data = parseJson(preview ? row.draft || row.published : row.published);
      if (!data) continue;
      if (row.key === SITE_KEY) site = normalizeSite(data);
      else if (row.key === MENU_KEY) tree = normalizeTree(data.roots);
      else if (row.key.startsWith('page:')) pages.push({ ...data, slug: row.key.slice(5) });
    }
    pages.sort((left, right) => (left.order - right.order) || left.title.localeCompare(right.title, 'nl'));
    const value = { site, pages, tree };
    if (!preview) cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  // ----- Afbeeldingen -----

  /**
   * AAD voor het versleutelen van een afbeelding.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de afbeelding.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id) => `${tenantId}:shop-afbeelding:${id}`;

  /**
   * Beschrijving van een afbeelding voor Beheer.
   * @param {object} row Rij uit shop_images (zonder data).
   * @returns {object} id, name, mime, width, height, size en createdAt.
   */
  const imageMeta = (row) => ({ id: row.id, name: row.name, mime: row.mime, width: row.width, height: row.height, size: Number(row.size), createdAt: row.created_at });

  /**
   * Alle geüploade afbeeldingen van een tenant, nieuwste eerst.
   * @param {string} tenantId Id van de tenant.
   * @returns {object[]} De afbeeldingen zonder inhoud.
   */
  const listImages = (tenantId) => prepare('SELECT id, name, mime, width, height, size, created_at FROM shop_images WHERE tenant_id = ? ORDER BY created_at DESC, id').all(tenantId).map(imageMeta);

  /**
   * Controleert en bewaart een afbeelding (JPEG, PNG of WebP, gecontroleerd op inhoud; EXIF gaat eruit).
   * @param {string} tenantId Id van de tenant.
   * @param {string|null} userId Wie uploadt.
   * @param {{ name?: string, data?: string }} input Bestandsnaam en base64-inhoud (eventueel als data-URL).
   * @returns {{ image?: object, error?: string, message?: string }} De afbeelding of een fout.
   */
  function addImage(tenantId, userId, input) {
    const raw = fromBase64(input && input.data);
    if (!raw || !raw.length) return { error: 'invalid_image', message: 'Dit is geen geldige afbeelding.' };
    if (raw.length > MAX_IMAGE_BYTES) return { error: 'too_large', message: `De afbeelding is te groot (maximaal ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` };
    const image = inspectImage(raw);
    if (!image || image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE) return { error: 'invalid_image', message: 'Alleen JPEG, PNG of WebP tot 8000 pixels.' };
    if (Number(prepare('SELECT COUNT(*) AS n FROM shop_images WHERE tenant_id = ?').get(tenantId).n) >= MAX_IMAGES) return { error: 'too_many', message: `Er kunnen maximaal ${MAX_IMAGES} afbeeldingen zijn. Verwijder eerst een ongebruikte.` };
    const id = crypto.randomUUID();
    const name = cleanText(String(input.name || '').replace(/^.*[\\/]/, ''), 80) || 'afbeelding';
    const createdAt = currentTimestamp();
    prepare('INSERT INTO shop_images (id, tenant_id, name, mime, width, height, size, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, tenantId, name, image.mime, image.width, image.height, image.body.length, vault.sealBytes(image.body, aadOf(tenantId, id)), createdAt, userId);
    return { image: imageMeta({ id, name, mime: image.mime, width: image.width, height: image.height, size: image.body.length, created_at: createdAt }) };
  }

  /**
   * De inhoud van een afbeelding.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de afbeelding.
   * @returns {{ mime: string, body: Buffer }|null} De afbeelding, of null als hij niet bestaat of niet te lezen is.
   */
  function imageFile(tenantId, id) {
    const remembered = memory.get(tenantId, String(id));
    if (remembered) return remembered;
    const row = prepare('SELECT mime, data FROM shop_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!row) return null;
    let found;
    try { found = { mime: row.mime, body: vault.openBytes(row.data, aadOf(tenantId, String(id))) }; } catch { return null; }
    memory.set(tenantId, String(id), found);
    return found;
  }

  /**
   * Of een afbeelding nog in een concept of gepubliceerde versie voorkomt.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de afbeelding.
   * @returns {boolean} true als hij in gebruik is.
   */
  function imageInUse(tenantId, id) {
    return rowsOf(tenantId).some((row) => [row.draft, row.published, row.previous].some((json) => json && json.includes(`media:${id}`)));
  }

  /**
   * Verwijdert een afbeelding die nergens meer wordt gebruikt.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de afbeelding.
   * @returns {{ error?: string, message?: string }} Leeg bij succes.
   */
  function removeImage(tenantId, id) {
    if (!prepare('SELECT id FROM shop_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(id))) return { error: 'not_found', message: 'Afbeelding niet gevonden.' };
    if (imageInUse(tenantId, String(id))) return { error: 'in_use', message: 'Deze afbeelding wordt nog gebruikt in een blok of pagina.' };
    prepare('DELETE FROM shop_images WHERE tenant_id = ? AND id = ?').run(tenantId, String(id));
    memory.remove(tenantId, String(id));
    return {};
  }

  /**
   * Vergeet de afbeeldingen van een omgeving in het geheugen (na leegmaken of verwijderen van de omgeving).
   * @param {string} tenantId Id van de tenant.
   * @returns {void}
   */
  const forgetImages = (tenantId) => memory.clearTenant(tenantId);

  return { state, saveDraft, publish, discard, revert, removePage, publicContent, listImages, addImage, imageFile, removeImage, forgetImages };
}

// ---------- Routes (Beheer) ----------

/**
 * Registreert de beheer-API van de webshop-inhoud (alleen beheerders; de
 * server zet requireAdmin al voor /api/admin) en geeft de pagina's.
 * @param {object} app De Express-app.
 * @param {{ content: object, requireJson: Function, audit: Function, mainTenantId: string, settingsOf: Function, unplacedOf?: Function }} options content = de opslag, requireJson = eist JSON, audit = auditregel schrijven, mainTenantId = de tenant met de eigen webshop, settingsOf(req) = instellingen van de omgeving van het verzoek en unplacedOf(tenantId) = de webshopcategorieën die niet in de menuboom staan ({ name, count, groupSlug }).
 * @returns {void}
 */
function registerShopContentRoutes(app, { content, requireJson, audit, mainTenantId, settingsOf, unplacedOf = () => [] }) {
  const BASE = '/api/admin/shop-content';
  /**
   * De webshop hoort bij de hoofdtenant: in een andere omgeving is er niets te bewerken.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  const onlyMain = (req, res, next) => (req.tenantId === mainTenantId ? next() : res.status(404).json({ error: 'not_found', message: 'De webshop-inhoud geldt alleen voor de hoofdorganisatie.' }));

  /**
   * De naam in het adres van een pagina (kleine letters).
   * @param {object} req Het verzoek.
   * @returns {string} De naam.
   */
  const slugOf = (req) => String(req.params.slug || '').toLowerCase();
  /**
   * Antwoord met de volledige stand van de inhoud voor Beheer.
   * @param {object} req Het verzoek.
   * @returns {object} available, storefront (aan?), site, menu, pages, images, unplaced, defaults en assets.
   */
  function view(req) {
    const stored = content.state(req.tenantId);
    return {
      available: true, storefront: Boolean(settingsOf(req).get('storefront')),
      site: { ...stored.site, isDefault: !stored.site.published },
      menu: { ...stored.menu, isDefault: !stored.menu.published }, unplaced: unplacedOf(req.tenantId),
      pages: stored.pages, images: content.listImages(req.tenantId),
      noticeColors: NOTICE_COLORS,
      groups: GROUP_NAMES,
      defaults: { site: DEFAULT_SITE, menu: { roots: DEFAULT_TREE }, aboutBody: DEFAULT_ABOUT_BODY, legal: legalDefaults(((stored.site.draft || stored.site.published) || {}).contact || DEFAULT_SITE.contact) }, assets: [...ASSET_NAMES].sort(),
    };
  }
  /**
   * Zet een uitkomst van de opslag om in een antwoord.
   * @param {object} res Het antwoord.
   * @param {object} outcome Uitkomst met eventueel error en message.
   * @param {Function} success Wordt aangeroepen bij succes.
   * @returns {void}
   */
  const reply = (res, outcome, success) => (outcome.error ? res.status(outcome.error === 'not_found' ? 404 : 409).json({ error: outcome.error, message: outcome.message }) : success());

  app.get(BASE, (req, res) => {
    if (req.tenantId !== mainTenantId) return res.json({ available: false, message: 'De webshop-inhoud geldt alleen voor de hoofdorganisatie.' });
    res.json(view(req));
  });

  app.put(`${BASE}/site`, onlyMain, requireJson, (req, res) => {
    const current = content.state(req.tenantId).site;
    const data = normalizeSite(req.body, normalizeSite(current.published || {}));
    content.saveDraft(req.tenantId, SITE_KEY, data, req.user?.id || null);
    audit(req, 'webshop_inhoud_concept', { onderdeel: 'blokken' });
    res.json(view(req));
  });
  app.put(`${BASE}/menu`, onlyMain, requireJson, (req, res) => {
    const current = content.state(req.tenantId).menu;
    let roots;
    try {
      roots = normalizeTree(req.body && req.body.roots, current.published ? normalizeTree(current.published.roots) : DEFAULT_TREE, { strict: true });
    } catch (error) {
      if (error.code !== 'tree_too_large') throw error;
      return res.status(400).json({ error: error.code, message: error.message });
    }
    content.saveDraft(req.tenantId, MENU_KEY, { roots }, req.user?.id || null);
    audit(req, 'webshop_inhoud_concept', { onderdeel: 'menuboom' });
    res.json(view(req));
  });
  app.put(`${BASE}/pages/:slug`, onlyMain, requireJson, (req, res) => {
    const checked = normalizePage(slugOf(req), req.body);
    if (checked.error) return res.status(400).json({ error: checked.error, message: checked.message });
    reply(res, content.saveDraft(req.tenantId, `page:${checked.page.slug}`, checked.page, req.user?.id || null), () => {
      audit(req, 'webshop_inhoud_concept', { onderdeel: 'pagina', pagina: checked.page.slug });
      res.json(view(req));
    });
  });
  // Publiceren, concept weggooien en vorige versie terugzetten gelden voor de blokken en voor een pagina.
  for (const [action, label] of [['publish', 'gepubliceerd'], ['discard', 'concept_verworpen'], ['revert', 'teruggezet']]) {
    /**
     * Maakt de route voor deze actie van een onderdeel.
     * @param {Function} keyOf Haalt de sleutel van het onderdeel uit het verzoek.
     * @param {Function} detailOf Haalt de auditgegevens uit het verzoek.
     * @returns {Function} De route.
     */
    const handle = (keyOf, detailOf) => (req, res) => {
      const key = keyOf(req);
      const outcome = content[action](req.tenantId, key, req.user?.id || null);
      reply(res, outcome, () => {
        audit(req, `webshop_inhoud_${label}`, detailOf(req));
        res.json(view(req));
      });
    };
    app.post(`${BASE}/site/${action}`, onlyMain, requireJson, handle(() => SITE_KEY, () => ({ onderdeel: 'blokken' })));
    app.post(`${BASE}/menu/${action}`, onlyMain, requireJson, handle(() => MENU_KEY, () => ({ onderdeel: 'menuboom' })));
    app.post(`${BASE}/pages/:slug/${action}`, onlyMain, requireJson, handle((req) => `page:${slugOf(req)}`, (req) => ({ onderdeel: 'pagina', pagina: slugOf(req) })));
  }
  app.delete(`${BASE}/pages/:slug`, onlyMain, (req, res) => {
    if (!content.removePage(req.tenantId, slugOf(req))) return res.status(404).json({ error: 'not_found', message: 'Pagina niet gevonden.' });
    audit(req, 'webshop_pagina_verwijderd', { pagina: slugOf(req) });
    res.json(view(req));
  });

  app.post(`${BASE}/images`, onlyMain, requireJson, (req, res) => {
    const out = content.addImage(req.tenantId, req.user?.id || null, req.body);
    if (out.error) return res.status(out.error === 'too_large' ? 413 : 400).json({ error: out.error, message: out.message });
    audit(req, 'webshop_afbeelding_toegevoegd', { afbeelding: out.image.id, naam: out.image.name });
    res.status(201).json({ image: out.image, images: content.listImages(req.tenantId) });
  });
  app.get(`${BASE}/images/:id`, onlyMain, (req, res) => {
    const file = /^[0-9a-f-]{36}$/.test(req.params.id) ? content.imageFile(req.tenantId, req.params.id) : null;
    if (!file) return res.status(404).end();
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(file.mime).send(file.body);
  });
  app.delete(`${BASE}/images/:id`, onlyMain, (req, res) => {
    reply(res, content.removeImage(req.tenantId, req.params.id), () => {
      audit(req, 'webshop_afbeelding_verwijderd', { afbeelding: req.params.id });
      res.json({ images: content.listImages(req.tenantId) });
    });
  });
}

module.exports = { NOTICE_COLORS, createShopContentStore, registerShopContentRoutes, normalizeSite, normalizeTree, normalizePage, sanitizeHtml, DEFAULT_SITE, DEFAULT_ABOUT_BODY, SITE_KEY, MENU_KEY };
