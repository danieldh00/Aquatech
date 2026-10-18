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

  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const quarter = (h) => Math.ceil(h * 4 - 1e-9) / 4;
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const numIn = (v, min, max, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  function today(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function addDays(iso, days) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return today(d);
  }

  function sanitizeLine(l) {
    l = l && typeof l === 'object' ? l : {};
    return {
      id: str(l.id, 40) || Math.random().toString(36).slice(2, 10),
      section: SECTIONS[l.section] ? l.section : 'overig',
      code: str(l.code, 40).trim(),
      description: str(l.description, 500),
      qty: round2(numIn(l.qty, -1e6, 1e6)),
      unit: str(l.unit, 12).trim(),
      price: round2(numIn(l.price, -1e7, 1e7)),
      vat: VAT_RATES.includes(Number(l.vat)) ? Number(l.vat) : 21,
    };
  }

  /** Maakt van willekeurige invoer een geldige offerte (lengtes, getallen, tarieven). */
  function sanitize(data) {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const c = d.customer && typeof d.customer === 'object' ? d.customer : {};
    const s = d.planSummary && typeof d.planSummary === 'object' ? d.planSummary : null;
    const date = isDate(d.date) ? d.date : today();
    return {
      title: str(d.title, 200),
      date,
      validUntil: isDate(d.validUntil) ? d.validUntil : addDays(date, 30),
      reference: str(d.reference, 120),
      customer: {
        name: str(c.name, 200),
        contact: str(c.contact, 200),
        address: str(c.address, 400),
        email: str(c.email, 200),
        phone: str(c.phone, 40),
      },
      intro: str(d.intro, 4000),
      terms: str(d.terms, 6000),
      discountPct: round2(numIn(d.discountPct, 0, 100)),
      // Op de offerte: alle regels met prijzen, of per onderdeel alleen een totaalbedrag.
      layout: d.layout === 'totaal' ? 'totaal' : 'specificatie',
      planId: str(d.planId, 64),
      planTitle: str(d.planTitle, 200),
      planSummary: s ? {
        lawnM2: round2(numIn(s.lawnM2, 0, 1e7)),
        totalM2: round2(numIn(s.totalM2, 0, 1e7)),
        sprinklers: Math.round(numIn(s.sprinklers, 0, 1e5)),
        zones: Math.round(numIn(s.zones, 0, 1e4)),
        level: str(s.level, 40),
      } : null,
      lines: (Array.isArray(d.lines) ? d.lines : []).slice(0, MAX_LINES).map(sanitizeLine),
    };
  }

  const lineTotal = (l) => round2((Number(l.qty) || 0) * (Number(l.price) || 0));

  /**
   * Totalen: per sectie, subtotaal, korting (naar rato over de btw-tarieven),
   * btw per tarief en het eindbedrag. Alle bedragen in euro's, afgerond op centen.
   */
  function totals(q) {
    const lines = (q && q.lines) || [];
    const pct = numIn(q && q.discountPct, 0, 100) / 100;
    const bySection = {};
    const bases = new Map();
    let subtotal = 0;
    for (const l of lines) {
      const t = lineTotal(l);
      bySection[l.section] = round2((bySection[l.section] || 0) + t);
      subtotal += t;
      const rate = Number(l.vat) || 0;
      bases.set(rate, (bases.get(rate) || 0) + t * (1 - pct));
    }
    subtotal = round2(subtotal);
    const discount = round2(subtotal * pct);
    const net = round2(subtotal - discount);
    const vat = [...bases.entries()].sort((a, b) => b[0] - a[0])
      .map(([rate, base]) => ({ rate, base: round2(base), amount: round2((base * rate) / 100) }));
    const vatTotal = round2(vat.reduce((s, v) => s + v.amount, 0));
    return { bySection, subtotal, discountPct: round2(pct * 100), discount, net, vat, vatTotal, total: round2(net + vatTotal) };
  }

  const PLAN_DEFAULTS = {
    pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'rotator', radius: null,
    methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray',
  };

  function polygonArea(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /**
   * Offerteregels uit een plan (de data zoals de planner die bewaart).
   * lib = { Catalog, Hydraulics, BOM } uit de beregeningsplanner.
   * profile = bedrijfsprofiel (uurtarief, opslag materiaal, btw, voorrijkosten).
   * Geeft { lines, summary, warnings }.
   */
  function fromPlan(plan, lib, profile = {}) {
    const { Catalog: C, Hydraulics: Hy, BOM } = lib;
    const st = JSON.parse(JSON.stringify(plan || {}));
    st.settings = { ...PLAN_DEFAULTS, ...(st.settings || {}) };
    st.settings.methods = { ...PLAN_DEFAULTS.methods, ...(st.settings.methods || {}) };
    for (const k of ['areas', 'elements', 'sprinklers', 'zones']) if (!Array.isArray(st[k])) st[k] = [];
    st.calc = null;
    const warnings = [];
    // Net als de stap "Stuklijst" in de planner: zonder zones eerst automatisch indelen.
    if (!st.zones.length && Hy.hasIrrigation(st)) Hy.autoZones(st);
    let rows = [];
    if (st.zones.length) {
      Hy.calculate(st);
      rows = BOM.build(st);
      for (const w of st.calc.warnings || []) warnings.push(w);
    } else {
      warnings.push('Het plan heeft nog geen sproeiers of druppelvlakken: er zijn geen materialen overgenomen.');
    }

    const vat = VAT_RATES.includes(Number(profile.vatRate)) ? Number(profile.vatRate) : 21;
    const markup = numIn(profile.markupPct, -100, 1000) / 100;
    const rate = round2(numIn(profile.hourlyRate, 0, 10000, 55));
    let n = 0;
    const id = () => `p${++n}`;
    const lines = rows.map((r) => ({
      id: id(), section: 'materiaal', code: r.code, description: r.name, qty: r.qty, unit: r.unit,
      price: round2(r.price * (1 + markup)), vat,
    }));

    const qty = (re) => rows.filter((r) => re.test(r.code)).reduce((s, r) => s + r.qty, 0);
    const pipeM = st.calc ? st.calc.pipes.reduce((s, p) => s + p.len, 0) : 0;
    const sprinklers = st.sprinklers.length;
    const valves = qty(/^VAL-24V/);
    const boxes = qty(/^BOX-/);
    const cableM = qty(/^CAB-(7|13)$/);
    const dripM = qty(/^DRIP-16$/);
    const drippers = qty(/^DRIPPER-/);
    const outlets = qty(/^OUTLET$/);
    const nl = (v, d = 0) => Number(v).toLocaleString('nl-NL', { maximumFractionDigits: d });
    const labor = (description, hours) => {
      if (hours > 0) lines.push({ id: id(), section: 'arbeid', code: '', description, qty: quarter(hours), unit: 'uur', price: rate, vat });
    };
    labor(`Sproeiers plaatsen, aansluiten en afstellen (${sprinklers} st)`, sprinklers * LABOR.sprinkler);
    labor(`Sleuven graven, leidingen leggen en aanvullen (${nl(pipeM)} m)`, pipeM * LABOR.trenchPerM);
    labor(`Ventielkast plaatsen en ventielen aansluiten (${valves} ${valves === 1 ? 'ventiel' : 'ventielen'})`, boxes * LABOR.valveBox + valves * LABOR.valve);
    if (valves) labor(`Beregeningscomputer plaatsen, stuurkabel aanleggen en programmeren (${nl(cableM)} m kabel)`, LABOR.controller + cableM * LABOR.cablePerM);
    labor(`Druppelslang leggen en vastzetten (${nl(dripM)} m)`, dripM * LABOR.dripPerM);
    labor(`Druppelaars met microbuis plaatsen (${drippers} st)`, drippers * LABOR.dripper);
    if (valves) labor('Wateraansluiting met hoofdafsluiter, filter en terugstroombeveiliging', LABOR.connection);
    labor(`Waterpunten plaatsen (${outlets} st)`, outlets * LABOR.outlet);
    if (valves) labor('Inregelen, testen en oplevering met uitleg', LABOR.commissioning + valves * LABOR.commissioningPerZone);

    const callOut = round2(numIn(profile.callOutFee, 0, 100000));
    if (callOut > 0) lines.push({ id: id(), section: 'overig', code: '', description: 'Voorrijkosten', qty: 1, unit: 'post', price: callOut, vat });

    const m2 = (type) => st.areas.filter((a) => a.type === type).reduce((s, a) => s + polygonArea(a.pts), 0);
    const level = C.levels && C.levels[st.settings.level];
    const summary = {
      lawnM2: round2(m2('lawn')),
      totalM2: round2(st.areas.reduce((s, a) => s + polygonArea(a.pts), 0)),
      sprinklers,
      zones: st.calc ? st.calc.zones.filter((z) => !z.empty).length : 0,
      level: level ? level.label : '',
    };
    return { lines, summary, warnings };
  }

  const api = { SECTIONS, VAT_RATES, STATUSES, LABOR, MAX_LINES, sanitize, sanitizeLine, totals, lineTotal, fromPlan, today, addDays, round2 };
  root.QuoteCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
