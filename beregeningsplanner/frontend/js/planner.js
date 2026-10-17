/* Automatische plaatsing van sproeiers op gazonvlakken (kop-tot-kop). */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  const CORNER_DEVIATION = 20; // graden afwijking van een rechte lijn om als hoek te tellen
  const NARROW_WIDTH = 3.0; // m; smaller => strooksproeiers

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Kies worpwijdte zodat de breedte in gelijke kop-tot-kop afstanden wordt verdeeld. */
  function autoRadius(type, width) {
    const t = C.sprinklerTypes[type];
    const pref = type === 'spray' ? Math.min(t.rMax, 4.6) : t.rMax * 0.95;
    const k = Math.max(1, Math.ceil(width / pref - 1e-6));
    return clamp(width / k, t.rMin, t.rMax);
  }

  function makeRadial(type, p, r, start, arc) {
    return {
      id: G.uid('s'),
      type,
      x: p.x,
      y: p.y,
      r: Math.round(r * 10) / 10,
      start: Math.round(G.normDeg(start)),
      arc: Math.round(clamp(arc, 10, 360)),
      zone: null,
    };
  }

  /** Diameter van de grootste ingeschreven cirkel (benadering via raster): 'effectieve breedte' van een vorm. */
  function inscribedDiameter(pts) {
    const bb = G.bbox(pts);
    const n = 40;
    let best = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p = { x: bb.minX + (bb.w * i) / n, y: bb.minY + (bb.h * j) / n };
        if (!G.pointInPolygon(p, pts)) continue;
        best = Math.max(best, G.closestOnPolygon(p, pts).d);
      }
    }
    return 2 * best;
  }

  function placeStrips(pts, rect) {
    const t = C.sprinklerTypes.strip;
    const n = Math.max(1, Math.ceil(rect.length / t.lMax - 1e-6));
    const seg = rect.length / n;
    const width = clamp(rect.width, t.wMin, t.wMax);
    const out = [];
    for (let i = 0; i < n; i++) {
      const along = rect.minU + (i + 0.5) * seg;
      const p = G.add(G.mul(rect.u, along), G.mul(rect.v, rect.minV));
      out.push({
        id: G.uid('s'),
        type: 'strip',
        x: p.x,
        y: p.y,
        r: 0,
        start: Math.round(G.angleOf(rect.u)),
        arc: 0,
        len: Math.round(clamp(seg, t.lMin, t.lMax) * 10) / 10,
        width: Math.round(width * 10) / 10,
        zone: null,
      });
    }
    return out;
  }

  /**
   * Plaatst sproeiers in een polygoon.
   * @param {Array<{x,y}>} rawPts
   * @param {string} type  spray|rotator|rotor
   * @param {object} [opts] {r: vaste worpwijdte}
   */
  function autoPlace(rawPts, type, opts = {}) {
    if (!rawPts || rawPts.length < 3) return [];
    const pts = G.orientCW(rawPts);
    const rect = G.minWidthRect(pts);

    if (type !== 'rotor' && rect.width < NARROW_WIDTH && !opts.r) {
      return placeStrips(pts, rect);
    }

    const effWidth = Math.min(rect.width, inscribedDiameter(pts) * 1.1);
    const r = opts.r ? clamp(opts.r, C.sprinklerTypes[type].rMin, C.sprinklerTypes[type].rMax) : autoRadius(type, effWidth);
    const n = pts.length;
    const heads = [];

    // Hoeken bepalen
    const info = pts.map((p, i) => {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      const uIn = G.norm(G.sub(p, prev));
      const uOut = G.norm(G.sub(next, p));
      const start = G.angleOf(uOut);
      const interior = G.normDeg(G.angleOf(G.mul(uIn, -1)) - start) || 360;
      return { p, start, interior, corner: Math.abs(interior - 180) > CORNER_DEVIATION };
    });

    const cornerIdx = info.map((v, i) => (v.corner ? i : -1)).filter((i) => i >= 0);

    // Randketens tussen opeenvolgende hoeken (of hele omtrek als er geen hoeken zijn)
    const chains = [];
    if (cornerIdx.length === 0) {
      chains.push({ from: 0, to: n, closed: true });
    } else {
      for (let k = 0; k < cornerIdx.length; k++) {
        const a = cornerIdx[k];
        let b = cornerIdx[(k + 1) % cornerIdx.length];
        if (b <= a) b += n;
        chains.push({ from: a, to: b, closed: false });
      }
    }

    for (const c of cornerIdx) {
      const v = info[c];
      heads.push(makeRadial(type, v.p, r, v.start, v.interior));
    }

    for (const ch of chains) {
      const segs = [];
      let total = 0;
      for (let i = ch.from; i < ch.to; i++) {
        const a = pts[i % n];
        const b = pts[(i + 1) % n];
        const l = G.dist(a, b);
        segs.push({ a, b, l, off: total });
        total += l;
      }
      if (total < 1e-6) continue;
      const count = Math.max(1, Math.ceil(total / r - 1e-6));
      const first = ch.closed ? 0 : 1;
      const last = ch.closed ? count - 1 : count - 1;
      for (let k = first; k <= last; k++) {
        const s = (k / count) * total;
        const seg = segs.find((g) => s >= g.off - 1e-9 && s <= g.off + g.l + 1e-9) || segs[segs.length - 1];
        const t = seg.l ? (s - seg.off) / seg.l : 0;
        const p = G.add(seg.a, G.mul(G.sub(seg.b, seg.a), t));
        heads.push(makeRadial(type, p, r, G.angleOf(G.sub(seg.b, seg.a)), 180));
      }
    }

    // Binnenraster, uitgelijnd op de georiënteerde rechthoek
    const nu = Math.max(1, Math.ceil(rect.length / r - 1e-6));
    const nv = Math.max(1, Math.ceil(rect.width / r - 1e-6));
    const su = rect.length / nu;
    const sv = rect.width / nv;
    for (let i = 1; i < nu; i++) {
      for (let j = 1; j < nv; j++) {
        const p = G.add(G.mul(rect.u, rect.minU + i * su), G.mul(rect.v, rect.minV + j * sv));
        if (!G.pointInPolygon(p, pts)) continue;
        const d = G.closestOnPolygon(p, pts).d;
        if (d < 0.45 * r) continue;
        // binnenkop dicht bij de rand: worpwijdte verkleinen (max. 25%) om overspray te beperken
        const ri = d < r ? Math.max(C.sprinklerTypes[type].rMin, 0.75 * r, d) : r;
        heads.push(makeRadial(type, p, ri, 0, 360));
      }
    }

    // Dubbele koppen samenvoegen
    const result = [];
    for (const h of heads) {
      if (result.some((o) => G.dist(o, h) < 0.35 * r)) continue;
      result.push(h);
    }
    return result;
  }

  window.Planner = { autoPlace, autoRadius, NARROW_WIDTH };
})();
