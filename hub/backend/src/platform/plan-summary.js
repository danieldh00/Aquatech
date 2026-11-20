// Samenvatting van een plan voor de historie en overzichten (vlakken, m2, titel, plan zonder achtergrond).

/**
 * Oppervlakte van een veelhoek (schoenveterformule).
 * @param {{ x: number, y: number }[]} points De hoekpunten.
 * @returns {number} De oppervlakte (0 bij minder dan 3 punten).
 */
function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let doubleArea = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i], next = points[(i + 1) % points.length];
    doubleArea += (Number(current?.x) || 0) * (Number(next?.y) || 0) - (Number(next?.x) || 0) * (Number(current?.y) || 0);
  }
  return Math.abs(doubleArea) / 2;
}


/**
 * Samenvatting van een plan voor de historie en overzichten: aantal vlakken,
 * m² per type en in totaal, en aantallen sproeiers, zones en elementen.
 * @param {object} data Het plan (of een jsonDigest met al getelde aantallen).
 * @returns {{ areas: number, totalM2: number, m2ByType: object, sprinklers: number, zones: number, elements: number }} De samenvatting.
 */
function summarize(data) {
  const areas = Array.isArray(data?.areas) ? data.areas : [];
  const m2ByType = {};
  for (const area of areas) {
    const type = String(area?.type || 'onbekend');
    m2ByType[type] = (m2ByType[type] || 0) + polygonArea(area?.pts);
  }
  /**
   * Rondt af op één decimaal.
   * @param {number} value Het getal.
   * @returns {number} Het afgeronde getal.
   */
  const round = (value) => Math.round(value * 10) / 10;
  for (const type of Object.keys(m2ByType)) m2ByType[type] = round(m2ByType[type]);
  /**
   * Aantal elementen van een lijst in het plan (of een al getelde waarde).
   * @param {string} field Naam van de lijst.
   * @returns {number} Het aantal.
   */
  const count = (field) => (Array.isArray(data?.[field]) ? data[field].length : Number.isFinite(data?.[field]) ? data[field] : 0);
  return {
    areas: areas.length,
    totalM2: round(Object.values(m2ByType).reduce((sum, value) => sum + value, 0)),
    m2ByType,
    sprinklers: count('sprinklers'),
    zones: count('zones'),
    elements: count('elements'),
  };
}

/**
 * Titel, klant en adres van een plan (uit data.meta).
 * @param {object} data Het plan.
 * @returns {{ title: string, customer: string, address: string }} De gegevens.
 */
function metaOf(data) {
  const meta = (data && typeof data.meta === 'object' && data.meta) || {};
  /**
   * Nette tekst van een waarde, ingekort.
   * @param {*} value De waarde.
   * @param {number} maxLength Maximaal aantal tekens.
   * @returns {string} De tekst.
   */
  const cleanText = (value, maxLength) => String(value == null ? '' : value).trim().slice(0, maxLength);
  return {
    title: cleanText(meta.name, 200) || 'Naamloos plan',
    customer: cleanText(meta.customer, 200),
    address: cleanText(meta.address, 300),
  };
}

/**
 * Het plan zonder achtergrond (foto/PDF van de tekening kan megabytes groot
 * zijn; die hoort bij het plan, maar niet in elke historieregel).
 * @param {object} data Het plan.
 * @returns {object} Het plan zonder het veld background.
 */
function withoutBackground(data) {
  const { background, ...rest } = data || {};
  return rest;
}

module.exports = { summarize, metaOf, withoutBackground };
