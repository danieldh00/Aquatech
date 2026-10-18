// Rekenkern van de werkorders: opschonen, voortgang, en het opbouwen van een
// werkorder uit een geaccordeerde offerte (materialen, werkstappen met uren)
// plus, als het plan erbij komt, de zone-indeling uit de beregeningsplanner.
// Gedeeld door de module Werkorders in de browser en de server. Geen
// afhankelijkheden: de plannerbibliotheken (Catalog, Hydraulics) komen als
// argument binnen.
(function (root) {
  const STATUSES = { open: 'Nieuw', gepland: 'Gepland', bezig: 'In uitvoering', gereed: 'Gereed', geannuleerd: 'Geannuleerd' };
  const PHASES = { voorbereiding: 'Voorbereiding', uitvoering: 'Uitvoering', oplevering: 'Oplevering' };
  const MAX_ITEMS = 400;

  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const numIn = (v, min, max, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const rid = () => Math.random().toString(36).slice(2, 10);

  function sanitizeStep(s) {
    s = s && typeof s === 'object' ? s : {};
    return {
      id: str(s.id, 40) || rid(),
      phase: PHASES[s.phase] ? s.phase : 'uitvoering',
      title: str(s.title, 300),
      details: str(s.details, 2000),
      hours: round2(numIn(s.hours, 0, 10000)),
      actualHours: s.actualHours === null || s.actualHours === undefined || s.actualHours === '' ? null : round2(numIn(s.actualHours, 0, 10000)),
      done: Boolean(s.done),
    };
  }

  function sanitizeMaterial(m) {
    m = m && typeof m === 'object' ? m : {};
    return {
      id: str(m.id, 40) || rid(),
      code: str(m.code, 40).trim(),
      description: str(m.description, 500),
      qty: round2(numIn(m.qty, -1e6, 1e6)),
      unit: str(m.unit, 12).trim(),
      picked: Boolean(m.picked),
    };
  }

  function sanitizeZone(z) {
    z = z && typeof z === 'object' ? z : {};
    return {
      name: str(z.name, 60),
      kind: str(z.kind, 60),
      parts: str(z.parts, 400),
      flowLph: Math.round(numIn(z.flowLph, 0, 1e6)),
      pipeM: round2(numIn(z.pipeM, 0, 1e5)),
      pressureBar: round2(numIn(z.pressureBar, -100, 100)),
      requiredBar: round2(numIn(z.requiredBar, 0, 100)),
      ok: z.ok !== false,
    };
  }

  /** Maakt van willekeurige invoer een geldige werkorder. */
  function sanitize(data) {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const c = d.customer && typeof d.customer === 'object' ? d.customer : {};
    const g = d.design && typeof d.design === 'object' ? d.design : null;
    const r = d.report && typeof d.report === 'object' ? d.report : {};
    const list = (v, fn) => (Array.isArray(v) ? v : []).slice(0, MAX_ITEMS).map(fn);
    return {
      title: str(d.title, 200),
      quoteId: str(d.quoteId, 64),
      quoteNumber: str(d.quoteNumber, 40),
      planId: str(d.planId, 64),
      planTitle: str(d.planTitle, 200),
      customer: {
        name: str(c.name, 200),
        contact: str(c.contact, 200),
        address: str(c.address, 400),
        email: str(c.email, 200),
        phone: str(c.phone, 40),
      },
      plannedDate: isDate(d.plannedDate) ? d.plannedDate : '',
      startTime: isTime(d.startTime) ? d.startTime : '',
      crew: str(d.crew, 200),
      instructions: str(d.instructions, 4000),
      siteNotes: str(d.siteNotes, 2000),
      design: g ? {
        lawnM2: round2(numIn(g.lawnM2, 0, 1e7)),
        sprinklers: Math.round(numIn(g.sprinklers, 0, 1e5)),
        zones: Math.round(numIn(g.zones, 0, 1e4)),
        pressureBar: round2(numIn(g.pressureBar, 0, 100)),
        flowM3h: round2(numIn(g.flowM3h, 0, 1000)),
        mainPipe: str(g.mainPipe, 40),
        level: str(g.level, 40),
      } : null,
      zones: list(d.zones, sanitizeZone).slice(0, 100),
      steps: list(d.steps, sanitizeStep),
      materials: list(d.materials, sanitizeMaterial),
      report: {
        notes: str(r.notes, 4000),
        completedOn: isDate(r.completedOn) ? r.completedOn : '',
        signedBy: str(r.signedBy, 200),
      },
    };
  }

  /** Voortgang: afgevinkte stappen, uren gepland/werkelijk, verzamelde materialen. */
  function progress(d) {
    const steps = (d && d.steps) || [];
    const mats = (d && d.materials) || [];
    const done = steps.filter((s) => s.done).length;
    return {
      steps: steps.length,
      done,
      pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
      hours: round2(steps.reduce((s, x) => s + (Number(x.hours) || 0), 0)),
      actualHours: round2(steps.reduce((s, x) => s + (Number(x.actualHours) || 0), 0)),
      materials: mats.length,
      picked: mats.filter((m) => m.picked).length,
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
  const rank = (text) => {
    for (const [re, n] of ORDER) if (re.test(text)) return n;
    return 5.5;
  };

  const PLAN_DEFAULTS = {
    pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'rotator', radius: null,
    methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray',
  };
  const nl = (v, d = 0) => Number(v).toLocaleString('nl-NL', { maximumFractionDigits: d });

  /**
   * Zone-indeling uit een plan (zoals de planner die bewaart), voor de ploeg:
   * per zone wat erop zit, het debiet, de leidinglengte en de druk.
   * lib = { Catalog, Hydraulics } uit de beregeningsplanner.
   */
  function zonesFromPlan(plan, lib) {
    const { Catalog: C, Hydraulics: Hy } = lib;
    const st = JSON.parse(JSON.stringify(plan || {}));
    st.settings = { ...PLAN_DEFAULTS, ...(st.settings || {}) };
    st.settings.methods = { ...PLAN_DEFAULTS.methods, ...(st.settings.methods || {}) };
    for (const k of ['areas', 'elements', 'sprinklers', 'zones']) if (!Array.isArray(st[k])) st[k] = [];
    if (!st.zones.length && Hy.hasIrrigation(st)) Hy.autoZones(st);
    if (!st.zones.length) return { zones: [], design: null, warnings: [] };
    const calc = Hy.calculate(st);
    const zones = [];
    for (const zr of calc.zones) {
      if (zr.empty) continue;
      const spr = {};
      const drip = [];
      for (const m of zr.members) {
        if (m.kind === 'spr') {
          const t = C.sprinklerTypes[m.ref.type];
          const label = t ? t.short || t.label : m.ref.type;
          spr[label] = (spr[label] || 0) + 1;
        } else if (m.drip) {
          const at = C.areaTypes[m.ref.type];
          const where = at ? at.label.toLowerCase() : 'beplanting';
          drip.push(m.drip.method === 'drippers'
            ? `${m.drip.count} druppelaars (${where})`
            : `${nl(m.drip.lengthM || 0)} m druppelslang (${where})`);
        }
      }
      const parts = [...Object.entries(spr).map(([k, n]) => `${n}× ${k}`), ...drip];
      const kinds = new Set(zr.members.map((m) => (m.kind === 'spr' ? (m.ref.areaId ? 'Sproeiers in beplanting' : 'Gazon') : 'Druppelirrigatie')));
      zones.push({
        name: zr.zone.name || `Zone ${zones.length + 1}`,
        kind: [...kinds].join(' + '),
        parts: parts.join(', '),
        flowLph: Math.round(zr.q),
        pipeM: round2((zr.edges || []).reduce((s, e) => s + e.len, 0)),
        pressureBar: round2(zr.critical),
        requiredBar: round2(zr.required),
        ok: zr.ok !== false,
      });
    }
    const area = (pts) => {
      if (!Array.isArray(pts) || pts.length < 3) return 0;
      let s = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
      return Math.abs(s) / 2;
    };
    const level = C.levels && C.levels[st.settings.level];
    const design = {
      lawnM2: round2(st.areas.filter((a) => a.type === 'lawn').reduce((s, a) => s + area(a.pts), 0)),
      sprinklers: st.sprinklers.length,
      zones: zones.length,
      pressureBar: round2(st.settings.pressure),
      flowM3h: round2(st.settings.flow),
      mainPipe: calc.mainPipe ? `PE ${calc.mainPipe.dn} mm, ${nl(calc.mainLen, 1)} m` : '',
      level: level ? level.label : '',
    };
    return { zones, design, warnings: (calc.warnings || []).slice() };
  }

  /**
   * Werkorder uit een offerte (zoals de API die teruggeeft: { id, number,
   * data }). Materialen = de materiaalregels zonder prijzen; werkstappen = de
   * arbeidsregels in uitvoeringsvolgorde, met voorbereiding en oplevering
   * eromheen. Met plan + lib komt de zone-indeling erbij.
   * Geeft { data, warnings }.
   */
  function fromQuote(quote, plan = null, lib = null) {
    const q = quote || {};
    const d = q.data || {};
    const lines = Array.isArray(d.lines) ? d.lines : [];
    let n = 0;
    const id = (p) => `${p}${++n}`;
    const materials = lines.filter((l) => l.section === 'materiaal').map((l) => ({
      id: id('m'), code: l.code || '', description: l.description || '', qty: l.qty, unit: l.unit || '', picked: false,
    }));
    const labor = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.section === 'arbeid')
      .sort((a, b) => rank(a.l.description) - rank(b.l.description) || a.i - b.i);
    const steps = [
      { id: id('s'), phase: 'voorbereiding', title: 'Materialen verzamelen en laden volgens de materiaallijst', details: '', hours: 0 },
      { id: id('s'), phase: 'voorbereiding', title: 'KLIC-melding controleren en kabels en leidingen in het tracé markeren', details: '', hours: 0 },
      { id: id('s'), phase: 'voorbereiding', title: 'Tracé van leidingen, ventielkast en sproeiers uitzetten volgens het plan', details: '', hours: 0 },
      ...labor.map(({ l }) => ({
        id: id('s'), phase: rank(l.description) === 9 ? 'oplevering' : 'uitvoering', title: l.description || 'Werkzaamheden',
        details: '', hours: /^u(ur|ren)?$/i.test(String(l.unit || '').trim()) ? l.qty : 0,
      })),
    ];
    if (!labor.some(({ l }) => rank(l.description) === 9)) {
      steps.push({ id: id('s'), phase: 'oplevering', title: 'Installatie testen, inregelen en met de klant doorlopen', details: '', hours: 0 });
    }
    steps.push({ id: id('s'), phase: 'oplevering', title: 'Werkplek opruimen en de werkbon laten aftekenen', details: '', hours: 0 });

    const warnings = [];
    let zones = [], design = null;
    if (plan && lib) {
      try {
        const z = zonesFromPlan(plan, lib);
        zones = z.zones;
        design = z.design;
        warnings.push(...z.warnings);
      } catch (e) {
        warnings.push(`De zone-indeling kon niet uit het plan worden gehaald (${e.message}).`);
      }
    }
    const s = d.planSummary;
    if (!design && s) design = { lawnM2: s.lawnM2, sprinklers: s.sprinklers, zones: s.zones, level: s.level };
    const c = d.customer || {};
    return {
      data: sanitize({
        title: d.title || `Werkorder ${q.number || ''}`.trim(),
        quoteId: q.id, quoteNumber: q.number, planId: d.planId, planTitle: d.planTitle,
        customer: { name: c.name, contact: c.contact, address: c.address, email: c.email, phone: c.phone },
        instructions: '', siteNotes: '', design, zones, steps, materials,
      }),
      warnings,
    };
  }

  const api = { STATUSES, PHASES, MAX_ITEMS, sanitize, sanitizeStep, sanitizeMaterial, progress, fromQuote, zonesFromPlan, round2 };
  root.WorkOrderCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
