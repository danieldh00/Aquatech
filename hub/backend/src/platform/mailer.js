// E-mail versturen via de eigen SMTP-server van de organisatie (instellingen
// mailServer + het versleutelde mailPassword, per tenant). Zonder ingestelde
// server stuurt de app niets; de offertemodule biedt dan een link om zelf te
// versturen. nodemailer is puur JavaScript (geen native module).
const { domainToASCII } = require('node:url');
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

/** Lokaal deel: geen spaties, @ of tekens die een adreslijst of kop kunnen breken. */
const EMAIL_LOCAL = /^[^\s@<>()",;:]+$/;
/** Domeinlabel in ASCII (na omzetting van internationale namen): begint en eindigt met letter of cijfer. */
const EMAIL_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/**
 * Of een waarde een bruikbaar e-mailadres is. Het domein wordt eerst naar zijn
 * ASCII-vorm (punycode) omgezet, zodat ook internationale domeinnamen kloppen.
 * @param {*} value De waarde.
 * @returns {boolean} true bij een geldig e-mailadres (hoogstens 200 tekens).
 */
const validEmail = (value) => {
  if (typeof value !== 'string' || value.length > 200) return false;
  const address = value.trim();
  const at = address.lastIndexOf('@');
  if (at < 1 || !EMAIL_LOCAL.test(address.slice(0, at))) return false;
  const domain = domainToASCII(address.slice(at + 1));
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => EMAIL_LABEL.test(label));
};

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
      // Zonder SSL/TLS (465) moet STARTTLS lukken: nooit wachtwoord of mail
      // onversleuteld versturen als een tussenpersoon STARTTLS weglaat.
      requireTLS: !server.secure ? true : undefined,
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

/**
 * Het antwoord van de mailserver uit een nodemailer-fout, zonder regeleinden en ingekort (bijv. "535 5.7.3
 * Authentication unsuccessful"). Bevat geen wachtwoord: de server herhaalt dat niet.
 * @param {Error & { response?: string }} error De fout.
 * @returns {string} Het antwoord, of '' als er geen is.
 */
const serverReply = (error) => String(error && error.response || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Zet een fout van send() om in een melding waar de gebruiker iets mee kan: wat er misging en waar het meestal aan
 * ligt. Eigen fouten van send() (not_configured, invalid_to, invalid_host) zijn al leesbaar. Het ruwe antwoord van de
 * mailserver staat erbij als die er is. De oorzaak (code en melding, nooit het wachtwoord) gaat altijd naar het
 * serverlog; met withCause ook naar de debugmodus.
 * @param {Error & { code?: string, command?: string, responseCode?: number, response?: string }} error De fout van send().
 * @returns {string} De melding, beginnend met "Versturen mislukt:".
 */
function mailFailure(error) {
  const code = String(error && error.code || '');
  const reply = serverReply(error);
  // Eén plek voor het log, zodat elke aanroeper (offerte, afspraak, factuur, webshop) de oorzaak terugvindt.
  console.warn('[mail] Versturen mislukt:', code || '(geen code)', String(error && error.message || error).slice(0, 300));
  /**
   * De melding met het antwoord van de mailserver erachter (als die er is).
   * @param {string} text Wat er misging en wat te controleren.
   * @returns {string} De volledige melding.
   */
  const withReply = (text) => `Versturen mislukt: ${text}${reply ? ` (mailserver: ${reply})` : ''}`;
  if (['not_configured', 'invalid_to', 'invalid_host'].includes(code)) return `Versturen mislukt: ${error.message}`;
  // Geen code en geen antwoord: geen fout van de mailserver maar van de app (bijv. bij het opbouwen van de mail).
  if (!code && !reply) return 'Versturen mislukt door een interne fout; de oorzaak staat in het serverlog.';
  const connectionProblem = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(code);
  if (code === 'EAUTH') return withReply('de mailserver weigert de inloggegevens. Controleer gebruikersnaam en wachtwoord (bij Microsoft 365 of Gmail vaak een app-wachtwoord) in Beheer → Integraties → E-mail.');
  // Eerst TLS: een certificaatfout komt van nodemailer vaak als ESOCKET, maar de oplossing is een andere. Alleen bij
  // verbindingsfouten op de tekst letten: een weigering door de server (EAUTH, EENVELOPE, EMESSAGE) houdt zijn eigen melding.
  // Een TLS-fout kan ook een eigen code van Node hebben (bijv. SELF_SIGNED_CERT_IN_CHAIN, UNABLE_TO_VERIFY_LEAF_SIGNATURE).
  const tlsCode = code === 'ETLS' || /CERT|SIGNED|UNABLE_TO_VERIFY|TLS|SSL/.test(code);
  if (tlsCode || (connectionProblem && /certificate|self.signed|TLS|SSL/i.test(String(error && error.message || '')))) {
    return withReply('de beveiligde verbinding (TLS) met de mailserver lukt niet. Controleer de poort en de instelling SSL/TLS; een ongeldig certificaat wordt niet geaccepteerd.');
  }
  if (connectionProblem) {
    return withReply('de mailserver is niet bereikbaar. Controleer server en poort (587 met STARTTLS of 465 met SSL/TLS) en of de server naar buiten mag verbinden.');
  }
  if (code === 'EENVELOPE') {
    return withReply(error.command === 'MAIL FROM'
      ? 'de mailserver weigert het afzenderadres. Gebruik een afzender waarvoor deze mailserver mag versturen.'
      : 'de mailserver weigert het adres van de ontvanger.');
  }
  if (code === 'EMESSAGE') return withReply('de mailserver weigert het bericht (bijvoorbeeld te groot of als spam gezien).');
  return withReply('de mailserver gaf een fout.');
}

// Melding als de mailinstellingen zelf niet te lezen zijn (een interne fout: de oorzaak gaat naar het serverlog).
const MAIL_SETUP_FAILED = 'Versturen mislukt: de mailinstellingen konden niet worden gelezen.';

module.exports = { createMailer, sanitizeMail, validEmail, mailFailure, MAIL_SETUP_FAILED, MAIL_DEFAULTS };
