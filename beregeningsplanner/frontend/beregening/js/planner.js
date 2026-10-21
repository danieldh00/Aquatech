/*
 * Automatische plaatsing van sproeiers (kop-tot-kop).
 *
 * Werkwijze: de vorm wordt vereenvoudigd en rechtgetrokken op de hoofdrichting.
 * Daarna worden varianten doorgerekend: raster vierkant of driehoekig, in de
 * hoofdrichting of langs de smalste kant, met verschillende afstanden. Elke
 * variant krijgt koppen op alle hoeken, op de randen (in lijn met het raster en
 * zonder gaten groter dan de worpwijdte) en binnenin. Rotators worden binnen het
 * bereik van hun kop gezet (MP-model, sector). De variant met de laagste kosten
 * (koppen, water buiten het vlak, gelijkmatigheid, droge plekken) wint.
 */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  const CORNER_DEVIATION = 20; // graden afwijking van een rechte lijn om als hoek te tellen
  const NARROW_WIDTH = 3.0; // m; smaller => strooksproeiers
  const SNAP = 0.5; // rasterpunten binnen deze fractie van de afstand tot de rand komen óp de rand

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  /** Kies worpwijdte zodat de breedte in gelijke kop-tot-kop afstanden wordt verdeeld. */
  function autoRadius(type, width) {
    const t = C.sprinklerTypes[type];
    const pref = type === 'spray' ? Math.min(t.rMax, 4.6) : t.rMax * 0.95;
    const k = Math.max(1, Math.ceil(width / pref - 1e-6));
    return clamp(width / k, t.rMin, t.rMax);
  }

  function makeRadial(type, p, r, start, arc) {
    const s = {
      id: G.uid('s'),
      type,
      x: p.x,
      y: p.y,
      r: round1(r),
      start: Math.round(G.normDeg(start)),
      arc: Math.round(clamp(arc, 10, 360)),
      zone: null,
    };
    return C.fitRotator ? C.fitRotator(s) : s;
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

  /** Vorm waarop geplaatst wordt: zonder kartels (herkenning, toverstaf) en rechtgetrokken. */
  function placementShape(pts) {
    const simple = G.simplifyClosed(pts, clamp(0.035 * Math.sqrt(G.area(pts)), 0.12, 0.35));
    const shape = G.orientCW(G.regularize(simple, G.dominantAngle([simple]), { tolDeg: 10, merge: 0.2 }));
    return shape.length >= 3 ? shape : pts;
  }

  /** Hoeken van de vorm met beginrichting en binnenhoek. */
  function cornersOf(pts) {
    const n = pts.length;
    return pts.map((p, i) => {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      const uIn = G.norm(G.sub(p, prev));
      const uOut = G.norm(G.sub(next, p));
      const start = G.angleOf(uOut);
      const interior = G.normDeg(G.angleOf(G.mul(uIn, -1)) - start) || 360;
      return { p, i, start, interior, corner: Math.abs(interior - 180) > CORNER_DEVIATION };
    });
  }

  /**
   * Eén indeling: raster in richting `angle` (graden), afstand `s`, patroon vierkant of driehoek.
   * @returns sproeiers
   */
  function layout(shape, type, s, angle, pattern) {
    const t = C.sprinklerTypes[type];
    const a = G.rad(angle);
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const v = { x: -u.y, y: u.x };
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of shape) {
      const pu = G.dot(p, u), pv = G.dot(p, v);
      u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
    }
    const tri = pattern === 'triangle';
    const nu = Math.max(1, Math.ceil((u1 - u0) / s - 1e-6));
    const su = (u1 - u0) / nu;
    const rowStep = tri ? s * Math.sqrt(3) / 2 : s;
    const nv = Math.max(1, Math.ceil((v1 - v0) / rowStep - 1e-6));
    const sv = (v1 - v0) / nv;
    const spacing = Math.min(su, sv) || s;
    // worp = grootste afstand tot een buurkop (kop-tot-kop), niet meer
    s = clamp(tri ? Math.max(su, Math.hypot(su / 2, sv)) : Math.max(su, sv), t.rMin, t.rMax);
    const n = shape.length;
    const corners = [], edgeHeads = [], inner = [];

    // hoeken (bol en hol)
    for (const c of cornersOf(shape)) {
      if (!c.corner) continue;
      // bolle hoek tussen twee korte randen: worp inkorten tot de langste, anders spuit de kop over beide uiteinden
      const longEdge = Math.max(G.dist(c.p, shape[(c.i + 1) % n]), G.dist(c.p, shape[(c.i - 1 + n) % n]));
      const r = c.interior < 180 ? clamp(longEdge, Math.max(t.rMin, 0.75 * s), s) : s;
      corners.push({ p: c.p, start: c.start, arc: c.interior, r });
    }

    // rasterpunten: binnenin, of op de rand als ze er dichtbij liggen
    for (let j = 0; j <= nv; j++) {
      const shift = tri && j % 2 ? su / 2 : 0;
      for (let i = 0; i <= nu + (shift ? -1 : 0); i++) {
        const p = G.add(G.mul(u, u0 + i * su + shift), G.mul(v, v0 + j * sv));
        const inside = G.pointInPolygon(p, shape);
        const c = G.closestOnPolygon(p, shape);
        if (inside && c.d > SNAP * spacing) inner.push({ p, d: c.d });
        else if (c.d < SNAP * spacing) {
          const A = shape[c.edge], B = shape[(c.edge + 1) % n];
          edgeHeads.push({ p: c.pt, start: G.angleOf(G.sub(B, A)), arc: 180 });
        }
      }
    }

    // samenvoegen: hoeken gaan voor, dan randkoppen
    const boundary = [];
    const near = (list, p, d) => list.some((o) => G.dist(o.p, p) < d);
    for (const h of corners) if (!near(boundary, h.p, 0.05)) boundary.push(h);
    for (const h of edgeHeads) if (!near(boundary, h.p, 0.45 * spacing)) boundary.push(h);

    // randen zonder gaten: tussen opeenvolgende randkoppen hoogstens één afstand
    const extra = [];
    for (let e = 0; e < n; e++) {
      const A = shape[e], B = shape[(e + 1) % n];
      const L = G.dist(A, B);
      if (L < 1e-6) continue;
      const dir = G.sub(B, A);
      const on = boundary.filter((h) => G.distToSegment(h.p, A, B) < 0.05).map((h) => G.dot(G.sub(h.p, A), dir) / L);
      // de hoekpunten zelf tellen als steunpunt, ook als daar geen kop staat (rechte doorloop)
      on.push(0, L);
      on.sort((x, y) => x - y);
      for (let k = 1; k < on.length; k++) {
        const gap = on[k] - on[k - 1];
        if (gap <= 1.15 * s) continue;
        const m = Math.ceil(gap / s - 1e-6);
        for (let q = 1; q < m; q++) {
          const at = on[k - 1] + (gap * q) / m;
          extra.push({ p: G.add(A, G.mul(dir, at / L)), start: G.angleOf(dir), arc: 180 });
        }
      }
    }
    for (const h of extra) if (!near(boundary, h.p, 0.3 * spacing)) boundary.push(h);
    // hoekpunten zonder hoek (rechte doorloop) maar met een gat ervoor: een halve cirkel volstaat
    for (const h of boundary) if (h.arc > 180 - CORNER_DEVIATION && h.arc < 180 + CORNER_DEVIATION) h.arc = 180;

    const heads = boundary.map((h) => makeRadial(type, h.p, h.r || s, h.start, h.arc));
    for (const h of inner) {
      if (near(boundary, h.p, 0.45 * spacing)) continue;
      // binnenkop dicht bij de rand: worpwijdte inkorten (stelschroef) om overspray te beperken
      const r = h.d < s ? clamp(h.d, Math.max(t.rMin, 0.7 * s), s) : s;
      heads.push(makeRadial(type, h.p, r, 0, 360));
    }
    heads.key = `${nu}x${nv}`;
    return heads;
  }

  // ------------------------------------------------------------ beoordelen

  /** Neerslagfunctie per kop, vooraf uitgerekend (zelfde profiel als Simulation.precipAt). */
  function headFn(s) {
    const t = C.sprinklerTypes[s.type];
    if (!t) return null;
    if (s.type === 'strip' || !window.Simulation) {
      const reach = s.type === 'strip' ? Math.hypot(s.len / 2, s.width) : s.r;
      return { x: s.x, y: s.y, reach, f: (p) => (window.Simulation ? window.Simulation.precipAt(s, p) : 0) };
    }
    const r = s.r, k = (3 * t.pr) / Math.PI;
    const full = s.arc >= 359.9;
    const a0 = G.rad(s.start), arc = G.rad(s.arc) + 1e-6;
    const f = (p) => {
      const dx = p.x - s.x, dy = p.y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) return 0;
      const d = Math.sqrt(d2);
      if (!full && d > 1e-6) {
        let a = Math.atan2(dy, dx) - a0;
        a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (a > arc) return 0;
      }
      return k * (1 - d / r);
    };
    return { x: s.x, y: s.y, reach: r, f };
  }

  /** Meetpunten binnen het vlak en in een band eromheen (vast per vlak, zodat varianten snel te vergelijken zijn). */
  function evaluator(pts, reach) {
    const area = G.area(pts);
    const cell = clamp(Math.sqrt(area) / 30, 0.2, 0.6);
    reach = Math.min(reach, 3); // overspray vlak langs de rand telt; verder weg komt alleen bij grote koppen
    const bb = G.bbox(pts);
    const inside = [], outside = [];
    for (let y = bb.minY - reach; y <= bb.maxY + reach; y += cell) {
      for (let x = bb.minX - reach; x <= bb.maxX + reach; x += cell) {
        const p = { x, y };
        if (G.pointInPolygon(p, pts)) inside.push(p);
        else if (x >= bb.minX - reach && G.closestOnPolygon(p, pts).d <= reach) outside.push(p);
      }
    }
    return { pts, area, cell, inside, outside };
  }

  /** Kosten van een indeling: aantal koppen, water buiten het vlak, ongelijkmatigheid en droge plekken. */
  function score(ev, heads) {
    if (!heads.length || !ev.inside.length) return { cost: Infinity };
    const fns = heads.map(headFn).filter(Boolean);
    const vals = new Float64Array(ev.inside.length);
    let outsideWet = 0;
    for (const h of fns) {
      for (let k = 0; k < ev.inside.length; k++) {
        const p = ev.inside[k];
        if (Math.abs(p.x - h.x) > h.reach || Math.abs(p.y - h.y) > h.reach) continue;
        vals[k] += h.f(p);
      }
    }
    for (const p of ev.outside) {
      for (const h of fns) {
        if (Math.abs(p.x - h.x) > h.reach || Math.abs(p.y - h.y) > h.reach) continue;
        if (h.f(p) > 0) { outsideWet++; break; }
      }
    }
    const arr = Array.from(vals).sort((x, y) => x - y);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const q = arr.slice(0, Math.max(1, Math.floor(arr.length / 4)));
    const du = mean > 0 ? q.reduce((s, x) => s + x, 0) / q.length / mean : 0;
    const dryPct = (arr.filter((x) => x < 0.3 * mean).length / arr.length) * 100;
    const outsideM2 = outsideWet * ev.cell * ev.cell;
    const cost = heads.length + (outsideM2 / Math.max(ev.area, 1)) * 40 + (1 - du) * 40 + dryPct * 1.5;
    return { cost, outsideM2, du, dryPct };
  }

  /**
   * Fijnregelen: per kop de worp inkorten (stelschroef) als dat minder water buiten
   * het vlak geeft zonder de verdeling te bederven. Hebzuchtig, twee rondes.
   */
  function refine(ev, heads, sc) {
    let best = sc;
    for (let round = 0; round < 2; round++) {
      let improved = false;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (h.type === 'strip') continue;
        const t = C.sprinklerTypes[h.type];
        for (const f of [0.9, 0.8, 0.7]) {
          const r = round1(Math.max(t.rMin, h.r * f));
          if (r >= h.r) continue;
          const cand = C.fitRotator({ ...h, r });
          if (cand.r >= h.r) continue;
          const trial = heads.slice();
          trial[i] = cand;
          const tsc = score(ev, trial);
          if (tsc.cost < best.cost - 1e-6) { heads[i] = cand; best = tsc; improved = true; break; }
        }
      }
      if (!improved) break;
    }
    return best;
  }

  /** Kosten van een indeling (los aan te roepen). */
  function evaluate(pts, heads) {
    const reach = Math.max(0.5, ...heads.map((h) => (h.type === 'strip' ? Math.hypot(h.len / 2, h.width) : h.r)));
    return score(evaluator(G.orientCW(pts), reach), heads);
  }

  /** Afstanden om te proberen: die het vlak in gelijke stukken delen, plus een reeks binnen het bereik. */
  function spacings(type, shape, angles) {
    const t = C.sprinklerTypes[type];
    const out = new Set();
    const ok = (r) => {
      if (r < t.rMin - 1e-9 || r > t.rMax + 1e-9) return;
      // rotators: alleen afstanden die een MP-kop haalt
      if (type === 'rotator' && C.rotatorModels && !Object.values(C.rotatorModels).some((m) => r >= m.rMin - 1e-9 && r <= m.rMax + 1e-9)) return;
      out.add(round1(r));
    };
    for (const ang of angles) {
      const a = G.rad(ang);
      const u = { x: Math.cos(a), y: Math.sin(a) }, v = { x: -u.y, y: u.x };
      const pu = shape.map((p) => G.dot(p, u)), pv = shape.map((p) => G.dot(p, v));
      for (const L of [Math.max(...pu) - Math.min(...pu), Math.max(...pv) - Math.min(...pv)]) {
        for (let k = Math.max(1, Math.ceil(L / t.rMax)); k <= Math.ceil(L / t.rMin) && k <= 12; k++) ok(L / k);
      }
    }
    for (let i = 0; i <= 8; i++) ok(t.rMin + ((t.rMax - t.rMin) * i) / 8);
    return [...out];
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
    const t = C.sprinklerTypes[type];
    if (type === 'strip') return placeStrips(pts, G.minWidthRect(pts));
    const shape = placementShape(pts);
    const rect = G.minWidthRect(shape);
    if (type !== 'rotor' && rect.width < NARROW_WIDTH && !opts.r) return placeStrips(pts, rect);

    const angles = [G.dominantAngle([shape])];
    const ra = G.normDeg(G.angleOf(rect.u)) % 90;
    if (Math.abs(ra - angles[0]) > 2 && Math.abs(ra - angles[0]) < 88) angles.push(ra);
    const radii = opts.r ? [clamp(opts.r, t.rMin, t.rMax)] : spacings(type, shape, angles);
    const ev = evaluator(pts, Math.max(...radii));
    let best = null;
    for (const angle of angles) {
      for (const pattern of ['square', 'triangle']) {
        const seen = new Set();
        for (const r of radii) {
          const heads = layout(shape, type, r, angle, pattern);
          if (seen.has(heads.key)) continue;
          seen.add(heads.key);
          const sc = score(ev, heads);
          if (!best || sc.cost < best.score.cost) best = { heads, score: sc };
        }
      }
    }
    if (!best) return [];
    refine(ev, best.heads, best.score);
    return best.heads;
  }

  /** Plaatsing met een vaste worpwijdte. */
  function placeWithRadius(rawPts, type, r) {
    return autoPlace(rawPts, type, r ? { r } : {});
  }

  window.Planner = { autoPlace, placeWithRadius, evaluate, autoRadius, placementShape, NARROW_WIDTH };
})();
