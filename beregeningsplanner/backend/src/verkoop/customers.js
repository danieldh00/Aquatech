// Klanten: een lichte klantenlijst (geen CRM) voor beheerders en installateurs. Een klant is een account met een
// rol van het soort klant (dezelfde accounts als in de webshop en het klantportaal), maar mag ook zonder inlog
// bestaan: dan is het gewoon een adresboekregel voor offertes, werkorders en facturen. Lijst met zoeken en
// pagina's, nieuwe klant (adres via PDOK, op verzoek een uitnodiging per mail), en een klantkaart met de
// offertes, werkorders en facturen van die klant.
const { requireVerifiedAddress } = require('../platform/address-lookup');
const { sanitizeBusinessProfile } = require('../webshop/business-profile');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');

/** Hoeveel regels een klantkaart per soort (offertes, werkorders, facturen) toont. */
const OVERVIEW_LIMIT = 100;
/** Hoeveel klanten een pagina van de lijst toont. */
const PAGE_SIZE = 50;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const PHONE = /^\+?[0-9 ()./-]{6,25}$/;

/**
 * Controleert en normaliseert de contactgegevens uit een verzoek. Alleen velden die zijn meegegeven komen terug.
 * @param {{ email?: *, phone?: *, address?: * }} input De ingevulde velden.
 * @returns {{ contact: object }|{ error: string, field: string }} De gesaneerde velden of een foutmelding met het veld.
 */
function sanitizeContact(input = {}) {
  const contact = {};
  if (input.email !== undefined) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (email && (email.length > 200 || !EMAIL.test(email))) return { error: 'Vul een geldig e-mailadres in.', field: 'email' };
    contact.email = email;
  }
  if (input.phone !== undefined) {
    const phone = String(input.phone ?? '').replace(/\s+/g, ' ').trim();
    if (phone && !PHONE.test(phone)) return { error: 'Vul een geldig telefoonnummer in (cijfers, spaties, +, - en haakjes).', field: 'phone' };
    contact.phone = phone;
  }
  if (input.address !== undefined) contact.address = String(input.address ?? '').replace(/\r/g, '').trim().slice(0, 400);
  return { contact };
}

/**
 * Maakt de opslag voor de klantkaart: wat er bij een klant hoort aan offertes, werkorders en facturen.
 * @param {object} db De database.
 * @returns {{ overview: Function }} De functies.
 */
function createCustomerStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De opdracht.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * De offertes, werkorders en facturen van een klant in een omgeving, elk hoogstens OVERVIEW_LIMIT regels (nieuwste eerst).
   * @param {string} tenantId De omgeving waarin de documenten staan.
   * @param {string} customerId Id van de klant.
   * @param {{ quotes: boolean, workOrders: boolean, invoices: boolean }} wanted Welke soorten de aanvrager mag zien.
   * @returns {{ quotes: object[]|null, workOrders: object[]|null, invoices: object[]|null }} De regels; null voor een soort die niet gevraagd is.
   */
  function overview(tenantId, customerId, wanted) {
    const quotes = wanted.quotes
      ? prepare(`SELECT id, number, status, title, total_incl, created_at FROM quotes
          WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id LIMIT ${OVERVIEW_LIMIT}`)
        .all(tenantId, customerId).map((row) => ({ id: row.id, number: row.number, status: row.status, title: row.title, total: Number(row.total_incl) || 0, createdAt: row.created_at }))
      : null;
    const workOrders = wanted.workOrders
      ? prepare(`SELECT w.id, w.number, w.status, w.title, w.planned_date FROM work_orders w
          WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND (
            w.quote_id IN (SELECT q.id FROM quotes q WHERE q.tenant_id = w.tenant_id AND q.customer_id = ? AND q.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))
          ORDER BY w.updated_at DESC, w.id LIMIT ${OVERVIEW_LIMIT}`)
        .all(tenantId, customerId, customerId).map((row) => ({ id: row.id, number: row.number, status: row.status, title: row.title, plannedDate: row.planned_date || null }))
      : null;
    const invoices = wanted.invoices
      ? prepare(`SELECT id, number, status, kind, total, invoice_date, due_date FROM invoices
          WHERE tenant_id = ? AND customer_id = ? ORDER BY invoice_date DESC, id LIMIT ${OVERVIEW_LIMIT}`)
        .all(tenantId, customerId).map((row) => ({ id: row.id, number: row.number || '', status: row.status, kind: row.kind, total: Number(row.total) || 0, invoiceDate: row.invoice_date, dueDate: row.due_date }))
      : null;
    return { quotes, workOrders, invoices };
  }

  return { overview };
}

/**
 * Registreert de routes van de klantenlijst.
 * @param {object} app De Express-app.
 * @param {object} ctx { store, customers (createCustomerStore), requireRight, requireJson, audit, addressGuard, tenantsOf(req) (de omgevingen met klanten), inviteReady(), invite(user) (async, stuurt de uitnodigingsmail) en can(user, recht) }.
 * @returns {void}
 */
function registerCustomerRoutes(app, ctx) {
  const { store, customers, requireRight, requireJson, audit, addressGuard, tenantsOf } = ctx;
  const requireCustomers = requireRight('klanten');
  /**
   * Antwoordt 404 voor een onbekende klant.
   * @param {object} res Het antwoord.
   * @returns {object} Het verstuurde antwoord.
   */
  const unknown = (res) => res.status(404).json({ error: 'not_found', message: 'Klant niet gevonden.' });
  /**
   * Antwoordt 400 met de melding en het veld.
   * @param {object} res Het antwoord.
   * @param {{ error: string, field?: string }} out De fout.
   * @returns {object} Het verstuurde antwoord.
   */
  const invalid = (res, out) => res.status(400).json({ error: 'invalid_customer', message: out.error, field: out.field || null });

  /**
   * Of de aanvrager de klantgroep en groothandelsinstellingen mag wijzigen (prijzen!): alleen beheerders.
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const mayPrice = (req) => ctx.can(req.user, 'beheer');

  const invitesPerUser = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `uitnodiging:${req.user?.id || clientKey(req)}` });
  const invitesPerVisitor = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `uitnodiging-ip:${clientKey(req)}` });

  /**
   * Begrenst het versturen van uitnodigingsmails per medewerker en per bezoeker, zodat het bedrijfsadres niet als mailmotor te gebruiken is.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  const limitInvites = (req, res, next) => invitesPerUser(req, res, () => invitesPerVisitor(req, res, next));

  /**
   * Zoals limitInvites, maar bij het aanmaken van een klant alleen als er ook een uitnodiging wordt gevraagd.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  const limitInvitesIfAsked = (req, res, next) => (req.body?.invite ? limitInvites(req, res, next) : next());

  /**
   * Stuurt de uitnodigingsmail aan een klant en vertaalt de uitkomst naar een korte melding.
   * @param {object} user De klant.
   * @returns {Promise<{ sent: boolean, problem: string }>} Of de mail is verstuurd, en zo niet waarom.
   */
  async function sendInvite(user) {
    if (!user.email) return { sent: false, problem: 'Vul eerst een e-mailadres in.' };
    if (user.hasLogin) return { sent: false, problem: 'Deze klant kan al inloggen; een nieuw wachtwoord kiest de klant zelf via Wachtwoord vergeten.' };
    const ready = ctx.inviteReady(user);
    if (ready) return { sent: false, problem: ready };
    try {
      return await ctx.invite(user) ? { sent: true, problem: '' } : { sent: false, problem: 'De uitnodiging kon niet worden verstuurd (te veel pogingen dit uur of een ongeldig adres).' };
    } catch (error) {
      console.warn(`Uitnodiging niet verstuurd: ${error.message}`);
      return { sent: false, problem: 'De mailserver gaf een fout; probeer het later opnieuw.' };
    }
  }

  app.get('/api/customers', requireCustomers, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE_SIZE));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    res.json({ ...store.listCustomerPage(tenantsOf(req), { search: String(req.query.q || '').slice(0, 100), group: String(req.query.group || ''), limit, offset }), limit, offset });
  });

  app.post('/api/customers', requireJson, requireCustomers, limitInvitesIfAsked, requireVerifiedAddress(addressGuard, (req) => req.body?.address), async (req, res) => {
    const body = req.body || {};
    const contact = sanitizeContact({ email: body.email, phone: body.phone, address: body.address });
    if (contact.error) return invalid(res, contact);
    let business = null;
    // Zakelijke prijzen (excl. btw) worden niet door een installateur toegekend, net als bij het wijzigen.
    if (body.customerGroup === 'zakelijk' && !mayPrice(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen een beheerder maakt een zakelijke klant.' });
    if (body.customerGroup === 'zakelijk') {
      const checked = sanitizeBusinessProfile(body);
      if (checked.error) return invalid(res, checked);
      business = checked.profile;
    } else if (body.customerGroup !== undefined && body.customerGroup !== '') {
      return invalid(res, { error: 'Onbekende klantgroep.', field: 'customerGroup' });
    }
    const tenantId = req.tenantId;
    const out = store.createCustomer(tenantId, { displayName: body.displayName, ...contact.contact, business });
    if (out.error) return invalid(res, { error: out.error, field: out.field || 'displayName' });
    audit(req, 'klant_aangemaakt', { userId: out.user.id, zakelijk: Boolean(business), uitgenodigd: Boolean(body.invite) }, undefined, tenantId);
    const created = store.getCustomer([tenantId], out.user.id);
    const invite = body.invite ? await sendInvite(created) : null;
    if (invite && invite.sent) audit(req, 'klant_uitgenodigd', { userId: created.id }, undefined, tenantId);
    res.status(201).json({ customer: created, invite });
  });

  app.get('/api/customers/:id', requireCustomers, (req, res) => {
    const customer = store.getCustomer(tenantsOf(req), req.params.id);
    if (!customer) return unknown(res);
    const documents = customers.overview(req.tenantId, customer.id, {
      quotes: ctx.can(req.user, 'offertes'), workOrders: ctx.can(req.user, 'werkorders'), invoices: ctx.can(req.user, 'facturen'),
    });
    res.json({
      customer, ...documents, dossierKey: `a-${customer.id}`, mayPrice: mayPrice(req), mayDossier: ctx.can(req.user, 'werkorders'),
      inviteProblem: customer.email ? (customer.hasLogin ? 'Deze klant kan al inloggen.' : ctx.inviteReady(customer)) : 'Vul eerst een e-mailadres in.',
    });
  });

  app.patch('/api/customers/:id', requireJson, requireCustomers, requireVerifiedAddress(addressGuard, (req) => req.body?.address,
    (req) => () => (store.getCustomer(tenantsOf(req), req.params.id) || {}).address), async (req, res) => {
    const body = req.body || {};
    const customer = store.getCustomer(tenantsOf(req), req.params.id);
    if (!customer) return unknown(res);
    const input = {};
    if (body.displayName !== undefined) {
      const name = String(body.displayName ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return invalid(res, { error: 'Vul de naam van de klant in.', field: 'displayName' });
      if (name.length > 80) return invalid(res, { error: 'Naam is te lang.', field: 'displayName' });
      input.displayName = name;
    }
    const contact = sanitizeContact({ email: body.email, phone: body.phone, address: body.address });
    if (contact.error) return invalid(res, contact);
    // Een adres van een klant met inlog is ook de weg naar het wachtwoord: alleen een beheerder wijzigt dat.
    if (customer.hasLogin && contact.contact.email !== undefined && contact.contact.email !== customer.email && !mayPrice(req)) {
      return res.status(403).json({ error: 'forbidden', message: 'Alleen een beheerder wijzigt het e-mailadres van een klant die kan inloggen.' });
    }
    if (contact.contact.email && store.accountIdsByEmail(customer.tenantId, contact.contact.email).some((otherId) => otherId !== customer.id)) {
      return invalid(res, { error: 'Er is al een account met dit e-mailadres.', field: 'email' });
    }
    if (Object.keys(contact.contact).length) input.contact = contact.contact;
    if (['companyName', 'kvkNumber', 'vatNumber'].some((field) => body[field] !== undefined)) {
      const checked = sanitizeBusinessProfile({ companyName: customer.companyName, kvkNumber: customer.kvkNumber, vatNumber: customer.vatNumber, ...body });
      if (checked.error) return invalid(res, checked);
      input.business = checked.profile;
    }
    // Prijsgevoelige instellingen (zakelijke prijzen excl. btw, groothandel) zijn voor beheerders.
    const pricing = ['customerGroup', 'wholesale', 'wholesaleDiscount'].filter((field) => body[field] !== undefined);
    if (pricing.length && !mayPrice(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen een beheerder wijzigt de klantgroep en de groothandelsinstellingen.' });
    for (const field of pricing) input[field] = body[field];
    if (!Object.keys(input).length) return res.json({ customer });
    const out = await store.updateAccount(customer.tenantId, customer.id, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_customer', message: out.error });
    audit(req, 'klant_gewijzigd', { userId: customer.id, fields: Object.keys(input).map((field) => (field === 'contact' ? Object.keys(input.contact).join(',') : field)),
      ...(input.customerGroup !== undefined ? { klantgroep: input.customerGroup || 'particulier' } : {}),
      ...(input.wholesale !== undefined ? { groothandel: Boolean(input.wholesale) } : {}),
      ...(input.wholesaleDiscount !== undefined ? { groothandelskorting: input.wholesaleDiscount } : {}) }, undefined, customer.tenantId);
    res.json({ customer: store.getCustomer([customer.tenantId], customer.id) });
  });

  app.post('/api/customers/:id/invite', requireJson, requireCustomers, limitInvites, async (req, res) => {
    const customer = store.getCustomer(tenantsOf(req), req.params.id);
    if (!customer) return unknown(res);
    if (customer.disabled) return res.status(409).json({ error: 'disabled', message: 'Dit account is uitgeschakeld.' });
    const invite = await sendInvite(customer);
    if (!invite.sent) return res.status(409).json({ error: 'invite_failed', message: invite.problem });
    audit(req, 'klant_uitgenodigd', { userId: customer.id }, undefined, customer.tenantId);
    res.json({ ok: true });
  });
}

module.exports = { registerCustomerRoutes, createCustomerStore, sanitizeContact };
