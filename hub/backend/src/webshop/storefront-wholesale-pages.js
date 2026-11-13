// HTML van het groothandelsvenster van de eigen webshop (storefront.js,
// /groothandel/): voor groothandelsklanten een snelbestellijst met alle
// artikelen en varianten (een aantal per regel, één knop voor de hele lijst), een
// vak om artikelcodes met aantallen te plakken (bijvoorbeeld uit Excel) en de
// laatste bestellingen om opnieuw te bestellen. Server-side opgebouwd; het script
// groothandel.js filtert de lijst en rondt aantallen af, zonder script werkt alles ook.

const { layout, escapeHtml, formatPrice } = require('./storefront-pages');
const Wholesale = require('./wholesale');

/** Relatief pad van deze pagina (/groothandel/) naar de shop-startpagina. */
const ROOT = '../';

/**
 * Vergelijkt twee regels van de lijst op naam, bij gelijke naam op artikelcode.
 * @param {{ name: string, code: string }} left De eerste regel.
 * @param {{ name: string, code: string }} right De tweede regel.
 * @returns {number} Negatief, nul of positief.
 */
function compareRows(left, right) {
  return String(left.name).localeCompare(String(right.name), 'nl', { numeric: true }) || String(left.code).localeCompare(String(right.code), 'nl');
}

/**
 * Alle bestelbare artikelen voor de lijst: losse artikelen en elke variant apart (een hoofdartikel zelf is niet te bestellen).
 * @param {{ products: object[], variantProducts: object[] }} catalog De catalogus (storefront-data.js).
 * @returns {object[]} De artikelen op naam.
 */
function orderableProducts(catalog) {
  return [...catalog.products.filter((product) => !product.variants), ...catalog.variantProducts].sort(compareRows);
}

/**
 * De voorwaarden van een artikel in een korte tekst ("per 25, min. 50").
 * @param {{ packSize: number, minimum: number }} product Het artikel.
 * @returns {string} De tekst, leeg zonder bijzondere voorwaarden.
 */
function termsText(product) {
  const parts = [];
  if (product.packSize > 1) parts.push(`per ${product.packSize}`);
  if (product.minimum > 1) parts.push(`min. ${product.minimum}`);
  return parts.join(', ');
}

/**
 * De prijskolom van een regel: de prijs excl. btw bij de kleinste afname en de staffels eronder.
 * @param {object} product Het artikel (priceBusinessList = de zakelijke prijs vóór de categoriekorting, categoryDiscountPct, minimum, tiers, unit).
 * @param {number} customerDiscount De vaste korting (%) van de klant.
 * @returns {string} HTML van de cel.
 */
function priceCell(product, customerDiscount) {
  const first = Wholesale.wholesalePrice(product.priceBusinessList, product.minimum, product.tiers, customerDiscount, product.categoryDiscountPct);
  const tiers = product.tiers.filter((tier) => tier.minQty > product.minimum).map((tier) => {
    const priced = Wholesale.wholesalePrice(product.priceBusinessList, tier.minQty, product.tiers, customerDiscount, product.categoryDiscountPct);
    return `<small class="tier">vanaf ${tier.minQty}: ${escapeHtml(formatPrice(priced.unitExcl))}</small>`;
  }).join('');
  return `<strong>${escapeHtml(formatPrice(first.unitExcl))}</strong> <small class="muted">per ${escapeHtml(product.unit)}</small>${tiers}`;
}

/**
 * Eén regel van de snelbestellijst.
 * @param {object} product Het artikel uit de catalogus.
 * @param {number} customerDiscount De vaste korting (%) van de klant.
 * @returns {string} HTML van de tabelrij.
 */
function listRow(product, customerDiscount) {
  const terms = termsText(product);
  const meta = product.values ? Object.entries(product.values).map(([name, value]) => `${name}: ${value}`).join(' | ') : '';
  const search = `${product.code} ${product.name} ${product.categoryName || ''}`.toLowerCase();
  return `<tr data-wholesale-row data-search="${escapeHtml(search)}" data-category="${escapeHtml(product.categorySlug)}">
<td><strong>${escapeHtml(product.name)}</strong><br><small class="muted">Artikelnr.: ${escapeHtml(product.code)}${meta ? ` · ${escapeHtml(meta)}` : ''}</small></td>
<td class="num">${priceCell(product, customerDiscount)}</td>
<td>${terms ? escapeHtml(terms) : '<span class="muted">–</span>'}</td>
<td><span class="stock ${product.inStock ? 'in' : 'out'}">${product.inStock ? 'Op voorraad' : 'Niet op voorraad'}</span></td>
<td><input type="number" name="q:${escapeHtml(product.code)}" min="0" max="9999" inputmode="numeric" data-wholesale-qty data-pack="${product.packSize}" data-minimum="${product.minimum}" aria-label="Aantal ${escapeHtml(product.name)}"></td>
</tr>`;
}

/**
 * De melding bovenaan na het toevoegen van een lijst: wat er in de winkelwagen kwam, wat is aangepast en wat niet gelukt is.
 * @param {?{ added: number, adjusted: { code: string, from: number, to: number, reason: string }[], problems: { text: string, message: string }[], skipped: string[] }} notice De uitkomst, of niets.
 * @returns {string} HTML, leeg zonder melding.
 */
function noticeBlock(notice) {
  if (!notice) return '';
  const adjusted = notice.adjusted.length ? `<p>Aantal aangepast aan de verpakkingseenheid of minimale afname:</p><ul>${notice.adjusted.map((entry) => `<li>${escapeHtml(entry.code)}: ${entry.from} → ${entry.to} (${escapeHtml(entry.reason)})</li>`).join('')}</ul>` : '';
  const problems = notice.problems.length ? `<p>Niet toegevoegd:</p><ul>${notice.problems.map((problem) => `<li>${escapeHtml(problem.text)}: ${escapeHtml(problem.message)}</li>`).join('')}</ul>` : '';
  const skipped = notice.skipped.length ? `<p>Je winkelwagen is vol; deze artikelen pasten er niet meer bij: ${notice.skipped.map(escapeHtml).join(', ')}. Plaats eerst deze bestelling en bestel de rest daarna.</p>` : '';
  const headline = notice.added > 0
    ? `<p><strong>${notice.added} ${notice.added === 1 ? 'artikel' : 'artikelen'} in je winkelwagen.</strong> <a href="${ROOT}winkelwagen/">Naar je winkelwagen</a></p>`
    : '<p><strong>Er is niets aan je winkelwagen toegevoegd.</strong></p>';
  return `<div class="wholesale-notice${notice.problems.length || notice.skipped.length || !notice.added ? ' warn' : ''}" role="status">${headline}${adjusted}${problems}${skipped}</div>`;
}

/**
 * De laatste bestellingen met een knop om ze opnieuw te bestellen.
 * @param {{ id: string, number: string, createdAt: string, total: number }[]} recent De laatste bestellingen van de klant.
 * @returns {string} HTML van het onderdeel, leeg zonder bestellingen.
 */
function reorderBlock(recent) {
  if (!recent.length) return '';
  const rows = recent.map((order) => `<tr><td><a href="${ROOT}bestelling/${escapeHtml(order.id)}/">${escapeHtml(order.number)}</a></td><td>${escapeHtml(String(order.createdAt).slice(0, 10).split('-').reverse().join('-'))}</td><td class="num">${escapeHtml(formatPrice(order.total))}</td>
<td><form method="post" action="./"><input type="hidden" name="action" value="opnieuw"><input type="hidden" name="orderId" value="${escapeHtml(order.id)}"><button class="button secondary" type="submit">Opnieuw bestellen</button></form></td></tr>`).join('');
  return `<section class="wholesale-block"><h2>Eerder besteld</h2>
<p class="muted">Zet alle artikelen van een eerdere bestelling met één klik in je winkelwagen. De prijzen en de voorraad van nu gelden.</p>
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Bestelling</th><th>Datum</th><th class="num">Totaal</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/**
 * Het groothandelsvenster.
 * @param {{ catalog: object, viewer: { displayName: string, wholesaleDiscount: number }, recent: object[], notice?: ?object, pasted?: string }} options catalog = de catalogus (storefront-data.js), viewer = de groothandelsklant, recent = zijn laatste bestellingen, notice = de uitkomst van een eerdere actie en pasted = de eerder geplakte tekst (blijft staan bij een fout).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function wholesalePage({ catalog, viewer, recent, notice = null, pasted = '' }, groups = []) {
  const discount = viewer.wholesaleDiscount || 0;
  const products = orderableProducts(catalog);
  const options = catalog.categories.map((category) => `<option value="${escapeHtml(category.slug)}">${escapeHtml(category.name)}</option>`).join('');
  const rows = products.map((product) => listRow(product, discount)).join('\n');
  const body = `<section class="wholesale"><h1>Groothandel</h1>
<p class="note">Je ziet je groothandelsprijzen, alle bedragen zijn exclusief btw.${discount > 0 ? ` Je hebt een vaste korting van ${escapeHtml(String(discount))}%; bij een staffelkorting geldt steeds de hoogste van de twee.` : ''} Artikelen kunnen een verpakkingseenheid of minimale afname hebben: een aantal dat daar niet bij past, ronden we naar boven af.</p>
${noticeBlock(notice)}
<section class="wholesale-block"><h2>Bestellen op artikelcode</h2>
<form method="post" action="./" class="wholesale-paste">
<input type="hidden" name="action" value="plakken">
<label for="wholesale-list">Plak een lijst met per regel een artikelcode en een aantal, bijvoorbeeld uit Excel (kolom A de code, kolom B het aantal).</label>
<textarea id="wholesale-list" name="lijst" rows="6" maxlength="20000" placeholder="SP-100&#9;50&#10;DR-16-25&#9;200" required>${escapeHtml(pasted)}</textarea>
<p><button class="button" type="submit">Toevoegen aan winkelwagen</button></p>
</form></section>
${reorderBlock(recent)}
<section class="wholesale-block"><h2>Snelbestellijst</h2>
<form method="post" action="./" class="wholesale-list" data-wholesale-form>
<input type="hidden" name="action" value="bestellen">
<div class="wholesale-toolbar">
<label class="form-field"><span>Zoeken</span><input type="search" data-wholesale-search placeholder="Naam of artikelnummer" autocomplete="off"></label>
<label class="form-field"><span>Categorie</span><select data-wholesale-category><option value="">Alle categorieën</option>${options}</select></label>
</div>
<div class="tablewrap"><table class="cart-table wholesale-table"><thead><tr><th>Artikel</th><th class="num">Prijs excl. btw</th><th>Afname</th><th>Voorraad</th><th>Aantal</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="muted" data-wholesale-empty hidden>Geen artikelen gevonden.</p>
<div class="wholesale-bar"><span data-wholesale-summary>Vul bij de artikelen een aantal in.</span><button class="button" type="submit">Alles in winkelwagen</button></div>
</form></section>
</section>`;
  return layout({ root: ROOT, title: 'Groothandel – Aquatechshop.nl', description: 'Bestel in bulk bij Aquatechshop.nl.', body, groups, script: 'groothandel.js' });
}

module.exports = { wholesalePage, orderableProducts };
