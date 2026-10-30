// Accounts van de webshop (storefront.js). Er is één accountsysteem: wie zich
// in de shop registreert krijgt een account met de rol klant in de planner,
// en inloggen in de shop gebruikt dezelfde sessie als de rest van de app.

const { createRateLimiter } = require('../beveiliging/rate-limit');
const { remoteIp } = require('../beveiliging/auth');

/** Mislukte inlogpogingen per gebruiker waarna de gebruiker tijdelijk is geblokkeerd. */
const LOGIN_MAX_FAILURES = 10;

/**
 * Maakt de accountfuncties van de webshop.
 * @param {{ store: object, auth: object, tenant: object, audit: Function, clearEnvironment: Function, impersonation: object, lockedOut: Function, failed: Function, failures: Map }} deps Opslag, sessies, de hoofdtenant waar de shop bij hoort en de blokkering van het hoofdinlogscherm.
 * @returns {{ viewer: Function, login: Function, register: Function, logout: Function, limited: Function }} De functies.
 */
function createShopAccounts({ store, auth, tenant, audit, clearEnvironment, impersonation, lockedOut, failed, failures }) {
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyFn: (req) => `login:${remoteIp(req)}` });
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyFn: (req) => `register:${remoteIp(req)}` });

  /**
   * Past een limiet toe zonder JSON-antwoord: zegt of het verzoek te veel is.
   * @param {Function} limiter De limiet-middleware.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord (alleen de Retry-After-kop wordt gezet).
   * @returns {boolean} true als het verzoek geweigerd moet worden.
   */
  function limited(limiter, req, res) {
    let refused = false;
    limiter(req, { setHeader: (name, value) => res.setHeader(name, value), status: () => ({ json: () => { refused = true; } }) }, () => {});
    return refused;
  }

  /**
   * Wie is er ingelogd (met een eigen account)?
   * @param {object} req Het verzoek.
   * @returns {{ id: string, displayName: string, username: string, email: string, isCustomer: boolean }|null} De gebruiker, of null.
   */
  function viewer(req) {
    const session = auth.session(req);
    const user = session?.via === 'user' ? session.user : null;
    if (!user || user.kind !== 'account' || user.tenant_id !== tenant.id) return null;
    return { id: user.id, displayName: user.display_name, username: user.username, email: user.email || '', customerGroup: user.customer_group || '',
      isCustomer: store.roles.keysOfKind(user.tenant_id, 'klant').includes(user.role) };
  }

  /**
   * Zet de sessie voor een gebruiker (zoals bij het gewone inloggen).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {object} user Het account.
   * @returns {void}
   */
  function startSession(req, res, user) {
    impersonation.stop(req, res, 'opnieuw_ingelogd');
    auth.setCookie(req, res, user.id);
    clearEnvironment(req, res);
  }

  /**
   * Logt in met gebruikersnaam of e-mailadres, alleen in de tenant van de shop.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {{ login: string, password: string }} fields De ingevulde velden.
   * @returns {Promise<{ user: object }|{ error: string, status: number }>} Het account of een foutmelding.
   */
  async function login(req, res, { login: typed, password }) {
    if (limited(loginLimiter, req, res)) return { error: 'Te veel pogingen. Probeer het over een kwartier opnieuw.', status: 429 };
    const username = store.loginNameFor(tenant.id, String(typed ?? '').slice(0, 200)).slice(0, 60);
    const key = `${tenant.id}:${username}`;
    if (lockedOut(key, LOGIN_MAX_FAILURES)) {
      audit(req, 'inloggen_geblokkeerd', { username, via: 'winkel' }, null, tenant.id);
      return { error: 'Te veel mislukte pogingen voor dit account. Probeer het over een kwartier opnieuw.', status: 429 };
    }
    const found = await store.authenticate(tenant.id, username, String(password ?? '').slice(0, 1024));
    const user = found && found.tenant_id === tenant.id ? found : null;
    if (!user) {
      failed(key);
      audit(req, 'inloggen_mislukt', { username, via: 'winkel' }, null, tenant.id);
      return { error: 'Onjuist e-mailadres, gebruikersnaam of wachtwoord.', status: 401 };
    }
    failures.delete(key);
    startSession(req, res, user);
    audit(req, 'ingelogd', { via: 'winkel' }, user.id, user.tenant_id);
    return { user };
  }

  /**
   * Registreert een nieuwe klant en logt die meteen in.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {{ displayName: string, email: string, password: string, password2: string, website: string }} fields De ingevulde velden (website = verborgen valstrikveld).
   * @returns {Promise<{ user?: object, skipped?: boolean, error?: string, status?: number }>} Het account, skipped bij een bot, of een foutmelding.
   */
  async function register(req, res, fields) {
    if (limited(registerLimiter, req, res)) return { error: 'Te veel registraties vanaf dit adres. Probeer het later opnieuw.', status: 429 };
    if (fields.website) return { skipped: true };
    if (fields.password2 !== undefined && String(fields.password ?? '') !== String(fields.password2)) return { error: 'De wachtwoorden zijn niet gelijk.', status: 400 };
    const out = await store.createShopCustomer(tenant.id, { displayName: fields.displayName, email: fields.email, password: String(fields.password ?? '').slice(0, 1024) });
    if (out.error) return { error: out.error, status: 400 };
    startSession(req, res, out.user);
    audit(req, 'klant_geregistreerd', { via: 'winkel' }, out.user.id, out.user.tenant_id);
    return { user: out.user };
  }

  /**
   * Logt uit.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  function logout(req, res) {
    impersonation.stop(req, res, 'uitgelogd');
    const session = auth.session(req);
    if (session) audit(req, 'uitgelogd', { via: 'winkel' }, session.user?.id || session.row.user_id, session.row.tenant_id);
    auth.clearCookie(req, res);
    clearEnvironment(req, res);
  }

  return { viewer, login, register, logout };
}

module.exports = { createShopAccounts };
