// HTML voor bestellen in de eigen webshop (storefront.js): winkelwagen,
// afrekenen en de bevestiging van een bestelling. Server-side opgebouwd, zonder
// scripts; alle adressen zijn relatief aan de pagina (/<pagina>/).

const { layout, escapeHtml, formatPrice } = require('./storefront-pages');
const { deliverySameOf } = require('./web-orders');

/** Relatief pad van deze pagina's naar de shop-startpagina. */
const ROOT = '../';
/** Relatief pad van het besteldetail (/bestelling/<id>/) naar de shop-startpagina. */
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

/** Hoe een korting op een winkelwagenregel heet, per bron. */
const DISCOUNT_LABELS = { staffel: 'staffelkorting', klant: 'groothandelskorting', categorie: 'categoriekorting' };

/**
 * De winkelwagen met aantallen die de klant kan aanpassen.
 * @param {{ lines: object[], missing: string[], totals: object, ok: boolean }} cart De geprijsde winkelwagen (zie web-orders.js, priceCart).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {string} [notice] Een melding bovenaan, bijvoorbeeld dat een wijziging niet meer in de wagen paste.
 * @param {?{ added: number, notOrderable: string[], otherUnit?: string[] }} [fromPlan] Uitkomst van "in winkelwagen" vanuit de planner: aantal toegevoegde artikelen, de codes die niet te bestellen zijn en de codes die de shop in een andere eenheid verkoopt.
 * @returns {string} De HTML-pagina.
 */
function cartPage(cart, groups = [], notice = '', fromPlan = null) {
  const planInfo = fromPlan ? `${fromPlan.added > 0 ? `<div class="form-info" role="status"><p>Het materiaal uit je plan staat in je winkelwagen (${fromPlan.added} ${fromPlan.added === 1 ? 'artikel' : 'artikelen'}). Controleer de aantallen en reken af.</p></div>` : ''}${fromPlan.notOrderable.length ? `<div class="form-error" role="alert"><p>Deze onderdelen uit je plan zijn niet in de webshop te bestellen: ${fromPlan.notOrderable.map(escapeHtml).join(', ')}.</p></div>` : ''}${fromPlan.otherUnit && fromPlan.otherUnit.length ? `<div class="form-error" role="alert"><p>Deze onderdelen verkopen we in een andere eenheid dan je plan (bijvoorbeeld per rol in plaats van per meter) en staan daarom niet in je winkelwagen: ${fromPlan.otherUnit.map(escapeHtml).join(', ')}. Kies zelf het aantal dat je nodig hebt.</p></div>` : ''}` : '';
  if (!cart.lines.length && !cart.missing.length) {
    return layout({ root: ROOT, title: 'Winkelwagen – Aquatechshop.nl', description: 'Je winkelwagen bij Aquatechshop.nl.', groups,
      body: `<section class="cart"><h1>Winkelwagen</h1>${planInfo}<p>Je winkelwagen is leeg.</p><p><a class="button" href="${ROOT}">Verder winkelen</a></p></section>` });
  }
  const rows = cart.lines.map((line) => `<tr${line.enough && !line.packProblem ? '' : ' class="problem"'}>
    <td><strong>${escapeHtml(line.name)}</strong><br><small>Artikelnr.: ${escapeHtml(line.code)}</small>${line.enough ? '' : `<br><small class="stock out">${line.available > 0 ? `Nog maar ${escapeHtml(String(line.available))} beschikbaar` : 'Niet meer op voorraad'}</small>`}${line.packProblem ? `<br><small class="stock out">${escapeHtml(line.packProblem)}</small>` : ''}</td>
    <td class="num">${escapeHtml(formatPrice(cart.pricesExcl ? line.unitExcl : line.unitIncl))}${line.discountPct > 0 ? `<br><small class="muted">${escapeHtml(String(line.discountPct))}% ${DISCOUNT_LABELS[line.discountSource] || 'groothandelskorting'}</small>` : ''}</td>
    <td><form class="cart-qty" method="post" action="./"><input type="hidden" name="action" value="set"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><input type="number" name="qty" value="${line.qty}" min="0" max="9999" aria-label="Aantal ${escapeHtml(line.name)}"><button class="button secondary" type="submit">Wijzig</button></form></td>
    <td class="num">${escapeHtml(formatPrice(cart.pricesExcl ? line.lineExcl : line.lineTotal))}</td>
    <td><form method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(line.code)}"><button class="button secondary" type="submit" aria-label="Verwijder ${escapeHtml(line.name)}">Verwijder</button></form></td>
  </tr>`).join('');
  const missing = cart.missing.length ? `<div class="form-error" role="alert"><p>Niet meer te koop: ${cart.missing.map(escapeHtml).join(', ')}.</p>${cart.missing.map((code) => `<form class="inline" method="post" action="./"><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="${escapeHtml(code)}"><button class="button secondary" type="submit">Verwijder ${escapeHtml(code)}</button></form>`).join('')}</div>` : '';
  const full = notice ? `<div class="form-error" role="alert"><p>${escapeHtml(notice)}</p></div>` : '';
  const body = `<section class="cart"><h1>Winkelwagen</h1>
${planInfo}${full}${missing}
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
 * Het extra invoerrijtje voor het afrekenformulier: huisnummer en toevoeging, waarmee het script (adres.js, afrekenen.js)
 * straat en woonplaats bij de postcode opzoekt. Verborgen zonder script; de velden hebben geen naam en worden niet verstuurd.
 * @returns {string} HTML van het rijtje met de plaats voor de melding.
 */
function addressLookupRow() {
  return `<div class="address-lookup" data-address-row hidden>
<label class="form-field"><span>Huisnummer</span><input type="text" inputmode="numeric" maxlength="5" autocomplete="off" data-address-number></label>
<label class="form-field"><span>Toevoeging (optioneel)</span><input type="text" maxlength="6" autocomplete="off" data-address-suffix></label>
<p class="address-status" role="status" aria-live="polite" data-address-status></p>
</div>`;
}

/**
 * De gegevens die het script (afrekenen.js) nodig heeft om het overzicht bij een andere verzendmethode direct bij te werken.
 * @param {{ label: string, price: number }} option De verzendoptie.
 * @param {?object} summary De uitgerekende totalen bij deze optie, of niets als de optie niet beschikbaar is.
 * @param {boolean} business true voor een zakelijke klant (bedragen excl. btw).
 * @returns {string} Attributen voor het keuzerondje, of leeg.
 */
function summaryData(option, summary, business) {
  if (!summary) return '';
  const shown = business ? summary.shipping.priceExcl : summary.shipping.price;
  const charged = option.price > 0;
  const attributes = {
    'data-ship-label': shippingCaption(option.label, charged, business),
    'data-ship-price': charged ? formatPrice(shown) : 'Gratis',
    'data-total': String(summary.totals.total),
    'data-total-text': formatPrice(summary.totals.total),
    'data-total-caption': totalCaption(business, summary.shifted),
    'data-note': vatNoteText(business, summary.shifted, summary.otherNumber),
  };
  return Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
}

/**
 * Het label bij het totaal op de pagina Afrekenen.
 * @param {boolean} business true voor een zakelijke klant.
 * @param {boolean} shifted true als de btw is verlegd.
 * @returns {string} Het label.
 */
function totalCaption(business, shifted) {
  return business && shifted ? 'Totaal (btw verlegd)' : 'Totaal incl. btw';
}

/**
 * De opmerking over de btw onder het totaal op de pagina Afrekenen.
 * @param {boolean} business true voor een zakelijke klant.
 * @param {boolean} shifted true als de btw is verlegd.
 * @param {boolean} [otherNumber] true als verleggen alleen niet kan omdat het nummer niet het goedgekeurde nummer van het account is.
 * @returns {string} De tekst, of leeg voor een particulier.
 */
function vatNoteText(business, shifted, otherNumber = false) {
  if (shifted) return 'Btw verlegd: je bestelling wordt zonder btw gefactureerd (intracommunautaire levering).';
  if (business && otherNumber) return 'Dit btw-nummer is niet het goedgekeurde btw-nummer van je zakelijke account, dus de btw wordt niet verlegd. Neem contact met ons op om het btw-nummer van je account te laten wijzigen.';
  return business ? 'Prijzen excl. btw; de btw komt er bij het afrekenen bovenop. Bij levering buiten Nederland wordt de btw verlegd met het btw-nummer van je zakelijke account.' : '';
}

/**
 * De keuze van de verzendmethode: een land (bij meer dan één) en per methode een keuzerondje met de kosten.
 * @param {{ countries: object[], options: object[] }} quote De verzendopties (web-orders.js, shippingQuote).
 * @param {string} country Het gekozen land (landcode).
 * @param {string} method De gekozen methode ('ophalen' of 'dpd').
 * @param {Object<string, object>} [summaries] De uitgerekende totalen per beschikbare methode (web-orders.js, orderTotals), zodat het script het overzicht direct kan bijwerken.
 * @param {boolean} [business] true voor een zakelijke klant (bedragen excl. btw).
 * @returns {string} HTML van het onderdeel Verzending.
 */
function shippingChoice(quote, country, method, summaries = {}, business = false) {
  const countryField = quote.countries.length > 1
    ? `<label class="form-field"><span>Land</span><select name="country">${quote.countries.map((entry) => `<option value="${escapeHtml(entry.code)}"${entry.code === country ? ' selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></label>
`
    : `<input type="hidden" name="country" value="${escapeHtml(country)}">`;
  const options = quote.options.map((option) => {
    const businessPrice = option.available && business && summaries[option.method] ? summaries[option.method].shipping.priceExcl : undefined;
    const displayPrice = businessPrice !== undefined ? businessPrice : option.price;
    const price = !option.available ? '' : option.free && option.method === 'dpd' ? 'Gratis' : displayPrice > 0 ? formatPrice(displayPrice) : 'Gratis';
    const extra = option.available ? option.note : option.reason;
    return `<label class="shipping-option${option.available ? '' : ' disabled'}"><input type="radio" name="shippingMethod" value="${escapeHtml(option.method)}"${option.method === method ? ' checked' : ''}${option.available ? '' : ' disabled'}${summaryData(option, summaries[option.method], business)} required>
<span><strong>${escapeHtml(option.label)}</strong>${price ? ` – ${escapeHtml(price)}` : ''}${extra ? `<br><small>${escapeHtml(extra)}</small>` : ''}</span></label>`;
  }).join('');
  return `<h2>Verzending</h2>
${countryField}
<div data-shipping-options>${options || '<p class="note">Er is op dit moment geen verzendmethode beschikbaar.</p>'}</div>
<button class="button secondary update-totals" type="submit" name="action" value="update" formnovalidate>Totaal bijwerken</button>`;
}

/** Namen van de betaalmethoden van Mollie zoals de klant ze kent. */
const PAYMENT_METHODS = { ideal: 'iDEAL', creditcard: 'creditcard', bancontact: 'Bancontact', paypal: 'PayPal', applepay: 'Apple Pay', banktransfer: 'overboeking', eps: 'EPS', giropay: 'giropay', kbc: 'KBC/CBC', belfius: 'Belfius' };

/**
 * Het onderdeel Betalen op de pagina Afrekenen: bij één betaalwijze een uitleg, bij meer een keuze.
 * @param {string[]} options De betaalwijzen die de klant mag kiezen: 'online' en/of 'rekening'.
 * @param {string} [chosen] De eerder gekozen betaalwijze.
 * @returns {string} HTML van het onderdeel.
 */
function paymentChoice(options, chosen = '') {
  const texts = { online: 'Online betalen met iDEAL of een andere betaalmethode: je betaalt direct op de beveiligde pagina van onze betaalprovider.', rekening: 'Op rekening: je ontvangt de factuur van ons.' };
  if (options.length === 1) return `<h2>Betalen</h2><p class="note">${options[0] === 'online' ? 'Na het bestellen betaal je online met iDEAL of een andere betaalmethode, op de beveiligde pagina van onze betaalprovider.' : texts.rekening}</p>${options[0] === 'online' ? '<input type="hidden" name="paymentMethod" value="online">' : ''}`;
  const selected = options.includes(chosen) ? chosen : options[0];
  return `<h2>Betalen</h2>${options.map((option) => `<label class="shipping-option"><input type="radio" name="paymentMethod" value="${option}"${option === selected ? ' checked' : ''} required> <span>${escapeHtml(texts[option])}</span></label>`).join('')}`;
}

/**
 * Eén adresblok op de pagina Afrekenen: postcode met opzoeken, straat, woonplaats en het vinkje voor een adres dat niet gevonden wordt.
 * @param {{ delivery: boolean, value: object, countries?: object[], country?: string, deliverySame?: boolean }} options `delivery` kiest de veldnamen van het afleveradres (voorvoegsel `delivery`) in plaats van die van het factuuradres; `value` zijn de eerder ingevulde waarden; met `countries` (meer dan één) en `country` komt er een landkeuze bij (alleen het factuuradres, naam `billingCountry`; verborgen zolang het afleveradres gelijk is).
 * @returns {string} HTML van het blok.
 */
function addressBlock({ delivery, value, countries = [], country = 'NL', deliverySame = true }) {
  /**
   * De veldnaam van dit adresblok (voorvoegsel `delivery` voor het afleveradres).
   * @param {string} field Basisnaam (street, postcode, city).
   * @returns {string} De veldnaam in het formulier.
   */
  const name = (field) => (delivery ? `delivery${field[0].toUpperCase()}${field.slice(1)}` : field);
  const scope = delivery ? 'shipping ' : 'billing ';
  const countryField = !delivery && countries.length > 1
    ? `<label class="form-field" data-billing-country${deliverySame ? ' hidden' : ''}><span>Land van het factuuradres</span><select name="billingCountry">${countries.map((entry) => `<option value="${escapeHtml(entry.code)}"${entry.code === country ? ' selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></label>`
    : '';
  return `${countryField}${checkoutField({ name: name('postcode'), label: 'Postcode', value: value[name('postcode')] || '', autocomplete: `${scope}postal-code`, required: false })}
${addressLookupRow()}
${checkoutField({ name: name('street'), label: 'Straat en huisnummer', value: value[name('street')] || '', autocomplete: `${scope}street-address`, required: false })}
${checkoutField({ name: name('city'), label: 'Woonplaats', value: value[name('city')] || '', autocomplete: `${scope}address-level2`, required: false })}
<label class="terms-check"><input type="checkbox" name="${delivery ? 'deliveryAddressManual' : 'addressManual'}" value="ja" data-address-manual${value[delivery ? 'deliveryAddressManual' : 'addressManual'] === 'ja' ? ' checked' : ''}><span>${delivery ? 'Dit adres wordt niet gevonden' : 'Mijn adres wordt niet gevonden'} (bijvoorbeeld nieuwbouw) of het opzoeken werkt nu niet: ik vul straat en woonplaats zelf in. We controleren het adres dan zelf voordat we verzenden.</span></label>`;
}

/**
 * Het blok Dropshipping op het afrekenformulier: de klant laat de bestelling rechtstreeks bij zijn eigen klant bezorgen en geeft
 * het e-mailadres voor het afleverbewijs. De eigen pakbon uploadt hij na het bestellen op de pagina van de bestelling.
 * @param {{ dropshipping?: string, dropshipProofEmail?: string }} value De eerder ingevulde waarden.
 * @returns {string} HTML van het blok.
 */
function dropshipChoice(value) {
  const on = value.dropshipping === 'ja';
  return `<div class="dropship-block" data-dropship-section>
<label class="terms-check"><input type="checkbox" name="dropshipping" value="ja" data-dropship${on ? ' checked' : ''}><span>Dropshipping: bezorg deze bestelling rechtstreeks bij mijn eigen klant, met mijn eigen pakbon</span></label>
<label class="form-field" data-dropship-fields><span>E-mailadres voor het afleverbewijs</span><input name="dropshipProofEmail" type="email" value="${escapeHtml(value.dropshipProofEmail || '')}" autocomplete="off" maxlength="200"><small>Vul bij het afleveradres het adres van je klant in. Na het bestellen upload je op de pagina van de bestelling je eigen pakbon (PDF); die gaat dan in de doos in plaats van de onze.</small></label>
</div>`;
}

/**
 * De pagina Afrekenen: gegevens van de klant, de verzendmethode, het afleveradres en een overzicht van de bestelling.
 * @param {{ cart: object, quote: object, country: string, method: string, summary?: object|null, values?: object, error?: string, viewer: { displayName: string, email: string }, paymentOptions?: string[] }} state De geprijsde winkelwagen, de verzendopties, het gekozen land en de gekozen methode, de uitgerekende totalen (web-orders.js, orderTotals), eerder ingevulde waarden, een foutmelding, de ingelogde klant en de betaalwijzen die hij mag kiezen (online en/of rekening).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function checkoutPage({ cart, quote, country, method, summary = null, summaries = {}, values = {}, error = '', viewer, paymentOptions = ['rekening'] }, groups = []) {
  const profile = viewer.profile || {};
  const value = { name: viewer.displayName, email: viewer.email, company: profile.companyName || '', vatNumber: profile.vatNumber || '', ...values };
  const chosen = quote.options.find((option) => option.method === method && option.available);
  const business = Boolean(cart.pricesExcl);
  const deliverySame = deliverySameOf(values);
  const items = (summary ? summary.lines : cart.lines).map((line) => `<li><span>${line.qty} × ${escapeHtml(line.name)}</span><span>${escapeHtml(formatPrice(business ? line.lineExcl : line.lineTotal))}</span></li>`).join('');
  const shippingShown = summary ? (business ? summary.shipping.priceExcl : summary.shipping.price) : 0;
  const shippingRow = `<li data-ship-row${chosen ? '' : ' hidden'}><span data-ship-label>${chosen ? escapeHtml(shippingCaption(chosen.label, chosen.price > 0, business)) : ''}</span><span data-ship-price>${chosen ? (chosen.price > 0 ? escapeHtml(formatPrice(shippingShown)) : 'Gratis') : ''}</span></li>`;
  const total = summary ? summary.totals.total : cart.totals.total;
  const noteText = vatNoteText(business, Boolean(summary && summary.shifted), Boolean(summary && summary.otherNumber));
  const vatNote = `<p class="note" data-vat-note${noteText ? '' : ' hidden'}>${escapeHtml(noteText)}</p>`;
  const body = `<section class="cart checkout"><h1>Afrekenen</h1>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="checkout-grid">
<form method="post" action="./" class="account-form" data-address-endpoint="${ROOT}adres/">
<button type="submit" hidden>Bestelling plaatsen</button>
<input type="hidden" name="expectedTotal" value="${escapeHtml(String(total))}" data-expected-total>
<h2>Je gegevens</h2>
${checkoutField({ name: 'name', label: 'Naam', value: value.name || '', autocomplete: 'name' })}
${checkoutField({ name: 'company', label: business ? 'Bedrijfsnaam' : 'Bedrijfsnaam (optioneel)', value: value.company || '', autocomplete: 'organization', required: business })}
${business ? checkoutField({ name: 'vatNumber', label: 'Btw-nummer (optioneel, bijvoorbeeld BE0123456789)', value: value.vatNumber || '', autocomplete: 'off', required: false }) : ''}
${viewer.email ? `<label class="form-field"><span>E-mailadres</span><input name="email" type="email" value="${escapeHtml(viewer.email)}" autocomplete="email" readonly><small>De bevestiging gaat naar het e-mailadres van je account; wijzigen kan in <a href="../app/profiel/">Mijn profiel</a>.</small></label>` : checkoutField({ name: 'email', label: 'E-mailadres', value: value.email || '', autocomplete: 'email', type: 'email' })}
${checkoutField({ name: 'phone', label: 'Telefoon (optioneel)', value: value.phone || '', autocomplete: 'tel', required: false, type: 'tel' })}
${shippingChoice(quote, country, method, summaries, business)}
<h2>Factuuradres</h2>
<p class="note">Bij ophalen is een adres niet nodig.</p>
<div class="address-block" data-address-block="billing">
${addressBlock({ delivery: false, value, countries: quote.countries, country: value.billingCountry || 'NL', deliverySame })}
</div>
<input type="hidden" name="deliveryForm" value="1">
<label class="terms-check" data-delivery-same-row><input type="checkbox" name="deliverySame" value="ja" data-delivery-same${deliverySame ? ' checked' : ''}><span>Afleveradres gelijk aan factuuradres</span></label>
<div class="address-block delivery-fields" data-address-block="delivery"${deliverySame ? ' hidden' : ''}>
<h2>Afleveradres</h2>
${addressBlock({ delivery: true, value })}
</div>
<label class="form-field"><span>Opmerking (optioneel)</span><textarea name="note" rows="3" maxlength="500">${escapeHtml(value.note || '')}</textarea></label>
${dropshipChoice(value)}
${paymentChoice(paymentOptions, value.paymentMethod)}
<label class="terms-check"><input type="checkbox" name="terms" value="ja" required${value.terms === 'ja' ? ' checked' : ''}><span>Ik ga akkoord met de <a href="${ROOT}pagina/algemene-voorwaarden/" target="_blank" rel="noopener">algemene voorwaarden</a> en heb de <a href="${ROOT}pagina/privacyverklaring/" target="_blank" rel="noopener">privacyverklaring</a> gelezen. Als consument heb je <a href="${ROOT}pagina/herroepingsrecht/" target="_blank" rel="noopener">herroepingsrecht</a>.</span></label>
<button class="button" type="submit" name="action" value="place">${paymentOptions.length === 1 && paymentOptions[0] === 'online' ? 'Bestellen en betalen' : 'Bestelling plaatsen'}</button>
</form>
<aside class="checkout-summary"><h2>Je bestelling</h2><ul>${items}${shippingRow}</ul>
<p class="checkout-total"><span data-total-caption>${totalCaption(business, Boolean(summary && summary.shifted))}</span><strong data-total-text>${escapeHtml(formatPrice(total))}</strong></p>${vatNote}
<p><a href="${ROOT}winkelwagen/">Winkelwagen aanpassen</a></p></aside>
</div></section>`;
  return layout({ root: ROOT, title: 'Afrekenen – Aquatechshop.nl', description: 'Reken je bestelling af bij Aquatechshop.nl.', body, groups, script: ['adres.js', 'afrekenen.js'] });
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
 * De omschrijving van de verzendkosten met erbij of de btw erin zit.
 * @param {string} label De naam van de verzendmethode (bijvoorbeeld "Bezorgen met DPD").
 * @param {boolean} charged true als er verzendkosten zijn (bij gratis staat er geen btw-vermelding).
 * @param {boolean} excl true voor een zakelijke klant: de verzendkosten staan excl. btw.
 * @returns {string} De omschrijving, bijvoorbeeld "Bezorgen met DPD (incl. btw)".
 */
function shippingCaption(label, charged, excl) {
  return charged ? `${label} (${excl ? 'excl.' : 'incl.'} btw)` : label;
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
  return `<tr class="sub"><td colspan="3">${escapeHtml(shippingCaption(shipping.label, shipping.price > 0, excl))}</td><td class="num">${shipping.price > 0 ? escapeHtml(formatPrice(shown)) : 'Gratis'}</td></tr>`;
}

/**
 * Hoe de bestelling bij de klant komt: het afleveradres of ophalen, met bij DPD de volglink.
 * @param {{ customer: object, address: object, billingAddress?: ?object, deliverySame?: boolean, shipping: object|null }} order De bestelling (met het factuuradres erbij als het afleveradres afwijkt).
 * @returns {string} HTML van het blok Aflevering.
 */
function deliveryBlock(order) {
  if (order.shipping && order.shipping.method === 'ophalen') return `<p><strong>Ophalen</strong><br>Je haalt deze bestelling zelf op. We laten je weten wanneer hij klaarstaat.</p>`;
  const address = [order.customer.company, order.customer.name, order.address.street, `${order.address.postcode} ${order.address.city}`].filter(Boolean).map(escapeHtml).join('<br>');
  const tracking = order.shipping && order.shipping.tracking ? `<p>Volg je pakket: <a href="${escapeHtml(order.shipping.tracking.url)}" rel="noopener" target="_blank">${escapeHtml(order.shipping.tracking.code)}</a></p>` : '';
  const billing = order.deliverySame === false && order.billingAddress && order.billingAddress.street
    ? `<p><strong>Factuuradres</strong><br>${[order.customer.company, order.customer.name, order.billingAddress.street, `${order.billingAddress.postcode} ${order.billingAddress.city}`].filter(Boolean).map(escapeHtml).join('<br>')}</p>` : '';
  return `<p><strong>Afleveradres</strong><br>${address}</p>${billing}${tracking}`;
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
 * @param {{ thanks?: boolean, invoice?: ?{ number: string, status: string }, returnsHtml?: string, payError?: string, autoPay?: boolean }} [options] thanks: direct na het plaatsen; invoice: de definitieve factuur bij de bestelling (download als PDF); returnsHtml: het blok Retourneren (storefront-return-pages.js); payError: een melding bij het starten van de betaling; autoPay: stuur de klant meteen door naar de betaalpagina.
 * @returns {string} De HTML-pagina.
 */
function orderPage(order, groups = [], { thanks = false, invoice = null, returnsHtml = '', payError = '', autoPay = false } = {}) {
  const business = order.customerGroup === 'zakelijk';
  const rows = order.lines.map((line) => `<tr><td>${escapeHtml(line.name)}<br><small>Artikelnr.: ${escapeHtml(line.code)}</small></td><td class="num">${escapeHtml(formatPrice(business ? line.unitExcl : line.unitIncl))}</td><td class="num">${line.qty}</td><td class="num">${escapeHtml(formatPrice(business && line.lineExcl !== undefined ? line.lineExcl : line.lineTotal))}</td></tr>`).join('');
  const vatNote = order.vat && order.vat.shifted ? `<p class="note">Btw verlegd naar de afnemer${order.vat.number ? ` (btw-nummer ${escapeHtml(order.vat.number)})` : ''}.</p>` : business && order.vat && order.vat.number ? `<p class="note">Btw-nummer: ${escapeHtml(order.vat.number)}</p>` : '';
  const online = order.payment === 'online' && order.pay;
  const paid = Boolean(online && order.pay.status === 'betaald');
  const waiting = Boolean(online && !paid && order.status === 'nieuw');
  const intro = thanks
    ? `<h1>Bedankt voor je bestelling</h1>
<p>Je bestelling <strong>${escapeHtml(order.number)}</strong> is ontvangen.${paid ? ` We hebben je betaling ontvangen en sturen een bevestiging naar ${escapeHtml(order.email)}.` : waiting ? ' Rond je betaling af, dan bevestigen we je bestelling per mail.' : ` We sturen een bevestiging naar ${escapeHtml(order.email)}. Je bestelling gaat op rekening: je ontvangt de factuur van ons.`}</p>`
    : `<h1>Bestelling ${escapeHtml(order.number)}</h1>
<p>Geplaatst op ${escapeHtml(formatDate(order.createdAt))}. ${online ? (paid ? 'Je hebt online betaald.' : 'Je bestelling wordt online betaald.') : 'Je bestelling gaat op rekening.'}</p>`;
  const payBlock = online ? paymentBlock(order, { payError, waiting }) : '';
  const invoiceBlock = invoice ? `<p>Factuur <strong>${escapeHtml(invoice.number)}</strong>: <a href="factuur.pdf">Download als PDF</a></p>` : '';
  const history = order.history.length ? `<p class="note">Verloop: ${order.history.map((step) => `${escapeHtml(STATUS_LABELS[step.status] || step.status)} (${escapeHtml(formatDate(step.at))})`).join(' → ')}</p>` : '';
  const body = `<section class="cart">${intro}
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Prijs${business ? ' excl. btw' : ''}</th><th class="num">Aantal</th><th class="num">Totaal${business ? ' excl. btw' : ''}</th></tr></thead>
<tbody>${rows}</tbody><tfoot>${shippingRow(order.shipping, business)}${totalRows(order.totals, business, Boolean(order.vat && order.vat.shifted))}</tfoot></table></div>
${vatNote}${deliveryBlock(order)}
${dropshipBlock(order, thanks)}${payBlock}<p>Status: <strong>${escapeHtml(order.statusLabel)}</strong></p>
${invoiceBlock}${history}
${returnsHtml}
<p><a class="button" href="${DETAIL_ROOT}">Verder winkelen</a> <a class="button secondary" href="${DETAIL_ROOT}bestellingen/">Al mijn bestellingen</a></p></section>`;
  return layout({ root: DETAIL_ROOT, title: `Bestelling ${order.number} – Aquatechshop.nl`, description: 'Je bestelling bij Aquatechshop.nl.', body, groups, script: order.dropshipping && order.status === 'nieuw' && !order.packingSlip ? 'pakbon.js' : '', refresh: autoPay && waiting && !payError ? 'betalen/' : '' });
}

/**
 * Het blok Dropshipping op de pagina van een bestelling: het adres voor het afleverbewijs en de eigen pakbon van de klant, met
 * zolang de bestelling nieuw is een formulier om hem te uploaden of te vervangen (script pakbon.js).
 * @param {{ dropshipping: ?{ proofEmail: string, slip: ?{ name: string, pages: number } }, status: string }} order De bestelling.
 * @param {boolean} thanks Of de klant de bestelling zojuist plaatste (dan staat de oproep om de pakbon te uploaden extra prominent).
 * @returns {string} HTML van het blok, of leeg als de bestelling geen dropshipping is.
 */
function dropshipBlock(order, thanks) {
  const drop = order.dropshipping;
  if (!drop) return '';
  const slip = drop.slip;
  const open = order.status === 'nieuw' && !order.packingSlip;
  const state = slip
    ? `<p>Je pakbon: <strong>${escapeHtml(slip.name)}</strong> (${slip.pages} ${slip.pages === 1 ? 'pagina' : 'pagina\'s'}) · <a href="pakbon.pdf">bekijken</a></p>`
    : `<p class="${thanks ? 'form-error' : 'note'}" role="status"><strong>Upload je pakbon.</strong> ${open ? 'We kunnen de bestelling pas inpakken als we je eigen pakbon hebben.' : 'Er is geen pakbon geüpload.'}</p>`;
  const upload = open
    ? `<div class="slip-upload" data-slip-upload><label class="form-field"><span>${slip ? 'Andere pakbon uploaden (PDF, hoogstens 2 MB)' : 'Pakbon uploaden (PDF, hoogstens 2 MB)'}</span><input type="file" accept="application/pdf,.pdf" data-slip-file></label><button class="button" type="button" data-slip-send>${slip ? 'Pakbon vervangen' : 'Pakbon uploaden'}</button><p class="note" data-slip-message role="status" hidden></p></div>`
    : '';
  return `<div class="dropship-info"><p><strong>Dropshipping</strong><br>Het afleverbewijs gaat naar ${escapeHtml(drop.proofEmail)}.</p>${state}${upload}</div>`;
}

/**
 * Het blok Betaling op de pagina van een online bestelling: betaald, nog te betalen (met knop) of niet gelukt.
 * @param {object} order De online bestelling (met pay).
 * @param {{ payError?: string, waiting: boolean }} state Een melding bij het starten van de betaling en of de bestelling nog op betaling wacht.
 * @returns {string} HTML van het blok.
 */
function paymentBlock(order, { payError, waiting }) {
  const pay = order.pay;
  const error = payError ? `<p class="form-error" role="alert">${escapeHtml(payError)}</p>` : '';
  if (pay.status === 'betaald') {
    const method = PAYMENT_METHODS[pay.method] || pay.method;
    return `<p>Betaling: <strong>betaald</strong> op ${escapeHtml(formatDate(pay.paidAt))}${method ? ` (${escapeHtml(method)})` : ''}.</p>`;
  }
  if (!waiting) return `<p>Betaling: <strong>niet betaald</strong>. Deze bestelling is ${order.status === 'geannuleerd' ? 'geannuleerd' : 'niet meer te betalen'}.</p>`;
  const note = pay.status === 'mislukt' ? 'De betaling is niet gelukt of afgebroken. Je kunt het opnieuw proberen; je bestelling staat nog even voor je klaar.' : 'We hebben je betaling nog niet ontvangen. Rond de betaling af om je bestelling te bevestigen.';
  return `${error}<p>Betaling: <strong>${pay.status === 'mislukt' ? 'niet gelukt' : 'nog te betalen'}</strong>. ${note}</p>
<p><a class="button" href="betalen/">${pay.status === 'mislukt' ? 'Opnieuw betalen' : 'Nu betalen'}</a></p>`;
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
