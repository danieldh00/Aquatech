const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const AiModels = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'ai-models.js'));

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

function validate(result, width, height) {
  const clampX = (v) => Math.max(0, Math.min(width, Number(v) || 0));
  const clampY = (v) => Math.max(0, Math.min(height, Number(v) || 0));
  const s = result.scale || {};
  const dist = Math.hypot((s.x2 || 0) - (s.x1 || 0), (s.y2 || 0) - (s.y1 || 0));
  const metersPerPixel = dist > 2 && s.length_m > 0 ? s.length_m / dist : null;
  const areas = (result.areas || [])
    .filter((a) => AREA_TYPES.includes(a.type) && Array.isArray(a.points) && a.points.length >= 3)
    .map((a) => ({
      type: a.type,
      name: String(a.name || '').slice(0, 60),
      points: a.points.map((p) => ({ x: clampX(p.x), y: clampY(p.y) })),
    }));
  const elements = (result.elements || [])
    .filter((e) => ELEMENT_KINDS.includes(e.kind))
    .map((e) => ({ kind: e.kind, x: clampX(e.x), y: clampY(e.y), reason: String(e.reason || '').slice(0, 200) }));
  return {
    scale: {
      metersPerPixel,
      method: s.method,
      evidence: String(s.evidence || '').slice(0, 300),
      confidence: s.confidence,
      reference: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, lengthM: s.length_m },
    },
    areas,
    elements,
    notes: String(result.notes || '').slice(0, 1000),
  };
}

/** Leesbare foutmelding uit een API-fout (zonder sleutel of afbeeldingsdata). */
function apiMessage(err) {
  const m = err && err.error && err.error.error && err.error.error.message;
  return String(m || err.message || 'onbekende fout').slice(0, 400);
}

const isNoCredit = (err) => err instanceof Anthropic.APIError && /credit balance/i.test(apiMessage(err));

function describe(err) {
  return `${err.status ?? '-'} ${err.error?.error?.type || err.name}: ${apiMessage(err)}${err.requestID ? ` (request ${err.requestID})` : ''}`;
}

class AnalyzeError extends Error {
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

function createPlanAnalyzer({ apiKey, client, model = MODEL, log = (msg) => console.warn(msg) }) {
  const anthropic = client || (apiKey ? new Anthropic({ apiKey }) : null);
  const modelId = AiModels.SELECTABLE.includes(model) ? model : MODEL;
  // Server-side fallback alleen bij modellen die het ondersteunen.
  const withFallback = Boolean(AiModels.MODELS[modelId].fallback);

  // Vertaalt een fout van de AI-dienst naar een begrijpelijke melding.
  function toAnalyzeError(err) {
    if (err instanceof Anthropic.APIError) log(`AI-dienst gaf een fout: ${describe(err)}`);
    if (err instanceof Anthropic.AuthenticationError) return new AnalyzeError('auth', 'De API-sleutel wordt geweigerd. Controleer de API-sleutel bij Instellingen.');
    if (err instanceof Anthropic.PermissionDeniedError) return new AnalyzeError('permission', `Deze API-sleutel heeft geen toegang: ${apiMessage(err)}`);
    if (err instanceof Anthropic.NotFoundError) return new AnalyzeError('not_found', `Model niet beschikbaar voor deze API-sleutel: ${apiMessage(err)}`);
    if (err instanceof Anthropic.RateLimitError) return new AnalyzeError('rate_limited', 'De AI-dienst is even overbelast of het tegoed is op. Probeer het later opnieuw.', 429);
    if (isNoCredit(err)) return new AnalyzeError('no_credit', 'Het API-tegoed bij Anthropic is op. Koop tegoed via console.anthropic.com → Plans & Billing; daarna werkt automatisch herkennen meteen weer.', 402);
    if (err instanceof Anthropic.BadRequestError) return new AnalyzeError('bad_request', `De AI-dienst weigert het verzoek: ${apiMessage(err)}`);
    if (err instanceof Anthropic.APIError) return new AnalyzeError('api_error', `Fout bij de AI-dienst (${err.status ?? 'verbinding'}): ${apiMessage(err)}`);
    return err;
  }

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
        } catch (err) {
          if (!(err instanceof Anthropic.BadRequestError) || isNoCredit(err)) throw err;
          // Sommige accounts/regio's ondersteunen de fallback-beta niet: één keer zonder.
          log(`Verzoek met fallback geweigerd (${describe(err)}); opnieuw zonder fallback.`);
          message = await anthropic.messages.stream(params).finalMessage();
        }
      }
    } catch (err) {
      throw toAnalyzeError(err);
    }
    return finish(message, width, height);
  }

  function finish(message, width, height) {
    const spent = { model: message.model, usage: message.usage };
    if (message.stop_reason === 'refusal') throw new AnalyzeError('refusal', 'De AI-dienst wilde deze afbeelding niet verwerken.', 502, spent);
    if (message.stop_reason === 'max_tokens') throw new AnalyzeError('too_long', 'Het plan is te complex om in één keer te verwerken. Probeer een uitsnede.', 502, spent);
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AnalyzeError('invalid_output', 'Het antwoord van de AI-dienst was onleesbaar. Probeer het opnieuw.', 502, spent);
    }
    return { ...validate(parsed, width, height), model: message.model, usage: message.usage };
  }

  // Controleert sleutel en modeltoegang zonder kosten (opvragen van het model).
  async function check() {
    if (!anthropic) throw new AnalyzeError('not_configured', 'Er is geen API-sleutel ingesteld.', 409);
    try {
      await anthropic.models.retrieve(modelId);
    } catch (err) {
      throw toAnalyzeError(err);
    }
    return { ok: true, model: modelId };
  }

  return { available: Boolean(anthropic), model: modelId, analyze, check };
}

module.exports = { createPlanAnalyzer, validate, AnalyzeError, SCHEMA, MODEL, PROMPT_VERSION };
