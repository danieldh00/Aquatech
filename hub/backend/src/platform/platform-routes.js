// Hoofdbeheer-routes (`/api/platform/*`): tenants en testomgevingen beheren, multitenancy aan/uit, testdata vullen en
// gebruikers per organisatie. Uit server.js gehaald (doorlichtingspunt 12); het gedrag is gelijk gebleven.
const { FIELDS, LIVE_ONLY_KEYS, valueForTest } = require('./settings');
const { hashPassword, passwordProblem } = require('./store');
const testdata = require('./test-data');
const { validShareBase } = require('../verkoop/quotes');

/**
 * Registreert de routes onder `/api/platform` (alleen hoofdbeheerders).
 * @param {object} app De Express-app.
 * @param {object} deps De opslag en hulpfuncties uit createApp (store, tenant, settings, audit, de opslagobjecten voor testdata, enz.).
 * @returns {void}
 */
function registerPlatformRoutes(app, { store, tenant, settings, settingsFor, settingsCache, dailyCounts, requirePlatformAdmin, requireJson, wrap, audit, inScope, inScopeOnly, multitenancyOn, itemImageStore, shopContentStore, database, quoteStore, quoteOrders, workOrderStore, shopStore, photoStore, workLogStore, outsourcingStore, newsStore, aiUsage, recognitions, stockStore, supplierStore, packagingStore, purchaseOrderStore, serviceRequestStore, invoiceStore, sprinklerStore, seasonReminderStore, paymentReminderStore, impersonation, withMustChange, auditUserChange, deleteUser }) {
  app.use('/api/platform', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, requirePlatformAdmin);

  /**
   * Stuurt een fout uit het tenantbeheer terug.
   * @param {object} res Het antwoord.
   * @param {{ status?: number, error: string }} out De fout.
   * @returns {void}
   */
  const platformError = (res, out) => res.status(out.status || 400).json({ error: 'invalid_tenant', message: out.error });

  /**
   * Antwoord voor een handeling op een organisatie die niet meedoet omdat multitenancy uit staat.
   * @param {object} res Het antwoord.
   * @returns {object} Het antwoord (409).
   */
  const multitenancyOffError = (res) => res.status(409).json({ error: 'multitenancy_off', message: 'Multitenancy staat uit. Zet het aan in Hoofdbeheer > Multitenancy om met meer organisaties te werken.' });

  // Een organisatie buiten de hoofdtenant is niet te benaderen zolang multitenancy uit staat.
  app.use('/api/platform/tenants/:id', (req, res, next) => {
    const tenantRow = store.getTenant(req.params.id);
    if (tenantRow && !inScope(tenantRow)) return multitenancyOffError(res);
    next();
  });

  app.get('/api/platform/tenants', (req, res) => {
    const items = inScopeOnly(store.listTenants());
    res.json({ items, mainTenantId: tenant.id, current: req.tenantId, multitenancy: multitenancyOn() });
  });

  // Multitenancy aan of uit. Uitzetten verbergt de andere organisaties (hun gegevens blijven staan); is er zo'n
  // organisatie, dan moet de hoofdbeheerder dat eerst bevestigen met { acknowledge: true }.
  app.get('/api/platform/multitenancy', (req, res) => {
    res.json({ enabled: multitenancyOn(), otherTenants: store.listTenants().filter((live) => live.id !== tenant.id).length });
  });

  app.put('/api/platform/multitenancy', requireJson, (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'invalid_multitenancy', message: 'Geef aan of multitenancy aan of uit moet.' });
    const others = store.listTenants().filter((live) => live.id !== tenant.id).length;
    if (!req.body.enabled && others && req.body.acknowledge !== true) {
      return res.status(409).json({ error: 'confirm_required', otherTenants: others, message: `Er zijn nog ${others} andere organisatie(s). Ze worden onbereikbaar (ook voor hun gebruikers) tot je multitenancy weer aanzet. Bevestig om door te gaan.` });
    }
    settings.update({ multitenancy: req.body.enabled }, req.user.id);
    console.log(`Multitenancy ${req.body.enabled ? 'aangezet' : 'uitgezet'} door ${req.user.display_name}`);
    audit(req, 'multitenancy_gewijzigd', { enabled: req.body.enabled, otherTenants: others }, undefined, tenant.id);
    res.json({ enabled: multitenancyOn(), otherTenants: others });
  });

  // Nieuwe tenant, met optioneel meteen de eerste beheerder. Het account wordt
  // vooraf gecontroleerd; lukt het daarna toch niet, dan gaat de tenant weer weg.
  app.post('/api/platform/tenants', requireJson, wrap(async (req, res) => {
    if (!multitenancyOn()) return multitenancyOffError(res);
    const { name, slug, admin } = req.body || {};
    const withAdmin = Boolean(admin && (admin.username || admin.password));
    const account = withAdmin ? { username: String(admin.username || '').trim().toLowerCase(), displayName: admin.displayName, role: 'beheerder', password: admin.password } : null;
    if (account) {
      const problem = store.accountProblem(null, account);
      if (problem) return platformError(res, { error: `Eerste beheerder: ${problem}` });
    }
    const out = store.createTenant({ name, slug: String(slug || '').trim().toLowerCase() });
    if (out.error) return platformError(res, out);
    let user = null;
    if (account) {
      const acc = await store.createAccount(out.tenant.id, account, { mustChangePassword: admin.mustChangePassword !== false });
      if (acc.error) {
        store.dropEmptyTenant(out.tenant.id);
        return platformError(res, { error: `Eerste beheerder: ${acc.error}` });
      }
      user = acc.user;
    }
    console.log(`Tenant aangemaakt door ${req.user.display_name}: ${out.tenant.name} (${out.tenant.slug})`);
    audit(req, 'tenant_aangemaakt', { tenantId: out.tenant.id, slug: out.tenant.slug, admin: user ? user.username : null }, undefined, tenant.id);
    res.status(201).json({ tenant: store.tenantRow(out.tenant), admin: user ? store.publicUser(user) : null });
  }));

  app.patch('/api/platform/tenants/:id', requireJson, (req, res) => {
    const input = {};
    if (req.body?.name !== undefined) input.name = req.body.name;
    if (req.body?.disabled !== undefined) input.disabled = Boolean(req.body.disabled);
    const out = store.updateTenant(req.params.id, input);
    if (out.error) return platformError(res, out);
    if (input.disabled !== undefined) console.log(`Tenant ${out.tenant.name} ${input.disabled ? 'uitgeschakeld' : 'ingeschakeld'} door ${req.user.display_name}`);
    audit(req, 'tenant_gewijzigd', { tenantId: out.tenant.id, fields: Object.keys(input), ...(input.disabled !== undefined ? { disabled: input.disabled } : {}) }, undefined, tenant.id);
    res.json({ tenant: store.tenantRow(out.tenant) });
  });

  app.post('/api/platform/tenants/:id/environments', requireJson, (req, res) => {
    // Een testomgeving mag de echte systemen nooit raken: geheimen (sleutels, wachtwoorden, tokens) en koppelingen
    // met de buitenwereld (webshop, betalen, mail, boekhouding, herinneringen) gaan niet mee. De AI-sleutel van live
    // blijft bruikbaar via aiTenantOf.
    const secrets = Object.keys(FIELDS).filter((key) => FIELDS[key].type === 'secret');
    const out = store.createEnvironment(req.params.id, { name: req.body?.name, copyPlans: Boolean(req.body?.copyPlans), skipSettings: [...new Set([...secrets, ...LIVE_ONLY_KEYS])], valueForTest });
    if (out.error) return platformError(res, out);
    audit(req, 'testomgeving_aangemaakt', { tenantId: out.tenant.id, parentId: req.params.id, slug: out.tenant.slug, copied: out.copied }, undefined, tenant.id);
    console.log(`Testomgeving ${out.tenant.name} (${out.tenant.slug}) aangemaakt door ${req.user.display_name}, ${out.copied} plannen gekopieerd`);
    res.status(201).json({ tenant: store.tenantRow(out.tenant), copied: out.copied });
  });

  /**
   * Vergeet de afbeeldingen van omgevingen in het geheugen nadat hun gegevens zijn gewist.
   * @param {string[]} ids Id's van de omgevingen.
   * @returns {void}
   */
  const forgetImages = (ids) => { for (const id of ids) { itemImageStore.forget(id); shopContentStore.forgetImages(id); } };

  app.post('/api/platform/tenants/:id/reset', requireJson, (req, res) => {
    const out = store.resetEnvironment(req.params.id);
    if (out.error) return platformError(res, out);
    forgetImages([out.tenant.id]);
    console.log(`Testomgeving ${out.tenant.name} leeggemaakt door ${req.user.display_name}`);
    audit(req, 'testomgeving_leeggemaakt', { tenantId: out.tenant.id }, undefined, tenant.id);
    res.json({ ok: true });
  });

  // Testomgeving of live-tenant verwijderen. Een live-tenant gaat weg met al
  // zijn gegevens, gebruikers en testomgevingen; ter bevestiging moet de
  // tenantcode (slug) worden meegestuurd als { confirm }.
  app.delete('/api/platform/tenants/:id', (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    // Niet de omgeving verwijderen waar je nu in werkt (of de tenant waar die onder hangt): wissel eerst naar een andere.
    if (tenantRow && tenantRow.id !== tenant.id && (tenantRow.id === req.tenantId || tenantRow.id === store.getTenant(req.tenantId)?.parent_id)) {
      return res.status(409).json({ error: 'current_tenant', message: `Je werkt nu in ${tenantRow.name}. Wissel eerst naar een andere omgeving (rechtsboven) en verwijder daarna.` });
    }
    if (tenantRow && tenantRow.environment === 'live') {
      if (tenantRow.id !== tenant.id && String(req.body?.confirm ?? req.query.confirm ?? '').trim().toLowerCase() !== tenantRow.slug) {
        return res.status(400).json({ error: 'confirm_required', message: `Typ ter bevestiging de tenantcode "${tenantRow.slug}" over.` });
      }
      const out = store.deleteTenant(tenantRow.id, tenant.id);
      if (out.error) return platformError(res, out);
      for (const id of out.ids) { settingsCache.delete(id); dailyCounts.delete(id); }
      forgetImages(out.ids);
      console.log(`Tenant ${tenantRow.name} (${tenantRow.slug}) verwijderd door ${req.user.display_name}, met ${out.ids.length - 1} testomgeving(en)`);
      audit(req, 'tenant_verwijderd', { tenantId: tenantRow.id, slug: tenantRow.slug, name: tenantRow.name, environments: out.ids.length - 1, rows: out.counts }, undefined, tenant.id);
      return res.json({ ok: true, environments: out.ids.length - 1 });
    }
    const out = store.deleteEnvironment(req.params.id);
    if (out.error) return platformError(res, out);
    settingsCache.delete(req.params.id);
    dailyCounts.delete(req.params.id);
    forgetImages([req.params.id]);
    console.log(`Testomgeving verwijderd door ${req.user.display_name}`);
    audit(req, 'testomgeving_verwijderd', { tenantId: req.params.id }, undefined, tenant.id);
    res.json({ ok: true });
  });

  // Testomgeving vullen met testdata: testaccounts per rol (één gedeeld,
  // willekeurig wachtwoord dat alleen in dit antwoord staat), nepklanten,
  // plannen en offertes. Wat er al in de testomgeving stond, gaat weg.
  app.post('/api/platform/tenants/:id/testdata', requireJson, wrap(async (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    if (!tenantRow) return platformError(res, { error: 'Omgeving niet gevonden.', status: 404 });
    if (tenantRow.environment !== 'test') return platformError(res, { error: 'Testdata kan alleen in een testomgeving.', status: 409 });
    const profile = settingsFor(tenantRow.id).get('quoteProfile');
    const testSet = testdata.buildTestData({ slug: tenantRow.slug, profile });
    let password = testdata.newPassword();
    while (testSet.accounts.some((account) => passwordProblem(password, account.username))) password = testdata.newPassword();
    const out = store.seedEnvironment(tenantRow.id, testSet, { passwordHash: await hashPassword(password), numberPrefix: profile.numberPrefix || 'OF-' });
    if (out.error) return platformError(res, out);
    forgetImages([tenantRow.id]);
    // Klantlinks, reacties, werkorders en webshop via de echte opslaglogica.
    // De klantlink heeft het adres van de openbare pagina nodig; dat kent
    // alleen de browser (padprefix achter een proxy).
    const extra = testdata.seedFeatures(
      { db: database, quotes: quoteStore, quoteOrders, workorders: workOrderStore, shop: shopStore, photos: photoStore, worklog: workLogStore, outsourcing: outsourcingStore, news: newsStore, aiUsage, recognitions, stock: stockStore, suppliers: supplierStore, packagings: packagingStore, purchaseOrders: purchaseOrderStore, itemImages: itemImageStore, requests: serviceRequestStore, invoices: invoiceStore, sprinklers: sprinklerStore, seasonReminders: seasonReminderStore, paymentReminders: paymentReminderStore, settings: settingsFor(tenantRow.id) },
      testSet, { users: out.byKey, quoteIds: out.quoteIds, tenantId: tenantRow.id },
      { shareBase: validShareBase(req.body?.shareBase) },
    );
    const counts = { ...out.counts, ...extra };
    console.log(`Testomgeving ${tenantRow.name} gevuld met testdata door ${req.user.display_name}`);
    audit(req, 'testomgeving_gevuld', { tenantId: tenantRow.id, ...counts }, undefined, tenant.id);
    res.status(201).json({ accounts: out.users.map(store.publicUser), password, counts });
  }));

  /**
   * De tenant uit de URL voor gebruikersbeheer (accounts, zonder gasten; in een
   * testomgeving de testaccounts van die omgeving). Stuurt zelf 404.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De tenant, of null.
   */
  const userTenant = (req, res) => {
    const tenantRow = store.getTenant(req.params.id);
    if (!tenantRow) { res.status(404).json({ error: 'not_found', message: 'Tenant niet gevonden.' }); return null; }
    return tenantRow;
  };

  // Hoofdbeheerders wonen in de hoofdtenant: ze loggen in zonder organisatiecode.
  const HOOFD_ONLY = 'Hoofdbeheerders horen bij de hoofdtenant. Maak ze aan bij de gebruikers van de hoofdtenant.';

  app.get('/api/platform/tenants/:id/users', (req, res) => {
    const tenantRow = userTenant(req, res);
    // Met de supporttoestemming erbij (nodig om in live als de gebruiker te werken).
    if (!tenantRow) return;
    const users = store.listUsers(tenantRow.id, { includeGuests: false });
    const grants = impersonation.activeGrants(users.map((user) => user.id));
    res.json({ items: users.map((user) => ({ ...user, support: grants[user.id] || null })), roles: store.roles.list(tenantRow.id) });
  });

  app.post('/api/platform/tenants/:id/users', requireJson, wrap(async (req, res) => {
    const tenantRow = userTenant(req, res);
    if (!tenantRow) return;
    const { username, displayName, password } = req.body || {};
    const platformAdmin = Boolean(req.body?.platformAdmin);
    if (platformAdmin && tenantRow.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    const role = platformAdmin ? 'beheerder' : req.body?.role;
    const out = await store.createAccount(tenantRow.id, { username: String(username || '').trim().toLowerCase(), displayName, role, password },
      { platformAdmin, mustChangePassword: req.body?.mustChangePassword !== false });
    if (out.error) return res.status(400).json({ error: 'invalid_user', message: out.error });
    audit(req, 'gebruiker_aangemaakt', { userId: out.user.id, username: out.user.username, role: out.user.role, door: 'hoofdbeheer',
      ...(platformAdmin ? { hoofdbeheerder: true } : {}) }, undefined, tenantRow.id);
    res.status(201).json(store.publicUser(out.user));
  }));

  app.patch('/api/platform/tenants/:id/users/:uid', requireJson, wrap(async (req, res) => {
    const tenantRow = userTenant(req, res);
    if (!tenantRow) return;
    const input = {};
    for (const field of ['displayName', 'role', 'disabled', 'password']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    withMustChange(input, req.body);
    if (req.body?.platformAdmin !== undefined) {
      input.platformAdmin = Boolean(req.body.platformAdmin);
      if (input.platformAdmin && tenantRow.id !== tenant.id) return res.status(400).json({ error: 'invalid_user', message: HOOFD_ONLY });
    }
    const out = await store.updateAccount(tenantRow.id, req.params.uid, input);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_user', message: out.error });
    auditUserChange(req, out.user, input, tenantRow.id);
    res.json(store.publicUser(out.user));
  }));

  app.delete('/api/platform/tenants/:id/users/:uid', (req, res) => {
    const tenantRow = userTenant(req, res);
    if (tenantRow) deleteUser(req, res, tenantRow.id, req.params.uid, { door: 'hoofdbeheer' });
  });
}

module.exports = { registerPlatformRoutes };
