/* Toverstaf: klik in de ondergrond en trek het vlak met dezelfde kleur uit als polygoon. */
(function () {
  'use strict';

  const WORK_MAX = 1200; // werkresolutie (langste zijde) voor snelheid

  let cache = null; // { src, data, w, h, f }

  function pixels(img) {
    const src = img.src;
    if (cache && cache.src === src) return cache;
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const f = Math.min(1, WORK_MAX / Math.max(w0, h0));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w0 * f));
    cv.height = Math.max(1, Math.round(h0 * f));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    cache = { src, data: ctx.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height, f };
    return cache;
  }

  function floodFill(px, sx, sy, tol) {
    const { data, w, h } = px;
    const mask = new Uint8Array(w * h);
    const i0 = (sy * w + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2];
    const t2 = tol * tol;
    const stack = [sy * w + sx];
    mask[sy * w + sx] = 1;
    let count = 0;
    while (stack.length) {
      const k = stack.pop();
      count++;
      const x = k % w, y = (k - x) / w;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const n of nb) {
        if (n < 0 || mask[n]) continue;
        const j = n * 4;
        const dr = data[j] - r0, dg = data[j + 1] - g0, db = data[j + 2] - b0;
        if (dr * dr + dg * dg + db * db <= t2) {
          mask[n] = 1;
          stack.push(n);
        }
      }
    }
    return { mask, count };
  }

  /** Dilatatie of erosie met een vierkant van straal r (scheidbaar, horizontaal + verticaal). */
  function morph(mask, w, h, r, dilate) {
    const pass = (src, horizontal) => {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = dilate ? 0 : 1;
          for (let d = -r; d <= r; d++) {
            const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
            const inside = xx >= 0 && yy >= 0 && xx < w && yy < h;
            const s = inside ? src[yy * w + xx] : 0;
            if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
          }
          out[y * w + x] = v;
        }
      }
      return out;
    };
    return pass(pass(mask, true), false);
  }

  /** Gaten (tekst, symbolen) in het vlak dichtmaken: alles wat de rand niet bereikt hoort erbij. */
  function fillHoles(mask, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const push = (k) => { if (!mask[k] && !outside[k]) { outside[k] = 1; stack.push(k); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const k = stack.pop();
      const x = k % w, y = (k - x) / w;
      if (x > 0) push(k - 1);
      if (x < w - 1) push(k + 1);
      if (y > 0) push(k - w);
      if (y < h - 1) push(k + w);
    }
    const out = new Uint8Array(w * h);
    for (let k = 0; k < out.length; k++) out[k] = outside[k] ? 0 : 1;
    return out;
  }

  /** Buitencontour volgen (Moore-buren), start bij het eerste maskerpixel in leesvolgorde. */
  function traceContour(mask, w, h) {
    let start = -1;
    for (let k = 0; k < mask.length; k++) if (mask[k]) { start = k; break; }
    if (start < 0) return [];
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
    // richtingen met de klok mee, beginnend links
    const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const sx = start % w, sy = (start - sx) / w;
    let x = sx, y = sy;
    let from = 1; // eerste zoekrichting: links van het startpixel is leeg (leesvolgorde)
    const pts = [{ x, y }];
    const limit = w * h * 4;
    for (let n = 0; n < limit; n++) {
      let moved = -1;
      for (let i = 0; i < 8; i++) {
        const d = (from + i) % 8;
        if (at(x + dirs[d][0], y + dirs[d][1])) { moved = d; break; }
      }
      if (moved < 0) break; // los pixel
      x += dirs[moved][0];
      y += dirs[moved][1];
      if (x === sx && y === sy) break;
      pts.push({ x, y });
      // volgende zoektocht begint net na het lege buurpixel waarlangs we kwamen
      from = (moved + (moved % 2 === 0 ? 7 : 6)) % 8;
    }
    return pts;
  }

  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, bd = 0;
      for (let i = a + 1; i < b; i++) {
        const d = window.Geo.distToSegment(pts[i], pts[a], pts[b]);
        if (d > bd) { bd = d; best = i; }
      }
      if (bd > eps && best > 0) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /**
   * @param {HTMLImageElement} img ondergrond
   * @param {number} ix,iy klikpositie in pixels van de ondergrond
   * @param {number} tol kleurtolerantie (0–120)
   * @returns {{points:Array<{x,y}>, coverage:number}|{error:string}}
   */
  function wand(img, ix, iy, tol = 40) {
    const px = pixels(img);
    const sx = Math.round(ix * px.f), sy = Math.round(iy * px.f);
    if (sx < 0 || sy < 0 || sx >= px.w || sy >= px.h) return { error: 'Klik binnen de ondergrond.' };
    let { mask, count } = floodFill(px, sx, sy, tol);
    const coverage = count / (px.w * px.h);
    if (count < 60) return { error: 'Te klein vlak gevonden. Verhoog de gevoeligheid of klik midden in het vlak.' };
    if (coverage > 0.92) return { error: 'Bijna de hele afbeelding valt binnen de kleur. Verlaag de gevoeligheid.' };
    // kleine onderbrekingen (lijnen, tekst) sluiten en gaten vullen
    const r = Math.max(1, Math.round(Math.max(px.w, px.h) / 600));
    mask = morph(morph(mask, px.w, px.h, r, true), px.w, px.h, r, false);
    mask = fillHoles(mask, px.w, px.h);
    const contour = traceContour(mask, px.w, px.h);
    if (contour.length < 8) return { error: 'Geen bruikbare rand gevonden.' };
    const eps = Math.max(1.2, Math.max(px.w, px.h) / 500);
    const simple = simplify(contour, eps);
    const points = simple.map((p) => ({ x: p.x / px.f, y: p.y / px.f }));
    return { points, coverage };
  }

  window.AutoTrace = { wand, _internal: { floodFill, traceContour, simplify, fillHoles } };
})();
