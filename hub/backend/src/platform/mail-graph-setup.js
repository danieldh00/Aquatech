// Mail via Microsoft Graph automatisch inrichten: de beheerder logt in met een Microsoft-code en -link (device code flow),
// waarna de app in dezelfde Microsoft 365-omgeving een app-registratie, een clientgeheim en de machtiging Mail.Send
// (toepassing) aanmaakt. De inlog van de beheerder wordt alleen hiervoor gebruikt en nooit bewaard; bewaard worden
// alleen tenant-ID, client-ID en het (versleutelde) clientgeheim van de nieuwe app. Vaste Microsoft-hosts.
const crypto = require('node:crypto');
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { validTenantId } = require('./mail-graph');
const { withCause } = require('./error-report');

const LOGIN = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** De openbare Microsoft-client waarmee de beheerder inlogt (Azure CLI); te vervangen met GRAPH_SETUP_CLIENT_ID. */
const DEFAULT_SETUP_CLIENT = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const SCOPES = ['Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Organization.Read.All'].map((scope) => `https://graph.microsoft.com/${scope}`).join(' ');
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const APP_NAME = 'AquaTech Hub mail';
const SESSION_MS = 15 * 60 * 1000;
const SECRET_MONTHS = 12;

/**
 * Een fout van de inrichting met een melding voor de beheerder.
 * @param {string} message De melding.
 * @param {number} [status] De HTTP-status voor de route (standaard 502).
 * @returns {Error} De fout.
 */
const setupError = (message, status = 502) => Object.assign(new Error(message), { status, setup: true });

/**
 * Maakt de inrichting van Graph-mail.
 * @param {{ fetchImpl?: Function, now?: Function, clientId?: string }} [options] fetchImpl, now en het client-id van de inlog-app (tests).
 * @returns {{ start: Function, poll: Function, cancel: Function, provision: Function }} De functies.
 */
function createGraphSetup({ fetchImpl = fetch, now = Date.now, clientId = process.env.GRAPH_SETUP_CLIENT_ID || DEFAULT_SETUP_CLIENT } = {}) {
  /** Lopende inlogsessies: id → { tenantKey, userId, deviceCode, interval, nextPoll, expiresAt, from }. */
  const sessions = new Map();

  /**
   * Een JSON-verzoek naar Microsoft met time-out.
   * @param {string} url Het adres (alleen vaste Microsoft-hosts).
   * @param {object} init De opties van fetch.
   * @returns {Promise<{ status: number, body: object }>} Status en antwoord.
   */
  async function call(url, init) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch (error) {
      throw setupError('Microsoft is niet bereikbaar vanaf de server. Controleer of de server naar buiten mag verbinden (HTTPS).');
    }
    let body = {};
    try { body = await response.json(); } catch (error) { body = {}; }
    return { status: response.status, body };
  }

  /**
   * Een Graph-aanroep met het token van de beheerder.
   * @param {string} token Het toegangstoken.
   * @param {string} method De methode.
   * @param {string} path Het pad na /v1.0.
   * @param {object} [payload] De JSON-inhoud.
   * @returns {Promise<{ status: number, body: object }>} Status en antwoord.
   */
  const graph = (token, method, path, payload) => call(`${GRAPH}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined,
  });

  /**
   * Meldt een weigering van Graph als leesbare fout, met een hint bij ontbrekende rechten.
   * @param {{ status: number, body: object }} result Het antwoord.
   * @param {string} doing Wat er gebeurde ("de app aanmaken").
   * @returns {void}
   * @throws {Error} Als de status geen succes is.
   */
  function expectOk(result, doing) {
    if (result.status >= 200 && result.status < 300) return;
    const code = result.body && result.body.error && result.body.error.code ? ` (${String(result.body.error.code).slice(0, 60)})` : '';
    if (result.status === 401 || result.status === 403) throw setupError(`Microsoft weigerde ${doing}${code}. Log in met een account met de rol Globale beheerder (of Toepassingsbeheerder met Bevoorrechte-rolbeheerder) en probeer opnieuw, of gebruik het stappenplan.`);
    throw setupError(`Microsoft gaf een fout bij ${doing} (${result.status})${code}.`);
  }

  /**
   * Maakt in de omgeving van de beheerder de app, het geheim en de machtiging aan (of vernieuwt het geheim van de bestaande app).
   * @param {string} token Het token van de ingelogde beheerder.
   * @returns {Promise<{ tenantId: string, clientId: string, secret: string, expiresAt: string, organization: string }>} De gegevens van de nieuwe app.
   */
  async function provision(token) {
    const org = await graph(token, 'GET', '/organization?$select=id,displayName');
    expectOk(org, 'het opvragen van de organisatie');
    const organization = org.body.value && org.body.value[0];
    if (!organization || !validTenantId(organization.id)) throw setupError('Microsoft gaf de organisatie niet terug.');
    const resource = await graph(token, 'GET', `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'&$select=id,appRoles`);
    expectOk(resource, 'het opvragen van Microsoft Graph');
    const graphPrincipal = resource.body.value && resource.body.value[0];
    const role = graphPrincipal && (graphPrincipal.appRoles || []).find((appRole) => appRole.value === 'Mail.Send' && (appRole.allowedMemberTypes || []).includes('Application'));
    if (!role) throw setupError('De machtiging Mail.Send is niet gevonden in deze Microsoft-omgeving.');

    const existing = await graph(token, 'GET', `/applications?$filter=displayName eq '${APP_NAME}'&$select=id,appId`);
    expectOk(existing, 'het zoeken naar de app');
    let application = existing.body.value && existing.body.value[0];
    if (!application) {
      const created = await graph(token, 'POST', '/applications', {
        displayName: APP_NAME, signInAudience: 'AzureADMyOrg',
        requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: role.id, type: 'Role' }] }],
      });
      expectOk(created, 'het aanmaken van de app');
      application = created.body;
    }
    const principals = await graph(token, 'GET', `/servicePrincipals?$filter=appId eq '${application.appId}'&$select=id`);
    expectOk(principals, 'het opvragen van de app-identiteit');
    let principal = principals.body.value && principals.body.value[0];
    if (!principal) {
      const createdPrincipal = await graph(token, 'POST', '/servicePrincipals', { appId: application.appId });
      expectOk(createdPrincipal, 'het aanmaken van de app-identiteit');
      principal = createdPrincipal.body;
    }
    const assignment = await graph(token, 'POST', `/servicePrincipals/${graphPrincipal.id}/appRoleAssignedTo`, { principalId: principal.id, resourceId: graphPrincipal.id, appRoleId: role.id });
    const alreadyAssigned = assignment.status === 400 && /already exists|MultipleObjects/i.test(JSON.stringify(assignment.body));
    if (!alreadyAssigned) expectOk(assignment, 'het verlenen van de machtiging Mail.Send');
    const end = new Date(now());
    end.setMonth(end.getMonth() + SECRET_MONTHS);
    const password = await graph(token, 'POST', `/applications/${application.id}/addPassword`, { passwordCredential: { displayName: `AquaTech Hub ${new Date(now()).toISOString().slice(0, 10)}`, endDateTime: end.toISOString() } });
    expectOk(password, 'het aanmaken van het clientgeheim');
    if (!password.body.secretText) throw setupError('Microsoft gaf het clientgeheim niet terug.');
    return { tenantId: organization.id, clientId: application.appId, secret: password.body.secretText, expiresAt: end.toISOString(), organization: String(organization.displayName || '').slice(0, 100) };
  }

  /**
   * Start de inlog: vraagt Microsoft om een code en een link.
   * @param {{ tenantKey: string, userId: string, from?: string }} owner Van wie de sessie is (omgeving en gebruiker).
   * @returns {Promise<{ id: string, userCode: string, verificationUri: string, expiresIn: number, interval: number }>} Wat de beheerder moet doen.
   */
  async function start({ tenantKey, userId, from = '' }) {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
    const { status, body } = await call(`${LOGIN}/devicecode`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, scope: SCOPES }).toString(),
    });
    if (status !== 200 || !body.device_code || !body.user_code) throw setupError('Microsoft gaf geen inlogcode. Gebruik het stappenplan.');
    const id = crypto.randomBytes(16).toString('hex');
    const interval = Math.max(5, Number(body.interval) || 5);
    sessions.set(id, { tenantKey, userId, from, deviceCode: body.device_code, interval, nextPoll: 0, expiresAt: now() + Math.min(SESSION_MS, (Number(body.expires_in) || 900) * 1000) });
    return { id, userCode: String(body.user_code), verificationUri: String(body.verification_uri || 'https://microsoft.com/devicelogin'), expiresIn: Math.round((sessions.get(id).expiresAt - now()) / 1000), interval };
  }

  /**
   * Vraagt één keer of de beheerder is ingelogd; zo ja, richt alles in.
   * @param {{ id: string, tenantKey: string, userId: string }} query De sessie en wie vraagt.
   * @returns {Promise<{ status: string, result?: object, message?: string }>} pending, done (met result), expired of denied.
   */
  async function poll({ id, tenantKey, userId }) {
    const session = sessions.get(id);
    if (!session || session.tenantKey !== tenantKey || session.userId !== userId) return { status: 'expired', message: 'De inlogsessie bestaat niet meer. Start opnieuw.' };
    if (session.expiresAt <= now()) { sessions.delete(id); return { status: 'expired', message: 'De code is verlopen. Start opnieuw.' }; }
    if (session.nextPoll > now()) return { status: 'pending' };
    session.nextPoll = now() + session.interval * 1000;
    const { status, body } = await call(`${LOGIN}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: session.deviceCode }).toString(),
    });
    if (status !== 200) {
      const code = String(body && body.error || '');
      if (code === 'authorization_pending') return { status: 'pending' };
      if (code === 'slow_down') { session.interval += 5; session.nextPoll = now() + session.interval * 1000; return { status: 'pending' }; }
      sessions.delete(id);
      if (code === 'authorization_declined') return { status: 'denied', message: 'De inlog is geweigerd.' };
      if (code === 'expired_token') return { status: 'expired', message: 'De code is verlopen. Start opnieuw.' };
      return { status: 'denied', message: 'Microsoft weigerde de inlog (zie het stappenplan voor een handmatige inrichting).' };
    }
    sessions.delete(id);
    const result = await provision(body.access_token);
    return { status: 'done', result: { ...result, from: session.from } };
  }

  /**
   * Breekt een inlogsessie af.
   * @param {{ id: string, tenantKey: string, userId: string }} query De sessie en wie vraagt.
   * @returns {void}
   */
  function cancel({ id, tenantKey, userId }) {
    const session = sessions.get(id);
    if (session && session.tenantKey === tenantKey && session.userId === userId) sessions.delete(id);
  }

  return { start, poll, cancel, provision };
}

/**
 * Registreert de routes van de automatische Graph-inrichting onder /api/admin/mail/graph-setup. Het geheim van de nieuwe
 * app gaat rechtstreeks in de (versleutelde) instellingen; naar de browser gaan alleen tenant-ID, client-ID en vervaldatum.
 * @param {import('express').Express} app De app.
 * @param {{ setup: object, settingsFor: Function, requireAdmin: Function, audit: Function }} deps De inrichting, de instellingen per omgeving, de rechtencontrole en het auditlog.
 * @returns {void}
 */
function registerGraphSetupRoutes(app, { setup, settingsFor, requireAdmin, audit }) {
  const BASE = '/api/admin/mail/graph-setup';
  const startLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `graph-setup:${req.user ? req.user.id : ''}` });
  const pollLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyFn: (req) => `graph-setup-poll:${req.user ? req.user.id : ''}` });
  /**
   * Van wie een inlogsessie is: de omgeving en de gebruiker uit de sessie, nooit uit de invoer.
   * @param {object} req Het verzoek.
   * @returns {{ tenantKey: string, userId: string }} De eigenaar.
   */
  const owner = (req) => ({ tenantKey: String(req.tenantId), userId: String(req.user && req.user.id) });

  app.post(BASE, requireAdmin, startLimiter, express.json({ limit: '2kb' }), async (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from.trim().slice(0, 200) : '';
    try {
      res.json(await setup.start({ ...owner(req), from }));
    } catch (error) {
      if (!error.setup) throw error;
      return withCause(res, error).status(error.status).json({ error: 'graph_setup_failed', message: error.message });
    }
  });

  app.get(`${BASE}/:id`, requireAdmin, pollLimiter, async (req, res) => {
    try {
      const outcome = await setup.poll({ id: String(req.params.id), ...owner(req) });
      if (outcome.status !== 'done') return res.json({ status: outcome.status, message: outcome.message });
      const settings = settingsFor(req.tenantId);
      const current = settings.get('mailServer');
      settings.update({
        mailServer: { ...current, mode: 'graph', graphTenantId: outcome.result.tenantId, graphClientId: outcome.result.clientId, graphSecretExpires: outcome.result.expiresAt.slice(0, 10), from: outcome.result.from || current.from },
        mailGraphSecret: outcome.result.secret,
      }, req.user?.id);
      audit(req, 'mail_graph_ingericht', { organization: outcome.result.organization, clientId: outcome.result.clientId });
      res.json({ status: 'done', tenantId: outcome.result.tenantId, clientId: outcome.result.clientId, expiresAt: outcome.result.expiresAt, organization: outcome.result.organization });
    } catch (error) {
      if (!error.setup) throw error;
      return withCause(res, error).status(error.status).json({ error: 'graph_setup_failed', message: error.message });
    }
  });

  app.delete(`${BASE}/:id`, requireAdmin, (req, res) => {
    setup.cancel({ id: String(req.params.id), ...owner(req) });
    res.json({ ok: true });
  });
}

module.exports = { createGraphSetup, registerGraphSetupRoutes, APP_NAME };
