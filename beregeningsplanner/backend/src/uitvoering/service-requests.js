// Meldingen: een klant meldt via het klantportaal zelf een storing of vraagt
// onderhoud aan, met een omschrijving en foto's. Medewerkers (recht
// 'werkorders') zien de meldingen in de module Meldingen, sturen de klant een
// antwoord en maken er met één klik een werkorder van. Die werkorder hangt via
// service_requests.work_order_id aan de klant, zodat hij hem in zijn portaal
// ziet (afspraak bevestigen, voortgang), ook zonder offerte.
//
// Foto's van de klant: verkleind in de browser, op inhoud gecontroleerd en
// zonder EXIF (photos.inspectImage) versleuteld opgeslagen (vault.sealBytes,
// AAD = tenant + melding-foto-id). Bij het omzetten gaan ze als foto's "voor"
// mee naar de werkorder.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { createMailer, validEmail } = require('../platform/mailer');
const { inspectImage, fromBase64, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, MAX_SIDE } = require('./photos');
const { mailBody } = require('../verkoop/quotes');

const KINDS = { storing: 'Storing', onderhoud: 'Onderhoud', overig: 'Vraag of verzoek' };
const STATUSES = {
  nieuw: 'Nieuw', in_behandeling: 'In behandeling', ingepland: 'Werkorder gemaakt',
  afgehandeld: 'Afgehandeld', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken door klant',
};
// Statussen waarin de melding nog loopt (klant kan foto's toevoegen of intrekken).
const OPEN = ['nieuw', 'in_behandeling'];
// Wat een medewerker zelf kan kiezen; 'ingepland' volgt uit het maken van de werkorder.
const STAFF_STATUSES = ['nieuw', 'in_behandeling', 'afgehandeld', 'afgewezen'];
const PREFIX = 'M-';
const MAX_PHOTOS = 6;
const now = () => new Date().toISOString();
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r\n?/g, '\n').trim().slice(0, max);

function createServiceRequestStore(db, { vault, workorders, photos }) {
  const q = (sql) => db.prepare(sql);
  const aad = (tenantId, id, part) => `${tenantId}:melding-foto:${id}:${part}`;

  // Overzicht en detail: zonder de foto's zelf; aantal foto's en de stand van
  // de werkorder in dezelfde query.
  const COLS = `sr.id, sr.number, sr.customer_id, sr.customer_name, sr.kind, sr.urgent, sr.subject, sr.description, sr.address,
    sr.phone, sr.email, sr.preferred, sr.installation_id, sr.status, sr.reply, sr.note, sr.handled_by_name, sr.work_order_id,
    sr.created_at, sr.updated_at, w.number AS wo_number, w.status AS wo_status, w.planned_date AS wo_planned,
    i.number AS inst_number, i.title AS inst_title,
    (SELECT COUNT(*) FROM service_request_photos p WHERE p.tenant_id = sr.tenant_id AND p.request_id = sr.id) AS photo_count`;
  const FROM = `FROM service_requests sr
    LEFT JOIN work_orders w ON w.id = sr.work_order_id AND w.tenant_id = sr.tenant_id AND w.deleted_at IS NULL
    LEFT JOIN work_orders i ON i.id = sr.installation_id AND i.tenant_id = sr.tenant_id AND i.deleted_at IS NULL`;

  function row(r) {
    return {
      id: r.id, number: r.number, kind: r.kind, kindLabel: KINDS[r.kind] || r.kind, urgent: Boolean(r.urgent),
      subject: r.subject, description: r.description, address: r.address, phone: r.phone, email: r.email, preferred: r.preferred,
      status: r.status, statusLabel: STATUSES[r.status] || r.status, reply: r.reply, note: r.note, handledBy: r.handled_by_name || '',
      customer: { id: r.customer_id || null, name: r.customer_name },
      installation: r.installation_id && r.inst_number ? { id: r.installation_id, number: r.inst_number, title: r.inst_title } : null,
      workOrder: r.work_order_id && r.wo_number ? { id: r.work_order_id, number: r.wo_number, status: r.wo_status, plannedDate: r.wo_planned || '' } : null,
      photoCount: Number(r.photo_count) || 0, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** Meldingen van de omgeving (nieuwste eerst). open: alleen lopende; customerId: alleen van die klant. */
  function list(tenantId, { open = false, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${COLS} ${FROM} WHERE sr.tenant_id = ?`;
    if (open) sql += " AND sr.status IN ('nieuw', 'in_behandeling')";
    if (customerId) { sql += ' AND sr.customer_id = ?'; args.push(String(customerId)); }
    return q(`${sql} ORDER BY sr.created_at DESC LIMIT 500`).all(...args).map(row);
  }

  /** Aantal nieuwe meldingen (voor een teller). */
  const countNew = (tenantId) => Number(q("SELECT COUNT(*) AS n FROM service_requests WHERE tenant_id = ? AND status = 'nieuw'").get(tenantId).n);

  function photoList(tenantId, id, base) {
    return q('SELECT id, mime, width, height, size, created_at FROM service_request_photos WHERE tenant_id = ? AND request_id = ? ORDER BY created_at, id')
      .all(tenantId, String(id)).map((p) => ({
        id: p.id, mime: p.mime, width: p.width, height: p.height, size: p.size, createdAt: p.created_at,
        url: `${base}/${p.id}`, thumbUrl: `${base}/${p.id}?thumb=1`,
      }));
  }

  /** Eén melding met de foto's. customerId: alleen als hij van die klant is (dan zonder interne notitie). */
  function get(tenantId, id, { customerId = null } = {}) {
    const args = [tenantId, String(id)];
    let sql = `SELECT ${COLS} ${FROM} WHERE sr.tenant_id = ? AND sr.id = ?`;
    if (customerId) { sql += ' AND sr.customer_id = ?'; args.push(String(customerId)); }
    const r = q(sql).get(...args);
    if (!r) return null;
    const out = row(r);
    out.photos = photoList(tenantId, r.id, customerId ? `api/portal/requests/${r.id}/photos` : `api/service-requests/${r.id}/photos`);
    return customerId ? forCustomer(out) : out;
  }

  // Meldingnummer per tenant en jaar: M-<jaar>-0001, oplopend.
  function nextNumber(tenantId, year) {
    const head = `${PREFIX}${year}-`;
    let max = 0;
    for (const r of q('SELECT number FROM service_requests WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const n = Number(r.number.slice(head.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /** Invoer van de klant controleren; { error } of de velden. */
  function sanitize(input) {
    const d = input && typeof input === 'object' ? input : {};
    const out = {
      kind: KINDS[d.kind] ? d.kind : 'storing',
      urgent: d.kind !== 'overig' && Boolean(d.urgent),
      subject: str(d.subject, 200),
      description: str(d.description, 4000),
      address: str(d.address, 400),
      phone: str(d.phone, 40),
      email: str(d.email, 200),
      preferred: str(d.preferred, 300),
      installationId: d.installationId ? String(d.installationId).slice(0, 64) : null,
    };
    if (!out.subject) return { error: 'subject_required', message: 'Geef een korte omschrijving (onderwerp).' };
    if (out.description.length < 10) return { error: 'description_required', message: 'Beschrijf wat er aan de hand is (minstens een paar woorden).' };
    if (out.email && !validEmail(out.email)) return { error: 'invalid_email', message: 'Ongeldig e-mailadres.' };
    return { value: out };
  }

  /** Nieuwe melding van een klant. installationOk(id): hoort die werkorder bij de klant. */
  function create(user, tenantId, input, { installationOk = () => false } = {}) {
    const s = sanitize(input);
    if (s.error) return s;
    const v = s.value;
    if (v.installationId && !installationOk(v.installationId)) return { error: 'invalid_installation', message: 'Onbekende installatie.' };
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const ts = now();
      const number = nextNumber(tenantId, ts.slice(0, 4));
      q(`INSERT INTO service_requests (id, tenant_id, number, customer_id, customer_name, kind, urgent, subject, description, address, phone, email,
          preferred, installation_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nieuw', ?, ?)`)
        .run(id, tenantId, number, user.id, str(user.display_name || user.displayName || '', 200), v.kind, v.urgent ? 1 : 0, v.subject, v.description,
          v.address, v.phone, v.email || str(user.email, 200), v.preferred, v.installationId, ts, ts);
      return { item: get(tenantId, id) };
    });
  }

  const find = (tenantId, id, customerId = null) => q(`SELECT id, tenant_id, number, status, work_order_id FROM service_requests
    WHERE tenant_id = ? AND id = ?${customerId ? ' AND customer_id = ?' : ''}`).get(tenantId, String(id), ...(customerId ? [String(customerId)] : []));

  /** Foto bij een lopende melding (klant). */
  function addPhoto(tenantId, requestId, customerId, input) {
    const r = find(tenantId, requestId, customerId);
    if (!r) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(r.status)) return { error: 'closed', status: 409, message: 'Bij deze melding kunnen geen foto\'s meer worden toegevoegd.' };
    const n = Number(q('SELECT COUNT(*) AS n FROM service_request_photos WHERE tenant_id = ? AND request_id = ?').get(tenantId, r.id).n);
    if (n >= MAX_PHOTOS) return { error: 'too_many_photos', status: 409, message: `Maximaal ${MAX_PHOTOS} foto's per melding.` };
    const raw = fromBase64(input && input.image);
    if (!raw) return { error: 'invalid_photo', status: 400, message: 'Geen geldige afbeelding.' };
    if (raw.length > MAX_IMAGE_BYTES) return { error: 'photo_too_large', status: 413, message: 'De foto is te groot (maximaal 4 MB).' };
    const img = inspectImage(raw);
    if (!img || img.width > MAX_SIDE || img.height > MAX_SIDE) return { error: 'invalid_photo', status: 400, message: 'Alleen JPEG, PNG of WebP.' };
    let thumb = img;
    if (input.thumb !== undefined && input.thumb !== null && input.thumb !== '') {
      const t = fromBase64(input.thumb);
      thumb = t && t.length <= MAX_THUMB_BYTES ? inspectImage(t) : null;
      if (!thumb) return { error: 'invalid_photo', status: 400, message: 'Ongeldige miniatuur.' };
    }
    const id = crypto.randomUUID();
    const ts = now();
    q(`INSERT INTO service_request_photos (id, tenant_id, request_id, mime, width, height, size, image, thumb, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, r.id, img.mime, img.width, img.height, img.body.length,
        vault.sealBytes(img.body, aad(tenantId, id, 'beeld')), vault.sealBytes(thumb.body, aad(tenantId, id, 'mini')), ts);
    q('UPDATE service_requests SET updated_at = ? WHERE id = ?').run(ts, r.id);
    return { photo: photoList(tenantId, r.id, `api/portal/requests/${r.id}/photos`).find((p) => p.id === id) };
  }

  function removePhoto(tenantId, requestId, customerId, photoId) {
    const r = find(tenantId, requestId, customerId);
    if (!r) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(r.status)) return { error: 'closed', status: 409, message: 'Deze melding is al in behandeling genomen.' };
    const n = q('DELETE FROM service_request_photos WHERE tenant_id = ? AND request_id = ? AND id = ?').run(tenantId, r.id, String(photoId)).changes;
    return n ? { ok: true } : { error: 'not_found', status: 404, message: 'Foto niet gevonden.' };
  }

  /** Afbeelding of miniatuur ontsleuteld; customerId: alleen van een melding van die klant. */
  function photoFile(tenantId, requestId, photoId, { thumb = false, customerId = null } = {}) {
    const r = q(`SELECT p.id, p.mime, p.${thumb ? 'thumb' : 'image'} AS data FROM service_request_photos p
      JOIN service_requests sr ON sr.id = p.request_id AND sr.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.request_id = ? AND p.id = ?${customerId ? ' AND sr.customer_id = ?' : ''}`)
      .get(tenantId, String(requestId), String(photoId), ...(customerId ? [String(customerId)] : []));
    if (!r) return null;
    const body = vault.openBytes(r.data, aad(tenantId, r.id, thumb ? 'mini' : 'beeld'));
    return { mime: inspectImage(body)?.mime || r.mime, body };
  }

  /** Klant trekt een lopende melding in. */
  function withdraw(tenantId, id, customerId) {
    const r = find(tenantId, id, customerId);
    if (!r) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(r.status)) return { error: 'closed', status: 409, message: 'Deze melding loopt niet meer.' };
    q("UPDATE service_requests SET status = 'ingetrokken', updated_at = ? WHERE id = ?").run(now(), r.id);
    return { item: get(tenantId, r.id, { customerId }) };
  }

  /** Medewerker: status, antwoord aan de klant en interne notitie. */
  function update(user, tenantId, id, input) {
    const r = q('SELECT id, status, reply, note, work_order_id FROM service_requests WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!r) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    const d = input && typeof input === 'object' ? input : {};
    let status = r.status;
    if (d.status !== undefined) {
      if (!STAFF_STATUSES.includes(d.status)) return { error: 'invalid_status', status: 400, message: 'Ongeldige status.' };
      if (r.work_order_id && OPEN.includes(d.status)) return { error: 'has_workorder', status: 409, message: 'Er is al een werkorder van deze melding gemaakt.' };
      status = d.status;
    }
    const reply = d.reply === undefined ? r.reply : str(d.reply, 4000);
    const note = d.note === undefined ? r.note : str(d.note, 4000);
    q('UPDATE service_requests SET status = ?, reply = ?, note = ?, handled_by = ?, handled_by_name = ?, updated_at = ? WHERE id = ?')
      .run(status, reply, note, user.kind === 'account' ? user.id : null, str(user.display_name || '', 200), now(), r.id);
    return { item: get(tenantId, r.id), changed: { status: status !== r.status, reply: reply !== r.reply } };
  }

  /**
   * Werkorder maken van een melding. Klantgegevens, omschrijving en (als de
   * melding over een installatie gaat) ontwerp en zone-indeling van die
   * installatie gaan mee; de foto's van de klant worden foto's "voor".
   */
  function toWorkOrder(user, tenantId, id, { assigneeId = null } = {}) {
    return transaction(db, () => {
      const r = q(`SELECT id, number, customer_name, kind, urgent, subject, description, address, phone, email, preferred, installation_id, status, work_order_id
        FROM service_requests WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
      if (!r) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
      if (r.work_order_id) return { error: 'has_workorder', status: 409, message: 'Van deze melding is al een werkorder gemaakt.' };
      if (r.status === 'ingetrokken' || r.status === 'afgewezen') return { error: 'closed', status: 409, message: 'Deze melding is ingetrokken of afgewezen.' };
      const inst = r.installation_id ? workorders.get(tenantId, r.installation_id) : null;
      const d = inst ? inst.data : {};
      const steps = r.kind === 'onderhoud'
        ? [{ phase: 'uitvoering', title: 'Onderhoud uitvoeren (controle sproeiers, zones en besturing)', hours: 1.5 }]
        : [{ phase: 'uitvoering', title: 'Storing opsporen en verhelpen', details: r.subject, hours: 1 }];
      steps.push({ phase: 'oplevering', title: 'Installatie testen en de klant informeren', hours: 0.5 });
      const lines = [`Melding ${r.number} (${KINDS[r.kind] || r.kind}${r.urgent ? ', spoed' : ''}): ${r.subject}`, '', r.description];
      if (r.preferred) lines.push('', `Voorkeur van de klant: ${r.preferred}`);
      if (inst) lines.push('', `Installatie: werkorder ${inst.number} (${inst.title}).`);
      const data = {
        title: `${KINDS[r.kind] || 'Melding'}: ${r.subject}`.slice(0, 200),
        customer: { name: r.customer_name || (d.customer && d.customer.name) || '', address: r.address || (d.customer && d.customer.address) || '', email: r.email, phone: r.phone },
        instructions: lines.join('\n'),
        design: d.design || null, zones: d.zones || [], heads: d.heads || [],
        steps, materials: [],
      };
      const wo = workorders.createReceived({ id: user.id, tenant_id: tenantId }, data, { assigneeId });
      q("UPDATE service_requests SET status = 'ingepland', work_order_id = ?, handled_by = ?, handled_by_name = ?, updated_at = ? WHERE id = ?")
        .run(wo.id, user.kind === 'account' ? user.id : null, str(user.display_name || '', 200), now(), r.id);
      // Foto's van de klant mee als foto's "voor" (zichtbaar voor de klant: ze zijn van hem).
      let copied = 0;
      if (photos) {
        for (const p of q('SELECT id FROM service_request_photos WHERE tenant_id = ? AND request_id = ? ORDER BY created_at, id').all(tenantId, r.id)) {
          const img = photoFile(tenantId, r.id, p.id);
          const th = photoFile(tenantId, r.id, p.id, { thumb: true });
          const out = photos.add(user, tenantId, wo.id, { image: img.body.toString('base64'), thumb: th.body.toString('base64'), kind: 'voor', caption: `Foto van de klant (melding ${r.number})` });
          if (!out.error) copied++;
        }
      }
      return { item: get(tenantId, r.id), workOrder: workorders.get(tenantId, wo.id), photosCopied: copied };
    });
  }

  return { list, get, countNew, create, addPhoto, removePhoto, photoFile, withdraw, update, toWorkOrder, nextNumber, sanitize };
}

// Wat de klant van zijn melding ziet: geen interne notitie.
function forCustomer(item) {
  const { note, ...rest } = item;
  return rest;
}

/**
 * Routes. ctx: { requests, portal, workorders, requireRight, requireJson, audit,
 * remoteIp, createRateLimiter, mailerFor, settingsOf, staffTenantsOf }.
 * Klant (recht 'portaal'): /api/portal/requests…; medewerkers (recht
 * 'werkorders'): /api/service-requests…; gegevens van de actieve omgeving.
 */
function registerServiceRequestRoutes(app, ctx) {
  const { requests, portal, workorders, requireRight, requireJson, audit } = ctx;
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const requirePortal = requireRight('portaal');
  const requireWo = requireRight('werkorders');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, message: out.message });
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Melding niet gevonden.' });
  const passthrough = (req, res, next) => next();
  // Per klant (of bezoeker): meldingen en foto's begrenzen.
  const limiter = (max) => (ctx.createRateLimiter
    ? ctx.createRateLimiter({ windowMs: 60 * 60 * 1000, max, keyFn: (req) => `${tid(req)}|${req.user?.id || remoteIp(req)}` })
    : passthrough);
  const createLimiter = limiter(10);
  const photoLimiter = limiter(60);

  function send(res, f) {
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', f.body.length);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.end(f.body);
  }

  // E-mail (als er een mailserver is); fouten alleen in het log.
  function mail(req, to, subject, lines, what) {
    if (!ctx.settingsOf) return;
    const settings = ctx.settingsOf(req);
    const mailer = mailerFor(settings);
    const p = settings.get('quoteProfile') || {};
    if (!mailer.configured() || !validEmail(to)) return;
    mailer.send({ to, subject, ...mailBody(p, lines, null) })
      .catch((err) => console.warn(`Bericht over ${what} niet verstuurd: ${err.message}`));
  }
  const profileOf = (req) => (ctx.settingsOf ? ctx.settingsOf(req).get('quoteProfile') || {} : {});

  // Naar het bedrijf bij een nieuwe melding.
  function notifyNew(req, item) {
    mail(req, profileOf(req).email, `${item.urgent ? 'SPOED: ' : ''}Melding ${item.number}: ${item.subject}`, [
      `Nieuwe melding ${item.number} van ${item.customer.name || 'een klant'}${item.urgent ? ' (spoed)' : ''}: ${item.kindLabel.toLowerCase()}.`,
      `Onderwerp: ${item.subject}`, item.description,
      [item.address ? `Adres: ${item.address}` : '', item.phone ? `Telefoon: ${item.phone}` : ''].filter(Boolean).join('\n'),
      'Bekijk en behandel de melding in de module Meldingen.',
    ], `melding ${item.number}`);
  }

  // Naar de klant als hij een (nieuw) antwoord heeft gekregen.
  function notifyReply(req, item) {
    if (!item.reply) return;
    mail(req, item.email, `Reactie op uw melding ${item.number}`, [
      `Er is gereageerd op uw melding ${item.number} (${item.subject}). Status: ${item.statusLabel}.`,
      item.reply, 'U vindt de melding ook in uw klantportaal.',
    ], `melding ${item.number}`);
  }

  // ---------- Klant (portaal) ----------
  app.get('/api/portal/requests', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: requests.list(tid(req), { customerId: req.user.id }).map(forCustomer) });
  });

  app.get('/api/portal/requests/:id', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const item = requests.get(tid(req), req.params.id, { customerId: req.user.id });
    if (!item) return notFound(res);
    res.json(item);
  });

  app.post('/api/portal/requests', requireJson, requirePortal, createLimiter, (req, res) => {
    const t = tid(req);
    const out = requests.create(req.user, t, req.body, { installationOk: (id) => Boolean(portal.ownRow(t, req.user.id, id)) });
    if (out.error) return fail(res, out);
    audit(req, 'melding_aangemaakt', { requestId: out.item.id, number: out.item.number, kind: out.item.kind });
    notifyNew(req, out.item);
    res.status(201).json(forCustomer(out.item));
  });

  app.post('/api/portal/requests/:id/photos', requireJson, requirePortal, photoLimiter, (req, res) => {
    const out = requests.addPhoto(tid(req), req.params.id, req.user.id, req.body || {});
    if (out.error) return fail(res, out);
    audit(req, 'melding_foto_toegevoegd', { requestId: req.params.id, photoId: out.photo.id });
    res.status(201).json(out.photo);
  });

  app.delete('/api/portal/requests/:id/photos/:pid', requirePortal, (req, res) => {
    const out = requests.removePhoto(tid(req), req.params.id, req.user.id, req.params.pid);
    if (out.error) return fail(res, out);
    res.json({ ok: true });
  });

  app.get('/api/portal/requests/:id/photos/:pid', requirePortal, (req, res) => {
    const f = requests.photoFile(tid(req), req.params.id, req.params.pid, { thumb: req.query.thumb === '1', customerId: req.user.id });
    if (!f) return notFound(res);
    send(res, f);
  });

  app.post('/api/portal/requests/:id/withdraw', requireJson, requirePortal, (req, res) => {
    const out = requests.withdraw(tid(req), req.params.id, req.user.id);
    if (out.error) return fail(res, out);
    audit(req, 'melding_ingetrokken', { requestId: req.params.id });
    res.json(out.item);
  });

  // ---------- Medewerkers ----------
  app.get('/api/service-requests', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: requests.list(tid(req), { open: req.query.open === '1' }), kinds: KINDS, statuses: STATUSES });
  });

  app.get('/api/service-requests/:id', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const item = requests.get(tid(req), req.params.id);
    if (!item) return notFound(res);
    res.json(item);
  });

  app.put('/api/service-requests/:id', requireJson, requireWo, (req, res) => {
    const out = requests.update(req.user, tid(req), req.params.id, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'melding_bijgewerkt', { requestId: out.item.id, number: out.item.number, status: out.item.status });
    if (out.changed.reply) notifyReply(req, out.item);
    res.json(out.item);
  });

  app.post('/api/service-requests/:id/workorder', requireJson, requireWo, (req, res) => {
    let assigneeId = null;
    const raw = req.body && req.body.assigneeId;
    if (raw) {
      if (!workorders.staff(ctx.staffTenantsOf(req)).some((u) => u.id === String(raw))) return res.status(400).json({ error: 'invalid_assignee', message: 'Onbekende medewerker.' });
      assigneeId = String(raw);
    }
    const out = requests.toWorkOrder(req.user, tid(req), req.params.id, { assigneeId });
    if (out.error) return fail(res, out);
    audit(req, 'melding_werkorder', { requestId: out.item.id, number: out.item.number, workOrderId: out.workOrder.id });
    res.status(201).json(out);
  });

  app.get('/api/service-requests/:id/photos/:pid', requireWo, (req, res) => {
    const f = requests.photoFile(tid(req), req.params.id, req.params.pid, { thumb: req.query.thumb === '1' });
    if (!f) return notFound(res);
    send(res, f);
  });
}

module.exports = { createServiceRequestStore, registerServiceRequestRoutes, forCustomer, KINDS, STATUSES, MAX_PHOTOS };
