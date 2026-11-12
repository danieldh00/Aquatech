// Dropshipping (punt 8): de eigen pakbon (PDF) die een klant bij een dropshippingbestelling uploadt. De PDF wordt bij het
// uploaden gecontroleerd (echte PDF, niet beveiligd, hoogstens 2 MB en 10 pagina's) en opnieuw opgebouwd uit de pagina's
// (annotaties, paginaacties en metadata van de klant worden weggehaald; de controle draait in een werkthread, order-slips-worker.js), versleuteld bewaard per bestelling (tabel
// web_order_slips, vault.sealBytes met de omgeving en bestelling als AAD) en bij Te picken / Alles afdrukken in plaats van
// onze eigen pakbon in de PDF gezet. De gegevens van de dropshippingbestelling zelf staan in `data.dropshipping`.
const path = require('path');
const { Worker } = require('worker_threads');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { transaction } = require('../database/db');

/** Hoogstens zoveel bytes voor een geüploade pakbon. */
const MAX_SLIP_BYTES = 2 * 1024 * 1024;
/** Hoogstens zoveel pagina's in een geüploade pakbon. */
const MAX_SLIP_PAGES = 10;
/** De controle van een upload mag hoogstens zo lang duren (milliseconden). */
const WORKER_TIMEOUT_MS = 8000;

/**
 * Controleert een geüploade pakbon in een aparte werkthread met begrensd geheugen en een tijdslimiet (een PDF met gecomprimeerde
 * objectstromen kan veel groter uitpakken dan hij is, en pdf-lib leest synchroon: zo blijft de server er niet door hangen).
 * @param {Buffer} buffer De ontvangen bytes.
 * @returns {Promise<{ bytes?: Buffer, pages?: number, error?: string }>} De schone PDF en het aantal pagina's, of een melding in gewone taal.
 */
function inspectSlip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return Promise.resolve({ error: 'Het bestand is leeg.' });
  if (buffer.length > MAX_SLIP_BYTES) return Promise.resolve({ error: `De pakbon is te groot (hoogstens ${MAX_SLIP_BYTES / 1024 / 1024} MB).` });
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return Promise.resolve({ error: 'Dit is geen PDF-bestand.' });
  return new Promise((resolve) => {
    const unusable = { error: 'Deze PDF kan niet worden verwerkt.' };
    const worker = new Worker(path.join(__dirname, 'order-slips-worker.js'), { workerData: buffer, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => { worker.terminate(); resolve(unusable); }, WORKER_TIMEOUT_MS);
    worker.once('message', (result) => { clearTimeout(timer); resolve(result && result.bytes ? { bytes: Buffer.from(result.bytes), pages: result.pages } : { error: String((result && result.error) || unusable.error) }); });
    worker.once('error', () => { clearTimeout(timer); resolve(unusable); });
  });
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
        // Een klein etiket in de linkerbovenhoek zoals je de pagina ziet (ook bij een gedraaide pagina of een MediaBox met afwijkende hoek).
        const text = part.label.replace(/[^\x20-\x7e]/g, '');
        const width = font.widthOfTextAtSize(text, 8);
        const box = page.getMediaBox();
        const angle = ((page.getRotation().angle % 360) + 360) % 360;
        const corner = { 0: [box.x, box.y + box.height], 90: [box.x, box.y], 180: [box.x + box.width, box.y], 270: [box.x + box.width, box.y + box.height] }[angle] || [box.x, box.y + box.height];
        const radians = (angle * Math.PI) / 180;
        /**
         * Zet een punt in de bovenhoek van de zichtbare pagina (rechts en omhoog) om naar paginacoördinaten.
         * @param {number} right Afstand naar rechts.
         * @param {number} up Afstand omhoog (negatief = omlaag).
         * @returns {{ x: number, y: number }} Het punt op de pagina.
         */
        const place = (right, up) => ({ x: corner[0] + right * Math.cos(radians) - up * Math.sin(radians), y: corner[1] + right * Math.sin(radians) + up * Math.cos(radians) });
        const rectAt = place(10, -22);
        const textAt = place(14, -19);
        page.drawRectangle({ ...rectAt, width: width + 8, height: 12, rotate: degrees(angle), color: rgb(1, 1, 1), opacity: 0.9 });
        page.drawText(text, { ...textAt, size: 8, rotate: degrees(angle), font, color: rgb(0.1, 0.18, 0.37) });
      }
    });
  }
  return Buffer.from(await output.save());
}

/**
 * Maakt de opslag voor de pakbonnen van klanten.
 * @param {object} db De database.
 * @param {{ vault: object, orders: object }} deps De kluis (sealBytes/openBytes) en de bestellingen (web-orders.js, voor `data.dropshipping`).
 * @returns {{ save: Function, read: Function, readMany: Function }} De functies.
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
   * Bewaart (of vervangt) de pakbon van een bestelling en legt de gegevens vast in `data.dropshipping.slip`, alles in één transactie.
   * De bestelling wordt daarin opnieuw gecontroleerd: nog nieuw en van de eigenaar, anders gebeurt er niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {{ bytes: Buffer, pages: number, fileName: string }} slip De gecontroleerde PDF (inspectSlip).
   * @returns {{ ok?: boolean, error?: string, status?: number }} ok bij succes, anders een melding (409 als de bestelling intussen is verzonden of geannuleerd).
   */
  function save(tenantId, orderId, { bytes, pages, fileName }) {
    const timestamp = new Date().toISOString();
    return transaction(db, () => {
      const stored = orders.setDropshippingSlip(tenantId, orderId, { name: fileName, pages, size: bytes.length, uploadedAt: timestamp }, { onlyIfNew: true });
      if (!stored) return { error: 'Deze bestelling is al in behandeling; de pakbon kan niet meer worden gewijzigd.', status: 409 };
      db.prepare('DELETE FROM web_order_slips WHERE tenant_id = ? AND order_id = ?').run(tenantId, orderId);
      db.prepare('INSERT INTO web_order_slips (tenant_id, order_id, file_name, pages, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tenantId, orderId, fileName, pages, bytes.length, vault.sealBytes(bytes, aadOf(tenantId, orderId)), timestamp);
      return { ok: true };
    });
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

  return { save, read, readMany };
}

module.exports = { createOrderSlips, inspectSlip, assemblePdf, MAX_SLIP_BYTES, MAX_SLIP_PAGES };
