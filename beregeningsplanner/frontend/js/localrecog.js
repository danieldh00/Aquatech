/*
 * Lokale planherkenning, zonder AI-koppeling.
 *  1. Vlakken: elk pixel op kleur indelen (gazon, haag, beplanting, bebouwing/verharding, water/grind),
 *     gladstrijken, gaten van tekst en lijnen dichten, aaneengesloten vlakken zoeken en hun rand traceren.
 *  2. Schaal: maatgetallen lezen met tekstherkenning (Tesseract, lokaal als WebAssembly) en per getal de
 *     bijbehorende maatlijn meten.
 * Geeft hetzelfde formaat terug als de AI-analyse (pixels van de analyse-afbeelding), zodat Concept.build
 * het resultaat op dezelfde manier verwerkt.
 */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  const WORK_MAX = 1000; // werkresolutie voor de kleuranalyse
  const NONE = 0, LAWN = 1, HEDGE = 2, BED = 3, DRY = 4, WET = 5;
  const CLASS_TYPE = { [LAWN]: 'lawn', [HEDGE]: 'hedge', [BED]: 'bed', [DRY]: 'dry', [WET]: 'wet' };

  // ---------------------------------------------------------------- kleuren

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max === 0 ? 0 : d / max, max];
  }

  /** Kleur naar vlaksoort. Bewust eenvoudig en uitlegbaar; zie DOCS.md voor de regels. */
  function classify(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.22) return NONE; // lijnen, tekst
    if (s < 0.12) return v > 0.88 ? NONE : DRY; // wit papier / grijs = bebouwing, verharding
    if (h >= 65 && h < 170) {
      if (s < 0.18) return DRY;
      return v > 0.58 ? LAWN : HEDGE; // licht/middengroen = gras, donkergroen = haag/heesters
    }
    if (h >= 50 && h < 65) return s > 0.35 ? LAWN : DRY; // geelgroen gras / kaki
    if (h >= 170 && h < 260) return WET; // water
    if (h >= 260 && h < 345) return BED; // bloemen
    return s < 0.3 && v > 0.7 ? DRY : BED; // licht beige/zand = verharding, (grijs)bruin/oranje/rood = beplanting
  }

  /** Kleur van de achtergrond (papier) = meest voorkomende kleur op de rand van het beeld. */
  function backgroundColor(data, w, h) {
    const counts = new Map();
    const add = (k) => {
      const i = k * 4;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
    let best = 0, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    return [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8, bestN / (2 * (w + h))];
  }

  function classMap(data, w, h) {
    const cls = new Uint8Array(w * h);
    const [br, bg, bb, share] = backgroundColor(data, w, h);
    const useBg = share > 0.3; // alleen als de rand grotendeels één kleur is (papier, geen luchtfoto)
    for (let k = 0; k < w * h; k++) {
      const i = k * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (useBg && Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) < 36) continue;
      cls[k] = classify(r, g, b);
    }
    return cls;
  }

  /** Meerderheidsfilter 3×3 (ruis en antialiasing weg). */
  function modeFilter(cls, w, h) {
    const out = new Uint8Array(cls.length);
    const cnt = new Uint8Array(6);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            cnt[cls[yy * w + xx]]++;
          }
        }
        let best = cls[y * w + x], bn = 0;
        for (let c = 0; c < 6; c++) if (cnt[c] > bn) { bn = cnt[c]; best = c; }
        out[y * w + x] = bn >= 5 ? best : cls[y * w + x];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- vlakken

  function morph(mask, w, h, r, dilate) {
    const pass = (src, horizontal) => {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = dilate ? 0 : 1;
          for (let d = -r; d <= r; d++) {
            const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
            const s = xx >= 0 && yy >= 0 && xx < w && yy < h ? src[yy * w + xx] : 0;
            if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
          }
          out[y * w + x] = v;
        }
      }
      return out;
    };
    return pass(pass(mask, true), false);
  }

  /** Aaneengesloten vlakken (4-buren) met hun pixels. */
  function components(mask, w, h, minPx) {
    const label = new Int32Array(w * h).fill(-1);
    const out = [];
    const stack = [];
    for (let k0 = 0; k0 < mask.length; k0++) {
      if (!mask[k0] || label[k0] >= 0) continue;
      const id = out.length;
      const pix = [];
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack.push(k0);
      label[k0] = id;
      while (stack.length) {
        const k = stack.pop();
        pix.push(k);
        const x = k % w, y = (k - x) / w;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[k - 1] && label[k - 1] < 0) { label[k - 1] = id; stack.push(k - 1); }
        if (x < w - 1 && mask[k + 1] && label[k + 1] < 0) { label[k + 1] = id; stack.push(k + 1); }
        if (y > 0 && mask[k - w] && label[k - w] < 0) { label[k - w] = id; stack.push(k - w); }
        if (y < h - 1 && mask[k + w] && label[k + w] < 0) { label[k + w] = id; stack.push(k + w); }
      }
      out.push({ pix, x0, y0, x1, y1 });
    }
    return out.filter((c) => c.pix.length >= minPx);
  }

  /** Polygoon van één vlak: lokaal masker, gaten dicht, rand volgen, vereenvoudigen. */
  function componentPolygon(comp, w, eps) {
    const pad = 2;
    const bw = comp.x1 - comp.x0 + 1 + 2 * pad, bh = comp.y1 - comp.y0 + 1 + 2 * pad;
    const local = new Uint8Array(bw * bh);
    for (const k of comp.pix) {
      const x = k % w, y = (k - x) / w;
      local[(y - comp.y0 + pad) * bw + (x - comp.x0 + pad)] = 1;
    }
    const filled = window.AutoTrace._internal.fillHoles(local, bw, bh);
    const contour = window.AutoTrace._internal.traceContour(filled, bw, bh);
    if (contour.length < 8) return null;
    return window.AutoTrace._internal.simplify(contour, eps).map((p) => ({ x: p.x + comp.x0 - pad, y: p.y + comp.y0 - pad }));
  }

  function findAreas(img, onProgress) {
    const W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    const f = Math.min(1, WORK_MAX / Math.max(W0, H0));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W0 * f));
    cv.height = Math.max(1, Math.round(H0 * f));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    const w = cv.width, h = cv.height;

    onProgress && onProgress('Kleuren indelen…');
    let cls = classMap(data, w, h);
    cls = modeFilter(modeFilter(cls, w, h), w, h);

    const r = Math.max(1, Math.round(Math.max(w, h) / 350)); // dichtmaken van lijnen en tekst
    const minPx = Math.max(60, Math.round(w * h * 0.0012));
    const eps = Math.max(1.2, Math.max(w, h) / 450);
    const areas = [];
    let colored = 0;
    for (const c of [LAWN, HEDGE, BED, DRY, WET]) {
      let mask = new Uint8Array(w * h);
      for (let k = 0; k < mask.length; k++) if (cls[k] === c) { mask[k] = 1; colored++; }
      mask = morph(morph(mask, w, h, r, true), w, h, r, false);
      const comps = components(mask, w, h, minPx).sort((a, b) => b.pix.length - a.pix.length).slice(0, 25);
      let n = 0;
      for (const comp of comps) {
        const poly = componentPolygon(comp, w, eps);
        if (!poly || poly.length < 3) continue;
        n++;
        const type = CLASS_TYPE[c];
        areas.push({ type, name: `${C.areaTypes[type].label} ${n}`, points: poly.map((p) => ({ x: p.x / f, y: p.y / f })) });
      }
    }
    return { areas, coloredShare: colored / (w * h) };
  }

  // ---------------------------------------------------------------- schaal (OCR)

  let tessWorker = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Tekstherkenning kon niet geladen worden'));
      document.head.appendChild(s);
    });
  }

  async function getWorker() {
    if (tessWorker) return tessWorker;
    await loadScript('vendor/tesseract/tesseract.min.js');
    // De worker laadt kern en taaldata zelf in; relatieve paden zouden relatief aan het worker-script
    // worden opgelost, dus absolute URL's (werkt ook onder het wisselende ingress-pad).
    const base = new URL('vendor/tesseract/', window.location.href).href;
    tessWorker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      workerBlobURL: false,
    });
    await tessWorker.setParameters({
      tessedit_pageseg_mode: '11', // losse tekst verspreid over de tekening
      tessedit_char_whitelist: '0123456789.,mMcC ',
    });
    return tessWorker;
  }

  /** Getal + eenheid uit OCR-woorden halen. Geeft lengte in meters of null. */
  function parseLength(text, nextText) {
    const t = String(text).replace(/\s+/g, '').replace(/[Mm]{2}$/, 'mm');
    const m = /^(\d{1,5}(?:[.,]\d{1,3})?)(mm|cm|m)?$/i.exec(t);
    if (!m) return null;
    const raw = m[1];
    let unit = (m[2] || '').toLowerCase();
    if (!unit && nextText && /^(mm|cm|m)$/i.test(String(nextText).trim())) unit = String(nextText).trim().toLowerCase();
    const value = parseFloat(raw.replace(',', '.'));
    if (!isFinite(value) || value <= 0) return null;
    const hasDecimal = /[.,]\d/.test(raw);
    if (unit === 'mm') return value / 1000;
    if (unit === 'cm') return value / 100;
    if (unit === 'm') return value;
    if (hasDecimal && value < 200) return value; // 12,50 → meter
    if (!hasDecimal && value >= 300 && value <= 99999) return value / 1000; // 1250 → mm (bouwtekening)
    return null;
  }

  /**
   * Zoekt de maatlijn bij een tekst: de langste aaneengesloten donkere lijn (horizontaal) op een rij
   * dicht bij de tekst die het midden van de tekst overspant. Onderbrekingen door de tekst zelf mogen.
   */
  function measureLine(gray, w, h, box) {
    const th = box.y1 - box.y0, tw = box.x1 - box.x0, cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    let best = null;
    for (let y = Math.max(0, Math.round(box.y0 - 2 * th)); y <= Math.min(h - 1, Math.round(box.y1 + 2 * th)); y++) {
      // donkere segmenten op deze rij
      const segs = [];
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const dark = x < w && gray[y * w + x] < 110;
        if (dark && start < 0) start = x;
        if (!dark && start >= 0) { segs.push([start, x - 1]); start = -1; }
      }
      if (!segs.length) continue;
      // samenvoegen: kleine gaten, of een gat waar de tekst staat
      const merged = [segs[0].slice()];
      for (let i = 1; i < segs.length; i++) {
        const last = merged[merged.length - 1];
        const gap = segs[i][0] - last[1];
        const gapOverText = last[1] >= box.x0 - th && segs[i][0] <= box.x1 + th && y >= box.y0 - th && y <= box.y1 + th;
        if (gap <= 3 || gapOverText) last[1] = segs[i][1];
        else merged.push(segs[i].slice());
      }
      for (const [a, b] of merged) {
        const len = b - a + 1;
        if (a > cx || b < cx) continue;
        if (len < Math.max(1.4 * tw, 30)) continue;
        // een maatlijn loopt aan beide kanten voorbij de tekst (filtert letters en tekstranden)
        if (a > box.x0 - 0.2 * tw || b < box.x1 + 0.2 * tw) continue;
        const dy = Math.abs(y - cy);
        if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && len > best.len)) best = { len, dy, y, a, b };
      }
    }
    return best;
  }

  function grayOf(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const g = new Uint8Array(canvas.width * canvas.height);
    for (let k = 0; k < g.length; k++) g[k] = (data[k * 4] * 0.299 + data[k * 4 + 1] * 0.587 + data[k * 4 + 2] * 0.114) | 0;
    return g;
  }

  /** Eén OCR-ronde op een canvas; geeft kandidaten {mpp, text} in pixels van dat canvas. */
  async function scaleCandidates(worker, canvas) {
    const { data } = await worker.recognize(canvas);
    const words = (data.words || []).filter((wd) => wd.confidence > 40);
    const gray = grayOf(canvas);
    const out = [];
    words.forEach((wd, i) => {
      const next = words[i + 1];
      const sameLine = next && Math.abs(next.bbox.y0 - wd.bbox.y0) < (wd.bbox.y1 - wd.bbox.y0) && next.bbox.x0 - wd.bbox.x1 < (wd.bbox.y1 - wd.bbox.y0) * 1.5;
      const meters = parseLength(wd.text, sameLine ? next.text : null);
      if (!meters) return;
      const box = sameLine && /^(mm|cm|m)$/i.test(next.text.trim()) ? { x0: wd.bbox.x0, y0: Math.min(wd.bbox.y0, next.bbox.y0), x1: next.bbox.x1, y1: Math.max(wd.bbox.y1, next.bbox.y1) } : wd.bbox;
      const line = measureLine(gray, canvas.width, canvas.height, box);
      if (!line) return;
      out.push({ mpp: meters / line.len, text: `${wd.text}${sameLine && /^(mm|cm|m)$/i.test(next.text.trim()) ? ' ' + next.text : ''}`, meters, px: line.len });
    });
    return out;
  }

  async function findScale(img, onProgress) {
    onProgress && onProgress('Maten lezen (tekstherkenning)…');
    const worker = await getWorker();
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    c.drawImage(img, 0, 0);
    const cands = await scaleCandidates(worker, cv);
    // tweede ronde 90° gedraaid voor verticale maten
    const rot = document.createElement('canvas');
    rot.width = H; rot.height = W;
    const rc = rot.getContext('2d');
    rc.translate(H, 0); rc.rotate(Math.PI / 2); rc.drawImage(cv, 0, 0);
    onProgress && onProgress('Verticale maten lezen…');
    cands.push(...await scaleCandidates(worker, rot));
    // onwaarschijnlijke schalen weg (plan 3–500 m breed)
    const ok = cands.filter((k) => W * k.mpp >= 3 && W * k.mpp <= 500);
    if (!ok.length) return null;
    // grootste groep die onderling binnen 8% overeenkomt
    let best = [];
    for (const a of ok) {
      const grp = ok.filter((b) => Math.abs(b.mpp - a.mpp) / a.mpp <= 0.08);
      if (grp.length > best.length) best = grp;
    }
    best.sort((a, b) => a.mpp - b.mpp);
    const median = best[Math.floor(best.length / 2)];
    return {
      metersPerPixel: median.mpp,
      method: 'maatvoering',
      confidence: best.length >= 2 ? 'hoog' : 'middel',
      evidence: best.slice(0, 4).map((k) => `"${k.text}" over ${Math.round(k.px)} px`).join(', '),
      count: best.length,
    };
  }

  // ---------------------------------------------------------------- samen

  /**
   * @param analyzeImage {dataUrl, width, height}
   * @returns resultaat in hetzelfde formaat als /api/plan/analyze
   */
  async function analyze(analyzeImage, onProgress) {
    const img = await window.PlanImport.loadImage(analyzeImage.dataUrl);
    const notes = [];
    const { areas, coloredShare } = findAreas(img, onProgress);
    if (coloredShare < 0.05) notes.push('Het plan bevat weinig kleur (lijntekening). Vlakken worden op kleur herkend; trek ze hier uit met de toverstaf of teken ze zelf.');
    let scale = null;
    try {
      scale = await findScale(img, onProgress);
    } catch (e) {
      notes.push(`Maten lezen lukte niet (${e.message}).`);
    }
    return {
      scale: scale || { metersPerPixel: null, method: 'schatting', confidence: 'laag', evidence: '' },
      areas,
      elements: [],
      notes: notes.join(' '),
      local: true,
    };
  }

  window.LocalRecognizer = { analyze, classify, parseLength, measureLine, findAreas, findScale };
})();
