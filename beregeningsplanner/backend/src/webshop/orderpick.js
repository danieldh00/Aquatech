// Orderpick (punt 16): de API van de orderpick-app voor het magazijn (recht `orderpick`, rol Picker). De picker ziet de te picken
// bestellingen, per bestelling de regels op volgorde van magazijnlocatie met de codes die bij het scannen horen (EAN van het artikel
// of van de verpakking), vult het gepickte aantal in en meldt de bestelling af. Afmelden gebruikt `webOrders.ship`: de gepickte aantallen
// gaan van de voorraad, een minder gepickt aantal blijft op backorder, en bij de laatste zending volgen factuur en verzendmail.
// De picker krijgt bewust geen prijzen, adressen, klantnamen of instellingen te zien; alleen de pakbon (PDF) bevat het adres.
// Alles loopt per omgeving (tenant) en de aantallen worden op de server gecontroleerd.

const { withCause } = require('../platform/error-report');
const { splitCartCode } = require('./web-orders');

/** Hoeveel artikelen per query (IN-lijst). */
const CHUNK = 200;

/**
 * Sorteert magazijnlocaties natuurlijk (A2 vóór A10); regels zonder locatie komen onderaan.
 * @param {{ location: string, name: string }} left De ene regel.
 * @param {{ location: string, name: string }} right De andere regel.
 * @returns {number} Negatief, nul of positief.
 */
function byLocation(left, right) {
  if (left.location && !right.location) return -1;
  if (!left.location && right.location) return 1;
  return left.location.localeCompare(right.location, 'nl', { numeric: true }) || left.name.localeCompare(right.name, 'nl');
}

/**
 * Maakt de orderpick-opslag.
 * @param {object} db De database.
 * @param {{ orders: object, slips: object, labels: object }} deps De bestellingen (web-orders.js), de pakbonnen (packing-slips.js) en de labeldienst (shipping-labels.js).
 * @returns {{ list: Function, detail: Function, pick: Function, packingSlip: Function, label: Function }} De functies.
 */
function createOrderpick(db, { orders, slips, labels }) {
  /** Zendingen waarvan nu een label wordt gemaakt. */
  const labelsBusy = new Set();

  /**
   * Leest de locatie, EAN en code van de artikelen en de EAN van hun verpakkingen (twee queries per 200 artikelen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds De artikel-id's.
   * @returns {{ items: Map<string, { code: string, ean: string, location: string }>, packagings: Map<string, { ean: string, name: string }> }} Per artikel-id de gegevens en per `<artikel-id>@<verpakkingscode>` de EAN en naam van de verpakking.
   */
  function scanData(tenantId, itemIds) {
    const items = new Map();
    const packagings = new Map();
    for (let start = 0; start < itemIds.length; start += CHUNK) {
      const chunk = itemIds.slice(start, start + CHUNK);
      const marks = chunk.map(() => '?').join(', ');
      for (const row of db.prepare(`SELECT id, code, ean, location FROM stock_items WHERE tenant_id = ? AND id IN (${marks})`).all(tenantId, ...chunk)) {
        items.set(String(row.id), { code: String(row.code || ''), ean: String(row.ean || ''), location: String(row.location || '') });
      }
      for (const row of db.prepare(`SELECT item_id, code, name, ean FROM item_packagings WHERE tenant_id = ? AND item_id IN (${marks})`).all(tenantId, ...chunk)) {
        packagings.set(`${row.item_id}@${row.code}`, { ean: String(row.ean || ''), name: String(row.name || '') });
      }
    }
    return { items, packagings };
  }

  /**
   * De bestellingen die nu gepickt kunnen worden (oudste eerst), zonder prijzen, adres of klantnaam.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[], waitingForStock: number, truncated: boolean }} Per bestelling: id, nummer, datum, verzendmethode, aantal regels en stuks, en of het een deellevering of dropshipping is (de vrije opmerking van de klant blijft bewust weg: daar staan vaak persoonsgegevens in).
   */
  function list(tenantId) {
    const { items, truncated, waitingForStock } = orders.listToPick(tenantId);
    return {
      truncated, waitingForStock: waitingForStock.length,
      items: items.map((order) => ({
        id: order.id, number: order.number, createdAt: order.createdAt, shippingLabel: order.shipping ? order.shipping.label : '',
        pickup: Boolean(order.shipping && order.shipping.method === 'ophalen'), dropshipping: Boolean(order.dropshipping),
        lineCount: order.fulfilment.lines.filter((entry) => entry.ready > 0).length, pieces: order.fulfilment.lines.reduce((sum, entry) => sum + entry.ready, 0),
        partial: order.fulfilment.backorder, hadShipments: order.shipments.length > 0
      })),
    };
  }

  /**
   * Eén bestelling om te picken: de regels gesorteerd op magazijnlocatie, met per regel wat er gepickt moet worden en de codes die bij het scannen kloppen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @returns {{ order?: object, error?: string, code?: string, status?: number }} De bestelling of een foutmelding (404 onbekend, 409 niet te picken of wacht op voorraad).
   */
  function detail(tenantId, id) {
    const order = orders.getDetailed(tenantId, id);
    if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
    if (!orders.pickable(order)) return { error: 'Deze bestelling staat niet klaar om te picken (al verzonden, geannuleerd, nog niet betaald of de pakbon van de klant ontbreekt).', code: 'not_pickable', status: 409 };
    if (!order.fulfilment.canShip) return { error: 'Deze bestelling wacht op voorraad en kan nu niet gepickt worden.', code: 'waiting_for_stock', status: 409 };
    const itemIds = [...new Set(order.lines.map((line) => String(line.itemId || '')).filter(Boolean))];
    const data = scanData(tenantId, itemIds);
    const lines = order.fulfilment.lines.filter((entry) => entry.remaining > 0).map((entry) => {
      const line = order.lines[entry.index];
      const item = data.items.get(String(line.itemId || '')) || { code: '', ean: '', location: '' };
      // De orderregel bewaart de wagencode (CODE@PAL) en de factor; de verpakking zelf staat in item_packagings.
      const packCode = Number(line.stockPer) > 1 ? splitCartCode(line.code).packCode : '';
      const packaging = packCode ? data.packagings.get(`${line.itemId}@${packCode}`) || { ean: '', name: '' } : null;
      // Een verpakkingsregel scant met de EAN van de verpakking (of de wagencode), een gewone regel met de EAN of de code van het artikel.
      const scanCodes = (packCode ? [packaging.ean, String(line.code || '')] : [item.ean, item.code]).filter(Boolean);
      return {
        index: entry.index, code: String(line.code || ''), name: String(line.name || line.code || '-'), unit: String(line.unit || ''),
        location: item.location, ordered: entry.ordered, shipped: entry.shipped, remaining: entry.remaining, ready: entry.ready, backorder: entry.backorder,
        packaging: packCode ? { code: packCode, name: packaging.name, factor: Number(line.stockPer) || 0 } : null,
        scanCodes, scannable: scanCodes.length > 0,
      };
    }).sort((left, right) => (Number(left.ready === 0) - Number(right.ready === 0)) || byLocation(left, right));
    return {
      order: {
        id: order.id, number: order.number, createdAt: order.createdAt, shippingLabel: order.shipping ? order.shipping.label : '',
        pickup: Boolean(order.shipping && order.shipping.method === 'ophalen'), dropshipping: Boolean(order.dropshipping),
        allowPartial: order.allowPartial, shipmentCount: order.shipments.length, lines, label: labels.statusFor(tenantId, order),
      },
    };
  }

  /**
   * Meldt een bestelling af: de gepickte aantallen worden verzonden, wat minder is blijft op backorder. De picker geeft het aantal zendingen
   * mee dat hij kent (`shipmentCount`): is de bestelling intussen door een ander verzonden, dan gebeurt er niets (409 `changed`).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {{ lines?: { index: number, qty: number }[], shipmentCount?: number }} body De gepickte regels en het aantal bekende zendingen.
   * @param {object} user De picker.
   * @returns {{ result?: object, error?: string, code?: string, status?: number }} Het resultaat (zending, of de bestelling klaar is, label en pakbonadres) of een foutmelding.
   */
  function pick(tenantId, id, body, user) {
    if (!body || !Array.isArray(body.lines)) return { error: 'Geef de gepickte regels op.', status: 400 };
    if (!Number.isInteger(body.shipmentCount) || body.shipmentCount < 0) return { error: 'Geef het aantal bekende zendingen op.', status: 400 };
    if (body.lines.some((part) => !part || !Number.isInteger(part.index) || typeof part.qty !== 'number' || !Number.isFinite(part.qty))) return { error: 'Ongeldige regel of ongeldig aantal.', status: 400 };
    const order = orders.get(tenantId, id);
    if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
    if (!orders.pickable(order)) return { error: 'Deze bestelling staat niet klaar om te picken.', code: 'not_pickable', status: 409 };
    const out = orders.ship(tenantId, id, body.lines.map((part) => ({ index: part && part.index, qty: part && part.qty })), user, { expectedShipments: body.shipmentCount });
    if (out.error) return out;
    return {
      result: {
        complete: out.complete, status: out.order.status, number: out.order.number,
        shipment: { id: out.shipment.id, at: out.shipment.at, lines: out.shipment.lines },
        label: labels.statusFor(tenantId, out.order),
      },
      order: out.order,
    };
  }

  /**
   * De pakbon (PDF) van een zending, met de aantallen die echt gepickt zijn.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} shipmentId Id van de zending.
   * @returns {Promise<{ pdf?: Buffer, fileName?: string, orders?: object[], error?: string, status?: number }>} De PDF of een foutmelding.
   */
  function packingSlip(tenantId, id, shipmentId) {
    // Een herdruk van een zendingspakbon zet de bestelling niet opnieuw op "afgedrukt" (dat hoort bij de pakbon van Te picken).
    return slips.pdfFor(tenantId, [id], { shipmentId: String(shipmentId || ''), markPrinted: false });
  }

  /**
   * Het verzendlabel van een zending (DPD). Zonder koppeling een nette melding; met koppeling wordt de volgcode bij de bestelling bewaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} shipmentId Id van de zending.
   * @returns {Promise<{ pdf?: Buffer, fileName?: string, order?: object, error?: string, code?: string, status?: number, cause?: Error }>} Het label of een foutmelding.
   */
  async function label(tenantId, id, shipmentId) {
    // Eén label tegelijk per zending (dubbel tikken, twee schermen): anders maakt de vervoerder er twee en verandert de volgcode.
    const lockKey = `${tenantId}:${id}:${shipmentId}`;
    if (labelsBusy.has(lockKey)) return { error: 'Het label voor deze zending wordt al gemaakt. Wacht even.', code: 'label_busy', status: 409 };
    labelsBusy.add(lockKey);
    try {
      return await makeLabel(tenantId, id, shipmentId);
    } finally {
      labelsBusy.delete(lockKey);
    }
  }

  /**
   * Maakt het label (zie label) zodra de zending is vergrendeld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} shipmentId Id van de zending.
   * @returns {Promise<object>} Zie label.
   */
  async function makeLabel(tenantId, id, shipmentId) {
    const order = orders.get(tenantId, id);
    if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
    const shipment = order.shipments.find((entry) => entry.id === String(shipmentId || ''));
    if (!shipment) return { error: 'Zending niet gevonden.', status: 404 };
    if (shipment.label) return { error: `Voor deze zending is al een label gemaakt${shipment.label.trackingCode ? ` (volgcode ${shipment.label.trackingCode})` : ''}. Een tweede label zou een tweede pakket betekenen.`, code: 'label_exists', status: 409 };
    const made = await labels.create(tenantId, order, shipment);
    if (made.error) return made;
    // Meteen vastleggen, zodat een tweede tik of scherm nooit een tweede label maakt.
    orders.recordShipmentLabel(tenantId, id, shipment.id, made.trackingCode);
    // Een volgcode gaat alleen bij de bestelling als die er nog geen heeft (de klant krijgt dan de mail met track & trace); een ongeldige code stopt het label niet.
    if (made.trackingCode && !(order.shipping && order.shipping.tracking)) orders.setTracking(tenantId, id, made.trackingCode);
    return { pdf: made.pdf, fileName: `Label ${order.number}.pdf`.replace(/[^\w .()-]/g, ''), order };
  }

  return { list, detail, pick, packingSlip, label };
}

/**
 * Registreert de routes van de orderpick-app onder /api/orderpick (recht `orderpick`).
 * @param {object} app De Express-app.
 * @param {{ orderpick: object, requireRight: Function, requireJson: Function, audit: Function, limiter: Function }} deps De orderpick-opslag, de rechtencontrole, de JSON-controle, het auditlogboek en de limiet voor het maken van PDF's.
 * @returns {void}
 */
function registerOrderpickRoutes(app, { orderpick, requireRight, requireJson, audit, limiter }) {
  const allowed = requireRight('orderpick');
  // Wijzigingen van de orderpick-app staan nooit in de browsercache; de lijst mag offline uit de cache van de service worker (sw.js).
  app.use('/api/orderpick', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, allowed);

  app.get('/api/orderpick/orders', (req, res) => {
    res.json(orderpick.list(req.tenantId));
  });

  app.get('/api/orderpick/orders/:id', (req, res) => {
    const out = orderpick.detail(req.tenantId, req.params.id);
    if (out.error) return res.status(out.status || 400).json({ error: out.code || 'not_found', message: out.error });
    res.json({ order: out.order });
  });

  app.post('/api/orderpick/orders/:id/pick', requireJson, (req, res) => {
    const out = orderpick.pick(req.tenantId, req.params.id, req.body, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: out.code || 'pick_failed', message: out.error });
    const pickedPieces = out.result.shipment.lines.reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);
    audit(req, 'orderpick_gepickt', { number: out.result.number, complete: out.result.complete, lines: out.result.shipment.lines.length, pieces: pickedPieces });
    res.json(out.result);
  });

  app.post('/api/orderpick/orders/:id/shipments/:shipmentId/packing-slip', limiter, requireJson, async (req, res) => {
    const out = await orderpick.packingSlip(req.tenantId, req.params.id, req.params.shipmentId);
    if (out.error) return res.status(out.status || 400).json({ error: 'packing_slip_failed', message: out.error });
    audit(req, 'orderpick_pakbon', { number: out.orders[0].number });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.fileName.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
    res.send(out.pdf);
  });

  app.post('/api/orderpick/orders/:id/shipments/:shipmentId/label', limiter, requireJson, async (req, res) => {
    const out = await orderpick.label(req.tenantId, req.params.id, req.params.shipmentId);
    if (out.error) {
      return withCause(res, out.cause).status(out.status || 400).json({ error: out.code || 'label_failed', message: out.error });
    }
    audit(req, 'orderpick_label', { number: out.order.number });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.fileName.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
    res.send(out.pdf);
  });
}

module.exports = { createOrderpick, registerOrderpickRoutes, byLocation };
