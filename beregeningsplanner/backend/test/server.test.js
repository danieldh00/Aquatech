const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp, FRONTEND_DIR, versionAssets } = require('../src/server');
const PKG = require('../package.json');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const SECRET = 'x'.repeat(64);

function start(opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ accessCode: 'geheim', secret: SECRET, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Database met al een beheerder (anders verschijnt het instelscherm).
async function dbWithAdmin() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  return db;
}

async function login(base, code = 'geheim') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('health is openbaar en geeft versie', async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(`${base}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.version);
  } finally {
    server.close();
  }
});

test('zonder inlog: inlogpagina in plaats van de planner, ook voor bestanden', async () => {
  const { server, base } = await start();
  try {
    for (const p of ['/', '/beregening/', '/beregening/js/app.js', '/dashboard/modules.js', '/een/pad']) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 401, p);
      const html = await res.text();
      assert.match(html, /toegangscode/i);
      assert.doesNotMatch(html, /window\.App|class Editor/);
    }
  } finally {
    server.close();
  }
});

test('X-Ingress-Path (oude HA-header) geeft geen toegang', async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(`${base}/`, { headers: { 'X-Ingress-Path': '/api/hassio_ingress/abc' } });
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

test('verkeerde code faalt, juiste code geeft toegang tot de planner', async () => {
  const { server, base } = await start();
  try {
    const bad = await login(base, 'fout');
    assert.strictEqual(bad.res.status, 401);
    const ok = await login(base);
    assert.strictEqual(ok.res.status, 200);
    assert.match(ok.cookie, /^aquatech_session=/);
    for (const p of ['/', '/een/willekeurig/pad']) {
      const res = await fetch(base + p, { headers: { cookie: ok.cookie } });
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /id="modules"/);
    }
    for (const p of ['/beregening/', '/beregening/diep/pad']) {
      const res = await fetch(base + p, { headers: { cookie: ok.cookie } });
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /Beregeningsplanner/);
    }
    const css = await fetch(`${base}/beregening/css/app.css`, { headers: { cookie: ok.cookie } });
    assert.strictEqual(css.status, 200);
    // Na een update geen oude CSS/JS uit een cache: versie achter elke verwijzing
    const v = `?v=${PKG.version}`;
    for (const p of ['/beregening/', '/beregening/index.html', '/beregening/diep/pad', '/']) {
      const res = await fetch(base + p, { headers: { cookie: ok.cookie } });
      assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
      const html = await res.text();
      assert.ok(html.includes(`shared/brand.css${v}"`), p);
      assert.doesNotMatch(html, /(?:href|src)="[^"]+\.(?:css|js)"/, p);
    }
    const versioned = await fetch(`${base}/beregening/css/app.css${v}`, { headers: { cookie: ok.cookie } });
    assert.strictEqual(versioned.status, 200);
  } finally {
    server.close();
  }
});

test('andere toegangscode maakt oude cookies ongeldig', async () => {
  const a = await start();
  const { cookie } = await login(a.base);
  a.server.close();
  const b = await start({ accessCode: 'nieuw' });
  try {
    const res = await fetch(`${b.base}/`, { headers: { cookie } });
    assert.strictEqual(res.status, 401);
  } finally {
    b.server.close();
  }
});

test('gasten aan en geen code: de planner is openbaar en inloggen is niet nodig', async () => {
  const { server, base } = await start({ accessCode: '', env: { GUEST_ACCESS: 'true' }, db: await dbWithAdmin() });
  try {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /id="modules"/);
    assert.match(await (await fetch(`${base}/beregening/`)).text(), /Beregeningsplanner/);
    assert.strictEqual((await fetch(`${base}/beregening/js/app.js`)).status, 200);
    const { res: noCode } = await login(base, '');
    assert.strictEqual(noCode.status, 400);
  } finally {
    server.close();
  }
});

// Alle pagina's (dashboard + modules): scripts en stylesheets relatief en lokaal.
const PAGES = ['index.html', ...fs.readdirSync(FRONTEND_DIR)
  .filter((d) => fs.existsSync(path.join(FRONTEND_DIR, d, 'index.html')))
  .map((d) => `${d}/index.html`)];

test('alle scripts en stylesheets uit de pagina\'s bestaan en zijn relatief', () => {
  assert.ok(PAGES.includes('beregening/index.html'));
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(FRONTEND_DIR, page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 2, page);
    for (const ref of refs) {
      assert.ok(!ref.startsWith('/'), `${page}: ${ref} moet relatief zijn (padprefix achter een proxy)`);
      assert.ok(!/^https?:/.test(ref), `${page}: ${ref} moet lokaal zijn (offline, geen CDN)`);
      assert.ok(fs.existsSync(path.join(FRONTEND_DIR, path.dirname(page), ref)), `${page}: ${ref} ontbreekt`);
    }
  }
});

test('dashboard: actieve modules wijzen relatief naar een bestaande module', () => {
  const modules = require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
  const ids = new Set();
  for (const m of modules) {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(m.id), m.id);
    assert.ok(!ids.has(m.id), `dubbele module ${m.id}`);
    ids.add(m.id);
    assert.ok(['actief', 'gepland'].includes(m.status), m.id);
    if (m.status !== 'actief') continue;
    assert.strictEqual(m.href, `${m.id}/`, `${m.id}: href relatief en met slash`);
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, m.id, 'index.html')), `${m.id}/index.html ontbreekt`);
  }
  assert.ok(modules.some((m) => m.id === 'beregening' && m.status === 'actief'));
});

test('planner heeft een relatieve link terug naar het dashboard', () => {
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'beregening', 'index.html'), 'utf8');
  assert.match(html, /href="\.\.\/"/);
});

test('module zonder slash: relatieve doorverwijzing, querystring blijft', async () => {
  const { server, base } = await start({ accessCode: '', env: { GUEST_ACCESS: 'true' }, db: await dbWithAdmin() });
  try {
    for (const [p, loc] of [['/beregening', 'beregening/'], ['/beregening?x=1', 'beregening/?x=1']]) {
      const res = await fetch(base + p, { redirect: 'manual' });
      assert.strictEqual(res.status, 302, p);
      assert.strictEqual(res.headers.get('location'), loc, p);
    }
    // Geen module: gewoon het dashboard, geen doorverwijzing.
    const res = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /id="modules"/);
  } finally {
    server.close();
  }
});

test('eerste start: instelscherm op elk pad, daarna inloggen met het nieuwe account', async () => {
  const { server, base } = await start({ accessCode: '', setupCode: 'ABCD-EFGH-JKLM' });
  try {
    for (const p of ['/', '/beregening/', '/login']) {
      const res = await fetch(base + p);
      assert.match(await res.text(), /Beheerder aanmaken/, p);
    }
    assert.deepStrictEqual(await (await fetch(`${base}/api/setup`)).json(), { required: true, codeRequired: true, codeKind: 'installatiecode' });
    const post = (body) => fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Zonder (juiste) installatiecode uit het serverlog lukt het niet.
    assert.strictEqual((await post({ username: 'daniel', displayName: 'Daniël', password: 'Tuin-Plan-2026!' })).status, 401);
    assert.strictEqual((await post({ username: 'daniel', displayName: 'Daniël', password: 'Tuin-Plan-2026!', code: 'ABCD-EFGH-JKLX' })).status, 401);
    assert.strictEqual((await post({ username: 'x', displayName: 'X', password: 'kort', code: 'abcd efgh jklm' })).status, 400);
    assert.strictEqual((await post({ username: 'daniel', displayName: 'Daniël', password: 'Wachtwoord2024!', code: 'abcd efgh jklm' })).status, 400, 'voorspelbaar wachtwoord');
    const ok = await post({ username: 'daniel', displayName: 'Daniël', password: 'Tuin-Plan-2026!', code: 'abcd efgh jklm' });
    assert.strictEqual(ok.status, 201);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.strictEqual(me.user.role, 'beheerder');
    assert.strictEqual(me.user.kind, 'account');
    assert.strictEqual((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
    // Daarna kan niemand nog een eerste beheerder aanmaken; anderen krijgen de inlogpagina.
    assert.strictEqual((await post({ username: 'indringer', displayName: 'I', password: 'Tuin-Plan-2026!', code: 'ABCD-EFGH-JKLM' })).status, 409);
    const anon = await fetch(`${base}/`);
    assert.strictEqual(anon.status, 401);
    assert.match(await anon.text(), /Gebruikersnaam/);
    assert.doesNotMatch(await (await fetch(`${base}/login`)).text(), /Beheerder aanmaken/);
  } finally {
    server.close();
  }
});

test('eerste start met toegangscode: de code is nodig om de beheerder aan te maken', async () => {
  const { server, base } = await start();
  try {
    assert.strictEqual((await (await fetch(`${base}/api/setup`)).json()).codeRequired, true);
    const post = (body) => fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await post({ username: 'daniel', password: 'Tuin-Plan-2026!', code: 'fout' })).status, 401);
    assert.strictEqual((await post({ username: 'daniel', password: 'Tuin-Plan-2026!', code: 'geheim' })).status, 201);
  } finally {
    server.close();
  }
});

test('de laatste actieve beheerder kan niet worden uitgeschakeld of gedegradeerd', async () => {
  const db = await dbWithAdmin();
  const { server, base } = await start({ db });
  try {
    const { cookie } = await login(base);
    const headers = { cookie, 'Content-Type': 'application/json' };
    const users = (await (await fetch(`${base}/api/admin/users`, { headers })).json()).items;
    const baas = users.find((u) => u.username === 'baas');
    for (const body of [{ disabled: true }, { role: 'gebruiker' }]) {
      const res = await fetch(`${base}/api/admin/users/${baas.id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
      assert.strictEqual(res.status, 409);
    }
  } finally {
    server.close();
  }
});

test('versionAssets: alleen lokale css/js, geen externe of data-URL\'s', () => {
  const html = '<link rel="stylesheet" href="css/app.css"><script src="../shared/x.js"></script>'
    + '<img src="logo.png"><a href="x.js">x</a><script src="https://cdn/x.js"></script><link href="a.css?x=1">';
  assert.strictEqual(versionAssets(html, '1.2.3'),
    '<link rel="stylesheet" href="css/app.css?v=1.2.3"><script src="../shared/x.js?v=1.2.3"></script>'
    + '<img src="logo.png"><a href="x.js">x</a><script src="https://cdn/x.js"></script><link href="a.css?x=1">');
});

test('zijbalk: alleen voor beheerders, op elke modulepagina, met de juiste modules', () => {
  require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
  const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
  const tools = globalThis.AquatechModuleTools;
  const rights = (u) => Roles.rightsOf(u);
  assert.ok(tools.usesSidebar(rights({ role: 'beheerder' })));
  assert.ok(tools.usesSidebar(rights({ role: 'klant', platformAdmin: true })));
  assert.ok(!tools.usesSidebar(rights({ role: 'installateur' })));
  assert.ok(!tools.usesSidebar(rights({ role: 'klant' })));
  const ids = (list) => list.map((m) => m.id);
  assert.ok(ids(tools.visible(rights({ role: 'beheerder' }))).includes('beheer'));
  assert.ok(!ids(tools.visible(rights({ role: 'beheerder' }))).includes('hoofdbeheer'));
  // Uitgezette modules vallen weg, beheer blijft altijd staan.
  const off = ids(tools.visible(rights({ role: 'beheerder' }), { offertes: false, beheer: false }));
  assert.ok(!off.includes('offertes') && off.includes('beheer'));
  for (const page of PAGES.filter((p) => p !== 'openbaar/offerte.html')) {
    const html = fs.readFileSync(path.join(FRONTEND_DIR, page), 'utf8');
    const mod = html.indexOf('dashboard/modules.js');
    const nav = html.indexOf('shared/sidebar.js');
    assert.ok(nav > 0 && mod > 0 && mod < nav, `${page}: modules.js en daarna shared/sidebar.js laden`);
    assert.match(html, /shared\/sidebar\.css/, `${page}: shared/sidebar.css ontbreekt`);
  }
});
