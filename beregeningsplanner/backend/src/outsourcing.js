// Opdrachten uitbesteden: een organisatie met te veel werk biedt een
// werkorder aan bij een andere organisatie op het platform, die hem kan
// aannemen. Beide kanten doen alleen mee als hun beheerder dat aanzet
// (instelling `outsourcing`: versturen en/of ontvangen, Beheer > Instellingen).
//
// Gegevensdeling (AVG, tenantscheiding):
// - Vóór acceptatie ziet een andere organisatie alleen een voorvertoning:
//   omschrijving, plaats (postcodecijfers + woonplaats, geen straat), gewenste
//   planning, omvang, werkstappen met uren en de materiaallijst. Geen klantnaam,
//   contactgegevens, instructies of prijzen.
// - Na acceptatie krijgt de ontvanger een eigen werkorder (eigen nummer) met
//   de klant- en adresgegevens die nodig zijn om het werk te doen. Offerte,
//   plan, ploeg, foto's en notities blijven bij de uitbesteder.
// - De uitbesteder ziet daarna alleen de voortgang bij de ontvanger (status,
//   planning, afgevinkte stappen, opleverdatum).
// Aanbieden kan aan één organisatie of aan iedereen die opdrachten ontvangt
// (wie het eerst accepteert, krijgt hem). Een live-omgeving werkt alleen met
// live-omgevingen, een testomgeving alleen met testomgevingen.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');
const { createMailer, validEmail } = require('./mailer');
const { mailBody } = require('./quotes');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));

const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const parse = (v, fallback) => {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
// Alleen een werkorder die nog niet in uitvoering is, kan worden uitbesteed.
const OFFERABLE = ['open', 'gepland'];
const MAX_FEE = 1e7;

/** Instelling per omgeving: { send, receive, region }. */
function sanitizeOutsourcing(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { send: r.send === true, receive: r.receive === true, region: str(r.region, 200) };
}

/**
 * Plaats uit een adres zonder straat en huisnummer: "8071 Nunspeet" uit
 * "Dorpsstraat 1, 8071 AB Nunspeet". Zonder postcode de laatste regel, maar
 * alleen als daar geen cijfers in staan (anders is het een straat).
 */
function placeOf(address) {
  const lines = String(address || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  for (const l of lines) {
    const m = /\b(\d{4})\s?[A-Za-z]{2}\b\s*(.*)$/.exec(l);
    if (m) return `${m[1]}${m[2] ? ` ${m[2].trim()}` : ''}`.slice(0, 120);
  }
  const last = lines.length > 1 ? lines[lines.length - 1] : '';
  return last && !/\d/.test(last) ? last.slice(0, 120) : '';
}

/** Wat een andere organisatie vóór acceptatie ziet. */
function previewOf(raw) {
  const d = Core.sanitize(raw);
  return {
    title: d.title || 'Werkorder',
    place: placeOf(d.customer.address),
    plannedDate: d.plannedDate, startTime: d.startTime, endTime: d.endTime, days: d.days,
    // Zonder instructies: daar kan van alles over de klant in staan.
    summary: Core.summary({ ...d, instructions: '' }),
    hours: Core.progress(d).hours,
    design: d.design,
    zones: d.zones.length,
    steps: d.steps.map((s) => ({ phase: s.phase, title: s.title, hours: s.hours })),
    materials: d.materials.map((m) => ({ code: m.code, description: m.description, qty: m.qty, unit: m.unit })),
  };
}

/** De werkorder voor de ontvanger na acceptatie: alles om het werk te doen, niets van de uitvoering bij de uitbesteder. */
function handoverOf(raw) {
  const d = Core.sanitize(raw);
  return Core.sanitize({
    title: d.title, customer: d.customer,
    plannedDate: d.plannedDate, startTime: d.startTime, endTime: d.endTime, days: d.days,
    instructions: d.instructions, siteNotes: d.siteNotes,
    design: d.design, zones: d.zones,
    steps: d.steps.map((s) => ({ phase: s.phase, title: s.title, details: s.details, hours: s.hours })),
    materials: d.materials.map((m) => ({ code: m.code, description: m.description, qty: m.qty, unit: m.unit })),
  });
}

// Kolommen van een aanbod die de weergaven gebruiken (elke query noemt zijn kolommen).
const COLS = 'id, tenant_id, work_order_id, to_tenant_id, status, message, fee, preview, from_name, created_by_name, declined, receiver_tenant_id, receiver_name, received_work_order_id, responded_by_name, responded_at, reason, created_at';
const F_COLS = COLS.split(', ').map((c) => `f.${c}`).join(', ');

function createOutsourcingStore(db, { workorders }) {
  const q = (sql) => db.prepare(sql);
  const find = (id) => q(`SELECT ${COLS} FROM work_order_offers WHERE id = ?`).get(String(id)) || null;
  const declinedOf = (r) => parse(r.declined, []);

  // Stand van het werk bij de ontvanger (voor de uitbesteder).
  function execution(r) {
    if (!r.received_work_order_id) return null;
    const w = q('SELECT number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND id = ?').get(r.receiver_tenant_id, r.received_work_order_id);
    if (!w || w.deleted_at) return { removed: true };
    const d = Core.sanitize(parse(w.data, {}));
    const p = Core.progress(d);
    return {
      number: w.number, status: w.status, plannedDate: d.plannedDate, startTime: d.startTime, endTime: d.endTime, days: d.days,
      progress: { steps: p.steps, done: p.done, pct: p.pct }, completedOn: d.report.completedOn,
    };
  }

  function outgoingView(r) {
    return {
      id: r.id, workOrderId: r.work_order_id, status: r.status, direct: Boolean(r.to_tenant_id), toTenantId: r.to_tenant_id || null,
      receiverName: r.receiver_name, message: r.message, fee: r.fee, preview: parse(r.preview, {}),
      createdAt: r.created_at, createdBy: r.created_by_name, respondedAt: r.responded_at, respondedBy: r.responded_by_name,
      reason: r.reason, declinedCount: declinedOf(r).length, execution: execution(r),
    };
  }

  // myStatus: hoe het aanbod er voor deze organisatie voor staat.
  function incomingView(r, tenantId) {
    let myStatus = r.status;
    if (r.receiver_tenant_id === tenantId) myStatus = 'geaccepteerd';
    else if (r.status === 'aangeboden' && declinedOf(r).includes(tenantId)) myStatus = 'afgewezen';
    const mine = r.receiver_tenant_id === tenantId;
    return {
      id: r.id, myStatus, direct: Boolean(r.to_tenant_id), fromTenantId: r.tenant_id, fromName: r.from_name, createdBy: r.created_by_name,
      message: r.message, fee: r.fee, preview: parse(r.preview, {}), createdAt: r.created_at,
      receivedWorkOrderId: mine ? r.received_work_order_id : null, respondedAt: mine || r.to_tenant_id === tenantId ? r.responded_at : null,
    };
  }

  const offerable = (tenantId, woId) => q('SELECT id, status, data FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(woId)) || null;
  const activeFor = (tenantId, woId) => q(`SELECT id FROM work_order_offers WHERE tenant_id = ? AND work_order_id = ?
    AND status IN ('aangeboden', 'geaccepteerd') ORDER BY created_at DESC LIMIT 1`).get(tenantId, String(woId)) || null;

  /**
   * Werkorder aanbieden. input: { toTenantId (null = iedereen), toName,
   * message, fee, fromName }. Fouten: not_found, status, active.
   */
  function offer(user, tenantId, woId, input) {
    return transaction(db, () => {
      const w = offerable(tenantId, woId);
      if (!w) return { error: 'not_found' };
      if (!OFFERABLE.includes(w.status)) return { error: 'status', status: w.status };
      if (activeFor(tenantId, w.id)) return { error: 'active' };
      const id = crypto.randomUUID();
      const ts = now();
      q(`INSERT INTO work_order_offers (id, tenant_id, work_order_id, to_tenant_id, status, message, fee, preview, from_name, created_by, created_by_name,
          receiver_name, created_at, updated_at) VALUES (?, ?, ?, ?, 'aangeboden', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, w.id, input.toTenantId || null, str(input.message, 2000), input.fee ?? null, JSON.stringify(previewOf(parse(w.data, {}))),
          str(input.fromName, 200), user.id, str(user.display_name, 120), input.toTenantId ? str(input.toName, 200) : '', ts, ts);
      return { offer: outgoingView(find(id)) };
    });
  }

  function outgoing(tenantId) {
    return q(`SELECT ${COLS} FROM work_order_offers WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`).all(tenantId).map(outgoingView);
  }

  /**
   * Aanbiedingen voor deze omgeving: open (aan haar of aan iedereen, uit een
   * omgeving van hetzelfde soort), plus wat ze heeft aangenomen of afgewezen.
   * active(tenantId) filtert uitgeschakelde organisaties weg.
   */
  function incoming(tenantId, environment, { active = () => true } = {}) {
    const rows = q(`SELECT ${F_COLS} FROM work_order_offers f JOIN tenants s ON s.id = f.tenant_id
      WHERE f.tenant_id <> ? AND s.environment = ?
        AND ((f.status = 'aangeboden' AND (f.to_tenant_id = ? OR f.to_tenant_id IS NULL))
          OR f.receiver_tenant_id = ? OR (f.status = 'afgewezen' AND f.to_tenant_id = ?))
      ORDER BY f.created_at DESC LIMIT 200`).all(tenantId, environment, tenantId, tenantId, tenantId);
    return rows.filter((r) => r.receiver_tenant_id === tenantId || active(r.tenant_id)).map((r) => incomingView(r, tenantId));
  }

  // Per werkorder-id: uitbesteed (bij de uitbesteder) of aangenomen (bij de ontvanger).
  function marks(tenantId) {
    const out = {};
    for (const r of q(`SELECT ${COLS} FROM work_order_offers WHERE tenant_id = ? AND status IN ('aangeboden', 'geaccepteerd')`).all(tenantId)) {
      out[r.work_order_id] = { role: 'uitbesteed', offerId: r.id, status: r.status, partner: r.receiver_name || '', direct: Boolean(r.to_tenant_id), execution: execution(r) };
    }
    for (const r of q(`SELECT ${COLS} FROM work_order_offers WHERE receiver_tenant_id = ? AND received_work_order_id IS NOT NULL`).all(tenantId)) {
      out[r.received_work_order_id] = { role: 'aangenomen', offerId: r.id, status: r.status, partner: r.from_name, fee: r.fee, message: r.message };
    }
    return out;
  }

  function withdraw(tenantId, id) {
    return transaction(db, () => {
      const r = find(id);
      if (!r || r.tenant_id !== tenantId) return { error: 'not_found' };
      if (r.status !== 'aangeboden') return { error: 'status', status: r.status };
      q("UPDATE work_order_offers SET status = 'ingetrokken', updated_at = ? WHERE id = ?").run(now(), r.id);
      return { offer: outgoingView(find(r.id)) };
    });
  }

  // Mag deze omgeving op het aanbod reageren? (de routes controleren de
  // instelling en het soort omgeving). Een aanbod voor een ander bestaat
  // voor haar niet (not_found); een aanbod dat al weg is, is closed.
  function problemFor(r, tenantId) {
    if (!r || r.tenant_id === tenantId || (r.to_tenant_id && r.to_tenant_id !== tenantId) || declinedOf(r).includes(tenantId)) return 'not_found';
    return r.status === 'aangeboden' ? null : 'closed';
  }

  /** Afwijzen: een gericht aanbod is dan afgewezen; een open aanbod blijft voor de anderen staan. */
  function decline(user, tenantId, id, reason) {
    return transaction(db, () => {
      const r = find(id);
      const problem = problemFor(r, tenantId);
      if (problem) return { error: problem };
      const ts = now();
      if (r.to_tenant_id) {
        q(`UPDATE work_order_offers SET status = 'afgewezen', responded_by_name = ?, responded_at = ?, reason = ?, updated_at = ? WHERE id = ?`)
          .run(str(user.display_name, 120), ts, str(reason, 1000), ts, r.id);
      } else {
        q('UPDATE work_order_offers SET declined = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...declinedOf(r), tenantId].slice(-500)), ts, r.id);
      }
      return { row: find(r.id) };
    });
  }

  /**
   * Aannemen: de ontvanger krijgt een eigen werkorder met de gegevens van
   * dat moment. Fouten: not_found, closed (al aangenomen of ingetrokken),
   * gone (de werkorder is bij de uitbesteder weg of al in uitvoering).
   */
  function accept(user, tenantId, id, { receiverName }) {
    return transaction(db, () => {
      const r = find(id);
      const problem = problemFor(r, tenantId);
      if (problem) return { error: problem };
      const w = offerable(r.tenant_id, r.work_order_id);
      if (!w || !OFFERABLE.includes(w.status)) return { error: 'gone' };
      const wo = workorders.createReceived({ ...user, tenant_id: tenantId }, handoverOf(parse(w.data, {})));
      const ts = now();
      q(`UPDATE work_order_offers SET status = 'geaccepteerd', receiver_tenant_id = ?, receiver_name = ?, received_work_order_id = ?,
          responded_by_name = ?, responded_at = ?, updated_at = ? WHERE id = ?`)
        .run(tenantId, str(receiverName, 200), wo.id, str(user.display_name, 120), ts, ts, r.id);
      return { row: find(r.id), workOrder: wo };
    });
  }

  return { offer, outgoing, incoming, marks, withdraw, decline, accept, find, outgoingView, incomingView };
}

/**
 * API-routes. ctx: { outsourcing, store, requireRight, requireJson, audit,
 * settingsForTenant(id), tenantActive(id), mailerFor(settings) }. Alles achter
 * het recht 'uitbesteden' (beheerder); de instelling van de actieve omgeving
 * bepaalt of versturen en ontvangen aan staan.
 */
function registerOutsourcingRoutes(app, ctx) {
  const { outsourcing, store, requireRight, requireJson, audit, settingsForTenant } = ctx;
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const requireOut = requireRight('uitbesteden');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const optsOf = (tenantId) => settingsForTenant(tenantId).get('outsourcing');
  const envOf = (tenantId) => store.getTenant(tenantId)?.environment || 'live';
  // Bedrijfsnaam uit de eigen bedrijfsgegevens (Offertes), anders de naam van de tenant.
  const nameOf = (tenantId) => {
    const s = settingsForTenant(tenantId);
    const own = s.view().quoteProfile.source === 'instellingen' ? str(s.get('quoteProfile').companyName, 200) : '';
    return own || store.getTenant(tenantId)?.name || 'Onbekende organisatie';
  };
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Aanbod niet gevonden.' });
  const off = (res, what) => res.status(409).json({ error: 'outsourcing_off', message: `${what} staat uit voor je organisatie. Een beheerder zet het aan in Beheer → Instellingen → Uitbesteden.` });

  // Organisaties die opdrachten ontvangen (zelfde soort omgeving, actief, niet zichzelf).
  function partners(tenantId) {
    const env = envOf(tenantId);
    const all = [];
    for (const live of store.listTenants()) all.push(live, ...(live.environments || []));
    return all
      .filter((t) => t.id !== tenantId && (t.environment || 'live') === env && tenantActive(t.id) && optsOf(t.id).receive)
      .map((t) => ({ id: t.id, name: nameOf(t.id), region: optsOf(t.id).region }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }

  // Bericht per e-mail, als de verzendende omgeving een mailserver heeft en de ontvanger een adres.
  function mail(viaTenantId, toTenantIds, subject, lines) {
    const settings = settingsForTenant(viaTenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return;
    const p = settings.get('quoteProfile');
    const to = [...new Set(toTenantIds.map((id) => settingsForTenant(id).get('quoteProfile').email).filter(validEmail))];
    if (!to.length) return;
    // Elke organisatie een eigen bericht (geen adressen van anderen zichtbaar).
    for (const addr of to) {
      mailer.send({ to: addr, replyTo: p.email, subject, ...mailBody(p, lines, null) })
        .catch((err) => console.warn(`Bericht over uitbesteden niet verstuurd: ${err.message}`));
    }
  }

  app.get('/api/outsourcing', requireOut, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const t = tid(req);
    const opts = optsOf(t);
    res.json({
      settings: opts,
      environment: envOf(t),
      partners: opts.send ? partners(t) : [],
      incoming: opts.receive ? outsourcing.incoming(t, envOf(t), { active: tenantActive }) : [],
      outgoing: outsourcing.outgoing(t),
    });
  });

  app.post('/api/outsourcing/offers', requireJson, requireOut, (req, res) => {
    const t = tid(req);
    if (!optsOf(t).send) return off(res, 'Uitbesteden');
    const b = req.body || {};
    const fee = b.fee === undefined || b.fee === null || b.fee === '' ? null : Number(b.fee);
    if (fee !== null && !(Number.isFinite(fee) && fee >= 0 && fee <= MAX_FEE)) return res.status(400).json({ error: 'invalid_fee', message: 'Ongeldige vergoeding.' });
    const toTenantId = b.toTenantId ? String(b.toTenantId) : null;
    const list = partners(t);
    if (!list.length) return res.status(409).json({ error: 'no_partners', message: 'Er zijn nog geen organisaties die opdrachten ontvangen.' });
    const target = toTenantId ? list.find((p) => p.id === toTenantId) : null;
    if (toTenantId && !target) return res.status(400).json({ error: 'invalid_partner', message: 'Deze organisatie ontvangt geen opdrachten.' });
    const out = outsourcing.offer(req.user, t, b.workOrderId, {
      toTenantId, toName: target?.name, message: b.message, fee: fee === null ? null : Math.round(fee * 100) / 100, fromName: nameOf(t),
    });
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
    if (out.error === 'status') return res.status(409).json({ error: 'status', message: 'Alleen een werkorder met status Nieuw of Gepland kan worden uitbesteed.' });
    if (out.error === 'active') return res.status(409).json({ error: 'active', message: 'Deze werkorder is al uitbesteed of aangeboden.' });
    audit(req, 'opdracht_aangeboden', { offerId: out.offer.id, workOrderId: out.offer.workOrderId, aan: target ? target.name : 'iedereen' });
    const p = out.offer.preview;
    mail(t, target ? [target.id] : list.map((x) => x.id), `Opdracht aangeboden door ${nameOf(t)}`, [
      `${nameOf(t)} biedt een opdracht aan${target ? ' aan uw organisatie' : ' aan organisaties die opdrachten ontvangen'}: ${p.title}${p.place ? ` in ${p.place}` : ''}.`,
      out.offer.message,
      'Bekijk het aanbod en neem het aan in de module Uitbesteden.',
    ]);
    res.status(201).json(out.offer);
  });

  app.delete('/api/outsourcing/offers/:id', requireOut, (req, res) => {
    const out = outsourcing.withdraw(tid(req), req.params.id);
    if (out.error === 'not_found') return notFound(res);
    if (out.error) return res.status(409).json({ error: 'closed', message: 'Dit aanbod is al aangenomen of afgewezen en kan niet meer worden ingetrokken.' });
    audit(req, 'opdracht_ingetrokken', { offerId: out.offer.id, workOrderId: out.offer.workOrderId });
    res.json(out.offer);
  });

  // Reageren kan alleen met ontvangen aan en vanuit hetzelfde soort omgeving.
  function respondable(req, res) {
    const t = tid(req);
    if (!optsOf(t).receive) { off(res, 'Opdrachten ontvangen'); return null; }
    const r = outsourcing.find(req.params.id);
    if (!r || envOf(r.tenant_id) !== envOf(t) || !tenantActive(r.tenant_id)) { notFound(res); return null; }
    return { t, r };
  }
  const closed = (res) => res.status(409).json({ error: 'closed', message: 'Dit aanbod is niet meer beschikbaar: al aangenomen of ingetrokken.' });

  app.post('/api/outsourcing/offers/:id/accept', requireJson, requireOut, (req, res) => {
    const ok = respondable(req, res);
    if (!ok) return;
    const out = outsourcing.accept(req.user, ok.t, ok.r.id, { receiverName: nameOf(ok.t) });
    if (out.error === 'not_found') return notFound(res);
    if (out.error === 'closed') return closed(res);
    if (out.error === 'gone') return res.status(409).json({ error: 'gone', message: 'De werkorder is bij de uitbesteder niet meer beschikbaar.' });
    audit(req, 'opdracht_aangenomen', { offerId: ok.r.id, workOrderId: out.workOrder.id, number: out.workOrder.number, van: ok.r.from_name });
    audit(req, 'opdracht_aangenomen', { offerId: ok.r.id, workOrderId: ok.r.work_order_id, door: nameOf(ok.t) }, null, ok.r.tenant_id);
    mail(ok.t, [ok.r.tenant_id], `Opdracht aangenomen door ${nameOf(ok.t)}`, [
      `${nameOf(ok.t)} heeft uw opdracht "${outsourcing.outgoingView(out.row).preview.title}" aangenomen (hun werkorder ${out.workOrder.number}).`,
      'De voortgang ziet u in de module Uitbesteden en bij de werkorder.',
    ]);
    res.json({ offer: outsourcing.incomingView(out.row, ok.t), workOrder: out.workOrder });
  });

  app.post('/api/outsourcing/offers/:id/decline', requireJson, requireOut, (req, res) => {
    const ok = respondable(req, res);
    if (!ok) return;
    const reason = str(req.body?.reason, 1000);
    const out = outsourcing.decline(req.user, ok.t, ok.r.id, reason);
    if (out.error === 'not_found') return notFound(res);
    if (out.error) return closed(res);
    audit(req, 'opdracht_afgewezen', { offerId: ok.r.id, van: ok.r.from_name });
    if (ok.r.to_tenant_id) {
      audit(req, 'opdracht_afgewezen', { offerId: ok.r.id, workOrderId: ok.r.work_order_id, door: nameOf(ok.t) }, null, ok.r.tenant_id);
      mail(ok.t, [ok.r.tenant_id], `Opdracht afgewezen door ${nameOf(ok.t)}`, [
        `${nameOf(ok.t)} neemt uw opdracht "${outsourcing.outgoingView(out.row).preview.title}" niet aan.`,
        reason ? `Toelichting: ${reason}` : '',
      ]);
    }
    res.json({ offer: outsourcing.incomingView(out.row, ok.t) });
  });
}

module.exports = { createOutsourcingStore, registerOutsourcingRoutes, sanitizeOutsourcing, placeOf, previewOf, handoverOf };
