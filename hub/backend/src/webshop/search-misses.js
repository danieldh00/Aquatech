// Zoektermen zonder resultaat in de eigen webshop: per omgeving en genormaliseerde term een teller, zodat de beheerder ziet wat
// bezoekers zoeken en niet vinden (een artikel dat ontbreekt, een synoniem dat nog niet bestaat). Alleen de term wordt bewaard, nooit
// wie zocht; termen die op persoonsgegevens lijken (e-mailadres, lang cijfer) worden overgeslagen en na 90 dagen zonder nieuwe
// zoekopdracht wordt de rij gewist.
const { normalize } = require('./search');

/** Hoeveel verschillende termen er hoogstens bewaard blijven per omgeving (tegen vollopen door een bot). */
const MAX_TERMS = 500;
/** Na hoeveel dagen zonder nieuwe zoekopdracht een term wordt gewist. */
const MAX_AGE_DAYS = 90;
/** Langste term die wordt bewaard (tekens, na normaliseren). */
const MAX_LENGTH = 40;

/**
 * Of een term mag worden bewaard: lang genoeg, niet te lang en zonder iets dat op een persoonsgegeven lijkt.
 * @param {string} raw De zoekterm zoals getypt.
 * @param {string} term De genormaliseerde term.
 * @returns {boolean} true als de term bewaard mag worden.
 */
function storable(raw, term) {
  if (term.length < 2 || term.length > MAX_LENGTH) return false;
  if (raw.includes('@')) return false;
  return !/\d{8,}/.test(term.replace(/ /g, ''));
}

/**
 * Maakt de opslag van zoektermen zonder resultaat.
 * @param {object} db De database.
 * @returns {{ record: Function, list: Function, purgeOld: Function }} De functies.
 */
function createSearchMisses(db) {
  return {
    /**
     * Telt een zoekopdracht zonder resultaat. Een term die niet bewaard mag worden of een omgeving die vol zit, doet niets.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} query De zoekterm zoals de bezoeker hem typte.
     * @returns {boolean} true als de zoekopdracht is geteld.
     */
    record(tenantId, query) {
      const raw = String(query || '');
      const term = normalize(raw);
      if (!storable(raw, term)) return false;
      const now = new Date().toISOString();
      const known = db.prepare('SELECT hits FROM shop_search_misses WHERE tenant_id = ? AND term = ?').get(tenantId, term);
      if (known) {
        db.prepare('UPDATE shop_search_misses SET hits = hits + 1, last_at = ? WHERE tenant_id = ? AND term = ?').run(now, tenantId, term);
        return true;
      }
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM shop_search_misses WHERE tenant_id = ?').get(tenantId).n);
      if (count >= MAX_TERMS) {
        // Vol: de oudste term met de minste zoekopdrachten maakt plaats.
        const oldest = db.prepare('SELECT term FROM shop_search_misses WHERE tenant_id = ? ORDER BY hits, last_at LIMIT 1').get(tenantId);
        if (oldest) db.prepare('DELETE FROM shop_search_misses WHERE tenant_id = ? AND term = ?').run(tenantId, oldest.term);
      }
      db.prepare('INSERT INTO shop_search_misses (tenant_id, term, hits, first_at, last_at) VALUES (?, ?, 1, ?, ?)').run(tenantId, term, now, now);
      return true;
    },

    /**
     * De termen zonder resultaat, de meest gezochte eerst.
     * @param {string} tenantId Id van de omgeving.
     * @returns {{ term: string, hits: number, firstAt: string, lastAt: string }[]} De termen.
     */
    list(tenantId) {
      return db.prepare('SELECT term, hits, first_at, last_at FROM shop_search_misses WHERE tenant_id = ? ORDER BY hits DESC, last_at DESC LIMIT ?').all(tenantId, MAX_TERMS)
        .map((row) => ({ term: row.term, hits: Number(row.hits), firstAt: row.first_at, lastAt: row.last_at }));
    },

    /**
     * Wist termen die al 90 dagen niet meer zijn gezocht.
     * @param {string} tenantId Id van de omgeving.
     * @returns {number} Het aantal gewiste termen.
     */
    purgeOld(tenantId) {
      const limit = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      return Number(db.prepare('DELETE FROM shop_search_misses WHERE tenant_id = ? AND last_at < ?').run(tenantId, limit).changes);
    },
  };
}

/**
 * API-route van het overzicht (onder /api/admin, dus alleen voor beheerders).
 * @param {object} app De Express-app.
 * @param {{ misses: object }} ctx De opslag (createSearchMisses).
 * @returns {void}
 */
function registerSearchMissRoutes(app, { misses }) {
  app.get('/api/admin/shop-search-misses', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ items: misses.list(req.tenantId), maxAgeDays: MAX_AGE_DAYS });
  });
}

module.exports = { createSearchMisses, registerSearchMissRoutes, MAX_TERMS, MAX_AGE_DAYS };
