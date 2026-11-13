// Bewaking (Beheer > Systeem > Bewaking): voert controles uit (platform: server, database, schijf, back-ups, update;
// per omgeving: koppelingen als Drive, mail, Mollie, Visma, webshop), houdt per controle hoogstens één open incident bij
// (tabel monitor_incidents, migratie 72) en meldt een nieuw incident, een herinnering, een zwaardere ernst en het herstel
// per mail en webhook (monitoring-notify.js). Na elke volledige ronde gaat er een heartbeat naar een externe dienst, die
// alarm slaat als de app zelf onbereikbaar is.
//
// - Platformincidenten staan onder de hoofdtenant met scope 'platform' en volgen de instelling `monitoring` van de
//   hoofdtenant; incidenten van een omgeving volgen de instelling van die omgeving.
// - Een controle die gooit of langer duurt dan 20 s wordt een waarschuwing "Controle zelf mislukt: ...".
// - Een meldingsfout komt in notify_error en het log, nooit als nieuw incident, en gooit nooit.
// - Meldingen en berichten gaan door redact (error-report.js): geen geheimen.
// - Alles werkt op SQLite en PostgreSQL (db.prepare met ?-parameters). De ronde over alle omgevingen loopt bewust
//   over organisaties heen (asSystem); elke query filtert zelf op tenant_id.
const crypto = require('crypto');
const { redact } = require('./error-report');
const { asSystem } = require('../database/tenant-scope');
const { sanitizeMonitoring, composeNotice, createNotifier, MONITORING_DEFAULTS, cleanHttpsUrl } = require('./monitoring-notify');

/** Kolommen van een incident die de bewaking zelf leest. */
const INCIDENT_COLUMNS = 'id, tenant_id, scope, check_key, severity, state, title, message, first_at, last_at, resolved_at, occurrences, notified_at, reminded_at, resolved_notified_at, notify_error';
/** Maximale lengte van het bericht van een incident. */
const MAX_MESSAGE = 500;
/** Een controle mag hoogstens zo lang duren. */
const CHECK_TIMEOUT_MS = 20000;
/** Zoveel controles lopen tegelijk. */
const PARALLEL_CHECKS = 4;
/** Speling bij "aan de beurt": een ronde die iets te vroeg komt, telt toch mee. */
const INTERVAL_SLACK_MS = 30000;
/** Hoogstens zoveel incidenten per lijst. */
const MAX_LIST = 500;

/**
 * Of een ernst geldig is; anders 'waarschuwing'.
 * @param {*} severity De opgegeven ernst.
 * @returns {'fout'|'waarschuwing'} De ernst.
 */
const cleanSeverity = (severity) => (severity === 'fout' ? 'fout' : 'waarschuwing');

/**
 * Zet een incident uit de database om naar het formaat voor de app (zonder tenant_id).
 * @param {object} row De rij uit monitor_incidents.
 * @returns {object} { id, scope, key, severity, state, title, message, firstAt, lastAt, resolvedAt, occurrences, notifiedAt, remindedAt, resolvedNotifiedAt, notifyError }.
 */
function publicIncident(row) {
  return {
    id: row.id, scope: row.scope, key: row.check_key, severity: row.severity, state: row.state, title: row.title,
    message: row.message, firstAt: row.first_at, lastAt: row.last_at, resolvedAt: row.resolved_at || '',
    occurrences: Number(row.occurrences) || 0, notifiedAt: row.notified_at || '', remindedAt: row.reminded_at || '',
    resolvedNotifiedAt: row.resolved_notified_at || '', notifyError: row.notify_error || '',
  };
}

/**
 * De opslag van incidenten (tabel monitor_incidents). Elke query filtert op tenant_id.
 * @param {{ db: object }} options De database.
 * @returns {{ findOpen: Function, insert: Function, update: Function, resolve: Function, list: Function, counts: Function, openOf: Function, prune: Function }} De opslagfuncties.
 */
function createIncidentStore({ db }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Het open incident van een controle in een omgeving.
   * @param {string} tenantId De omgeving.
   * @param {string} checkKey De controle.
   * @returns {object|null} De rij, of null.
   */
  const findOpen = (tenantId, checkKey) => prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incidents WHERE tenant_id = ? AND check_key = ? AND state = 'open'`)
    .get(tenantId, checkKey) || null;

  /**
   * Maakt een nieuw (open of al opgelost) incident.
   * @param {{ tenantId: string, scope: string, checkKey: string, severity: string, title: string, message: string, at: string, state?: string, resolvedAt?: string, occurrences?: number, notifiedAt?: string }} incident De gegevens.
   * @returns {object} De nieuwe rij.
   */
  function insert({ tenantId, scope, checkKey, severity, title, message, at, state = 'open', resolvedAt = '', occurrences = 1, notifiedAt = '' }) {
    const id = crypto.randomUUID();
    prepare(`INSERT INTO monitor_incidents (id, tenant_id, scope, check_key, severity, state, title, message, first_at, last_at, resolved_at, occurrences, notified_at, reminded_at, resolved_notified_at, notify_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '')`)
      .run(id, tenantId, scope, checkKey, cleanSeverity(severity), state, redact(title, 200), redact(message, MAX_MESSAGE), at, resolvedAt || at, resolvedAt, occurrences, notifiedAt);
    return prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incidents WHERE tenant_id = ? AND id = ?`).get(tenantId, id);
  }

  /**
   * Wijzigt velden van een incident.
   * @param {string} tenantId De omgeving.
   * @param {string} id Het incident.
   * @param {object} fields Kolomnamen met nieuwe waarden (alleen de bekende kolommen).
   * @returns {object|null} De bijgewerkte rij.
   */
  function update(tenantId, id, fields) {
    const allowed = ['severity', 'state', 'title', 'message', 'last_at', 'resolved_at', 'occurrences', 'notified_at', 'reminded_at', 'resolved_notified_at', 'notify_error'];
    const names = Object.keys(fields).filter((name) => allowed.includes(name));
    if (names.length) {
      prepare(`UPDATE monitor_incidents SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`)
        .run(...names.map((name) => fields[name]), tenantId, id);
    }
    return prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incidents WHERE tenant_id = ? AND id = ?`).get(tenantId, id) || null;
  }

  /**
   * Sluit een open incident.
   * @param {string} tenantId De omgeving.
   * @param {string} id Het incident.
   * @param {string} at Tijdstip (ISO).
   * @returns {object|null} De bijgewerkte rij.
   */
  const resolve = (tenantId, id, at) => update(tenantId, id, { state: 'opgelost', resolved_at: at, last_at: at });

  /**
   * Incidenten van een omgeving, nieuwste eerst.
   * @param {string} tenantId De omgeving.
   * @param {{ state?: string, scope?: string, limit?: number, before?: string }} [options] Alleen open of opgelost, alleen platform of tenant, aantal en cursor (last_at van het laatste item van de vorige bladzijde).
   * @returns {object[]} De rijen.
   */
  function list(tenantId, { state = '', scope = '', limit = 50, before = '' } = {}) {
    const filters = [];
    const params = [tenantId];
    if (state === 'open' || state === 'opgelost') { filters.push('state = ?'); params.push(state); }
    if (scope === 'platform' || scope === 'tenant') { filters.push('scope = ?'); params.push(scope); }
    if (typeof before === 'string' && before) { filters.push('last_at < ?'); params.push(before.slice(0, 40)); }
    const count = Math.min(MAX_LIST, Math.max(1, Math.floor(Number(limit)) || 50));
    return prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incidents WHERE tenant_id = ?${filters.map((filter) => ` AND ${filter}`).join('')} ORDER BY last_at DESC, id DESC LIMIT ${count}`).all(...params);
  }

  /**
   * Aantal open incidenten per ernst.
   * @param {string} tenantId De omgeving.
   * @param {string} [scope] Alleen deze scope ('platform'|'tenant'), leeg = beide.
   * @returns {{ fout: number, waarschuwing: number }} De aantallen.
   */
  function counts(tenantId, scope = '') {
    const scoped = scope === 'platform' || scope === 'tenant';
    const rows = prepare(`SELECT severity, COUNT(*) AS n FROM monitor_incidents WHERE tenant_id = ? AND state = 'open'${scoped ? ' AND scope = ?' : ''} GROUP BY severity`)
      .all(...(scoped ? [tenantId, scope] : [tenantId]));
    const out = { fout: 0, waarschuwing: 0 };
    for (const row of rows) if (row.severity in out) out[row.severity] = Number(row.n) || 0;
    return out;
  }

  /**
   * Alle open incidenten van een omgeving in een scope (voor het overzicht per controle).
   * @param {string} tenantId De omgeving.
   * @param {string} scope 'platform' of 'tenant'.
   * @returns {object[]} De rijen.
   */
  const openOf = (tenantId, scope) => prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incidents WHERE tenant_id = ? AND state = 'open' AND scope = ? ORDER BY last_at DESC LIMIT ${MAX_LIST}`)
    .all(tenantId, scope);

  /**
   * Verwijdert opgeloste incidenten die voor een tijdstip zijn opgelost.
   * @param {string} tenantId De omgeving.
   * @param {string} beforeIso Grens (ISO).
   * @returns {number} Aantal verwijderde incidenten.
   */
  const prune = (tenantId, beforeIso) => Number(prepare("DELETE FROM monitor_incidents WHERE tenant_id = ? AND state = 'opgelost' AND resolved_at <> '' AND resolved_at < ?")
    .run(tenantId, beforeIso).changes) || 0;

  return { findOpen, insert, update, resolve, list, counts, openOf, prune };
}

/**
 * Maakt de bewaking.
 * @param {object} options
 * @param {object} options.db De database.
 * @param {Function} options.settingsFor settingsFor(tenantId) → instellingen van die omgeving (get/set).
 * @param {string} options.mainTenantId De hoofdtenant (platformincidenten en heartbeat).
 * @param {Function} options.listTenantIds () → id's van alle actieve omgevingen (voor de controles per omgeving).
 * @param {Function} options.mailerFor mailerFor(settings) → mailer ({ configured, send }).
 * @param {Function} [options.publicUrl] publicUrl(tenantId) → link naar Beheer > Bewaking voor in de melding ('' = geen link).
 * @param {Function} [options.tenantLabel] tenantLabel(tenantId) → naam van de omgeving voor in de melding (standaard het id).
 * @param {Function|null} [options.fetchImpl] Eigen fetch voor webhook en heartbeat (tests); zonder gaat het via pinned-fetch naar het gecontroleerde adres.
 * @param {Function} [options.resolveHost] Zoekt een hostnaam op en geeft een openbaar adres (standaard netguard.publicAddress).
 * @param {Function} [options.now] Klok in ms (tests).
 * @param {object} [options.log] Log (warn/error).
 * @param {number} [options.startGraceMs] Zo lang na het starten slaat een gewone ronde de controles over.
 * @param {number} [options.checkTimeoutMs] Tijdslimiet per controle.
 * @returns {object} { register, checks, runAll, report, list, openCount, checkStates, config, sendTest, heartbeat, lastHeartbeat, prune, incidents }.
 */
function createMonitor({
  db, settingsFor, mainTenantId, listTenantIds = () => [], mailerFor, publicUrl = () => '', tenantLabel = (tenantId) => tenantId,
  fetchImpl = null, resolveHost, now = Date.now, log = console, startGraceMs = 120000, checkTimeoutMs = CHECK_TIMEOUT_MS,
}) {
  const incidents = createIncidentStore({ db });
  const notifier = createNotifier({ mailerFor, fetchImpl, log, ...(resolveHost ? { resolveHost } : {}) });
  const startedAt = now();
  /** De geregistreerde controles, op volgorde. */
  const registered = new Map();
  /** Uitkomst van de laatste uitvoering per '<tenant>|<controle>'. */
  const lastResults = new Map();
  /** Wachtrij per '<tenant>|<controle>', zodat twee uitkomsten van dezelfde controle elkaar niet kruisen. */
  const queues = new Map();
  let lastBeat = null;

  /**
   * Het huidige tijdstip als ISO-tekst.
   * @returns {string} Het tijdstip.
   */
  const nowIso = () => new Date(now()).toISOString();

  /**
   * De omgeving waaronder incidenten van een scope staan: platform = hoofdtenant.
   * @param {string} tenantId De omgeving.
   * @param {string} scope 'platform' of 'tenant'.
   * @returns {string} De omgeving voor de opslag en de instelling.
   */
  const ownerOf = (tenantId, scope) => (scope === 'platform' ? mainTenantId : tenantId);

  /**
   * De gesaneerde instelling `monitoring` van een omgeving; bij een fout de standaard.
   * @param {string} tenantId De omgeving.
   * @returns {object} De instelling met standaarden.
   */
  function config(tenantId) {
    try {
      return sanitizeMonitoring(settingsFor(tenantId).get('monitoring'));
    } catch (error) {
      log.warn('[bewaking] Instelling niet te lezen:', redact(error && error.message, 200));
      return sanitizeMonitoring(MONITORING_DEFAULTS);
    }
  }

  /**
   * Voegt een controle toe (of vervangt die met dezelfde sleutel).
   * @param {{ key: string, scope: 'platform'|'tenant', title: string, intervalMinutes?: number, run: Function }} check De controle.
   * @returns {void}
   */
  function register(check) {
    if (!check || typeof check.key !== 'string' || !check.key || typeof check.run !== 'function') throw new Error('Ongeldige controle.');
    registered.set(check.key, {
      key: check.key, scope: check.scope === 'platform' ? 'platform' : 'tenant', title: String(check.title || check.key),
      intervalMinutes: Math.max(1, Number(check.intervalMinutes) || 5), run: check.run,
    });
  }

  /**
   * Voert taken na elkaar uit per sleutel (een volgende wacht op de vorige).
   * @param {string} key De sleutel.
   * @param {Function} task Async taak.
   * @returns {Promise<*>} Wat de taak teruggeeft.
   */
  function serialized(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }

  /**
   * Verstuurt een melding (mail + webhook) over een incident en legt een eventuele fout vast in notify_error.
   * Gooit nooit.
   * @param {string} owner De omgeving van het incident (en van de instelling en de mailserver).
   * @param {object} row Het incident.
   * @param {'open'|'herinnering'|'opgelost'} kind Soort melding.
   * @param {object} settingsConfig De instelling `monitoring`.
   * @returns {Promise<{ sent: boolean, error: string }>} Of er iets is verstuurd en de fout (of '').
   */
  async function notify(owner, row, kind, settingsConfig) {
    try {
      let link = '';
      let environment = owner;
      try { link = String(publicUrl(owner) || ''); } catch { link = ''; }
      try { environment = String(tenantLabel(owner) || owner); } catch { environment = owner; }
      const notice = composeNotice({
        kind, title: row.title, message: row.message, severity: row.severity, checkKey: row.check_key, environment,
        link, at: nowIso(),
      });
      let settings = null;
      try { settings = settingsFor(owner); } catch { settings = null; }
      const [mailResult, webhookResult] = await Promise.all([
        settings ? notifier.mail(settings, settingsConfig.recipients, notice) : Promise.resolve({ ok: false, message: 'Instellingen niet te lezen.' }),
        notifier.webhook(settingsConfig.webhookUrl, notice.payload),
      ]);
      const problems = [];
      if (!mailResult.ok && !mailResult.skipped) problems.push(`Mail: ${mailResult.message}`);
      if (!webhookResult.ok && !webhookResult.skipped) problems.push(`Webhook: ${webhookResult.message}`);
      const error = redact(problems.join(' '), 300);
      if (error) log.warn(`[bewaking] Melding over ${row.check_key} niet (helemaal) verstuurd:`, error);
      return { sent: mailResult.ok || webhookResult.ok, error };
    } catch (error) {
      log.warn('[bewaking] Melding mislukt:', redact(error && error.message, 200));
      return { sent: false, error: 'Melding mislukt (interne fout).' };
    }
  }

  /**
   * Verwerkt de uitkomst van een controle of gebeurtenis: opent, bevestigt of sluit het incident en verstuurt de
   * meldingen volgens de regels (nieuw, herinnering, zwaardere ernst, herstel).
   * @param {{ owner: string, scope: string, key: string, title: string, result: object }} input De omgeving van het incident, scope, controle, titel en uitkomst ({ ok } | { ok: false, severity, message } | { skip }).
   * @returns {Promise<{ incident: object|null, opened: boolean, resolved: boolean }>} Het incident (open, net opgelost, of null) en wat er veranderde.
   */
  function apply({ owner, scope, key, title, result }) {
    return serialized(`${owner}|${key}`, async () => {
      const settingsConfig = config(owner);
      const silent = !settingsConfig.enabled || settingsConfig.muted.includes(key);
      const at = nowIso();
      const open = incidents.findOpen(owner, key);
      if (result.skip || result.ok) {
        if (!open) return { incident: null, opened: false, resolved: false };
        let row = incidents.resolve(owner, open.id, at);
        if (!result.skip && settingsConfig.notifyRecovery && !silent && open.notified_at) {
          const outcome = await notify(owner, row, 'opgelost', settingsConfig);
          row = incidents.update(owner, open.id, { resolved_notified_at: outcome.sent ? nowIso() : '', notify_error: outcome.error });
        }
        return { incident: publicIncident(row), opened: false, resolved: true };
      }
      const severity = cleanSeverity(result.severity);
      const message = redact(result.message || '', MAX_MESSAGE);
      const cleanTitle = redact(title || key, 200);
      let row;
      let kind = null;
      let opened = false;
      if (!open) {
        try {
          row = incidents.insert({ tenantId: owner, scope, checkKey: key, severity, title: cleanTitle, message, at });
          opened = true;
          kind = 'open';
        } catch (error) {
          // Een ander proces was net eerder (unieke index op het open incident): dan dat incident bijwerken.
          const raced = incidents.findOpen(owner, key);
          if (!raced) throw error;
          row = incidents.update(owner, raced.id, { last_at: at, occurrences: (Number(raced.occurrences) || 0) + 1, message, title: cleanTitle });
        }
      } else {
        const escalated = open.severity === 'waarschuwing' && severity === 'fout';
        row = incidents.update(owner, open.id, { severity, last_at: at, occurrences: (Number(open.occurrences) || 0) + 1, message, title: cleanTitle });
        const lastNotice = Math.max(Date.parse(open.notified_at || '') || 0, Date.parse(open.reminded_at || '') || 0);
        if (escalated || !open.notified_at) kind = 'open';
        else if (settingsConfig.reminderHours > 0 && now() - lastNotice >= settingsConfig.reminderHours * 3600000) kind = 'herinnering';
      }
      if (kind && !silent) {
        const outcome = await notify(owner, row, kind, settingsConfig);
        const sentAt = nowIso();
        const fields = { notify_error: outcome.error };
        // Ook een volledig mislukte melding telt als poging: anders volgt bij elke ronde een nieuwe poging (en logregel).
        if (kind === 'open') Object.assign(fields, { notified_at: sentAt, reminded_at: '' });
        else fields.reminded_at = sentAt;
        row = incidents.update(owner, row.id, fields);
      }
      return { incident: publicIncident(row), opened, resolved: false };
    });
  }

  /**
   * Voert één controle uit met een tijdslimiet. Een controle die gooit, te lang duurt of iets onbruikbaars teruggeeft,
   * wordt een waarschuwing "Controle zelf mislukt: ...".
   * @param {object} check De controle.
   * @param {object} context ctx voor de controle ({ tenantId, scope, config, now }).
   * @returns {Promise<object>} De uitkomst.
   */
  async function runCheck(check, context) {
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`duurde langer dan ${Math.round(checkTimeoutMs / 1000)} s.`), { code: 'check_timeout' })), checkTimeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => check.run(context)), timeout]);
      if (!result || typeof result !== 'object') throw new Error('ongeldige uitkomst.');
      if (result.skip) return { skip: true };
      if (result.ok === true) return { ok: true };
      return { ok: false, severity: cleanSeverity(result.severity), message: redact(result.message || 'Controle niet geslaagd.', MAX_MESSAGE) };
    } catch (error) {
      return { ok: false, severity: 'waarschuwing', message: redact(`Controle zelf mislukt: ${error && error.message ? error.message : error}`, MAX_MESSAGE) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Voert een controle uit voor een omgeving en verwerkt de uitkomst. Gooit nooit.
   * @param {object} check De controle.
   * @param {string} owner De omgeving (bij platform de hoofdtenant); de controle krijgt de instelling van die omgeving.
   * @returns {Promise<{ opened: boolean, resolved: boolean }>} Wat er veranderde.
   */
  async function execute(check, owner) {
    const stateKey = `${owner}|${check.key}`;
    const context = { tenantId: owner, scope: check.scope, config: config(owner), now };
    const result = await runCheck(check, context);
    lastResults.set(stateKey, {
      status: result.skip ? 'overgeslagen' : result.ok ? 'ok' : 'open', severity: result.ok || result.skip ? '' : result.severity,
      message: result.ok || result.skip ? '' : result.message, lastRunAt: nowIso(), ranAtMs: now(),
    });
    try {
      const outcome = await apply({ owner, scope: check.scope, key: check.key, title: check.title, result });
      return { opened: outcome.opened, resolved: outcome.resolved };
    } catch (error) {
      log.error('[bewaking] Uitkomst niet vast te leggen:', check.key, redact(error && error.message, 300));
      return { opened: false, resolved: false };
    }
  }

  /**
   * Voert taken uit met hoogstens zoveel tegelijk.
   * @param {Function[]} tasks Async taken zonder argumenten.
   * @param {number} limit Hoeveel tegelijk.
   * @returns {Promise<object[]>} De uitkomsten in volgorde.
   */
  async function inParallel(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    /**
     * Werkt de wachtrij af tot alle taken gedaan zijn.
     * @returns {Promise<void>}
     */
    const worker = async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  }

  /**
   * Voert de controles uit die aan de beurt zijn: de platformcontroles één keer voor de hoofdtenant, de controles per
   * omgeving voor elke actieve omgeving. Binnen startGraceMs na het starten slaat een gewone ronde de controles over
   * (een herstart geeft dan geen valse meldingen). Een volledige ronde stuurt daarna de heartbeat.
   * @param {{ force?: boolean, tenantId?: string, includePlatform?: boolean }} [options] force = alles nu, ook binnen de starttijd en buiten het interval; tenantId = alleen de controles van die omgeving (Nu controleren in Beheer), met includePlatform ook de platformcontroles; dan geen heartbeat.
   * @returns {Promise<{ ran: number, opened: number, resolved: number, grace?: boolean }>} Aantal uitgevoerde controles, nieuwe en opgeloste incidenten.
   */
  function runRound({ force = false, tenantId = '', includePlatform = false } = {}) {
    return asSystem(async () => {
      const summary = { ran: 0, opened: 0, resolved: 0 };
      const full = !tenantId;
      if (!force && now() - startedAt < startGraceMs) {
        summary.grace = true;
        if (full) await heartbeat();
        return summary;
      }
      let tenantIds = [];
      if (full) {
        try {
          tenantIds = [...new Set((await listTenantIds()) || [])].filter((id) => typeof id === 'string' && id);
        } catch (error) {
          log.warn('[bewaking] Omgevingen niet te lezen:', redact(error && error.message, 200));
        }
      } else {
        tenantIds = [tenantId];
      }
      const tasks = [];
      /**
       * Of een controle voor een omgeving aan de beurt is.
       * @param {object} check De controle.
       * @param {string} owner De omgeving.
       * @returns {boolean} true als hij moet draaien.
       */
      const due = (check, owner) => {
        if (force) return true;
        const last = lastResults.get(`${owner}|${check.key}`);
        return !last || now() - last.ranAtMs >= check.intervalMinutes * 60000 - INTERVAL_SLACK_MS;
      };
      for (const check of registered.values()) {
        if (check.scope === 'platform') {
          if ((full || includePlatform) && due(check, mainTenantId)) tasks.push(() => execute(check, mainTenantId));
        } else {
          for (const id of tenantIds) if (due(check, id)) tasks.push(() => execute(check, id));
        }
      }
      const outcomes = await inParallel(tasks, PARALLEL_CHECKS);
      for (const outcome of outcomes) {
        summary.ran++;
        if (outcome.opened) summary.opened++;
        if (outcome.resolved) summary.resolved++;
      }
      if (full) await heartbeat();
      return summary;
    });
  }

  /** Staart van de laatste ronde: een volgende ronde wacht erop, zodat twee rondes nooit door elkaar lopen. */
  let lastRound = Promise.resolve();

  /**
   * Voert een ronde uit nadat een eventuele lopende ronde klaar is (de 5-minutentaak en Nu controleren kunnen
   * tegelijk komen). Een gewone ronde die erna aan de beurt is, ziet dan dat de controles net gelopen hebben.
   * @param {object} [options] Zie runRound.
   * @returns {Promise<object>} Zie runRound.
   */
  function runAll(options = {}) {
    const next = lastRound.catch(() => {}).then(() => runRound(options));
    lastRound = next;
    return next;
  }

  /**
   * Meldt een gebeurtenis (bijv. een mislukte upload) direct, zonder op een ronde te wachten: opent of bevestigt een
   * incident (ok: false) of sluit het (ok: true). Dezelfde meldregels als bij een controle. Gooit nooit.
   * @param {string} tenantId De omgeving (bij scope 'platform' genegeerd: dan de hoofdtenant).
   * @param {string} key De controle-sleutel.
   * @param {{ ok: boolean, severity?: string, title?: string, message?: string, scope?: string }} event De uitkomst.
   * @returns {Promise<object|null>} Het incident (open of net opgelost), of null.
   */
  async function report(tenantId, key, { ok, severity, title, message, scope = 'tenant' } = {}) {
    const cleanScope = scope === 'platform' ? 'platform' : 'tenant';
    const owner = ownerOf(tenantId, cleanScope);
    if (!owner || typeof key !== 'string' || !key) return null;
    const known = registered.get(key);
    const result = ok ? { ok: true } : { ok: false, severity: cleanSeverity(severity), message: redact(message || '', MAX_MESSAGE) };
    try {
      return await asSystem(async () => {
        const outcome = await apply({ owner, scope: cleanScope, key, title: title || (known && known.title) || key, result });
        lastResults.set(`${owner}|${key}`, {
          status: ok ? 'ok' : 'open', severity: ok ? '' : result.severity, message: ok ? '' : result.message,
          lastRunAt: nowIso(), ranAtMs: (lastResults.get(`${owner}|${key}`) || {}).ranAtMs || 0,
        });
        return outcome.incident;
      });
    } catch (error) {
      log.error('[bewaking] Gebeurtenis niet vast te leggen:', key, redact(error && error.message, 300));
      return null;
    }
  }

  /**
   * Incidenten van een omgeving, nieuwste eerst.
   * @param {string} tenantId De omgeving.
   * @param {{ state?: string, scope?: string, limit?: number, before?: string }} [options] Filter op open/opgelost en scope, aantal (standaard 50, hoogstens 500) en cursor (lastAt van het laatste item).
   * @returns {object[]} De incidenten.
   */
  const list = (tenantId, options = {}) => incidents.list(tenantId, options).map(publicIncident);

  /**
   * Aantal open incidenten per ernst.
   * @param {string} tenantId De omgeving.
   * @param {{ scope?: string }} [options] Alleen deze scope (standaard beide).
   * @returns {{ fout: number, waarschuwing: number }} De aantallen.
   */
  const openCount = (tenantId, { scope = '' } = {}) => incidents.counts(tenantId, scope);

  /**
   * De stand per controle voor het overzicht: uit de laatste uitvoering in het geheugen, aangevuld met de open
   * incidenten (ook van gebeurtenissen zonder eigen controle, en van voor een herstart).
   * @param {string} tenantId De omgeving.
   * @param {'platform'|'tenant'} scope Welke controles.
   * @returns {object[]} [{ key, title, scope, status: 'ok'|'open'|'overgeslagen'|'onbekend', severity, message, lastRunAt, muted, intervalMinutes }].
   */
  function checkStates(tenantId, scope) {
    const cleanScope = scope === 'platform' ? 'platform' : 'tenant';
    const owner = ownerOf(tenantId, cleanScope);
    const openByKey = new Map(incidents.openOf(owner, cleanScope).map((row) => [row.check_key, row]));
    const muted = config(owner).muted;
    const states = [];
    for (const check of registered.values()) {
      if (check.scope !== cleanScope) continue;
      const last = lastResults.get(`${owner}|${check.key}`);
      const open = openByKey.get(check.key);
      openByKey.delete(check.key);
      states.push({
        key: check.key, title: check.title, scope: cleanScope,
        status: open ? 'open' : last ? last.status : 'onbekend',
        severity: open ? open.severity : last ? last.severity : '',
        message: open ? open.message : last ? last.message : '',
        lastRunAt: last ? last.lastRunAt : '', muted: muted.includes(check.key), intervalMinutes: check.intervalMinutes,
      });
    }
    for (const open of openByKey.values()) {
      const last = lastResults.get(`${owner}|${open.check_key}`);
      states.push({
        key: open.check_key, title: open.title, scope: cleanScope, status: 'open', severity: open.severity, message: open.message,
        lastRunAt: last ? last.lastRunAt : open.last_at, muted: muted.includes(open.check_key), intervalMinutes: 0,
      });
    }
    return states;
  }

  /**
   * Stuurt de heartbeat van de hoofdtenant: een GET op het adres als er geen open platformincident van ernst 'fout'
   * is, anders op <adres>/fail. Zonder adres (of met de bewaking uit) gebeurt er niets. Gooit nooit.
   * @returns {Promise<{ ok: boolean, skipped: boolean, failed?: boolean, message?: string }>} De uitkomst.
   */
  async function heartbeat() {
    try {
      const settingsConfig = config(mainTenantId);
      if (!settingsConfig.enabled || !settingsConfig.heartbeatUrl) return { ok: false, skipped: true };
      const failed = asSystem(() => incidents.counts(mainTenantId, 'platform')).fout > 0;
      const outcome = await notifier.ping(settingsConfig.heartbeatUrl, { fail: failed });
      lastBeat = { ok: outcome.ok, failed, message: outcome.message, at: nowIso() };
      if (!outcome.ok) log.warn('[bewaking] Heartbeat niet verstuurd:', outcome.message);
      return { ok: outcome.ok, skipped: false, failed, message: outcome.message };
    } catch (error) {
      log.warn('[bewaking] Heartbeat mislukt:', redact(error && error.message, 200));
      return { ok: false, skipped: false, message: 'Heartbeat mislukt (interne fout).' };
    }
  }

  /**
   * De uitkomst van de laatste heartbeat (sinds het starten).
   * @returns {{ ok: boolean, failed: boolean, message: string, at: string }|null} De uitkomst, of null.
   */
  const lastHeartbeat = () => (lastBeat ? { ...lastBeat } : null);

  /**
   * Verstuurt een duidelijk gemarkeerde testmelding via alle ingestelde kanalen van een omgeving; er wordt niets als
   * incident opgeslagen. De heartbeat alleen in de hoofdtenant (een gewone ping, geen /fail).
   * @param {string} tenantId De omgeving.
   * @returns {Promise<{ mail: object, webhook: object, heartbeat: object }>} Per kanaal { ok, message, skipped? }.
   */
  async function sendTest(tenantId) {
    const settingsConfig = config(tenantId);
    let link = '';
    let environment = tenantId;
    try { link = String(publicUrl(tenantId) || ''); } catch { link = ''; }
    try { environment = String(tenantLabel(tenantId) || tenantId); } catch { environment = tenantId; }
    const notice = composeNotice({ kind: 'test', title: 'Testmelding van de bewaking', message: 'Als je dit leest, komen meldingen aan.', checkKey: 'test', environment, link, at: nowIso() });
    let settings = null;
    try { settings = settingsFor(tenantId); } catch { settings = null; }
    const skippedHeartbeat = { ok: false, skipped: true, message: tenantId === mainTenantId ? 'Geen heartbeat-adres ingesteld.' : 'De heartbeat hoort bij de hoofdomgeving.' };
    const [mail, webhook, beat] = await Promise.all([
      settings ? notifier.mail(settings, settingsConfig.recipients, notice) : Promise.resolve({ ok: false, message: 'Instellingen niet te lezen.' }),
      notifier.webhook(settingsConfig.webhookUrl, notice.payload),
      tenantId === mainTenantId && settingsConfig.heartbeatUrl ? notifier.ping(settingsConfig.heartbeatUrl) : Promise.resolve(skippedHeartbeat),
    ]);
    return { mail, webhook, heartbeat: beat };
  }

  /**
   * Verwijdert opgeloste incidenten die langer dan zoveel dagen geleden zijn opgelost (bewaartermijn =
   * auditRetentionDays). Open incidenten blijven altijd staan.
   * @param {string} tenantId De omgeving.
   * @param {number} days Bewaartermijn in dagen (minstens 1).
   * @returns {number} Aantal verwijderde incidenten.
   */
  function prune(tenantId, days) {
    const keepDays = Math.max(1, Math.floor(Number(days)) || 1);
    return incidents.prune(tenantId, new Date(now() - keepDays * 86400000).toISOString());
  }

  /**
   * De geregistreerde controles (zonder de functie zelf).
   * @returns {object[]} [{ key, scope, title, intervalMinutes }].
   */
  const checks = () => [...registered.values()].map(({ key, scope, title, intervalMinutes }) => ({ key, scope, title, intervalMinutes }));

  return { register, checks, runAll, report, list, openCount, checkStates, config, sendTest, heartbeat, lastHeartbeat, prune, incidents };
}

module.exports = { createMonitor, createIncidentStore, sanitizeMonitoring, cleanHttpsUrl, MONITORING_DEFAULTS, CHECK_TIMEOUT_MS };
