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
  const d = Lib.sanitize(Lib.DEFAULTS);
  return { bodies: new Map(d.bodies.map((x) => [x.key, JSON.stringify(x)])), nozzles: new Map(d.nozzles.map((x) => [x.key, JSON.stringify(x)])) };
})();

function createSprinklerStore(db) {
  const q = (sql) => db.prepare(sql);

  /** Eigen regels van een omgeving: { own: { bodies, nozzles } | null, updatedAt }. */
  function get(tenantId) {
    const rows = q('SELECT kind, data, updated_at FROM sprinkler_library WHERE tenant_id = ? ORDER BY kind, key').all(tenantId);
    if (!rows.length) return { own: null, updatedAt: null };
    const own = { bodies: [], nozzles: [] };
    let updatedAt = '';
    for (const r of rows) {
      try { own[KINDS[r.kind]].push(JSON.parse(r.data)); } catch { /* kapotte regel overslaan */ }
      if (r.updated_at > updatedAt) updatedAt = r.updated_at;
    }
    return { own, updatedAt };
  }

  /**
   * Vervangt alle eigen regels. Geeft { error } als er niets bruikbaars in zit,
   * anders { counts, problems } (overgeslagen regels met de reden).
   */
  function replace(tenantId, user, raw) {
    const lib = Lib.sanitize(raw);
    if (!lib.bodies.length && !lib.nozzles.length) {
      return { error: lib.problems.length ? `Geen bruikbare regels gevonden. ${lib.problems.slice(0, 3).join(' ')}` : 'Het bestand bevat geen behuizingen of nozzles.' };
    }
    // regels die gelijk zijn aan de standaard niet opslaan (het gedownloade bestand bevat ze ook),
    // zodat verbeteringen in de standaard gewoon doorkomen
    const same = (kind, x) => DEFAULTS[kind].get(x.key) === JSON.stringify(x);
    const keep = { bodies: lib.bodies.filter((x) => !same('bodies', x)), nozzles: lib.nozzles.filter((x) => !same('nozzles', x)) };
    const at = new Date().toISOString();
    transaction(db, () => {
      q('DELETE FROM sprinkler_library WHERE tenant_id = ?').run(tenantId);
      const ins = q(`INSERT INTO sprinkler_library (id, tenant_id, kind, key, data, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const [kind, list] of [['body', keep.bodies], ['nozzle', keep.nozzles]]) {
        for (const x of list) ins.run(crypto.randomUUID(), tenantId, kind, x.key, JSON.stringify(x), at, user ? user.id : null);
      }
    });
    return {
      counts: { bodies: lib.bodies.length, nozzles: lib.nozzles.length, own: keep.bodies.length + keep.nozzles.length },
      problems: lib.problems,
    };
  }

  /** Terug naar de standaardbibliotheek. */
  function reset(tenantId) {
    return q('DELETE FROM sprinkler_library WHERE tenant_id = ?').run(tenantId).changes;
  }

  return { get, replace, reset };
}

function registerSprinklerRoutes(app, ctx) {
  const { sprinklers, requireUser, requireRight, requireJson, audit } = ctx;
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const requireAdmin = requireRight('beheer');

  // Eigen regels (de standaard zit in de frontend): planner, offertes en Beheer.
  app.get('/api/sprinkler-library', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(sprinklers.get(tid(req)));
  });

  app.put('/api/sprinkler-library', requireJson, requireAdmin, (req, res) => {
    const out = sprinklers.replace(tid(req), req.user, req.body);
    if (out.error) return res.status(400).json({ error: 'invalid', message: out.error });
    audit(req, 'sproeierbibliotheek_ingelezen', { behuizingen: out.counts.bodies, nozzles: out.counts.nozzles, overgeslagen: out.problems.length });
    res.json({ ...sprinklers.get(tid(req)), counts: out.counts, problems: out.problems.slice(0, 50) });
  });

  app.delete('/api/sprinkler-library', requireAdmin, (req, res) => {
    const removed = sprinklers.reset(tid(req));
    if (removed) audit(req, 'sproeierbibliotheek_standaard', { verwijderd: removed });
    res.json({ own: null, updatedAt: null, removed });
  });
}

module.exports = { createSprinklerStore, registerSprinklerRoutes, Lib };
