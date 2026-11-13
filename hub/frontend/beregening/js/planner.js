/*
 * Automatische plaatsing van sproeiers (kop-tot-kop).
 *
 * Werkwijze: de vorm wordt vereenvoudigd en rechtgetrokken op de hoofdrichting.
 * Daarna worden indelingen doorgerekend: een raster vierkant of driehoekig, in de
 * hoofdrichting of langs de smalste kant, met verschillende afstanden, en een
 * indeling vanaf de rand (hoeken, gelijke afstanden langs de rand, raster binnenin).
 * Een eigen snelle neerslagsimulatie geeft elke indeling kosten (koppen, water
 * buiten het vlak, niet-groene plekken op de neerslagkaart, droge plekken). De
 * beste indelingen worden afgesteld (worp, sproeihoek, richting, verschuiven),
 * overbodige koppen gaan eruit en droge plekken krijgen zo nodig een kop erbij.
 * Rotators worden binnen het bereik van hun kop gezet (MP-model, sector).
 */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;

  const CORNER_DEVIATION = 20; // graden afwijking van een rechte lijn om als hoek te tellen
  const NARROW_WIDTH = 3.0; // m; smaller => strooksproeiers
  const MIN_EDGE = 0.6; // m; kortere randjes van de vorm worden weggewerkt
  const SNAP = 0.5; // rasterpunten binnen deze fractie van de afstand tot de rand komen óp de rand
  const MAX_GRID_CELLS = 250000; // meetraster per vlak: hoogstens zoveel cellen (geheugen, rekentijd)
  const PRESSURE_MARGIN = 0.2; // bar; nodig aan de kraan bovenop de kopdruk (leidingverlies, ventielen)

  /**
   * Weging van de kosten van een indeling. Een kop telt zwaar (huis, nozzle, aansluiting en
   * graafwerk): liever minder koppen met volle worp dan veel kleine. Gelijkmatigheid telt
   * pas onder de streefwaarde mee; droge plekken en water buiten het vlak blijven zwaar.
   */
  const WEIGHTS = {
    head: 2.5, outside: 80, du: 60, duTarget: 0.85, dry: 6, low: 2.5, lowRatio: 0.7,
    // niet groen op de neerslagkaart (85–130% van het gemiddelde): te weinig per %, te veel per %
    off: 2, offHigh: 1.5, green: [0.85, 1.3],
    // water op een vlak dat droog moet blijven (huis, terras) telt 6×, op een vlak dat nat mag ¼×
    dryOut: 6, wetOut: 0.25,
  };

  /**
   * Begrenst een getal tussen een onder- en bovengrens.
   * @param {number} value Het getal.
   * @param {number} low Ondergrens.
   * @param {number} high Bovengrens.
   * @returns {number} Het begrensde getal.
   */
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  /**
   * Rondt af op één decimaal.
   * @param {number} value Het getal.
   * @returns {number} Afgerond op 0,1.
   */
  const round1 = (value) => Math.round(value * 10) / 10;

  /**
   * Kiest de worpwijdte zodat de breedte in gelijke kop-tot-kop afstanden wordt verdeeld.
   * @param {string} type Sproeiertype (spray, rotator, rotor).
   * @param {number} width Breedte van het vlak in meter.
   * @returns {number} Worpwijdte in meter.
   */
  function autoRadius(type, width) {
    const typeInfo = Catalog.sprinklerTypes[type];
    const preferred = type === 'spray' ? Math.min(typeInfo.rMax, 4.6) : typeInfo.rMax * 0.95;
    const count = Math.max(1, Math.ceil(width / preferred - 1e-6));
    return clamp(width / count, typeInfo.rMin, typeInfo.rMax);
  }

  /**
   * Maakt een kop met een sector (passend gemaakt op de nozzle als die er is).
   * @param {string} type Sproeiertype.
   * @param {{x: number, y: number}} point Plek van de kop.
   * @param {number} radius Worp in meter.
   * @param {number} start Beginrichting van de sector in graden.
   * @param {number} arc Sproeihoek in graden.
   * @param {string|null} body Gekozen behuizing, of null.
   * @returns {object} De sproeier.
   */
  function makeRadial(type, point, radius, start, arc, body) {
    const sprinkler = {
      id: Geo.uid('s'),
      type,
      ...(body ? { body } : {}),
      x: point.x,
      y: point.y,
      r: round1(radius),
      start: Math.round(Geo.normDeg(start)),
      arc: Math.round(clamp(arc, 10, 360)),
      zone: null,
    };
    return Catalog.fitRotator ? Catalog.fitRotator(sprinkler) : sprinkler;
  }

  /**
   * Strooksproeiers langs een smal vlak: gelijke stukken over de lengte.
   * @param {Array<{x: number, y: number}>} points Het vlak (niet gebruikt, alleen de rechthoek).
   * @param {object} rect Kleinste omsluitende rechthoek (Geo.minWidthRect).
   * @returns {object[]} Strooksproeiers.
   */
  function placeStrips(points, rect) {
    const stripType = Catalog.sprinklerTypes.strip;
    const count = Math.max(1, Math.ceil(rect.length / stripType.lMax - 1e-6));
    const segment = rect.length / count;
    const width = clamp(rect.width, stripType.wMin, stripType.wMax);
    const strips = [];
    for (let i = 0; i < count; i++) {
      const along = rect.minU + (i + 0.5) * segment;
      const point = Geo.add(Geo.mul(rect.u, along), Geo.mul(rect.v, rect.minV));
      strips.push({
        id: Geo.uid('s'),
        type: 'strip',
        x: point.x,
        y: point.y,
        r: 0,
        start: Math.round(Geo.angleOf(rect.u)),
        arc: 0,
        len: Math.round(clamp(segment, stripType.lMin, stripType.lMax) * 10) / 10,
        width: Math.round(width * 10) / 10,
        zone: null,
      });
    }
    return strips;
  }

  /**
   * Vorm waarop geplaatst wordt: zonder kartels (herkenning, toverstaf) en rechtgetrokken.
   * @param {Array<{x: number, y: number}>} points Omtrek van het vlak.
   * @returns {Array<{x: number, y: number}>} Vereenvoudigde vorm (met de klok mee).
   */
  function placementShape(points) {
    const simple = Geo.simplifyClosed(points, clamp(0.035 * Math.sqrt(Geo.area(points)), 0.12, 0.35));
    const angle = Geo.dominantAngle([simple]);
    let shape = Geo.orientCW(Geo.regularize(simple, angle, { tolDeg: 10, merge: 0.2 }));
    // trapjes en inhammen van een paar decimeter (boomkroon, tekst op de rand) weg: die vragen anders
    // elk een eigen hoekkop, terwijl de sproeiers er gewoon overheen werpen
    const trimmed = collapseShortEdges(shape, MIN_EDGE);
    if (trimmed.length >= 3 && trimmed.length < shape.length) {
      const again = Geo.orientCW(Geo.regularize(trimmed, angle, { tolDeg: 10, merge: 0.2 }));
      if (again.length >= 3 && Math.abs(Geo.area(again) - Geo.area(shape)) < 0.05 * Geo.area(shape)) shape = again;
    }
    return shape.length >= 3 ? shape : points;
  }

  /**
   * Vorm voor een bepaalde kopafstand: trapjes en inhammen die veel kleiner zijn dan de worp
   * (terrasranden, plantvakjes) weg, anders krijgt elk hoekje een eigen kop en ontstaan er
   * kluitjes koppen langs de rand. Valt er te veel af of bij, dan blijft de vorm zoals hij was.
   * @param {Array<{x: number, y: number}>} shape De plaatsingsvorm.
   * @param {number} spacing Kopafstand in meter.
   * @returns {Array<{x: number, y: number}>} De grove vorm, of `shape` zelf.
   */
  function coarseShape(shape, spacing) {
    const minEdge = clamp(0.3 * spacing, MIN_EDGE, 3);
    const trimmed = collapseShortEdges(shape, minEdge, true);
    if (trimmed.length < 3 || trimmed.length === shape.length) return shape;
    const angle = Geo.dominantAngle([shape]);
    const coarse = Geo.orientCW(Geo.regularize(trimmed, angle, { tolDeg: 10, merge: 0.2 }));
    return coarse.length >= 3 && Math.abs(Geo.area(coarse) - Geo.area(shape)) < 0.08 * Geo.area(shape) ? coarse : shape;
  }

  /**
   * Voegt steeds de kortste rand korter dan `minEdge` samen tot één punt, tot er geen meer is.
   * @param {Array<{x: number, y: number}>} points Omtrek.
   * @param {number} minEdge Kortere randen verdwijnen.
   * @param {boolean} [outward] Naar buiten: het eindpunt kiezen dat het grootste vlak overhoudt
   *   (anders het midden van de rand).
   * @returns {Array<{x: number, y: number}>} De nieuwe omtrek.
   */
  function collapseShortEdges(points, minEdge, outward = false) {
    let result = points.slice();
    while (result.length > 4) {
      let shortest = -1, shortestLength = minEdge;
      for (let i = 0; i < result.length; i++) {
        const length = Geo.dist(result[i], result[(i + 1) % result.length]);
        if (length < shortestLength) { shortestLength = length; shortest = i; }
      }
      if (shortest < 0) break;
      const next = (shortest + 1) % result.length;
      const rest = result.filter((_, index) => index !== shortest && index !== next);
      const insertAt = Math.min(shortest, rest.length);
      const options = [{ x: (result[shortest].x + result[next].x) / 2, y: (result[shortest].y + result[next].y) / 2 }];
      // naar buiten: het eindpunt dat het grootste vlak overhoudt, zodat er geen gazon achter de randkoppen valt
      if (outward) options.push(result[shortest], result[next]);
      let picked = null, pickedArea = -Infinity;
      for (const option of options) {
        const candidate = rest.slice();
        candidate.splice(insertAt, 0, option);
        const candidateArea = Math.abs(Geo.area(candidate));
        if (candidateArea > pickedArea + 1e-9) { picked = candidate; pickedArea = candidateArea; }
      }
      result = picked;
    }
    return result;
  }

  /**
   * Hoekpunten van de vorm met beginrichting (langs de volgende rand) en binnenhoek.
   * @param {Array<{x: number, y: number}>} points Omtrek (met de klok mee).
   * @returns {Array<{p: object, i: number, start: number, interior: number, corner: boolean}>}
   *   Per hoekpunt; `corner` als het geen rechte doorloop is.
   */
  function cornersOf(points) {
    const count = points.length;
    return points.map((point, index) => {
      const previous = points[(index - 1 + count) % count];
      const next = points[(index + 1) % count];
      const directionIn = Geo.norm(Geo.sub(point, previous));
      const directionOut = Geo.norm(Geo.sub(next, point));
      const start = Geo.angleOf(directionOut);
      const interior = Geo.normDeg(Geo.angleOf(Geo.mul(directionIn, -1)) - start) || 360;
      return { p: point, i: index, start, interior, corner: Math.abs(interior - 180) > CORNER_DEVIATION };
    });
  }

  /**
   * Eén indeling: raster in richting `angle`, met koppen op de hoeken, op de randen (in lijn
   * met het raster en zonder gaten groter dan de worp) en binnenin.
   * @param {Array<{x: number, y: number}>} shape De plaatsingsvorm.
   * @param {string} type Sproeiertype.
   * @param {number} spacing Afstand langs de hoofdrichting in meter.
   * @param {number} angle Hoofdrichting in graden.
   * @param {string} pattern 'square' of 'triangle'.
   * @param {number} [spacingAcross] Afstand dwars op de hoofdrichting.
   * @param {string|null} [body] Gekozen behuizing.
   * @returns {object[]} Sproeiers, met `key` (rastermaat) en `spacing` (worp) als eigenschap.
   */
  function layout(shape, type, spacing, angle, pattern, spacingAcross = spacing, body = null) {
    const typeInfo = Catalog.sprinklerTypes[type];
    const radians = Geo.rad(angle);
    const along = { x: Math.cos(radians), y: Math.sin(radians) };
    const across = { x: -along.y, y: along.x };
    let alongMin = Infinity, alongMax = -Infinity, acrossMin = Infinity, acrossMax = -Infinity;
    for (const point of shape) {
      const alongPos = Geo.dot(point, along), acrossPos = Geo.dot(point, across);
      alongMin = Math.min(alongMin, alongPos); alongMax = Math.max(alongMax, alongPos);
      acrossMin = Math.min(acrossMin, acrossPos); acrossMax = Math.max(acrossMax, acrossPos);
    }
    const triangle = pattern === 'triangle';
    const columns = Math.max(1, Math.ceil((alongMax - alongMin) / spacing - 1e-6));
    const columnStep = (alongMax - alongMin) / columns;
    const rowStep = triangle ? spacingAcross * Math.sqrt(3) / 2 : spacingAcross;
    const rows = Math.max(1, Math.ceil((acrossMax - acrossMin) / rowStep - 1e-6));
    const rowGap = (acrossMax - acrossMin) / rows;
    const minGap = Math.min(columnStep, rowGap) || spacing;
    // worp = grootste afstand tot een buurkop (kop-tot-kop), niet meer
    const radius = clamp(triangle ? Math.max(columnStep, Math.hypot(columnStep / 2, rowGap)) : Math.max(columnStep, rowGap), typeInfo.rMin, typeInfo.rMax);
    const count = shape.length;
    const corners = [], edgeHeads = [], inner = [];

    // hoeken (bol en hol)
    for (const vertex of cornersOf(shape)) {
      if (!vertex.corner) continue;
      // bolle hoek tussen twee korte randen: worp inkorten tot de langste, anders spuit de kop over beide uiteinden
      const longEdge = Math.max(Geo.dist(vertex.p, shape[(vertex.i + 1) % count]), Geo.dist(vertex.p, shape[(vertex.i - 1 + count) % count]));
      const cornerRadius = vertex.interior < 180 ? clamp(longEdge, Math.max(typeInfo.rMin, 0.75 * radius), radius) : radius;
      corners.push({ p: vertex.p, start: vertex.start, arc: vertex.interior, r: cornerRadius });
    }

    // rasterpunten: binnenin, of op de rand als ze er dichtbij liggen
    for (let j = 0; j <= rows; j++) {
      const shift = triangle && j % 2 ? columnStep / 2 : 0;
      for (let i = 0; i <= columns + (shift ? -1 : 0); i++) {
        const point = Geo.add(Geo.mul(along, alongMin + i * columnStep + shift), Geo.mul(across, acrossMin + j * rowGap));
        const inside = Geo.pointInPolygon(point, shape);
        const closest = Geo.closestOnPolygon(point, shape);
        if (inside && closest.d > SNAP * minGap) inner.push({ p: point, d: closest.d });
        else if (closest.d < SNAP * minGap) {
          const edgeStart = shape[closest.edge], edgeEnd = shape[(closest.edge + 1) % count];
          edgeHeads.push({ p: closest.pt, start: Geo.angleOf(Geo.sub(edgeEnd, edgeStart)), arc: 180 });
        }
      }
    }

    // samenvoegen: hoeken gaan voor, dan randkoppen
    const boundary = [];
    /**
     * Ligt er in de lijst al een kop binnen deze afstand?
     * @param {object[]} list Koppen met `p`.
     * @param {{x: number, y: number}} point Te toetsen plek.
     * @param {number} distance Afstand in meter.
     * @returns {boolean} Waar als er een kop dichtbij ligt.
     */
    const near = (list, point, distance) => list.some((other) => Geo.dist(other.p, point) < distance);
    for (const head of corners) if (!near(boundary, head.p, 0.05)) boundary.push(head);
    for (const head of edgeHeads) if (!near(boundary, head.p, 0.45 * minGap)) boundary.push(head);

    // randen zonder gaten: tussen opeenvolgende randkoppen hoogstens één afstand
    const extra = [];
    for (let edge = 0; edge < count; edge++) {
      const edgeStart = shape[edge], edgeEnd = shape[(edge + 1) % count];
      const edgeLength = Geo.dist(edgeStart, edgeEnd);
      if (edgeLength < 1e-6) continue;
      const direction = Geo.sub(edgeEnd, edgeStart);
      const onEdge = boundary.filter((head) => Geo.distToSegment(head.p, edgeStart, edgeEnd) < 0.05).map((head) => Geo.dot(Geo.sub(head.p, edgeStart), direction) / edgeLength);
      // de hoekpunten zelf tellen als steunpunt, ook als daar geen kop staat (rechte doorloop)
      onEdge.push(0, edgeLength);
      onEdge.sort((left, right) => left - right);
      for (let step = 1; step < onEdge.length; step++) {
        const gap = onEdge[step] - onEdge[step - 1];
        if (gap <= 1.15 * radius) continue;
        const parts = Math.ceil(gap / radius - 1e-6);
        for (let part = 1; part < parts; part++) {
          const position = onEdge[step - 1] + (gap * part) / parts;
          extra.push({ p: Geo.add(edgeStart, Geo.mul(direction, position / edgeLength)), start: Geo.angleOf(direction), arc: 180 });
        }
      }
    }
    for (const head of extra) if (!near(boundary, head.p, 0.3 * minGap)) boundary.push(head);
    // hoekpunten zonder hoek (rechte doorloop) maar met een gat ervoor: een halve cirkel volstaat
    for (const head of boundary) if (head.arc > 180 - CORNER_DEVIATION && head.arc < 180 + CORNER_DEVIATION) head.arc = 180;

    const heads = boundary.map((head) => makeRadial(type, head.p, head.r || radius, head.start, head.arc, body));
    for (const head of inner) {
      if (near(boundary, head.p, 0.45 * minGap)) continue;
      // binnenkop dicht bij de rand: worpwijdte inkorten (stelschroef) om overspray te beperken
      const innerRadius = head.d < radius ? clamp(head.d, Math.max(typeInfo.rMin, 0.55 * radius), radius) : radius;
      heads.push(makeRadial(type, head.p, innerRadius, 0, 360, body));
    }
    heads.key = `${columns}x${rows}`;
    heads.spacing = radius;
    return heads;
  }

  /**
   * Indeling vanaf de rand, zoals een hovenier het doet: koppen op de hoeken, daartussen langs
   * de rand op gelijke afstanden (ook langs schuine en bolle randen, los van het raster) en
   * binnenin een raster op minstens ruim een halve afstand van de rand.
   * @param {Array<{x: number, y: number}>} shape De plaatsingsvorm.
   * @param {string} type Sproeiertype.
   * @param {number} spacing Kopafstand in meter.
   * @param {number} angle Richting van het raster binnenin, in graden.
   * @param {string} pattern 'square' of 'triangle'.
   * @param {string|null} [body] Gekozen behuizing.
   * @returns {object[]} Sproeiers, met `key` en `spacing` als eigenschap.
   */
  function layoutPerimeter(shape, type, spacing, angle, pattern, body = null) {
    const typeInfo = Catalog.sprinklerTypes[type];
    const radius = clamp(spacing, typeInfo.rMin, typeInfo.rMax);
    const count = shape.length;
    const vertices = cornersOf(shape);
    const heads = [];
    for (const vertex of vertices) {
      if (!vertex.corner) continue;
      const longEdge = Math.max(Geo.dist(vertex.p, shape[(vertex.i + 1) % count]), Geo.dist(vertex.p, shape[(vertex.i - 1 + count) % count]));
      const cornerRadius = vertex.interior < 180 ? clamp(longEdge, Math.max(typeInfo.rMin, 0.75 * radius), radius) : radius;
      heads.push(makeRadial(type, vertex.p, cornerRadius, vertex.start, vertex.interior, body));
    }
    // ketens van rand tussen twee hoeken (zonder hoeken: de hele omtrek)
    let chainStarts = vertices.filter((vertex) => vertex.corner).map((vertex) => vertex.i);
    if (!chainStarts.length) chainStarts = [0];
    for (let chainIndex = 0; chainIndex < chainStarts.length; chainIndex++) {
      const from = chainStarts[chainIndex], to = chainStarts[(chainIndex + 1) % chainStarts.length];
      const chain = [];
      let index = from;
      do { chain.push(shape[index]); index = (index + 1) % count; } while (index !== to);
      chain.push(shape[to]);
      const segments = [];
      let chainLength = 0;
      for (let step = 1; step < chain.length; step++) { const length = Geo.dist(chain[step - 1], chain[step]); segments.push(length); chainLength += length; }
      const parts = Math.ceil(chainLength / radius - 1e-6);
      for (let part = 1; part < parts; part++) {
        let position = (chainLength * part) / parts, segment = 0;
        while (segment < segments.length - 1 && position > segments[segment]) { position -= segments[segment]; segment++; }
        const segmentStart = chain[segment], segmentEnd = chain[segment + 1];
        const point = Geo.add(segmentStart, Geo.mul(Geo.sub(segmentEnd, segmentStart), segments[segment] ? position / segments[segment] : 0));
        heads.push(makeRadial(type, point, radius, Geo.angleOf(Geo.sub(segmentEnd, segmentStart)), 180, body));
      }
    }
    // binnenin: raster in de hoofdrichting
    const radians = Geo.rad(angle);
    const along = { x: Math.cos(radians), y: Math.sin(radians) }, across = { x: -along.y, y: along.x };
    const alongPos = shape.map((point) => Geo.dot(point, along)), acrossPos = shape.map((point) => Geo.dot(point, across));
    const alongMin = Math.min(...alongPos), alongMax = Math.max(...alongPos);
    const acrossMin = Math.min(...acrossPos), acrossMax = Math.max(...acrossPos);
    const triangle = pattern === 'triangle';
    const columns = Math.max(1, Math.round((alongMax - alongMin) / radius)), columnStep = (alongMax - alongMin) / columns;
    const rowStep = triangle ? radius * Math.sqrt(3) / 2 : radius;
    const rows = Math.max(1, Math.round((acrossMax - acrossMin) / rowStep)), rowGap = (acrossMax - acrossMin) / rows;
    for (let j = 1; j < rows; j++) {
      const shift = triangle && j % 2 ? columnStep / 2 : 0;
      for (let i = shift ? 0 : 1; i < columns; i++) {
        const point = Geo.add(Geo.mul(along, alongMin + i * columnStep + shift), Geo.mul(across, acrossMin + j * rowGap));
        if (!Geo.pointInPolygon(point, shape)) continue;
        const toEdge = Geo.closestOnPolygon(point, shape).d;
        if (toEdge < 0.6 * radius || heads.some((head) => Geo.dist(head, point) < 0.6 * radius)) continue;
        heads.push(makeRadial(type, point, radius, 0, 360, body));
      }
    }
    heads.key = `rand-${round1(radius)}-${pattern}-${Math.round(angle)}`;
    heads.spacing = radius;
    return heads;
  }

  // ------------------------------------------------------------ beoordelen

  /**
   * Neerslagfunctie van één kop, vooraf uitgerekend (zelfde profiel als Simulation.precipAt).
   * @param {object} sprinkler De kop.
   * @returns {{x: number, y: number, reach: number, f: Function}|null} Plek, bereik en de
   *   functie punt → neerslag (mm/u), of null bij een onbekend type.
   */
  function headFn(sprinkler) {
    const typeInfo = Catalog.sprinklerTypes[sprinkler.type];
    if (!typeInfo) return null;
    if (sprinkler.type === 'strip' || !window.Simulation) {
      const reach = sprinkler.type === 'strip' ? Math.hypot(sprinkler.len / 2, sprinkler.width) : sprinkler.r;
      /**
       * Neerslag van deze kop op een punt via de volledige simulatie.
       * @param {{x: number, y: number}} point Punt in meters.
       * @returns {number} Neerslag in mm/u.
       */
      const simulated = (point) => (window.Simulation ? window.Simulation.precipAt(sprinkler, point) : 0);
      return { x: sprinkler.x, y: sprinkler.y, reach, f: simulated };
    }
    const radius = sprinkler.r, radiusSquared = radius * radius, peak = (3 * Catalog.headPr(sprinkler)) / Math.PI;
    const full = sprinkler.arc >= 359.9;
    // sector zonder hoekfuncties: punt ligt links/rechts van de begin- en eindstraal
    const startRadians = Geo.rad(sprinkler.start), endRadians = Geo.rad(sprinkler.start + sprinkler.arc);
    const startX = Math.cos(startRadians), startY = Math.sin(startRadians);
    const endX = Math.cos(endRadians), endY = Math.sin(endRadians);
    const wide = sprinkler.arc > 180;
    /**
     * Neerslag van deze kop op een punt (driehoeksprofiel).
     * @param {{x: number, y: number}} point Het punt.
     * @returns {number} Neerslag in mm/u.
     */
    const precipitation = (point) => {
      const dx = point.x - sprinkler.x, dy = point.y - sprinkler.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radiusSquared) return 0;
      if (!full && distanceSquared > 1e-12) {
        const afterStart = startX * dy - startY * dx >= 0;
        const beforeEnd = endX * dy - endY * dx <= 0;
        if (wide ? !(afterStart || beforeEnd) : !(afterStart && beforeEnd)) return 0;
      }
      return peak * (1 - Math.sqrt(distanceSquared) / radius);
    };
    return { x: sprinkler.x, y: sprinkler.y, reach: radius, f: precipitation };
  }

  /**
   * Meetpunten binnen het vlak en in een band eromheen (vast per vlak, zodat varianten snel te
   * vergelijken zijn).
   * @param {Array<{x: number, y: number}>} points Omtrek van het vlak (met de klok mee).
   * @param {number} reach Breedte van de band buiten het vlak (grootste worp).
   * @param {{dry?: Array, wet?: Array}|null} [surroundings] Vlakken rondom: water op wat droog
   *   moet blijven (huis, terras) telt zwaarder, op wat nat mag worden lichter.
   * @returns {object} Het meetraster: punten binnen (`inside`) en buiten (`outside`) met
   *   gewicht, rasterindex `cellIdx`, de rand zonder kartels (`edge`) en de hoeken daarvan.
   */
  function evaluator(points, reach, surroundings = null) {
    const dryPolygons = ((surroundings && surroundings.dry) || []).filter((polygon) => polygon && polygon.length >= 3);
    const wetPolygons = ((surroundings && surroundings.wet) || []).filter((polygon) => polygon && polygon.length >= 3);
    const area = Geo.area(points);
    const bounds = Geo.bbox(points);
    // Vaste grens op het aantal rastercellen (geheugen en rekentijd): bij een
    // heel groot of lang uitgerekt vlak worden de cellen groter.
    const spanX = bounds.w + 2 * reach, spanY = bounds.h + 2 * reach;
    const cell = Math.max(clamp(Math.sqrt(area) / 30, 0.2, 0.6), Math.sqrt((spanX * spanY) / MAX_GRID_CELLS));
    // raster iets verschoven, zodat er geen meetpunten precies op een rechte rand liggen
    const x0 = bounds.minX - reach + 0.37 * cell, y0 = bounds.minY - reach + 0.41 * cell;
    const nx = Math.ceil((bounds.w + 2 * reach) / cell) + 1, ny = Math.ceil((bounds.h + 2 * reach) / cell) + 1;
    // per rastercel: index in inside (>= 0), in outside (-2 - index) of -1 (niet meetellen)
    const cellIdx = new Int32Array(nx * ny).fill(-1);
    const inside = [], outside = [], outWeight = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const point = { x: x0 + i * cell, y: y0 + j * cell };
        if (Geo.pointInPolygon(point, points)) { cellIdx[j * nx + i] = inside.length; inside.push(point); }
        // buiten het vlak: alles in de band telt (verder dan de worp komt geen kop)
        else {
          cellIdx[j * nx + i] = -2 - outside.length;
          outside.push(point);
          const onDry = dryPolygons.some((polygon) => Geo.pointInPolygon(point, polygon));
          const onWet = !onDry && wetPolygons.some((polygon) => Geo.pointInPolygon(point, polygon));
          outWeight.push(onDry ? WEIGHTS.dryOut : onWet ? WEIGHTS.wetOut : 1);
        }
      }
    }
    // rand voor verschuiven langs de rand: zonder kartels (rekent veel sneller)
    const simple = Geo.orientCW(Geo.simplifyClosed(points, 0.1));
    const edge = simple.length >= 3 ? simple : points;
    return { pts: points, edge, corners: cornersOf(edge), area, cell, inside, outside, outWeight: Float64Array.from(outWeight), x0, y0, nx, ny, cellIdx };
  }

  // bijdrage per kop aan de meetpunten, onthouden zolang kop en meetpunten gelijk blijven
  const cellCache = new WeakMap();

  /**
   * Meetpunten die een kop raakt, met de neerslag erop (onthouden per kop).
   * @param {object} grid Meetraster (evaluator).
   * @param {object} head De kop.
   * @returns {{codes: Int32Array, vals: Float64Array}} Rastercodes (zoals `grid.cellIdx`) en neerslag.
   */
  function headCells(grid, head) {
    const hit = cellCache.get(head);
    if (hit && hit.grid === grid && hit.r === head.r && hit.arc === head.arc && hit.start === head.start
      && hit.x === head.x && hit.y === head.y && hit.model === head.model && hit.body === head.body) return hit;
    const precipitation = headFn(head);
    const codes = [], values = [];
    if (precipitation) {
      const i0 = Math.max(0, Math.floor((precipitation.x - precipitation.reach - grid.x0) / grid.cell));
      const i1 = Math.min(grid.nx - 1, Math.ceil((precipitation.x + precipitation.reach - grid.x0) / grid.cell));
      const j0 = Math.max(0, Math.floor((precipitation.y - precipitation.reach - grid.y0) / grid.cell));
      const j1 = Math.min(grid.ny - 1, Math.ceil((precipitation.y + precipitation.reach - grid.y0) / grid.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const code = grid.cellIdx[j * grid.nx + i];
          if (code === -1) continue;
          const value = precipitation.f(code >= 0 ? grid.inside[code] : grid.outside[-2 - code]);
          if (value > 0) { codes.push(code); values.push(value); }
        }
      }
    }
    const entry = {
      grid, r: head.r, arc: head.arc, start: head.start, x: head.x, y: head.y, model: head.model, body: head.body,
      codes: Int32Array.from(codes), vals: Float64Array.from(values),
    };
    cellCache.set(head, entry);
    return entry;
  }

  /**
   * Telt de bijdrage van één kop op (sign = 1) of trekt hem af (sign = -1) bij de meetpunten.
   * @param {object} grid Meetraster (evaluator).
   * @param {object} totals Opgetelde neerslag (accumulate).
   * @param {object} head De kop.
   * @param {number} sign 1 of -1.
   * @returns {void}
   */
  function apply(grid, totals, head, sign) {
    const { codes, vals } = headCells(grid, head);
    for (let cellIndex = 0; cellIndex < codes.length; cellIndex++) {
      const code = codes[cellIndex];
      if (code >= 0) totals.vals[code] += sign * vals[cellIndex];
      else {
        const outsideIndex = -2 - code;
        const changed = sign > 0 ? totals.wet[outsideIndex]++ === 0 : --totals.wet[outsideIndex] === 0;
        if (changed) { totals.wetCount += sign; totals.wetWeight += sign * grid.outWeight[outsideIndex]; }
      }
    }
  }

  /**
   * Telt de neerslag van alle koppen op.
   * @param {object} grid Meetraster (evaluator).
   * @param {object[]} heads De koppen.
   * @returns {{vals: Float64Array, wet: Int16Array, wetCount: number, wetWeight: number}}
   *   Neerslag per meetpunt binnen, aantal koppen per punt buiten, natte punten buiten (en gewogen).
   */
  function accumulate(grid, heads) {
    const totals = { vals: new Float64Array(grid.inside.length), wet: new Int16Array(grid.outside.length), wetCount: 0, wetWeight: 0 };
    for (const head of heads) apply(grid, totals, head, 1);
    return totals;
  }

  let scratch = new Float64Array(0);

  /**
   * Som van de `count` kleinste waarden (quickselect op een kopie, gemiddeld lineair).
   * @param {Float64Array} values De waarden.
   * @param {number} count Aantal kleinste waarden.
   * @returns {number} Hun som.
   */
  function sumSmallest(values, count) {
    const total = values.length;
    if (scratch.length < total) scratch = new Float64Array(total);
    const work = scratch;
    work.set(values);
    let low = 0, high = total - 1;
    const target = count - 1;
    while (low < high) {
      const pivot = work[(low + high) >> 1];
      let i = low, j = high;
      while (i <= j) {
        while (work[i] < pivot) i++;
        while (work[j] > pivot) j--;
        if (i <= j) { const swap = work[i]; work[i] = work[j]; work[j] = swap; i++; j--; }
      }
      if (target <= j) high = j;
      else if (target >= i) low = i;
      else break;
    }
    let sum = 0;
    for (let i = 0; i < count; i++) sum += work[i];
    return sum;
  }

  /**
   * Kosten van een indeling: aantal koppen, water buiten het vlak, ongelijkmatigheid en
   * gele, blauwe en droge plekken.
   * @param {object} grid Meetraster (evaluator).
   * @param {object} totals Opgetelde neerslag (accumulate).
   * @param {number} count Aantal koppen.
   * @returns {{cost: number, outsideM2: number, du: number, dryPct: number, lowPct: number, offPct: number, highPct: number}}
   *   Kosten en de onderdelen ervan.
   */
  function costOf(grid, totals, count) {
    const values = totals.vals, total = values.length;
    let sum = 0;
    for (let i = 0; i < total; i++) sum += values[i];
    const mean = sum / total;
    let dry = 0, low = 0, under = 0, over = 0;
    const greenLow = WEIGHTS.green[0] * mean, greenHigh = WEIGHTS.green[1] * mean;
    for (let i = 0; i < total; i++) {
      const value = values[i];
      if (value < WEIGHTS.lowRatio * mean) { low++; if (value < 0.3 * mean) dry++; }
      if (value < greenLow) under++;
      else if (value > greenHigh) over++;
    }
    // niet groen op de neerslagkaart: te weinig weegt zwaarder dan te veel (dat wordt geen bruine plek)
    const offPct = (under / total) * 100, highPct = (over / total) * 100;
    const quarter = Math.max(1, Math.floor(total / 4));
    const du = mean > 0 ? sumSmallest(values, quarter) / quarter / mean : 0;
    const dryPct = (dry / total) * 100;
    // geel op de neerslagkaart: duidelijk minder dan gemiddeld
    const lowPct = (low / total) * 100;
    const outsideM2 = totals.wetCount * grid.cell * grid.cell;
    const outsideCost = totals.wetWeight * grid.cell * grid.cell;
    const cost = WEIGHTS.head * count + (outsideCost / Math.max(grid.area, 1)) * WEIGHTS.outside
      + Math.max(0, WEIGHTS.duTarget - du) * WEIGHTS.du + dryPct * WEIGHTS.dry + lowPct * WEIGHTS.low
      + offPct * WEIGHTS.off + highPct * WEIGHTS.offHigh;
    return { cost, outsideM2, du, dryPct, lowPct, offPct, highPct };
  }

  /**
   * Kosten van een lijst koppen (zie costOf).
   * @param {object} grid Meetraster (evaluator).
   * @param {object[]} heads De koppen.
   * @returns {object} Beoordeling; kosten oneindig zonder koppen of meetpunten.
   */
  function score(grid, heads) {
    if (!heads.length || !grid.inside.length) return { cost: Infinity };
    return costOf(grid, accumulate(grid, heads), heads.length);
  }

  /**
   * Varianten van één kop om te proberen: worp korter/langer, sproeihoek kleiner/groter,
   * richting draaien, en met een meetraster ook verschuiven en de sector uit de echte rand.
   * @param {object} head De kop.
   * @param {object|null} [grid] Meetraster; alleen dan wordt er ook verschoven.
   * @returns {object[]} Varianten (passend gemaakt op de nozzle), zonder de kop zelf.
   */
  function variantsOf(head, grid = null) {
    const range = Catalog.headRange ? Catalog.headRange(head) : Catalog.sprinklerTypes[head.type];
    const variants = [];
    for (const factor of [0.9, 0.8, 0.7, 0.6, 1.1, 1.2]) {
      const radius = round1(clamp(head.r * factor, range.rMin, range.rMax));
      if (radius !== head.r) variants.push({ ...head, r: radius });
    }
    if (head.arc < 359.9) {
      for (const arcStep of [-20, -10, 10, 20]) variants.push({ ...head, arc: head.arc + arcStep });
      for (const turn of [-10, -5, 5, 10]) variants.push({ ...head, start: Math.round(Geo.normDeg(head.start + turn)) });
      // beide randen iets naar binnen (hoek kleiner, midden gelijk)
      variants.push({ ...head, start: Math.round(Geo.normDeg(head.start + 5)), arc: head.arc - 10 });
    }
    // verschuiven (alleen bij automatisch plaatsen): binnenkop een stukje, randkop langs de rand
    if (grid) {
      // sproeihoek en richting opnieuw uit de echte rand op deze plek (na de grove vorm kan een
      // kop op een trapje van het terras staan en dan over het terras spuiten)
      if (head.arc < 359.9) {
        const vertex = grid.corners.find((corner) => Geo.dist(corner.p, head) < 0.15);
        if (vertex) {
          for (const [turn, arcStep] of [[0, 0], [0, -15], [15, -15]]) {
            variants.push({ ...head, start: Math.round(Geo.normDeg(vertex.start + turn)), arc: Math.round(vertex.interior + arcStep) });
          }
        } else {
          const closest = Geo.closestOnPolygon(head, grid.edge);
          if (closest.d < 0.15) {
            const edgeStart = grid.edge[closest.edge], edgeEnd = grid.edge[(closest.edge + 1) % grid.edge.length];
            variants.push({ ...head, start: Math.round(Geo.normDeg(Geo.angleOf(Geo.sub(edgeEnd, edgeStart)))), arc: 180 });
          }
        }
      }
      const step = Math.max(0.3, 0.1 * head.r);
      if (head.arc >= 359.9) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const point = { x: head.x + dx * step, y: head.y + dy * step };
          if (Geo.pointInPolygon(point, grid.pts)) variants.push({ ...head, x: point.x, y: point.y });
        }
      } else if (Math.abs(head.arc - 180) < 1) {
        const radians = Geo.rad(head.start);
        for (const distance of [-2 * step, -step, step, 2 * step]) {
          const closest = Geo.closestOnPolygon({ x: head.x + Math.cos(radians) * distance, y: head.y + Math.sin(radians) * distance }, grid.edge);
          const edgeStart = grid.edge[closest.edge], edgeEnd = grid.edge[(closest.edge + 1) % grid.edge.length];
          variants.push({ ...head, x: closest.pt.x, y: closest.pt.y, start: Math.round(Geo.normDeg(Geo.angleOf(Geo.sub(edgeEnd, edgeStart)))) });
        }
      }
    }
    return variants.map((variant) => Catalog.fitRotator(variant))
      .filter((variant) => variant.r !== head.r || variant.arc !== head.arc || variant.start !== head.start || variant.x !== head.x || variant.y !== head.y);
  }

  /**
   * Afstellen: per kop worp (stelschroef), sproeihoek en richting (en eventueel plek) zo kiezen
   * dat er minder water buiten het vlak valt en de verdeling gelijkmatiger wordt.
   * Hebzuchtig: per kop de beste verbetering, rondes tot er niets meer te winnen is.
   * @param {object} grid Meetraster (evaluator).
   * @param {object[]} heads De koppen (worden vervangen door betere varianten).
   * @param {object} current Huidige beoordeling.
   * @param {number} [rounds] Hoogstens zoveel rondes.
   * @param {Set<string>|null} [onlyIds] Alleen deze koppen afstellen.
   * @param {boolean} [move] Koppen ook verschuiven.
   * @returns {object} De nieuwe beoordeling.
   */
  function refine(grid, heads, current, rounds = 3, onlyIds = null, move = false) {
    let best = current;
    if (!grid.inside.length) return best;
    const totals = accumulate(grid, heads);
    for (let round = 0; round < rounds; round++) {
      let improved = false;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].type === 'strip' || (onlyIds && !onlyIds.has(heads[i].id))) continue;
        let picked = null;
        apply(grid, totals, heads[i], -1);
        for (const candidate of variantsOf(heads[i], move ? grid : null)) {
          apply(grid, totals, candidate, 1);
          const result = costOf(grid, totals, heads.length);
          apply(grid, totals, candidate, -1);
          if (result.cost < (picked ? picked.result.cost : best.cost) - 1e-6) picked = { candidate, result };
        }
        if (picked) { heads[i] = picked.candidate; best = picked.result; improved = true; }
        apply(grid, totals, heads[i], 1);
      }
      if (!improved) break;
    }
    return best;
  }

  /**
   * Gele en droge plekken bijwerken: bij de droogste plek een kop erbij (op de rand een halve
   * cirkel langs de rand, binnenin een volle), afgesteld, en alleen houden als het beter wordt.
   * @param {object} grid Meetraster (evaluator).
   * @param {object[]} heads De koppen (krijgen er mogelijk bij).
   * @param {object} current Huidige beoordeling.
   * @param {string} type Sproeiertype.
   * @param {number} spacing Kopafstand van de indeling.
   * @param {string|null} body Gekozen behuizing.
   * @param {number} [tries] Zoveel droge plekken proberen.
   * @returns {object} De nieuwe beoordeling.
   */
  function fill(grid, heads, current, type, spacing, body, tries = 4) {
    let best = current;
    if (!grid.inside.length || type === 'strip') return best;
    const typeInfo = Catalog.sprinklerTypes[type];
    const tried = [];
    for (let attempt = 0; attempt < tries; attempt++) {
      const totals = accumulate(grid, heads);
      let mean = 0;
      for (const value of totals.vals) mean += value;
      mean /= totals.vals.length;
      let driest = -1;
      for (let i = 0; i < totals.vals.length; i++) {
        if (totals.vals[i] >= WEIGHTS.lowRatio * mean) continue;
        if (tried.some((point) => Geo.dist(point, grid.inside[i]) < 0.5 * spacing)) continue;
        if (driest < 0 || totals.vals[i] < totals.vals[driest]) driest = i;
      }
      if (driest < 0) break;
      const point = grid.inside[driest];
      tried.push(point);
      const closest = Geo.closestOnPolygon(point, grid.edge);
      let candidate;
      if (closest.d < 0.35 * spacing) {
        const edgeStart = grid.edge[closest.edge], edgeEnd = grid.edge[(closest.edge + 1) % grid.edge.length];
        candidate = makeRadial(type, closest.pt, spacing, Geo.angleOf(Geo.sub(edgeEnd, edgeStart)), 180, body);
      } else candidate = makeRadial(type, point, clamp(closest.d + 0.5 * spacing, typeInfo.rMin, spacing), 0, 360, body);
      const list = heads.concat([candidate]);
      let result = costOf(grid, accumulate(grid, list), list.length);
      result = refine(grid, list, result, 2, new Set([candidate.id]), true);
      if (result.cost < best.cost - 1e-6) { heads.splice(0, heads.length, ...list); best = result; }
    }
    return best;
  }

  /**
   * Overbodige koppen weghalen: steeds de kop zonder welke de indeling het meest verbetert
   * (kluitjes langs de rand, dubbele hoekkoppen), tot weghalen niets meer oplevert.
   * @param {object} grid Meetraster (evaluator).
   * @param {object[]} heads De koppen (worden mogelijk minder).
   * @param {object} current Huidige beoordeling.
   * @returns {object} De nieuwe beoordeling.
   */
  function prune(grid, heads, current) {
    let best = current;
    if (!grid.inside.length) return best;
    const totals = accumulate(grid, heads);
    for (;;) {
      let picked = -1, pickedResult = null;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].type === 'strip') continue;
        apply(grid, totals, heads[i], -1);
        const result = costOf(grid, totals, heads.length - 1);
        apply(grid, totals, heads[i], 1);
        if (result.cost < (pickedResult ? pickedResult.cost : best.cost) - 1e-6) { picked = i; pickedResult = result; }
      }
      if (picked < 0 || heads.length <= 1) break;
      apply(grid, totals, heads[picked], -1);
      heads.splice(picked, 1);
      best = pickedResult;
    }
    return best;
  }

  /**
   * Stelt bestaande koppen in een vlak optimaal af (positie blijft gelijk).
   * @param {Array<{x: number, y: number}>} rawPoints Omtrek van het vlak.
   * @param {object[]} heads De koppen.
   * @param {string[]|null} [onlyIds] Alleen deze koppen afstellen (de rest blijft staan), of null voor alle.
   * @param {{dry?: Array, wet?: Array}|null} [surroundings] Vlakken rondom (zie evaluator).
   * @returns {{heads: object[], before: object|null, after: object|null}} Nieuwe objecten (zelfde
   *   id's), plus de beoordeling voor en na.
   */
  function tune(rawPoints, heads, onlyIds = null, surroundings = null) {
    const points = Geo.orientCW(rawPoints);
    const list = heads.map((head) => Catalog.fitRotator({ ...head }));
    if (!list.length || points.length < 3) return { heads: list, before: null, after: null };
    const reach = Math.max(0.5, ...list.map((head) => (head.type === 'strip' ? Math.hypot(head.len / 2, head.width) : head.r * 1.1)));
    const grid = evaluator(points, reach, surroundings);
    const before = score(grid, list);
    const after = refine(grid, list, before, 3, onlyIds ? new Set(onlyIds) : null);
    return { heads: list, before, after };
  }

  /**
   * Kosten van een indeling (los aan te roepen).
   * @param {Array<{x: number, y: number}>} points Omtrek van het vlak.
   * @param {object[]} heads De koppen.
   * @returns {object} Beoordeling (zie costOf).
   */
  function evaluate(points, heads) {
    const reach = Math.max(0.5, ...heads.map((head) => (head.type === 'strip' ? Math.hypot(head.len / 2, head.width) : head.r)));
    return score(evaluator(Geo.orientCW(points), reach), heads);
  }

  /**
   * Haalt een kop van dit type deze worpwijdte (rotators: alleen afstanden die een kop uit de
   * bibliotheek haalt)?
   * @param {string} type Sproeiertype.
   * @param {number} radius Worp in meter.
   * @returns {boolean} Waar als het kan.
   */
  function feasible(type, radius) {
    const typeInfo = Catalog.sprinklerTypes[type];
    if (radius < typeInfo.rMin - 1e-9 || radius > typeInfo.rMax + 1e-9) return false;
    if (type === 'rotator' && Catalog.rotatorModels) {
      const models = Object.values(Catalog.rotatorModelsAvailable ? Catalog.rotatorModelsAvailable() : Catalog.rotatorModels);
      return models.some((model) => radius >= model.rMin - 1e-9 && radius <= model.rMax + 1e-9);
    }
    return true;
  }

  /**
   * Afstanden om te proberen, per richting: de lengte in gelijke stukken verdeeld, van zo groot
   * mogelijk (volle worp) tot een paar stappen kleiner. Meer koppen dan dat wint nooit.
   * @param {string} type Sproeiertype.
   * @param {number} length Lengte in deze richting, in meter.
   * @returns {number[]} Afstanden in meter.
   */
  function spacingsAlong(type, length) {
    const typeInfo = Catalog.sprinklerTypes[type];
    const spacings = new Set();
    /**
     * Rotatorkoppen die de planner mag kiezen.
     * @returns {object[]} De koppen.
     */
    const models = () => Object.values(Catalog.rotatorModelsAvailable ? Catalog.rotatorModelsAvailable() : Catalog.rotatorModels);
    // tot 20% verder dan de worp: tussen twee rijen randkoppen valt dan nog genoeg (bijv. 12 m breed met 10 m worp)
    const fewest = Math.max(1, Math.ceil(length / (1.2 * typeInfo.rMax) - 1e-6));
    for (let parts = fewest; parts <= Math.ceil(length / typeInfo.rMin) && parts <= 12 && parts <= fewest + 4; parts++) {
      const radius = round1(length / parts);
      if (feasible(type, radius) || (radius > typeInfo.rMax && feasible(type, typeInfo.rMax))) spacings.add(radius);
      else if (type === 'rotator' && Catalog.rotatorModels) {
        // valt in een gat tussen twee koppen: de grootste kop die er net onder blijft
        const below = models().map((model) => model.rMax).filter((maxRadius) => maxRadius < radius).sort((left, right) => right - left)[0];
        if (below) spacings.add(round1(below));
      }
    }
    if (!spacings.size) spacings.add(round1(clamp(length, typeInfo.rMin, typeInfo.rMax)));
    return [...spacings];
  }

  /**
   * Plaatst sproeiers in een polygoon.
   * @param {Array<{x: number, y: number}>} rawPoints Omtrek van het vlak.
   * @param {string} type Sproeiertype: spray, rotator of rotor (strip: strooksproeiers).
   * @param {object} [options] {r: vaste worpwijdte, body: behuizing, dry/wet: polygonen rondom
   *   (huis/terras, mag nat)}.
   * @returns {object[]} De sproeiers.
   */
  function autoPlace(rawPoints, type, options = {}) {
    if (!rawPoints || rawPoints.length < 3) return [];
    const points = Geo.orientCW(rawPoints);
    const typeInfo = Catalog.sprinklerTypes[type];
    if (type === 'strip') return placeStrips(points, Geo.minWidthRect(points));
    const shape = placementShape(points);
    const rect = Geo.minWidthRect(shape);
    if (type !== 'rotor' && rect.width < NARROW_WIDTH && !options.r) return placeStrips(points, rect);

    const angles = [Geo.dominantAngle([shape])];
    const rectAngle = Geo.normDeg(Geo.angleOf(rect.u)) % 90;
    if (Math.abs(rectAngle - angles[0]) > 2 && Math.abs(rectAngle - angles[0]) < 88) angles.push(rectAngle);
    const fixed = options.r ? clamp(options.r, typeInfo.rMin, typeInfo.rMax) : null;
    const grid = evaluator(points, fixed || typeInfo.rMax, options);
    const body = options.body || null;
    const candidates = [];
    // per afstand de grove vorm (trapjes weg) en, als die afwijkt, ook de vorm zelf: bij een
    // terras langs het gazon kan een kop op elk trapje beter zijn dan water op het terras
    const shapeCache = new Map();
    /**
     * Vormen om op te plaatsen bij deze afstand.
     * @param {number} spacing Kopafstand (afgerond).
     * @returns {Array<[string, Array]>} Paren [soort, vorm].
     */
    const shapesFor = (spacing) => {
      if (!shapeCache.has(spacing)) {
        const coarse = coarseShape(shape, spacing);
        shapeCache.set(spacing, coarse === shape ? [['', shape]] : [['grof', coarse], ['', shape]]);
      }
      return shapeCache.get(spacing);
    };
    for (const angle of angles) {
      const radians = Geo.rad(angle);
      const along = { x: Math.cos(radians), y: Math.sin(radians) }, across = { x: -along.y, y: along.x };
      const alongPos = shape.map((point) => Geo.dot(point, along)), acrossPos = shape.map((point) => Geo.dot(point, across));
      const lengthAlong = Math.max(...alongPos) - Math.min(...alongPos), lengthAcross = Math.max(...acrossPos) - Math.min(...acrossPos);
      const spacingsU = fixed ? [fixed] : spacingsAlong(type, lengthAlong);
      const spacingsV = fixed ? [fixed] : spacingsAlong(type, lengthAcross);
      for (const pattern of ['square', 'triangle']) {
        const seen = new Set();
        for (const spacingU of spacingsU) {
          for (const spacingV of spacingsV) {
            // rechthoekig verband mag, maar niet extreem langgerekt (dan valt er midden tussen te weinig)
            if (Math.max(spacingU, spacingV) > 2 * Math.min(spacingU, spacingV)) continue;
            for (const [variant, form] of shapesFor(round1(Math.min(spacingU, spacingV)))) {
              const heads = layout(form, type, spacingU, angle, pattern, spacingV, body);
              if (seen.has(variant + heads.key)) continue;
              seen.add(variant + heads.key);
              candidates.push({ heads, score: score(grid, heads) });
            }
          }
        }
        // vanaf de rand, met de kleinste en de grootste afstand
        for (const spacing of new Set([Math.min(...spacingsU, ...spacingsV), Math.max(...spacingsU, ...spacingsV)])) {
          for (const [, form] of shapesFor(round1(spacing))) {
            const heads = layoutPerimeter(form, type, spacing, angle, pattern, body);
            if (heads.length) candidates.push({ heads, score: score(grid, heads) });
          }
        }
      }
    }
    if (!candidates.length) return [];
    // de beste paar indelingen eerst afstellen en dan pas kiezen: een ruim verband met grote
    // koppen wint vaak pas als randkoppen zijn ingekort. Eerst ruw afstellen, dan de beste twee
    // ook verschuiven en aanvullen, dan de winnaar fijn.
    candidates.sort((left, right) => left.score.cost - right.score.cost);
    const top = candidates.slice(0, 6);
    for (const candidate of top) candidate.score = refine(grid, candidate.heads, prune(grid, candidate.heads, candidate.score), 2);
    top.sort((left, right) => left.score.cost - right.score.cost);
    let best = null;
    for (const candidate of top.slice(0, 2)) {
      candidate.score = refine(grid, candidate.heads, candidate.score, 3, null, true);
      candidate.score = fill(grid, candidate.heads, candidate.score, type, candidate.heads.spacing, body);
      if (!best || candidate.score.cost < best.score.cost) best = candidate;
    }
    best.score = refine(grid, best.heads, prune(grid, best.heads, best.score), 6, null, true);
    return best.heads;
  }

  /**
   * Kiest per gazon het beste sproeiertype: elk bruikbaar type wordt geplaatst en afgesteld en
   * de indelingen worden met dezelfde maatstaf vergeleken (aantal koppen, water buiten het
   * vlak, niet-groene en droge plekken, gelijkmatigheid). Types die bij de beschikbare druk
   * niet werken, doen niet mee (tenzij er dan niets overblijft).
   * @param {Array<{x: number, y: number}>} rawPoints Omtrek van het gazon.
   * @param {object} [options] {types: kandidaten, bodies: {type: behuizing}, pressure: bar,
   *   dry/wet: polygonen rondom}.
   * @returns {{type: string|null, heads: object[], score: object|null, results: Array<{type: string, count: number, score: object}>}}
   *   Het gekozen type met zijn koppen, en de beoordeling per type.
   */
  function bestPlace(rawPoints, options = {}) {
    if (!rawPoints || rawPoints.length < 3) return { type: null, heads: [], score: null, results: [] };
    let types = (options.types || ['rotator', 'spray', 'rotor']).filter((type) => Catalog.sprinklerTypes[type]);
    if (options.pressure > 0) {
      const enoughPressure = types.filter((type) => Catalog.sprinklerTypes[type].minBar <= options.pressure - PRESSURE_MARGIN + 1e-9);
      if (enoughPressure.length) types = enoughPressure;
    }
    const placed = types.map((type) => ({
      type,
      heads: autoPlace(rawPoints, type, { body: (options.bodies || {})[type] || null, dry: options.dry, wet: options.wet }),
    }));
    const points = Geo.orientCW(rawPoints);
    const reach = Math.max(0.5, ...placed.flatMap((option) => option.heads.map((head) => (head.type === 'strip' ? Math.hypot(head.len / 2, head.width) : head.r))));
    const grid = evaluator(points, reach, options);
    let best = null;
    const results = placed.map((option) => {
      const result = score(grid, option.heads);
      if (option.heads.length && (!best || result.cost < best.score.cost)) best = { ...option, score: result };
      return { type: option.type, count: option.heads.length, score: result };
    });
    if (!best) return { type: null, heads: [], score: null, results };
    const type = best.heads.every((head) => head.type === 'strip') ? 'strip' : best.type;
    return { type, heads: best.heads, score: best.score, results };
  }

  /**
   * Plaatsing met een vaste worpwijdte.
   * @param {Array<{x: number, y: number}>} rawPoints Omtrek van het vlak.
   * @param {string} type Sproeiertype.
   * @param {number|null} radius Worp in meter, of leeg voor automatisch.
   * @returns {object[]} De sproeiers.
   */
  function placeWithRadius(rawPoints, type, radius) {
    return autoPlace(rawPoints, type, radius ? { r: radius } : {});
  }

  window.Planner = { autoPlace, bestPlace, placeWithRadius, evaluate, tune, autoRadius, placementShape, NARROW_WIDTH };
})();
