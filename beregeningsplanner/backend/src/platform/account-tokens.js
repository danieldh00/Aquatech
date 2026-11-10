// Eenmalige links per mail voor accounts (tabel account_tokens, migratie 48):
// wachtwoord vergeten ('wachtwoord') en e-mailadres bevestigen ('e-mail'),
// bevinding A-02 uit de audit van 1.7.3. Alleen de SHA-256 van het token staat
// in de database; het token zelf gaat alleen in de mail. Een link verloopt,
// werkt één keer, en een nieuwe link maakt de vorige van hetzelfde soort ongeldig.

const crypto = require('crypto');
const { transaction } = require('../database/db');

/** Geldigheid per soort link. */
const TTL_MS = { wachtwoord: 60 * 60 * 1000, 'e-mail': 7 * 24 * 60 * 60 * 1000 };
/** Hooguit zoveel links per account, soort en uur (tegen mailbommen). */
const MAX_PER_HOUR = 3;

/**
 * SHA-256 van een token.
 * @param {string} token Het token.
 * @returns {string} Hex.
 */
const sha256 = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Maakt de opslag voor eenmalige accountlinks.
 * @param {object} db De database.
 * @returns {{ issue: Function, consume: Function, purgeExpired: Function, TTL_MS: object }} De functies.
 */
function createAccountTokens(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De opdracht.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Maakt een nieuwe link voor een account. Eerdere ongebruikte links van dezelfde soort vervallen.
   * @param {string} tenantId Id van de omgeving van het account.
   * @param {string} userId Id van het account.
   * @param {'wachtwoord'|'e-mail'} purpose Soort link.
   * @param {string} email Het e-mailadres waar de link heen gaat.
   * @returns {{ token: string, expiresAt: string }|{ limited: true }} Het token (alleen voor de mail), of limited als er dit uur al te veel zijn verstuurd.
   */
  function issue(tenantId, userId, purpose, email) {
    return transaction(db, () => {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = prepare('SELECT COUNT(*) AS n FROM account_tokens WHERE tenant_id = ? AND user_id = ? AND purpose = ? AND created_at > ?')
        .get(tenantId, userId, purpose, hourAgo).n;
      if (Number(recent) >= MAX_PER_HOUR) return { limited: true };
      const now = new Date();
      prepare('UPDATE account_tokens SET used_at = ? WHERE tenant_id = ? AND user_id = ? AND purpose = ? AND used_at IS NULL').run(now.toISOString(), tenantId, userId, purpose);
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + TTL_MS[purpose]).toISOString();
      prepare(`INSERT INTO account_tokens (id, tenant_id, user_id, purpose, token_hash, email, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(crypto.randomUUID(), tenantId, userId, purpose, sha256(token), String(email || '').slice(0, 200), expiresAt, now.toISOString());
      return { token, expiresAt };
    });
  }

  /**
   * Gebruikt een link: geldig, niet verlopen, niet eerder gebruikt en van deze soort. Daarna werkt hij niet meer.
   * @param {string} tenantId Id van de omgeving waarin de link hoort (de shop).
   * @param {string} token Het token uit de link.
   * @param {'wachtwoord'|'e-mail'} purpose Soort link.
   * @returns {{ userId: string, email: string }|null} Het account en het adres van de link, of null.
   */
  function consume(tenantId, token, purpose) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
    return transaction(db, () => {
      const row = prepare('SELECT id, user_id, email, expires_at, used_at FROM account_tokens WHERE token_hash = ? AND tenant_id = ? AND purpose = ?')
        .get(sha256(token), tenantId, purpose);
      if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
      prepare('UPDATE account_tokens SET used_at = ? WHERE id = ? AND tenant_id = ?').run(new Date().toISOString(), row.id, tenantId);
      return { userId: row.user_id, email: row.email };
    });
  }

  /**
   * Ruimt verlopen of gebruikte links op die ouder zijn dan een dag (onderhoud).
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal verwijderde links.
   */
  function purgeExpired(tenantId) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return prepare('DELETE FROM account_tokens WHERE tenant_id = ? AND created_at < ? AND (used_at IS NOT NULL OR expires_at < ?)').run(tenantId, dayAgo, new Date().toISOString()).changes;
  }

  return { issue, consume, purgeExpired, TTL_MS };
}

module.exports = { createAccountTokens, TTL_MS, MAX_PER_HOUR };
