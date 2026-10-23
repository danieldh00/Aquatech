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
const { inspectImage, fromBase64, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, MAX_SIDE, MAX_THUMB_SIDE } = require('./photos');
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
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt van een waarde nette tekst: regeleinden gelijkgetrokken, getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength) => (typeof value === 'string' ? value : value == null ? '' : String(value)).replace(/\r\n?/g, '\n').trim().slice(0, maxLength);

/**
 * Maakt de opslag voor meldingen van klanten (met versleutelde foto's).
 * @param {object} db De database.
 * @param {{ vault: object, workorders: object, photos: object }} stores De kluis, de werkorder- en de foto-opslag.
 * @returns {object} list, get, countNew, create, addPhoto, removePhoto, photoFile, withdraw, update, toWorkOrder, nextNumber en sanitize.
 */
function createServiceRequestStore(db, { vault, workorders, photos }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * AAD voor het versleutelen van een foto bij een melding.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de foto.
   * @param {string} part 'beeld' of 'mini'.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id, part) => `${tenantId}:melding-foto:${id}:${part}`;

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

  /**
   * Zet een meldingrij om naar het formaat van de API.
   * @param {object} requestRow Rij met COLS.
   * @returns {object} De melding zonder foto's.
   */
  function toRequest(requestRow) {
    return {
      id: requestRow.id, number: requestRow.number, kind: requestRow.kind, kindLabel: KINDS[requestRow.kind] || requestRow.kind, urgent: Boolean(requestRow.urgent),
      subject: requestRow.subject, description: requestRow.description, address: requestRow.address, phone: requestRow.phone, email: requestRow.email, preferred: requestRow.preferred,
      status: requestRow.status, statusLabel: STATUSES[requestRow.status] || requestRow.status, reply: requestRow.reply, note: requestRow.note, handledBy: requestRow.handled_by_name || '',
      customer: { id: requestRow.customer_id || null, name: requestRow.customer_name },
      installation: requestRow.installation_id && requestRow.inst_number ? { id: requestRow.installation_id, number: requestRow.inst_number, title: requestRow.inst_title } : null,
      workOrder: requestRow.work_order_id && requestRow.wo_number ? { id: requestRow.work_order_id, number: requestRow.wo_number, status: requestRow.wo_status, plannedDate: requestRow.wo_planned || '' } : null,
      photoCount: Number(requestRow.photo_count) || 0, createdAt: requestRow.created_at, updatedAt: requestRow.updated_at,
    };
  }

  /**
   * Meldingen van de omgeving, nieuwste eerst (hooguit 500).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ open?: boolean, customerId?: string }} [filters] Alleen lopende; alleen van die klant.
   * @returns {object[]} De meldingen.
   */
  function list(tenantId, { open = false, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${COLS} ${FROM} WHERE sr.tenant_id = ?`;
    if (open) sql += " AND sr.status IN ('nieuw', 'in_behandeling')";
    if (customerId) { sql += ' AND sr.customer_id = ?'; args.push(String(customerId)); }
    return prepare(`${sql} ORDER BY sr.created_at DESC LIMIT 500`).all(...args).map(toRequest);
  }

  /**
   * Aantal nieuwe meldingen (voor een teller).
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Het aantal.
   */
  const countNew = (tenantId) => Number(prepare("SELECT COUNT(*) AS n FROM service_requests WHERE tenant_id = ? AND status = 'nieuw'").get(tenantId).n);

  /**
   * De foto's van een melding (zonder beelddata).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {string} base Basis-URL voor de foto's (portaal of medewerker).
   * @returns {object[]} De foto's met URL.
   */
  function photoList(tenantId, id, base) {
    return prepare('SELECT id, mime, width, height, size, created_at FROM service_request_photos WHERE tenant_id = ? AND request_id = ? ORDER BY created_at, id')
      .all(tenantId, String(id)).map((photo) => ({
        id: photo.id, mime: photo.mime, width: photo.width, height: photo.height, size: photo.size, createdAt: photo.created_at,
        url: `${base}/${photo.id}`, thumbUrl: `${base}/${photo.id}?thumb=1`,
      }));
  }

  /**
   * Eén melding met de foto's.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {{ customerId?: string }} [options] Alleen als hij van die klant is (dan zonder interne notitie).
   * @returns {object|null} De melding, of null.
   */
  function get(tenantId, id, { customerId = null } = {}) {
    const args = [tenantId, String(id)];
    let sql = `SELECT ${COLS} ${FROM} WHERE sr.tenant_id = ? AND sr.id = ?`;
    if (customerId) { sql += ' AND sr.customer_id = ?'; args.push(String(customerId)); }
    const requestRow = prepare(sql).get(...args);
    if (!requestRow) return null;
    const out = toRequest(requestRow);
    out.photos = photoList(tenantId, requestRow.id, customerId ? `api/portal/requests/${requestRow.id}/photos` : `api/service-requests/${requestRow.id}/photos`);
    return customerId ? forCustomer(out) : out;
  }

  /**
   * Het volgende meldingnummer per tenant en jaar: M-<jaar>-0001.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} year Het jaar.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, year) {
    const head = `${PREFIX}${year}-`;
    let max = 0;
    for (const existing of prepare('SELECT number FROM service_requests WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const sequence = Number(existing.number.slice(head.length));
      if (Number.isInteger(sequence) && sequence > max) max = sequence;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * Controleert de invoer van de klant.
   * @param {object} input kind, urgent, subject, description, address, phone, email, preferred en installationId.
   * @returns {{ value: object }|{ error: string, message: string }} De velden, of een fout.
   */
  function sanitize(input) {
    const fields = input && typeof input === 'object' ? input : {};
    const out = {
      kind: KINDS[fields.kind] ? fields.kind : 'storing',
      urgent: fields.kind !== 'overig' && Boolean(fields.urgent),
      subject: cleanText(fields.subject, 200),
      description: cleanText(fields.description, 4000),
      address: cleanText(fields.address, 400),
      phone: cleanText(fields.phone, 40),
      email: cleanText(fields.email, 200),
      preferred: cleanText(fields.preferred, 300),
      installationId: fields.installationId ? String(fields.installationId).slice(0, 64) : null,
    };
    if (!out.subject) return { error: 'subject_required', message: 'Geef een korte omschrijving (onderwerp).' };
    if (out.description.length < 10) return { error: 'description_required', message: 'Beschrijf wat er aan de hand is (minstens een paar woorden).' };
    if (out.email && !validEmail(out.email)) return { error: 'invalid_email', message: 'Ongeldig e-mailadres.' };
    return { value: out };
  }

  /**
   * Nieuwe melding van een klant.
   * @param {object} user De klant.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} input De invoer (zie sanitize).
   * @param {{ installationOk?: Function }} [checks] installationOk(id): hoort die werkorder bij de klant.
   * @returns {{ item: object }|{ error: string, message: string }} De melding, of een fout.
   */
  function create(user, tenantId, input, { installationOk = () => false } = {}) {
    const checked = sanitize(input);
    if (checked.error) return checked;
    const fields = checked.value;
    if (fields.installationId && !installationOk(fields.installationId)) return { error: 'invalid_installation', message: 'Onbekende installatie.' };
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      const number = nextNumber(tenantId, timestamp.slice(0, 4));
      prepare(`INSERT INTO service_requests (id, tenant_id, number, customer_id, customer_name, kind, urgent, subject, description, address, phone, email,
          preferred, installation_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nieuw', ?, ?)`)
        .run(id, tenantId, number, user.id, cleanText(user.display_name || user.displayName || '', 200), fields.kind, fields.urgent ? 1 : 0, fields.subject, fields.description,
          fields.address, fields.phone, fields.email || cleanText(user.email, 200), fields.preferred, fields.installationId, timestamp, timestamp);
      return { item: get(tenantId, id) };
    });
  }

  /**
   * Zoekt een melding (eventueel alleen van een bepaalde klant).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {string|null} [customerId] Alleen van deze klant.
   * @returns {object|undefined} id, tenant_id, number, status en work_order_id.
   */
  const find = (tenantId, id, customerId = null) => prepare(`SELECT id, tenant_id, number, status, work_order_id FROM service_requests
    WHERE tenant_id = ? AND id = ?${customerId ? ' AND customer_id = ?' : ''}`).get(tenantId, String(id), ...(customerId ? [String(customerId)] : []));

  /**
   * Voegt een foto toe aan een lopende melding (klant): formaat op inhoud gecontroleerd, versleuteld opgeslagen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} requestId Id van de melding.
   * @param {string} customerId Id van de klant.
   * @param {object} input image en thumb (base64).
   * @returns {{ photo: object }|{ error: string, status: number, message: string }} De foto, of een fout.
   */
  function addPhoto(tenantId, requestId, customerId, input) {
    const requestRow = find(tenantId, requestId, customerId);
    if (!requestRow) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(requestRow.status)) return { error: 'closed', status: 409, message: 'Bij deze melding kunnen geen foto\'s meer worden toegevoegd.' };
    const photoCount = Number(prepare('SELECT COUNT(*) AS n FROM service_request_photos WHERE tenant_id = ? AND request_id = ?').get(tenantId, requestRow.id).n);
    if (photoCount >= MAX_PHOTOS) return { error: 'too_many_photos', status: 409, message: `Maximaal ${MAX_PHOTOS} foto's per melding.` };
    const raw = fromBase64(input && input.image);
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
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    prepare(`INSERT INTO service_request_photos (id, tenant_id, request_id, mime, width, height, size, image, thumb, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, requestRow.id, image.mime, image.width, image.height, image.body.length,
        vault.sealBytes(image.body, aadOf(tenantId, id, 'beeld')), vault.sealBytes(thumb.body, aadOf(tenantId, id, 'mini')), timestamp);
    prepare('UPDATE service_requests SET updated_at = ? WHERE id = ?').run(timestamp, requestRow.id);
    return { photo: photoList(tenantId, requestRow.id, `api/portal/requests/${requestRow.id}/photos`).find((photo) => photo.id === id) };
  }

  /**
   * Verwijdert een foto van een lopende melding (klant).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} requestId Id van de melding.
   * @param {string} customerId Id van de klant.
   * @param {string} photoId Id van de foto.
   * @returns {{ ok: boolean }|{ error: string, status: number, message: string }} Gelukt, of een fout.
   */
  function removePhoto(tenantId, requestId, customerId, photoId) {
    const requestRow = find(tenantId, requestId, customerId);
    if (!requestRow) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(requestRow.status)) return { error: 'closed', status: 409, message: 'Deze melding is al in behandeling genomen.' };
    const removed = prepare('DELETE FROM service_request_photos WHERE tenant_id = ? AND request_id = ? AND id = ?').run(tenantId, requestRow.id, String(photoId)).changes;
    return removed ? { ok: true } : { error: 'not_found', status: 404, message: 'Foto niet gevonden.' };
  }

  /**
   * Afbeelding of miniatuur ontsleuteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} requestId Id van de melding.
   * @param {string} photoId Id van de foto.
   * @param {{ thumb?: boolean, customerId?: string }} [options] Miniatuur; alleen van een melding van die klant.
   * @returns {{ mime: string, body: Buffer }|null} Het bestand, of null.
   */
  function photoFile(tenantId, requestId, photoId, { thumb = false, customerId = null } = {}) {
    const photoRow = prepare(`SELECT p.id, p.mime, p.${thumb ? 'thumb' : 'image'} AS data FROM service_request_photos p
      JOIN service_requests sr ON sr.id = p.request_id AND sr.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.request_id = ? AND p.id = ?${customerId ? ' AND sr.customer_id = ?' : ''}`)
      .get(tenantId, String(requestId), String(photoId), ...(customerId ? [String(customerId)] : []));
    if (!photoRow) return null;
    const body = vault.openBytes(photoRow.data, aadOf(tenantId, photoRow.id, thumb ? 'mini' : 'beeld'));
    return { mime: inspectImage(body)?.mime || photoRow.mime, body };
  }

  /**
   * De klant trekt een lopende melding in.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {string} customerId Id van de klant.
   * @returns {{ item: object }|{ error: string, status: number, message: string }} De melding, of een fout.
   */
  function withdraw(tenantId, id, customerId) {
    const requestRow = find(tenantId, id, customerId);
    if (!requestRow) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    if (!OPEN.includes(requestRow.status)) return { error: 'closed', status: 409, message: 'Deze melding loopt niet meer.' };
    prepare("UPDATE service_requests SET status = 'ingetrokken', updated_at = ? WHERE id = ?").run(currentTimestamp(), requestRow.id);
    return { item: get(tenantId, requestRow.id, { customerId }) };
  }

  /**
   * Medewerker: status, antwoord aan de klant en interne notitie.
   * @param {object} user De medewerker.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {object} input status, reply en note.
   * @returns {{ item: object, changed: object }|{ error: string, status: number, message: string }} De melding en wat er veranderd is, of een fout.
   */
  function update(user, tenantId, id, input) {
    const requestRow = prepare('SELECT id, status, reply, note, work_order_id FROM service_requests WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!requestRow) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
    const fields = input && typeof input === 'object' ? input : {};
    let status = requestRow.status;
    if (fields.status !== undefined) {
      if (!STAFF_STATUSES.includes(fields.status)) return { error: 'invalid_status', status: 400, message: 'Ongeldige status.' };
      if (requestRow.work_order_id && OPEN.includes(fields.status)) return { error: 'has_workorder', status: 409, message: 'Er is al een werkorder van deze melding gemaakt.' };
      status = fields.status;
    }
    const reply = fields.reply === undefined ? requestRow.reply : cleanText(fields.reply, 4000);
    const note = fields.note === undefined ? requestRow.note : cleanText(fields.note, 4000);
    prepare('UPDATE service_requests SET status = ?, reply = ?, note = ?, handled_by = ?, handled_by_name = ?, updated_at = ? WHERE id = ?')
      .run(status, reply, note, user.kind === 'account' ? user.id : null, cleanText(user.display_name || '', 200), currentTimestamp(), requestRow.id);
    return { item: get(tenantId, requestRow.id), changed: { status: status !== requestRow.status, reply: reply !== requestRow.reply } };
  }

  /**
   * Maakt een werkorder van een melding. Klantgegevens, omschrijving en (als de
   * melding over een installatie gaat) ontwerp en zone-indeling van die
   * installatie gaan mee; de foto's van de klant worden foto's "voor".
   * @param {object} user De medewerker.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de melding.
   * @param {{ assigneeId?: string }} [options] De installateur.
   * @returns {{ item: object, workOrder: object, photosCopied: number }|{ error: string, status: number, message: string }} Melding, werkorder en aantal meegekopieerde foto's, of een fout.
   */
  function toWorkOrder(user, tenantId, id, { assigneeId = null } = {}) {
    return transaction(db, () => {
      const requestRow = prepare(`SELECT id, number, customer_name, kind, urgent, subject, description, address, phone, email, preferred, installation_id, status, work_order_id
        FROM service_requests WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
      if (!requestRow) return { error: 'not_found', status: 404, message: 'Melding niet gevonden.' };
      if (requestRow.work_order_id) return { error: 'has_workorder', status: 409, message: 'Van deze melding is al een werkorder gemaakt.' };
      if (requestRow.status === 'ingetrokken' || requestRow.status === 'afgewezen') return { error: 'closed', status: 409, message: 'Deze melding is ingetrokken of afgewezen.' };
      const installation = requestRow.installation_id ? workorders.get(tenantId, requestRow.installation_id) : null;
      const installationData = installation ? installation.data : {};
      const steps = requestRow.kind === 'onderhoud'
        ? [{ phase: 'uitvoering', title: 'Onderhoud uitvoeren (controle sproeiers, zones en besturing)', hours: 1.5 }]
        : [{ phase: 'uitvoering', title: 'Storing opsporen en verhelpen', details: requestRow.subject, hours: 1 }];
      steps.push({ phase: 'oplevering', title: 'Installatie testen en de klant informeren', hours: 0.5 });
      const lines = [`Melding ${requestRow.number} (${KINDS[requestRow.kind] || requestRow.kind}${requestRow.urgent ? ', spoed' : ''}): ${requestRow.subject}`, '', requestRow.description];
      if (requestRow.preferred) lines.push('', `Voorkeur van de klant: ${requestRow.preferred}`);
      if (installation) lines.push('', `Installatie: werkorder ${installation.number} (${installation.title}).`);
      const data = {
        title: `${KINDS[requestRow.kind] || 'Melding'}: ${requestRow.subject}`.slice(0, 200),
        customer: { name: requestRow.customer_name || (installationData.customer && installationData.customer.name) || '', address: requestRow.address || (installationData.customer && installationData.customer.address) || '', email: requestRow.email, phone: requestRow.phone },
        instructions: lines.join('\n'),
        design: installationData.design || null, zones: installationData.zones || [], heads: installationData.heads || [],
        steps, materials: [],
      };
      const workOrder = workorders.createReceived({ id: user.id, tenant_id: tenantId }, data, { assigneeId });
      prepare("UPDATE service_requests SET status = 'ingepland', work_order_id = ?, handled_by = ?, handled_by_name = ?, updated_at = ? WHERE id = ?")
        .run(workOrder.id, user.kind === 'account' ? user.id : null, cleanText(user.display_name || '', 200), currentTimestamp(), requestRow.id);
      // Foto's van de klant mee als foto's "voor" (zichtbaar voor de klant: ze zijn van hem).
      let copied = 0;
      if (photos) {
        for (const photo of prepare('SELECT id FROM service_request_photos WHERE tenant_id = ? AND request_id = ? ORDER BY created_at, id').all(tenantId, requestRow.id)) {
          const image = photoFile(tenantId, requestRow.id, photo.id);
          const thumbnail = photoFile(tenantId, requestRow.id, photo.id, { thumb: true });
          const copyInput = { image: image.body.toString('base64'), kind: 'voor', caption: `Foto van de klant (melding ${requestRow.number})` };
          // Een oudere melding kan de bronfoto als miniatuur hebben (groter dan
          // MAX_THUMB_SIDE); dan zonder miniatuur kopiëren, zodat de foto niet wegvalt.
          const thumbnailImage = thumbnail.body.length <= MAX_THUMB_BYTES ? inspectImage(thumbnail.body) : null;
          if (thumbnailImage && thumbnailImage.width <= MAX_THUMB_SIDE && thumbnailImage.height <= MAX_THUMB_SIDE) copyInput.thumb = thumbnail.body.toString('base64');
          const out = photos.add(user, tenantId, workOrder.id, copyInput);
          if (!out.error) copied++;
        }
      }
      return { item: get(tenantId, requestRow.id), workOrder: workorders.get(tenantId, workOrder.id), photosCopied: copied };
    });
  }

  return { list, get, countNew, create, addPhoto, removePhoto, photoFile, withdraw, update, toWorkOrder, nextNumber, sanitize };
}

/**
 * Wat de klant van zijn melding ziet: geen interne notitie.
 * @param {object} item De melding.
 * @returns {object} De melding zonder note.
 */
function forCustomer(item) {
  const { note, ...rest } = item;
  return rest;
}

/**
 * Registreert de routes voor meldingen. Klant (recht 'portaal'):
 * /api/portal/requests…; medewerkers (recht 'werkorders'): /api/service-requests…;
 * gegevens van de actieve omgeving.
 * @param {object} app De Express-app.
 * @param {object} ctx requests, portal, workorders, requireRight, requireJson, audit, remoteIp, createRateLimiter, mailerFor, settingsOf en staffTenantsOf.
 */
function registerServiceRequestRoutes(app, ctx) {
  const { requests, portal, workorders, requireRight, requireJson, audit } = ctx;
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const requirePortal = requireRight('portaal');
  const requireWo = requireRight('werkorders');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt een fout uit de opslag als antwoord.
   * @param {object} res Het Express-antwoord.
   * @param {{ status?: number, error: string, message: string }} out De fout.
   * @returns {object} Het antwoord.
   */
  const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, message: out.message });
  /**
   * Stuurt het antwoord 404 "melding niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Melding niet gevonden.' });
  /**
   * Middleware die niets doet (zonder rate limiter).
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {Function} next Volgende stap.
   * @returns {*} Wat next teruggeeft.
   */
  const passthrough = (req, res, next) => next();
  /**
   * Begrenst per klant (of bezoeker) het aantal verzoeken per uur.
   * @param {number} max Hooguit zoveel per uur.
   * @returns {Function} De middleware.
   */
  const limiter = (max) => (ctx.createRateLimiter
    ? ctx.createRateLimiter({ windowMs: 60 * 60 * 1000, max, keyFn: (req) => `${tenantOf(req)}|${req.user?.id || remoteIp(req)}` })
    : passthrough);
  const createLimiter = limiter(10);
  const photoLimiter = limiter(60);

  /**
   * Stuurt een afbeelding; alleen de eigen browser mag hem een dag bewaren.
   * @param {object} res Het Express-antwoord.
   * @param {{ mime: string, body: Buffer }} file Het bestand.
   */
  function send(res, file) {
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.body.length);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.end(file.body);
  }

  /**
   * Stuurt een e-mail als er een mailserver is; fouten alleen in het log.
   * @param {object} req Het Express-verzoek.
   * @param {string} to Het adres.
   * @param {string} subject Het onderwerp.
   * @param {string[]} lines De regels van het bericht.
   * @param {string} what Waarover (voor het log).
   */
  function mail(req, to, subject, lines, what) {
    if (!ctx.settingsOf) return;
    const settings = ctx.settingsOf(req);
    const mailer = mailerFor(settings);
    const profile = settings.get('quoteProfile') || {};
    if (!mailer.configured() || !validEmail(to)) return;
    mailer.send({ to, subject, ...mailBody(profile, lines, null) })
      .catch((error) => console.warn(`Bericht over ${what} niet verstuurd: ${error.message}`));
  }
  /**
   * Het bedrijfsprofiel van de omgeving.
   * @param {object} req Het Express-verzoek.
   * @returns {object} Het profiel (leeg zonder instellingen).
   */
  const profileOf = (req) => (ctx.settingsOf ? ctx.settingsOf(req).get('quoteProfile') || {} : {});

  /**
   * Bericht naar het bedrijf bij een nieuwe melding.
   * @param {object} req Het Express-verzoek.
   * @param {object} item De melding.
   */
  function notifyNew(req, item) {
    mail(req, profileOf(req).email, `${item.urgent ? 'SPOED: ' : ''}Melding ${item.number}: ${item.subject}`, [
      `Nieuwe melding ${item.number} van ${item.customer.name || 'een klant'}${item.urgent ? ' (spoed)' : ''}: ${item.kindLabel.toLowerCase()}.`,
      `Onderwerp: ${item.subject}`, item.description,
      [item.address ? `Adres: ${item.address}` : '', item.phone ? `Telefoon: ${item.phone}` : ''].filter(Boolean).join('\n'),
      'Bekijk en behandel de melding in de module Meldingen.',
    ], `melding ${item.number}`);
  }

  /**
   * Bericht naar de klant als hij een (nieuw) antwoord heeft gekregen.
   * @param {object} req Het Express-verzoek.
   * @param {object} item De melding.
   */
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
    res.json({ items: requests.list(tenantOf(req), { customerId: req.user.id }).map(forCustomer) });
  });

  app.get('/api/portal/requests/:id', requirePortal, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const item = requests.get(tenantOf(req), req.params.id, { customerId: req.user.id });
    if (!item) return notFound(res);
    res.json(item);
  });

  app.post('/api/portal/requests', requireJson, requirePortal, createLimiter, (req, res) => {
    const tenantId = tenantOf(req);
    const out = requests.create(req.user, tenantId, req.body, { installationOk: (id) => Boolean(portal.ownRow(tenantId, req.user.id, id)) });
    if (out.error) return fail(res, out);
    audit(req, 'melding_aangemaakt', { requestId: out.item.id, number: out.item.number, kind: out.item.kind });
    notifyNew(req, out.item);
    res.status(201).json(forCustomer(out.item));
  });

  app.post('/api/portal/requests/:id/photos', requireJson, requirePortal, photoLimiter, (req, res) => {
    const out = requests.addPhoto(tenantOf(req), req.params.id, req.user.id, req.body || {});
    if (out.error) return fail(res, out);
    audit(req, 'melding_foto_toegevoegd', { requestId: req.params.id, photoId: out.photo.id });
    res.status(201).json(out.photo);
  });

  app.delete('/api/portal/requests/:id/photos/:pid', requirePortal, (req, res) => {
    const out = requests.removePhoto(tenantOf(req), req.params.id, req.user.id, req.params.pid);
    if (out.error) return fail(res, out);
    res.json({ ok: true });
  });

  app.get('/api/portal/requests/:id/photos/:pid', requirePortal, (req, res) => {
    const file = requests.photoFile(tenantOf(req), req.params.id, req.params.pid, { thumb: req.query.thumb === '1', customerId: req.user.id });
    if (!file) return notFound(res);
    send(res, file);
  });

  app.post('/api/portal/requests/:id/withdraw', requireJson, requirePortal, (req, res) => {
    const out = requests.withdraw(tenantOf(req), req.params.id, req.user.id);
    if (out.error) return fail(res, out);
    audit(req, 'melding_ingetrokken', { requestId: req.params.id });
    res.json(out.item);
  });

  // ---------- Medewerkers ----------
  app.get('/api/service-requests', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: requests.list(tenantOf(req), { open: req.query.open === '1' }), kinds: KINDS, statuses: STATUSES });
  });

  app.get('/api/service-requests/:id', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const item = requests.get(tenantOf(req), req.params.id);
    if (!item) return notFound(res);
    res.json(item);
  });

  app.put('/api/service-requests/:id', requireJson, requireWo, (req, res) => {
    const out = requests.update(req.user, tenantOf(req), req.params.id, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'melding_bijgewerkt', { requestId: out.item.id, number: out.item.number, status: out.item.status });
    if (out.changed.reply) notifyReply(req, out.item);
    res.json(out.item);
  });

  app.post('/api/service-requests/:id/workorder', requireJson, requireWo, (req, res) => {
    let assigneeId = null;
    const raw = req.body && req.body.assigneeId;
    if (raw) {
      if (!workorders.staff(ctx.staffTenantsOf(req)).some((member) => member.id === String(raw))) return res.status(400).json({ error: 'invalid_assignee', message: 'Onbekende medewerker.' });
      assigneeId = String(raw);
    }
    const out = requests.toWorkOrder(req.user, tenantOf(req), req.params.id, { assigneeId });
    if (out.error) return fail(res, out);
    audit(req, 'melding_werkorder', { requestId: out.item.id, number: out.item.number, workOrderId: out.workOrder.id });
    res.status(201).json(out);
  });

  app.get('/api/service-requests/:id/photos/:pid', requireWo, (req, res) => {
    const file = requests.photoFile(tenantOf(req), req.params.id, req.params.pid, { thumb: req.query.thumb === '1' });
    if (!file) return notFound(res);
    send(res, file);
  });
}

module.exports = { createServiceRequestStore, registerServiceRequestRoutes, forCustomer, KINDS, STATUSES, MAX_PHOTOS };
