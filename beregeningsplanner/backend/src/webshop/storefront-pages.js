// HTML van de eigen webshop (storefront.js): startpagina, categorie,
// productpagina en "niet gevonden". Server-side opgebouwd, zonder scripts.
// Alle adressen zijn relatief ten opzichte van de huidige pagina (`root` =
// '', '../' of '../../'), zodat de shop ook onder een padprefix achter een
// proxy werkt.

const SHOP_NAME = 'AquaTech Shop';
const MAX_HOME_PRODUCTS = 8;

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

/**
 * Het kader om elke pagina: kop met logo en navigatie, inhoud en voet.
 * @param {{ root: string, title: string, description: string, body: string }} options root = relatief pad naar de shop-startpagina, title, description (meta) en body (HTML).
 * @returns {string} De volledige HTML-pagina.
 */
function layout({ root, title, description, body }) {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="${root}assets/brand.css">
<link rel="stylesheet" href="${root}assets/winkel.css">
</head>
<body>
<header class="shop-head">
  <a class="shop-brand" href="${root || './'}"><img src="${root}assets/logo-white.png" alt="AquaTech Service"><span>Shop</span></a>
</header>
<main class="shop-main">
${body}
</main>
<footer class="shop-foot">AquaTech Service · Prijzen zijn inclusief btw.</footer>
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
 * Startpagina: categorieën en een selectie producten.
 * @param {{ products: object[], categories: object[] }} catalog De catalogus.
 * @returns {string} De HTML-pagina.
 */
function homePage(catalog) {
  const root = '';
  const categoryTiles = catalog.categories.map((category) => `<a class="category-tile" href="categorie/${escapeHtml(category.slug)}/"><strong>${escapeHtml(category.name)}</strong><span>${category.count} ${category.count === 1 ? 'product' : 'producten'}</span></a>`).join('\n');
  const featured = catalog.products.slice(0, MAX_HOME_PRODUCTS).map((product) => productCard(product, root)).join('\n');
  const body = catalog.products.length
    ? `<section class="hero"><h1>Beregening voor uw tuin</h1><p>Sproeiers, leidingen, druppelslang en alles om uw tuinberegening aan te leggen.</p></section>
<h2>Categorieën</h2>
<div class="category-grid">
${categoryTiles}
</div>
<h2>Producten</h2>
<div class="product-grid">
${featured}
</div>`
    : '<section class="hero"><h1>Beregening voor uw tuin</h1><p>De webshop wordt gevuld. Kom snel terug.</p></section>';
  return layout({ root, title: `${SHOP_NAME} – beregening voor uw tuin`, description: 'Sproeiers, leidingen, druppelslang en alles voor tuinberegening van AquaTech Service.', body });
}

/**
 * Categoriepagina: alle producten van één categorie.
 * @param {object} category De categorie (slug, name, count).
 * @param {object[]} products De producten in die categorie.
 * @returns {string} De HTML-pagina.
 */
function categoryPage(category, products) {
  const root = '../../';
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <span>${escapeHtml(category.name)}</span></nav>
<h1>${escapeHtml(category.name)}</h1>
<div class="product-grid">
${products.map((product) => productCard(product, root)).join('\n')}
</div>`;
  return layout({ root, title: `${category.name} – ${SHOP_NAME}`, description: `${category.name} van AquaTech Service: ${category.count} ${category.count === 1 ? 'product' : 'producten'}.`, body });
}

/**
 * Productpagina: afbeelding, naam, artikelnummer, prijs en voorraadstand.
 * @param {object} product Het product uit de catalogus.
 * @returns {string} De HTML-pagina.
 */
function productPage(product) {
  const root = '../../';
  const image = product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">` : '<span class="no-image" aria-hidden="true"></span>';
  const body = `<nav class="crumbs" aria-label="Kruimelpad"><a href="${root}">Shop</a> › <a href="${root}categorie/${escapeHtml(product.categorySlug)}/">${escapeHtml(product.categoryName)}</a> › <span>${escapeHtml(product.name)}</span></nav>
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
  return layout({ root, title: `${product.name} – ${SHOP_NAME}`, description: `${product.name} (${formatPrice(product.priceIncl)} incl. btw) bij AquaTech Service.`, body });
}

/**
 * Pagina voor een onbekende categorie of product.
 * @param {string} root Relatief pad naar de shop-startpagina.
 * @returns {string} De HTML-pagina.
 */
function notFoundPage(root) {
  return layout({ root, title: `Pagina niet gevonden – ${SHOP_NAME}`, description: 'Deze pagina bestaat niet.', body: `<h1>Pagina niet gevonden</h1><p><a href="${root || './'}">Terug naar de shop</a></p>` });
}

module.exports = { homePage, categoryPage, productPage, notFoundPage, escapeHtml, formatPrice };
