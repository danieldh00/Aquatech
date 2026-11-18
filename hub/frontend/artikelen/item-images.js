// Afbeeldingen bij artikelen (module Artikelen): een gekozen bestand verkleinen en
// uploaden, de afbeelding van een artikel verwijderen en alle afbeeldingen van de
// oude webshop in porties overnemen. Praat met /api/stock (recht 'voorraad').
(function () {
  const MAX_SIDE = 1200;
  const KEEP_BYTES = 300 * 1024;
  /** Lange kant van de miniatuur voor de kaartjes in de webshop. */
  const THUMB_SIDE = 480;

  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad na '../api/'
   * @param {{ method?: string, body?: object }} [request] methode en inhoud
   * @returns {Promise<object>} het antwoord; gooit een fout met de melding van de server
   */
  async function api(url, { method = 'GET', body } = {}) {
    const response = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || AquatechCommon.statusMessage(response.status)), { code: result.error, status: response.status });
    return result;
  }

  /**
   * Leest een bestand als base64 (zonder het data-URL-voorvoegsel).
   * @param {Blob} blob het bestand
   * @returns {Promise<string>} de base64-inhoud
   */
  function readBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] || ''));
      reader.addEventListener('error', () => reject(new Error('Het bestand kan niet worden gelezen.')));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Maakt van een afbeelding een miniatuur (WebP, hoogstens 480 pixels, witte ondergrond) voor de kaartjes in de webshop.
   * @param {ImageBitmap} bitmap de afbeelding
   * @returns {Promise<string>} de miniatuur als base64, of '' als de browser geen WebP kan maken
   */
  async function makeThumb(bitmap) {
    const scale = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
    return blob && blob.type === 'image/webp' ? readBase64(blob) : '';
  }

  /**
   * Maakt een gekozen bestand klaar voor het uploaden: een grote afbeelding wordt
   * verkleind tot maximaal 1200 pixels (JPEG op een witte ondergrond), een kleine blijft zoals hij is.
   * @param {File} file het gekozen bestand (JPEG, PNG of WebP)
   * @returns {Promise<{ name: string, data: string, thumb?: string }>} bestandsnaam, base64-inhoud en (als de browser het kan) een miniatuur
   */
  async function prepare(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Kies een JPEG-, PNG- of WebP-afbeelding.');
    let bitmap = null;
    try { bitmap = await createImageBitmap(file); } catch (error) { /* geen voorbeeld mogelijk: de server controleert */ }
    const thumb = bitmap ? await makeThumb(bitmap).catch(() => '') : '';
    if (!bitmap || (file.size <= KEEP_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE)) return { name: file.name, data: await readBase64(file), thumb };
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: await readBase64(blob || file), thumb };
  }

  /**
   * Zet de afbeelding van een artikel.
   * @param {string} itemId het artikel
   * @param {{ name: string, data: string }} picked het resultaat van prepare()
   * @returns {Promise<string>} het id van de afbeelding
   */
  async function upload(itemId, picked) {
    return (await api(`stock/items/${encodeURIComponent(itemId)}/image`, { method: 'PUT', body: picked })).imageId;
  }

  /**
   * Haalt de afbeelding van een artikel weg.
   * @param {string} itemId het artikel
   * @returns {Promise<void>}
   */
  async function remove(itemId) {
    await api(`stock/items/${encodeURIComponent(itemId)}/image`, { method: 'DELETE' });
  }

  /**
   * Het adres van een afbeelding in het beheer.
   * @param {string} imageId id van de afbeelding
   * @returns {string} het relatieve adres
   */
  const src = (imageId) => `../api/stock/images/${encodeURIComponent(imageId)}`;

  /**
   * Hoeveel artikelen nog een afbeelding van de webshop kunnen overnemen.
   * @returns {Promise<number>} het aantal
   */
  async function pending() {
    return Number((await api('stock/images-import')).pending) || 0;
  }

  /**
   * Neemt de afbeeldingen uit de webshop over, portie voor portie, tot alles gehad is.
   * Opnieuw uitvoeren neemt alleen over wat nog ontbreekt.
   * @param {(progress: { imported: number, reused: number, stored: number, failed: object[], pending: number }) => void} onProgress wordt na elke portie aangeroepen met de totalen
   * @returns {Promise<{ imported: number, reused: number, stored: number, failed: object[], pending: number }>} de totalen
   */
  async function importAll(onProgress) {
    const totals = { imported: 0, reused: 0, stored: 0, failed: [], pending: 0 };
    let after = '';
    for (;;) {
      const part = await api('stock/images-import', { method: 'POST', body: { after } });
      totals.imported += part.imported;
      totals.reused += part.reused;
      totals.stored += part.stored;
      totals.failed.push(...part.failed);
      totals.pending = part.pending;
      if (onProgress) onProgress({ ...totals });
      if (!part.next) return totals;
      after = part.next;
    }
  }

  /**
   * Hoeveel afbeeldingen nog geen miniatuur hebben.
   * @returns {Promise<number>} het aantal
   */
  async function thumbsPending() {
    return Number((await api('stock/images-thumbs')).pending) || 0;
  }

  /**
   * Maakt de ontbrekende miniaturen aan, portie voor portie: haalt elke afbeelding op, verkleint hem in de browser en bewaart de miniatuur.
   * Opnieuw uitvoeren doet alleen wat nog ontbreekt.
   * @param {(progress: { done: number, failed: number, pending: number }) => void} onProgress wordt na elke afbeelding aangeroepen
   * @returns {Promise<{ done: number, failed: number, pending: number }>} de totalen
   */
  async function thumbsAll(onProgress) {
    const totals = { done: 0, failed: 0, pending: 0 };
    let after = '';
    for (;;) {
      const part = await api(`stock/images-thumbs?after=${encodeURIComponent(after)}`);
      totals.pending = part.pending;
      for (const id of part.ids) {
        try {
          const response = await fetch(src(id), { cache: 'no-store' });
          if (!response.ok) throw new Error('niet te lezen');
          const thumb = await makeThumb(await createImageBitmap(await response.blob()));
          if (!thumb) throw new Error('geen WebP');
          await api(`stock/images/${encodeURIComponent(id)}/thumb`, { method: 'PUT', body: { data: thumb } });
          totals.done += 1;
        } catch (error) {
          totals.failed += 1;
        }
        if (onProgress) onProgress({ ...totals, pending: Math.max(0, part.pending - totals.done - totals.failed) });
      }
      if (!part.next) return totals;
      after = part.next;
    }
  }

  window.ItemImages = { prepare, upload, remove, src, pending, importAll, thumbsPending, thumbsAll };
})();
