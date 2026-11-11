// Opslag van de toestemmingen (grants) van de AI-koppeling (OAuth 2.1, zie oauth-server.js). Eén rij per keer dat een
// gebruiker een AI-app (Claude, ChatGPT) toegang geeft: eerst met een eenmalige autorisatiecode, daarna met een
// toegangstoken (1 uur) en een vernieuwingstoken (30 dagen, bij elk gebruik een nieuwe). Van elke code en elk token staat
// alleen de SHA-256 in de database; het token zelf zien alleen de AI-app en de gebruiker nooit. Een token draagt de
// omgeving (tenant) vooraan, zodat elke opzoeking op `tenant_id` filtert (en via de index loopt).
// Wordt een al gebruikte code of een oud vernieuwingstoken nog eens aangeboden, dan is er iets uitgelekt: dan vervalt de
// hele toestemming (RFC 9700, 4.14).
const crypto = require('crypto');

/** Hoelang een autorisatiecode geldig is: de AI-app wisselt hem binnen een paar seconden in. */
const CODE_TTL_MS = 5 * 60 * 1000;
/** Hoelang een toegangstoken geldig is. */
const ACCESS_TTL_MS = 60 * 60 * 1000;
/** Hoelang een vernieuwingstoken geldig is (elke vernieuwing begint opnieuw). */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hoelang een toestemming hoogstens bestaat; daarna moet de gebruiker opnieuw toestaan. */
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Twee gelijktijdige vernieuwingen met hetzelfde token (netwerkfout, herhaling) tellen binnen deze tijd niet als misbruik. */
const REFRESH_GRACE_MS = 60 * 1000;
/** Hoelang een ingetrokken of verlopen toestemming nog zichtbaar blijft voordat het onderhoud hem wist. */
const KEEP_ENDED_MS = 7 * 24 * 60 * 60 * 1000;
/** Hoe vaak het moment van laatste gebruik hoogstens wordt bijgewerkt (geen schrijfactie per verzoek). */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/** De vorm van een code of token: aqt_<soort>_<omgeving>.<willekeurig deel>. */
const TOKEN_FORMAT = /^aqt_(ac|at|rt)_([A-Za-z0-9-]{1,64})\.([A-Za-z0-9_-]{43})$/;

/** De kolommen die het opzoeken van een toestemming teruggeeft. */
const GRANT_COLUMNS = `id, tenant_id, user_id, client_id_hash, client_name, redirect_uri, scope, resource, fingerprint, code_challenge,
  code_expires_at, code_used_at, access_expires_at, refresh_expires_at, rotated_at, created_at, last_used_at, expires_at, revoked_at`;

/**
 * SHA-256 van een code of token (hex).
 * @param {string} value De code of het token.
 * @returns {string} De hash.
 */
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Maakt een nieuwe code of een nieuw token voor een omgeving.
 * @param {string} kind 'ac' (autorisatiecode), 'at' (toegangstoken) of 'rt' (vernieuwingstoken).
 * @param {string} tenantId De omgeving.
 * @returns {string} De code of het token.
 */
const newToken = (kind, tenantId) => `aqt_${kind}_${tenantId}.${crypto.randomBytes(32).toString('base64url')}`;

/**
 * Leest de omgeving uit een code of token, als de vorm klopt.
 * @param {*} value De aangeboden waarde.
 * @param {string} kind De verwachte soort ('ac', 'at' of 'rt').
 * @returns {{ tenantId: string, hash: string }|null} De omgeving en de hash, of null bij een onbekende vorm.
 */
function parseToken(value, kind) {
  const match = TOKEN_FORMAT.exec(String(value || ''));
  if (!match || match[1] !== kind) return null;
  return { tenantId: match[2], hash: sha256(value) };
}

/**
 * ISO-tijdstip over een aantal milliseconden (vanaf nu of vanaf het opgegeven moment).
 * @param {number} ms Aantal milliseconden.
 * @param {number} [from] Startmoment in ms.
 * @returns {string} Het tijdstip.
 */
const isoIn = (ms, from = Date.now()) => new Date(from + ms).toISOString();

/**
 * Vergelijkt twee teksten in constante tijd.
 * @param {string} left De ene.
 * @param {string} right De andere.
 * @returns {boolean} true als ze gelijk zijn.
 */
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Controleert PKCE (S256): de SHA-256 van de verifier (base64url) moet de challenge zijn.
 * @param {string} verifier De code_verifier van de AI-app (43-128 tekens).
 * @param {string} challenge De code_challenge uit de autorisatie.
 * @returns {boolean} true als hij klopt.
 */
function pkceMatches(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ''))) return false;
  return safeEqual(crypto.createHash('sha256').update(String(verifier)).digest('base64url'), String(challenge || ''));
}

/**
 * Maakt de opslag van de toestemmingen.
 * @param {object} db De database.
 * @returns {object} De functies (createCode, exchangeCode, refresh, findAccess, touch, revoke, revokeByToken, listForUser, revokeForUser, purge).
 */
function createOAuthGrants(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De opdracht.
   * @returns {object} Het statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Een toestemming in het formaat van de code (camelCase).
   * @param {object|undefined} row De rij.
   * @returns {object|null} De toestemming, of null.
   */
  const shape = (row) => (row ? {
    id: row.id, tenantId: row.tenant_id, userId: row.user_id, clientIdHash: row.client_id_hash, clientName: row.client_name, redirectUri: row.redirect_uri,
    scope: row.scope, resource: row.resource, fingerprint: row.fingerprint, codeChallenge: row.code_challenge, codeExpiresAt: row.code_expires_at,
    codeUsedAt: row.code_used_at, accessExpiresAt: row.access_expires_at, refreshExpiresAt: row.refresh_expires_at, rotatedAt: row.rotated_at,
    createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
  } : null);

  /**
   * Of een toestemming nog in gebruik mag zijn (niet ingetrokken en niet over de maximale duur).
   * @param {object} grant De toestemming.
   * @param {number} [now] Het moment.
   * @returns {boolean} true als hij nog geldt.
   */
  const alive = (grant, now = Date.now()) => !grant.revokedAt && Date.parse(grant.expiresAt) > now;

  /**
   * Legt een nieuwe toestemming vast met een eenmalige autorisatiecode (na "Toestaan" op het toestemmingsscherm).
   * @param {{ tenantId: string, userId: string, clientIdHash: string, clientName: string, redirectUri: string, scope: string, resource: string, fingerprint: string, codeChallenge: string }} input De gegevens.
   * @returns {{ code: string, grantId: string }} De code (alleen voor de redirect) en het id.
   */
  function createCode(input) {
    const id = crypto.randomUUID();
    const code = newToken('ac', input.tenantId);
    const now = Date.now();
    prepare(`INSERT INTO oauth_grants (id, tenant_id, user_id, client_id_hash, client_name, redirect_uri, scope, resource, fingerprint,
        code_hash, code_challenge, code_expires_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.tenantId, input.userId, input.clientIdHash, String(input.clientName || '').slice(0, 100), input.redirectUri, input.scope, input.resource,
        input.fingerprint, sha256(code), input.codeChallenge, isoIn(CODE_TTL_MS, now), new Date(now).toISOString(), isoIn(GRANT_TTL_MS, now));
    return { code, grantId: id };
  }

  /**
   * Zet een nieuw toegangs- en vernieuwingstoken op een toestemming, alleen als de vorige stand nog klopt (zo wint bij
   * twee gelijktijdige verzoeken er maar één).
   * @param {object} grant De toestemming.
   * @param {string} condition Extra voorwaarde in SQL (met één ?), bijv. 'code_used_at IS NULL AND code_hash = ?'.
   * @param {string} conditionValue De waarde voor de voorwaarde.
   * @param {string|null} previousRefreshHash Hash van het vernieuwingstoken dat hiermee vervalt (voor het herkennen van hergebruik).
   * @returns {{ accessToken: string, refreshToken: string, expiresIn: number }|null} De tokens, of null als een ander verzoek voor was.
   */
  function issueTokens(grant, condition, conditionValue, previousRefreshHash) {
    const accessToken = newToken('at', grant.tenantId);
    const refreshToken = newToken('rt', grant.tenantId);
    const now = Date.now();
    // Het vernieuwingstoken leeft niet langer dan de toestemming zelf.
    const refreshExpires = Math.min(now + REFRESH_TTL_MS, Date.parse(grant.expiresAt));
    const result = prepare(`UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?,
        previous_refresh_hash = COALESCE(?, previous_refresh_hash), rotated_at = ?, code_used_at = COALESCE(code_used_at, ?), last_used_at = ?
      WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL AND ${condition}`)
      .run(sha256(accessToken), isoIn(ACCESS_TTL_MS, now), sha256(refreshToken), new Date(refreshExpires).toISOString(), previousRefreshHash,
        new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), grant.tenantId, grant.id, conditionValue);
    if (Number(result.changes) !== 1) return null;
    return { accessToken, refreshToken, expiresIn: Math.round(ACCESS_TTL_MS / 1000) };
  }

  /**
   * Wisselt een autorisatiecode in voor tokens. Controleert de AI-app, het terugkeeradres en PKCE. Een al gebruikte code
   * trekt de hele toestemming in.
   * @param {{ code: string, clientIdHash: string, redirectUri: string, codeVerifier: string, resource?: string }} input De aanvraag.
   * @returns {{ tokens: object, grant: object }|{ error: string, description: string }} De tokens of een OAuth-fout.
   */
  function exchangeCode(input) {
    const parsed = parseToken(input.code, 'ac');
    const invalid = { error: 'invalid_grant', description: 'De autorisatiecode is ongeldig of verlopen.' };
    if (!parsed) return invalid;
    const grant = shape(prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE tenant_id = ? AND code_hash = ?`).get(parsed.tenantId, parsed.hash));
    if (!grant || !alive(grant)) return invalid;
    if (grant.codeUsedAt) {
      // Tweede keer dezelfde code: iemand anders heeft hem ook. Alles van deze toestemming vervalt.
      revoke(grant.tenantId, grant.id);
      return invalid;
    }
    if (Date.parse(grant.codeExpiresAt) <= Date.now()) return invalid;
    if (!safeEqual(grant.clientIdHash, input.clientIdHash) || grant.redirectUri !== input.redirectUri) return invalid;
    if (input.resource && input.resource !== grant.resource) return { error: 'invalid_target', description: 'Dit token is voor een andere server aangevraagd.' };
    if (!pkceMatches(input.codeVerifier, grant.codeChallenge)) return invalid;
    const tokens = issueTokens(grant, 'code_used_at IS NULL AND code_hash = ?', parsed.hash, null);
    return tokens ? { tokens, grant } : invalid;
  }

  /**
   * Vernieuwt de tokens met een vernieuwingstoken (rotatie: het oude vervalt). Wordt een vervallen vernieuwingstoken
   * na de korte marge nog eens gebruikt, dan vervalt de hele toestemming.
   * @param {{ refreshToken: string, clientIdHash: string, resource?: string }} input De aanvraag.
   * @returns {{ tokens: object, grant: object }|{ error: string, description: string }} De tokens of een OAuth-fout.
   */
  function refresh(input) {
    const parsed = parseToken(input.refreshToken, 'rt');
    const invalid = { error: 'invalid_grant', description: 'Het vernieuwingstoken is ongeldig of verlopen. Koppel de app opnieuw.' };
    if (!parsed) return invalid;
    const grant = shape(prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE tenant_id = ? AND refresh_hash = ?`).get(parsed.tenantId, parsed.hash));
    if (!grant) {
      const reused = shape(prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE tenant_id = ? AND previous_refresh_hash = ?`).get(parsed.tenantId, parsed.hash));
      if (reused && !reused.revokedAt && Date.now() - Date.parse(reused.rotatedAt || 0) > REFRESH_GRACE_MS) revoke(reused.tenantId, reused.id);
      return invalid;
    }
    if (!alive(grant) || Date.parse(grant.refreshExpiresAt) <= Date.now()) return invalid;
    if (!safeEqual(grant.clientIdHash, input.clientIdHash)) return invalid;
    if (input.resource && input.resource !== grant.resource) return { error: 'invalid_target', description: 'Dit token is voor een andere server aangevraagd.' };
    const tokens = issueTokens(grant, 'refresh_hash = ?', parsed.hash, parsed.hash);
    return tokens ? { tokens, grant } : invalid;
  }

  /**
   * Zoekt de toestemming bij een toegangstoken (voor elk verzoek aan de MCP-server).
   * @param {string} accessToken Het token uit de kop Authorization.
   * @returns {object|null} De toestemming, of null als het token niet (meer) geldt.
   */
  function findAccess(accessToken) {
    const parsed = parseToken(accessToken, 'at');
    if (!parsed) return null;
    const grant = shape(prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE tenant_id = ? AND access_hash = ?`).get(parsed.tenantId, parsed.hash));
    if (!grant || !alive(grant) || Date.parse(grant.accessExpiresAt) <= Date.now()) return null;
    return grant;
  }

  /**
   * Werkt het moment van laatste gebruik bij, hoogstens eens per vijf minuten.
   * @param {object} grant De toestemming.
   * @returns {void}
   */
  function touch(grant) {
    if (grant.lastUsedAt && Date.now() - Date.parse(grant.lastUsedAt) < TOUCH_EVERY_MS) return;
    prepare('UPDATE oauth_grants SET last_used_at = ? WHERE tenant_id = ? AND id = ?').run(new Date().toISOString(), grant.tenantId, grant.id);
  }

  /**
   * Trekt een toestemming in: alle tokens vervallen direct.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van de toestemming.
   * @returns {boolean} true als er iets is ingetrokken.
   */
  function revoke(tenantId, id) {
    const result = prepare(`UPDATE oauth_grants SET revoked_at = ?, access_hash = NULL, refresh_hash = NULL
      WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), tenantId, String(id));
    return Number(result.changes) > 0;
  }

  /**
   * Trekt de toestemming in waar een toegangs- of vernieuwingstoken bij hoort (RFC 7009); onbekende tokens doen niets.
   * @param {string} token Het token.
   * @param {string} clientIdHash Hash van de AI-app die vraagt (alleen eigen tokens).
   * @returns {boolean} true als er iets is ingetrokken.
   */
  function revokeByToken(token, clientIdHash) {
    for (const [kind, column] of [['at', 'access_hash'], ['rt', 'refresh_hash']]) {
      const parsed = parseToken(token, kind);
      if (!parsed) continue;
      const grant = shape(prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE tenant_id = ? AND ${column} = ?`).get(parsed.tenantId, parsed.hash));
      if (grant && safeEqual(grant.clientIdHash, clientIdHash)) return revoke(grant.tenantId, grant.id);
    }
    return false;
  }

  /**
   * De actieve koppelingen van een gebruiker (voor Mijn profiel), nieuwste eerst.
   * @param {string[]} tenantIds De omgevingen van de organisatie van de gebruiker.
   * @param {string} userId Id van de gebruiker.
   * @returns {object[]} id, app, omgeving, aangemaakt, laatst gebruikt en geldig tot.
   */
  function listForUser(tenantIds, userId) {
    const ids = [...new Set(tenantIds.map(String))];
    if (!ids.length) return [];
    const now = new Date().toISOString();
    return prepare(`SELECT g.id, g.tenant_id, g.client_name, g.redirect_uri, g.scope, g.created_at, g.last_used_at, g.expires_at, g.refresh_expires_at, t.name AS tenant_name
        FROM oauth_grants g JOIN tenants t ON t.id = g.tenant_id
        WHERE g.tenant_id IN (${ids.map(() => '?').join(', ')}) AND g.user_id = ? AND g.revoked_at IS NULL AND g.code_used_at IS NOT NULL
          AND g.expires_at > ? AND g.refresh_expires_at > ?
        ORDER BY g.created_at DESC LIMIT 50`)
      .all(...ids, String(userId), now, now)
      .map((row) => ({ id: row.id, tenantId: row.tenant_id, environment: row.tenant_name, app: row.client_name, host: hostOf(row.redirect_uri), scope: row.scope,
        createdAt: row.created_at, lastUsedAt: row.last_used_at, validUntil: row.refresh_expires_at < row.expires_at ? row.refresh_expires_at : row.expires_at }));
  }

  /**
   * Trekt een koppeling van een gebruiker in (Mijn profiel).
   * @param {string[]} tenantIds De omgevingen van de organisatie.
   * @param {string} userId Id van de gebruiker.
   * @param {string} id Id van de toestemming.
   * @returns {boolean} true als hij is ingetrokken.
   */
  function revokeForUser(tenantIds, userId, id) {
    const ids = [...new Set(tenantIds.map(String))];
    if (!ids.length) return false;
    const result = prepare(`UPDATE oauth_grants SET revoked_at = ?, access_hash = NULL, refresh_hash = NULL
      WHERE tenant_id IN (${ids.map(() => '?').join(', ')}) AND id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), ...ids, String(id), String(userId));
    return Number(result.changes) > 0;
  }

  /**
   * Trekt alle koppelingen van een gebruiker in, bijvoorbeeld als het account wordt uitgeschakeld.
   * @param {string[]} tenantIds De omgevingen van de organisatie.
   * @param {string} userId Id van de gebruiker.
   * @returns {number} Aantal ingetrokken koppelingen.
   */
  function revokeAllForUser(tenantIds, userId) {
    const ids = [...new Set(tenantIds.map(String))];
    if (!ids.length) return 0;
    const result = prepare(`UPDATE oauth_grants SET revoked_at = ?, access_hash = NULL, refresh_hash = NULL
      WHERE tenant_id IN (${ids.map(() => '?').join(', ')}) AND user_id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), ...ids, String(userId));
    return Number(result.changes) || 0;
  }

  /**
   * Wist toestemmingen die niet meer gelden: verlopen, een week geleden ingetrokken, of een code die nooit is ingewisseld.
   * @param {string} tenantId De omgeving.
   * @returns {number} Aantal gewiste rijen.
   */
  function purge(tenantId) {
    const now = Date.now();
    const ended = new Date(now - KEEP_ENDED_MS).toISOString();
    const result = prepare(`DELETE FROM oauth_grants WHERE tenant_id = ? AND (expires_at < ? OR refresh_expires_at < ? OR revoked_at < ?
        OR (code_used_at IS NULL AND code_expires_at < ?))`)
      .run(tenantId, ended, ended, ended, new Date(now - CODE_TTL_MS).toISOString());
    return Number(result.changes) || 0;
  }

  return { createCode, exchangeCode, refresh, findAccess, touch, revoke, revokeByToken, listForUser, revokeForUser, revokeAllForUser, purge };
}

/**
 * De host van een adres (voor het tonen van waar een koppeling heen gaat).
 * @param {string} url Het adres.
 * @returns {string} De host, of leeg.
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

module.exports = { createOAuthGrants, parseToken, pkceMatches, sha256, hostOf, ACCESS_TTL_MS, REFRESH_TTL_MS, CODE_TTL_MS };
