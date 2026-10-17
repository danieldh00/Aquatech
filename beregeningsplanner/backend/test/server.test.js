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
    for (const p of ['/', '/js/app.js', '/een/pad']) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 401, p);
      const html = await res.text();
      assert.match(html, /Toegangscode/);
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
      assert.match(await res.text(), /Beregeningsplanner/);
    }
    const css = await fetch(`${base}/css/app.css`, { headers: { cookie: ok.cookie } });
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
    assert.match(await res.text(), /Beregeningsplanner/);
    assert.strictEqual((await fetch(`${base}/js/app.js`)).status, 200);
    const { res: login409 } = await login(base, '');
    assert.strictEqual(login409.status, 409);
  } finally {
    server.close();
  }
});

test('alle scripts en stylesheets uit index.html bestaan en zijn relatief', () => {
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `${ref} moet relatief zijn (ingress)`);
    assert.ok(!/^https?:/.test(ref), `${ref} moet lokaal zijn (offline/ingress)`);
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, ref)), `${ref} ontbreekt`);
  }
});
