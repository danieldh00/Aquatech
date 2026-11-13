/* Plan inlezen: afbeelding of PDF (eerste pagina) naar een canvas, plus een verkleinde kopie voor de analyse. */
(function () {
  'use strict';

  const BG_MAX = 2400; // langste zijde van de opgeslagen ondergrond
  const ANALYZE_MAX = 1568; // langste zijde voor de AI-analyse

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  /**
   * Leest een bestand in als ArrayBuffer.
   * @param {File} file het bestand
   * @returns {Promise<ArrayBuffer>} de inhoud
   */
  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      /** Geeft de inhoud door als het lezen klaar is. */
      reader.onload = () => { resolve(reader.result); };
      /** Meldt dat het lezen mislukt is. */
      reader.onerror = () => { reject(new Error('Bestand kan niet gelezen worden')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Laadt een afbeelding.
   * @param {string} src adres of data-URL van de afbeelding
   * @returns {Promise<HTMLImageElement>} de geladen afbeelding
   */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      /** Geeft de afbeelding door als hij geladen is. */
      image.onload = () => { resolve(image); };
      /** Meldt dat het laden mislukt is. */
      image.onerror = () => { reject(new Error('Afbeelding kan niet geladen worden')); };
      image.src = src;
    });
  }

  /**
   * Tekent een bron verkleind (nooit vergroot) op een nieuw canvas met witte achtergrond.
   * @param {CanvasImageSource} source afbeelding of canvas
   * @param {number} width breedte van de bron in pixels
   * @param {number} height hoogte van de bron in pixels
   * @param {number} maxSide maximale lengte van de langste zijde
   * @returns {HTMLCanvasElement} het nieuwe canvas
   */
  function scaled(source, width, height, maxSide) {
    const factor = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * factor));
    canvas.height = Math.max(1, Math.round(height * factor));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Tekent de eerste pagina van een PDF op een canvas en leest papierformaat en schaal.
   * @param {File} file het PDF-bestand
   * @returns {Promise<{canvas: HTMLCanvasElement, pages: number, paper: {widthM: number, ratio: (number|null)}}>} canvas, aantal pagina's en papiergegevens
   */
  async function renderPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF-ondersteuning is niet geladen');
    const data = new Uint8Array(await readAsArrayBuffer(file));
    // isEvalSupported uit: geen code uit het PDF-bestand uitvoeren.
    const pdf = await window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = BG_MAX / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    // papierformaat (1 pt = 1/72 inch) en, als de tekst in de PDF staat, de schaal "1:N"
    const paper = { widthM: (base.width / 72) * 0.0254, ratio: null };
    try {
      const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
      paper.ratio = parseRatio(text);
    } catch (error) { /* geen tekstlaag: dan alleen tekstherkenning */ }
    return { canvas, pages: pdf.numPages, paper };
  }

  /**
   * Leest een schaalaanduiding: "1:50", "1 : 100", "schaal 1/200" → 50, 100, 200.
   * @param {string} text tekst waarin de schaal kan staan
   * @returns {number|null} de schaal (10–5000), of null
   */
  function parseRatio(text) {
    const match = /(?:^|[^\d.,])1\s*[:/]\s*(\d{2,4})(?![\d.,]*\d)/.exec(String(text));
    if (!match) return null;
    const ratio = parseInt(match[1], 10);
    return ratio >= 10 && ratio <= 5000 ? ratio : null;
  }

  /**
   * Laadt een plan en geeft de ondergrond (dataUrl + afmetingen) en een analyse-afbeelding terug. Coördinaten van de analyse-afbeelding staan in verhouding `analyze.factor` tot die van de ondergrond.
   * @param {File} file afbeelding of PDF
   * @returns {Promise<{background: object, analyze: object, pages: number}>} ondergrond, analyse-afbeelding en aantal pagina's
   */
  async function load(file) {
    let source, width, height, pages = 1, paper = null;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const rendered = await renderPdf(file);
      source = rendered.canvas; width = rendered.canvas.width; height = rendered.canvas.height; pages = rendered.pages; paper = rendered.paper;
    } else {
      const url = URL.createObjectURL(file);
      try {
        source = await loadImage(url);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      width = source.naturalWidth; height = source.naturalHeight;
    }
    const background = scaled(source, width, height, BG_MAX);
    const analysis = scaled(background, background.width, background.height, ANALYZE_MAX);
    return {
      background: { dataUrl: background.toDataURL('image/jpeg', 0.88), width: background.width, height: background.height, paper },
      analyze: { dataUrl: analysis.toDataURL('image/jpeg', 0.9), width: analysis.width, height: analysis.height, factor: analysis.width / background.width, paper },
      pages,
    };
  }

  /**
   * Maakt een analyse-afbeelding van een reeds geladen ondergrond.
   * @param {string} dataUrl de ondergrond als data-URL
   * @returns {Promise<{dataUrl: string, width: number, height: number, factor: number}>} de verkleinde afbeelding en de verkleiningsfactor
   */
  async function analyzeImageFrom(dataUrl) {
    const image = await loadImage(dataUrl);
    const analysis = scaled(image, image.naturalWidth, image.naturalHeight, ANALYZE_MAX);
    return { dataUrl: analysis.toDataURL('image/jpeg', 0.9), width: analysis.width, height: analysis.height, factor: analysis.width / image.naturalWidth };
  }

  window.PlanImport = { load, analyzeImageFrom, loadImage, parseRatio };
})();
