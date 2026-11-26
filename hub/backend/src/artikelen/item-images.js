// Afbeeldingen bij artikelen (tabel item_images, kolom stock_items.image_id, migratie 41).
//
// - Een artikel heeft hoogstens één afbeelding. De browser verkleint hem; de
//   server controleert het formaat op inhoud (JPEG, PNG of WebP), haalt bij JPEG
//   de metadata weg en bewaart hem versleuteld in de database (vault.sealBytes,
//   AAD = tenant + afbeelding-id). Zo gaat hij mee in de back-ups en in
//   PostgreSQL, en wist het verwijderen van een tenant hem ook.
// - Dezelfde foto (SHA-256 van de inhoud) wordt één keer bewaard en door meerdere
//   artikelen gedeeld, bijvoorbeeld de subartikelen van een product.
// - Overnemen uit de oude webshop: artikelen zonder eigen afbeelding waarvan het
//   gekoppelde webshopproduct een afbeelding op een https-adres heeft, worden in
//   porties gedownload (alleen openbare adressen, zonder omleidingen, met een
//   grens in bytes) en daarna als eigen afbeelding gebruikt. Opnieuw uitvoeren
//   neemt alleen over wat nog ontbreekt.
// - De openbare shop toont de afbeelding via `winkel/artikelfoto/<id>`; het
//   beheer via `/api/stock/images/<id>`.
const crypto = require('crypto');
const { inspectImage, fromBase64, MAX_IMAGE_BYTES, MAX_SIDE } = require('../uitvoering/photos');
const { publicAddress } = require('../beveiliging/netguard');
const { createImageCache } = require('../platform/image-cache');
const { pinnedFetch, readBytesLimited } = require('../beveiliging/pinned-fetch');
const { withCause } = require('../platform/error-report');

const DOWNLOAD_TIMEOUT_MS = 10000;
const IMPORT_PAGE_SIZE = 25;
const IMPORT_CONCURRENCY = 5;
const IMAGE_ID_PATTERN = /^[0-9a-f-]{36}$/;
/** Een miniatuur is een WebP van hoogstens zoveel pixels aan de lange kant en zoveel bytes. */
const THUMB_MAX_SIDE = 480;
const THUMB_MAX_BYTES = 100 * 1024;
const THUMB_PAGE_SIZE = 25;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Een leesbare bestandsnaam voor een afbeelding (zonder pad, ingekort).
 * @param {string} name De opgegeven naam of het adres.
 * @returns {string} De naam, of 'afbeelding' als er niets overblijft.
 */
function cleanName(name) {
  const text = String(name || '').split('?')[0].replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f<>"]/g, '').trim();
  return text.slice(0, 80) || 'afbeelding';
}

/**
 * Of een adres een afbeelding is die we mogen ophalen: https (of http/lokaal alleen in de tests).
 * @param {string} text Het adres.
 * @returns {URL|null} Het adres als URL, of null.
 */
function importableUrl(text) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch (error) { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  return process.env.SHOP_ALLOW_INSECURE === '1' && url.protocol === 'http:' ? url : null;
}

/**
 * Maakt de opslag voor artikelafbeeldingen.
 * @param {object} db De database.
 * @param {{ vault: object, fetchImpl?: Function|null, resolveHost?: Function }} options vault = de kluis (sealBytes/openBytes), fetchImpl = eigen fetch (tests), resolveHost = zoekt een hostnaam op (alleen openbare adressen).
 * @returns {{ setForItem: Function, clearForItem: Function, shopImageBytes: Function, file: Function, thumbFile: Function, setThumb: Function, thumbsPending: Function, thumbCandidates: Function, importFromShop: Function, prune: Function, pendingImport: Function, library: Function, forget: Function }} De functies.
 */
function createItemImageStore(db, { vault, fetchImpl = null, resolveHost = publicAddress }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * De AAD waaronder een afbeelding wordt versleuteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de afbeelding.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id) => `${tenantId}:artikel-afbeelding:${id}`;
  /**
   * De AAD waaronder de miniatuur van een afbeelding wordt versleuteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de afbeelding.
   * @returns {string} De context.
   */
  const thumbAadOf = (tenantId, id) => `${tenantId}:artikel-afbeelding-klein:${id}`;
  /** Ontsleutelde afbeeldingen in het geheugen: de shop toont dezelfde foto's steeds opnieuw. */
  const memory = createImageCache();

  /**
   * Verwijdert afbeeldingen waar geen artikel meer naar verwijst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  function prune(tenantId) {
    const removed = prepare('DELETE FROM item_images WHERE tenant_id = ? AND NOT EXISTS (SELECT 1 FROM stock_items i WHERE i.tenant_id = ? AND i.image_id = item_images.id)').run(tenantId, tenantId);
    // Welke afbeeldingen weg zijn weten we niet: dan de hele omgeving uit het geheugen.
    if (!removed || Number(removed.changes) !== 0) memory.clearTenant(tenantId);
  }

  /**
   * Controleert en bewaart een afbeelding; dezelfde inhoud wordt hergebruikt.
   * @param {string} tenantId Id van de omgeving.
   * @param {Buffer} raw De bytes van het bestand.
   * @param {{ name?: string, sourceUrl?: string|null }} [origin] Bestandsnaam en het adres waarvan hij komt.
   * @returns {{ imageId?: string, created?: boolean, error?: string, message?: string, status?: number }} Het id van de afbeelding (created = nieuw bewaard, anders hergebruikt), of een fout.
   */
  function storeImage(tenantId, raw, { name = '', sourceUrl = null } = {}) {
    if (!raw || !raw.length) return { error: 'invalid_image', message: 'Dit is geen geldige afbeelding.', status: 400 };
    if (raw.length > MAX_IMAGE_BYTES) return { error: 'too_large', message: `De afbeelding is te groot (maximaal ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`, status: 413 };
    const image = inspectImage(raw);
    // AVIF (en HEIC) kan de server niet op inhoud controleren zonder een native module; de browser kan ze wel lezen en omzetten.
    if (!image && /^ftyp(avif|avis|heic|heix|mif1)/.test(raw.toString('latin1', 4, 12))) return { error: 'unsupported_format', message: 'AVIF of HEIC: de browser zet dit om naar JPEG.', status: 415 };
    if (!image || image.width > MAX_SIDE || image.height > MAX_SIDE) return { error: 'invalid_image', message: 'Alleen JPEG, PNG of WebP tot 8000 pixels.', status: 400 };
    const contentHash = crypto.createHash('sha256').update(image.body).digest('hex');
    const existing = prepare('SELECT id FROM item_images WHERE tenant_id = ? AND content_hash = ?').get(tenantId, contentHash);
    if (existing) return { imageId: existing.id };
    const id = crypto.randomUUID();
    prepare('INSERT INTO item_images (id, tenant_id, name, mime, width, height, size, content_hash, source_url, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, tenantId, cleanName(name), image.mime, image.width, image.height, image.body.length, contentHash, sourceUrl ? String(sourceUrl).slice(0, 1000) : null,
        vault.sealBytes(image.body, aadOf(tenantId, id)), currentTimestamp());
    return { imageId: id, created: true };
  }

  /**
   * Zet de afbeelding van een artikel (vervangt de vorige).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ name?: string, data?: string }} input Bestandsnaam en base64-inhoud (eventueel als data-URL).
   * @returns {{ imageId?: string, error?: string, message?: string, status?: number }} Het id van de afbeelding, of een fout.
   */
  function setForItem(tenantId, itemId, input) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId));
    if (!item) return { error: 'not_found', message: 'Artikel niet gevonden.', status: 404 };
    const stored = storeImage(tenantId, fromBase64(input && input.data), { name: input && input.name });
    if (stored.error) return stored;
    // Een meegestuurde miniatuur is een extraatje: een ongeldige wordt overgeslagen, de afbeelding zelf telt.
    if (input && input.thumb && (stored.created || !hasThumb(tenantId, stored.imageId))) setThumb(tenantId, stored.imageId, input.thumb);
    prepare('UPDATE stock_items SET image_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(stored.imageId, currentTimestamp(), tenantId, item.id);
    prune(tenantId);
    return { imageId: stored.imageId };
  }

  /**
   * Of een afbeelding al een miniatuur heeft.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @returns {boolean} true bij een bestaande miniatuur.
   */
  function hasThumb(tenantId, imageId) {
    const row = prepare('SELECT thumb FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(imageId));
    return Boolean(row && row.thumb);
  }

  /**
   * Bewaart de miniatuur van een afbeelding: een WebP of JPEG (Safari kan geen WebP maken) van hoogstens 480 pixels en 100 kB (gecontroleerd op inhoud).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @param {string} data De miniatuur als base64 (eventueel als data-URL).
   * @returns {{ ok?: boolean, error?: string, message?: string, status?: number }} ok bij gelukt, of een fout.
   */
  function setThumb(tenantId, imageId, data) {
    if (!IMAGE_ID_PATTERN.test(String(imageId))) return { error: 'not_found', message: 'Afbeelding niet gevonden.', status: 404 };
    const raw = fromBase64(data);
    const image = raw && raw.length && raw.length <= THUMB_MAX_BYTES ? inspectImage(raw) : null;
    if (!image || !['image/webp', 'image/jpeg'].includes(image.mime) || image.width > THUMB_MAX_SIDE || image.height > THUMB_MAX_SIDE) {
      return { error: 'invalid_thumb', message: `Een miniatuur is een WebP of JPEG van hoogstens ${THUMB_MAX_SIDE} pixels en ${THUMB_MAX_BYTES / 1024} kB.`, status: 400 };
    }
    const changed = prepare('UPDATE item_images SET thumb = ? WHERE tenant_id = ? AND id = ?').run(vault.sealBytes(image.body, thumbAadOf(tenantId, String(imageId))), tenantId, String(imageId));
    if (changed && Number(changed.changes) === 0) return { error: 'not_found', message: 'Afbeelding niet gevonden.', status: 404 };
    memory.remove(tenantId, `${imageId}:klein`);
    return { ok: true };
  }

  /**
   * De miniatuur van een afbeelding, of de afbeelding zelf als er nog geen miniatuur is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @returns {{ mime: string, body: Buffer, fallback?: boolean }|null} De miniatuur of afbeelding (fallback = de gewone afbeelding, want er is nog geen miniatuur), of null als hij niet bestaat.
   */
  function thumbFile(tenantId, imageId) {
    if (!IMAGE_ID_PATTERN.test(String(imageId))) return null;
    const key = `${imageId}:klein`;
    const remembered = memory.get(tenantId, key);
    if (remembered) return remembered;
    const row = prepare('SELECT thumb FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(imageId));
    /**
     * De gewone afbeelding als terugval, gemarkeerd zodat hij maar kort wordt gecachet.
     * @returns {{ mime: string, body: Buffer, fallback: boolean }|null} De afbeelding, of null.
     */
    const original = () => { const full = file(tenantId, imageId); return full ? { ...full, fallback: true } : null; };
    if (!row || !row.thumb) return original();
    let found;
    try { const body = vault.openBytes(row.thumb, thumbAadOf(tenantId, String(imageId))); found = { mime: body[0] === 0xff && body[1] === 0xd8 ? 'image/jpeg' : 'image/webp', body }; } catch (error) { return original(); }
    memory.set(tenantId, key, found);
    return found;
  }

  /**
   * Hoeveel gebruikte afbeeldingen nog geen miniatuur hebben.
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Het aantal.
   */
  function thumbsPending(tenantId) {
    return Number(prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ? AND thumb IS NULL').get(tenantId).n);
  }

  /**
   * De volgende afbeeldingen zonder miniatuur (op id, na `after`), voor het in porties aanmaken in de browser.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} [after] Het laatste id van de vorige portie ('' = begin).
   * @returns {{ ids: string[], next: string|null }} De id's en het cursor-id voor de volgende portie (null = klaar).
   */
  function thumbCandidates(tenantId, after = '') {
    const rows = prepare(`SELECT id FROM item_images WHERE tenant_id = ? AND thumb IS NULL AND id::text > ? ORDER BY id::text LIMIT ${THUMB_PAGE_SIZE}`).all(tenantId, String(after || ''));
    return { ids: rows.map((row) => row.id), next: rows.length === THUMB_PAGE_SIZE ? rows[rows.length - 1].id : null };
  }

  /**
   * Haalt de afbeelding bij een artikel weg.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {boolean} false als het artikel niet bestaat.
   */
  function clearForItem(tenantId, itemId) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId));
    if (!item) return false;
    prepare('UPDATE stock_items SET image_id = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, item.id);
    prune(tenantId);
    return true;
  }

  /**
   * De inhoud van een afbeelding.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @returns {{ mime: string, body: Buffer }|null} De afbeelding, of null als hij niet bestaat of niet te lezen is.
   */
  function file(tenantId, imageId) {
    if (!IMAGE_ID_PATTERN.test(String(imageId))) return null;
    const remembered = memory.get(tenantId, String(imageId));
    if (remembered) return remembered;
    const row = prepare('SELECT mime, data FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(imageId));
    if (!row) return null;
    let found;
    try { found = { mime: row.mime, body: vault.openBytes(row.data, aadOf(tenantId, String(imageId))) }; } catch (error) { return null; }
    memory.set(tenantId, String(imageId), found);
    return found;
  }

  /**
   * Downloadt een afbeelding van een https-adres (alleen openbare adressen, geen omleidingen, begrensd).
   * @param {string} imageUrl Het adres.
   * @returns {Promise<Buffer>} De bytes.
   * @throws {Error} Met een leesbare melding als het niet lukt.
   */
  async function download(imageUrl) {
    const url = importableUrl(imageUrl);
    if (!url) throw new Error('Geen geldig https-adres.');
    let send = fetchImpl;
    if (!send) {
      try {
        send = pinnedFetch(await resolveHost(url.hostname));
      } catch (error) {
        throw new Error('Adres is niet openbaar of niet gevonden.', { cause: error });
      }
    }
    let response;
    try {
      response = await send(url.href, { headers: { Accept: 'image/jpeg,image/png,image/webp' }, redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(error && error.name === 'TimeoutError' ? 'Time-out bij het ophalen.' : 'Niet bereikbaar (of doorgestuurd naar een ander adres).', { cause: error });
    }
    if (!response.ok) throw new Error(`Status ${response.status}.`);
    try {
      return await readBytesLimited(response, MAX_IMAGE_BYTES);
    } catch (error) {
      throw new Error(error && error.code === 'too_large' ? 'Afbeelding is te groot.' : 'Lezen is mislukt.', { cause: error });
    }
  }

  const CANDIDATES_SQL = `FROM stock_items i
    JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
    WHERE i.tenant_id = ? AND i.archived = 0 AND i.image_id IS NULL AND p.image IS NOT NULL AND p.image <> ''`;

  /**
   * Hoeveel artikelen nog een afbeelding van de webshop kunnen krijgen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Het aantal.
   */
  function pendingImport(tenantId) {
    return Number(prepare(`SELECT COUNT(*) AS n ${CANDIDATES_SQL}`).get(tenantId).n);
  }

  /**
   * Neemt één portie afbeeldingen over uit de webshop: zoekt de volgende artikelen
   * (op id, na `after`) zonder eigen afbeelding, haalt elk adres één keer op en
   * koppelt de afbeelding aan alle artikelen met dat adres.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ after?: string }} [options] Het laatste artikel-id van de vorige portie ('' = begin).
   * @returns {Promise<{ processed: number, imported: number, reused: number, stored: number, failed: { code: string, itemId: string, url: string, reason: string, convert: boolean }[], next: string|null, pending: number }>} Het resultaat; `stored` = hoeveel nieuwe afbeeldingen er echt zijn bewaard (imported en reused tellen artikelen); `next` is het cursor-id voor de volgende portie of null als alles gehad is.
   */
  async function importFromShop(tenantId, { after = '' } = {}) {
    const rows = prepare(`SELECT i.id, i.code, p.image ${CANDIDATES_SQL} AND i.id::text > ? ORDER BY i.id::text LIMIT ${IMPORT_PAGE_SIZE}`).all(tenantId, String(after || ''));
    const known = new Map(prepare('SELECT id, source_url FROM item_images WHERE tenant_id = ? AND source_url IS NOT NULL').all(tenantId).map((row) => [row.source_url, row.id]));
    const byUrl = new Map();
    for (const row of rows) byUrl.set(row.image, [...(byUrl.get(row.image) || []), row]);
    const result = { processed: rows.length, imported: 0, reused: 0, stored: 0, failed: [], next: rows.length === IMPORT_PAGE_SIZE ? rows[rows.length - 1].id : null, pending: 0 };
    const queue = [...byUrl.keys()];
    /**
     * Neemt adressen uit de wachtrij en koppelt de afbeelding aan de artikelen.
     * @returns {Promise<void>} Klaar als de wachtrij leeg is.
     */
    async function worker() {
      while (queue.length) {
        const url = queue.shift();
        const items = byUrl.get(url);
        let imageId = known.get(url) || null;
        // Een bekende afbeelding kan intussen opgeruimd zijn (artikel verwijderd tijdens het overnemen): dan opnieuw ophalen.
        if (imageId && !prepare('SELECT 1 AS present FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, imageId)) {
          known.delete(url);
          imageId = null;
        }
        if (imageId) {
          result.reused += items.length;
        } else {
          try {
            const stored = storeImage(tenantId, await download(url), { name: url, sourceUrl: url });
            if (stored.error) throw Object.assign(new Error(stored.message), { convert: stored.error === 'unsupported_format' });
            imageId = stored.imageId;
            if (stored.created) result.stored += 1;
            known.set(url, imageId);
            result.imported += items.length;
          } catch (error) {
            for (const item of items) result.failed.push({ code: item.code, itemId: item.id, url, reason: String(error.message || 'Mislukt.').slice(0, 120), convert: Boolean(error.convert) });
            continue;
          }
        }
        for (const item of items) prepare('UPDATE stock_items SET image_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND image_id IS NULL').run(imageId, currentTimestamp(), tenantId, item.id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, worker));
    prune(tenantId);
    result.pending = pendingImport(tenantId);
    return result;
  }

  /**
   * De bytes van de afbeelding van het gekoppelde webshopproduct van een artikel, voor de browser: die zet een formaat dat de server
   * niet kan controleren (AVIF) om. Alleen het adres dat bij het artikel staat, nooit een adres uit het verzoek (geen SSRF).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {Promise<{ body?: Buffer, error?: string, message?: string, status?: number }>} De bytes, of een fout.
   */
  async function shopImageBytes(tenantId, itemId) {
    const row = prepare('SELECT p.image FROM stock_items i JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id WHERE i.tenant_id = ? AND i.id = ?').get(tenantId, String(itemId));
    if (!row || !row.image) return { error: 'not_found', message: 'Geen afbeelding van de webshop bij dit artikel.', status: 404 };
    try {
      return { body: await download(row.image) };
    } catch (error) {
      return { error: 'download_failed', message: String(error.message || 'Ophalen mislukt.').slice(0, 120), status: 502 };
    }
  }

  /**
   * De mediabibliotheek: alle afbeeldingen van de omgeving (zonder inhoud) met de artikelen
   * die ze gebruiken, plus de actieve artikelen zonder afbeelding. Twee queries, geen query per afbeelding.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ images: object[], missing: object[] }} images = [{ id, name, mime, width, height, size, sourceUrl, createdAt, items: [{ id, code, name }] }], missing = [{ id, code, name }].
   */
  function library(tenantId) {
    const images = prepare('SELECT id, name, mime, width, height, size, source_url, created_at FROM item_images WHERE tenant_id = ? ORDER BY created_at DESC, id').all(tenantId);
    const itemRows = prepare('SELECT id, code, name, image_id, archived FROM stock_items WHERE tenant_id = ? ORDER BY code').all(tenantId);
    const usedBy = new Map();
    const missing = [];
    for (const item of itemRows) {
      if (item.image_id) {
        if (!usedBy.has(item.image_id)) usedBy.set(item.image_id, []);
        usedBy.get(item.image_id).push({ id: item.id, code: item.code, name: item.name });
      }
      else if (!Number(item.archived)) missing.push({ id: item.id, code: item.code, name: item.name });
    }
    return {
      images: images.map((row) => ({ id: row.id, name: row.name, mime: row.mime, width: row.width, height: row.height, size: Number(row.size), sourceUrl: row.source_url || '', createdAt: row.created_at, items: usedBy.get(row.id) || [] })),
      missing,
    };
  }

  /**
   * Vergeet de afbeeldingen van een omgeving in het geheugen (na leegmaken of verwijderen van de omgeving).
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  const forget = (tenantId) => memory.clearTenant(tenantId);

  return { setForItem, clearForItem, shopImageBytes, file, thumbFile, setThumb, thumbsPending, thumbCandidates, importFromShop, prune, pendingImport, library, forget };
}

/**
 * Registreert de routes voor artikelafbeeldingen (recht `voorraad`, per omgeving).
 * @param {object} app De Express-app.
 * @param {{ images: object, requireRight: Function, requireJson: Function, audit: Function, importLimiter?: Function }} ctx images = createItemImageStore, importLimiter = begrenzing van het overnemen.
 * @returns {void}
 */
function registerItemImageRoutes(app, { images, requireRight, requireJson, audit, importLimiter = (req, res, next) => next() }) {
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;

  app.put('/api/stock/items/:id/image', requireJson, requireStock, (req, res) => {
    const out = images.setForItem(tenantOf(req), req.params.id, req.body);
    if (out.error) return res.status(out.status || 400).json({ error: out.error, message: out.message });
    audit(req, 'voorraad_afbeelding_gezet', { itemId: req.params.id });
    res.json({ imageId: out.imageId });
  });

  app.delete('/api/stock/items/:id/image', requireStock, (req, res) => {
    if (!images.clearForItem(tenantOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    audit(req, 'voorraad_afbeelding_verwijderd', { itemId: req.params.id });
    res.json({ imageId: null });
  });

  // Voorbeeld in het beheer; de openbare shop heeft zijn eigen route (winkel/artikelfoto).
  app.get('/api/stock/images/:id', requireStock, (req, res) => {
    const file = images.file(tenantOf(req), req.params.id);
    if (!file) return res.status(404).end();
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(file.mime).send(file.body);
  });

  // Miniaturen (480 px WebP, door de browser gemaakt) voor de kaartjes in de shop: opslaan, en de afbeeldingen zonder miniatuur in porties.
  app.put('/api/stock/images/:id/thumb', requireJson, requireStock, (req, res) => {
    const out = images.setThumb(tenantOf(req), req.params.id, req.body && req.body.data);
    if (out.error) return res.status(out.status || 400).json({ error: out.error, message: out.message });
    res.json({ ok: true });
  });

  app.get('/api/stock/images-thumbs', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 64) : '';
    res.json({ pending: images.thumbsPending(tenantOf(req)), ...images.thumbCandidates(tenantOf(req), after) });
  });

  // De afbeelding van het webshopproduct van een artikel als bytes, zodat de browser een AVIF kan omzetten (zie shopImageBytes).
  app.get('/api/stock/items/:id/shop-image', requireStock, importLimiter, async (req, res) => {
    const out = await images.shopImageBytes(tenantOf(req), req.params.id);
    if (out.error) return res.status(out.status || 400).json({ error: out.error, message: out.message });
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('application/octet-stream').send(out.body);
  });

  // Mediabibliotheek: alle afbeeldingen met de artikelen die ze gebruiken, en de artikelen zonder afbeelding.
  app.get('/api/stock/images', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(images.library(tenantOf(req)));
  });

  app.get('/api/stock/images-import', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ pending: images.pendingImport(tenantOf(req)) });
  });

  // Eén portie overnemen uit de webshop; de browser herhaalt met `after` = `next` tot die leeg is.
  app.post('/api/stock/images-import', requireJson, requireStock, importLimiter, async (req, res) => {
    const after = typeof req.body?.after === 'string' ? req.body.after.slice(0, 64) : '';
    try {
      const out = await images.importFromShop(tenantOf(req), { after });
      audit(req, 'voorraad_afbeeldingen_overgenomen', { imported: out.imported, reused: out.reused, failed: out.failed.length });
      res.json(out);
    } catch (error) {
      withCause(res, error).status(500).json({ error: 'import_failed', message: 'Afbeeldingen overnemen is mislukt.' });
    }
  });
}

module.exports = { createItemImageStore, registerItemImageRoutes };
