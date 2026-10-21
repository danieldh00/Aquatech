// Databasequeries: hoeveel queries een verzoek kost en hoeveel er uit de
// database komt. Met PostgreSQL (Supabase) is elke query een rondgang over
// het netwerk; deze test bewaakt dat de lichte paden licht blijven.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const SECRET = 'q'.repeat(64);
const PASSWORD = 'Tuin-Plan-2026!';

// Telt queries en de omvang van wat ze teruggeven (alle tekst in de rijen).
function instrument(db) {
  const stats = { queries: 0, bytes: 0, sql: [] };
  const size = (v) => (v == null ? 0 : Array.isArray(v) ? v.reduce((a, r) => a + size(r), 0)
    : typeof v === 'object' ? Object.values(v).reduce((a, x) => a + (x == null ? 0 : String(x).length), 0) : 0);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prepare(sql);
    const wrap = (fn) => (...args) => {
      const r = st[fn](...args);
      stats.queries++;
      stats.bytes += size(r);
      stats.sql.push(sql.replace(/\s+/g, ' ').slice(0, 80));
      return r;
    };
    return new Proxy(st, { get: (t, p) => (['get', 'all', 'run'].includes(p) ? wrap(p) : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) });
  };
  return {
    reset() { stats.queries = 0; stats.bytes = 0; stats.sql = []; },
    get stats() { return stats; },
  };
}

function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

const plan = (extra = {}) => ({
  meta: { name: 'Tuin', customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [{ id: 's1', x: 1, y: 1, r: 4 }], zones: [], elements: [], ...extra,
});

test('queries: sessie in één query, opslaan zonder het plan terug te lezen, overzicht zonder achtergrond', async () => {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const c = client(`http://127.0.0.1:${server.address().port}`);
  try {
    assert.strictEqual((await c.post('/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    await c.get('/api/me');
    const probe = instrument(db);

    // Elk verzoek: sessie + gebruiker + tenant in één query, verder niets
    // (last_seen_at is net geschreven, het aantal beheerders is bekend).
    probe.reset();
    assert.strictEqual((await c.get('/api/account/profile')).status, 200);
    assert.strictEqual(probe.stats.queries, 1, probe.stats.sql.join('\n'));

    // Statische bestanden van een pagina: één sessiecontrole, daarna even geen query.
    probe.reset();
    for (const f of ['/shared/brand.css', '/dashboard/modules.js', '/shared/sidebar.js']) assert.strictEqual((await c.get(f)).status, 200, f);
    assert.ok(probe.stats.queries <= 1, probe.stats.sql.join('\n'));
    // Na uitloggen geen bestanden meer.
    const other = client(`http://127.0.0.1:${server.address().port}`);
    assert.strictEqual((await other.post('/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    assert.strictEqual((await other.get('/beheer/beheer.js')).status, 200);
    await other.post('/api/auth/logout');
    assert.strictEqual((await other.get('/beheer/beheer.js')).status, 401);

    // Een plan met een grote achtergrond (foto van de tekening).
    const background = { src: `data:image/png;base64,${'A'.repeat(400000)}` };
    const id = (await c.post('/api/plans', { data: plan({ background }) })).body.id;

    // Automatisch opslaan leest het plan niet terug uit de database.
    probe.reset();
    assert.strictEqual((await c.put(`/api/plans/${id}`, { data: plan({ background }) })).status, 200);
    assert.ok(probe.stats.bytes < 5000, `opslaan las ${probe.stats.bytes} tekens`);

    // Het overzicht haalt alleen de vlakken en aantallen op, niet de achtergrond of het hele plan.
    probe.reset();
    const list = (await c.get('/api/plans')).body.items;
    assert.deepStrictEqual(list[0].summary, { areas: 1, totalM2: 50, m2ByType: { lawn: 50 }, sprinklers: 1, zones: 0, elements: 0 });
    assert.ok(probe.stats.bytes < 5000, `overzicht las ${probe.stats.bytes} tekens`);
    assert.strictEqual(probe.stats.queries, 2);

    // Gebruikersbeheer stuurt nooit de wachtwoord-hash mee uit de database.
    probe.reset();
    assert.strictEqual((await c.get('/api/admin/users')).status, 200);
    assert.ok(!probe.stats.sql.some((s) => /SELECT u\.\*/.test(s)));

    // AI-kosten: vaste aantallen queries, ongeacht het aantal verzoeken
    // (sessie + totaal + per periode/gebruiker/functie/model; lijst: aantal + pagina).
    probe.reset();
    assert.strictEqual((await c.get('/api/admin/ai-usage')).status, 200);
    assert.strictEqual(probe.stats.queries, 6, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await c.get('/api/admin/ai-usage/requests')).status, 200);
    assert.strictEqual(probe.stats.queries, 3, probe.stats.sql.join('\n'));

    // Voorraad: overzicht in één query (stand + reserveringen samen), een
    // artikel in drie, ongeacht het aantal artikelen en mutaties.
    assert.strictEqual((await c.post('/api/stock/import', { codes: ['PE-25', 'PE-32', 'FIT-T-25', 'VAL-24V', 'BOX-STD'] })).status, 200);
    probe.reset();
    const stock = (await c.get('/api/stock')).body.items;
    assert.strictEqual(stock.length, 5);
    assert.strictEqual(probe.stats.queries, 2, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await c.get(`/api/stock/items/${stock[0].id}`)).status, 200);
    assert.strictEqual(probe.stats.queries, 4, probe.stats.sql.join('\n'));
    // Werkregistratie: vaste aantallen queries, ongeacht het aantal regels
    // (sessie + werkorder + uren + materiaal; urenstaat: sessie + uren + materiaal).
    const lines = [{ id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10 }];
    const qid = (await c.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen' }, lines } })).body.id;
    await c.put(`/api/quotes/${qid}`, { status: 'akkoord' });
    const wo = (await c.post('/api/workorders', { quoteId: qid })).body;
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await c.post(`/api/workorders/${wo.id}/hours`, { workDate: day, hours: 1 })).status, 201);
      assert.strictEqual((await c.post(`/api/workorders/${wo.id}/materials`, { usedOn: day, description: 'Sproeier', qty: 1 })).status, 201);
    }
    probe.reset();
    assert.strictEqual((await c.get(`/api/workorders/${wo.id}/worklog`)).status, 200);
    assert.strictEqual(probe.stats.queries, 4, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await c.get(`/api/worklog?from=${day}&to=${day}`)).status, 200);
    assert.strictEqual(probe.stats.queries, 3, probe.stats.sql.join('\n'));
    // Het werkorderoverzicht telt de geboekte uren met twee queries, niet per werkorder.
    probe.reset();
    assert.strictEqual((await c.get('/api/workorders')).body.items[0].logged.minutes, 300);
    assert.ok(probe.stats.queries <= 5, probe.stats.sql.join('\n'));
    // Facturen: overzicht en export in een vast aantal queries, ongeacht het
    // aantal facturen (geen query per factuur of regel).
    for (let i = 0; i < 4; i++) {
      const inv = (await c.post('/api/invoices', { data: { customer: { name: `Klant ${i}` }, lines: [{ description: 'Sproeier', qty: 2, price: 10 }] } })).body;
      assert.strictEqual((await c.post(`/api/invoices/${inv.id}/finalize`, {})).status, 200);
    }
    probe.reset();
    assert.strictEqual((await c.get('/api/invoices')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await c.get('/api/invoices/export')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Debiteuren met aantal facturen en openstaand bedrag: één query.
    probe.reset();
    assert.strictEqual((await c.get('/api/debtors')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Visma-status: wachtende facturen in één telling.
    probe.reset();
    assert.strictEqual((await c.get('/api/visma')).body.connected, false);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
  } finally {
    server.close();
  }
});

// Wens Daniël (2026-10-20): nergens SELECT * of t.*; elke query noemt de
// kolommen die hij nodig heeft (COUNT(*) mag).
test('queries: geen SELECT * in de backend', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/COUNT\(\*\)/gi, '');
      if (/^\s*\/\//.test(line)) return;
      if (/SELECT\s+\*|\b[a-z]\.\*(\s|,)/i.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});
