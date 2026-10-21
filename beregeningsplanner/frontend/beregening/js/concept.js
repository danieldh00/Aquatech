/* Van herkend plan naar een bewerkbaar concept: schaal, vlakken, elementen, sproeiers, zones en leidingen. */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  const FALLBACK_WIDTH_M = 30; // aangenomen breedte van het plan als er geen schaal gevonden is
  const FALLBACK_GARDEN_M = 10; // aangenomen breedte van de herkende tuin (gangbare achtertuin)

  /**
   * Vraagt de backend om het plan te herkennen. Een eerder herkende tekening geeft de bewaarde uitkomst
   * (recognition.cached); met `fresh` herkent de AI opnieuw.
   */
  async function analyze(analyzeImage, { fresh = false } = {}) {
    let res;
    try {
      res = await fetch('api/plan/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: analyzeImage.dataUrl, width: analyzeImage.width, height: analyzeImage.height, fresh }),
      });
    } catch (err) {
      throw new Error('Geen verbinding met de server. Automatisch herkennen werkt alleen via de app, niet via een lokaal geopend bestand.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `Herkennen mislukt (${res.status}).`);
    return body;
  }

  /** Wat de organisatie geleerd heeft van eerder herkende plannen (voor de lokale herkenning), of null. */
  async function learned() {
    try {
      const res = await fetch('api/plan/learned', { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      return body && body.examples > 0 ? body : null;
    } catch (err) {
      return null;
    }
  }

  /** Kleurtellingen van een herkend of goedgekeurd plan naar de server (geen afbeelding); fouten negeren. */
  async function teach(body) {
    try {
      await fetch('api/plan/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      /* leren is een bijzaak */
    }
  }

  async function status() {
    try {
      const res = await fetch('api/plan/status', { cache: 'no-store' });
      if (!res.ok) return { available: false };
      return await res.json();
    } catch (err) {
      return { available: false };
    }
  }

  function cleanPolygon(pts) {
    const out = [];
    for (const p of pts) {
      if (!out.length || G.dist(out[out.length - 1], p) > 0.05) out.push({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) });
    }
    if (out.length > 2 && G.dist(out[0], out[out.length - 1]) < 0.05) out.pop();
    return out;
  }

  /** Kiest plekken voor wateraansluiting, besturing en ventielkast als het plan ze niet aangeeft. */
  function defaultElements(areas, given) {
    const lawns = areas.filter((a) => a.type === 'lawn');
    const dry = areas.filter((a) => a.type === 'dry');
    const els = given.slice();
    const has = (k) => els.some((e) => e.kind === k);
    const mainLawn = lawns.slice().sort((a, b) => G.area(b.pts) - G.area(a.pts))[0];
    const target = mainLawn ? G.centroid(mainLawn.pts) : null;

    if (!has('source') && target) {
      // gevel: dichtstbijzijnde punt op een droog vlak (woning/terras) richting het gazon
      let best = null;
      for (const d of dry) {
        const c = G.closestOnPolygon(target, d.pts);
        if (!best || c.d < best.d) best = c;
      }
      const p = best ? best.pt : G.closestOnPolygon(target, mainLawn.pts).pt;
      els.push({ kind: 'source', x: p.x, y: p.y });
    }
    const src = els.find((e) => e.kind === 'source');
    if (src && !has('controller')) els.push({ kind: 'controller', x: src.x + 0.6, y: src.y });
    if (src && !has('valvebox') && mainLawn) {
      // ventielkast net buiten het gazon, tussen aansluiting en gazon
      const edge = G.closestOnPolygon(src, mainLawn.pts).pt;
      const dir = G.norm(G.sub(src, edge));
      const p = G.dist(src, edge) > 1.2 ? G.add(edge, G.mul(dir, 0.6)) : G.add(src, G.mul(G.sub(edge, src), 0.5));
      els.push({ kind: 'valvebox', x: p.x, y: p.y });
    }
    return els.map((e) => ({ id: G.uid('e'), kind: e.kind, x: +e.x.toFixed(3), y: +e.y.toFixed(3) }));
  }

  /**
   * Herkende vlakken rechttrekken: pixelranden en kartels eruit, randen die bijna in de
   * hoofdrichting van het plan lopen precies recht of haaks. Zo krijgt de sproeierplaatsing
   * nette randen en hoeken in plaats van tientallen kleine knikken.
   */
  function straighten(areas) {
    if (!areas.length) return;
    const simple = areas.map((a) => G.simplifyClosed(a.pts, Math.max(0.08, Math.min(0.25, 0.03 * Math.sqrt(G.area(a.pts))))));
    const angle = G.dominantAngle(simple);
    areas.forEach((a, i) => {
      const pts = G.regularize(simple[i], angle, { tolDeg: 12, merge: 0.2 });
      if (pts.length >= 3) a.pts = pts.map((p) => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
    });
  }

  /** Breedte in pixels van alle herkende vlakken samen (de getekende tuin), of 0. */
  function gardenWidthPx(areas) {
    const xs = [];
    for (const a of areas || []) if (C.areaTypes[a.type]) for (const p of a.points || []) xs.push(p.x);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  }

  /**
   * Zet het analyse-resultaat om naar vlakken en elementen in meters.
   * Schaal, in volgorde: maat met maatlijn (analyse) → schaal 1:N met bekend papierformaat (PDF) →
   * door de gebruiker opgegeven tuinbreedte → aanname (tuin 10 m breed, of het hele plan 30 m).
   * @param result  antwoord van /api/plan/analyze (pixels van de analyse-afbeelding)
   * @param analyzeImage {width, height, factor, paper?: {widthM, ratio}} (factor = analyse-px / ondergrond-px)
   * @param opts {gardenWidthM?}
   * @returns {{backgroundScale, areas, elements, scaleInfo, warnings, gardenWidthPx}}
   */
  function build(result, analyzeImage, opts = {}) {
    const warnings = [];
    const scale = { ...(result.scale || {}) };
    let mppAnalyze = scale.metersPerPixel;
    let estimated = false;
    const found = mppAnalyze > 0 && isFinite(mppAnalyze) && scale.method !== 'schatting';
    const paper = analyzeImage.paper || {};
    const ratio = paper.ratio || scale.ratio;
    const gw = gardenWidthPx(result.areas);
    if (!found && paper.widthM > 0 && ratio > 0) {
      mppAnalyze = (paper.widthM * ratio) / analyzeImage.width;
      Object.assign(scale, { metersPerPixel: mppAnalyze, method: `schaal 1:${ratio}`, confidence: 'hoog', evidence: `schaal 1:${ratio} op papierbreedte ${Math.round(paper.widthM * 1000)} mm` });
    } else if (!found && opts.gardenWidthM > 0 && gw > 0) {
      mppAnalyze = opts.gardenWidthM / gw;
      Object.assign(scale, { metersPerPixel: mppAnalyze, method: 'opgegeven tuinbreedte', confidence: 'middel', evidence: `tuin ${opts.gardenWidthM} m breed` });
      warnings.push(`Schaal afgeleid uit de opgegeven tuinbreedte (${opts.gardenWidthM} m). Controleer met "Schaal kalibreren" als er een bekende maat is.`);
    } else if (!(mppAnalyze > 0) || !isFinite(mppAnalyze)) {
      estimated = true;
      if (gw > 0) {
        mppAnalyze = FALLBACK_GARDEN_M / gw;
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
    const toWorld = (p) => ({ x: p.x * mppAnalyze, y: p.y * mppAnalyze });
    const counters = {};
    const areas = [];
    for (const a of result.areas || []) {
      if (!C.areaTypes[a.type]) continue;
      const pts = cleanPolygon(a.points.map(toWorld));
      if (pts.length < 3 || G.area(pts) < 0.5) continue;
      counters[a.type] = (counters[a.type] || 0) + 1;
      areas.push({ id: G.uid('a'), type: a.type, name: a.name || `${C.areaTypes[a.type].label} ${counters[a.type]}`, pts, zone: null });
    }
    if (result.local) straighten(areas);
    if (!areas.some((a) => a.type === 'lawn')) warnings.push('Geen gazon herkend. Teken het gazon of gebruik de toverstaf in stap 2.');
    const elements = defaultElements(areas, (result.elements || []).map((e) => ({ kind: e.kind, ...toWorld(e) })));
    if (result.notes) warnings.push(result.notes);
    return {
      // meters per pixel van de ondergrond = per analyse-pixel × (analyse-px per ondergrond-px)
      backgroundScale: mppAnalyze * analyzeImage.factor,
      areas,
      elements,
      scaleInfo: { ...scale, estimated },
      warnings,
      gardenWidthPx: gw,
    };
  }

  window.Concept = { analyze, learned, teach, status, build, defaultElements, straighten, FALLBACK_WIDTH_M, FALLBACK_GARDEN_M };
})();
