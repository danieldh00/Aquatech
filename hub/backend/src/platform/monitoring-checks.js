// De controles van de bewaking (Beheer > Systeem > Bewaking). createMonitoringChecks(deps) geeft een lijst checks in
// het formaat van de monitor (platform/monitoring.js): { key, scope, title, intervalMinutes, run(ctx) → result }.
// ctx = { tenantId, scope, config (gesaneerde instelling `monitoring`), now: () => ms };
// result = { ok: true } | { ok: false, severity: 'fout'|'waarschuwing', message } | { skip: true }.
//
// Elke check is klein: één statusaanroep of één query met tenant_id en LIMIT, nooit per regel. Dure controles bij een
// externe dienst (mailserver, Mollie) gebeuren hoogstens één keer per uur per omgeving; het resultaat wordt onthouden
// (alleen in het geheugen, met een SHA-256-vingerafdruk van de instelling, zodat een gewijzigde instelling meteen
// opnieuw wordt gecontroleerd). Meldingen gaan altijd door `redact` en bevatten nooit sleutels, tokens of wachtwoorden.
//
// Afhankelijkheden (in te vullen door server.js; een ontbrekende afhankelijkheid = die check wordt niet aangemaakt):
//   db                          de database (db.prepare(sql).get/all; met db.async.get gebruikt de databasecheck de pool)
//                               → checks database, visma, ai
//   settingsFor(tenantId)       instellingen van een omgeving ({ get(sleutel) }) → checks back-up, mail, mollie,
//                               webshop, ai (back-up leest backupKeepDays van ctx.tenantId = de hoofdtenant)
//   dataDir, backupDir          paden van de datamap en de back-upmap (backupDir leeg = back-ups niet ingesteld)
//                               → check schijf (minstens één van beide), check back-up (backupDir)
//   listBackups(dir)            backup.js listBackups: [{ name, size, createdAt }] nieuwste eerst → check back-up
//   systemUpdate                platform/system-update.js: { configured, view() } → check update
//   driveBackup                 platform/drive-backup.js: { status() } → check drive (platform: één koppeling per
//                               installatie, met de instellingen van de hoofdtenant)
//   errorCounter                platform/error-report.js errorCounter: { count(sinceMs) } → check serverfouten
//   mailerFor(settings)         zoals createApp: → { configured(), verify() } (platform/mailer.js) → check mail
//   mollie                      webshop/mollie.js createMollie({ fetchImpl }): { checkKey(apiKey) } → check mollie
//   visma                       verkoop/visma.js: { connected(tenantId) } (+ db voor visma_log) → check visma
//   shop                        webshop/shop.js createShopStore: { status(tenantId) } → check webshop
//   statfs(path)                optioneel, standaard fs.statfsSync (tests)
//   runtimeStats()              optioneel: () => { eventLoopP99Ms, heapUsedPct }; standaard gemeten met
//                               perf_hooks.monitorEventLoopDelay en v8; runtimeStats: false = geen runtimecheck
//
// Voorbeeld in server.js:
//   createMonitoringChecks({ db: database, settingsFor, dataDir, backupDir, listBackups: backups.listBackups,
//     systemUpdate, driveBackup, errorCounter, mailerFor, mollie: createMollie(mollieFetch ? { fetchImpl: mollieFetch } : {}),
//     visma, shop: shopStore }).forEach((check) => monitor.register(check));
const crypto = require('crypto');
const fs = require('fs');
const v8 = require('v8');
const { monitorEventLoopDelay } = require('perf_hooks');
const { redact } = require('./error-report');
const { mailFailure } = require('./mailer');
const { configOf: mollieConfigOf } = require('../webshop/mollie');

const HOUR_MS = 3600 * 1000;
const MB = 1024 * 1024;
const MAX_MESSAGE = 500;
const EXTERNAL_CACHE_MS = HOUR_MS;
const EVENT_LOOP_MAX_MS = 1000;
const HEAP_MAX_PCT = 90;
const UPDATE_CHECK_MAX_HOURS = 24;
const UPDATE_REFUSED_HOURS = 24;
const SHOP_WARN_HOURS = 3;
const SHOP_FAIL_HOURS = 24;
const VISMA_WINDOW_HOURS = 24;
const VISMA_REPEATED = 3;
const AI_WINDOW_HOURS = 24;
const AI_RECENT = 3;
// Statussen in ai_usage die op een probleem met de sleutel, het tegoed of de dienst wijzen (niet op de tekening zelf).
const AI_KEY_PROBLEMS = ['auth', 'permission', 'no_credit', 'not_found'];
const AI_SERVICE_PROBLEMS = [...AI_KEY_PROBLEMS, 'rate_limited', 'api_error', 'error'];
const DEFAULT_THRESHOLDS = { backupMaxHours: 36, diskMinFreePct: 10, diskMinFreeMb: 1024, errorsPerHour: 20, dbSlowMs: 2000 };

/**
 * Een mislukte controle, met de melding zonder geheimen en ingekort.
 * @param {'fout'|'waarschuwing'} severity Ernst.
 * @param {string} message De melding.
 * @returns {{ ok: false, severity: string, message: string }} Het resultaat.
 */
const problem = (severity, message) => ({ ok: false, severity, message: redact(message, MAX_MESSAGE) });

const OK = Object.freeze({ ok: true });
const SKIP = Object.freeze({ skip: true });

/**
 * De drempels uit de instelling, met de standaard voor wat ontbreekt of onbruikbaar is.
 * @param {object} config De instelling `monitoring` (ctx.config).
 * @returns {object} backupMaxHours, diskMinFreePct, diskMinFreeMb, errorsPerHour en dbSlowMs.
 */
function thresholdsOf(config) {
  const given = config && config.thresholds && typeof config.thresholds === 'object' ? config.thresholds : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_THRESHOLDS)) {
    const value = Number(given[key]);
    out[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return out;
}

/**
 * Hoeveel uur er sinds een tijdstip voorbij is.
 * @param {number} nowMs Nu in milliseconden.
 * @param {string} isoTime Het tijdstip als ISO-tekst.
 * @returns {number} Aantal uren (Infinity zonder geldig tijdstip).
 */
const hoursSince = (nowMs, isoTime) => {
  const time = Date.parse(String(isoTime || ''));
  return Number.isFinite(time) ? (nowMs - time) / HOUR_MS : Infinity;
};

/**
 * Een aantal uren als korte leesbare tekst.
 * @param {number} hours Aantal uren.
 * @returns {string} Bijv. "40 uur" of "3 dagen".
 */
const formatHours = (hours) => (hours >= 72 ? `${Math.floor(hours / 24)} dagen` : `${Math.max(0, Math.floor(hours))} uur`);

/**
 * SHA-256-vingerafdruk van een waarde (om te zien of een instelling is gewijzigd, zonder hem te bewaren).
 * @param {*} value De waarde.
 * @returns {string} De hash als hex.
 */
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

/**
 * Een geheugen voor dure controles: per omgeving het resultaat met de vingerafdruk van de instelling en het tijdstip.
 * Een lopende controle wordt gedeeld (twee rondes tegelijk doen hem niet dubbel).
 * @param {number} ttlMs Hoe lang een resultaat geldt.
 * @returns {{ get: Function }} get(tenantId, vingerafdruk, nowMs, controle) → Promise<resultaat>.
 */
function createResultCache(ttlMs) {
  const entries = new Map();
  return {
    /**
     * Geeft het onthouden resultaat, of voert de controle uit als er geen geldig resultaat is.
     * @param {string} tenantId De omgeving.
     * @param {string} print Vingerafdruk van de instelling.
     * @param {number} nowMs Nu in milliseconden.
     * @param {() => Promise<object>} runCheck De dure controle.
     * @returns {Promise<object>} Het resultaat.
     */
    get(tenantId, print, nowMs, runCheck) {
      const entry = entries.get(tenantId);
      if (entry && entry.print === print && (entry.pending || nowMs - entry.at < ttlMs)) return entry.pending || Promise.resolve(entry.result);
      const pending = Promise.resolve().then(runCheck);
      const fresh = { print, at: nowMs, pending, result: null };
      entries.set(tenantId, fresh);
      return pending.then((result) => {
        fresh.result = result;
        fresh.pending = null;
        return result;
      }, (error) => {
        // Een controle die zelf gooit wordt niet onthouden: de volgende ronde probeert het opnieuw.
        if (entries.get(tenantId) === fresh) entries.delete(tenantId);
        throw error;
      });
    },
  };
}

/**
 * Meet de eventloop-vertraging en het geheugengebruik van dit proces (de standaard voor runtimeStats).
 * @returns {() => { eventLoopP99Ms: number, heapUsedPct: number }} Leesfunctie; elke lezing begint een nieuwe meetperiode.
 */
function createRuntimeStats() {
  let histogram = null;
  return () => {
    if (!histogram) {
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    }
    const p99 = histogram.count ? histogram.percentile(99) / 1e6 : 0;
    histogram.reset();
    const limit = v8.getHeapStatistics().heap_size_limit || 1;
    return { eventLoopP99Ms: p99, heapUsedPct: (process.memoryUsage().heapUsed / limit) * 100 };
  };
}

/**
 * Maakt alle controles van de bewaking voor de afhankelijkheden die er zijn.
 * @param {object} deps De afhankelijkheden (zie het kopcommentaar van dit bestand).
 * @returns {object[]} De checks: { key, scope, title, intervalMinutes, run }.
 */
function createMonitoringChecks(deps = {}) {
  const {
    db, settingsFor, dataDir, backupDir, listBackups, systemUpdate, driveBackup, errorCounter,
    mailerFor, mollie, visma, shop, statfs = fs.statfsSync,
  } = deps;
  const runtimeStats = deps.runtimeStats === false ? null : (deps.runtimeStats || createRuntimeStats());
  const mailCache = createResultCache(EXTERNAL_CACHE_MS);
  const mollieCache = createResultCache(EXTERNAL_CACHE_MS);
  const checks = [];

  // ---------- Platform ----------

  if (db) {
    checks.push({
      key: 'database', scope: 'platform', title: 'Database bereikbaar', intervalMinutes: 5,
      /**
       * Doet een SELECT 1 en meet hoe lang dat duurt.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const started = ctx.now();
        try {
          if (db.async && typeof db.async.get === 'function') await db.async.get('SELECT 1 AS ok');
          else db.prepare('SELECT 1 AS ok').get();
        } catch (error) {
          return problem('fout', `De database antwoordt niet: ${error && error.message ? error.message : error}`);
        }
        const elapsed = ctx.now() - started;
        const { dbSlowMs } = thresholdsOf(ctx.config);
        if (dbSlowMs > 0 && elapsed > dbSlowMs) return problem('waarschuwing', `De database reageert traag: ${Math.round(elapsed)} ms (drempel ${dbSlowMs} ms).`);
        return OK;
      },
    });
  }

  const diskPaths = [...new Set([dataDir, backupDir].filter(Boolean))];
  if (diskPaths.length) {
    checks.push({
      key: 'schijf', scope: 'platform', title: 'Vrije schijfruimte', intervalMinutes: 15,
      /**
       * Controleert de vrije ruimte op de datamap en de back-upmap. Onder een drempel = waarschuwing, onder de helft
       * van een drempel = fout.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const { diskMinFreePct, diskMinFreeMb } = thresholdsOf(ctx.config);
        let measured = 0;
        let worst = null;
        for (const dir of diskPaths) {
          let info;
          try {
            info = statfs(dir);
          } catch (error) {
            if (error && error.code === 'ENOENT') continue;
            throw error;
          }
          measured++;
          const blockSize = Number(info.bsize) || 0;
          const freeMb = (Number(info.bavail) * blockSize) / MB;
          const totalBlocks = Number(info.blocks) || 0;
          const freePct = totalBlocks ? (Number(info.bavail) / totalBlocks) * 100 : 100;
          const label = dir === backupDir && dir !== dataDir ? 'back-upmap' : 'datamap';
          let severity = null;
          if (freePct < diskMinFreePct / 2 || freeMb < diskMinFreeMb / 2) severity = 'fout';
          else if (freePct < diskMinFreePct || freeMb < diskMinFreeMb) severity = 'waarschuwing';
          if (severity && (!worst || (severity === 'fout' && worst.severity !== 'fout'))) {
            worst = { severity, message: `Weinig schijfruimte bij de ${label}: ${Math.round(freeMb)} MB vrij (${freePct.toFixed(1)}%). Drempel: ${diskMinFreeMb} MB of ${diskMinFreePct}%.` };
          }
        }
        if (!measured) return SKIP;
        return worst ? problem(worst.severity, worst.message) : OK;
      },
    });
  }

  if (backupDir && listBackups && settingsFor) {
    checks.push({
      key: 'backup', scope: 'platform', title: 'Lokale back-up', intervalMinutes: 60,
      /**
       * Controleert of de nieuwste lokale back-up niet te oud is (alleen als automatische back-ups aan staan).
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        if (Number(settingsFor(ctx.tenantId).get('backupKeepDays')) === 0) return SKIP;
        const { backupMaxHours } = thresholdsOf(ctx.config);
        if (!backupMaxHours) return SKIP;
        const newest = listBackups(backupDir)[0];
        if (!newest) return problem('fout', 'Er is nog geen lokale back-up gemaakt.');
        const age = hoursSince(ctx.now(), newest.createdAt);
        if (age > backupMaxHours) return problem('fout', `De nieuwste lokale back-up is ${formatHours(age)} oud (drempel ${backupMaxHours} uur). Controleer het serverlog.`);
        return OK;
      },
    });
  }

  if (systemUpdate && typeof systemUpdate.view === 'function') {
    checks.push({
      key: 'update', scope: 'platform', title: 'Systeemupdate', intervalMinutes: 15,
      /**
       * Leest de stand van het hostscript: een mislukte uitrol = fout, een geweigerde aanvraag (laatste 24 uur) of een
       * hostscript dat al een dag niet heeft gecontroleerd = waarschuwing.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const view = systemUpdate.view();
        if (!view || !view.configured) return SKIP;
        const status = view.status || {};
        if (status.state === 'mislukt') {
          return problem('fout', `De update${status.version ? ` naar ${status.version}` : ''} is mislukt: ${status.message || 'zie Beheer > Systeem > Updates.'}`);
        }
        if (status.state === 'geweigerd' && hoursSince(ctx.now(), status.finishedAt) <= UPDATE_REFUSED_HOURS) {
          return problem('waarschuwing', `De update-aanvraag is geweigerd: ${status.message || 'zie Beheer > Systeem > Updates.'}`);
        }
        if (status.checkedAt && status.state !== 'bezig') {
          const age = hoursSince(ctx.now(), status.checkedAt);
          if (age > UPDATE_CHECK_MAX_HOURS) return problem('waarschuwing', `Het updatescript op de server heeft al ${formatHours(age)} niet gecontroleerd op een nieuwe versie. Controleer de timer op de server.`);
        }
        return OK;
      },
    });
  }

  if (runtimeStats) {
    checks.push({
      key: 'runtime', scope: 'platform', title: 'Geheugen en reactiesnelheid', intervalMinutes: 5,
      /**
       * Controleert de eventloop-vertraging (p99 sinds de vorige ronde) en het gebruik van het heapgeheugen.
       * @returns {Promise<object>} Het resultaat.
       */
      async run() {
        const stats = runtimeStats() || {};
        const lag = Number(stats.eventLoopP99Ms) || 0;
        const heap = Number(stats.heapUsedPct) || 0;
        const issues = [];
        if (lag > EVENT_LOOP_MAX_MS) issues.push(`de server reageert traag (vertraging tot ${Math.round(lag)} ms)`);
        if (heap > HEAP_MAX_PCT) issues.push(`het geheugen is voor ${Math.round(heap)}% vol`);
        if (!issues.length) return OK;
        return problem('waarschuwing', `${issues.join(' en ').replace(/^./, (letter) => letter.toUpperCase())}.`);
      },
    });
  }

  if (errorCounter && typeof errorCounter.count === 'function') {
    checks.push({
      key: 'serverfouten', scope: 'platform', title: 'Serverfouten', intervalMinutes: 5,
      /**
       * Telt de 500-antwoorden van het laatste uur: boven de drempel = waarschuwing, boven drie keer de drempel = fout.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const { errorsPerHour } = thresholdsOf(ctx.config);
        if (!errorsPerHour) return SKIP;
        const count = Number(errorCounter.count(ctx.now() - HOUR_MS)) || 0;
        if (count <= errorsPerHour) return OK;
        const message = `${count} serverfouten in het laatste uur (drempel ${errorsPerHour}). De foutcodes staan in het serverlog.`;
        return problem(count > errorsPerHour * 3 ? 'fout' : 'waarschuwing', message);
      },
    });
  }

  if (driveBackup && typeof driveBackup.status === 'function') {
    checks.push({
      key: 'drive', scope: 'platform', title: 'Back-ups naar Google Drive', intervalMinutes: 60,
      /**
       * Leest de stand van de Drive-koppeling: opnieuw verbinden nodig = fout, laatste upload mislukt of geen recente
       * upload = waarschuwing, beide = fout.
       * @returns {Promise<object>} Het resultaat.
       */
      async run() {
        const status = driveBackup.status() || {};
        const enabled = Boolean(status.config && status.config.enabled);
        if (status.needsReconnect && (enabled || status.connected)) return problem('fout', 'Google Drive weigert de koppeling: verbind opnieuw in Beheer > Systeem > Back-ups naar Google Drive.');
        if (!enabled || !status.connected) return SKIP;
        const failedLast = Boolean(status.lastFailAt && (!status.lastOkAt || Date.parse(status.lastFailAt) > Date.parse(status.lastOkAt)));
        if (failedLast && status.stale) return problem('fout', 'De back-ups gaan al meer dan 36 uur niet naar Google Drive en de laatste poging mislukte. Zie het logboek in Beheer > Systeem > Back-ups naar Google Drive.');
        if (failedLast) return problem('waarschuwing', 'De laatste upload naar Google Drive is mislukt; hij wordt automatisch opnieuw geprobeerd.');
        if (status.stale) return problem('waarschuwing', 'Er is al meer dan 36 uur geen back-up naar Google Drive gegaan.');
        return OK;
      },
    });
  }

  // ---------- Per omgeving ----------

  if (settingsFor && mailerFor) {
    checks.push({
      key: 'mail', scope: 'tenant', title: 'Mailserver', intervalMinutes: 15,
      /**
       * Controleert (hoogstens één keer per uur) of de ingestelde mailserver verbinding en aanmelding accepteert.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const settings = settingsFor(ctx.tenantId);
        const mailer = mailerFor(settings);
        if (!mailer || typeof mailer.verify !== 'function' || !mailer.configured()) return SKIP;
        const print = fingerprint([settings.get('mailServer'), settings.get('mailPassword')]);
        return mailCache.get(ctx.tenantId, print, ctx.now(), async () => {
          try {
            await mailer.verify();
            return OK;
          } catch (error) {
            return problem('fout', mailFailure(error).replace(/^Versturen mislukt: ?/, 'De mailserver werkt niet: '));
          }
        });
      },
    });
  }

  if (settingsFor && mollie && typeof mollie.checkKey === 'function') {
    checks.push({
      key: 'mollie', scope: 'tenant', title: 'Online betalen (Mollie)', intervalMinutes: 15,
      /**
       * Als online betalen aan staat: of sleutel en webadres kloppen en (hoogstens één keer per uur) of Mollie de
       * sleutel nog accepteert.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const payment = mollieConfigOf(settingsFor(ctx.tenantId));
        if (!payment.wanted) return SKIP;
        if (!payment.online) return problem('fout', 'Online betalen staat aan, maar de Mollie-sleutel of het webadres van de webshop ontbreekt of klopt niet (Beheer > Webshop > Betalen).');
        return mollieCache.get(ctx.tenantId, fingerprint(payment.apiKey), ctx.now(), async () => {
          try {
            await mollie.checkKey(payment.apiKey);
            return OK;
          } catch (error) {
            const status = Number(error && error.status) || 0;
            if (status === 401 || status === 403) return problem('fout', 'Mollie weigert de API-sleutel. Klanten kunnen niet online betalen; vul een geldige sleutel in bij Beheer > Webshop > Betalen.');
            if (status === 0) return problem('waarschuwing', 'Mollie is niet bereikbaar; online betalen werkt mogelijk niet.');
            return problem('waarschuwing', `Mollie gaf een fout bij de controle (status ${status}).`);
          }
        });
      },
    });
  }

  if (db && visma && typeof visma.connected === 'function') {
    checks.push({
      key: 'visma', scope: 'tenant', title: 'Visma eAccounting', intervalMinutes: 15,
      /**
       * Leest het Visma-logboek van de laatste 24 uur (één query): een niet-herstelde mislukte aanmelding = fout,
       * herhaalde fouten die nog niet zijn gelukt = waarschuwing.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        if (!visma.connected(ctx.tenantId)) return SKIP;
        const since = new Date(ctx.now() - VISMA_WINDOW_HOURS * HOUR_MS).toISOString();
        const rows = db.prepare('SELECT kind, reference, ok, message, repeat_count, last_at FROM visma_log WHERE tenant_id = ? AND last_at >= ? ORDER BY last_at DESC LIMIT 50')
          .all(ctx.tenantId, since);
        // Nieuwste eerst: een fout telt alleen als er daarna niets meer gelukt is (aanmelding: niets; anders: hetzelfde onderdeel).
        let anyOkAfter = false;
        const okAfter = new Set();
        let loginFailure = null;
        let failures = 0;
        let firstMessage = '';
        for (const row of rows) {
          const subject = `${row.kind}|${row.reference || ''}`;
          if (Number(row.ok)) {
            anyOkAfter = true;
            okAfter.add(subject);
            continue;
          }
          if (row.kind === 'aanmelding') {
            if (!anyOkAfter && !loginFailure) loginFailure = row;
            continue;
          }
          if (okAfter.has(subject)) continue;
          failures += Math.max(1, Number(row.repeat_count) || 1);
          if (!firstMessage) firstMessage = row.message || '';
        }
        if (loginFailure) return problem('fout', `Visma weigert de aanmelding: ${loginFailure.message || 'verbind opnieuw'}. Verbind opnieuw in Facturen > Visma.`);
        if (failures >= VISMA_REPEATED) return problem('waarschuwing', `${failures} mislukte acties naar Visma in de laatste 24 uur. Laatste fout: ${firstMessage || 'zie het logboek in Facturen > Visma'}.`);
        return OK;
      },
    });
  }

  if (settingsFor && shop && typeof shop.status === 'function') {
    checks.push({
      key: 'webshop', scope: 'tenant', title: 'Webshopsynchronisatie', intervalMinutes: 15,
      /**
       * Als er een webshop (WooCommerce) gekoppeld is: laatste synchronisatie mislukt of langer dan 3 uur geleden =
       * waarschuwing, langer dan een dag = fout.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        const source = settingsFor(ctx.tenantId).get('shopSource');
        if (!source || !source.url) return SKIP;
        const status = shop.status(ctx.tenantId);
        if (!status) return SKIP;
        const age = hoursSince(ctx.now(), status.syncedAt);
        if (status.syncedAt && age > SHOP_FAIL_HOURS) {
          return problem('fout', `De webshop is al ${formatHours(age)} niet gesynchroniseerd${status.lastError ? `: ${status.lastError}` : '.'}`);
        }
        if (status.lastError) return problem('waarschuwing', `De laatste synchronisatie met de webshop is mislukt: ${status.lastError}`);
        if (status.syncedAt && age > SHOP_WARN_HOURS) return problem('waarschuwing', `De webshop is al ${formatHours(age)} niet gesynchroniseerd.`);
        return OK;
      },
    });
  }

  if (db && settingsFor) {
    checks.push({
      key: 'ai', scope: 'tenant', title: 'AI-dienst', intervalMinutes: 30,
      /**
       * Als deze omgeving een eigen AI-sleutel heeft: kijkt naar de laatste aanroepen (één query). Een geweigerde
       * sleutel of op tegoed als nieuwste uitkomst = fout; de laatste drie aanroepen mislukt bij de dienst = waarschuwing.
       * @param {object} ctx De context van de monitor.
       * @returns {Promise<object>} Het resultaat.
       */
      async run(ctx) {
        if (!settingsFor(ctx.tenantId).get('anthropicApiKey')) return SKIP;
        const since = new Date(ctx.now() - AI_WINDOW_HOURS * HOUR_MS).toISOString();
        const rows = db.prepare('SELECT status FROM ai_usage WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
          .all(ctx.tenantId, since, AI_RECENT);
        if (!rows.length) return OK;
        const newest = String(rows[0].status || '');
        if (AI_KEY_PROBLEMS.includes(newest)) {
          return problem('fout', newest === 'no_credit'
            ? 'Het API-tegoed van de AI-dienst is op; automatisch herkennen en inlezen werken niet.'
            : 'De AI-dienst weigert de API-sleutel of het model; controleer de sleutel in Beheer > Instellingen.');
        }
        if (rows.length >= AI_RECENT && rows.every((row) => AI_SERVICE_PROBLEMS.includes(String(row.status || '')))) {
          return problem('waarschuwing', `De laatste ${AI_RECENT} aanroepen van de AI-dienst zijn mislukt.`);
        }
        return OK;
      },
    });
  }

  return checks;
}

module.exports = { createMonitoringChecks, createResultCache, thresholdsOf, DEFAULT_THRESHOLDS };
