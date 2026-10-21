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
  const cacheable = (rel) => CACHEABLE.some((re) => re.test(String(rel || '')));

  // Bewaarde gegevens en wachtende wijzigingen niet eindeloos bewaren.
  const DATA_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
  const QUEUE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const MAX_ATTEMPTS = 8;

  /** Eigenaar van de offline gegevens: `<gebruiker>@<omgeving>`, of null. */
  function ownerOf(me) {
    const u = me && me.user;
    if (!u || !u.id || u.kind === 'gast') return null;
    const t = (me.tenant && me.tenant.id) || u.tenantId || '';
    return `${u.id}@${t}`;
  }

  /** Mag deze gebruiker offline werken? Alleen eigen accounts met werkorders, niet tijdens impersonatie. */
  function offlineAllowed(me) {
    return Boolean(ownerOf(me) && me.user.kind === 'account' && !me.impersonation
      && Array.isArray(me.rights) && me.rights.includes('werkorders'));
  }

  // Een onbereikbare server (Cloudflare, tijdens een update) is hetzelfde als
  // geen verbinding: later opnieuw.
  const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);
  const unreachable = (status) => GATEWAY.has(Number(status));

  /**
   * Wat te doen met het antwoord op een verstuurde wijziging uit de wachtrij:
   * 'done' (weg uit de wachtrij), 'retry' (later opnieuw), 'auth' (eerst
   * opnieuw inloggen), 'conflict' (gebruiker kiest) of 'failed' (geweigerd).
   */
  function classify(status, body) {
    const s = Number(status);
    const code = body && body.error;
    if (s >= 200 && s < 300) return 'done';
    if (unreachable(s) || s === 429 || s === 408 || code === 'in_progress') return 'retry';
    if (s === 401 || code === 'password_change_required') return 'auth';
    if (s === 409 && code === 'conflict') return 'conflict';
    return 'failed';
  }

  const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return undefined; }
  }

  /**
   * Nieuwe wijziging samenvoegen met een wachtende met dezelfde sleutel. De
   * oudste basis (If-Base) blijft staan: daarop was de eerste wijziging
   * gebaseerd. JSON-objecten per veld samenvoegen (nieuw wint), anders vervangen.
   */
  function merge(older, newer) {
    const a = parseJson(older.body);
    const b = parseJson(newer.body);
    const body = isPlainObject(a) && isPlainObject(b) ? JSON.stringify({ ...a, ...b }) : newer.body;
    const headers = { ...older.headers, ...newer.headers };
    if (older.headers && older.headers[HEADERS.ifBase]) headers[HEADERS.ifBase] = older.headers[HEADERS.ifBase];
    return { ...older, ...newer, id: older.id, seq: older.seq, createdAt: older.createdAt, baseDoc: older.baseDoc !== undefined ? older.baseDoc : newer.baseDoc, headers, body, attempts: 0, state: 'pending', error: null };
  }

  /**
   * Na een geslaagde wijziging: latere wachtende wijzigingen op hetzelfde item
   * die van dezelfde basis uitgingen krijgen de nieuwe updatedAt als basis
   * (anders zouden ze botsen met onze eigen vorige wijziging).
   */
  function rebase(items, sent, response) {
    const from = sent.headers && sent.headers[HEADERS.ifBase];
    const to = response && response.updatedAt;
    if (!sent.key || !to) return [];
    const changed = [];
    for (const it of items) {
      if (it.id === sent.id || it.key !== sent.key || !it.headers) continue;
      const base = it.headers[HEADERS.ifBase];
      if (base && (!from || base === from)) {
        it.headers[HEADERS.ifBase] = to;
        // Die wijziging bouwt nu voort op wat de server net teruggaf.
        if (it.baseDoc !== undefined && isPlainObject(response)) it.baseDoc = response;
        changed.push(it);
      }
    }
    return changed;
  }

  /** Bewaarde GET bijwerken met een wachtende wijziging (Offline-Patch: merge). */
  function applyPatch(resource, body) {
    const b = parseJson(body);
    if (!isPlainObject(resource) || !isPlainObject(b)) return resource;
    const out = { ...resource };
    for (const [k, v] of Object.entries(b)) if (k !== 'base') out[k] = v;
    return out;
  }

  // ---------- Drieweg samenvoegen ----------
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const byId = (list) => Array.isArray(list) && list.every((x) => isPlainObject(x) && typeof x.id === 'string' && x.id);

  /**
   * Een offline wijziging (mine) die botst met een wijziging van een ander
   * (theirs) samenvoegen ten opzichte van de versie waarop ze allebei
   * voortbouwden (base). Per veld: wie het veld heeft gewijzigd, wint; hebben
   * beiden hetzelfde veld anders gewijzigd, dan is dat een conflict. Lijsten
   * met id's (werkstappen, materialen) per regel en per veld.
   * Geeft { value, conflicts: [paden] }.
   */
  function merge3(base, mine, theirs, at = '') {
    if (same(mine, theirs)) return { value: mine, conflicts: [] };
    if (same(mine, base)) return { value: theirs, conflicts: [] };
    if (same(theirs, base)) return { value: mine, conflicts: [] };
    if (isPlainObject(mine) && isPlainObject(theirs)) {
      const b = isPlainObject(base) ? base : {};
      const value = {};
      const conflicts = [];
      for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
        const r = merge3(b[k], mine[k], theirs[k], at ? `${at}.${k}` : k);
        if (r.value !== undefined) value[k] = r.value;
        conflicts.push(...r.conflicts);
      }
      return { value, conflicts };
    }
    if (byId(mine) && byId(theirs) && (base === undefined || byId(base))) {
      const index = (list) => new Map((list || []).map((x) => [x.id, x]));
      const B = index(base), M = index(mine), T = index(theirs);
      const conflicts = [];
      const out = [];
      const take = (id) => {
        const b = B.get(id), m = M.get(id), t = T.get(id);
        const path = `${at}[${id}]`;
        if (m && t) { const r = merge3(b, m, t, path); conflicts.push(...r.conflicts); return r.value; }
        if (!m && !t) return undefined;
        // Weggehaald aan de ene kant: weg, tenzij de andere kant hem wijzigde.
        if (!m) { if (b && !same(b, t)) conflicts.push(path); return b ? undefined : t; }
        if (b && !same(b, m)) conflicts.push(path);
        return b ? undefined : m;
      };
      // Volgorde van de ander aanhouden; nieuwe regels van mij op hun plek erachter.
      const ids = [...T.keys()];
      mine.forEach((x, i) => {
        if (T.has(x.id) || B.has(x.id)) return;
        const prev = i > 0 ? ids.indexOf(mine[i - 1].id) : -1;
        ids.splice(prev + 1, 0, x.id);
      });
      for (const id of ids) {
        const v = take(id);
        if (v !== undefined) out.push(v);
      }
      for (const id of M.keys()) if (!ids.includes(id)) { const v = take(id); if (v !== undefined) out.push(v); }
      return { value: out, conflicts };
    }
    return { value: mine, conflicts: [at || '(geheel)'] };
  }

  /**
   * Botsende wijziging (body van de wachtrij) samenvoegen met de huidige
   * versie op de server. Alleen de velden uit de body tellen. Geeft
   * { body (tekst), conflicts } of null als het niet kan.
   */
  function rebaseBody(body, baseDoc, current) {
    const mine = parseJson(body);
    if (!isPlainObject(mine) || !isPlainObject(baseDoc) || !isPlainObject(current)) return null;
    const out = {};
    const conflicts = [];
    for (const k of Object.keys(mine)) {
      const r = merge3(baseDoc[k], mine[k], current[k], k);
      out[k] = r.value;
      conflicts.push(...r.conflicts);
    }
    return { body: JSON.stringify(out), conflicts };
  }

  /** Alleen de koppen die de wachtrij bewaart (kleine letters). */
  function keepHeaders(get) {
    const out = {};
    const ct = get('content-type');
    if (ct) out['content-type'] = ct;
    const base = get(HEADERS.base);
    if (base && base.length <= 64) out[HEADERS.ifBase] = base;
    return out;
  }

  function newId() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Namen van velden voor de melding bij een conflict.
  const FIELDS = {
    status: 'status', assigneeId: 'uitvoerder', title: 'omschrijving', customer: 'klantgegevens', plannedDate: 'datum',
    startTime: 'begintijd', endTime: 'eindtijd', days: 'werkdagen', crew: 'ploeg', instructions: 'werkinstructies',
    siteNotes: 'bijzonderheden locatie', steps: 'werkstappen', materials: 'materialen', report: 'oplevering',
    zones: 'zone-indeling', caption: 'bijschrift', kind: 'fase', customerVisible: 'zichtbaar voor de klant',
  };
  /** Conflictpaden ('data.steps[s1].done') als korte tekst: 'werkstappen'. */
  function fieldNames(paths) {
    const names = [];
    for (const p of paths || []) {
      const segs = String(p).split(/[.[]/).filter((x) => x && x !== 'data');
      const name = FIELDS[segs[0]] || segs[0] || 'gegevens';
      if (!names.includes(name)) names.push(name);
    }
    return names;
  }

  /** Korte omschrijving voor de gebruiker als er geen label is meegegeven. */
  function describe(item) {
    if (item.label) return item.label;
    const m = String(item.url || '').match(/api\/([a-z-]+)/);
    return `${item.method} ${m ? m[1] : 'wijziging'}`;
  }

  return {
    HEADERS, CACHEABLE, cacheable, DATA_MAX_AGE_MS, QUEUE_MAX_AGE_MS, MAX_ATTEMPTS,
    ownerOf, offlineAllowed, unreachable, classify, merge, rebase, merge3, rebaseBody, fieldNames, applyPatch, keepHeaders, newId, describe, parseJson,
  };
});
