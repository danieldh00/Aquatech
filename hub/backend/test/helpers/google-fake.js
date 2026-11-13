// Nagebootste Google (OAuth + Drive v3) voor de tests van de Drive-back-up. Een echte HTTP-server op localhost, zodat ook de
// gestreamde upload (Content-Length, body) echt over een verbinding gaat. `fetchImpl` herschrijft de Google-adressen naar die server.
const http = require('node:http');

/**
 * Start de nagebootste Google.
 * @returns {Promise<{ fetchImpl: Function, close: Function, files: Map<string, object>, calls: object[], revoked: string[], revokeAll: Function, failUploads: { status: number } | null }>} fetchImpl voor createApp({ googleFetch }) of createDriveBackup({ fetchImpl }), de bestanden op "Drive", alle aanroepen en schakelaars.
 */
async function createGoogleFake() {
  const files = new Map();
  const sessions = new Map();
  const calls = [];
  const revoked = [];
  const fake = { files, calls, revoked, failUploads: null, tokenRevoked: false, nextRefreshToken: 'refresh-1' };
  let counter = 0;
  let accessCounter = 0;

  /**
   * Leest de hele inhoud van een verzoek.
   * @param {object} req Het binnenkomende verzoek.
   * @returns {Promise<Buffer>} De inhoud.
   */
  const bodyOf = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  /**
   * Stuurt een JSON-antwoord.
   * @param {object} res Het antwoord.
   * @param {number} status De status.
   * @param {object} payload De inhoud.
   * @param {object} [headers] Extra koppen.
   */
  const send = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const body = await bodyOf(req);
    calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', length: req.headers['content-length'] || '', size: body.length });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body.toString());
      if (form.get('client_secret') !== 'geheim-van-google-app') return send(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'goede-code') return send(res, 400, { error: 'invalid_grant' });
        fake.tokenRevoked = false;
        return send(res, 200, { access_token: `acc-${++accessCounter}`, ...(fake.nextRefreshToken ? { refresh_token: fake.nextRefreshToken } : {}), expires_in: 3600 });
      }
      if (fake.tokenRevoked || form.get('refresh_token') !== 'refresh-1') return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, { access_token: `acc-${++accessCounter}`, expires_in: 3600 });
    }
    if (url.pathname === '/revoke') {
      revoked.push(new URLSearchParams(body.toString()).get('token'));
      return send(res, 200, {});
    }
    // De sessie-URL van een hervatbare upload draagt zelf de toestemming: geen Authorization-kop.
    const session = /^\/upload\/session\/([^/]+)$/.exec(url.pathname);
    if (session && req.method === 'PUT') {
      const meta = sessions.get(session[1]);
      if (!meta) return send(res, 404, {});
      counter += 1;
      const file = { id: `id${counter}`, name: meta.name, parents: meta.parents, size: String(body.length), body, createdTime: new Date(Date.UTC(2026, 10, 13, 0, 0, counter)).toISOString(), seq: counter };
      files.set(file.id, file);
      return send(res, 200, { id: file.id, size: file.size });
    }
    if (fake.tokenRevoked || !/^Bearer acc-\d+$/.test(req.headers.authorization || '')) return send(res, 401, { error: { status: 'UNAUTHENTICATED' } });
    if (url.pathname === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'beheer@example.nl' } });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      let list;
      if (query.includes('application/vnd.google-apps.folder')) {
        const name = /name='((?:[^'\\]|\\.)*)'/.exec(query)?.[1].replace(/\\(.)/g, '$1');
        list = [...files.values()].filter((file) => file.folder && file.name === name && !file.trashed);
      } else {
        list = [...files.values()].filter((file) => !file.folder && file.parents.includes(parent) && !file.trashed).sort((left, right) => right.seq - left.seq);
      }
      return send(res, 200, { files: list.map(({ id, name, size, createdTime }) => ({ id, name, size, createdTime })) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse(body.toString());
      counter += 1;
      files.set(`id${counter}`, { id: `id${counter}`, name: meta.name, folder: true, parents: ['root'], seq: counter });
      return send(res, 200, { id: `id${counter}` });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const file = files.get(decodeURIComponent(one[1]));
      if (!file) return send(res, 404, { error: { status: 'NOT_FOUND' } });
      if (req.method === 'DELETE') { files.delete(file.id); res.writeHead(204); return res.end(); }
      return send(res, 200, { id: file.id, trashed: Boolean(file.trashed) });
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      if (fake.failUploads) return send(res, fake.failUploads.status, { error: { errors: [{ reason: fake.failUploads.reason || 'backendError' }] } });
      const meta = JSON.parse(body.toString());
      counter += 1;
      sessions.set(`s${counter}`, meta);
      return send(res, 200, {}, { Location: `https://www.googleapis.com/upload/session/s${counter}` });
    }
    return send(res, 404, { error: 'onbekend' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /**
   * Doet alsof dit fetch naar Google is: het adres gaat naar de nagebootste server.
   * @param {string} url Het Google-adres.
   * @param {object} [init] Fetch-opties.
   * @returns {Promise<Response>} Het antwoord.
   */
  fake.fetchImpl = (url, init) => {
    const parsed = new URL(url);
    return fetch(`${origin}${parsed.pathname}${parsed.search}`, init);
  };
  /**
   * Stopt de nagebootste server.
   * @returns {Promise<void>}
   */
  fake.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return fake;
}

module.exports = { createGoogleFake };
