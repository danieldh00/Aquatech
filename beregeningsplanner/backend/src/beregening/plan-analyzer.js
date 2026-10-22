const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModels = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));

// Leest een tuinplan (afbeelding) en geeft schaal, gebieden en elementen terug
// in pixelcoördinaten van de aangeleverde afbeelding. De frontend rekent dat om
// naar meters en maakt er een bewerkbaar concept van.

// Standaardmodel; de beheerder kiest per organisatie een ander model in
// Beheer > Instellingen (aiModel, zie shared/ai-models.js).
const MODEL = AiModels.DEFAULT;

const AREA_TYPES = ['lawn', 'bed', 'hedge', 'planter', 'wet', 'dry'];
const ELEMENT_KINDS = ['source', 'controller', 'valvebox', 'outlet'];

const point = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scale', 'areas', 'elements', 'notes'],
  properties: {
    scale: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'evidence', 'confidence', 'x1', 'y1', 'x2', 'y2', 'length_m'],
      properties: {
        method: { type: 'string', enum: ['maatvoering', 'schaalstok', 'schatting'] },
        evidence: { type: 'string' },
        confidence: { type: 'string', enum: ['hoog', 'middel', 'laag'] },
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        length_m: { type: 'number' },
      },
    },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'name', 'points'],
        properties: {
          type: { type: 'string', enum: AREA_TYPES },
          name: { type: 'string' },
          points: { type: 'array', items: point },
        },
      },
    },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'x', 'y', 'reason'],
        properties: {
          kind: { type: 'string', enum: ELEMENT_KINDS },
          x: { type: 'number' },
          y: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const SYSTEM = `Je bent een ervaren ontwerper van tuinberegening en leest tuinplannen: CAD-tekeningen, handschetsen, ontwerpen van hoveniers en luchtfoto's, met teksten in het Nederlands, Duits of Engels.

Je krijgt één afbeelding van een tuinplan. Coördinaten zijn pixels in die afbeelding: oorsprong linksboven, x naar rechts, y naar beneden. De afmetingen van de afbeelding staan in het verzoek.

1. Schaal. Zoek een referentiemaat in de tekening en geef de twee eindpunten (x1,y1)-(x2,y2) in pixels en de werkelijke lengte in meters:
   - "maatvoering": een maatlijn met een getal (let op de eenheid: mm, cm of m; "1250" op een bouwtekening is meestal mm).
   - "schaalstok": een getekende schaalbalk.
   - "schatting": alleen als er geen maat of schaalstok is; gebruik dan iets met een bekende maat (deur 0,9 m, auto 4,5 m, terrastegel 0,6 m of 0,5 m, parkeervak 2,5 m) en zet de betrouwbaarheid op "laag".
   Neem bij voorkeur de langste duidelijk leesbare maat. Een schaalnotatie als "1:100" alleen is niet bruikbaar zonder papierformaat.
2. Gebieden. Trek elk vlak als polygoon langs de werkelijke rand, met genoeg hoekpunten om bochten te volgen (bij gebogen randen minstens 12 punten). Soorten:
   - "lawn": gazon/grasveld (hier komen sproeiers).
   - "bed": beplanting, borders, struiken, moestuin (druppelirrigatie).
   - "hedge": hagen.
   - "planter": plantenbakken en grote potten (los van de grond of verhoogd).
   - "wet": vlakken die nat mogen worden maar geen beregening krijgen (grindpaden, boomspiegels, vijver).
   - "dry": wat droog moet blijven: woning, schuur, terras, bestrating, oprit, overkapping, carport.
   Gebruik ook teksten in het plan, ook handgeschreven ("gras", "gazon", "terras", "border", "haag", "vijver", "grind"), om te bepalen welk soort vlak het is; een label weegt zwaarder dan de kleur.
   Laat vlakken buiten de tuin weg. Overlappingen mogen (een border in een gazon is een apart vlak). Geef elk vlak een korte Nederlandse naam.
3. Elementen (alleen als ze aangegeven zijn of logisch af te leiden): "source" = buitenkraan/wateraansluiting, "controller" = plek voor de beregeningscomputer (meestal aan de gevel), "valvebox" = ventielkast, "outlet" = tappunt. Als niets is aangegeven, zet dan de wateraansluiting op de gevel van de woning die het dichtst bij het gazon ligt.
4. Notes: korte Nederlandse toelichting op onzekerheden (bijv. "maat 12,50 m slecht leesbaar").`;

// Versie van opdracht en schema: een bewaarde herkenning (recognitions.js)
// geldt alleen voor dezelfde opdracht. Verandert de opdracht, dan herkent de
// AI een tekening opnieuw.
const PROMPT_VERSION = require('crypto').createHash('sha256').update(SYSTEM + JSON.stringify(SCHEMA)).digest('hex').slice(0, 12);

/**
 * Controleert het antwoord van de AI en zet het om naar het formaat van de
 * frontend: coördinaten binnen de afbeelding, alleen bekende soorten vlakken
 * en elementen, teksten ingekort.
 * @param {object} result Het JSON-antwoord volgens SCHEMA.
 * @param {number} width Breedte van de afbeelding in pixels.
 * @param {number} height Hoogte van de afbeelding in pixels.
 * @returns {{ scale: object, areas: object[], elements: object[], notes: string }} Schaal (metersPerPixel of null), vlakken, elementen en toelichting.
 */
function validate(result, width, height) {
  /**
   * Houdt een x-coördinaat binnen de afbeelding.
   * @param {*} value De coördinaat.
   * @returns {number} Waarde tussen 0 en de breedte.
   */
  const clampX = (value) => Math.max(0, Math.min(width, Number(value) || 0));
  /**
   * Houdt een y-coördinaat binnen de afbeelding.
   * @param {*} value De coördinaat.
   * @returns {number} Waarde tussen 0 en de hoogte.
   */
  const clampY = (value) => Math.max(0, Math.min(height, Number(value) || 0));
  const scale = result.scale || {};
  const referencePixels = Math.hypot((scale.x2 || 0) - (scale.x1 || 0), (scale.y2 || 0) - (scale.y1 || 0));
  const metersPerPixel = referencePixels > 2 && scale.length_m > 0 ? scale.length_m / referencePixels : null;
  const areas = (result.areas || [])
    .filter((area) => AREA_TYPES.includes(area.type) && Array.isArray(area.points) && area.points.length >= 3)
    .map((area) => ({
      type: area.type,
      name: String(area.name || '').slice(0, 60),
      points: area.points.map((point) => ({ x: clampX(point.x), y: clampY(point.y) })),
    }));
  const elements = (result.elements || [])
    .filter((element) => ELEMENT_KINDS.includes(element.kind))
    .map((element) => ({ kind: element.kind, x: clampX(element.x), y: clampY(element.y), reason: String(element.reason || '').slice(0, 200) }));
  return {
    scale: {
      metersPerPixel,
      method: scale.method,
      evidence: String(scale.evidence || '').slice(0, 300),
      confidence: scale.confidence,
      reference: { x1: scale.x1, y1: scale.y1, x2: scale.x2, y2: scale.y2, lengthM: scale.length_m },
    },
    areas,
    elements,
    notes: String(result.notes || '').slice(0, 1000),
  };
}

/**
 * Leesbare foutmelding uit een API-fout (zonder sleutel of afbeeldingsdata).
 * @param {Error} error De fout van de AI-dienst.
 * @returns {string} De melding, hooguit 400 tekens.
 */
function apiMessage(error) {
  const message = error && error.error && error.error.error && error.error.error.message;
  return String(message || error.message || 'onbekende fout').slice(0, 400);
}

/**
 * Of de fout betekent dat het API-tegoed op is.
 * @param {Error} error De fout van de AI-dienst.
 * @returns {boolean} True als het tegoed op is.
 */
const isNoCredit = (error) => error instanceof Anthropic.APIError && /credit balance/i.test(apiMessage(error));

/**
 * Korte beschrijving van een API-fout voor het serverlog.
 * @param {Error} error De fout van de AI-dienst.
 * @returns {string} Status, soort, melding en request-id.
 */
function describe(error) {
  return `${error.status ?? '-'} ${error.error?.error?.type || error.name}: ${apiMessage(error)}${error.requestID ? ` (request ${error.requestID})` : ''}`;
}

class AnalyzeError extends Error {
  /**
   * Fout bij het herkennen, met een code voor de frontend en de HTTP-status.
   * @param {string} code Foutcode, bijv. 'auth' of 'no_credit'.
   * @param {string} message Melding voor de gebruiker.
   * @param {number} [status] HTTP-status (standaard 502).
   * @param {{ model?: string, usage?: object }} [extra] Model en verbruik als het antwoord toch tokens kostte.
   */
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    // Bij een antwoord dat toch tokens kostte (weigering, te lang, onleesbaar):
    // model en verbruik, zodat de kosten in het overzicht komen.
    if (extra.model) this.model = extra.model;
    if (extra.usage) this.usage = extra.usage;
  }
}

/**
 * Maakt de herkenner voor tuinplannen met de AI-dienst.
 * @param {object} options apiKey, client (voor tests), model en log (functie voor waarschuwingen).
 * @returns {{ available: boolean, model: string, analyze: Function, check: Function }} De herkenner.
 */
function createPlanAnalyzer({ apiKey, client, model = MODEL, log = (msg) => console.warn(msg) }) {
  const anthropic = client || (apiKey ? new Anthropic({ apiKey }) : null);
  const modelId = AiModels.SELECTABLE.includes(model) ? model : MODEL;
  // Server-side fallback alleen bij modellen die het ondersteunen.
  const withFallback = Boolean(AiModels.MODELS[modelId].fallback);

  /**
   * Vertaalt een fout van de AI-dienst naar een begrijpelijke melding.
   * @param {Error} error De fout.
   * @returns {Error} Een AnalyzeError, of de oorspronkelijke fout als die niet van de AI-dienst komt.
   */
  function toAnalyzeError(error) {
    if (error instanceof Anthropic.APIError) log(`AI-dienst gaf een fout: ${describe(error)}`);
    if (error instanceof Anthropic.AuthenticationError) return new AnalyzeError('auth', 'De API-sleutel wordt geweigerd. Controleer de API-sleutel bij Instellingen.');
    if (error instanceof Anthropic.PermissionDeniedError) return new AnalyzeError('permission', `Deze API-sleutel heeft geen toegang: ${apiMessage(error)}`);
    if (error instanceof Anthropic.NotFoundError) return new AnalyzeError('not_found', `Model niet beschikbaar voor deze API-sleutel: ${apiMessage(error)}`);
    if (error instanceof Anthropic.RateLimitError) return new AnalyzeError('rate_limited', 'De AI-dienst is even overbelast of het tegoed is op. Probeer het later opnieuw.', 429);
    if (isNoCredit(error)) return new AnalyzeError('no_credit', 'Het API-tegoed bij Anthropic is op. Koop tegoed via console.anthropic.com → Plans & Billing; daarna werkt automatisch herkennen meteen weer.', 402);
    if (error instanceof Anthropic.BadRequestError) return new AnalyzeError('bad_request', `De AI-dienst weigert het verzoek: ${apiMessage(error)}`);
    if (error instanceof Anthropic.APIError) return new AnalyzeError('api_error', `Fout bij de AI-dienst (${error.status ?? 'verbinding'}): ${apiMessage(error)}`);
    return error;
  }

  /**
   * Leest een tuinplan: één aanroep met de afbeelding, met server-side fallback
   * als het model dat ondersteunt.
   * @param {{ mediaType: string, data: string, width: number, height: number }} image De afbeelding (base64) en de afmetingen in pixels.
   * @returns {Promise<object>} Schaal, vlakken, elementen en toelichting, plus model en verbruik.
   */
  async function analyze({ mediaType, data, width, height }) {
    if (!anthropic) throw new AnalyzeError('not_configured', 'Automatisch herkennen is niet ingesteld: stel de API-sleutel in bij Instellingen.', 409);
    const params = {
      model: modelId,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: `Afbeelding: ${width} × ${height} pixels. Lees dit tuinplan en geef schaal, gebieden en elementen.` },
          ],
        },
      ],
    };
    let message;
    try {
      if (!withFallback) {
        message = await anthropic.messages.stream(params).finalMessage();
      } else {
        try {
          // Met server-side fallback: bij een weigering neemt een ander model het over.
          message = await anthropic.beta.messages
            .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
            .finalMessage();
        } catch (error) {
          if (!(error instanceof Anthropic.BadRequestError) || isNoCredit(error)) throw error;
          // Sommige accounts/regio's ondersteunen de fallback-beta niet: één keer zonder.
          log(`Verzoek met fallback geweigerd (${describe(error)}); opnieuw zonder fallback.`);
          message = await anthropic.messages.stream(params).finalMessage();
        }
      }
    } catch (error) {
      throw toAnalyzeError(error);
    }
    return finish(message, width, height);
  }

  /**
   * Verwerkt het antwoord van de AI-dienst; een weigering, een te lang of een
   * onleesbaar antwoord wordt een AnalyzeError (met het verbruik, voor het kostenoverzicht).
   * @param {object} message Het antwoord van de AI-dienst.
   * @param {number} width Breedte van de afbeelding in pixels.
   * @param {number} height Hoogte van de afbeelding in pixels.
   * @returns {object} De gecontroleerde herkenning met model en verbruik.
   */
  function finish(message, width, height) {
    const spent = { model: message.model, usage: message.usage };
    if (message.stop_reason === 'refusal') throw new AnalyzeError('refusal', 'De AI-dienst wilde deze afbeelding niet verwerken.', 502, spent);
    if (message.stop_reason === 'max_tokens') throw new AnalyzeError('too_long', 'Het plan is te complex om in één keer te verwerken. Probeer een uitsnede.', 502, spent);
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AnalyzeError('invalid_output', 'Het antwoord van de AI-dienst was onleesbaar. Probeer het opnieuw.', 502, spent);
    }
    return { ...validate(parsed, width, height), model: message.model, usage: message.usage };
  }

  /**
   * Controleert sleutel en modeltoegang zonder kosten (opvragen van het model).
   * @returns {Promise<{ ok: boolean, model: string }>} Het gebruikte model.
   */
  async function check() {
    if (!anthropic) throw new AnalyzeError('not_configured', 'Er is geen API-sleutel ingesteld.', 409);
    try {
      await anthropic.models.retrieve(modelId);
    } catch (error) {
      throw toAnalyzeError(error);
    }
    return { ok: true, model: modelId };
  }

  return { available: Boolean(anthropic), model: modelId, analyze, check };
}

module.exports = { createPlanAnalyzer, validate, AnalyzeError, SCHEMA, MODEL, PROMPT_VERSION };
