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
const { jsonDigest } = require('../database/db');
const Roles = require('../../../frontend/shared/roles.js');

const KINDS = { voor: 'Voor', tijdens: 'Tijdens', oplevering: 'Oplevering' };
const MAX_PER_WORK_ORDER = 100;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 300 * 1024;
const MAX_SIDE = 8000;
// Een miniatuur is klein (de browser maakt hem op 480 px): een grote "miniatuur" weigeren.
const MAX_THUMB_SIDE = 1024;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

// ---------- Afbeeldingen controleren ----------

/**
 * Doorloopt de JPEG-segmenten: afmetingen uit SOF; APP1 (EXIF/XMP, met GPS), APP13 (IPTC) en commentaar gaan eruit.
 * @param {Buffer} buffer Het JPEG-bestand.
 * @returns {{ mime: string, width: number, height: number, body: Buffer }|null} Het opgeschoonde bestand met afmetingen, of null bij een ongeldige JPEG.
 */
function cleanJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const parts = [buffer.subarray(0, 2)];
  let position = 2;
  let width = 0;
  let height = 0;
  while (position + 4 <= buffer.length) {
    if (buffer[position] !== 0xff) return null;
    const marker = buffer[position + 1];
    if (marker === 0xff) { position++; continue; }
    if (marker === 0xda) { parts.push(buffer.subarray(position)); break; } // start of scan: rest is beelddata
    if (marker === 0xd9) return null;
    const segmentLength = buffer.readUInt16BE(position + 2);
    if (segmentLength < 2 || position + 2 + segmentLength > buffer.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && segmentLength >= 7) {
      height = buffer.readUInt16BE(position + 5);
      width = buffer.readUInt16BE(position + 7);
    }
    // APP1 (EXIF, XMP), APP13 (IPTC) en COM laten we weg; de rest (ook APP0/JFIF, kleurprofiel APP2) blijft.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(buffer.subarray(position, position + 2 + segmentLength));
    position += 2 + segmentLength;
  }
  if (!width || !height || parts.length < 2 || parts[parts.length - 1][1] !== 0xda) return null;
  return { mime: 'image/jpeg', width, height, body: Buffer.concat(parts) };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Herkent het formaat aan de inhoud (niet aan wat de browser zegt).
 * @param {Buffer} buffer Het bestand.
 * @returns {{ mime: string, width: number, height: number, body: Buffer }|null} JPEG (opgeschoond), PNG of WebP met afmetingen, of null.
 */
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return cleanJpeg(buffer);
  if (buffer.subarray(0, 8).equals(PNG_SIG) && buffer.toString('latin1', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), body: buffer };
  }
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP' && buffer.length >= 30) {
    const chunk = buffer.toString('latin1', 12, 16);
    let width = 0;
    let height = 0;
    if (chunk === 'VP8 ') { width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L') { const header = buffer.readUInt32LE(21); width = (header & 0x3fff) + 1; height = ((header >> 14) & 0x3fff) + 1; }
    else if (chunk === 'VP8X') { width = buffer.readUIntLE(24, 3) + 1; height = buffer.readUIntLE(27, 3) + 1; }
    return width && height ? { mime: 'image/webp', width, height, body: buffer } : null;
  }
  return null;
}

/**
 * Zet base64 (eventueel als data-URL) om naar een Buffer.
 * @param {string} text De base64-tekst.
 * @returns {Buffer|null} De bytes, of null bij ongeldige invoer.
 */
function fromBase64(text) {
  if (typeof text !== 'string' || !text) return null;
  const payload = text.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) return null;
  return Buffer.from(payload, 'base64');
}

/**
 * Of een waarde een ISO-datum of -tijdstip is.
 * @param {*} value De invoer.
 * @returns {boolean} True bij een geldig tijdstip.
 */
const isIsoTime = (value) => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value));

// ---------- Opslag ----------

/**
 * Maakt de opslag voor foto's bij werkorders (versleuteld in de database).
 * @param {object} db De database.
 * @param {{ vault: object }} stores De kluis (sealBytes/openBytes).
 * @returns {object} list, listMany, counts, add, update, remove, removeAll, file, customerOwns, KINDS en MAX_PER_WORK_ORDER.
 */
function createPhotoStore(db, { vault }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * AAD voor het versleutelen van een foto.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de foto.
   * @param {string} part 'beeld' of 'mini'.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id, part) => `${tenantId}:foto:${id}:${part}`;
  const META = 'p.id, p.work_order_id, p.uploaded_by, p.kind, p.caption, p.customer_visible, p.mime, p.width, p.height, p.size, p.taken_at, p.created_at';

  /**
   * Zet een fotorij om naar het formaat van de API.
   * @param {object} row Rij met META (en eventueel uploader_name).
   * @param {Function} urlOf Maakt de URL van de foto (medewerker of portaal).
   * @returns {object} De foto zonder beelddata.
   */
  function meta(row, urlOf) {
    return {
      id: row.id, workOrderId: row.work_order_id, kind: row.kind, caption: row.caption,
      customerVisible: Boolean(row.customer_visible), mime: row.mime, width: row.width, height: row.height, size: row.size,
      takenAt: row.taken_at || null, createdAt: row.created_at,
      uploadedBy: row.uploaded_by ? { id: row.uploaded_by, displayName: row.uploader_name || '' } : null,
      url: urlOf(row), thumbUrl: `${urlOf(row)}?thumb=1`,
    };
  }
  /**
   * URL van een foto voor medewerkers.
   * @param {object} row De fotorij.
   * @returns {string} Relatieve URL.
   */
  const staffUrl = (row) => `api/workorders/${row.work_order_id}/photos/${row.id}`;
  /**
   * URL van een foto in het klantportaal.
   * @param {object} row De fotorij.
   * @returns {string} Relatieve URL.
   */
  const portalUrl = (row) => `api/portal/photos/${row.id}`;

  /**
   * Een werkorder van de tenant die nog bestaat.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de werkorder.
   * @returns {object|undefined} id, status en quote_id.
   */
  const workOrder = (tenantId, id) => prepare('SELECT id, status, quote_id FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));

  /**
   * Foto's van een werkorder, oudste eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {string} workOrderId Id van de werkorder.
   * @param {{ customerOnly?: boolean }} [options] Alleen wat de klant mag zien, met de portaal-URL en zonder uploader.
   * @returns {object[]} De foto's.
   */
  function list(tenantId, workOrderId, { customerOnly = false } = {}) {
    const rows = prepare(`SELECT ${META}, u.display_name AS uploader_name FROM work_order_photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.tenant_id = ? AND p.work_order_id = ?${customerOnly ? ' AND p.customer_visible = 1' : ''} ORDER BY p.created_at, p.id`)
      .all(tenantId, String(workOrderId));
    return rows.map((row) => {
      const photo = meta(row, customerOnly ? portalUrl : staffUrl);
      if (customerOnly) delete photo.uploadedBy;
      return photo;
    });
  }

  /**
   * Aantal foto's per werkorder van de tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string[]|null} [ids] Alleen deze werkorders.
   * @returns {object} Werkorder-id → aantal.
   */
  function counts(tenantId, ids = null) {
    const out = {};
    if (ids && !ids.length) return out;
    const only = ids ? ` AND work_order_id IN (${ids.map(() => '?').join(', ')})` : '';
    for (const row of prepare(`SELECT work_order_id, COUNT(*) AS n FROM work_order_photos WHERE tenant_id = ?${only} GROUP BY work_order_id`)
      .all(tenantId, ...(ids || []).map(String))) out[row.work_order_id] = Number(row.n);
    return out;
  }

  /**
   * Foto's van meerdere werkorders in één query.
   * @param {string} tenantId Id van de tenant.
   * @param {string[]} workOrderIds De werkorders.
   * @returns {object} Werkorder-id → lijst foto's.
   */
  function listMany(tenantId, workOrderIds) {
    const out = {};
    for (const id of workOrderIds) out[id] = [];
    if (!workOrderIds.length) return out;
    const rows = prepare(`SELECT ${META}, u.display_name AS uploader_name FROM work_order_photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.tenant_id = ? AND p.work_order_id IN (${workOrderIds.map(() => '?').join(', ')}) ORDER BY p.created_at, p.id`)
      .all(tenantId, ...workOrderIds.map(String));
    for (const row of rows) out[row.work_order_id].push(meta(row, staffUrl));
    return out;
  }

  /**
   * Voegt een foto toe: formaat op inhoud gecontroleerd, metadata eruit, beeld en miniatuur versleuteld.
   * @param {object|null} user Wie de foto maakt.
   * @param {string} tenantId Id van de tenant.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} input image en thumb (base64), kind, caption, customerVisible en takenAt.
   * @returns {{ photo: object, thumbMime: string }|{ error: string, status: number, message: string }} De foto, of een fout.
   */
  function add(user, tenantId, workOrderId, input) {
    const workOrderRow = workOrder(tenantId, workOrderId);
    if (!workOrderRow) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const photoCount = Number(prepare('SELECT COUNT(*) AS n FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?').get(tenantId, workOrderRow.id).n);
    if (photoCount >= MAX_PER_WORK_ORDER) return { error: 'too_many_photos', status: 409, message: `Maximaal ${MAX_PER_WORK_ORDER} foto's per werkorder.` };
    const raw = fromBase64(input.image);
    if (!raw) return { error: 'invalid_photo', status: 400, message: 'Geen geldige afbeelding.' };
    if (raw.length > MAX_IMAGE_BYTES) return { error: 'photo_too_large', status: 413, message: 'De foto is te groot (maximaal 4 MB).' };
    const image = inspectImage(raw);
    if (!image || image.width > MAX_SIDE || image.height > MAX_SIDE) return { error: 'invalid_photo', status: 400, message: 'Alleen JPEG, PNG of WebP.' };
    let thumb = image;
    if (input.thumb !== undefined && input.thumb !== null && input.thumb !== '') {
      const thumbBuffer = fromBase64(input.thumb);
      thumb = thumbBuffer && thumbBuffer.length <= MAX_THUMB_BYTES ? inspectImage(thumbBuffer) : null;
      if (thumb && (thumb.width > MAX_THUMB_SIDE || thumb.height > MAX_THUMB_SIDE)) thumb = null;
      if (!thumb) return { error: 'invalid_photo', status: 400, message: 'Ongeldige miniatuur.' };
    }
    const kind = KINDS[input.kind] ? input.kind : 'oplevering';
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    prepare(`INSERT INTO work_order_photos (id, tenant_id, work_order_id, uploaded_by, kind, caption, customer_visible, mime, width, height, size, taken_at, image, thumb, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, workOrderRow.id, user && user.kind === 'account' ? user.id : null, kind, String(input.caption || '').trim().slice(0, 300),
        input.customerVisible === false ? 0 : 1, image.mime, image.width, image.height, image.body.length,
        isIsoTime(input.takenAt) ? new Date(input.takenAt).toISOString() : null,
        vault.sealBytes(image.body, aadOf(tenantId, id, 'beeld')), vault.sealBytes(thumb.body, aadOf(tenantId, id, 'mini')), timestamp);
    return { photo: list(tenantId, workOrderRow.id).find((photo) => photo.id === id), thumbMime: thumb.mime };
  }

  /**
   * Wijzigt soort, bijschrift of zichtbaarheid voor de klant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} workOrderId Id van de werkorder.
   * @param {string} id Id van de foto.
   * @param {object} input kind, caption en customerVisible.
   * @returns {object|null} De foto, of null.
   */
  function update(tenantId, workOrderId, id, input) {
    const row = prepare('SELECT id, work_order_id, kind, caption, customer_visible FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ? AND id = ?').get(tenantId, String(workOrderId), String(id));
    if (!row) return null;
    const kind = KINDS[input.kind] ? input.kind : row.kind;
    const caption = input.caption === undefined ? row.caption : String(input.caption || '').trim().slice(0, 300);
    const visible = input.customerVisible === undefined ? row.customer_visible : input.customerVisible ? 1 : 0;
    prepare('UPDATE work_order_photos SET kind = ?, caption = ?, customer_visible = ? WHERE id = ?').run(kind, caption, visible, row.id);
    return list(tenantId, row.work_order_id).find((photo) => photo.id === row.id);
  }

  /**
   * Verwijdert een foto.
   * @param {string} tenantId Id van de tenant.
   * @param {string} workOrderId Id van de werkorder.
   * @param {string} id Id van de foto.
   * @returns {boolean} Of de foto bestond.
   */
  const remove = (tenantId, workOrderId, id) => prepare('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ? AND id = ?')
    .run(tenantId, String(workOrderId), String(id)).changes > 0;
  /**
   * Verwijdert alle foto's van een werkorder.
   * @param {string} tenantId Id van de tenant.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {number} Aantal verwijderde foto's.
   */
  const removeAll = (tenantId, workOrderId) => prepare('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?')
    .run(tenantId, String(workOrderId)).changes;

  /**
   * Een afbeelding (of miniatuur) ontsleuteld.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de foto.
   * @param {{ thumb?: boolean, workOrderId?: string }} [options] Miniatuur, en alleen als de foto bij deze werkorder hoort.
   * @returns {{ mime: string, body: Buffer, workOrderId: string, customerVisible: boolean }|null} Het bestand, of null.
   */
  function file(tenantId, id, { thumb = false, workOrderId = null } = {}) {
    const row = prepare(`SELECT p.id, p.work_order_id, p.mime, p.customer_visible, p.${thumb ? 'thumb' : 'image'} AS data FROM work_order_photos p
      JOIN work_orders w ON w.id = p.work_order_id AND w.deleted_at IS NULL WHERE p.tenant_id = ? AND p.id = ?`).get(tenantId, String(id));
    if (!row || (workOrderId && row.work_order_id !== String(workOrderId))) return null;
    const body = vault.openBytes(row.data, aadOf(tenantId, row.id, thumb ? 'mini' : 'beeld'));
    return { mime: inspectImage(body)?.mime || row.mime, body, workOrderId: row.work_order_id, customerVisible: Boolean(row.customer_visible) };
  }

  /**
   * Mag deze klant de foto zien: zichtbaar gezet en de werkorder hoort via de offerte (niet verwijderd,
   * geen concept: zelfde regel als het opleverdossier) of via zijn melding bij hem.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de foto.
   * @param {string} userId Id van de klant.
   * @returns {boolean} True als de klant de foto mag zien.
   */
  function customerOwns(tenantId, id, userId) {
    return Boolean(prepare(`SELECT 1 AS ok FROM work_order_photos p JOIN work_orders w ON w.id = p.work_order_id AND w.deleted_at IS NULL
      WHERE p.tenant_id = ? AND p.id = ? AND p.customer_visible = 1
        AND (EXISTS (SELECT 1 FROM quotes o WHERE o.id = w.quote_id AND o.tenant_id = w.tenant_id
          AND o.deleted_at IS NULL AND o.customer_id = ? AND o.status <> 'concept')
        OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`)
      .get(tenantId, String(id), String(userId), String(userId)));
  }

  return { list, listMany, counts, add, update, remove, removeAll, file, customerOwns, KINDS, MAX_PER_WORK_ORDER };
}

// ---------- Klantdossier ----------

/**
 * Maakt een klantnaam vergelijkbaar (kleine letters, enkele spaties).
 * @param {string} name De naam.
 * @returns {string} De genormaliseerde naam.
 */
const normalizeName = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * Sleutel van een dossier zonder klantaccount: een hash van de naam.
 * @param {string} name De klantnaam.
 * @returns {string} "n-" plus 16 tekens hex.
 */
const nameKey = (name) => `n-${crypto.createHash('sha256').update(normalizeName(name)).digest('hex').slice(0, 16)}`;

/**
 * Maakt de opslag voor klantdossiers (werkorders per klant).
 * @param {object} db De database.
 * @param {{ photos: object }} stores De foto-opslag.
 * @returns {{ list: Function, get: Function }} De opslagfuncties.
 */
function createDossierStore(db, { photos }) {
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
  /**
   * Leest de werkorderdata en zet de dossiersleutel erbij (a-<klant-id> of n-<hash van de naam>).
   * @param {object} row De werkorderrij.
   * @returns {object} De rij met data en key.
   */
  const withKey = (row) => ({ ...row, data: JSON.parse(row.data), key: row.customer_id ? `a-${row.customer_id}` : nameKey(row.customer) });

  /**
   * Werkorders voor het overzicht: van de data alleen het opleververslag (datum gereed).
   * @param {string} tenantId Id van de tenant.
   * @returns {object[]} De rijen met key.
   */
  const listRows = (tenantId) => prepare(`SELECT ${COLS}, ${jsonDigest(db, 'w.data', { values: ['report'] })} AS data ${FROM}`).all(tenantId).map(withKey);

  /**
   * Werkorders van één dossier: met een klantaccount direct op dat account;
   * anders eerst de namen (de sleutel is een hash van de naam), dan alleen die
   * werkorders volledig.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key De dossiersleutel.
   * @returns {object[]} De rijen met data en key.
   */
  function dossierRows(tenantId, key) {
    if (key.startsWith('a-')) return prepare(`SELECT ${COLS}, w.data ${FROM} AND o.customer_id = ?`).all(tenantId, key.slice(2)).map(withKey);
    const ids = prepare(`SELECT w.id, w.customer ${FROM} AND o.customer_id IS NULL`).all(tenantId)
      .filter((row) => nameKey(row.customer) === key).map((row) => row.id);
    if (!ids.length) return [];
    return prepare(`SELECT ${COLS}, w.data ${FROM} AND o.customer_id IS NULL AND w.id IN (${ids.map(() => '?').join(', ')})`).all(tenantId, ...ids).map(withKey);
  }

  /**
   * De opleverdatum van een werkorder.
   * @param {object} row De werkorderrij met data.
   * @returns {string} Datum (JJJJ-MM-DD), of leeg.
   */
  const completedOf = (row) => row.data.report?.completedOn || (row.status === 'gereed' ? row.updated_at.slice(0, 10) : '');

  /**
   * Alle klanten met een werkorder: één regel per dossier, laatst actief eerst.
   * @param {string} tenantId Id van de tenant.
   * @returns {object[]} De dossiers met aantallen.
   */
  function list(tenantId) {
    const photoCounts = photos.counts(tenantId);
    const byKey = new Map();
    for (const row of listRows(tenantId)) {
      let dossier = byKey.get(row.key);
      if (!dossier) {
        dossier = { key: row.key, name: row.customer || row.account_name || 'Onbekende klant', account: row.customer_id ? { id: row.customer_id, displayName: row.account_name || '' } : null,
          addresses: [], installations: 0, completed: 0, photos: 0, lastCompletedOn: '', lastActivity: '' };
        byKey.set(row.key, dossier);
      }
      if (row.address && !dossier.addresses.includes(row.address)) dossier.addresses.push(row.address);
      dossier.installations++;
      if (row.status === 'gereed') dossier.completed++;
      dossier.photos += photoCounts[row.id] || 0;
      const done = completedOf(row);
      if (done > dossier.lastCompletedOn) dossier.lastCompletedOn = done;
      if (row.updated_at > dossier.lastActivity) { dossier.lastActivity = row.updated_at; if (row.customer) dossier.name = row.customer; }
    }
    return [...byKey.values()].sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
  }

  /**
   * Eén dossier: klantgegevens, installaties (nieuwste eerst) met foto's, en de offertes.
   * @param {string} tenantId Id van de tenant.
   * @param {string} key De dossiersleutel.
   * @returns {object|null} Het dossier, of null.
   */
  function get(tenantId, key) {
    const mine = dossierRows(tenantId, String(key));
    if (!mine.length) return null;
    const photosOf = photos.listMany(tenantId, mine.map((row) => row.id));
    mine.sort((left, right) => (completedOf(right) || right.planned_date || right.created_at).localeCompare(completedOf(left) || left.planned_date || left.created_at));
    const latest = [...mine].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    const customer = latest.data.customer || {};
    const accountId = latest.customer_id || null;
    const installations = mine.map((row) => {
      const details = row.data;
      return {
        id: row.id, number: row.number, status: row.status, title: row.title, address: row.address,
        plannedDate: row.planned_date || '', completedOn: completedOf(row),
        assignee: row.assignee_name || '', crew: details.crew || '',
        quoteId: row.quote_id || null, quoteNumber: details.quoteNumber || '', planId: details.planId || null, planTitle: details.planTitle || '',
        report: { notes: details.report?.notes || '', completedOn: details.report?.completedOn || '', signedBy: details.report?.signedBy || '' },
        design: details.design || null, zones: details.zones || [],
        materials: (details.materials || []).map((material) => ({ code: material.code, description: material.description, qty: material.qty, unit: material.unit })),
        steps: { total: (details.steps || []).length, done: (details.steps || []).filter((step) => step.done).length },
        photos: photosOf[row.id],
      };
    });
    const quoteIds = [...new Set(mine.map((row) => row.quote_id).filter(Boolean))];
    const args = [tenantId];
    let where = 'tenant_id = ? AND deleted_at IS NULL AND (';
    const ors = [];
    if (accountId) { ors.push('customer_id = ?'); args.push(accountId); }
    if (quoteIds.length) { ors.push(`id IN (${quoteIds.map(() => '?').join(',')})`); args.push(...quoteIds); }
    where += `${ors.join(' OR ')})`;
    const quoteList = (ors.length ? prepare(`SELECT id, number, status, title, total_incl, created_at FROM quotes WHERE ${where} ORDER BY created_at DESC`).all(...args) : [])
      .map((quote) => ({ id: quote.id, number: quote.number, status: quote.status, title: quote.title, totalIncl: quote.total_incl, createdAt: quote.created_at }));
    return {
      key: String(key),
      customer: { name: latest.customer || customer.name || latest.account_name || '', contact: customer.contact || '', email: customer.email || '', phone: customer.phone || '' },
      account: accountId ? { id: accountId, displayName: latest.account_name || '' } : null,
      addresses: [...new Set(mine.map((row) => row.address).filter(Boolean))],
      installations, quotes: quoteList,
    };
  }

  return { list, get };
}

// ---------- Routes ----------

/**
 * Registreert de routes voor foto's en klantdossiers. Medewerkers (recht
 * 'werkorders') beheren foto's en zien de dossiers; een klant haalt alleen de
 * foto's op die bij zijn eigen werkorders horen (/api/portal/photos/:id).
 * @param {object} app De Express-app.
 * @param {object} ctx photos, dossiers, requireRight, requireUser, requireJson, identify en audit.
 */
function registerPhotoRoutes(app, ctx) {
  const { photos, dossiers, requireRight, requireUser, requireJson, identify, audit } = ctx;
  const requireWo = requireRight('werkorders');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt het antwoord 404.
   * @param {object} res Het Express-antwoord.
   * @param {string} [what] Wat er niet gevonden is.
   * @returns {object} Het antwoord.
   */
  const notFound = (res, what = 'Foto') => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });

  /**
   * Stuurt een afbeelding; alleen de eigen browser mag hem een dag bewaren (een foto verandert nooit).
   * @param {object} res Het Express-antwoord.
   * @param {{ mime: string, body: Buffer }} file Het bestand.
   */
  function send(res, file) {
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.body.length);
    // Een foto verandert nooit (nieuwe foto = nieuw id); alleen de eigen browser bewaart hem.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.end(file.body);
  }

  app.get('/api/workorders/:id/photos', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: photos.list(tenantOf(req), req.params.id), max: photos.MAX_PER_WORK_ORDER, kinds: photos.KINDS });
  });

  app.post('/api/workorders/:id/photos', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = photos.add(req.user, tenantOf(req), req.params.id, body);
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'foto_toegevoegd', { workOrderId: req.params.id, photoId: out.photo.id, kind: out.photo.kind });
    res.status(201).json(out.photo);
  });

  app.patch('/api/workorders/:id/photos/:pid', requireJson, requireWo, (req, res) => {
    const photo = photos.update(tenantOf(req), req.params.id, req.params.pid, req.body || {});
    if (!photo) return notFound(res);
    res.json(photo);
  });

  app.delete('/api/workorders/:id/photos/:pid', requireWo, (req, res) => {
    if (!photos.remove(tenantOf(req), req.params.id, req.params.pid)) return notFound(res);
    audit(req, 'foto_verwijderd', { workOrderId: req.params.id, photoId: req.params.pid });
    res.json({ ok: true });
  });

  app.get('/api/workorders/:id/photos/:pid', requireWo, (req, res) => {
    const file = photos.file(tenantOf(req), req.params.pid, { thumb: req.query.thumb === '1', workOrderId: req.params.id });
    if (!file) return notFound(res);
    send(res, file);
  });

  // Klantportaal: een klant ziet alleen zichtbaar gezette foto's van zijn eigen werkorders.
  app.get('/api/portal/photos/:pid', requireUser, (req, res) => {
    const user = req.user || identify(req);
    const tenantId = tenantOf(req);
    if (!Roles.can(user, 'werkorders') && !photos.customerOwns(tenantId, req.params.pid, user.id)) return notFound(res);
    const file = photos.file(tenantId, req.params.pid, { thumb: req.query.thumb === '1' });
    if (!file) return notFound(res);
    send(res, file);
  });

  // ---------- Klantdossiers (medewerkers) ----------
  app.get('/api/dossiers', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: dossiers.list(tenantOf(req)) });
  });

  app.get('/api/dossiers/:key', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const dossier = dossiers.get(tenantOf(req), req.params.key);
    if (!dossier) return notFound(res, 'Dossier');
    res.json(dossier);
  });
}

module.exports = { createPhotoStore, createDossierStore, registerPhotoRoutes, inspectImage, cleanJpeg, fromBase64, KINDS, MAX_PER_WORK_ORDER, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, MAX_SIDE, MAX_THUMB_SIDE };
