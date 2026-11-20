// HTML van de eigen webshop (storefront.js): startpagina, hoofdcategorie,
// categorie, zoeken, productpagina en "niet gevonden". Server-side opgebouwd, zonder scripts.
// Alle adressen zijn relatief ten opzichte van de huidige pagina (`root` =
// '', '../' of '../../'), zodat de shop ook onder een padprefix achter een
// proxy werkt.

const fs = require('fs');
const path = require('path');
const { version: SHOP_VERSION } = require('../../package.json');
const { DEFAULT_SITE } = require('./shop-content');
const { LEGAL_SLUGS, LEGAL_TITLES } = require('./legal-pages');
const Seo = require('./seo');
const { blocksOf, faqEntriesOfBlocks } = require('./page-blocks');
const Analytics = require('./shop-analytics');

const SHOP_NAME = 'Aquatechshop.nl';
/** Maximaal aantal resultaten op de zoekpagina. */
const MAX_SEARCH_RESULTS = 60;
/** Aantal subcategorieën per hoofdcategorie op de startpagina. */
const HOME_SUBCATEGORIES = 6;
/** Sleutel van de pagina uit Beheer waarvan de koppen vragen en de tekst eronder antwoorden zijn (wordt een FAQPage voor zoekmachines). */
const FAQ_SLUG = 'veelgestelde-vragen';

/**
 * Maakt tekst veilig voor in HTML (tekst en attributen).
 * @param {*} value De tekst.
 * @returns {string} De ontsnapte tekst.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

/**
 * Zet een bedrag om naar Nederlandse notatie: € 1.234,50.
 * @param {number} amount Het bedrag.
 * @returns {string} De opgemaakte prijs.
 */
function formatPrice(amount) {
  return `€ ${Number(amount).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** De inhoud (blokken en pagina's uit Beheer) waarmee de pagina's die nu worden opgebouwd, worden getekend. */
let activeContent = { site: DEFAULT_SITE, pages: [] };
/** Of bestellen aan staat, hoeveel regels er in de winkelwagen van de bezoeker zitten en of hij een groothandelsklant is, met het kopje Groothandel (voor de pagina's die nu worden opgebouwd). */
let activeShop = { indexing: false, ordering: false, cartCount: 0, business: false, staff: false, wholesale: false, baseUrl: '', analytics: '', clarity: '', captcha: '' };

/**
 * De velden die een formulier nodig heeft voor de onzichtbare captcha: het verborgen veld waar het script een token in zet en de
 * verplichte vermelding van Google (het kenmerk van reCAPTCHA zelf is verborgen). Leeg als de captcha uit staat.
 * @param {string} action De actienaam van het formulier (zie ACTIONS in beveiliging/captcha.js).
 * @returns {string} De HTML, leeg zonder captcha.
 */
function captchaFields(action) {
  if (!activeShop.captcha) return '';
  return `<input type="hidden" name="captchaToken" value="" data-site-key="${escapeHtml(activeShop.captcha)}" data-captcha-action="${escapeHtml(action)}">
<p class="captcha-note">Deze site wordt beschermd door reCAPTCHA. Het <a href="https://policies.google.com/privacy" rel="noopener noreferrer" target="_blank">privacybeleid</a> en de <a href="https://policies.google.com/terms" rel="noopener noreferrer" target="_blank">servicevoorwaarden</a> van Google zijn van toepassing.</p>`;
}

/**
 * Bouwt pagina's op met de inhoud uit Beheer. Het opbouwen is synchroon, dus
 * zolang `render` loopt hoort elke pagina bij deze inhoud; daarna geldt weer de vorige.
 * @param {{ site: object, pages: object[] }} content De inhoud (zie shop-content.js, publicContent).
 * @param {Function} render Functie die de pagina('s) opbouwt en iets teruggeeft.
 * @param {{ ordering: boolean, cartCount: number, business?: boolean, wholesale?: boolean, baseUrl?: string }} [shop] Het volledige webadres van de shop (met slash achteraan; leeg = geen canonical-link en OpenGraph), of bestellen aan staat, het aantal regels in de winkelwagen, of de bezoeker een zakelijke klant is (prijzen excl. btw) en of hij groothandelsklant is (kopje Groothandel).
 * @returns {*} Wat `render` teruggeeft.
 */
function renderWith(content, render, shop = { indexing: false, ordering: false, cartCount: 0, business: false, staff: false, wholesale: false, baseUrl: '', analytics: '', clarity: '', captcha: '' }) {
  const previous = activeContent;
  const previousShop = activeShop;
  activeContent = content;
  activeShop = shop;
  try { return render(); } finally { activeContent = previous; activeShop = previousShop; }
}

/**
 * Het adres van een afbeelding uit Beheer: een standaardbestand of een geüploade afbeelding.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} reference 'asset:<bestand>' of 'media:<id>'.
 * @returns {string} Het (relatieve) adres, of een lege tekst als er geen afbeelding is.
 */
function imageSrc(root, reference) {
  const [kind, name] = String(reference || '').split(':');
  if (kind === 'asset' && name) return assetUrl(root, name);
  return kind === 'media' && name ? `${root}media/${escapeHtml(name)}` : '';
}

/** Namen van de bestanden in de map assets/ (om te weten van welke afbeeldingen een WebP-variant bestaat). */
const ASSET_NAMES = new Set(fs.readdirSync(path.join(__dirname, 'assets')));

/**
 * Een afbeelding uit Beheer als img, met een WebP-variant als picture als die bestaat. Een standaardbestand `<naam>.jpg|png` krijgt
 * `<naam>.webp` (en `<naam>-klein.webp` voor smalle schermen) als die in assets/ staan (zie tools/shop-webp.py); geüploade
 * afbeeldingen en bestanden zonder WebP blijven een gewone img.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} reference 'asset:<bestand>' of 'media:<id>' (zie imageSrc).
 * @param {{ attributes?: string, sizes?: string }} [options] attributes = extra attributen voor de img (al ontsnapt, bijv. alt en loading), sizes = de sizes-waarde als er een kleine variant is.
 * @returns {string} De HTML, of een lege tekst als er geen afbeelding is.
 */
function imageHtml(root, reference, { attributes = '', sizes = '100vw' } = {}) {
  const source = imageSrc(root, reference);
  if (!source) return '';
  const img = `<img src="${source}"${attributes ? ` ${attributes}` : ''}>`;
  const [kind, name] = String(reference || '').split(':');
  const stem = kind === 'asset' ? /^([a-z0-9-]+)\.(?:jpg|png)$/i.exec(name || '') : null;
  if (!stem || !ASSET_NAMES.has(`${stem[1]}.webp`)) return img;
  const large = assetUrl(root, `${stem[1]}.webp`);
  const small = ASSET_NAMES.has(`${stem[1]}-klein.webp`) ? assetUrl(root, `${stem[1]}-klein.webp`) : '';
  const widths = IMAGE_WIDTHS[stem[1]] || [];
  const srcset = small && widths.length === 2 ? `${small} ${widths[0]}w, ${large} ${widths[1]}w` : large;
  return `<picture><source type="image/webp" srcset="${srcset}"${small && widths.length === 2 ? ` sizes="${sizes}"` : ''}>${img}</picture>`;
}

/** Breedte in pixels van de kleine en de grote WebP per standaardafbeelding (voor srcset). */
const IMAGE_WIDTHS = { 'hero-tuin': [720, 1440], 'banner-druppelslang': [600, 1000], 'banner-pomp': [600, 1000] };

/**
 * Het adres van een productafbeelding: een eigen afbeelding ('own:<id>') komt van
 * de shop zelf, anders is het het https-adres van het webshopproduct.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} image De waarde uit de catalogus ('own:<id>' of een https-adres).
 * @param {{ small?: boolean }} [options] small = de miniatuur voor een kaartje (alleen bij een eigen afbeelding; zonder miniatuur levert de server de gewone).
 * @returns {string} Het adres, ontsnapt voor in een attribuut.
 */
function productImageSrc(root, image, { small = false } = {}) {
  const text = String(image || '');
  return text.startsWith('own:') ? `${root}artikelfoto/${escapeHtml(text.slice(4))}${small ? '/klein' : ''}` : escapeHtml(text);
}

/**
 * Het adres van een knop uit Beheer: een volledig adres, een pad in de shop of de standaard.
 * @param {string} link De ingevoerde link (leeg = standaard).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} fallback De standaardbestemming (al met root).
 * @returns {string} Het adres, ontsnapt voor in een attribuut.
 */
function linkHref(link, root, fallback) {
  if (!link) return fallback;
  return escapeHtml(/^https?:/i.test(link) ? link : `${root}${link}`);
}

/**
 * Het telefoonnummer als tel:-link (06 → +316).
 * @param {string} phone Het nummer zoals getoond.
 * @returns {string} De link, of een lege tekst zonder cijfers.
 */
function phoneLink(phone) {
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (!/\d/.test(digits)) return '';
  if (digits.startsWith('00')) return `tel:+${digits.slice(2)}`;
  return `tel:${digits.startsWith('0') ? `+31${digits.slice(1)}` : digits}`;
}

/** Pictogrammen (inline SVG, geen scripts of afbeeldingen nodig). */
const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 10.4a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L19.5 8H6"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.2-3.6 4.2-5 8-5s6.8 1.4 8 5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/><path d="M19 19c0 1.5-1.5 2-4 2"/></svg>',
  admin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13a8 8 0 0 1 16 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.4"/><path d="M4 13v4h16v-4"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};

/** Pictogrammen voor de vertrouwensstrook (inline SVG). */
const ICONS_TRUST = {
  truck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="17.5" cy="17.5" r="1.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

/**
 * Adres van een bestand van de shop (CSS, afbeelding) met de versie erbij, zodat
 * een browser na een nieuwe versie nooit een oud bestand uit de cache gebruikt.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} name Bestandsnaam onder assets/.
 * @returns {string} Het adres, bijv. '../assets/winkel.css?v=1.3.8'.
 */
function assetUrl(root, name) {
  return `${root}assets/${name}?v=${SHOP_VERSION}`;
}

/**
 * Zin voor een aantal producten: "1 product" of "7 producten".
 * @param {number} count Het aantal.
 * @returns {string} De tekst.
 */
function productCount(count) {
  return `${count} ${count === 1 ? 'product' : 'producten'}`;
}

/**
 * Menu van de hoofdcategorieën. Op een breed scherm een balk met uitklappers en
 * per niveau een flyout (alleen CSS), op een smal scherm een menuknop met
 * ingeklapte niveaus (details/summary). De koppen van de hoofdcategorieën zijn
 * geen link: ze klappen alleen open.
 * @param {object[]} groups De hoofdcategorieën (slug, name, categories met children).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van beide menu's.
 */
function navigation(groups, root) {
  /**
   * De zichtbare (niet verborgen) categorieën uit een lijst.
   * @param {object[]} categories De categorieën.
   * @returns {object[]} De categorieën die in menu's getoond worden.
   */
  const visible = (categories) => categories.filter((category) => !category.hidden);
  /**
   * Lijstitems voor de balk: een link, bij subcategorieën met een flyout ernaast.
   * @param {object[]} categories De categorieën van één niveau.
   * @returns {string} HTML van de lijstitems.
   */
  const flyItems = (categories) => visible(categories).map((category) => {
    const link = `<a href="${root}categorie/${escapeHtml(category.slug)}/">${escapeHtml(category.name)}</a>`;
    const children = visible(category.children);
    return children.length ? `<li class="has-sub">${link}<ul class="nav-drop nav-fly">${flyItems(children)}</ul></li>` : `<li>${link}</li>`;
  }).join('');
  /**
   * Lijstitems voor het smalle menu: subcategorieën klappen open met "Alles in …" bovenaan.
   * @param {object[]} categories De categorieën van één niveau.
   * @returns {string} HTML van de lijstitems.
   */
  const foldItems = (categories) => visible(categories).map((category) => {
    const link = `<a href="${root}categorie/${escapeHtml(category.slug)}/">${escapeHtml(category.name)}</a>`;
    const children = visible(category.children);
    return children.length
      ? `<li><details><summary>${escapeHtml(category.name)}</summary><ul><li><a href="${root}categorie/${escapeHtml(category.slug)}/">Alles in ${escapeHtml(category.name)}</a></li>${foldItems(children)}</ul></details></li>`
      : `<li>${link}</li>`;
  }).join('');
  const extraPages = activeContent.pages.filter((page) => page.menu && page.slug !== 'over-ons');
  const wholesale = activeShop.wholesale ? `<li class="nav-about"><a href="${root}groothandel/">Groothandel</a></li>` : '';
  const about = `<li class="nav-about"><a href="${root}over-ons/">Over ons</a></li>${wholesale}${extraPages.map((page) => `<li class="nav-about"><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}`;
  const desktop = groups.map((group) => `<li class="nav-group"><span class="nav-heading" tabindex="0">${escapeHtml(group.name)}</span><ul class="nav-drop">${flyItems(group.categories)}</ul></li>`).join('');
  const mobile = groups.map((group) => `<li><details><summary>${escapeHtml(group.name)}</summary><ul>${foldItems(group.categories)}</ul></details></li>`).join('');
  return `<nav class="shop-nav" aria-label="Productgroepen"><ul class="nav-bar">${about}${desktop}<!--planner:${root}--></ul></nav>
<details class="shop-menu"><summary>${ICONS.menu}<span>Alle productgroepen</span></summary><ul>${activeShop.staff ? `<li><a href="${root}app/">Naar het beheer</a></li>` : ''}${mobile}${activeShop.wholesale ? `<li><a href="${root}groothandel/">Groothandel</a></li>` : ''}${extraPages.map((page) => `<li><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}<!--planner:${root}--></ul></details>`;
}

/**
 * De kopregels voor zoekmachines en delen: canonical-link, OpenGraph, Twitter-kaart, robots en JSON-LD.
 * Zonder webadres van de shop (activeShop.baseUrl) of zonder canonicalPath is er geen canonical en OpenGraph;
 * een pagina zonder canonicalPath (account, winkelwagen, zoeken, niet gevonden) krijgt noindex, en elke pagina zolang
 * de shop niet is vrijgegeven voor zoekmachines (activeShop.indexing, instelling shopSeo).
 * @param {{ title: string, description: string, canonicalPath: ?string, ogImage: string, ogType: string, jsonLd: object[], root: string }} input De gegevens van de pagina (zie layout).
 * @returns {string} De HTML-regels (leeg als er niets te zetten is).
 */
function seoHead({ title, description, canonicalPath, ogImage, ogType, jsonLd, root }) {
  const { baseUrl } = activeShop;
  const robots = canonicalPath == null || !activeShop.indexing ? '<meta name="robots" content="noindex, follow">\n' : '';
  // Zolang de shop niet is vrijgegeven voor zoekmachines: alleen noindex, geen canonical, OpenGraph of gestructureerde gegevens.
  if (!baseUrl || canonicalPath == null || !activeShop.indexing) return robots;
  const url = Seo.absoluteUrl(baseUrl, canonicalPath);
  const image = ogImage || Seo.absoluteUrl(baseUrl, assetUrl(root, 'aquatechshop-logo.png').replace(/^(\.\.\/)+/, ''));
  return `<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:site_name" content="${escapeHtml(SHOP_NAME)}">
<meta property="og:locale" content="nl_NL">
<meta property="og:type" content="${escapeHtml(ogType)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
${Seo.jsonLdBlock(jsonLd)}`;
}

/**
 * De koopfunnel-gebeurtenissen van een lijst producten (alleen als Google Analytics aan staat).
 * @param {string} listName Naam van de lijst (categorie, "Zoekresultaten").
 * @param {object[]} products De getoonde producten.
 * @param {{ searchTerm?: string, resultCount?: number }} [search] De zoekopdracht en het totaal aantal resultaten.
 * @returns {object[]} De gebeurtenissen, leeg zonder Google Analytics.
 */
function listEventsOf(listName, products, search = {}) {
  if (!activeShop.analytics) return [];
  const items = products.map((product, index) => Analytics.itemOfProduct(product, shownPrice((product.variants && product.variants[0]) || product), { listName, index: index + 1 }));
  return Analytics.listEvents({ listName, items, ...search });
}

/**
 * De attributen op <body> waarmee `analytiek.js` na toestemming de metingen laadt: het meet-ID van Google Analytics en/of het
 * project-ID van Clarity, de klantgroep, het pad naar de privacyverklaring en de gebeurtenissen van de pagina. Zonder actieve
 * meting (instellingen uit of geen ID) is het resultaat leeg en staat er niets van deze diensten in de pagina.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object[]} events De gebeurtenissen van de pagina (zie shop-analytics.js).
 * @param {boolean} [privatePage] Of de pagina persoonsgegevens kan tonen (geen canonicalPath): dan wordt alle tekst voor Clarity gemaskeerd.
 * @returns {string} De attributen met een spatie ervoor, of een lege tekst.
 */
function analyticsAttributes(root, events, privatePage = false) {
  if (!activeShop.analytics && !activeShop.clarity) return '';
  const group = activeShop.wholesale ? 'groothandel' : activeShop.business ? 'zakelijk' : 'particulier';
  const json = activeShop.analytics ? Analytics.eventsJson(events) : '';
  const tools = `${activeShop.analytics ? ` data-shop-analytics="${escapeHtml(activeShop.analytics)}"` : ''}${activeShop.clarity ? ` data-shop-clarity="${escapeHtml(activeShop.clarity)}"` : ''}`;
  // Pagina's zonder canonicalPath (account, bestelling, afrekenen, retour, winkelwagen, zoeken) kunnen persoonsgegevens als tekst tonen: die gaan niet naar Clarity.
  const mask = privatePage ? ' data-clarity-mask="True"' : '';
  return `${tools}${mask} data-customer-group="${group}" data-privacy-url="${escapeHtml(root)}pagina/privacyverklaring/"${activeShop.staff ? ' data-internal="1"' : ''}${json ? ` data-shop-events="${escapeHtml(json)}"` : ''}`;
}

/**
 * Het kader om elke pagina: kop met logo, zoeken, winkelwagen en account,
 * menu van productgroepen, inhoud en voet.
 * @param {{ root: string, title: string, description: string, body: string, groups: object[], query?: string, wide?: boolean, variantScript?: boolean, script?: string|string[], refresh?: string, canonicalPath?: ?string, ogImage?: string, ogType?: string, jsonLd?: object[], events?: object[] }} options root = relatief pad naar de shop-startpagina, title, description (meta), body (HTML), groups = hoofdcategorieën voor menu en voet en query = ingevulde zoekterm en wide = de inhoud over de volle breedte (startpagina) en variantScript = of de pagina het script voor de keuzelijsten van varianten laadt en script = de naam (of namen) van andere scripts uit de assets die de pagina laadt (leeg = geen) en refresh = een adres waar de pagina de bezoeker meteen heen stuurt (leeg = niet) en canonicalPath = het pad van de pagina vanaf de startpagina ('' = startpagina) voor de canonical-link, OpenGraph en zoekmachines (null = geen: de pagina is dan voor zoekmachines niet bedoeld en krijgt noindex) en ogImage = volledig adres van de afbeelding voor delen (leeg = het logo) en ogType = het OpenGraph-type ('website' of 'product') en jsonLd = Schema.org-objecten voor in de pagina en events = de koopfunnel-gebeurtenissen van de pagina (alleen gebruikt als Google Analytics aan staat, zie shop-analytics.js).
 * @returns {string} De volledige HTML-pagina.
 */
function layout({ root, title, description, body, groups, query = '', wide = false, variantScript = false, script = '', refresh = '', canonicalPath = null, ogImage = '', ogType = 'website', jsonLd = [], events = [] }) {
  const home = root || './';
  const { site, pages } = activeContent;
  const phone = site.contact.phone;
  const phoneHref = phoneLink(phone);
  const nav = navigation(groups, root);
  const footerPages = pages.filter((page) => page.footer && page.slug !== 'over-ons' && !LEGAL_SLUGS.includes(page.slug));
  const legalLinks = LEGAL_SLUGS.map((slug) => { const own = pages.find((page) => page.slug === slug); return `<a href="${root}pagina/${slug}/">${escapeHtml(own ? own.title : LEGAL_TITLES[slug])}</a>`; }).join('');
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="google-site-verification" content="F-Mvae4wYP79oJ8bT2t-gPrw6Jr-dgUAFkOBetYB1ic">
${seoHead({ title, description, canonicalPath, ogImage, ogType, jsonLd, root })}${refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">\n` : ''}<link rel="icon" type="image/png" href="${assetUrl(root, 'favicon.png')}">
<link rel="stylesheet" href="${assetUrl(root, 'brand.css')}">
<link rel="stylesheet" href="${assetUrl(root, 'winkel.css')}">
${nav.includes('nav-fly') ? `<script src="${assetUrl(root, 'menu.js')}" defer></script>\n` : ''}${variantScript ? `<script src="${assetUrl(root, 'varianten.js')}" defer></script>\n` : ''}${[].concat(script || [], 'zoeksuggesties.js', 'kaartaantal.js', activeShop.analytics || activeShop.clarity ? 'analytiek.js' : [], activeShop.captcha ? 'captcha.js' : []).map((name) => `<script src="${assetUrl(root, name)}" defer></script>\n`).join('')}</head>
<body${analyticsAttributes(root, events, canonicalPath == null)}>
${site.notice.enabled && site.notice.text ? `<div class="shop-notice kleur-${escapeHtml(site.notice.color || 'purple')}">${escapeHtml(site.notice.text)}</div>` : ''}
<header class="shop-head">
  <div class="shop-bar">
    <a class="shop-brand" href="${home}"><img src="${assetUrl(root, 'aquatechshop-logo.png')}" alt="Aquatechshop.nl" width="216" height="44"></a>
    <form class="shop-search" action="${root}zoeken/" method="get" role="search">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Zoek op product of artikelnummer" aria-label="Zoeken" maxlength="80" autocomplete="off" data-suggest="${root}zoeken/suggesties/">
      <button type="submit" aria-label="Zoeken">${ICONS.search}</button>
    </form>
    ${phone ? `<a class="shop-phone" href="${phoneHref}" aria-label="Klantenservice ${escapeHtml(phone)}">${ICONS.phone}<span><small>Klantenservice</small><strong>${escapeHtml(phone)}</strong></span></a>` : ''}
    <div class="shop-actions">
      ${activeShop.staff ? `<a class="shop-action shop-admin" href="${root}app/" title="Naar het beheer">${ICONS.admin}<span>Beheer</span></a>\n      ` : ''}<a class="shop-action" href="${root}account/" title="Inloggen of mijn account" aria-label="Account">${ICONS.user}<span>Account</span></a>
      ${activeShop.ordering
    ? `<a class="shop-action cart" href="${root}winkelwagen/" title="Naar je winkelwagen" aria-label="Winkelwagen, ${activeShop.cartCount} ${activeShop.cartCount === 1 ? 'artikel' : 'artikelen'}">${ICONS.cart}<span>Winkelwagen</span><b>${activeShop.cartCount}</b></a>`
    : `<span class="shop-action cart" aria-disabled="true" title="De winkelwagen volgt binnenkort">${ICONS.cart}<span>Winkelwagen</span><b>0</b></span>`}
    </div>
  </div>
  ${nav}
</header>
<main class="shop-main${wide ? ' wide' : ''}">
${body}
</main>
<footer class="shop-foot">
  <div class="foot-grid">
    <div><strong>Aquatechshop.nl</strong><p>${[site.contact.kvk && `K.v.k.: ${escapeHtml(site.contact.kvk)}`, site.contact.address && escapeHtml(site.contact.address), site.contact.email && `<a href="mailto:${escapeHtml(site.contact.email)}">${escapeHtml(site.contact.email)}</a>`, phone && `<a href="${phoneHref}">${escapeHtml(phone)}</a>`].filter(Boolean).join('<br>')}</p></div>
    <div><strong>Klantenservice</strong><ul>${site.contact.email ? `<li><a href="mailto:${escapeHtml(site.contact.email)}">Contact</a></li>` : ''}<li><a href="${root}pagina/herroepingsrecht/">Retourbeleid</a></li><li><a href="${root}pagina/algemene-voorwaarden/">Algemene voorwaarden</a></li></ul></div>
    <div><strong>Account</strong><ul><li><a href="${root}account/">Mijn account</a></li><li><a href="${root}account/">Inloggen of registreren</a></li></ul></div>
    <div><strong>Over ons</strong><p>${escapeHtml(site.footer.about)}</p><p><a href="${root}over-ons/">Lees ons verhaal</a></p>${footerPages.length ? `<ul>${footerPages.map((page) => `<li><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}</ul>` : ''}</div>
  </div>
  <nav class="foot-legal" aria-label="Voorwaarden">${legalLinks}${activeShop.analytics || activeShop.clarity ? '<button type="button" class="link-button" data-consent-settings>Cookie-instellingen</button>' : ''}</nav>
  <div class="foot-note"><span>${activeShop.business ? 'Je ziet zakelijke prijzen: alle prijzen zijn exclusief btw.' : 'Alle prijzen zijn inclusief btw.'}</span><img src="${assetUrl(root, 'betaalmethoden.png')}" alt="Betaalmethoden" width="286" height="26" loading="lazy"></div>
</footer>
</body>
</html>
`;
}

/**
 * De prijs van een product; bij een hoofdartikel met varianten "Vanaf" de laagste prijs.
 * @param {object} product Een product uit de catalogus.
 * @returns {string} De opgemaakte en ontsnapte prijs.
 */
function priceText(product) {
  const business = activeShop.business ? ` <small class="price-vat">excl. btw</small> <small class="price-incl">(incl. btw ${escapeHtml(formatPrice(product.priceBusinessIncl))})</small>` : '';
  return `${product.variants && product.variants.length > 1 ? 'Vanaf ' : ''}${escapeHtml(formatPrice(shownPrice(product)))}${business}`;
}

/**
 * De prijs die de bezoeker te zien krijgt: voor een zakelijke klant de zakelijke prijs excl. btw, anders de prijs incl. btw.
 * @param {{ priceIncl: number, priceBusiness: number }} item Een product of variant uit de catalogus.
 * @returns {number} De te tonen prijs.
 */
function shownPrice(item) {
  return activeShop.business ? item.priceBusiness : item.priceIncl;
}

/**
 * Het label achter de prijs en, voor een zakelijke klant, de kleine regel met de prijs incl. btw.
 * @param {{ priceBusinessIncl: number }} item Een product of variant uit de catalogus.
 * @returns {string} HTML: "incl. btw" of "excl. btw" met bij een zakelijke klant de regel "incl. btw € …".
 */
function vatLabel(item) {
  if (!activeShop.business) return 'incl. btw';
  return `excl. btw<br><small class="price-incl" data-variant-incl>incl. btw ${escapeHtml(formatPrice(item.priceBusinessIncl))}</small>`;
}

/**
 * Adres van de productpagina, bij een hoofdartikel met een gekozen variant.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object} product Het product.
 * @param {object} [variant] De gekozen variant (alleen bij een hoofdartikel).
 * @returns {string} Het relatieve adres.
 */
function productHref(root, product, variant) {
  return `${root}product/${escapeHtml(product.slug)}/${variant ? `?v=${encodeURIComponent(variant.code)}` : ''}`;
}

/** Tot en met dit aantal toont de shop "Nog N op voorraad" in plaats van "Op voorraad". */
const LOW_STOCK_MAX = 5;

/**
 * De voorraadtekst bij een artikel: "Nog 3 op voorraad" bij een kleine voorraad, anders "Op voorraad" of "Niet op voorraad".
 * @param {boolean} inStock Of het artikel te bestellen is.
 * @param {?number} [quantity] Het aantal te bestellen stuks, of null als dat onbekend is (geen voorraadbeheer).
 * @returns {string} De tekst.
 */
function stockText(inStock, quantity = null) {
  if (!inStock) return 'Niet op voorraad';
  return quantity !== null && quantity >= 1 && quantity <= LOW_STOCK_MAX ? `Nog ${quantity} op voorraad` : 'Op voorraad';
}

/**
 * Het formulier "Mail mij als hij weer binnen is" bij een artikel dat niet op voorraad is.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} code Artikelcode (van de gekozen variant).
 * @param {string} status De uitkomst van een eerdere aanmelding: `ja`, `fout` of leeg.
 * @returns {string} HTML van het blok.
 */
function stockAlertForm(root, code, status) {
  const message = status === 'ja' ? '<p class="form-info" role="status">Gelukt: je krijgt één mail zodra dit artikel weer te bestellen is.</p>'
    : status === 'fout' ? '<p class="form-error" role="alert">Aanmelden is niet gelukt. Controleer je e-mailadres en probeer het opnieuw.</p>' : '';
  return `<form class="stock-alert" id="voorraadmelding" method="post" action="${root}voorraadmelding/">
<h2>Mail mij als hij weer binnen is</h2>${message}
<input type="hidden" name="code" value="${escapeHtml(code)}">
<label class="trap" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
<label class="form-field"><span>E-mailadres</span><input name="email" type="email" required maxlength="200" autocomplete="email"><small>We mailen je één keer en wissen je adres daarna.</small></label>
${captchaFields('stock_alert')}
<button class="button" type="submit">Mail mij</button>
</form>`;
}

/**
 * De vertrouwensstrook op de beslismomenten (productpagina, winkelwagen, afrekenen): levertijd, gratis verzenden, retour, advies en
 * betalen. Alleen wat klopt: een punt zonder gegevens (geen drempel, geen telefoonnummer, geen online betalen) blijft weg.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {{ leadText?: string, freeFrom?: number, business?: boolean, online?: boolean }} [facts] De levertijd van de eerste bezorgmethode (leeg = onbekend), de gratis-vanaf-drempel (incl. btw), of de klant zakelijk is (geen herroepingsrecht) en of online betalen aan staat.
 * @returns {string} HTML van de strook, of leeg als er niets te melden is.
 */
function trustStrip(root, { leadText = '', freeFrom = 0, business = false, online = false } = {}) {
  const phone = activeContent.site.contact.phone;
  const items = [];
  if (leadText) items.push(`<li>${ICONS_TRUST.truck}<span>${escapeHtml(leadText)}</span></li>`);
  if (freeFrom > 0) items.push(`<li>${ICONS_TRUST.tag}<span>Gratis bezorgd vanaf ${escapeHtml(formatPrice(freeFrom))}${business ? ' (incl. btw)' : ''}</span></li>`);
  if (!business) items.push(`<li>${ICONS_TRUST.back}<span><a href="${root}pagina/herroepingsrecht/">14 dagen bedenktijd</a> voor consumenten</span></li>`);
  if (phone) items.push(`<li>${ICONS.phone}<span>Advies van vakmensen: <a href="${escapeHtml(phoneLink(phone))}">${escapeHtml(phone)}</a></span></li>`);
  if (online) items.push(`<li>${ICONS_TRUST.lock}<span>Veilig betalen met iDEAL en andere methodes</span></li>`);
  return items.length ? `<ul class="trust-strip" aria-label="Waarom bij ons bestellen">${items.join('')}</ul>` : '';
}

/**
 * Het formulier om een artikel in de winkelwagen te leggen (alleen als bestellen aan staat; anders een uitgeschakelde knop).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} code Artikelnummer van het artikel (of van de gekozen variant).
 * @param {boolean} inStock Of het artikel op voorraad is.
 * @param {string} className Klasse van het formulier.
 * @param {?object} [item] Het artikel als GA4-artikel (shop-analytics.js, itemOf) voor de gebeurtenis add_to_cart; leeg zonder Google Analytics.
 * @returns {string} HTML.
 */
function orderForm(root, code, inStock, className, item = null) {
  if (!activeShop.ordering) return `<div class="${className}"><input type="number" value="1" min="1" aria-label="Aantal" disabled><button class="button" type="button" disabled>In winkelwagen</button></div>`;
  const itemData = item && activeShop.analytics ? ` data-item="${escapeHtml(JSON.stringify(item))}"` : '';
  return `<form class="${className}" method="post" action="${root}winkelwagen/"${itemData}>
      <input type="hidden" name="action" value="add"><input type="hidden" name="code" value="${escapeHtml(code)}" data-order-code>
      <input type="number" name="qty" value="1" min="1" max="99" aria-label="Aantal"${inStock ? '' : ' disabled'}><button class="button" type="submit"${inStock ? '' : ' disabled'}>In winkelwagen</button>
    </form>`;
}

/**
 * De kaart van een product in een overzicht: foto met voorraadlabel, naam, (bij een hoofdartikel) de keuzelijst met
 * uitvoeringen, prijs, voorraad en een aantal-veld met de knop "In winkelwagen". Elk artikel
 * heeft dezelfde kaart; alleen de keuzelijst is er alleen voor een hoofdartikel met varianten.
 * Zonder script kiest de bezoeker met de knop Kies (opent de productpagina van die uitvoering);
 * met het script wisselen artikelnummer, prijs, voorraad en winkelwagenknop direct.
 * @param {object} product Een product uit de catalogus (bij een hoofdartikel met variants en attributeName).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de kaart.
 */
function productCard(product, root) {
  const variants = product.variants || [];
  const selected = variants.length ? (variants.find((variant) => variant.inStock) || variants[0]) : product;
  const href = productHref(root, product, variants.length ? selected : null);
  const image = product.image ? `<img src="${productImageSrc(root, product.image, { small: true })}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>';
  const options = variants.map((variant) => `<option value="${escapeHtml(variant.code)}" data-code="${escapeHtml(variant.code)}" data-meta="${escapeHtml(variant.meta)}" data-price="${escapeHtml(formatPrice(shownPrice(variant)))}" ${activeShop.business ? ` data-price-incl="${escapeHtml(formatPrice(variant.priceBusinessIncl))}"` : ''} data-stock="${variant.inStock ? 'in' : 'out'}" data-value="${escapeHtml(String(shownPrice(variant)))}" data-label="${escapeHtml(variant.label)}" data-href="${productHref(root, product, variant)}"${variant === selected ? ' selected' : ''}>${escapeHtml(variant.label)}</option>`).join('');
  const picker = variants.length ? `<form class="variant-pick" method="get" action="${root}product/${escapeHtml(product.slug)}/">
    <label>${escapeHtml(product.attributeName)}<select name="v" data-variant-select>${options}</select></label>
    <span class="variant-count">${variants.length} varianten</span>
    <button class="button secondary variant-go" type="submit">Kies</button>
  </form>
  <p class="variant-meta">Artikelnr.: <span data-variant-code>${escapeHtml(selected.code)}</span><span data-variant-meta>${selected.meta ? ` | ${escapeHtml(selected.meta)}` : ''}</span></p>` : '';
  return `<article class="product-card"${variants.length ? ' data-variant-row' : ''}>
  <a class="product-image" href="${href}" data-variant-link tabindex="-1" aria-hidden="true">${image}</a>
  <p class="stock ${selected.inStock ? 'in' : 'out'}" data-variant-stock>${selected.inStock ? 'Op voorraad' : 'Niet op voorraad'}</p>
  <a class="product-name" href="${href}" data-variant-link title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</a>
  ${picker || `<p class="card-sku">Artikelnr. ${escapeHtml(product.code)}</p>`}
  <div class="product-foot">
    <p class="product-price"><strong data-variant-price>${escapeHtml(formatPrice(shownPrice(selected)))}</strong> <small>${vatLabel(selected)}</small></p>
    ${orderForm(root, selected.code, selected.inStock, 'card-order', Analytics.itemOfProduct({ code: selected.code, name: product.name, categoryName: product.categoryName }, shownPrice(selected), { variant: variants.length ? selected.label : '' }))}
  </div>
</article>`;
}

/**
 * Het label "3 varianten" voor een hoofdartikel met varianten, zodat de bezoeker in een lijst ziet dat er keuze is.
 * @param {object} product Een product uit de catalogus.
 * @returns {string} HTML van het label, of leeg als het product geen varianten heeft.
 */
function variantBadge(product) {
  return product.variants && product.variants.length > 1 ? `<span class="variant-badge">${product.variants.length} varianten</span>` : '';
}

/**
 * Eerste product met foto per hoofdcategorie, voor de tegels in de assortimentsbalk.
 * @param {object} group De hoofdcategorie (slug).
 * @param {object[]} products Alle producten.
 * @returns {object|undefined} Een product met foto, bij voorkeur op voorraad.
 */
function groupShowcase(group, products) {
  const own = products.filter((product) => product.groupSlug === group.slug && product.image);
  return own.find((product) => product.inStock) || own[0];
}

/**
 * Kleine productregel (foto, naam, prijs) in de kolommen onder de populaire producten.
 * @param {object} product Het product.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de regel.
 */
function productRow(product, root) {
  return `<a class="product-row" href="${root}product/${escapeHtml(product.slug)}/"><span class="product-image"><img src="${productImageSrc(root, product.image, { small: true })}" alt="" loading="lazy"></span><span class="product-row-text"><span class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span><span class="product-price">${priceText(product)}</span>${variantBadge(product)}<span class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</span></span></a>`;
}

/**
 * Het aanvraagformulier voor een zakelijk account op de startpagina (bedrijfsnaam,
 * e-mail, telefoon en een bericht). Het veld "website" blijft leeg voor bezoekers
 * (valstrik voor robots).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} sent Uitkomst van een verstuurde aanvraag: 'ja', 'fout' of leeg.
 * @returns {string} HTML van het formulier of de bevestiging.
 */
function businessForm(root, sent) {
  if (sent === 'ja') return '<div class="business-form" id="zakelijk"><p class="business-sent">Bedankt voor je aanvraag. We nemen zo snel mogelijk contact met je op.</p></div>';
  return `<form class="business-form" id="zakelijk" method="post" action="${root}zakelijk-aanvraag/">
${sent === 'fout' ? '<p class="error" role="alert">Versturen is niet gelukt. Controleer je gegevens en probeer het opnieuw, of bel ons.</p>' : ''}
<label>Bedrijfsnaam*<input name="company" required maxlength="120" autocomplete="organization"></label>
<label>E-mail*<input type="email" name="email" required maxlength="120" autocomplete="email"></label>
<label>Telefoonnummer*<input type="tel" name="phone" required maxlength="30" autocomplete="tel"></label>
<label>Bericht (optioneel)<textarea name="message" rows="4" maxlength="1000"></textarea></label>
<label class="trap" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
${captchaFields('business_request')}
<button class="button" type="submit">Verstuur</button>
</form>`;
}

/**
 * Het volledige adres van de afbeelding bovenaan de startpagina, voor delen op social media en in zoekresultaten.
 * @param {string} reference 'asset:<bestand>' of 'media:<id>' (zie imageSrc).
 * @returns {string} Het volledige adres, leeg zonder webadres van de shop of zonder afbeelding.
 */
function homeImage(reference) {
  const source = imageSrc('', reference);
  return activeShop.baseUrl && source ? Seo.absoluteUrl(activeShop.baseUrl, source) : '';
}

/**
 * De gestructureerde gegevens van de startpagina: het bedrijf (Nunspeet) en de website met zoekfunctie.
 * @param {string} heroReference De afbeelding bovenaan de startpagina (voor het bedrijfsbeeld).
 * @returns {object[]} De Schema.org-objecten (leeg zonder webadres van de shop).
 */
function homeJsonLd(heroReference) {
  return activeShop.baseUrl ? Seo.organizationJsonLd(activeContent.site, activeShop.baseUrl, SHOP_NAME, homeImage(heroReference)) : [];
}

/**
 * Het blok dat de gratis planner aanprijst: ontwerp de beregening en bestel de complete lijst in één keer. De server vervangt het
 * merkteken door het blok als de planner aan staat (anders blijft er niets over), zodat de pagina's er niet van afhangen.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} Het merkteken `<!--planner-promo:…-->`.
 */
function plannerPromoMark(root) {
  return `<!--planner-promo:${root}-->`;
}

/**
 * Of een hoofdcategorie over beregening gaat (daar past de plannerpromotie): de naam of het adres bevat "beregening".
 * @param {{ slug?: string, name?: string }} group De hoofdcategorie.
 * @returns {boolean} true als het een beregeningscategorie is.
 */
function isIrrigationGroup(group) {
  return /beregening/i.test(`${group.slug || ''} ${group.name || ''}`);
}

/**
 * Startpagina in de opzet van aquatechshop.nl: foto met kop, assortimentsbalk,
 * populaire producten, producten per hoofdcategorie, voordelen, merken en een
 * oproep voor een zakelijk account.
 * @param {{ products: object[], groups: object[], featured: object[] }} catalog De catalogus.
 * @returns {string} De HTML-pagina.
 */
function homePage(catalog) {
  const root = '';
  const first = catalog.groups[0];
  const { hero, banners: bannerBlock, columns: columnBlock, quote: quoteBlock, benefits: benefitBlock, brands: brandBlock, business: businessBlock } = activeContent.site;
  const heroButton = hero.button || (hero.title && first ? `Bekijk ${first.name.toLowerCase()}` : '');
  const heroHref = linkHref(hero.link, root, first ? `groep/${escapeHtml(first.slug)}/` : '');
  const heroImage = imageSrc(root, hero.image);
  const intro = `<section class="home-hero">${heroImage ? imageHtml(root, hero.image, { attributes: `alt=""${hero.image === DEFAULT_SITE.hero.image ? ' width="1440" height="419" fetchpriority="high"' : ''}` }) : ''}${hero.title || hero.text || heroButton ? `<div class="home-hero-text">${hero.title ? `<h1>${escapeHtml(hero.title)}</h1>` : ''}${hero.text ? `<p>${escapeHtml(hero.text)}</p>` : ''}${heroButton && heroHref ? `<a class="button" href="${heroHref}">${escapeHtml(heroButton)}</a>` : ''}</div>` : ''}</section>`;
  if (!catalog.products.length) return layout({ root, groups: catalog.groups, wide: true, canonicalPath: '', jsonLd: homeJsonLd(hero.image), ogImage: homeImage(hero.image), title: `${SHOP_NAME} – alles voor uw tuinberegening`, description: 'Sproeiers, druppelslang, leidingen en pompen voor tuinberegening van AquaTech Service.', body: `${intro}<div class="wrap"><p class="muted">De webshop wordt gevuld. Kom snel terug.</p></div>` });
  const tiles = catalog.groups.map((group) => {
    const showcase = groupShowcase(group, catalog.products);
    return `<a class="assortment-tile" href="groep/${escapeHtml(group.slug)}/"><span class="product-image">${showcase ? `<img src="${productImageSrc(root, showcase.image, { small: true })}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>'}</span><span>${escapeHtml(group.name)}</span></a>`;
  }).join('');
  const assortment = `<section class="assortment"><div class="wrap assortment-inner"><div class="assortment-title"><h2>Assortiment</h2><p>Alles voor jouw project</p></div><div class="assortment-strip">${tiles}</div></div></section>`;
  /**
   * Een raster met productkaarten.
   * @param {object[]} list De producten.
   * @returns {string} HTML van het raster.
   */
  const grid = (list) => `<div class="product-grid">\n${list.map((product) => productCard(product, root)).join('\n')}\n</div>`;
  // Meest verkocht (webshopverkopen) en Populaire producten als tabbladen zonder script (keuzerondjes); zonder verkopen alleen Populaire producten.
  const popular = catalog.bestsellers.length && catalog.featured.length
    ? `<section class="wrap home-tabs"><input type="radio" name="home-tab" id="tab-best" checked><input type="radio" name="home-tab" id="tab-popular"><div class="tab-labels"><label for="tab-best">Meest verkocht</label><label for="tab-popular">Populaire producten</label></div><div class="tab-panel panel-best">${grid(catalog.bestsellers)}</div><div class="tab-panel panel-popular">${grid(catalog.featured)}</div></section>`
    : catalog.featured.length ? `<section class="wrap"><h2 class="centered">Populaire producten</h2>\n${grid(catalog.featured)}</section>` : '';
  const banners = bannerBlock.enabled && bannerBlock.items.length ? `<section class="home-banners">${bannerBlock.items.map((item) => {
    const href = linkHref(item.link, root, '');
    const inner = `${imageHtml(root, item.image, { attributes: 'alt="" loading="lazy"', sizes: '(max-width: 800px) 100vw, 50vw' })}<span class="home-banner-text">${item.title ? `<strong>${escapeHtml(item.title)}</strong>` : ''}${item.button ? `<span class="button">${escapeHtml(item.button)}</span>` : ''}</span>`;
    return href ? `<a class="home-banner" href="${href}">${inner}</a>` : `<div class="home-banner">${inner}</div>`;
  }).join('')}</section>` : '';
  // Een variantcode verwijst naar het hoofdartikel waar de variant onder valt.
  const byCode = new Map(catalog.products.map((product) => [product.code, product]));
  const bySlug = new Map(catalog.products.map((product) => [product.slug, product]));
  for (const variant of catalog.variantProducts || []) {
    if (!byCode.has(variant.code) && bySlug.has(variant.parentSlug)) byCode.set(variant.code, bySlug.get(variant.parentSlug));
  }
  const columns = columnBlock.enabled ? columnBlock.items.map((column) => {
    const group = catalog.groups.find((candidate) => candidate.slug === column.group);
    const items = column.codes.length
      ? column.codes.map((code) => byCode.get(code)).filter((product) => product && product.image)
      : group ? catalog.products.filter((product) => product.groupSlug === group.slug && product.image).slice(0, 3) : [];
    return { column, group, items };
  }) : [];
  const perGroup = columns.length ? `<section class="wrap"><div class="group-columns">${columns.map(({ column, group, items }) => `<div><h2>${group ? `<a href="groep/${escapeHtml(group.slug)}/">${escapeHtml(column.title)}</a>` : escapeHtml(column.title)}</h2>${items.length ? items.map((product) => productRow(product, root)).join('') : '<p class="muted">Binnenkort meer producten.</p>'}</div>`).join('')}</div></section>` : '';
  const benefits = benefitBlock.enabled && benefitBlock.items.length ? `<section class="benefits"><div class="wrap benefits-inner">${benefitBlock.items.map((item) => `<div class="benefit">${item.image ? `<img src="${imageSrc(root, item.image)}" alt="" width="50" height="50" loading="lazy">` : ''}<div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></div></div>`).join('')}</div></section>` : '';
  const brands = brandBlock.enabled && brandBlock.items.length ? `<section class="wrap">${brandBlock.title ? `<h2 class="centered">${escapeHtml(brandBlock.title)}</h2>` : ''}<div class="brands">${brandBlock.items.map((item) => `<img src="${imageSrc(root, item.image)}" alt="${escapeHtml(item.name)}" height="70" loading="lazy">`).join('')}</div></section>` : '';
  const quote = quoteBlock.enabled && quoteBlock.text ? `<section class="wrap"><p class="home-quote">“${escapeHtml(quoteBlock.text)}”</p></section>` : '';
  const businessImage = imageSrc(root, businessBlock.image);
  const businessHref = linkHref(businessBlock.link, root, `${root}registreren/`);
  const withForm = Boolean(businessBlock.form && activeShop.businessForm);
  const business = businessBlock.enabled ? `<section class="business${withForm ? ' with-form' : ''}">${businessImage ? imageHtml(root, businessBlock.image, { attributes: 'alt="" loading="lazy"' }) : ''}<div class="business-text"><h2>${escapeHtml(businessBlock.title)}</h2>${businessBlock.text ? `<p>${escapeHtml(businessBlock.text)}</p>` : ''}${businessBlock.button && !withForm ? `<a class="button" href="${businessHref}">${escapeHtml(businessBlock.button)}</a>` : ''}</div>${withForm ? businessForm(root, activeShop.businessSent) : ''}</section>` : '';
  return layout({ root, wide: true, canonicalPath: '', variantScript: [...catalog.bestsellers, ...catalog.featured].some((product) => product.variants), jsonLd: homeJsonLd(hero.image), ogImage: homeImage(hero.image), title: `${SHOP_NAME} – alles voor uw tuinberegening`, description: 'Sproeiers, druppelslang, leidingen en pompen voor tuinberegening van AquaTech Service.', body: `${intro}\n${assortment}\n${plannerPromoMark(root)}\n${popular}\n${banners}\n${perGroup}\n${benefits}\n${brands}\n${quote}\n${business}`, groups: catalog.groups });
}

/**
 * Keuze tussen alle producten en alleen wat op voorraad is (uit de voorraad van het systeem).
 * @param {boolean} onlyInStock Of nu alleen wat op voorraad is getoond wordt.
 * @param {string} allQuery Querystring voor alle producten (zonder vraagteken, kan leeg zijn).
 * @param {string} stockQuery Querystring voor alleen op voorraad (zonder vraagteken).
 * @param {boolean} [preview] Of het conceptvoorbeeld (`?voorbeeld=1`) in de links behouden blijft.
 * @returns {string} HTML van de keuze.
 */
function stockFilter(onlyInStock, allQuery, stockQuery, preview = false) {
  if (preview) {
    allQuery = [allQuery, 'voorbeeld=1'].filter(Boolean).join('&amp;');
    stockQuery = `${stockQuery}&amp;voorbeeld=1`;
  }
  return `<p class="stock-filter">Toon: <a href="./${allQuery ? `?${allQuery}` : ''}"${onlyInStock ? '' : ' aria-current="true"'}>Alles</a> · <a href="./?${stockQuery}"${onlyInStock ? ' aria-current="true"' : ''}>Alleen op voorraad</a></p>`;
}

/** Aantal producten per pagina op een categoriepagina. */
const PAGE_SIZE = 24;
/** Sorteringen op een categoriepagina: sleutel in de adresbalk en tekst. */
const SORTS = [
  { key: '', label: 'Op naam' },
  { key: 'prijs-laag', label: 'Prijs: laag - hoog' },
  { key: 'prijs-hoog', label: 'Prijs: hoog - laag' },
];

/**
 * De intro van een categorie als HTML: alinea's, met "## kop" als tussenkop.
 * @param {string} intro De tekst; alinea's gescheiden door een lege regel.
 * @returns {string} HTML, leeg zonder tekst.
 */
function introHtml(intro) {
  return String(intro || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
    .map((part) => (part.startsWith('## ') ? `<h2>${escapeHtml(part.slice(3))}</h2>` : `<p>${escapeHtml(part)}</p>`)).join('\n');
}

/**
 * Zoekt een categorie met haar voorouders in de categorieën van een hoofdcategorie.
 * @param {object[]} categories De categorieën van één niveau (met children).
 * @param {string} slug De gezochte categorie.
 * @returns {?object[]} De keten van de bovenste categorie tot de gezochte, of null.
 */
function chainTo(categories, slug) {
  for (const category of categories) {
    if (category.slug === slug) return [category];
    const below = chainTo(category.children, slug);
    if (below) return [category, ...below];
  }
  return null;
}

/**
 * Het blok "Categorie" in de zijbalk: de categorieën van de hoofdcategorie, met de subcategorieën
 * uitgeklapt langs het pad naar de huidige pagina.
 * @param {object[]} categories De categorieën van één niveau.
 * @param {Set<string>} open Slugs van categorieën waarvan de subcategorieën getoond worden (het pad naar de huidige).
 * @param {string} current Slug van de huidige categorie (leeg op de pagina van een hoofdcategorie).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de lijst.
 */
function sideTree(categories, open, current, root) {
  const items = categories.filter((category) => !category.hidden).map((category) => {
    const children = category.children.filter((child) => !child.hidden);
    const here = category.slug === current;
    return `<li><a href="${root}categorie/${escapeHtml(category.slug)}/"${here ? ' aria-current="page"' : ''}>${escapeHtml(category.name)}</a>${children.length && open.has(category.slug) ? sideTree(children, open, current, root) : ''}</li>`;
  }).join('');
  return `<ul>${items}</ul>`;
}

/**
 * Pagina van een hoofdcategorie of categorie in de opzet van aquatechshop.nl: kruimelpad,
 * zijbalk met categorieën en prijsfilter, intro, blokken van de subcategorieën en (als er
 * producten direct in de categorie zitten) de producten met sortering en paginering.
 * @param {{ group: object, category?: ?object, products?: object[], groups: object[], options?: { onlyInStock?: boolean, min?: ?number, max?: ?number, sort?: string, page?: number, preview?: boolean } }} input group = de hoofdcategorie, category = de categorie (leeg op de pagina van de hoofdcategorie zelf), products = de producten die direct in de categorie zitten, groups = alle hoofdcategorieën en options = de gekozen filters en sortering.
 * @returns {string} De HTML-pagina.
 */
function browsePage({ group, category = null, products = [], groups, options = {} }) {
  const root = '../../';
  const { onlyInStock = false, min = null, max = null, sort = '', preview = false } = options;
  const subject = category || group;
  const children = (category ? category.children : group.categories).filter((child) => !child.hidden);
  const chain = category ? chainTo(group.categories, category.slug) || [category] : [];
  const open = new Set(chain.map((item) => item.slug));
  /**
   * Adres met de gekozen filters, met enkele wijzigingen.
   * @param {Object<string, ?(string|number)>} changes Waarden die anders zijn dan nu (leeg of null = weglaten).
   * @returns {string} Een relatief adres, "./" zonder filters.
   */
  const link = (changes) => {
    const values = { voorraad: onlyInStock ? '1' : '', min: min ?? '', max: max ?? '', sorteer: sort, pagina: '', voorbeeld: preview ? '1' : '', ...changes };
    const query = Object.entries(values).filter(([, value]) => value !== '' && value != null).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&amp;');
    return `./${query ? `?${query}` : ''}`;
  };
  const filtered = products.filter((product) => (!onlyInStock || product.inStock)
    && (min == null || shownPrice(product) >= min) && (max == null || shownPrice(product) <= max));
  const ordered = sort === 'prijs-laag' ? [...filtered].sort((left, right) => shownPrice(left) - shownPrice(right))
    : sort === 'prijs-hoog' ? [...filtered].sort((left, right) => shownPrice(right) - shownPrice(left)) : filtered;
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(options.page) || 1), pageCount);
  const shown = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const crumbs = [`<a href="${root}">Shop</a>`, category ? `<a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : `<span>${escapeHtml(group.name)}</span>`,
    ...chain.map((item, position) => (position === chain.length - 1 ? `<span>${escapeHtml(item.name)}</span>` : `<a href="${root}categorie/${escapeHtml(item.slug)}/">${escapeHtml(item.name)}</a>`))].join(' › ');
  const priceForm = `<form class="price-filter" action="./" method="get">
  <label>Van <input type="number" name="min" min="0" step="0.01" inputmode="decimal" value="${min == null ? '' : escapeHtml(min)}" placeholder="Min. prijs"></label>
  <label>Tot <input type="number" name="max" min="0" step="0.01" inputmode="decimal" value="${max == null ? '' : escapeHtml(max)}" placeholder="Max. prijs"></label>
  ${onlyInStock ? '<input type="hidden" name="voorraad" value="1">' : ''}${sort ? `<input type="hidden" name="sorteer" value="${escapeHtml(sort)}">` : ''}${preview ? '<input type="hidden" name="voorbeeld" value="1">' : ''}
  <button class="button" type="submit">Filter</button>${min != null || max != null ? ` <a href="${link({ min: '', max: '' })}">Wis prijs</a>` : ''}
</form>`;
  const side = `<aside class="browse-side"><h2>Categorie</h2>${sideTree(group.categories, open, category ? category.slug : '', root)}${products.length ? `<h2>Prijs</h2>${priceForm}` : ''}</aside>`;
  const blocks = children.length ? `<div class="cat-blocks">${children.map((child) => `<a class="cat-block" href="${root}categorie/${escapeHtml(child.slug)}/"><span class="cat-block-image">${child.image ? `<img src="${imageSrc(root, child.image)}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>'}</span><strong>${escapeHtml(child.name)}</strong><span>${productCount(child.count)}</span></a>`).join('')}</div>` : '';
  const sorting = SORTS.map((item) => `<a href="${link({ sorteer: item.key })}"${item.key === sort ? ' aria-current="true"' : ''}>${escapeHtml(item.label)}</a>`).join(' · ');
  const pages = pageCount > 1 ? `<nav class="pager" aria-label="Pagina's">${Array.from({ length: pageCount }, (_, index) => `<a href="${link({ pagina: index === 0 ? '' : index + 1 })}"${index + 1 === page ? ' aria-current="page"' : ''}>${index + 1}</a>`).join('')}${page < pageCount ? `<a href="${link({ pagina: page + 1 })}">Volgende</a>` : ''}</nav>` : '';
  const list = products.length ? `<div class="browse-toolbar"><p>${ordered.length ? `Resultaat ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown.length} van de ${ordered.length} ${ordered.length === 1 ? 'resultaat' : 'resultaten'}` : 'Geen resultaten'}</p>
<p class="stock-filter">Toon: <a href="${link({ voorraad: '' })}"${onlyInStock ? '' : ' aria-current="true"'}>Alles</a> · <a href="${link({ voorraad: '1' })}"${onlyInStock ? ' aria-current="true"' : ''}>Alleen op voorraad</a></p>
<p class="stock-filter">Sorteren: ${sorting}</p></div>
${ordered.length ? '' : '<p class="muted">Geen producten gevonden met deze filters.</p>'}
<div class="product-grid">
${shown.map((product) => productCard(product, root)).join('\n')}
</div>
${pages}` : '';
  const body = `<div class="crumbs-band"><nav class="crumbs wrap" aria-label="Kruimelpad">${crumbs}</nav></div>
<div class="wrap browse">
${side}
<section class="browse-main">
<h1>${escapeHtml(subject.name)}</h1>
<div class="browse-intro">${introHtml(subject.intro)}</div>
${isIrrigationGroup(group) ? plannerPromoMark(root) : ''}
${blocks}
${list}
</section>
</div>`;
  const browsePath = `${category ? `categorie/${category.slug}` : `groep/${group.slug}`}/${page > 1 ? `?pagina=${page}` : ''}`;
  const breadcrumbSteps = [{ name: 'Shop', path: '' }, { name: group.name, path: `groep/${group.slug}/` }, ...chain.map((item) => ({ name: item.name, path: `categorie/${item.slug}/` }))];
  return layout({ root, wide: true, canonicalPath: browsePath, jsonLd: [Seo.breadcrumbJsonLd(breadcrumbSteps, activeShop.baseUrl)], events: listEventsOf(subject.name, shown), variantScript: shown.some((product) => product.variants), title: Seo.pageTitleOf(subject.seoTitle, `${subject.name} – ${SHOP_NAME}`), description: subject.seoDescription || `${subject.name} van AquaTech Service: ${productCount(subject.count)}.`, body, groups });
}

/**
 * Pagina van een hoofdcategorie: haar categorieën als blokken.
 * @param {object} group De hoofdcategorie (slug, name, categories, count, intro).
 * @param {object[]} groups Alle hoofdcategorieën (voor menu en voet).
 * @returns {string} De HTML-pagina.
 */
function groupPage(group, groups) {
  return browsePage({ group, groups });
}

/**
 * Categoriepagina: subcategorieën als blokken en de producten die direct in de categorie zitten.
 * @param {object} category De categorie (slug, name, count, groupSlug, children, intro).
 * @param {object[]} products De producten die direct in de categorie zitten.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {object} [options] De filters, zie browsePage.
 * @returns {string} De HTML-pagina.
 */
function categoryPage(category, products, groups, options = {}) {
  const group = groups.find((candidate) => candidate.slug === category.groupSlug) || { slug: category.groupSlug, name: category.name, categories: [category], count: category.count };
  return browsePage({ group, category, products, groups, options });
}

/**
 * De hulp bij een zoekopdracht zonder resultaat: tips, de hoofdcategorieën en het telefoonnummer, zodat de bezoeker niet op een lege pagina strandt.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} HTML van het blok.
 */
function noResults(root, groups) {
  const phone = activeContent.site.contact.phone;
  const links = groups.map((group) => `<li><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a></li>`).join('');
  return `<div class="no-results"><p><strong>Niets gevonden.</strong> Probeer een korter woord, een andere schrijfwijze of het artikelnummer.</p>${links ? `<p>Of kijk in een van onze categorieën:</p><ul class="no-results-groups">${links}</ul>` : ''}${phone ? `<p>Zoek je iets specifieks? Bel ons voor advies: <a href="${escapeHtml(phoneLink(phone))}">${escapeHtml(phone)}</a>.</p>` : ''}</div>`;
}

/**
 * Zoekpagina: producten waarvan naam, artikelnummer of categorie bij de zoekterm passen, beste treffer eerst.
 * @param {string} query De zoekterm.
 * @param {object[]} products De producten die passen (al gefilterd).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {boolean} [onlyInStock] Of alleen producten op voorraad getoond worden.
 * @param {boolean} [preview] Of het conceptvoorbeeld in de filterlinks behouden blijft.
 * @param {boolean} [widened] Of er ruimer is gezocht (verwante woorden, tikfouten) omdat er geen exacte treffers waren.
 * @returns {string} De HTML-pagina.
 */
function searchPage(query, products, groups, onlyInStock = false, preview = false, widened = false) {
  const root = '../';
  const shown = products.slice(0, MAX_SEARCH_RESULTS);
  const body = `<h1>Zoeken</h1>
${query ? `<p class="muted">${productCount(products.length)} voor “${escapeHtml(query)}”${products.length > shown.length ? ` (de eerste ${shown.length} getoond)` : ''}.</p>` : '<p class="muted">Typ een productnaam of artikelnummer.</p>'}
${query && widened && products.length ? '<p class="muted search-widened">Geen exacte treffers: we zochten ook op verwante woorden en andere schrijfwijzen.</p>' : ''}
${query ? stockFilter(onlyInStock, `q=${encodeURIComponent(query)}`, `q=${encodeURIComponent(query)}&amp;voorraad=1`, preview) : ''}
${query && !products.length ? noResults(root, groups) : ''}
<div class="product-grid">
${shown.map((product) => productCard(product, root)).join('\n')}
</div>`;
  return layout({ root, events: query ? listEventsOf('Zoekresultaten', shown, { searchTerm: query, resultCount: products.length }) : [], variantScript: shown.some((product) => product.variants), title: `Zoeken – ${SHOP_NAME}`, description: 'Zoek een product in de webshop van AquaTech Service.', body, groups, query });
}

/**
 * Kort een tekst in tot een maximale lengte op een woordgrens, op één regel (voor meta-omschrijvingen en JSON-LD).
 * @param {string} text De tekst.
 * @param {number} maxLength Hoogstens zoveel tekens.
 * @returns {string} De ingekorte tekst (met … als er iets af is).
 */
function shortText(text, maxLength) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxLength * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * Het blok Omschrijving en Specificaties onder een product (12): alinea's uit de platte tekst (lege regel = nieuwe
 * alinea, een regel met • = lijstpunt) en een tabel met de specificaties.
 * @param {{ description: string, specifications: { name: string, value: string }[] }} details Wat het artikel toont.
 * @returns {string} De HTML, leeg als er niets is.
 */
function detailsSection(details) {
  const blocks = details.description ? details.description.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith('• '))) return `<ul>${lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('\n') : '';
  const specs = details.specifications.length ? `<table class="product-specs"><tbody>${details.specifications.map((entry) => `<tr><th scope="row">${escapeHtml(entry.name)}</th><td>${escapeHtml(entry.value)}</td></tr>`).join('')}</tbody></table>` : '';
  if (!blocks && !specs) return '';
  return `<section class="product-details">${blocks ? `<h2>Omschrijving</h2>\n${blocks}` : ''}${specs ? `<h2>Specificaties</h2>\n${specs}` : ''}</section>`;
}

/**
 * Productpagina: afbeelding, naam, artikelnummer, prijs en voorraadstand. Bij een
 * hoofdartikel met varianten een keuzelijst en de gegevens van de gekozen variant.
 * @param {object} product Het product uit de catalogus (of een variant, met parentSlug en parentName).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {string} [chosenCode] Artikelnummer van de gekozen variant (alleen bij een hoofdartikel; anders de eerste op voorraad).
 * @param {Map<string, { description: string, specifications: object[] }>} [details] Omschrijving en specificaties per artikelcode (storefront-data.detailsOf).
 * @param {{ packagingsFor?: Function, packCode?: string, leadTextFor?: Function, deliveryNoteFor?: Function, trust?: { freeFrom?: number, online?: boolean }, stockAlert?: ?{ status: string } }} [packaging] `stockAlert` zet het formulier voor de voorraadmelding bij een artikel dat niet op voorraad is (met de uitkomst van een eerdere aanmelding in `status`) packagingsFor(artikelcode) = de verpakkingen die de bezoeker mag kiezen (zie storefront.js) en packCode = de gekozen verpakking (leeg = per stuk).
 * @returns {string} De HTML-pagina.
 */
function productPage(product, groups, chosenCode = '', details = new Map(), { packagingsFor = () => [], packCode = '', leadTextFor = () => '', deliveryNoteFor = () => '', trust = {}, stockAlert = null } = {}) {
  const root = '../../';
  const variants = product.variants || [];
  const chosen = variants.length ? (variants.find((variant) => variant.code === chosenCode) || variants.find((variant) => variant.inStock) || variants[0]) : null;
  const shown = chosen || product;
  const imageUrl = (chosen && chosen.image) || product.image;
  const image = imageUrl ? `<img src="${productImageSrc(root, imageUrl)}" alt="${escapeHtml(product.name)}">` : '<span class="no-image" aria-hidden="true"></span>';
  const group = groups.find((candidate) => candidate.slug === product.groupSlug);
  const packagings = packagingsFor(shown.code);
  const pack = packagings.find((packaging) => packaging.packCode.toUpperCase() === packCode.toUpperCase()) || null;
  const picker = chosen ? `<form class="variant-pick" method="get" action="">
      <label>${escapeHtml(product.attributeName)} <span class="variant-count">(${variants.length} varianten)</span><select name="v" data-autosubmit>${variants.map((variant) => `<option value="${escapeHtml(variant.code)}"${variant === chosen ? ' selected' : ''}>${escapeHtml(variant.label)}</option>`).join('')}</select></label>
      <button class="button secondary variant-go" type="submit">Kies</button>
    </form>` : '';
  // Verpakkingskeuze (per stuk, doos, pallet): de prijs en winkelwagencode volgen de keuze; de variant blijft behouden.
  const packagingPicker = packagings.length ? `<form class="variant-pick" method="get" action="">
      ${chosen ? `<input type="hidden" name="v" value="${escapeHtml(chosen.code)}">` : ''}
      <label>Verpakking<select name="p" data-autosubmit><option value="">Per ${escapeHtml(product.unit)} – ${escapeHtml(formatPrice(shownPrice(shown)))}</option>${packagings.map((packaging) => `<option value="${escapeHtml(packaging.packCode)}"${packaging === pack ? ' selected' : ''}>${escapeHtml(packaging.name)} (${packaging.factor} ${escapeHtml(product.unit)}) – ${escapeHtml(formatPrice(packaging.price))}</option>`).join('')}</select></label>
      <button class="button secondary variant-go" type="submit">Kies</button>
    </form>` : '';
  const shownDetails = details.get(shown.code) || details.get(product.code) || { description: '', specifications: [], seoTitle: '', seoDescription: '', brand: '', ean: '' };
  const parentLink = product.parentSlug ? `<p class="note"><a href="${root}product/${escapeHtml(product.parentSlug)}/?v=${encodeURIComponent(shown.code)}">Alle uitvoeringen van ${escapeHtml(product.parentName)}</a></p>` : '';
  const viewedItem = activeShop.analytics ? Analytics.itemOfProduct({ code: pack ? pack.cartCode : shown.code, name: product.name, categoryName: product.categoryName }, pack ? pack.price : shownPrice(shown), { variant: chosen ? chosen.label : '' }) : null;
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a>${group ? ` › <a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : ''} › <a href="${root}categorie/${escapeHtml(product.categorySlug)}/">${escapeHtml(product.categoryName)}</a> › <span>${escapeHtml(product.name)}</span></nav>
<article class="product-detail">
  <div class="product-image large">${image}</div>
  <div class="product-info">
    <h1>${escapeHtml(product.name)}</h1>
    ${picker}
    <p class="sku">Artikelnummer: ${escapeHtml(shown.code)}${chosen && chosen.meta ? ` | ${escapeHtml(chosen.meta)}` : ''}</p>
    ${packagingPicker}
    <p class="price">${escapeHtml(formatPrice(pack ? pack.price : shownPrice(shown)))} <small>${activeShop.business ? `excl. ${shown.vatRate}% btw · per ${escapeHtml(pack ? `${pack.name} (${pack.factor} ${product.unit})` : product.unit)}<br><span class="price-incl">incl. btw ${escapeHtml(formatPrice(pack ? pack.priceIncl : shown.priceBusinessIncl))}</span>` : `incl. ${shown.vatRate}% btw · per ${escapeHtml(pack ? `${pack.name} (${pack.factor} ${product.unit})` : product.unit)}`}</small></p>
    <p class="stock ${(pack ? pack.inStock : shown.inStock) ? 'in' : 'out'}">${stockText(pack ? pack.inStock : shown.inStock, pack ? null : (shown.stockQty === undefined ? null : shown.stockQty))}</p>
    ${leadTextFor(shown.code, pack ? pack.inStock : shown.inStock) ? `<p class="lead-time">${escapeHtml(leadTextFor(shown.code, pack ? pack.inStock : shown.inStock))}</p>` : ''}
    ${deliveryNoteFor(shown.code) ? `<p class="delivery-note note">Bezorging: ${escapeHtml(deliveryNoteFor(shown.code))}</p>` : ''}
    ${activeShop.ordering ? orderForm(root, pack ? pack.cartCode : shown.code, pack ? pack.inStock : shown.inStock, 'product-order', viewedItem) : '<button class="button" type="button" disabled>In winkelwagen</button>\n    <p class="note">Online bestellen volgt binnenkort.</p>'}
    ${stockAlert && !(pack ? pack.inStock : shown.inStock) ? stockAlertForm(root, shown.code, stockAlert.status) : ''}
    ${parentLink}
    ${trustStrip(root, { freeFrom: trust.freeFrom || 0, online: Boolean(trust.online), business: activeShop.business })}
  </div>
</article>
${detailsSection(shownDetails)}`;
  const productPath = `product/${product.slug}/`;
  // Een variantpagina heeft één aanbieding (de eigen prijs en voorraad); een hoofdartikel een prijsbereik over de varianten.
  const jsonProduct = product.parentSlug ? { ...product, variants: [] } : product;
  const productDescription = shownDetails.description ? shortText(shownDetails.description, 500) : `${product.name}, artikelnummer ${product.code}${product.categoryName ? `, uit de categorie ${product.categoryName}` : ''} bij ${SHOP_NAME}.`;
  const breadcrumbSteps = [{ name: 'Shop', path: '' }, ...(group ? [{ name: group.name, path: `groep/${group.slug}/` }] : []), { name: product.categoryName, path: `categorie/${product.categorySlug}/` }, { name: product.name, path: productPath }];
  return layout({ root, events: viewedItem ? Analytics.viewItemEvents(viewedItem, { inStock: pack ? pack.inStock : shown.inStock }) : [], canonicalPath: productPath, ogType: 'product', ogImage: Seo.imageUrlOf(activeShop.baseUrl, imageUrl), variantScript: Boolean(chosen || packagings.length), jsonLd: [Seo.productJsonLd({ product: jsonProduct, baseUrl: activeShop.baseUrl, canonicalPath: productPath, shopName: SHOP_NAME, description: productDescription, brand: shownDetails.brand, ean: shownDetails.ean }), Seo.breadcrumbJsonLd(breadcrumbSteps, activeShop.baseUrl)], title: Seo.pageTitleOf(shownDetails.seoTitle, `${product.name} – ${SHOP_NAME}`), description: shownDetails.seoDescription || (shownDetails.description ? shortText(shownDetails.description, 155) : `${product.name} (${formatPrice(shownPrice(shown))} ${activeShop.business ? 'excl.' : 'incl.'} btw) bij AquaTech Service.`), body, groups });
}

/**
 * Kop van de pagina Over ons (gedeeld door de standaardpagina en een eigen pagina uit Beheer).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de kop.
 */
function aboutHero(root) {
  return `<section class="about-hero"><img src="${assetUrl(root, 'over-ons-hero.webp')}" alt="" width="1440" height="511"><div class="about-hero-text"><p class="about-eyebrow">Ons verhaal</p><h1>Over ons</h1><p class="about-lead">Beregening, leidingen en pompen van mensen die het vak kennen.</p></div></section>`;
}

/**
 * Blok met de bedrijfsgegevens (telefoon, e-mail, adres, KvK) uit de bedrijfsinstellingen.
 * @returns {string} HTML van het blok, of leeg zonder gegevens.
 */
function aboutFacts() {
  const contact = activeContent.site.contact;
  const facts = [['Telefoon', contact.phone ? `<a href="${escapeHtml(phoneLink(contact.phone))}">${escapeHtml(contact.phone)}</a>` : ''], ['E-mail', contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : ''], ['Adres', escapeHtml(contact.address || '')], ['KvK', escapeHtml(contact.kvk || '')]].filter(([, value]) => value);
  return facts.length ? `<dl class="about-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` : '';
}

/**
 * Afsluitend blok van de pagina Over ons met knoppen voor het assortiment, bellen en mailen.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van het blok.
 */
function aboutCta(root) {
  const contact = activeContent.site.contact;
  const contactButtons = `${contact.phone ? `<a class="button" href="${escapeHtml(phoneLink(contact.phone))}">Bel ${escapeHtml(contact.phone)}</a>` : ''}${contact.email ? `<a class="button secondary" href="mailto:${escapeHtml(contact.email)}">Stuur een e-mail</a>` : ''}`;
  return `<section class="about-cta"><p class="about-claim">Kwaliteit, service en betaalbaarheid komen bij ons samen.</p><p>Vragen of advies nodig bij uw project? Neem contact met ons op of bekijk direct het assortiment.</p><div class="about-cta-actions"><a class="button" href="${root}">Bekijk het assortiment</a>${contactButtons}</div></section>`;
}

/**
 * Pagina Over ons: het verhaal van Aquatechshop.nl (tekst overgenomen van
 * aquatechshop.nl), met kop, verhaal met bedrijfsgegevens, twee onderscheidende
 * punten, de waarden en een contactblok. Gegevens komen uit de bedrijfsinstellingen.
 * @param {object[]} groups Alle hoofdcategorieën (voor menu en voet).
 * @returns {string} De HTML-pagina.
 */
function aboutPage(groups) {
  const root = '../';
  const blocks = [
    ['over-ons-verhaal.png', 'Aquatechshop.nl is ontstaan vanuit HVT Beregening, een gespecialiseerd bedrijf in beregenings- en watertechniek. Dankzij de ervaring in de sector kunnen wij onze klanten optimaal van dienst zijn. Korte lijnen, klanttevredenheid en efficiëntie zijn onze uitgangspunten.'],
    ['over-ons-tarieven.png', 'Scherpe tarieven', 'Wij zijn totaalleverancier voor bedrijven, particulieren en organisaties. Door de goede en veelal rechtstreekse relaties met fabrikanten en leveranciers kunnen wij bewezen materialen en techniek leveren tegen zeer scherpe prijzen. Met ons koopt u als het ware de vruchten van een goed netwerk in combinatie met vakkennis en ervaring.'],
    ['over-ons-technische-dienst.png', 'Eigen technische dienst', 'HVT Beregening is onze eigen technische dienst. Voor installatie en/of uitgebreid advies kunt u daarom ook bij ons terecht: <a href="https://www.hvtberegening.nl">www.hvtberegening.nl</a>'],
  ];
  const values = [
    ['Kwaliteit', 'Bewezen en beproefde producten'],
    ['Betrouwbaar', 'Verbeter uw werk door samen te werken met een ervaren en betrouwbare partner.'],
    ['Levering op locatie', 'Bezorging bij u op locatie, om u te ontzorgen'],
    ['Persoonlijke aandacht', 'Of je nu een professional, ondernemer of particulier bent, maatwerk vinden wij belangrijk.'],
  ];
  const factsHtml = aboutFacts();
  const body = `${aboutHero(root)}
<div class="wrap">
<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>Over ons</span></nav>
<div class="about-story"><div><h2>Aquatechshop.nl</h2><p>${blocks[0][1]}</p></div>${factsHtml}</div>
<div class="about-blocks">${blocks.slice(1).map(([icon, heading, text]) => `<section class="about-block"><img src="${assetUrl(root, icon)}" alt="" width="64" height="64" loading="lazy"><div><h2>${heading}</h2><p>${text}</p></div></section>`).join('')}</div>
<h2 class="centered">Waarom Aquatechshop?</h2>
<div class="about-values">${values.map(([heading, text]) => `<div class="about-value"><strong>${heading}</strong><span>${text}</span></div>`).join('')}</div>
${aboutCta(root)}
</div>`;
  return layout({ root, groups, wide: true, canonicalPath: 'over-ons/', title: `Over ons – ${SHOP_NAME}`, description: 'Aquatechshop.nl is ontstaan vanuit HVT Beregening: scherpe tarieven, een eigen technische dienst en levering op locatie.', body });
}

/** Opzoeklijsten per catalogus (artikelcode → artikel, categorie → subcategorieën), zodat een pagina met meer artikelblokken ze één keer opbouwt. */
const blockLookups = new WeakMap();

/**
 * De opzoeklijsten voor artikelblokken van een catalogus.
 * @param {object} catalog De catalogus (zie buildCatalog).
 * @returns {{ byCode: Map<string, object>, childrenOf: Map<string, string[]> }} Artikel per code (een variantcode geeft het hoofdartikel) en de directe subcategorieën per categorie.
 */
function lookupsOf(catalog) {
  let lookups = blockLookups.get(catalog);
  if (lookups) return lookups;
  const byCode = new Map(catalog.products.map((product) => [product.code, product]));
  const bySlug = new Map(catalog.products.map((product) => [product.slug, product]));
  for (const variant of catalog.variantProducts || []) {
    if (!byCode.has(variant.code) && bySlug.has(variant.parentSlug)) byCode.set(variant.code, bySlug.get(variant.parentSlug));
  }
  const childrenOf = new Map();
  for (const category of catalog.categories) {
    if (category.parentSlug) childrenOf.set(category.parentSlug, [...(childrenOf.get(category.parentSlug) || []), category.slug]);
  }
  lookups = { byCode, childrenOf };
  blockLookups.set(catalog, lookups);
  return lookups;
}

/**
 * Zoekt de artikelen voor een artikelblok: eigen artikelcodes (een variantcode geeft het hoofdartikel) of een categorie met haar subcategorieën.
 * @param {object} block Het artikelblok (mode, codes, category, limit).
 * @param {object} catalog De catalogus (zie buildCatalog).
 * @returns {object[]} De artikelen (uit een categorie maximaal block.limit; bij eigen codes alle bestaande, zonder dubbelen).
 */
function productsOfBlock(block, catalog) {
  const { byCode, childrenOf } = lookupsOf(catalog);
  if (block.mode === 'category') {
    const slugs = new Set([block.category]);
    const queue = [block.category];
    while (queue.length) {
      for (const child of childrenOf.get(queue.pop()) || []) {
        if (!slugs.has(child)) { slugs.add(child); queue.push(child); }
      }
    }
    return catalog.products.filter((product) => slugs.has(product.categorySlug)).slice(0, block.limit);
  }
  // Bij eigen codes telt het aantal codes (maximaal 12, al begrensd bij het opslaan); `limit` geldt alleen voor een categorie.
  return [...new Set(block.codes.map((code) => byCode.get(code)).filter(Boolean))];
}

/**
 * Tekent de blokken van een pagina (tekst, afbeelding, artikelen, vragen, knop).
 * @param {object[]} blocks De blokken (zie page-blocks.js).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object} catalog De catalogus voor de artikelblokken.
 * @returns {string} HTML van de blokken.
 */
function renderPageBlocks(blocks, root, catalog) {
  return blocks.map((block) => {
    if (block.type === 'text') return `<div class="cms-text">${block.html.replace(/<img src="media:([0-9a-f-]{36})"/g, (_, id) => `<img loading="lazy" src="${root}media/${id}"`)}</div>`;
    if (block.type === 'image') {
      const image = `<img loading="lazy" src="${imageSrc(root, block.image)}" alt="${escapeHtml(block.alt)}">`;
      const href = linkHref(block.link, root, '');
      return `<figure class="cms-image">${href ? `<a href="${href}">${image}</a>` : image}${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
    }
    if (block.type === 'products') {
      const products = productsOfBlock(block, catalog);
      if (!products.length) return '';
      return `<section class="cms-products">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}<div class="product-grid">\n${products.map((product) => productCard(product, root)).join('\n')}\n</div></section>`;
    }
    if (block.type === 'faq') {
      return `<section class="cms-faq">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}${block.items.map((item) => `<details><summary>${escapeHtml(item.question)}</summary>${item.answer.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('')}</details>`).join('')}</section>`;
    }
    const href = linkHref(block.link, root, '');
    return `<aside class="cms-cta">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}${block.text ? `<p>${escapeHtml(block.text)}</p>` : ''}${href && block.button ? `<a class="button" href="${href}">${escapeHtml(block.button)}</a>` : ''}</aside>`;
  }).join('\n');
}

/**
 * Vragen met antwoord voor de FAQPage-gegevens van een pagina: de vragen uit de FAQ-blokken, en op de pagina
 * veelgestelde-vragen (zonder FAQ-blok) de koppen in de tekstblokken.
 * @param {{ slug: string }} page De pagina.
 * @param {object[]} blocks De blokken van de pagina.
 * @returns {{ question: string, answer: string }[]} De vragen.
 */
function faqEntriesOfPage(page, blocks) {
  const fromBlocks = faqEntriesOfBlocks(blocks);
  if (fromBlocks.length || page.slug !== FAQ_SLUG) return fromBlocks;
  return Seo.faqEntriesOf(blocks.filter((block) => block.type === 'text').map((block) => block.html).join(''));
}

/**
 * Een vaste pagina uit Beheer.
 * @param {{ slug: string, title: string, description?: string, seoTitle?: string, blocks?: object[], body?: string }} page De pagina.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object} [catalog] De catalogus voor artikelblokken (zonder tonen die blokken niets).
 * @returns {string} De HTML-pagina.
 */
function contentPage(page, groups, root, catalog = { products: [], categories: [] }) {
  const blocks = blocksOf(page);
  // Een eigen Over ons uit Beheer krijgt dezelfde kop, bedrijfsgegevens en afsluiting als de standaardpagina.
  const html = page.slug === 'over-ons'
    ? `${aboutHero(root)}
<div class="wrap"><nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>${escapeHtml(page.title)}</span></nav>
<div class="about-story"><article class="cms-page">${renderPageBlocks(blocks, root, catalog)}</article>${aboutFacts()}</div>
${aboutCta(root)}
</div>`
    : `<div class="wrap"><nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>${escapeHtml(page.title)}</span></nav>
<article class="cms-page"><h1>${escapeHtml(page.title)}</h1>
${renderPageBlocks(blocks, root, catalog)}
</article></div>`;
  const faq = Seo.faqJsonLd(faqEntriesOfPage(page, blocks));
  return layout({ root, groups, wide: true, canonicalPath: page.slug === 'over-ons' ? 'over-ons/' : `pagina/${page.slug}/`, jsonLd: faq ? [faq] : [], title: Seo.pageTitleOf(page.seoTitle, `${page.title} – ${SHOP_NAME}`), description: page.description || `${page.title} bij ${SHOP_NAME}.`, body: html });
}

/**
 * Pagina voor een onbekende categorie of product.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function notFoundPage(root, groups) {
  return layout({ root, groups, title: `Pagina niet gevonden – ${SHOP_NAME}`, description: 'Deze pagina bestaat niet.', body: `<h1>Pagina niet gevonden</h1><p><a href="${root || './'}">Terug naar de shop</a></p>` });
}

module.exports = { layout, renderWith, captchaFields, trustStrip, stockText, contentPage, homePage, aboutPage, groupPage, categoryPage, searchPage, productPage, notFoundPage, escapeHtml, formatPrice };
