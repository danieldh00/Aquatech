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
const H = Core.HEADERS;

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
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('aquatech-offline', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const allItems = () => tx('queue', 'readonly', (s) => reqP(s.getAll())).then((list) => (list || []).sort((a, b) => a.seq - b.seq));
const putItem = (item) => tx('queue', 'readwrite', (s) => { s.put(item); });
const deleteItem = (id) => tx('queue', 'readwrite', (s) => { s.delete(id); });
const clearQueue = () => tx('queue', 'readwrite', (s) => { s.clear(); });
const getMeta = (k) => tx('meta', 'readonly', (s) => reqP(s.get(k)));
const setMeta = (k, v) => tx('meta', 'readwrite', (s) => { if (v === undefined) s.delete(k); else s.put(v, k); });

// Wie er nu is ingelogd (uit api/me), in het geheugen en in IndexedDB.
let identity = null; // { owner, allowed }
async function currentIdentity() {
  if (!identity) identity = (await getMeta('identity').catch(() => null)) || { owner: null, allowed: false };
  return identity;
}
async function setIdentity(next) {
  const prev = await currentIdentity();
  if (prev.owner !== next.owner) {
    // Andere gebruiker of omgeving (of uitgelogd): niets van de vorige
    // gebruiker blijft zichtbaar. Een ingelogde andere gebruiker wist ook de
    // wachtrij van de vorige (die kan hij niet versturen en mag hij niet zien).
    await caches.delete(DATA);
    if (next.owner) {
      const items = await allItems();
      for (const it of items) if (it.owner !== next.owner) await deleteItem(it.id);
    }
  }
  if (!next.allowed) await caches.delete(DATA);
  identity = next;
  await setMeta('identity', next);
  if (prev.owner !== next.owner || prev.allowed !== next.allowed) broadcast({ type: 'status', status: await status() });
}

// Alles wissen (uitloggen): gegevens, wachtrij en eigenaar.
async function wipe() {
  await caches.delete(DATA);
  await clearQueue().catch(() => {});
  identity = { owner: null, allowed: false };
  await setMeta('identity', identity).catch(() => {});
  await setMeta('needsLogin', undefined).catch(() => {});
  broadcast({ type: 'status', status: await status() });
}

// ---------- Hulpjes ----------
const rel = (url) => {
  const u = new URL(url);
  return u.pathname.startsWith(ROOT) ? u.pathname.slice(ROOT.length) + u.search : null;
};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const noStore = (res) => /no-store/i.test(res.headers.get('Cache-Control') || '');
async function stamp(res) {
  const headers = new Headers(res.headers);
  headers.set(H.cachedAt, new Date().toISOString());
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
}
async function broadcast(msg) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const c of list) c.postMessage(msg);
}

// ---------- Installeren en opruimen ----------
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
      for (const m of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"#:]+\.(?:css|js)\?v=[^"]+)"/g)) assets.add(new URL(m[1], url).href);
      for (const m of html.matchAll(/<img\b[^>]*?\bsrc="([^"#:?]+\.png)"/g)) assets.add(new URL(m[1], url).href);
      await Promise.all([...assets].map(async (a) => {
        if (await cache.match(a)) return;
        const r = await fetch(a, { credentials: 'same-origin' }).catch(() => null);
        if (r && r.ok && !noStore(r)) await cache.put(a, r);
      }));
    } catch (e) { /* niet ingelogd of offline: later opnieuw */ }
  }
  await setMeta('precached', VERSION).catch(() => {});
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(precache());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('aquatech-shell-') && k !== SHELL) await caches.delete(k);
    await expire();
    await self.clients.claim();
  })());
});

// Verlopen gegevens en wijzigingen opruimen.
async function expire() {
  const cache = await caches.open(DATA);
  const now = Date.now();
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const at = res && Date.parse(res.headers.get(H.cachedAt) || '');
    if (!at || now - at > Core.DATA_MAX_AGE_MS) await cache.delete(req);
  }
  for (const it of await allItems().catch(() => [])) if (now - it.createdAt > Core.QUEUE_MAX_AGE_MS) await deleteItem(it.id);
}

// ---------- Ophalen ----------
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = rel(req.url);
  if (path === null) return;
  if (path.startsWith('api/')) {
    if (req.method === 'GET') {
      if (path === 'api/me') e.respondWith(me(req));
      else if (Core.cacheable(path)) e.respondWith(data(req));
      return;
    }
    if (path === 'api/auth/logout' && req.method === 'POST') { e.respondWith(logout(req)); return; }
    if (req.headers.get(H.queue)) e.respondWith(write(req, path));
    return;
  }
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') { e.respondWith(page(req)); return; }
  if (STATIC.test(url.pathname) && !NO_CACHE.test(url.pathname)) e.respondWith(asset(req, url));
});

// Pagina: eerst de server (verse versie), zonder verbinding de bewaarde.
async function page(req) {
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
  } catch (err) {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(key.href) || (key.pathname.endsWith('/index.html') ? null : await cache.match(new URL('index.html', key).href));
    return hit || offlinePage();
  }
}

function offlinePage() {
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Geen verbinding – AquaTech Service</title>
<style>body{font-family:Montserrat,system-ui,sans-serif;margin:0;background:#f4f6fa;color:#172f5e}main{max-width:32rem;margin:15vh auto;padding:1.5rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}a{display:inline-block;margin:.75rem .75rem 0 0;padding:.6rem 1rem;border-radius:8px;background:#19924f;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>Geen verbinding</h1><p>Deze pagina is nog niet offline beschikbaar. Je werkorders en het startscherm werken wel zonder verbinding, als je ze eerder met verbinding hebt geopend.</p><a href="${ROOT}">Overzicht</a><a href="${ROOT}werkorders/">Werkorders</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Script, stylesheet, afbeelding: wat de server onveranderlijk noemt
// (?v=<versie>, immutable) eerst uit de cache, de rest (zoals het kleurthema)
// eerst van de server.
async function asset(req, url) {
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
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

// api/me: bepaalt van wie de offline gegevens zijn.
async function me(req) {
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
  } catch (err) {
    return (await fromCache(req)) || json({ user: null, via: null, offline: true }, 200);
  }
}

async function fromCache(req) {
  const id = await currentIdentity();
  if (!id.allowed) return null;
  const cache = await caches.open(DATA);
  return (await cache.match(req.url)) || null;
}

// Gegevens: eerst de server, zonder verbinding (of server onbereikbaar) de cache.
async function data(req) {
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
  } catch (err) {
    return (await fromCache(req)) || json({ error: 'offline', message: 'Geen verbinding, en deze gegevens zijn nog niet offline beschikbaar.' }, 503);
  }
}

async function logout(req) {
  try {
    return await fetch(req);
  } catch (err) {
    return json({ ok: true, offline: true });
  } finally {
    await wipe();
  }
}

// ---------- Wijzigingen en de wachtrij ----------
const inFlight = new Set();

async function itemFrom(req, path, owner) {
  const label = req.headers.get(H.label);
  let decoded = '';
  try { decoded = label ? decodeURIComponent(label).slice(0, 200) : ''; } catch (e) { decoded = ''; }
  return {
    id: Core.newId(),
    seq: Date.now() + Math.random(),
    createdAt: Date.now(),
    owner,
    url: path,
    method: req.method,
    headers: Core.keepHeaders((k) => req.headers.get(k)),
    body: ['GET', 'HEAD'].includes(req.method) ? null : await req.clone().text(),
    key: (req.headers.get(H.key) || '').slice(0, 200) || null,
    patch: req.headers.get(H.patch) === 'merge',
    label: decoded,
    idem: Core.newId(),
    attempts: 0,
    state: 'pending',
    error: null,
  };
}

// `check`: de basis meesturen als controle (alleen vanuit de wachtrij).
function send(item, extra = {}, check = true) {
  const headers = { ...item.headers, [H.idempotency]: item.idem, ...extra };
  if (!check) delete headers[H.ifBase];
  return fetch(new URL(item.url, self.registration.scope).href, { method: item.method, headers, body: item.body, credentials: 'same-origin', cache: 'no-store' });
}

async function write(req, path) {
  const id = await currentIdentity();
  if (!id.owner || !id.allowed) return fetch(req);
  const item = await itemFrom(req, path, id.owner);
  const pending = item.key ? (await allItems()).find((x) => x.key === item.key && x.owner === id.owner && x.state === 'pending' && !inFlight.has(x.id)) : null;
  if (!pending) {
    try {
      // Direct versturen; de basis gaat alleen mee als controle als het via de wachtrij loopt.
      const res = await send(item, {}, false);
      if (!Core.unreachable(res.status)) {
        if (res.ok && item.patch) await keepResponse(item, res.clone());
        return res;
      }
    } catch (err) { /* geen verbinding: in de wachtrij */ }
  }
  // De versie waarop de wijziging voortbouwt (voor samenvoegen bij een conflict).
  if (item.patch && !pending) item.baseDoc = await cachedJson(item.url);
  const queued = pending ? Core.merge(pending, item) : item;
  await putItem(queued);
  if (item.patch) await patchCache(queued);
  if (self.registration.sync) self.registration.sync.register('aquatech-queue').catch(() => {});
  const st = await status();
  broadcast({ type: 'status', status: st });
  return json({ queued: true, id: queued.id, pending: st.pending }, 202);
}

async function cachedJson(url) {
  const hit = await (await caches.open(DATA)).match(new URL(url, self.registration.scope).href);
  return hit ? hit.clone().json().catch(() => null) : null;
}

/**
 * Conflict: de huidige versie ophalen en de wijziging er per veld overheen
 * leggen (offline-core merge3). Lukt dat zonder echte botsing, dan opnieuw
 * versturen op de nieuwe basis; anders beslist de gebruiker.
 */
async function autoMerge(item) {
  if (!item.patch || !item.baseDoc || item.merged >= 3) return null;
  const res = await fetch(new URL(item.url, self.registration.scope).href, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const current = await res.json().catch(() => null);
  const out = Core.rebaseBody(item.body, item.baseDoc, current);
  if (!out || !current.updatedAt) return null;
  return { item: { ...item, body: out.body, baseDoc: current, merged: (item.merged || 0) + 1, headers: { ...item.headers, [H.ifBase]: current.updatedAt }, idem: Core.newId() }, conflicts: out.conflicts };
}

// De bewaarde GET van hetzelfde adres bijwerken met de wachtende wijziging.
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

async function keepResponse(item, res) {
  if (!(await currentIdentity()).allowed) return;
  const cache = await caches.open(DATA);
  await cache.put(new URL(item.url, self.registration.scope).href, await stamp(res));
}

let flushing = null;
function flush() {
  if (!flushing) flushing = doFlush().catch(() => {}).finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  const id = await currentIdentity();
  if (!id.owner) return;
  let sent = 0;
  for (;;) {
    const items = await allItems();
    const item = items.find((x) => x.owner === id.owner && x.state === 'pending');
    if (!item) break;
    inFlight.add(item.id);
    let res;
    try {
      res = await send(item, { [H.queued]: '1' });
    } catch (err) {
      inFlight.delete(item.id);
      break; // nog steeds geen verbinding
    }
    const body = await res.clone().json().catch(() => ({}));
    const verdict = Core.classify(res.status, body);
    inFlight.delete(item.id);
    if (verdict === 'done') {
      await deleteItem(item.id);
      for (const it of Core.rebase(items, item, body)) await putItem(it);
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
      const m = await autoMerge(item);
      if (m && !m.conflicts.length) { await putItem(m.item); continue; }
      if (m) Object.assign(item, { conflicts: m.conflicts.slice(0, 20) });
    }
    Object.assign(item, { state: verdict, error: body.message || `HTTP ${res.status}` });
    await putItem(item);
  }
  broadcast({ type: 'status', status: await status(), sent });
}

function summary(it, full = false) {
  const out = { id: it.id, url: it.url, method: it.method, key: it.key, label: Core.describe(it), state: it.state, error: it.error, conflicts: it.conflicts || [], createdAt: it.createdAt, attempts: it.attempts };
  if (full) out.body = it.body;
  return out;
}

async function status() {
  const id = await currentIdentity();
  const items = id.owner ? (await allItems().catch(() => [])).filter((x) => x.owner === id.owner) : [];
  return {
    version: VERSION,
    allowed: Boolean(id.allowed),
    pending: items.filter((x) => x.state === 'pending').length,
    problems: items.filter((x) => x.state !== 'pending').length,
    needsLogin: Boolean(await getMeta('needsLogin').catch(() => false)),
    items: items.map((x) => summary(x)),
  };
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'aquatech-queue') e.waitUntil(flush());
});

// Berichten van de pagina's (shared/offline.js en common.js).
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  const reply = (v) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(v); };
  e.waitUntil((async () => {
    try {
      if (msg.type === 'status') return reply(await status());
      if (msg.type === 'flush') { await flush(); return reply(await status()); }
      if (msg.type === 'list') {
        const id = await currentIdentity();
        const items = (await allItems()).filter((x) => x.owner === id.owner && (!msg.prefix || x.url.startsWith(msg.prefix)) && (!msg.method || x.method === msg.method));
        return reply({ items: items.map((x) => summary(x, true)) });
      }
      if (msg.type === 'retry' || msg.type === 'discard') {
        const id = await currentIdentity();
        const item = (await allItems()).find((x) => x.id === msg.id && x.owner === id.owner);
        if (item && msg.type === 'discard') {
          await deleteItem(item.id);
          // De bewaarde versie bevat de weggegooide wijziging: opnieuw ophalen.
          if (item.patch) await (await caches.open(DATA)).delete(new URL(item.url, self.registration.scope).href);
        }
        if (item && msg.type === 'retry') {
          // `force`: toch versturen, zonder controle op wijzigingen van anderen.
          if (msg.force) delete item.headers[H.ifBase];
          Object.assign(item, { state: 'pending', error: null, conflicts: [], attempts: 0, idem: Core.newId() });
          await putItem(item);
        }
        await flush();
        return reply(await status());
      }
      if (msg.type === 'wipe') { await wipe(); return reply({ ok: true }); }
      reply({ error: 'unknown' });
    } catch (err) {
      reply({ error: String(err && err.message || err) });
    }
  })());
});
