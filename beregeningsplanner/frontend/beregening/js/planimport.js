/* Plan inlezen: afbeelding of PDF (eerste pagina) naar een canvas, plus een verkleinde kopie voor de analyse. */
(function () {
  'use strict';

  const BG_MAX = 2400; // langste zijde van de opgeslagen ondergrond
  const ANALYZE_MAX = 1568; // langste zijde voor de AI-analyse

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Bestand kan niet gelezen worden'));
      r.readAsArrayBuffer(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Afbeelding kan niet geladen worden'));
      img.src = src;
    });
  }

  function scaled(source, w, h, max) {
    const f = Math.min(1, max / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * f));
    cv.height = Math.max(1, Math.round(h * f));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(source, 0, 0, cv.width, cv.height);
    return cv;
  }

  async function renderPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF-ondersteuning is niet geladen');
    const data = new Uint8Array(await readAsArrayBuffer(file));
    // isEvalSupported uit: geen code uit het PDF-bestand uitvoeren.
    const pdf = await window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = BG_MAX / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(viewport.width);
    cv.height = Math.round(viewport.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    // papierformaat (1 pt = 1/72 inch) en, als de tekst in de PDF staat, de schaal "1:N"
    const paper = { widthM: (base.width / 72) * 0.0254, ratio: null };
    try {
      const text = (await page.getTextContent()).items.map((it) => it.str).join(' ');
      paper.ratio = parseRatio(text);
    } catch (e) { /* geen tekstlaag: dan alleen tekstherkenning */ }
    return { canvas: cv, pages: pdf.numPages, paper };
  }

  /** Schaalaanduiding "1:50", "1 : 100", "schaal 1/200" → 50, 100, 200 (of null). */
  function parseRatio(text) {
    const m = /(?:^|[^\d.,])1\s*[:/]\s*(\d{2,4})(?![\d.,]*\d)/.exec(String(text));
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 10 && n <= 5000 ? n : null;
  }

  /**
   * Laadt een plan en geeft de ondergrond (dataUrl + afmetingen) en een
   * analyse-afbeelding terug. Coördinaten van de analyse-afbeelding staan in
   * verhouding `analyze.factor` tot die van de ondergrond.
   */
  async function load(file) {
    let source, w, h, pages = 1, paper = null;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const r = await renderPdf(file);
      source = r.canvas; w = r.canvas.width; h = r.canvas.height; pages = r.pages; paper = r.paper;
    } else {
      const url = URL.createObjectURL(file);
      try {
        source = await loadImage(url);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      w = source.naturalWidth; h = source.naturalHeight;
    }
    const bg = scaled(source, w, h, BG_MAX);
    const an = scaled(bg, bg.width, bg.height, ANALYZE_MAX);
    return {
      background: { dataUrl: bg.toDataURL('image/jpeg', 0.88), width: bg.width, height: bg.height, paper },
      analyze: { dataUrl: an.toDataURL('image/jpeg', 0.9), width: an.width, height: an.height, factor: an.width / bg.width, paper },
      pages,
    };
  }

  /** Maakt een analyse-afbeelding van een reeds geladen ondergrond. */
  async function analyzeImageFrom(dataUrl) {
    const img = await loadImage(dataUrl);
    const an = scaled(img, img.naturalWidth, img.naturalHeight, ANALYZE_MAX);
    return { dataUrl: an.toDataURL('image/jpeg', 0.9), width: an.width, height: an.height, factor: an.width / img.naturalWidth };
  }

  window.PlanImport = { load, analyzeImageFrom, loadImage, parseRatio };
})();
