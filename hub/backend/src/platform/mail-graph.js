// Mail versturen via Microsoft Graph (Mail.Send als applicatiemachtiging, client credentials): HTTPS naar vaste
// Microsoft-adressen, dus geen SMTP-poorten nodig. Het token wordt kort onthouden; het clientgeheim komt nooit in een fout.
const crypto = require('node:crypto');

const LOGIN_HOST = 'login.microsoftonline.com';
const GRAPH_HOST = 'graph.microsoft.com';
/** Een gewone bijlage mag via Graph hoogstens ongeveer 3 MB groot zijn (grotere vragen een uploadsessie). */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Tokens per (tenant, app, geheim): sleutel is een hash, de waarde het token en zijn einde (ms). */
const tokenCache = new Map();

/**
 * Of een waarde een bruikbaar Entra-tenantadres is: een GUID of een domeinnaam.
 * @param {*} value De waarde.
 * @returns {boolean} true bij een geldige waarde.
 */
const validTenantId = (value) => typeof value === 'string' && (GUID.test(value) || (value.length <= 100 && DOMAIN.test(value)));

/**
 * Of een waarde een geldig client-id (GUID) is.
 * @param {*} value De waarde.
 * @returns {boolean} true bij een geldige waarde.
 */
const validClientId = (value) => typeof value === 'string' && GUID.test(value);

/**
 * Splitst een afzender ("Naam <adres>" of alleen een adres) in naam en adres.
 * @param {string} from De ingestelde afzender.
 * @returns {{ address: string, name: string }} Het adres en de (mogelijk lege) naam.
 */
function parseSender(from) {
  const text = String(from || '').trim();
  const match = text.match(/^(.*?)<([^<>]+)>\s*$/);
  if (match) return { address: match[2].trim(), name: match[1].trim().replace(/^"|"$/g, '') };
  return { address: text, name: '' };
}

/**
 * Maakt een fout met code, zodat mailFailure er een melding van kan maken.
 * @param {string} code De code (EGRAPH_AUTH, EGRAPH_DENIED, EGRAPH_MAILBOX, EGRAPH_THROTTLED, EGRAPH_ERROR, EGRAPH_SIZE).
 * @param {string} message De melding voor het serverlog.
 * @param {string} [reply] Korte tekst van Microsoft (zonder geheimen), komt achter de melding.
 * @returns {Error} De fout, met mailHost en mailPort van Graph.
 */
const graphError = (code, message, reply) => Object.assign(new Error(message), { code, response: reply, mailHost: GRAPH_HOST, mailPort: 443 });

/**
 * Zet een netwerkfout van fetch om in een fout met de codes die mailFailure al kent.
 * @param {Error & { cause?: { code?: string } }} error De fout van fetch.
 * @param {string} host De host waar naartoe verbonden werd.
 * @returns {Error} Een fout met code ETIMEDOUT, EDNS of ECONNECTION.
 */
function networkError(error, host) {
  const cause = String(error && error.cause && error.cause.code || '');
  const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  const code = timedOut || cause === 'UND_ERR_CONNECT_TIMEOUT' ? 'ETIMEDOUT' : /ENOTFOUND|EAI_AGAIN/.test(cause) ? 'EDNS' : 'ECONNECTION';
  return Object.assign(new Error(`${host}: ${timedOut ? 'timeout' : cause || String(error && error.message || error)}`), { code, mailHost: host, mailPort: 443 });
}

/**
 * Korte, veilige tekst uit een foutantwoord van Microsoft (code en bericht, zonder regeleinden).
 * @param {object} body Het JSON-antwoord.
 * @returns {string} De tekst, hoogstens 160 tekens.
 */
function replyOf(body) {
  const graph = body && body.error;
  if (graph && typeof graph === 'object') return `${graph.code || ''}${graph.message ? `: ${graph.message}` : ''}`.replace(/\s+/g, ' ').slice(0, 160);
  if (body && body.error_description) return String(body.error_description).replace(/\s+/g, ' ').split('Trace ID')[0].trim().slice(0, 160);
  return '';
}

/**
 * Maakt de Graph-verzender voor één tenant.
 * @param {object} credentials tenantId, clientId, clientSecret en from (de afzender; de mailbox waarmee verstuurd wordt).
 * @param {{ fetchImpl?: Function, now?: Function }} [options] fetchImpl en now, te vervangen in tests.
 * @returns {{ token: Function, send: Function, verify: Function }} De functies.
 */
function createGraphSender({ tenantId, clientId, clientSecret, from }, { fetchImpl = fetch, now = Date.now } = {}) {
  const sender = parseSender(from);

  /**
   * Een verzoek met time-out; netwerkfouten worden leesbare fouten.
   * @param {string} url Het adres.
   * @param {object} init De opties van fetch.
   * @param {number} timeoutMs De time-out.
   * @returns {Promise<{ status: number, body: object }>} De status en het JSON-antwoord (leeg object bij geen inhoud).
   */
  async function call(url, init, timeoutMs) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw networkError(error, new URL(url).hostname);
    }
    let body = {};
    try { body = await response.json(); } catch (error) { body = {}; }
    return { status: response.status, body };
  }

  /**
   * Haalt een toegangstoken op (of gebruikt het onthouden token).
   * @returns {Promise<string>} Het token.
   * @throws {Error} Met code EGRAPH_AUTH als Microsoft de gegevens weigert.
   */
  async function token() {
    const key = crypto.createHash('sha256').update(`${tenantId}\n${clientId}\n${clientSecret}`).digest('hex');
    const cached = tokenCache.get(key);
    if (cached && cached.until > now() + 60000) return cached.value;
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: `https://${GRAPH_HOST}/.default`, grant_type: 'client_credentials' });
    const { status, body } = await call(`https://${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, 15000);
    if (status !== 200 || !body.access_token) throw graphError('EGRAPH_AUTH', `Graph-token geweigerd (${status})`, replyOf(body));
    if (tokenCache.size > 50) tokenCache.clear();
    tokenCache.set(key, { value: body.access_token, until: now() + Math.max(120, Number(body.expires_in) || 3000) * 1000 });
    return body.access_token;
  }

  /**
   * Controleert tenant, app en geheim door een token op te halen (er wordt niets verstuurd).
   * @returns {Promise<true>} true als Microsoft een token geeft.
   */
  async function verify() {
    await token();
    return true;
  }

  /**
   * Verstuurt een mail met sendMail (de mail komt ook in Verzonden items van de mailbox).
   * @param {{ to: string[], bcc?: string, replyTo?: string, subject: string, text?: string, html?: string, attachments?: object[] }} message Het bericht (geldige adressen).
   * @returns {Promise<{ accepted: string[] }>} De ontvangers.
   * @throws {Error} Met een EGRAPH_*-code of een netwerkcode.
   */
  async function send({ to, bcc, replyTo, subject, text, html, attachments = [] }) {
    const files = attachments.map((attachment) => {
      const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || '');
      if (content.length > MAX_ATTACHMENT_BYTES) throw graphError('EGRAPH_SIZE', `Bijlage te groot (${content.length} bytes)`);
      return {
        '@odata.type': '#microsoft.graph.fileAttachment', name: attachment.filename, contentType: attachment.contentType || 'application/octet-stream',
        contentBytes: content.toString('base64'), ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
      };
    });
    /**
     * Een ontvanger in het formaat van Graph.
     * @param {string} address Het e-mailadres.
     * @returns {{ emailAddress: { address: string } }} De ontvanger.
     */
    const recipient = (address) => ({ emailAddress: { address } });
    const message = {
      subject, body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
      toRecipients: to.map(recipient),
      ...(bcc ? { bccRecipients: [recipient(bcc)] } : {}),
      ...(replyTo ? { replyTo: [recipient(replyTo)] } : {}),
      from: { emailAddress: { address: sender.address, ...(sender.name ? { name: sender.name } : {}) } },
      ...(files.length ? { attachments: files } : {}),
    };
    const accessToken = await token();
    const { status, body } = await call(`https://${GRAPH_HOST}/v1.0/users/${encodeURIComponent(sender.address)}/sendMail`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }),
    }, 30000);
    if (status === 202 || status === 200) return { accepted: to };
    const reply = replyOf(body);
    if (status === 401) { tokenCache.clear(); throw graphError('EGRAPH_AUTH', 'Graph weigerde het token (401)', reply); }
    if (status === 403) throw graphError('EGRAPH_DENIED', 'Graph weigert toegang (403)', reply);
    if (status === 404 || (status === 400 && /MailboxNotEnabled|InvalidUser|ResourceNotFound/i.test(reply))) throw graphError('EGRAPH_MAILBOX', `Graph kent de mailbox niet (${status})`, reply);
    if (status === 429) throw graphError('EGRAPH_THROTTLED', 'Graph beperkt het versturen (429)', reply);
    throw graphError('EGRAPH_ERROR', `Graph gaf een fout (${status})`, reply);
  }

  return { token, send, verify };
}

module.exports = { createGraphSender, parseSender, validTenantId, validClientId, MAX_ATTACHMENT_BYTES };
