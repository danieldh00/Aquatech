// HTML van het account in de eigen webshop (storefront.js): inloggen,
// registreren en "mijn account". Hetzelfde account werkt in de planner en het
// klantportaal. Alle adressen zijn relatief aan de pagina (/winkel/<pagina>/).

const { layout, escapeHtml } = require('./storefront-pages');

/** Relatief pad van deze pagina's naar de shop-startpagina. */
const ROOT = '../';
/** Relatief pad naar de hoofdmap van de app (planner, portaal, profiel). */
const APP_ROOT = '../../';

/**
 * Een invoerveld met label.
 * @param {{ name: string, label: string, type?: string, value?: string, autocomplete: string, hint?: string }} field Het veld.
 * @returns {string} HTML van het veld.
 */
function field({ name, label, type = 'text', value = '', autocomplete, hint = '' }) {
  return `<label class="form-field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}" required>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`;
}

/**
 * De pagina met een formulier in het kader van de shop.
 * @param {{ title: string, heading: string, form: string, aside: string, groups: object[] }} options Titel, kop, formulier, tekst eronder en menu.
 * @returns {string} De HTML-pagina.
 */
function formPage({ title, heading, form, aside, groups }) {
  const body = `<section class="account-card"><h1>${escapeHtml(heading)}</h1>${form}<p class="account-aside">${aside}</p></section>`;
  return layout({ root: ROOT, title: `${title} – Aquatechshop.nl`, description: `${heading} bij Aquatechshop.nl.`, body, groups });
}

/**
 * Inlogpagina.
 * @param {{ error?: string, login?: string, next?: string }} state Foutmelding, eerder ingevulde inlognaam en waar naartoe na het inloggen ('planner' of leeg).
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function loginPage({ error = '', login = '', next = '' } = {}, groups = []) {
  const form = `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${next === 'planner' ? '<input type="hidden" name="volgende" value="planner">' : ''}
${field({ name: 'login', label: 'E-mailadres of gebruikersnaam', value: login, autocomplete: 'username' })}
${field({ name: 'password', label: 'Wachtwoord', type: 'password', autocomplete: 'current-password' })}
<button class="button" type="submit">Inloggen</button>
</form>`;
  return formPage({ title: 'Inloggen', heading: 'Inloggen', form, groups,
    aside: `Nog geen account? <a href="${ROOT}registreren/">Registreer je</a>. Je account werkt ook in de planner en het klantportaal.` });
}

/**
 * Registratiepagina.
 * @param {{ error?: string, displayName?: string, email?: string }} state Foutmelding en eerder ingevulde waarden.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function registerPage({ error = '', displayName = '', email = '' } = {}, groups = []) {
  const form = `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="./" class="account-form">
${field({ name: 'displayName', label: 'Naam', value: displayName, autocomplete: 'name' })}
${field({ name: 'email', label: 'E-mailadres', type: 'email', value: email, autocomplete: 'email' })}
${field({ name: 'password', label: 'Wachtwoord', type: 'password', autocomplete: 'new-password', hint: 'Minimaal 12 tekens.' })}
${field({ name: 'password2', label: 'Wachtwoord herhalen', type: 'password', autocomplete: 'new-password' })}
<input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button class="button" type="submit">Account maken</button>
</form>`;
  return formPage({ title: 'Registreren', heading: 'Account maken', form, groups,
    aside: `Al een account? <a href="${ROOT}account/">Log in</a>. Met je account kun je ook je tuin ontwerpen in de planner.` });
}

/**
 * "Mijn account": wie is ingelogd, met knoppen naar de planner en het portaal.
 * @param {{ displayName: string, username: string, email: string, isCustomer: boolean }} viewer De ingelogde gebruiker.
 * @param {object[]} groups Alle hoofdcategorieën.
 * @returns {string} De HTML-pagina.
 */
function accountPage(viewer, groups = []) {
  const portal = viewer.isCustomer ? `<a class="button secondary" href="${APP_ROOT}portaal/">Mijn portaal</a>` : '';
  const body = `<section class="account-card"><h1>Mijn account</h1>
<p>Ingelogd als <strong>${escapeHtml(viewer.displayName)}</strong> (${escapeHtml(viewer.username)}${viewer.email ? `, ${escapeHtml(viewer.email)}` : ''}).</p>
<div class="account-actions">
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
<input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button class="button" type="submit">Account maken en naar de planner</button>
</form>`;
  return formPage({ title: 'Planner', heading: 'Naar de planner', form, groups,
    aside: `Al een account? <a href="${ROOT}inloggen/?volgende=planner">Log in</a>.` });
}

module.exports = { loginPage, registerPage, accountPage, plannerPage };
