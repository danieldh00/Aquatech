// HTML van de eigen webshop (storefront.js): startpagina, hoofdcategorie,
// categorie, zoeken, productpagina en "niet gevonden". Server-side opgebouwd, zonder scripts.
// Alle adressen zijn relatief ten opzichte van de huidige pagina (`root` =
// '', '../' of '../../'), zodat de shop ook onder een padprefix achter een
// proxy werkt.

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

/** Pictogrammen (inline SVG, geen scripts of afbeeldingen nodig). */
const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 10.4a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L19.5 8H6"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.2-3.6 4.2-5 8-5s6.8 1.4 8 5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};

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
  const desktop = groups.map((group) => `<li class="nav-group"><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a><ul class="nav-drop">${subItems(group)}</ul></li>`).join('');
  const mobile = groups.map((group) => `<li><details><summary>${escapeHtml(group.name)}</summary><ul><li><a href="${root}groep/${escapeHtml(group.slug)}/">Alles in ${escapeHtml(group.name)}</a></li>${subItems(group)}</ul></details></li>`).join('');
  return `<nav class="shop-nav" aria-label="Productgroepen"><ul class="nav-bar">${desktop}<!--planner:${root}--></ul></nav>
<details class="shop-menu"><summary>${ICONS.menu}<span>Alle productgroepen</span></summary><ul>${mobile}<!--planner:${root}--></ul></details>`;
}

/**
 * Het kader om elke pagina: kop met logo, zoeken, winkelwagen en account,
 * menu van productgroepen, inhoud en voet.
 * @param {{ root: string, title: string, description: string, body: string, groups: object[], query?: string }} options root = relatief pad naar de shop-startpagina, title, description (meta), body (HTML), groups = hoofdcategorieën voor menu en voet en query = ingevulde zoekterm.
 * @returns {string} De volledige HTML-pagina.
 */
function layout({ root, title, description, body, groups, query = '' }) {
  const home = root || './';
  const footerGroups = groups.map((group) => `<li><a href="${root}groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a></li>`).join('');
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" type="image/png" href="${root}assets/favicon.png">
<link rel="stylesheet" href="${root}assets/brand.css">
<link rel="stylesheet" href="${root}assets/winkel.css">
</head>
<body>
<header class="shop-head">
  <div class="shop-bar">
    <a class="shop-brand" href="${home}"><img src="${root}assets/aquatechshop-logo.png" alt="Aquatechshop.nl" width="216" height="44"></a>
    <form class="shop-search" action="${root}zoeken/" method="get" role="search">
      <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Zoek op product of artikelnummer" aria-label="Zoeken" maxlength="80">
      <button type="submit" aria-label="Zoeken">${ICONS.search}</button>
    </form>
    <div class="shop-actions">
      <a class="shop-action" href="${root}account/" title="Inloggen of mijn account">${ICONS.user}<span>Account</span></a>
      <span class="shop-action cart" aria-disabled="true" title="De winkelwagen volgt binnenkort">${ICONS.cart}<span>Winkelwagen</span><b>0</b></span>
    </div>
  </div>
  ${navigation(groups, root)}
</header>
<main class="shop-main">
${body}
</main>
<footer class="shop-foot">
  <div class="foot-grid">
    <div><strong>Aquatechshop.nl</strong><p>Beregening, leidingen en pompen voor tuin en bedrijf, van AquaTech Service in Nunspeet.</p></div>
    <div><strong>Productgroepen</strong><ul>${footerGroups}</ul></div>
    <div><strong>AquaTech Service</strong><ul><li><a href="https://aquatechservice.nl">Over AquaTech Service</a></li><li><a href="${root}account/">Inloggen of registreren</a></li></ul></div>
  </div>
  <p class="foot-note">Alle prijzen zijn inclusief btw.</p>
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
  <span class="product-name">${escapeHtml(product.name)}</span>
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
 * Startpagina: hero, hoofdcategorieën met subcategorieën en uitgelichte producten.
 * @param {{ products: object[], groups: object[], featured: object[] }} catalog De catalogus.
 * @returns {string} De HTML-pagina.
 */
function homePage(catalog) {
  const root = '';
  const hero = `<section class="hero"><div><h1>Alles voor uw tuinberegening</h1><p>Sproeiers, druppelslang, leidingen en pompen van AquaTech Service.</p></div>${catalog.groups[0] ? `<a class="button" href="groep/${escapeHtml(catalog.groups[0].slug)}/">Bekijk ${escapeHtml(catalog.groups[0].name.toLowerCase())}</a>` : ''}</section>`;
  const groupCards = catalog.groups.map((group) => `<section class="group-card">
  <h3><a href="groep/${escapeHtml(group.slug)}/">${escapeHtml(group.name)}</a></h3>
  <ul>${group.categories.slice(0, HOME_SUBCATEGORIES).map((category) => `<li><a href="categorie/${escapeHtml(category.slug)}/">${escapeHtml(category.name)}</a></li>`).join('')}</ul>
  <a class="more" href="groep/${escapeHtml(group.slug)}/">Alle ${productCount(group.count)} →</a>
</section>`).join('\n');
  const featured = catalog.featured.length ? `<h2>Uitgelichte producten</h2>
<div class="product-grid">
${catalog.featured.map((product) => productCard(product, root)).join('\n')}
</div>` : '';
  const body = catalog.products.length
    ? `${hero}
<h2>Productgroepen</h2>
<div class="group-grid">
${groupCards}
</div>
${featured}`
    : '<section class="hero"><div><h1>Alles voor uw tuinberegening</h1><p>De webshop wordt gevuld. Kom snel terug.</p></div></section>';
  return layout({ root, title: `${SHOP_NAME} – alles voor uw tuinberegening`, description: 'Sproeiers, druppelslang, leidingen en pompen voor tuinberegening van AquaTech Service.', body, groups: catalog.groups });
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
    <p class="note">Online bestellen volgt binnenkort.</p>
  </div>
</article>`;
  return layout({ root, title: `${product.name} – ${SHOP_NAME}`, description: `${product.name} (${formatPrice(product.priceIncl)} incl. btw) bij AquaTech Service.`, body, groups });
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

module.exports = { layout, homePage, groupPage, categoryPage, searchPage, productPage, notFoundPage, escapeHtml, formatPrice };
