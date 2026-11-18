// Eigen koopfunneltelling van de webshop: per omgeving, dag en stap hoeveel keer de stap is bereikt (productpagina, in winkelwagen,
// winkelwagen bekeken, afrekenen, bestelling geplaatst, betaald, account aangemaakt). Alleen tellers: er wordt niets over wie het
// was bewaard (geen adres, cookie of account) en medewerkers, voorbeelden en bots tellen niet mee. De tellers staan eerst in het
// geheugen en gaan elke minuut in één keer naar de database, zodat een winkelpagina geen databasequery kost. Het zijn aantallen
// paginaweergaven en acties, geen unieke bezoekers, dus de percentages zijn indicatief.
const { transaction } = require('../database/db');

const TIME_ZONE = 'Europe/Amsterdam';

/** De stappen van de funnel in de volgorde waarin een klant ze doorloopt; `label` is de tekst in Beheer. */
const STEPS = [
  { key: 'product', label: 'Productpagina bekeken' },
  { key: 'cart_add', label: 'In winkelwagen gelegd' },
  { key: 'cart', label: 'Winkelwagen bekeken' },
  { key: 'checkout', label: 'Afrekenen geopend' },
  { key: 'order', label: 'Bestelling geplaatst' },
  { key: 'paid', label: 'Online betaald' },
];

/** Gebeurtenissen die naast de funnel worden geteld (geen vaste stap in de volgorde). */
const EXTRA_STEPS = [
  { key: 'checkout_login', label: 'Inlogmuur bij afrekenen getoond' },
  { key: 'signup', label: 'Account aangemaakt' },
];

/** Alle sleutels die bewaard mogen worden. */
const KEYS = new Set([...STEPS, ...EXTRA_STEPS].map((step) => step.key));

/** Na hoeveel dagen een dagtelling wordt gewist. */
const MAX_AGE_DAYS = 400;
/** Langste periode die het overzicht in één keer toont (dagen). */
const MAX_RANGE_DAYS = 366;

/**
 * Of dit een zoekmachine of andere robot lijkt, aan de User-Agent. Robots tellen niet mee in de funnel.
 * @param {object} req Het verzoek.
 * @returns {boolean} true als de User-Agent leeg is of op een robot lijkt.
 */
function looksLikeBot(req) {
  const agent = String(req.get ? req.get('user-agent') : (req.headers && req.headers['user-agent']) || '');
  return !agent || /bot|crawl|spider|slurp|preview|monitor|uptime|curl|wget|python|headless|lighthouse|facebookexternalhit/i.test(agent);
}

/**
 * De datum (jjjj-mm-dd) in Nederlandse tijd.
 * @param {Date} [moment] Het tijdstip (standaard nu).
 * @returns {string} De datum.
 */
function dayOf(moment = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
}

/**
 * Maakt de funneltelling.
 * @param {object} db De database.
 * @returns {{ count: Function, flush: Function, report: Function, purgeOld: Function }} De functies.
 */
function createFunnel(db) {
  /** Nog niet weggeschreven tellers: sleutel `<omgeving>|<dag>|<stap>` → aantal. */
  let pending = new Map();

  return {
    /**
     * Telt één keer een stap. Een onbekende stap doet niets.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} step De sleutel van de stap (zie STEPS en EXTRA_STEPS).
     * @returns {boolean} true als de stap is geteld.
     */
    count(tenantId, step) {
      if (!tenantId || !KEYS.has(step)) return false;
      const key = `${tenantId}|${dayOf()}|${step}`;
      pending.set(key, (pending.get(key) || 0) + 1);
      return true;
    },

    /**
     * Schrijft de tellers uit het geheugen naar de database. Bij een fout blijven ze staan voor de volgende ronde.
     * @returns {number} Het aantal weggeschreven tellers.
     */
    flush() {
      if (!pending.size) return 0;
      const batch = pending;
      pending = new Map();
      try {
        transaction(db, () => {
          for (const [key, hits] of batch) {
            const [tenantId, day, step] = key.split('|');
            db.prepare('INSERT INTO shop_funnel_days (tenant_id, day, step, hits) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, day, step) DO UPDATE SET hits = shop_funnel_days.hits + excluded.hits').run(tenantId, day, step, hits);
          }
        });
      } catch (error) {
        for (const [key, hits] of batch) pending.set(key, (pending.get(key) || 0) + hits);
        throw error;
      }
      return batch.size;
    },

    /**
     * Het overzicht van een periode: per stap het totaal, het aandeel ten opzichte van de vorige stap en per dag de aantallen.
     * @param {string} tenantId Id van de omgeving.
     * @param {number} days Aantal dagen terug (1 tot en met 366), vandaag meegerekend.
     * @returns {{ days: number, from: string, to: string, steps: object[], extra: object[], perDay: object[] }} Het overzicht.
     */
    report(tenantId, days) {
      this.flush();
      const span = Math.min(MAX_RANGE_DAYS, Math.max(1, Math.floor(Number(days)) || 30));
      const to = dayOf();
      const from = dayOf(new Date(Date.now() - (span - 1) * 24 * 60 * 60 * 1000));
      const rows = db.prepare('SELECT day, step, hits FROM shop_funnel_days WHERE tenant_id = ? AND day >= ? AND day <= ? ORDER BY day').all(tenantId, from, to);
      const totals = new Map();
      const byDay = new Map();
      for (const row of rows) {
        totals.set(row.step, (totals.get(row.step) || 0) + Number(row.hits));
        if (!byDay.has(row.day)) byDay.set(row.day, {});
        byDay.get(row.day)[row.step] = Number(row.hits);
      }
      let previous = null;
      const steps = STEPS.map((step) => {
        const count = totals.get(step.key) || 0;
        const out = { key: step.key, label: step.label, count, ofPrevious: previous ? (previous > 0 ? Math.round((count / previous) * 1000) / 10 : null) : null };
        previous = count;
        return out;
      });
      const extra = EXTRA_STEPS.map((step) => ({ key: step.key, label: step.label, count: totals.get(step.key) || 0 }));
      const perDay = [...byDay.keys()].sort().map((day) => ({ day, ...Object.fromEntries([...KEYS].map((key) => [key, byDay.get(day)[key] || 0])) }));
      return { days: span, from, to, steps, extra, perDay };
    },

    /**
     * Wist dagtellingen die ouder zijn dan 400 dagen.
     * @param {string} tenantId Id van de omgeving.
     * @returns {number} Het aantal gewiste rijen.
     */
    purgeOld(tenantId) {
      const limit = dayOf(new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000));
      return Number(db.prepare('DELETE FROM shop_funnel_days WHERE tenant_id = ? AND day < ?').run(tenantId, limit).changes);
    },
  };
}

/**
 * API-route van het overzicht (onder /api/admin, dus alleen voor beheerders).
 * @param {object} app De Express-app.
 * @param {{ funnel: object }} ctx De telling (createFunnel).
 * @returns {void}
 */
function registerFunnelRoutes(app, { funnel }) {
  app.get('/api/admin/shop-funnel', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(funnel.report(req.tenantId, req.query.days));
  });
}

module.exports = { createFunnel, registerFunnelRoutes, looksLikeBot, dayOf, STEPS, EXTRA_STEPS, MAX_AGE_DAYS };
