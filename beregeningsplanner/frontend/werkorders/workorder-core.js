// Rekenkern van de werkorders: opschonen, voortgang, en het opbouwen van een
// werkorder uit een geaccordeerde offerte (materialen, werkstappen met uren)
// plus, als het plan erbij komt, de zone-indeling uit de beregeningsplanner.
// Gedeeld door de module Werkorders in de browser en de server. Geen
// afhankelijkheden: de plannerbibliotheken (Catalog, Hydraulics) komen als
// argument binnen.
(function (root) {
  const STATUSES = { open: 'Nieuw', gepland: 'Gepland', bezig: 'In uitvoering', gereed: 'Gereed', geannuleerd: 'Geannuleerd' };
  const PHASES = { voorbereiding: 'Voorbereiding', uitvoering: 'Uitvoering', oplevering: 'Oplevering' };
  // Stand van de afspraak met de klant (klantlink): geen datum, nog niet
  // gedeeld, wacht op de klant, bevestigd of klant vraagt een ander moment.
  const APPOINTMENT = {
    geen: 'Geen datum', niet_gedeeld: 'Niet naar de klant', wacht: 'Wacht op klant',
    bevestigd: 'Bevestigd door klant', ander_moment: 'Klant vraagt ander moment',
  };
  const MAX_DAYS = 20;
  const MAX_ITEMS = 400;

  /**
   * Rondt af op twee decimalen.
   * @param {*} value Getal of tekst met een getal.
   * @returns {number} Het afgeronde getal (0 als het geen getal is).
   */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  /**
   * Maakt van een waarde tekst van hoogstens max tekens.
   * @param {*} value De waarde (null/undefined = leeg).
   * @param {number} max Maximaal aantal tekens.
   * @returns {string} De ingekorte tekst.
   */
  const limitText = (value, max) => String(value == null ? '' : value).slice(0, max);
  /**
   * Getal begrensd tussen min en max.
   * @param {*} value De invoer.
   * @param {number} min Ondergrens.
   * @param {number} max Bovengrens.
   * @param {number} [fallback] Waarde als de invoer geen getal is.
   * @returns {number} Het begrensde getal.
   */
  const clampNumber = (value, min, max, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  /**
   * Geeft aan of een waarde een datum JJJJ-MM-DD is.
   * @param {*} value De waarde.
   * @returns {boolean} true bij een datum.
   */
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  /**
   * Geeft aan of een waarde een geldige tijd UU:MM is.
   * @param {*} value De waarde.
   * @returns {boolean} true bij een geldige tijd.
   */
  const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  /**
   * Kort willekeurig id voor een regel.
   * @returns {string} 8 letters/cijfers.
   */
  const randomId = () => Math.random().toString(36).slice(2, 10);

  /**
   * Maakt van willekeurige invoer een geldige werkstap.
   * @param {object} step De stap.
   * @returns {object} { id, phase, title, details, hours, actualHours, done }.
   */
  function sanitizeStep(step) {
    step = step && typeof step === 'object' ? step : {};
    return {
      id: limitText(step.id, 40) || randomId(),
      phase: PHASES[step.phase] ? step.phase : 'uitvoering',
      title: limitText(step.title, 300),
      details: limitText(step.details, 2000),
      hours: round2(clampNumber(step.hours, 0, 10000)),
      actualHours: step.actualHours === null || step.actualHours === undefined || step.actualHours === '' ? null : round2(clampNumber(step.actualHours, 0, 10000)),
      done: Boolean(step.done),
    };
  }

  /**
   * Maakt van willekeurige invoer een geldige materiaalregel.
   * @param {object} material De regel.
   * @returns {object} { id, code, description, qty, unit, picked }.
   */
  function sanitizeMaterial(material) {
    material = material && typeof material === 'object' ? material : {};
    return {
      id: limitText(material.id, 40) || randomId(),
      code: limitText(material.code, 40).trim(),
      description: limitText(material.description, 500),
      qty: round2(clampNumber(material.qty, -1e6, 1e6)),
      unit: limitText(material.unit, 12).trim(),
      picked: Boolean(material.picked),
    };
  }

  /**
   * Maakt van willekeurige invoer een geldige zone (uit de zone-indeling).
   * @param {object} zone De zone.
   * @returns {object} { name, kind, parts, flowLph, pipeM, pressureBar, requiredBar, ok }.
   */
  function sanitizeZone(zone) {
    zone = zone && typeof zone === 'object' ? zone : {};
    return {
      name: limitText(zone.name, 60),
      kind: limitText(zone.kind, 60),
      parts: limitText(zone.parts, 400),
      flowLph: Math.round(clampNumber(zone.flowLph, 0, 1e6)),
      pipeM: round2(clampNumber(zone.pipeM, 0, 1e5)),
      pressureBar: round2(clampNumber(zone.pressureBar, -100, 100)),
      requiredBar: round2(clampNumber(zone.requiredBar, 0, 100)),
      ok: zone.ok !== false,
    };
  }

  /**
   * Maakt van willekeurige invoer een geldige afstelling van een kop.
   * @param {object} head De kop.
   * @returns {object} { nr, zone, kind, nozzle, body, sector, arc, r, left, leftText, x, y }.
   */
  function sanitizeHead(head) {
    head = head && typeof head === 'object' ? head : {};
    return {
      nr: Math.round(clampNumber(head.nr, 0, 1e5)),
      zone: limitText(head.zone, 60),
      kind: limitText(head.kind, 60),
      nozzle: limitText(head.nozzle, 60),
      body: limitText(head.body, 120),
      sector: limitText(head.sector, 20),
      arc: Math.round(clampNumber(head.arc, 0, 360)),
      r: round2(clampNumber(head.r, 0, 100)),
      left: Math.round(clampNumber(head.left, 0, 360)),
      leftText: limitText(head.leftText, 40),
      x: round2(clampNumber(head.x, -1e5, 1e5)),
      y: round2(clampNumber(head.y, -1e5, 1e5)),
    };
  }

  const DIRS = ['rechts', 'rechtsonder', 'onder', 'linksonder', 'links', 'linksboven', 'boven', 'rechtsboven'];
  /**
   * Richting op de tekening (0° = rechts, met de klok mee).
   * @param {number} deg Hoek in graden.
   * @returns {string} Bijv. "90° (onder)".
   */
  function dirText(deg) {
    const degrees = ((Math.round(deg) % 360) + 360) % 360;
    return `${degrees}° (${DIRS[Math.round(degrees / 45) % 8]})`;
  }

  /**
   * Maakt van willekeurige invoer een geldige werkorder.
   * @param {object} data De werkordergegevens.
   * @returns {object} De opgeschoonde werkordergegevens.
   */
  function sanitize(data) {
    const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const customer = fields.customer && typeof fields.customer === 'object' ? fields.customer : {};
    const design = fields.design && typeof fields.design === 'object' ? fields.design : null;
    const report = fields.report && typeof fields.report === 'object' ? fields.report : {};
    /**
     * Schoont een lijst op (hoogstens MAX_ITEMS).
     * @param {*} value De lijst.
     * @param {Function} cleanItem Schoont één item op.
     * @returns {object[]} De opgeschoonde lijst.
     */
    const cleanList = (value, cleanItem) => (Array.isArray(value) ? value : []).slice(0, MAX_ITEMS).map(cleanItem);
    return {
      title: limitText(fields.title, 200),
      quoteId: limitText(fields.quoteId, 64),
      quoteNumber: limitText(fields.quoteNumber, 40),
      planId: limitText(fields.planId, 64),
      planTitle: limitText(fields.planTitle, 200),
      customer: {
        name: limitText(customer.name, 200),
        contact: limitText(customer.contact, 200),
        address: limitText(customer.address, 400),
        email: limitText(customer.email, 200),
        phone: limitText(customer.phone, 40),
      },
      plannedDate: isDate(fields.plannedDate) ? fields.plannedDate : '',
      startTime: isTime(fields.startTime) ? fields.startTime : '',
      endTime: isTime(fields.endTime) ? fields.endTime : '',
      days: Math.round(clampNumber(fields.days, 1, MAX_DAYS, 1)),
      crew: limitText(fields.crew, 200),
      instructions: limitText(fields.instructions, 4000),
      siteNotes: limitText(fields.siteNotes, 2000),
      design: design ? {
        lawnM2: round2(clampNumber(design.lawnM2, 0, 1e7)),
        sprinklers: Math.round(clampNumber(design.sprinklers, 0, 1e5)),
        zones: Math.round(clampNumber(design.zones, 0, 1e4)),
        pressureBar: round2(clampNumber(design.pressureBar, 0, 100)),
        flowM3h: round2(clampNumber(design.flowM3h, 0, 1000)),
        mainPipe: limitText(design.mainPipe, 40),
        level: limitText(design.level, 40),
      } : null,
      zones: cleanList(fields.zones, sanitizeZone).slice(0, 100),
      heads: (Array.isArray(fields.heads) ? fields.heads : []).slice(0, 1000).map(sanitizeHead),
      steps: cleanList(fields.steps, sanitizeStep),
      materials: cleanList(fields.materials, sanitizeMaterial),
      report: {
        notes: limitText(report.notes, 4000),
        completedOn: isDate(report.completedOn) ? report.completedOn : '',
        signedBy: limitText(report.signedBy, 200),
      },
    };
  }

  /**
   * Korte omschrijving van het werk voor de planning: de eerste regel van de
   * instructies, anders de omvang (zones, sproeiers, gazon) plus de
   * uitvoeringsstappen. Ingekort tot max tekens.
   * @param {object} data De werkordergegevens.
   * @param {number} [max] Maximaal aantal tekens.
   * @returns {string} De omschrijving.
   */
  function summary(data, max = 160) {
    const workOrderData = sanitize(data);
    /**
     * Kort een tekst in tot max tekens (met … aan het eind).
     * @param {string} text De tekst.
     * @returns {string} De ingekorte tekst.
     */
    const shorten = (text) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
    const first = workOrderData.instructions.split(/\n+/).map((line) => line.trim()).find(Boolean);
    if (first) return shorten(first);
    const design = workOrderData.design;
    const facts = design ? [
      design.zones ? `${design.zones} zone${design.zones === 1 ? '' : 's'}` : '',
      design.sprinklers ? `${design.sprinklers} sproeier${design.sprinklers === 1 ? '' : 's'}` : '',
      design.lawnM2 ? `${Math.round(design.lawnM2)} m² gazon` : '',
    ].filter(Boolean).join(', ') : '';
    const work = workOrderData.steps.filter((step) => step.phase === 'uitvoering' && step.title).map((step) => step.title);
    return shorten([facts, [...new Set(work)].join(', ')].filter(Boolean).join(': '));
  }

  // ---------- Planning ----------
  /**
   * Getal met een voorloopnul tot twee cijfers.
   * @param {number} number Het getal.
   * @returns {string} Bijv. "07".
   */
  const padTwo = (number) => String(number).padStart(2, '0');
  /**
   * Datum als JJJJ-MM-DD (UTC).
   * @param {Date} moment De datum.
   * @returns {string} De datum.
   */
  const isoDate = (moment) => `${moment.getUTCFullYear()}-${padTwo(moment.getUTCMonth() + 1)}-${padTwo(moment.getUTCDate())}`;
  /**
   * Datum (JJJJ-MM-DD) plus een aantal kalenderdagen.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @param {number} count Aantal dagen.
   * @returns {string} De nieuwe datum.
   */
  function addDays(date, count) {
    const moment = new Date(`${date}T00:00:00Z`);
    moment.setUTCDate(moment.getUTCDate() + count);
    return isoDate(moment);
  }
  /**
   * Dag van de week van een datum.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {number} 0 = zondag … 6 = zaterdag.
   */
  const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

  /**
   * De werkdagen van een klus: vanaf de geplande datum `days` werkdagen
   * (maandag t/m vrijdag; een start in het weekend telt zelf wel mee).
   * @param {string} date Geplande datum (JJJJ-MM-DD).
   * @param {number} [days] Aantal werkdagen.
   * @returns {string[]} De datums.
   */
  function workDays(date, days = 1) {
    if (!isDate(date)) return [];
    const count = Math.round(clampNumber(days, 1, MAX_DAYS, 1));
    const out = [date];
    let current = date;
    while (out.length < count) {
      current = addDays(current, 1);
      const weekdayNumber = weekdayOf(current);
      if (weekdayNumber !== 0 && weekdayNumber !== 6) out.push(current);
    }
    return out;
  }

  /**
   * Het afgesproken moment: wat de klant bevestigt. Gelijk moment = gelijke sleutel.
   * @param {object} fields Werkordergegevens (plannedDate, startTime, endTime, days).
   * @returns {{date: string, startTime: string, endTime: string, days: number}} Het moment.
   */
  function moment(fields) {
    fields = fields || {};
    return { date: isDate(fields.plannedDate) ? fields.plannedDate : '', startTime: isTime(fields.startTime) ? fields.startTime : '',
      endTime: isTime(fields.endTime) ? fields.endTime : '', days: Math.round(clampNumber(fields.days, 1, MAX_DAYS, 1)) };
  }
  /**
   * Sleutel van een moment, om te zien of een reactie van de klant nog geldt.
   * @param {object} appointment Uitkomst van moment().
   * @returns {string} Bijv. "2026-10-22|08:00|12:00|1".
   */
  const momentKey = (appointment) => [appointment.date, appointment.startTime, appointment.endTime, appointment.days].join('|');

  // Lengte van een werkdag op de bouwplaats (uren), voor het verdelen van de
  // geplande uren uit de offerte over de dagen.
  const WORKDAY_HOURS = 8;
  /**
   * Tijd UU:MM als minuten sinds middernacht.
   * @param {string} time De tijd.
   * @returns {number|null} Minuten, of null bij een ongeldige tijd.
   */
  const minutesOf = (time) => (isTime(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null);
  /**
   * Minuten sinds middernacht als tijd UU:MM.
   * @param {number} minutes Aantal minuten.
   * @returns {string} De tijd.
   */
  const timeOfMinutes = (minutes) => `${padTwo(Math.floor(minutes / 60))}:${padTwo(minutes % 60)}`;

  /**
   * Blok uit de geplande uren: vanaf de starttijd zoveel uur, en meer dan een
   * werkdag verdeeld over zoveel werkdagen dat elke dag even lang is (12 uur
   * vanaf 08:00 = 2 dagen 08:00–14:00). Geeft { endTime, days } of null
   * (geen starttijd of geen uren).
   * @param {string} startTime Starttijd UU:MM.
   * @param {number} hours Geplande uren.
   * @param {number} [dayHours] Lengte van een werkdag in uren.
   * @returns {{endTime: string, days: number}|null} Eindtijd en aantal werkdagen.
   */
  function fitHours(startTime, hours, dayHours = WORKDAY_HOURS) {
    const startMinutes = minutesOf(startTime);
    const totalHours = Number(hours) || 0;
    if (startMinutes == null || totalHours <= 0) return null;
    const days = Math.min(MAX_DAYS, Math.max(1, Math.ceil(totalHours / dayHours - 1e-9)));
    const minutesPerDay = Math.max(15, Math.round(((totalHours / days) * 60) / 15) * 15);
    return { endTime: timeOfMinutes(Math.min(24 * 60 - 1, startMinutes + minutesPerDay)), days };
  }

  /**
   * Voortgang: afgevinkte stappen, uren gepland/werkelijk, verzamelde materialen.
   * @param {object} fields Werkordergegevens (steps, materials).
   * @returns {object} { steps, done, pct, hours, actualHours, materials, picked }.
   */
  function progress(fields) {
    const steps = (fields && fields.steps) || [];
    const materials = (fields && fields.materials) || [];
    const done = steps.filter((step) => step.done).length;
    return {
      steps: steps.length,
      done,
      pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
      hours: round2(steps.reduce((sum, step) => sum + (Number(step.hours) || 0), 0)),
      actualHours: round2(steps.reduce((sum, step) => sum + (Number(step.actualHours) || 0), 0)),
      materials: materials.length,
      picked: materials.filter((material) => material.picked).length,
    };
  }

  // Volgorde op de bouwplaats: eerst de aansluiting en de sleuven, dan de
  // ventielkast en de koppen, als laatste besturing en inregelen.
  const ORDER = [
    [/wateraansluiting|hoofdafsluiter/i, 1],
    [/sleuv|leiding/i, 2],
    [/ventielkast|ventiel/i, 3],
    [/waterpunt/i, 4],
    [/sproeier|rotor|kop/i, 5],
    [/druppelslang/i, 6],
    [/druppelaar/i, 7],
    [/computer|besturing|stuurkabel/i, 8],
    [/inregel|test|oplever/i, 9],
  ];
  /**
   * Plek van een arbeidsregel in de volgorde op de bouwplaats.
   * @param {string} text Omschrijving van de regel.
   * @returns {number} 1 (eerst) t/m 9 (oplevering); 5,5 als niets past.
   */
  const rank = (text) => {
    for (const [pattern, order] of ORDER) if (pattern.test(text)) return order;
    return 5.5;
  };

  const PLAN_DEFAULTS = {
    pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'rotator', radius: null,
    methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray',
  };
  /**
   * Getal in Nederlandse notatie.
   * @param {number} value Het getal.
   * @param {number} [decimals] Maximaal aantal decimalen.
   * @returns {string} Bijv. "12,5".
   */
  const formatNumber = (value, decimals = 0) => Number(value).toLocaleString('nl-NL', { maximumFractionDigits: decimals });

  /**
   * Zone-indeling uit een plan (zoals de planner die bewaart), voor de ploeg:
   * per zone wat erop zit, het debiet, de leidinglengte en de druk.
   * lib = { Catalog, Hydraulics } uit de beregeningsplanner.
   * @param {object} plan Plangegevens.
   * @param {object} lib { Catalog, Hydraulics } uit de beregeningsplanner.
   * @returns {{zones: object[], design: object|null, heads: object[], warnings: string[]}} Zones, ontwerp, afstelling per kop en waarschuwingen.
   */
  function zonesFromPlan(plan, lib) {
    const { Catalog, Hydraulics } = lib;
    const planState = JSON.parse(JSON.stringify(plan || {}));
    planState.settings = { ...PLAN_DEFAULTS, ...(planState.settings || {}) };
    planState.settings.methods = { ...PLAN_DEFAULTS.methods, ...(planState.settings.methods || {}) };
    for (const key of ['areas', 'elements', 'sprinklers', 'zones']) if (!Array.isArray(planState[key])) planState[key] = [];
    if (!planState.zones.length && Hydraulics.hasIrrigation(planState)) Hydraulics.autoZones(planState);
    if (!planState.zones.length) return { zones: [], design: null, heads: [], warnings: [] };
    const calc = Hydraulics.calculate(planState);
    const zones = [];
    for (const zoneResult of calc.zones) {
      if (zoneResult.empty) continue;
      const sprinklerCounts = {};
      const drip = [];
      for (const member of zoneResult.members) {
        if (member.kind === 'spr') {
          const sprinklerType = Catalog.sprinklerTypes[member.ref.type];
          const label = sprinklerType ? sprinklerType.short || sprinklerType.label : member.ref.type;
          sprinklerCounts[label] = (sprinklerCounts[label] || 0) + 1;
        } else if (member.drip) {
          const areaType = Catalog.areaTypes[member.ref.type];
          const where = areaType ? areaType.label.toLowerCase() : 'beplanting';
          drip.push(member.drip.method === 'drippers'
            ? `${member.drip.count} druppelaars (${where})`
            : `${formatNumber(member.drip.lengthM || 0)} m druppelslang (${where})`);
        }
      }
      const parts = [...Object.entries(sprinklerCounts).map(([label, count]) => `${count}× ${label}`), ...drip];
      const kinds = new Set(zoneResult.members.map((member) => (member.kind === 'spr' ? (member.ref.areaId ? 'Sproeiers in beplanting' : 'Gazon') : 'Druppelirrigatie')));
      zones.push({
        name: zoneResult.zone.name || `Zone ${zones.length + 1}`,
        kind: [...kinds].join(' + '),
        parts: parts.join(', '),
        flowLph: Math.round(zoneResult.q),
        pipeM: round2((zoneResult.edges || []).reduce((sum, edge) => sum + edge.len, 0)),
        pressureBar: round2(zoneResult.critical),
        requiredBar: round2(zoneResult.required),
        ok: zoneResult.ok !== false,
      });
    }
    /**
     * Oppervlakte van een veelhoek (schoenveterformule).
     * @param {Array<{x: number, y: number}>} points De hoekpunten.
     * @returns {number} De oppervlakte (0 bij minder dan 3 punten).
     */
    const polygonArea = (points) => {
      if (!Array.isArray(points) || points.length < 3) return 0;
      let twiceArea = 0;
      for (let i = 0; i < points.length; i++) { const current = points[i], next = points[(i + 1) % points.length]; twiceArea += current.x * next.y - next.x * current.y; }
      return Math.abs(twiceArea) / 2;
    };
    const level = Catalog.levels && Catalog.levels[planState.settings.level];
    const design = {
      lawnM2: round2(planState.areas.filter((shape) => shape.type === 'lawn').reduce((sum, shape) => sum + polygonArea(shape.pts), 0)),
      sprinklers: planState.sprinklers.length,
      zones: zones.length,
      pressureBar: round2(planState.settings.pressure),
      flowM3h: round2(planState.settings.flow),
      mainPipe: calc.mainPipe ? `PE ${calc.mainPipe.dn} mm, ${formatNumber(calc.mainLen, 1)} m` : '',
      level: level ? level.label : '',
    };
    // Afstelling per kop, zodat de installateur elke kop kan inregelen zoals ontworpen.
    // Nr = volgorde in het plan (gelijk aan de stuklijst); linkerrand = begin van de sproeihoek,
    // de sector loopt vandaar met de klok mee.
    const zoneName = new Map(calc.zones.map((zoneResult, index) => [zoneResult.zone.id, zoneResult.zone.name || `Zone ${index + 1}`]));
    const heads = [];
    planState.sprinklers.forEach((sprinkler, index) => {
      const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
      if (!sprinklerType) return;
      const head = { nr: index + 1, zone: zoneName.get(sprinkler.zone) || '', kind: sprinklerType.short || sprinklerType.label, x: sprinkler.x, y: sprinkler.y };
      if (sprinkler.type === 'strip') {
        Object.assign(head, { nozzle: 'Strook', sector: '', arc: 0, r: sprinkler.len, left: sprinkler.start, leftText: `${formatNumber(sprinkler.width, 1)} × ${formatNumber(sprinkler.len, 1)} m` });
      } else {
        let nozzle = '', sector = '';
        const nozzleInfo = Catalog.nozzleOf ? (Catalog.fitHead(sprinkler), Catalog.nozzleOf(sprinkler)) : null;
        if (nozzleInfo) {
          const arcSet = Catalog.rotatorArcSet(nozzleInfo.key, sprinkler.arc);
          nozzle = nozzleInfo.name;
          sector = arcSet[0] === arcSet[1] ? `${arcSet[0]}°` : `${arcSet[0]}–${arcSet[1]}°`;
        }
        const body = Catalog.bodyOf ? Catalog.bodyOf(sprinkler) : null;
        if (body) head.body = body.name;
        Object.assign(head, { nozzle, sector, arc: sprinkler.arc, r: sprinkler.r, left: sprinkler.arc >= 360 ? 0 : sprinkler.start, leftText: sprinkler.arc >= 360 ? 'rondom' : dirText(sprinkler.start) });
      }
      heads.push(head);
    });
    heads.sort((left, right) => left.zone.localeCompare(right.zone, 'nl', { numeric: true }) || left.nr - right.nr);
    return { zones, design, heads, warnings: (calc.warnings || []).slice() };
  }

  /**
   * Werkorder uit een offerte (zoals de API die teruggeeft: { id, number,
   * data }). Materialen = de materiaalregels zonder prijzen; werkstappen = de
   * arbeidsregels in uitvoeringsvolgorde, met voorbereiding en oplevering
   * eromheen. Met plan + lib komt de zone-indeling erbij.
   * Geeft { data, warnings }.
   * @param {object} quote De offerte ({ id, number, data }).
   * @param {object} [plan] Plangegevens.
   * @param {object} [lib] { Catalog, Hydraulics } uit de beregeningsplanner.
   * @returns {{data: object, warnings: string[]}} De werkordergegevens en waarschuwingen.
   */
  function fromQuote(quote, plan = null, lib = null) {
    const quoteRecord = quote || {};
    const quoteData = quoteRecord.data || {};
    // Een optie die de klant niet heeft gekozen hoort niet bij de uitvoering.
    const lines = (Array.isArray(quoteData.lines) ? quoteData.lines : []).filter((line) => !line.optional || line.selected);
    let counter = 0;
    /**
     * Volgend id met een voorvoegsel.
     * @param {string} prefix "m" (materiaal) of "s" (stap).
     * @returns {string} Bijv. "s3".
     */
    const nextId = (prefix) => `${prefix}${++counter}`;
    const materials = lines.filter((line) => line.section === 'materiaal').map((line) => ({
      id: nextId('m'), code: line.code || '', description: line.description || '', qty: line.qty, unit: line.unit || '', picked: false,
    }));
    const labor = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.section === 'arbeid')
      .sort((left, right) => rank(left.line.description) - rank(right.line.description) || left.index - right.index);
    const steps = [
      { id: nextId('s'), phase: 'voorbereiding', title: 'Materialen verzamelen en laden volgens de materiaallijst', details: '', hours: 0 },
      { id: nextId('s'), phase: 'voorbereiding', title: 'KLIC-melding controleren en kabels en leidingen in het tracé markeren', details: '', hours: 0 },
      { id: nextId('s'), phase: 'voorbereiding', title: 'Tracé van leidingen, ventielkast en sproeiers uitzetten volgens het plan', details: '', hours: 0 },
      ...labor.map(({ line }) => ({
        id: nextId('s'), phase: rank(line.description) === 9 ? 'oplevering' : 'uitvoering', title: line.description || 'Werkzaamheden',
        details: '', hours: /^u(ur|ren)?$/i.test(String(line.unit || '').trim()) ? line.qty : 0,
      })),
    ];
    if (!labor.some(({ line }) => rank(line.description) === 9)) {
      steps.push({ id: nextId('s'), phase: 'oplevering', title: 'Installatie testen, inregelen en met de klant doorlopen', details: '', hours: 0 });
    }
    steps.push({ id: nextId('s'), phase: 'oplevering', title: 'Werkplek opruimen en de werkbon laten aftekenen', details: '', hours: 0 });

    const warnings = [];
    let zones = [], design = null, heads = [];
    if (plan && lib) {
      try {
        const fromPlan = zonesFromPlan(plan, lib);
        zones = fromPlan.zones;
        design = fromPlan.design;
        heads = fromPlan.heads || [];
        warnings.push(...fromPlan.warnings);
      } catch (error) {
        warnings.push(`De zone-indeling kon niet uit het plan worden gehaald (${error.message}).`);
      }
    }
    const summary = quoteData.planSummary;
    if (!design && summary) design = { lawnM2: summary.lawnM2, sprinklers: summary.sprinklers, zones: summary.zones, level: summary.level };
    const customer = quoteData.customer || {};
    return {
      data: sanitize({
        title: quoteData.title || `Werkorder ${quoteRecord.number || ''}`.trim(),
        quoteId: quoteRecord.id, quoteNumber: quoteRecord.number, planId: quoteData.planId, planTitle: quoteData.planTitle,
        customer: { name: customer.name, contact: customer.contact, address: customer.address, email: customer.email, phone: customer.phone },
        instructions: '', siteNotes: '', design, zones, heads, steps, materials,
      }),
      warnings,
    };
  }

  const api = { STATUSES, PHASES, APPOINTMENT, MAX_ITEMS, MAX_DAYS, WORKDAY_HOURS, addDays, workDays, moment, momentKey, fitHours, isDate, isTime, sanitize, summary, sanitizeStep, sanitizeHead, dirText, sanitizeMaterial, progress, fromQuote, zonesFromPlan, round2 };
  root.WorkOrderCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
