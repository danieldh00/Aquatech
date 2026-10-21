/* Geometrie-hulpfuncties. Wereldcoördinaten in meters, y-as naar beneden. */
(function () {
  'use strict';

  const G = {};

  G.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  G.sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  G.add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  G.mul = (a, s) => ({ x: a.x * s, y: a.y * s });
  G.len = (v) => Math.hypot(v.x, v.y);
  G.norm = (v) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  G.dot = (a, b) => a.x * b.x + a.y * b.y;
  G.cross = (a, b) => a.x * b.y - a.y * b.x;
  G.deg = (rad) => (rad * 180) / Math.PI;
  G.rad = (deg) => (deg * Math.PI) / 180;
  G.normDeg = (d) => ((d % 360) + 360) % 360;

  /** Signed area (positief = met de klok mee op scherm, omdat y omlaag wijst). */
  G.signedArea = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  };
  G.area = (pts) => Math.abs(G.signedArea(pts));

  G.perimeter = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) s += G.dist(pts[i], pts[(i + 1) % pts.length]);
    return s;
  };

  G.centroid = (pts) => {
    let cx = 0, cy = 0, a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const f = p.x * q.y - q.x * p.y;
      cx += (p.x + q.x) * f;
      cy += (p.y + q.y) * f;
      a += f;
    }
    if (Math.abs(a) < 1e-9) {
      const n = pts.length || 1;
      return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
    }
    a *= 0.5;
    return { x: cx / (6 * a), y: cy / (6 * a) };
  };

  G.bbox = (pts) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };

  G.pointInPolygon = (p, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  };

  G.closestOnSegment = (p, a, b) => {
    const ab = G.sub(b, a);
    const l2 = G.dot(ab, ab);
    let t = l2 ? G.dot(G.sub(p, a), ab) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + ab.x * t, y: a.y + ab.y * t, t };
  };

  G.distToSegment = (p, a, b) => G.dist(p, G.closestOnSegment(p, a, b));

  /** Kleinste afstand van punt tot de rand van een polygoon, met index van de rand. */
  G.closestOnPolygon = (p, pts) => {
    let best = { d: Infinity, pt: null, edge: -1 };
    for (let i = 0; i < pts.length; i++) {
      const c = G.closestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
      const d = G.dist(p, c);
      if (d < best.d) best = { d, pt: { x: c.x, y: c.y }, edge: i };
    }
    return best;
  };

  /** Maakt de polygoon met de klok mee (op scherm), zodat het binnenste rechts van elke rand ligt. */
  G.orientCW = (pts) => (G.signedArea(pts) < 0 ? pts.slice().reverse() : pts.slice());

  G.convexHull = (points) => {
    const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  };

  /** Georiënteerde omsluitende rechthoek met minimale breedte (rotating calipers, benadering per hull-rand). */
  G.minWidthRect = (pts) => {
    const hull = G.convexHull(pts);
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const u = G.norm(G.sub(b, a));
      const v = { x: -u.y, y: u.x };
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const pu = G.dot(p, u), pv = G.dot(p, v);
        minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
        minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
      }
      const width = maxV - minV;
      if (!best || width < best.width) {
        best = { u, v, minU, maxU, minV, maxV, width, length: maxU - minU };
      }
    }
    return best;
  };

  /** Vereenvoudigt een gesloten polygoon (Douglas-Peucker): punten die minder dan `tol` m afwijken vervallen. */
  G.simplifyClosed = (pts, tol) => {
    const n = pts.length;
    if (n < 4) return pts.slice();
    // splitsen op de twee verst uit elkaar liggende punten (benadering: verste van punt 0, dan verste daarvan)
    const far = (from) => { let k = 0, d = -1; pts.forEach((p, i) => { const e = G.dist(p, pts[from]); if (e > d) { d = e; k = i; } }); return k; };
    const a = far(0), b = far(a);
    const keep = new Uint8Array(n);
    keep[a] = keep[b] = 1;
    const run = (i, j) => { // i..j langs de ring (j na i)
      const len = (j - i + n) % n;
      if (len < 2) return;
      let best = -1, bd = tol;
      for (let s = 1; s < len; s++) {
        const k = (i + s) % n;
        const d = G.distToSegment(pts[k], pts[i], pts[j]);
        if (d > bd) { bd = d; best = k; }
      }
      if (best < 0) return;
      keep[best] = 1;
      run(i, best);
      run(best, j);
    };
    run(a, b);
    run(b, a);
    const out = pts.filter((_, i) => keep[i]);
    return out.length >= 3 ? out : pts.slice();
  };

  /** Hoofdrichting (graden, 0–90) van een of meer polygonen: de richting waarin de meeste randlengte ligt. */
  G.dominantAngle = (polys) => {
    const bins = new Float64Array(90);
    for (const pts of polys) {
      for (let i = 0; i < pts.length; i++) {
        const v = G.sub(pts[(i + 1) % pts.length], pts[i]);
        const l = G.len(v);
        if (l < 1e-9) continue;
        bins[Math.floor(G.normDeg(G.angleOf(v)) % 90) % 90] += l;
      }
    }
    let best = 0, bestW = -1;
    for (let k = 0; k < 90; k++) {
      let w = 0;
      for (let d = -3; d <= 3; d++) w += bins[(k + d + 90) % 90] * (4 - Math.abs(d));
      if (w > bestW) { bestW = w; best = k; }
    }
    // verfijnen: gewogen gemiddelde van de randen rond de piek
    let sum = 0, wsum = 0;
    for (const pts of polys) {
      for (let i = 0; i < pts.length; i++) {
        const v = G.sub(pts[(i + 1) % pts.length], pts[i]);
        const l = G.len(v);
        if (l < 1e-9) continue;
        let a = G.normDeg(G.angleOf(v)) % 90;
        let d = a - (best + 0.5);
        if (d > 45) d -= 90;
        if (d < -45) d += 90;
        if (Math.abs(d) <= 4) { sum += d * l; wsum += l; }
      }
    }
    return G.normDeg(best + 0.5 + (wsum ? sum / wsum : 0)) % 90;
  };

  /**
   * Trekt een polygoon recht: randen die minder dan `tolDeg` van de hoofdrichting (of haaks
   * daarop) afwijken worden precies evenwijdig of haaks; bijna-gelijke evenwijdige randen
   * worden één rand. Valt het resultaat te ver af (oppervlak), dan blijft de invoer.
   */
  G.regularize = (pts, angleDeg, opts = {}) => {
    const tolDeg = opts.tolDeg == null ? 12 : opts.tolDeg;
    const merge = opts.merge == null ? 0.25 : opts.merge;
    if (pts.length < 4) return pts.slice();
    const a = G.rad(angleDeg);
    const axes = [{ x: Math.cos(a), y: Math.sin(a) }, { x: -Math.sin(a), y: Math.cos(a) }];
    const cosTol = Math.cos(G.rad(tolDeg));
    const lines = [];
    for (let i = 0; i < pts.length; i++) {
      const A = pts[i], B = pts[(i + 1) % pts.length];
      const len = G.dist(A, B);
      if (len < 1e-9) continue;
      let d = G.norm(G.sub(B, A));
      let snapped = false;
      for (const ax of axes) {
        const c = G.dot(d, ax);
        if (Math.abs(c) >= cosTol) { d = c > 0 ? ax : G.mul(ax, -1); snapped = true; }
      }
      lines.push({ p: G.mul(G.add(A, B), 0.5), d, len, start: A, snapped });
    }
    // korte schuine stukjes tussen twee rechte randen (afgeronde of afgeschuinde hoek) vervallen
    const minEdge = opts.minEdge == null ? 0.6 : opts.minEdge;
    for (let i = lines.length - 1; i >= 0 && lines.length > 3; i--) {
      const l = lines[i];
      const prev = lines[(i - 1 + lines.length) % lines.length], next = lines[(i + 1) % lines.length];
      if (!l.snapped && l.len < minEdge && prev.snapped && next.snapped && Math.abs(G.cross(prev.d, next.d)) > 0.5) lines.splice(i, 1);
    }
    const out = [];
    const join = (last, l) => {
      if (G.dot(last.d, l.d) < 0.9986) return 'corner';
      const nrm = { x: -last.d.y, y: last.d.x };
      const off = G.dot(G.sub(l.p, last.p), nrm);
      if (Math.abs(off) <= merge) {
        last.p = G.add(last.p, G.mul(nrm, (off * l.len) / (last.len + l.len)));
        last.len += l.len;
        return 'merged';
      }
      return { p: l.start, d: nrm, len: Math.abs(off), start: l.start };
    };
    for (const l of lines) {
      const last = out[out.length - 1];
      const r = last ? join(last, l) : 'corner';
      if (r === 'merged') continue;
      if (r !== 'corner') out.push(r);
      out.push(l);
    }
    if (out.length > 2) {
      const first = out[0], last = out[out.length - 1];
      const r = join(first, { ...last, start: last.start });
      if (r === 'merged') { first.start = last.start; out.pop(); } else if (r !== 'corner') out.push({ ...r, start: first.start, p: first.start });
    }
    if (out.length < 3) return pts.slice();
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const L1 = out[(i - 1 + out.length) % out.length], L2 = out[i];
      const den = G.cross(L1.d, L2.d);
      let v = L2.start;
      if (Math.abs(den) > 1e-6) {
        const t = G.cross(G.sub(L2.p, L1.p), L2.d) / den;
        const q = G.add(L1.p, G.mul(L1.d, t));
        if (G.dist(q, L2.start) < 2 * merge + 0.5) v = q;
      }
      if (!res.length || G.dist(res[res.length - 1], v) > 0.02) res.push(v);
    }
    if (res.length > 2 && G.dist(res[0], res[res.length - 1]) <= 0.02) res.pop();
    // rechte tussenpunten weg
    const clean = res.filter((p, i) => {
      const prev = res[(i - 1 + res.length) % res.length], next = res[(i + 1) % res.length];
      return G.distToSegment(p, prev, next) > 0.01;
    });
    const A0 = G.area(pts), A1 = clean.length >= 3 ? G.area(clean) : 0;
    if (clean.length < 3 || Math.abs(A1 - A0) > 0.12 * A0) return pts.slice();
    return clean;
  };

  /** Hoek (graden) van vector, 0 = +x, positief richting +y (met de klok mee op scherm). */
  G.angleOf = (v) => G.normDeg(G.deg(Math.atan2(v.y, v.x)));

  /** Ligt hoek `a` binnen de sector [start, start+arc]? */
  G.inArc = (a, start, arc) => {
    if (arc >= 359.9) return true;
    const d = G.normDeg(a - start);
    return d <= arc + 1e-6;
  };

  /** Getal in Nederlandse notatie (decimale komma). */
  G.nl = (v, d = 1) => Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
  /** Zoals nl(), maar zonder overbodige nullen (4,6 i.p.v. 4,60). */
  G.nlShort = (v, d = 2) => Number(v).toLocaleString('nl-NL', { maximumFractionDigits: d });

  G.uid = (() => {
    let n = Date.now() % 100000;
    return (prefix) => `${prefix}${(n++).toString(36)}`;
  })();

  window.Geo = G;
})();
