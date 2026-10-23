'use strict';

// Tekening indienen en plannen controleren.
//
// - Openbaar (zonder inloggen): de planner draait in de browser van de klant
//   (beregening/?tekenen); pas bij indienen gaat er één verzoek naar de
//   server, met contactgegevens en een vraag. Het plan komt ter controle bij
//   de organisatie van de organisatiecode (instelling drawingRequests).
// - Ingelogd: een klant biedt een eigen plan ter controle aan; een
//   installateur (recht plannen.goedkeuren) keurt goed of trekt dat in.
//   Een plan van een klant is nooit meteen definitief.

const { createMailer, validEmail } = require('../platform/mailer');
const { mailBody } = require('../verkoop/quotes');
const { createRateLimiter } = require('../beveiliging/rate-limit');

const LIMITS = { name: 80, email: 120, phone: 30, address: 300, question: 2000 };
// Grootste plan (met foto of PDF van de tekening als achtergrond) in tekens JSON.
const MAX_PLAN_CHARS = 7 * 1024 * 1024;
const PER_IP_HOUR = 10;
const PER_TENANT_DAY = 30;

/**
 * Maakt van een invoerwaarde nette tekst: zonder stuurtekens, getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De opgeschoonde tekst.
 */
const text = (value, maxLength) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength);

/**
 * Controleert en schoont de invoer van het indienformulier op.
 * @param {object} body De body van het verzoek (naam, e-mail, telefoon, adres, vraag, toestemming en het plan).
 * @returns {{ value: object }|{ error: string }} De opgeschoonde aanvraag, of een foutmelding voor de indiener.
 */
function sanitizeSubmission(body) {
  const fields = body && typeof body === 'object' ? body : {};
  const out = {
    name: text(fields.name, LIMITS.name),
    email: text(fields.email, LIMITS.email).toLowerCase(),
    phone: text(fields.phone, LIMITS.phone),
    address: text(fields.address, LIMITS.address),
    question: text(fields.question, LIMITS.question),
  };
  if (out.name.length < 2) return { error: 'Vul je naam in.' };
  if (!validEmail(out.email)) return { error: 'Vul een geldig e-mailadres in.' };
  if (out.phone && !/^[+0-9 ()./-]{6,30}$/.test(out.phone)) return { error: 'Ongeldig telefoonnummer.' };
  if (fields.consent !== true) return { error: 'Geef toestemming om je gegevens te gebruiken voor deze aanvraag.' };
  const data = fields.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.areas)) return { error: 'Ongeldige tekening.' };
  if (!data.areas.length) return { error: 'Teken eerst minstens één vlak van je tuin.' };
  // Interne velden van de planner gaan niet mee.
  const { serverId, calc, ...plan } = data;
  return { value: { ...out, data: plan } };
}

/**
 * Registreert de routes voor tekeningen indienen en plannen controleren.
 * @param {object} app De Express-app.
 * @param {object} ctx store, identify, requirePlans (gebruiker met het recht plannen), requireRight, requireJson, audit, settingsFor(tenantId), tenantActive(id), mailerFor(settings), remoteIp, publicLimiter en planLimiter.
 */
function registerDrawingRoutes(app, ctx) {
  const { store, identify, requirePlans, requireRight, requireJson, audit, settingsFor, remoteIp, publicLimiter } = ctx;
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const planLimiter = ctx.planLimiter || ((req, res, next) => next());
  const ipLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: PER_IP_HOUR, keyFn: remoteIp });
  const tenantLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: PER_TENANT_DAY, keyFn: (req) => req.drawingTenant });
  /**
   * Stuurt het antwoord 404 "plan niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Plan niet gevonden.' });

  /**
   * De organisatie bij een organisatiecode (leeg = hoofdtenant). Ook een
   * testomgeving kan tekeningen ontvangen (om te proberen); een uitgeschakelde
   * organisatie of een met de instelling uit niet.
   * @param {string} code De organisatiecode.
   * @returns {{ tenant: object, settings: object }|null} Tenant en instellingen, of null.
   */
  function drawingTenant(code) {
    const slug = String(code ?? '').trim().toLowerCase().slice(0, 64);
    const tenant = store.getTenantBySlug(slug || 'default');
    if (!tenant || !tenantActive(tenant.id)) return null;
    const settings = settingsFor(tenant.id);
    if (!settings.get('drawingRequests')) return null;
    return { tenant: tenant, settings };
  }

  app.get('/api/public/drawing', publicLimiter, (req, res) => {
    const found = drawingTenant(req.query.org);
    if (!found) return res.json({ enabled: false });
    res.json({ enabled: true, company: found.settings.get('quoteProfile').companyName || found.tenant.name, limits: LIMITS });
  });

  app.post('/api/public/drawing', requireJson, ipLimiter, (req, res) => {
    const body = req.body || {};
    // Honeypot: een verborgen veld dat alleen bots invullen. Zelfde antwoord
    // als bij succes, zodat een bot niet leert dat hij is herkend.
    if (text(body.website, 200)) return res.status(201).json({ ok: true, reference: 'ONTVANGEN' });
    const found = drawingTenant(body.org);
    if (!found) return res.status(404).json({ error: 'not_available', message: 'Bij deze organisatie kun je (nog) geen tekening indienen.' });
    const input = sanitizeSubmission(body);
    if (input.error) return res.status(400).json({ error: 'invalid', message: input.error });
    if (JSON.stringify(input.value.data).length > MAX_PLAN_CHARS) return res.status(413).json({ error: 'too_large', message: 'De tekening is te groot (maximaal 7 MB, inclusief de achtergrond).' });
    req.drawingTenant = found.tenant.id;
    let allowed = false;
    tenantLimiter(req, res, () => { allowed = true; });
    if (!allowed) return;
    const plan = store.submitDrawing(found.tenant.id, { ...input.value, ip: remoteIp(req) });
    // Geen persoonsgegevens in het auditlog.
    audit(req, 'tekening_ingediend', { planId: plan.id, via: 'openbaar' }, null, found.tenant.id);
    notify(found.tenant.id, [
      `${input.value.name} heeft zonder account een tekening ingediend en vraagt om een controle.`,
      `Plan: ${plan.title} (referentie ${plan.reference})`,
      `E-mail: ${input.value.email}${input.value.phone ? `\nTelefoon: ${input.value.phone}` : ''}${input.value.address ? `\nAdres: ${input.value.address}` : ''}`,
      input.value.question ? `Vraag: ${input.value.question}` : '',
      'Je vindt de tekening in het Plannenoverzicht onder "Ter controle".',
    ], `Tekening ter controle: ${plan.title}`);
    res.status(201).json({ ok: true, reference: plan.reference });
  });

  /**
   * Stuurt een bericht naar het bedrijf (e-mail uit het bedrijfsprofiel), als
   * er een mailserver is. Nooit een mail naar het opgegeven adres van de
   * indiener: dan kon iedereen via dit formulier mail naar willekeurige adressen sturen.
   * @param {string} tenantId Id van de tenant.
   * @param {string[]} lines De regels van het bericht (lege regels vallen weg).
   * @param {string} subject Het onderwerp.
   */
  function notify(tenantId, lines, subject) {
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    const profile = settings.get('quoteProfile');
    if (!mailer.configured() || !validEmail(profile.email)) return;
    mailer.send({ to: profile.email, subject, ...mailBody(profile, lines, null) })
      .catch((err) => console.warn(`Bericht over een tekening ter controle niet verstuurd: ${err.message}`));
  }

  // Eigen plan ter controle aanbieden (klant, of een medewerker namens hem).
  app.post('/api/plans/:id/review-request', requireJson, requirePlans, planLimiter, (req, res) => {
    const review = store.requestReview(req.user, req.params.id, text(req.body?.question, LIMITS.question));
    if (!review) return notFound(res);
    audit(req, 'plan_ter_controle', { planId: req.params.id });
    if (!ctx.canApprove(req.user)) {
      notify(req.tenantId, [
        `${req.user.display_name} vraagt om een controle van een plan.`,
        review.question ? `Vraag: ${review.question}` : '',
        'Je vindt het plan in het Plannenoverzicht onder "Ter controle".',
      ], 'Plan ter controle');
    }
    res.json({ review });
  });

  // Goedkeuren (action 'approve') of de goedkeuring intrekken ('reopen').
  app.post('/api/plans/:id/review', requireJson, requireRight('plannen.goedkeuren'), (req, res) => {
    const action = req.body?.action;
    if (action !== 'approve' && action !== 'reopen') return res.status(400).json({ error: 'invalid_action', message: 'Ongeldige actie.' });
    const user = identify(req);
    const review = store.reviewPlan(user, req.params.id, action);
    if (!review) return notFound(res);
    audit(req, action === 'approve' ? 'plan_goedgekeurd' : 'plan_heropend', { planId: req.params.id });
    res.json({ review });
  });
}

module.exports = { registerDrawingRoutes, sanitizeSubmission, LIMITS, MAX_PLAN_CHARS, PER_IP_HOUR, PER_TENANT_DAY };
