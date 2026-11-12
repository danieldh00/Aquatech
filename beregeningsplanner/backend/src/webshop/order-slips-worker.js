// Werkthread voor de controle van een geüploade pakbon (order-slips.js, inspectSlip): leest de PDF met pdf-lib, bouwt hem opnieuw op
// zonder annotaties, paginaacties en metadata en geeft de schone bytes terug. Draait apart zodat een zware PDF de server niet blokkeert.
const { parentPort, workerData } = require('worker_threads');
const { PDFDocument, PDFName } = require('pdf-lib');

/** Hoogstens zoveel bytes voor een geüploade pakbon. */
const MAX_SLIP_BYTES = 2 * 1024 * 1024;
/** Hoogstens zoveel pagina's in een geüploade pakbon. */
const MAX_SLIP_PAGES = 10;
/** Een pagina is minstens zo groot en hoogstens zo groot (in punten, 72 per inch): een A0-vel is 2384 × 3370. */
const MIN_PAGE_POINTS = 100;
const MAX_PAGE_POINTS = 3400;

/**
 * Controleert een geüploade pakbon en bouwt hem opnieuw op uit de pagina's (zonder annotaties, paginaacties en metadata).
 * @param {Buffer} buffer De ontvangen bytes.
 * @returns {Promise<{ bytes?: Buffer, pages?: number, error?: string }>} De schone PDF en het aantal pagina's, of een melding in gewone taal.
 */
async function checkSlip(buffer) {
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
