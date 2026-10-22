// Klantportaal: één overzicht voor een klant (recht 'portaal') met zijn
// eigen plannen, zijn offertes, de werkorders die uit die offertes zijn
// ontstaan (afspraak en voortgang) en per werkorder het opleverdossier.
//
// Een klant ziet een werkorder alleen als de offerte waaruit hij is gemaakt
// aan zijn account hangt (quotes.customer_id) en niet meer in concept is.
// Interne velden (uren, instructies voor de ploeg, bouwplaatsnotities,
// verzamelde materialen, eigenaar) gaan nooit naar de klant.
//
// Optioneel (komen uit andere onderdelen, het portaal werkt ook zonder):
// - ctx.photos: opleverfoto's per werkorder (photos.list met customerOnly);
// - workorders.respond: een afspraak bevestigen of om een ander moment vragen;
// - ctx.requests: eigen meldingen (storing, onderhoud; service-requests.js).
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { forCustomer } = require('./service-requests');

const Core = require(path.join(FRONTEND_DIR, 'werkorders', 'workorder-core.js'));

/**
 * Maakt de opslag voor het klantportaal.
 * @param {object} db De database.
 * @returns {{ ownRow: Function }} De opslagfuncties.
 */
function createPortalStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  // Werkorders van een klant: via een niet-concept-offerte aan zijn account.
  // Of uit een melding van de klant (service-requests.js).
  const OWN = `FROM work_orders w WHERE w.tenant_id = ? AND w.id = ? AND w.deleted_at IS NULL
    AND (EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id
      AND qu.deleted_at IS NULL AND qu.customer_id = ? AND qu.status <> 'concept')
    OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`;

  /**
   * Een werkorder van deze klant: via een niet-concept-offerte aan zijn account
   * of uit een eigen melding. Alleen het id (workorders.respond leest de rij
   * zelf opnieuw).
   * @param {string} tenantId Id van de tenant.
   * @param {string} customerId Id van de klant.
   * @param {string} id Id van de werkorder.
   * @returns {{ id: string }|null} Het id, of null als de werkorder niet bij de klant hoort.
   */
  const ownRow = (tenantId, customerId, id) => prepare(`SELECT w.id ${OWN}`).get(tenantId, String(id), String(customerId), String(customerId)) || null;

  return { ownRow };
}

/**
 * Wat een klant van een werkorder ziet: nooit uren, instructies, notities of eigenaar.
 * @param {object} workOrder De werkorder uit workorders.get.
 * @param {{ detail?: boolean }} [options] detail: ook ontwerp, zones, stappen, materiaal en oplevering (opleverdossier).
 * @returns {object} De werkorder voor de klant.
 */
function customerWorkOrder(workOrder, { detail = false } = {}) {
  const details = workOrder.data || {};
  const progress = workOrder.progress || Core.progress(details);
  const out = {
    id: workOrder.id, number: workOrder.number, status: workOrder.status, statusLabel: Core.STATUSES[workOrder.status] || workOrder.status,
    title: workOrder.title, address: workOrder.address, quoteId: workOrder.quoteId, quoteNumber: workOrder.quoteNumber, planId: workOrder.planId,
    plannedDate: workOrder.plannedDate || '', startTime: workOrder.startTime || '', endTime: details.endTime || '', days: details.days || null,
    installer: workOrder.assignee ? workOrder.assignee.displayName : '',
    progress: { steps: progress.steps, done: progress.done, pct: progress.pct },
    completedOn: details.report ? details.report.completedOn || '' : '',
    updatedAt: workOrder.updatedAt,
  };
  // Afspraakstatus (planning): alleen de staat en het eigen antwoord. Of de
  // klantlink al gedeeld is, doet er in het portaal niet toe: een ingeplande
  // afspraak zonder reactie wacht op de klant.
  if (workOrder.appointment && typeof workOrder.appointment === 'object') {
    const response = workOrder.appointment.response;
    const state = workOrder.appointment.state === 'niet_gedeeld' ? 'wacht' : workOrder.appointment.state;
    out.appointment = { state: state, response: response ? { answer: response.answer, name: response.name || '', reason: response.reason || '', at: response.at } : null };
  }
  if (!detail) return out;
  out.design = details.design || null;
  out.zones = (details.zones || []).map((zone) => ({ name: zone.name, kind: zone.kind, parts: zone.parts }));
  out.steps = (details.steps || []).map((step) => ({ phase: step.phase, phaseLabel: Core.PHASES[step.phase] || step.phase, title: step.title, done: step.done }));
  out.materials = (details.materials || []).filter((material) => material.qty > 0).map((material) => ({ code: material.code, description: material.description, qty: material.qty, unit: material.unit }));
  out.report = { notes: details.report?.notes || '', completedOn: details.report?.completedOn || '', signedBy: details.report?.signedBy || '' };
  return out;
}

/**
 * Contactgegevens van het bedrijf voor op het portaal (geen geheimen).
 * @param {object} profile Het bedrijfsprofiel.
 * @returns {object} companyName, address, email, phone en website.
 */
function contactOf(profile) {
  const company = profile || {};
  return { companyName: company.companyName || '', address: company.address || '', email: company.email || '', phone: company.phone || '', website: company.website || '' };
}

/**
 * Registreert de API-routes van het klantportaal (recht 'portaal'; gegevens
 * van de actieve omgeving, net als offertes).
 * @param {object} app De Express-app.
 * @param {object} ctx portal, store, quotes, workorders, photos (optioneel), requests (optioneel), requireRight, requireJson, settingsOf, audit en remoteIp.
 */
function registerPortalRoutes(app, ctx) {
  const { portal, store, quotes, workorders, requireRight, requireJson, settingsOf, audit } = ctx;
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const requirePortal = requireRight('portaal');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt het antwoord 404 "werkorder niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
  /**
   * Opleverfoto's van een werkorder die de klant mag zien (leeg zonder fotomodule).
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de werkorder.
   * @returns {object[]} De foto's.
   */
  const photosOf = (tenantId, id) => {
    if (!ctx.photos || typeof ctx.photos.list !== 'function') return [];
    return ctx.photos.list(tenantId, id, { customerOnly: true });
  };

  /**
   * Alle werkorders van de klant, in één query.
   * @param {object} req Het Express-verzoek.
   * @returns {object[]} De werkorders voor de klant.
   */
  function workOrdersOf(req) {
    return workorders.list(tenantOf(req), { customerId: req.user.id }).map((workOrder) => customerWorkOrder(workOrder));
  }

  // Het hele overzicht in één keer.
  app.get('/api/portal', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    const user = req.user;
    res.json({
      user: { displayName: user.display_name || user.displayName || '', kind: user.kind, phone: user.phone || '' },
      contact: contactOf(settingsOf(req).get('quoteProfile')),
      plans: store.listPlans(tenantId, { ownerId: user.id }),
      quotes: quotes.list(tenantId, { customerId: user.id }),
      workorders: workOrdersOf(req),
      // Eigen meldingen (storing, onderhoud), zie service-requests.js.
      requests: ctx.requests ? ctx.requests.list(tenantId, { customerId: user.id }).map(forCustomer) : [],
      features: { photos: Boolean(ctx.photos), appointments: typeof workorders.respond === 'function', requests: Boolean(ctx.requests) },
    });
  });

  // Eén werkorder als opleverdossier.
  app.get('/api/portal/workorders/:id', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const workOrder = workorders.get(tenantOf(req), req.params.id, { customerId: req.user.id });
    if (!workOrder) return notFound(res);
    res.json({ ...customerWorkOrder(workOrder, { detail: true }), photos: photosOf(tenantOf(req), workOrder.id) });
  });

  // Afspraak bevestigen of om een ander moment vragen.
  app.post('/api/portal/workorders/:id/appointment', requireJson, requirePortal, (req, res) => {
    if (typeof workorders.respond !== 'function') return res.status(501).json({ error: 'not_available', message: 'Afspraken bevestigen is nog niet beschikbaar.' });
    const answer = req.body?.answer;
    if (answer !== 'bevestigd' && answer !== 'ander_moment') return res.status(400).json({ error: 'invalid_answer', message: 'Kies bevestigen of een ander moment.' });
    const row = portal.ownRow(tenantOf(req), req.user.id, req.params.id);
    if (!row) return notFound(res);
    const name = String(req.body.name || req.user.display_name || '').slice(0, 200);
    const reason = String(req.body.reason || '').slice(0, 2000);
    const out = workorders.respond(row, answer, { name, reason }, { ip: remoteIp(req), userAgent: req.headers['user-agent'] || '', via: 'account', userId: req.user.id });
    if (out.error) {
      const message = {
        answered: 'U hebt al op deze afspraak gereageerd.', past: 'Deze afspraak ligt in het verleden.',
        closed: 'Deze werkorder is afgerond of geannuleerd.', not_found: 'Werkorder niet gevonden.',
      }[out.error] || out.message || 'Ongeldige invoer.';
      return res.status(out.error === 'not_found' ? 404 : out.error === 'invalid' ? 400 : 409).json({ error: out.error, message: message });
    }
    audit(req, answer === 'bevestigd' ? 'afspraak_bevestigd' : 'afspraak_ander_moment', { workOrderId: row.id, via: 'portaal' });
    res.json(customerWorkOrder(workorders.get(tenantOf(req), row.id), { detail: true }));
  });
}

module.exports = { createPortalStore, registerPortalRoutes, customerWorkOrder };
