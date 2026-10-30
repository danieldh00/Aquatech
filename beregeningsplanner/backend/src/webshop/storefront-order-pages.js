// HTML voor bestellen in de eigen webshop (storefront.js): winkelwagen,
// afrekenen en de bevestiging van een bestelling. Server-side opgebouwd, zonder
// scripts; alle adressen zijn relatief aan de pagina (/winkel/<pagina>/).

const { layout, escapeHtml, formatPrice } = require('./storefront-pages');

/** Relatief pad van deze pagina's naar de shop-startpagina. */
const ROOT = '../';
/** Relatief pad van het besteldetail (/winkel/bestelling/<id>/) naar de shop-startpagina. */
const DETAIL_ROOT = '../../';
/** Namen van de bestelstatussen voor het verloop (web-orders.js, STATUSES). */
const STATUS_LABELS = { nieuw: 'Nieuw', verzonden: 'Verzonden', afgerond: 'Afgerond', geannuleerd: 'Geannuleerd' };

/**
 * De btw-regels onder een bedrag: per tarief het bedrag excl. btw en de btw.
 * @param {{ total: number, byRate: { rate: number, excl: number, vat: number }[] }} totals De totalen.
 * @param {boolean} [excl] true voor een zakelijke klant: eerst het totaal excl. btw, dan de btw per tarief.
 * @param {boolean} [shifted] true als de btw is verlegd: het totaal is dan excl. btw en krijgt dat label.
 * @returns {string} HTML van de tabelrijen.
 */
function totalRows(totals, excl = false, shifted = false) {
  if (excl) {
    const subtotal = totals.byRate.reduce((sum, row) => sum + row.excl, 0);
    return `<tr class="sub"><th colspan="3" scope="row">Totaal excl. btw</th><td class="num">${escapeHtml(formatPrice(subtotal))}</td></tr>
${totals.byRate.filter((row) => row.rate > 0).map((row) => `<tr class="sub"><td colspan="3">Btw ${row.rate}% over ${escapeHtml(formatPrice(row.excl))}</td><td class="num">${escapeHtml(formatPrice(row.vat))}</td></tr>`).join('')}
<tr class="total"><th colspan="3" scope="row">${shifted ? 'Totaal (btw verlegd)' : 'Totaal incl. btw'}</th><td class="num">${escapeHtml(formatPrice(totals.total))}</td></tr>`;
  }
  return `${totals.byRate.map((row) => `<tr class="sub"><td colspan="3">Waarvan ${row.rate}% btw over ${escapeHtml(formatPrice(row.excl))}</td><td class="num">${escapeHtml(formatPrice(row.vat))}</td></tr>`).join('')}
<tr class="total"><th colspan="3" scope="row">${shifted ? 'Totaal (btw verlegd)' : 'Totaal incl. btw'}</th><td class="num">${escapeHtml(formatPrice(totals.total))}</td></tr>`;
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
    <td class="num">${escapeHtml(formatPrice(cart.pricesExcl ? line.unitExcl : line.unitIncl))}</td>
    <td><form class="cart-qty" method="post" action="./"><input type="hidden" name="action" value="set"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><input type="number" name="qty" value="${line.qty}" min="0" max="99" aria-label="Aantal ${escapeHtml(line.name)}"><button class="button secondary" type="submit">Wijzig</button></form></td>
    <td class="num">${escapeHtml(formatPrice(cart.pricesExcl ? line.lineExcl : line.lineTotal))}</td>
    <td><form method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><button class="button secondary" type="submit" aria-label="Verwijder ${escapeHtml(line.name)}">Verwijder</button></form></td>
  </tr>`).join('');
  const missing = cart.missing.length ? `<div class="form-error" role="alert"><p>Niet meer te koop: ${cart.missing.map(escapeHtml).join(', ')}.</p>${cart.missing.map((code) => `<form class="inline" method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(code)}"><button class="button secondary" type="submit">Verwijder ${escapeHtml(code)}</button></form>`).join('')}</div>` : '';
  const body = `<section class="cart"><h1>Winkelwagen</h1>
${missing}
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Prijs${cart.pricesExcl ? ' excl. btw' : ''}</th><th>Aantal</th><th class="num">Totaal${cart.pricesExcl ? ' excl. btw' : ''}</th><th></th></tr></thead>
<tbody>${rows}</tbody><tfoot>${totalRows(cart.totals, cart.pricesExcl)}</tfoot></table></div>
<p class="note">${cart.pricesExcl ? 'Je ziet zakelijke prijzen excl. btw. ' : ''}Verzendkosten worden bij het afrekenen berekend. Betalen kan op rekening.</p>
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
 * De keuze van de verzendmethode: een land (bij meer dan één) en per methode een keuzerondje met de kosten.
 * @param {{ countries: object[], options: object[] }} quote De verzendopties (web-orders.js, shippingQuote).
 * @param {string} country Het gekozen land (landcode).
 * @param {string} method De gekozen methode ('ophalen' of 'dpd').
 * @returns {string} HTML van het onderdeel Verzending.
 */
function shippingChoice(quote, country, method) {
  const countryField = quote.countries.length > 1
    ? `<label class="form-field"><span>Land</span><select name="country">${quote.countries.map((entry) => `<option value="${escapeHtml(entry.code)}"${entry.code === country ? ' selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></label>
<button class="button secondary" type="submit" name="action" value="update" formnovalidate>Verzendkosten bijwerken</button>`
    : `<input type="hidden" name="country" value="${escapeHtml(country)}">`;
  const options = quote.options.map((option) => {
    const price = !option.available ? '' : option.free && option.method === 'dpd' ? 'Gratis' : option.price > 0 ? formatPrice(option.price) : 'Gratis';
    const extra = option.available ? option.note : option.reason;
    return `<label class="shipping-option${option.available ? '' : ' disabled'}"><input type="radio" name="shippingMethod" value="${escapeHtml(option.method)}"${option.method === method ? ' checked' : ''}${option.available ? '' : ' disabled'} required>
<span><strong>${escapeHtml(option.label)}</strong>${price ? ` – ${escapeHtml(price)}` : ''}${extra ? `<br><small>${escapeHtml(extra)}</small>` : ''}</span></label>`;
  }).join('');
  return `<h2>Verzending</h2>
${countryField}
${options || '<p class="note">Er is op dit moment geen verzendmethode beschikbaar.</p>'}`;
}

/**
 * De pagina Afrekenen: gegevens van de klant, de verzendmethode, het afleveradres en een overzicht van de bestelling.
 * @param {{ cart: object, quote: object, country: string, method: string, summary?: object|null, values?: object, error?: string, viewer: { displayName: string, email: string } }} state De geprijsde winkelwagen, de verzendopties, het gekozen land en de gekozen methode, de uitgerekende totalen (web-orders.js, orderTotals), eerder ingevulde waarden, een foutmelding en de ingelogde klant.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function checkoutPage({ cart, quote, country, method, summary = null, values = {}, error = '', viewer }, groups = []) {
  const value = { name: viewer.displayName, email: viewer.email, ...values };
  const chosen = quote.options.find((option) => option.method === method && option.available);
  const business = Boolean(cart.pricesExcl);
  const items = (summary ? summary.lines : cart.lines).map((line) => `<li><span>${line.qty} × ${escapeHtml(line.name)}</span><span>${escapeHtml(formatPrice(business ? line.lineExcl : line.lineTotal))}</span></li>`).join('');
  const shippingShown = summary ? (business ? summary.shipping.priceExcl : summary.shipping.price) : 0;
  const shippingRow = chosen ? `<li><span>${escapeHtml(chosen.label)}</span><span>${chosen.price > 0 ? escapeHtml(formatPrice(shippingShown)) : 'Gratis'}</span></li>` : '';
  const total = summary ? summary.totals.total : cart.totals.total;
  const vatNote = summary && summary.shifted ? '<p class="note">Btw verlegd: je bestelling wordt zonder btw gefactureerd (intracommunautaire levering).</p>' : business ? '<p class="note">Prijzen excl. btw; de btw komt er bij het afrekenen bovenop. Heb je een btw-nummer van het land van aflevering (buiten Nederland), vul het in en de btw wordt verlegd.</p>' : '';
  const body = `<section class="cart checkout"><h1>Afrekenen</h1>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="checkout-grid">
<form method="post" action="./" class="account-form">
<button type="submit" hidden>Bestelling plaatsen</button>
<input type="hidden" name="expectedTotal" value="${escapeHtml(String(total))}">
<h2>Je gegevens</h2>
${checkoutField({ name: 'name', label: 'Naam', value: value.name || '', autocomplete: 'name' })}
${checkoutField({ name: 'company', label: business ? 'Bedrijfsnaam' : 'Bedrijfsnaam (optioneel)', value: value.company || '', autocomplete: 'organization', required: business })}
${business ? checkoutField({ name: 'vatNumber', label: 'Btw-nummer (optioneel, bijvoorbeeld BE0123456789)', value: value.vatNumber || '', autocomplete: 'off', required: false }) : ''}
${checkoutField({ name: 'email', label: 'E-mailadres', value: value.email || '', autocomplete: 'email', type: 'email' })}
${checkoutField({ name: 'phone', label: 'Telefoon (optioneel)', value: value.phone || '', autocomplete: 'tel', required: false, type: 'tel' })}
${shippingChoice(quote, country, method)}
<h2>Afleveradres</h2>
<p class="note">Bij ophalen is een adres niet nodig.</p>
${checkoutField({ name: 'street', label: 'Straat en huisnummer', value: value.street || '', autocomplete: 'street-address', required: false })}
${checkoutField({ name: 'postcode', label: 'Postcode', value: value.postcode || '', autocomplete: 'postal-code', required: false })}
${checkoutField({ name: 'city', label: 'Woonplaats', value: value.city || '', autocomplete: 'address-level2', required: false })}
<label class="form-field"><span>Opmerking (optioneel)</span><textarea name="note" rows="3" maxlength="500">${escapeHtml(value.note || '')}</textarea></label>
<p class="note">Je bestelling gaat op rekening: je ontvangt de factuur van ons.</p>
<label class="terms-check"><input type="checkbox" name="terms" value="ja" required${value.terms === 'ja' ? ' checked' : ''}><span>Ik ga akkoord met de <a href="${ROOT}pagina/algemene-voorwaarden/" target="_blank" rel="noopener">algemene voorwaarden</a> en heb de <a href="${ROOT}pagina/privacyverklaring/" target="_blank" rel="noopener">privacyverklaring</a> gelezen. Als consument heb je <a href="${ROOT}pagina/herroepingsrecht/" target="_blank" rel="noopener">herroepingsrecht</a>.</span></label>
<button class="button" type="submit" name="action" value="place">Bestelling plaatsen</button>
</form>
<aside class="checkout-summary"><h2>Je bestelling</h2><ul>${items}${shippingRow}</ul>
<p class="checkout-total"><span>${business && !(summary && summary.shifted) ? 'Totaal incl. btw' : business ? 'Totaal (btw verlegd)' : 'Totaal incl. btw'}</span><strong>${escapeHtml(formatPrice(total))}</strong></p>${vatNote}
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
 * De regel met de verzendkosten onder de artikelen van een bestelling.
 * @param {{ label: string, price: number, priceExcl?: number, vatRate?: number, free: boolean }|null} shipping De verzending van de bestelling (oudere bestellingen hebben geen).
 * @param {boolean} [excl] true voor een zakelijke bestelling: toon de verzendkosten excl. btw.
 * @returns {string} HTML van de tabelrij, of leeg.
 */
function shippingRow(shipping, excl = false) {
  if (!shipping) return '';
  const shown = excl && shipping.priceExcl !== undefined ? shipping.priceExcl : shipping.price;
  return `<tr class="sub"><td colspan="3">${escapeHtml(shipping.label)}</td><td class="num">${shipping.price > 0 ? escapeHtml(formatPrice(shown)) : 'Gratis'}</td></tr>`;
}

/**
 * Hoe de bestelling bij de klant komt: het afleveradres of ophalen, met bij DPD de volglink.
 * @param {{ customer: object, address: object, shipping: object|null }} order De bestelling.
 * @returns {string} HTML van het blok Aflevering.
 */
function deliveryBlock(order) {
  if (order.shipping && order.shipping.method === 'ophalen') return `<p><strong>Ophalen</strong><br>Je haalt deze bestelling zelf op. We laten je weten wanneer hij klaarstaat.</p>`;
  const address = [order.customer.company, order.customer.name, order.address.street, `${order.address.postcode} ${order.address.city}`].filter(Boolean).map(escapeHtml).join('<br>');
  const tracking = order.shipping && order.shipping.tracking ? `<p>Volg je pakket: <a href="${escapeHtml(order.shipping.tracking.url)}" rel="noopener" target="_blank">${escapeHtml(order.shipping.tracking.code)}</a></p>` : '';
  return `<p><strong>Afleveradres</strong><br>${address}</p>${tracking}`;
}

/**
 * Een datum als dag-maand-jaar in het Nederlands.
 * @param {string} iso Tijdstip als ISO-tekst.
 * @returns {string} Bijvoorbeeld "30-10-2026".
 */
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Amsterdam' });
};

/**
 * De bestelling met regels, verzending, volgcode, factuur en verloop. Na het
 * plaatsen (`thanks`) met een bedankt, anders als onderdeel van de bestelhistorie.
 * @param {object} order De bestelling (met regels, adres, totalen en verloop).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {{ thanks?: boolean, invoice?: ?{ number: string, status: string }, returnsHtml?: string }} [options] thanks: direct na het plaatsen; invoice: de definitieve factuur bij de bestelling (download als PDF); returnsHtml: het blok Retourneren (storefront-return-pages.js).
 * @returns {string} De HTML-pagina.
 */
function orderPage(order, groups = [], { thanks = false, invoice = null, returnsHtml = '' } = {}) {
  const business = order.customerGroup === 'zakelijk';
  const rows = order.lines.map((line) => `<tr><td>${escapeHtml(line.name)}<br><small>Artikelnr.: ${escapeHtml(line.code)}</small></td><td class="num">${escapeHtml(formatPrice(business ? line.unitExcl : line.unitIncl))}</td><td class="num">${line.qty}</td><td class="num">${escapeHtml(formatPrice(business && line.lineExcl !== undefined ? line.lineExcl : line.lineTotal))}</td></tr>`).join('');
  const vatNote = order.vat && order.vat.shifted ? `<p class="note">Btw verlegd naar de afnemer${order.vat.number ? ` (btw-nummer ${escapeHtml(order.vat.number)})` : ''}.</p>` : business && order.vat && order.vat.number ? `<p class="note">Btw-nummer: ${escapeHtml(order.vat.number)}</p>` : '';
  const intro = thanks
    ? `<h1>Bedankt voor je bestelling</h1>
<p>Je bestelling <strong>${escapeHtml(order.number)}</strong> is ontvangen. We sturen een bevestiging naar ${escapeHtml(order.email)}. Je bestelling gaat op rekening: je ontvangt de factuur van ons.</p>`
    : `<h1>Bestelling ${escapeHtml(order.number)}</h1>
<p>Geplaatst op ${escapeHtml(formatDate(order.createdAt))}. Je bestelling gaat op rekening.</p>`;
  const invoiceBlock = invoice ? `<p>Factuur <strong>${escapeHtml(invoice.number)}</strong>: <a href="factuur.pdf">Download als PDF</a></p>` : '';
  const history = order.history.length ? `<p class="note">Verloop: ${order.history.map((step) => `${escapeHtml(STATUS_LABELS[step.status] || step.status)} (${escapeHtml(formatDate(step.at))})`).join(' → ')}</p>` : '';
  const body = `<section class="cart">${intro}
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Prijs${business ? ' excl. btw' : ''}</th><th class="num">Aantal</th><th class="num">Totaal${business ? ' excl. btw' : ''}</th></tr></thead>
<tbody>${rows}</tbody><tfoot>${shippingRow(order.shipping, business)}${totalRows(order.totals, business, Boolean(order.vat && order.vat.shifted))}</tfoot></table></div>
${vatNote}${deliveryBlock(order)}
<p>Status: <strong>${escapeHtml(order.statusLabel)}</strong></p>
${invoiceBlock}${history}
${returnsHtml}
<p><a class="button" href="${DETAIL_ROOT}">Verder winkelen</a> <a class="button secondary" href="${DETAIL_ROOT}bestellingen/">Al mijn bestellingen</a></p></section>`;
  return layout({ root: DETAIL_ROOT, title: `Bestelling ${order.number} – Aquatechshop.nl`, description: 'Je bestelling bij Aquatechshop.nl.', body, groups });
}

/**
 * De bestelhistorie van de ingelogde klant: een tabel met elke bestelling en een link naar het detail, met bladeren bij meer dan één pagina.
 * @param {{ items: { id: string, number: string, statusLabel: string, total: number, createdAt: string }[], total: number }} list De bestellingen van deze pagina (nieuwste eerst) en het totaal aantal.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {{ page?: number, pageSize?: number }} [paging] Het paginanummer (vanaf 1) en het aantal per pagina.
 * @returns {string} De HTML-pagina.
 */
function ordersPage(list, groups = [], { page = 1, pageSize = 25 } = {}) {
  const rows = list.items.map((order) => `<tr><td><a href="../bestelling/${escapeHtml(order.id)}/">${escapeHtml(order.number)}</a></td><td>${escapeHtml(formatDate(order.createdAt))}</td><td>${escapeHtml(order.statusLabel)}</td><td class="num">${escapeHtml(formatPrice(order.total))}</td></tr>`).join('');
  const pages = Math.max(1, Math.ceil(list.total / pageSize));
  const paging = pages > 1 ? `<p class="note">Pagina ${page} van ${pages}${page > 1 ? ` · <a href="?pagina=${page - 1}">Vorige</a>` : ''}${page < pages ? ` · <a href="?pagina=${page + 1}">Volgende</a>` : ''}</p>` : '';
  const emptyNote = list.total > 0 ? '<p>Deze pagina bevat geen bestellingen. <a href="?pagina=1">Naar de eerste pagina</a></p>' : '<p>Je hebt nog geen bestellingen geplaatst.</p>';
  const body = `<section class="cart"><h1>Mijn bestellingen</h1>
${list.items.length ? `<div class="tablewrap"><table class="cart-table"><thead><tr><th>Bestelling</th><th>Datum</th><th>Status</th><th class="num">Totaal</th></tr></thead><tbody>${rows}</tbody></table></div>${paging}` : emptyNote}
<p><a class="button" href="${ROOT}">Verder winkelen</a> <a class="button secondary" href="../account/">Mijn account</a></p></section>`;
  return layout({ root: ROOT, title: 'Mijn bestellingen – Aquatechshop.nl', description: 'Je bestellingen bij Aquatechshop.nl.', body, groups });
}

module.exports = { cartPage, checkoutPage, checkoutLoginPage, orderPage, ordersPage };
