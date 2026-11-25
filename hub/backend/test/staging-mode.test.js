// Stagingmodus (AQUATECH_STAGING=1): noindex-kop en de kop die de stagingbalk toont; zonder de schakelaar niets extra's.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { listen } = require('./helpers/http-client');

/**
 * Start een app met de gegeven omgevingsvariabelen en vraagt de gezondheidscontrole op.
 * @param {object} env Omgevingsvariabelen voor createApp.
 * @returns {Promise<Response>} Het antwoord van /api/health.
 */
async function healthWith(env) {
  const { server, base } = await listen(createApp({ db: openDb(), env, secret: 'a'.repeat(64) }));
  try {
    return await fetch(`${base}/api/health`);
  } finally {
    server.close();
  }
}

test('stagingmodus zet noindex en de stagingkop', async () => {
  const response = await healthWith({ AQUATECH_STAGING: '1' });
  assert.strictEqual(response.headers.get('X-Aquatech-Staging'), '1');
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
});

test('zonder stagingmodus geen extra koppen', async () => {
  const response = await healthWith({});
  assert.strictEqual(response.headers.get('X-Aquatech-Staging'), null);
  assert.strictEqual(response.headers.get('X-Robots-Tag'), null);
});

test('de staging-compose zet de stagingschakelaar voor de app', () => {
  const compose = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'deploy', 'staging', 'compose.yml'), 'utf8');
  assert.match(compose, /^\s*- AQUATECH_STAGING=1\s*$/m);
});
