/* Geometrie-hulpfuncties. Wereldcoördinaten in meters, y-as naar beneden. */
(function () {
  'use strict';

  const Geo = {};

  /**
   * Afstand tussen twee punten.
   * @param {{x: number, y: number}} pointA eerste punt
   * @param {{x: number, y: number}} pointB tweede punt
   * @returns {number} de afstand
   */
  Geo.dist = (pointA, pointB) => Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  /**
   * Trekt twee vectoren van elkaar af.
   * @param {{x: number, y: number}} vectorA vector
   * @param {{x: number, y: number}} vectorB af te trekken vector
   * @returns {{x: number, y: number}} vectorA − vectorB
   */
  Geo.sub = (vectorA, vectorB) => ({ x: vectorA.x - vectorB.x, y: vectorA.y - vectorB.y });
  /**
   * Telt twee vectoren op.
   * @param {{x: number, y: number}} vectorA vector
   * @param {{x: number, y: number}} vectorB vector
   * @returns {{x: number, y: number}} de som
   */
  Geo.add = (vectorA, vectorB) => ({ x: vectorA.x + vectorB.x, y: vectorA.y + vectorB.y });
  /**
   * Vermenigvuldigt een vector met een getal.
   * @param {{x: number, y: number}} vector de vector
   * @param {number} factor de factor
   * @returns {{x: number, y: number}} de geschaalde vector
   */
  Geo.mul = (vector, factor) => ({ x: vector.x * factor, y: vector.y * factor });
  /**
   * Lengte van een vector.
   * @param {{x: number, y: number}} vector de vector
   * @returns {number} de lengte
   */
  Geo.len = (vector) => Math.hypot(vector.x, vector.y);
  /**
   * Maakt een vector met lengte 1 (een nulvector blijft nul).
   * @param {{x: number, y: number}} vector de vector
   * @returns {{x: number, y: number}} de eenheidsvector
   */
  Geo.norm = (vector) => {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
  };
  /**
   * Inproduct van twee vectoren.
   * @param {{x: number, y: number}} vectorA vector
   * @param {{x: number, y: number}} vectorB vector
   * @returns {number} het inproduct
   */
  Geo.dot = (vectorA, vectorB) => vectorA.x * vectorB.x + vectorA.y * vectorB.y;
  /**
   * Kruisproduct (z-component) van twee vectoren.
   * @param {{x: number, y: number}} vectorA vector
   * @param {{x: number, y: number}} vectorB vector
   * @returns {number} het kruisproduct
   */
  Geo.cross = (vectorA, vectorB) => vectorA.x * vectorB.y - vectorA.y * vectorB.x;
  /**
   * Rekent radialen om naar graden.
   * @param {number} radians hoek in radialen
   * @returns {number} hoek in graden
   */
  Geo.deg = (radians) => (radians * 180) / Math.PI;
  /**
   * Rekent graden om naar radialen.
   * @param {number} degrees hoek in graden
   * @returns {number} hoek in radialen
   */
  Geo.rad = (degrees) => (degrees * Math.PI) / 180;
  /**
   * Brengt een hoek terug naar 0–360 graden.
   * @param {number} degrees hoek in graden
   * @returns {number} hoek tussen 0 en 360
   */
  Geo.normDeg = (degrees) => ((degrees % 360) + 360) % 360;

  /**
   * Oppervlak met teken (positief = met de klok mee op scherm, omdat y omlaag wijst).
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @returns {number} oppervlak met teken
   */
  Geo.signedArea = (points) => {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      sum += current.x * next.y - next.x * current.y;
    }
    return sum / 2;
  };
  /**
   * Oppervlak van een polygoon.
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @returns {number} oppervlak (altijd positief)
   */
  Geo.area = (points) => Math.abs(Geo.signedArea(points));

  /**
   * Omtrek van een gesloten polygoon.
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @returns {number} de omtrek
   */
  Geo.perimeter = (points) => {
    let sum = 0;
    for (let i = 0; i < points.length; i++) sum += Geo.dist(points[i], points[(i + 1) % points.length]);
    return sum;
  };

  /**
   * Zwaartepunt van een polygoon (bij oppervlak 0 het gemiddelde van de punten).
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @returns {{x: number, y: number}} het zwaartepunt
   */
  Geo.centroid = (points) => {
    let sumX = 0, sumY = 0, doubleArea = 0;
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      const crossProduct = current.x * next.y - next.x * current.y;
      sumX += (current.x + next.x) * crossProduct;
      sumY += (current.y + next.y) * crossProduct;
      doubleArea += crossProduct;
    }
    if (Math.abs(doubleArea) < 1e-9) {
      const count = points.length || 1;
      return { x: points.reduce((sum, point) => sum + point.x, 0) / count, y: points.reduce((sum, point) => sum + point.y, 0) / count };
    }
    doubleArea *= 0.5;
    return { x: sumX / (6 * doubleArea), y: sumY / (6 * doubleArea) };
  };

  /**
   * Omsluitende rechthoek langs de assen.
   * @param {Array<{x: number, y: number}>} points de punten
   * @returns {{minX: number, minY: number, maxX: number, maxY: number, w: number, h: number}} grenzen, breedte en hoogte
   */
  Geo.bbox = (points) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };

  /**
   * Zegt of een punt binnen een polygoon ligt (even-oneven-regel).
   * @param {{x: number, y: number}} point het punt
   * @param {Array<{x: number, y: number}>} points hoekpunten van de polygoon
   * @returns {boolean} true als het punt erbinnen ligt
   */
  Geo.pointInPolygon = (point, points) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const current = points[i], previous = points[j];
      if ((current.y > point.y) !== (previous.y > point.y) && point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x) {
        inside = !inside;
      }
    }
    return inside;
  };

  /**
   * Dichtstbijzijnde punt op een lijnstuk.
   * @param {{x: number, y: number}} point het punt
   * @param {{x: number, y: number}} start begin van het lijnstuk
   * @param {{x: number, y: number}} end eind van het lijnstuk
   * @returns {{x: number, y: number, t: number}} het punt en de positie langs het lijnstuk (0–1)
   */
  Geo.closestOnSegment = (point, start, end) => {
    const segment = Geo.sub(end, start);
    const lengthSquared = Geo.dot(segment, segment);
    let fraction = lengthSquared ? Geo.dot(Geo.sub(point, start), segment) / lengthSquared : 0;
    fraction = Math.max(0, Math.min(1, fraction));
    return { x: start.x + segment.x * fraction, y: start.y + segment.y * fraction, t: fraction };
  };

  /**
   * Afstand van een punt tot een lijnstuk.
   * @param {{x: number, y: number}} point het punt
   * @param {{x: number, y: number}} start begin van het lijnstuk
   * @param {{x: number, y: number}} end eind van het lijnstuk
   * @returns {number} de afstand
   */
  Geo.distToSegment = (point, start, end) => Geo.dist(point, Geo.closestOnSegment(point, start, end));

  /**
   * Kleinste afstand van een punt tot de rand van een polygoon, met index van de rand.
   * @param {{x: number, y: number}} point het punt
   * @param {Array<{x: number, y: number}>} points hoekpunten van de polygoon
   * @returns {{d: number, pt: ({x: number, y: number}|null), edge: number}} afstand, dichtstbijzijnde punt en index van de rand
   */
  Geo.closestOnPolygon = (point, points) => {
    let best = { d: Infinity, pt: null, edge: -1 };
    for (let i = 0; i < points.length; i++) {
      const closest = Geo.closestOnSegment(point, points[i], points[(i + 1) % points.length]);
      const distance = Geo.dist(point, closest);
      if (distance < best.d) best = { d: distance, pt: { x: closest.x, y: closest.y }, edge: i };
    }
    return best;
  };

  /**
   * Maakt de polygoon met de klok mee (op scherm), zodat het binnenste rechts van elke rand ligt.
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @returns {Array<{x: number, y: number}>} kopie met de klok mee
   */
  Geo.orientCW = (points) => (Geo.signedArea(points) < 0 ? points.slice().reverse() : points.slice());

  /**
   * Convex omhulsel (monotone-ketenalgoritme).
   * @param {Array<{x: number, y: number}>} points de punten
   * @returns {Array<{x: number, y: number}>} hoekpunten van het omhulsel
   */
  Geo.convexHull = (points) => {
    const sorted = points.map((point) => ({ x: point.x, y: point.y })).sort((left, right) => left.x - right.x || left.y - right.y);
    if (sorted.length < 3) return sorted;
    /**
     * Zegt naar welke kant de lijn van origin via pointA naar pointB afbuigt.
     * @param {{x: number, y: number}} origin beginpunt
     * @param {{x: number, y: number}} pointA middelste punt
     * @param {{x: number, y: number}} pointB eindpunt
     * @returns {number} positief = linksaf, negatief = rechtsaf, 0 = recht
     */
    const turn = (origin, pointA, pointB) => (pointA.x - origin.x) * (pointB.y - origin.y) - (pointA.y - origin.y) * (pointB.x - origin.x);
    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const point = sorted[i];
      while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  };

  /**
   * Georiënteerde omsluitende rechthoek met minimale breedte (rotating calipers, benadering per rand van het omhulsel).
   * @param {Array<{x: number, y: number}>} points de punten
   * @returns {object|null} assen (u, v), grenzen langs beide assen, breedte en lengte
   */
  Geo.minWidthRect = (points) => {
    const hull = Geo.convexHull(points);
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const start = hull[i];
      const end = hull[(i + 1) % hull.length];
      const alongEdge = Geo.norm(Geo.sub(end, start));
      const acrossEdge = { x: -alongEdge.y, y: alongEdge.x };
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const point of hull) {
        const alongValue = Geo.dot(point, alongEdge), acrossValue = Geo.dot(point, acrossEdge);
        minU = Math.min(minU, alongValue); maxU = Math.max(maxU, alongValue);
        minV = Math.min(minV, acrossValue); maxV = Math.max(maxV, acrossValue);
      }
      const width = maxV - minV;
      if (!best || width < best.width) {
        best = { u: alongEdge, v: acrossEdge, minU, maxU, minV, maxV, width, length: maxU - minU };
      }
    }
    return best;
  };

  /**
   * Vereenvoudigt een gesloten polygoon (Douglas-Peucker): punten die minder dan de tolerantie afwijken vervallen.
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @param {number} tolerance toegestane afwijking in meters
   * @returns {Array<{x: number, y: number}>} de overgebleven hoekpunten
   */
  Geo.simplifyClosed = (points, tolerance) => {
    const count = points.length;
    if (count < 4) return points.slice();
    /**
     * Zoekt het punt dat het verst van een gegeven punt ligt.
     * @param {number} from index van het punt
     * @returns {number} index van het verste punt
     */
    const farthestFrom = (from) => { let farthest = 0, farthestDistance = -1; points.forEach((point, i) => { const distance = Geo.dist(point, points[from]); if (distance > farthestDistance) { farthestDistance = distance; farthest = i; } }); return farthest; };
    const firstSplit = farthestFrom(0), secondSplit = farthestFrom(firstSplit);
    const keep = new Uint8Array(count);
    keep[firstSplit] = keep[secondSplit] = 1;
    /**
     * Vereenvoudigt het stuk van de ring van index i tot j (j na i).
     * @param {number} i beginindex
     * @param {number} j eindindex
     */
    const simplifyRun = (i, j) => { // i..j langs de ring (j na i)
      const span = (j - i + count) % count;
      if (span < 2) return;
      let best = -1, bestDistance = tolerance;
      for (let step = 1; step < span; step++) {
        const index = (i + step) % count;
        const distance = Geo.distToSegment(points[index], points[i], points[j]);
        if (distance > bestDistance) { bestDistance = distance; best = index; }
      }
      if (best < 0) return;
      keep[best] = 1;
      simplifyRun(i, best);
      simplifyRun(best, j);
    };
    simplifyRun(firstSplit, secondSplit);
    simplifyRun(secondSplit, firstSplit);
    const result = points.filter((_, i) => keep[i]);
    return result.length >= 3 ? result : points.slice();
  };

  /**
   * Hoofdrichting (graden, 0–90) van een of meer polygonen: de richting waarin de meeste randlengte ligt.
   * @param {Array<Array<{x: number, y: number}>>} polygons de polygonen
   * @returns {number} hoek in graden
   */
  Geo.dominantAngle = (polygons) => {
    const bins = new Float64Array(90);
    for (const points of polygons) {
      for (let i = 0; i < points.length; i++) {
        const edge = Geo.sub(points[(i + 1) % points.length], points[i]);
        const length = Geo.len(edge);
        if (length < 1e-9) continue;
        bins[Math.floor(Geo.normDeg(Geo.angleOf(edge)) % 90) % 90] += length;
      }
    }
    let best = 0, bestWeight = -1;
    for (let bin = 0; bin < 90; bin++) {
      let weight = 0;
      for (let offset = -3; offset <= 3; offset++) weight += bins[(bin + offset + 90) % 90] * (4 - Math.abs(offset));
      if (weight > bestWeight) { bestWeight = weight; best = bin; }
    }
    // verfijnen: gewogen gemiddelde van de randen rond de piek
    let sum = 0, weightSum = 0;
    for (const points of polygons) {
      for (let i = 0; i < points.length; i++) {
        const edge = Geo.sub(points[(i + 1) % points.length], points[i]);
        const length = Geo.len(edge);
        if (length < 1e-9) continue;
        let edgeAngle = Geo.normDeg(Geo.angleOf(edge)) % 90;
        let difference = edgeAngle - (best + 0.5);
        if (difference > 45) difference -= 90;
        if (difference < -45) difference += 90;
        if (Math.abs(difference) <= 4) { sum += difference * length; weightSum += length; }
      }
    }
    return Geo.normDeg(best + 0.5 + (weightSum ? sum / weightSum : 0)) % 90;
  };

  /**
   * Trekt een polygoon recht: randen die minder dan `tolDeg` van de hoofdrichting (of haaks daarop) afwijken worden precies evenwijdig of haaks; bijna-gelijke evenwijdige randen worden één rand. Valt het resultaat te ver af (oppervlak), dan blijft de invoer. Met `maxShift` (m) verschuift geen rand verder dan dat: een schuine rand wordt alleen recht gezet als de uiteinden daarbij hooguit `maxShift` opschuiven, en de uitkomst mag nergens verder dan `maxShift` van de invoer liggen. Zo blijven bochten bochten.
   * @param {Array<{x: number, y: number}>} points hoekpunten
   * @param {number} angleDeg hoofdrichting in graden
   * @param {{tolDeg: number, merge: number, maxShift: number, minEdge: number}} options toleranties
   * @returns {Array<{x: number, y: number}>} de rechtgetrokken hoekpunten (of een kopie van de invoer)
   */
  Geo.regularize = (points, angleDeg, options = {}) => {
    const tolDeg = options.tolDeg == null ? 12 : options.tolDeg;
    const merge = options.merge == null ? 0.25 : options.merge;
    if (points.length < 4) return points.slice();
    const angle = Geo.rad(angleDeg);
    const axes = [{ x: Math.cos(angle), y: Math.sin(angle) }, { x: -Math.sin(angle), y: Math.cos(angle) }];
    const cosTolerance = Math.cos(Geo.rad(tolDeg));
    const lines = [];
    for (let i = 0; i < points.length; i++) {
      const start = points[i], end = points[(i + 1) % points.length];
      const length = Geo.dist(start, end);
      if (length < 1e-9) continue;
      let direction = Geo.norm(Geo.sub(end, start));
      let snapped = false;
      for (const axis of axes) {
        const cosine = Geo.dot(direction, axis);
        if (Math.abs(cosine) < cosTolerance) continue;
        if (options.maxShift != null && (length / 2) * Math.sqrt(Math.max(0, 1 - cosine * cosine)) > options.maxShift) continue;
        direction = cosine > 0 ? axis : Geo.mul(axis, -1); snapped = true;
      }
      lines.push({ p: Geo.mul(Geo.add(start, end), 0.5), d: direction, len: length, start, snapped });
    }
    // korte schuine stukjes tussen twee rechte randen (afgeronde of afgeschuinde hoek) vervallen
    const minEdge = options.minEdge == null ? 0.6 : options.minEdge;
    for (let i = lines.length - 1; i >= 0 && lines.length > 3; i--) {
      const line = lines[i];
      const previous = lines[(i - 1 + lines.length) % lines.length], next = lines[(i + 1) % lines.length];
      if (!line.snapped && line.len < minEdge && previous.snapped && next.snapped && Math.abs(Geo.cross(previous.d, next.d)) > 0.5) lines.splice(i, 1);
    }
    const out = [];
    /**
     * Voegt een rand aan de vorige toe als ze in elkaar overlopen.
     * @param {object} last de vorige rand (wordt aangepast bij samenvoegen)
     * @param {object} line de nieuwe rand
     * @returns {string|object} 'corner' (hoek), 'merged' (samengevoegd) of een tussenrand voor een verspringing
     */
    const join = (last, line) => {
      if (Geo.dot(last.d, line.d) < 0.9986) return 'corner';
      const normal = { x: -last.d.y, y: last.d.x };
      const offset = Geo.dot(Geo.sub(line.p, last.p), normal);
      if (Math.abs(offset) <= merge) {
        last.p = Geo.add(last.p, Geo.mul(normal, (offset * line.len) / (last.len + line.len)));
        last.len += line.len;
        return 'merged';
      }
      return { p: line.start, d: normal, len: Math.abs(offset), start: line.start };
    };
    for (const line of lines) {
      const last = out[out.length - 1];
      const joined = last ? join(last, line) : 'corner';
      if (joined === 'merged') continue;
      if (joined !== 'corner') out.push(joined);
      out.push(line);
    }
    if (out.length > 2) {
      const firstLine = out[0], lastLine = out[out.length - 1];
      const joined = join(firstLine, { ...lastLine, start: lastLine.start });
      if (joined === 'merged') { firstLine.start = lastLine.start; out.pop(); } else if (joined !== 'corner') out.push({ ...joined, start: firstLine.start, p: firstLine.start });
    }
    if (out.length < 3) return points.slice();
    const corners = [];
    for (let i = 0; i < out.length; i++) {
      const previousLine = out[(i - 1 + out.length) % out.length], currentLine = out[i];
      const denominator = Geo.cross(previousLine.d, currentLine.d);
      let corner = currentLine.start;
      if (Math.abs(denominator) > 1e-6) {
        const fraction = Geo.cross(Geo.sub(currentLine.p, previousLine.p), currentLine.d) / denominator;
        const intersection = Geo.add(previousLine.p, Geo.mul(previousLine.d, fraction));
        if (Geo.dist(intersection, currentLine.start) < 2 * merge + 0.5) corner = intersection;
      }
      if (!corners.length || Geo.dist(corners[corners.length - 1], corner) > 0.02) corners.push(corner);
    }
    if (corners.length > 2 && Geo.dist(corners[0], corners[corners.length - 1]) <= 0.02) corners.pop();
    // rechte tussenpunten weg
    const clean = corners.filter((point, i) => {
      const previous = corners[(i - 1 + corners.length) % corners.length], next = corners[(i + 1) % corners.length];
      return Geo.distToSegment(point, previous, next) > 0.01;
    });
    const areaBefore = Geo.area(points), areaAfter = clean.length >= 3 ? Geo.area(clean) : 0;
    if (clean.length < 3 || Math.abs(areaAfter - areaBefore) > 0.12 * areaBefore) return points.slice();
    if (options.maxShift != null && Geo.deviation(points, clean) > options.maxShift) return points.slice();
    return clean;
  };

  /**
   * Grootste afstand (m) tussen de randen van twee polygonen, in beide richtingen gemeten langs de hoekpunten.
   * @param {Array<{x: number, y: number}>} polygonA eerste polygoon
   * @param {Array<{x: number, y: number}>} polygonB tweede polygoon
   * @returns {number} de grootste afstand
   */
  Geo.deviation = (polygonA, polygonB) => {
    let maximum = 0;
    for (const point of polygonA) maximum = Math.max(maximum, Geo.closestOnPolygon(point, polygonB).d);
    for (const point of polygonB) maximum = Math.max(maximum, Geo.closestOnPolygon(point, polygonA).d);
    return maximum;
  };

  /**
   * Hoek (graden) van een vector, 0 = +x, positief richting +y (met de klok mee op scherm).
   * @param {{x: number, y: number}} vector de vector
   * @returns {number} hoek tussen 0 en 360
   */
  Geo.angleOf = (vector) => Geo.normDeg(Geo.deg(Math.atan2(vector.y, vector.x)));

  /**
   * Zegt of een hoek binnen de sector [start, start+arc] ligt.
   * @param {number} angle de hoek in graden
   * @param {number} start begin van de sector in graden
   * @param {number} arc grootte van de sector in graden
   * @returns {boolean} true als de hoek erbinnen ligt
   */
  Geo.inArc = (angle, start, arc) => {
    if (arc >= 359.9) return true;
    const offset = Geo.normDeg(angle - start);
    return offset <= arc + 1e-6;
  };

  /**
   * Getal in Nederlandse notatie (decimale komma).
   * @param {number} value het getal
   * @param {number} decimals aantal decimalen (standaard 1)
   * @returns {string} bijv. '4,60'
   */
  Geo.nl = (value, decimals = 1) => Number(value).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  /**
   * Zoals nl(), maar zonder overbodige nullen (4,6 i.p.v. 4,60).
   * @param {number} value het getal
   * @param {number} decimals maximaal aantal decimalen (standaard 2)
   * @returns {string} bijv. '4,6'
   */
  Geo.nlShort = (value, decimals = 2) => Number(value).toLocaleString('nl-NL', { maximumFractionDigits: decimals });

  /**
   * Maakt een kort, uniek id.
   * @returns {function(string): string} functie die bij een voorvoegsel een nieuw id geeft
   */
  Geo.uid = (() => {
    let counter = Date.now() % 100000;
    /**
     * Geeft een nieuw id.
     * @param {string} prefix voorvoegsel (bijv. 'a' voor een vlak)
     * @returns {string} het id
     */
    return (prefix) => `${prefix}${(counter++).toString(36)}`;
  })();

  window.Geo = Geo;
})();
