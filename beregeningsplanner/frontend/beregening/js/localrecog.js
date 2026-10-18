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

  /**
   * Kleur naar vlaksoort. Bewust eenvoudig en uitlegbaar; zie DOCS.md voor de regels. Werkt op kleuren die
   * op het papier genormaliseerd zijn, dus ook voor bleke potlood- en stifttinten.
   */
  function classify(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    const c = s * v; // kleurigheid (chroma): klein bij wit, grijs én zwart
    if (v < 0.22) return NONE; // lijnen, tekst
    if (c < 0.07) return v > 0.88 ? NONE : DRY; // wit papier / grijs = bebouwing, verharding
    if (h >= 65 && h < 140) {
      if (c < 0.12) return v > 0.88 ? NONE : DRY; // grijsgroen: grind, vervaagde lijnen
      return v > 0.58 ? LAWN : HEDGE; // licht/middengroen = gras, donkergroen = haag/heesters
    }
    if (h >= 140 && h < 195) return c < 0.1 ? DRY : HEDGE; // blauwgroen = heesters, coniferen
    if (h >= 50 && h < 65) return s > 0.35 ? LAWN : DRY; // geelgroen gras / kaki, geel = terras of vlonder
    if (h >= 195 && h < 260) return WET; // water
    if (h >= 260 && h < 345) return BED; // bloemen
    return s < 0.3 && v > 0.7 ? DRY : BED; // licht beige/zand/baksteen = verharding, (grijs)bruin/oranje/rood = beplanting
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

  /** Termen van een derdegraads veelterm in x, y (beide -1..1). */
  function polyTerms(x, y, out) {
    out[0] = 1; out[1] = x; out[2] = y; out[3] = x * x; out[4] = x * y; out[5] = y * y;
    out[6] = x * x * x; out[7] = x * x * y; out[8] = x * y * y; out[9] = y * y * y;
    return out;
  }

  /** Kleinste-kwadratenoplossing (normaalvergelijkingen, Gauss-eliminatie met kleine regularisatie). */
  function solveLeastSquares(rows, ys, weights) {
    const m = rows[0].length;
    const A = Array.from({ length: m }, () => new Float64Array(m + 1));
    rows.forEach((r, k) => {
      const wt = weights ? weights[k] : 1;
      if (!wt) return;
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) A[i][j] += wt * r[i] * r[j];
        A[i][m] += wt * r[i] * ys[k];
      }
    });
    for (let i = 0; i < m; i++) A[i][i] += 1e-6 * (A[0][0] || 1);
    for (let i = 0; i < m; i++) {
      let piv = i;
      for (let k = i + 1; k < m; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      [A[i], A[piv]] = [A[piv], A[i]];
      if (Math.abs(A[i][i]) < 1e-12) continue;
      for (let k = 0; k < m; k++) {
        if (k === i) continue;
        const f = A[k][i] / A[i][i];
        for (let j = i; j <= m; j++) A[k][j] -= f * A[i][j];
      }
    }
    return A.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[m] / r[i]));
  }

  /**
   * Papierkleur over het hele beeld schatten (foto's en scans: ongelijke belichting, grijs of getint papier).
   * Per cel de lichtste, minst gekleurde pixels; cellen met een afwijkende kleurtoon (ingekleurd) vallen af.
   * Daarna een gladde derdegraads veelterm per kleurkanaal, herhaald zonder cellen die duidelijk donkerder
   * zijn dan de fit (grijze arcering, tafelrand). Geeft een functie (x, y) → [r, g, b] (0–255) of null.
   */
  function paperModel(data, w, h) {
    const cs = Math.max(6, Math.round(Math.max(w, h) / 32));
    const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
    const cells = [];
    const hist = new Uint32Array(256);
    const lum = (rgb) => rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
    const score = (i) => {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return Math.max(0, Math.min(255, (r * 0.3 + g * 0.59 + b * 0.11) - 3 * (Math.max(r, g, b) - Math.min(r, g, b)))) | 0;
    };
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const xa = gx * cs, ya = gy * cs, xb = Math.min(w, xa + cs), yb = Math.min(h, ya + cs);
        hist.fill(0);
        let cnt = 0;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { hist[score((y * w + x) * 4)]++; cnt++; }
        let acc = 0, thr = 255; // drempel: lichtste 15%
        while (thr > 0 && acc + hist[thr] < cnt * 0.15) acc += hist[thr--];
        let sr = 0, sg = 0, sb = 0, m = 0;
        for (let y = ya; y < yb; y++) {
          for (let x = xa; x < xb; x++) {
            const i = (y * w + x) * 4;
            if (score(i) < thr) continue;
            sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; m++;
          }
        }
        cells.push({ x: ((xa + xb) / 2 / w) * 2 - 1, y: ((ya + yb) / 2 / h) * 2 - 1, rgb: [sr / m, sg / m, sb / m] });
      }
    }
    // kleurtoon t.o.v. de papiertint (een foto kan een kleurzweem hebben): mediaan over de 20% cellen die
    // het lichtst en minst gekleurd zijn; bij een sterk ingekleurd plan is papier niet de meerderheid
    const tone = (c) => { const t = c.rgb[0] + c.rgb[1] + c.rgb[2] || 1; return [c.rgb[0] / t, c.rgb[1] / t, c.rgb[2] / t]; };
    const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    const tones = cells.map(tone);
    const cellScore = (c) => lum(c.rgb) - 3 * (Math.max(...c.rgb) - Math.min(...c.rgb));
    const best = cells.map((c, k) => k).sort((a, b) => cellScore(cells[b]) - cellScore(cells[a])).slice(0, Math.max(5, Math.round(cells.length * 0.2)));
    const mt = [0, 1, 2].map((c) => med(best.map((k) => tones[k][c])));
    const valid = cells.map((c, k) => c.rgb[0] + c.rgb[1] + c.rgb[2] > 60 &&
      Math.abs(tones[k][0] - mt[0]) + Math.abs(tones[k][1] - mt[1]) + Math.abs(tones[k][2] - mt[2]) < 0.025);
    if (valid.filter(Boolean).length < Math.max(8, 0.1 * cells.length)) return null; // geen papier zichtbaar (luchtfoto)
    const rows = cells.map((c) => polyTerms(c.x, c.y, new Float64Array(10)));
    let active = valid.map((v) => (v ? 1 : 0));
    let coef = null;
    for (let it = 0; it < 6; it++) {
      coef = [0, 1, 2].map((c) => solveLeastSquares(rows, cells.map((cl) => cl.rgb[c]), active));
      const fitLum = (k) => lum([0, 1, 2].map((c) => rows[k].reduce((s, t, i) => s + t * coef[c][i], 0)));
      active = cells.map((cl, k) => (valid[k] && lum(cl.rgb) > fitLum(k) * 0.94 ? 1 : 0));
      if (active.filter(Boolean).length < 10) return null;
    }
    // begrenzen op wat er werkelijk aan papier gezien is (extrapolatie in hoeken)
    const act = cells.filter((c, k) => active[k]);
    const lo = [0, 1, 2].map((c) => Math.min(...act.map((cl) => cl.rgb[c])) * 0.9);
    const hi = [0, 1, 2].map((c) => Math.max(...act.map((cl) => cl.rgb[c])) * 1.05);
    const t = new Float64Array(10);
    return (x, y, out) => {
      polyTerms((x / w) * 2 - 1, (y / h) * 2 - 1, t);
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let i = 0; i < 10; i++) v += t[i] * coef[c][i];
        out[c] = Math.max(Math.max(24, lo[c]), Math.min(hi[c], v));
      }
      return out;
    };
  }

  /**
   * Kleuren genormaliseerd op het papier (papier = 1,1,1) en uitgemiddeld over de arcering van potlood
   * of stift. Inkt (zwarte lijnen, tekst) telt bij het middelen niet mee: een lijn neemt de kleur van zijn
   * omgeving aan en verdwijnt, in plaats van een grijze rand (= "verharding") te worden.
   * Digitale plannen (egaal wit papier) worden niet genormaliseerd. Geeft Float32Array rgb 0..~1.
   */
  function normalizedColors(data, w, h) {
    const [br, bg, bb, share] = backgroundColor(data, w, h);
    const [, bs, bv] = rgbToHsv(br, bg, bb);
    const digital = share > 0.5 && bv > 0.9 && bs < 0.08; // egaal wit papier: niets te corrigeren
    let model = digital ? null : paperModel(data, w, h);
    const out = new Float32Array(w * h * 3);
    const fill = (mdl) => {
      const p = [255, 255, 255];
      let over = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, o = (y * w + x) * 3;
          if (mdl && (x & 3) === 0) mdl(x, y, p); // papierkleur verloopt traag: elke 4 pixels bijwerken
          out[o] = data[i] / p[0]; out[o + 1] = data[i + 1] / p[1]; out[o + 2] = data[i + 2] / p[2];
          if (out[o] * 0.3 + out[o + 1] * 0.59 + out[o + 2] * 0.11 > 1.12) over++;
        }
      }
      return over / (w * h);
    };
    // controle: na normaliseren hoort vrijwel niets veel lichter te zijn dan het papier (anders: geen papier,
    // maar bv. een luchtfoto met grijze daken en wegen)
    if (fill(model) > 0.04 && model) { model = null; fill(null); }
    const r = Math.max(1, Math.round(Math.max(w, h) / 220));
    return { rgb: inkFreeBlur(out, w, h, r), normalized: Boolean(model) };
  }

  /** Is deze (genormaliseerde) kleur inkt: donker en kleurloos? */
  function isInk(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx < 0.45 && mx - mn < 0.1;
  }

  /**
   * Box-blur (lopende som, horizontaal en verticaal) waarin inktpixels niet meetellen. Een pixel zonder
   * inktvrije buren houdt zijn eigen kleur (grote donkere vlakken).
   */
  function inkFreeBlur(src, w, h, r) {
    const n = w * h;
    const a = new Float32Array(n * 4); // r, g, b, gewicht
    for (let k = 0; k < n; k++) {
      if (isInk(src[k * 3], src[k * 3 + 1], src[k * 3 + 2])) continue;
      a[k * 4] = src[k * 3]; a[k * 4 + 1] = src[k * 3 + 1]; a[k * 4 + 2] = src[k * 3 + 2]; a[k * 4 + 3] = 1;
    }
    const tmp = new Float32Array(n * 4), sum = new Float64Array(4);
    const run = (from, to, len, stride, base) => {
      sum.fill(0);
      for (let i = 0; i < Math.min(len, r); i++) for (let c = 0; c < 4; c++) sum[c] += from[(base + i * stride) * 4 + c];
      for (let i = 0; i < len; i++) {
        if (i + r < len) for (let c = 0; c < 4; c++) sum[c] += from[(base + (i + r) * stride) * 4 + c];
        if (i - r - 1 >= 0) for (let c = 0; c < 4; c++) sum[c] -= from[(base + (i - r - 1) * stride) * 4 + c];
        for (let c = 0; c < 4; c++) to[(base + i * stride) * 4 + c] = sum[c];
      }
    };
    for (let y = 0; y < h; y++) run(a, tmp, w, 1, y * w);
    const acc = new Float32Array(n * 4);
    for (let x = 0; x < w; x++) run(tmp, acc, h, w, x);
    const out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const wt = acc[k * 4 + 3];
      for (let c = 0; c < 3; c++) out[k * 3 + c] = wt > 0.5 ? acc[k * 4 + c] / wt : src[k * 3 + c];
    }
    return out;
  }

  function classMap(data, w, h) {
    const { rgb, normalized } = normalizedColors(data, w, h);
    const cls = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) cls[k] = classify(rgb[k * 3] * 255, rgb[k * 3 + 1] * 255, rgb[k * 3 + 2] * 255);
    return { cls, rgb, normalized };
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

  /**
   * Polygonen van één vlak: lokaal masker, kleine gaten (tekst, symbolen) dicht, rand volgen, vereenvoudigen.
   * Grote gaten (een gazon midden in de verharding, een border) blijven open: een polygoon kent geen gaten,
   * dus wordt er een smalle snede langs de kortste weg naar buiten gemaakt (sleutelgat).
   */
  function componentPolygons(comp, w, eps, minHole, cls, minFill = 0.4) {
    const T = window.AutoTrace._internal;
    const pad = 2;
    const bw = comp.x1 - comp.x0 + 1 + 2 * pad, bh = comp.y1 - comp.y0 + 1 + 2 * pad;
    const local = new Uint8Array(bw * bh);
    for (const k of comp.pix) {
      const x = k % w, y = (k - x) / w;
      local[(y - comp.y0 + pad) * bw + (x - comp.x0 + pad)] = 1;
    }
    const filled = T.fillHoles(local, bw, bh);
    const holeMask = new Uint8Array(bw * bh);
    let inner = 0; // binnenkant zonder ander vlak (papier, lijnen)
    for (let k = 0; k < holeMask.length; k++) {
      holeMask[k] = filled[k] && !local[k] ? 1 : 0;
      if (!holeMask[k] || !cls) continue;
      const x = (k % bw) + comp.x0 - pad, y = Math.floor(k / bw) + comp.y0 - pad;
      if (!cls[y * w + x]) inner++;
    }
    // getekende omtrek (lijn) i.p.v. ingekleurd vlak: binnenin vrijwel leeg
    if (minFill > 0 && comp.pix.length / Math.max(1, comp.pix.length + inner) < minFill) return [];
    const mask = filled.slice();
    const holes = components(holeMask, bw, bh, minHole);
    const holeId = new Int32Array(bw * bh).fill(-1);
    holes.forEach((hole, i) => { for (const k of hole.pix) { mask[k] = 0; holeId[k] = i; } });
    holes.forEach((hole, i) => {
      // kortste weg (breedte-eerst) naar buiten het vlak, eventueel door andere gaten heen
      const prev = new Int32Array(bw * bh).fill(-2);
      const queue = [];
      for (const k of hole.pix) { prev[k] = -1; queue.push(k); }
      let end = -1;
      for (let q = 0; q < queue.length && end < 0; q++) {
        const k = queue[q], x = k % bw;
        for (const nb of [x > 0 ? k - 1 : -1, x < bw - 1 ? k + 1 : -1, k - bw, k + bw]) {
          if (nb < 0 || nb >= bw * bh || prev[nb] !== -2) continue;
          prev[nb] = k;
          if (!filled[nb]) { end = nb; break; }
          queue.push(nb);
        }
      }
      // snede 3 px breed, zodat de randvolging er niet overheen springt
      for (let k = end >= 0 ? prev[end] : -1; k >= 0 && holeId[k] !== i; k = prev[k]) {
        if (holeId[k] >= 0) continue; // door een ander gat: daar is niets te snijden
        const x = k % bw, y = (k - x) / bw;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) mask[yy * bw + xx] = 0;
        }
      }
    });
    const out = [];
    for (const piece of components(mask, bw, bh, minHole)) {
      const pm = new Uint8Array(bw * bh);
      for (const k of piece.pix) pm[k] = 1;
      const contour = T.traceContour(pm, bw, bh);
      if (contour.length < 8) continue;
      const poly = T.simplify(contour, eps).map((p) => ({ x: p.x + comp.x0 - pad, y: p.y + comp.y0 - pad }));
      if (poly.length >= 3) out.push(poly);
    }
    return out;
  }

  /** Eén polygoon (gaten dicht), eventueel iets verdikt: voor vlakken die door lijnen rond een label omsloten zijn. */
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

  function findAreas(img, onProgress, opts = {}) {
    const W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    const f = Math.min(1, WORK_MAX / Math.max(W0, H0));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W0 * f));
    cv.height = Math.max(1, Math.round(H0 * f));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    onProgress && onProgress('Kleuren indelen…');
    return areasFromPixels(data, cv.width, cv.height, f, opts);
  }

  /** Vlakken uit RGBA-pixels (werkresolutie); f = werk-px per beeld-px. Los van canvas, zodat het testbaar is. */
  function areasFromPixels(data, w, h, f = 1, opts = {}) {
    const cm = classMap(data, w, h);
    const cls = modeFilter(modeFilter(cm.cls, w, h), w, h);

    const r = Math.max(1, Math.round(Math.max(w, h) / 350)); // dichtmaken van lijnen en tekst
    const minPx = Math.max(60, Math.round(w * h * 0.0012));
    const eps = Math.max(1.2, Math.max(w, h) / 450);
    let colored = 0;
    const found = [];
    for (const c of [LAWN, HEDGE, BED, DRY, WET]) {
      let mask = new Uint8Array(w * h);
      for (let k = 0; k < mask.length; k++) if (cls[k] === c) { mask[k] = 1; colored++; }
      mask = morph(morph(mask, w, h, r, true), w, h, r, false);
      const comps = components(mask, w, h, minPx).sort((a, b) => b.pix.length - a.pix.length).slice(0, 25);
      for (const comp of comps) {
        if (comp.x1 - comp.x0 > 0.95 * w && comp.y1 - comp.y0 > 0.95 * h) continue; // achtergrond, geen vlak
        // foto of scan van een vel: wat de beeldrand raakt ligt buiten het papier (tafel, schaduw)
        if (cm.normalized && (comp.x0 <= 1 || comp.y0 <= 1 || comp.x1 >= w - 2 || comp.y1 >= h - 2)) continue;
        found.push({ c, comp });
      }
    }
    // grijze vlakken die niet aan de tuin grenzen (titelblok, legenda, tekstkader) weglaten
    let garden = found.filter((o) => o.c !== DRY && o.comp.pix.length >= 3 * minPx); // logo's en symbolen tellen niet
    if (!garden.length) garden = found.filter((o) => o.c !== DRY);
    if (garden.length) {
      let near = new Uint8Array(w * h);
      for (const o of garden) for (const k of o.comp.pix) near[k] = 1;
      near = morph(near, w, h, Math.max(2, Math.round(0.02 * Math.max(w, h))), true);
      for (let i = found.length - 1; i >= 0; i--) {
        const { c, comp } = found[i];
        if (c !== DRY) continue;
        let touch = 0;
        for (const k of comp.pix) if (near[k]) touch++;
        if (touch < Math.min(minPx, 0.02 * comp.pix.length)) found.splice(i, 1);
      }
    }
    const areas = [];
    const counters = {};
    for (const { c, comp } of found) {
      const type = CLASS_TYPE[c];
      for (const poly of componentPolygons(comp, w, eps, minPx, cls)) {
        counters[type] = (counters[type] || 0) + 1;
        areas.push({ type, name: `${C.areaTypes[type].label} ${counters[type]}`, points: poly.map((p) => ({ x: p.x / f, y: p.y / f })) });
      }
    }
    const gray = new Uint8Array(w * h);
    for (let k = 0; k < gray.length; k++) gray[k] = (data[k * 4] * 0.299 + data[k * 4 + 1] * 0.587 + data[k * 4 + 2] * 0.114) | 0;
    const res = { areas, coloredShare: colored / (w * h), normalized: cm.normalized, work: { gray, w, h, f } };
    if (opts.debug) {
      const norm = new Uint8ClampedArray(w * h * 4);
      for (let k = 0; k < w * h; k++) { for (let c = 0; c < 3; c++) norm[k * 4 + c] = cm.rgb[k * 3 + c] * 255; norm[k * 4 + 3] = 255; }
      res.debug = { w, h, cls, norm, rgb: cm.rgb };
    }
    return res;
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
    // worden opgelost, dus absolute URL's (werkt ook onder een padprefix achter een proxy).
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

  /**
   * Getal + eenheid uit OCR-woorden halen. Geeft de mogelijke lezingen [{meters, strong}]:
   * sterk = decimaal getal of gewone eenheid ("12,50", "450 cm", "8 m"); zwak = kaal geheel getal (mm op een
   * bouwtekening) of een getal van 3+ cijfers met "m", waar OCR vaak de komma mist ("10,00 m" → "100 m";
   * dan ook 10 en 1 m als zwakke lezing).
   */
  function lengthReadings(text, nextText) {
    const t = String(text).replace(/\s+/g, '').replace(/[Mm]{2}$/, 'mm');
    const m = /^(\d{1,5}(?:[.,]\d{1,3})?)(mm|cm|m)?$/i.exec(t);
    if (!m) return [];
    const raw = m[1];
    let unit = (m[2] || '').toLowerCase();
    if (!unit && nextText && /^(mm|cm|m)$/i.test(String(nextText).trim())) unit = String(nextText).trim().toLowerCase();
    const value = parseFloat(raw.replace(',', '.'));
    if (!isFinite(value) || value <= 0) return [];
    const hasDecimal = /[.,]\d/.test(raw);
    if (unit === 'mm') return [{ meters: value / 1000, strong: true }];
    if (unit === 'cm') return [{ meters: value / 100, strong: true }];
    if (unit === 'm') {
      if (hasDecimal || raw.length <= 2) return [{ meters: value, strong: true }];
      return [{ meters: value, strong: false }, { meters: value / 10, strong: false }, { meters: value / 100, strong: false }];
    }
    if (hasDecimal && value < 200) return [{ meters: value, strong: true }]; // 12,50 → meter
    if (!hasDecimal && value >= 300 && value <= 99999) return [{ meters: value / 1000, strong: false }]; // 1250 → mm (bouwtekening)
    return [];
  }

  /** Eerste lezing in meters, of null. */
  function parseLength(text, nextText) {
    const r = lengthReadings(text, nextText);
    return r.length ? r[0].meters : null;
  }

  /**
   * Kiest de schaal uit kandidaten {mpp, meters, px, text, strong?, conf?}; W = beeldbreedte in pixels.
   * Groepen kandidaten die binnen 8% overeenkomen; dezelfde maat (zelfde lijn) uit meerdere OCR-rondes telt
   * één keer. Een groep komt in aanmerking met een sterke lezing of met twee of meer verschillende maten;
   * daarbinnen wint de groep met de meeste maten en de hoogste zekerheid. Anders: één zwakke lezing die een
   * gangbare plangrootte geeft (laag). Tegenstrijdige lezingen verlagen de betrouwbaarheid.
   */
  function pickScale(cands, W) {
    const ok = cands.filter((k) => W * k.mpp >= 3 && W * k.mpp <= 200); // plan 3–200 m breed
    if (!ok.length) return null;
    const key = (k) => `${k.meters}@${Math.round(k.px / 5)}`; // dezelfde maat
    const source = (k) => `${k.text}@${Math.round(k.px / 5)}`; // hetzelfde woord (alternatieve lezingen)
    const strong = (k) => k.strong !== false;
    const groups = ok.map((a) => {
      const grp = ok.filter((b) => Math.abs(b.mpp - a.mpp) / a.mpp <= 0.08);
      const distinct = [...new Map(grp.map((k) => [key(k), k])).values()];
      const score = (grp.some(strong) ? 10000 : 0) + distinct.length * 100 + grp.reduce((s, k) => s + (k.conf == null ? 50 : k.conf), 0);
      return { grp, distinct, score, eligible: grp.some(strong) || distinct.length >= 2 };
    }).filter((g) => g.eligible).sort((a, b) => b.score - a.score);
    let best = groups[0], confidence;
    if (best) {
      const own = new Set(best.grp.map(source));
      const conflicts = ok.filter((k) => !best.grp.includes(k) && !own.has(source(k))).map((k) => `"${k.text}"`);
      const many = best.distinct.length >= 2;
      confidence = conflicts.length ? (many ? 'middel' : 'laag') : many ? 'hoog' : 'middel';
      best.conflicts = [...new Set(conflicts)];
    } else {
      const plaus = ok.filter((k) => W * k.mpp >= 5 && W * k.mpp <= 100);
      plaus.sort((a, b) => Math.abs(Math.log(W * a.mpp / 25)) - Math.abs(Math.log(W * b.mpp / 25)));
      if (!plaus.length) return null;
      best = { grp: [plaus[0]], distinct: [plaus[0]], conflicts: [] };
      confidence = 'laag';
    }
    const sorted = best.grp.slice().sort((a, b) => a.mpp - b.mpp);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      metersPerPixel: median.mpp,
      method: 'maatvoering',
      confidence,
      evidence: best.distinct.slice(0, 4).map((k) => `"${k.text}" = ${+k.meters.toFixed(3)} m over ${Math.round(k.px)} px`).join(', ') +
        (best.conflicts.length ? `; tegenstrijdig gelezen: ${best.conflicts.slice(0, 3).join(', ')}` : ''),
      count: best.distinct.length,
    };
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

  /**
   * Kader van de tekens zelf (van één of meer opeenvolgende woorden). Tesseract rekent een maatlijn die de
   * tekst raakt soms bij het eerste of laatste teken (kader honderden pixels breed): het eerste teken wordt
   * dan ingekort tot een gewone tekenbreedte aan zijn rechterkant, het laatste aan zijn linkerkant.
   */
  function textBox(...wds) {
    const hgt = Math.max(...wds.map((wd) => wd.bbox.y1 - wd.bbox.y0)), cw = 0.7 * hgt;
    const syms = [];
    for (const wd of wds) {
      const ss = (wd.symbols || []).filter((q) => q.text.trim());
      if (ss.length) syms.push(...ss);
      else syms.push({ text: wd.text, bbox: wd.bbox });
    }
    let box = null;
    syms.forEach((q, i) => {
      let { x0, x1 } = q.bbox;
      if (x1 - x0 > 1.6 * hgt) {
        if (syms.length === 1) return; // niet te zeggen aan welke kant de tekst staat
        if (i === 0) x0 = x1 - cw;
        else if (i === syms.length - 1) x1 = x0 + cw;
        else return;
      }
      box = unionBox(box, { x0, y0: q.bbox.y0, x1, y1: q.bbox.y1 });
    });
    return box;
  }

  function unionBox(a, b) {
    if (!a || !b) return a || b;
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
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
  function scaleCandidates(ws, canvas) {
    // Tesseract geeft getallen met een komma ("10,00") met tekenwitlijst soms betrouwbaarheid 0; een getal
    // met eenheid telt daarom ook bij lage betrouwbaarheid, de maatlijn eromheen is dan het bewijs
    const words = ws.filter((wd) => wd.text.trim());
    const gray = grayOf(canvas);
    const out = [];
    out.ratios = words.filter((wd) => wd.confidence > 40).map((wd) => window.PlanImport && window.PlanImport.parseRatio(wd.text)).filter(Boolean);
    words.forEach((wd, i) => {
      const next = words[i + 1];
      const sameLine = next && Math.abs(next.bbox.y0 - wd.bbox.y0) < (wd.bbox.y1 - wd.bbox.y0) && next.bbox.x0 - wd.bbox.x1 < (wd.bbox.y1 - wd.bbox.y0) * 1.5;
      const readings = lengthReadings(wd.text, sameLine ? next.text : null);
      if (!readings.length) return;
      const withUnit = /(mm|cm|m)$/i.test(wd.text.trim()) || (sameLine && /^(mm|cm|m)$/i.test(next.text.trim()));
      if (wd.confidence <= 40 && !withUnit) return;
      const unitWord = sameLine && /^(mm|cm|m)$/i.test(next.text.trim());
      const box = unitWord ? textBox(wd, next) : textBox(wd);
      if (!box) return;
      const line = measureLine(gray, canvas.width, canvas.height, box);
      if (!line) return;
      const text = `${wd.text}${unitWord ? ' ' + next.text : ''}`;
      for (const r of readings) out.push({ mpp: r.meters / line.len, strong: r.strong, text, meters: r.meters, px: line.len, conf: wd.confidence });
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
    const ratios = []; // schaalaanduiding "1:N"; bruikbaar als het papierformaat bekend is (PDF)
    for (const ps of passes) {
      onProgress && onProgress(ps.msg);
      const cv = variant(img, ps.rotate, ps.binary);
      await worker.setParameters({
        tessedit_pageseg_mode: '11', // losse tekst verspreid over de tekening
        tessedit_char_whitelist: ps.digits ? '0123456789.,:/mMcC ' : '',
      });
      const { data } = await worker.recognize(cv);
      const ws = data.words || [];
      // de gemeten lijnlengte hangt niet af van de draaiing; de cijferronde is betrouwbaarder voor getallen
      const sc = scaleCandidates(ws, cv);
      scales.push(...sc.map((k) => ({ ...k, conf: k.conf + (ps.digits ? 10 : 0) })));
      ratios.push(...sc.ratios);
      if (ps.digits) continue;
      for (const wd of ws) {
        if (wd.confidence < 25 || !String(wd.text).trim()) continue;
        words.push({ text: wd.text, confidence: wd.confidence, bbox: ps.rotate ? unrotate(wd.bbox, H) : { ...wd.bbox } });
      }
    }
    return { words, scales, ratios };
  }

  async function findScale(img, onProgress) {
    const { scales, ratios } = await readText(img, onProgress);
    return scaleFrom(scales, ratios, img.naturalWidth || img.width);
  }

  /** Schaal uit maatkandidaten; zonder bruikbare maat eventueel alleen de schaalaanduiding "1:N". */
  function scaleFrom(scales, ratios, W) {
    const ratio = ratios[0] || null;
    // "1:100" zonder dubbele punt gelezen ("1100") is geen maat
    const noRatio = scales.filter((k) => k.strong || !ratios.some((r) => k.text.replace(/\D/g, '') === `1${r}`));
    const picked = pickScale(noRatio, W);
    if (!picked) return ratio ? { metersPerPixel: null, method: 'schatting', confidence: 'laag', evidence: `schaal 1:${ratio}`, ratio } : null;
    return { ...picked, ratio };
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
      const { words, scales, ratios } = await readText(img, onProgress);
      scale = scaleFrom(scales, ratios, img.naturalWidth || img.width);
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

  window.LocalRecognizer = {
    analyze, classify, parseLength, lengthReadings, pickScale, measureLine, findAreas, findScale, areasFromPixels,
    readText, matchLabel, labelsFromWords, enclosedRegions, regionForLabel, applyLabels, _internal: { paperModel, normalizedColors },
  };
})();
