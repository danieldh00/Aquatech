// Rekenkern van de facturen: opschonen, totalen per btw-tarief en per
// omzetcategorie, de factuurinstellingen (nummering, betaaltermijn,
// omzetcategorieën met grootboekrekening) en het opbouwen van een factuur uit
// een werkorder. Gedeeld door de module Facturen in de browser en de server
// (backend/src/invoices.js). Geen afhankelijkheden.
//
// Omzetcategorie = omzetgroep (producten, arbeid, overig) x btw-tarief, bijv.
// "Omzet producten hoog (21%)" op grootboekrekening 8000. Die gaan per regel
// mee in de export naar de boekhouding (Visma eAccounting).
(function (root) {
  const STATUSES = { concept: 'Concept', definitief: 'Openstaand', betaald: 'Betaald' };
  const KINDS = { factuur: 'Factuur', credit: 'Creditfactuur' };
  const GROUPS = { producten: 'Producten', arbeid: 'Arbeid', overig: 'Overig' };
  const VAT_RATES = [21, 9, 0];
  const RATE_NAMES = { 21: 'hoog (21%)', 9: 'laag (9%)', 0: '0%' };
  // Offerteregel (sectie) -> omzetgroep.
  const SECTION_GROUP = { materiaal: 'producten', arbeid: 'arbeid', overig: 'overig' };
  const MAX_LINES = 400;

  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const numIn = (v, min, max, dflt = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
  const rid = () => Math.random().toString(36).slice(2, 10);

  function today(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function addDays(iso, days) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return today(d);
  }

  const catKey = (group, rate) => `${group}:${rate}`;
  const defaultCategoryName = (group, rate) => `Omzet ${GROUPS[group].toLowerCase()} ${RATE_NAMES[rate]}`;

  /** Factuurinstellingen (instelling invoicing van de tenant). */
  function sanitizeSettings(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const cats = r.categories && typeof r.categories === 'object' && !Array.isArray(r.categories) ? r.categories : {};
    const categories = {};
    for (const g of Object.keys(GROUPS)) {
      for (const rate of VAT_RATES) {
        const k = catKey(g, rate);
        const c = cats[k] && typeof cats[k] === 'object' ? cats[k] : {};
        categories[k] = {
          name: str(c.name, 80).trim() || defaultCategoryName(g, rate),
          account: str(c.account, 20).replace(/[^0-9A-Za-z.-]/g, ''),
        };
      }
    }
    const prefix = str(r.prefix, 12).replace(/[^0-9A-Za-z._/-]/g, '');
    return {
      prefix: r.prefix === undefined ? 'F' : prefix,
      paymentDays: Math.round(numIn(r.paymentDays, 0, 365, 14)),
      paymentText: typeof r.paymentText === 'string' ? str(r.paymentText, 1000)
        : 'Wij verzoeken u het totaalbedrag binnen {dagen} dagen over te maken op {iban} onder vermelding van factuurnummer {nummer}.',
      footer: str(r.footer, 1000),
      categories,
    };
  }

  /** Omzetcategorie van een regel: { key, name, account }. */
  function categoryOf(line, settings) {
    const s = settings && settings.categories ? settings : sanitizeSettings(settings);
    const group = GROUPS[line.group] ? line.group : 'producten';
    const rate = VAT_RATES.includes(Number(line.vat)) ? Number(line.vat) : 21;
    const k = catKey(group, rate);
    return { key: k, group, rate, name: s.categories[k].name, account: s.categories[k].account };
  }

  function sanitizeLine(l) {
    l = l && typeof l === 'object' ? l : {};
    return {
      id: str(l.id, 40) || rid(),
      code: str(l.code, 40).trim(),
      description: str(l.description, 500),
      qty: round2(numIn(l.qty, -1e6, 1e6)),
      unit: str(l.unit, 12).trim(),
      price: round2(numIn(l.price, -1e7, 1e7)),
      vat: VAT_RATES.includes(Number(l.vat)) ? Number(l.vat) : 21,
      group: GROUPS[l.group] ? l.group : 'producten',
    };
  }

  /** Maakt van willekeurige invoer een geldige factuur. */
  function sanitize(data, settings = null) {
    const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const c = d.customer && typeof d.customer === 'object' ? d.customer : {};
    const s = settings && settings.categories ? settings : sanitizeSettings(settings);
    const date = isDate(d.date) ? d.date : today();
    return {
      date,
      dueDate: isDate(d.dueDate) && d.dueDate >= date ? d.dueDate : addDays(date, s.paymentDays),
      reference: str(d.reference, 120),
      customer: {
        name: str(c.name, 200),
        contact: str(c.contact, 200),
        address: str(c.address, 400),
        email: str(c.email, 200),
        phone: str(c.phone, 40),
        vatNumber: str(c.vatNumber, 30),
      },
      intro: str(d.intro, 2000),
      notes: str(d.notes, 2000),
      discountPct: round2(numIn(d.discountPct, 0, 100)),
      workOrderNumber: str(d.workOrderNumber, 40),
      quoteNumber: str(d.quoteNumber, 40),
      creditOfNumber: str(d.creditOfNumber, 40),
      lines: (Array.isArray(d.lines) ? d.lines : []).slice(0, MAX_LINES).map(sanitizeLine),
    };
  }

  const lineTotal = (l) => round2((Number(l.qty) || 0) * (Number(l.price) || 0));

  /**
   * Totalen: subtotaal, korting (naar rato), btw per tarief, eindbedrag en
   * de omzet per categorie (excl. btw, na korting; voor de boekhouding).
   */
  function totals(inv, settings = null) {
    const lines = (inv && inv.lines) || [];
    const pct = numIn(inv && inv.discountPct, 0, 100) / 100;
    let subtotal = 0;
    const bases = new Map();
    const cats = new Map();
    for (const l of lines) {
      const t = lineTotal(l);
      subtotal += t;
      const rate = Number(l.vat) || 0;
      bases.set(rate, (bases.get(rate) || 0) + t * (1 - pct));
      const c = categoryOf(l, settings);
      const cur = cats.get(c.key) || { ...c, base: 0 };
      cur.base += t * (1 - pct);
      cats.set(c.key, cur);
    }
    subtotal = round2(subtotal);
    const discount = round2(subtotal * pct);
    const net = round2(subtotal - discount);
    const vat = [...bases.entries()].sort((a, b) => b[0] - a[0])
      .map(([rate, base]) => ({ rate, base: round2(base), amount: round2((base * rate) / 100) }));
    const vatTotal = round2(vat.reduce((s, v) => s + v.amount, 0));
    const categories = [...cats.values()].map((c) => ({ ...c, base: round2(c.base), vatAmount: round2((c.base * c.rate) / 100) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { subtotal, discountPct: round2(pct * 100), discount, net, vat, vatTotal, total: round2(net + vatTotal), categories };
  }

  /** Betaaltekst met {dagen}, {iban}, {nummer}, {vervaldatum} ingevuld. */
  function paymentText(settings, { number = '', iban = '', dueDate = '' } = {}) {
    const s = settings && settings.categories ? settings : sanitizeSettings(settings);
    return s.paymentText
      .replace(/\{dagen\}/g, String(s.paymentDays))
      .replace(/\{iban\}/g, iban || 'onze rekening')
      .replace(/\{nummer\}/g, number || '(volgt)')
      .replace(/\{vervaldatum\}/g, dueDate);
  }

  /** Creditfactuur: dezelfde regels met negatieve aantallen. */
  function creditOf(inv) {
    const d = inv.data || inv;
    return {
      ...d,
      date: today(),
      dueDate: '',
      creditOfNumber: inv.number || d.creditOfNumber || '',
      intro: `Creditering van factuur ${inv.number || ''}`.trim(),
      lines: (d.lines || []).map((l) => ({ ...l, id: rid(), qty: -l.qty })),
    };
  }

  /**
   * Factuur uit een werkorder. ctx:
   *   quote     de geaccordeerde offerte ({ number, data }) of null
   *   logged    geboekte uren en materialen ({ hours: [{ minutes }], materials: [{ code, description, qty, unit }] })
   *   articles  verkoopgegevens per code ({ CODE: { name, unit, salePrice, vatRate, revenueGroup } })
   *   catalog   catalogus van de planner ({ code: { name, unit, price } }), terugval voor de prijs
   *   hourlyRate uurtarief excl. btw (bedrijfsprofiel)
   * Met offerte: de gekozen offerteregels, plus geboekt materiaal dat niet in
   * de offerte staat als meerwerk. Zonder offerte (bijv. uit een melding):
   * geboekt materiaal (of de materiaallijst) en geboekte uren (of de geplande
   * uren van de werkstappen). Geeft { data, warnings }.
   */
  function fromWorkOrder(wo, ctx = {}) {
    const w = wo || {};
    const d = w.data || {};
    const quote = ctx.quote || null;
    const logged = ctx.logged || { hours: [], materials: [] };
    const articles = ctx.articles || {};
    const catalog = ctx.catalog || {};
    const rate = round2(ctx.hourlyRate || 0);
    const warnings = [];
    const priceOf = (code) => {
      const a = articles[String(code || '').toUpperCase()];
      if (a && a.salePrice != null) return { price: a.salePrice, vat: a.vatRate, group: a.revenueGroup };
      const c = catalog[code] || catalog[String(code || '').toUpperCase()];
      return { price: c && c.price != null ? c.price : 0, vat: a ? a.vatRate : 21, group: a ? a.revenueGroup : 'producten', missing: !c || c.price == null };
    };
    const lines = [];
    const qd = quote ? quote.data || {} : null;
    if (qd) {
      for (const l of (qd.lines || []).filter((x) => !x.optional || x.selected)) {
        lines.push({ code: l.code, description: l.description, qty: l.qty, unit: l.unit, price: l.price, vat: l.vat, group: SECTION_GROUP[l.section] || 'overig' });
      }
      const quoted = new Set((qd.lines || []).map((l) => String(l.code || '').toUpperCase()).filter(Boolean));
      const extra = new Map();
      for (const m of logged.materials || []) {
        const code = String(m.code || '').toUpperCase();
        if (!code || quoted.has(code) || !(Number(m.qty) > 0)) continue;
        const cur = extra.get(code) || { code, description: m.description, qty: 0, unit: m.unit };
        cur.qty = round2(cur.qty + Number(m.qty));
        extra.set(code, cur);
      }
      for (const m of extra.values()) {
        const p = priceOf(m.code);
        if (p.missing) warnings.push(`Geen verkoopprijs voor ${m.code}: vul die op de factuur in.`);
        lines.push({ code: m.code, description: `Meerwerk: ${m.description || m.code}`, qty: m.qty, unit: m.unit, price: p.price, vat: p.vat, group: p.group });
      }
    } else {
      const used = (logged.materials || []).filter((m) => Number(m.qty) > 0);
      const mats = used.length ? used : (d.materials || []).filter((m) => Number(m.qty) > 0);
      const merged = new Map();
      for (const m of mats) {
        const k = String(m.code || m.description || '').toUpperCase();
        const cur = merged.get(k) || { code: m.code || '', description: m.description || '', qty: 0, unit: m.unit || '' };
        cur.qty = round2(cur.qty + Number(m.qty));
        merged.set(k, cur);
      }
      for (const m of merged.values()) {
        const p = m.code ? priceOf(m.code) : { price: 0, vat: 21, group: 'producten', missing: true };
        if (p.missing) warnings.push(`Geen verkoopprijs voor ${m.code || m.description}: vul die op de factuur in.`);
        lines.push({ code: m.code, description: m.description || m.code, qty: m.qty, unit: m.unit, price: p.price, vat: p.vat, group: p.group });
      }
      const minutes = (logged.hours || []).reduce((s, h) => s + (Number(h.minutes) || 0), 0);
      const hours = minutes
        ? Math.ceil((minutes / 60) * 4 - 1e-9) / 4
        : round2((d.steps || []).reduce((s, x) => s + (Number(x.actualHours != null ? x.actualHours : x.hours) || 0), 0));
      if (hours > 0) {
        lines.push({ code: '', description: minutes ? 'Arbeid (geboekte uren)' : 'Arbeid', qty: hours, unit: 'uur', price: rate, vat: 21, group: 'arbeid' });
        if (!rate) warnings.push('Geen uurtarief in het bedrijfsprofiel: vul het tarief op de factuur in.');
      }
      if (!lines.length) warnings.push('Op deze werkorder is niets geboekt: vul de regels zelf in.');
    }
    const c = d.customer || {};
    return {
      data: sanitize({
        reference: d.title || '',
        customer: { name: c.name, contact: c.contact, address: c.address, email: c.email, phone: c.phone },
        discountPct: qd ? qd.discountPct : 0,
        workOrderNumber: w.number || '',
        quoteNumber: quote ? quote.number || '' : '',
        lines,
      }, ctx.settings),
      warnings,
    };
  }

  /**
   * Regels voor de export naar de boekhouding: per factuur per
   * omzetcategorie één regel (zoals een verkoopboeking in Visma).
   */
  function exportRows(invoices, settings) {
    const out = [];
    for (const inv of invoices) {
      const t = totals(inv.data, settings);
      for (const c of t.categories) {
        out.push({
          number: inv.number, kind: inv.kind || 'factuur', date: inv.data.date, dueDate: inv.data.dueDate,
          customer: inv.data.customer.name, customerEmail: inv.data.customer.email, customerAddress: inv.data.customer.address,
          customerVat: inv.data.customer.vatNumber || '', reference: inv.data.reference,
          category: c.name, account: c.account, group: c.group, rate: c.rate,
          base: c.base, vat: c.vatAmount, total: round2(c.base + c.vatAmount),
        });
      }
    }
    return out;
  }

  const api = {
    STATUSES, KINDS, GROUPS, VAT_RATES, RATE_NAMES, SECTION_GROUP, MAX_LINES,
    today, addDays, isDate, round2, catKey, sanitizeSettings, categoryOf, sanitizeLine, sanitize, lineTotal, totals,
    paymentText, creditOf, fromWorkOrder, exportRows,
  };
  root.InvoiceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
