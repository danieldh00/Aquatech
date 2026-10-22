// Rekenkern van de offertes: regels opschonen, totalen met korting en btw, en
// het opbouwen van offerteregels (materiaal + arbeid) uit een beregeningsplan.
// Gedeeld door de offertemodule in de browser en de server (die rekent de
// totalen voor het overzicht zelf na). Geen afhankelijkheden: de planner-
// bibliotheken (Catalog, Hydraulics, BOM) komen als argument binnen.
(function (root) {
  const SECTIONS = { materiaal: 'Materialen', arbeid: 'Arbeid', overig: 'Overig' };
  const VAT_RATES = [21, 9, 0];
  const STATUSES = { concept: 'Concept', verzonden: 'Verzonden', akkoord: 'Akkoord', afgewezen: 'Afgewezen' };
  const MAX_LINES = 400;

  // Arbeidsnormen in uren; de uitkomst is een startpunt en per offerte aan te passen.
  const LABOR = {
    sprinkler: 0.4, // sproeier plaatsen, aansluiten en afstellen
    trenchPerM: 0.1, // sleuf graven, PE-buis leggen en aanvullen, per meter
    valveBox: 1.5, // ventielkast plaatsen
    valve: 0.5, // magneetventiel monteren en aansluiten
    controller: 1.5, // beregeningscomputer ophangen en programmeren
    cablePerM: 0.02, // stuurkabel leggen, per meter
    dripPerM: 0.04, // druppelslang leggen en vastzetten, per meter
    dripper: 0.05, // druppelaar met microbuis plaatsen
    connection: 2, // wateraansluiting, hoofdafsluiter, filter, terugstroombeveiliging
    outlet: 1, // waterpunt in grondkastje
    commissioning: 1, // inregelen, testen en oplevering met uitleg
    commissioningPerZone: 0.25,
  };

  /**
   * Rondt af op twee decimalen (centen).
   * @param {*} value Getal of tekst met een getal.
   * @returns {number} Het afgeronde getal (0 als het geen getal is).
   */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  /**
   * Rondt uren naar boven af op een kwartier.
   * @param {number} hours Aantal uren.
   * @returns {number} Uren in stappen van 0,25.
   */
  const roundUpToQuarter = (hours) => Math.ceil(hours * 4 - 1e-9) / 4;
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
   * Datum van vandaag (of van een gegeven datum) als JJJJ-MM-DD in lokale tijd.
   * @param {Date} [date] De datum.
   * @returns {string} De datum als JJJJ-MM-DD.
   */
  function today(date = new Date()) {
    /**
     * Getal met een voorloopnul tot twee cijfers.
     * @param {number} number Het getal.
     * @returns {string} Bijv. "07".
     */
    const padTwo = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
  }
  /**
   * Telt dagen op bij een datum.
   * @param {string} iso Datum als JJJJ-MM-DD.
   * @param {number} days Aantal dagen.
   * @returns {string} De nieuwe datum als JJJJ-MM-DD.
   */
  function addDays(iso, days) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + days);
    return today(date);
  }

  /**
   * Maakt van willekeurige invoer een geldige offerteregel.
   * @param {object} line De regel.
   * @returns {object} { id, section, code, description, qty, unit, price, vat, optional, selected }.
   */
  function sanitizeLine(line) {
    line = line && typeof line === 'object' ? line : {};
    return {
      id: limitText(line.id, 40) || Math.random().toString(36).slice(2, 10),
      section: SECTIONS[line.section] ? line.section : 'overig',
      code: limitText(line.code, 40).trim(),
      description: limitText(line.description, 500),
      qty: round2(clampNumber(line.qty, -1e6, 1e6)),
      unit: limitText(line.unit, 12).trim(),
      price: round2(clampNumber(line.price, -1e7, 1e7)),
      vat: VAT_RATES.includes(Number(line.vat)) ? Number(line.vat) : 21,
      // Optie: de klant kiest zelf of die meedoet; telt alleen mee als gekozen.
      optional: Boolean(line.optional),
      selected: Boolean(line.optional && line.selected),
    };
  }

  /**
   * Maakt van willekeurige invoer een geldige offerte (lengtes, getallen, tarieven).
   * @param {object} data De offertegegevens.
   * @returns {object} De opgeschoonde offerte.
   */
  function sanitize(data) {
    const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const customer = fields.customer && typeof fields.customer === 'object' ? fields.customer : {};
    const summary = fields.planSummary && typeof fields.planSummary === 'object' ? fields.planSummary : null;
    const date = isDate(fields.date) ? fields.date : today();
    return {
      title: limitText(fields.title, 200),
      date,
      validUntil: isDate(fields.validUntil) ? fields.validUntil : addDays(date, 30),
      reference: limitText(fields.reference, 120),
      customer: {
        name: limitText(customer.name, 200),
        contact: limitText(customer.contact, 200),
        address: limitText(customer.address, 400),
        email: limitText(customer.email, 200),
        phone: limitText(customer.phone, 40),
      },
      intro: limitText(fields.intro, 4000),
      terms: limitText(fields.terms, 6000),
      discountPct: round2(clampNumber(fields.discountPct, 0, 100)),
      // Op de offerte: alle regels met prijzen, of per onderdeel alleen een totaalbedrag.
      layout: fields.layout === 'totaal' ? 'totaal' : 'specificatie',
      planId: limitText(fields.planId, 64),
      planTitle: limitText(fields.planTitle, 200),
      planSummary: summary ? {
        lawnM2: round2(clampNumber(summary.lawnM2, 0, 1e7)),
        totalM2: round2(clampNumber(summary.totalM2, 0, 1e7)),
        sprinklers: Math.round(clampNumber(summary.sprinklers, 0, 1e5)),
        zones: Math.round(clampNumber(summary.zones, 0, 1e4)),
        level: limitText(summary.level, 40),
      } : null,
      lines: (Array.isArray(fields.lines) ? fields.lines : []).slice(0, MAX_LINES).map(sanitizeLine),
    };
  }

  /**
   * Bedrag van een regel: aantal × prijs.
   * @param {object} line De regel.
   * @returns {number} Het bedrag in euro's.
   */
  const lineTotal = (line) => round2((Number(line.qty) || 0) * (Number(line.price) || 0));
  /**
   * Telt de regel mee in de totalen? Een niet gekozen optie niet.
   * @param {object} line De regel.
   * @returns {boolean} true als hij meetelt.
   */
  const included = (line) => !line.optional || Boolean(line.selected);

  /**
   * Kiest de opties: alleen de regels met een id uit `ids` staan aan.
   * @param {object} data De offertegegevens.
   * @param {string[]} ids Id's van de gekozen opties.
   * @returns {object} Een kopie met de keuze verwerkt.
   */
  function chooseOptions(data, ids) {
    const chosen = new Set((Array.isArray(ids) ? ids : []).map(String));
    return { ...data, lines: data.lines.map((line) => (line.optional ? { ...line, selected: chosen.has(line.id) } : line)) };
  }

  /**
   * Totalen: per sectie, subtotaal, korting (naar rato over de btw-tarieven),
   * btw per tarief en het eindbedrag. Alle bedragen in euro's, afgerond op centen.
   * @param {object} quote Offertegegevens (lines, discountPct).
   * @returns {object} { bySection, subtotal, discountPct, discount, net, vat, vatTotal, total }.
   */
  function totals(quote) {
    const lines = (quote && quote.lines) || [];
    const discountFraction = clampNumber(quote && quote.discountPct, 0, 100) / 100;
    const bySection = {};
    const bases = new Map();
    let subtotal = 0;
    for (const line of lines) {
      if (!included(line)) continue;
      const amount = lineTotal(line);
      bySection[line.section] = round2((bySection[line.section] || 0) + amount);
      subtotal += amount;
      const rate = Number(line.vat) || 0;
      bases.set(rate, (bases.get(rate) || 0) + amount * (1 - discountFraction));
    }
    subtotal = round2(subtotal);
    const discount = round2(subtotal * discountFraction);
    const net = round2(subtotal - discount);
    const vat = [...bases.entries()].sort((left, right) => right[0] - left[0])
      .map(([rate, base]) => ({ rate, base: round2(base), amount: round2((base * rate) / 100) }));
    const vatTotal = round2(vat.reduce((sum, entry) => sum + entry.amount, 0));
    return { bySection, subtotal, discountPct: round2(discountFraction * 100), discount, net, vat, vatTotal, total: round2(net + vatTotal) };
  }

  const PLAN_DEFAULTS = {
    pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'rotator', radius: null,
    methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray',
  };

  /**
   * Oppervlakte van een veelhoek (schoenveterformule).
   * @param {Array<{x: number, y: number}>} points De hoekpunten.
   * @returns {number} De oppervlakte (0 bij minder dan 3 punten).
   */
  function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let twiceArea = 0;
    for (let i = 0; i < points.length; i++) {
      const current = points[i], next = points[(i + 1) % points.length];
      twiceArea += current.x * next.y - next.x * current.y;
    }
    return Math.abs(twiceArea) / 2;
  }

  /**
   * Offerteregels uit een plan (de data zoals de planner die bewaart).
   * @param {object} plan Plangegevens.
   * @param {object} lib { Catalog, Hydraulics, BOM } uit de beregeningsplanner.
   * @param {object} [profile] Bedrijfsprofiel (uurtarief, opslag materiaal, btw, voorrijkosten).
   * @returns {{lines: object[], summary: object, warnings: string[]}} De regels, een samenvatting van het plan en waarschuwingen.
   */
  function fromPlan(plan, lib, profile = {}) {
    const { Catalog, Hydraulics, BOM } = lib;
    const planState = JSON.parse(JSON.stringify(plan || {}));
    planState.settings = { ...PLAN_DEFAULTS, ...(planState.settings || {}) };
    planState.settings.methods = { ...PLAN_DEFAULTS.methods, ...(planState.settings.methods || {}) };
    for (const key of ['areas', 'elements', 'sprinklers', 'zones']) if (!Array.isArray(planState[key])) planState[key] = [];
    planState.calc = null;
    const warnings = [];
    // Net als de stap "Stuklijst" in de planner: zonder zones eerst automatisch indelen.
    if (!planState.zones.length && Hydraulics.hasIrrigation(planState)) Hydraulics.autoZones(planState);
    let rows = [];
    if (planState.zones.length) {
      Hydraulics.calculate(planState);
      rows = BOM.build(planState);
      for (const warning of planState.calc.warnings || []) warnings.push(warning);
      // Eigen assortiment: onderdelen zonder artikel staan niet in de offerte.
      if (rows.missing && rows.missing.length) {
        warnings.push(`Niet in het eigen assortiment en dus niet in de offerte: ${rows.missing.map((item) => `${item.name} (${item.qty} ${item.unit})`).join(', ')}.`);
      }
    } else {
      warnings.push('Het plan heeft nog geen sproeiers of druppelvlakken: er zijn geen materialen overgenomen.');
    }

    const vat = VAT_RATES.includes(Number(profile.vatRate)) ? Number(profile.vatRate) : 21;
    const markup = clampNumber(profile.markupPct, -100, 1000) / 100;
    const rate = round2(clampNumber(profile.hourlyRate, 0, 10000, 55));
    let counter = 0;
    /**
     * Volgend id voor een regel uit het plan.
     * @returns {string} Bijv. "p3".
     */
    const nextId = () => `p${++counter}`;
    const lines = rows.map((row) => ({
      id: nextId(), section: 'materiaal', code: row.code, description: row.name, qty: row.qty, unit: row.unit,
      // Webshopprijzen zijn al verkoopprijzen: daar geen opslag op.
      price: round2(row.price * (1 + (row.shop ? 0 : markup))), vat,
    }));

    /**
     * Totaal aantal van de stuklijstregels waarvan de code past.
     * @param {RegExp} pattern Patroon voor de artikelcode.
     * @returns {number} Het aantal.
     */
    const quantityOf = (pattern) => rows.filter((row) => pattern.test(row.code)).reduce((sum, row) => sum + row.qty, 0);
    const pipeM = planState.calc ? planState.calc.pipes.reduce((sum, pipe) => sum + pipe.len, 0) : 0;
    const sprinklers = planState.sprinklers.length;
    const valves = quantityOf(/^VAL-24V/);
    const boxes = quantityOf(/^BOX-/);
    const cableM = quantityOf(/^CAB-(7|13)$/);
    const dripM = quantityOf(/^DRIP-16$/);
    const drippers = quantityOf(/^DRIPPER-/);
    const outlets = quantityOf(/^OUTLET$/);
    /**
     * Getal in Nederlandse notatie.
     * @param {number} value Het getal.
     * @param {number} [decimals] Maximaal aantal decimalen.
     * @returns {string} Bijv. "12".
     */
    const formatNumber = (value, decimals = 0) => Number(value).toLocaleString('nl-NL', { maximumFractionDigits: decimals });
    /**
     * Voegt een arbeidsregel toe (alleen bij meer dan 0 uur, afgerond op een kwartier).
     * @param {string} description Omschrijving.
     * @param {number} hours Aantal uren.
     */
    const labor = (description, hours) => {
      if (hours > 0) lines.push({ id: nextId(), section: 'arbeid', code: '', description, qty: roundUpToQuarter(hours), unit: 'uur', price: rate, vat });
    };
    labor(`Sproeiers plaatsen, aansluiten en afstellen (${sprinklers} st)`, sprinklers * LABOR.sprinkler);
    labor(`Sleuven graven, leidingen leggen en aanvullen (${formatNumber(pipeM)} m)`, pipeM * LABOR.trenchPerM);
    labor(`Ventielkast plaatsen en ventielen aansluiten (${valves} ${valves === 1 ? 'ventiel' : 'ventielen'})`, boxes * LABOR.valveBox + valves * LABOR.valve);
    if (valves) labor(`Beregeningscomputer plaatsen, stuurkabel aanleggen en programmeren (${formatNumber(cableM)} m kabel)`, LABOR.controller + cableM * LABOR.cablePerM);
    labor(`Druppelslang leggen en vastzetten (${formatNumber(dripM)} m)`, dripM * LABOR.dripPerM);
    labor(`Druppelaars met microbuis plaatsen (${drippers} st)`, drippers * LABOR.dripper);
    if (valves) labor('Wateraansluiting met hoofdafsluiter, filter en terugstroombeveiliging', LABOR.connection);
    labor(`Waterpunten plaatsen (${outlets} st)`, outlets * LABOR.outlet);
    if (valves) labor('Inregelen, testen en oplevering met uitleg', LABOR.commissioning + valves * LABOR.commissioningPerZone);

    const callOut = round2(clampNumber(profile.callOutFee, 0, 100000));
    if (callOut > 0) lines.push({ id: nextId(), section: 'overig', code: '', description: 'Voorrijkosten', qty: 1, unit: 'post', price: callOut, vat });

    /**
     * Oppervlakte van alle vlakken van een soort.
     * @param {string} type Soort vlak, bijv. "lawn".
     * @returns {number} De oppervlakte in m².
     */
    const areaOfType = (type) => planState.areas.filter((area) => area.type === type).reduce((sum, area) => sum + polygonArea(area.pts), 0);
    const level = Catalog.levels && Catalog.levels[planState.settings.level];
    const summary = {
      lawnM2: round2(areaOfType('lawn')),
      totalM2: round2(planState.areas.reduce((sum, area) => sum + polygonArea(area.pts), 0)),
      sprinklers,
      zones: planState.calc ? planState.calc.zones.filter((zone) => !zone.empty).length : 0,
      level: level ? level.label : '',
    };
    return { lines, summary, warnings };
  }

  const api = { SECTIONS, VAT_RATES, STATUSES, LABOR, MAX_LINES, sanitize, sanitizeLine, totals, lineTotal, included, chooseOptions, fromPlan, today, addDays, round2 };
  root.QuoteCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
