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
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { createMailer, validEmail } = require('../platform/mailer');
const { mailBody } = require('../verkoop/quotes');

const Core = require(path.join(FRONTEND_DIR, 'werkorders', 'workorder-core.js'));

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt van een waarde getrimde, ingekorte tekst.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);
/**
 * Leest JSON zonder te falen.
 * @param {string|null} text De JSON-tekst.
 * @param {*} fallback Waarde bij lege of ongeldige JSON.
 * @returns {*} De waarde.
 */
const parseJson = (text, fallback) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
// Alleen een werkorder die nog niet in uitvoering is, kan worden uitbesteed.
const OFFERABLE = ['open', 'gepland'];
const MAX_FEE = 1e7;

/**
 * Schoont de instelling outsourcing per omgeving op.
 * @param {object} raw De invoer.
 * @returns {{ send: boolean, receive: boolean, region: string }} Versturen, ontvangen en werkgebied.
 */
function sanitizeOutsourcing(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { send: input.send === true, receive: input.receive === true, region: cleanText(input.region, 200) };
}

/**
 * Plaats uit een adres zonder straat en huisnummer: "8071 Nunspeet" uit
 * "Dorpsstraat 1, 8071 AB Nunspeet". Zonder postcode de laatste regel, maar
 * alleen als daar geen cijfers in staan (anders is het een straat).
 * @param {string} address Het adres.
 * @returns {string} Postcodecijfers en woonplaats, of leeg.
 */
function placeOf(address) {
  const lines = String(address || '').split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /\b(\d{4})\s?[A-Za-z]{2}\b\s*(.*)$/.exec(line);
    if (match) return `${match[1]}${match[2] ? ` ${match[2].trim()}` : ''}`.slice(0, 120);
  }
  const last = lines.length > 1 ? lines[lines.length - 1] : '';
  return last && !/\d/.test(last) ? last.slice(0, 120) : '';
}

/**
 * Wat een andere organisatie vóór acceptatie ziet: geen klantnaam, contactgegevens, instructies of prijzen.
 * @param {object} raw De inhoud van de werkorder.
 * @returns {object} title, place, planning, summary, hours, design, zones, steps en materials.
 */
function previewOf(raw) {
  const details = Core.sanitize(raw);
  return {
    title: details.title || 'Werkorder',
    place: placeOf(details.customer.address),
    plannedDate: details.plannedDate, startTime: details.startTime, endTime: details.endTime, days: details.days,
    // Zonder instructies: daar kan van alles over de klant in staan.
    summary: Core.summary({ ...details, instructions: '' }),
    hours: Core.progress(details).hours,
    design: details.design,
    zones: details.zones.length,
    steps: details.steps.map((step) => ({ phase: step.phase, title: step.title, hours: step.hours })),
    materials: details.materials.map((material) => ({ code: material.code, description: material.description, qty: material.qty, unit: material.unit })),
  };
}

/**
 * De werkorder voor de ontvanger na acceptatie: alles om het werk te doen, niets van de uitvoering bij de uitbesteder.
 * @param {object} raw De inhoud van de werkorder.
 * @returns {object} De opgeschoonde inhoud voor de nieuwe werkorder.
 */
function handoverOf(raw) {
  const details = Core.sanitize(raw);
  return Core.sanitize({
    title: details.title, customer: details.customer,
    plannedDate: details.plannedDate, startTime: details.startTime, endTime: details.endTime, days: details.days,
    instructions: details.instructions, siteNotes: details.siteNotes,
    design: details.design, zones: details.zones,
    steps: details.steps.map((step) => ({ phase: step.phase, title: step.title, details: step.details, hours: step.hours })),
    materials: details.materials.map((material) => ({ code: material.code, description: material.description, qty: material.qty, unit: material.unit })),
  });
}

// Kolommen van een aanbod die de weergaven gebruiken (elke query noemt zijn kolommen).
const COLS = 'id, tenant_id, work_order_id, to_tenant_id, status, message, fee, preview, from_name, created_by_name, declined, receiver_tenant_id, receiver_name, received_work_order_id, responded_by_name, responded_at, reason, created_at';
const F_COLS = COLS.split(', ').map((column) => `f.${column}`).join(', ');

/**
 * Maakt de opslag voor uitbestede opdrachten.
 * @param {object} db De database.
 * @param {{ workorders: object }} stores De werkorderopslag (createReceived).
 * @returns {object} offer, outgoing, incoming, marks, withdraw, decline, accept, find, outgoingView en incomingView.
 */
function createOutsourcingStore(db, { workorders }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Een aanbod op id (over alle organisaties; de aanroeper controleert wie het mag zien).
   * @param {string} id Id van het aanbod.
   * @returns {object|null} De rij, of null.
   */
  const find = (id) => prepare(`SELECT ${COLS} FROM work_order_offers WHERE id = ?`).get(String(id)) || null;
  /**
   * De organisaties die een open aanbod hebben afgewezen.
   * @param {object} offerRow De rij van het aanbod.
   * @returns {string[]} Hun tenant-id's.
   */
  const declinedOf = (offerRow) => parseJson(offerRow.declined, []);

  /**
   * Stand van het werk bij de ontvanger (voor de uitbesteder).
   * @param {object} offerRow De rij van het aanbod.
   * @returns {object|null} number, status, planning, progress en completedOn; { removed: true } als de werkorder weg is; null zonder ontvanger.
   */
  function execution(offerRow) {
    if (!offerRow.received_work_order_id) return null;
    const received = prepare('SELECT number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND id = ?').get(offerRow.receiver_tenant_id, offerRow.received_work_order_id);
    if (!received || received.deleted_at) return { removed: true };
    const details = Core.sanitize(parseJson(received.data, {}));
    const progress = Core.progress(details);
    return {
      number: received.number, status: received.status, plannedDate: details.plannedDate, startTime: details.startTime, endTime: details.endTime, days: details.days,
      progress: { steps: progress.steps, done: progress.done, pct: progress.pct }, completedOn: details.report.completedOn,
    };
  }

  /**
   * Een aanbod zoals de uitbesteder het ziet.
   * @param {object} offerRow De rij van het aanbod.
   * @returns {object} Het aanbod met ontvanger en uitvoering.
   */
  function outgoingView(offerRow) {
    return {
      id: offerRow.id, workOrderId: offerRow.work_order_id, status: offerRow.status, direct: Boolean(offerRow.to_tenant_id), toTenantId: offerRow.to_tenant_id || null,
      receiverName: offerRow.receiver_name, message: offerRow.message, fee: offerRow.fee, preview: parseJson(offerRow.preview, {}),
      createdAt: offerRow.created_at, createdBy: offerRow.created_by_name, respondedAt: offerRow.responded_at, respondedBy: offerRow.responded_by_name,
      reason: offerRow.reason, declinedCount: declinedOf(offerRow).length, execution: execution(offerRow),
    };
  }

  /**
   * Een aanbod zoals een ontvangende organisatie het ziet; myStatus zegt hoe het er voor haar voor staat.
   * @param {object} offerRow De rij van het aanbod.
   * @param {string} tenantId Id van de ontvangende omgeving.
   * @returns {object} Het aanbod.
   */
  function incomingView(offerRow, tenantId) {
    let myStatus = offerRow.status;
    if (offerRow.receiver_tenant_id === tenantId) myStatus = 'geaccepteerd';
    else if (offerRow.status === 'aangeboden' && declinedOf(offerRow).includes(tenantId)) myStatus = 'afgewezen';
    const mine = offerRow.receiver_tenant_id === tenantId;
    return {
      id: offerRow.id, myStatus, direct: Boolean(offerRow.to_tenant_id), fromTenantId: offerRow.tenant_id, fromName: offerRow.from_name, createdBy: offerRow.created_by_name,
      message: offerRow.message, fee: offerRow.fee, preview: parseJson(offerRow.preview, {}), createdAt: offerRow.created_at,
      receivedWorkOrderId: mine ? offerRow.received_work_order_id : null, respondedAt: mine || offerRow.to_tenant_id === tenantId ? offerRow.responded_at : null,
    };
  }

  /**
   * Een werkorder van de uitbesteder die nog bestaat.
   * @param {string} tenantId Id van de uitbesteder.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {object|null} id, status en data, of null.
   */
  const offerable = (tenantId, workOrderId) => prepare('SELECT id, status, data FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(workOrderId)) || null;
  /**
   * Het lopende aanbod (aangeboden of aangenomen) voor een werkorder.
   * @param {string} tenantId Id van de uitbesteder.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {{ id: string }|null} Het aanbod, of null.
   */
  const activeFor = (tenantId, workOrderId) => prepare(`SELECT id FROM work_order_offers WHERE tenant_id = ? AND work_order_id = ?
    AND status IN ('aangeboden', 'geaccepteerd') ORDER BY created_at DESC LIMIT 1`).get(tenantId, String(workOrderId)) || null;

  /**
   * Biedt een werkorder aan, aan één organisatie of aan iedereen.
   * @param {object} user Wie het aanbiedt.
   * @param {string} tenantId Id van de uitbesteder.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} input toTenantId (null = iedereen), toName, message, fee en fromName.
   * @returns {{ offer: object }|{ error: string, status?: string }} Het aanbod, of de fout not_found, status of active.
   */
  function offer(user, tenantId, workOrderId, input) {
    return transaction(db, () => {
      const workOrder = offerable(tenantId, workOrderId);
      if (!workOrder) return { error: 'not_found' };
      if (!OFFERABLE.includes(workOrder.status)) return { error: 'status', status: workOrder.status };
      if (activeFor(tenantId, workOrder.id)) return { error: 'active' };
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      prepare(`INSERT INTO work_order_offers (id, tenant_id, work_order_id, to_tenant_id, status, message, fee, preview, from_name, created_by, created_by_name,
          receiver_name, created_at, updated_at) VALUES (?, ?, ?, ?, 'aangeboden', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, workOrder.id, input.toTenantId || null, cleanText(input.message, 2000), input.fee ?? null, JSON.stringify(previewOf(parseJson(workOrder.data, {}))),
          cleanText(input.fromName, 200), user.id, cleanText(user.display_name, 120), input.toTenantId ? cleanText(input.toName, 200) : '', timestamp, timestamp);
      return { offer: outgoingView(find(id)) };
    });
  }

  /**
   * De aanbiedingen van een uitbesteder, nieuwste eerst (hooguit 200).
   * @param {string} tenantId Id van de uitbesteder.
   * @returns {object[]} De aanbiedingen.
   */
  function outgoing(tenantId) {
    return prepare(`SELECT ${COLS} FROM work_order_offers WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`).all(tenantId).map(outgoingView);
  }

  /**
   * Aanbiedingen voor deze omgeving: open (aan haar of aan iedereen, uit een
   * omgeving van hetzelfde soort), plus wat ze heeft aangenomen of afgewezen.
   * @param {string} tenantId Id van de ontvangende omgeving.
   * @param {string} environment 'live' of 'test'.
   * @param {{ active?: Function }} [options] active(tenantId) filtert uitgeschakelde organisaties weg.
   * @returns {object[]} De aanbiedingen.
   */
  function incoming(tenantId, environment, { active = () => true } = {}) {
    const rows = prepare(`SELECT ${F_COLS} FROM work_order_offers f JOIN tenants s ON s.id = f.tenant_id
      WHERE f.tenant_id <> ? AND s.environment = ?
        AND ((f.status = 'aangeboden' AND (f.to_tenant_id = ? OR f.to_tenant_id IS NULL))
          OR f.receiver_tenant_id = ? OR (f.status = 'afgewezen' AND f.to_tenant_id = ?))
      ORDER BY f.created_at DESC LIMIT 200`).all(tenantId, environment, tenantId, tenantId, tenantId);
    return rows.filter((offerRow) => offerRow.receiver_tenant_id === tenantId || active(offerRow.tenant_id)).map((offerRow) => incomingView(offerRow, tenantId));
  }

  /**
   * Per werkorder-id: uitbesteed (bij de uitbesteder) of aangenomen (bij de ontvanger).
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} Werkorder-id → rol, aanbod, status en partner.
   */
  function marks(tenantId) {
    const out = {};
    for (const offerRow of prepare(`SELECT ${COLS} FROM work_order_offers WHERE tenant_id = ? AND status IN ('aangeboden', 'geaccepteerd')`).all(tenantId)) {
      out[offerRow.work_order_id] = { role: 'uitbesteed', offerId: offerRow.id, status: offerRow.status, partner: offerRow.receiver_name || '', direct: Boolean(offerRow.to_tenant_id), execution: execution(offerRow) };
    }
    for (const offerRow of prepare(`SELECT ${COLS} FROM work_order_offers WHERE receiver_tenant_id = ? AND received_work_order_id IS NOT NULL`).all(tenantId)) {
      out[offerRow.received_work_order_id] = { role: 'aangenomen', offerId: offerRow.id, status: offerRow.status, partner: offerRow.from_name, fee: offerRow.fee, message: offerRow.message };
    }
    return out;
  }

  /**
   * Trekt een open aanbod in.
   * @param {string} tenantId Id van de uitbesteder.
   * @param {string} id Id van het aanbod.
   * @returns {{ offer: object }|{ error: string, status?: string }} Het aanbod, of een fout.
   */
  function withdraw(tenantId, id) {
    return transaction(db, () => {
      const offerRow = find(id);
      if (!offerRow || offerRow.tenant_id !== tenantId) return { error: 'not_found' };
      if (offerRow.status !== 'aangeboden') return { error: 'status', status: offerRow.status };
      prepare("UPDATE work_order_offers SET status = 'ingetrokken', updated_at = ? WHERE id = ?").run(currentTimestamp(), offerRow.id);
      return { offer: outgoingView(find(offerRow.id)) };
    });
  }

  /**
   * Mag deze omgeving op het aanbod reageren? (de routes controleren de
   * instelling en het soort omgeving). Een aanbod voor een ander bestaat voor
   * haar niet; een aanbod dat al weg is, is closed.
   * @param {object|null} offerRow De rij van het aanbod.
   * @param {string} tenantId Id van de ontvangende omgeving.
   * @returns {string|null} 'not_found', 'closed' of null als reageren mag.
   */
  function problemFor(offerRow, tenantId) {
    if (!offerRow || offerRow.tenant_id === tenantId || (offerRow.to_tenant_id && offerRow.to_tenant_id !== tenantId) || declinedOf(offerRow).includes(tenantId)) return 'not_found';
    return offerRow.status === 'aangeboden' ? null : 'closed';
  }

  /**
   * Wijst een aanbod af: een gericht aanbod is dan afgewezen; een open aanbod blijft voor de anderen staan.
   * @param {object} user Wie het doet.
   * @param {string} tenantId Id van de ontvangende omgeving.
   * @param {string} id Id van het aanbod.
   * @param {string} reason Toelichting.
   * @returns {{ row: object }|{ error: string }} De bijgewerkte rij, of een fout.
   */
  function decline(user, tenantId, id, reason) {
    return transaction(db, () => {
      const offerRow = find(id);
      const problem = problemFor(offerRow, tenantId);
      if (problem) return { error: problem };
      const timestamp = currentTimestamp();
      if (offerRow.to_tenant_id) {
        prepare(`UPDATE work_order_offers SET status = 'afgewezen', responded_by_name = ?, responded_at = ?, reason = ?, updated_at = ? WHERE id = ?`)
          .run(cleanText(user.display_name, 120), timestamp, cleanText(reason, 1000), timestamp, offerRow.id);
      } else {
        prepare('UPDATE work_order_offers SET declined = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...declinedOf(offerRow), tenantId].slice(-500)), timestamp, offerRow.id);
      }
      return { row: find(offerRow.id) };
    });
  }

  /**
   * Neemt een aanbod aan: de ontvanger krijgt een eigen werkorder met de gegevens van dat moment.
   * @param {object} user Wie het doet.
   * @param {string} tenantId Id van de ontvangende omgeving.
   * @param {string} id Id van het aanbod.
   * @param {{ receiverName: string }} receiver Naam van de ontvangende organisatie.
   * @returns {{ row: object, workOrder: object }|{ error: string }} De rij en de nieuwe werkorder, of de fout not_found, closed of gone.
   */
  function accept(user, tenantId, id, { receiverName }) {
    return transaction(db, () => {
      const offerRow = find(id);
      const problem = problemFor(offerRow, tenantId);
      if (problem) return { error: problem };
      const source = offerable(offerRow.tenant_id, offerRow.work_order_id);
      if (!source || !OFFERABLE.includes(source.status)) return { error: 'gone' };
      const workOrder = workorders.createReceived({ ...user, tenant_id: tenantId }, handoverOf(parseJson(source.data, {})));
      const timestamp = currentTimestamp();
      prepare(`UPDATE work_order_offers SET status = 'geaccepteerd', receiver_tenant_id = ?, receiver_name = ?, received_work_order_id = ?,
          responded_by_name = ?, responded_at = ?, updated_at = ? WHERE id = ?`)
        .run(tenantId, cleanText(receiverName, 200), workOrder.id, cleanText(user.display_name, 120), timestamp, timestamp, offerRow.id);
      return { row: find(offerRow.id), workOrder: workOrder };
    });
  }

  return { offer, outgoing, incoming, marks, withdraw, decline, accept, find, outgoingView, incomingView };
}

/**
 * Registreert de API-routes voor uitbesteden (recht 'uitbesteden'); de
 * instelling van de actieve omgeving bepaalt of versturen en ontvangen aan staan.
 * @param {object} app De Express-app.
 * @param {object} ctx outsourcing, store, requireRight, requireJson, audit, settingsForTenant(id), tenantActive(id) en mailerFor(settings).
 */
function registerOutsourcingRoutes(app, ctx) {
  const { outsourcing, store, requireRight, requireJson, audit, settingsForTenant } = ctx;
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const requireOut = requireRight('uitbesteden');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * De instelling outsourcing van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} send, receive en region.
   */
  const settingsOf = (tenantId) => settingsForTenant(tenantId).get('outsourcing');
  /**
   * Het soort omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {string} 'live' of 'test'.
   */
  const envOf = (tenantId) => store.getTenant(tenantId)?.environment || 'live';
  /**
   * Bedrijfsnaam uit de eigen bedrijfsgegevens (Offertes), anders de naam van de tenant.
   * @param {string} tenantId Id van de omgeving.
   * @returns {string} De naam.
   */
  const nameOf = (tenantId) => {
    const settings = settingsForTenant(tenantId);
    const own = settings.view().quoteProfile.source === 'instellingen' ? cleanText(settings.get('quoteProfile').companyName, 200) : '';
    return own || store.getTenant(tenantId)?.name || 'Onbekende organisatie';
  };
  /**
   * Stuurt het antwoord 404 "aanbod niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Aanbod niet gevonden.' });
  /**
   * Stuurt het antwoord 409: uitbesteden staat uit.
   * @param {object} res Het Express-antwoord.
   * @param {string} what Wat er uit staat (voor de melding).
   * @returns {object} Het antwoord.
   */
  const off = (res, what) => res.status(409).json({ error: 'outsourcing_off', message: `${what} staat uit voor je organisatie. Een beheerder zet het aan in Beheer → Instellingen → Uitbesteden.` });

  /**
   * Organisaties die opdrachten ontvangen (zelfde soort omgeving, actief, niet zichzelf).
   * @param {string} tenantId Id van de eigen omgeving.
   * @returns {{ id: string, name: string, region: string }[]} De partners op naam.
   */
  function partners(tenantId) {
    const env = envOf(tenantId);
    const all = [];
    for (const live of store.listTenants()) all.push(live, ...(live.environments || []));
    return all
      .filter((tenant) => tenant.id !== tenantId && (tenant.environment || 'live') === env && tenantActive(tenant.id) && settingsOf(tenant.id).receive)
      .map((tenant) => ({ id: tenant.id, name: nameOf(tenant.id), region: settingsOf(tenant.id).region }))
      .sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  }

  /**
   * Stuurt een bericht per e-mail aan elke organisatie apart, als de verzendende omgeving een mailserver heeft en de ontvanger een adres.
   * @param {string} viaTenantId De omgeving waarvan de mailserver wordt gebruikt.
   * @param {string[]} toTenantIds De ontvangende omgevingen.
   * @param {string} subject Het onderwerp.
   * @param {string[]} lines De regels van het bericht.
   */
  function mail(viaTenantId, toTenantIds, subject, lines) {
    const settings = settingsForTenant(viaTenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return;
    const profile = settings.get('quoteProfile');
    const to = [...new Set(toTenantIds.map((id) => settingsForTenant(id).get('quoteProfile').email).filter(validEmail))];
    if (!to.length) return;
    // Elke organisatie een eigen bericht (geen adressen van anderen zichtbaar).
    for (const address of to) {
      mailer.send({ to: address, replyTo: profile.email, subject, ...mailBody(profile, lines, null) })
        .catch((error) => console.warn(`Bericht over uitbesteden niet verstuurd: ${error.message}`));
    }
  }

  app.get('/api/outsourcing', requireOut, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    const options = settingsOf(tenantId);
    res.json({
      settings: options,
      environment: envOf(tenantId),
      partners: options.send ? partners(tenantId) : [],
      incoming: options.receive ? outsourcing.incoming(tenantId, envOf(tenantId), { active: tenantActive }) : [],
      outgoing: outsourcing.outgoing(tenantId),
    });
  });

  app.post('/api/outsourcing/offers', requireJson, requireOut, (req, res) => {
    const tenantId = tenantOf(req);
    if (!settingsOf(tenantId).send) return off(res, 'Uitbesteden');
    const body = req.body || {};
    const fee = body.fee === undefined || body.fee === null || body.fee === '' ? null : Number(body.fee);
    if (fee !== null && !(Number.isFinite(fee) && fee >= 0 && fee <= MAX_FEE)) return res.status(400).json({ error: 'invalid_fee', message: 'Ongeldige vergoeding.' });
    const toTenantId = body.toTenantId ? String(body.toTenantId) : null;
    const list = partners(tenantId);
    if (!list.length) return res.status(409).json({ error: 'no_partners', message: 'Er zijn nog geen organisaties die opdrachten ontvangen.' });
    const target = toTenantId ? list.find((partner) => partner.id === toTenantId) : null;
    if (toTenantId && !target) return res.status(400).json({ error: 'invalid_partner', message: 'Deze organisatie ontvangt geen opdrachten.' });
    const out = outsourcing.offer(req.user, tenantId, body.workOrderId, {
      toTenantId, toName: target?.name, message: body.message, fee: fee === null ? null : Math.round(fee * 100) / 100, fromName: nameOf(tenantId),
    });
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
    if (out.error === 'status') return res.status(409).json({ error: 'status', message: 'Alleen een werkorder met status Nieuw of Gepland kan worden uitbesteed.' });
    if (out.error === 'active') return res.status(409).json({ error: 'active', message: 'Deze werkorder is al uitbesteed of aangeboden.' });
    audit(req, 'opdracht_aangeboden', { offerId: out.offer.id, workOrderId: out.offer.workOrderId, aan: target ? target.name : 'iedereen' });
    const preview = out.offer.preview;
    mail(tenantId, target ? [target.id] : list.map((partner) => partner.id), `Opdracht aangeboden door ${nameOf(tenantId)}`, [
      `${nameOf(tenantId)} biedt een opdracht aan${target ? ' aan uw organisatie' : ' aan organisaties die opdrachten ontvangen'}: ${preview.title}${preview.place ? ` in ${preview.place}` : ''}.`,
      out.offer.message,
      'Bekijk het aanbod en neem het aan in de module Uitbesteden.',
    ]);
    res.status(201).json(out.offer);
  });

  app.delete('/api/outsourcing/offers/:id', requireOut, (req, res) => {
    const out = outsourcing.withdraw(tenantOf(req), req.params.id);
    if (out.error === 'not_found') return notFound(res);
    if (out.error) return res.status(409).json({ error: 'closed', message: 'Dit aanbod is al aangenomen of afgewezen en kan niet meer worden ingetrokken.' });
    audit(req, 'opdracht_ingetrokken', { offerId: out.offer.id, workOrderId: out.offer.workOrderId });
    res.json(out.offer);
  });

  /**
   * Of de omgeving op het aanbod mag reageren (ontvangen aan, zelfde soort omgeving); stuurt anders zelf het antwoord.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @returns {{ tenantId: string, offerRow: object }|null} De omgeving en het aanbod, of null.
   */
  function respondable(req, res) {
    const tenantId = tenantOf(req);
    if (!settingsOf(tenantId).receive) { off(res, 'Opdrachten ontvangen'); return null; }
    const offerRow = outsourcing.find(req.params.id);
    if (!offerRow || envOf(offerRow.tenant_id) !== envOf(tenantId) || !tenantActive(offerRow.tenant_id)) { notFound(res); return null; }
    return { tenantId, offerRow };
  }
  /**
   * Stuurt het antwoord 409: het aanbod is niet meer beschikbaar.
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const closed = (res) => res.status(409).json({ error: 'closed', message: 'Dit aanbod is niet meer beschikbaar: al aangenomen of ingetrokken.' });

  app.post('/api/outsourcing/offers/:id/accept', requireJson, requireOut, (req, res) => {
    const access = respondable(req, res);
    if (!access) return;
    const out = outsourcing.accept(req.user, access.tenantId, access.offerRow.id, { receiverName: nameOf(access.tenantId) });
    if (out.error === 'not_found') return notFound(res);
    if (out.error === 'closed') return closed(res);
    if (out.error === 'gone') return res.status(409).json({ error: 'gone', message: 'De werkorder is bij de uitbesteder niet meer beschikbaar.' });
    audit(req, 'opdracht_aangenomen', { offerId: access.offerRow.id, workOrderId: out.workOrder.id, number: out.workOrder.number, van: access.offerRow.from_name });
    audit(req, 'opdracht_aangenomen', { offerId: access.offerRow.id, workOrderId: access.offerRow.work_order_id, door: nameOf(access.tenantId) }, null, access.offerRow.tenant_id);
    mail(access.tenantId, [access.offerRow.tenant_id], `Opdracht aangenomen door ${nameOf(access.tenantId)}`, [
      `${nameOf(access.tenantId)} heeft uw opdracht "${outsourcing.outgoingView(out.row).preview.title}" aangenomen (hun werkorder ${out.workOrder.number}).`,
      'De voortgang ziet u in de module Uitbesteden en bij de werkorder.',
    ]);
    res.json({ offer: outsourcing.incomingView(out.row, access.tenantId), workOrder: out.workOrder });
  });

  app.post('/api/outsourcing/offers/:id/decline', requireJson, requireOut, (req, res) => {
    const access = respondable(req, res);
    if (!access) return;
    const reason = cleanText(req.body?.reason, 1000);
    const out = outsourcing.decline(req.user, access.tenantId, access.offerRow.id, reason);
    if (out.error === 'not_found') return notFound(res);
    if (out.error) return closed(res);
    audit(req, 'opdracht_afgewezen', { offerId: access.offerRow.id, van: access.offerRow.from_name });
    if (access.offerRow.to_tenant_id) {
      audit(req, 'opdracht_afgewezen', { offerId: access.offerRow.id, workOrderId: access.offerRow.work_order_id, door: nameOf(access.tenantId) }, null, access.offerRow.tenant_id);
      mail(access.tenantId, [access.offerRow.tenant_id], `Opdracht afgewezen door ${nameOf(access.tenantId)}`, [
        `${nameOf(access.tenantId)} neemt uw opdracht "${outsourcing.outgoingView(out.row).preview.title}" niet aan.`,
        reason ? `Toelichting: ${reason}` : '',
      ]);
    }
    res.json({ offer: outsourcing.incomingView(out.row, access.tenantId) });
  });
}

module.exports = { createOutsourcingStore, registerOutsourcingRoutes, sanitizeOutsourcing, placeOf, previewOf, handoverOf };
