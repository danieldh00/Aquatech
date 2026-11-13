// OAuth 2.1-server van de AI-koppeling: hiermee koppelt een medewerker Claude of ChatGPT aan zijn eigen account.
// - Ontdekken: /.well-known/oauth-protected-resource (RFC 9728) en /.well-known/oauth-authorization-server (RFC 8414).
// - Registreren: POST /app/oauth/register (RFC 7591, dynamisch). Een AI-app krijgt een ondertekend client_id waarin zijn
//   naam en terugkeeradressen staan (geen tabel nodig). Alleen terugkeeradressen van bekende AI-apps (claude.ai,
//   claude.com, chatgpt.com, chat.openai.com) of van de eigen computer (localhost) worden aangenomen.
// - Toestaan: GET/POST /app/oauth/authorize met PKCE (S256, verplicht). Niet ingelogd = eerst de gewone inlogpagina
//   (met tweestapsverificatie); daarna een toestemmingsscherm met de app, het account, de omgeving en wat de app mag.
// - Tokens: POST /app/oauth/token (autorisatiecode en vernieuwen) en POST /app/oauth/revoke (RFC 7009).
// De toestemmingen zelf staan in oauth-grants.js; Mijn profiel toont ze en trekt ze in (/api/account/connections).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PAGES_DIR } = require('../paths');
const { sha256, hostOf } = require('./oauth-grants');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');

/** Pad van de MCP-server binnen de app (de app staat onder /app). */
const MCP_PATH = '/app/mcp';
/** Wat een AI-app kan vragen, met de uitleg op het toestemmingsscherm en het recht dat de gebruiker ervoor nodig heeft. */
const SCOPES = {
  'klanten.lezen': { label: 'Klanten zoeken (naam, adres, e-mail, telefoon)', rights: ['offertes', 'klanten'] },
  'klanten.aanmaken': { label: 'Nieuwe klanten aanmaken (particulier, adres via de postcode)', rights: ['klanten'] },
  'artikelen.lezen': { label: 'Artikelen en verkoopprijzen opzoeken', rights: ['offertes', 'voorraad', 'werkorders'] },
  'offertes.concept': { label: 'Concept-offertes aanmaken (nooit versturen, wijzigen of verwijderen)', rights: ['offertes'] },
  'werkorders.concept': { label: 'Concept-werkorders aanmaken (status Nieuw, niet ingepland; nooit wijzigen of verwijderen)', rights: ['werkorders'] },
  'werkregistratie.boeken': { label: 'Uren en materiaal boeken op werkorders (alleen op je eigen naam; wijzigen of verwijderen doe je in AquaTech)', rights: ['werkorders'] },
  'status.lezen': { label: 'De status van offertes, werkorders, facturen en bestellingen opvragen (wat jouw rol mag zien)', rights: ['offertes', 'werkorders', 'facturen', 'beheer'] },
  'facturen.lezen': { label: 'Openstaande facturen en wat klanten nog moeten betalen bekijken', rights: ['facturen'] },
};
/** Bekende AI-apps: alleen naar deze hosts (via https) mag een autorisatiecode worden teruggestuurd. */
const KNOWN_APPS = { 'claude.ai': 'Claude', 'claude.com': 'Claude', 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT' };
/** De eigen computer (bijvoorbeeld Claude Code of Claude Desktop): http mag, elke poort (RFC 8252). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Hoelang het toestemmingsscherm geldig blijft. */
const CONSENT_TTL_MS = 10 * 60 * 1000;
/** Hoeveel openstaande toestemmingsschermen er tegelijk mogen zijn (geheugen). */
const MAX_PENDING = 2000;

const TEMPLATE = fs.readFileSync(path.join(PAGES_DIR, 'koppelen.html'), 'utf8');
const LOGO = (/<div class="logo">(<img [^>]+>)<\/div>/.exec(fs.readFileSync(path.join(PAGES_DIR, 'login.html'), 'utf8')) || [])[1] || '<strong style="color:#fff">AquaTech Service</strong>';

/**
 * Maakt tekst veilig voor HTML.
 * @param {*} value De tekst.
 * @returns {string} De ontsnapte tekst.
 */
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/**
 * Het webadres uit de Host-kop van het verzoek (https achter de tunnel), alleen met een geldige hostnaam. Alleen de
 * terugval zolang er in Beheer geen webadres is ingevuld (zie publicOrigin in registerOAuthRoutes).
 * @param {object} req Het verzoek.
 * @returns {string} Bijvoorbeeld https://aquatech.den-hollander.com (zonder slash).
 */
function requestOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const safeHost = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) || /^\[[0-9a-f:]+\](:\d{1,5})?$/.test(host) ? host : 'localhost';
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${safeHost}`;
}

/**
 * Controleert een terugkeeradres van een AI-app: https naar een bekende AI-app, of de eigen computer.
 * @param {*} value Het adres.
 * @returns {URL|null} Het adres, of null als het niet mag.
 */
function allowedRedirect(value) {
  const text = String(value || '');
  if (!text || text.length > 300) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash || text.includes('#')) return null;
  if (url.protocol === 'https:' && KNOWN_APPS[url.hostname] && !url.port) return url;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/**
 * De naam van de app zoals het toestemmingsscherm hem toont: bij een bekende host die naam (niet wat de app zelf opgeeft).
 * @param {string} redirectUri Het terugkeeradres.
 * @param {string} clientName De naam die de app bij het registreren opgaf.
 * @returns {string} Bijvoorbeeld "Claude" of "Programma op je eigen computer (Claude Code)".
 */
function appLabel(redirectUri, clientName) {
  let host = '';
  try { host = new URL(redirectUri).hostname; } catch { host = ''; }
  if (KNOWN_APPS[host]) return KNOWN_APPS[host];
  return `Programma op je eigen computer${clientName ? ` (${clientName})` : ''}`;
}

/**
 * Leest de gevraagde rechten (scope). Leeg = alles.
 * @param {*} value De scope uit het verzoek.
 * @returns {string[]|null} De rechten, of null bij een onbekend recht.
 */
function parseScope(value) {
  const requested = String(value || '').split(/\s+/).filter(Boolean);
  if (!requested.length) return Object.keys(SCOPES);
  if (requested.length > 10 || requested.some((scope) => !SCOPES[scope])) return null;
  return [...new Set(requested)];
}

/**
 * Welke van de gevraagde rechten deze gebruiker met zijn rol ook echt heeft.
 * @param {string[]} scopes De gevraagde rechten.
 * @param {object} user De gebruiker.
 * @param {Function} can can(user, recht) uit roles.js.
 * @returns {string[]} De rechten die overblijven.
 */
const scopesFor = (scopes, user, can) => scopes.filter((scope) => SCOPES[scope].rights.some((right) => can(user, right)));

/**
 * Eén waarde uit de querystring of het formulier (een herhaalde parameter telt als ongeldig).
 * @param {object} source req.query of req.body.
 * @param {string} name De naam.
 * @returns {string} De waarde (leeg als hij ontbreekt of herhaald is).
 */
const single = (source, name) => {
  const value = source ? source[name] : undefined;
  return typeof value === 'string' ? value : '';
};

/**
 * Registreert de OAuth-routes van de AI-koppeling.
 * @param {object} app De Express-app.
 * @param {object} ctx { grants (createOAuthGrants), publicOrigin() (vast webadres zonder slash, of leeg), signValue(doel, waarde), identify(req), sendLogin(req, res), connectorOn(tenantId),
 *   can(user, recht), accountOf(userId) (de gebruiker uit de database), fingerprintOf(passwordHash), environmentName(tenantId),
 *   userForGrant(grant), familyOf(user), isCustomer(req, user) (klant of gast), themeCss(tenantId), audit(req, actie, detail, gebruiker, omgeving) }.
 * @returns {{ resourceOf: Function, originOf: Function, verifyClient: Function }} Hulpfuncties voor de MCP-server.
 */
function registerOAuthRoutes(app, ctx) {
  const { grants } = ctx;

  /**
   * Het webadres van deze server voor issuer, resource, de iss in de redirect en links in toolantwoorden: het vaste
   * webadres uit Beheer (publicOrigin) zodra dat is ingevuld, anders de (gecontroleerde) Host-kop.
   * @param {object} req Het verzoek.
   * @returns {string} Het adres zonder slash achteraan.
   */
  const originOf = (req) => (ctx.publicOrigin && ctx.publicOrigin()) || requestOrigin(req);
  /**
   * Het adres van de MCP-server (de "resource" waar de tokens voor gelden).
   * @param {object} req Het verzoek.
   * @returns {string} Het adres.
   */
  const resourceOf = (req) => `${originOf(req)}${MCP_PATH}`;
  const pending = new Map();

  /**
   * Maakt het client_id van een AI-app: naam en terugkeeradressen, ondertekend met het servergeheim.
   * @param {string} name De naam.
   * @param {string[]} redirectUris De terugkeeradressen.
   * @returns {string} Het client_id.
   */
  function signClient(name, redirectUris) {
    const payload = Buffer.from(JSON.stringify({ n: name, r: redirectUris, t: Math.floor(Date.now() / 1000) })).toString('base64url');
    return `aqtc_${payload}.${ctx.signValue('oauth-client', payload)}`;
  }

  /**
   * Leest en controleert een client_id.
   * @param {*} clientId Het client_id.
   * @returns {{ id: string, hash: string, name: string, redirectUris: string[] }|null} De app, of null als het id niet van deze server is.
   */
  function verifyClient(clientId) {
    const match = /^aqtc_([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(String(clientId || ''));
    if (!match) return null;
    const expected = Buffer.from(ctx.signValue('oauth-client', match[1]));
    const given = Buffer.from(match[2]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (!Array.isArray(data.r)) return null;
      return { id: clientId, hash: sha256(clientId), name: String(data.n || ''), redirectUris: data.r.map(String) };
    } catch {
      return null;
    }
  }

  /**
   * Stuurt een pagina in de huisstijl (toestemming, foutmelding).
   * @param {object} res Het antwoord.
   * @param {number} status De HTTP-status.
   * @param {string} title De titel.
   * @param {string} body De inhoud (al veilige HTML).
   * @param {{ tenantId?: string, formTarget?: string }} [options] Omgeving voor het kleurthema; formTarget = extra adres waar het formulier na een redirect heen mag (CSP form-action).
   * @returns {void}
   */
  function sendPage(res, status, title, body, { tenantId, formTarget } = {}) {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    if (formTarget) {
      const csp = String(res.getHeader('Content-Security-Policy') || '');
      res.setHeader('Content-Security-Policy', csp.replace("form-action 'self'", `form-action 'self' ${formTarget}`));
    }
    const css = ctx.themeCss ? ctx.themeCss(tenantId) : '';
    const html = TEMPLATE.replace('{{title}}', escapeHtml(title)).replace('{{logo}}', LOGO).replace('{{body}}', body);
    res.type('html').send(css ? html.replace('</head>', `  <style>${css}</style>\n</head>`) : html);
  }

  /**
   * Een foutpagina (bijvoorbeeld een onbekende app): die stuurt nooit door naar de app, want het terugkeeradres is niet te vertrouwen.
   * @param {object} res Het antwoord.
   * @param {number} status De HTTP-status.
   * @param {string} message De uitleg.
   * @param {string} [tenantId] Omgeving voor het kleurthema.
   * @returns {void}
   */
  const errorPage = (res, status, message, tenantId) => sendPage(res, status, 'Koppelen niet gelukt',
    `<h1>Koppelen niet gelukt</h1><p class="error">${escapeHtml(message)}</p><p class="muted">Sluit dit venster en probeer het opnieuw vanuit de app.</p>`, { tenantId });

  /**
   * Stuurt terug naar de AI-app met een uitkomst (code of fout) en de state.
   * @param {object} res Het antwoord.
   * @param {string} redirectUri Het (gecontroleerde) terugkeeradres.
   * @param {object} params De parameters.
   * @param {object} req Het verzoek (voor de issuer).
   * @returns {void}
   */
  function backToApp(res, redirectUri, params, req) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, iss: originOf(req) })) if (value) url.searchParams.set(key, value);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url.toString());
  }

  /**
   * Ruimt verlopen toestemmingsschermen op en houdt de lijst begrensd.
   * @returns {void}
   */
  function prunePending() {
    const now = Date.now();
    for (const [id, entry] of pending) if (entry.expires <= now) pending.delete(id);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
  }

  // ---------- Ontdekken (buiten /app, zie server.js) ----------
  /**
   * De gegevens van deze autorisatieserver (RFC 8414).
   * @param {object} req Het verzoek.
   * @returns {object} De metadata.
   */
  const serverMetadata = (req) => {
    const origin = originOf(req);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/app/oauth/authorize`,
      token_endpoint: `${origin}/app/oauth/token`,
      registration_endpoint: `${origin}/app/oauth/register`,
      revocation_endpoint: `${origin}/app/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: Object.keys(SCOPES),
      authorization_response_iss_parameter_supported: true,
    };
  };
  /**
   * De gegevens van de MCP-server als beschermde bron (RFC 9728).
   * @param {object} req Het verzoek.
   * @returns {object} De metadata.
   */
  const resourceMetadata = (req) => ({
    resource: resourceOf(req),
    authorization_servers: [originOf(req)],
    scopes_supported: Object.keys(SCOPES),
    bearer_methods_supported: ['header'],
    resource_name: 'AquaTech',
  });
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/app'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(serverMetadata(req));
  });
  app.get(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(resourceMetadata(req));
  });

  // ---------- Registreren (RFC 7591) ----------
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `oauth-register:${clientKey(req)}` });
  app.post('/oauth/register', registerLimiter, express.json({ limit: '8kb' }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 3) return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Geef één tot drie terugkeeradressen (redirect_uris).' });
    const checked = uris.map(allowedRedirect);
    if (checked.some((url) => !url)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Alleen Claude, ChatGPT of een programma op de eigen computer (localhost) kunnen koppelen.' });
    }
    const types = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
    if (!types.includes('authorization_code') || types.some((type) => type !== 'authorization_code' && type !== 'refresh_token')) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Alleen authorization_code en refresh_token worden ondersteund.' });
    }
    const name = String(body.client_name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
    const redirectUris = uris.map(String);
    const clientId = signClient(name, redirectUris);
    res.status(201).json({
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: Object.keys(SCOPES).join(' '),
    });
  });

  // ---------- Toestaan ----------
  /**
   * Controleert een autorisatieverzoek tot het punt waarop de app terug te sturen is.
   * @param {object} query De parameters.
   * @returns {{ client: object, redirectUri: string }|{ page: string }} De app en het adres, of de melding voor een foutpagina.
   */
  function checkClient(query) {
    const client = verifyClient(single(query, 'client_id'));
    if (!client) return { page: 'Deze app is niet (meer) bekend bij AquaTech. Verwijder de koppeling in de app en voeg hem opnieuw toe.' };
    const redirectUri = single(query, 'redirect_uri') || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!client.redirectUris.includes(redirectUri) || !allowedRedirect(redirectUri)) return { page: 'Het terugkeeradres van deze app klopt niet.' };
    return { client, redirectUri };
  }

  app.get('/oauth/authorize', (req, res) => {
    const checked = checkClient(req.query);
    if (checked.page) return errorPage(res, 400, checked.page);
    const { client, redirectUri } = checked;
    const state = single(req.query, 'state').slice(0, 500);
    /**
     * Stuurt de app terug met een fout.
     * @param {string} error De OAuth-foutcode.
     * @param {string} description De uitleg.
     * @returns {void}
     */
    const fail = (error, description) => backToApp(res, redirectUri, { error, error_description: description, state }, req);
    if (single(req.query, 'response_type') !== 'code') return fail('unsupported_response_type', 'Alleen response_type=code.');
    const challenge = single(req.query, 'code_challenge');
    if (single(req.query, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'PKCE met S256 is verplicht.');
    const resource = single(req.query, 'resource');
    if (resource && resource.replace(/\/$/, '') !== resourceOf(req)) return fail('invalid_target', 'Onbekende server (resource).');
    const scopes = parseScope(single(req.query, 'scope'));
    if (!scopes) return fail('invalid_scope', 'Onbekend recht gevraagd.');
    const user = ctx.identify(req);
    if (!user) return ctx.sendLogin(req, res);
    if (user.kind !== 'account' || user.impersonator || user.impersonation) return errorPage(res, 403, 'Koppel een AI-app alleen vanuit je eigen account (niet als gast, met de toegangscode of terwijl je meekijkt).', req.tenantId);
    if (!ctx.connectorOn(req.tenantId)) return errorPage(res, 403, 'De AI-koppeling staat uit in deze omgeving. Een beheerder zet hem aan in Beheer > Instellingen > AI-koppeling.', req.tenantId);
    if (ctx.isCustomer(req, user)) return errorPage(res, 403, 'De AI-koppeling is alleen voor medewerkers.', req.tenantId);
    if (!ctx.can(user, 'offertes')) return errorPage(res, 403, 'Je rol mag geen offertes maken, dus koppelen heeft geen zin. Vraag een beheerder om het recht Offertes.', req.tenantId);
    const allowed = scopesFor(scopes, user, ctx.can);
    prunePending();
    const id = crypto.randomBytes(24).toString('base64url');
    pending.set(id, { clientIdHash: client.hash, clientName: client.name, redirectUri, state, challenge, scopes: allowed, resource: resourceOf(req),
      userId: user.id, tenantId: req.tenantId, expires: Date.now() + CONSENT_TTL_MS });
    const label = appLabel(redirectUri, client.name);
    const environment = ctx.environmentName(req.tenantId);
    const body = `<h1>${escapeHtml(label)} koppelen aan AquaTech</h1>
      <p class="muted">${escapeHtml(label)} wil namens jou in AquaTech werken. Sta dit alleen toe als je dit zelf net in de app hebt gevraagd.</p>
      <dl><dt>Account</dt><dd>${escapeHtml(user.display_name || user.username)}</dd>
        <dt>Omgeving</dt><dd>${escapeHtml(environment)}</dd>
        <dt>Terug naar</dt><dd>${escapeHtml(hostOf(redirectUri))}</dd></dl>
      <p><strong>De app mag:</strong></p>
      <ul>${allowed.map((scope) => `<li>${escapeHtml(SCOPES[scope].label)}</li>`).join('')}</ul>
      <p class="warn">Een AI kan zich vergissen. De app maakt alleen <strong>concepten</strong>; jij controleert de offerte en verstuurt hem zelf. Intrekken kan altijd in Mijn profiel.</p>
      <form method="post" action="authorize">
        <input type="hidden" name="request" value="${escapeHtml(id)}">
        <input type="hidden" name="csrf" value="${escapeHtml(ctx.signValue('oauth-consent', `${id}:${user.id}`))}">
        <div class="actions"><button type="submit" name="decision" value="deny">Weigeren</button><button class="primary" type="submit" name="decision" value="allow">Toestaan</button></div>
      </form>`;
    sendPage(res, 200, `${label} koppelen`, body, { tenantId: req.tenantId, formTarget: new URL(redirectUri).origin });
  });

  app.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 }), (req, res) => {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return errorPage(res, 403, 'Verzoek van een andere site geweigerd.');
    const id = single(req.body, 'request');
    const entry = pending.get(id);
    pending.delete(id);
    if (!entry || entry.expires <= Date.now()) return errorPage(res, 400, 'Dit toestemmingsscherm is verlopen.');
    const user = ctx.identify(req);
    const expected = user ? ctx.signValue('oauth-consent', `${id}:${user.id}`) : '';
    const given = single(req.body, 'csrf');
    if (!user || user.id !== entry.userId || req.tenantId !== entry.tenantId || expected.length !== given.length
      || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
      return errorPage(res, 403, 'Je bent intussen met een ander account of in een andere omgeving ingelogd.', req.tenantId);
    }
    const host = hostOf(entry.redirectUri);
    if (single(req.body, 'decision') !== 'allow') {
      ctx.audit(req, 'ai_koppeling_geweigerd', { app: host });
      return backToApp(res, entry.redirectUri, { error: 'access_denied', error_description: 'De gebruiker heeft geweigerd.', state: entry.state }, req);
    }
    if (!ctx.connectorOn(req.tenantId) || ctx.isCustomer(req, user) || !ctx.can(user, 'offertes')) return errorPage(res, 403, 'Koppelen mag (nu) niet in deze omgeving.', req.tenantId);
    const account = ctx.accountOf(user.id);
    if (!account || !account.password_hash) return errorPage(res, 403, 'Koppel een AI-app alleen vanuit je eigen account.', req.tenantId);
    const { code } = grants.createCode({
      tenantId: entry.tenantId, userId: user.id, clientIdHash: entry.clientIdHash, clientName: appLabel(entry.redirectUri, entry.clientName), redirectUri: entry.redirectUri,
      scope: entry.scopes.join(' '), resource: entry.resource, fingerprint: ctx.fingerprintOf(account.password_hash), codeChallenge: entry.challenge,
    });
    ctx.audit(req, 'ai_koppeling_toegestaan', { app: host, rechten: entry.scopes.join(' ') });
    return backToApp(res, entry.redirectUri, { code, state: entry.state }, req);
  });

  // ---------- Tokens ----------
  const tokenLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120, keyFn: (req) => `oauth-token:${clientKey(req)}` });
  /**
   * Een OAuth-fout van het tokeneindpunt (RFC 6749, 5.2).
   * @param {object} res Het antwoord.
   * @param {number} status De HTTP-status.
   * @param {string} error De foutcode.
   * @param {string} description De uitleg.
   * @returns {object} Het antwoord.
   */
  const tokenError = (res, status, error, description) => res.status(status).json({ error, error_description: description });
  const tokenBody = [express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 20 }), express.json({ limit: '8kb' })];

  app.post('/oauth/token', tokenLimiter, tokenBody, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const client = verifyClient(single(body, 'client_id'));
    if (!client) return tokenError(res, 401, 'invalid_client', 'Onbekende app (client_id).');
    const grantType = single(body, 'grant_type');
    let out;
    if (grantType === 'authorization_code') {
      out = grants.exchangeCode({ code: single(body, 'code'), clientIdHash: client.hash, redirectUri: single(body, 'redirect_uri'),
        codeVerifier: single(body, 'code_verifier'), resource: single(body, 'resource').replace(/\/$/, '') });
    } else if (grantType === 'refresh_token') {
      out = grants.refresh({ refreshToken: single(body, 'refresh_token'), clientIdHash: client.hash, resource: single(body, 'resource').replace(/\/$/, '') });
    } else {
      return tokenError(res, 400, 'unsupported_grant_type', 'Alleen authorization_code en refresh_token.');
    }
    if (out.error) return tokenError(res, 400, out.error, out.description);
    // Is het account intussen uitgeschakeld, het wachtwoord gewijzigd of de koppeling uitgezet: dan geen tokens meer.
    if (!ctx.userForGrant(out.grant)) {
      grants.revoke(out.grant.tenantId, out.grant.id);
      return tokenError(res, 400, 'invalid_grant', 'Deze koppeling geldt niet meer. Koppel de app opnieuw.');
    }
    res.json({ access_token: out.tokens.accessToken, token_type: 'Bearer', expires_in: out.tokens.expiresIn, refresh_token: out.tokens.refreshToken, scope: out.grant.scope });
  });

  app.post('/oauth/revoke', tokenLimiter, tokenBody, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const client = verifyClient(single(body, 'client_id'));
    if (!client) return tokenError(res, 401, 'invalid_client', 'Onbekende app (client_id).');
    grants.revokeByToken(single(body, 'token'), client.hash);
    res.status(200).json({});
  });

  // ---------- Mijn profiel: gekoppelde apps ----------
  /**
   * De gebruiker voor Mijn profiel: alleen een eigen account (niet meekijkend). Een klant mag de lijst niet zien
   * (alleen intern), maar wel een oude koppeling intrekken (bijvoorbeeld van toen het account nog medewerker was).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {{ allowCustomer?: boolean }} [options] allowCustomer: ook voor een klant (alleen bij intrekken).
   * @returns {object|null} De gebruiker, of null als er al is geantwoord.
   */
  const ownAccount = (req, res, { allowCustomer = false } = {}) => {
    const user = ctx.identify(req);
    if (!user) { res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' }); return null; }
    if (user.kind !== 'account' || user.impersonator || user.impersonation) { res.status(403).json({ error: 'forbidden', message: 'Alleen met je eigen account.' }); return null; }
    if (!allowCustomer && ctx.isCustomer(req, user)) { res.status(403).json({ error: 'internal_only', message: 'De AI-koppeling is alleen voor medewerkers.' }); return null; }
    return user;
  };
  app.get('/api/account/connections', (req, res) => {
    const user = ownAccount(req, res);
    if (!user) return;
    res.json({ items: grants.listForUser(ctx.familyOf(user), user.id), available: ctx.connectorOn(req.tenantId) && ctx.can(user, 'offertes'), url: resourceOf(req) });
  });
  app.delete('/api/account/connections/:id', (req, res) => {
    const user = ownAccount(req, res, { allowCustomer: true });
    if (!user) return;
    if (!grants.revokeForUser(ctx.familyOf(user), user.id, req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Koppeling niet gevonden.' });
    ctx.audit(req, 'ai_koppeling_ingetrokken', { grantId: req.params.id });
    res.json({ ok: true });
  });

  return { resourceOf, originOf, verifyClient };
}

module.exports = { registerOAuthRoutes, allowedRedirect, parseScope, scopesFor, requestOrigin, SCOPES, MCP_PATH };
