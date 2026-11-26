// Voorraadmelding in de eigen webshop: een bezoeker laat bij een artikel dat niet op voorraad is zijn e-mailadres achter en krijgt één
// mail zodra het weer te bestellen is. Het adres wordt niet langer bewaard dan nodig: na de mail (of na een half jaar) wordt de rij gewist.
// Zo wordt ook zichtbaar hoeveel bezoekers op een artikel wachten (voor de inkoop).
const crypto = require('node:crypto');
const { validEmail } = require('../platform/mailer');

/** Hoeveel voorraadmeldingen één e-mailadres tegelijk open mag hebben (tegen misbruik van het formulier). */
const MAX_PER_EMAIL = 10;
/** Na hoeveel dagen een melding zonder mail vervalt (het artikel is blijkbaar nooit teruggekomen). */
const MAX_AGE_DAYS = 180;
/** Hoeveel meldingen één ronde hoogstens verstuurt. */
const MAX_PER_RUN = 200;

/**
 * Maakt de opslag van voorraadmeldingen.
 * @param {object} db De database.
 * @returns {{ subscribe: Function, due: Function, remove: Function, purgeOld: Function, waitingByItem: Function }} De functies.
 */
function createStockAlerts(db) {
  /**
   * Het artikel waarvoor iemand zich wil aanmelden: moet bestaan, niet gearchiveerd zijn, en echt niet op voorraad.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} code De artikelcode.
   * @returns {?{ code: string, name: string, available: number }} Het artikel, of null.
   */
  const itemOf = (tenantId, code) => {
    const row = db.prepare(`SELECT i.code, i.name, i.on_hand, i.stock_managed, i.is_group,
        (SELECT COALESCE(SUM(r.qty), 0) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id) AS reserved
      FROM stock_items i WHERE i.tenant_id = ? AND i.archived = 0 AND i.code = ?`).get(tenantId, String(code));
    if (!row || Number(row.is_group) === 1) return null;
    return { code: row.code, name: row.name, managed: Number(row.stock_managed) !== 0, available: Math.round((Number(row.on_hand) - Number(row.reserved)) * 1000) / 1000 };
  };

  return {
    /**
     * Legt een voorraadmelding vast. Een tweede keer voor hetzelfde artikel en adres telt als gelukt (geen dubbele rij).
     * @param {string} tenantId Id van de omgeving.
     * @param {{ code: string, email: string }} request Het artikel en het e-mailadres van de bezoeker.
     * @returns {{ ok: true }|{ error: string, status: number }} Gelukt, of een foutmelding met statuscode.
     */
    subscribe(tenantId, { code, email }) {
      const address = String(email || '').trim().toLowerCase().slice(0, 200);
      if (!validEmail(address)) return { error: 'Vul een geldig e-mailadres in.', status: 400 };
      const item = itemOf(tenantId, code);
      if (!item) return { error: 'Dit artikel bestaat niet.', status: 404 };
      if (!item.managed || item.available > 0) return { error: 'Dit artikel is op voorraad: je kunt het gewoon bestellen.', status: 409 };
      const existing = db.prepare('SELECT id FROM stock_alerts WHERE tenant_id = ? AND item_code = ? AND email = ?').get(tenantId, item.code, address);
      if (existing) return { ok: true };
      const open = db.prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE tenant_id = ? AND email = ?').get(tenantId, address).n;
      if (Number(open) >= MAX_PER_EMAIL) return { error: 'Je hebt al veel voorraadmeldingen openstaan. Je krijgt een mail zodra een van die artikelen terug is.', status: 429 };
      db.prepare('INSERT INTO stock_alerts (id, tenant_id, item_code, email, created_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), tenantId, item.code, address, new Date().toISOString());
      return { ok: true };
    },

    /**
     * De meldingen waarvan het artikel weer te bestellen is (voorraad min reserveringen boven nul), oudste eerst.
     * @param {string} tenantId Id van de omgeving.
     * @returns {{ id: string, code: string, name: string, email: string }[]} De meldingen om te versturen (hoogstens één ronde).
     */
    due(tenantId) {
      return db.prepare(`SELECT a.id, a.item_code AS code, i.name, a.email
        FROM stock_alerts a JOIN stock_items i ON i.tenant_id = a.tenant_id AND i.code = a.item_code
        WHERE a.tenant_id = ? AND i.archived = 0 AND i.stock_managed <> 0
          AND i.on_hand - (SELECT COALESCE(SUM(r.qty), 0) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id) > 0
        ORDER BY a.created_at LIMIT ${MAX_PER_RUN}`).all(tenantId);
    },

    /**
     * Wist een verstuurde melding.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} id Id van de melding.
     * @returns {void}
     */
    remove(tenantId, id) {
      db.prepare('DELETE FROM stock_alerts WHERE tenant_id = ? AND id = ?').run(tenantId, id);
    },

    /**
     * Wist meldingen die al een half jaar open staan, en die van artikelen die niet meer bestaan of gearchiveerd zijn.
     * @param {string} tenantId Id van de omgeving.
     * @returns {number} Het aantal gewiste meldingen.
     */
    purgeOld(tenantId) {
      const limit = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const old = db.prepare('DELETE FROM stock_alerts WHERE tenant_id = ? AND created_at < ?').run(tenantId, limit).changes;
      const gone = db.prepare(`DELETE FROM stock_alerts WHERE tenant_id = ? AND NOT EXISTS
        (SELECT 1 FROM stock_items i WHERE i.tenant_id = stock_alerts.tenant_id AND i.code = stock_alerts.item_code AND i.archived = 0)`).run(tenantId).changes;
      return Number(old) + Number(gone);
    },

    /**
     * Hoeveel bezoekers op elk artikel wachten (voor de inkoop).
     * @param {string} tenantId Id van de omgeving.
     * @returns {{ code: string, name: string, waiting: number }[]} Per artikel het aantal, grootste eerst.
     */
    waitingByItem(tenantId) {
      return db.prepare(`SELECT a.item_code AS code, MIN(i.name) AS name, COUNT(*) AS waiting
        FROM stock_alerts a JOIN stock_items i ON i.tenant_id = a.tenant_id AND i.code = a.item_code
        WHERE a.tenant_id = ? GROUP BY a.item_code ORDER BY COUNT(*) DESC, a.item_code`).all(tenantId).map((row) => ({ code: row.code, name: row.name, waiting: Number(row.waiting) }));
    },
  };
}

module.exports = { createStockAlerts, MAX_PER_EMAIL, MAX_AGE_DAYS };
