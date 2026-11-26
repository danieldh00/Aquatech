// Routes voor het archief (Beheer > Archief): tellen, bekijken, archiveren per stuk of in bulk, terughalen en het archief definitief
// verwijderen. Onder /api/admin, dus alleen met het recht beheer; alles binnen de eigen organisatie (req.tenantId).
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/** Het woord dat de beheerder moet typen om het archief definitief te verwijderen. */
const PURGE_CONFIRMATION = 'VERWIJDEREN';

/**
 * Registreert de archiefroutes onder /api/admin/archive.
 * @param {import('express').Express} app De app.
 * @param {object} ctx archive (createArchive), audit (req, actie, detail), confirmIdentity (req, res → wachtwoord opnieuw vragen) en runBackup (veiligheidsback-up vóór het verwijderen; null als back-ups niet zijn ingesteld).
 * @returns {void}
 */
function registerArchiveRoutes(app, { archive, audit, confirmIdentity, runBackup }) {
  const changeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120, keyFn: (req) => `archief-wijzig:${req.user ? req.user.id : ''}` });
  const purgeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `archief-wissen:${req.user ? req.user.id : ''}` });

  app.use('/api/admin/archive', express.json({ limit: '100kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  /**
   * Haalt de selectie uit een verzoek en saneert die.
   * @param {object} body Verzoekinhoud.
   * @returns {{ kinds: string[]|null, before: string, query: string }} De selectie.
   */
  const selectionOf = (body) => ({
    kinds: Array.isArray(body.kinds) ? body.kinds.map(String).filter((kind) => archive.kinds[kind]) : null,
    before: /^\d{4}-\d{2}-\d{2}$/.test(String(body.before || '')) ? String(body.before) : '',
    query: String(body.query || '').slice(0, 80),
  });

  app.get('/api/admin/archive', (req, res) => res.json({ counts: archive.counts(req.tenantId), retentionCutoff: archive.retentionCutoff() }));

  app.get('/api/admin/archive/list', (req, res) => {
    if (!archive.kinds[req.query.kind]) return res.status(400).json({ error: 'invalid_kind', message: 'Onbekende soort.' });
    res.json(archive.list(req.tenantId, { kind: req.query.kind, query: String(req.query.query || '').slice(0, 80), limit: req.query.limit, offset: req.query.offset }));
  });

  app.post('/api/admin/archive/preview', (req, res) => {
    const selection = selectionOf(req.body || {});
    res.json(archive.preview(req.tenantId, { ...selection, state: req.body && req.body.state === 'archief' ? 'archief' : 'actief' }));
  });

  app.post('/api/admin/archive/archive', changeLimiter, (req, res) => {
    const body = req.body || {};
    if (body.kind) {
      if (!archive.kinds[body.kind] || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500) return res.status(400).json({ error: 'invalid_request', message: 'Kies een soort en één of meer stukken.' });
      const out = archive.archive(req.tenantId, body.kind, body.ids);
      audit(req, 'archief_archiveren', { soort: body.kind, aantal: out.changed, overgeslagen: out.skipped });
      return res.json({ archived: { [body.kind]: out.changed }, skipped: { [body.kind]: out.skipped } });
    }
    const selection = selectionOf(body);
    if (!selection.before && !selection.query) return res.status(400).json({ error: 'selection_required', message: 'Geef een datum of zoekterm op, zodat niet per ongeluk alles wordt gearchiveerd.' });
    if (!selection.kinds || !selection.kinds.length) return res.status(400).json({ error: 'kinds_required', message: 'Kies welke soorten je wilt archiveren.' });
    // Het aantal uit het voorbeeld moet nog kloppen: zo archiveert de server nooit meer dan de beheerder zag.
    const expected = archive.preview(req.tenantId, selection).total;
    if (!Number.isInteger(body.expected) || body.expected !== expected) {
      return res.status(409).json({ error: 'selection_changed', message: `Het voorbeeld klopt niet meer (nu ${expected} stuks). Bekijk het voorbeeld opnieuw.`, expected });
    }
    const results = archive.archiveMatching(req.tenantId, selection);
    const archived = Object.fromEntries(Object.entries(results).map(([kind, out]) => [kind, out.changed]));
    const skipped = Object.fromEntries(Object.entries(results).map(([kind, out]) => [kind, out.skipped]));
    audit(req, 'archief_archiveren_bulk', { ...archived, voor: selection.before, zoek: selection.query });
    res.json({ archived, skipped });
  });

  app.post('/api/admin/archive/restore', changeLimiter, (req, res) => {
    const body = req.body || {};
    if (!archive.kinds[body.kind] || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500) return res.status(400).json({ error: 'invalid_request', message: 'Kies een soort en één of meer stukken.' });
    const changed = archive.restore(req.tenantId, body.kind, body.ids);
    audit(req, 'archief_terughalen', { soort: body.kind, aantal: changed });
    res.json({ restored: { [body.kind]: changed } });
  });

  app.post('/api/admin/archive/purge', purgeLimiter, async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== PURGE_CONFIRMATION) return res.status(409).json({ error: 'confirm_required', message: `Typ ${PURGE_CONFIRMATION} om het archief definitief te verwijderen.` });
    const selection = selectionOf(body);
    if (!selection.kinds || !selection.kinds.length) return res.status(400).json({ error: 'kinds_required', message: 'Kies welke soorten je definitief wilt verwijderen.' });
    if (!(await confirmIdentity(req, res))) return undefined;
    let safetyBackup = null;
    if (runBackup) {
      try { safetyBackup = (await runBackup(req)).name || true; } catch (error) {
        return res.status(500).json({ error: 'backup_failed', message: 'De veiligheidsback-up lukte niet, dus er is niets verwijderd. Probeer het opnieuw of maak eerst een back-up in Beheer.' });
      }
    }
    const result = archive.purge(req.tenantId, selection);
    audit(req, 'archief_verwijderd', { ...result.deleted, geblokkeerd: result.blocked.length, voor: selection.before, zoek: selection.query, back_up: Boolean(safetyBackup) });
    res.json({ ...result, safetyBackup: Boolean(safetyBackup) });
  });
}

module.exports = { registerArchiveRoutes, PURGE_CONFIRMATION };
