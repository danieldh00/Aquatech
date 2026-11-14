// HTML van het account in de eigen webshop (storefront.js): inloggen,
// registreren en "mijn account". Hetzelfde account werkt in de planner en het
// klantportaal. Alle adressen zijn relatief aan de pagina (/<pagina>/).

const { layout, escapeHtml, captchaFields } = require('./storefront-pages');

/** Relatief pad van deze pagina's naar de shop-startpagina. */
const ROOT = '../';
/** Relatief pad naar de hoofdmap van de app (planner, portaal, profiel). */
const APP_ROOT = '../app/';

/**
 * Een invoerveld met label.
 * @param {{ name: string, label: string, type?: string, value?: string, autocomplete: string, hint?: string, required?: boolean }} field Het veld.
 * @returns {string} HTML van het veld.
 */
function field({ name, label, type = 'text', value = '', autocomplete, hint = '', required = true }) {
  return `<label class="form-field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${required ? ' required' : ''}>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`;
}

/**
 * De velden voor een zakelijk account (bedrijfsnaam, KvK-nummer, btw-nummer).
 * @param {{ companyName?: string, kvkNumber?: string, vatNumber?: string }} [values] Eerder ingevulde waarden.
 * @param {boolean} [required] Of bedrijfsnaam en KvK-nummer verplicht zijn in de browser (niet bij het keuzevakje bij registreren).
 * @returns {string} HTML van de velden.
 */
function businessFields({ companyName = '', kvkNumber = '', vatNumber = '' } = {}, required = true) {
  return `${field({ name: 'companyName', label: 'Bedrijfsnaam', value: companyName, autocomplete: 'organization', required })}
${field({ name: 'kvkNumber', label: 'KvK-nummer', value: kvkNumber, autocomplete: 'off', hint: '8 cijfers.', required })}
${field({ name: 'vatNumber', label: 'Btw-nummer (optioneel)', value: vatNumber, autocomplete: 'off', hint: 'Bijvoorbeeld NL123456789B01.', required: false })}`;
}

/**
 * De pagina met een formulier in het kader van de shop.
 * @param {{ title: string, heading: string, form: string, aside: string, groups: object[], script?: string }} options Titel, kop, formulier, tekst eronder, menu en eventueel een script uit de assets.
 * @returns {string} De HTML-pagina.
 */
function formPage({ title, heading, form, aside, groups, script = '' }) {
  const body = `<section class="account-card"><h1>${escapeHtml(heading)}</h1>${form}<p class="account-aside">${aside}</p></section>`;
  return layout({ root: ROOT, title: `${title} – Aquatechshop.nl`, description: `${heading} bij Aquatechshop.nl.`, body, groups, script });
}

/**
 * Inlogpagina.
 * @param {{ error?: string, login?: string, next?: string }} state Foutmelding, eerder ingevulde inlognaam en waar naartoe na het inloggen ('planner', 'afrekenen' of leeg).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function loginPage({ error = '', login = '', next = '' } = {}, groups = []) {
  const form = `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${next ? `<input type="hidden" name="volgende" value="${escapeHtml(next)}">` : ''}
${field({ name: 'login', label: 'E-mailadres of gebruikersnaam', value: login, autocomplete: 'username' })}
${field({ name: 'password', label: 'Wachtwoord', type: 'password', autocomplete: 'current-password' })}
${captchaFields('login')}
<button class="button" type="submit">Inloggen</button>
</form>`;
  return formPage({ title: 'Inloggen', heading: 'Inloggen', form, groups,
    aside: `<a href="${ROOT}wachtwoord-vergeten/">Wachtwoord vergeten?</a> Nog geen account? <a href="${ROOT}registreren/">Registreer je</a>. Je account werkt ook in de planner en het klantportaal.` });
}

/**
 * Registratiepagina.
 * @param {{ error?: string, displayName?: string, email?: string, next?: string, business?: boolean, companyName?: string, kvkNumber?: string, vatNumber?: string }} state Foutmelding, eerder ingevulde waarden (ook het vakje en de bedrijfsgegevens) en waar naartoe na het registreren ('afrekenen' of leeg).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function registerPage({ error = '', displayName = '', email = '', next = '', business = false, companyName = '', kvkNumber = '', vatNumber = '' } = {}, groups = []) {
  const form = `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${next ? `<input type="hidden" name="volgende" value="${escapeHtml(next)}">` : ''}
${field({ name: 'displayName', label: 'Naam', value: displayName, autocomplete: 'name' })}
${field({ name: 'email', label: 'E-mailadres', type: 'email', value: email, autocomplete: 'email' })}
${field({ name: 'password', label: 'Wachtwoord', type: 'password', autocomplete: 'new-password', hint: 'Minimaal 12 tekens.' })}
${field({ name: 'password2', label: 'Wachtwoord herhalen', type: 'password', autocomplete: 'new-password' })}
<fieldset class="business-fields"><legend>Zakelijke klant</legend>
<label class="check"><input type="checkbox" name="business" value="1"${business ? ' checked' : ''}> Ik bestel zakelijk (prijzen excl. btw)</label>
<p class="note">Vink dit aan en vul de bedrijfsgegevens in. Na controle door AquaTech Service zie je overal prijzen excl. btw. Tot die tijd bestel je als particulier.</p>
${businessFields({ companyName, kvkNumber, vatNumber }, false)}
</fieldset>
<input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
${captchaFields('register')}
<button class="button" type="submit">Account maken</button>
</form>`;
  return formPage({ title: 'Registreren', heading: 'Account maken', form, groups,
    aside: `Al een account? <a href="${ROOT}account/">Log in</a>. Met je account kun je ook je tuin ontwerpen in de planner.` });
}

/**
 * Het blok over zakelijk bestellen op "Mijn account": de status voor een zakelijke klant of een open aanvraag, of het formulier om een zakelijk account aan te vragen.
 * @param {{ isCustomer: boolean }} viewer De ingelogde gebruiker.
 * @param {{ customerGroup?: string, companyName?: string, kvkNumber?: string, vatNumber?: string, businessRequest?: string }} profile Klantgroep en bedrijfsgegevens.
 * @param {{ error: string, values: object, requested: boolean }} state Fout, ingevulde waarden en of de aanvraag net is verstuurd.
 * @returns {string} HTML van het blok (leeg voor een gebruiker die geen klant is).
 */
function businessSection(viewer, profile, { error, values, requested }) {
  if (!viewer.isCustomer) return '';
  if (profile.customerGroup === 'zakelijk') {
    const details = [profile.companyName, profile.kvkNumber && `KvK ${profile.kvkNumber}`, profile.vatNumber && `btw ${profile.vatNumber}`].filter(Boolean).map(escapeHtml).join(' · ');
    return `<div class="business-status"><p><strong>Zakelijk account</strong>${details ? `: ${details}` : ''}. Je ziet prijzen excl. btw.</p></div>`;
  }
  if (profile.businessRequest === 'aangevraagd') {
    return `<div class="business-status"><p>${requested ? 'Bedankt! ' : ''}Je aanvraag voor een zakelijk account wordt beoordeeld. Je hoort van ons zodra het is goedgekeurd; tot die tijd zie je de prijzen incl. btw.</p></div>`;
  }
  return `<details class="business-request"${error ? ' open' : ''}><summary>Zakelijk bestellen? Vraag een zakelijk account aan</summary>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${ROOT}account/zakelijk/" class="account-form">
${businessFields(values)}
<button class="button" type="submit">Aanvragen</button>
</form></details>`;
}

/**
 * Het blok over het e-mailadres op "Mijn account": bevestigd, of een knop om de bevestigingsmail opnieuw te sturen.
 * @param {{ email: string, emailVerified: boolean }} viewer De ingelogde gebruiker.
 * @param {{ available?: boolean, sent?: string, verified?: boolean }} state available: er kan gemaild worden; sent: 'ja' of 'nee' na opnieuw versturen; verified: net bevestigd.
 * @returns {string} HTML van het blok (leeg zonder e-mailadres of zonder mailserver bij een onbevestigd adres).
 */
function verificationSection(viewer, { available = false, sent = '', verified = false } = {}) {
  if (!viewer.email) return '';
  if (viewer.emailVerified) return `<p class="note">${verified ? 'Bedankt, ' : ''}je e-mailadres is bevestigd.</p>`;
  if (!available) return '';
  const status = sent === 'ja' ? '<p class="note" role="status">We hebben een nieuwe bevestigingsmail gestuurd.</p>' : sent === 'nee' ? '<p class="form-error" role="alert">Er is net al een mail verstuurd. Probeer het later opnieuw.</p>' : '';
  return `<div class="business-status">${status}<form method="post" action="${ROOT}account/bevestigen/"><p>Je e-mailadres is nog niet bevestigd. Klik op de link in de mail die we stuurden. <button class="button secondary" type="submit">Mail opnieuw sturen</button></p></form></div>`;
}

/**
 * Wachtwoord vergeten: het e-mailadres invullen, of de melding dat de mail onderweg is.
 * @param {{ error?: string, email?: string, sent?: boolean }} state Foutmelding, ingevuld adres en of het formulier is verstuurd.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function forgotPage({ error = '', email = '', sent = false } = {}, groups = []) {
  const form = sent
    ? '<p role="status">Als er een account met dit e-mailadres is, krijg je binnen een paar minuten een mail met een link om een nieuw wachtwoord te kiezen. De link werkt één uur. Kijk ook in je map met ongewenste mail.</p>'
    : `<p>Vul het e-mailadres van je account in. Je krijgt een mail met een link om een nieuw wachtwoord te kiezen.</p>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${field({ name: 'email', label: 'E-mailadres', type: 'email', value: email, autocomplete: 'email' })}
${captchaFields('forgot_password')}
<button class="button" type="submit">Stuur de link</button>
</form>`;
  return formPage({ title: 'Wachtwoord vergeten', heading: 'Wachtwoord vergeten', form, groups, aside: `Weet je het weer? <a href="${ROOT}inloggen/">Log in</a>.` });
}

/**
 * Nieuw wachtwoord kiezen met de link uit de mail (het token zet storefront-account-link.js in het formulier).
 * @param {{ error?: string, done?: boolean, expired?: boolean }} state Foutmelding, of het gelukt is en of de link niet meer werkt.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function resetPage({ error = '', done = false, expired = false } = {}, groups = []) {
  const form = done
    ? `<p role="status">Je wachtwoord is gewijzigd. Je bent op al je apparaten uitgelogd; log in met je nieuwe wachtwoord.</p><p><a class="button" href="${ROOT}inloggen/">Inloggen</a></p>`
    : expired
      ? `<p class="form-error" role="alert">${escapeHtml(error)}</p><p><a class="button" href="${ROOT}wachtwoord-vergeten/">Nieuwe link aanvragen</a></p>`
      : `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form" data-token-form>
<input type="hidden" name="token" value="">
${field({ name: 'password', label: 'Nieuw wachtwoord', type: 'password', autocomplete: 'new-password', hint: 'Minimaal 12 tekens.' })}
${field({ name: 'password2', label: 'Nieuw wachtwoord herhalen', type: 'password', autocomplete: 'new-password' })}
<button class="button" type="submit">Wachtwoord opslaan</button>
</form>`;
  return formPage({ title: 'Nieuw wachtwoord', heading: 'Nieuw wachtwoord kiezen', form, groups, aside: `Werkt de link niet meer? <a href="${ROOT}wachtwoord-vergeten/">Vraag een nieuwe aan</a>.`, script: 'account-link.js' });
}

/**
 * E-mailadres bevestigen met de link uit de mail: het script verstuurt het formulier meteen.
 * @param {{ error?: string, done?: boolean }} state Foutmelding en of het gelukt is.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function verifyPage({ error = '', done = false } = {}, groups = []) {
  const form = done
    ? `<p role="status">Bedankt, je e-mailadres is bevestigd.</p><p><a class="button" href="${ROOT}account/">Naar mijn account</a></p>`
    : `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form" data-token-form data-auto-submit>
<input type="hidden" name="token" value="">
<p>Een moment, we bevestigen je e-mailadres.</p>
<button class="button" type="submit">E-mailadres bevestigen</button>
</form>`;
  return formPage({ title: 'E-mailadres bevestigen', heading: 'E-mailadres bevestigen', form, groups, aside: `<a href="${ROOT}account/">Naar mijn account</a>`, script: error ? '' : 'account-link.js' });
}

/**
 * "Mijn account": wie is ingelogd, met knoppen naar de planner en het portaal.
 * @param {{ displayName: string, username: string, email: string, isCustomer: boolean }} viewer De ingelogde gebruiker.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @param {{ ordering?: boolean, profile?: object, error?: string, values?: object, requested?: boolean, verification?: object }} [options] ordering: bestellen staat aan, dus een knop naar de bestelhistorie; profile: klantgroep en bedrijfsgegevens uit het account; error/values: fout en ingevulde waarden van het aanvraagformulier; requested: de aanvraag is net verstuurd; verification: zie verificationSection.
 * @returns {string} De HTML-pagina.
 */
function accountPage(viewer, groups = [], { ordering = false, profile = {}, error = '', values = {}, requested = false, verification = {} } = {}) {
  const orders = ordering ? `<a class="button" href="${ROOT}bestellingen/">Mijn bestellingen</a>` : '';
  const portal = viewer.isCustomer ? `<a class="button secondary" href="${APP_ROOT}portaal/">Mijn portaal</a>` : '';
  const body = `<section class="account-card"><h1>Mijn account</h1>
<p>Ingelogd als <strong>${escapeHtml(viewer.displayName)}</strong> (${escapeHtml(viewer.username)}${viewer.email ? `, ${escapeHtml(viewer.email)}` : ''}).</p>
${verificationSection(viewer, verification)}
${businessSection(viewer, profile, { error, values, requested })}
<div class="account-actions">
${orders}
<a class="button" href="${APP_ROOT}beregening/">Naar de planner</a>
${portal}
<a class="button secondary" href="${APP_ROOT}profiel/">Mijn profiel</a>
</div>
<form method="post" action="${ROOT}uitloggen/"><button class="button secondary" type="submit">Uitloggen</button></form>
</section>`;
  return layout({ root: ROOT, title: 'Mijn account – Aquatechshop.nl', description: 'Je account bij Aquatechshop.nl.', body, groups });
}

/**
 * Laagdrempelige aanmelding voor de planner: alleen naam, e-mail en wachtwoord.
 * @param {{ error?: string, displayName?: string, email?: string }} state Foutmelding en eerder ingevulde waarden.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function plannerPage({ error = '', displayName = '', email = '' } = {}, groups = []) {
  const form = `<p>Ontwerp je eigen tuinberegening in de planner. Maak even een gratis account, dan ben je er zo.</p>
${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${field({ name: 'displayName', label: 'Naam', value: displayName, autocomplete: 'name' })}
${field({ name: 'email', label: 'E-mailadres', type: 'email', value: email, autocomplete: 'email' })}
${field({ name: 'password', label: 'Wachtwoord', type: 'password', autocomplete: 'new-password', hint: 'Minimaal 12 tekens.' })}
<input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
${captchaFields('planner_signup')}
<button class="button" type="submit">Account maken en naar de planner</button>
</form>`;
  return formPage({ title: 'Planner', heading: 'Naar de planner', form, groups,
    aside: `Al een account? <a href="${ROOT}inloggen/?volgende=planner">Log in</a>.` });
}

module.exports = { loginPage, registerPage, accountPage, plannerPage, forgotPage, resetPage, verifyPage };
