// Onzichtbare captcha (Google reCAPTCHA v3) voor openbare formulieren: de instelling `captcha` (aan/uit, sitesleutel,
// minimumscore, gedrag bij een onbereikbaar Google) met het geheim `captchaSecret`, het controleren van de token aan de
// serverkant en de uitgebreide Content-Security-Policy. Zonder sleutels (of met de schakelaar uit) doet dit bestand niets:
// de formulieren werken dan zoals voorheen en er staat niets van Google in de pagina.

/** Het adres waar Google een token controleert (vast, nooit uit invoer: geen SSRF). */
const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

/** Een sitesleutel van reCAPTCHA: begint met 6L en is 40 tekens lang. */
const SITE_KEY_PATTERN = /^6L[A-Za-z0-9_-]{38}$/;

/** Hoe lang we op Google wachten (ms) voordat het "onbereikbaar" heet. */
const VERIFY_TIMEOUT_MS = 4000;

/** De acties die een formulier mag melden (Google hoort de actienaam terug te geven). */
const ACTIONS = ['login', 'register', 'planner_signup', 'forgot_password', 'business_request', 'checkout', 'drawing_submit'];

/** Google-foutcodes die aan onze kant liggen (verkeerde of ontbrekende geheime sleutel): geen schuld van de bezoeker. */
const CONFIGURATION_ERRORS = ['missing-input-secret', 'invalid-input-secret'];

/**
 * Maakt van een ingevulde sitesleutel een schone waarde.
 * @param {*} raw Wat de beheerder invulde.
 * @returns {string} De sleutel, of leeg als het geen sitesleutel van reCAPTCHA lijkt.
 */
function cleanSiteKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  return SITE_KEY_PATTERN.test(key) ? key : '';
}

/**
 * Saneert de instelling `captcha`. Lege of onbruikbare invoer geeft de standaard (uit).
 * @param {*} raw De ingevoerde instelling.
 * @returns {{ enabled: boolean, siteKey: string, minScore: number, onUnreachable: string }} De gesaneerde instelling.
 */
function sanitizeCaptcha(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const score = Number(input.minScore);
  return {
    enabled: input.enabled === true,
    siteKey: cleanSiteKey(input.siteKey),
    // reCAPTCHA v3 geeft 0.0 (zeker een robot) tot 1.0 (zeker een mens); 0.5 is de aanbevolen start.
    minScore: Number.isFinite(score) ? Math.min(0.9, Math.max(0.1, Math.round(score * 10) / 10)) : 0.5,
    // Bij een onbereikbaar Google: doorlaten (standaard, de andere beveiligingen blijven gelden) of blokkeren.
    onUnreachable: input.onUnreachable === 'block' ? 'block' : 'allow',
  };
}

/**
 * De Content-Security-Policy met de Google-adressen van reCAPTCHA erbij. Alleen aanroepen als de captcha actief is:
 * zonder captcha blijft de policy exact zoals hij was.
 * @param {string} baseCsp De standaardpolicy (richtlijnen gescheiden door "; ").
 * @returns {string} De policy voor dit verzoek.
 */
function cspWith(baseCsp) {
  const additions = {
    'script-src': ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
    'connect-src': ['https://www.google.com/recaptcha/'],
    'frame-src': ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
  };
  const directives = baseCsp.split('; ');
  const seen = new Set();
  const extended = directives.map((directive) => {
    const [name] = directive.split(' ');
    seen.add(name);
    return additions[name] ? `${directive} ${additions[name].join(' ')}` : directive;
  });
  // Een richtlijn die er nog niet in staat (frame-src) valt anders terug op default-src ('none' of 'self'): zelf toevoegen.
  for (const name of Object.keys(additions)) if (!seen.has(name)) extended.push(`${name} ${additions[name].join(' ')}`);
  return extended.join('; ');
}

/**
 * Leest het antwoord van Google als gewone gegevens, of niets als het geen bruikbaar JSON-antwoord is.
 * @param {object} response Het antwoord van de fetch.
 * @returns {Promise<?object>} De gegevens, of null.
 */
async function readJson(response) {
  try {
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Maakt de captcha-dienst: instellingen per organisatie lezen, tokens controleren en melden wat er gebeurt.
 * @param {{ settingsFor: Function, fetchImpl?: Function, disabled?: boolean, report?: Function, now?: Function }} options settingsFor(tenantId) geeft de
 *   instellingen (get); fetchImpl de fetch (tests); disabled = noodschakelaar (omgeving CAPTCHA_DISABLED): alles uit;
 *   report(tenantId, event) krijgt { type: 'rejected'|'unreachable'|'misconfigured'|'ok', action, reason?, score? } (voor audit en bewaking).
 * @returns {{ activeOf: Function, publicOf: Function, check: Function, checkSecret: Function }} De dienst.
 */
function createCaptcha({ settingsFor, fetchImpl = globalThis.fetch, disabled = false, report = () => {} }) {
  /**
   * De bruikbare instelling van een organisatie: alleen als de captcha aan staat, de sleutel klopt en het geheim er is.
   * @param {string} tenantId De organisatie.
   * @returns {?{ siteKey: string, secret: string, minScore: number, onUnreachable: string }} De instelling, of null als er niet gecontroleerd wordt.
   */
  function activeOf(tenantId) {
    if (disabled || !tenantId) return null;
    const settings = settingsFor(tenantId);
    const setting = sanitizeCaptcha(settings.get('captcha'));
    const secret = settings.get('captchaSecret');
    if (!setting.enabled || !setting.siteKey || !secret) return null;
    return { siteKey: setting.siteKey, secret, minScore: setting.minScore, onUnreachable: setting.onUnreachable };
  }

  /**
   * Wat de browser mag weten: alleen de sitesleutel, en alleen als de captcha actief is. Het geheim gaat nooit mee.
   * @param {string} tenantId De organisatie.
   * @returns {?{ siteKey: string }} De openbare gegevens, of null.
   */
  function publicOf(tenantId) {
    const active = activeOf(tenantId);
    return active ? { siteKey: active.siteKey } : null;
  }

  /**
   * Vraagt Google om een token te controleren.
   * @param {string} secret Het geheim.
   * @param {string} token Het token van de browser.
   * @param {string} [remoteIp] Het adres van de bezoeker (helpt Google, mag leeg).
   * @returns {Promise<{ body: ?object }>} Het antwoord van Google; body null als Google onbereikbaar of onbruikbaar was.
   */
  async function askGoogle(secret, token, remoteIp) {
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const response = await fetchImpl(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      // Een serverfout van Google (5xx) of een ander dan JSON telt als onbereikbaar.
      if (!response.ok) return { body: null };
      return { body: await readJson(response) };
    } catch {
      return { body: null };
    }
  }

  /**
   * Controleert het token van een formulier. Zonder actieve captcha geslaagd zonder iets te vragen.
   * @param {string} tenantId De organisatie waarvan de instellingen gelden.
   * @param {{ token: *, action: string, remoteIp?: string }} input Het token uit het formulier, de verwachte actie en het adres.
   * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, message?: string }>} De uitkomst; bij een weigering een leesbare melding.
   */
  async function check(tenantId, { token, action, remoteIp = '' }) {
    const active = activeOf(tenantId);
    if (!active) return { ok: true, skipped: true };
    const clean = typeof token === 'string' ? token.trim() : '';
    if (!clean || clean.length > 4096) {
      report(tenantId, { type: 'rejected', action, reason: 'missing' });
      return { ok: false, reason: 'missing', message: 'De beveiligingscontrole is niet uitgevoerd. Zet JavaScript aan, schakel een eventuele adblocker voor deze pagina uit en probeer het opnieuw.' };
    }
    const { body } = await askGoogle(active.secret, clean, remoteIp);
    if (!body) return unreachable(tenantId, active, action, 'unreachable');
    const errors = Array.isArray(body['error-codes']) ? body['error-codes'].map(String) : [];
    if (errors.some((code) => CONFIGURATION_ERRORS.includes(code))) return unreachable(tenantId, active, action, 'misconfigured');
    if (body.success !== true) {
      report(tenantId, { type: 'rejected', action, reason: 'failed', errors: errors.slice(0, 5) });
      return { ok: false, reason: 'failed', message: 'De beveiligingscontrole is mislukt of verlopen. Probeer het opnieuw.' };
    }
    if (body.action !== action) {
      report(tenantId, { type: 'rejected', action, reason: 'wrong_action' });
      return { ok: false, reason: 'wrong_action', message: 'De beveiligingscontrole hoort niet bij dit formulier. Laad de pagina opnieuw en probeer het nog eens.' };
    }
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < active.minScore) {
      report(tenantId, { type: 'rejected', action, reason: 'low_score', score: Number.isFinite(score) ? score : null });
      return { ok: false, reason: 'low_score', message: 'We konden niet vaststellen dat je geen robot bent. Probeer het later opnieuw of neem contact met ons op.' };
    }
    report(tenantId, { type: 'ok', action, score });
    return { ok: true, score };
  }

  /**
   * De uitkomst als Google niet te bereiken is of de geheime sleutel niet klopt: volgens de instelling doorlaten of blokkeren,
   * en altijd melden (de bewaking laat dan een waarschuwing zien).
   * @param {string} tenantId De organisatie.
   * @param {{ onUnreachable: string }} active De instelling.
   * @param {string} action De actie van het formulier.
   * @param {string} reason 'unreachable' of 'misconfigured'.
   * @returns {{ ok: boolean, reason: string, message?: string, degraded: boolean }} De uitkomst.
   */
  function unreachable(tenantId, active, action, reason) {
    report(tenantId, { type: reason, action });
    if (active.onUnreachable === 'block') {
      return { ok: false, reason, degraded: true, message: 'De beveiligingscontrole is nu niet beschikbaar. Probeer het over enkele minuten opnieuw.' };
    }
    return { ok: true, reason, degraded: true };
  }

  /**
   * Controleert of het geheim bij Google bekend is, met een nepToken: Google antwoordt dan met "invalid-input-response" als het
   * geheim klopt en met "invalid-input-secret" als het niet klopt. Er wordt niets bewaard.
   * @param {string} secret Het te controleren geheim.
   * @returns {Promise<'ok'|'invalid'|'unreachable'>} De uitkomst.
   */
  async function checkSecret(secret) {
    const { body } = await askGoogle(secret, 'aquatech-sleutelcontrole');
    if (!body) return 'unreachable';
    const errors = Array.isArray(body['error-codes']) ? body['error-codes'].map(String) : [];
    if (errors.some((code) => CONFIGURATION_ERRORS.includes(code))) return 'invalid';
    return 'ok';
  }

  return { activeOf, publicOf, check, checkSecret };
}

module.exports = { VERIFY_URL, SITE_KEY_PATTERN, ACTIONS, cleanSiteKey, sanitizeCaptcha, cspWith, createCaptcha };
