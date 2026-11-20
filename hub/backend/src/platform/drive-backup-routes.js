// Routes voor Beheer > Back-ups > Google Drive (/api/admin/backups/drive*). De koppeling zelf staat in drive-backup.js;
// hier staan de invoercontrole van de instelling `backupDrive`, de foutafhandeling, de OAuth-terugkeer en het auditlog.
// Alleen voor hoofdbeheerders: de controle op /api/admin/backups in server.js geldt ook voor deze routes, en ze moeten
// vóór /api/admin/backups/:name worden geregistreerd.
const { sanitizeDriveBackup, DriveError, CALLBACK_PATH: DRIVE_CALLBACK_PATH } = require('./drive-backup');
const { SettingsError } = require('./settings');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/**
 * Registreert de Drive-routes onder /api/admin/backups/drive.
 * @param {import('express').Express} app De app.
 * @param {object} ctx driveBackup (uit createDriveBackup), settings, audit (req, actie, detail, gebruiker, tenant), requireJson (middleware) en mainTenantId.
 * @returns {void}
 */
function registerDriveBackupRoutes(app, { driveBackup, settings, audit, requireJson, mainTenantId }) {
  // Een ruime limiet per gebruiker voor alle Drive-routes (het scherm doet er hooguit een paar per minuut).
  const driveLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120, keyFn: (req) => `backup-drive:${req.user ? req.user.id : ''}` });
  app.use('/api/admin/backups/drive', driveLimiter);
  /**
   * Antwoordt op een fout van de Drive-koppeling met een leesbare melding; een andere fout gaat door naar de foutafhandeling.
   * @param {object} res Het antwoord.
   * @param {Error} error De fout.
   * @param {Function} next De volgende afhandeling.
   * @returns {object} Het antwoord.
   */
  const driveFail = (res, error, next) => {
    if (!(error instanceof DriveError)) return next(error);
    return res.status(error.status).json({ error: error.code, message: error.message });
  };
  /**
   * Een route met async afhandeling en Drive-fouten.
   * @param {Function} handler De afhandeling.
   * @returns {Function} De route.
   */
  const driveRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => driveFail(res, error, next));
  /**
   * Het voorgestelde redirect-adres voor de Google-app (alleen een suggestie voor het formulier; wat telt is wat is opgeslagen).
   * @returns {string} Het adres.
   */
  const driveSuggestedRedirect = () => `${settings.get('shopPayment').publicUrl || 'https://aquatech.den-hollander.com/'}app${DRIVE_CALLBACK_PATH}`;
  app.get('/api/admin/backups/drive', driveRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const out = { ...driveBackup.status(), suggestedRedirect: driveSuggestedRedirect() };
    if (req.query.remote === '1' && out.connected) {
      try { out.remote = await driveBackup.remote(); } catch (error) { if (!(error instanceof DriveError)) throw error; out.remoteError = error.message; }
    }
    res.json(out);
  }));
  app.put('/api/admin/backups/drive', requireJson, driveRoute(async (req, res) => {
    const body = req.body || {};
    const current = settings.get('backupDrive');
    const next = sanitizeDriveBackup({ ...current, ...body, redirectUri: body.redirectUri === undefined ? current.redirectUri : body.redirectUri });
    if (body.redirectUri !== undefined && String(body.redirectUri).trim() && !next.redirectUri) {
      return res.status(400).json({ error: 'invalid_setting', field: 'redirectUri', message: `Het redirect-adres moet met https:// beginnen en eindigen op ${DRIVE_CALLBACK_PATH}.` });
    }
    // De app-gegevens horen bij het refresh token: een andere Google-app pas na verbreken.
    const changesApp = next.clientId !== current.clientId || next.redirectUri !== current.redirectUri || (typeof body.clientSecret === 'string' && body.clientSecret.trim() !== '') || body.clearSecret === true;
    if (changesApp && driveBackup.connected()) return res.status(409).json({ error: 'disconnect_first', message: 'Verbreek eerst de verbinding met Google Drive voordat je de Google-gegevens wijzigt; verbind daarna opnieuw.' });
    if (next.enabled && !driveBackup.connected() && body.enabled === true) return res.status(409).json({ error: 'not_connected', message: 'Verbind eerst met Google Drive voordat je de kopie aanzet.' });
    const patch = { backupDrive: next };
    if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) patch.backupDriveClientSecret = body.clientSecret.trim();
    if (body.clearSecret === true) patch.backupDriveClientSecret = '';
    try {
      settings.update(patch, req.user.id);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      return res.status(400).json({ error: 'invalid_setting', field: error.field, message: error.message });
    }
    audit(req, 'instellingen_gewijzigd', { fields: Object.keys(patch) }, undefined, mainTenantId);
    if (next.enabled && driveBackup.connected()) driveBackup.sync({ source: 'handmatig' }).catch((error) => console.warn(`Google Drive: ${error.message}`));
    res.json({ ...driveBackup.status(), suggestedRedirect: driveSuggestedRedirect() });
  }));
  app.post('/api/admin/backups/drive/connect', requireJson, driveRoute(async (req, res) => {
    res.json({ url: driveBackup.authorizeUrl(req.user.id) });
  }));
  app.get('/api/admin/backups/drive/callback', driveRoute(async (req, res) => {
    // Terug naar Beheer (relatief, werkt ook onder een padprefix): .../app/api/admin/backups/drive/ -> .../app/beheer/
    /**
     * Stuurt de browser terug naar Beheer met de uitkomst in de adresregel.
     * @param {string} query De querystring, bijv. 'drive=verbonden'.
     * @returns {void}
     */
    const back = (query) => res.redirect(303, `../../../../beheer/?${query}#backup-drive`);
    if (req.query.error) return back('drive=geweigerd');
    try {
      await driveBackup.finishConnect(String(req.query.state || ''), String(req.query.code || ''), { userId: req.user.id });
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      console.warn(`Google Drive verbinden mislukt: ${error.code}`);
      return back(`drive=fout&reden=${encodeURIComponent(error.code)}`);
    }
    audit(req, 'backup_drive_verbonden', {}, undefined, mainTenantId);
    driveBackup.sync({ source: 'handmatig' }).catch((error) => console.warn(`Google Drive: ${error.message}`));
    return back('drive=verbonden');
  }));
  app.post('/api/admin/backups/drive/disconnect', requireJson, driveRoute(async (req, res) => {
    const { revoked } = await driveBackup.disconnect();
    audit(req, 'backup_drive_verbroken', { revoked }, undefined, mainTenantId);
    res.json({ ...driveBackup.status(), revoked, suggestedRedirect: driveSuggestedRedirect() });
  }));
  app.post('/api/admin/backups/drive/sync', requireJson, driveRoute(async (req, res) => {
    if (!driveBackup.connected()) return res.status(409).json({ error: 'not_connected', message: 'Er is geen verbinding met Google Drive.' });
    const out = await driveBackup.sync({ source: 'handmatig' });
    audit(req, 'backup_drive_upload', { uploaded: out.uploaded.length, removed: out.removed.length, error: Boolean(out.error) }, undefined, mainTenantId);
    res.json({ ...out, status: driveBackup.status() });
  }));
  app.post('/api/admin/backups/drive/test', requireJson, driveRoute(async (req, res) => {
    if (!driveBackup.connected()) return res.status(409).json({ error: 'not_connected', message: 'Er is geen verbinding met Google Drive.' });
    res.json({ ...(await driveBackup.test()), status: driveBackup.status() });
  }));
}

module.exports = { registerDriveBackupRoutes };
