// Rekenkern van de werkregistratie: de uren en het materiaalverbruik die de
// ploeg op een werkorder boekt. Gedeeld door de browser (formulier, totalen,
// Excel) en de server (opschonen en controleren, zie backend/src/worklog.js).
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

  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
  const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const isClientId = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

  /** Minuten tussen begin en eind min de pauze (over middernacht telt door). */
  function minutesBetween(start, end, pause = 0) {
    if (!isTime(start) || !isTime(end)) return 0;
    let m = toMin(end) - toMin(start);
    if (m <= 0) m += 24 * 60;
    return Math.max(0, m - (Number(pause) || 0));
  }

  const hoursText = (min) => {
    const m = Math.round(Number(min) || 0);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  };

  /**
   * Urenregel opschonen. Met begin- en eindtijd volgen de minuten daaruit,
   * anders telt het ingevulde aantal uren (hours) of minuten.
   * Geeft { entry } of { error } (Nederlandse melding).
   */
  function cleanHours(input) {
    const d = input && typeof input === 'object' ? input : {};
    const startTime = isTime(d.startTime) ? d.startTime : '';
    const endTime = isTime(d.endTime) ? d.endTime : '';
    const breakMinutes = Math.round(Math.min(MAX_MINUTES, Math.max(0, Number(d.breakMinutes) || 0)));
    let minutes;
    if (startTime && endTime) minutes = minutesBetween(startTime, endTime, breakMinutes);
    else if (d.hours !== undefined && d.hours !== null && d.hours !== '') minutes = Math.round((Number(String(d.hours).replace(',', '.')) || 0) * 60);
    else minutes = Math.round(Number(d.minutes) || 0);
    const entry = {
      workDate: isDate(d.workDate) ? d.workDate : '',
      startTime: startTime && endTime ? startTime : '',
      endTime: startTime && endTime ? endTime : '',
      breakMinutes: startTime && endTime ? breakMinutes : 0,
      minutes,
      kind: KINDS[d.kind] ? d.kind : 'werk',
      stepId: str(d.stepId, 40),
      note: str(d.note, 500).trim(),
    };
    if (!entry.workDate) return { error: 'Vul een geldige datum in.' };
    if (!(minutes > 0)) return { error: 'Vul de begin- en eindtijd of het aantal uren in.' };
    if (minutes > MAX_MINUTES) return { error: 'Meer dan 24 uur op één dag kan niet.' };
    return { entry };
  }

  /** Verbruiksregel opschonen: { entry } of { error }. */
  function cleanMaterial(input) {
    const d = input && typeof input === 'object' ? input : {};
    const qty = round2(String(d.qty == null ? '' : d.qty).replace(',', '.'));
    const entry = {
      usedOn: isDate(d.usedOn) ? d.usedOn : '',
      code: str(d.code, 40).trim(),
      description: str(d.description, 500).trim(),
      unit: str(d.unit, 12).trim(),
      qty,
      materialId: str(d.materialId, 40),
      note: str(d.note, 500).trim(),
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
   */
  function totals(data, hours, materials) {
    const d = data || {};
    const steps = d.steps || [];
    const byKind = {};
    const byUser = {};
    let minutes = 0;
    for (const h of hours || []) {
      minutes += h.minutes;
      byKind[h.kind] = (byKind[h.kind] || 0) + h.minutes;
      const name = (h.user && h.user.displayName) || '–';
      byUser[name] = (byUser[name] || 0) + h.minutes;
    }
    const plannedHours = round2(steps.reduce((s, x) => s + (Number(x.hours) || 0), 0));
    const keyOf = (m) => (m.code ? `c:${m.code.toLowerCase()}` : `d:${String(m.description || '').trim().toLowerCase()}`);
    const map = new Map();
    for (const m of d.materials || []) {
      const k = keyOf(m);
      const row = map.get(k) || { code: m.code, description: m.description, unit: m.unit, planned: 0, used: 0, extra: false };
      row.planned = round2(row.planned + (Number(m.qty) || 0));
      map.set(k, row);
    }
    for (const m of materials || []) {
      const k = keyOf(m);
      let row = map.get(k);
      if (!row) { row = { code: m.code, description: m.description, unit: m.unit, planned: 0, used: 0, extra: true }; map.set(k, row); }
      row.used = round2(row.used + (Number(m.qty) || 0));
    }
    const mats = [...map.values()].map((r) => ({ ...r, diff: round2(r.used - r.planned) }));
    return {
      minutes, hours: round2(minutes / 60), plannedHours, byKind, byUser,
      materials: mats, extraMaterials: mats.filter((m) => m.extra).length,
    };
  }

  const api = { KINDS, MAX_MINUTES, MAX_ENTRIES, isDate, isTime, isClientId, minutesBetween, hoursText, cleanHours, cleanMaterial, totals };
  root.WorkLogCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
