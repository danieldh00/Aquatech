// HTML van de eigen webshop (storefront.js): startpagina, hoofdcategorie,
// categorie, zoeken, productpagina en "niet gevonden". Server-side opgebouwd, zonder scripts.
// Alle adressen zijn relatief ten opzichte van de huidige pagina (`root` =
// '', '../' of '../../'), zodat de shop ook onder een padprefix achter een
// proxy werkt.

const { version: SHOP_VERSION } = require('../../package.json');

const SHOP_NAME = 'Aquatechshop.nl';
/** Contactgegevens zoals op aquatechshop.nl. */
const PHONE = '06 47212019';
const PHONE_LINK = 'tel:+31647212019';
const EMAIL = 'info@aquatechshop.nl';
/** Merken op de startpagina: bestand in assets/ en naam (alt-tekst). */
const BRANDS = [
  ['merk-ebara.png', 'Ebara'], ['merk-metzerplas.jpg', 'Metzerplas'], ['merk-grundfos.jpg', 'Grundfos'],
  ['merk-rainbird.png', 'Rain Bird'], ['merk-dab.webp', 'DAB'], ['merk-pedrollo.webp', 'Pedrollo'],
];
/** Voordelen onder de producten op de startpagina: pictogram, kop en tekst. */
const BENEFITS = [
  ['usp-assortiment.png', 'Zeer compleet assortiment', 'Direct alles voor jouw project in huis'],
  ['usp-bezorgd.png', 'Bezorgd op iedere locatie', 'Jouw producten op locatie bezorgd'],
  ['usp-prijzen.png', 'Scherpe zakelijke prijzen', 'Vraag jouw zakelijk account aan'],
];
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
  const about = `<li class="nav-about"><a href="${root}over-ons/">Over ons</a></li>`;
  const desktop = groups.map((group) => `<li class="nav-group"><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a><ul class="nav-drop">${subItems(group)}</ul></li>`).join('');
  const mobile = groups.map((group) => `<li><details><summary>${escapeHtml(group.name)}</summary><ul><li><a href="${root}groep/${escapeHtml(group.slug)}/">Alles in ${escapeHtml(group.name)}</a></li>${subItems(group)}</ul></details></li>`).join('');
  return `<nav class="shop-nav" aria-label="Productgroepen"><ul class="nav-bar">${search}${about}${desktop}<!--planner:${root}--></ul></nav>
<details class="shop-menu"><summary>${ICONS.menu}<span>Alle productgroepen</span></summary><ul>${mobile}<!--planner:${root}--></ul></details>`;
}

/**
 * Het kader om elke pagina: kop met logo, zoeken, winkelwagen en account,
 * menu van productgroepen, inhoud en voet.
 * @param {{ root: string, title: string, description: string, body: string, groups: object[], query?: string, wide?: boolean }} options root = relatief pad naar de shop-startpagina, title, description (meta), body (HTML), groups = hoofdcategorieën voor menu en voet en query = ingevulde zoekterm en wide = de inhoud over de volle breedte (startpagina).
 * @returns {string} De volledige HTML-pagina.
 */
function layout({ root, title, description, body, groups, query = '', wide = false }) {
  const home = root || './';
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
</head>
<body>
<div class="shop-notice">Welkom op onze webshop! Momenteel zijn wij nog volop producten aan het toevoegen. Mocht er wat ontbreken wat u zoekt, neem contact op!</div>
<header class="shop-head">
  <div class="shop-bar">
    <a class="shop-brand" href="${home}"><img src="${assetUrl(root, 'aquatechshop-logo.png')}" alt="Aquatechshop.nl" width="216" height="44"></a>
    <form class="shop-search" action="${root}zoeken/" method="get" role="search">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Zoek op product of artikelnummer" aria-label="Zoeken" maxlength="80">
      <button type="submit" aria-label="Zoeken">${ICONS.search}</button>
    </form>
    <a class="shop-phone" href="${PHONE_LINK}" aria-label="Klantenservice ${PHONE}">${ICONS.phone}<span><small>Klantenservice</small><strong>${PHONE}</strong></span></a>
    <div class="shop-actions">
      <a class="shop-action" href="${root}account/" title="Inloggen of mijn account">${ICONS.user}<span>Account</span></a>
      <span class="shop-action cart" aria-disabled="true" title="De winkelwagen volgt binnenkort">${ICONS.cart}<span>Winkelwagen</span><b>0</b></span>
    </div>
  </div>
  ${navigation(groups, root)}
</header>
<main class="shop-main${wide ? ' wide' : ''}">
${body}
</main>
<footer class="shop-foot">
  <div class="foot-grid">
    <div><strong>Aquatechshop.nl</strong><p>K.v.k.: 88438252<br>Oenenburgweg 218, 8072 GP Nunspeet<br><a href="mailto:${EMAIL}">${EMAIL}</a><br><a href="${PHONE_LINK}">${PHONE}</a></p></div>
    <div><strong>Productgroepen</strong><ul>${footerGroups}</ul></div>
    <div><strong>Account</strong><ul><li><a href="${root}account/">Mijn account</a></li><li><a href="${root}account/">Inloggen of registreren</a></li></ul></div>
    <div><strong>Over ons</strong><p>Beregening, leidingen en pompen voor tuin en bedrijf, van AquaTech Service in Nunspeet.</p><p><a href="${root}over-ons/">Lees ons verhaal</a></p></div>
  </div>
  <div class="foot-note"><span>Alle prijzen zijn inclusief btw.</span><img src="${assetUrl(root, 'betaalmethoden.png')}" alt="Betaalmethoden" width="286" height="26" loading="lazy"></div>
</footer>
</body>
</html>
`;
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
  <span class="product-price">${escapeHtml(formatPrice(product.priceIncl))}</span>
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
  return `<a class="product-row" href="${root}product/${escapeHtml(product.slug)}/"><span class="product-image"><img src="${escapeHtml(product.image)}" alt="" loading="lazy"></span><span class="product-row-text"><span class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span><span class="product-price">${escapeHtml(formatPrice(product.priceIncl))}</span><span class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</span></span></a>`;
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
  const intro = `<section class="home-hero"><img src="${assetUrl(root, 'hero-tuin.jpg')}" alt="" width="1440" height="419"><div class="home-hero-text"><h1>Alles voor uw tuinberegening</h1><p>Sproeiers, druppelslang, leidingen en pompen van AquaTech Service.</p>${first ? `<a class="button" href="groep/${escapeHtml(first.slug)}/">Bekijk ${escapeHtml(first.name.toLowerCase())}</a>` : ''}</div></section>`;
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
  const benefits = `<section class="benefits"><div class="wrap benefits-inner">${BENEFITS.map(([icon, heading, text]) => `<div class="benefit"><img src="${assetUrl(root, icon)}" alt="" width="50" height="50" loading="lazy"><div><strong>${heading}</strong><span>${text}</span></div></div>`).join('')}</div></section>`;
  const brands = `<section class="wrap"><h2 class="centered">Onze merken</h2><div class="brands">${BRANDS.map(([file, name]) => `<img src="${assetUrl(root, file)}" alt="${name}" height="70" loading="lazy">`).join('')}</div></section>`;
  const business = `<section class="business"><img src="${assetUrl(root, 'zakelijk-achtergrond.jpg')}" alt="" loading="lazy"><div class="business-text"><h2>Vraag direct een zakelijk account aan</h2><p>Ervaar de scherpe prijzen en het complete assortiment van Aquatechshop.nl.</p><a class="button" href="${root}registreren/">Account aanmaken</a></div></section>`;
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
 * Categoriepagina: alle producten van één categorie.
 * @param {object} category De categorie (slug, name, count, groupSlug).
 * @param {object[]} products De producten in die categorie.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function categoryPage(category, products, groups) {
  const root = '../../';
  const group = groups.find((candidate) => candidate.slug === category.groupSlug);
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a>${group ? ` › <a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : ''} › <span>${escapeHtml(category.name)}</span></nav>
<h1>${escapeHtml(category.name)}</h1>
<div class="product-grid">
${products.map((product) => productCard(product, root)).join('\n')}
</div>`;
  return layout({ root, title: `${category.name} – ${SHOP_NAME}`, description: `${category.name} van AquaTech Service: ${productCount(category.count)}.`, body, groups });
}

/**
 * Zoekpagina: producten waarvan naam of artikelnummer de zoekterm bevat.
 * @param {string} query De zoekterm.
 * @param {object[]} products De producten die passen (al gefilterd).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function searchPage(query, products, groups) {
  const root = '../';
  const shown = products.slice(0, MAX_SEARCH_RESULTS);
  const body = `<h1>Zoeken</h1>
${query ? `<p class="muted">${productCount(products.length)} voor “${escapeHtml(query)}”${products.length > shown.length ? ` (de eerste ${shown.length} getoond)` : ''}.</p>` : '<p class="muted">Typ een productnaam of artikelnummer.</p>'}
<div class="product-grid">
${shown.map((product) => productCard(product, root)).join('\n')}
</div>`;
  return layout({ root, title: `Zoeken – ${SHOP_NAME}`, description: 'Zoek een product in de webshop van AquaTech Service.', body, groups, query });
}

/**
 * Productpagina: afbeelding, naam, artikelnummer, prijs en voorraadstand.
 * @param {object} product Het product uit de catalogus.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function productPage(product, groups) {
  const root = '../../';
  const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">` : '<span class="no-image" aria-hidden="true"></span>';
  const group = groups.find((candidate) => candidate.slug === product.groupSlug);
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a>${group ? ` › <a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a>` : ''} › <a href="${root}categorie/${escapeHtml(product.categorySlug)}/">${escapeHtml(product.categoryName)}</a> › <span>${escapeHtml(product.name)}</span></nav>
<article class="product-detail">
  <div class="product-image large">${image}</div>
  <div class="product-info">
    <h1>${escapeHtml(product.name)}</h1>
    <p class="sku">Artikelnummer: ${escapeHtml(product.code)}</p>
    <p class="price">${escapeHtml(formatPrice(product.priceIncl))} <small>incl. ${product.vatRate}% btw · per ${escapeHtml(product.unit)}</small></p>
    <p class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</p>
    <button class="button" type="button" disabled>In winkelwagen</button>
    <p class="note">Online bestellen volgt binnenkort.</p>
  </div>
</article>`;
  return layout({ root, title: `${product.name} – ${SHOP_NAME}`, description: `${product.name} (${formatPrice(product.priceIncl)} incl. btw) bij AquaTech Service.`, body, groups });
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
 * Pagina voor een onbekende categorie of product.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function notFoundPage(root, groups) {
  return layout({ root, groups, title: `Pagina niet gevonden – ${SHOP_NAME}`, description: 'Deze pagina bestaat niet.', body: `<h1>Pagina niet gevonden</h1><p><a href="${root || './'}">Terug naar de shop</a></p>` });
}

module.exports = { layout, homePage, aboutPage, groupPage, categoryPage, searchPage, productPage, notFoundPage, escapeHtml, formatPrice };
