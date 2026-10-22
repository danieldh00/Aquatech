// Rekenkern van de facturen: opschonen, totalen per btw-tarief en per
// omzetcategorie, de factuurinstellingen (nummering, betaaltermijn,
// omzetcategorieën met grootboekrekening) en het opbouwen van een factuur uit
// een werkorder. Gedeeld door de module Facturen in de browser en de server
// (backend/src/verkoop/invoices.js). Geen afhankelijkheden.
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

  /**
   * Rondt af op twee decimalen (centen).
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
   * Geeft aan of een waarde een geldige datum JJJJ-MM-DD is.
   * @param {*} value De waarde.
   * @returns {boolean} true bij een geldige datum.
   */
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
  /**
   * Kort willekeurig id voor een regel.
   * @returns {string} 8 letters/cijfers.
   */
  const randomId = () => Math.random().toString(36).slice(2, 10);

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
   * Sleutel van een omzetcategorie.
   * @param {string} group Omzetgroep (producten, arbeid, overig).
   * @param {number} rate Btw-tarief.
   * @returns {string} Bijv. "arbeid:21".
   */
  const catKey = (group, rate) => `${group}:${rate}`;
  // Bekende standaarden uit het rekeningschema van Visma eAccounting (opgave
  // Daniël); de rest vult de beheerder zelf in.
  const KNOWN = { 'arbeid:21': { name: 'Omzet diensten hoog tarief', account: '8140' } };
  /**
   * Standaardnaam van een omzetcategorie.
   * @param {string} group Omzetgroep.
   * @param {number} rate Btw-tarief.
   * @returns {string} Bijv. "Omzet producten hoog (21%)".
   */
  const defaultCategoryName = (group, rate) => (KNOWN[catKey(group, rate)] || {}).name || `Omzet ${GROUPS[group].toLowerCase()} ${RATE_NAMES[rate]}`;

  /**
   * Factuurinstellingen opschonen (instelling invoicing van de tenant).
   * @param {object} raw De opgeslagen of ingevulde instellingen.
   * @returns {object} { prefix, paymentDays, paymentText, footer, categories, debtorStart, autoSend, mailSubject, mailText, shopOrders }.
   */
  function sanitizeSettings(raw) {
    const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawCategories = fields.categories && typeof fields.categories === 'object' && !Array.isArray(fields.categories) ? fields.categories : {};
    const categories = {};
    for (const group of Object.keys(GROUPS)) {
      for (const rate of VAT_RATES) {
        const key = catKey(group, rate);
        const category = rawCategories[key] && typeof rawCategories[key] === 'object' ? rawCategories[key] : {};
        categories[key] = {
          name: limitText(category.name, 80).trim() || defaultCategoryName(group, rate),
          account: category.account === undefined ? (KNOWN[key] || {}).account || '' : limitText(category.account, 20).replace(/[^0-9A-Za-z.-]/g, ''),
        };
      }
    }
    const prefix = limitText(fields.prefix, 12).replace(/[^0-9A-Za-z._/-]/g, '');
    return {
      prefix: fields.prefix === undefined ? 'F' : prefix,
      paymentDays: Math.round(clampNumber(fields.paymentDays, 0, 365, 14)),
      paymentText: typeof fields.paymentText === 'string' ? limitText(fields.paymentText, 1000)
        : 'Wij verzoeken u het totaalbedrag binnen {dagen} dagen over te maken op {iban} onder vermelding van factuurnummer {nummer}.',
      footer: limitText(fields.footer, 1000),
      categories,
      // Eerste debiteurnummer (laat ruimte voor de nummers die al in de boekhouding staan).
      debtorStart: Math.round(clampNumber(fields.debtorStart, 1, 99999999, 1000)),
      // Definitieve facturen meteen per e-mail (met de PDF) naar de klant.
      autoSend: fields.autoSend === true,
      mailSubject: typeof fields.mailSubject === 'string' && fields.mailSubject.trim() ? limitText(fields.mailSubject, 200).replace(/[\r\n]/g, ' ') : DEFAULT_SUBJECT,
      mailText: typeof fields.mailText === 'string' && fields.mailText.trim() ? limitText(fields.mailText, 4000) : DEFAULT_MAIL,
      shopOrders: sanitizeShopOrders(fields.shopOrders),
    };
  }

  const DEFAULT_SUBJECT = '{soort} {nummer} van {bedrijf}';
  const DEFAULT_MAIL = 'Beste {klant},\n\nIn de bijlage vindt u {soort_klein} {nummer} van {datum} voor {bedrag} incl. btw.\n\n{betaling}\n\nMet vriendelijke groet,\n{bedrijf}';
  // WooCommerce-status die een bestelling tot factuur maakt ("Afgerond" = completed).
  const SHOP_STATUSES = { completed: 'Afgerond', processing: 'In behandeling' };

  /**
   * Webshopbestellingen omzetten in facturen: aan/uit, bij welke status,
   * vanaf welke datum (oudere bestellingen zijn al gefactureerd) en of de
   * factuur meteen definitief wordt.
   * @param {object} raw De ingevulde instellingen.
   * @returns {{enabled: boolean, status: string, since: string, finalize: boolean}} De opgeschoonde instellingen.
   */
  function sanitizeShopOrders(raw) {
    const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      enabled: fields.enabled === true,
      status: SHOP_STATUSES[fields.status] ? fields.status : 'completed',
      since: isDate(fields.since) ? fields.since : '',
      finalize: fields.finalize !== false,
    };
  }

  /**
   * Vult {veld} in een mailtekst in; onbekende velden blijven staan.
   * @param {string} template De tekst met {velden}.
   * @param {object} values Waarden per veldnaam.
   * @returns {string} De ingevulde tekst.
   */
  function fillText(template, values) {
    return String(template || '').replace(/\{([a-z_]+)\}/g, (placeholder, name) => (values[name] === undefined || values[name] === null ? placeholder : String(values[name])));
  }

  /**
   * Omzetcategorie van een regel.
   * @param {object} line De regel (group, vat).
   * @param {object} settings Factuurinstellingen (opgeschoond of ruw).
   * @returns {{key: string, group: string, rate: number, name: string, account: string}} De categorie.
   */
  function categoryOf(line, settings) {
    const cleanSettings = settings && settings.categories ? settings : sanitizeSettings(settings);
    const group = GROUPS[line.group] ? line.group : 'producten';
    const rate = VAT_RATES.includes(Number(line.vat)) ? Number(line.vat) : 21;
    const key = catKey(group, rate);
    return { key, group, rate, name: cleanSettings.categories[key].name, account: cleanSettings.categories[key].account };
  }

  /**
   * Maakt van willekeurige invoer een geldige factuurregel.
   * @param {object} line De regel.
   * @returns {object} { id, code, description, qty, unit, price, vat, group }.
   */
  function sanitizeLine(line) {
    line = line && typeof line === 'object' ? line : {};
    return {
      id: limitText(line.id, 40) || randomId(),
      code: limitText(line.code, 40).trim(),
      description: limitText(line.description, 500),
      qty: round2(clampNumber(line.qty, -1e6, 1e6)),
      unit: limitText(line.unit, 12).trim(),
      price: round2(clampNumber(line.price, -1e7, 1e7)),
      vat: VAT_RATES.includes(Number(line.vat)) ? Number(line.vat) : 21,
      group: GROUPS[line.group] ? line.group : 'producten',
    };
  }

  /**
   * Maakt van willekeurige invoer een geldige factuur.
   * @param {object} data De factuurgegevens.
   * @param {object} [settings] Factuurinstellingen (voor de betaaltermijn).
   * @returns {object} De opgeschoonde factuurgegevens.
   */
  function sanitize(data, settings = null) {
    const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const customer = fields.customer && typeof fields.customer === 'object' ? fields.customer : {};
    const cleanSettings = settings && settings.categories ? settings : sanitizeSettings(settings);
    const date = isDate(fields.date) ? fields.date : today();
    return {
      date,
      dueDate: isDate(fields.dueDate) && fields.dueDate >= date ? fields.dueDate : addDays(date, cleanSettings.paymentDays),
      reference: limitText(fields.reference, 120),
      customer: {
        name: limitText(customer.name, 200),
        contact: limitText(customer.contact, 200),
        address: limitText(customer.address, 400),
        email: limitText(customer.email, 200),
        phone: limitText(customer.phone, 40),
        vatNumber: limitText(customer.vatNumber, 30),
      },
      intro: limitText(fields.intro, 2000),
      notes: limitText(fields.notes, 2000),
      discountPct: round2(clampNumber(fields.discountPct, 0, 100)),
      workOrderNumber: limitText(fields.workOrderNumber, 40),
      quoteNumber: limitText(fields.quoteNumber, 40),
      creditOfNumber: limitText(fields.creditOfNumber, 40),
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
   * Totalen: subtotaal, korting (naar rato), btw per tarief, eindbedrag en
   * de omzet per categorie (excl. btw, na korting; voor de boekhouding).
   * @param {object} invoice Factuurgegevens (lines, discountPct).
   * @param {object} [settings] Factuurinstellingen (voor de categorieën).
   * @returns {object} { subtotal, discountPct, discount, net, vat, vatTotal, total, categories }.
   */
  function totals(invoice, settings = null) {
    const lines = (invoice && invoice.lines) || [];
    const discountFraction = clampNumber(invoice && invoice.discountPct, 0, 100) / 100;
    let subtotal = 0;
    const bases = new Map();
    const categoryTotals = new Map();
    for (const line of lines) {
      const amount = lineTotal(line);
      subtotal += amount;
      const rate = Number(line.vat) || 0;
      bases.set(rate, (bases.get(rate) || 0) + amount * (1 - discountFraction));
      const category = categoryOf(line, settings);
      const entry = categoryTotals.get(category.key) || { ...category, base: 0 };
      entry.base += amount * (1 - discountFraction);
      categoryTotals.set(category.key, entry);
    }
    subtotal = round2(subtotal);
    const discount = round2(subtotal * discountFraction);
    const net = round2(subtotal - discount);
    const vat = [...bases.entries()].sort((left, right) => right[0] - left[0])
      .map(([rate, base]) => ({ rate, base: round2(base), amount: round2((base * rate) / 100) }));
    const vatTotal = round2(vat.reduce((sum, entry) => sum + entry.amount, 0));
    const categories = [...categoryTotals.values()].map((category) => ({ ...category, base: round2(category.base), vatAmount: round2((category.base * category.rate) / 100) }))
      .sort((left, right) => left.key.localeCompare(right.key));
    return { subtotal, discountPct: round2(discountFraction * 100), discount, net, vat, vatTotal, total: round2(net + vatTotal), categories };
  }

  /**
   * Betaaltekst met {dagen}, {iban}, {nummer}, {vervaldatum} ingevuld.
   * @param {object} settings Factuurinstellingen.
   * @param {object} [values] { number, iban, dueDate }.
   * @returns {string} De betaaltekst.
   */
  function paymentText(settings, { number = '', iban = '', dueDate = '' } = {}) {
    const cleanSettings = settings && settings.categories ? settings : sanitizeSettings(settings);
    return cleanSettings.paymentText
      .replace(/\{dagen\}/g, String(cleanSettings.paymentDays))
      .replace(/\{iban\}/g, iban || 'onze rekening')
      .replace(/\{nummer\}/g, number || '(volgt)')
      .replace(/\{vervaldatum\}/g, dueDate);
  }

  /**
   * Creditfactuur: dezelfde regels met negatieve aantallen.
   * @param {object} invoice De factuur (met number en data) of alleen de gegevens.
   * @returns {object} Gegevens voor een nieuwe conceptfactuur.
   */
  function creditOf(invoice) {
    const fields = invoice.data || invoice;
    return {
      ...fields,
      date: today(),
      dueDate: '',
      creditOfNumber: invoice.number || fields.creditOfNumber || '',
      intro: `Creditering van factuur ${invoice.number || ''}`.trim(),
      lines: (fields.lines || []).map((line) => ({ ...line, id: randomId(), qty: -line.qty })),
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
   * @param {object} workOrder De werkorder (number, data).
   * @param {object} [ctx] { quote, logged, articles, catalog, hourlyRate, settings }.
   * @returns {{data: object, warnings: string[]}} De factuurgegevens en waarschuwingen.
   */
  function fromWorkOrder(workOrder, ctx = {}) {
    const order = workOrder || {};
    const data = order.data || {};
    const quote = ctx.quote || null;
    const logged = ctx.logged || { hours: [], materials: [] };
    const articles = ctx.articles || {};
    const catalog = ctx.catalog || {};
    const rate = round2(ctx.hourlyRate || 0);
    const warnings = [];
    /**
     * Verkoopprijs, btw en omzetgroep van een artikel (voorraad, anders catalogus).
     * @param {string} code Artikelcode.
     * @returns {{price: number, vat: number, group: string, missing?: boolean}} De prijsgegevens; missing = geen prijs gevonden.
     */
    const priceOf = (code) => {
      const article = articles[String(code || '').toUpperCase()];
      if (article && article.salePrice != null) return { price: article.salePrice, vat: article.vatRate, group: article.revenueGroup };
      const catalogItem = catalog[code] || catalog[String(code || '').toUpperCase()];
      return { price: catalogItem && catalogItem.price != null ? catalogItem.price : 0, vat: article ? article.vatRate : 21, group: article ? article.revenueGroup : 'producten', missing: !catalogItem || catalogItem.price == null };
    };
    const lines = [];
    const quoteData = quote ? quote.data || {} : null;
    if (quoteData) {
      for (const line of (quoteData.lines || []).filter((candidate) => !candidate.optional || candidate.selected)) {
        lines.push({ code: line.code, description: line.description, qty: line.qty, unit: line.unit, price: line.price, vat: line.vat, group: SECTION_GROUP[line.section] || 'overig' });
      }
      const quoted = new Set((quoteData.lines || []).map((line) => String(line.code || '').toUpperCase()).filter(Boolean));
      const extra = new Map();
      for (const material of logged.materials || []) {
        const code = String(material.code || '').toUpperCase();
        if (!code || quoted.has(code) || !(Number(material.qty) > 0)) continue;
        const entry = extra.get(code) || { code, description: material.description, qty: 0, unit: material.unit };
        entry.qty = round2(entry.qty + Number(material.qty));
        extra.set(code, entry);
      }
      for (const material of extra.values()) {
        const pricing = priceOf(material.code);
        if (pricing.missing) warnings.push(`Geen verkoopprijs voor ${material.code}: vul die op de factuur in.`);
        lines.push({ code: material.code, description: `Meerwerk: ${material.description || material.code}`, qty: material.qty, unit: material.unit, price: pricing.price, vat: pricing.vat, group: pricing.group });
      }
    } else {
      const used = (logged.materials || []).filter((material) => Number(material.qty) > 0);
      const materialList = used.length ? used : (data.materials || []).filter((material) => Number(material.qty) > 0);
      const merged = new Map();
      for (const material of materialList) {
        const key = String(material.code || material.description || '').toUpperCase();
        const entry = merged.get(key) || { code: material.code || '', description: material.description || '', qty: 0, unit: material.unit || '' };
        entry.qty = round2(entry.qty + Number(material.qty));
        merged.set(key, entry);
      }
      for (const material of merged.values()) {
        const pricing = material.code ? priceOf(material.code) : { price: 0, vat: 21, group: 'producten', missing: true };
        if (pricing.missing) warnings.push(`Geen verkoopprijs voor ${material.code || material.description}: vul die op de factuur in.`);
        lines.push({ code: material.code, description: material.description || material.code, qty: material.qty, unit: material.unit, price: pricing.price, vat: pricing.vat, group: pricing.group });
      }
      const minutes = (logged.hours || []).reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0);
      const hours = minutes
        ? Math.ceil((minutes / 60) * 4 - 1e-9) / 4
        : round2((data.steps || []).reduce((sum, step) => sum + (Number(step.actualHours != null ? step.actualHours : step.hours) || 0), 0));
      if (hours > 0) {
        lines.push({ code: '', description: minutes ? 'Arbeid (geboekte uren)' : 'Arbeid', qty: hours, unit: 'uur', price: rate, vat: 21, group: 'arbeid' });
        if (!rate) warnings.push('Geen uurtarief in het bedrijfsprofiel: vul het tarief op de factuur in.');
      }
      if (!lines.length) warnings.push('Op deze werkorder is niets geboekt: vul de regels zelf in.');
    }
    const customer = data.customer || {};
    return {
      data: sanitize({
        reference: data.title || '',
        customer: { name: customer.name, contact: customer.contact, address: customer.address, email: customer.email, phone: customer.phone },
        discountPct: quoteData ? quoteData.discountPct : 0,
        workOrderNumber: order.number || '',
        quoteNumber: quote ? quote.number || '' : '',
        lines,
      }, ctx.settings),
      warnings,
    };
  }

  /**
   * Regels voor de export naar de boekhouding: per factuur per
   * omzetcategorie één regel (zoals een verkoopboeking in Visma).
   * @param {object[]} invoices De facturen (number, kind, data, debtorNumber).
   * @param {object} settings Factuurinstellingen.
   * @returns {object[]} Eén regel per factuur per omzetcategorie.
   */
  function exportRows(invoices, settings) {
    const out = [];
    for (const invoice of invoices) {
      const invoiceTotals = totals(invoice.data, settings);
      for (const category of invoiceTotals.categories) {
        out.push({
          number: invoice.number, kind: invoice.kind || 'factuur', date: invoice.data.date, dueDate: invoice.data.dueDate,
          debtorNumber: invoice.debtorNumber || '', customer: invoice.data.customer.name, customerEmail: invoice.data.customer.email, customerAddress: invoice.data.customer.address,
          customerVat: invoice.data.customer.vatNumber || '', reference: invoice.data.reference,
          category: category.name, account: category.account, group: category.group, rate: category.rate,
          base: category.base, vat: category.vatAmount, total: round2(category.base + category.vatAmount),
        });
      }
    }
    return out;
  }

  const api = {
    STATUSES, KINDS, GROUPS, VAT_RATES, RATE_NAMES, SECTION_GROUP, MAX_LINES,
    today, addDays, isDate, round2, catKey, sanitizeSettings, categoryOf, sanitizeLine, sanitize, lineTotal, totals,
    paymentText, creditOf, fromWorkOrder, exportRows, sanitizeShopOrders, fillText, SHOP_STATUSES, DEFAULT_SUBJECT, DEFAULT_MAIL,
  };
  root.InvoiceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
