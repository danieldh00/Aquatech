// E-mail versturen via de eigen SMTP-server van de organisatie (instellingen
// mailServer + het versleutelde mailPassword, per tenant). Zonder ingestelde
// server stuurt de app niets; de offertemodule biedt dan een link om zelf te
// versturen. nodemailer is puur JavaScript (geen native module).
const nodemailer = require('nodemailer');
const { publicAddress, privateAllowed } = require('../beveiliging/netguard');

const MAIL_TEXT = { host: 200, user: 200, from: 200, replyTo: 200 };
// mode: 'smtp' = inloggen met gebruikersnaam en wachtwoord; 'connector' =
// Exchange Online-connector op IP-basis (poort 25, geen inlog, TLS verplicht).
const MAIL_DEFAULTS = { mode: 'smtp', host: '', port: 587, secure: false, user: '', from: '', replyTo: '' };

/**
 * Schoont de gegevens van de mailserver op (zonder wachtwoord; dat is een eigen
 * geheim). Afzender en antwoordadres zonder regeleinden (geen kop-injectie).
 * @param {object} raw De ruwe invoer.
 * @returns {{ mode: string, host: string, port: number, secure: boolean, user: string, from: string, replyTo: string }} De opgeschoonde instellingen.
 */
function sanitizeMail(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [field, maxLength] of Object.entries(MAIL_TEXT)) out[field] = typeof input[field] === 'string' ? input[field].trim().slice(0, maxLength) : MAIL_DEFAULTS[field];
  const port = Number(input.port);
  out.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : MAIL_DEFAULTS.port;
  out.secure = input.secure === true || input.secure === 'true';
  out.mode = input.mode === 'connector' ? 'connector' : 'smtp';
  if (out.mode === 'connector') out.user = '';
  // Geen kop-injectie via afzender of antwoordadres.
  for (const field of ['from', 'replyTo']) out[field] = out[field].replace(/[\r\n]/g, '');
  return out;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/**
 * Of een waarde een bruikbaar e-mailadres is.
 * @param {*} value De waarde.
 * @returns {boolean} true bij een geldig e-mailadres (hoogstens 200 tekens).
 */
const validEmail = (value) => typeof value === 'string' && value.length <= 200 && EMAIL.test(value.trim());

/**
 * Maakt de mailer van een tenant. De mailserver moet een openbaar adres hebben
 * (zie netguard.js); er wordt verbonden met het gevonden adres, het certificaat
 * blijft op naam gecontroleerd.
 * @param {object} settings Instellingen van de tenant (mailServer en mailPassword).
 * @param {object} [options] createTransport en resolveHost, te vervangen in tests.
 * @returns {{ configured: Function, send: Function, config: Function }} De mailfuncties.
 */
function createMailer(settings, { createTransport = nodemailer.createTransport, resolveHost = publicAddress } = {}) {
  /**
   * De ingestelde mailserver.
   * @returns {object} De instelling mailServer.
   */
  const config = () => settings.get('mailServer');
  /**
   * Of er een mailserver is ingesteld (host en afzender).
   * @returns {boolean} true als er gemaild kan worden.
   */
  const configured = () => {
    const server = config();
    return Boolean(server.host && server.from);
  };
  /**
   * Verstuurt een e-mail via de mailserver van de tenant.
   * @param {{ to: string|string[], subject: string, text?: string, html?: string, replyTo?: string, bcc?: string, attachments?: object[] }} message Het bericht; attachments: [{ filename, content (Buffer), contentType }], hoogstens 5.
   * @returns {Promise<object>} Het resultaat van nodemailer.
   * @throws {Error} Met code not_configured, invalid_to of invalid_host.
   */
  async function send({ to, subject, text, html, replyTo, bcc, attachments }) {
    if (!configured()) throw Object.assign(new Error('Er is geen mailserver ingesteld.'), { code: 'not_configured' });
    const list = (Array.isArray(to) ? to : [to]).filter(validEmail);
    if (!list.length) throw Object.assign(new Error('Geen geldig e-mailadres.'), { code: 'invalid_to' });
    const server = config();
    const password = settings.get('mailPassword');
    let address = server.host;
    if (!privateAllowed()) {
      try {
        address = await resolveHost(server.host);
      } catch (err) {
        throw Object.assign(new Error(err.code === 'private_host' ? 'De mailserver moet een openbaar adres hebben.' : 'De mailserver is niet gevonden.'), { code: 'invalid_host' });
      }
    }
    const transport = createTransport({
      host: address, servername: server.host, port: server.port, secure: server.secure,
      auth: server.mode !== 'connector' && server.user ? { user: server.user, pass: password } : undefined,
      // De connector herkent de server aan zijn IP; dan moet STARTTLS wel lukken.
      requireTLS: server.mode === 'connector' && !server.secure ? true : undefined,
      // Nooit zonder geldig certificaat; de verbinding loopt niet eindeloos.
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    return transport.sendMail({
      from: server.from, to: list.join(', '), bcc: bcc && validEmail(bcc) ? bcc.trim() : undefined, replyTo: replyTo && validEmail(replyTo) ? replyTo : server.replyTo || undefined,
      subject: String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 300), text, html,
      attachments: Array.isArray(attachments) && attachments.length ? attachments.slice(0, 5).map((attachment) => ({
        filename: String(attachment.filename || 'bijlage').replace(/[\r\n"\\/]/g, '').slice(0, 120), content: attachment.content, contentType: attachment.contentType,
      })) : undefined,
    });
  }
  return { configured, send, config };
}

module.exports = { createMailer, sanitizeMail, validEmail, MAIL_DEFAULTS };
