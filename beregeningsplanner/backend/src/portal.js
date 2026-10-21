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
// - ctx.requests: eigen meldingen (storing, onderhoud; servicerequests.js).
const path = require('path');
const { forCustomer } = require('./servicerequests');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));

function createPortalStore(db) {
  const q = (sql) => db.prepare(sql);

  // Werkorders van een klant: via een niet-concept-offerte aan zijn account.
  // Of uit een melding van de klant (servicerequests.js).
  const OWN = `FROM work_orders w WHERE w.tenant_id = ? AND w.id = ? AND w.deleted_at IS NULL
    AND (EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id
      AND qu.deleted_at IS NULL AND qu.customer_id = ? AND qu.status <> 'concept')
    OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`;

  // Alleen het id (workorders.respond leest de rij zelf opnieuw), en alleen
  // als de werkorder bij deze klant hoort.
  const ownRow = (tenantId, customerId, id) => q(`SELECT w.id ${OWN}`).get(tenantId, String(id), String(customerId), String(customerId)) || null;

  return { ownRow };
}

// Wat een klant van een werkorder ziet. `wo` komt uit workorders.get.
function customerWorkOrder(wo, { detail = false } = {}) {
  const d = wo.data || {};
  const p = wo.progress || Core.progress(d);
  const out = {
    id: wo.id, number: wo.number, status: wo.status, statusLabel: Core.STATUSES[wo.status] || wo.status,
    title: wo.title, address: wo.address, quoteId: wo.quoteId, quoteNumber: wo.quoteNumber, planId: wo.planId,
    plannedDate: wo.plannedDate || '', startTime: wo.startTime || '', endTime: d.endTime || '', days: d.days || null,
    installer: wo.assignee ? wo.assignee.displayName : '',
    progress: { steps: p.steps, done: p.done, pct: p.pct },
    completedOn: d.report ? d.report.completedOn || '' : '',
    updatedAt: wo.updatedAt,
  };
  // Afspraakstatus (planning): alleen de staat en het eigen antwoord. Of de
  // klantlink al gedeeld is, doet er in het portaal niet toe: een ingeplande
  // afspraak zonder reactie wacht op de klant.
  if (wo.appointment && typeof wo.appointment === 'object') {
    const r = wo.appointment.response;
    const st = wo.appointment.state === 'niet_gedeeld' ? 'wacht' : wo.appointment.state;
    out.appointment = { state: st, response: r ? { answer: r.answer, name: r.name || '', reason: r.reason || '', at: r.at } : null };
  }
  if (!detail) return out;
  out.design = d.design || null;
  out.zones = (d.zones || []).map((z) => ({ name: z.name, kind: z.kind, parts: z.parts }));
  out.steps = (d.steps || []).map((s) => ({ phase: s.phase, phaseLabel: Core.PHASES[s.phase] || s.phase, title: s.title, done: s.done }));
  out.materials = (d.materials || []).filter((m) => m.qty > 0).map((m) => ({ code: m.code, description: m.description, qty: m.qty, unit: m.unit }));
  out.report = { notes: d.report?.notes || '', completedOn: d.report?.completedOn || '', signedBy: d.report?.signedBy || '' };
  return out;
}

// Contactgegevens van het bedrijf voor op het portaal (geen geheimen).
function contactOf(profile) {
  const p = profile || {};
  return { companyName: p.companyName || '', address: p.address || '', email: p.email || '', phone: p.phone || '', website: p.website || '' };
}

/**
 * API-routes. ctx: { portal, store, quotes, workorders, photos?, requests?, requireRight,
 * requireJson, settingsOf, audit, remoteIp }. Alles achter het recht
 * 'portaal'; gegevens van de actieve omgeving (req.tenantId), net als offertes.
 */
function registerPortalRoutes(app, ctx) {
  const { portal, store, quotes, workorders, requireRight, requireJson, settingsOf, audit } = ctx;
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const requirePortal = requireRight('portaal');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
  const photosOf = (tenantId, id) => {
    if (!ctx.photos || typeof ctx.photos.list !== 'function') return [];
    return ctx.photos.list(tenantId, id, { customerOnly: true });
  };

  // Eén query voor alle werkorders van de klant (niet één per werkorder).
  function workOrdersOf(req) {
    return workorders.list(tid(req), { customerId: req.user.id }).map((wo) => customerWorkOrder(wo));
  }

  // Het hele overzicht in één keer.
  app.get('/api/portal', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const t = tid(req);
    const user = req.user;
    res.json({
      user: { displayName: user.display_name || user.displayName || '', kind: user.kind, phone: user.phone || '' },
      contact: contactOf(settingsOf(req).get('quoteProfile')),
      plans: store.listPlans(t, { ownerId: user.id }),
      quotes: quotes.list(t, { customerId: user.id }),
      workorders: workOrdersOf(req),
      // Eigen meldingen (storing, onderhoud), zie servicerequests.js.
      requests: ctx.requests ? ctx.requests.list(t, { customerId: user.id }).map(forCustomer) : [],
      features: { photos: Boolean(ctx.photos), appointments: typeof workorders.respond === 'function', requests: Boolean(ctx.requests) },
    });
  });

  // Eén werkorder als opleverdossier.
  app.get('/api/portal/workorders/:id', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const wo = workorders.get(tid(req), req.params.id, { customerId: req.user.id });
    if (!wo) return notFound(res);
    res.json({ ...customerWorkOrder(wo, { detail: true }), photos: photosOf(tid(req), wo.id) });
  });

  // Afspraak bevestigen of om een ander moment vragen.
  app.post('/api/portal/workorders/:id/appointment', requireJson, requirePortal, (req, res) => {
    if (typeof workorders.respond !== 'function') return res.status(501).json({ error: 'not_available', message: 'Afspraken bevestigen is nog niet beschikbaar.' });
    const answer = req.body?.answer;
    if (answer !== 'bevestigd' && answer !== 'ander_moment') return res.status(400).json({ error: 'invalid_answer', message: 'Kies bevestigen of een ander moment.' });
    const row = portal.ownRow(tid(req), req.user.id, req.params.id);
    if (!row) return notFound(res);
    const name = String(req.body.name || req.user.display_name || '').slice(0, 200);
    const reason = String(req.body.reason || '').slice(0, 2000);
    const out = workorders.respond(row, answer, { name, reason }, { ip: remoteIp(req), userAgent: req.headers['user-agent'] || '', via: 'account', userId: req.user.id });
    if (out.error) {
      const msg = {
        answered: 'U hebt al op deze afspraak gereageerd.', past: 'Deze afspraak ligt in het verleden.',
        closed: 'Deze werkorder is afgerond of geannuleerd.', not_found: 'Werkorder niet gevonden.',
      }[out.error] || out.message || 'Ongeldige invoer.';
      return res.status(out.error === 'not_found' ? 404 : out.error === 'invalid' ? 400 : 409).json({ error: out.error, message: msg });
    }
    audit(req, answer === 'bevestigd' ? 'afspraak_bevestigd' : 'afspraak_ander_moment', { workOrderId: row.id, via: 'portaal' });
    res.json(customerWorkOrder(workorders.get(tid(req), row.id), { detail: true }));
  });
}

module.exports = { createPortalStore, registerPortalRoutes, customerWorkOrder };
