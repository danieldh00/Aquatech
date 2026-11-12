// Dropshipping (punt 8): de eigen pakbon (PDF) die een klant bij een dropshippingbestelling uploadt. De PDF wordt bij het
// uploaden gecontroleerd (echte PDF, niet beveiligd, hoogstens 2 MB en 10 pagina's) en opnieuw opgebouwd uit de pagina's
// (scripts, bijlagen en formulieren van de klant komen er zo niet in), versleuteld bewaard per bestelling (tabel
// web_order_slips, vault.sealBytes met de omgeving en bestelling als AAD) en bij Te picken / Alles afdrukken in plaats van
// onze eigen pakbon in de PDF gezet. De gegevens van de dropshippingbestelling zelf staan in `data.dropshipping`.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { transaction } = require('../database/db');

/** Hoogstens zoveel bytes voor een geüploade pakbon. */
const MAX_SLIP_BYTES = 2 * 1024 * 1024;
/** Hoogstens zoveel pagina's in een geüploade pakbon. */
const MAX_SLIP_PAGES = 10;
/** Een pagina is minstens zo groot en hoogstens zo groot (in punten, 72 per inch): een A0-vel is 2384 × 3370. */
const MIN_PAGE_POINTS = 100;
const MAX_PAGE_POINTS = 3400;

/**
 * Controleert een geüploade pakbon en bouwt hem opnieuw op uit de pagina's.
 * @param {Buffer} buffer De ontvangen bytes.
 * @returns {Promise<{ bytes?: Buffer, pages?: number, error?: string }>} De schone PDF en het aantal pagina's, of een melding in gewone taal.
 */
async function inspectSlip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return { error: 'Het bestand is leeg.' };
  if (buffer.length > MAX_SLIP_BYTES) return { error: `De pakbon is te groot (hoogstens ${MAX_SLIP_BYTES / 1024 / 1024} MB).` };
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'Dit is geen PDF-bestand.' };
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
    for (const page of copied) clean.addPage(page);
    const bytes = Buffer.from(await clean.save());
    if (bytes.length > MAX_SLIP_BYTES) return { error: `De pakbon is te groot (hoogstens ${MAX_SLIP_BYTES / 1024 / 1024} MB).` };
    return { bytes, pages: count };
  } catch {
    return { error: 'Deze PDF kan niet worden verwerkt.' };
  }
}

/**
 * Zet de pagina's van de pakbonnen in de volgorde van de bestellingen achter elkaar: onze eigen pakbon voor gewone
 * bestellingen, de pakbon van de klant (met bovenaan de eerste pagina het bestelnummer) voor dropshippingbestellingen.
 * @param {{ type: 'ours', first: number, last: number }|{ type: 'slip', bytes: Buffer, label: string }} sequence Per bestelling in volgorde: een bereik pagina's (vanaf 0) uit `oursBytes`, of de pakbon van de klant met de tekst die erop komt.
 * @param {Buffer|null} oursBytes De PDF met onze eigen pakbonnen (leeg als er geen zijn).
 * @returns {Promise<Buffer>} De samengevoegde PDF.
 */
async function assemblePdf(sequence, oursBytes) {
  const output = await PDFDocument.create();
  const ours = oursBytes ? await PDFDocument.load(oursBytes) : null;
  const font = await output.embedFont(StandardFonts.HelveticaBold);
  for (const part of sequence) {
    if (part.type === 'ours') {
      const indices = [];
      for (let index = part.first; index <= part.last; index++) indices.push(index);
      for (const page of await output.copyPages(ours, indices)) output.addPage(page);
      continue;
    }
    const slip = await PDFDocument.load(part.bytes);
    const pages = await output.copyPages(slip, slip.getPageIndices());
    pages.forEach((page, index) => {
      output.addPage(page);
      if (index === 0) {
        // Een klein etiket in de bovenste hoek, zodat de picker weet bij welke bestelling deze pakbon hoort.
        const { height } = page.getSize();
        const text = part.label.replace(/[^\x20-\x7e]/g, '');
        const width = font.widthOfTextAtSize(text, 8);
        page.drawRectangle({ x: 14, y: height - 22, width: width + 8, height: 12, color: rgb(1, 1, 1), opacity: 0.9 });
        page.drawText(text, { x: 18, y: height - 19, size: 8, font, color: rgb(0.1, 0.18, 0.37) });
      }
    });
  }
  return Buffer.from(await output.save());
}

/**
 * Maakt de opslag voor de pakbonnen van klanten.
 * @param {object} db De database.
 * @param {{ vault: object, orders: object }} deps De kluis (sealBytes/openBytes) en de bestellingen (web-orders.js, voor `data.dropshipping`).
 * @returns {{ save: Function, read: Function, readMany: Function, remove: Function }} De functies.
 */
function createOrderSlips(db, { vault, orders }) {
  /**
   * De versleutelingscontext van de pakbon van één bestelling.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {string} De context (AAD) voor sealBytes en openBytes.
   */
  const aadOf = (tenantId, orderId) => `${tenantId}:pakbon:${orderId}`;

  /**
   * Bewaart (of vervangt) de pakbon van een bestelling en legt de gegevens vast in `data.dropshipping.slip`.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {{ bytes: Buffer, pages: number, fileName: string }} slip De gecontroleerde PDF (inspectSlip).
   * @returns {void}
   */
  function save(tenantId, orderId, { bytes, pages, fileName }) {
    const timestamp = new Date().toISOString();
    transaction(db, () => {
      db.prepare('DELETE FROM web_order_slips WHERE tenant_id = ? AND order_id = ?').run(tenantId, orderId);
      db.prepare('INSERT INTO web_order_slips (tenant_id, order_id, file_name, pages, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tenantId, orderId, fileName, pages, bytes.length, vault.sealBytes(bytes, aadOf(tenantId, orderId)), timestamp);
    });
    orders.setDropshippingSlip(tenantId, orderId, { name: fileName, pages, size: bytes.length, uploadedAt: timestamp });
  }

  /**
   * De pakbon van één bestelling.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {?{ bytes: Buffer, fileName: string, pages: number }} De PDF, of null als er geen is.
   */
  function read(tenantId, orderId) {
    return readMany(tenantId, [orderId]).get(String(orderId)) || null;
  }

  /**
   * De pakbonnen van meerdere bestellingen in één query.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} orderIds De bestellingen.
   * @returns {Map<string, { bytes: Buffer, fileName: string, pages: number }>} De pakbon per bestelling-id (alleen waar er een is).
   */
  function readMany(tenantId, orderIds) {
    const wanted = Array.from(new Set(orderIds.map(String)));
    const map = new Map();
    if (!wanted.length) return map;
    const rows = db.prepare(`SELECT order_id, file_name, pages, data FROM web_order_slips WHERE tenant_id = ? AND order_id IN (${wanted.map(() => '?').join(', ')})`).all(tenantId, ...wanted);
    for (const row of rows) map.set(String(row.order_id), { bytes: vault.openBytes(row.data, aadOf(tenantId, row.order_id)), fileName: row.file_name, pages: Number(row.pages) });
    return map;
  }

  /**
   * Verwijdert de pakbon van een bestelling (ook uit `data.dropshipping`).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {void}
   */
  function remove(tenantId, orderId) {
    db.prepare('DELETE FROM web_order_slips WHERE tenant_id = ? AND order_id = ?').run(tenantId, orderId);
    orders.setDropshippingSlip(tenantId, orderId, null);
  }

  return { save, read, readMany, remove };
}

module.exports = { createOrderSlips, inspectSlip, assemblePdf, MAX_SLIP_BYTES, MAX_SLIP_PAGES };
