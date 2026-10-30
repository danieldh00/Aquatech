// HTTP-client voor de API-tests: bewaart cookies zoals een browser (sessie,
// gast, omgeving) en geeft per verzoek de status en de JSON terug. Gedeeld
// door alle testbestanden die de server via fetch aanspreken; daarnaast
// listen() (testserver starten) en createLogin() (ingelogde client per account).
const assert = require('node:assert');

/**
 * Werkt de cookiepot bij met de Set-Cookie-koppen van een antwoord. Een lege
 * waarde of Max-Age=0 wist de cookie.
 * @param {Map<string, string>} jar De cookies (naam → waarde).
 * @param {string[]} setCookies De Set-Cookie-koppen.
 * @returns {void}
 */
function storeCookies(jar, setCookies) {
  for (const header of setCookies) {
    const [nameValue] = header.split(';');
    const separator = nameValue.indexOf('=');
    const name = nameValue.slice(0, separator);
    const value = nameValue.slice(separator + 1);
    if (!value || /Max-Age=0/i.test(header)) jar.delete(name);
    else jar.set(name, value);
  }
}

/**
 * Maakt een client voor één (nep)browser.
 * @param {string} baseUrl Adres van de testserver, bijv. http://127.0.0.1:1234.
 * @param {{ jar?: Map<string, string>, emptyJsonBody?: boolean, followRedirects?: boolean }} [options]
 *   jar: een bestaande cookiepot (zelfde browser); emptyJsonBody: POST zonder
 *   body stuurt `{}` als JSON (standaard aan; uit om een verzoek zonder JSON te
 *   testen); followRedirects: uit om een doorverwijzing zelf te bekijken (location).
 * @returns {object} jar, request, get, post, put, patch, del en login; elk geeft
 *   { status, body (JSON of null), text, raw (Buffer), type (Content-Type), size, location, headers }.
 */
function createClient(baseUrl, { jar = new Map(), emptyJsonBody = true, followRedirects = true } = {}) {
  /**
   * Doet één verzoek met de cookies van deze client.
   * @param {string} method HTTP-methode.
   * @param {string} urlPath Pad (met query), bijv. /api/me.
   * @param {*} [body] Wordt als JSON verstuurd (undefined = geen body).
   * @param {object} [extraHeaders] Extra koppen.
   * @returns {Promise<{ status: number, body: *, text: string, raw: Buffer, type: string, size: number, location: string, headers: Headers }>} Het antwoord.
   */
  async function request(method, urlPath, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(baseUrl + urlPath, { method, headers, redirect: followRedirects ? 'follow' : 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    storeCookies(jar, response.headers.getSetCookie());
    const raw = Buffer.from(await response.arrayBuffer());
    const text = raw.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* geen JSON */ }
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: json, text, raw, type, size: raw.length, location: response.headers.get('location') || '', headers: response.headers };
  }

  return {
    jar,
    request,
    /**
     * GET-verzoek.
     * @param {string} urlPath Pad.
     * @param {object} [headers] Extra koppen.
     * @returns {Promise<object>} Het antwoord.
     */
    get: (urlPath, headers) => request('GET', urlPath, undefined, headers),
    /**
     * POST-verzoek (zonder body standaard `{}`, zie emptyJsonBody).
     * @param {string} urlPath Pad.
     * @param {*} [body] JSON-body.
     * @param {object} [headers] Extra koppen.
     * @returns {Promise<object>} Het antwoord.
     */
    post: (urlPath, body, headers) => request('POST', urlPath, body === undefined && emptyJsonBody ? {} : body, headers),
    /**
     * PUT-verzoek.
     * @param {string} urlPath Pad.
     * @param {*} [body] JSON-body.
     * @param {object} [headers] Extra koppen.
     * @returns {Promise<object>} Het antwoord.
     */
    put: (urlPath, body, headers) => request('PUT', urlPath, body, headers),
    /**
     * PATCH-verzoek.
     * @param {string} urlPath Pad.
     * @param {*} [body] JSON-body.
     * @param {object} [headers] Extra koppen.
     * @returns {Promise<object>} Het antwoord.
     */
    patch: (urlPath, body, headers) => request('PATCH', urlPath, body, headers),
    /**
     * DELETE-verzoek.
     * @param {string} urlPath Pad.
     * @param {*} [body] JSON-body (bijv. een bevestiging).
     * @param {object} [headers] Extra koppen.
     * @returns {Promise<object>} Het antwoord.
     */
    del: (urlPath, body, headers) => request('DELETE', urlPath, body, headers),
    /**
     * Inloggen met een account.
     * @param {string} username Gebruikersnaam.
     * @param {string} password Wachtwoord.
     * @param {string} [tenant] Organisatiecode (leeg = hoofdtenant).
     * @returns {Promise<object>} Het antwoord.
     */
    login: (username, password, tenant = '') => request('POST', '/api/auth/login', { username, password, tenant }),
  };
}

/**
 * Start een app op een vrije poort van 127.0.0.1.
 * @param {import('express').Express} app De app uit createApp().
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * Maakt een inlogfunctie voor één testserver: elke aanroep geeft een nieuwe,
 * ingelogde client. Het inloggen moet slagen (anders faalt de test).
 * @param {string} baseUrl Adres van de testserver.
 * @param {{ password: string, extraBody?: object, organizationField?: string, clientOptions?: object }} options
 *   password: wachtwoord van alle testaccounts; extraBody: extra velden in het
 *   inlogverzoek; organizationField: naam van het veld voor de organisatiecode
 *   (standaard tenant); clientOptions: opties voor createClient.
 * @returns {(username: string, organization?: string) => Promise<object>} Inlogfunctie die de client teruggeeft.
 */
function createLogin(baseUrl, { password, extraBody = {}, organizationField = 'tenant', clientOptions = {} }) {
  /**
   * Logt in als een testaccount.
   * @param {string} username Gebruikersnaam.
   * @param {string} [organization] Organisatiecode (leeg = hoofdtenant).
   * @returns {Promise<object>} De ingelogde client.
   */
  return async function loginAs(username, organization) {
    const client = createClient(baseUrl, clientOptions);
    const response = await client.post('/api/auth/login', { username, password, ...extraBody, [organizationField]: organization });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    return client;
  };
}

/**
 * Verstuurt een formulier zoals een browser (urlencoded) met de cookies van een client.
 * @param {string} base Adres van de testserver.
 * @param {object} client De client (cookiepot).
 * @param {string} urlPath Pad van het formulier.
 * @param {object} fields De velden.
 * @param {object} [headers] Extra koppen.
 * @returns {Promise<{ status: number, location: string, text: string }>} Het antwoord (zonder redirect te volgen).
 */
async function postForm(base, client, urlPath, fields, headers = {}) {
  const cookie = [...client.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(base + urlPath, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers } });
  storeCookies(client.jar, response.headers.getSetCookie());
  return { status: response.status, location: response.headers.get('location') || '', text: await response.text() };
}

module.exports = { createClient, storeCookies, listen, createLogin, postForm };
