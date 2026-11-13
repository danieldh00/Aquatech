// Back-ups naar Google Drive: elke versleutelde back-up (backup.js) wordt automatisch ook in een Drive-map gezet,
// met een bewaartermijn op Drive, een overzicht (status, laatste upload, fouten, bestanden) en bediening in
// Beheer > Back-ups. Het is een koppeling per installatie (alleen hoofdbeheerders), net als de back-ups zelf.
//
// - OAuth 2.0 met een eigen Google-app (client ID + secret uit de Google Cloud Console), scope `drive.file`: de app
//   ziet en wijzigt alleen bestanden en mappen die zij zelf aanmaakte, nooit de rest van de Drive.
// - Wat naar Google gaat is al versleuteld met de hoofdsleutel (AES-256-GCM): Google kan de inhoud niet lezen.
// - Instellingen: `backupDrive` (aan/uit, client ID, redirect URI, mapnaam, aantal bewaren), geheimen
//   `backupDriveClientSecret` en `backupDriveRefreshToken` (versleuteld, nooit terug naar de browser) en
//   `backupDriveState` (map-id, account, wat al op Drive staat, laatste gebeurtenissen); alles internal.
// - Uploaden gaat met een hervatbare upload (stream, ook voor grote bestanden). Een mislukte upload wordt het volgende
//   uur opnieuw geprobeerd (na een korte wachttijd); elke uitkomst komt in het overzicht, nooit een token of geheim.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CALLBACK_PATH = '/api/admin/backups/drive/callback';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const BACKUP_FILE = /^aquatech-\d{8}-\d{6}\.db\.enc$/;
const DEFAULT_FOLDER = 'AquaTech back-ups';
const TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const STATE_TTL_MS = 15 * 60 * 1000;
const RETRY_AFTER_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 36 * 3600 * 1000;
const MAX_EVENTS = 40;
const MAX_UPLOADED = 400;

/**
 * Fout van de Drive-koppeling, met een code voor de frontend en de HTTP-status.
 */
class DriveError extends Error {
  /**
   * Een fout met een leesbare melding en een code waarop de aanroeper kan reageren.
   * @param {string} code Foutcode, bijv. 'not_connected' of 'reconnect'.
   * @param {string} message Melding voor de gebruiker (nooit een token of geheim).
   * @param {number} [status] HTTP-status (standaard 502).
   * @param {Error} [cause] De onderliggende fout (alleen zichtbaar in de debugmodus).
   */
  constructor(code, message, status = 502, cause) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
    this.status = status;
  }
}

/**
 * Maakt van een waarde nette tekst: getrimd, zonder stuurtekens en ingekort.
 * @param {*} value De invoer.
 * @param {number} [maxLength] Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength = 200) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);

/**
 * Schoont de instelling backupDrive op (zonder geheimen).
 * @param {object} raw De invoer.
 * @returns {{ enabled: boolean, clientId: string, redirectUri: string, folderName: string, keepCount: number }} De instelling.
 */
function sanitizeDriveBackup(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let redirectUri = '';
  try {
    const parsed = new URL(cleanText(input.redirectUri, 300));
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.endsWith(CALLBACK_PATH)) redirectUri = `${parsed.origin}${parsed.pathname}`;
  } catch { /* leeg: het formulier stelt dan een adres voor */ }
  const keep = Number(input.keepCount);
  return {
    enabled: input.enabled === true,
    clientId: cleanText(input.clientId, 200).replace(/[^\w.:@-]/g, ''),
    redirectUri,
    folderName: cleanText(input.folderName, 100) || DEFAULT_FOLDER,
    keepCount: Number.isInteger(keep) && keep >= 1 && keep <= 365 ? keep : 30,
  };
}

/**
 * Schoont de stand van de koppeling op (map, account, geüploade bestanden en gebeurtenissen).
 * @param {object} raw De invoer.
 * @returns {object} De stand, met begrensde lijsten.
 */
function sanitizeDriveState(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /**
   * Een tijdstip als ISO-tekst.
   * @param {*} value De invoer.
   * @returns {string} ISO-tekst, of leeg als het geen datum is.
   */
  const isoOrEmpty = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : '');
  const uploaded = (Array.isArray(input.uploaded) ? input.uploaded : [])
    .filter((entry) => entry && typeof entry === 'object' && BACKUP_FILE.test(String(entry.name)))
    .slice(0, MAX_UPLOADED)
    .map((entry) => ({ name: String(entry.name), driveId: cleanText(entry.driveId, 120).replace(/[^\w-]/g, ''), size: Math.max(0, Math.floor(Number(entry.size) || 0)), at: isoOrEmpty(entry.at) }));
  const events = (Array.isArray(input.events) ? input.events : [])
    .filter((entry) => entry && typeof entry === 'object')
    .slice(0, MAX_EVENTS)
    .map((entry) => ({ at: isoOrEmpty(entry.at), ok: entry.ok === true, kind: cleanText(entry.kind, 30), message: cleanText(entry.message, 300), source: cleanText(entry.source, 40) }));
  return {
    folderId: cleanText(input.folderId, 120).replace(/[^\w-]/g, ''),
    folderName: cleanText(input.folderName, 100),
    account: cleanText(input.account, 200),
    uploaded,
    events,
    lastOkAt: isoOrEmpty(input.lastOkAt),
    lastFailAt: isoOrEmpty(input.lastFailAt),
    needsReconnect: input.needsReconnect === true,
  };
}

/**
 * Zet tekst klaar voor gebruik tussen enkele aanhalingstekens in een Drive-zoekopdracht.
 * @param {string} text De tekst.
 * @returns {string} De tekst met backslash en aanhalingsteken ontsnapt.
 */
const queryEscape = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Maakt de Drive-koppeling.
 * @param {object} options settings (instellingen van de hoofdtenant), backupDir (map met de back-ups), listBackups (backup.js), fetchImpl, hosts (Google-adressen; alleen tests vervangen die), log en now (tests).
 * @returns {object} status, authorizeUrl, finishConnect, disconnect, sync, test, remote, connected, configured en suggestedRedirect.
 */
function createDriveBackup({ settings, backupDir, listBackups, fetchImpl = fetch, hosts = GOOGLE, log = console, now = () => Date.now() }) {
  const pendingStates = new Map();
  let accessToken = null;
  let running = null;

  /**
   * De stand van de koppeling.
   * @returns {object} De opgeschoonde stand.
   */
  const stateOf = () => sanitizeDriveState(settings.get('backupDriveState'));
  /**
   * Bewaart (een deel van) de stand.
   * @param {object} patch De te wijzigen velden.
   * @returns {object} De nieuwe stand.
   */
  function saveState(patch) {
    const next = sanitizeDriveState({ ...stateOf(), ...patch });
    settings.update({ backupDriveState: next });
    return next;
  }
  /**
   * Legt een gebeurtenis vast in de stand (nieuwste eerst, begrensd), met bij een uitkomst ook het laatste succes of de laatste fout.
   * @param {{ ok: boolean, kind: string, message: string, source?: string }} event De gebeurtenis.
   * @returns {object} De nieuwe stand.
   */
  function record(event) {
    const state = stateOf();
    const at = new Date(now()).toISOString();
    const patch = { events: [{ at, source: 'automatisch', ...event }, ...state.events].slice(0, MAX_EVENTS) };
    if (event.kind === 'upload' || event.kind === 'test') {
      if (event.ok) patch.lastOkAt = at; else patch.lastFailAt = at;
    }
    return saveState(patch);
  }
  /**
   * De app-registratie bij Google.
   * @returns {{ clientId: string, clientSecret: string, redirectUri: string, configured: boolean }} De registratie.
   */
  function registration() {
    const config = settings.get('backupDrive');
    const clientSecret = settings.get('backupDriveClientSecret');
    return { clientId: config.clientId, clientSecret, redirectUri: config.redirectUri, configured: Boolean(config.clientId && clientSecret && config.redirectUri) };
  }
  /**
   * Of er een refresh token is (de koppeling is gelegd).
   * @returns {boolean} True als verbonden.
   */
  const connected = () => Boolean(settings.get('backupDriveRefreshToken'));

  /**
   * Doet een verzoek naar Google met een tijdslimiet en zonder doorverwijzingen.
   * @param {string} url Het adres.
   * @param {object} [init] Fetch-opties.
   * @param {number} [timeoutMs] De tijdslimiet.
   * @returns {Promise<object>} Het antwoord.
   * @throws {DriveError} Bij een netwerkfout of time-out.
   */
  async function call(url, init = {}, timeoutMs = TIMEOUT_MS) {
    try {
      return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (error) {
      throw new DriveError('unreachable', 'Google Drive is niet bereikbaar. Probeer het later opnieuw.', 502, error);
    }
  }
  /**
   * Leest de JSON van een antwoord (leeg of ongeldig = leeg object).
   * @param {object} response Het antwoord.
   * @returns {Promise<object>} De inhoud.
   */
  async function jsonOf(response) {
    try { return (await response.json()) || {}; } catch { return {}; }
  }
  /**
   * Zet een fout van Google om naar een leesbare melding (zonder de inhoud van het antwoord).
   * @param {object} response Het antwoord met een foutstatus.
   * @param {string} action Wat er gebeurde, bijv. 'uploaden'.
   * @returns {Promise<DriveError>} De fout.
   */
  async function failure(response, action) {
    const body = await jsonOf(response);
    const reason = String(body?.error?.errors?.[0]?.reason || body?.error?.status || body?.error || '');
    if (response.status === 401) return new DriveError('reconnect', 'De verbinding met Google is verlopen of ingetrokken: verbind opnieuw.', 401);
    if (response.status === 403 && /storageQuotaExceeded|quota/i.test(reason)) return new DriveError('quota', 'Je Google Drive is vol: maak ruimte vrij of verlaag het aantal te bewaren back-ups.', 507);
    if (response.status === 403 || response.status === 404) return new DriveError('forbidden', `Google weigert het ${action} (${reason || response.status}). Controleer de toestemming en de map.`, 502);
    return new DriveError('google_error', `Google gaf een fout bij het ${action} (${response.status}).`, 502);
  }

  // ---------- OAuth2 ----------
  /**
   * Begin van het verbinden: het adres van de inlogpagina van Google (state 15 minuten geldig).
   * @param {string} userId Id van de gebruiker die verbindt.
   * @returns {string} Het adres.
   * @throws {DriveError} Als de app-gegevens nog niet zijn ingevuld.
   */
  function authorizeUrl(userId) {
    const app = registration();
    if (!app.configured) throw new DriveError('not_configured', 'Vul eerst de Google-gegevens in (client ID, secret en redirect URI) en sla ze op.', 409);
    const current = now();
    for (const [key, entry] of pendingStates) if (entry.exp < current) pendingStates.delete(key);
    const state = crypto.randomBytes(24).toString('base64url');
    pendingStates.set(state, { userId, exp: current + STATE_TTL_MS });
    const query = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state });
    return `${hosts.authorize}?${query}`;
  }
  /**
   * Vraagt tokens op bij Google.
   * @param {object} form De formuliervelden (grant_type enz.); client ID en secret komen erbij.
   * @returns {Promise<object>} access_token, expires_in en eventueel refresh_token.
   * @throws {DriveError} Bij een weigering ('reconnect' bij een ingetrokken token).
   */
  async function tokenRequest(form) {
    const app = registration();
    const response = await call(hosts.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, client_id: app.clientId, client_secret: app.clientSecret }).toString(),
    });
    const body = await jsonOf(response);
    if (!response.ok || !body.access_token) {
      if (body.error === 'invalid_grant') throw new DriveError('reconnect', 'De verbinding met Google is verlopen of ingetrokken: verbind opnieuw.', 401);
      throw new DriveError('token_rejected', 'Google weigert de aanmelding (controleer client ID, secret en redirect URI).', 502);
    }
    return body;
  }
  /**
   * Een geldig access token (uit het geheugen of vernieuwd met het refresh token).
   * @returns {Promise<string>} Het token.
   * @throws {DriveError} Als er niet verbonden is of het refresh token niet meer werkt.
   */
  async function token() {
    if (accessToken && accessToken.exp > now() + 60000) return accessToken.value;
    const refresh = settings.get('backupDriveRefreshToken');
    if (!refresh) throw new DriveError('not_connected', 'Er is geen verbinding met Google Drive.', 409);
    try {
      const granted = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
      accessToken = { value: granted.access_token, exp: now() + Math.max(60, Number(granted.expires_in) || 3600) * 1000 };
      if (stateOf().needsReconnect) saveState({ needsReconnect: false });
      return accessToken.value;
    } catch (error) {
      accessToken = null;
      if (error.code === 'reconnect') saveState({ needsReconnect: true });
      throw error;
    }
  }
  /**
   * Een Drive-API-verzoek met het access token.
   * @param {string} url Het adres.
   * @param {object} [init] Fetch-opties.
   * @param {number} [timeoutMs] De tijdslimiet.
   * @returns {Promise<object>} Het antwoord.
   */
  async function api(url, init = {}, timeoutMs = TIMEOUT_MS) {
    const bearer = await token();
    const response = await call(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${bearer}` } }, timeoutMs);
    if (response.status !== 401 || init.retried) return response;
    // Het token kan bij Google al ingetrokken of verlopen zijn: eenmaal een vers token vragen (lukt dat niet, dan 'reconnect').
    accessToken = null;
    return api(url, { ...init, retried: true }, timeoutMs);
  }

  /**
   * Maakt de verbinding af: wisselt de code in voor tokens, bewaart het refresh token en zoekt of maakt de map.
   * @param {string} state De state uit authorizeUrl.
   * @param {string} code De code van Google.
   * @param {{ userId: string }} session Wie terugkomt (moet bij de state horen).
   * @returns {Promise<object>} De nieuwe stand.
   * @throws {DriveError} Bij een ongeldige state of een weigering.
   */
  async function finishConnect(state, code, { userId }) {
    const pending = pendingStates.get(String(state || ''));
    pendingStates.delete(String(state || ''));
    if (!pending || pending.exp < now() || pending.userId !== userId) throw new DriveError('invalid_state', 'Deze aanmelding is verlopen of hoort niet bij jouw sessie. Probeer opnieuw te verbinden.', 400);
    if (!code) throw new DriveError('invalid_code', 'Google gaf geen toestemmingscode terug.', 400);
    const app = registration();
    const granted = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: app.redirectUri });
    if (!granted.refresh_token) throw new DriveError('no_refresh_token', 'Google gaf geen blijvende toestemming. Trek de toegang van deze app in je Google-account in (myaccount.google.com/permissions) en verbind opnieuw.', 502);
    settings.update({ backupDriveRefreshToken: granted.refresh_token });
    accessToken = { value: granted.access_token, exp: now() + Math.max(60, Number(granted.expires_in) || 3600) * 1000 };
    saveState({ needsReconnect: false, folderId: '', folderName: '', account: '' });
    const account = await accountOf();
    saveState({ account });
    await ensureFolder();
    record({ ok: true, kind: 'verbinden', message: `Verbonden met Google Drive${account ? ` (${account})` : ''}`, source: 'handmatig' });
    return stateOf();
  }
  /**
   * Het e-mailadres van het verbonden Google-account (leeg als het niet te lezen is).
   * @returns {Promise<string>} Het adres.
   */
  async function accountOf() {
    try {
      const response = await api(`${hosts.api}/about?fields=user(emailAddress)`);
      return response.ok ? cleanText((await jsonOf(response))?.user?.emailAddress, 200) : '';
    } catch { return ''; }
  }
  /**
   * Trekt de toestemming bij Google in (best effort) en wist het token en de stand van de koppeling.
   * @returns {Promise<{ revoked: boolean }>} Of Google de toestemming heeft ingetrokken.
   */
  async function disconnect() {
    const refresh = settings.get('backupDriveRefreshToken');
    let revoked = false;
    if (refresh) {
      try {
        const response = await call(hosts.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }).toString() });
        revoked = response.ok;
      } catch (error) {
        log.warn(`Google Drive: toestemming intrekken mislukt (${error.code || 'fout'})`);
      }
    }
    accessToken = null;
    settings.update({ backupDriveRefreshToken: '' });
    saveState({ needsReconnect: false, folderId: '', folderName: '', account: '', uploaded: [] });
    record({ ok: true, kind: 'verbreken', message: revoked ? 'Verbinding verbroken en toestemming bij Google ingetrokken' : 'Verbinding verbroken (de toestemming bij Google kon niet worden ingetrokken: doe dat zelf via myaccount.google.com/permissions)', source: 'handmatig' });
    return { revoked };
  }

  // ---------- Map, upload en opruimen ----------
  /**
   * Zoekt de map voor de back-ups (of maakt hem) en onthoudt het id; een gewijzigde mapnaam geeft een nieuwe map.
   * @returns {Promise<string>} Het id van de map.
   */
  async function ensureFolder() {
    const name = settings.get('backupDrive').folderName;
    const state = stateOf();
    if (state.folderId && state.folderName === name) {
      const check = await api(`${hosts.api}/files/${encodeURIComponent(state.folderId)}?fields=id,trashed`);
      if (check.ok && !(await jsonOf(check)).trashed) return state.folderId;
      if (check.status === 401) throw await failure(check, 'controleren van de map');
    }
    const query = new URLSearchParams({ q: `name='${queryEscape(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`, fields: 'files(id)', pageSize: '1', spaces: 'drive' });
    const found = await api(`${hosts.api}/files?${query}`);
    if (!found.ok) throw await failure(found, 'zoeken naar de map');
    let folderId = (await jsonOf(found)).files?.[0]?.id;
    if (!folderId) {
      const created = await api(`${hosts.api}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME }) });
      if (!created.ok) throw await failure(created, 'aanmaken van de map');
      folderId = (await jsonOf(created)).id;
    }
    if (!folderId) throw new DriveError('google_error', 'Google gaf geen map terug.', 502);
    saveState({ folderId, folderName: name });
    return folderId;
  }
  /**
   * Zet één back-up in de Drive-map (hervatbare upload als stream).
   * @param {string} name Bestandsnaam van de back-up in de back-upmap.
   * @param {string} folderId Id van de Drive-map.
   * @returns {Promise<{ driveId: string, size: number }>} Het Drive-bestand.
   * @throws {DriveError} Bij een weigering of netwerkfout.
   */
  async function uploadFile(name, folderId) {
    const file = path.join(backupDir, name);
    const size = fs.statSync(file).size;
    const start = await api(`${hosts.upload}/files?uploadType=resumable&fields=id,size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [folderId], appProperties: { aquatech: 'backup' } }),
    });
    if (!start.ok) throw await failure(start, 'uploaden');
    const location = start.headers.get('location') || '';
    // De sessie-URL hoort bij het uploadadres van Google; nooit een ander adres benaderen.
    if (new URL(location, hosts.upload).origin !== new URL(hosts.upload).origin) throw new DriveError('google_error', 'Google gaf een onverwacht uploadadres.', 502);
    const sent = await call(location, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: Readable.toWeb(fs.createReadStream(file)),
      duplex: 'half',
    }, UPLOAD_TIMEOUT_MS);
    if (!sent.ok) throw await failure(sent, 'uploaden');
    const created = await jsonOf(sent);
    if (!created.id) throw new DriveError('google_error', 'Google bevestigde de upload niet.', 502);
    return { driveId: created.id, size };
  }
  /**
   * Alle back-ups in de Drive-map (nieuwste eerst).
   * @param {string} folderId Id van de map.
   * @returns {Promise<object[]>} id, name, size, createdTime en webViewLink per bestand.
   */
  async function listRemote(folderId) {
    const query = new URLSearchParams({ q: `'${queryEscape(folderId)}' in parents and trashed=false`, pageSize: '1000', fields: 'files(id,name,size,createdTime,webViewLink)' });
    const response = await api(`${hosts.api}/files?${query}`);
    if (!response.ok) throw await failure(response, 'ophalen van de lijst');
    // Nieuwste eerst op de naam (die bevat de datum), niet op uploadtijd: dat is ook de volgorde voor het opruimen.
    return ((await jsonOf(response)).files || []).filter((entry) => BACKUP_FILE.test(String(entry.name))).sort((left, right) => String(right.name).localeCompare(String(left.name)));
  }
  /**
   * Verwijdert de oudste back-ups op Drive boven het in te stellen aantal.
   * @param {string} folderId Id van de map.
   * @returns {Promise<string[]>} Namen van de verwijderde bestanden.
   */
  async function prune(folderId) {
    const keep = settings.get('backupDrive').keepCount;
    const remote = await listRemote(folderId);
    const removed = [];
    for (const entry of remote.slice(keep)) {
      const response = await api(`${hosts.api}/files/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (response.ok || response.status === 404) removed.push(entry.name);
      else log.warn(`Google Drive: oude back-up ${entry.name} verwijderen mislukt (${response.status})`);
    }
    return removed;
  }

  /**
   * Zet de nieuwe back-ups op Drive en ruimt daar op; één ronde tegelijk. Automatisch: alleen als de koppeling aan staat en na een fout
   * pas na een korte wachttijd; handmatig altijd.
   * @param {{ source?: string }} [options] 'automatisch' (standaard) of 'handmatig'.
   * @returns {Promise<object>} uploaded (namen), removed (namen) en eventueel skipped (reden) of error (melding).
   */
  function sync({ source = 'automatisch' } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        return await syncRound(source);
      } finally {
        running = null;
      }
    })();
    return running;
  }
  /**
   * Eén ronde van sync().
   * @param {string} source 'automatisch' of 'handmatig'.
   * @returns {Promise<object>} Zie sync.
   */
  async function syncRound(source) {
    const config = settings.get('backupDrive');
    if (!connected()) return { skipped: 'not_connected', uploaded: [], removed: [] };
    if (source === 'automatisch' && !config.enabled) return { skipped: 'disabled', uploaded: [], removed: [] };
    const state = stateOf();
    if (source === 'automatisch' && (state.needsReconnect || (state.lastFailAt && now() - Date.parse(state.lastFailAt) < RETRY_AFTER_MS))) return { skipped: 'backoff', uploaded: [], removed: [] };
    const known = new Set(state.uploaded.map((entry) => entry.name));
    // Alleen de nieuwste `keepCount` back-ups komen in aanmerking: wat daarbuiten valt zou op Drive direct weer worden opgeruimd.
    const pending = (backupDir ? listBackups(backupDir) : []).slice(0, config.keepCount).filter((backup) => !known.has(backup.name));
    const uploaded = [];
    try {
      const folderId = await ensureFolder();
      for (const backup of pending) {
        const result = await uploadFile(backup.name, folderId);
        uploaded.push(backup.name);
        const current = stateOf();
        saveState({ uploaded: [{ name: backup.name, driveId: result.driveId, size: result.size, at: new Date(now()).toISOString() }, ...current.uploaded].slice(0, MAX_UPLOADED) });
        record({ ok: true, kind: 'upload', message: `${backup.name} geüpload (${result.size} bytes)`, source });
      }
      const removed = await prune(folderId);
      if (removed.length) {
        const gone = new Set(removed);
        saveState({ uploaded: stateOf().uploaded.filter((entry) => !gone.has(entry.name)) });
        record({ ok: true, kind: 'opruimen', message: `${removed.length} oude back-up${removed.length === 1 ? '' : 's'} op Drive verwijderd (bewaartermijn: ${config.keepCount})`, source });
      }
      return { uploaded, removed };
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      record({ ok: false, kind: 'upload', message: error.message, source });
      log.warn(`Google Drive: back-up uploaden mislukt (${error.code})`);
      return { uploaded, removed: [], error: error.message, code: error.code };
    }
  }
  /**
   * Controleert de koppeling: token, map en schrijfrechten (zonder iets te uploaden).
   * @returns {Promise<{ ok: boolean, message: string }>} De uitkomst.
   */
  async function test() {
    try {
      await token();
      const folderId = await ensureFolder();
      await listRemote(folderId);
      record({ ok: true, kind: 'test', message: 'Verbinding met Google Drive werkt', source: 'handmatig' });
      return { ok: true, message: 'De verbinding met Google Drive werkt.' };
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      record({ ok: false, kind: 'test', message: error.message, source: 'handmatig' });
      return { ok: false, message: error.message };
    }
  }
  /**
   * De bestanden die nu op Drive staan (live opgehaald).
   * @returns {Promise<object[]>} id, name, size, createdTime en webViewLink per bestand.
   */
  async function remote() {
    return listRemote(await ensureFolder());
  }

  /**
   * Het overzicht voor Beheer: instelling (zonder geheimen), stand, waarschuwingen en de lokale back-ups met of ze op Drive staan.
   * @returns {object} enabled, configured, connected, account, folderName, keepCount, redirectUri, running, lastOkAt, lastFailAt, needsReconnect, stale, events en items.
   */
  function status() {
    const config = settings.get('backupDrive');
    const state = stateOf();
    const uploadedBy = new Map(state.uploaded.map((entry) => [entry.name, entry]));
    const isConnected = connected();
    const stale = Boolean(isConnected && config.enabled && (!state.lastOkAt || now() - Date.parse(state.lastOkAt) > STALE_AFTER_MS));
    return {
      config,
      secretSet: Boolean(settings.get('backupDriveClientSecret')),
      configured: registration().configured,
      connected: isConnected,
      account: state.account,
      folderId: state.folderId,
      running: Boolean(running),
      lastOkAt: state.lastOkAt,
      lastFailAt: state.lastFailAt,
      needsReconnect: state.needsReconnect,
      stale,
      events: state.events,
      items: (backupDir ? listBackups(backupDir) : []).map((backup) => ({ ...backup, onDrive: uploadedBy.has(backup.name), uploadedAt: uploadedBy.get(backup.name)?.at || '' })),
    };
  }

  return { status, authorizeUrl, finishConnect, disconnect, sync, test, remote, connected, registration, DriveError };
}

module.exports = { createDriveBackup, sanitizeDriveBackup, sanitizeDriveState, DriveError, CALLBACK_PATH, GOOGLE, SCOPE };
