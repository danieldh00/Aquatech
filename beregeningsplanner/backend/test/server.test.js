const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp, FRONTEND_DIR } = require('../src/server');
const { isIngress } = require('../src/auth');

const SECRET = 'x'.repeat(64);

function start(opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ accessCode: 'geheim', secret: SECRET, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
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

test('X-Ingress-Path vanaf een willekeurig IP geeft geen toegang', async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(`${base}/`, { headers: { 'X-Ingress-Path': '/api/hassio_ingress/abc' } });
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

test('ingress = header + Supervisor-IP', () => {
  const req = (ip, header) => ({ socket: { remoteAddress: ip }, headers: header ? { 'x-ingress-path': '/x' } : {} });
  assert.strictEqual(isIngress(req('172.30.32.2', true)), true);
  assert.strictEqual(isIngress(req('::ffff:172.30.32.2', true)), true);
  assert.strictEqual(isIngress(req('172.30.32.2', false)), false);
  assert.strictEqual(isIngress(req('172.30.33.5', true)), false);
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

test('zonder ingestelde code is de planner openbaar en is inloggen niet nodig', async () => {
  const { server, base } = await start({ accessCode: '' });
  try {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /id="modules"/);
    assert.match(await (await fetch(`${base}/beregening/`)).text(), /Beregeningsplanner/);
    assert.strictEqual((await fetch(`${base}/beregening/js/app.js`)).status, 200);
    const { res: login409 } = await login(base, '');
    assert.strictEqual(login409.status, 409);
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
      assert.ok(!ref.startsWith('/'), `${page}: ${ref} moet relatief zijn (ingress)`);
      assert.ok(!/^https?:/.test(ref), `${page}: ${ref} moet lokaal zijn (offline/ingress)`);
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

test('module zonder slash: relatieve doorverwijzing (ingress), querystring blijft', async () => {
  const { server, base } = await start({ accessCode: '' });
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
