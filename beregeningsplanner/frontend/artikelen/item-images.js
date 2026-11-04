// Afbeeldingen bij artikelen (module Artikelen): een gekozen bestand verkleinen en
// uploaden, de afbeelding van een artikel verwijderen en alle afbeeldingen van de
// oude webshop in porties overnemen. Praat met /api/stock (recht 'voorraad').
(function () {
  const MAX_SIDE = 1200;
  const KEEP_BYTES = 300 * 1024;

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
    if (!response.ok) throw Object.assign(new Error(result.message || `HTTP ${response.status}`), { code: result.error, status: response.status });
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
   * Maakt een gekozen bestand klaar voor het uploaden: een grote afbeelding wordt
   * verkleind tot maximaal 1200 pixels (JPEG op een witte ondergrond), een kleine blijft zoals hij is.
   * @param {File} file het gekozen bestand (JPEG, PNG of WebP)
   * @returns {Promise<{ name: string, data: string }>} bestandsnaam en base64-inhoud
   */
  async function prepare(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Kies een JPEG-, PNG- of WebP-afbeelding.');
    let bitmap = null;
    try { bitmap = await createImageBitmap(file); } catch (error) { /* geen voorbeeld mogelijk: de server controleert */ }
    if (!bitmap || (file.size <= KEEP_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE)) return { name: file.name, data: await readBase64(file) };
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: await readBase64(blob || file) };
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
   * @param {(progress: { imported: number, reused: number, failed: object[], pending: number }) => void} onProgress wordt na elke portie aangeroepen met de totalen
   * @returns {Promise<{ imported: number, reused: number, failed: object[], pending: number }>} de totalen
   */
  async function importAll(onProgress) {
    const totals = { imported: 0, reused: 0, failed: [], pending: 0 };
    let after = '';
    for (;;) {
      const part = await api('stock/images-import', { method: 'POST', body: { after } });
      totals.imported += part.imported;
      totals.reused += part.reused;
      totals.failed.push(...part.failed);
      totals.pending = part.pending;
      if (onProgress) onProgress({ ...totals });
      if (!part.next) return totals;
      after = part.next;
    }
  }

  window.ItemImages = { prepare, upload, remove, src, pending, importAll };
})();
