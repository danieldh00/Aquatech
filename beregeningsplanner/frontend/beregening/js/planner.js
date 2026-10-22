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
  const MIN_EDGE = 0.6; // m; kortere randjes van de vorm worden weggewerkt
  const SNAP = 0.5; // rasterpunten binnen deze fractie van de afstand tot de rand komen óp de rand

  /**
   * Weging van de kosten van een indeling. Een kop telt zwaar (huis, nozzle, aansluiting en
   * graafwerk): liever minder koppen met volle worp dan veel kleine. Gelijkmatigheid telt
   * pas onder de streefwaarde mee; droge plekken en water buiten het vlak blijven zwaar.
   */
  const W = {
    head: 2.5, outside: 80, du: 60, duTarget: 0.85, dry: 6, low: 2.5, lowRatio: 0.7,
    // niet groen op de neerslagkaart (85–130% van het gemiddelde): te weinig per %, te veel per %
    off: 2, offHigh: 1.5, green: [0.85, 1.3],
    // water op een vlak dat droog moet blijven (huis, terras) telt 6×, op een vlak dat nat mag ¼×
    dryOut: 6, wetOut: 0.25,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  /** Kies worpwijdte zodat de breedte in gelijke kop-tot-kop afstanden wordt verdeeld. */
  function autoRadius(type, width) {
    const t = C.sprinklerTypes[type];
    const pref = type === 'spray' ? Math.min(t.rMax, 4.6) : t.rMax * 0.95;
    const k = Math.max(1, Math.ceil(width / pref - 1e-6));
    return clamp(width / k, t.rMin, t.rMax);
  }

  function makeRadial(type, p, r, start, arc, body) {
    const s = {
      id: G.uid('s'),
      type,
      ...(body ? { body } : {}),
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
    const angle = G.dominantAngle([simple]);
    let shape = G.orientCW(G.regularize(simple, angle, { tolDeg: 10, merge: 0.2 }));
    // trapjes en inhammen van een paar decimeter (boomkroon, tekst op de rand) weg: die vragen anders
    // elk een eigen hoekkop, terwijl de sproeiers er gewoon overheen werpen
    const trimmed = collapseShortEdges(shape, MIN_EDGE);
    if (trimmed.length >= 3 && trimmed.length < shape.length) {
      const again = G.orientCW(G.regularize(trimmed, angle, { tolDeg: 10, merge: 0.2 }));
      if (again.length >= 3 && Math.abs(G.area(again) - G.area(shape)) < 0.05 * G.area(shape)) shape = again;
    }
    return shape.length >= 3 ? shape : pts;
  }

  /**
   * Vorm voor een bepaalde kopafstand: trapjes en inhammen die veel kleiner zijn dan de worp
   * (terrasranden, plantvakjes) weg, anders krijgt elk hoekje een eigen kop en ontstaan er
   * kluitjes koppen langs de rand. Valt er te veel af of bij, dan blijft de vorm zoals hij was.
   */
  function coarseShape(shape, s) {
    const min = clamp(0.3 * s, MIN_EDGE, 3);
    const trimmed = collapseShortEdges(shape, min, true);
    if (trimmed.length < 3 || trimmed.length === shape.length) return shape;
    const angle = G.dominantAngle([shape]);
    const out = G.orientCW(G.regularize(trimmed, angle, { tolDeg: 10, merge: 0.2 }));
    return out.length >= 3 && Math.abs(G.area(out) - G.area(shape)) < 0.08 * G.area(shape) ? out : shape;
  }

  /** Kortste rand korter dan `min` steeds samenvoegen tot zijn midden, tot er geen meer is. */
  function collapseShortEdges(pts, min, outward = false) {
    let out = pts.slice();
    while (out.length > 4) {
      let best = -1, bestL = min;
      for (let i = 0; i < out.length; i++) {
        const L = G.dist(out[i], out[(i + 1) % out.length]);
        if (L < bestL) { bestL = L; best = i; }
      }
      if (best < 0) break;
      const j = (best + 1) % out.length;
      const rest = out.filter((_, k) => k !== best && k !== j);
      const at = Math.min(best, rest.length);
      const options = [{ x: (out[best].x + out[j].x) / 2, y: (out[best].y + out[j].y) / 2 }];
      // naar buiten: het eindpunt dat het grootste vlak overhoudt, zodat er geen gazon achter de randkoppen valt
      if (outward) options.push(out[best], out[j]);
      let pick = null, pickA = -Infinity;
      for (const p of options) {
        const cand = rest.slice();
        cand.splice(at, 0, p);
        const a = Math.abs(G.area(cand));
        if (a > pickA + 1e-9) { pick = cand; pickA = a; }
      }
      out = pick;
    }
    return out;
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
  function layout(shape, type, s, angle, pattern, sAcross = s, body = null) {
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
    const rowStep = tri ? sAcross * Math.sqrt(3) / 2 : sAcross;
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

    const heads = boundary.map((h) => makeRadial(type, h.p, h.r || s, h.start, h.arc, body));
    for (const h of inner) {
      if (near(boundary, h.p, 0.45 * spacing)) continue;
      // binnenkop dicht bij de rand: worpwijdte inkorten (stelschroef) om overspray te beperken
      const r = h.d < s ? clamp(h.d, Math.max(t.rMin, 0.55 * s), s) : s;
      heads.push(makeRadial(type, h.p, r, 0, 360, body));
    }
    heads.key = `${nu}x${nv}`;
    heads.spacing = s;
    return heads;
  }

  /**
   * Indeling vanaf de rand, zoals een hovenier het doet: koppen op de hoeken, daartussen langs
   * de rand op gelijke afstanden (ook langs schuine en bolle randen, los van het raster) en
   * binnenin een raster op minstens ruim een halve afstand van de rand.
   */
  function layoutPerimeter(shape, type, s, angle, pattern, body = null) {
    const t = C.sprinklerTypes[type];
    s = clamp(s, t.rMin, t.rMax);
    const n = shape.length;
    const cs = cornersOf(shape);
    const heads = [];
    for (const c of cs) {
      if (!c.corner) continue;
      const longEdge = Math.max(G.dist(c.p, shape[(c.i + 1) % n]), G.dist(c.p, shape[(c.i - 1 + n) % n]));
      const r = c.interior < 180 ? clamp(longEdge, Math.max(t.rMin, 0.75 * s), s) : s;
      heads.push(makeRadial(type, c.p, r, c.start, c.interior, body));
    }
    // ketens van rand tussen twee hoeken (zonder hoeken: de hele omtrek)
    let starts = cs.filter((c) => c.corner).map((c) => c.i);
    if (!starts.length) starts = [0];
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k], to = starts[(k + 1) % starts.length];
      const chain = [];
      let i = from;
      do { chain.push(shape[i]); i = (i + 1) % n; } while (i !== to);
      chain.push(shape[to]);
      const seg = [];
      let L = 0;
      for (let q = 1; q < chain.length; q++) { const d = G.dist(chain[q - 1], chain[q]); seg.push(d); L += d; }
      const m = Math.ceil(L / s - 1e-6);
      for (let q = 1; q < m; q++) {
        let at = (L * q) / m, e = 0;
        while (e < seg.length - 1 && at > seg[e]) { at -= seg[e]; e++; }
        const A = chain[e], B = chain[e + 1];
        const p = G.add(A, G.mul(G.sub(B, A), seg[e] ? at / seg[e] : 0));
        heads.push(makeRadial(type, p, s, G.angleOf(G.sub(B, A)), 180, body));
      }
    }
    // binnenin: raster in de hoofdrichting
    const a = G.rad(angle);
    const u = { x: Math.cos(a), y: Math.sin(a) }, v = { x: -u.y, y: u.x };
    const pu = shape.map((p) => G.dot(p, u)), pv = shape.map((p) => G.dot(p, v));
    const u0 = Math.min(...pu), u1 = Math.max(...pu), v0 = Math.min(...pv), v1 = Math.max(...pv);
    const tri = pattern === 'triangle';
    const nu = Math.max(1, Math.round((u1 - u0) / s)), su = (u1 - u0) / nu;
    const rowStep = tri ? s * Math.sqrt(3) / 2 : s;
    const nv = Math.max(1, Math.round((v1 - v0) / rowStep)), sv = (v1 - v0) / nv;
    for (let j = 1; j < nv; j++) {
      const shift = tri && j % 2 ? su / 2 : 0;
      for (let i = shift ? 0 : 1; i < nu; i++) {
        const p = G.add(G.mul(u, u0 + i * su + shift), G.mul(v, v0 + j * sv));
        if (!G.pointInPolygon(p, shape)) continue;
        const d = G.closestOnPolygon(p, shape).d;
        if (d < 0.6 * s || heads.some((h) => G.dist(h, p) < 0.6 * s)) continue;
        heads.push(makeRadial(type, p, s, 0, 360, body));
      }
    }
    heads.key = `rand-${round1(s)}-${pattern}-${Math.round(angle)}`;
    heads.spacing = s;
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
    const r = s.r, r2 = r * r, k = (3 * C.headPr(s)) / Math.PI;
    const full = s.arc >= 359.9;
    // sector zonder hoekfuncties: punt ligt links/rechts van de begin- en eindstraal
    const a0 = G.rad(s.start), a1 = G.rad(s.start + s.arc);
    const ux = Math.cos(a0), uy = Math.sin(a0), wx = Math.cos(a1), wy = Math.sin(a1);
    const wide = s.arc > 180;
    const f = (p) => {
      const dx = p.x - s.x, dy = p.y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return 0;
      if (!full && d2 > 1e-12) {
        const afterStart = ux * dy - uy * dx >= 0;
        const beforeEnd = wx * dy - wy * dx <= 0;
        if (wide ? !(afterStart || beforeEnd) : !(afterStart && beforeEnd)) return 0;
      }
      return k * (1 - Math.sqrt(d2) / r);
    };
    return { x: s.x, y: s.y, reach: r, f };
  }

  /** Meetpunten binnen het vlak en in een band eromheen (vast per vlak, zodat varianten snel te vergelijken zijn). */
  /**
   * @param surroundings {dry: [polygonen], wet: [polygonen]}: water op wat droog moet blijven
   *   (huis, terras) telt zwaarder, op wat nat mag worden lichter
   */
  function evaluator(pts, reach, surroundings = null) {
    const dryPolys = ((surroundings && surroundings.dry) || []).filter((p) => p && p.length >= 3);
    const wetPolys = ((surroundings && surroundings.wet) || []).filter((p) => p && p.length >= 3);
    const area = G.area(pts);
    const cell = clamp(Math.sqrt(area) / 30, 0.2, 0.6);
    const bb = G.bbox(pts);
    // raster iets verschoven, zodat er geen meetpunten precies op een rechte rand liggen
    const x0 = bb.minX - reach + 0.37 * cell, y0 = bb.minY - reach + 0.41 * cell;
    const nx = Math.ceil((bb.w + 2 * reach) / cell) + 1, ny = Math.ceil((bb.h + 2 * reach) / cell) + 1;
    // per rastercel: index in inside (>= 0), in outside (-2 - index) of -1 (niet meetellen)
    const cellIdx = new Int32Array(nx * ny).fill(-1);
    const inside = [], outside = [], outWeight = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = { x: x0 + i * cell, y: y0 + j * cell };
        if (G.pointInPolygon(p, pts)) { cellIdx[j * nx + i] = inside.length; inside.push(p); }
        // buiten het vlak: alles in de band telt (verder dan de worp komt geen kop)
        else {
          cellIdx[j * nx + i] = -2 - outside.length;
          outside.push(p);
          outWeight.push(dryPolys.some((d) => G.pointInPolygon(p, d)) ? W.dryOut : wetPolys.some((d) => G.pointInPolygon(p, d)) ? W.wetOut : 1);
        }
      }
    }
    // rand voor verschuiven langs de rand: zonder kartels (rekent veel sneller)
    const simple = G.orientCW(G.simplifyClosed(pts, 0.1));
    const edge = simple.length >= 3 ? simple : pts;
    return { pts, edge, corners: cornersOf(edge), area, cell, inside, outside, outWeight: Float64Array.from(outWeight), x0, y0, nx, ny, cellIdx };
  }

  // bijdrage per kop aan de meetpunten, onthouden zolang kop en meetpunten gelijk blijven
  const cellCache = new WeakMap();

  /** Meetpunten die een kop raakt: codes (zoals ev.cellIdx) en neerslag. */
  function headCells(ev, h) {
    const hit = cellCache.get(h);
    if (hit && hit.ev === ev && hit.r === h.r && hit.arc === h.arc && hit.start === h.start && hit.x === h.x && hit.y === h.y && hit.model === h.model && hit.body === h.body) return hit;
    const fn = headFn(h);
    const codes = [], vals = [];
    if (fn) {
      const i0 = Math.max(0, Math.floor((fn.x - fn.reach - ev.x0) / ev.cell));
      const i1 = Math.min(ev.nx - 1, Math.ceil((fn.x + fn.reach - ev.x0) / ev.cell));
      const j0 = Math.max(0, Math.floor((fn.y - fn.reach - ev.y0) / ev.cell));
      const j1 = Math.min(ev.ny - 1, Math.ceil((fn.y + fn.reach - ev.y0) / ev.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = ev.cellIdx[j * ev.nx + i];
          if (k === -1) continue;
          const v = fn.f(k >= 0 ? ev.inside[k] : ev.outside[-2 - k]);
          if (v > 0) { codes.push(k); vals.push(v); }
        }
      }
    }
    const out = { ev, r: h.r, arc: h.arc, start: h.start, x: h.x, y: h.y, model: h.model, body: h.body, codes: Int32Array.from(codes), vals: Float64Array.from(vals) };
    cellCache.set(h, out);
    return out;
  }

  /** Bijdrage van één kop optellen (sign = 1) of aftrekken (sign = -1) bij de meetpunten. */
  function apply(ev, acc, h, sign) {
    const { codes, vals } = headCells(ev, h);
    for (let n = 0; n < codes.length; n++) {
      const k = codes[n];
      if (k >= 0) acc.vals[k] += sign * vals[n];
      else {
        const o = -2 - k;
        if (sign > 0 ? acc.wet[o]++ === 0 : --acc.wet[o] === 0) { acc.wetCount += sign; acc.wetWeight += sign * ev.outWeight[o]; }
      }
    }
  }

  function accumulate(ev, heads) {
    const acc = { vals: new Float64Array(ev.inside.length), wet: new Int16Array(ev.outside.length), wetCount: 0, wetWeight: 0 };
    for (const h of heads) apply(ev, acc, h, 1);
    return acc;
  }

  let scratch = new Float64Array(0);

  /** Som van de k kleinste waarden (quickselect op een kopie, gemiddeld lineair). */
  function sumSmallest(vals, k) {
    const n = vals.length;
    if (scratch.length < n) scratch = new Float64Array(n);
    const a = scratch;
    a.set(vals);
    let lo = 0, hi = n - 1;
    const kk = k - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (kk <= j) hi = j;
      else if (kk >= i) lo = i;
      else break;
    }
    let sum = 0;
    for (let i = 0; i < k; i++) sum += a[i];
    return sum;
  }

  /** Kosten van een indeling: aantal koppen, water buiten het vlak, ongelijkmatigheid en gele/droge plekken. */
  function costOf(ev, acc, count) {
    const vals = acc.vals, n = vals.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += vals[i];
    const mean = sum / n;
    let dry = 0, low = 0, off = 0, high = 0;
    const g0 = W.green[0] * mean, g1 = W.green[1] * mean;
    for (let i = 0; i < n; i++) {
      const x = vals[i];
      if (x < W.lowRatio * mean) { low++; if (x < 0.3 * mean) dry++; }
      if (x < g0) off++;
      else if (x > g1) high++;
    }
    // niet groen op de neerslagkaart: te weinig weegt zwaarder dan te veel (dat wordt geen bruine plek)
    const offPct = (off / n) * 100, highPct = (high / n) * 100;
    const nq = Math.max(1, Math.floor(n / 4));
    const lq = sumSmallest(vals, nq);
    const du = mean > 0 ? lq / nq / mean : 0;
    const dryPct = (dry / n) * 100;
    // geel op de neerslagkaart: duidelijk minder dan gemiddeld
    const lowPct = (low / n) * 100;
    const outsideM2 = acc.wetCount * ev.cell * ev.cell;
    const outsideCost = acc.wetWeight * ev.cell * ev.cell;
    const cost = W.head * count + (outsideCost / Math.max(ev.area, 1)) * W.outside + Math.max(0, W.duTarget - du) * W.du + dryPct * W.dry + lowPct * W.low + offPct * W.off + highPct * W.offHigh;
    return { cost, outsideM2, du, dryPct, lowPct, offPct, highPct };
  }

  function score(ev, heads) {
    if (!heads.length || !ev.inside.length) return { cost: Infinity };
    return costOf(ev, accumulate(ev, heads), heads.length);
  }

  /** Varianten van één kop om te proberen: worp korter/langer, sproeihoek kleiner/groter, richting draaien. */
  function variantsOf(h, ev = null) {
    const t = C.headRange ? C.headRange(h) : C.sprinklerTypes[h.type];
    const out = [];
    for (const f of [0.9, 0.8, 0.7, 0.6, 1.1, 1.2]) {
      const r = round1(clamp(h.r * f, t.rMin, t.rMax));
      if (r !== h.r) out.push({ ...h, r });
    }
    if (h.arc < 359.9) {
      for (const da of [-20, -10, 10, 20]) out.push({ ...h, arc: h.arc + da });
      for (const ds of [-10, -5, 5, 10]) out.push({ ...h, start: Math.round(G.normDeg(h.start + ds)) });
      // beide randen iets naar binnen (hoek kleiner, midden gelijk)
      out.push({ ...h, start: Math.round(G.normDeg(h.start + 5)), arc: h.arc - 10 });
    }
    // verschuiven (alleen bij automatisch plaatsen): binnenkop een stukje, randkop langs de rand
    if (ev) {
      // sproeihoek en richting opnieuw uit de echte rand op deze plek (na de grove vorm kan een
      // kop op een trapje van het terras staan en dan over het terras spuiten)
      if (h.arc < 359.9) {
        const v = ev.corners.find((c) => G.dist(c.p, h) < 0.15);
        if (v) {
          for (const [ds, da] of [[0, 0], [0, -15], [15, -15]]) out.push({ ...h, start: Math.round(G.normDeg(v.start + ds)), arc: Math.round(v.interior + da) });
        } else {
          const c = G.closestOnPolygon(h, ev.edge);
          if (c.d < 0.15) {
            const A = ev.edge[c.edge], B = ev.edge[(c.edge + 1) % ev.edge.length];
            out.push({ ...h, start: Math.round(G.normDeg(G.angleOf(G.sub(B, A)))), arc: 180 });
          }
        }
      }
      const step = Math.max(0.3, 0.1 * h.r);
      if (h.arc >= 359.9) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const p = { x: h.x + dx * step, y: h.y + dy * step };
          if (G.pointInPolygon(p, ev.pts)) out.push({ ...h, x: p.x, y: p.y });
        }
      } else if (Math.abs(h.arc - 180) < 1) {
        const a = G.rad(h.start);
        for (const d of [-2 * step, -step, step, 2 * step]) {
          const c = G.closestOnPolygon({ x: h.x + Math.cos(a) * d, y: h.y + Math.sin(a) * d }, ev.edge);
          const A = ev.edge[c.edge], B = ev.edge[(c.edge + 1) % ev.edge.length];
          out.push({ ...h, x: c.pt.x, y: c.pt.y, start: Math.round(G.normDeg(G.angleOf(G.sub(B, A)))) });
        }
      }
    }
    return out.map((c) => C.fitRotator(c)).filter((c) => c.r !== h.r || c.arc !== h.arc || c.start !== h.start || c.x !== h.x || c.y !== h.y);
  }

  /**
   * Afstellen: per kop worp (stelschroef), sproeihoek en richting zo kiezen dat er
   * minder water buiten het vlak valt en de verdeling gelijkmatiger wordt.
   * Hebzuchtig: per kop de beste verbetering, rondes tot er niets meer te winnen is.
   */
  function refine(ev, heads, sc, rounds = 3, only = null, move = false) {
    let best = sc;
    if (!ev.inside.length) return best;
    const acc = accumulate(ev, heads);
    for (let round = 0; round < rounds; round++) {
      let improved = false;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].type === 'strip' || (only && !only.has(heads[i].id))) continue;
        let pick = null;
        apply(ev, acc, heads[i], -1);
        for (const cand of variantsOf(heads[i], move ? ev : null)) {
          apply(ev, acc, cand, 1);
          const tsc = costOf(ev, acc, heads.length);
          apply(ev, acc, cand, -1);
          if (tsc.cost < (pick ? pick.sc.cost : best.cost) - 1e-6) pick = { cand, sc: tsc };
        }
        if (pick) { heads[i] = pick.cand; best = pick.sc; improved = true; }
        apply(ev, acc, heads[i], 1);
      }
      if (!improved) break;
    }
    return best;
  }

  /**
   * Gele en droge plekken bijwerken: bij de droogste plek een kop erbij (op de rand een halve
   * cirkel langs de rand, binnenin een volle), afgesteld, en alleen houden als het beter wordt.
   */
  function fill(ev, heads, sc, type, s, body, tries = 4) {
    let best = sc;
    if (!ev.inside.length || type === 'strip') return best;
    const t = C.sprinklerTypes[type];
    const tried = [];
    for (let k = 0; k < tries; k++) {
      const acc = accumulate(ev, heads);
      let mean = 0;
      for (const v of acc.vals) mean += v;
      mean /= acc.vals.length;
      let at = -1;
      for (let i = 0; i < acc.vals.length; i++) {
        if (acc.vals[i] >= W.lowRatio * mean) continue;
        if (tried.some((p) => G.dist(p, ev.inside[i]) < 0.5 * s)) continue;
        if (at < 0 || acc.vals[i] < acc.vals[at]) at = i;
      }
      if (at < 0) break;
      const p = ev.inside[at];
      tried.push(p);
      const c = G.closestOnPolygon(p, ev.edge);
      let cand;
      if (c.d < 0.35 * s) {
        const n = ev.edge.length, A = ev.edge[c.edge], B = ev.edge[(c.edge + 1) % n];
        cand = makeRadial(type, c.pt, s, G.angleOf(G.sub(B, A)), 180, body);
      } else cand = makeRadial(type, p, clamp(c.d + 0.5 * s, t.rMin, s), 0, 360, body);
      const list = heads.concat([cand]);
      let tsc = costOf(ev, (() => { const a = accumulate(ev, list); return a; })(), list.length);
      tsc = refine(ev, list, tsc, 2, new Set([cand.id]), true);
      if (tsc.cost < best.cost - 1e-6) { heads.splice(0, heads.length, ...list); best = tsc; }
    }
    return best;
  }

  /**
   * Overbodige koppen weghalen: steeds de kop zonder welke de indeling het meest verbetert
   * (kluitjes langs de rand, dubbele hoekkoppen), tot weghalen niets meer oplevert.
   */
  function prune(ev, heads, sc) {
    let best = sc;
    if (!ev.inside.length) return best;
    const acc = accumulate(ev, heads);
    for (;;) {
      let pick = -1, pickSc = null;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].type === 'strip') continue;
        apply(ev, acc, heads[i], -1);
        const tsc = costOf(ev, acc, heads.length - 1);
        apply(ev, acc, heads[i], 1);
        if (tsc.cost < (pickSc ? pickSc.cost : best.cost) - 1e-6) { pick = i; pickSc = tsc; }
      }
      if (pick < 0 || heads.length <= 1) break;
      apply(ev, acc, heads[pick], -1);
      heads.splice(pick, 1);
      best = pickSc;
    }
    return best;
  }

  /**
   * Stelt bestaande koppen in een vlak optimaal af (positie blijft gelijk).
   * @param onlyIds alleen deze koppen afstellen (de rest blijft staan), of null voor alle
   * @returns {{heads, before, after}} nieuwe objecten (zelfde id's), plus de beoordeling voor en na
   */
  function tune(rawPts, heads, onlyIds = null, surroundings = null) {
    const pts = G.orientCW(rawPts);
    const list = heads.map((h) => C.fitRotator({ ...h }));
    if (!list.length || pts.length < 3) return { heads: list, before: null, after: null };
    const reach = Math.max(0.5, ...list.map((h) => (h.type === 'strip' ? Math.hypot(h.len / 2, h.width) : h.r * 1.1)));
    const ev = evaluator(pts, reach, surroundings);
    const before = score(ev, list);
    const after = refine(ev, list, before, 3, onlyIds ? new Set(onlyIds) : null);
    return { heads: list, before, after };
  }

  /** Kosten van een indeling (los aan te roepen). */
  function evaluate(pts, heads) {
    const reach = Math.max(0.5, ...heads.map((h) => (h.type === 'strip' ? Math.hypot(h.len / 2, h.width) : h.r)));
    return score(evaluator(G.orientCW(pts), reach), heads);
  }

  /** Haalt een kop van dit type deze worpwijdte (rotators: alleen afstanden die een kop uit de bibliotheek haalt)? */
  function feasible(type, r) {
    const t = C.sprinklerTypes[type];
    if (r < t.rMin - 1e-9 || r > t.rMax + 1e-9) return false;
    if (type === 'rotator' && C.rotatorModels) {
      const models = Object.values(C.rotatorModelsAvailable ? C.rotatorModelsAvailable() : C.rotatorModels);
      return models.some((m) => r >= m.rMin - 1e-9 && r <= m.rMax + 1e-9);
    }
    return true;
  }

  /**
   * Afstanden om te proberen, per richting: de lengte in gelijke stukken verdeeld, van zo groot
   * mogelijk (volle worp) tot een paar stappen kleiner. Meer koppen dan dat wint nooit.
   */
  function spacingsAlong(type, L) {
    const t = C.sprinklerTypes[type];
    const out = new Set();
    const models = () => Object.values(C.rotatorModelsAvailable ? C.rotatorModelsAvailable() : C.rotatorModels);
    // tot 20% verder dan de worp: tussen twee rijen randkoppen valt dan nog genoeg (bijv. 12 m breed met 10 m worp)
    const k0 = Math.max(1, Math.ceil(L / (1.2 * t.rMax) - 1e-6));
    for (let k = k0; k <= Math.ceil(L / t.rMin) && k <= 12 && k <= k0 + 4; k++) {
      const r = round1(L / k);
      if (feasible(type, r) || (r > t.rMax && feasible(type, t.rMax))) out.add(r);
      else if (type === 'rotator' && C.rotatorModels) {
        // valt in een gat tussen twee koppen: de grootste kop die er net onder blijft
        const below = models().map((m) => m.rMax).filter((m) => m < r).sort((x, y) => y - x)[0];
        if (below) out.add(round1(below));
      }
    }
    if (!out.size) out.add(round1(clamp(L, t.rMin, t.rMax)));
    return [...out];
  }

  /**
   * Plaatst sproeiers in een polygoon.
   * @param {Array<{x,y}>} rawPts
   * @param {string} type  spray|rotator|rotor
   * @param {object} [opts] {r: vaste worpwijdte, body, dry/wet: polygonen rondom (huis/terras, mag nat)}
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
    const fixed = opts.r ? clamp(opts.r, t.rMin, t.rMax) : null;
    const ev = evaluator(pts, fixed || t.rMax, opts);
    const cands = [];
    // per afstand de grove vorm (trapjes weg) en, als die afwijkt, ook de vorm zelf: bij een
    // terras langs het gazon kan een kop op elk trapje beter zijn dan water op het terras
    const coarse = new Map();
    const shapesFor = (key) => {
      if (!coarse.has(key)) {
        const c = coarseShape(shape, key);
        coarse.set(key, c === shape ? [['', shape]] : [['grof', c], ['', shape]]);
      }
      return coarse.get(key);
    };
    for (const angle of angles) {
      const a = G.rad(angle);
      const u = { x: Math.cos(a), y: Math.sin(a) }, v = { x: -u.y, y: u.x };
      const pu = shape.map((p) => G.dot(p, u)), pv = shape.map((p) => G.dot(p, v));
      const Lu = Math.max(...pu) - Math.min(...pu), Lv = Math.max(...pv) - Math.min(...pv);
      const alongU = fixed ? [fixed] : spacingsAlong(type, Lu);
      const alongV = fixed ? [fixed] : spacingsAlong(type, Lv);
      for (const pattern of ['square', 'triangle']) {
        const seen = new Set();
        for (const su of alongU) {
          for (const sv of alongV) {
            // rechthoekig verband mag, maar niet extreem langgerekt (dan valt er midden tussen te weinig)
            if (Math.max(su, sv) > 2 * Math.min(su, sv)) continue;
            for (const [variant, form] of shapesFor(round1(Math.min(su, sv)))) {
              const heads = layout(form, type, su, angle, pattern, sv, opts.body || null);
              if (seen.has(variant + heads.key)) continue;
              seen.add(variant + heads.key);
              cands.push({ heads, score: score(ev, heads) });
            }
          }
        }
        // vanaf de rand, met de kleinste en de grootste afstand
        for (const sp of new Set([Math.min(...alongU, ...alongV), Math.max(...alongU, ...alongV)])) {
          for (const [, form] of shapesFor(round1(sp))) {
            const heads = layoutPerimeter(form, type, sp, angle, pattern, opts.body || null);
            if (heads.length) cands.push({ heads, score: score(ev, heads) });
          }
        }
      }
    }
    if (!cands.length) return [];
    // de beste paar indelingen eerst afstellen en dan pas kiezen: een ruim verband met grote
    // koppen wint vaak pas als randkoppen zijn ingekort
    cands.sort((x, y) => x.score.cost - y.score.cost);
    let best = null;
    // eerst ruw afstellen, dan de beste twee ook verschuiven en aanvullen, dan de winnaar fijn
    const top = cands.slice(0, 6);
    for (const c of top) c.score = refine(ev, c.heads, prune(ev, c.heads, c.score), 2);
    top.sort((x, y) => x.score.cost - y.score.cost);
    for (const c of top.slice(0, 2)) {
      c.score = refine(ev, c.heads, c.score, 3, null, true);
      c.score = fill(ev, c.heads, c.score, type, c.heads.spacing, opts.body || null);
      if (!best || c.score.cost < best.score.cost) best = c;
    }
    best.score = refine(ev, best.heads, prune(ev, best.heads, best.score), 6, null, true);
    return best.heads;
  }

  /** Benodigde druk aan de kraan bovenop de kopdruk (leidingverlies, ventielen). */
  const PRESSURE_MARGIN = 0.2;

  /**
   * Kiest per gazon het beste sproeiertype: elk bruikbaar type wordt geplaatst en afgesteld en
   * de indelingen worden met dezelfde maatstaf vergeleken (aantal koppen, water buiten het
   * vlak, gele en droge plekken, gelijkmatigheid). Types die bij de beschikbare druk niet
   * werken, doen niet mee (tenzij er dan niets overblijft).
   * @param {Array<{x,y}>} rawPts
   * @param {object} [opts] {types: kandidaten, bodies: {type: behuizing}, pressure: bar, dry/wet: polygonen rondom}
   * @returns {{type, heads, score, results: Array<{type, count, score}>}}
   */
  function bestPlace(rawPts, opts = {}) {
    if (!rawPts || rawPts.length < 3) return { type: null, heads: [], score: null, results: [] };
    let types = (opts.types || ['rotator', 'spray', 'rotor']).filter((k) => C.sprinklerTypes[k]);
    if (opts.pressure > 0) {
      const ok = types.filter((k) => C.sprinklerTypes[k].minBar <= opts.pressure - PRESSURE_MARGIN + 1e-9);
      if (ok.length) types = ok;
    }
    const placed = types.map((type) => ({ type, heads: autoPlace(rawPts, type, { body: (opts.bodies || {})[type] || null, dry: opts.dry, wet: opts.wet }) }));
    const pts = G.orientCW(rawPts);
    const reach = Math.max(0.5, ...placed.flatMap((p) => p.heads.map((h) => (h.type === 'strip' ? Math.hypot(h.len / 2, h.width) : h.r))));
    const ev = evaluator(pts, reach, opts);
    let best = null;
    const results = placed.map((p) => {
      const sc = score(ev, p.heads);
      const res = { type: p.type, count: p.heads.length, score: sc };
      if (p.heads.length && (!best || sc.cost < best.score.cost)) best = { ...p, score: sc };
      return res;
    });
    if (!best) return { type: null, heads: [], score: null, results };
    const type = best.heads.every((h) => h.type === 'strip') ? 'strip' : best.type;
    return { type, heads: best.heads, score: best.score, results };
  }

  /** Plaatsing met een vaste worpwijdte. */
  function placeWithRadius(rawPts, type, r) {
    return autoPlace(rawPts, type, r ? { r } : {});
  }

  window.Planner = { autoPlace, bestPlace, placeWithRadius, evaluate, tune, autoRadius, placementShape, NARROW_WIDTH };
})();
