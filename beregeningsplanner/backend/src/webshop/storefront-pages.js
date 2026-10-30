// HTML van de eigen webshop (storefront.js): startpagina, hoofdcategorie,
// categorie, zoeken, productpagina en "niet gevonden". Server-side opgebouwd, zonder scripts.
// Alle adressen zijn relatief ten opzichte van de huidige pagina (`root` =
// '', '../' of '../../'), zodat de shop ook onder een padprefix achter een
// proxy werkt.

const { version: SHOP_VERSION } = require('../../package.json');
const { DEFAULT_SITE } = require('./shop-content');
const { LEGAL_SLUGS, LEGAL_TITLES } = require('./legal-pages');

const SHOP_NAME = 'Aquatechshop.nl';
/** Maximaal aantal resultaten op de zoekpagina. */
const MAX_SEARCH_RESULTS = 60;
/** Aantal subcategorieën per hoofdcategorie op de startpagina. */
const HOME_SUBCATEGORIES = 6;

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
/** Of bestellen aan staat en hoeveel regels er in de winkelwagen van de bezoeker zitten (voor de pagina's die nu worden opgebouwd). */
let activeShop = { ordering: false, cartCount: 0 };

/**
 * Bouwt pagina's op met de inhoud uit Beheer. Het opbouwen is synchroon, dus
 * zolang `render` loopt hoort elke pagina bij deze inhoud; daarna geldt weer de vorige.
 * @param {{ site: object, pages: object[] }} content De inhoud (zie shop-content.js, publicContent).
 * @param {Function} render Functie die de pagina('s) opbouwt en iets teruggeeft.
 * @param {{ ordering: boolean, cartCount: number }} [shop] Of bestellen aan staat en het aantal regels in de winkelwagen.
 * @returns {*} Wat `render` teruggeeft.
 */
function renderWith(content, render, shop = { ordering: false, cartCount: 0 }) {
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
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
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
 * Menu van de hoofdcategorieën. Op een breed scherm een balk met uitklappers
 * (alleen CSS), op een smal scherm een menuknop (details/summary).
 * @param {object[]} groups De hoofdcategorieën (slug, name, categories).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van beide menu's.
 */
function navigation(groups, root) {
  /**
   * Lijstitems met de subcategorieën van een hoofdcategorie.
   * @param {object} group De hoofdcategorie.
   * @returns {string} HTML van de lijstitems.
   */
  function subItems(group) {
    return group.categories.map((category) => `<li><a href="${root}categorie/${escapeHtml(category.slug)}/">${escapeHtml(category.name)}</a></li>`).join('');
  }
  const allGroups = groups.map((group) => `<li><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a></li>`).join('');
  const search = `<li class="nav-all"><span class="nav-all-button" tabindex="0">Product zoeken${ICONS.down}</span><ul class="nav-drop">${allGroups}</ul></li>`;
  const extraPages = activeContent.pages.filter((page) => page.menu && page.slug !== 'over-ons');
  const about = `<li class="nav-about"><a href="${root}over-ons/">Over ons</a></li>${extraPages.map((page) => `<li class="nav-about"><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}`;
  const desktop = groups.map((group) => `<li class="nav-group"><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a><ul class="nav-drop">${subItems(group)}</ul></li>`).join('');
  const mobile = groups.map((group) => `<li><details><summary>${escapeHtml(group.name)}</summary><ul><li><a href="${root}groep/${escapeHtml(group.slug)}/">Alles in ${escapeHtml(group.name)}</a></li>${subItems(group)}</ul></details></li>`).join('');
  return `<nav class="shop-nav" aria-label="Productgroepen"><ul class="nav-bar">${search}${about}${desktop}<!--planner:${root}--></ul></nav>
<details class="shop-menu"><summary>${ICONS.menu}<span>Alle productgroepen</span></summary><ul>${mobile}${extraPages.map((page) => `<li><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}<!--planner:${root}--></ul></details>`;
}

/**
 * Het kader om elke pagina: kop met logo, zoeken, winkelwagen en account,
 * menu van productgroepen, inhoud en voet.
 * @param {{ root: string, title: string, description: string, body: string, groups: object[], query?: string, wide?: boolean, variantScript?: boolean }} options root = relatief pad naar de shop-startpagina, title, description (meta), body (HTML), groups = hoofdcategorieën voor menu en voet en query = ingevulde zoekterm en wide = de inhoud over de volle breedte (startpagina) en variantScript = of de pagina het script voor de keuzelijsten van varianten laadt.
 * @returns {string} De volledige HTML-pagina.
 */
function layout({ root, title, description, body, groups, query = '', wide = false, variantScript = false }) {
  const home = root || './';
  const { site, pages } = activeContent;
  const phone = site.contact.phone;
  const phoneHref = phoneLink(phone);
  const footerPages = pages.filter((page) => page.footer && page.slug !== 'over-ons' && !LEGAL_SLUGS.includes(page.slug));
  const legalLinks = LEGAL_SLUGS.map((slug) => { const own = pages.find((page) => page.slug === slug); return `<a href="${root}pagina/${slug}/">${escapeHtml(own ? own.title : LEGAL_TITLES[slug])}</a>`; }).join('');
  const footerGroups = groups.map((group) => `<li><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a></li>`).join('');
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" type="image/png" href="${assetUrl(root, 'favicon.png')}">
<link rel="stylesheet" href="${assetUrl(root, 'brand.css')}">
<link rel="stylesheet" href="${assetUrl(root, 'winkel.css')}">
${variantScript ? `<script src="${assetUrl(root, 'varianten.js')}" defer></script>\n` : ''}</head>
<body>
${site.notice.enabled && site.notice.text ? `<div class="shop-notice">${escapeHtml(site.notice.text)}</div>` : ''}
<header class="shop-head">
  <div class="shop-bar">
    <a class="shop-brand" href="${home}"><img src="${assetUrl(root, 'aquatechshop-logo.png')}" alt="Aquatechshop.nl" width="216" height="44"></a>
    <form class="shop-search" action="${root}zoeken/" method="get" role="search">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Zoek op product of artikelnummer" aria-label="Zoeken" maxlength="80">
      <button type="submit" aria-label="Zoeken">${ICONS.search}</button>
    </form>
    ${phone ? `<a class="shop-phone" href="${phoneHref}" aria-label="Klantenservice ${escapeHtml(phone)}">${ICONS.phone}<span><small>Klantenservice</small><strong>${escapeHtml(phone)}</strong></span></a>` : ''}
    <div class="shop-actions">
      <a class="shop-action" href="${root}account/" title="Inloggen of mijn account">${ICONS.user}<span>Account</span></a>
      ${activeShop.ordering
    ? `<a class="shop-action cart" href="${root}winkelwagen/" title="Naar je winkelwagen">${ICONS.cart}<span>Winkelwagen</span><b>${activeShop.cartCount}</b></a>`
    : `<span class="shop-action cart" aria-disabled="true" title="De winkelwagen volgt binnenkort">${ICONS.cart}<span>Winkelwagen</span><b>0</b></span>`}
    </div>
  </div>
  ${navigation(groups, root)}
</header>
<main class="shop-main${wide ? ' wide' : ''}">
${body}
</main>
<footer class="shop-foot">
  <div class="foot-grid">
    <div><strong>Aquatechshop.nl</strong><p>${[site.contact.kvk && `K.v.k.: ${escapeHtml(site.contact.kvk)}`, site.contact.address && escapeHtml(site.contact.address), site.contact.email && `<a href="mailto:${escapeHtml(site.contact.email)}">${escapeHtml(site.contact.email)}</a>`, phone && `<a href="${phoneHref}">${escapeHtml(phone)}</a>`].filter(Boolean).join('<br>')}</p></div>
    <div><strong>Productgroepen</strong><ul>${footerGroups}</ul></div>
    <div><strong>Account</strong><ul><li><a href="${root}account/">Mijn account</a></li><li><a href="${root}account/">Inloggen of registreren</a></li></ul></div>
    <div><strong>Over ons</strong><p>${escapeHtml(site.footer.about)}</p><p><a href="${root}over-ons/">Lees ons verhaal</a></p>${footerPages.length ? `<ul>${footerPages.map((page) => `<li><a href="${root}pagina/${escapeHtml(page.slug)}/">${escapeHtml(page.title)}</a></li>`).join('')}</ul>` : ''}</div>
  </div>
  <nav class="foot-legal" aria-label="Voorwaarden">${legalLinks}</nav>
  <div class="foot-note"><span>Alle prijzen zijn inclusief btw.</span><img src="${assetUrl(root, 'betaalmethoden.png')}" alt="Betaalmethoden" width="286" height="26" loading="lazy"></div>
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
  return `${product.variants && product.variants.length > 1 ? 'Vanaf ' : ''}${escapeHtml(formatPrice(product.priceIncl))}`;
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

/**
 * Het formulier om een artikel in de winkelwagen te leggen (alleen als bestellen aan staat; anders een uitgeschakelde knop).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {string} code Artikelnummer van het artikel (of van de gekozen variant).
 * @param {boolean} inStock Of het artikel op voorraad is.
 * @param {string} className Klasse van het formulier.
 * @returns {string} HTML.
 */
function orderForm(root, code, inStock, className) {
  if (!activeShop.ordering) return `<div class="${className}"><input type="number" value="1" min="1" aria-label="Aantal" disabled><button class="button" type="button" disabled>In winkelwagen</button></div>`;
  return `<form class="${className}" method="post" action="${root}winkelwagen/">
      <input type="hidden" name="action" value="add"><input type="hidden" name="code" value="${escapeHtml(code)}" data-order-code>
      <input type="number" name="qty" value="1" min="1" max="99" aria-label="Aantal"${inStock ? '' : ' disabled'}><button class="button" type="submit"${inStock ? '' : ' disabled'}>In winkelwagen</button>
    </form>`;
}

/**
 * De regel van een hoofdartikel met varianten, in de opzet van een groothandel:
 * foto, naam, artikelnummer en kenmerken, een keuzelijst met uitvoeringen en
 * rechts prijs incl. btw, voorraad, aantal en winkelwagenknop. Zonder script
 * kiest de bezoeker met de knop Kies (opent de productpagina van die
 * uitvoering); met het script wisselen artikelnummer, prijs en voorraad direct.
 * @param {object} product Het hoofdartikel (variants, attributeName).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de regel.
 */
function variantRow(product, root) {
  const selected = product.variants.find((variant) => variant.inStock) || product.variants[0];
  const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>';
  const options = product.variants.map((variant) => `<option value="${escapeHtml(variant.code)}" data-code="${escapeHtml(variant.code)}" data-meta="${escapeHtml(variant.meta)}" data-price="${escapeHtml(formatPrice(variant.priceIncl))}" data-stock="${variant.inStock ? 'in' : 'out'}" data-href="${productHref(root, product, variant)}"${variant === selected ? ' selected' : ''}>${escapeHtml(variant.label)}</option>`).join('');
  return `<div class="variant-row" data-variant-row>
  <a class="product-image" href="${productHref(root, product, selected)}" data-variant-link tabindex="-1" aria-hidden="true">${image}</a>
  <div class="variant-main">
    <a class="product-name" href="${productHref(root, product, selected)}" data-variant-link title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</a>
    <p class="variant-meta">Artikelnr.: <span data-variant-code>${escapeHtml(selected.code)}</span><span data-variant-meta>${selected.meta ? ` | ${escapeHtml(selected.meta)}` : ''}</span></p>
  </div>
  <form class="variant-pick" method="get" action="${root}product/${escapeHtml(product.slug)}/">
    <label>${escapeHtml(product.attributeName)}<select name="v" data-variant-select>${options}</select></label>
    <span class="variant-count">${product.variants.length} varianten</span>
    <button class="button secondary variant-go" type="submit">Kies</button>
  </form>
  <div class="variant-buy">
    <p class="variant-price"><strong data-variant-price>${escapeHtml(formatPrice(selected.priceIncl))}</strong> <small>incl. btw</small></p>
    <p class="stock ${selected.inStock ? 'in' : 'out'}" data-variant-stock>${selected.inStock ? 'Op voorraad' : 'Niet op voorraad'}</p>
    ${orderForm(root, selected.code, selected.inStock, 'variant-order')}
  </div>
</div>`;
}

/**
 * Een product in een lijst: een regel met keuzelijst bij een hoofdartikel met varianten, anders een kaart.
 * @param {object} product Een product uit de catalogus.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML.
 */
function listItem(product, root) {
  return product.variants ? variantRow(product, root) : productCard(product, root);
}

/**
 * Een kaart in een productoverzicht: afbeelding, naam, prijs en voorraadstand.
 * @param {object} product Een product uit de catalogus.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van de kaart.
 */
function productCard(product, root) {
  const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>';
  return `<a class="product-card" href="${root}product/${escapeHtml(product.slug)}/">
  <span class="product-image">${image}</span>
  <span class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span>
  <span class="product-price">${priceText(product)}</span>
  <span class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</span>
</a>`;
}

/**
 * Tegels van categorieën (naam en aantal producten).
 * @param {object[]} categories De categorieën (slug, name, count).
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} HTML van het raster.
 */
function categoryTiles(categories, root) {
  return `<div class="category-grid">
${categories.map((category) => `<a class="category-tile" href="${root}categorie/${escapeHtml(category.slug)}/"><strong>${escapeHtml(category.name)}</strong><span>${productCount(category.count)}</span></a>`).join('\n')}
</div>`;
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
  return `<a class="product-row" href="${root}product/${escapeHtml(product.slug)}/"><span class="product-image"><img src="${escapeHtml(product.image)}" alt="" loading="lazy"></span><span class="product-row-text"><span class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span><span class="product-price">${priceText(product)}</span><span class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</span></span></a>`;
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
  const { hero, benefits: benefitBlock, brands: brandBlock, business: businessBlock } = activeContent.site;
  const heroButton = hero.button || (first ? `Bekijk ${first.name.toLowerCase()}` : '');
  const heroHref = linkHref(hero.link, root, first ? `groep/${escapeHtml(first.slug)}/` : '');
  const heroImage = imageSrc(root, hero.image);
  const intro = `<section class="home-hero">${heroImage ? `<img src="${heroImage}" alt=""${hero.image === DEFAULT_SITE.hero.image ? ' width="1440" height="419"' : ''}>` : ''}<div class="home-hero-text"><h1>${escapeHtml(hero.title)}</h1>${hero.text ? `<p>${escapeHtml(hero.text)}</p>` : ''}${heroButton && heroHref ? `<a class="button" href="${heroHref}">${escapeHtml(heroButton)}</a>` : ''}</div></section>`;
  if (!catalog.products.length) return layout({ root, groups: catalog.groups, wide: true, title: `${SHOP_NAME} – alles voor uw tuinberegening`, description: 'Sproeiers, druppelslang, leidingen en pompen voor tuinberegening van AquaTech Service.', body: `${intro}<div class="wrap"><p class="muted">De webshop wordt gevuld. Kom snel terug.</p></div>` });
  const tiles = catalog.groups.map((group) => {
    const showcase = groupShowcase(group, catalog.products);
    return `<a class="assortment-tile" href="groep/${escapeHtml(group.slug)}/"><span class="product-image">${showcase ? `<img src="${escapeHtml(showcase.image)}" alt="" loading="lazy">` : '<span class="no-image" aria-hidden="true"></span>'}</span><span>${escapeHtml(group.name)}</span></a>`;
  }).join('');
  const assortment = `<section class="assortment"><div class="wrap assortment-inner"><div class="assortment-title"><h2>Assortiment</h2><p>Alles voor jouw project</p></div><div class="assortment-strip">${tiles}</div></div></section>`;
  const popular = catalog.featured.length ? `<section class="wrap"><h2 class="centered">Populaire producten</h2>
<div class="product-grid">
${catalog.featured.map((product) => productCard(product, root)).join('\n')}
</div></section>` : '';
  const columns = catalog.groups.map((group) => ({ group, items: catalog.products.filter((product) => product.groupSlug === group.slug && product.image).slice(0, 3) })).filter((column) => column.items.length).slice(0, 3);
  const perGroup = columns.length ? `<section class="wrap"><div class="group-columns">${columns.map((column) => `<div><h2><a href="groep/${escapeHtml(column.group.slug)}/">${escapeHtml(column.group.name)}</a></h2>${column.items.map((product) => productRow(product, root)).join('')}</div>`).join('')}</div></section>` : '';
  const benefits = benefitBlock.enabled && benefitBlock.items.length ? `<section class="benefits"><div class="wrap benefits-inner">${benefitBlock.items.map((item) => `<div class="benefit">${item.image ? `<img src="${imageSrc(root, item.image)}" alt="" width="50" height="50" loading="lazy">` : ''}<div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></div></div>`).join('')}</div></section>` : '';
  const brands = brandBlock.enabled && brandBlock.items.length ? `<section class="wrap">${brandBlock.title ? `<h2 class="centered">${escapeHtml(brandBlock.title)}</h2>` : ''}<div class="brands">${brandBlock.items.map((item) => `<img src="${imageSrc(root, item.image)}" alt="${escapeHtml(item.name)}" height="70" loading="lazy">`).join('')}</div></section>` : '';
  const businessImage = imageSrc(root, businessBlock.image);
  const businessHref = linkHref(businessBlock.link, root, `${root}registreren/`);
  const business = businessBlock.enabled ? `<section class="business">${businessImage ? `<img src="${businessImage}" alt="" loading="lazy">` : ''}<div class="business-text"><h2>${escapeHtml(businessBlock.title)}</h2>${businessBlock.text ? `<p>${escapeHtml(businessBlock.text)}</p>` : ''}${businessBlock.button ? `<a class="button" href="${businessHref}">${escapeHtml(businessBlock.button)}</a>` : ''}</div></section>` : '';
  return layout({ root, wide: true, title: `${SHOP_NAME} – alles voor uw tuinberegening`, description: 'Sproeiers, druppelslang, leidingen en pompen voor tuinberegening van AquaTech Service.', body: `${intro}\n${assortment}\n${popular}\n${perGroup}\n${benefits}\n${brands}\n${business}`, groups: catalog.groups });
}

/**
 * Pagina van een hoofdcategorie: haar subcategorieën.
 * @param {object} group De hoofdcategorie (slug, name, categories, count).
 * @param {object[]} groups Alle hoofdcategorieën (voor menu en voet).
 * @returns {string} De HTML-pagina.
 */
function groupPage(group, groups) {
  const root = '../../';
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>${escapeHtml(group.name)}</span></nav>
<h1>${escapeHtml(group.name)}</h1>
${categoryTiles(group.categories, root)}`;
  return layout({ root, title: `${group.name} – ${SHOP_NAME}`, description: `${group.name} van AquaTech Service: ${productCount(group.count)}.`, body, groups });
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

/**
 * Categoriepagina: alle producten van één categorie.
 * @param {object} category De categorie (slug, name, count, groupSlug).
 * @param {object[]} products De producten in die categorie (bij onlyInStock al gefilterd).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {boolean} [onlyInStock] Of alleen producten op voorraad getoond worden.
 * @param {boolean} [preview] Of het conceptvoorbeeld in de filterlinks behouden blijft.
 * @returns {string} De HTML-pagina.
 */
function categoryPage(category, products, groups, onlyInStock = false, preview = false) {
  const root = '../../';
  const group = groups.find((candidate) => candidate.slug === category.groupSlug);
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a>${group ? ` › <a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : ''} › <span>${escapeHtml(category.name)}</span></nav>
<h1>${escapeHtml(category.name)}</h1>
${stockFilter(onlyInStock, '', 'voorraad=1', preview)}
${products.length ? '' : '<p class="muted">Geen producten op voorraad in deze categorie.</p>'}
<div class="product-grid">
${products.map((product) => listItem(product, root)).join('\n')}
</div>`;
  return layout({ root, variantScript: products.some((product) => product.variants), title: `${category.name} – ${SHOP_NAME}`, description: `${category.name} van AquaTech Service: ${productCount(category.count)}.`, body, groups });
}

/**
 * Zoekpagina: producten waarvan naam of artikelnummer de zoekterm bevat.
 * @param {string} query De zoekterm.
 * @param {object[]} products De producten die passen (al gefilterd).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {boolean} [onlyInStock] Of alleen producten op voorraad getoond worden.
 * @param {boolean} [preview] Of het conceptvoorbeeld in de filterlinks behouden blijft.
 * @returns {string} De HTML-pagina.
 */
function searchPage(query, products, groups, onlyInStock = false, preview = false) {
  const root = '../';
  const shown = products.slice(0, MAX_SEARCH_RESULTS);
  const body = `<h1>Zoeken</h1>
${query ? `<p class="muted">${productCount(products.length)} voor “${escapeHtml(query)}”${products.length > shown.length ? ` (de eerste ${shown.length} getoond)` : ''}.</p>` : '<p class="muted">Typ een productnaam of artikelnummer.</p>'}
${query ? stockFilter(onlyInStock, `q=${encodeURIComponent(query)}`, `q=${encodeURIComponent(query)}&amp;voorraad=1`, preview) : ''}
<div class="product-grid">
${shown.map((product) => listItem(product, root)).join('\n')}
</div>`;
  return layout({ root, variantScript: shown.some((product) => product.variants), title: `Zoeken – ${SHOP_NAME}`, description: 'Zoek een product in de webshop van AquaTech Service.', body, groups, query });
}

/**
 * Productpagina: afbeelding, naam, artikelnummer, prijs en voorraadstand. Bij een
 * hoofdartikel met varianten een keuzelijst en de gegevens van de gekozen variant.
 * @param {object} product Het product uit de catalogus (of een variant, met parentSlug en parentName).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {string} [chosenCode] Artikelnummer van de gekozen variant (alleen bij een hoofdartikel; anders de eerste op voorraad).
 * @returns {string} De HTML-pagina.
 */
function productPage(product, groups, chosenCode = '') {
  const root = '../../';
  const variants = product.variants || [];
  const chosen = variants.length ? (variants.find((variant) => variant.code === chosenCode) || variants.find((variant) => variant.inStock) || variants[0]) : null;
  const shown = chosen || product;
  const imageUrl = (chosen && chosen.image) || product.image;
  const image = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}">` : '<span class="no-image" aria-hidden="true"></span>';
  const group = groups.find((candidate) => candidate.slug === product.groupSlug);
  const picker = chosen ? `<form class="variant-pick" method="get" action="">
      <label>${escapeHtml(product.attributeName)}<select name="v">${variants.map((variant) => `<option value="${escapeHtml(variant.code)}"${variant === chosen ? ' selected' : ''}>${escapeHtml(variant.label)}</option>`).join('')}</select></label>
      <span class="variant-count">${variants.length} varianten</span>
      <button class="button secondary" type="submit">Kies</button>
    </form>` : '';
  const parentLink = product.parentSlug ? `<p class="note"><a href="${root}product/${escapeHtml(product.parentSlug)}/?v=${encodeURIComponent(shown.code)}">Alle uitvoeringen van ${escapeHtml(product.parentName)}</a></p>` : '';
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a>${group ? ` › <a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : ''} › <a href="${root}categorie/${escapeHtml(product.categorySlug)}/">${escapeHtml(product.categoryName)}</a> › <span>${escapeHtml(product.name)}</span></nav>
<article class="product-detail">
  <div class="product-image large">${image}</div>
  <div class="product-info">
    <h1>${escapeHtml(product.name)}</h1>
    ${picker}
    <p class="sku">Artikelnummer: ${escapeHtml(shown.code)}${chosen && chosen.meta ? ` | ${escapeHtml(chosen.meta)}` : ''}</p>
    <p class="price">${escapeHtml(formatPrice(shown.priceIncl))} <small>incl. ${shown.vatRate}% btw · per ${escapeHtml(product.unit)}</small></p>
    <p class="stock ${shown.inStock ? 'in' : 'out'}">${shown.inStock ? 'Op voorraad' : 'Niet op voorraad'}</p>
    ${activeShop.ordering ? orderForm(root, shown.code, shown.inStock, 'product-order') : '<button class="button" type="button" disabled>In winkelwagen</button>\n    <p class="note">Online bestellen volgt binnenkort.</p>'}
    ${parentLink}
  </div>
</article>`;
  return layout({ root, title: `${product.name} – ${SHOP_NAME}`, description: `${product.name} (${formatPrice(shown.priceIncl)} incl. btw) bij AquaTech Service.`, body, groups });
}

/**
 * Pagina Over ons: het verhaal van Aquatechshop.nl, overgenomen van de
 * gelijknamige pagina op aquatechshop.nl.
 * @param {object[]} groups Alle hoofdcategorieën (voor menu en voet).
 * @returns {string} De HTML-pagina.
 */
function aboutPage(groups) {
  const root = '../';
  const blocks = [
    ['over-ons-verhaal.png', 'Aquatechshop.nl', 'Aquatechshop.nl is ontstaan vanuit HVT Beregening, een gespecialiseerd bedrijf in beregenings- en watertechniek. Dankzij de ervaring in de sector kunnen wij onze klanten optimaal van dienst zijn. Korte lijnen, klanttevredenheid en efficiëntie zijn onze uitgangspunten.'],
    ['over-ons-tarieven.png', 'Scherpe tarieven', 'Wij zijn totaalleverancier voor bedrijven, particulieren en organisaties. Door de goede en veelal rechtstreekse relaties met fabrikanten en leveranciers kunnen wij bewezen materialen en techniek leveren tegen zeer scherpe prijzen. Met ons koopt u als het ware de vruchten van een goed netwerk in combinatie met vakkennis en ervaring.'],
    ['over-ons-technische-dienst.png', 'Eigen technische dienst', 'HVT Beregening is onze eigen technische dienst. Voor installatie en/of uitgebreid advies kunt u daarom ook bij ons terecht: <a href="https://www.hvtberegening.nl">www.hvtberegening.nl</a>'],
  ];
  const values = [
    ['Kwaliteit', 'Bewezen en beproefde producten'],
    ['Betrouwbaar', 'Verbeter uw werk door samen te werken met een ervaren en betrouwbare partner.'],
    ['Levering op locatie', 'Bezorging bij u op locatie, om u te ontzorgen'],
    ['Persoonlijke aandacht', 'Of je nu een professional, ondernemer of particulier bent, maatwerk vinden wij belangrijk.'],
  ];
  const body = `<section class="about-hero"><img src="${assetUrl(root, 'over-ons-hero.webp')}" alt="" width="1440" height="511"><div class="about-hero-text"><h1>Over ons</h1><p>Ons verhaal</p></div></section>
<div class="wrap">
<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>Over ons</span></nav>
<div class="about-blocks">${blocks.map(([icon, heading, text]) => `<section class="about-block"><img src="${assetUrl(root, icon)}" alt="" width="64" height="64" loading="lazy"><div><h2>${heading}</h2><p>${text}</p></div></section>`).join('')}</div>
<h2 class="centered">Waarom Aquatechshop?</h2>
<div class="about-values">${values.map(([heading, text]) => `<div class="about-value"><strong>${heading}</strong><span>${text}</span></div>`).join('')}</div>
<p class="about-claim">Kwaliteit, service en betaalbaarheid komen bij ons samen.</p>
</div>`;
  return layout({ root, groups, wide: true, title: `Over ons – ${SHOP_NAME}`, description: 'Aquatechshop.nl is ontstaan vanuit HVT Beregening: scherpe tarieven, een eigen technische dienst en levering op locatie.', body });
}

/**
 * Een vaste pagina uit Beheer (zoals Over ons): titel en tekst.
 * @param {object} page De pagina (slug, title, description, body).
 * @param {object[]} groups Alle hoofdcategorieën (voor menu en voet).
 * @param {string} root Relatief pad naar de shop-startpagina ('../' of '../../').
 * @returns {string} De HTML-pagina.
 */
function contentPage(page, groups, root) {
  const body = page.body.replace(/<img src="media:([0-9a-f-]{36})"/g, (_, id) => `<img loading="lazy" src="${root}media/${id}"`);
  const html = `<div class="wrap"><nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>${escapeHtml(page.title)}</span></nav>
<article class="cms-page"><h1>${escapeHtml(page.title)}</h1>
${body}
</article></div>`;
  return layout({ root, groups, wide: true, title: `${page.title} – ${SHOP_NAME}`, description: page.description || `${page.title} bij ${SHOP_NAME}.`, body: html });
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

module.exports = { layout, renderWith, contentPage, homePage, aboutPage, groupPage, categoryPage, searchPage, productPage, notFoundPage, escapeHtml, formatPrice };
