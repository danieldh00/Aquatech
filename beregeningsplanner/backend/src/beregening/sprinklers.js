// Sproeierbibliotheek per omgeving: eigen behuizingen en nozzles bovenop de
// standaardbibliotheek in frontend/beregening/js/sprinklerlib.js (Rain Bird
// 1800/5004/5012, Hunter Pro-Spray, MP Rotator, HE-VAN, Rain Curtain).
//
// - Tabel `sprinkler_library` (migratie 29): één rij per behuizing of nozzle
//   (kind 'body' | 'nozzle', sleutel uniek per omgeving), de gecontroleerde
//   gegevens als JSON in `data`. Een testomgeving heeft een eigen bibliotheek.
// - Inlezen (Beheer > Sproeiers, Excel in de browser omgezet naar JSON)
//   vervangt alle eigen regels in één transactie; de server controleert alles
//   opnieuw met SprinklerLib.sanitize (de browser is niet te vertrouwen).
// - De planner en de offertes halen de eigen regels op (GET, elke ingelogde
//   gebruiker van de omgeving) en leggen ze over de standaard.
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { transaction } = require('../database/db');

const Lib = require(path.join(FRONTEND_DIR, 'beregening', 'js', 'sprinklerlib.js'));

const KINDS = { body: 'bodies', nozzle: 'nozzles' };
// Standaardregels zoals ze na controle zijn, om ongewijzigde regels te herkennen.
const DEFAULTS = (() => {
  const checked = Lib.sanitize(Lib.DEFAULTS);
  return { bodies: new Map(checked.bodies.map((entry) => [entry.key, JSON.stringify(entry)])), nozzles: new Map(checked.nozzles.map((entry) => [entry.key, JSON.stringify(entry)])) };
})();

/**
 * Maakt de opslag voor de eigen sproeierbibliotheek per omgeving.
 * @param {object} db De database.
 * @returns {{ get: Function, replace: Function, reset: Function }} De opslagfuncties.
 */
function createSprinklerStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Eigen regels van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ own: { bodies: object[], nozzles: object[] }|null, updatedAt: string|null }} De eigen regels (null = alleen de standaard) en het moment van de laatste wijziging.
   */
  function get(tenantId) {
    const rows = prepare('SELECT kind, data, updated_at FROM sprinkler_library WHERE tenant_id = ? ORDER BY kind, key').all(tenantId);
    if (!rows.length) return { own: null, updatedAt: null };
    const own = { bodies: [], nozzles: [] };
    let updatedAt = '';
    for (const row of rows) {
      try { own[KINDS[row.kind]].push(JSON.parse(row.data)); } catch { /* kapotte regel overslaan */ }
      if (row.updated_at > updatedAt) updatedAt = row.updated_at;
    }
    return { own, updatedAt };
  }

  /**
   * Vervangt alle eigen regels. Regels die gelijk zijn aan de standaard worden
   * niet opgeslagen, zodat verbeteringen in de standaard gewoon doorkomen.
   * @param {string} tenantId Id van de omgeving.
   * @param {object|null} user Wie het bestand inleest.
   * @param {object} raw De ingelezen bibliotheek (wordt opnieuw gecontroleerd).
   * @returns {{ counts: object, problems: string[] }|{ error: string }} Aantallen en overgeslagen regels met de reden, of een fout als er niets bruikbaars in zit.
   */
  function replace(tenantId, user, raw) {
    const lib = Lib.sanitize(raw);
    if (!lib.bodies.length && !lib.nozzles.length) {
      return { error: lib.problems.length ? `Geen bruikbare regels gevonden. ${lib.problems.slice(0, 3).join(' ')}` : 'Het bestand bevat geen behuizingen of nozzles.' };
    }
    /**
     * Of een regel gelijk is aan de standaardregel met dezelfde sleutel.
     * @param {string} kind 'bodies' of 'nozzles'.
     * @param {object} entry De gecontroleerde regel.
     * @returns {boolean} True als hij gelijk is aan de standaard.
     */
    const same = (kind, entry) => DEFAULTS[kind].get(entry.key) === JSON.stringify(entry);
    const keep = { bodies: lib.bodies.filter((entry) => !same('bodies', entry)), nozzles: lib.nozzles.filter((entry) => !same('nozzles', entry)) };
    const timestamp = new Date().toISOString();
    transaction(db, () => {
      prepare('DELETE FROM sprinkler_library WHERE tenant_id = ?').run(tenantId);
      const insert = prepare(`INSERT INTO sprinkler_library (id, tenant_id, kind, key, data, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const [kind, list] of [['body', keep.bodies], ['nozzle', keep.nozzles]]) {
        for (const entry of list) insert.run(crypto.randomUUID(), tenantId, kind, entry.key, JSON.stringify(entry), timestamp, user ? user.id : null);
      }
    });
    return {
      counts: { bodies: lib.bodies.length, nozzles: lib.nozzles.length, own: keep.bodies.length + keep.nozzles.length },
      problems: lib.problems,
    };
  }

  /**
   * Zet de omgeving terug naar de standaardbibliotheek.
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal verwijderde eigen regels.
   */
  function reset(tenantId) {
    return prepare('DELETE FROM sprinkler_library WHERE tenant_id = ?').run(tenantId).changes;
  }

  return { get, replace, reset };
}

/**
 * Registreert de routes van de sproeierbibliotheek (lezen voor iedereen, inlezen en terugzetten voor beheerders).
 * @param {object} app De Express-app.
 * @param {object} ctx sprinklers (de opslag), requireUser, requireRight, requireJson en audit.
 */
function registerSprinklerRoutes(app, ctx) {
  const { sprinklers, requireUser, requireRight, requireJson, audit } = ctx;
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  const requireAdmin = requireRight('beheer');

  // Eigen regels (de standaard zit in de frontend): planner, offertes en Beheer.
  app.get('/api/sprinkler-library', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(sprinklers.get(tenantOf(req)));
  });

  app.put('/api/sprinkler-library', requireJson, requireAdmin, (req, res) => {
    const out = sprinklers.replace(tenantOf(req), req.user, req.body);
    if (out.error) return res.status(400).json({ error: 'invalid', message: out.error });
    audit(req, 'sproeierbibliotheek_ingelezen', { behuizingen: out.counts.bodies, nozzles: out.counts.nozzles, overgeslagen: out.problems.length });
    res.json({ ...sprinklers.get(tenantOf(req)), counts: out.counts, problems: out.problems.slice(0, 50) });
  });

  app.delete('/api/sprinkler-library', requireAdmin, (req, res) => {
    const removed = sprinklers.reset(tenantOf(req));
    if (removed) audit(req, 'sproeierbibliotheek_standaard', { verwijderd: removed });
    res.json({ own: null, updatedAt: null, removed });
  });
}

module.exports = { createSprinklerStore, registerSprinklerRoutes, Lib };
