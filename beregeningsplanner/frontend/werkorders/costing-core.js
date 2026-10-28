// Rekenkern van de nacalculatie: per werkorder de begroting (offerte, of
// zonder offerte de werkorder zelf) naast wat er werkelijk is geboekt (uren en
// materiaalverbruik) en wat er is gefactureerd, met kosten en marge. Gedeeld
// door de server (backend/src/uitvoering/costing.js) en de browser (paneel en
// Excel-export). Geen afhankelijkheden.
//
// Bedragen zijn excl. btw. "Waarde" = tegen verkoopprijs (offerteprijs, anders
// verkoopprijs uit de voorraad; arbeid tegen het uurtarief van de offerte), "kosten" = geboekte uren × kostprijs per uur
// plus verbruikt materiaal × inkoopprijs. De opbrengst is wat er definitief is
// gefactureerd (creditnota's tellen negatief mee); zolang er niets
// gefactureerd is, telt de offerte (netto, na korting), en zonder offerte een
// schatting uit de werkorder (revenueSource 'schatting').
(function (root) {
  /**
   * Rondt af op twee decimalen.
   * @param {*} value Getal of tekst met een getal.
   * @returns {number} Het afgeronde getal (0 als het geen getal is).
   */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  /**
   * Sleutel om materiaalregels samen te voegen: de code, anders de omschrijving.
   * @param {object} line Regel met code en description.
   * @returns {string} De sleutel in hoofdletters (leeg zonder code en omschrijving).
   */
  const keyOf = (line) => String((line && (line.code || line.description)) || '').trim().toUpperCase();
  /**
   * Telt een offerteregel mee? Een niet gekozen optie niet.
   * @param {object} line De offerteregel.
   * @returns {boolean} true als hij meetelt.
   */
  const included = (line) => !line.optional || Boolean(line.selected);
  /**
   * Is dit een urenregel (eenheid uur of u)?
   * @param {object} line De offerteregel.
   * @returns {boolean} true bij uren.
   */
  const isHours = (line) => /^(uur|uren|u)$/i.test(String(line.unit || '').trim());

  /**
   * Rekent de nacalculatie van één werkorder uit.
   * @param {object} input De gegevens:
   *   workOrder  { number, status, data } (data.steps[].hours, data.materials[])
   *   quote      { number, data } van de geaccordeerde offerte, of null
   *   logged     { hours: [{ minutes }], materials: [{ code, description, unit, qty }] }
   *   articles   per code { name, salePrice, costPrice } (voorraad)
   *   invoices   [{ number, status, subtotal }] van deze werkorder
   *   hourlyRate uurtarief excl. btw (zonder uren in de offerte); hourlyCost kostprijs per uur
   * @returns {object} { source, labour, materials, other, budget, actual, cost, invoiced, revenue, revenueSource, margin, marginPct, warnings }.
   */
  function compute(input) {
    const fields = input || {};
    const order = fields.workOrder || {};
    const orderData = order.data || {};
    const quoteData = fields.quote ? fields.quote.data || {} : null;
    const logged = fields.logged || {};
    const articles = fields.articles || {};
    const hourlyRate = round2(fields.hourlyRate);
    const hourlyCost = round2(fields.hourlyCost);
    const warnings = [];
    /**
     * Voorraadartikel bij een code (codes in hoofdletters).
     * @param {string} code Artikelcode.
     * @returns {object|null} Het artikel, of null.
     */
    const articleOf = (code) => (code ? articles[String(code).toUpperCase()] || null : null);

    // Begroot: uit de offerte, anders uit de werkorder (stappen en materiaallijst).
    const materials = new Map();
    /**
     * Zoekt of maakt de materiaalregel bij een sleutel.
     * @param {object} line Regel met code, description en unit.
     * @returns {object} De regel in de nacalculatie.
     */
    const materialFor = (line) => {
      const key = keyOf(line);
      if (!materials.has(key)) {
        materials.set(key, { code: String(line.code || '').toUpperCase(), description: line.description || line.code || '', unit: line.unit || '', plannedQty: 0, usedQty: 0, price: null, plannedAmount: 0 });
      }
      return materials.get(key);
    };
    let plannedHours = 0;
    let plannedLabour = 0;
    let plannedOther = 0;
    let discountPct = 0;
    if (quoteData) {
      discountPct = Math.min(100, Math.max(0, Number(quoteData.discountPct) || 0));
      for (const line of (quoteData.lines || []).filter(included)) {
        const amount = round2((Number(line.qty) || 0) * (Number(line.price) || 0));
        if (line.section === 'arbeid') {
          plannedLabour += amount;
          if (isHours(line)) plannedHours += Number(line.qty) || 0;
        } else if (line.section === 'materiaal' && keyOf(line)) {
          const material = materialFor(line);
          material.plannedQty += Number(line.qty) || 0;
          material.plannedAmount += amount;
          if (material.price === null) material.price = Number(line.price) || 0;
        } else {
          plannedOther += amount;
        }
      }
    } else {
      plannedHours = (orderData.steps || []).reduce((sum, step) => sum + (Number(step.hours) || 0), 0);
      plannedLabour = plannedHours * hourlyRate;
      for (const line of orderData.materials || []) {
        if (!keyOf(line)) continue;
        const material = materialFor(line);
        const article = articleOf(line.code);
        // Geen verkoopprijs: price blijft null, zodat de waarschuwing hieronder volgt.
        if (material.price === null && article && article.salePrice != null) material.price = article.salePrice;
        material.plannedQty += Number(line.qty) || 0;
        material.plannedAmount += (Number(line.qty) || 0) * (material.price || 0);
      }
    }

    // Werkelijk: geboekte uren en materiaalverbruik (negatief = retour).
    const actualHours = (logged.hours || []).reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0) / 60;
    for (const line of logged.materials || []) {
      if (!keyOf(line)) continue;
      materialFor(line).usedQty += Number(line.qty) || 0;
    }
    const missingPrice = [];
    const missingCost = [];
    const materialRows = [...materials.values()].map((material) => {
      const article = articleOf(material.code);
      let price = material.price;
      if (price === null) {
        price = article && article.salePrice != null ? article.salePrice : 0;
        if (!(article && article.salePrice != null) && (material.usedQty > 0 || material.plannedQty > 0)) missingPrice.push(material.code || material.description);
      }
      const costPrice = article && article.costPrice != null ? article.costPrice : null;
      if (costPrice === null && material.usedQty > 0) missingCost.push(material.code || material.description);
      const plannedQty = round2(material.plannedQty);
      const usedQty = round2(material.usedQty);
      return {
        code: material.code, description: material.description, unit: material.unit,
        plannedQty, usedQty, diffQty: round2(usedQty - plannedQty), price: round2(price), costPrice,
        plannedAmount: round2(material.plannedAmount), usedAmount: round2(usedQty * price),
        usedCost: costPrice === null ? null : round2(usedQty * costPrice), extra: plannedQty === 0 && usedQty !== 0,
      };
    });

    const budgetMaterials = round2(materialRows.reduce((sum, row) => sum + row.plannedAmount, 0));
    const actualMaterials = round2(materialRows.reduce((sum, row) => sum + row.usedAmount, 0));
    const budgetSubtotal = round2(plannedLabour + budgetMaterials + plannedOther);
    // Werkelijke arbeid tegen hetzelfde tarief als de begroting: het gemiddelde
    // uurtarief van de offerteregels in uren, anders het uurtarief uit het profiel.
    const labourRate = plannedHours > 0 && plannedLabour > 0 ? round2(plannedLabour / plannedHours) : hourlyRate;
    const actualLabour = round2(actualHours * labourRate);
    // Overige posten (voorrijkosten e.d.) worden niet geboekt: werkelijk = begroot.
    const actualSubtotal = round2(actualLabour + actualMaterials + plannedOther);
    const budgetDiscount = round2(budgetSubtotal * discountPct / 100);
    const actualDiscount = round2(actualSubtotal * discountPct / 100);
    const budget = { labour: round2(plannedLabour), materials: budgetMaterials, other: round2(plannedOther), subtotal: budgetSubtotal, discount: budgetDiscount, net: round2(budgetSubtotal - budgetDiscount) };
    const actual = { labour: actualLabour, materials: actualMaterials, other: round2(plannedOther), subtotal: actualSubtotal, discount: actualDiscount, net: round2(actualSubtotal - actualDiscount) };

    const labourCost = round2(actualHours * hourlyCost);
    const materialCost = round2(materialRows.reduce((sum, row) => sum + (row.usedCost || 0), 0));
    const cost = { labour: labourCost, materials: materialCost, total: round2(labourCost + materialCost), complete: Boolean(hourlyCost || !actualHours) && !missingCost.length };

    const final = (fields.invoices || []).filter((invoice) => invoice.status === 'definitief' || invoice.status === 'betaald');
    const invoiced = {
      amount: round2(final.reduce((sum, invoice) => sum + (Number(invoice.subtotal) || 0), 0)),
      count: final.length,
      concepts: (fields.invoices || []).filter((invoice) => invoice.status === 'concept').length,
      numbers: final.map((invoice) => invoice.number).filter(Boolean),
    };
    // Zonder factuur en zonder offerte is de opbrengst een schatting uit de werkorder.
    const revenueSource = final.length ? 'factuur' : quoteData ? 'offerte' : 'schatting';
    const revenue = final.length ? invoiced.amount : budget.net;
    const margin = round2(revenue - cost.total);

    if (!quoteData) warnings.push('Geen offerte: de begroting komt uit de werkstappen en de materiaallijst van de werkorder.');
    if (actualHours && !hourlyCost) warnings.push('Vul de kostprijs per uur in (Offertes > Bedrijfsgegevens); de arbeidskosten tellen nu niet mee.');
    if (missingCost.length) warnings.push(`Geen inkoopprijs in de voorraad voor ${missingCost.join(', ')}; die kosten tellen niet mee.`);
    if (missingPrice.length) warnings.push(`Geen verkoopprijs voor ${missingPrice.join(', ')}; de waarde telt als € 0.`);
    if (invoiced.concepts) warnings.push(`${invoiced.concepts === 1 ? 'Eén conceptfactuur telt' : `${invoiced.concepts} conceptfacturen tellen`} nog niet mee.`);

    return {
      source: quoteData ? 'offerte' : 'werkorder',
      labour: {
        plannedHours: round2(plannedHours), actualHours: round2(actualHours), diffHours: round2(actualHours - plannedHours),
        hourlyRate: labourRate, hourlyCost, plannedAmount: budget.labour, actualAmount: actualLabour, cost: labourCost,
      },
      materials: materialRows,
      discountPct,
      budget, actual, cost, invoiced, revenue: round2(revenue), revenueSource,
      margin, marginPct: revenue ? round2((margin / revenue) * 100) : null,
      warnings,
    };
  }

  const api = { compute, round2 };
  root.CostingCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
