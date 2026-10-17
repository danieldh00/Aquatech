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

  /** Hoek (graden) van vector, 0 = +x, positief richting +y (met de klok mee op scherm). */
  G.angleOf = (v) => G.normDeg(G.deg(Math.atan2(v.y, v.x)));

  /** Ligt hoek `a` binnen de sector [start, start+arc]? */
  G.inArc = (a, start, arc) => {
    if (arc >= 359.9) return true;
    const d = G.normDeg(a - start);
    return d <= arc + 1e-6;
  };

  G.uid = (() => {
    let n = Date.now() % 100000;
    return (prefix) => `${prefix}${(n++).toString(36)}`;
  })();

  window.Geo = G;
})();
