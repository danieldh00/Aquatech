// E-mail versturen via de eigen SMTP-server van de organisatie (instellingen
// mailServer + het versleutelde mailPassword, per tenant). Zonder ingestelde
// server stuurt de app niets; de offertemodule biedt dan een link om zelf te
// versturen. nodemailer is puur JavaScript (geen native module).
const { domainToASCII } = require('node:url');
const nodemailer = require('nodemailer');
const { publicAddress, privateAllowed } = require('../beveiliging/netguard');
const { createGraphSender, parseSender, validTenantId, validClientId } = require('./mail-graph');

const MAIL_TEXT = { host: 200, user: 200, from: 200, replyTo: 200 };
// mode: 'smtp' = inloggen met gebruikersnaam en wachtwoord; 'connector' =
// Exchange Online-connector op IP-basis (poort 25, geen inlog, TLS verplicht); 'graph' = Microsoft Graph (HTTPS, app-registratie
// in Entra; het clientgeheim staat apart en versleuteld in mailGraphSecret).
const MAIL_DEFAULTS = { mode: 'smtp', host: '', port: 587, secure: false, user: '', from: '', replyTo: '', graphTenantId: '', graphClientId: '' };

/**
 * Schoont de gegevens van de mailserver op (zonder wachtwoord; dat is een eigen
 * geheim). Afzender en antwoordadres zonder regeleinden (geen kop-injectie).
 * @param {object} raw De ruwe invoer.
 * @returns {{ mode: string, host: string, port: number, secure: boolean, user: string, from: string, replyTo: string, graphTenantId: string, graphClientId: string }} De opgeschoonde instellingen.
 */
function sanitizeMail(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [field, maxLength] of Object.entries(MAIL_TEXT)) out[field] = typeof input[field] === 'string' ? input[field].trim().slice(0, maxLength) : MAIL_DEFAULTS[field];
  const port = Number(input.port);
  out.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : MAIL_DEFAULTS.port;
  out.secure = input.secure === true || input.secure === 'true';
  out.mode = ['connector', 'graph'].includes(input.mode) ? input.mode : 'smtp';
  if (out.mode !== 'smtp') out.user = '';
  const graphTenantId = typeof input.graphTenantId === 'string' ? input.graphTenantId.trim() : '';
  const graphClientId = typeof input.graphClientId === 'string' ? input.graphClientId.trim() : '';
  out.graphTenantId = validTenantId(graphTenantId) ? graphTenantId : '';
  out.graphClientId = validClientId(graphClientId) ? graphClientId : '';
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
 * Zet ingebedde PNG-afbeeldingen (data-adressen, zoals het logo in de mailopmaak) om in bijlagen die de HTML met cid: aanroept:
 * mailprogramma's tonen een data-adres vaak niet, een ingebedde bijlage wel.
 * @param {string} [html] De HTML van de mail.
 * @returns {{ html: string|undefined, attachments: object[] }} De HTML met cid-adressen en de bijlagen (hoogstens 2 afbeeldingen).
 */
function inlineImages(html) {
  if (typeof html !== 'string') return { html, attachments: [] };
  const attachments = [];
  const known = new Map();
  const converted = html.replace(/src="data:image\/png;base64,([A-Za-z0-9+/]+={0,2})"/g, (match, data) => {
    if (!known.has(data)) {
      if (known.size >= 2) return match;
      const cid = `afbeelding${known.size + 1}@aquatech`;
      known.set(data, cid);
      attachments.push({ filename: `afbeelding${known.size}.png`, content: Buffer.from(data, 'base64'), contentType: 'image/png', cid, contentDisposition: 'inline' });
    }
    return `src="cid:${known.get(data)}"`;
  });
  return { html: converted, attachments };
}

/**
 * Legt vast bij welke mailserver (host, poort, beveiliging) een fout hoort, zodat de melding aan de gebruiker die
 * kan noemen. Het wachtwoord komt hier nooit in.
 * @param {Error} error De fout van nodemailer.
 * @param {{ host: string, port: number, secure: boolean }} server De instelling mailServer.
 * @returns {Error} Dezelfde fout, met mailHost, mailPort en mailSecure.
 */
function tagServer(error, server) {
  if (error && typeof error === 'object' && !error.mailHost) Object.assign(error, { mailHost: server.host, mailPort: server.port, mailSecure: Boolean(server.secure) });
  return error;
}

/**
 * Maakt de mailer van een tenant. De mailserver moet een openbaar adres hebben
 * (zie netguard.js); er wordt verbonden met het gevonden adres, het certificaat
 * blijft op naam gecontroleerd.
 * @param {object} settings Instellingen van de tenant (mailServer en mailPassword).
 * @param {object} [options] createTransport, resolveHost en fetchImpl (voor Graph), te vervangen in tests.
 * @returns {{ configured: Function, send: Function, verify: Function, config: Function }} De mailfuncties.
 */
function createMailer(settings, { createTransport = nodemailer.createTransport, resolveHost = publicAddress, fetchImpl } = {}) {
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
    if (server.mode === 'graph') return Boolean(server.graphTenantId && server.graphClientId && parseSender(server.from).address && settings.get('mailGraphSecret'));
    return Boolean(server.host && server.from);
  };
  /**
   * De Graph-verzender met de ingestelde app-gegevens.
   * @returns {{ send: Function, verify: Function }} De functies van createGraphSender.
   */
  const graphSender = () => {
    const server = config();
    return createGraphSender({ tenantId: server.graphTenantId, clientId: server.graphClientId, clientSecret: settings.get('mailGraphSecret'), from: server.from }, fetchImpl ? { fetchImpl } : {});
  };
  /**
   * Maakt de verbinding (transport) met de ingestelde mailserver. De server moet een openbaar adres hebben; er wordt
   * verbonden met het gevonden adres, het certificaat blijft op naam gecontroleerd.
   * @returns {Promise<{ transport: object, server: object }>} Het transport van nodemailer en de instelling mailServer.
   * @throws {Error} Met code invalid_host.
   */
  async function openTransport() {
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
    return { transport, server };
  }
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
    const inline = inlineImages(html);
    if (config().mode === 'graph') {
      return graphSender().send({
        to: list, bcc: bcc && validEmail(bcc) ? bcc.trim() : undefined, replyTo: replyTo && validEmail(replyTo) ? replyTo : config().replyTo || undefined,
        subject: String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 300), text, html: inline.html,
        attachments: (Array.isArray(attachments) ? attachments.slice(0, 5) : []).map((attachment) => ({
          filename: String(attachment.filename || 'bijlage').replace(/[\r\n"\\/]/g, '').slice(0, 120), content: attachment.content, contentType: attachment.contentType,
        })).concat(inline.attachments),
      });
    }
    const { transport, server } = await openTransport();
    try {
      return await transport.sendMail({
        from: server.from, to: list.join(', '), bcc: bcc && validEmail(bcc) ? bcc.trim() : undefined, replyTo: replyTo && validEmail(replyTo) ? replyTo : server.replyTo || undefined,
        subject: String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 300), text, html: inline.html,
        attachments: Array.isArray(attachments) && attachments.length ? attachments.slice(0, 5).map((attachment) => ({
          filename: String(attachment.filename || 'bijlage').replace(/[\r\n"\\/]/g, '').slice(0, 120), content: attachment.content, contentType: attachment.contentType,
        })).concat(inline.attachments) : (inline.attachments.length ? inline.attachments : undefined),
      });
    } catch (error) {
      throw tagServer(error, server);
    }
  }
  /**
   * Controleert of de mailserver bereikbaar is en de inloggegevens accepteert, zonder iets te versturen (SMTP-verify
   * van nodemailer). Voor de bewaking (platform/monitoring-checks.js).
   * @returns {Promise<true>} true als de server de verbinding en de aanmelding accepteert.
   * @throws {Error} Met code not_configured of invalid_host, of de fout van nodemailer (zie mailFailure).
   */
  async function verify() {
    if (!configured()) throw Object.assign(new Error('Er is geen mailserver ingesteld.'), { code: 'not_configured' });
    if (config().mode === 'graph') return graphSender().verify();
    const { transport, server } = await openTransport();
    try {
      await transport.verify();
      return true;
    } catch (error) {
      throw tagServer(error, server);
    } finally {
      if (typeof transport.close === 'function') transport.close();
    }
  }
  return { configured, send, verify, config };
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
  if (code === 'EGRAPH_AUTH') return withReply('Microsoft weigert de aanmelding van de app. Controleer tenant-ID, client-ID en het clientgeheim (een geheim verloopt; maak zo nodig een nieuw geheim aan in Entra).');
  if (code === 'EGRAPH_DENIED') return withReply('Microsoft weigert de app toegang tot de mailbox. Controleer of de machtiging Mail.Send (toepassing) is verleend met beheerderstoestemming en of een Application Access Policy deze mailbox toestaat.');
  if (code === 'EGRAPH_MAILBOX') return withReply('de afzender-mailbox is niet gevonden of heeft geen Exchange Online-mailbox. Gebruik het volledige e-mailadres van een bestaande mailbox als afzender.');
  if (code === 'EGRAPH_THROTTLED') return withReply('Microsoft beperkt het versturen even (te veel berichten). Probeer het later opnieuw.');
  if (code === 'EGRAPH_SIZE') return 'Versturen mislukt: een bijlage is te groot voor verzenden via Microsoft Graph (hoogstens 3 MB per bijlage).';
  if (code === 'EGRAPH_ERROR') return withReply('Microsoft Graph gaf een fout.');
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
    const where = error.mailHost ? `${error.mailHost}:${error.mailPort}` : 'de mailserver';
    const text = `${code} ${String(error && error.message || '')}`;
    if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(text)) {
      return withReply(`de naam van ${where} is niet gevonden. Controleer de servernaam en of de server DNS kan gebruiken.`);
    }
    if (/ECONNREFUSED/.test(text)) {
      return withReply(`${where} weigert de verbinding. Controleer de poort (587 met STARTTLS of 465 met SSL/TLS) en of de mailserver die poort aanbiedt.`);
    }
    if (/ENETUNREACH|EHOSTUNREACH/.test(text)) {
      return withReply(`${where} is vanaf de server niet bereikbaar (geen route naar het netwerk; bij een IPv6-adres kan dat aan ontbrekend IPv6 liggen).`);
    }
    if (error.mailPort === 443 && (code === 'ETIMEDOUT' || code === 'ECONNECTION')) {
      return withReply(`${where} is niet bereikbaar (HTTPS). Controleer of de server naar buiten mag verbinden en of DNS werkt.`);
    }
    if (code === 'ETIMEDOUT' || /timeout|never received/i.test(text)) {
      return withReply(`${where} geeft geen antwoord (time-out). Meestal blokkeert een firewall of de internetprovider uitgaand verkeer naar die poort (bij consumentenabonnementen vaak poort 25). Probeer 587 met STARTTLS of 465 met SSL/TLS, en controleer of de server naar buiten mag verbinden.`);
    }
    return withReply(`${where} is niet bereikbaar. Controleer server en poort (587 met STARTTLS of 465 met SSL/TLS) en of de server naar buiten mag verbinden.`);
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

module.exports = { inlineImages, createMailer, sanitizeMail, validEmail, mailFailure, MAIL_SETUP_FAILED, MAIL_DEFAULTS };
