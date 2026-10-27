// Offertes: opslag (tabel quotes), het bedrijfsprofiel voor op de offerte
// (instelling quoteProfile) en de API-routes. De berekening zelf staat in
// frontend/offertes/quote-core.js en is gedeeld met de browser.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction, jsonField } = require('../database/db');
const { createVault } = require('../beveiliging/vault');
const { createMailer, validEmail } = require('../platform/mailer');
const { preferencesOf } = require('../platform/store');

/**
 * Kopie (bcc) van een verstuurde mail naar de afzender, als die dat in Mijn
 * profiel heeft aangezet en een e-mailadres heeft.
 * @param {object} user De ingelogde gebruiker.
 * @returns {string|undefined} Het e-mailadres, of niets.
 */
const copyTo = (user) => (user && preferencesOf(user).mailCopy && validEmail(user.email) ? user.email : undefined);

const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));
const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));

// Bedrijfsprofiel: tekstvelden met maximale lengte en getallen [min, max].
const PROFILE_TEXT = {
  companyName: 120, address: 400, email: 160, phone: 40, website: 160, kvk: 20, vatNumber: 30, iban: 40,
  numberPrefix: 12, intro: 4000, terms: 6000,
};
const PROFILE_NUMBERS = { hourlyRate: [0, 10000], hourlyCost: [0, 10000], validDays: [1, 365], vatRate: [0, 21], markupPct: [-100, 1000], callOutFee: [0, 100000] };
const PROFILE_DEFAULTS = {
  companyName: 'AquaTech Service', address: '', email: '', phone: '', website: 'aquatechservice.nl', kvk: '', vatNumber: '', iban: '',
  numberPrefix: 'OF-',
  intro: 'Naar aanleiding van ons gesprek bieden wij u vrijblijvend de aanleg aan van een automatisch beregeningssysteem, volgens het ontwerp dat wij voor uw tuin hebben gemaakt.',
  terms: 'Alle bedragen zijn in euro\'s. Deze offerte is geldig tot de genoemde datum. Meerwerk voeren wij alleen in overleg uit, op basis van nacalculatie. Graafwerk gaat uit van een normaal bewerkbare grond zonder obstakels of kabels en leidingen in het tracé. Na akkoord plannen wij de werkzaamheden in overleg in.',
  // hourlyCost: kostprijs per uur voor de nacalculatie (0 = niet ingevuld).
  hourlyRate: 55, hourlyCost: 0, validDays: 30, vatRate: 21, markupPct: 0, callOutFee: 0,
};

/**
 * Schoont een (deel)profiel op; ontbrekende velden krijgen de standaardwaarde.
 * @param {object} raw Het bedrijfsprofiel uit het verzoek of de instellingen.
 * @returns {object} Het complete bedrijfsprofiel.
 */
function sanitizeProfile(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [field, max] of Object.entries(PROFILE_TEXT)) out[field] = typeof input[field] === 'string' ? input[field].slice(0, max) : PROFILE_DEFAULTS[field];
  for (const [field, [min, max]] of Object.entries(PROFILE_NUMBERS)) {
    const value = Number(input[field]);
    out[field] = input[field] !== undefined && input[field] !== null && input[field] !== '' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 100) / 100)) : PROFILE_DEFAULTS[field];
  }
  if (![0, 9, 21].includes(out.vatRate)) out.vatRate = 21;
  out.validDays = Math.round(out.validDays);
  return out;
}

const STATUSES = Object.keys(Core.STATUSES);
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * SHA-256 van een tekst.
 * @param {string} text De tekst.
 * @returns {string} De hash in hex.
 */
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
/**
 * Leest JSON zonder te falen.
 * @param {string|null} text De JSON-tekst.
 * @returns {*} De waarde, of null bij lege of ongeldige JSON.
 */
const parseJson = (text) => {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};

/**
 * Controleert de basis van een openbare link: <basis>/openbaar/offerte.html#t=<token>.
 * De basis komt van de browser van de installateur (de server kent zijn eigen
 * adres achter een proxy met padprefix niet) en moet precies naar die pagina wijzen.
 * @param {string} url Het adres van de openbare pagina.
 * @param {string} [page] Een andere openbare pagina (afspraak.html voor de werkorders).
 * @returns {string|null} Herkomst + pad, of null bij een ongeldig adres.
 */
function validShareBase(url, page = 'offerte.html') {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && parsed.pathname.endsWith(`/openbaar/${page}`)
      ? `${parsed.origin}${parsed.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * Controleert een handtekening: een PNG als data-URL van hooguit ~200 kB.
 * @param {*} dataUrl De handtekening.
 * @returns {boolean} True bij een geldige PNG.
 */
function validSignature(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 280000 || !dataUrl.startsWith('data:image/png;base64,')) return false;
  const image = Buffer.from(dataUrl.slice(22), 'base64');
  return image.length > 100 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/**
 * Maakt de opslag voor offertes, met de openbare link en het akkoord van de klant.
 * @param {object} db De database.
 * @param {{ vault?: object }} [options] De kluis voor het versleutelde linktoken.
 * @returns {object} list, get, create, update, respond, decide, share, unshare, markSent, byToken, markViewed, publicView, shareLink, remove, purge, acceptedNumber en nextNumber.
 */
function createQuoteStore(db, { vault = createVault() } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * AAD voor het versleutelde linktoken van een offerte.
   * @param {object} quoteRow De offerterij (tenant_id en id).
   * @returns {string} De context.
   */
  const tokenContext = (quoteRow) => `${quoteRow.tenant_id}:offertelink:${quoteRow.id}`;

  /**
   * Stand van de openbare link voor wie de offerte bewerkt (met de link zelf).
   * @param {object} quoteRow De volledige offerterij.
   * @returns {object} active, url, sharedAt, viewedAt, lastViewedAt, viewCount, sentAt en sentTo.
   */
  function shareOf(quoteRow) {
    let url = null;
    if (quoteRow.share_hash && quoteRow.share_token && quoteRow.share_url) {
      try { url = `${quoteRow.share_url}#t=${vault.open(quoteRow.share_token, tokenContext(quoteRow))}`; } catch { url = null; }
    }
    return {
      active: Boolean(quoteRow.share_hash), url, sharedAt: quoteRow.shared_at || null, viewedAt: quoteRow.viewed_at || null,
      lastViewedAt: quoteRow.last_viewed_at || null, viewCount: quoteRow.view_count || 0, sentAt: quoteRow.sent_at || null, sentTo: quoteRow.sent_to || null,
    };
  }

  /**
   * Zet een offerterij om naar het formaat van de API.
   * @param {object} quoteRow De rij.
   * @param {boolean} withData Ook inhoud, linkstand en akkoord meegeven.
   * @returns {object} De offerte.
   */
  function toQuote(quoteRow, withData) {
    const out = {
      id: quoteRow.id, number: quoteRow.number, status: quoteRow.status, title: quoteRow.title, customer: quoteRow.customer, planId: quoteRow.plan_id || null,
      totalExcl: quoteRow.total_excl, totalIncl: quoteRow.total_incl, createdAt: quoteRow.created_at, updatedAt: quoteRow.updated_at,
    };
    if (quoteRow.valid_until !== undefined) out.validUntil = quoteRow.valid_until;
    if (quoteRow.owner_name !== undefined) out.owner = { id: quoteRow.owner_id, username: quoteRow.owner_username, displayName: quoteRow.owner_name };
    out.customerId = quoteRow.customer_id || null;
    if (quoteRow.customer_name !== undefined) out.customerAccount = quoteRow.customer_id ? { id: quoteRow.customer_id, displayName: quoteRow.customer_name } : null;
    if (quoteRow.view_count !== undefined) {
      out.viewedAt = quoteRow.viewed_at || null;
      out.respondedAt = quoteRow.responded_at || null;
    }
    if (withData) {
      out.data = JSON.parse(quoteRow.data);
      out.share = shareOf(quoteRow);
      out.acceptance = parseJson(quoteRow.acceptance);
    }
    return out;
  }

  /**
   * Wat een klant van een offerte te zien krijgt. Met de opmaak "totaal per
   * onderdeel" geen prijzen per regel, wel per onderdeel en btw-tarief de som
   * van de vaste regels (zodat de klantpagina bij een andere optiekeuze het
   * totaal kan herberekenen). Een optie houdt zijn prijs.
   * @param {object} quote De offerte (toQuote met inhoud).
   * @returns {object} De offerte voor de klant, zonder linkstand.
   */
  function forCustomer(quote) {
    const { share, ...rest } = quote;
    const out = { ...rest, totals: Core.totals(quote.data) };
    if (quote.data.layout === 'totaal') {
      // Zonder regelprijzen kan de klantpagina het totaal bij een andere
      // optiekeuze niet herberekenen; daarom per sectie en btw-tarief de som
      // van de vaste regels.
      const fixed = new Map();
      for (const line of quote.data.lines) {
        if (line.optional) continue;
        const key = `${line.section}|${line.vat}`;
        const current = fixed.get(key) || { section: line.section, vat: line.vat, amount: 0 };
        current.amount += Core.lineTotal(line);
        fixed.set(key, current);
      }
      out.fixed = [...fixed.values()];
      out.data = { ...quote.data, lines: quote.data.lines.map((line) => (line.optional ? line
        : { id: line.id, section: line.section, description: line.description, qty: line.qty, unit: line.unit, optional: false, selected: false })) };
    }
    if (quote.acceptance) {
      const acceptance = quote.acceptance;
      out.acceptance = { answer: acceptance.answer, name: acceptance.name, at: acceptance.at, via: acceptance.via, signature: acceptance.signature || null, reason: acceptance.reason || '', totalIncl: acceptance.totalIncl, contentHash: acceptance.contentHash || null };
    }
    return out;
  }

  /**
   * Offertes van een tenant, laatst gewijzigd eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [filters] ownerId, planId en customerId (alleen de offertes van dat klantaccount, zonder concepten).
   * @returns {object[]} De offertes zonder inhoud.
   */
  function list(tenantId, { ownerId = null, planId = null, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT q.id, q.number, q.status, q.title, q.customer, q.plan_id, q.total_excl, q.total_incl, q.created_at, q.updated_at,
        ${jsonField(db, 'q.data', 'validUntil')} AS valid_until, q.owner_id, u.username AS owner_username, u.display_name AS owner_name,
        q.customer_id, c.display_name AS customer_name, q.view_count, q.viewed_at, q.responded_at
      FROM quotes q JOIN users u ON u.id = q.owner_id LEFT JOIN users c ON c.id = q.customer_id
      WHERE q.tenant_id = ? AND q.deleted_at IS NULL`;
    if (ownerId) { sql += ' AND q.owner_id = ?'; args.push(ownerId); }
    if (customerId) { sql += " AND q.customer_id = ? AND q.status <> 'concept'"; args.push(customerId); }
    if (planId) { sql += ' AND q.plan_id = ?'; args.push(String(planId)); }
    return prepare(`${sql} ORDER BY q.updated_at DESC`).all(...args).map((quoteRow) => toQuote(quoteRow, false));
  }

  /**
   * Of een gebruiker een offerte mag bewerken: de eigenaar, of wie het recht offertes.alle heeft.
   * @param {object} user De gebruiker.
   * @param {object} quoteRow De offerterij (owner_id).
   * @returns {boolean} True als bewerken mag.
   */
  const canEdit = (user, quoteRow) => Roles.can(user, 'offertes') && (quoteRow.owner_id === user.id || Roles.can(user, 'offertes.alle'));

  /**
   * Zoekt een offerte op die de gebruiker mag bewerken (een klant bewerkt
   * nooit). Alleen de kolommen voor de controle en het bijwerken; inhoud en
   * akkoord blijven in de database tot ze nodig zijn.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @returns {object|null} De rij, of null.
   */
  function findEditable(user, id) {
    if (!Roles.can(user, 'offertes')) return null;
    const quoteRow = prepare(`SELECT id, tenant_id, owner_id, status, customer_id, share_hash, CASE WHEN acceptance IS NULL THEN 0 ELSE 1 END AS accepted
      FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`).get(user.tenant_id, String(id));
    return quoteRow && canEdit(user, quoteRow) ? quoteRow : null;
  }

  // De volledige rij (met de naam van het klantaccount) in één query.
  const FULL_SQL = `SELECT q.id, q.tenant_id, q.owner_id, q.plan_id, q.number, q.status, q.title, q.customer, q.total_excl, q.total_incl,
      q.data, q.created_at, q.updated_at, q.customer_id, q.share_hash, q.share_token, q.share_url, q.shared_at, q.viewed_at,
      q.last_viewed_at, q.view_count, q.sent_at, q.sent_to, q.responded_at, q.acceptance, c.display_name AS customer_name
    FROM quotes q LEFT JOIN users c ON c.id = q.customer_id`;
  /**
   * De volledige offerterij (met de naam van het klantaccount).
   * @param {string} id Id van de offerte.
   * @returns {object|undefined} De rij.
   */
  const fullRaw = (id) => prepare(`${FULL_SQL} WHERE q.id = ?`).get(id);
  /**
   * De volledige offerte in het formaat van de API.
   * @param {string} id Id van de offerte.
   * @returns {object} De offerte met inhoud.
   */
  const fullRow = (id) => toQuote(fullRaw(id), true);

  /**
   * Een offerte inzien: wie mag bewerken, plus de gekoppelde klant zodra de
   * offerte verzonden is (concepten blijven intern). Eén query; de rechten in JS.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @returns {object|null} De offerte (voor een klant via forCustomer), of null.
   */
  const get = (user, id) => {
    const quoteRow = prepare(`${FULL_SQL} WHERE q.tenant_id = ? AND q.id = ? AND q.deleted_at IS NULL`).get(user.tenant_id, String(id));
    if (!quoteRow) return null;
    if (canEdit(user, quoteRow)) return toQuote(quoteRow, true);
    return quoteRow.customer_id === user.id && quoteRow.status !== 'concept' ? forCustomer(toQuote(quoteRow, true)) : null;
  };

  /**
   * Het volgende offertenummer per tenant en jaar: <voorvoegsel><jaar>-0001.
   * Ook verwijderde offertes tellen mee, zodat een nummer nooit terugkomt.
   * @param {string} tenantId Id van de tenant.
   * @param {string} prefix Voorvoegsel uit het bedrijfsprofiel.
   * @param {string} year Het jaar van de offertedatum.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, prefix, year) {
    const head = `${prefix}${year}-`;
    let max = 0;
    for (const existing of prepare('SELECT number FROM quotes WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const sequence = Number(existing.number.slice(head.length));
      if (Number.isInteger(sequence) && sequence > max) max = sequence;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * De kolommen die uit de inhoud volgen (titel, klant, totalen).
   * @param {object} data De opgeschoonde inhoud.
   * @returns {{ title: string, customer: string, totalExcl: number, totalIncl: number }} De kolomwaarden.
   */
  function fields(data) {
    const totals = Core.totals(data);
    return {
      title: data.title.trim() || data.planTitle.trim() || 'Offerte',
      customer: data.customer.name.trim(),
      totalExcl: totals.net,
      totalIncl: totals.total,
    };
  }

  /**
   * Maakt een offerte met een nieuw nummer.
   * @param {object} user De ingelogde gebruiker (eigenaar).
   * @param {object} rawData De inhoud (wordt opgeschoond).
   * @param {{ status?: string, prefix?: string, customerId?: string|null }} [options] Status, nummervoorvoegsel en klantaccount.
   * @returns {object} De nieuwe offerte.
   */
  function create(user, rawData, { status = 'concept', prefix = 'OF-', customerId = null } = {}) {
    const data = Core.sanitize(rawData);
    const columns = fields(data);
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      const number = nextNumber(user.tenant_id, prefix, data.date.slice(0, 4));
      prepare(`INSERT INTO quotes (id, tenant_id, owner_id, plan_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.tenant_id, user.id, data.planId || null, number, STATUSES.includes(status) ? status : 'concept',
          columns.title, columns.customer, columns.totalExcl, columns.totalIncl, JSON.stringify(data), timestamp, timestamp, customerId || null);
      return fullRow(id);
    });
  }

  /**
   * Slaat een offerte op. Na een vastgelegd akkoord ligt hij vast (bewijs van
   * wat er is geaccordeerd); wijzigen kan dan alleen in een kopie.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @param {object|undefined} rawData De inhoud; undefined = ongewijzigd.
   * @param {string|undefined} status De nieuwe status; undefined = ongewijzigd.
   * @param {string|null|undefined} customerId Klantaccount; undefined = ongewijzigd, null = ontkoppelen.
   * @returns {object|null} De offerte, { locked: true } of null.
   */
  function update(user, id, rawData, status, customerId) {
    return transaction(db, () => {
      const quoteRow = findEditable(user, id);
      if (!quoteRow) return null;
      // Na een vastgelegd akkoord ligt de offerte vast (bewijs van wat er is
      // geaccordeerd); wijzigen kan alleen in een kopie.
      if (Number(quoteRow.accepted) && (rawData !== undefined || (status !== undefined && status !== quoteRow.status))) return { locked: true };
      const data = rawData === undefined ? JSON.parse(prepare('SELECT data FROM quotes WHERE id = ?').get(quoteRow.id).data) : Core.sanitize(rawData);
      const columns = fields(data);
      const newStatus = STATUSES.includes(status) ? status : quoteRow.status;
      const newCustomerId = customerId === undefined ? quoteRow.customer_id : customerId || null;
      prepare(`UPDATE quotes SET plan_id = ?, status = ?, title = ?, customer = ?, total_excl = ?, total_incl = ?, data = ?, updated_at = ?, customer_id = ? WHERE id = ?`)
        .run(data.planId || null, newStatus, columns.title, columns.customer, columns.totalExcl, columns.totalIncl, JSON.stringify(data), currentTimestamp(), newCustomerId, quoteRow.id);
      return fullRow(quoteRow.id);
    });
  }

  /**
   * Legt de reactie van de klant vast op een verzonden offerte (via de
   * openbare link of een klantaccount). Akkoord: naam, handtekening, akkoord
   * met de voorwaarden en de gekozen opties; de offerte ligt daarna vast, met
   * een hash van de geaccordeerde inhoud.
   * @param {object|null} quoteRow De volledige offerterij.
   * @param {string} answer 'akkoord' of 'afgewezen'.
   * @param {object} input name, terms, signature, options en reason.
   * @param {object} who ip, forwardedFor, userAgent, via en userId.
   * @returns {{ quote: object, row: object }|{ error: string, status?: string, message?: string }} De offerte en de rij, of een fout.
   */
  function decide(quoteRow, answer, input, who) {
    if (!quoteRow || quoteRow.status === 'concept') return { error: 'not_found' };
    if (quoteRow.status !== 'verzonden' || quoteRow.acceptance || Number(quoteRow.accepted)) return { error: 'answered', status: quoteRow.status };
    let data = JSON.parse(quoteRow.data);
    if (answer === 'akkoord' && data.validUntil && data.validUntil < Core.today()) return { error: 'expired' };
    const name = String(input.name || '').trim().slice(0, 120);
    if (answer === 'akkoord') {
      if (name.length < 2) return { error: 'invalid', message: 'Vul uw naam in.' };
      if (input.terms !== true) return { error: 'invalid', message: 'Ga akkoord met de voorwaarden.' };
      if (!validSignature(input.signature)) return { error: 'invalid', message: 'Zet uw handtekening.' };
      data = Core.sanitize(Core.chooseOptions(data, input.options));
    }
    const at = currentTimestamp();
    const totals = Core.totals(data);
    const acceptance = {
      answer, name, at, via: who.via, userId: who.userId || null,
      ip: who.ip || '', forwardedFor: String(who.forwardedFor || '').slice(0, 100), userAgent: String(who.userAgent || '').slice(0, 300),
      signature: answer === 'akkoord' ? input.signature : null,
      termsAccepted: answer === 'akkoord',
      options: data.lines.filter((line) => line.optional && line.selected).map((line) => line.id),
      reason: answer === 'afgewezen' ? String(input.reason || '').trim().slice(0, 1000) : '',
      totalExcl: totals.net, totalIncl: totals.total,
      contentHash: sha256(JSON.stringify({ number: quoteRow.number, data, totals })),
    };
    return transaction(db, () => {
      const current = prepare('SELECT status, CASE WHEN acceptance IS NULL THEN 0 ELSE 1 END AS accepted FROM quotes WHERE id = ?').get(quoteRow.id);
      if (current.status !== 'verzonden' || Number(current.accepted)) return { error: 'answered', status: current.status };
      const columns = fields(data);
      prepare('UPDATE quotes SET status = ?, data = ?, total_excl = ?, total_incl = ?, acceptance = ?, responded_at = ?, updated_at = ? WHERE id = ?')
        .run(answer, JSON.stringify(data), columns.totalExcl, columns.totalIncl, JSON.stringify(acceptance), at, at, quoteRow.id);
      const raw = fullRaw(quoteRow.id);
      return { quote: toQuote(raw, true), row: raw };
    });
  }

  /**
   * Reactie van een klantaccount (in de app) op een eigen offerte.
   * @param {object} user De klant.
   * @param {string} id Id van de offerte.
   * @param {string} answer 'akkoord' of 'afgewezen'.
   * @param {object} [input] Zie decide.
   * @param {object} [who] ip, forwardedFor en userAgent.
   * @returns {object} Zie decide; de offerte zoals de klant hem ziet.
   */
  function respond(user, id, answer, input = {}, who = {}) {
    const quoteRow = prepare('SELECT id, tenant_id, number, status, data, CASE WHEN acceptance IS NULL THEN 0 ELSE 1 END AS accepted FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND customer_id = ?').get(user.tenant_id, String(id), user.id);
    const out = decide(quoteRow, answer, input, { ...who, via: 'account', userId: user.id });
    return out.quote ? { ...out, quote: forCustomer(out.quote) } : out;
  }

  // ---------- Openbare link ----------
  /**
   * Maakt de openbare link (of houdt de bestaande, de klant heeft hem misschien
   * al); de offerte gaat dan naar Verzonden.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @param {string} url Adres van de openbare pagina (validShareBase).
   * @returns {{ quote: object }|{ error: string }} De offerte, of de fout invalid_url of not_found.
   */
  function share(user, id, url) {
    const base = validShareBase(url);
    if (!base) return { error: 'invalid_url' };
    return transaction(db, () => {
      const quoteRow = findEditable(user, id);
      if (!quoteRow) return { error: 'not_found' };
      if (quoteRow.share_hash) {
        // Bestaande link houden (de klant heeft hem misschien al); alleen de basis bijwerken.
        prepare('UPDATE quotes SET share_url = ? WHERE id = ?').run(base, quoteRow.id);
      } else {
        const token = crypto.randomBytes(24).toString('base64url');
        prepare(`UPDATE quotes SET share_hash = ?, share_token = ?, share_url = ?, shared_at = ?, view_count = 0, viewed_at = NULL, last_viewed_at = NULL,
          status = CASE WHEN status = 'concept' THEN 'verzonden' ELSE status END, updated_at = ? WHERE id = ?`)
          .run(sha256(token), vault.seal(token, tokenContext(quoteRow)), base, currentTimestamp(), currentTimestamp(), quoteRow.id);
      }
      return { quote: fullRow(quoteRow.id) };
    });
  }

  /**
   * Trekt de openbare link in; de oude link werkt niet meer.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @returns {object|null} De offerte, of null.
   */
  function unshare(user, id) {
    const quoteRow = findEditable(user, id);
    if (!quoteRow) return null;
    prepare('UPDATE quotes SET share_hash = NULL, share_token = NULL, shared_at = NULL WHERE id = ?').run(quoteRow.id);
    return fullRow(quoteRow.id);
  }

  /**
   * Legt vast dat de offerte per e-mail is verstuurd (een concept gaat naar Verzonden).
   * @param {string} id Id van de offerte.
   * @param {string} to De ontvangers.
   */
  function markSent(id, to) {
    prepare("UPDATE quotes SET sent_at = ?, sent_to = ?, status = CASE WHEN status = 'concept' THEN 'verzonden' ELSE status END WHERE id = ?").run(currentTimestamp(), String(to).slice(0, 400), id);
  }

  /**
   * Zoekt een offerte op het token van de openbare link (over alle tenants;
   * het token is het enige geheim). De volledige rij, zodat publicView en
   * decide niet opnieuw hoeven te lezen.
   * @param {string} token Het token.
   * @returns {object|null} De rij, of null.
   */
  function byToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return prepare(`${FULL_SQL} WHERE q.share_hash = ? AND q.deleted_at IS NULL`).get(sha256(token)) || null;
  }

  /**
   * Telt een bezoek aan de openbare link.
   * @param {object} quoteRow De offerterij.
   */
  function markViewed(quoteRow) {
    const timestamp = currentTimestamp();
    prepare('UPDATE quotes SET viewed_at = COALESCE(viewed_at, ?), last_viewed_at = ?, view_count = view_count + 1 WHERE id = ?').run(timestamp, timestamp, quoteRow.id);
  }

  /**
   * Wat de klant via de link ziet: zoals een klantaccount, zonder interne velden.
   * @param {object} quoteRow Een volledige rij (byToken, decide) of alleen { id }.
   * @returns {object} De offerte.
   */
  function publicView(quoteRow) {
    const raw = quoteRow.customer_name !== undefined && quoteRow.data !== undefined ? quoteRow : fullRaw(quoteRow.id);
    const { owner, customerId, customerAccount, planId, viewedAt, respondedAt, ...rest } = forCustomer(toQuote(raw, true));
    return rest;
  }

  /**
   * De openbare link van een offerte.
   * @param {object} quoteRow De volledige offerterij.
   * @returns {string|null} De link, of null.
   */
  const shareLink = (quoteRow) => shareOf(quoteRow).url;

  /**
   * Verwijdert een offerte (zacht: deleted_at).
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van de offerte.
   * @returns {boolean} Of de offerte gevonden is.
   */
  function remove(user, id) {
    const quoteRow = findEditable(user, id);
    if (!quoteRow) return false;
    prepare('UPDATE quotes SET deleted_at = ? WHERE id = ?').run(currentTimestamp(), quoteRow.id);
    return true;
  }

  /**
   * Nummer van een geaccordeerde offerte; verwijderen daarvan vraagt een extra
   * bevestiging met het offertenummer.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de offerte.
   * @returns {string|null} Het nummer, of null als de offerte niet akkoord is.
   */
  function acceptedNumber(tenantId, id) {
    const quoteRow = prepare('SELECT number, status FROM quotes WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    return quoteRow && quoteRow.status === 'akkoord' ? quoteRow.number : null;
  }

  /**
   * Wist een offerte definitief (AVG-verzoek), ook een al verwijderde.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de offerte.
   * @returns {boolean} Of er iets is gewist.
   */
  function purge(tenantId, id) {
    return prepare('DELETE FROM quotes WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
  }

  return { list, get, create, update, respond, decide, share, unshare, markSent, byToken, markViewed, publicView, shareLink, remove, purge, acceptedNumber, nextNumber };
}

/**
 * Maakt van een async route-afhandeling een gewone: een fout gaat naar de foutafhandeling van Express.
 * @param {Function} handler De async afhandeling (req, res, next).
 * @returns {Function} De route-afhandeling.
 */
const wrapAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
/**
 * Maakt tekst veilig voor in HTML.
 * @param {*} value De tekst.
 * @returns {string} De tekst met &, <, >, " en ' als entiteit.
 */
const escHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/**
 * Stelt een e-mail in huisstijl op: platte tekst en HTML met alinea's, ondertekening en optioneel een knop.
 * @param {object} profile Het bedrijfsprofiel (naam, telefoon, e-mail, website).
 * @param {string[]} paragraphs De alinea's (lege vallen weg).
 * @param {{ label: string, href: string }|null} button De knop, of null.
 * @returns {{ text: string, html: string }} De twee versies van het bericht.
 */
function mailBody(profile, paragraphs, button) {
  const paras = paragraphs.map((paragraph) => String(paragraph || '').trim()).filter(Boolean);
  const sign = [profile.companyName, profile.phone, profile.email, profile.website].filter(Boolean);
  const text = [...paras, button ? `${button.label}: ${button.href}` : '', '', ...sign].filter((line, i, allLines) => line || (i > 0 && allLines[i - 1])).join('\n\n');
  const href = button && /^https?:\/\//.test(button.href) ? button.href : null;
  const html = `<!doctype html><html lang="nl"><body style="margin:0;background:#f4f6f9;font-family:Montserrat,Arial,sans-serif;color:#1d2733">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#172f5e;color:#ffffff;padding:18px 24px;font-size:18px;font-weight:700">${escHtml(profile.companyName)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">
${paras.map((paragraph) => `<p style="margin:0 0 14px">${escHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')}
${href ? `<p style="margin:22px 0"><a href="${escHtml(href)}" style="background:#19924f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;display:inline-block">${escHtml(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px;border-top:3px solid #2cb0c0;font-size:12px;color:#6b7785">${sign.map(escHtml).join(' · ')}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

/**
 * Registreert de API-routes voor offertes, de openbare link en de mailserver.
 * Opstellen en bewerken: recht 'offertes' (beheerder, installateur); een
 * klant ziet alleen de verzonden offertes die aan zijn account hangen en kan
 * die accepteren of afwijzen.
 * @param {object} app De Express-app.
 * @param {object} ctx quotes, tenantOf(req), settingsOf(req), customersOf(req), identify, requireUser, requireAdmin, requireRight, requireJson, audit en optioneel settingsForTenant, themeOf, tenantActive, mailerFor, remoteIp, publicLimiter en planReviewOf.
 */
function registerQuoteRoutes(app, ctx) {
  const { quotes, identify, requireAdmin, requireRight, requireJson, settingsOf, customersOf, audit } = ctx;
  // Openbare link: instellingen van de tenant van de offerte, en geen
  // uitgeschakelde tenants. mailerFor is te vervangen in tests.
  const settingsForTenant = ctx.settingsForTenant;
  // Kleurthema van de tenant voor de openbare pagina (CSS-variabelen).
  const themeOf = ctx.themeOf || (() => null);
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const publicLimiter = ctx.publicLimiter || ((req, res, next) => next());
  /**
   * Gegevens van de bezoeker voor het akkoordbewijs.
   * @param {object} req Het Express-verzoek.
   * @returns {{ ip: string, forwardedFor: string, userAgent: string }} IP-adres, opgegeven adres achter een proxy en browser.
   */
  const who = (req) => ({
    ip: remoteIp(req),
    // Achter Cloudflare/een proxy: het opgegeven adres van de bezoeker (ter informatie).
    forwardedFor: req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || '',
  });
  /**
   * Stuurt het antwoord 404 "offerte niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Offerte niet gevonden.' });
  /**
   * Of de inhoud van een offerte een object is.
   * @param {*} data De inhoud uit het verzoek.
   * @returns {boolean} True bij een gewoon object.
   */
  const validData = (data) => data && typeof data === 'object' && !Array.isArray(data);
  /**
   * Of een status ontbreekt of bestaat.
   * @param {*} status De status uit het verzoek.
   * @returns {boolean} True als hij bruikbaar is.
   */
  const validStatus = (status) => status === undefined || STATUSES.includes(status);
  const requireQuotes = requireRight('offertes');

  /**
   * Klantaccount voor een offerte: leeg (geen) of een actieve klant van de organisatie.
   * @param {object} req Het Express-verzoek.
   * @param {*} raw Het id uit het verzoek.
   * @returns {{ value: string|null|undefined }|{ error: boolean }} Het id (undefined = ongewijzigd), of een fout.
   */
  function customerIdOf(req, raw) {
    if (raw === undefined) return { value: undefined };
    if (raw === null || raw === '') return { value: null };
    return customersOf(req).some((customer) => customer.id === String(raw)) ? { value: String(raw) } : { error: true };
  }
  /**
   * Stuurt het antwoord 400 "onbekend klantaccount".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const badCustomer = (res) => res.status(400).json({ error: 'invalid_customer', message: 'Onbekend klantaccount.' });

  // Bedrijfsgegevens en standaardwaarden voor op de offerte (geen geheimen).
  // Ook een klant heeft ze nodig om de offerte te kunnen tonen.
  app.get('/api/quote-profile', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    const settings = settingsOf(req);
    res.json({ profile: settings.get('quoteProfile'), canEdit: Roles.can(user, 'beheer'), mail: Roles.can(user, 'offertes') && mailerFor(settings).configured() });
  });

  app.put('/api/quote-profile', requireJson, requireAdmin, (req, res) => {
    const settings = settingsOf(req);
    const next = sanitizeProfile({ ...settings.get('quoteProfile'), ...(validData(req.body?.profile) ? req.body.profile : {}) });
    settings.update({ quoteProfile: next }, req.user?.id);
    audit(req, 'instellingen_gewijzigd', { fields: ['quoteProfile'] });
    res.json({ profile: settings.get('quoteProfile') });
  });

  // Klantaccounts om een offerte aan te koppelen.
  app.get('/api/quote-customers', requireQuotes, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: customersOf(req) });
  });

  // Eigen offertes; beheerders en installateurs zien met ?all=1 die van
  // iedereen, een klant alleen de offertes voor zijn account.
  app.get('/api/quotes', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.json({ items: [] });
    if (!Roles.can(user, 'offertes')) {
      return res.json({ items: Roles.can(user, 'offertes.klant') ? quotes.list(user.tenant_id, { customerId: user.id }) : [] });
    }
    const all = req.query.all === '1' && Roles.can(user, 'offertes.alle');
    res.json({ items: quotes.list(user.tenant_id, { ownerId: all ? null : user.id, planId: req.query.plan || null }) });
  });

  app.get('/api/quotes/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    const quote = user && quotes.get(user, req.params.id);
    if (!quote) return notFound(res);
    res.json(quote);
  });

  app.post('/api/quotes', requireJson, requireQuotes, (req, res) => {
    const { data, status } = req.body || {};
    if (!validData(data) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const customerChoice = customerIdOf(req, req.body.customerId);
    if (customerChoice.error) return badCustomer(res);
    // Uit een plan dat (nog) niet is goedgekeurd geen offerte (een verwijderd
    // plan blokkeert niet: de offerte blijft los daarvan bestaan).
    const review = data.planId && ctx.planReviewOf ? ctx.planReviewOf(req.user.tenant_id, data.planId) : null;
    if (review && review !== 'goedgekeurd') return res.status(409).json({ error: 'plan_not_approved', message: 'Dit plan is nog niet goedgekeurd. Laat het eerst controleren en goedkeuren door een installateur.' });
    const prefix = settingsOf(req).get('quoteProfile').numberPrefix;
    res.status(201).json(quotes.create(req.user, data, { status, prefix, customerId: customerChoice.value }));
  });

  app.put('/api/quotes/:id', requireJson, requireQuotes, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_quote', message: 'Ongeldige offerte.' });
    const customerChoice = customerIdOf(req, req.body.customerId);
    if (customerChoice.error) return badCustomer(res);
    const quote = quotes.update(req.user, req.params.id, data, status, customerChoice.value);
    if (!quote) return notFound(res);
    if (quote.locked) return res.status(409).json({ error: 'locked', message: 'Deze offerte is digitaal beantwoord en ligt vast. Maak een kopie om iets te wijzigen.' });
    res.json(quote);
  });

  /**
   * Antwoord op een fout bij akkoord of afwijzen (klantaccount en openbare link).
   * @param {object} res Het Express-antwoord.
   * @param {{ error: string, status?: string, message?: string }} out De fout uit decide.
   * @returns {object} Het antwoord.
   */
  function decideError(res, out) {
    if (out.error === 'not_found') return notFound(res);
    if (out.error === 'answered') return res.status(409).json({ error: 'answered', message: `Deze offerte is al ${out.status === 'akkoord' ? 'geaccepteerd' : out.status === 'afgewezen' ? 'afgewezen' : 'beantwoord'}.` });
    if (out.error === 'expired') return res.status(409).json({ error: 'expired', message: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.' });
    return res.status(400).json({ error: 'invalid', message: out.message || 'Ongeldige invoer.' });
  }
  /**
   * Of het antwoord akkoord of afgewezen is.
   * @param {*} answer Het antwoord uit het verzoek.
   * @returns {boolean} True bij een geldig antwoord.
   */
  const validAnswer = (answer) => answer === 'akkoord' || answer === 'afgewezen';

  /**
   * Na een akkoord of afwijzing: bevestiging naar de klant en bericht naar het
   * bedrijf, als er een mailserver is. Mislukt dat, dan blijft het akkoord staan.
   * @param {object} settings De instellingen van de tenant.
   * @param {object} row De volledige offerterij na de reactie.
   * @returns {Promise<void>} Klaar als alle mails verstuurd of mislukt zijn.
   */
  function notifyDecision(settings, row) {
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return Promise.resolve();
    const profile = settings.get('quoteProfile');
    const data = JSON.parse(row.data);
    const acceptance = JSON.parse(row.acceptance);
    const link = quotes.shareLink(row);
    const when = new Date(acceptance.at).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
    const total = Number(acceptance.totalIncl || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
    const jobs = [];
    if (acceptance.answer === 'akkoord' && validEmail(data.customer.email)) {
      jobs.push(mailer.send({
        to: data.customer.email, replyTo: profile.email,
        subject: `Bevestiging: offerte ${row.number} geaccordeerd`,
        ...mailBody(profile, [
          `Beste ${acceptance.name},`,
          `Bedankt voor uw akkoord op offerte ${row.number}${data.title ? ` (${data.title})` : ''} op ${when}, voor ${total} incl. btw.`,
          link ? 'Via de knop hieronder bekijkt u de geaccordeerde offerte met uw handtekening; daar kunt u hem ook als PDF opslaan.' : '',
          'Wij nemen contact met u op om de werkzaamheden in te plannen.',
        ], link ? { label: 'Geaccordeerde offerte bekijken', href: link } : null),
      }));
    }
    if (validEmail(profile.email)) {
      const lines = acceptance.answer === 'akkoord'
        ? [`${acceptance.name} heeft offerte ${row.number}${data.customer.name ? ` voor ${data.customer.name}` : ''} geaccordeerd op ${when}, voor ${total} incl. btw.`]
        : [`${acceptance.name || 'De klant'} heeft offerte ${row.number}${data.customer.name ? ` voor ${data.customer.name}` : ''} afgewezen op ${when}.`, acceptance.reason ? `Reden: ${acceptance.reason}` : ''];
      jobs.push(mailer.send({ to: profile.email, subject: `Offerte ${row.number} ${acceptance.answer === 'akkoord' ? 'geaccordeerd' : 'afgewezen'}`, ...mailBody(profile, lines, link ? { label: 'Offerte bekijken', href: link } : null) }));
    }
    return Promise.allSettled(jobs).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.warn(`Bevestiging offerte ${row.number} niet verstuurd: ${result.reason?.message || result.reason}`);
    });
  }

  // De klant (klantaccount) accepteert of wijst af (alleen een verzonden offerte).
  app.post('/api/quotes/:id/respond', requireJson, requireRight('offertes.klant'), (req, res) => {
    const answer = req.body?.answer;
    if (!validAnswer(answer)) return res.status(400).json({ error: 'invalid_answer', message: 'Kies akkoord of afwijzen.' });
    const out = quotes.respond(req.user, req.params.id, answer, req.body || {}, who(req));
    if (out.error) return decideError(res, out);
    audit(req, answer === 'akkoord' ? 'offerte_akkoord' : 'offerte_afgewezen', { quoteId: out.quote.id, number: out.quote.number, via: 'account' });
    notifyDecision(settingsOf(req), out.row);
    res.json(out.quote);
  });

  // ---------- Openbare link (digitale offerte) ----------
  // Link maken (of de bestaande houden): de offerte gaat naar Verzonden.
  app.post('/api/quotes/:id/share', requireJson, requireQuotes, (req, res) => {
    const out = quotes.share(req.user, req.params.id, req.body?.url);
    if (out.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (out.error) return notFound(res);
    audit(req, 'offertelink_gemaakt', { quoteId: out.quote.id, number: out.quote.number });
    res.json(out.quote);
  });

  // Link intrekken: de oude link werkt niet meer.
  app.delete('/api/quotes/:id/share', requireQuotes, (req, res) => {
    const quote = quotes.unshare(req.user, req.params.id);
    if (!quote) return notFound(res);
    audit(req, 'offertelink_ingetrokken', { quoteId: quote.id, number: quote.number });
    res.json(quote);
  });

  // Versturen per e-mail met de link (maakt de link zo nodig aan).
  app.post('/api/quotes/:id/send', requireJson, requireQuotes, wrapAsync(async (req, res) => {
    const { to, subject, message, url } = req.body || {};
    const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
    if (!list.length || list.length > 5 || !list.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Er is geen mailserver ingesteld (Beheer → Instellingen → E-mail).' });
    const shared = quotes.share(req.user, req.params.id, url);
    if (shared.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (shared.error) return notFound(res);
    const quote = shared.quote;
    const profile = settings.get('quoteProfile');
    const text = String(message || '').slice(0, 5000);
    try {
      await mailer.send({
        to: list, replyTo: profile.email, bcc: copyTo(req.user),
        subject: String(subject || `Offerte ${quote.number} van ${profile.companyName}`).slice(0, 300),
        ...mailBody(profile, text.split(/\n{2,}/), { label: 'Offerte bekijken en accorderen', href: quote.share.url }),
      });
    } catch (error) {
      console.warn(`Offerte ${quote.number} niet verstuurd: ${error.message}`);
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${error.message}` });
    }
    quotes.markSent(quote.id, list.join(', '));
    audit(req, 'offerte_verstuurd', { quoteId: quote.id, number: quote.number, recipients: list.length });
    res.json(quotes.get(req.user, quote.id));
  }));

  /**
   * Het token van de openbare link. Het komt in een kop mee (niet in de URL van
   * het verzoek, dus niet in logboeken van proxy's).
   * @param {object} req Het Express-verzoek.
   * @returns {string} Het token.
   */
  const tokenOf = (req) => String(req.headers['x-offerte-token'] || '');
  /**
   * Zoekt de offerte bij het token; stuurt zelf 404 als hij er niet (meer) is.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @returns {object|null} De volledige offerterij, of null.
   */
  function publicQuote(req, res) {
    const quoteRow = quotes.byToken(tokenOf(req));
    if (!quoteRow || quoteRow.status === 'concept' || !tenantActive(quoteRow.tenant_id)) {
      res.status(404).json({ error: 'not_found', message: 'Deze offerte is niet (meer) beschikbaar. Neem contact op met de afzender.' });
      return null;
    }
    return quoteRow;
  }

  app.get('/api/public/quote', publicLimiter, (req, res) => {
    const quoteRow = publicQuote(req, res);
    if (!quoteRow) return;
    if (req.query.preview !== '1') quotes.markViewed(quoteRow);
    const settings = settingsForTenant(quoteRow.tenant_id);
    res.json({ quote: quotes.publicView(quoteRow), profile: settings.get('quoteProfile'), theme: themeOf(quoteRow.tenant_id) });
  });

  app.post('/api/public/quote/respond', publicLimiter, requireJson, (req, res) => {
    const quoteRow = publicQuote(req, res);
    if (!quoteRow) return;
    const answer = req.body?.answer;
    if (!validAnswer(answer)) return res.status(400).json({ error: 'invalid_answer', message: 'Kies akkoord of afwijzen.' });
    const out = quotes.decide(quoteRow, answer, req.body || {}, { ...who(req), via: 'link' });
    if (out.error) return decideError(res, out);
    audit(req, answer === 'akkoord' ? 'offerte_akkoord' : 'offerte_afgewezen', { quoteId: quoteRow.id, number: quoteRow.number, via: 'link' }, null, quoteRow.tenant_id);
    notifyDecision(settingsForTenant(quoteRow.tenant_id), out.row);
    res.json({ quote: quotes.publicView(out.row) });
  });

  // ---------- Mailserver (beheerder) ----------
  // Ook onder /api/admin/mail: het formulier staat in Beheer > Instellingen.
  /**
   * Instellingen van de mailserver zonder het wachtwoord.
   * @param {object} settings De instellingen van de tenant.
   * @returns {{ config: object, passwordSet: boolean }} De instellingen en of er een wachtwoord is.
   */
  const mailView = (settings) => ({ config: settings.get('mailServer'), passwordSet: Boolean(settings.get('mailPassword')) });
  app.get(['/api/quote-mail', '/api/admin/mail'], requireAdmin, (req, res) => res.json(mailView(settingsOf(req))));

  app.put(['/api/quote-mail', '/api/admin/mail'], requireJson, requireAdmin, (req, res) => {
    const settings = settingsOf(req);
    const patch = {};
    if (validData(req.body?.config)) patch.mailServer = { ...settings.get('mailServer'), ...req.body.config };
    if (typeof req.body?.password === 'string') patch.mailPassword = req.body.password;
    try {
      const changed = settings.update(patch, req.user?.id);
      if (changed.length) audit(req, 'instellingen_gewijzigd', { fields: changed });
    } catch (error) {
      return res.status(400).json({ error: 'invalid_setting', message: error.message });
    }
    res.json(mailView(settings));
  });

  app.post(['/api/quote-mail/test', '/api/admin/mail/test'], requireJson, requireAdmin, wrapAsync(async (req, res) => {
    const settings = settingsOf(req);
    const to = req.body?.to;
    if (!validEmail(to)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een geldig e-mailadres in.' });
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Vul eerst de mailserver en het afzenderadres in.' });
    try {
      await mailer.send({ to, subject: 'Testbericht van de mailinstellingen', ...mailBody(settings.get('quoteProfile'), ['Dit is een testbericht. De mailserver is goed ingesteld.'], null) });
    } catch (error) {
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${error.message}` });
    }
    res.json({ ok: true });
  }));

  /**
   * Een geaccordeerde offerte is een afspraak met de klant: verwijderen of
   * wissen alleen als het offertenummer als { confirm } is meegestuurd.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord (krijgt 409 als de bevestiging ontbreekt).
   * @param {string} tenantId Id van de tenant.
   * @returns {boolean} True als het verzoek is tegengehouden.
   */
  const acceptedGuard = (req, res, tenantId) => {
    const number = quotes.acceptedNumber(tenantId, req.params.id);
    if (!number || String(req.body?.confirm ?? '').trim() === number) return false;
    res.status(409).json({ error: 'confirm_required', number, message: `Offerte ${number} is geaccordeerd door de klant. Typ ter bevestiging het offertenummer over.` });
    return true;
  };

  app.delete('/api/quotes/:id', requireQuotes, (req, res) => {
    if (acceptedGuard(req, res, req.user.tenant_id)) return;
    if (!quotes.remove(req.user, req.params.id)) return notFound(res);
    audit(req, 'offerte_verwijderd', { quoteId: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/admin/quotes/:id', requireAdmin, (req, res) => {
    if (acceptedGuard(req, res, ctx.tenantOf(req))) return;
    if (!quotes.purge(ctx.tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'offerte_gewist', { quoteId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createQuoteStore, registerQuoteRoutes, sanitizeProfile, PROFILE_DEFAULTS, Core, validShareBase, validSignature, mailBody };
