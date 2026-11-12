// Leest een leveranciersdocument (PDF of foto van een offerte, orderbevestiging, pakbon of factuur) met de
// AI-dienst en geeft de regels terug (artikelnummer, omschrijving, aantal, eenheid, prijs). Het koppelen aan
// artikelen gebeurt apart (order-matching.js) en het resultaat wordt pas een inkooporder nadat een
// medewerker het heeft nagekeken.
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModels = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));
const { translateApiError, AnalyzeError } = require('../beregening/plan-analyzer');

const MAX_LINES = 300;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplierName', 'documentNumber', 'documentDate', 'documentType', 'lines', 'notes'],
  properties: {
    supplierName: { type: 'string' },
    documentNumber: { type: 'string' },
    documentDate: { type: 'string' },
    documentType: { type: 'string', enum: ['offerte', 'orderbevestiging', 'pakbon', 'factuur', 'overig'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['supplierSku', 'description', 'qty', 'unit', 'unitPrice'],
        properties: {
          supplierSku: { type: 'string' },
          description: { type: 'string' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          unitPrice: { type: ['number', 'null'] },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const SYSTEM = `Je leest documenten van leveranciers van een Nederlands bedrijf in tuinberegening en irrigatie: offertes, orderbevestigingen, pakbonnen en facturen, als PDF of foto, in het Nederlands, Engels of Duits.

Geef de gegevens van het document:
- supplierName: de naam van de leverancier die het document verstuurt (niet de ontvanger). Leeg als die niet te vinden is.
- documentNumber en documentDate (JJJJ-MM-DD, leeg als onbekend) en documentType.
- lines: elke artikelregel, in de volgorde van het document. supplierSku is het artikelnummer van de leverancier (leeg als er geen staat), description de omschrijving, qty het aantal in de eenheid van de regel (decimalen met punt), unit de eenheid (st, m, rol, doos, ...; leeg als niet vermeld) en unitPrice de prijs per eenheid exclusief btw in euro (null als er geen prijs staat). Een prijs per 100 of per 1000 reken je om naar de prijs per stuk. Neem geen totaalregels, verzendkosten, btw, kortingen, opmerkingen of kopteksten op als artikelregel.
- notes: korte Nederlandse toelichting op wat onzeker of onleesbaar was (bijvoorbeeld "regel 7: aantal slecht leesbaar").
Verzin niets: wat niet in het document staat laat je leeg of null.`;

// Versie van opdracht en schema, voor wie ooit uitkomsten wil bewaren.
const PROMPT_VERSION = require('crypto').createHash('sha256').update(SYSTEM + JSON.stringify(SCHEMA)).digest('hex').slice(0, 12);

/**
 * Maakt een getal van een waarde die een getal, een tekst of leeg kan zijn.
 * @param {*} value De waarde.
 * @param {number} max Hoogste toegestane waarde.
 * @returns {number|null} Het getal, of null als het geen geldig getal tot max is.
 */
function numberOf(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

/**
 * Maakt tekst schoon: stuurtekens weg, spaties aan de randen af, ingekort.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte.
 * @returns {string} De schone tekst.
 */
function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * Controleert het antwoord van de AI en zet het om naar schone regels: teksten ingekort, aantallen en prijzen als getal.
 * @param {object} result Het JSON-antwoord volgens SCHEMA.
 * @returns {{ supplierName: string, documentNumber: string, documentDate: string, documentType: string, lines: object[], notes: string }} Het gecontroleerde document.
 */
function validate(result) {
  const source = result && typeof result === 'object' ? result : {};
  const lines = (Array.isArray(source.lines) ? source.lines : []).slice(0, MAX_LINES)
    .map((line) => ({
      supplierSku: clean(line && line.supplierSku, 80), description: clean(line && line.description, 200),
      qty: numberOf(line && line.qty, 1000000), unit: clean(line && line.unit, 20), unitPrice: numberOf(line && line.unitPrice, 1000000),
    }))
    .filter((line) => (line.description || line.supplierSku) && line.qty !== null && line.qty > 0);
  const date = clean(source.documentDate, 10);
  return {
    supplierName: clean(source.supplierName, 120), documentNumber: clean(source.documentNumber, 60),
    documentDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    documentType: ['offerte', 'orderbevestiging', 'pakbon', 'factuur'].includes(source.documentType) ? source.documentType : 'overig',
    lines, notes: clean(source.notes, 1000),
  };
}

/**
 * Maakt de lezer voor leveranciersdocumenten met de AI-dienst.
 * @param {object} options apiKey, client (voor tests), model en log (functie voor waarschuwingen).
 * @returns {{ available: boolean, model: string, read: Function }} De lezer.
 */
function createOrderReader({ apiKey, client, model = AiModels.DEFAULT, log = (msg) => console.warn(msg) }) {
  const anthropic = client || (apiKey ? new Anthropic({ apiKey }) : null);
  const modelId = AiModels.SELECTABLE.includes(model) ? model : AiModels.DEFAULT;

  /**
   * Leest een document: één aanroep met de PDF of foto.
   * @param {{ mediaType: string, data: string }} file Het bestand (base64) en het type (application/pdf of een afbeelding).
   * @returns {Promise<object>} Het gecontroleerde document plus model en verbruik.
   */
  async function read({ mediaType, data }) {
    if (!anthropic) throw new AnalyzeError('not_configured', 'Inlezen is niet ingesteld: stel de API-sleutel in bij Instellingen.', 409);
    const block = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    let message;
    try {
      message = await anthropic.messages.stream({
        model: modelId, max_tokens: 32000, thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Lees dit leveranciersdocument en geef de gegevens en artikelregels.' }] }],
      }).finalMessage();
    } catch (error) {
      throw translateApiError(error, log);
    }
    const spent = { model: message.model, usage: message.usage };
    if (message.stop_reason === 'refusal') throw new AnalyzeError('refusal', 'De AI-dienst wilde dit document niet verwerken.', 502, spent);
    if (message.stop_reason === 'max_tokens') throw new AnalyzeError('too_long', 'Het document is te groot om in één keer te lezen. Probeer een deel van de pagina\'s.', 502, spent);
    let parsed;
    try {
      parsed = JSON.parse(message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
    } catch {
      throw new AnalyzeError('invalid_output', 'Het antwoord van de AI-dienst was onleesbaar. Probeer het opnieuw.', 502, spent);
    }
    return { ...validate(parsed), model: message.model, usage: message.usage };
  }

  return { available: Boolean(anthropic), model: modelId, read };
}

module.exports = { createOrderReader, validate, SCHEMA, PROMPT_VERSION };
