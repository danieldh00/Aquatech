/* Van herkend plan naar een bewerkbaar concept: schaal, vlakken, elementen, sproeiers, zones en leidingen. */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  const FALLBACK_WIDTH_M = 30; // aangenomen breedte van het plan als er geen schaal gevonden is

  /** Vraagt de backend om het plan te herkennen. */
  async function analyze(analyzeImage) {
    let res;
    try {
      res = await fetch('api/plan/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: analyzeImage.dataUrl, width: analyzeImage.width, height: analyzeImage.height }),
      });
    } catch (err) {
      throw new Error('Geen verbinding met de server. Automatisch herkennen werkt alleen via de app, niet via een lokaal geopend bestand.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `Herkennen mislukt (${res.status}).`);
    return body;
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
   * Zet het analyse-resultaat om naar vlakken en elementen in meters.
   * @param result  antwoord van /api/plan/analyze (pixels van de analyse-afbeelding)
   * @param analyzeImage {width, height, factor} (factor = analyse-px / ondergrond-px)
   * @returns {{background:{scale}, areas, elements, scaleInfo, warnings}}
   */
  function build(result, analyzeImage) {
    const warnings = [];
    let mppAnalyze = result.scale && result.scale.metersPerPixel;
    let estimated = false;
    if (!(mppAnalyze > 0) || !isFinite(mppAnalyze)) {
      mppAnalyze = FALLBACK_WIDTH_M / analyzeImage.width;
      estimated = true;
      warnings.push(`Geen leesbare maat met maatlijn gevonden; aangenomen dat het plan ${FALLBACK_WIDTH_M} m breed is. Kalibreer de schaal in stap 1 met een bekende maat.`);
    } else if (result.scale.confidence === 'laag' || result.scale.method === 'schatting') {
      warnings.push(`Schaal geschat (${result.scale.evidence || 'geen maat gevonden'}). Controleer met "Schaal kalibreren".`);
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
    if (!areas.some((a) => a.type === 'lawn')) warnings.push('Geen gazon herkend. Teken het gazon of gebruik de toverstaf in stap 2.');
    const elements = defaultElements(areas, (result.elements || []).map((e) => ({ kind: e.kind, ...toWorld(e) })));
    if (result.notes) warnings.push(result.notes);
    return {
      // meters per pixel van de ondergrond = per analyse-pixel × (analyse-px per ondergrond-px)
      backgroundScale: mppAnalyze * analyzeImage.factor,
      areas,
      elements,
      scaleInfo: { ...(result.scale || {}), estimated },
      warnings,
    };
  }

  window.Concept = { analyze, status, build, defaultElements, FALLBACK_WIDTH_M };
})();
