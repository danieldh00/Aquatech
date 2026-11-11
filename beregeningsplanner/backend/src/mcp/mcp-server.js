// De MCP-server van de AI-koppeling (Model Context Protocol, transport "Streamable HTTP", zonder sessies): POST /app/mcp
// met één JSON-RPC-bericht (of een lijst, voor oudere apps) en een toegangstoken uit oauth-server.js in de kop
// Authorization. Het antwoord is gewoon JSON; een eigen stroom (GET, Server-Sent Events) is er niet.
// Elk verzoek werkt als de gebruiker van het token, in de omgeving van het token, met de rechten van zijn rol op dit
// moment (en hoogstens de rechten uit de toestemming). De tools staan in mcp-tools.js.
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { limitTo } = require('../database/tenant-scope');
const { MCP_PATH } = require('./oauth-server');

/** De protocolversies die deze server spreekt (nieuwste eerst). */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Hoeveel berichten een lijst (batch) hoogstens mag bevatten. */
const MAX_BATCH = 20;
/** Uitleg voor de AI over hoe de tools samen een offerte maken. */
const INSTRUCTIONS = [
  'Je maakt voor een medewerker van een beregeningsbedrijf een CONCEPT-offerte op basis van een (ingesproken) gesprekssamenvatting.',
  'Werkwijze: 1) zoek de klant met zoek_klant; bestaat die niet, maak hem met maak_klant (postcode en huisnummer voor het adres).',
  '2) Zoek per onderdeel het artikel met zoek_artikelen en gebruik de artikelcode; prijzen komen altijd uit AquaTech.',
  '3) Maak de offerte met maak_concept_offerte. Twijfel je over een artikel of aantal, zet dan twijfel=true en leg in notitie uit waarom.',
  'Arbeid als regel met soort "arbeid" en eenheid "uur" (het uurtarief vult AquaTech in). Verzin geen artikelcodes of prijzen.',
  'De offerte blijft een concept: de medewerker controleert en verstuurt hem zelf in AquaTech. Geef aan het eind de link naar de offerte.',
].join(' ');

/**
 * Een JSON-RPC-antwoord.
 * @param {*} id Het id van het verzoek.
 * @param {object} result De uitkomst.
 * @returns {object} Het antwoord.
 */
const success = (id, result) => ({ jsonrpc: '2.0', id, result });
/**
 * Een JSON-RPC-fout.
 * @param {*} id Het id van het verzoek (null als het niet te lezen was).
 * @param {number} code De foutcode (JSON-RPC).
 * @param {string} message De uitleg.
 * @returns {object} Het antwoord.
 */
const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

/**
 * Registreert de MCP-server.
 * @param {object} app De Express-app.
 * @param {object} ctx { grants, tools (createMcpTools), userForGrant(grant), connectorOn(tenantId), familyOf(user), originOf(req), resourceOf(req), version }.
 * @returns {void}
 */
function registerMcpRoutes(app, ctx) {
  const perGrant = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyFn: (req) => `mcp:${req.mcpGrant ? req.mcpGrant.id : ''}` });

  /**
   * Antwoordt 401 met een verwijzing naar de OAuth-gegevens, zodat de AI-app weet waar hij moet inloggen.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {boolean} hadToken Of er een (ongeldig) token was meegestuurd.
   * @returns {object} Het antwoord.
   */
  function unauthorized(req, res, hadToken) {
    const metadata = `${ctx.originOf(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${hadToken ? ', error="invalid_token"' : ''}`);
    return res.status(401).json(failure(null, -32001, hadToken ? 'Het token is ongeldig of verlopen.' : 'Inloggen is nodig.'));
  }

  /**
   * Middleware: leest het toegangstoken, zet req.user (de gebruiker in de omgeving van het token) en req.tenantId.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  function authenticate(req, res, next) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{20,200})$/.exec(header);
    if (!match) return unauthorized(req, res, Boolean(header));
    const grant = ctx.grants.findAccess(match[1]);
    if (!grant || grant.resource !== ctx.resourceOf(req)) return unauthorized(req, res, true);
    const user = ctx.userForGrant(grant);
    if (!user) {
      ctx.grants.revoke(grant.tenantId, grant.id);
      return unauthorized(req, res, true);
    }
    req.user = user;
    req.tenantId = grant.tenantId;
    req.mcpGrant = grant;
    req.mcpScopes = new Set(grant.scope.split(' ').filter(Boolean));
    // Vanaf hier ziet de database (PostgreSQL-policies) alleen de omgevingen van de eigen organisatie.
    if (!user.platform_admin) limitTo(ctx.familyOf(user));
    ctx.grants.touch(grant);
    next();
  }

  /**
   * Middleware: een Origin-kop (een browser) moet van deze server of van een bekende AI-app komen (tegen DNS-rebinding).
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  function checkOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin || origin === ctx.originOf(req) || /^https:\/\/(claude\.ai|claude\.com|chatgpt\.com|chat\.openai\.com)$/.test(origin)) return next();
    res.status(403).json(failure(null, -32003, 'Verzoek van een andere site geweigerd.'));
  }

  /**
   * Middleware: een meegegeven protocolversie moet er een zijn die deze server kent.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende stap.
   * @returns {void}
   */
  function checkVersion(req, res, next) {
    const version = req.headers['mcp-protocol-version'];
    if (version === undefined || PROTOCOL_VERSIONS.includes(String(version))) return next();
    res.status(400).json(failure(null, -32600, `Onbekende MCP-protocolversie ${String(version).slice(0, 20)}.`));
  }

  /**
   * Handelt één JSON-RPC-bericht af.
   * @param {*} message Het bericht.
   * @param {object} req Het verzoek (met req.user en req.mcpScopes).
   * @returns {Promise<object|null>} Het antwoord, of null bij een melding (notification) of een antwoord van de app.
   */
  async function handle(message, req) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') return failure(null, -32600, 'Ongeldig JSON-RPC-bericht.');
    const { id, method, params } = message;
    if (typeof method !== 'string') return null;
    const isNotification = id === undefined;
    if (isNotification) return null;
    if (method === 'initialize') {
      const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return success(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aquatech', title: 'AquaTech', version: ctx.version },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return success(id, {});
    if (method === 'tools/list') return success(id, { tools: ctx.tools.list(req) });
    if (method === 'tools/call') {
      const name = params && typeof params.name === 'string' ? params.name : '';
      const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      if (!ctx.tools.has(name)) return failure(id, -32602, `Onbekende tool: ${name.slice(0, 60)}.`);
      return success(id, await ctx.tools.call(name, args, req));
    }
    return failure(id, -32601, `Onbekende methode: ${method.slice(0, 60)}.`);
  }

  app.post(MCP_PATH.replace('/app', ''), checkOrigin, checkVersion, authenticate, perGrant, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!ctx.connectorOn(req.tenantId)) return res.status(403).json(failure(null, -32003, 'De AI-koppeling staat uit in deze omgeving (Beheer > Instellingen > AI-koppeling).'));
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length || messages.length > MAX_BATCH) return res.status(400).json(failure(null, -32600, 'Ongeldig verzoek.'));
    const answers = [];
    for (const message of messages) {
      const answer = await handle(message, req);
      if (answer) answers.push(answer);
    }
    if (!answers.length) return res.status(202).end();
    res.json(batch ? answers : answers[0]);
  });

  // Geen eigen stroom (Server-Sent Events) en geen sessies: GET en DELETE bestaan niet.
  app.all(MCP_PATH.replace('/app', ''), (req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json(failure(null, -32000, 'Gebruik POST.'));
  });
}

module.exports = { registerMcpRoutes, PROTOCOL_VERSIONS };
