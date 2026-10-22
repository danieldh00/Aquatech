// Rekenkern van de werkregistratie: de uren en het materiaalverbruik die de
// ploeg op een werkorder boekt. Gedeeld door de browser (formulier, totalen,
// Excel) en de server (opschonen en controleren, zie backend/src/uitvoering/worklog.js).
// Geen afhankelijkheden.
//
// Een regel heeft een clientId (UUID uit de browser): dezelfde regel twee keer
// versturen (geen netwerk, opnieuw proberen, later synchroniseren) levert één
// regel op. Materiaalverbruik is de basis voor het afboeken van voorraad:
// positief = verbruikt, negatief = retour.
(function (root) {
  const KINDS = { werk: 'Werk', reistijd: 'Reistijd', meerwerk: 'Meerwerk' };
  const MAX_MINUTES = 24 * 60;
  const MAX_ENTRIES = 1000;

  /**
   * Maakt van een waarde tekst van hoogstens max tekens.
   * @param {*} value De waarde (null/undefined = leeg).
   * @param {number} max Maximaal aantal tekens.
   * @returns {string} De ingekorte tekst.
   */
  const limitText = (value, max) => String(value == null ? '' : value).slice(0, max);
  /**
   * Rondt af op twee decimalen.
   * @param {*} value Getal of tekst met een getal.
   * @returns {number} Het afgeronde getal (0 als het geen getal is).
   */
  const roundTwoDecimals = (value) => Math.round((Number(value) || 0) * 100) / 100;
  /**
   * Geeft aan of een waarde een geldige datum JJJJ-MM-DD is.
   * @param {*} value De waarde.
   * @returns {boolean} true bij een geldige datum.
   */
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
  /**
   * Geeft aan of een waarde een geldige tijd UU:MM is.
   * @param {*} value De waarde.
   * @returns {boolean} true bij een geldige tijd.
   */
  const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  /**
   * Geeft aan of een waarde een geldig clientId is (8–64 letters, cijfers of streepjes).
   * @param {*} value De waarde.
   * @returns {boolean} true bij een geldig clientId.
   */
  const isClientId = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value);
  /**
   * Zet een tijd UU:MM om naar minuten sinds middernacht.
   * @param {string} time Tijd als UU:MM.
   * @returns {number} Minuten.
   */
  const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

  /**
   * Minuten tussen begin en eind min de pauze (over middernacht telt door).
   * @param {string} start Begintijd UU:MM.
   * @param {string} end Eindtijd UU:MM.
   * @param {number} [pause] Pauze in minuten.
   * @returns {number} Minuten (0 bij een ongeldige tijd).
   */
  function minutesBetween(start, end, pause = 0) {
    if (!isTime(start) || !isTime(end)) return 0;
    let minutes = toMinutes(end) - toMinutes(start);
    if (minutes <= 0) minutes += 24 * 60;
    return Math.max(0, minutes - (Number(pause) || 0));
  }

  /**
   * Minuten als uren:minuten.
   * @param {number} minutes Aantal minuten.
   * @returns {string} Bijv. "7:30".
   */
  const hoursText = (minutes) => {
    const rounded = Math.round(Number(minutes) || 0);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  };

  /**
   * Urenregel opschonen. Met begin- en eindtijd volgen de minuten daaruit,
   * anders telt het ingevulde aantal uren (hours) of minuten.
   * Geeft { entry } of { error } (Nederlandse melding).
   * @param {object} input Ingevulde urenregel.
   * @returns {{entry: object}|{error: string}} De opgeschoonde regel of de foutmelding.
   */
  function cleanHours(input) {
    const fields = input && typeof input === 'object' ? input : {};
    const startTime = isTime(fields.startTime) ? fields.startTime : '';
    const endTime = isTime(fields.endTime) ? fields.endTime : '';
    const breakMinutes = Math.round(Math.min(MAX_MINUTES, Math.max(0, Number(fields.breakMinutes) || 0)));
    let minutes;
    if (startTime && endTime) minutes = minutesBetween(startTime, endTime, breakMinutes);
    else if (fields.hours !== undefined && fields.hours !== null && fields.hours !== '') minutes = Math.round((Number(String(fields.hours).replace(',', '.')) || 0) * 60);
    else minutes = Math.round(Number(fields.minutes) || 0);
    const entry = {
      workDate: isDate(fields.workDate) ? fields.workDate : '',
      startTime: startTime && endTime ? startTime : '',
      endTime: startTime && endTime ? endTime : '',
      breakMinutes: startTime && endTime ? breakMinutes : 0,
      minutes,
      kind: KINDS[fields.kind] ? fields.kind : 'werk',
      stepId: limitText(fields.stepId, 40),
      note: limitText(fields.note, 500).trim(),
    };
    if (!entry.workDate) return { error: 'Vul een geldige datum in.' };
    if (!(minutes > 0)) return { error: 'Vul de begin- en eindtijd of het aantal uren in.' };
    if (minutes > MAX_MINUTES) return { error: 'Meer dan 24 uur op één dag kan niet.' };
    return { entry };
  }

  /**
   * Verbruiksregel opschonen.
   * @param {object} input Ingevulde verbruiksregel (positief = verbruikt, negatief = retour).
   * @returns {{entry: object}|{error: string}} De opgeschoonde regel of de foutmelding.
   */
  function cleanMaterial(input) {
    const fields = input && typeof input === 'object' ? input : {};
    const qty = roundTwoDecimals(String(fields.qty == null ? '' : fields.qty).replace(',', '.'));
    const entry = {
      usedOn: isDate(fields.usedOn) ? fields.usedOn : '',
      code: limitText(fields.code, 40).trim(),
      description: limitText(fields.description, 500).trim(),
      unit: limitText(fields.unit, 12).trim(),
      qty,
      materialId: limitText(fields.materialId, 40),
      note: limitText(fields.note, 500).trim(),
    };
    if (!entry.usedOn) return { error: 'Vul een geldige datum in.' };
    if (!entry.description && !entry.code) return { error: 'Kies een materiaal of vul een omschrijving in.' };
    if (!qty || Math.abs(qty) > 100000) return { error: 'Vul een aantal in (negatief voor retour).' };
    return { entry };
  }

  /**
   * Totalen voor de werkorder: uren per soort en per medewerker naast de
   * geplande uren, en per materiaal gepland tegenover verbruikt (op code, of
   * op omschrijving als er geen code is). data = werkorderdata (steps,
   * materials); hours/materials = de geboekte regels.
   * @param {object} data Werkorderdata (steps, materials).
   * @param {object[]} hours De geboekte urenregels.
   * @param {object[]} materials De geboekte verbruiksregels.
   * @returns {object} { minutes, hours, plannedHours, byKind, byUser, materials, extraMaterials }.
   */
  function totals(data, hours, materials) {
    const workOrderData = data || {};
    const steps = workOrderData.steps || [];
    const byKind = {};
    const byUser = {};
    let minutes = 0;
    for (const entry of hours || []) {
      minutes += entry.minutes;
      byKind[entry.kind] = (byKind[entry.kind] || 0) + entry.minutes;
      const name = (entry.user && entry.user.displayName) || '–';
      byUser[name] = (byUser[name] || 0) + entry.minutes;
    }
    const plannedHours = roundTwoDecimals(steps.reduce((sum, step) => sum + (Number(step.hours) || 0), 0));
    /**
     * Sleutel om gepland en verbruikt materiaal bij elkaar te zoeken: de code, of anders de omschrijving.
     * @param {object} material Materiaalregel.
     * @returns {string} De sleutel.
     */
    const keyOf = (material) => (material.code ? `c:${material.code.toLowerCase()}` : `d:${String(material.description || '').trim().toLowerCase()}`);
    const map = new Map();
    for (const material of workOrderData.materials || []) {
      const key = keyOf(material);
      const row = map.get(key) || { code: material.code, description: material.description, unit: material.unit, planned: 0, used: 0, extra: false };
      row.planned = roundTwoDecimals(row.planned + (Number(material.qty) || 0));
      map.set(key, row);
    }
    for (const material of materials || []) {
      const key = keyOf(material);
      let row = map.get(key);
      if (!row) { row = { code: material.code, description: material.description, unit: material.unit, planned: 0, used: 0, extra: true }; map.set(key, row); }
      row.used = roundTwoDecimals(row.used + (Number(material.qty) || 0));
    }
    const materialRows = [...map.values()].map((row) => ({ ...row, diff: roundTwoDecimals(row.used - row.planned) }));
    return {
      minutes, hours: roundTwoDecimals(minutes / 60), plannedHours, byKind, byUser,
      materials: materialRows, extraMaterials: materialRows.filter((row) => row.extra).length,
    };
  }

  const api = { KINDS, MAX_MINUTES, MAX_ENTRIES, isDate, isTime, isClientId, minutesBetween, hoursText, cleanHours, cleanMaterial, totals };
  root.WorkLogCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
