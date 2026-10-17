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
  function componentPolygon(comp, w, eps, minFill = 0, grow = 0) {
    const pad = 2 + grow;
    const bw = comp.x1 - comp.x0 + 1 + 2 * pad, bh = comp.y1 - comp.y0 + 1 + 2 * pad;
    const local = new Uint8Array(bw * bh);
    for (const k of comp.pix) {
      const x = k % w, y = (k - x) / w;
      local[(y - comp.y0 + pad) * bw + (x - comp.x0 + pad)] = 1;
    }
    let filled = window.AutoTrace._internal.fillHoles(local, bw, bh);
    if (grow > 0) filled = morph(filled, bw, bh, grow, true);
    if (minFill > 0) {
      // getekende omtrek (lijn) i.p.v. ingekleurd vlak: binnenin vrijwel leeg
      let n = 0;
      for (let k = 0; k < filled.length; k++) n += filled[k];
      if (comp.pix.length / Math.max(1, n) < minFill) return null;
    }
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
        const poly = componentPolygon(comp, w, eps, 0.4);
        if (!poly || poly.length < 3) continue;
        n++;
        const type = CLASS_TYPE[c];
        areas.push({ type, name: `${C.areaTypes[type].label} ${n}`, points: poly.map((p) => ({ x: p.x / f, y: p.y / f })) });
      }
    }
    const gray = new Uint8Array(w * h);
    for (let k = 0; k < gray.length; k++) gray[k] = (data[k * 4] * 0.299 + data[k * 4 + 1] * 0.587 + data[k * 4 + 2] * 0.114) | 0;
    return { areas, coloredShare: colored / (w * h), work: { gray, w, h, f } };
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
    tessWorker = await window.Tesseract.createWorker('nld+eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      workerBlobURL: false,
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

  /** Beeldvariant voor OCR: eventueel 90° gedraaid en/of zwart-wit gemaakt. */
  function variant(img, rotate, binary) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const cv = document.createElement('canvas');
    cv.width = rotate ? H : W;
    cv.height = rotate ? W : H;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    if (rotate) { c.translate(H, 0); c.rotate(Math.PI / 2); }
    c.drawImage(img, 0, 0);
    if (binary) {
      const d = c.getImageData(0, 0, cv.width, cv.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const g = d.data[i] * 0.299 + d.data[i + 1] * 0.587 + d.data[i + 2] * 0.114;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = g < 150 ? 0 : 255;
      }
      c.putImageData(d, 0, 0);
    }
    return cv;
  }

  /** Box in een 90° gedraaid beeld (x' = H - y, y' = x) terug naar het origineel. */
  const unrotate = (b, H) => ({ x0: b.y0, y0: H - b.x1, x1: b.y1, y1: H - b.x0 });

  /** Maatkandidaten uit de woorden van één OCR-ronde, gemeten op dat beeld. */
  function scaleCandidates(words, canvas) {
    words = words.filter((wd) => wd.confidence > 40);
    const gray = grayOf(canvas);
    const out = [];
    words.forEach((wd, i) => {
      const next = words[i + 1];
      const sameLine = next && Math.abs(next.bbox.y0 - wd.bbox.y0) < (wd.bbox.y1 - wd.bbox.y0) && next.bbox.x0 - wd.bbox.x1 < (wd.bbox.y1 - wd.bbox.y0) * 1.5;
      const unitNext = sameLine && /^(mm|cm|m)$/i.test(next.text.trim());
      const meters = parseLength(wd.text, sameLine ? next.text : null);
      if (!meters) return;
      const box = unitNext ? { x0: wd.bbox.x0, y0: Math.min(wd.bbox.y0, next.bbox.y0), x1: next.bbox.x1, y1: Math.max(wd.bbox.y1, next.bbox.y1) } : wd.bbox;
      const line = measureLine(gray, canvas.width, canvas.height, box);
      if (!line) return;
      out.push({ mpp: meters / line.len, text: `${wd.text}${unitNext ? ' ' + next.text : ''}`, meters, px: line.len, conf: wd.confidence });
    });
    return out;
  }

  /**
   * Alle OCR-rondes: maten (cijfers, normaal + gedraaid) en labels (vrije tekst, normaal en zwart-wit,
   * recht en gedraaid). Geeft woorden in originele coördinaten en alle maatkandidaten.
   */
  async function readText(img, onProgress) {
    const worker = await getWorker();
    const H = img.naturalHeight || img.height;
    const passes = [
      { rotate: false, binary: false, digits: true, msg: 'Maten lezen…' },
      { rotate: true, binary: false, digits: true, msg: 'Verticale maten lezen…' },
      { rotate: false, binary: false, digits: false, msg: 'Teksten zoeken (gras, terras, border…)…' },
      { rotate: false, binary: true, digits: false, msg: 'Teksten zoeken (zwart-wit)…' },
      { rotate: true, binary: false, digits: false, msg: 'Verticale teksten zoeken…' },
      { rotate: true, binary: true, digits: false, msg: 'Verticale teksten zoeken (zwart-wit)…' },
    ];
    const words = [];
    const scales = [];
    for (const ps of passes) {
      onProgress && onProgress(ps.msg);
      const cv = variant(img, ps.rotate, ps.binary);
      await worker.setParameters({
        tessedit_pageseg_mode: '11', // losse tekst verspreid over de tekening
        tessedit_char_whitelist: ps.digits ? '0123456789.,mMcC ' : '',
      });
      const { data } = await worker.recognize(cv);
      const ws = data.words || [];
      // de gemeten lijnlengte hangt niet af van de draaiing; de cijferronde is betrouwbaarder voor getallen
      scales.push(...scaleCandidates(ws, cv).map((k) => ({ ...k, conf: k.conf + (ps.digits ? 10 : 0) })));
      if (ps.digits) continue;
      for (const wd of ws) {
        if (wd.confidence < 25 || !String(wd.text).trim()) continue;
        words.push({ text: wd.text, confidence: wd.confidence, bbox: ps.rotate ? unrotate(wd.bbox, H) : { ...wd.bbox } });
      }
    }
    return { words, scales };
  }

  /** Meest gedragen schaal: de grootste groep kandidaten die binnen 8% overeenkomen. */
  function pickScale(cands, W) {
    const ok = cands.filter((k) => W * k.mpp >= 3 && W * k.mpp <= 500);
    if (!ok.length) return null;
    // dezelfde maat (zelfde lijn) uit meerdere rondes telt één keer, met de hoogste zekerheid per lezing
    const key = (k) => `${k.meters}@${Math.round(k.px / 5)}`;
    const groups = [];
    for (const a of ok) {
      const grp = ok.filter((b) => Math.abs(b.mpp - a.mpp) / a.mpp <= 0.08);
      const distinct = [...new Map(grp.map((k) => [key(k), k])).values()];
      const score = distinct.length * 100 + grp.reduce((s, k) => s + k.conf, 0);
      groups.push({ grp, distinct, score });
    }
    groups.sort((a, b) => b.score - a.score);
    const best = groups[0];
    const sorted = best.grp.slice().sort((a, b) => a.mpp - b.mpp);
    const median = sorted[Math.floor(sorted.length / 2)];
    // tegenstrijdige lezingen (een andere maat die niet past) → betrouwbaarheid laag
    const conflicts = ok.filter((k) => !best.grp.includes(k)).map((k) => `"${k.text}"`);
    const confidence = conflicts.length ? (best.distinct.length >= 2 ? 'middel' : 'laag') : best.distinct.length >= 2 ? 'hoog' : 'middel';
    return {
      metersPerPixel: median.mpp,
      method: 'maatvoering',
      confidence,
      evidence: best.distinct.slice(0, 4).map((k) => `"${k.text}" over ${Math.round(k.px)} px`).join(', ') + (conflicts.length ? `; tegenstrijdig gelezen: ${[...new Set(conflicts)].slice(0, 3).join(', ')}` : ''),
      count: best.distinct.length,
    };
  }

  async function findScale(img, onProgress) {
    const { scales } = await readText(img, onProgress);
    return pickScale(scales, img.naturalWidth || img.width);
  }

  // ---------------------------------------------------------------- labels (gras, terras, …)

  /** Woorden per vlaksoort (Nederlands, Duits, Engels). */
  const VOCAB = {
    lawn: ['gras', 'gazon', 'grasveld', 'grasmat', 'speelgazon', 'rasen', 'rasenfläche', 'wiese', 'lawn', 'grass'],
    bed: ['border', 'borders', 'beplanting', 'plantvak', 'plantvakken', 'bloemen', 'bloemenborder', 'bloemperk', 'perk',
      'heesters', 'struiken', 'vasteplanten', 'planten', 'moestuin', 'kruidentuin', 'beet', 'beete', 'staudenbeet', 'blumen',
      'sträucher', 'flowers', 'shrubs', 'plants', 'flowerbed'],
    hedge: ['haag', 'heg', 'beukenhaag', 'ligusterhaag', 'taxushaag', 'coniferen', 'hecke', 'hedge'],
    planter: ['plantenbak', 'plantenbakken', 'bak', 'bakken', 'pot', 'potten', 'kuip', 'pflanzkübel', 'kübel', 'planter'],
    dry: ['terras', 'terrassen', 'woning', 'huis', 'woonhuis', 'schuur', 'tuinhuis', 'berging', 'garage', 'bestrating',
      'tegels', 'klinkers', 'pad', 'tuinpad', 'oprit', 'carport', 'veranda', 'overkapping', 'patio', 'vlonder', 'zitplek',
      'terrasse', 'haus', 'gebäude', 'weg', 'house', 'terrace', 'path', 'driveway', 'shed', 'deck'],
    wet: ['vijver', 'water', 'grind', 'grindpad', 'kiezel', 'kiezels', 'split', 'teich', 'kies', 'pond', 'gravel'],
  };
  const VOCAB_INDEX = [];
  for (const [type, words] of Object.entries(VOCAB)) for (const w of words) VOCAB_INDEX.push({ type, w: w.replace(/[^a-zäöüß]/g, '') });

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  /** Woord (ook slordig/handgeschreven gelezen) naar vlaksoort, of null. */
  function matchLabel(text) {
    const t = String(text).toLowerCase().replace(/[^a-zäöüß]/g, '');
    if (t.length < 3) return null;
    let best = null;
    for (const v of VOCAB_INDEX) {
      // korte woorden exact; langere met 1–2 tekens speling (handschrift)
      const allowed = v.w.length <= 4 ? 0 : v.w.length <= 7 ? 1 : 2;
      if (Math.abs(v.w.length - t.length) > allowed) continue;
      const d = levenshtein(t, v.w);
      if (d <= allowed && (!best || d < best.d)) best = { type: v.type, word: v.w, d };
    }
    return best;
  }

  /** Labels uit OCR-woorden; dezelfde tekst uit meerdere rondes wordt samengevoegd. */
  function labelsFromWords(words) {
    const out = [];
    for (const wd of words) {
      const m = matchLabel(wd.text);
      if (!m) continue;
      const l = { type: m.type, text: wd.text, conf: wd.confidence - m.d * 15, bbox: wd.bbox };
      const cx = (l.bbox.x0 + l.bbox.x1) / 2, cy = (l.bbox.y0 + l.bbox.y1) / 2;
      const dup = out.find((o) => cx >= o.bbox.x0 && cx <= o.bbox.x1 && cy >= o.bbox.y0 && cy <= o.bbox.y1);
      if (dup) {
        if (l.conf > dup.conf) Object.assign(dup, l);
        continue;
      }
      out.push(l);
    }
    return out;
  }

  /**
   * Vlak dat door getekende lijnen rond een label wordt omsloten (lijntekening of handschets).
   * Lijnen worden iets verdikt om kleine gaten in handgetekende lijnen te dichten.
   */
  function enclosedRegions(work) {
    const { gray, w, h } = work;
    // achtergrondhelderheid = mediaan van de rand
    const edge = [];
    for (let x = 0; x < w; x += 4) edge.push(gray[x], gray[(h - 1) * w + x]);
    edge.sort((a, b) => a - b);
    const bgLum = edge[Math.floor(edge.length / 2)] || 255;
    const thr = Math.min(170, bgLum - 55);
    let dark = new Uint8Array(w * h);
    for (let k = 0; k < dark.length; k++) dark[k] = gray[k] < thr ? 1 : 0;
    const r = Math.max(1, Math.round(Math.max(w, h) / 300));
    dark = morph(dark, w, h, r, true);
    const free = new Uint8Array(w * h);
    for (let k = 0; k < free.length; k++) free[k] = dark[k] ? 0 : 1;
    const label = new Int32Array(w * h).fill(-1);
    const comps = [];
    const stack = [];
    for (let k0 = 0; k0 < free.length; k0++) {
      if (!free[k0] || label[k0] >= 0) continue;
      const id = comps.length;
      const pix = [];
      let x0 = w, y0 = h, x1 = 0, y1 = 0, border = false;
      stack.push(k0); label[k0] = id;
      while (stack.length) {
        const k = stack.pop();
        pix.push(k);
        const x = k % w, y = (k - x) / w;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
        for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
          if (n >= 0 && free[n] && label[n] < 0) { label[n] = id; stack.push(n); }
        }
      }
      comps.push({ pix, x0, y0, x1, y1, border });
    }
    return { label, comps, w, h, r };
  }

  function regionForLabel(regions, box) {
    const { label, comps, w, h, r } = regions;
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const pad = Math.max(2 * r + 2, Math.round(bh * 0.6));
    const votes = new Map();
    const vote = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const id = label[y * w + x];
      if (id >= 0) votes.set(id, (votes.get(id) || 0) + 1);
    };
    for (let t = 0; t <= 1; t += 0.05) {
      vote(box.x0 - pad + t * (bw + 2 * pad), box.y0 - pad);
      vote(box.x0 - pad + t * (bw + 2 * pad), box.y1 + pad);
      vote(box.x0 - pad, box.y0 - pad + t * (bh + 2 * pad));
      vote(box.x1 + pad, box.y0 - pad + t * (bh + 2 * pad));
    }
    let best = -1, bn = 0;
    for (const [id, n] of votes) if (n > bn) { bn = n; best = id; }
    if (best < 0) return null;
    const comp = comps[best];
    const share = comp.pix.length / (w * h);
    if (comp.pix.length < bw * bh * 3 || share > 0.7 || (comp.border && share > 0.25)) return null;
    return comp;
  }

  /** Labels toepassen: type van gekleurde vlakken corrigeren, en lijnvlakken toevoegen. */
  function applyLabels(areas, labels, work) {
    const f = work.f;
    let retyped = 0, added = 0;
    const named = new Set();
    const counters = {};
    labels.sort((a, b) => b.conf - a.conf);
    let regions = null;
    const nameOf = (l) => l.text.replace(/[^\p{L}]/gu, '').toLowerCase().replace(/^./, (c) => c.toUpperCase()) || C.areaTypes[l.type].label;
    for (const l of labels) {
      const cx = (l.bbox.x0 + l.bbox.x1) / 2, cy = (l.bbox.y0 + l.bbox.y1) / 2;
      // kleinste gekleurde vlak waar het label in staat
      const hits = areas.filter((a) => G.pointInPolygon({ x: cx, y: cy }, a.points)).sort((a, b) => G.area(a.points) - G.area(b.points));
      if (hits.length) {
        const a = hits[0];
        if (named.has(a)) continue;
        named.add(a);
        if (a.type !== l.type) retyped++;
        a.type = l.type;
        a.name = nameOf(l);
        a.fromLabel = true;
        continue;
      }
      regions = regions || enclosedRegions(work);
      const box = { x0: l.bbox.x0 * f, y0: l.bbox.y0 * f, x1: l.bbox.x1 * f, y1: l.bbox.y1 * f };
      const comp = regionForLabel(regions, box);
      if (!comp || comp.used) continue;
      comp.used = true;
      const eps = Math.max(1.2, Math.max(work.w, work.h) / 450);
      const poly = componentPolygon(comp, work.w, eps, 0, regions.r + 1);
      if (!poly || poly.length < 3) continue;
      counters[l.type] = (counters[l.type] || 0) + 1;
      areas.push({ type: l.type, name: nameOf(l), points: poly.map((p) => ({ x: p.x / f, y: p.y / f })), fromLabel: true });
      added++;
    }
    return { retyped, added };
  }

  // ---------------------------------------------------------------- samen

  /**
   * @param analyzeImage {dataUrl, width, height}
   * @returns resultaat in hetzelfde formaat als /api/plan/analyze
   */
  async function analyze(analyzeImage, onProgress) {
    const img = await window.PlanImport.loadImage(analyzeImage.dataUrl);
    const notes = [];
    const { areas, coloredShare, work } = findAreas(img, onProgress);
    let labelStats = { retyped: 0, added: 0 }, labels = [], scale = null;
    try {
      const { words, scales } = await readText(img, onProgress);
      scale = pickScale(scales, img.naturalWidth || img.width);
      // gekleurde "vlakjes" die op een gelezen woord liggen zijn tekst (gekleurde inkt), geen vlak
      const IW = img.naturalWidth || img.width, IH = img.naturalHeight || img.height;
      const textBoxes = words.map((wd) => wd.bbox).filter((b) => b.y1 - b.y0 < IH * 0.08 && b.x1 - b.x0 < IW * 0.4);
      for (let i = areas.length - 1; i >= 0; i--) {
        const bb = G.bbox(areas[i].points);
        const isText = textBoxes.some((b) => {
          const m = (b.y1 - b.y0) * 0.5; // marge van een halve letterhoogte
          return bb.minX >= b.x0 - m && bb.maxX <= b.x1 + m && bb.minY >= b.y0 - m && bb.maxY <= b.y1 + m;
        });
        // kleine blauwe vlekjes zijn bij pen-/inkttekeningen vrijwel altijd lijnen of tekst, geen vijver
        const tinyWet = areas[i].type === 'wet' && G.area(areas[i].points) < IW * IH * 0.004;
        if (isText || tinyWet) areas.splice(i, 1);
      }
      labels = labelsFromWords(words);
      labelStats = applyLabels(areas, labels, work);
    } catch (e) {
      notes.push(`Teksten lezen lukte niet (${e.message}).`);
    }
    if (labelStats.added || labelStats.retyped) {
      notes.push(`${labels.length} label(s) gelezen: ${labelStats.added} vlak(ken) uit lijnen rond een label gehaald, ${labelStats.retyped} vlak(ken) van type veranderd.`);
    }
    if (coloredShare < 0.05 && !labelStats.added) notes.push('Het plan bevat weinig kleur en geen leesbare labels als "gras" of "terras". Trek de vlakken uit met de toverstaf of teken ze zelf.');
    return {
      scale: scale || { metersPerPixel: null, method: 'schatting', confidence: 'laag', evidence: '' },
      areas,
      elements: [],
      notes: notes.join(' '),
      local: true,
    };
  }

  window.LocalRecognizer = { analyze, classify, parseLength, measureLine, findAreas, findScale, readText, pickScale, matchLabel, labelsFromWords, enclosedRegions, regionForLabel, applyLabels };
})();
