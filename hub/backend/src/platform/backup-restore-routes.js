// Routes voor het terugzetten uit een back-up (Beheer > Back-ups > Terugzetten), achter de hoofdbeheerder-poort van
// /api/admin/backups. De logica staat in backup-restore.js; hier staan de invoercontrole, het opnieuw invullen van het
// eigen wachtwoord, de limieten, de back-up vooraf en het auditlog.
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { verifyPassword } = require('./store');
const restore = require('./backup-restore');

const BASE = '/api/admin/backups/restore';

/**
 * Koppelt de routes voor terugzetten aan de app.
 * @param {object} app De Express-app.
 * @param {{ backupDir: ?string, vault: object, database: object, store: object, audit: Function, runBackup: Function, requireJson: Function }} deps De back-upmap, de kluis, de actieve database, de store, het auditlog, de back-upfunctie en de JSON-controle.
 * @returns {void}
 */
function registerBackupRestoreRoutes(app, { backupDir, vault, database, store, audit, runBackup, requireJson }) {
  const openLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyFn: (req) => `restore-open:${req.user ? req.user.id : ''}` });
  const applyLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyFn: (req) => `restore-apply:${req.user ? req.user.id : ''}` });
  let applying = false;

  /**
   * Opent de gekozen back-up, voert de functie uit en sluit hem altijd weer.
   * @param {object} req Het verzoek (req.tenantId = de actieve omgeving).
   * @param {string} name De bestandsnaam van de back-up.
   * @param {Function} callback Krijgt { backup, current, context }.
   * @returns {Promise<*>} Wat de functie teruggeeft.
   */
  async function withBackup(req, name, callback) {
    const opened = await restore.openBackup({ dir: backupDir, name: String(name || ''), vault });
    try {
      const customerRoleKeys = store.roles.keysOfKind(req.tenantId, 'klant');
      return await callback({ backup: opened.db, current: database, context: { tenantId: req.tenantId, customerRoleKeys } });
    } finally {
      opened.close();
    }
  }
  /**
   * Zet een fout om in een antwoord: bewust leesbare fouten (met status) tonen hun melding, de rest wordt een interne fout.
   * @param {object} res Het antwoord.
   * @param {Error} error De fout.
   * @param {Function} next Volgende handler voor onverwachte fouten.
   * @returns {void}
   */
  function fail(res, error, next) {
    if (error && error.status && error.status < 500) return res.status(error.status).json({ error: 'restore_failed', message: error.message });
    return next(error);
  }

  app.get(`${BASE}/kinds`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: Boolean(backupDir), kinds: restore.kinds() });
  });

  app.get(`${BASE}/records`, openLimiter, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const out = await withBackup(req, req.query.backup, (opened) => restore.listRecords({ ...opened, kind: String(req.query.kind || ''), query: String(req.query.q || ''), offset: req.query.offset }));
      res.json(out);
    } catch (error) { fail(res, error, next); }
  });

  app.post(`${BASE}/preview`, requireJson, openLimiter, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, restore.MAX_LIST);
      if (!ids.length) return res.status(400).json({ error: 'invalid_request', message: 'Kies minstens één record.' });
      const previews = await withBackup(req, req.body.backup, (opened) => ids.map((id) => restore.preview({ ...opened, kind: String(req.body.kind || ''), id })));
      res.json({ previews });
    } catch (error) { fail(res, error, next); }
  });

  app.post(`${BASE}/apply`, requireJson, applyLimiter, async (req, res, next) => {
    if (applying) return res.status(409).json({ error: 'busy', message: 'Er wordt al een terugzetting uitgevoerd.' });
    applying = true;
    try {
      const account = store.getUser(req.user.id);
      const password = String(req.body?.password ?? '').slice(0, 200);
      if (!account || !account.password_hash || !(await verifyPassword(password, account.password_hash))) {
        audit(req, 'backup_terugzetten_wachtwoord_fout', {});
        return res.status(401).json({ error: 'wrong_password', message: 'Je wachtwoord klopt niet.' });
      }
      const kind = String(req.body.kind || '');
      const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, restore.MAX_IDS).map((item) => ({ id: String(item?.id || ''), fields: Array.isArray(item?.fields) ? item.fields.map(String).slice(0, 200) : [] }));
      // Eerst controleren dat de back-up te openen is, dan een verse back-up als vangnet, pas daarna schrijven.
      const out = await withBackup(req, req.body.backup, async (opened) => {
        const safety = await runBackup(req);
        const done = restore.applyRestore({ ...opened, kind, items });
        return { ...done, safetyBackup: safety.name };
      });
      const counts = {};
      for (const result of out.results) counts[result.status] = (counts[result.status] || 0) + 1;
      audit(req, 'backup_teruggezet', { backup: String(req.body.backup), soort: kind, aantal: counts, vooraf: out.safetyBackup, records: out.results.filter((result) => result.status === 'hersteld' || result.status === 'bijgewerkt').map((result) => result.id).slice(0, 50) });
      res.json(out);
    } catch (error) { fail(res, error, next); } finally { applying = false; }
  });
}

module.exports = { registerBackupRestoreRoutes };
