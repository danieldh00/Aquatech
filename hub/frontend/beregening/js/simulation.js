/* Neerslagsimulatie op een raster: gemiddelde neerslag, verdeling (DU) en droge plekken. */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;

  // Neerslag per kop (uit de nozzle van de bibliotheek) onthouden zolang de instelling gelijk blijft.
  const prCache = new WeakMap();
  /**
   * Geeft de neerslag van een sproeikop (uit de nozzle van de bibliotheek), onthouden zolang de instelling gelijk blijft.
   * @param {object} sprinkler de sproeier
   * @returns {number} neerslag in mm/u
   */
  function prOf(sprinkler) {
    const signature = `${sprinkler.type}|${sprinkler.r}|${sprinkler.arc}|${sprinkler.model || ''}|${sprinkler.body || ''}`;
    const hit = prCache.get(sprinkler);
    if (hit && hit.sig === signature) return hit.pr;
    const precipitation = Catalog.headPr ? Catalog.headPr(sprinkler) : Catalog.sprinklerTypes[sprinkler.type].pr;
    prCache.set(sprinkler, { sig: signature, pr: precipitation });
    return precipitation;
  }

  /**
   * Berekent de neerslag van één sproeier op een punt.
   * @param {object} sprinkler de sproeier
   * @param {{x: number, y: number}} point het punt in meters
   * @returns {number} neerslag in mm/u
   */
  function precipAt(sprinkler, point) {
    const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
    if (!sprinklerType) return 0;
    const deltaX = point.x - sprinkler.x, deltaY = point.y - sprinkler.y;
    if (sprinkler.type === 'strip') {
      const angle = Geo.rad(sprinkler.start);
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      const along = deltaX * direction.x + deltaY * direction.y;
      const across = -deltaX * direction.y + deltaY * direction.x;
      return Math.abs(along) <= sprinkler.len / 2 && across >= 0 && across <= sprinkler.width ? sprinklerType.pr : 0;
    }
    const distance = Math.hypot(deltaX, deltaY);
    if (distance > sprinkler.r) return 0;
    if (sprinkler.arc < 359.9 && distance > 1e-6 && !Geo.inArc(Geo.angleOf({ x: deltaX, y: deltaY }), sprinkler.start, sprinkler.arc)) return 0;
    // Driehoeksprofiel; volume-equivalent met PR bij kop-tot-kop vierkantsverband
    return ((3 * prOf(sprinkler)) / Math.PI) * (1 - distance / sprinkler.r);
  }

  /**
   * Geeft hoe ver een sproeier reikt.
   * @param {object} sprinkler de sproeier
   * @returns {number} afstand in meters
   */
  function reach(sprinkler) {
    return sprinkler.type === 'strip' ? Math.hypot(sprinkler.len / 2, sprinkler.width) : sprinkler.r;
  }

  /**
   * Simuleert neerslag op alle gazonvlakken en controleert overspray op 'droog'-vlakken.
   * @param {object} state de planstand (vlakken en sproeiers)
   * @param {number} cellSize celgrootte in meters (standaard 0,25)
   * @returns {object|null} raster (cellX, cellY, minX, minY, nx, ny, values, mask, areaIdx, areaMean), statistiek (null zonder rastercellen in een gazon), per gazon en overspray; null zonder geldig gazonvlak én zonder sproeiers
   */
  function simulate(state, cellSize = 0.25) {
    const lawns = state.areas.filter((area) => area.type === 'lawn' && area.pts.length >= 3);
    const dry = state.areas.filter((area) => area.type === 'dry' && area.pts.length >= 3);
    const points = [];
    lawns.forEach((area) => points.push(...area.pts));
    state.sprinklers.forEach((sprinkler) => {
      const radius = reach(sprinkler);
      points.push({ x: sprinkler.x - radius, y: sprinkler.y - radius }, { x: sprinkler.x + radius, y: sprinkler.y + radius });
    });
    if (!points.length) return null;
    const bounds = Geo.bbox(points);
    const columns = Math.min(1200, Math.ceil(bounds.w / cellSize) + 1);
    const rows = Math.min(1200, Math.ceil(bounds.h / cellSize) + 1);
    const cellX = bounds.w / Math.max(1, columns - 1) || cellSize;
    const cellY = bounds.h / Math.max(1, rows - 1) || cellSize;
    const values = new Float32Array(columns * rows);
    const mask = new Uint8Array(columns * rows); // 1 = gazon, 2 = droog-vlak
    const areaIdx = new Int16Array(columns * rows).fill(-1);

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const point = { x: bounds.minX + i * cellX, y: bounds.minY + j * cellY };
        const index = j * columns + i;
        for (let areaIndex = 0; areaIndex < lawns.length; areaIndex++) {
          if (Geo.pointInPolygon(point, lawns[areaIndex].pts)) { mask[index] = 1; areaIdx[index] = areaIndex; break; }
        }
        if (!mask[index] && dry.some((dryArea) => Geo.pointInPolygon(point, dryArea.pts))) mask[index] = 2;
      }
    }

    for (const sprinkler of state.sprinklers) {
      const radius = reach(sprinkler);
      const firstColumn = Math.max(0, Math.floor((sprinkler.x - radius - bounds.minX) / cellX));
      const lastColumn = Math.min(columns - 1, Math.ceil((sprinkler.x + radius - bounds.minX) / cellX));
      const firstRow = Math.max(0, Math.floor((sprinkler.y - radius - bounds.minY) / cellY));
      const lastRow = Math.min(rows - 1, Math.ceil((sprinkler.y + radius - bounds.minY) / cellY));
      for (let j = firstRow; j <= lastRow; j++) {
        for (let i = firstColumn; i <= lastColumn; i++) {
          const value = precipAt(sprinkler, { x: bounds.minX + i * cellX, y: bounds.minY + j * cellY });
          if (value) values[j * columns + i] += value;
        }
      }
    }

    /**
     * Berekent de statistiek over de cellen die het filter doorlaat.
     * @param {function(number): boolean} isIncluded zegt per celindex of hij meetelt
     * @returns {object|null} gemiddelde, min, max, DU, droog- en dekkingspercentage en aantal cellen; null zonder cellen
     */
    const statsFor = (isIncluded) => {
      const cellValues = [];
      for (let index = 0; index < values.length; index++) if (isIncluded(index)) cellValues.push(values[index]);
      if (!cellValues.length) return null;
      cellValues.sort((left, right) => left - right);
      const mean = cellValues.reduce((sum, value) => sum + value, 0) / cellValues.length;
      const lowestQuarter = cellValues.slice(0, Math.max(1, Math.floor(cellValues.length / 4)));
      const lowQuarterMean = lowestQuarter.reduce((sum, value) => sum + value, 0) / lowestQuarter.length;
      const dryCells = cellValues.filter((value) => value < 0.3 * mean).length;
      return {
        mean,
        min: cellValues[0],
        max: cellValues[cellValues.length - 1],
        du: mean > 0 ? lowQuarterMean / mean : 0,
        dryPct: (dryCells / cellValues.length) * 100,
        coveredPct: (cellValues.filter((value) => value > 0).length / cellValues.length) * 100,
        cells: cellValues.length,
      };
    };

    const perArea = lawns.map((area, areaIndex) => ({ area, stats: statsFor((index) => mask[index] === 1 && areaIdx[index] === areaIndex) }));
    // Elk gazon draait in eigen zones zo lang als nodig (rotators langer dan sproeiers), dus de
    // verdeling telt per gazon: elke cel t.o.v. het gemiddelde van zijn eigen gazon.
    const areaMean = perArea.map((entry) => (entry.stats && entry.stats.mean > 0 ? entry.stats.mean : 0));
    const stats = statsFor((index) => mask[index] === 1);
    if (stats && lawns.length > 1) {
      const relative = [];
      for (let index = 0; index < values.length; index++) if (mask[index] === 1) relative.push(areaMean[areaIdx[index]] > 0 ? values[index] / areaMean[areaIdx[index]] : 0);
      relative.sort((left, right) => left - right);
      const lowestQuarter = relative.slice(0, Math.max(1, Math.floor(relative.length / 4)));
      stats.du = lowestQuarter.reduce((sum, value) => sum + value, 0) / lowestQuarter.length;
      stats.dryPct = (relative.filter((value) => value < 0.3).length / relative.length) * 100;
    }
    let oversprayCells = 0;
    for (let index = 0; index < values.length; index++) if (mask[index] === 2 && values[index] > 0) oversprayCells++;
    const overspray = oversprayCells * cellX * cellY;

    return { cellX, cellY, minX: bounds.minX, minY: bounds.minY, nx: columns, ny: rows, values, mask, areaIdx, areaMean, stats, perArea, overspray };
  }

  /**
   * Geeft de kleur bij een neerslag t.o.v. het gemiddelde: 0 = rood, 50% = geel, 100% = groen, 150%+ = blauw.
   * @param {number} ratio neerslag gedeeld door het gemiddelde
   * @returns {number[]} kleur als [rood, groen, blauw]
   */
  function colorFor(ratio) {
    const stops = [
      [0, [211, 47, 47]],
      [0.5, [255, 193, 7]],
      [0.85, [139, 195, 74]],
      [1.15, [56, 142, 60]],
      [1.6, [30, 136, 229]],
    ];
    if (ratio <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (ratio <= stops[i][0]) {
        const [lowerStop, lowerColor] = stops[i - 1];
        const [upperStop, upperColor] = stops[i];
        const fraction = (ratio - lowerStop) / (upperStop - lowerStop);
        return lowerColor.map((channel, channelIndex) => Math.round(channel + (upperColor[channelIndex] - channel) * fraction));
      }
    }
    return stops[stops.length - 1][1];
  }

  /**
   * Tekent het resultaat op een (klein) canvas voor de overlay.
   * @param {object} result uitkomst van simulate
   * @returns {HTMLCanvasElement} het canvas
   */
  function toCanvas(result) {
    const canvas = document.createElement('canvas');
    canvas.width = result.nx;
    canvas.height = result.ny;
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(result.nx, result.ny);
    const reference = result.stats && result.stats.mean > 0 ? result.stats.mean : 1;
    for (let index = 0; index < result.values.length; index++) {
      const maskValue = result.mask[index];
      const value = result.values[index];
      const offset = index * 4;
      if (maskValue === 1) {
        const areaMeanValue = result.areaMean && result.areaIdx ? result.areaMean[result.areaIdx[index]] : 0;
        const color = colorFor(value / (areaMeanValue > 0 ? areaMeanValue : reference));
        imageData.data[offset] = color[0]; imageData.data[offset + 1] = color[1]; imageData.data[offset + 2] = color[2]; imageData.data[offset + 3] = 190;
      } else if (value > 0) {
        // overspray buiten gazon
        const isDry = maskValue === 2;
        imageData.data[offset] = isDry ? 183 : 100; imageData.data[offset + 1] = isDry ? 28 : 181; imageData.data[offset + 2] = isDry ? 28 : 246;
        imageData.data[offset + 3] = isDry ? 170 : 60;
      }
    }
    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  window.Simulation = { simulate, precipAt, toCanvas, colorFor };
})();
