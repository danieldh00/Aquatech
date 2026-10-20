// E-mail versturen via de eigen SMTP-server van de organisatie (instellingen
// mailServer + het versleutelde mailPassword, per tenant). Zonder ingestelde
// server stuurt de app niets; de offertemodule biedt dan een link om zelf te
// versturen. nodemailer is puur JavaScript (geen native module).
const nodemailer = require('nodemailer');
const { publicAddress, privateAllowed } = require('./netguard');

const MAIL_TEXT = { host: 200, user: 200, from: 200, replyTo: 200 };
const MAIL_DEFAULTS = { host: '', port: 587, secure: false, user: '', from: '', replyTo: '' };

/** Schoont de servergegevens op (zonder wachtwoord; dat is een eigen geheim). */
function sanitizeMail(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, max] of Object.entries(MAIL_TEXT)) out[k] = typeof r[k] === 'string' ? r[k].trim().slice(0, max) : MAIL_DEFAULTS[k];
  const port = Number(r.port);
  out.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : MAIL_DEFAULTS.port;
  out.secure = r.secure === true || r.secure === 'true';
  // Geen kop-injectie via afzender of antwoordadres.
  for (const k of ['from', 'replyTo']) out[k] = out[k].replace(/[\r\n]/g, '');
  return out;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const validEmail = (v) => typeof v === 'string' && v.length <= 200 && EMAIL.test(v.trim());

/**
 * settings: instellingen van de tenant. createTransport en resolveHost zijn te
 * vervangen in tests. Geeft { configured(), send({ to, subject, text, html, replyTo }) }.
 * resolveHost: de mailserver moet een openbaar adres hebben (zie netguard.js);
 * er wordt verbonden met het gevonden adres, het certificaat blijft op naam gecontroleerd.
 */
function createMailer(settings, { createTransport = nodemailer.createTransport, resolveHost = publicAddress } = {}) {
  const config = () => settings.get('mailServer');
  const configured = () => {
    const c = config();
    return Boolean(c.host && c.from);
  };
  async function send({ to, subject, text, html, replyTo, bcc }) {
    if (!configured()) throw Object.assign(new Error('Er is geen mailserver ingesteld.'), { code: 'not_configured' });
    const list = (Array.isArray(to) ? to : [to]).filter(validEmail);
    if (!list.length) throw Object.assign(new Error('Geen geldig e-mailadres.'), { code: 'invalid_to' });
    const c = config();
    const password = settings.get('mailPassword');
    let address = c.host;
    if (!privateAllowed()) {
      try {
        address = await resolveHost(c.host);
      } catch (err) {
        throw Object.assign(new Error(err.code === 'private_host' ? 'De mailserver moet een openbaar adres hebben.' : 'De mailserver is niet gevonden.'), { code: 'invalid_host' });
      }
    }
    const transport = createTransport({
      host: address, servername: c.host, port: c.port, secure: c.secure,
      auth: c.user ? { user: c.user, pass: password } : undefined,
      // Nooit zonder geldig certificaat; de verbinding loopt niet eindeloos.
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    return transport.sendMail({
      from: c.from, to: list.join(', '), bcc: bcc && validEmail(bcc) ? bcc.trim() : undefined, replyTo: replyTo && validEmail(replyTo) ? replyTo : c.replyTo || undefined,
      subject: String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 300), text, html,
    });
  }
  return { configured, send, config };
}

module.exports = { createMailer, sanitizeMail, validEmail, MAIL_DEFAULTS };
