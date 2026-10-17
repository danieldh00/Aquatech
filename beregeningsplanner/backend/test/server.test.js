const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp, FRONTEND_DIR } = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    const server = createApp().listen(0, () => resolve(server));
  });
}

test('health geeft ok en versie', async () => {
  const server = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.version);
  } finally {
    server.close();
  }
});

test('serveert de planner, ook onder een ingress-pad', async () => {
  const server = await listen();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of ['/', '/een/willekeurig/pad']) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /Beregeningsplanner/);
    }
    const css = await fetch(`${base}/css/app.css`);
    assert.strictEqual(css.status, 200);
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
