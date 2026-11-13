// Generator voor synthetische tuinplannen in de stijl van hoveniersontwerpen (lichtgroen gazon, donkergroene
// borders met beplanting en bomen, grijze/rode/houten terrassen, een woning, soms een vijver, tekstlabels,
// titelblok en logo). Elk plan komt met de waarheid: de vlakken (soort, hoekpunten en laag) staan in
// `naam.json`, in het formaat van tools/recog-bench.js. Zo kan de lokale herkenning worden gemeten zonder
// AI en zonder echte klanttekeningen.
//
// Gebruik: `node tools/plan-generator.js <doelmap> [aantal] [eerste-seed]` (rasteriseert met de aanwezige
// Playwright/Chromium; elk plan wordt afwisselend "digitaal" en "scan" (licht, ruis, onscherp)).
// De bouwfuncties (`buildPlan`) zijn zuiver en kennen geen Chromium; alleen de opdrachtregel gebruikt het.
const fs = require('fs');
const path = require('path');
const { insidePolygon } = require('../src/beregening/recog-metrics');

/** Pixels per meter in de gegenereerde tekeningen. */
const PIXELS_PER_METER = 55;
const LABEL_WORDS = ['Gazon', 'Border', 'Beplanting', 'Terras', 'Haag', 'Vijver', 'Boom (meerstammig)', 'Tegels 60x60', 'Beplanting van sedum', 'Overkapping', 'Berging', 'Vuurplaats', 'Bank', 'Hortensia', 'Siergras', 'Klinkers', 'Grind', 'Stapstenen', 'Bestaande boom', 'Erfafscheiding'];
const TERRACE_COLORS = [[176, 176, 178], [196, 108, 88], [176, 128, 78], [214, 200, 170], [150, 150, 156]];

/**
 * Vaste toevalsreeks (mulberry32): dezelfde seed geeft altijd dezelfde tekening.
 * @param {number} seed Startwaarde.
 * @returns {function(): number} Functie die steeds een getal tussen 0 en 1 geeft.
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Zwaartepunt van een veelhoek (gemiddelde van de hoekpunten).
 * @param {Array<{x: number, y: number}>} points De hoekpunten.
 * @returns {{x: number, y: number}} Het midden.
 */
function centerOf(points) {
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}

/**
 * Afstand van een punt langs een straal tot de rand van een veelhoek.
 * @param {{x: number, y: number}} origin Beginpunt (binnen de veelhoek).
 * @param {number} angle Richting in radialen.
 * @param {Array<{x: number, y: number}>} polygon De veelhoek.
 * @returns {number} De afstand tot het dichtstbijzijnde snijpunt (0 als er geen is).
 */
function rayDistance(origin, angle, polygon) {
  const directionX = Math.cos(angle), directionY = Math.sin(angle);
  let nearest = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    const from = polygon[index], to = polygon[(index + 1) % polygon.length];
    const edgeX = to.x - from.x, edgeY = to.y - from.y;
    const denominator = directionX * edgeY - directionY * edgeX;
    if (Math.abs(denominator) < 1e-9) continue;
    const along = ((from.x - origin.x) * edgeY - (from.y - origin.y) * edgeX) / denominator;
    const across = ((from.x - origin.x) * directionY - (from.y - origin.y) * directionX) / denominator;
    if (along > 0 && across >= 0 && across <= 1 && along < nearest) nearest = along;
  }
  return Number.isFinite(nearest) ? nearest : 0;
}

/**
 * Organische vorm binnen een veelhoek: per richting een vaste fractie van de afstand tot de rand, met een zachte golving.
 * @param {Array<{x: number, y: number}>} polygon De omringende veelhoek.
 * @param {{x: number, y: number}} center Het midden van de vorm.
 * @param {number} minFraction Kleinste fractie van de afstand tot de rand.
 * @param {number} maxFraction Grootste fractie van de afstand tot de rand.
 * @param {function(): number} random Toevalsreeks.
 * @returns {Array<{x: number, y: number}>} 72 hoekpunten.
 */
function organicShape(polygon, center, minFraction, maxFraction, random) {
  const waves = [1, 2, 3, 5].map((frequency) => ({ frequency, phase: random() * Math.PI * 2, weight: random() / frequency }));
  const total = waves.reduce((sum, wave) => sum + wave.weight, 0) || 1;
  const points = [];
  for (let step = 0; step < 72; step++) {
    const angle = (step / 72) * Math.PI * 2;
    const wobble = waves.reduce((sum, wave) => sum + wave.weight * Math.sin(wave.frequency * angle + wave.phase), 0) / total;
    const fraction = minFraction + (maxFraction - minFraction) * (0.5 + 0.5 * wobble);
    const distance = rayDistance(center, angle, polygon) * fraction;
    points.push({ x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance });
  }
  return points;
}

/**
 * Ellips als veelhoek, met een lichte golving.
 * @param {{x: number, y: number}} center Het midden.
 * @param {number} radiusX Straal in x-richting.
 * @param {number} radiusY Straal in y-richting.
 * @param {function(): number} random Toevalsreeks.
 * @returns {Array<{x: number, y: number}>} 40 hoekpunten.
 */
function blob(center, radiusX, radiusY, random) {
  const phase = random() * Math.PI * 2;
  const points = [];
  for (let step = 0; step < 40; step++) {
    const angle = (step / 40) * Math.PI * 2;
    const wobble = 1 + 0.12 * Math.sin(2 * angle + phase) + 0.07 * Math.sin(3 * angle + phase * 2);
    points.push({ x: center.x + Math.cos(angle) * radiusX * wobble, y: center.y + Math.sin(angle) * radiusY * wobble });
  }
  return points;
}

/**
 * Een tuinomtrek: rechthoek, trapezium of vijfhoek met een afgesneden hoek.
 * @param {{left: number, top: number, right: number, bottom: number}} box Het beschikbare vak.
 * @param {function(): number} random Toevalsreeks.
 * @returns {{points: Array<{x: number, y: number}>, kind: string}} De omtrek en zijn soort.
 */
function gardenOutline(box, random) {
  const { left, top, right, bottom } = box;
  const width = right - left, height = bottom - top;
  const pick = random();
  if (pick < 0.4) return { kind: 'rechthoek', points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
  if (pick < 0.75) {
    const skew = height * (0.08 + random() * 0.12);
    return { kind: 'trapezium', points: [{ x: left, y: top }, { x: right, y: top + skew }, { x: right, y: bottom - skew * 0.4 }, { x: left, y: bottom }] };
  }
  const cut = Math.min(width, height) * (0.2 + random() * 0.15);
  return { kind: 'vijfhoek', points: [{ x: left, y: top }, { x: right - cut, y: top }, { x: right, y: top + cut }, { x: right, y: bottom }, { x: left, y: bottom }] };
}

/**
 * Rechthoek als veelhoek.
 * @param {number} left Links.
 * @param {number} top Boven.
 * @param {number} width Breedte.
 * @param {number} height Hoogte.
 * @returns {Array<{x: number, y: number}>} De vier hoekpunten.
 */
const rectangle = (left, top, width, height) => [{ x: left, y: top }, { x: left + width, y: top }, { x: left + width, y: top + height }, { x: left, y: top + height }];

/**
 * SVG-pad voor een veelhoek.
 * @param {Array<{x: number, y: number}>} points De hoekpunten.
 * @returns {string} De waarde voor het d-attribuut.
 */
const pathOf = (points) => `M${points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')} Z`;

/**
 * Kleur als css-tekst.
 * @param {number[]} rgb Rood, groen, blauw.
 * @param {number} [shift] Optionele verandering per kanaal.
 * @returns {string} Bijvoorbeeld "rgb(10,20,30)".
 */
const colorOf = (rgb, shift = 0) => `rgb(${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value + shift)))).join(',')})`;

/**
 * Laadt Playwright: eerst uit de eigen modules, anders uit de globale (zo staat het in de cloud-sandbox).
 * @returns {object} de Playwright-module
 */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'));
    } catch (error) {
      throw new Error('Playwright niet gevonden: installeer het globaal (npm i -g playwright) of draai dit script in een omgeving waar het beschikbaar is.', { cause: error });
    }
  }
}

/**
 * Bouwt één tuinplan: een SVG-tekening en de waarheid (vlakken, elementen, schaal).
 * @param {number} seed Startwaarde van de toevalsreeks.
 * @param {{ style?: string }} [options] style: "digitaal" (scherp) of "scan" (licht verloop, ruis, onscherp).
 * @returns {{ svg: string, width: number, height: number, truth: object, style: string, blur: number }} De tekening en de waarheid.
 */
function buildPlan(seed, options = {}) {
  const random = createRandom(seed);
  /**
   * Een toevalsgetal tussen twee grenzen.
   * @param {number} low ondergrens
   * @param {number} high bovengrens
   * @returns {number} getal tussen low en high
   */
  const between = (low, high) => low + (high - low) * random();
  const style = options.style === 'scan' ? 'scan' : 'digitaal';
  const portrait = random() < 0.6;
  const width = portrait ? 1100 : 1500, height = portrait ? 1500 : 1100;
  const box = { left: 170 + between(0, 40), top: 110 + between(0, 30), right: width - 170 - between(0, 40), bottom: height - 190 - between(0, 30) };
  const outline = gardenOutline(box, random);
  const garden = outline.points;
  const gardenWidth = box.right - box.left, gardenHeight = box.bottom - box.top;

  // woning aan de onder- of bovenkant (liggend: links of rechts), terras ervoor
  const houseWidth = gardenWidth * between(0.38, 0.55), houseHeight = gardenHeight * between(0.2, 0.3);
  const houseLeft = box.left + (gardenWidth - houseWidth) * between(0.25, 0.75);
  const houseOnBottom = random() < 0.6;
  const houseTop = houseOnBottom ? box.bottom - houseHeight - gardenHeight * 0.02 : box.top + gardenHeight * 0.02 + 40;
  const house = rectangle(houseLeft, houseTop, houseWidth, houseHeight);
  const terraceDepth = PIXELS_PER_METER * between(2.8, 4.2);
  const terraceWidth = houseWidth * between(0.7, 1.15);
  const terraceLeft = houseLeft + (houseWidth - terraceWidth) / 2;
  const terrace = rectangle(terraceLeft, houseOnBottom ? houseTop - terraceDepth : houseTop + houseHeight, terraceWidth, terraceDepth);
  const hardscape = [{ points: house, kind: 'house' }, { points: terrace, kind: 'terrace' }];
  if (random() < 0.5) {
    const sideLeft = random() < 0.5;
    const driveWidth = PIXELS_PER_METER * between(2.4, 3.2);
    hardscape.push({ points: rectangle(sideLeft ? box.left : box.right - driveWidth, houseTop, driveWidth, houseHeight), kind: 'oprit' });
  }
  /**
   * Zegt of een punt in de tuin ligt.
   * @param {{x: number, y: number}} point het punt
   * @returns {boolean} true als het binnen de tuinvorm ligt
   */
  const insideGarden = (point) => insidePolygon(point.x, point.y, garden);
  /**
   * Zegt of een punt op of vlak bij huis, terras of oprit ligt.
   * @param {{x: number, y: number}} point het punt
   * @param {number} margin extra afstand rond de verharding
   * @returns {boolean} true als het punt erop of erbij ligt
   */
  const inHardscape = (point, margin = 0) => hardscape.some(({ points }) => point.x > points[0].x - margin && point.x < points[1].x + margin && point.y > points[0].y - margin && point.y < points[2].y + margin);
  const hardscapeInside = hardscape.every(({ points }) => points.every(insideGarden));
  if (!hardscapeInside) {
    hardscape.splice(2); // oprit vervalt; woning en terras schuiven naar het midden van de tuin tot ze binnen de omtrek liggen
    const middle = centerOf(garden);
    for (let step = 0; step < 40 && !hardscape.every(({ points }) => points.every(insideGarden)); step++) {
      for (const { points } of hardscape) {
        for (const point of points) { point.x += (middle.x - point.x) * 0.03; point.y += (middle.y - point.y) * 0.03; }
      }
    }
    if (!hardscape.every(({ points }) => points.every(insideGarden))) hardscape.splice(0);
  }

  // gazon: organische vorm in de tuin; huis en terras liggen er later bovenop
  const gardenCenter = centerOf(garden);
  const lawn = organicShape(garden, gardenCenter, 0.55, 0.88, random);
  /**
   * Zegt of een punt in het gazon ligt.
   * @param {{x: number, y: number}} point het punt
   * @returns {boolean} true als het in het gazon ligt
   */
  const inLawn = (point) => insidePolygon(point.x, point.y, lawn);

  const areas = [{ type: 'bed', name: 'Tuin', points: garden, layer: 0 }, { type: 'lawn', name: 'Gazon', points: lawn, layer: 1 }];
  const islands = [];
  for (let attempt = 0, wanted = Math.round(between(0, 2.4)); attempt < 40 && islands.length < wanted; attempt++) {
    const center = lawn[Math.floor(random() * lawn.length)];
    const towardsCenter = { x: gardenCenter.x + (center.x - gardenCenter.x) * between(0.2, 0.6), y: gardenCenter.y + (center.y - gardenCenter.y) * between(0.2, 0.6) };
    const radius = PIXELS_PER_METER * between(1.1, 2.2);
    if (!inLawn(towardsCenter) || inHardscape(towardsCenter, radius * 1.4)) continue;
    islands.push(blob(towardsCenter, radius * between(1, 1.6), radius * between(0.6, 1), random));
  }
  for (const [index, island] of islands.entries()) areas.push({ type: 'bed', name: `Border ${index + 1}`, points: island, layer: 2 });
  let pond = null;
  if (random() < 0.4) {
    const center = { x: gardenCenter.x + between(-0.15, 0.15) * gardenWidth, y: gardenCenter.y + between(-0.15, 0.15) * gardenHeight };
    const radius = PIXELS_PER_METER * between(1, 1.7);
    if (inLawn(center) && !inHardscape(center, radius * 1.5) && !islands.some((island) => insidePolygon(center.x, center.y, island))) {
      pond = blob(center, radius * 1.3, radius * 0.9, random);
      areas.push({ type: 'wet', name: 'Vijver', points: pond, layer: 3 });
    }
  }
  const terraceColor = TERRACE_COLORS[Math.floor(random() * TERRACE_COLORS.length)];
  for (const { points, kind } of hardscape) areas.push({ type: 'dry', name: kind === 'house' ? 'Woning' : kind === 'terrace' ? 'Terras' : 'Oprit', points, layer: 4 });

  // wateraansluiting op de gevel die naar het gazon kijkt, regelaar ernaast
  const sourcePoint = { x: houseLeft + houseWidth * between(0.2, 0.8), y: houseOnBottom ? houseTop : houseTop + houseHeight };
  const elements = [{ kind: 'source', x: sourcePoint.x, y: sourcePoint.y }, { kind: 'controller', x: sourcePoint.x + 30, y: sourcePoint.y }];

  const lawnColor = [166 + between(0, 26), 214 + between(0, 14), 62 + between(0, 26)];
  const bedColor = [78 + between(0, 14), 130 + between(0, 14), 56 + between(0, 12)];
  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="rgb(255,255,255)"/>`);
  parts.push(`<path d="${pathOf(garden)}" fill="${colorOf(bedColor)}" stroke="rgb(30,70,30)" stroke-width="4"/>`);
  parts.push(`<path d="${pathOf(lawn)}" fill="${colorOf(lawnColor)}"/>`);
  for (const island of islands) parts.push(`<path d="${pathOf(island)}" fill="${colorOf(bedColor, -6)}"/>`);
  if (pond) parts.push(`<path d="${pathOf(pond)}" fill="rgb(150,192,206)" stroke="rgb(70,100,120)" stroke-width="3"/>`);
  for (const { points, kind } of hardscape) {
    if (kind === 'house') parts.push(`<path d="${pathOf(points)}" fill="rgb(247,247,247)" stroke="rgb(70,70,70)" stroke-width="3"/><path d="M${points[0].x},${points[0].y} L${points[2].x},${points[2].y} M${points[1].x},${points[1].y} L${points[3].x},${points[3].y}" stroke="rgb(200,200,200)" stroke-width="1.5"/>`);
    else parts.push(`<path d="${pathOf(points)}" fill="${colorOf(kind === 'terrace' ? terraceColor : [168, 168, 172])}" stroke="rgb(110,110,110)" stroke-width="1.5"/>`);
  }
  // tegelvoegen in het terras
  const [terraceStart, , terraceEnd] = terrace;
  const tileLines = [];
  for (let x = terraceStart.x + 36; x < terraceEnd.x; x += 36) tileLines.push(`M${x.toFixed(1)},${terraceStart.y} L${x.toFixed(1)},${terraceEnd.y}`);
  for (let y = terraceStart.y + 36; y < terraceEnd.y; y += 36) tileLines.push(`M${terraceStart.x},${y.toFixed(1)} L${terraceEnd.x},${y.toFixed(1)}`);
  parts.push(`<path d="${tileLines.join(' ')}" stroke="rgba(90,90,90,0.35)" stroke-width="1" fill="none"/>`);

  // beplanting in de border (tussen omtrek en gazon, buiten verharding en vijver), bomen met schaduw
  const shadows = [], plants = [], trees = [];
  const plantColors = [[52, 108, 46], [96, 150, 66], [70, 128, 52], [120, 168, 78], [150, 112, 190], [210, 120, 150], [240, 240, 230]];
  for (let attempt = 0, placed = 0, wanted = Math.round(between(120, 260)); attempt < wanted * 6 && placed < wanted; attempt++) {
    const point = { x: between(box.left, box.right), y: between(box.top, box.bottom) };
    const inIsland = islands.some((island) => insidePolygon(point.x, point.y, island));
    if (!insideGarden(point) || inHardscape(point, 6) || (inLawn(point) && !inIsland)) continue;
    const radius = between(5, 14);
    const colorIndex = random() < 0.12 ? 4 + Math.floor(random() * 3) : Math.floor(random() * 4);
    plants.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${colorOf(plantColors[colorIndex])}" stroke="rgba(30,70,30,0.55)" stroke-width="1"/>`);
    placed++;
  }
  for (let attempt = 0, placed = 0, wanted = Math.round(between(5, 13)); attempt < 300 && placed < wanted; attempt++) {
    const onLawnEdge = random() < 0.25;
    const base = onLawnEdge ? lawn[Math.floor(random() * lawn.length)] : { x: between(box.left, box.right), y: between(box.top, box.bottom) };
    const radius = between(20, 46);
    if (!insideGarden(base) || inHardscape(base, radius * 0.6) || (!onLawnEdge && inLawn(base))) continue;
    shadows.push(`<circle cx="${(base.x + 10).toFixed(1)}" cy="${(base.y + 12).toFixed(1)}" r="${radius.toFixed(1)}" fill="rgba(20,40,20,0.35)"/>`);
    trees.push(`<circle cx="${base.x.toFixed(1)}" cy="${base.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${colorOf([64 + between(0, 30), 118 + between(0, 30), 52 + between(0, 20)])}" stroke="rgba(25,60,25,0.8)" stroke-width="2"/><circle cx="${(base.x - radius * 0.2).toFixed(1)}" cy="${(base.y - radius * 0.2).toFixed(1)}" r="${(radius * 0.55).toFixed(1)}" fill="rgba(160,205,110,0.45)"/>`);
    placed++;
  }
  parts.push('<defs><filter id="blur"><feGaussianBlur stdDeviation="5"/></filter></defs>');
  parts.push(`<g filter="url(#blur)">${shadows.join('')}</g>`, plants.join(''), trees.join(''));

  // stapstenen over het gazon
  if (random() < 0.5) {
    const startAt = lawn[Math.floor(random() * lawn.length)], endAt = lawn[Math.floor(random() * lawn.length)];
    for (let step = 0; step <= 8; step++) {
      const point = { x: startAt.x + (endAt.x - startAt.x) * (step / 8), y: startAt.y + (endAt.y - startAt.y) * (step / 8) };
      if (insideGarden(point) && !inHardscape(point, 10)) parts.push(`<rect x="${(point.x - 15).toFixed(1)}" y="${(point.y - 9).toFixed(1)}" width="30" height="18" rx="3" fill="rgb(190,190,190)" stroke="rgb(90,90,90)" stroke-width="1.5"/>`);
    }
  }

  // tekstlabels met geleiderlijnen buiten de tuin, titelblok en logo
  const labelCount = Math.round(between(6, 13));
  for (let index = 0; index < labelCount; index++) {
    const word = LABEL_WORDS[Math.floor(random() * LABEL_WORDS.length)];
    const onLeft = random() < 0.5;
    const y = between(box.top, box.bottom);
    const target = { x: onLeft ? box.left + between(20, 140) : box.right - between(20, 140), y: Math.max(box.top + 10, Math.min(box.bottom - 10, y + between(-60, 60))) };
    const textX = onLeft ? box.left - 150 : box.right + 20;
    parts.push(`<path d="M${(onLeft ? textX + 120 : textX - 4).toFixed(1)},${y.toFixed(1)} L${target.x.toFixed(1)},${target.y.toFixed(1)}" stroke="rgb(40,40,40)" stroke-width="1" fill="none"/>`);
    parts.push(`<text x="${textX.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, sans-serif" font-size="${between(10, 13).toFixed(1)}" fill="rgb(25,25,25)">${word}</text>`);
  }
  for (let line = 0; line < 6; line++) parts.push(`<text x="${(box.left - 150).toFixed(1)}" y="${(height - 120 + line * 14).toFixed(1)}" font-family="Arial, sans-serif" font-size="10" fill="rgb(40,40,40)">${['Tuinontwerp particuliere tuin', 'Ontwerp: Voorbeeld Tuinen', `Schaal 1:100 – tekening ${seed}`, 'Datum: 13-11-2026', 'Opdrachtgever: familie Voorbeeld', 'Getekend voor beregeningstest'][line]}</text>`);
  parts.push(`<g transform="translate(${width - 210},${height - 130})"><path d="M0,0 L70,0 L70,60 L0,60 Z" fill="rgb(238,128,36)"/><path d="M20,10 L60,10 L60,50 Z" fill="rgb(40,120,190)"/><text x="0" y="80" font-family="Arial, sans-serif" font-size="12" fill="rgb(40,40,40)">Voorbeeld Tuinen</text></g>`);

  if (style === 'scan') {
    parts.push(`<defs><linearGradient id="light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(255,255,255)"/><stop offset="1" stop-color="rgb(196,190,180)"/></linearGradient>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed}"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.5 0"/></filter></defs>
      <rect width="${width}" height="${height}" fill="url(#light)" style="mix-blend-mode:multiply"/><rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.25"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
  const truth = {
    seed, style, shape: outline.kind, width, height, metersPerPixel: 1 / PIXELS_PER_METER,
    areas: areas.map((area) => ({ ...area, points: area.points.map((point) => ({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 })) })),
    elements,
  };
  return { svg, width, height, truth, style, blur: style === 'scan' ? 1.1 : 0 };
}

/**
 * Rasteriseert plannen naar PNG met Chromium (Playwright) en schrijft naam.png + naam.json in een map.
 * @param {string} directory De doelmap.
 * @param {number} count Aantal plannen.
 * @param {number} firstSeed Seed van het eerste plan.
 * @returns {Promise<string[]>} De namen (zonder extensie).
 */
async function writePlans(directory, count, firstSeed) {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch();
  const names = [];
  try {
    for (let index = 0; index < count; index++) {
      const seed = firstSeed + index;
      const plan = buildPlan(seed, { style: index % 2 === 0 ? 'digitaal' : 'scan' });
      const page = await browser.newPage({ viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: 1 });
      await page.setContent(`<html><body style="margin:0;background:#fff"><div style="filter:blur(${plan.blur}px)">${plan.svg}</div></body></html>`);
      const name = `plan-${String(seed).padStart(3, '0')}-${plan.style}`;
      fs.writeFileSync(path.join(directory, `${name}.png`), await page.screenshot({ type: 'png' }));
      fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(plan.truth));
      await page.close();
      names.push(name);
    }
  } finally {
    await browser.close();
  }
  return names;
}

module.exports = { buildPlan, createRandom, writePlans, PIXELS_PER_METER };

if (require.main === module) {
  const [target, count, firstSeed] = process.argv.slice(2);
  if (!target) {
    console.error('Gebruik: node tools/plan-generator.js <doelmap> [aantal] [eerste-seed]');
    process.exit(2);
  }
  writePlans(path.resolve(target), Number(count) || 10, Number(firstSeed) || 1)
    .then((names) => console.log(`${names.length} plannen geschreven naar ${path.resolve(target)}`))
    .catch((error) => { console.error(`Genereren mislukt: ${error.message}`); process.exit(1); });
}
