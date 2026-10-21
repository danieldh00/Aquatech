/* Neerslagsimulatie op een raster: gemiddelde neerslag, verdeling (DU) en droge plekken. */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  // Neerslag per kop (uit de nozzle van de bibliotheek) onthouden zolang de instelling gelijk blijft.
  const prCache = new WeakMap();
  function prOf(s) {
    const sig = `${s.type}|${s.r}|${s.arc}|${s.model || ''}|${s.body || ''}`;
    const hit = prCache.get(s);
    if (hit && hit.sig === sig) return hit.pr;
    const pr = C.headPr ? C.headPr(s) : C.sprinklerTypes[s.type].pr;
    prCache.set(s, { sig, pr });
    return pr;
  }

  /** Neerslag [mm/h] van één sproeier op punt p. */
  function precipAt(s, p) {
    const t = C.sprinklerTypes[s.type];
    if (!t) return 0;
    const dx = p.x - s.x, dy = p.y - s.y;
    if (s.type === 'strip') {
      const a = G.rad(s.start);
      const u = { x: Math.cos(a), y: Math.sin(a) };
      const along = dx * u.x + dy * u.y;
      const perp = -dx * u.y + dy * u.x;
      return Math.abs(along) <= s.len / 2 && perp >= 0 && perp <= s.width ? t.pr : 0;
    }
    const d = Math.hypot(dx, dy);
    if (d > s.r) return 0;
    if (s.arc < 359.9 && d > 1e-6 && !G.inArc(G.angleOf({ x: dx, y: dy }), s.start, s.arc)) return 0;
    // Driehoeksprofiel; volume-equivalent met PR bij kop-tot-kop vierkantsverband
    return ((3 * prOf(s)) / Math.PI) * (1 - d / s.r);
  }

  function reach(s) {
    return s.type === 'strip' ? Math.hypot(s.len / 2, s.width) : s.r;
  }

  /**
   * Simuleert neerslag op alle gazonvlakken en controleert overspray op 'droog'-vlakken.
   * @returns {{cell, minX, minY, nx, ny, values:Float32Array, mask:Uint8Array, stats, perArea}}
   */
  function simulate(state, cell = 0.25) {
    const lawns = state.areas.filter((a) => a.type === 'lawn' && a.pts.length >= 3);
    const dry = state.areas.filter((a) => a.type === 'dry' && a.pts.length >= 3);
    const pts = [];
    lawns.forEach((a) => pts.push(...a.pts));
    state.sprinklers.forEach((s) => {
      const r = reach(s);
      pts.push({ x: s.x - r, y: s.y - r }, { x: s.x + r, y: s.y + r });
    });
    if (!pts.length) return null;
    const bb = G.bbox(pts);
    const nx = Math.min(1200, Math.ceil(bb.w / cell) + 1);
    const ny = Math.min(1200, Math.ceil(bb.h / cell) + 1);
    const cx = bb.w / Math.max(1, nx - 1) || cell;
    const cy = bb.h / Math.max(1, ny - 1) || cell;
    const values = new Float32Array(nx * ny);
    const mask = new Uint8Array(nx * ny); // 1 = gazon, 2 = droog-vlak
    const areaIdx = new Int16Array(nx * ny).fill(-1);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = { x: bb.minX + i * cx, y: bb.minY + j * cy };
        const k = j * nx + i;
        for (let a = 0; a < lawns.length; a++) {
          if (G.pointInPolygon(p, lawns[a].pts)) { mask[k] = 1; areaIdx[k] = a; break; }
        }
        if (!mask[k] && dry.some((d) => G.pointInPolygon(p, d.pts))) mask[k] = 2;
      }
    }

    for (const s of state.sprinklers) {
      const r = reach(s);
      const i0 = Math.max(0, Math.floor((s.x - r - bb.minX) / cx));
      const i1 = Math.min(nx - 1, Math.ceil((s.x + r - bb.minX) / cx));
      const j0 = Math.max(0, Math.floor((s.y - r - bb.minY) / cy));
      const j1 = Math.min(ny - 1, Math.ceil((s.y + r - bb.minY) / cy));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const v = precipAt(s, { x: bb.minX + i * cx, y: bb.minY + j * cy });
          if (v) values[j * nx + i] += v;
        }
      }
    }

    const statsFor = (filter) => {
      const arr = [];
      for (let k = 0; k < values.length; k++) if (filter(k)) arr.push(values[k]);
      if (!arr.length) return null;
      arr.sort((a, b) => a - b);
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      const q = arr.slice(0, Math.max(1, Math.floor(arr.length / 4)));
      const lq = q.reduce((s, v) => s + v, 0) / q.length;
      const dryCells = arr.filter((v) => v < 0.3 * mean).length;
      return {
        mean,
        min: arr[0],
        max: arr[arr.length - 1],
        du: mean > 0 ? lq / mean : 0,
        dryPct: (dryCells / arr.length) * 100,
        coveredPct: (arr.filter((v) => v > 0).length / arr.length) * 100,
        cells: arr.length,
      };
    };

    const stats = statsFor((k) => mask[k] === 1);
    const perArea = lawns.map((a, idx) => ({ area: a, stats: statsFor((k) => mask[k] === 1 && areaIdx[k] === idx) }));
    let oversprayCells = 0;
    for (let k = 0; k < values.length; k++) if (mask[k] === 2 && values[k] > 0) oversprayCells++;
    const overspray = oversprayCells * cx * cy;

    return { cellX: cx, cellY: cy, minX: bb.minX, minY: bb.minY, nx, ny, values, mask, stats, perArea, overspray };
  }

  /** Kleurenschaal: 0 = rood, 50% = geel, 100% = groen, 150%+ = blauw (t.o.v. gemiddelde). */
  function colorFor(ratio) {
    const stops = [
      [0, [211, 47, 47]],
      [0.5, [255, 193, 7]],
      [0.85, [139, 195, 74]],
      [1.15, [56, 142, 60]],
      [1.6, [30, 136, 229]],
    ];
    if (ratio <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (ratio <= stops[i][0]) {
        const [a, ca] = stops[i - 1];
        const [b, cb] = stops[i];
        const t = (ratio - a) / (b - a);
        return ca.map((c, k) => Math.round(c + (cb[k] - c) * t));
      }
    }
    return stops[stops.length - 1][1];
  }

  /** Rendert het resultaat naar een (kleine) canvas voor overlay. */
  function toCanvas(sim) {
    const cv = document.createElement('canvas');
    cv.width = sim.nx;
    cv.height = sim.ny;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(sim.nx, sim.ny);
    const ref = sim.stats && sim.stats.mean > 0 ? sim.stats.mean : 1;
    for (let k = 0; k < sim.values.length; k++) {
      const m = sim.mask[k];
      const v = sim.values[k];
      const o = k * 4;
      if (m === 1) {
        const c = colorFor(v / ref);
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 190;
      } else if (v > 0) {
        // overspray buiten gazon
        const bad = m === 2;
        img.data[o] = bad ? 183 : 100; img.data[o + 1] = bad ? 28 : 181; img.data[o + 2] = bad ? 28 : 246;
        img.data[o + 3] = bad ? 170 : 60;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  window.Simulation = { simulate, precipAt, toCanvas, colorFor };
})();
