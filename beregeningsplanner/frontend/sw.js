// Service worker: de app werkt op locatie ook zonder verbinding (installateurs).
// Geregistreerd door shared/common.js als `sw.js?v=<versie>`; een nieuwe versie
// van de app is dus een nieuwe service worker die de oude caches opruimt.
//
// - Pagina's en hun scripts/stylesheets (geen gegevens) in de cache
//   'aquatech-shell-<versie>': pagina's eerst van de server, bestanden met
//   ?v=<versie> eerst uit de cache.
// - Gegevens (alleen de lijst in offline-core.js, alleen voor een eigen account
//   met het recht werkorders) in 'aquatech-data': eerst van de server, zonder
//   verbinding uit de cache. Bij uitloggen, een andere gebruiker of omgeving,
//   of een verlopen sessie wordt die cache gewist; na 14 dagen vervalt een item.
// - Wijzigingen met de kop X-Aquatech-Offline gaan zonder verbinding in een
//   wachtrij (IndexedDB 'aquatech-offline') en worden verstuurd zodra het weer
//   kan: bij het openen van een pagina, bij 'online', via Background Sync waar
//   de browser dat kent en elke 30 s zolang er iets wacht (shared/offline.js).
/* eslint-env serviceworker */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
importScripts(`shared/offline-core.js?v=${encodeURIComponent(VERSION)}`);
const Core = self.AquatechOfflineCore;
const HEADERS = Core.HEADERS;

const SHELL = `aquatech-shell-${VERSION}`;
const DATA = 'aquatech-data';
const ROOT = new URL('./', self.location.href).pathname;
// Pagina's die een installateur offline nodig heeft; hun scripts en
// stylesheets komen mee (uit de HTML gelezen).
const PRECACHE_PAGES = ['', 'werkorders/'];
// Grote bibliotheken (OCR, pdf.js, Excel) horen niet in de offline cache.
const NO_CACHE = /(^|\/)vendor\/|\.(traineddata(\.gz)?|wasm|map)$/i;
const STATIC = /\.(css|js|png|jpe?g|svg|webp|ico|woff2?|json)$/i;

// ---------- IndexedDB: wachtrij en eigenaar ----------
let dbPromise = null;
/**
 * Opent (eenmalig) de IndexedDB-database met de wachtrij en de eigenaar.
 * @returns {Promise<IDBDatabase>} de geopende database
 */
function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('aquatech-offline', 1);
      /**
       * Maakt bij de eerste keer de objectstores 'queue' en 'meta' aan.
       */
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('queue')) database.createObjectStore('queue', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
      };
      /**
       * Geeft de geopende database door.
       */
      request.onsuccess = () => { resolve(request.result); };
      /**
       * Meldt de fout; een volgende aanroep probeert opnieuw.
       */
      request.onerror = () => { dbPromise = null; reject(request.error); };
    });
  }
  return dbPromise;
}
/**
 * Voert werk uit binnen één IndexedDB-transactie op een objectstore.
 * @param {string} storeName 'queue' of 'meta'
 * @param {IDBTransactionMode} mode 'readonly' of 'readwrite'
 * @param {function(IDBObjectStore): *} work krijgt de objectstore; mag een promise teruggeven
 * @returns {Promise<*>} wat `work` opleverde, zodra de transactie klaar is
 */
async function withStore(storeName, mode, work) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const objectStore = transaction.objectStore(storeName);
    let result;
    Promise.resolve(work(objectStore)).then((value) => { result = value; });
    /**
     * Transactie klaar: het resultaat van het werk doorgeven.
     */
    transaction.oncomplete = () => { resolve(result); };
    /**
     * Transactie mislukt: de fout doorgeven.
     */
    transaction.onerror = () => { reject(transaction.error); };
    /**
     * Transactie afgebroken: de fout doorgeven.
     */
    transaction.onabort = () => { reject(transaction.error); };
  });
}
/**
 * Maakt van een IndexedDB-verzoek een promise.
 * @param {IDBRequest} request het verzoek
 * @returns {Promise<*>} het resultaat van het verzoek
 */
const requestResult = (request) => new Promise((resolve, reject) => {
  /**
   * Geeft het resultaat van het verzoek door.
   */
  request.onsuccess = () => { resolve(request.result); };
  /**
   * Geeft de fout van het verzoek door.
   */
  request.onerror = () => { reject(request.error); };
});
/**
 * Geeft alle wijzigingen in de wachtrij, in volgorde van ontstaan.
 * @returns {Promise<object[]>} de wachtrij-items
 */
const allItems = () => withStore('queue', 'readonly', (objectStore) => requestResult(objectStore.getAll())).then((list) => (list || []).sort((left, right) => left.seq - right.seq));
/**
 * Bewaart (of vervangt) een item in de wachtrij.
 * @param {object} item het wachtrij-item
 * @returns {Promise<void>}
 */
const putItem = (item) => withStore('queue', 'readwrite', (objectStore) => { objectStore.put(item); });
/**
 * Haalt een item uit de wachtrij.
 * @param {string} id id van het item
 * @returns {Promise<void>}
 */
const deleteItem = (id) => withStore('queue', 'readwrite', (objectStore) => { objectStore.delete(id); });
/**
 * Maakt de hele wachtrij leeg.
 * @returns {Promise<void>}
 */
const clearQueue = () => withStore('queue', 'readwrite', (objectStore) => { objectStore.clear(); });
/**
 * Leest een waarde uit de meta-opslag.
 * @param {string} key sleutel (bijv. 'identity')
 * @returns {Promise<*>} de bewaarde waarde
 */
const getMeta = (key) => withStore('meta', 'readonly', (objectStore) => requestResult(objectStore.get(key)));
/**
 * Schrijft een waarde in de meta-opslag; undefined wist de sleutel.
 * @param {string} key sleutel
 * @param {*} value waarde, of undefined om te wissen
 * @returns {Promise<void>}
 */
const setMeta = (key, value) => withStore('meta', 'readwrite', (objectStore) => { if (value === undefined) objectStore.delete(key); else objectStore.put(value, key); });

// Wie er nu is ingelogd (uit api/me), in het geheugen en in IndexedDB.
let identity = null; // { owner, allowed }
/**
 * Geeft wie er nu is ingelogd (uit het geheugen of IndexedDB).
 * @returns {Promise<{owner: (string|null), allowed: boolean}>} eigenaar en of offline mag
 */
async function currentIdentity() {
  if (!identity) identity = (await getMeta('identity').catch(() => null)) || { owner: null, allowed: false };
  return identity;
}
/**
 * Legt vast wie er is ingelogd. Bij een andere gebruiker (of omgeving)
 * worden de gegevens en de wachtrij van de vorige gewist.
 * @param {{owner: (string|null), allowed: boolean}} next de nieuwe identiteit
 * @returns {Promise<void>}
 */
async function setIdentity(next) {
  const previous = await currentIdentity();
  if (previous.owner !== next.owner) {
    // Andere gebruiker of omgeving (of uitgelogd): niets van de vorige
    // gebruiker blijft zichtbaar. Een ingelogde andere gebruiker wist ook de
    // wachtrij van de vorige (die kan hij niet versturen en mag hij niet zien).
    await caches.delete(DATA);
    if (next.owner) {
      const items = await allItems();
      for (const item of items) if (item.owner !== next.owner) await deleteItem(item.id);
    }
  }
  if (!next.allowed) await caches.delete(DATA);
  identity = next;
  await setMeta('identity', next);
  if (previous.owner !== next.owner || previous.allowed !== next.allowed) broadcast({ type: 'status', status: await status() });
}

/**
 * Wist alles (bij uitloggen): gegevens, wachtrij en eigenaar.
 * @returns {Promise<void>}
 */
async function wipe() {
  await caches.delete(DATA);
  await clearQueue().catch(() => {});
  identity = { owner: null, allowed: false };
  await setMeta('identity', identity).catch(() => {});
  await setMeta('needsLogin', undefined).catch(() => {});
  broadcast({ type: 'status', status: await status() });
}

// ---------- Hulpjes ----------
/**
 * Geeft het pad van een adres relatief aan de map van de app.
 * @param {string} url volledig adres
 * @returns {string|null} pad met querystring zonder de app-map, of null als het adres buiten de app valt
 */
const relativePath = (url) => {
  const parsed = new URL(url);
  return parsed.pathname.startsWith(ROOT) ? parsed.pathname.slice(ROOT.length) + parsed.search : null;
};
/**
 * Maakt een JSON-antwoord dat niet gecachet wordt.
 * @param {object} body de inhoud
 * @param {number} status HTTP-status (standaard 200)
 * @param {object} extraHeaders extra koppen
 * @returns {Response} het antwoord
 */
const jsonResponse = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
/**
 * Zegt of de server vraagt een antwoord niet te bewaren.
 * @param {Response} res het antwoord
 * @returns {boolean} true bij Cache-Control: no-store
 */
const noStore = (res) => /no-store/i.test(res.headers.get('Cache-Control') || '');
/**
 * Maakt een kopie van een antwoord met het tijdstip van bewaren in een kop.
 * @param {Response} res het antwoord van de server
 * @returns {Promise<Response>} kopie met de kop `cachedAt`
 */
async function stamp(res) {
  const headers = new Headers(res.headers);
  headers.set(HEADERS.cachedAt, new Date().toISOString());
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
}
/**
 * Stuurt een bericht naar alle open vensters van de app.
 * @param {object} message het bericht (bijv. { type: 'status', status })
 * @returns {Promise<void>}
 */
async function broadcast(message) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of list) client.postMessage(message);
}

// ---------- Installeren en opruimen ----------
/**
 * Zet de pagina's uit PRECACHE_PAGES en hun scripts, stylesheets en
 * afbeeldingen in de cache.
 * @returns {Promise<void>}
 */
async function precache() {
  const cache = await caches.open(SHELL);
  for (const page of PRECACHE_PAGES) {
    try {
      const url = new URL(page, self.registration.scope).href;
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok || noStore(res) || !/text\/html/.test(res.headers.get('Content-Type') || '')) continue;
      const html = await res.clone().text();
      await cache.put(url, res);
      const assets = new Set();
      for (const match of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"#:]+\.(?:css|js)\?v=[^"]+)"/g)) assets.add(new URL(match[1], url).href);
      for (const match of html.matchAll(/<img\b[^>]*?\bsrc="([^"#:?]+\.png)"/g)) assets.add(new URL(match[1], url).href);
      await Promise.all([...assets].map(async (assetUrl) => {
        if (await cache.match(assetUrl)) return;
        const assetResponse = await fetch(assetUrl, { credentials: 'same-origin' }).catch(() => null);
        if (assetResponse && assetResponse.ok && !noStore(assetResponse)) await cache.put(assetUrl, assetResponse);
      }));
    } catch (error) { /* niet ingelogd of offline: later opnieuw */ }
  }
  await setMeta('precached', VERSION).catch(() => {});
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const cacheName of await caches.keys()) if (cacheName.startsWith('aquatech-shell-') && cacheName !== SHELL) await caches.delete(cacheName);
    await expire();
    await self.clients.claim();
  })());
});

/**
 * Ruimt verlopen gegevens en te oude wijzigingen in de wachtrij op.
 * @returns {Promise<void>}
 */
async function expire() {
  const cache = await caches.open(DATA);
  const now = Date.now();
  for (const request of await cache.keys()) {
    const res = await cache.match(request);
    const cachedAt = res && Date.parse(res.headers.get(HEADERS.cachedAt) || '');
    if (!cachedAt || now - cachedAt > Core.DATA_MAX_AGE_MS) await cache.delete(request);
  }
  for (const item of await allItems().catch(() => [])) if (now - item.createdAt > Core.QUEUE_MAX_AGE_MS) await deleteItem(item.id);
}

// ---------- Ophalen ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = relativePath(req.url);
  if (path === null) return;
  if (path.startsWith('api/')) {
    if (req.method === 'GET') {
      if (path === 'api/me') event.respondWith(handleMe(req));
      else if (Core.cacheable(path)) event.respondWith(handleData(req));
      return;
    }
    if (path === 'api/auth/logout' && req.method === 'POST') { event.respondWith(handleLogout(req)); return; }
    if (req.headers.get(HEADERS.queue)) event.respondWith(handleWrite(req, path));
    return;
  }
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') { event.respondWith(handlePage(req)); return; }
  if (STATIC.test(url.pathname) && !NO_CACHE.test(url.pathname)) event.respondWith(handleAsset(req, url));
});

/**
 * Pagina: eerst de server (verse versie), zonder verbinding de bewaarde.
 * @param {Request} req het verzoek om de pagina
 * @returns {Promise<Response>} de pagina, de bewaarde versie of een offlinepagina
 */
async function handlePage(req) {
  const key = new URL(req.url);
  key.search = '';
  key.hash = '';
  try {
    const res = await fetch(req);
    if (res.ok && !noStore(res) && /text\/html/.test(res.headers.get('Content-Type') || '')) {
      const cache = await caches.open(SHELL);
      await cache.put(key.href, res.clone());
    }
    return res;
  } catch (error) {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(key.href) || (key.pathname.endsWith('/index.html') ? null : await cache.match(new URL('index.html', key).href));
    return hit || offlinePage();
  }
}

/**
 * Maakt de pagina "Geen verbinding" voor een pagina die niet offline bewaard is.
 * @returns {Response} HTML-antwoord met status 503
 */
function offlinePage() {
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Geen verbinding – AquaTech Service</title>
<style>body{font-family:Montserrat,system-ui,sans-serif;margin:0;background:#f4f6fa;color:#172f5e}main{max-width:32rem;margin:15vh auto;padding:1.5rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}a{display:inline-block;margin:.75rem .75rem 0 0;padding:.6rem 1rem;border-radius:8px;background:#19924f;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>Geen verbinding</h1><p>Deze pagina is nog niet offline beschikbaar. Je werkorders en het startscherm werken wel zonder verbinding, als je ze eerder met verbinding hebt geopend.</p><a href="${ROOT}">Overzicht</a><a href="${ROOT}werkorders/">Werkorders</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * Script, stylesheet, afbeelding: wat de server onveranderlijk noemt
 * (?v=<versie>, immutable) eerst uit de cache, de rest (zoals het
 * kleurthema) eerst van de server.
 * @param {Request} req het verzoek
 * @param {URL} url het ontlede adres van het verzoek
 * @returns {Promise<Response>} het bestand
 */
async function handleAsset(req, url) {
  const cache = await caches.open(SHELL);
  const fixed = url.searchParams.get('v') === VERSION;
  if (fixed) {
    const hit = await cache.match(req);
    if (hit && /immutable/.test(hit.headers.get('Cache-Control') || '')) return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok && !noStore(res) && (fixed || !url.search)) await cache.put(req, res.clone());
    return res;
  } catch (error) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw error;
  }
}

/**
 * api/me: bepaalt van wie de offline gegevens zijn en start zo nodig het
 * vullen van de cache en het versturen van de wachtrij.
 * @param {Request} req het verzoek om api/me
 * @returns {Promise<Response>} het antwoord van de server, of offline het bewaarde
 */
async function handleMe(req) {
  try {
    const res = await fetch(req);
    if (res.status === 401) await setIdentity({ owner: null, allowed: false });
    if (!res.ok) return res;
    const body = await res.clone().json().catch(() => null);
    const next = { owner: Core.ownerOf(body), allowed: Core.offlineAllowed(body) };
    await setIdentity(next);
    if (next.allowed) {
      const cache = await caches.open(DATA);
      await cache.put(req.url, await stamp(res));
      if (await getMeta('precached') !== VERSION) precache();
    }
    await setMeta('needsLogin', undefined);
    flush();
    return res;
  } catch (error) {
    return (await fromCache(req)) || jsonResponse({ user: null, via: null, offline: true }, 200);
  }
}

/**
 * Zoekt een bewaard antwoord, alleen als offline gegevens toegestaan zijn.
 * @param {Request} req het verzoek
 * @returns {Promise<Response|null>} het bewaarde antwoord of null
 */
async function fromCache(req) {
  const current = await currentIdentity();
  if (!current.allowed) return null;
  const cache = await caches.open(DATA);
  return (await cache.match(req.url)) || null;
}

/**
 * Gegevens: eerst de server, zonder verbinding (of server onbereikbaar) de cache.
 * @param {Request} req het GET-verzoek
 * @returns {Promise<Response>} antwoord van de server, uit de cache of een 503
 */
async function handleData(req) {
  try {
    const res = await fetch(req);
    if (Core.unreachable(res.status)) {
      const hit = await fromCache(req);
      if (hit) return hit;
    }
    if (res.status === 401) await setIdentity({ owner: null, allowed: false });
    if (res.ok && (await currentIdentity()).allowed) {
      const cache = await caches.open(DATA);
      await cache.put(req.url, await stamp(res));
    }
    return res;
  } catch (error) {
    return (await fromCache(req)) || jsonResponse({ error: 'offline', message: 'Geen verbinding, en deze gegevens zijn nog niet offline beschikbaar.' }, 503);
  }
}

/**
 * Uitloggen: doorsturen naar de server en daarna altijd alles wissen.
 * @param {Request} req het uitlogverzoek
 * @returns {Promise<Response>} antwoord van de server, of offline { ok: true }
 */
async function handleLogout(req) {
  try {
    return await fetch(req);
  } catch (error) {
    return jsonResponse({ ok: true, offline: true });
  } finally {
    await wipe();
  }
}

// ---------- Wijzigingen en de wachtrij ----------
const inFlight = new Set();

/**
 * Maakt een wachtrij-item van een schrijvend verzoek.
 * @param {Request} req het verzoek
 * @param {string} path pad relatief aan de app
 * @param {string} owner eigenaar (gebruiker + omgeving)
 * @returns {Promise<object>} het wachtrij-item
 */
async function itemFrom(req, path, owner) {
  const label = req.headers.get(HEADERS.label);
  let decoded = '';
  try { decoded = label ? decodeURIComponent(label).slice(0, 200) : ''; } catch (error) { decoded = ''; }
  return {
    id: Core.newId(),
    seq: Date.now() + Math.random(),
    createdAt: Date.now(),
    owner,
    url: path,
    method: req.method,
    headers: Core.keepHeaders((headerName) => req.headers.get(headerName)),
    body: ['GET', 'HEAD'].includes(req.method) ? null : await req.clone().text(),
    key: (req.headers.get(HEADERS.key) || '').slice(0, 200) || null,
    patch: req.headers.get(HEADERS.patch) === 'merge',
    label: decoded,
    idem: Core.newId(),
    attempts: 0,
    state: 'pending',
    error: null,
  };
}

/**
 * Verstuurt een wachtrij-item naar de server.
 * @param {object} item het wachtrij-item
 * @param {object} extraHeaders extra koppen
 * @param {boolean} check de basis meesturen als controle (alleen vanuit de wachtrij)
 * @returns {Promise<Response>} het antwoord van de server
 */
function send(item, extraHeaders = {}, check = true) {
  const headers = { ...item.headers, [HEADERS.idempotency]: item.idem, ...extraHeaders };
  if (!check) delete headers[HEADERS.ifBase];
  return fetch(new URL(item.url, self.registration.scope).href, { method: item.method, headers, body: item.body, credentials: 'same-origin', cache: 'no-store' });
}

/**
 * Schrijvend verzoek dat offline mag: direct versturen, en zonder verbinding
 * in de wachtrij zetten (samengevoegd met een wachtende wijziging met dezelfde sleutel).
 * @param {Request} req het verzoek
 * @param {string} path pad relatief aan de app
 * @returns {Promise<Response>} antwoord van de server, of 202 { queued } als het in de wachtrij staat
 */
async function handleWrite(req, path) {
  const current = await currentIdentity();
  if (!current.owner || !current.allowed) return fetch(req);
  const item = await itemFrom(req, path, current.owner);
  const pending = item.key ? (await allItems()).find((candidate) => candidate.key === item.key && candidate.owner === current.owner && candidate.state === 'pending' && !inFlight.has(candidate.id)) : null;
  if (!pending) {
    try {
      // Direct versturen; de basis gaat alleen mee als controle als het via de wachtrij loopt.
      const res = await send(item, {}, false);
      if (!Core.unreachable(res.status)) {
        if (res.ok && item.patch) await keepResponse(item, res.clone());
        return res;
      }
    } catch (error) { /* geen verbinding: in de wachtrij */ }
  }
  // De versie waarop de wijziging voortbouwt (voor samenvoegen bij een conflict).
  if (item.patch && !pending) item.baseDoc = await cachedJson(item.url);
  const queued = pending ? Core.merge(pending, item) : item;
  await putItem(queued);
  if (item.patch) await patchCache(queued);
  if (self.registration.sync) self.registration.sync.register('aquatech-queue').catch(() => {});
  const queueStatus = await status();
  broadcast({ type: 'status', status: queueStatus });
  return jsonResponse({ queued: true, id: queued.id, pending: queueStatus.pending }, 202);
}

/**
 * Leest de bewaarde JSON van een adres uit de gegevenscache.
 * @param {string} url pad relatief aan de app
 * @returns {Promise<object|null>} de bewaarde gegevens of null
 */
async function cachedJson(url) {
  const hit = await (await caches.open(DATA)).match(new URL(url, self.registration.scope).href);
  return hit ? hit.clone().json().catch(() => null) : null;
}

/**
 * Conflict: de huidige versie ophalen en de wijziging er per veld overheen
 * leggen (offline-core merge3). Lukt dat zonder echte botsing, dan opnieuw
 * versturen op de nieuwe basis; anders beslist de gebruiker.
 * @param {object} item het wachtrij-item met `baseDoc`
 * @returns {Promise<{item: object, conflicts: string[]}|null>} het bijgewerkte item en de botsende velden, of null als samenvoegen niet kan
 */
async function autoMerge(item) {
  if (!item.patch || !item.baseDoc || item.merged >= 3) return null;
  const res = await fetch(new URL(item.url, self.registration.scope).href, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const current = await res.json().catch(() => null);
  const rebased = Core.rebaseBody(item.body, item.baseDoc, current);
  if (!rebased || !current.updatedAt) return null;
  return { item: { ...item, body: rebased.body, baseDoc: current, merged: (item.merged || 0) + 1, headers: { ...item.headers, [HEADERS.ifBase]: current.updatedAt }, idem: Core.newId() }, conflicts: rebased.conflicts };
}

/**
 * Werkt de bewaarde GET van hetzelfde adres bij met de wachtende wijziging.
 * @param {object} item het wachtrij-item (met patch)
 * @returns {Promise<void>}
 */
async function patchCache(item) {
  const cache = await caches.open(DATA);
  const url = new URL(item.url, self.registration.scope).href;
  const hit = await cache.match(url);
  if (!hit) return;
  const resource = await hit.clone().json().catch(() => null);
  const next = Core.applyPatch(resource, item.body);
  const headers = new Headers(hit.headers);
  await cache.put(url, new Response(JSON.stringify(next), { status: 200, headers }));
}

/**
 * Bewaart het antwoord op een verstuurde wijziging als nieuwe versie van dat adres.
 * @param {object} item het verstuurde wachtrij-item
 * @param {Response} res het antwoord van de server
 * @returns {Promise<void>}
 */
async function keepResponse(item, res) {
  if (!(await currentIdentity()).allowed) return;
  const cache = await caches.open(DATA);
  await cache.put(new URL(item.url, self.registration.scope).href, await stamp(res));
}

let flushing = null;
/**
 * Verstuurt de wachtrij; loopt er al een ronde, dan wordt die hergebruikt.
 * @returns {Promise<void>} klaar als de ronde klaar is
 */
function flush() {
  if (!flushing) flushing = doFlush().catch(() => {}).finally(() => { flushing = null; });
  return flushing;
}

/**
 * Verstuurt de wachtende wijzigingen van de huidige gebruiker één voor één
 * en verwerkt per antwoord: klaar, opnieuw proberen, inloggen of conflict.
 * @returns {Promise<void>}
 */
async function doFlush() {
  const current = await currentIdentity();
  if (!current.owner) return;
  let sent = 0;
  for (;;) {
    const items = await allItems();
    const item = items.find((candidate) => candidate.owner === current.owner && candidate.state === 'pending');
    if (!item) break;
    inFlight.add(item.id);
    let res;
    try {
      res = await send(item, { [HEADERS.queued]: '1' });
    } catch (error) {
      inFlight.delete(item.id);
      break; // nog steeds geen verbinding
    }
    const body = await res.clone().json().catch(() => ({}));
    const verdict = Core.classify(res.status, body);
    inFlight.delete(item.id);
    if (verdict === 'done') {
      await deleteItem(item.id);
      for (const rebasedItem of Core.rebase(items, item, body)) await putItem(rebasedItem);
      if (item.patch) await keepResponse(item, res.clone());
      sent++;
      broadcast({ type: 'synced', item: summary(item), status: res.status, body });
      continue;
    }
    if (verdict === 'retry') {
      item.attempts++;
      if (item.attempts >= Core.MAX_ATTEMPTS && !Core.unreachable(res.status)) Object.assign(item, { state: 'failed', error: body.message || `HTTP ${res.status}` });
      await putItem(item);
      break;
    }
    if (verdict === 'auth') {
      await setMeta('needsLogin', true);
      break;
    }
    if (verdict === 'conflict') {
      const mergeResult = await autoMerge(item);
      if (mergeResult && !mergeResult.conflicts.length) { await putItem(mergeResult.item); continue; }
      if (mergeResult) Object.assign(item, { conflicts: mergeResult.conflicts.slice(0, 20) });
    }
    Object.assign(item, { state: verdict, error: body.message || `HTTP ${res.status}` });
    await putItem(item);
  }
  broadcast({ type: 'status', status: await status(), sent });
}

/**
 * Geeft de gegevens van een wachtrij-item die een pagina mag zien.
 * @param {object} item het wachtrij-item
 * @param {boolean} full true om ook de inhoud (body) mee te geven
 * @returns {object} samenvatting van het item
 */
function summary(item, full = false) {
  const result = { id: item.id, url: item.url, method: item.method, key: item.key, label: Core.describe(item), state: item.state, error: item.error, conflicts: item.conflicts || [], createdAt: item.createdAt, attempts: item.attempts };
  if (full) result.body = item.body;
  return result;
}

/**
 * Geeft de stand van de offline-functie voor de huidige gebruiker.
 * @returns {Promise<object>} versie, of offline mag, aantal wachtend/problemen, inloggen nodig en de items
 */
async function status() {
  const current = await currentIdentity();
  const items = current.owner ? (await allItems().catch(() => [])).filter((item) => item.owner === current.owner) : [];
  return {
    version: VERSION,
    allowed: Boolean(current.allowed),
    pending: items.filter((item) => item.state === 'pending').length,
    problems: items.filter((item) => item.state !== 'pending').length,
    needsLogin: Boolean(await getMeta('needsLogin').catch(() => false)),
    items: items.map((item) => summary(item)),
  };
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'aquatech-queue') event.waitUntil(flush());
});

// Berichten van de pagina's (shared/offline.js en common.js).
self.addEventListener('message', (event) => {
  const message = event.data || {};
  /**
   * Stuurt het antwoord terug via de meegegeven poort.
   * @param {object} value het antwoord
   */
  const reply = (value) => { if (event.ports && event.ports[0]) event.ports[0].postMessage(value); };
  event.waitUntil((async () => {
    try {
      if (message.type === 'status') return reply(await status());
      if (message.type === 'flush') { await flush(); return reply(await status()); }
      if (message.type === 'list') {
        const current = await currentIdentity();
        const items = (await allItems()).filter((item) => item.owner === current.owner && (!message.prefix || item.url.startsWith(message.prefix)) && (!message.method || item.method === message.method));
        return reply({ items: items.map((item) => summary(item, true)) });
      }
      if (message.type === 'retry' || message.type === 'discard') {
        const current = await currentIdentity();
        const item = (await allItems()).find((candidate) => candidate.id === message.id && candidate.owner === current.owner);
        if (item && message.type === 'discard') {
          await deleteItem(item.id);
          // De bewaarde versie bevat de weggegooide wijziging: opnieuw ophalen.
          if (item.patch) await (await caches.open(DATA)).delete(new URL(item.url, self.registration.scope).href);
        }
        if (item && message.type === 'retry') {
          // `force`: toch versturen, zonder controle op wijzigingen van anderen.
          if (message.force) delete item.headers[HEADERS.ifBase];
          Object.assign(item, { state: 'pending', error: null, conflicts: [], attempts: 0, idem: Core.newId() });
          await putItem(item);
        }
        await flush();
        return reply(await status());
      }
      if (message.type === 'wipe') { await wipe(); return reply({ ok: true }); }
      reply({ error: 'unknown' });
    } catch (error) {
      reply({ error: String(error && error.message || error) });
    }
  })());
});
