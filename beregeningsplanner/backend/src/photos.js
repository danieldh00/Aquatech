// Foto's bij werkorders en het klantdossier.
//
// Foto's: de ploeg maakt bij een werkorder foto's (voor, tijdens, oplevering)
// om vast te leggen hoe een installatie is opgeleverd. De browser verkleint
// en hercodeert ze (zonder EXIF/GPS); de server controleert het formaat,
// haalt bij JPEG alsnog metadata weg en bewaart afbeelding en miniatuur
// versleuteld in de database (vault.sealBytes, AAD = tenant + foto-id). Zo
// gaan ze mee in de versleutelde back-ups en in een overstap naar PostgreSQL,
// en wist het verwijderen van een tenant ze ook.
//
// Klantdossier: alle werkorders (installaties) van één klant met de
// opleverinformatie, het ontwerp, de geplaatste materialen en de foto's. Een
// klant hoort bij een dossier via zijn account (quotes.customer_id) of, zonder
// account, via de klantnaam op de werkorder.
const crypto = require('crypto');
const { jsonDigest } = require('./db');
const Roles = require('../../frontend/shared/roles.js');

const KINDS = { voor: 'Voor', tijdens: 'Tijdens', oplevering: 'Oplevering' };
const MAX_PER_WORK_ORDER = 100;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 300 * 1024;
const MAX_SIDE = 8000;
const now = () => new Date().toISOString();

// ---------- Afbeeldingen controleren ----------

/** JPEG-segmenten doorlopen: afmetingen uit SOF, APP1 (EXIF/XMP, met GPS) en commentaar eruit. */
function cleanJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xda) { parts.push(buf.subarray(i)); break; } // start of scan: rest is beelddata
    if (marker === 0xd9) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && len >= 7) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    // APP1 (EXIF, XMP), APP13 (IPTC) en COM laten we weg; de rest (ook APP0/JFIF, kleurprofiel APP2) blijft.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!width || !height || parts.length < 2 || parts[parts.length - 1][1] !== 0xda) return null;
  return { mime: 'image/jpeg', width, height, body: Buffer.concat(parts) };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Formaat herkennen aan de inhoud (niet aan wat de browser zegt). */
function inspectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return cleanJpeg(buf);
  if (buf.subarray(0, 8).equals(PNG_SIG) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), body: buf };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    let width = 0;
    let height = 0;
    if (chunk === 'VP8 ') { width = buf.readUInt16LE(26) & 0x3fff; height = buf.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); width = (b & 0x3fff) + 1; height = ((b >> 14) & 0x3fff) + 1; }
    else if (chunk === 'VP8X') { width = buf.readUIntLE(24, 3) + 1; height = buf.readUIntLE(27, 3) + 1; }
    return width && height ? { mime: 'image/webp', width, height, body: buf } : null;
  }
  return null;
}

/** Base64 (eventueel als data-URL) naar Buffer; null bij ongeldige invoer. */
function fromBase64(v) {
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

const isIsoTime = (v) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v));

// ---------- Opslag ----------

function createPhotoStore(db, { vault }) {
  const q = (sql) => db.prepare(sql);
  const aad = (tenantId, id, part) => `${tenantId}:foto:${id}:${part}`;
  const META = 'p.id, p.work_order_id, p.uploaded_by, p.kind, p.caption, p.customer_visible, p.mime, p.width, p.height, p.size, p.taken_at, p.created_at';

  function meta(r, url) {
    return {
      id: r.id, workOrderId: r.work_order_id, kind: r.kind, caption: r.caption,
      customerVisible: Boolean(r.customer_visible), mime: r.mime, width: r.width, height: r.height, size: r.size,
      takenAt: r.taken_at || null, createdAt: r.created_at,
      uploadedBy: r.uploaded_by ? { id: r.uploaded_by, displayName: r.uploader_name || '' } : null,
      url: url(r), thumbUrl: `${url(r)}?thumb=1`,
    };
  }
  const staffUrl = (r) => `api/workorders/${r.work_order_id}/photos/${r.id}`;
  const portalUrl = (r) => `api/portal/photos/${r.id}`;

  const workOrder = (tenantId, id) => q('SELECT id, status, quote_id FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));

  /** Foto's van een werkorder (oudste eerst). customerOnly: alleen wat de klant mag zien, met de portaal-URL. */
  function list(tenantId, workOrderId, { customerOnly = false } = {}) {
    const rows = q(`SELECT ${META}, u.display_name AS uploader_name FROM work_order_photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.tenant_id = ? AND p.work_order_id = ?${customerOnly ? ' AND p.customer_visible = 1' : ''} ORDER BY p.created_at, p.id`)
      .all(tenantId, String(workOrderId));
    return rows.map((r) => {
      const m = meta(r, customerOnly ? portalUrl : staffUrl);
      if (customerOnly) delete m.uploadedBy;
      return m;
    });
  }

  /** Aantal foto's per werkorder van de tenant; ids: alleen die werkorders. */
  function counts(tenantId, ids = null) {
    const out = {};
    if (ids && !ids.length) return out;
    const only = ids ? ` AND work_order_id IN (${ids.map(() => '?').join(', ')})` : '';
    for (const r of q(`SELECT work_order_id, COUNT(*) AS n FROM work_order_photos WHERE tenant_id = ?${only} GROUP BY work_order_id`)
      .all(tenantId, ...(ids || []).map(String))) out[r.work_order_id] = Number(r.n);
    return out;
  }

  /** Foto's van meerdere werkorders in één query: { werkorder-id: [foto, ...] }. */
  function listMany(tenantId, workOrderIds) {
    const out = {};
    for (const id of workOrderIds) out[id] = [];
    if (!workOrderIds.length) return out;
    const rows = q(`SELECT ${META}, u.display_name AS uploader_name FROM work_order_photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.tenant_id = ? AND p.work_order_id IN (${workOrderIds.map(() => '?').join(', ')}) ORDER BY p.created_at, p.id`)
      .all(tenantId, ...workOrderIds.map(String));
    for (const r of rows) out[r.work_order_id].push(meta(r, staffUrl));
    return out;
  }

  function add(user, tenantId, workOrderId, input) {
    const wo = workOrder(tenantId, workOrderId);
    if (!wo) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const n = Number(q('SELECT COUNT(*) AS n FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?').get(tenantId, wo.id).n);
    if (n >= MAX_PER_WORK_ORDER) return { error: 'too_many_photos', status: 409, message: `Maximaal ${MAX_PER_WORK_ORDER} foto's per werkorder.` };
    const raw = fromBase64(input.image);
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
    const kind = KINDS[input.kind] ? input.kind : 'oplevering';
    const id = crypto.randomUUID();
    const ts = now();
    q(`INSERT INTO work_order_photos (id, tenant_id, work_order_id, uploaded_by, kind, caption, customer_visible, mime, width, height, size, taken_at, image, thumb, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, wo.id, user && user.kind === 'account' ? user.id : null, kind, String(input.caption || '').trim().slice(0, 300),
        input.customerVisible === false ? 0 : 1, img.mime, img.width, img.height, img.body.length,
        isIsoTime(input.takenAt) ? new Date(input.takenAt).toISOString() : null,
        vault.sealBytes(img.body, aad(tenantId, id, 'beeld')), vault.sealBytes(thumb.body, aad(tenantId, id, 'mini')), ts);
    return { photo: list(tenantId, wo.id).find((p) => p.id === id), thumbMime: thumb.mime };
  }

  function update(tenantId, workOrderId, id, input) {
    const r = q('SELECT id, work_order_id, kind, caption, customer_visible FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ? AND id = ?').get(tenantId, String(workOrderId), String(id));
    if (!r) return null;
    const kind = KINDS[input.kind] ? input.kind : r.kind;
    const caption = input.caption === undefined ? r.caption : String(input.caption || '').trim().slice(0, 300);
    const visible = input.customerVisible === undefined ? r.customer_visible : input.customerVisible ? 1 : 0;
    q('UPDATE work_order_photos SET kind = ?, caption = ?, customer_visible = ? WHERE id = ?').run(kind, caption, visible, r.id);
    return list(tenantId, r.work_order_id).find((p) => p.id === r.id);
  }

  const remove = (tenantId, workOrderId, id) => q('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ? AND id = ?')
    .run(tenantId, String(workOrderId), String(id)).changes > 0;
  const removeAll = (tenantId, workOrderId) => q('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?')
    .run(tenantId, String(workOrderId)).changes;

  /** Afbeelding (of miniatuur) ontsleuteld: { mime, body, workOrderId, customerVisible }. */
  function file(tenantId, id, { thumb = false, workOrderId = null } = {}) {
    const r = q(`SELECT p.id, p.work_order_id, p.mime, p.customer_visible, p.${thumb ? 'thumb' : 'image'} AS data FROM work_order_photos p
      JOIN work_orders w ON w.id = p.work_order_id AND w.deleted_at IS NULL WHERE p.tenant_id = ? AND p.id = ?`).get(tenantId, String(id));
    if (!r || (workOrderId && r.work_order_id !== String(workOrderId))) return null;
    const body = vault.openBytes(r.data, aad(tenantId, r.id, thumb ? 'mini' : 'beeld'));
    return { mime: inspectImage(body)?.mime || r.mime, body, workOrderId: r.work_order_id, customerVisible: Boolean(r.customer_visible) };
  }

  /** Mag deze klant de foto zien: zichtbaar gezet en de werkorder hoort via de offerte (of zijn melding) bij hem. */
  function customerOwns(tenantId, id, userId) {
    return Boolean(q(`SELECT 1 AS ok FROM work_order_photos p JOIN work_orders w ON w.id = p.work_order_id AND w.deleted_at IS NULL
      WHERE p.tenant_id = ? AND p.id = ? AND p.customer_visible = 1
        AND (EXISTS (SELECT 1 FROM quotes o WHERE o.id = w.quote_id AND o.tenant_id = w.tenant_id AND o.customer_id = ?)
        OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`)
      .get(tenantId, String(id), String(userId), String(userId)));
  }

  return { list, listMany, counts, add, update, remove, removeAll, file, customerOwns, KINDS, MAX_PER_WORK_ORDER };
}

// ---------- Klantdossier ----------

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const nameKey = (s) => `n-${crypto.createHash('sha256').update(normName(s)).digest('hex').slice(0, 16)}`;

function createDossierStore(db, { photos }) {
  const q = (sql) => db.prepare(sql);

  const FROM = `FROM work_orders w LEFT JOIN quotes o ON o.id = w.quote_id AND o.tenant_id = w.tenant_id
      LEFT JOIN users c ON c.id = o.customer_id LEFT JOIN users a ON a.id = w.assignee_id
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'`;
  const COLS = `w.id, w.number, w.status, w.title, w.customer, w.address, w.planned_date, w.created_at, w.updated_at,
        w.quote_id, o.customer_id, c.display_name AS account_name, a.display_name AS assignee_name`;
  const withKey = (r) => ({ ...r, data: JSON.parse(r.data), key: r.customer_id ? `a-${r.customer_id}` : nameKey(r.customer) });

  // Overzicht: van de werkorderdata alleen het opleververslag (datum gereed).
  const listRows = (tenantId) => q(`SELECT ${COLS}, ${jsonDigest(db, 'w.data', { values: ['report'] })} AS data ${FROM}`).all(tenantId).map(withKey);

  // Eén dossier: met een klantaccount direct op dat account; anders eerst de
  // namen (de sleutel is een hash van de naam), dan alleen die werkorders volledig.
  function dossierRows(tenantId, key) {
    if (key.startsWith('a-')) return q(`SELECT ${COLS}, w.data ${FROM} AND o.customer_id = ?`).all(tenantId, key.slice(2)).map(withKey);
    const ids = q(`SELECT w.id, w.customer ${FROM} AND o.customer_id IS NULL`).all(tenantId)
      .filter((r) => nameKey(r.customer) === key).map((r) => r.id);
    if (!ids.length) return [];
    return q(`SELECT ${COLS}, w.data ${FROM} AND o.customer_id IS NULL AND w.id IN (${ids.map(() => '?').join(', ')})`).all(tenantId, ...ids).map(withKey);
  }

  const completedOf = (r) => r.data.report?.completedOn || (r.status === 'gereed' ? r.updated_at.slice(0, 10) : '');

  /** Alle klanten met een werkorder: één regel per dossier. */
  function list(tenantId) {
    const pc = photos.counts(tenantId);
    const map = new Map();
    for (const r of listRows(tenantId)) {
      let d = map.get(r.key);
      if (!d) {
        d = { key: r.key, name: r.customer || r.account_name || 'Onbekende klant', account: r.customer_id ? { id: r.customer_id, displayName: r.account_name || '' } : null,
          addresses: [], installations: 0, completed: 0, photos: 0, lastCompletedOn: '', lastActivity: '' };
        map.set(r.key, d);
      }
      if (r.address && !d.addresses.includes(r.address)) d.addresses.push(r.address);
      d.installations++;
      if (r.status === 'gereed') d.completed++;
      d.photos += pc[r.id] || 0;
      const done = completedOf(r);
      if (done > d.lastCompletedOn) d.lastCompletedOn = done;
      if (r.updated_at > d.lastActivity) { d.lastActivity = r.updated_at; if (r.customer) d.name = r.customer; }
    }
    return [...map.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  /** Eén dossier: klantgegevens, installaties (nieuwste eerst) met foto's, en de offertes. */
  function get(tenantId, key) {
    const mine = dossierRows(tenantId, String(key));
    if (!mine.length) return null;
    const photosOf = photos.listMany(tenantId, mine.map((r) => r.id));
    mine.sort((a, b) => (completedOf(b) || b.planned_date || b.created_at).localeCompare(completedOf(a) || a.planned_date || a.created_at));
    const latest = [...mine].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    const c = latest.data.customer || {};
    const accountId = latest.customer_id || null;
    const installations = mine.map((r) => {
      const d = r.data;
      return {
        id: r.id, number: r.number, status: r.status, title: r.title, address: r.address,
        plannedDate: r.planned_date || '', completedOn: completedOf(r),
        assignee: r.assignee_name || '', crew: d.crew || '',
        quoteId: r.quote_id || null, quoteNumber: d.quoteNumber || '', planId: d.planId || null, planTitle: d.planTitle || '',
        report: { notes: d.report?.notes || '', completedOn: d.report?.completedOn || '', signedBy: d.report?.signedBy || '' },
        design: d.design || null, zones: d.zones || [],
        materials: (d.materials || []).map((m) => ({ code: m.code, description: m.description, qty: m.qty, unit: m.unit })),
        steps: { total: (d.steps || []).length, done: (d.steps || []).filter((s) => s.done).length },
        photos: photosOf[r.id],
      };
    });
    const quoteIds = [...new Set(mine.map((r) => r.quote_id).filter(Boolean))];
    const args = [tenantId];
    let where = 'tenant_id = ? AND deleted_at IS NULL AND (';
    const ors = [];
    if (accountId) { ors.push('customer_id = ?'); args.push(accountId); }
    if (quoteIds.length) { ors.push(`id IN (${quoteIds.map(() => '?').join(',')})`); args.push(...quoteIds); }
    where += `${ors.join(' OR ')})`;
    const quotes = (ors.length ? q(`SELECT id, number, status, title, total_incl, created_at FROM quotes WHERE ${where} ORDER BY created_at DESC`).all(...args) : [])
      .map((o) => ({ id: o.id, number: o.number, status: o.status, title: o.title, totalIncl: o.total_incl, createdAt: o.created_at }));
    return {
      key: String(key),
      customer: { name: latest.customer || c.name || latest.account_name || '', contact: c.contact || '', email: c.email || '', phone: c.phone || '' },
      account: accountId ? { id: accountId, displayName: latest.account_name || '' } : null,
      addresses: [...new Set(mine.map((r) => r.address).filter(Boolean))],
      installations, quotes,
    };
  }

  return { list, get };
}

// ---------- Routes ----------

/**
 * ctx: { photos, dossiers, requireRight, requireUser, requireJson, identify, audit }.
 * Medewerkers (recht 'werkorders') beheren foto's en zien de dossiers; een
 * klant haalt alleen de foto's op die bij zijn eigen werkorders horen
 * (/api/portal/photos/:id, gebruikt door het klantportaal).
 */
function registerPhotoRoutes(app, ctx) {
  const { photos, dossiers, requireRight, requireUser, requireJson, identify, audit } = ctx;
  const requireWo = requireRight('werkorders');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res, what = 'Foto') => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });

  function send(res, f) {
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', f.body.length);
    // Een foto verandert nooit (nieuwe foto = nieuw id); alleen de eigen browser bewaart hem.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.end(f.body);
  }

  app.get('/api/workorders/:id/photos', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: photos.list(tid(req), req.params.id), max: photos.MAX_PER_WORK_ORDER, kinds: photos.KINDS });
  });

  app.post('/api/workorders/:id/photos', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = photos.add(req.user, tid(req), req.params.id, body);
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'foto_toegevoegd', { workOrderId: req.params.id, photoId: out.photo.id, kind: out.photo.kind });
    res.status(201).json(out.photo);
  });

  app.patch('/api/workorders/:id/photos/:pid', requireJson, requireWo, (req, res) => {
    const p = photos.update(tid(req), req.params.id, req.params.pid, req.body || {});
    if (!p) return notFound(res);
    res.json(p);
  });

  app.delete('/api/workorders/:id/photos/:pid', requireWo, (req, res) => {
    if (!photos.remove(tid(req), req.params.id, req.params.pid)) return notFound(res);
    audit(req, 'foto_verwijderd', { workOrderId: req.params.id, photoId: req.params.pid });
    res.json({ ok: true });
  });

  app.get('/api/workorders/:id/photos/:pid', requireWo, (req, res) => {
    const f = photos.file(tid(req), req.params.pid, { thumb: req.query.thumb === '1', workOrderId: req.params.id });
    if (!f) return notFound(res);
    send(res, f);
  });

  // Klantportaal: een klant ziet alleen zichtbaar gezette foto's van zijn eigen werkorders.
  app.get('/api/portal/photos/:pid', requireUser, (req, res) => {
    const user = req.user || identify(req);
    const t = tid(req);
    if (!Roles.can(user, 'werkorders') && !photos.customerOwns(t, req.params.pid, user.id)) return notFound(res);
    const f = photos.file(t, req.params.pid, { thumb: req.query.thumb === '1' });
    if (!f) return notFound(res);
    send(res, f);
  });

  // ---------- Klantdossiers (medewerkers) ----------
  app.get('/api/dossiers', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: dossiers.list(tid(req)) });
  });

  app.get('/api/dossiers/:key', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const d = dossiers.get(tid(req), req.params.key);
    if (!d) return notFound(res, 'Dossier');
    res.json(d);
  });
}

module.exports = { createPhotoStore, createDossierStore, registerPhotoRoutes, inspectImage, cleanJpeg, fromBase64, KINDS, MAX_PER_WORK_ORDER, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, MAX_SIDE };
