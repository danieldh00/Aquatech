// Installatiedossier per locatie: alles van één adres bij elkaar. De
// tekening/het plan, de offertes, de werkorders (installaties) met oplevering
// en foto's, de meldingen en de geplaatste en verbruikte materialen.
//
// Er is geen eigen tabel: een locatie is het adres op de werkorders en
// meldingen, vergelijkbaar gemaakt met locationKey (photos.js). Medewerkers
// (recht 'werkorders') zien alle locaties van de omgeving; een klant (recht
// 'portaal') alleen zijn eigen werkorders en meldingen, zonder prijzen, uren,
// interne notities en interne foto's.
const { jsonDigest } = require('../database/db');
const { installationOf, completedOf, locationKey } = require('./photos');
const { KINDS: REQUEST_KINDS, STATUSES: REQUEST_STATUSES } = require('./service-requests');
const WorkOrderCore = require('../../../frontend/werkorders/workorder-core.js');

const KEY_PATTERN = /^l-[0-9a-f]{16}$/;
// Meldingen die nog aandacht vragen.
const OPEN_REQUESTS = new Set(['nieuw', 'in_behandeling', 'ingepland']);

/**
 * Maakt een lijst van "?"-plaatshouders voor een IN-lijst.
 * @param {Array} values De waarden.
 * @returns {string} Bijv. "?, ?, ?".
 */
const placeholders = (values) => values.map(() => '?').join(', ');

/**
 * Maakt de opslag voor installatiedossiers per locatie.
 * @param {object} db De database.
 * @param {{ photos: object }} stores De foto-opslag.
 * @returns {{ list: Function, get: Function }} De opslagfuncties.
 */
function createLocationStore(db, { photos }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  const FROM = `FROM work_orders w LEFT JOIN quotes o ON o.id = w.quote_id AND o.tenant_id = w.tenant_id
      LEFT JOIN users c ON c.id = o.customer_id LEFT JOIN users a ON a.id = w.assignee_id
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'`;
  const COLS = `w.id, w.number, w.status, w.title, w.customer, w.address, w.planned_date, w.created_at, w.updated_at,
        w.quote_id, o.customer_id, c.display_name AS account_name, a.display_name AS assignee_name`;
  // Zelfde regel als OF_CUSTOMER in workorders.js: via een niet-concept-offerte
  // aan het account van de klant, of uit een eigen melding.
  const OF_CUSTOMER = ` AND (EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id
    AND qu.deleted_at IS NULL AND qu.customer_id = ? AND qu.status <> 'concept')
    OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`;

  /**
   * De locatie van een melding: het eigen adres, anders dat van de gekoppelde installatie of werkorder.
   * @param {object} requestRow Rij met address, installation_id en work_order_id.
   * @param {Map<string, string>} locationOfWorkOrder Locatiesleutel per werkorder-id.
   * @returns {string|null} De locatiesleutel, of null.
   */
  const requestLocation = (requestRow, locationOfWorkOrder) => locationKey(requestRow.address)
    || locationOfWorkOrder.get(requestRow.installation_id) || locationOfWorkOrder.get(requestRow.work_order_id) || null;

  /**
   * Alle locaties van de omgeving: één regel per adres, laatst actief eerst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De locaties met aantallen.
   */
  function list(tenantId) {
    const workOrderRows = prepare(`SELECT w.id, w.status, w.customer, w.address, w.updated_at, c.display_name AS account_name,
      ${jsonDigest(db, 'w.data', { values: ['report'] })} AS data ${FROM}`).all(tenantId);
    const requestRows = prepare(`SELECT sr.id, sr.address, sr.status, sr.customer_name, sr.installation_id, sr.work_order_id, sr.updated_at
      FROM service_requests sr WHERE sr.tenant_id = ? AND sr.status <> 'ingetrokken'`).all(tenantId);
    const photoCounts = photos.counts(tenantId);
    const byKey = new Map();
    const locationOfWorkOrder = new Map();
    /**
     * De locatie bij een sleutel (nieuw als hij er nog niet is).
     * @param {string} key De locatiesleutel.
     * @param {string} address Het adres zoals ingevoerd.
     * @returns {object} De locatie.
     */
    const locationFor = (key, address) => {
      if (!byKey.has(key)) byKey.set(key, { key, address, customers: [], installations: 0, completed: 0, photos: 0, requests: 0, openRequests: 0, lastCompletedOn: '', lastActivity: '' });
      return byKey.get(key);
    };
    /**
     * Zet een klantnaam bij de locatie (één keer).
     * @param {object} location De locatie.
     * @param {string} name De klantnaam.
     */
    const addCustomer = (location, name) => { if (name && !location.customers.includes(name)) location.customers.push(name); };
    for (const row of workOrderRows) {
      const key = locationKey(row.address);
      if (!key) continue;
      locationOfWorkOrder.set(row.id, key);
      const location = locationFor(key, row.address);
      addCustomer(location, row.customer || row.account_name);
      location.installations++;
      if (row.status === 'gereed') location.completed++;
      location.photos += photoCounts[row.id] || 0;
      const done = completedOf({ ...row, data: JSON.parse(row.data || '{}') || {} });
      if (done > location.lastCompletedOn) location.lastCompletedOn = done;
      if (row.updated_at > location.lastActivity) { location.lastActivity = row.updated_at; location.address = row.address; }
    }
    for (const row of requestRows) {
      const key = requestLocation(row, locationOfWorkOrder);
      if (!key) continue;
      const location = locationFor(key, row.address);
      addCustomer(location, row.customer_name);
      location.requests++;
      if (OPEN_REQUESTS.has(row.status)) location.openRequests++;
      if (row.updated_at > location.lastActivity) location.lastActivity = row.updated_at;
    }
    return [...byKey.values()].sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
  }

  /**
   * Werkorders en meldingen op deze locatie (alleen id's): eerst id + adres van
   * de omgeving, dan in JavaScript vergelijken (de sleutel is een hash).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} key De locatiesleutel.
   * @param {string|null} customerId Alleen van deze klant (portaal), of null.
   * @returns {{ workOrderIds: string[], requestIds: string[] }} De id's.
   */
  function idsAt(tenantId, key, customerId) {
    const customerArgs = customerId ? [String(customerId), String(customerId)] : [];
    const workOrderRows = prepare(`SELECT w.id, w.address FROM work_orders w WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'${customerId ? OF_CUSTOMER : ''}`)
      .all(tenantId, ...customerArgs);
    const locationOfWorkOrder = new Map(workOrderRows.map((row) => [row.id, locationKey(row.address)]));
    const workOrderIds = workOrderRows.filter((row) => locationOfWorkOrder.get(row.id) === key).map((row) => row.id);
    const requestRows = prepare(`SELECT sr.id, sr.address, sr.installation_id, sr.work_order_id FROM service_requests sr
      WHERE sr.tenant_id = ?${customerId ? ' AND sr.customer_id = ?' : " AND sr.status <> 'ingetrokken'"}`).all(tenantId, ...(customerId ? [String(customerId)] : []));
    const requestIds = requestRows.filter((row) => requestLocation(row, locationOfWorkOrder) === key).map((row) => row.id);
    return { workOrderIds, requestIds };
  }

  /**
   * Geplaatste materialen (uit de werkorders) en verbruikte materialen (urenregistratie) per artikel opgeteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} installations De installaties met materials.
   * @param {boolean} withUsage true = ook het verbruik uit de urenregistratie.
   * @returns {object[]} Per artikel code, omschrijving, eenheid, geplaatst en verbruikt.
   */
  function materialsOf(tenantId, installations, withUsage) {
    const byKey = new Map();
    /**
     * De regel voor een artikel (nieuw als hij er nog niet is).
     * @param {{ code: string, description: string, unit: string }} material Het artikel.
     * @returns {object} De regel.
     */
    const lineFor = (material) => {
      const description = String(material.description || '').trim().toLowerCase();
      // Op code; zonder code (losse boeking) op omschrijving, ook bij een regel die wel een code heeft.
      const key = material.code ? `code:${material.code}` : [...byKey.keys()].find((candidate) => byKey.get(candidate).description.trim().toLowerCase() === description) || `omschrijving:${description}`;
      if (!byKey.has(key)) byKey.set(key, { code: material.code || '', description: material.description || '', unit: material.unit || '', placed: 0, used: 0 });
      const line = byKey.get(key);
      if (!line.unit && material.unit) line.unit = material.unit;
      return line;
    };
    for (const installation of installations) {
      for (const material of installation.materials) if (Number(material.qty) > 0) lineFor(material).placed += Number(material.qty);
    }
    const ids = installations.map((installation) => installation.id);
    if (withUsage && ids.length) {
      const usage = prepare(`SELECT code, description, unit, SUM(qty) AS qty FROM work_order_materials
        WHERE tenant_id = ? AND work_order_id IN (${placeholders(ids)}) GROUP BY code, description, unit`).all(tenantId, ...ids);
      for (const row of usage) lineFor(row).used += Number(row.qty) || 0;
    }
    return [...byKey.values()].sort((left, right) => left.description.localeCompare(right.description, 'nl'));
  }

  /**
   * Eén installatiedossier: installaties (nieuwste eerst) met foto's, plannen,
   * offertes, meldingen en materialen. Met customerId alleen wat die klant
   * mag zien.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} key De locatiesleutel (l-<hash>).
   * @param {{ customerId?: string }} [options] customerId: weergave voor het klantportaal.
   * @returns {object|null} Het dossier, of null als er niets op deze locatie is.
   */
  function get(tenantId, key, { customerId = null } = {}) {
    if (!KEY_PATTERN.test(String(key))) return null;
    const forCustomer = Boolean(customerId);
    const { workOrderIds, requestIds } = idsAt(tenantId, String(key), customerId);
    if (!workOrderIds.length && !requestIds.length) return null;

    const rows = workOrderIds.length
      ? prepare(`SELECT ${COLS}, w.data ${FROM} AND w.id IN (${placeholders(workOrderIds)})`).all(tenantId, ...workOrderIds)
        .map((row) => ({ ...row, data: JSON.parse(row.data) }))
      : [];
    rows.sort((left, right) => (completedOf(right) || right.planned_date || right.created_at).localeCompare(completedOf(left) || left.planned_date || left.created_at));
    const photoLists = photos.listMany(tenantId, workOrderIds, { customerOnly: forCustomer });
    const installations = rows.map((row) => installationOf(row, photoLists[row.id]));

    const requests = requestIds.length
      ? prepare(`SELECT sr.id, sr.number, sr.kind, sr.urgent, sr.subject, sr.address, sr.status, sr.customer_name, sr.work_order_id, sr.created_at
        FROM service_requests sr WHERE sr.tenant_id = ? AND sr.id IN (${placeholders(requestIds)}) ORDER BY sr.created_at DESC`).all(tenantId, ...requestIds)
        .map((row) => ({
          id: row.id, number: row.number, kind: row.kind, kindLabel: REQUEST_KINDS[row.kind] || row.kind, urgent: Boolean(row.urgent),
          subject: row.subject, status: row.status, statusLabel: REQUEST_STATUSES[row.status] || row.status,
          workOrderId: row.work_order_id || null, createdAt: row.created_at, address: row.address, customer: row.customer_name,
        }))
      : [];

    const quoteIds = [...new Set(rows.map((row) => row.quote_id).filter(Boolean))];
    const quotes = quoteIds.length
      ? prepare(`SELECT id, number, status, title, total_incl, created_at FROM quotes WHERE tenant_id = ? AND deleted_at IS NULL
        AND id IN (${placeholders(quoteIds)})${forCustomer ? " AND status <> 'concept' AND customer_id = ?" : ''} ORDER BY created_at DESC`)
        .all(tenantId, ...quoteIds, ...(forCustomer ? [String(customerId)] : []))
        .map((quote) => ({ id: quote.id, number: quote.number, status: quote.status, title: quote.title, createdAt: quote.created_at, ...(forCustomer ? {} : { totalIncl: quote.total_incl }) }))
      : [];

    const plans = [];
    for (const installation of installations) {
      if (installation.planId && !plans.some((plan) => plan.id === installation.planId)) plans.push({ id: installation.planId, title: installation.planTitle || 'Beregeningsplan', workOrderNumber: installation.number });
    }
    const latest = [...rows].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    const address = latest ? latest.address : requests[0].address;
    const materials = materialsOf(tenantId, installations, !forCustomer);

    if (forCustomer) {
      return {
        key: String(key), address,
        installations: installations.map((installation) => ({
          id: installation.id, number: installation.number, status: installation.status, statusLabel: WorkOrderCore.STATUSES[installation.status] || installation.status,
          title: installation.title, address: installation.address, plannedDate: installation.plannedDate, completedOn: installation.completedOn,
          installer: installation.assignee, quoteId: installation.quoteId, quoteNumber: installation.quoteNumber, planTitle: installation.planTitle,
          report: installation.report, design: installation.design,
          zones: installation.zones.map((zone) => ({ name: zone.name, kind: zone.kind, parts: zone.parts })),
          photos: installation.photos,
        })),
        plans: plans.map((plan) => ({ title: plan.title, workOrderNumber: plan.workOrderNumber })),
        quotes,
        requests: requests.map(({ address: _address, customer: _customer, ...rest }) => rest),
        materials: materials.map(({ used: _used, ...rest }) => rest),
      };
    }
    const customers = [];
    for (const row of rows) {
      const name = row.customer || row.account_name || '';
      if (name && !customers.some((customer) => customer.name === name)) {
        customers.push({ name, dossierKey: row.customer_id ? `a-${row.customer_id}` : null, account: row.customer_id ? row.account_name || '' : '' });
      }
    }
    for (const request of requests) if (request.customer && !customers.some((customer) => customer.name === request.customer)) customers.push({ name: request.customer, dossierKey: null, account: '' });
    return { key: String(key), address, customers, installations, plans, quotes, requests, materials };
  }

  return { list, get };
}

/**
 * Registreert de routes voor installatiedossiers: medewerkers (recht
 * 'werkorders') via /api/locations, de klant (recht 'portaal') via
 * /api/portal/locations/:key.
 * @param {object} app De Express-app.
 * @param {object} ctx locations, requireRight, createRateLimiter en remoteIp.
 */
function registerLocationRoutes(app, ctx) {
  const { locations, requireRight, createRateLimiter, remoteIp } = ctx;
  // Elk verzoek leest alle adressen van de omgeving: begrensd per bezoeker.
  const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyFn: remoteIp });
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt het antwoord 404.
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Installatiedossier niet gevonden.' });

  app.get('/api/locations', requireRight('werkorders'), limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: locations.list(tenantOf(req)) });
  });

  app.get('/api/locations/:key', requireRight('werkorders'), limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const dossier = locations.get(tenantOf(req), req.params.key);
    if (!dossier) return notFound(res);
    res.json(dossier);
  });

  app.get('/api/portal/locations/:key', requireRight('portaal'), limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const dossier = locations.get(tenantOf(req), req.params.key, { customerId: req.user.id });
    if (!dossier) return notFound(res);
    res.json(dossier);
  });
}

module.exports = { createLocationStore, registerLocationRoutes };
