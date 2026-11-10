// Accounts van de webshop (storefront.js). Er is één accountsysteem: wie zich
// in de shop registreert krijgt een account met de rol klant in de planner,
// en inloggen in de shop gebruikt dezelfde sessie als de rest van de app.

const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');
const { sanitizeBusinessProfile, wantsBusiness } = require('./business-profile');
const { validEmail } = require('../platform/mailer');
const { passwordProblem } = require('../platform/store');

/** Mislukte inlogpogingen per gebruiker waarna de gebruiker tijdelijk is geblokkeerd. */
const LOGIN_MAX_FAILURES = 10;

/**
 * Maakt de accountfuncties van de webshop.
 * @param {{ store: object, auth: object, tenant: object, audit: Function, clearEnvironment: Function, impersonation: object, loginGuard: object }} deps Opslag, sessies, de hoofdtenant waar de shop bij hoort en de blokkering van het hoofdinlogscherm (per account en bezoeker).
 * @returns {{ viewer: Function, login: Function, register: Function, logout: Function, businessProfile: Function, requestBusiness: Function, mailReady: Function, sendVerification: Function, forgotPassword: Function, resetPassword: Function, verifyEmail: Function }} De functies.
 */
function createShopAccounts({ store, auth, tenant, audit, clearEnvironment, impersonation, loginGuard, tokens = null, mailerFor = null, settingsFor = null, mailBody = null }) {
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyFn: (req) => `login:${clientKey(req)}` });
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyFn: (req) => `register:${clientKey(req)}` });
  const recoveryLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `herstel:${clientKey(req)}` });

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
   * @returns {{ id: string, displayName: string, username: string, email: string, customerGroup: string, wholesale: boolean, wholesaleDiscount: number, isCustomer: boolean }|null} De gebruiker (wholesale = zakelijke groothandelsklant met zijn vaste korting in %), of null.
   */
  function viewer(req) {
    const session = auth.session(req);
    const user = session?.via === 'user' ? session.user : null;
    if (!user || user.kind !== 'account' || user.tenant_id !== tenant.id) return null;
    return { id: user.id, displayName: user.display_name, username: user.username, email: user.email || '', emailVerified: Boolean(user.email_verified_at), customerGroup: user.customer_group || '',
      wholesale: user.customer_group === 'zakelijk' && Boolean(Number(user.wholesale)), wholesaleDiscount: Number(user.wholesale_discount) || 0,
      isCustomer: store.roles.keysOfKind(user.tenant_id, 'klant').includes(user.role) };
  }

  /**
   * Moet de ingelogde bezoeker eerst zijn wachtwoord wijzigen (tijdelijk wachtwoord van een beheerder)?
   * @param {object} req Het verzoek.
   * @returns {boolean} true als er een account is ingelogd dat zijn wachtwoord nog moet wijzigen.
   */
  function mustChangePassword(req) {
    const session = auth.session(req);
    return Boolean(session?.via === 'user' && session.user && Number(session.user.must_change_password));
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
    if (loginGuard.blocked(req, key, LOGIN_MAX_FAILURES)) {
      audit(req, 'inloggen_geblokkeerd', { username, via: 'winkel' }, null, tenant.id);
      return { error: 'Te veel mislukte pogingen voor dit account. Probeer het over een kwartier opnieuw.', status: 429 };
    }
    const found = await store.authenticate(tenant.id, username, String(password ?? '').slice(0, 1024));
    const user = found && found.tenant_id === tenant.id ? found : null;
    if (!user) {
      loginGuard.fail(req, key);
      audit(req, 'inloggen_mislukt', { username, via: 'winkel' }, null, tenant.id);
      return { error: 'Onjuist e-mailadres, gebruikersnaam of wachtwoord.', status: 401 };
    }
    loginGuard.clear(req, key);
    startSession(req, res, user);
    audit(req, 'ingelogd', { via: 'winkel' }, user.id, user.tenant_id);
    return { user };
  }

  /**
   * Registreert een nieuwe klant en logt die meteen in.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {{ displayName: string, email: string, password: string, password2: string, website: string, business?: string, companyName?: string, kvkNumber?: string, vatNumber?: string }} fields De ingevulde velden (website = verborgen valstrikveld; business = vakje "zakelijke klant" met de bedrijfsgegevens).
   * @returns {Promise<{ user?: object, skipped?: boolean, error?: string, status?: number }>} Het account, skipped bij een bot, of een foutmelding.
   */
  async function register(req, res, fields) {
    if (limited(registerLimiter, req, res)) return { error: 'Te veel registraties vanaf dit adres. Probeer het later opnieuw.', status: 429 };
    if (fields.website) return { skipped: true };
    if (fields.password2 !== undefined && String(fields.password ?? '') !== String(fields.password2)) return { error: 'De wachtwoorden zijn niet gelijk.', status: 400 };
    let business = null;
    if (wantsBusiness(fields.business)) {
      const checked = sanitizeBusinessProfile(fields);
      if (checked.error) return { error: checked.error, status: 400 };
      business = checked.profile;
    }
    const out = await store.createShopCustomer(tenant.id, { displayName: fields.displayName, email: fields.email, password: String(fields.password ?? '').slice(0, 1024), business });
    if (out.error) return { error: out.error, status: 400 };
    startSession(req, res, out.user);
    audit(req, 'klant_geregistreerd', { via: 'winkel', zakelijkAangevraagd: Boolean(business) }, out.user.id, out.user.tenant_id);
    // Bevestigingsmail op de achtergrond: een mailfout houdt de registratie niet tegen.
    if (req.shopBaseUrl) sendVerification(out.user, req.shopBaseUrl).catch((error) => console.warn(`Bevestigingsmail niet verstuurd: ${error.message}`));
    return { user: out.user };
  }

  /**
   * Of mails voor wachtwoord vergeten en bevestigen kunnen worden verstuurd.
   * @returns {boolean} true als er een mailserver is ingesteld.
   */
  function mailReady() {
    if (!tokens || !mailerFor || !settingsFor || !mailBody) return false;
    try { return mailerFor(settingsFor(tenant.id)).configured(); } catch { return false; }
  }

  /**
   * Verstuurt een mail met een eenmalige link.
   * @param {{ id: string, display_name?: string, displayName?: string, email: string }} user Het account.
   * @param {'wachtwoord'|'e-mail'} purpose Soort link.
   * @param {string} link Volledig adres van de pagina; het token komt erachter als #t=…
   * @returns {Promise<boolean>} true als de mail is verstuurd.
   */
  async function sendLink(user, purpose, link) {
    // Zonder webadres van de shop (Beheer > Betalen) geen link: die zou anders naar een adres uit het verzoek wijzen (W-07).
    if (!mailReady() || !validEmail(user.email) || !/^https?:\/\//.test(String(link))) return false;
    const issued = tokens.issue(tenant.id, user.id, purpose, user.email);
    if (issued.limited) return false;
    const settings = settingsFor(tenant.id);
    const profile = settings.get('quoteProfile') || {};
    const name = user.display_name || user.displayName || '';
    const url = `${link}#t=${issued.token}`;
    const lines = purpose === 'wachtwoord'
      ? [`Beste ${name},`, 'Je hebt gevraagd om een nieuw wachtwoord voor je account bij de webshop. Kies een nieuw wachtwoord via deze link (hij werkt één uur en één keer):', url, 'Heb je dit niet zelf gevraagd? Dan kun je deze mail negeren; je wachtwoord blijft zoals het is.']
      : [`Beste ${name},`, 'Bevestig je e-mailadres voor je account bij de webshop via deze link (hij werkt zeven dagen):', url, 'Heb je geen account aangemaakt? Dan kun je deze mail negeren.'];
    const body = mailBody(profile, lines);
    await mailerFor(settings).send({ to: user.email, subject: purpose === 'wachtwoord' ? 'Nieuw wachtwoord kiezen' : 'Bevestig je e-mailadres', text: body.text, html: body.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
    return true;
  }

  /**
   * Stuurt (opnieuw) een bevestigingslink naar het e-mailadres van een account.
   * @param {object} user Het account (rij of viewer met id, naam en e-mail).
   * @param {string} baseUrl Volledig webadres van de shop (met slash).
   * @returns {Promise<boolean>} true als de mail is verstuurd.
   */
  function sendVerification(user, baseUrl) {
    return sendLink(user, 'e-mail', `${baseUrl}e-mail-bevestigen/`);
  }

  /**
   * Wachtwoord vergeten: stuurt een herstellink als er een account met dit adres is. Het antwoord is altijd hetzelfde, zodat niet te zien is of een adres bestaat.
   * @param {object} req Het verzoek (req.shopBaseUrl = webadres van de shop).
   * @param {object} res Het antwoord (alleen de Retry-After-kop bij een limiet).
   * @param {string} email Het ingevulde e-mailadres.
   * @returns {Promise<{ ok: true }|{ error: string, status: number }>} Gelukt (ook als er geen account is), of een fout.
   */
  async function forgotPassword(req, res, email) {
    if (limited(recoveryLimiter, req, res)) return { error: 'Te veel aanvragen vanaf dit adres. Probeer het later opnieuw.', status: 429 };
    const address = String(email ?? '').trim().toLowerCase().slice(0, 200);
    if (!validEmail(address)) return { error: 'Vul een geldig e-mailadres in.', status: 400 };
    if (!mailReady()) return { error: 'Wachtwoord herstellen per mail is nu niet mogelijk. Neem contact met ons op.', status: 503 };
    const ids = store.accountIdsByEmail(tenant.id, address);
    // Alleen bij precies één account: bij een gedeeld adres weet niemand welk account bedoeld is.
    if (ids.length === 1) {
      const user = store.getUser(ids[0]);
      try {
        if (await sendLink(user, 'wachtwoord', `${req.shopBaseUrl}wachtwoord-herstellen/`)) audit(req, 'wachtwoord_herstel_aangevraagd', { via: 'winkel' }, user.id, tenant.id);
      } catch (error) {
        console.warn(`Herstelmail niet verstuurd: ${error.message}`);
      }
    }
    return { ok: true };
  }

  /**
   * Zet een nieuw wachtwoord met een herstellink. Alle sessies van het account vervallen; de bezoeker logt daarna opnieuw in.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {{ token: string, password: string, password2: string }} fields Het token uit de link en het nieuwe wachtwoord (twee keer).
   * @returns {Promise<{ ok: true }|{ error: string, status: number, expired?: boolean }>} Gelukt, of een fout.
   */
  async function resetPassword(req, res, fields) {
    if (limited(recoveryLimiter, req, res)) return { error: 'Te veel pogingen vanaf dit adres. Probeer het later opnieuw.', status: 429 };
    const password = String(fields.password ?? '').slice(0, 1024);
    if (password !== String(fields.password2 ?? '')) return { error: 'De wachtwoorden zijn niet gelijk.', status: 400 };
    const problem = passwordProblem(password);
    if (problem) return { error: problem, status: 400 };
    if (!tokens) return { error: 'Deze link is ongeldig of verlopen.', status: 400, expired: true };
    const used = tokens.consume(tenant.id, String(fields.token ?? ''), 'wachtwoord');
    if (!used) return { error: 'Deze link is ongeldig, al gebruikt of verlopen. Vraag een nieuwe aan.', status: 400, expired: true };
    const out = await store.updateAccount(tenant.id, used.userId, { password, mustChangePassword: false });
    if (out.error) return { error: out.error, status: out.status || 400 };
    // Wie de link uit zijn mail gebruikt, heeft daarmee ook dat adres bevestigd.
    store.markEmailVerified(tenant.id, used.userId, used.email);
    loginGuard.clear(req, `${tenant.id}:${out.user.username}`);
    audit(req, 'wachtwoord_hersteld', { via: 'winkel' }, used.userId, tenant.id);
    return { ok: true };
  }

  /**
   * Bevestigt een e-mailadres met de link uit de mail.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {string} token Het token uit de link.
   * @returns {{ ok: true }|{ error: string, status: number }} Gelukt, of een fout.
   */
  function verifyEmail(req, res, token) {
    if (limited(recoveryLimiter, req, res)) return { error: 'Te veel pogingen vanaf dit adres. Probeer het later opnieuw.', status: 429 };
    const used = tokens ? tokens.consume(tenant.id, String(token ?? ''), 'e-mail') : null;
    if (!used || !store.markEmailVerified(tenant.id, used.userId, used.email)) return { error: 'Deze link is ongeldig, al gebruikt of verlopen. Vraag op Mijn account een nieuwe aan.', status: 400 };
    audit(req, 'e-mail_bevestigd', { via: 'winkel' }, used.userId, tenant.id);
    return { ok: true };
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

  /**
   * De bedrijfsgegevens en de klantgroep van de ingelogde klant.
   * @param {{ id: string }} viewer De ingelogde klant.
   * @returns {{ customerGroup: string, companyName: string, kvkNumber: string, vatNumber: string, businessRequest: string }} De gegevens (lege waarden als er niets is).
   */
  function businessProfile(viewer) {
    return store.businessProfile(tenant.id, viewer.id) || { customerGroup: '', companyName: '', kvkNumber: '', vatNumber: '', businessRequest: '' };
  }

  /**
   * Een ingelogde particuliere klant vraagt een zakelijk account aan; een beheerder keurt het goed.
   * @param {object} req Het verzoek.
   * @param {{ id: string }} viewer De ingelogde klant.
   * @param {{ companyName?: string, kvkNumber?: string, vatNumber?: string }} fields De ingevulde bedrijfsgegevens.
   * @returns {{ ok: true }|{ error: string, status: number }} Gelukt, of een foutmelding.
   */
  function requestBusiness(req, viewer, fields) {
    if (businessProfile(viewer).customerGroup === 'zakelijk') return { error: 'Je account is al zakelijk.', status: 409 };
    const checked = sanitizeBusinessProfile(fields);
    if (checked.error) return { error: checked.error, status: 400 };
    store.saveBusinessProfile(tenant.id, viewer.id, checked.profile, { request: true });
    audit(req, 'zakelijk_aangevraagd', { via: 'winkel' }, viewer.id, tenant.id);
    return { ok: true };
  }

  return { viewer, mustChangePassword, login, register, logout, businessProfile, requestBusiness, mailReady, sendVerification, forgotPassword, resetPassword, verifyEmail };
}

module.exports = { createShopAccounts };
