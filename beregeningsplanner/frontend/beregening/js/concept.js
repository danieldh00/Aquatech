/* Van herkend plan naar een bewerkbaar concept: schaal, vlakken, elementen, sproeiers, zones en leidingen. */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;

  const FALLBACK_WIDTH_M = 30; // aangenomen breedte van het plan als er geen schaal gevonden is
  const FALLBACK_GARDEN_M = 10; // aangenomen breedte van de herkende tuin (gangbare achtertuin)

  /**
   * Vraagt de backend om het plan te herkennen. Een eerder herkende tekening geeft de bewaarde uitkomst (recognition.cached); met `fresh` herkent de AI opnieuw.
   * @param {{dataUrl: string, width: number, height: number}} analyzeImage de analyse-afbeelding
   * @param {{fresh: boolean}} options `fresh` = opnieuw herkennen
   * @returns {Promise<object>} de herkenning (schaal, vlakken, elementen); gooit een fout als het mislukt
   */
  async function analyze(analyzeImage, { fresh = false } = {}) {
    let response;
    try {
      response = await fetch('api/plan/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: analyzeImage.dataUrl, width: analyzeImage.width, height: analyzeImage.height, fresh }),
      });
    } catch (error) {
      throw new Error('Geen verbinding met de server. Automatisch herkennen werkt alleen via de app, niet via een lokaal geopend bestand.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Herkennen mislukt (${response.status}).`);
    return body;
  }

  /**
   * Haalt op wat de organisatie geleerd heeft van eerder herkende plannen (voor de lokale herkenning).
   * @returns {Promise<object|null>} de tellingen, of null als er nog niets is
   */
  async function learned() {
    try {
      const response = await fetch('api/plan/learned', { cache: 'no-store' });
      if (!response.ok) return null;
      const body = await response.json();
      return body && body.examples > 0 ? body : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Stuurt de kleurtellingen van een herkend of goedgekeurd plan naar de server (geen afbeelding); fouten worden genegeerd.
   * @param {object} body de tellingen
   * @returns {Promise<void>}
   */
  async function teach(body) {
    try {
      await fetch('api/plan/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      /* leren is een bijzaak */
    }
  }

  /**
   * Vraagt of automatisch herkennen beschikbaar is.
   * @returns {Promise<{available: boolean}>} de stand van de herkenning
   */
  async function status() {
    try {
      const response = await fetch('api/plan/status', { cache: 'no-store' });
      if (!response.ok) return { available: false };
      return await response.json();
    } catch (error) {
      return { available: false };
    }
  }

  /**
   * Haalt dubbele punten weg en rondt af op millimeters.
   * @param {Array<{x: number, y: number}>} points de hoekpunten in meters
   * @returns {Array<{x: number, y: number}>} de opgeschoonde hoekpunten
   */
  function cleanPolygon(points) {
    const result = [];
    for (const point of points) {
      if (!result.length || Geo.dist(result[result.length - 1], point) > 0.05) result.push({ x: +point.x.toFixed(3), y: +point.y.toFixed(3) });
    }
    if (result.length > 2 && Geo.dist(result[0], result[result.length - 1]) < 0.05) result.pop();
    return result;
  }

  /**
   * Kiest plekken voor wateraansluiting, besturing en ventielkast als het plan ze niet aangeeft.
   * @param {object[]} areas de vlakken
   * @param {Array<{kind: string, x: number, y: number}>} given de herkende elementen
   * @returns {object[]} alle elementen, met id
   */
  function defaultElements(areas, given) {
    const lawns = areas.filter((area) => area.type === 'lawn');
    const dry = areas.filter((area) => area.type === 'dry');
    const elements = given.slice();
    /**
     * Zegt of er al een element van deze soort is.
     * @param {string} kind soort element
     * @returns {boolean} true als het er al is
     */
    const has = (kind) => elements.some((element) => element.kind === kind);
    const mainLawn = lawns.slice().sort((left, right) => Geo.area(right.pts) - Geo.area(left.pts))[0];
    const target = mainLawn ? Geo.centroid(mainLawn.pts) : null;

    if (!has('source') && target) {
      // gevel: dichtstbijzijnde punt op een droog vlak (woning/terras) richting het gazon
      let best = null;
      for (const dryArea of dry) {
        const closest = Geo.closestOnPolygon(target, dryArea.pts);
        if (!best || closest.d < best.d) best = closest;
      }
      const point = best ? best.pt : Geo.closestOnPolygon(target, mainLawn.pts).pt;
      elements.push({ kind: 'source', x: point.x, y: point.y });
    }
    const source = elements.find((element) => element.kind === 'source');
    if (source && !has('controller')) elements.push({ kind: 'controller', x: source.x + 0.6, y: source.y });
    if (source && !has('valvebox') && mainLawn) {
      // ventielkast net buiten het gazon, tussen aansluiting en gazon
      const edge = Geo.closestOnPolygon(source, mainLawn.pts).pt;
      const direction = Geo.norm(Geo.sub(source, edge));
      const point = Geo.dist(source, edge) > 1.2 ? Geo.add(edge, Geo.mul(direction, 0.6)) : Geo.add(source, Geo.mul(Geo.sub(edge, source), 0.5));
      elements.push({ kind: 'valvebox', x: point.x, y: point.y });
    }
    return elements.map((element) => ({ id: Geo.uid('e'), kind: element.kind, x: +element.x.toFixed(3), y: +element.y.toFixed(3) }));
  }

  // Maximale verschuiving van een rand bij het rechttrekken (meter).
  const SHIFT_MAX = 0.15;
  /**
   * Trekt herkende vlakken recht: pixelranden en kartels eruit, randen die bijna in de hoofdrichting van het plan lopen precies recht of haaks. Zo krijgt de sproeierplaatsing nette randen en hoeken in plaats van tientallen kleine knikken. Een rand schuift daarbij hooguit `SHIFT_MAX` op en bochten blijven gevolgd, zodat de vlakken ook ingezoomd op de tekening blijven liggen.
   * @param {object[]} areas de vlakken (worden aangepast)
   */
  function straighten(areas) {
    if (!areas.length) return;
    const simple = areas.map((area) => Geo.simplifyClosed(area.pts, Math.max(0.08, Math.min(0.15, 0.03 * Math.sqrt(Geo.area(area.pts))))));
    const angle = Geo.dominantAngle(simple);
    areas.forEach((area, i) => {
      const points = Geo.regularize(simple[i], angle, { tolDeg: 12, merge: 0.2, maxShift: SHIFT_MAX });
      if (points.length >= 3) area.pts = points.map((point) => ({ x: +point.x.toFixed(3), y: +point.y.toFixed(3) }));
    });
  }

  /**
   * Berekent de breedte in pixels van alle herkende vlakken samen (de getekende tuin).
   * @param {object[]} areas herkende vlakken met punten in pixels
   * @returns {number} de breedte, of 0
   */
  function gardenWidthPx(areas) {
    const xValues = [];
    for (const area of areas || []) if (Catalog.areaTypes[area.type]) for (const point of area.points || []) xValues.push(point.x);
    return xValues.length ? Math.max(...xValues) - Math.min(...xValues) : 0;
  }

  /**
   * Zet het analyse-resultaat om naar vlakken en elementen in meters. Schaal, in volgorde: maat met maatlijn (analyse) → schaal 1:N met bekend papierformaat (PDF) → door de gebruiker opgegeven tuinbreedte → aanname (tuin 10 m breed, of het hele plan 30 m).
   * @param {object} result antwoord van /api/plan/analyze (pixels van de analyse-afbeelding)
   * @param {{width: number, height: number, factor: number, paper: object}} analyzeImage de analyse-afbeelding (factor = analyse-px / ondergrond-px; paper = {widthM, ratio})
   * @param {{gardenWidthM: number}} opts eventueel de opgegeven tuinbreedte
   * @returns {{backgroundScale: number, areas: object[], elements: object[], scaleInfo: object, warnings: string[], gardenWidthPx: number}} het concept
   */
  function build(result, analyzeImage, opts = {}) {
    const warnings = [];
    const scale = { ...(result.scale || {}) };
    let mppAnalyze = scale.metersPerPixel;
    let estimated = false;
    const found = mppAnalyze > 0 && isFinite(mppAnalyze) && scale.method !== 'schatting';
    const paper = analyzeImage.paper || {};
    const ratio = paper.ratio || scale.ratio;
    const gardenWidth = gardenWidthPx(result.areas);
    if (!found && paper.widthM > 0 && ratio > 0) {
      mppAnalyze = (paper.widthM * ratio) / analyzeImage.width;
      Object.assign(scale, { metersPerPixel: mppAnalyze, method: `schaal 1:${ratio}`, confidence: 'hoog', evidence: `schaal 1:${ratio} op papierbreedte ${Math.round(paper.widthM * 1000)} mm` });
    } else if (!found && opts.gardenWidthM > 0 && gardenWidth > 0) {
      mppAnalyze = opts.gardenWidthM / gardenWidth;
      Object.assign(scale, { metersPerPixel: mppAnalyze, method: 'opgegeven tuinbreedte', confidence: 'middel', evidence: `tuin ${opts.gardenWidthM} m breed` });
      warnings.push(`Schaal afgeleid uit de opgegeven tuinbreedte (${opts.gardenWidthM} m). Controleer met "Schaal kalibreren" als er een bekende maat is.`);
    } else if (!(mppAnalyze > 0) || !isFinite(mppAnalyze)) {
      estimated = true;
      if (gardenWidth > 0) {
        mppAnalyze = FALLBACK_GARDEN_M / gardenWidth;
        warnings.push(`Geen leesbare maat met maatlijn gevonden${ratio ? ` (wel schaal 1:${ratio}, maar het papierformaat is bij een foto onbekend)` : ''}; aangenomen dat de tuin ${FALLBACK_GARDEN_M} m breed is. Kalibreer de schaal in stap 1 met een bekende maat.`);
      } else {
        mppAnalyze = FALLBACK_WIDTH_M / analyzeImage.width;
        warnings.push(`Geen leesbare maat met maatlijn gevonden; aangenomen dat het plan ${FALLBACK_WIDTH_M} m breed is. Kalibreer de schaal in stap 1 met een bekende maat.`);
      }
    } else if (scale.confidence === 'laag' || scale.method === 'schatting') {
      warnings.push(`Schaal onzeker (${scale.evidence || 'geen maat gevonden'}). Controleer met "Schaal kalibreren" in stap 1.`);
    } else if (scale.confidence === 'middel' && result.local && scale.method === 'maatvoering') {
      warnings.push(`Schaal bepaald uit één maat: ${scale.evidence}. Klopt de breedte van het plan (${(analyzeImage.width * mppAnalyze).toFixed(1).replace('.', ',')} m)? Zo niet: "Schaal kalibreren" in stap 1.`);
    }
    /**
     * Rekent een punt van analyse-pixels om naar meters.
     * @param {{x: number, y: number}} point het punt in pixels
     * @returns {{x: number, y: number}} het punt in meters
     */
    const toWorld = (point) => ({ x: point.x * mppAnalyze, y: point.y * mppAnalyze });
    const counters = {};
    const areas = [];
    for (const area of result.areas || []) {
      if (!Catalog.areaTypes[area.type]) continue;
      const points = cleanPolygon(area.points.map(toWorld));
      if (points.length < 3 || Geo.area(points) < 0.5) continue;
      counters[area.type] = (counters[area.type] || 0) + 1;
      areas.push({ id: Geo.uid('a'), type: area.type, name: area.name || `${Catalog.areaTypes[area.type].label} ${counters[area.type]}`, pts: points, zone: null });
    }
    if (result.local) straighten(areas);
    if (!areas.some((area) => area.type === 'lawn')) warnings.push('Geen gazon herkend. Teken het gazon of gebruik de toverstaf in stap 2.');
    const elements = defaultElements(areas, (result.elements || []).map((element) => ({ kind: element.kind, ...toWorld(element) })));
    if (result.notes) warnings.push(result.notes);
    return {
      // meters per pixel van de ondergrond = per analyse-pixel × (analyse-px per ondergrond-px)
      backgroundScale: mppAnalyze * analyzeImage.factor,
      areas,
      elements,
      scaleInfo: { ...scale, estimated },
      warnings,
      gardenWidthPx: gardenWidth,
    };
  }

  window.Concept = { analyze, learned, teach, status, build, defaultElements, straighten, FALLBACK_WIDTH_M, FALLBACK_GARDEN_M };
})();
