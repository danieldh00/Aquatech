// HTML voor bestellen in de eigen webshop (storefront.js): winkelwagen,
// afrekenen en de bevestiging van een bestelling. Server-side opgebouwd, zonder
// scripts; alle adressen zijn relatief aan de pagina (/winkel/<pagina>/).

const { layout, escapeHtml, formatPrice } = require('./storefront-pages');

/** Relatief pad van deze pagina's naar de shop-startpagina. */
const ROOT = '../';

/**
 * De btw-regels onder een bedrag: per tarief het bedrag excl. btw en de btw.
 * @param {{ total: number, byRate: { rate: number, excl: number, vat: number }[] }} totals De totalen.
 * @returns {string} HTML van de tabelrijen.
 */
function totalRows(totals) {
  return `${totals.byRate.map((row) => `<tr class="sub"><td colspan="3">Waarvan ${row.rate}% btw over ${escapeHtml(formatPrice(row.excl))}</td><td class="num">${escapeHtml(formatPrice(row.vat))}</td></tr>`).join('')}
<tr class="total"><th colspan="3" scope="row">Totaal incl. btw</th><td class="num">${escapeHtml(formatPrice(totals.total))}</td></tr>`;
}

/**
 * De winkelwagen met aantallen die de klant kan aanpassen.
 * @param {{ lines: object[], missing: string[], totals: object, ok: boolean }} cart De geprijsde winkelwagen (zie web-orders.js, priceCart).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function cartPage(cart, groups = []) {
  if (!cart.lines.length && !cart.missing.length) {
    return layout({ root: ROOT, title: 'Winkelwagen – Aquatechshop.nl', description: 'Je winkelwagen bij Aquatechshop.nl.', groups,
      body: `<section class="cart"><h1>Winkelwagen</h1><p>Je winkelwagen is leeg.</p><p><a class="button" href="${ROOT}">Verder winkelen</a></p></section>` });
  }
  const rows = cart.lines.map((line) => `<tr${line.enough ? '' : ' class="problem"'}>
    <td><strong>${escapeHtml(line.name)}</strong><br><small>Artikelnr.: ${escapeHtml(line.code)}</small>${line.enough ? '' : `<br><small class="stock out">${line.available > 0 ? `Nog maar ${escapeHtml(String(line.available))} beschikbaar` : 'Niet meer op voorraad'}</small>`}</td>
    <td class="num">${escapeHtml(formatPrice(line.unitIncl))}</td>
    <td><form class="cart-qty" method="post" action="./"><input type="hidden" name="action" value="set"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><input type="number" name="qty" value="${line.qty}" min="0" max="99" aria-label="Aantal ${escapeHtml(line.name)}"><button class="button secondary" type="submit">Wijzig</button></form></td>
    <td class="num">${escapeHtml(formatPrice(line.lineTotal))}</td>
    <td><form method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><button class="button secondary" type="submit" aria-label="Verwijder ${escapeHtml(line.name)}">Verwijder</button></form></td>
  </tr>`).join('');
  const missing = cart.missing.length ? `<div class="form-error" role="alert"><p>Niet meer te koop: ${cart.missing.map(escapeHtml).join(', ')}.</p>${cart.missing.map((code) => `<form class="inline" method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(code)}"><button class="button secondary" type="submit">Verwijder ${escapeHtml(code)}</button></form>`).join('')}</div>` : '';
  const body = `<section class="cart"><h1>Winkelwagen</h1>
${missing}
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Prijs</th><th>Aantal</th><th class="num">Totaal</th><th></th></tr></thead>
<tbody>${rows}</tbody><tfoot>${totalRows(cart.totals)}</tfoot></table></div>
<p class="note">Verzendkosten zijn nog niet in dit bedrag opgenomen. Betalen kan op rekening.</p>
<div class="cart-actions"><a class="button secondary" href="${ROOT}">Verder winkelen</a>
${cart.ok ? `<a class="button" href="${ROOT}afrekenen/">Naar afrekenen</a>` : '<span class="note">Pas eerst je winkelwagen aan om af te rekenen.</span>'}</div>
</section>`;
  return layout({ root: ROOT, title: 'Winkelwagen – Aquatechshop.nl', description: 'Je winkelwagen bij Aquatechshop.nl.', body, groups });
}

/**
 * Een invoerveld met label voor het afrekenformulier.
 * @param {{ name: string, label: string, value: string, autocomplete: string, required?: boolean, type?: string }} field Het veld.
 * @returns {string} HTML.
 */
function checkoutField({ name, label, value, autocomplete, required = true, type = 'text' }) {
  return `<label class="form-field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${required ? ' required' : ''}></label>`;
}

/**
 * De pagina Afrekenen: gegevens van de klant, het afleveradres en een overzicht van de bestelling.
 * @param {{ cart: object, values?: object, error?: string, viewer: { displayName: string, email: string } }} state De geprijsde winkelwagen, eerder ingevulde waarden, een foutmelding en de ingelogde klant.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function checkoutPage({ cart, values = {}, error = '', viewer }, groups = []) {
  const value = { name: viewer.displayName, email: viewer.email, ...values };
  const summary = cart.lines.map((line) => `<li><span>${line.qty} × ${escapeHtml(line.name)}</span><span>${escapeHtml(formatPrice(line.lineTotal))}</span></li>`).join('');
  const body = `<section class="cart checkout"><h1>Afrekenen</h1>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="checkout-grid">
<form method="post" action="./" class="account-form">
<h2>Je gegevens</h2>
${checkoutField({ name: 'name', label: 'Naam', value: value.name || '', autocomplete: 'name' })}
${checkoutField({ name: 'company', label: 'Bedrijfsnaam (optioneel)', value: value.company || '', autocomplete: 'organization', required: false })}
${checkoutField({ name: 'email', label: 'E-mailadres', value: value.email || '', autocomplete: 'email', type: 'email' })}
${checkoutField({ name: 'phone', label: 'Telefoon (optioneel)', value: value.phone || '', autocomplete: 'tel', required: false, type: 'tel' })}
<h2>Afleveradres</h2>
${checkoutField({ name: 'street', label: 'Straat en huisnummer', value: value.street || '', autocomplete: 'street-address' })}
${checkoutField({ name: 'postcode', label: 'Postcode', value: value.postcode || '', autocomplete: 'postal-code' })}
${checkoutField({ name: 'city', label: 'Woonplaats', value: value.city || '', autocomplete: 'address-level2' })}
<label class="form-field"><span>Opmerking (optioneel)</span><textarea name="note" rows="3" maxlength="500">${escapeHtml(value.note || '')}</textarea></label>
<p class="note">Je bestelling gaat op rekening: je ontvangt de factuur van ons. Alleen aflevering in Nederland.</p>
<button class="button" type="submit">Bestelling plaatsen</button>
</form>
<aside class="checkout-summary"><h2>Je bestelling</h2><ul>${summary}</ul>
<p class="checkout-total"><span>Totaal incl. btw</span><strong>${escapeHtml(formatPrice(cart.totals.total))}</strong></p>
<p><a href="${ROOT}winkelwagen/">Winkelwagen aanpassen</a></p></aside>
</div></section>`;
  return layout({ root: ROOT, title: 'Afrekenen – Aquatechshop.nl', description: 'Reken je bestelling af bij Aquatechshop.nl.', body, groups });
}

/**
 * Afrekenen zonder account: uitleg met links om in te loggen of te registreren, waarna de klant terugkomt bij het afrekenen.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function checkoutLoginPage(groups = []) {
  const body = `<section class="account-card"><h1>Afrekenen</h1>
<p>Log in of maak een account om je bestelling af te ronden. Je winkelwagen blijft bewaard.</p>
<div class="account-actions"><a class="button" href="${ROOT}inloggen/?volgende=afrekenen">Inloggen</a><a class="button secondary" href="${ROOT}registreren/?volgende=afrekenen">Account maken</a></div>
</section>`;
  return layout({ root: ROOT, title: 'Afrekenen – Aquatechshop.nl', description: 'Log in om af te rekenen bij Aquatechshop.nl.', body, groups });
}

/**
 * De bevestiging van een geplaatste bestelling.
 * @param {object} order De bestelling (met regels, adres en totalen).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function orderPage(order, groups = []) {
  const rows = order.lines.map((line) => `<tr><td>${escapeHtml(line.name)}<br><small>Artikelnr.: ${escapeHtml(line.code)}</small></td><td class="num">${escapeHtml(formatPrice(line.unitIncl))}</td><td class="num">${line.qty}</td><td class="num">${escapeHtml(formatPrice(line.lineTotal))}</td></tr>`).join('');
  const body = `<section class="cart"><h1>Bedankt voor je bestelling</h1>
<p>Je bestelling <strong>${escapeHtml(order.number)}</strong> is ontvangen. We sturen een bevestiging naar ${escapeHtml(order.email)}. Je bestelling gaat op rekening: je ontvangt de factuur van ons.</p>
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Prijs</th><th class="num">Aantal</th><th class="num">Totaal</th></tr></thead>
<tbody>${rows}</tbody><tfoot>${totalRows(order.totals)}</tfoot></table></div>
<p><strong>Afleveradres</strong><br>${[order.customer.company, order.customer.name, order.address.street, `${order.address.postcode} ${order.address.city}`].filter(Boolean).map(escapeHtml).join('<br>')}</p>
<p>Status: <strong>${escapeHtml(order.statusLabel)}</strong></p>
<p><a class="button" href="${ROOT}">Verder winkelen</a></p></section>`;
  return layout({ root: ROOT, title: `Bestelling ${order.number} – Aquatechshop.nl`, description: 'Je bestelling bij Aquatechshop.nl.', body, groups });
}

module.exports = { cartPage, checkoutPage, checkoutLoginPage, orderPage };
