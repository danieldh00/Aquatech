// Algemene bovengrens op schrijfacties via de API: na het maximum volgt 429, lezen en openbare routes blijven buiten de telling.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { listen } = require('./helpers/http-client');

const SECRET = 'x'.repeat(64);

test('schrijfacties via de API krijgen na het maximum een 429, lezen niet', async () => {
  const { server, base } = await listen(createApp({ accessCode: 'Geheim-Code-2026', secret: SECRET, env: { API_WRITE_LIMIT: '3' } }));
  try {
    /**
     * Een schrijfverzoek naar een route die niet bestaat (telt wel mee voor de limiet).
     * @returns {Promise<Response>} Het antwoord.
     */
    const post = () => fetch(`${base}/app/api/bestaat-niet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (let attempt = 0; attempt < 3; attempt += 1) assert.notEqual((await post()).status, 429);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.notEqual((await fetch(`${base}/app/api/health`)).status, 429);
  } finally { server.close(); }
});
