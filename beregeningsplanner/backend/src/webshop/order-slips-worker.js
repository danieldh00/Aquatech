// Werkthread voor de controle van een geüploade pakbon (order-slips.js, inspectSlip): leest de PDF met pdf-lib, bouwt hem opnieuw op
// zonder annotaties, paginaacties en metadata en geeft de schone bytes terug. Draait apart zodat een zware PDF de server niet blokkeert.
const { parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const { PDFDocument, PDFName } = require('pdf-lib');

/** Hoogstens zoveel bytes voor een geüploade pakbon. */
const MAX_SLIP_BYTES = 2 * 1024 * 1024;
/** Hoogstens zoveel pagina's in een geüploade pakbon. */
const MAX_SLIP_PAGES = 10;
/** Een pagina is minstens zo groot en hoogstens zo groot (in punten, 72 per inch): een A0-vel is 2384 × 3370. */
const MIN_PAGE_POINTS = 100;
const MAX_PAGE_POINTS = 3400;
/** Hoogstens zoveel bytes mag één stream uitgepakt zijn, en alle streams samen (een kleine PDF kan anders vele honderden MB worden). */
const MAX_STREAM_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
/** Hoogstens zoveel streams worden gecontroleerd (een gewone pakbon heeft er tientallen); meer is verdacht en houdt het werk begrensd. */
const MAX_STREAMS = 500;
/** Filters die pdf-lib naast Flate uitvoert en die deze controle niet kan begrenzen: PDF's die ze noemen worden geweigerd. */
const UNSUPPORTED_FILTERS = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode', 'LZWDecode']);
/** Een filterketen (Flate van Flate) wordt hoogstens zoveel lagen diep uitgepakt; dieper is verdacht. */
const MAX_LAYERS = 4;

/**
 * Controleert of de waarde van een /Filter direct in de tekst staat: één naam, of een rij van alleen namen (witruimte en commentaar
 * ertussen, zoals pdf-lib die overslaat, zijn toegestaan). Een verwijzing (8 0 R) kan naar een naam in een gecomprimeerde objectstroom wijzen en is hier niet te zien.
 * @param {string} text De PDF als tekst.
 * @param {number} index De plek direct na /Filter.
 * @returns {boolean} true als de waarde alleen uit directe namen bestaat.
 */
function filterIsDirect(text, index) {
  const skip = /(?:[\s\0]+|%[^\r\n]*)*/y;
  const name = /\/[^\s\0\/\[\]<>()%{}]*/y;
  /**
   * Gaat voorbij witruimte en commentaar.
   * @param {number} from Beginplek.
   * @returns {number} De plek van het eerste teken daarna.
   */
  const next = (from) => { skip.lastIndex = from; skip.test(text); return skip.lastIndex; };
  let position = next(index);
  if (text[position] === '/') return true;
  if (text[position] !== '[') return false;
  position = next(position + 1);
  for (let count = 0; count < 50; count++) {
    if (text[position] === ']') return true;
    name.lastIndex = position;
    if (text[position] !== '/' || !name.test(text)) return false;
    position = next(name.lastIndex);
  }
  return false;
}

/**
 * Zoekt in de ruwe PDF naar namen van filters die niet te begrenzen zijn (ook geschreven met #xx-tekens, zoals /ASCII#48exDecode).
 * @param {Buffer} buffer De PDF.
 * @returns {boolean} true als zo'n filter wordt genoemd.
 */
function usesUnsupportedFilter(buffer) {
  const text = buffer.toString('latin1');
  for (const match of text.matchAll(/\/[^\s\0\/\[\]<>()%{}]+/g)) {
    const name = match[0].slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (UNSUPPORTED_FILTERS.has(name)) return true;
    if (name === 'Filter' && !filterIsDirect(text, match.index + match[0].length)) return true;
  }
  return false;
}

/**
 * Pakt gegevens laag voor laag uit zolang het resultaat zelf weer uit te pakken is (elke geldige zlib-kop telt, ook met een kleiner venster) (pdf-lib past een filterketen als
 * [/FlateDecode /FlateDecode] achter elkaar toe), en telt alle uitgepakte lagen mee.
 * @param {Buffer} data De gecomprimeerde gegevens.
 * @returns {number|null} Het totaal aantal uitgepakte bytes, 0 als het geen zlib-gegevens zijn, of null als een grens wordt overschreden.
 */
function inflateLayers(data) {
  let sum = 0;
  let current = data;
  for (let layer = 0; layer <= MAX_LAYERS; layer++) {
    let output;
    try {
      output = zlib.inflateSync(current, { maxOutputLength: MAX_STREAM_BYTES });
    } catch (failure) {
      // Geen (geldige) zlib-gegevens meer: de keten is hier klaar. Een te grote uitvoer weigert de PDF.
      return failure.code === 'ERR_BUFFER_TOO_LARGE' ? null : sum;
    }
    sum += output.length;
    if (sum > MAX_STREAM_BYTES) return null;
    current = output;
  }
  return null;
}

/**
 * Probeert elke stream van de PDF begrensd uit te pakken (zonder op het woordenboek van de stream te vertrouwen, dat is te omzeilen) om een decompressiebom te herkennen vóór pdf-lib de PDF leest.
 * @param {Buffer} buffer De PDF.
 * @returns {boolean} true als alle streams binnen de grenzen blijven (een stream zonder einde telt als onbruikbaar).
 */
function streamsWithinLimits(buffer) {
  let total = 0;
  let position = 0;
  let streams = 0;
  for (;;) {
    const start = buffer.indexOf('stream', position, 'latin1');
    if (start < 0) return true;
    position = start + 6;
    if (buffer.subarray(Math.max(0, start - 3), start).toString('latin1') === 'end') continue;
    streams += 1;
    if (streams > MAX_STREAMS) return false;
    // Zonder 'endstream' is het bestand niet in orde. Uitpakken loopt tot het einde van de gecomprimeerde gegevens zelf (niet tot de
    // eerste 'endstream', die ook toevallig in de gegevens kan staan); wat achter dat einde komt, negeert zlib.
    if (buffer.indexOf('endstream', position, 'latin1') < 0) return false;
    // pdf-lib accepteert na 'stream' ook spaties vóór de regeleinde; daarom wordt vanaf de eerste paar posities geprobeerd.
    for (let offset = 0; offset <= 4; offset++) {
      const unpacked = inflateLayers(buffer.subarray(position + offset));
      if (unpacked === null) return false;
      if (unpacked > 0) {
        total += unpacked;
        break;
      }
    }
    if (total > MAX_TOTAL_BYTES) return false;
    // Het zoeken gaat verder direct na het trefwoord, niet na 'endstream': een stream die binnen de gegevens van een andere staat
    // wordt door pdf-lib via de xref toch gelezen en moet dus ook worden gecontroleerd.
  }
}

/**
 * Controleert een geüploade pakbon en bouwt hem opnieuw op uit de pagina's (zonder annotaties, paginaacties en metadata).
 * @param {Buffer} buffer De ontvangen bytes.
 * @returns {Promise<{ bytes?: Buffer, pages?: number, error?: string }>} De schone PDF en het aantal pagina's, of een melding in gewone taal.
 */
async function checkSlip(buffer) {
  if (usesUnsupportedFilter(buffer)) return { error: 'Deze PDF gebruikt een compressie die niet wordt ondersteund. Sla de pakbon opnieuw op als gewone PDF.' };
  if (!streamsWithinLimits(buffer)) return { error: 'Deze PDF wordt te groot als hij wordt uitgepakt en is daarom niet toegestaan.' };
  let source;
  let count;
  try {
    source = await PDFDocument.load(buffer, { updateMetadata: false });
    count = source.getPageCount();
  } catch {
    return { error: 'Deze PDF kan niet worden gelezen. Beveiligde (met wachtwoord) en beschadigde PDF\'s worden niet geaccepteerd.' };
  }
  if (count < 1) return { error: 'De PDF heeft geen pagina\'s.' };
  if (count > MAX_SLIP_PAGES) return { error: `De pakbon heeft te veel pagina's (hoogstens ${MAX_SLIP_PAGES}).` };
  for (const page of source.getPages()) {
    const { width, height } = page.getSize();
    if (!(width >= MIN_PAGE_POINTS && height >= MIN_PAGE_POINTS && width <= MAX_PAGE_POINTS && height <= MAX_PAGE_POINTS)) return { error: 'De paginagrootte van de PDF is niet bruikbaar.' };
  }
  try {
    const clean = await PDFDocument.create();
    const copied = await clean.copyPages(source, source.getPageIndices());
    for (const page of copied) {
      // Annotaties (links, bijlagen), paginaacties en metadata van de klant komen niet mee.
      for (const key of ['Annots', 'AA', 'Metadata']) page.node.delete(PDFName.of(key));
      clean.addPage(page);
    }
    const bytes = Buffer.from(await clean.save());
    if (bytes.length > MAX_SLIP_BYTES) return { error: `De pakbon is te groot (hoogstens ${MAX_SLIP_BYTES / 1024 / 1024} MB).` };
    return { bytes, pages: count };
  } catch {
    return { error: 'Deze PDF kan niet worden verwerkt.' };
  }
}

checkSlip(Buffer.from(workerData)).then((result) => parentPort.postMessage(result)).catch(() => parentPort.postMessage({ error: 'Deze PDF kan niet worden verwerkt.' }));
