/* Toverstaf: klik in de ondergrond en trek het vlak met dezelfde kleur uit als polygoon. */
(function () {
  'use strict';

  const WORK_MAX = 1200; // werkresolutie (langste zijde) voor snelheid

  let cache = null; // { src, data, w, h, f }

  /**
   * Leest de pixels van de ondergrond op werkresolutie (bewaard zolang de ondergrond gelijk blijft).
   * @param {HTMLImageElement} image de ondergrond
   * @returns {{src: string, data: Uint8ClampedArray, w: number, h: number, f: number}} pixels, breedte, hoogte en verkleiningsfactor
   */
  function pixels(image) {
    const src = image.src;
    if (cache && cache.src === src) return cache;
    const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
    const factor = Math.min(1, WORK_MAX / Math.max(imageWidth, imageHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(imageWidth * factor));
    canvas.height = Math.max(1, Math.round(imageHeight * factor));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    cache = { src, data: context.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height, f: factor };
    return cache;
  }

  /**
   * Vult vanaf een startpixel alle aangrenzende pixels met (bijna) dezelfde kleur.
   * @param {{data: Uint8ClampedArray, w: number, h: number}} image pixels met breedte en hoogte
   * @param {number} startX kolom van het startpixel
   * @param {number} startY rij van het startpixel
   * @param {number} tolerance toegestane kleurafstand
   * @returns {{mask: Uint8Array, count: number}} masker (1 = binnen het vlak) en aantal pixels
   */
  function floodFill(image, startX, startY, tolerance) {
    const { data, w: width, h: height } = image;
    const mask = new Uint8Array(width * height);
    const startIndex = (startY * width + startX) * 4;
    const startRed = data[startIndex], startGreen = data[startIndex + 1], startBlue = data[startIndex + 2];
    const toleranceSquared = tolerance * tolerance;
    const stack = [startY * width + startX];
    mask[startY * width + startX] = 1;
    let count = 0;
    while (stack.length) {
      const index = stack.pop();
      count++;
      const x = index % width, y = (index - x) / width;
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || mask[neighbour]) continue;
        const offset = neighbour * 4;
        const deltaRed = data[offset] - startRed, deltaGreen = data[offset + 1] - startGreen, deltaBlue = data[offset + 2] - startBlue;
        if (deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue <= toleranceSquared) {
          mask[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    return { mask, count };
  }

  /**
   * Dilatatie of erosie met een vierkant van een straal (scheidbaar, horizontaal + verticaal).
   * @param {Uint8Array} mask het masker
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} radius straal van het vierkant
   * @param {boolean} dilate true = uitzetten, false = krimpen
   * @returns {Uint8Array} het nieuwe masker
   */
  function morph(mask, width, height, radius, dilate) {
    /**
     * Doet één richting van de bewerking.
     * @param {Uint8Array} source het masker
     * @param {boolean} horizontal true = langs de rijen, false = langs de kolommen
     * @returns {Uint8Array} het resultaat
     */
    const pass = (source, horizontal) => {
      const result = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = dilate ? 0 : 1;
          for (let step = -radius; step <= radius; step++) {
            const sampleX = horizontal ? x + step : x, sampleY = horizontal ? y : y + step;
            const inside = sampleX >= 0 && sampleY >= 0 && sampleX < width && sampleY < height;
            const sample = inside ? source[sampleY * width + sampleX] : 0;
            if (dilate ? sample : !sample) { value = dilate ? 1 : 0; break; }
          }
          result[y * width + x] = value;
        }
      }
      return result;
    };
    return pass(pass(mask, true), false);
  }

  /**
   * Maakt gaten (tekst, symbolen) in het vlak dicht: alles wat de rand niet bereikt hoort erbij.
   * @param {Uint8Array} mask het masker
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {Uint8Array} het masker zonder gaten
   */
  function fillHoles(mask, width, height) {
    const outside = new Uint8Array(width * height);
    const stack = [];
    /**
     * Markeert een leeg pixel als buiten en zet het op de stapel.
     * @param {number} index index van het pixel
     */
    const push = (index) => { if (!mask[index] && !outside[index]) { outside[index] = 1; stack.push(index); } };
    for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
    while (stack.length) {
      const index = stack.pop();
      const x = index % width, y = (index - x) / width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }
    const result = new Uint8Array(width * height);
    for (let index = 0; index < result.length; index++) result[index] = outside[index] ? 0 : 1;
    return result;
  }

  /**
   * Volgt de buitencontour (Moore-buren), te beginnen bij het eerste maskerpixel in leesvolgorde.
   * @param {Uint8Array} mask het masker
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {Array<{x: number, y: number}>} de randpunten
   */
  function traceContour(mask, width, height) {
    let start = -1;
    for (let index = 0; index < mask.length; index++) if (mask[index]) { start = index; break; }
    if (start < 0) return [];
    /**
     * Zegt of een pixel binnen het beeld ligt en in het masker zit.
     * @param {number} x kolom
     * @param {number} y rij
     * @returns {boolean|number} waar als het pixel gevuld is
     */
    const isFilled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
    // richtingen met de klok mee, beginnend links
    const directions = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const startX = start % width, startY = (start - startX) / width;
    let x = startX, y = startY;
    let from = 1; // eerste zoekrichting: links van het startpixel is leeg (leesvolgorde)
    const points = [{ x, y }];
    const limit = width * height * 4;
    for (let step = 0; step < limit; step++) {
      let moved = -1;
      for (let i = 0; i < 8; i++) {
        const direction = (from + i) % 8;
        if (isFilled(x + directions[direction][0], y + directions[direction][1])) { moved = direction; break; }
      }
      if (moved < 0) break; // los pixel
      x += directions[moved][0];
      y += directions[moved][1];
      if (x === startX && y === startY) break;
      points.push({ x, y });
      // volgende zoektocht begint net na het lege buurpixel waarlangs we kwamen
      from = (moved + (moved % 2 === 0 ? 7 : 6)) % 8;
    }
    return points;
  }

  /**
   * Vereenvoudigt een lijn (Ramer-Douglas-Peucker).
   * @param {Array<{x: number, y: number}>} points de punten
   * @param {number} tolerance maximale afwijking in pixels
   * @returns {Array<{x: number, y: number}>} de overgebleven punten
   */
  function simplify(points, tolerance) {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let best = -1, bestDistance = 0;
      for (let i = first + 1; i < last; i++) {
        const distance = window.Geo.distToSegment(points[i], points[first], points[last]);
        if (distance > bestDistance) { bestDistance = distance; best = i; }
      }
      if (bestDistance > tolerance && best > 0) {
        keep[best] = 1;
        stack.push([first, best], [best, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  /**
   * Toverstaf: trekt het vlak met dezelfde kleur rond de klikpositie uit als polygoon.
   * @param {HTMLImageElement} image ondergrond
   * @param {number} imageX klikpositie (x) in pixels van de ondergrond
   * @param {number} imageY klikpositie (y) in pixels van de ondergrond
   * @param {number} tolerance kleurtolerantie (0–120)
   * @returns {{points: Array<{x: number, y: number}>, coverage: number}|{error: string}} de punten en het aandeel van het beeld, of een foutmelding
   */
  function wand(image, imageX, imageY, tolerance = 40) {
    const pixelData = pixels(image);
    const startX = Math.round(imageX * pixelData.f), startY = Math.round(imageY * pixelData.f);
    if (startX < 0 || startY < 0 || startX >= pixelData.w || startY >= pixelData.h) return { error: 'Klik binnen de ondergrond.' };
    let { mask, count } = floodFill(pixelData, startX, startY, tolerance);
    const coverage = count / (pixelData.w * pixelData.h);
    if (count < 60) return { error: 'Te klein vlak gevonden. Verhoog de gevoeligheid of klik midden in het vlak.' };
    if (coverage > 0.92) return { error: 'Bijna de hele afbeelding valt binnen de kleur. Verlaag de gevoeligheid.' };
    // kleine onderbrekingen (lijnen, tekst) sluiten en gaten vullen
    const radius = Math.max(1, Math.round(Math.max(pixelData.w, pixelData.h) / 600));
    mask = morph(morph(mask, pixelData.w, pixelData.h, radius, true), pixelData.w, pixelData.h, radius, false);
    mask = fillHoles(mask, pixelData.w, pixelData.h);
    const contour = traceContour(mask, pixelData.w, pixelData.h);
    if (contour.length < 8) return { error: 'Geen bruikbare rand gevonden.' };
    const simplifyTolerance = Math.max(1.2, Math.max(pixelData.w, pixelData.h) / 500);
    const simple = simplify(contour, simplifyTolerance);
    const points = simple.map((point) => ({ x: point.x / pixelData.f, y: point.y / pixelData.f }));
    return { points, coverage };
  }

  window.AutoTrace = { wand, _internal: { floodFill, traceContour, simplify, fillHoles } };
})();
