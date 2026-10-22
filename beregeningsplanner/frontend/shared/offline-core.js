// Offline werken (installateurs op locatie): de regels die de service worker
// (sw.js), de pagina's (shared/offline.js) en de tests delen. Geen DOM, geen
// opslag: alleen beslissingen, zodat ze zonder browser te testen zijn.
//
// Hoe het werkt (zie ook sw.js):
// - Lezen: een vaste lijst API-adressen (werkorders, startscherm, api/me)
//   komt eerst van de server en anders uit de cache van de ingelogde
//   medewerker. Alleen met het recht 'werkorders' en een eigen account.
// - Schrijven: een verzoek met de kop `X-Aquatech-Offline: 1` gaat bij geen
//   verbinding (of een onbereikbare server) in een wachtrij en wordt later
//   verstuurd, met een `Idempotency-Key` zodat een herhaling nooit dubbel telt.
//   Optioneel:
//     X-Aquatech-Offline-Key    wijzigingen met dezelfde sleutel worden
//                               samengevoegd (laatste wint per veld)
//     X-Aquatech-Offline-Label  omschrijving voor de gebruiker (URI-gecodeerd)
//     X-Aquatech-Offline-Patch  'merge': de JSON-body ook over de bewaarde
//                               GET van hetzelfde adres leggen (en het antwoord
//                               na versturen daar bewaren), zodat de pagina
//                               offline de eigen wijziging terugziet
//     X-Aquatech-Base           updatedAt waarop de wijziging is gebaseerd; in
//                               de wachtrij wordt dat X-Aquatech-If-Base, en
//                               de server weigert (409 conflict) als het item
//                               intussen door een ander is gewijzigd
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AquatechOfflineCore = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const HEADERS = {
    queue: 'x-aquatech-offline',
    key: 'x-aquatech-offline-key',
    label: 'x-aquatech-offline-label',
    patch: 'x-aquatech-offline-patch',
    base: 'x-aquatech-base',
    ifBase: 'x-aquatech-if-base',
    queued: 'x-aquatech-queued',
    idempotency: 'idempotency-key',
    cachedAt: 'x-aquatech-cached-at',
  };

  // Gegevens die offline beschikbaar mogen zijn (pad vanaf de app-root, met
  // query). Niets anders komt in de cache: geen offertes, geen beheer, geen
  // klantportaal en geen grote foto's (alleen miniaturen).
  const CACHEABLE = [
    /^api\/me$/,
    /^api\/config$/,
    /^api\/my-day(\?[a-z0-9=&%-]*)?$/i,
    /^api\/workorders$/,
    /^api\/workorders\/[A-Za-z0-9-]{1,64}$/,
    /^api\/workorders\/[A-Za-z0-9-]{1,64}\/photos$/,
    /^api\/workorders\/[A-Za-z0-9-]{1,64}\/worklog$/,
    /^api\/workorders\/[A-Za-z0-9-]{1,64}\/photos\/[A-Za-z0-9-]{1,64}\?thumb=1$/,
    /^api\/workorder-staff$/,
    /^api\/quote-profile$/,
  ];
  /**
   * Geeft aan of een adres offline beschikbaar mag zijn.
   * @param {string} relativePath Pad vanaf de app-root, met query.
   * @returns {boolean} true als het in CACHEABLE staat.
   */
  const cacheable = (relativePath) => CACHEABLE.some((pattern) => pattern.test(String(relativePath || '')));

  // Bewaarde gegevens en wachtende wijzigingen niet eindeloos bewaren.
  const DATA_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
  const QUEUE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const MAX_ATTEMPTS = 8;

  /**
   * Eigenaar van de offline gegevens: `<gebruiker>@<omgeving>`, of null.
   * @param {object} me Antwoord van api/me.
   * @returns {string|null} De eigenaar (null voor gasten of zonder gebruiker).
   */
  function ownerOf(me) {
    const user = me && me.user;
    if (!user || !user.id || user.kind === 'gast') return null;
    const tenantId = (me.tenant && me.tenant.id) || user.tenantId || '';
    return `${user.id}@${tenantId}`;
  }

  /**
   * Mag deze gebruiker offline werken? Alleen eigen accounts met werkorders, niet tijdens impersonatie.
   * @param {object} me Antwoord van api/me.
   * @returns {boolean} true als offline werken mag.
   */
  function offlineAllowed(me) {
    return Boolean(ownerOf(me) && me.user.kind === 'account' && !me.impersonation
      && Array.isArray(me.rights) && me.rights.includes('werkorders'));
  }

  // Een onbereikbare server (Cloudflare, tijdens een update) is hetzelfde als
  // geen verbinding: later opnieuw.
  const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);
  /**
   * Geeft aan of een status betekent dat de server onbereikbaar is.
   * @param {number} status HTTP-status.
   * @returns {boolean} true bij een gateway-fout.
   */
  const unreachable = (status) => GATEWAY.has(Number(status));

  /**
   * Wat te doen met het antwoord op een verstuurde wijziging uit de wachtrij:
   * 'done' (weg uit de wachtrij), 'retry' (later opnieuw), 'auth' (eerst
   * opnieuw inloggen), 'conflict' (gebruiker kiest) of 'failed' (geweigerd).
   * @param {number} status HTTP-status van het antwoord.
   * @param {object} [body] JSON-body van het antwoord.
   * @returns {string} 'done', 'retry', 'auth', 'conflict' of 'failed'.
   */
  function classify(status, body) {
    const statusCode = Number(status);
    const errorCode = body && body.error;
    if (statusCode >= 200 && statusCode < 300) return 'done';
    if (unreachable(statusCode) || statusCode === 429 || statusCode === 408 || errorCode === 'in_progress') return 'retry';
    if (statusCode === 401 || errorCode === 'password_change_required') return 'auth';
    if (statusCode === 409 && errorCode === 'conflict') return 'conflict';
    return 'failed';
  }

  /**
   * Geeft aan of een waarde een gewoon object is (geen array, geen null).
   * @param {*} value De waarde.
   * @returns {boolean} true bij een object.
   */
  const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  /**
   * Leest JSON zonder fout bij ongeldige tekst.
   * @param {string} text De JSON-tekst.
   * @returns {*} De waarde, of undefined als het geen JSON is.
   */
  function parseJson(text) {
    try { return JSON.parse(text); } catch (error) { return undefined; }
  }

  /**
   * Nieuwe wijziging samenvoegen met een wachtende met dezelfde sleutel. De
   * oudste basis (If-Base) blijft staan: daarop was de eerste wijziging
   * gebaseerd. JSON-objecten per veld samenvoegen (nieuw wint), anders vervangen.
   * @param {object} older Wachtende wijziging.
   * @param {object} newer Nieuwe wijziging met dezelfde sleutel.
   * @returns {object} De samengevoegde wijziging (weer 'pending').
   */
  function merge(older, newer) {
    const olderBody = parseJson(older.body);
    const newerBody = parseJson(newer.body);
    const body = isPlainObject(olderBody) && isPlainObject(newerBody) ? JSON.stringify({ ...olderBody, ...newerBody }) : newer.body;
    const headers = { ...older.headers, ...newer.headers };
    if (older.headers && older.headers[HEADERS.ifBase]) headers[HEADERS.ifBase] = older.headers[HEADERS.ifBase];
    return { ...older, ...newer, id: older.id, seq: older.seq, createdAt: older.createdAt, baseDoc: older.baseDoc !== undefined ? older.baseDoc : newer.baseDoc, headers, body, attempts: 0, state: 'pending', error: null };
  }

  /**
   * Na een geslaagde wijziging: latere wachtende wijzigingen op hetzelfde item
   * die van dezelfde basis uitgingen krijgen de nieuwe updatedAt als basis
   * (anders zouden ze botsen met onze eigen vorige wijziging).
   * @param {object[]} items De wachtrij (wordt aangepast).
   * @param {object} sent De verstuurde wijziging.
   * @param {object} response Antwoord van de server (met updatedAt).
   * @returns {object[]} De aangepaste wijzigingen.
   */
  function rebase(items, sent, response) {
    const from = sent.headers && sent.headers[HEADERS.ifBase];
    const to = response && response.updatedAt;
    if (!sent.key || !to) return [];
    const changed = [];
    for (const item of items) {
      if (item.id === sent.id || item.key !== sent.key || !item.headers) continue;
      const base = item.headers[HEADERS.ifBase];
      if (base && (!from || base === from)) {
        item.headers[HEADERS.ifBase] = to;
        // Die wijziging bouwt nu voort op wat de server net teruggaf.
        if (item.baseDoc !== undefined && isPlainObject(response)) item.baseDoc = response;
        changed.push(item);
      }
    }
    return changed;
  }

  /**
   * Bewaarde GET bijwerken met een wachtende wijziging (Offline-Patch: merge).
   * @param {object} resource De bewaarde gegevens.
   * @param {string} body JSON-body van de wijziging.
   * @returns {object} De bijgewerkte gegevens (ongewijzigd als het geen objecten zijn).
   */
  function applyPatch(resource, body) {
    const patch = parseJson(body);
    if (!isPlainObject(resource) || !isPlainObject(patch)) return resource;
    const out = { ...resource };
    for (const [key, value] of Object.entries(patch)) if (key !== 'base') out[key] = value;
    return out;
  }

  // ---------- Drieweg samenvoegen ----------
  /**
   * Geeft aan of twee waarden gelijk zijn (via JSON).
   * @param {*} left Eerste waarde.
   * @param {*} right Tweede waarde.
   * @returns {boolean} true als ze gelijk zijn.
   */
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  /**
   * Geeft aan of een lijst bestaat uit objecten met een tekst-id (zoals werkstappen).
   * @param {*} list De waarde.
   * @returns {boolean} true bij een lijst met id's.
   */
  const byId = (list) => Array.isArray(list) && list.every((item) => isPlainObject(item) && typeof item.id === 'string' && item.id);

  /**
   * Een offline wijziging (mine) die botst met een wijziging van een ander
   * (theirs) samenvoegen ten opzichte van de versie waarop ze allebei
   * voortbouwden (base). Per veld: wie het veld heeft gewijzigd, wint; hebben
   * beiden hetzelfde veld anders gewijzigd, dan is dat een conflict. Lijsten
   * met id's (werkstappen, materialen) per regel en per veld.
   * Geeft { value, conflicts: [paden] }.
   * @param {*} base Versie waarop beide wijzigingen voortbouwden.
   * @param {*} mine De offline wijziging.
   * @param {*} theirs De wijziging van de ander.
   * @param {string} [at] Pad van dit veld (voor de conflicten).
   * @returns {{value: *, conflicts: string[]}} De samengevoegde waarde en de paden met een conflict.
   */
  function merge3(base, mine, theirs, at = '') {
    if (same(mine, theirs)) return { value: mine, conflicts: [] };
    if (same(mine, base)) return { value: theirs, conflicts: [] };
    if (same(theirs, base)) return { value: mine, conflicts: [] };
    if (isPlainObject(mine) && isPlainObject(theirs)) {
      const baseObject = isPlainObject(base) ? base : {};
      const value = {};
      const conflicts = [];
      for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
        const merged = merge3(baseObject[key], mine[key], theirs[key], at ? `${at}.${key}` : key);
        if (merged.value !== undefined) value[key] = merged.value;
        conflicts.push(...merged.conflicts);
      }
      return { value, conflicts };
    }
    if (byId(mine) && byId(theirs) && (base === undefined || byId(base))) {
      /**
       * Zet een lijst met id's om naar een Map op id.
       * @param {object[]} list De lijst.
       * @returns {Map<string, object>} De regels op id.
       */
      const index = (list) => new Map((list || []).map((item) => [item.id, item]));
      const baseById = index(base), mineById = index(mine), theirsById = index(theirs);
      const conflicts = [];
      const out = [];
      /**
       * Voegt één regel (op id) samen; een weggehaalde regel blijft weg tenzij de andere kant hem wijzigde.
       * @param {string} id Id van de regel.
       * @returns {object|undefined} De regel, of undefined als hij weg moet.
       */
      const take = (id) => {
        const baseItem = baseById.get(id), mineItem = mineById.get(id), theirsItem = theirsById.get(id);
        const path = `${at}[${id}]`;
        if (mineItem && theirsItem) { const merged = merge3(baseItem, mineItem, theirsItem, path); conflicts.push(...merged.conflicts); return merged.value; }
        if (!mineItem && !theirsItem) return undefined;
        // Weggehaald aan de ene kant: weg, tenzij de andere kant hem wijzigde.
        if (!mineItem) { if (baseItem && !same(baseItem, theirsItem)) conflicts.push(path); return baseItem ? undefined : theirsItem; }
        if (baseItem && !same(baseItem, mineItem)) conflicts.push(path);
        return baseItem ? undefined : mineItem;
      };
      // Volgorde van de ander aanhouden; nieuwe regels van mij op hun plek erachter.
      const ids = [...theirsById.keys()];
      mine.forEach((item, i) => {
        if (theirsById.has(item.id) || baseById.has(item.id)) return;
        const previousIndex = i > 0 ? ids.indexOf(mine[i - 1].id) : -1;
        ids.splice(previousIndex + 1, 0, item.id);
      });
      for (const id of ids) {
        const value = take(id);
        if (value !== undefined) out.push(value);
      }
      for (const id of mineById.keys()) if (!ids.includes(id)) { const value = take(id); if (value !== undefined) out.push(value); }
      return { value: out, conflicts };
    }
    return { value: mine, conflicts: [at || '(geheel)'] };
  }

  /**
   * Botsende wijziging (body van de wachtrij) samenvoegen met de huidige
   * versie op de server. Alleen de velden uit de body tellen. Geeft
   * { body (tekst), conflicts } of null als het niet kan.
   * @param {string} body JSON-body uit de wachtrij.
   * @param {object} baseDoc Versie waarop de wijziging voortbouwde.
   * @param {object} current Huidige versie op de server.
   * @returns {{body: string, conflicts: string[]}|null} De nieuwe body en de conflicten, of null.
   */
  function rebaseBody(body, baseDoc, current) {
    const mine = parseJson(body);
    if (!isPlainObject(mine) || !isPlainObject(baseDoc) || !isPlainObject(current)) return null;
    const out = {};
    const conflicts = [];
    for (const key of Object.keys(mine)) {
      const merged = merge3(baseDoc[key], mine[key], current[key], key);
      out[key] = merged.value;
      conflicts.push(...merged.conflicts);
    }
    return { body: JSON.stringify(out), conflicts };
  }

  /**
   * Alleen de koppen die de wachtrij bewaart (kleine letters).
   * @param {Function} get Leest een kop van het verzoek (naam → waarde).
   * @returns {object} De koppen.
   */
  function keepHeaders(get) {
    const out = {};
    const contentType = get('content-type');
    if (contentType) out['content-type'] = contentType;
    const base = get(HEADERS.base);
    if (base && base.length <= 64) out[HEADERS.ifBase] = base;
    return out;
  }

  /**
   * Nieuw willekeurig id (UUID als de browser dat kan).
   * @returns {string} Het id.
   */
  function newId() {
    const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    const bytes = new Uint8Array(16);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Namen van velden voor de melding bij een conflict.
  const FIELDS = {
    status: 'status', assigneeId: 'uitvoerder', title: 'omschrijving', customer: 'klantgegevens', plannedDate: 'datum',
    startTime: 'begintijd', endTime: 'eindtijd', days: 'werkdagen', crew: 'ploeg', instructions: 'werkinstructies',
    siteNotes: 'bijzonderheden locatie', steps: 'werkstappen', materials: 'materialen', report: 'oplevering',
    zones: 'zone-indeling', caption: 'bijschrift', kind: 'fase', customerVisible: 'zichtbaar voor de klant',
  };
  /**
   * Conflictpaden ('data.steps[s1].done') als korte tekst: 'werkstappen'.
   * @param {string[]} paths De paden.
   * @returns {string[]} De veldnamen, zonder dubbele.
   */
  function fieldNames(paths) {
    const names = [];
    for (const path of paths || []) {
      const segments = String(path).split(/[.[]/).filter((part) => part && part !== 'data');
      const name = FIELDS[segments[0]] || segments[0] || 'gegevens';
      if (!names.includes(name)) names.push(name);
    }
    return names;
  }

  /**
   * Korte omschrijving voor de gebruiker als er geen label is meegegeven.
   * @param {object} item Wijziging uit de wachtrij.
   * @returns {string} Het label, of bijv. "PUT workorders".
   */
  function describe(item) {
    if (item.label) return item.label;
    const match = String(item.url || '').match(/api\/([a-z-]+)/);
    return `${item.method} ${match ? match[1] : 'wijziging'}`;
  }

  return {
    HEADERS, CACHEABLE, cacheable, DATA_MAX_AGE_MS, QUEUE_MAX_AGE_MS, MAX_ATTEMPTS,
    ownerOf, offlineAllowed, unreachable, classify, merge, rebase, merge3, rebaseBody, fieldNames, applyPatch, keepHeaders, newId, describe, parseJson,
  };
});
