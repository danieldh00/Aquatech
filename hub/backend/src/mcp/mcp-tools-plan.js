// De MCP-tools voor beregeningsplannen: plan_maken, plan_details en plan_omzetten (zie mcp-tools.js voor het geheel en beregening/plan-builder.js).
const { MAX_ORDER_ITEMS, PLANS_PER_HOUR, READS_LIMITED, cleanText, resultOf, errorOf, findArticle } = require('./mcp-tool-helpers');

/**
 * Maakt de tools van dit onderdeel.
 * @param { ctx, withinLimit, articlesOf, planReadsPerHour, plansPerHour, quotesPerDay, quotesPerHour, workOrdersPerDay, workOrdersPerHour } shared Wat mcp-tools.js deelt: de context van de server, de begrenzers en de hulpfuncties.
 * @returns { [name: string]: object } De tools (naam → scope, rechten, definitie en run).
 */
function createPlanTools(shared) {
  const { ctx, withinLimit, articlesOf, planReadsPerHour, plansPerHour, quotesPerDay, quotesPerHour, workOrdersPerDay, workOrdersPerHour } = shared;
  return {
  plan_maken: {
    scope: 'plannen.concept', rights: ['plannen'],
    definition: {
      title: 'Beregeningsplan maken',
      description: 'Maakt een beregeningsplan als CONCEPT in de Beregeningsplanner uit de vlakken die jij uit een tekening of foto hebt gelezen. Geef elk vlak als soort '
        + '(lawn gazon, bed border, hedge haag, planter plantenbak, dry moet droog blijven zoals huis of terras, wet mag nat worden) met hoekpunten in METERS in een eigen assenstelsel '
        + '(x naar rechts, y naar beneden; gebruik de maatvoering of de schaal van de tekening, schat niet stilzwijgend). AquaTech plaatst zelf de sproeiers, deelt de zones in en rekent de stuklijst met de prijzen uit de voorraad; '
        + 'jij verzint geen sproeiers of artikelen. Het antwoord bevat vlakken, aantallen, zones, stuklijst en aandachtspunten: laat de gebruiker dat controleren en pas zo nodig de vlakken aan; roep dan opnieuw aan met dezelfde planId om het plan bij te werken. '
        + 'Zonder druk en debiet (kraan) vraagt de tool terug; de gebruiker kent die vaak niet, dan mag ookMetAannames=true (3,5 bar, 2,0 m³/u).',
      inputSchema: {
        type: 'object',
        properties: {
          naam: { type: 'string', maxLength: 120, description: 'Naam van het plan, bijvoorbeeld "Tuin Jansen".' },
          klantId: { type: 'string', maxLength: 64, description: 'Id van de klant uit zoek_klant (vult klantnaam en adres in; alleen met het recht klanten).' },
          klantNaam: { type: 'string', maxLength: 120 },
          adres: { type: 'string', maxLength: 200 },
          vlakken: {
            type: 'array', minItems: 1, maxItems: 40,
            items: {
              type: 'object',
              properties: {
                soort: { type: 'string', enum: ['lawn', 'bed', 'hedge', 'planter', 'wet', 'dry'] },
                naam: { type: 'string', maxLength: 60 },
                punten: { type: 'array', minItems: 3, maxItems: 60, items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
              },
              required: ['soort', 'punten'], additionalProperties: false,
            },
          },
          elementen: {
            type: 'array', maxItems: 12, description: 'Alleen als op de tekening staat waar de wateraansluiting (source), beregeningscomputer (controller), ventielkast (valvebox) of een tappunt (outlet) zit; anders zet AquaTech ze zelf.',
            items: { type: 'object', properties: { soort: { type: 'string', enum: ['source', 'controller', 'valvebox', 'outlet'] }, x: { type: 'number' }, y: { type: 'number' } }, required: ['soort', 'x', 'y'], additionalProperties: false },
          },
          druk: { type: 'number', minimum: 0.5, maximum: 10, description: 'Waterdruk aan de kraan in bar (dynamisch).' },
          debiet: { type: 'number', minimum: 0.2, maximum: 30, description: 'Beschikbaar debiet aan de kraan in m³/u.' },
          sproeiertype: { type: 'string', enum: ['auto', 'rotator', 'spray', 'rotor'], default: 'auto' },
          methodes: { type: 'object', description: 'Beregening per soort beplanting: bed, hedge, planter = dripline, drippers of none.', additionalProperties: { type: 'string' } },
          planId: { type: 'string', maxLength: 64, description: 'Id van een eerder gemaakt plan om bij te werken (alleen eigen plannen, of alle met het recht plannen.alle).' },
          ookMetAannames: { type: 'boolean', description: 'Alleen true nadat de gebruiker heeft gezegd dat druk en debiet onbekend zijn of dat de aannames goed zijn.' },
        },
        required: ['vlakken'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    /**
     * Bouwt het plan en bewaart het als concept.
     * @param {object} args De invoer.
     * @param {object} req Het verzoek.
     * @returns {object} De uitkomst.
     */
    run: async (args, req) => {
      if (!withinLimit(plansPerHour, req)) return errorOf(`Te veel plannen dit uur via de AI-koppeling (hoogstens ${PLANS_PER_HOUR}). Probeer het later opnieuw of werk in de Beregeningsplanner.`);
      let customerName = cleanText(args.klantNaam, 120);
      let address = cleanText(args.adres, 200);
      const wantedId = cleanText(args.klantId, 64);
      if (wantedId) {
        if (!ctx.can(req.user, 'klanten')) return errorOf('Je mag in AquaTech geen klantgegevens opzoeken. Geef de klant als tekst op (klantNaam en adres) in plaats van klantId.');
        const account = ctx.getCustomer(req, wantedId);
        if (!account || account.disabled) return errorOf('Deze klant bestaat niet (meer). Zoek opnieuw met zoek_klant.');
        customerName = account.companyName || account.displayName;
        address = address || account.address || '';
      }
      const questions = [];
      if (args.druk == null || args.debiet == null) questions.push({ onderwerp: 'kraan', vraag: 'Wat zijn de waterdruk (bar) en het debiet (m³/u) aan de kraan? De gebruiker kan dat meten met een emmer en een manometer; weet hij het niet, dan gaat het plan uit van 3,5 bar en 2,0 m³/u.' });
      if (questions.length && args.ookMetAannames !== true) {
        return resultOf({ status: 'terugvragen', aangemaakt: false, vragen: questions,
          melding: 'Er is nog geen plan gemaakt. Leg de vraag voor aan de gebruiker en roep opnieuw aan (met druk en debiet, of met ookMetAannames=true).' });
      }
      const built = await ctx.buildPlan(req, { ...args, klantNaam: customerName, adres: address });
      if (built.problems) return errorOf(`Het plan kon niet gemaakt worden: ${built.problems.join(' ')}`, { problemen: built.problems });
      const planId = cleanText(args.planId, 64);
      const saved = ctx.savePlan(req, planId || null, built.state);
      if (!saved) return errorOf('Dit plan bestaat niet (meer) of is van een ander. Maak een nieuw plan zonder planId.');
      ctx.audit(req, 'plan_via_ai', { planId: saved.id, bijgewerkt: Boolean(planId), vlakken: built.report.vlakken.length, sproeiers: built.report.sproeiers.totaal });
      return resultOf({
        planId: saved.id, status: 'concept', bijgewerkt: Boolean(planId), link: ctx.appUrl(req, `beregening/?plan=${encodeURIComponent(saved.id)}`), ...built.report,
        melding: 'Het plan staat als concept in AquaTech. Laat de gebruiker het verslag controleren (vlakken, aantallen, aandachtspunten) en kijk het plan na in de Beregeningsplanner voordat er een offerte of werkorder van komt.',
      });
    },
  },
  plan_details: {
    scope: 'plannen.concept', rights: ['plannen'],
    definition: {
      title: 'Beregeningsplan bekijken',
      description: 'Geeft de samenvatting van een bestaand plan: vlakken, sproeiers, zones, stuklijst met prijzen en aandachtspunten. Alleen eigen plannen (of alle met het recht plannen.alle).',
      inputSchema: { type: 'object', properties: { planId: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['planId'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    /**
     * Vat het plan samen.
     * @param {object} args { planId }.
     * @param {object} req Het verzoek.
     * @returns {object} De uitkomst.
     */
    run: async (args, req) => {
      if (!withinLimit(planReadsPerHour, req)) return errorOf(READS_LIMITED);
      const plan = ctx.getPlan(req, cleanText(args.planId, 64));
      if (!plan) return errorOf('Geen plan met dit id gevonden.');
      const summary = await ctx.summarizePlan(req, plan.data);
      if (summary.problems) return errorOf(`Dit plan kan niet samengevat worden: ${summary.problems.join(' ')}`, { problemen: summary.problems });
      return resultOf({ planId: plan.id, status: (plan.review && plan.review.status) || 'concept', link: ctx.appUrl(req, `beregening/?plan=${encodeURIComponent(plan.id)}`), ...summary });
    },
  },
  plan_omzetten: {
    scope: 'plannen.concept', rights: ['plannen'],
    definition: {
      title: 'Plan omzetten naar concept-offerte of werkorder',
      description: 'Zet een bewaard beregeningsplan (uit plan_maken) om naar een CONCEPT-offerte (materiaal uit de stuklijst met de prijzen en het uurtarief van AquaTech, arbeid en voorrijkosten volgens het bedrijfsprofiel) '
        + 'of naar een nieuwe werkorder (stappen met uren en het materiaal, dat reserveert voorraad). De gebruiker heeft het plan eerst gecontroleerd. Is iets onduidelijk (geen klant), dan maakt deze tool niets aan maar geeft status "terugvragen": '
        + 'stel de vraag aan de gebruiker en roep opnieuw aan (of ookMetOpenPunten=true als de gebruiker bewust zonder klant door wil). Er wordt niets verstuurd; de medewerker controleert alles in AquaTech.',
      inputSchema: {
        type: 'object',
        properties: {
          planId: { type: 'string', minLength: 1, maxLength: 64, description: 'Id uit plan_maken.' },
          naar: { type: 'string', enum: ['offerte', 'werkorder'] },
          klantId: { type: 'string', maxLength: 64, description: 'Id uit zoek_klant of maak_klant (aanbevolen: dan staan naam en adres goed).' },
          klant: {
            type: 'object', description: 'Alleen als er geen klantId is: de klantgegevens uit het gesprek (zonder adres).',
            properties: { naam: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 }, telefoon: { type: 'string', maxLength: 40 } },
            additionalProperties: false,
          },
          titel: { type: 'string', maxLength: 200, description: 'Standaard de naam van het plan.' },
          ookMetOpenPunten: { type: 'boolean', description: 'Alleen true nadat de gebruiker de vragen uit een eerder antwoord heeft beantwoord of bewust zonder klant door wil.' },
        },
        required: ['planId', 'naar'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    /**
     * Zet het plan om.
     * @param {object} args De invoer.
     * @param {object} req Het verzoek.
     * @returns {Promise<object>} De uitkomst.
     */
    run: async (args, req) => {
      const target = args.naar;
      if (target !== 'offerte' && target !== 'werkorder') return errorOf('Kies naar "offerte" of "werkorder".');
      if (target === 'offerte' && !(req.mcpScopes.has('offertes.concept') && ctx.can(req.user, 'offertes'))) return errorOf('Je mag via deze koppeling geen offertes maken (toestemming of recht ontbreekt).');
      if (target === 'werkorder' && !(req.mcpScopes.has('werkorders.concept') && ctx.can(req.user, 'werkorders'))) return errorOf('Je mag via deze koppeling geen werkorders maken (toestemming of recht ontbreekt).');
      if (!ctx.can(req.user, 'plannen')) return errorOf('Je mag in AquaTech geen plannen bekijken.');
      if (!withinLimit(planReadsPerHour, req)) return errorOf(READS_LIMITED);
      const plan = ctx.getPlan(req, cleanText(args.planId, 64));
      if (!plan) return errorOf('Geen plan met dit id gevonden.');
      let customer = { name: '', contact: '', address: '', email: '', phone: '' };
      let customerId = null;
      const wantedId = cleanText(args.klantId, 64);
      if (wantedId) {
        if (!ctx.can(req.user, 'klanten')) return errorOf('Je mag in AquaTech geen klantgegevens opzoeken. Geef de klant als tekst op (klant.naam) in plaats van klantId.');
        const account = ctx.getCustomer(req, wantedId);
        if (!account || account.disabled) return errorOf('Deze klant bestaat niet (meer). Zoek opnieuw met zoek_klant.');
        customerId = account.id;
        customer = { name: account.companyName || account.displayName, contact: account.companyName ? account.displayName : '', address: account.address || '', email: account.email || '', phone: account.phone || '' };
      } else if (args.klant && typeof args.klant === 'object') {
        customer = { ...customer, name: cleanText(args.klant.naam, 200), email: cleanText(args.klant.email, 200), phone: cleanText(args.klant.telefoon, 40) };
      }
      if (!customerId && !customer.name && args.ookMetOpenPunten !== true) {
        return resultOf({ status: 'terugvragen', aangemaakt: false, vragen: [{ onderwerp: 'klant', vraag: `Voor welke klant is deze ${target}? Zoek hem met zoek_klant of maak hem aan met maak_klant.` }],
          melding: 'Er is nog niets aangemaakt. Leg de vraag voor aan de gebruiker en roep opnieuw aan (of zet ookMetOpenPunten=true als de gebruiker bewust zonder klant door wil).' });
      }
      const profile = ctx.quoteProfile(req);
      const converted = await ctx.planLines(req, plan.data, profile);
      if (converted.problems) return errorOf(`Dit plan kan niet omgezet worden: ${converted.problems.join(' ')}`, { problemen: converted.problems });
      const lines = converted.lines || [];
      if (!lines.length) return errorOf(`Het plan bevat geen materiaal of arbeid om om te zetten. ${(converted.warnings || []).join(' ')}`.trim());
      const planTitle = cleanText(plan.title, 120);
      const title = cleanText(args.titel, 200) || planTitle || (customer.name ? `Beregening ${customer.name}` : 'Beregening');
      const warnings = converted.warnings || [];
      const sourceNote = `Gemaakt via de AI-koppeling uit het plan "${planTitle || plan.id}": controleer regels en aantallen.`;
      const planUrl = ctx.appUrl(req, `beregening/?plan=${encodeURIComponent(plan.id)}`);
      if (target === 'offerte') {
        if (!withinLimit(quotesPerHour, req) || !withinLimit(quotesPerDay, req)) return errorOf('Te veel offertes via de AI-koppeling in korte tijd. Probeer het later opnieuw.');
        // Een offerte mag alleen aan een plan hangen dat is goedgekeurd (zoals in de app); anders staat de offerte los van het plan.
        const approved = plan.review && plan.review.status === 'goedgekeurd';
        const quote = ctx.createDraft(req, { title, intro: profile.intro || '', terms: profile.terms || '', customer, lines, internalNote: [sourceNote, ...warnings].join('\n'), ...(approved ? { planId: plan.id } : {}) }, customerId);
        ctx.audit(req, 'offerte_concept_via_ai', { quoteId: quote.id, number: quote.number, regels: lines.length, planId: plan.id, via: 'plan' });
        return resultOf({
          offerteId: quote.id, nummer: quote.number, status: 'concept', link: ctx.quoteUrl(req, quote.id), planLink: planUrl, totaalExclBtw: quote.totalExcl, totaalInclBtw: quote.totalIncl,
          regels: lines.length, samenvatting: converted.summary, aandachtspunten: warnings, aanPlanGekoppeld: Boolean(approved),
          ...(customerId ? {} : { let_op: 'Niet gekoppeld aan een klant: het adres ontbreekt. Maak of zoek de klant en kies hem in de offerte.' }),
          ...(approved ? {} : { let_op_plan: 'Het plan is nog niet goedgekeurd, dus de offerte is niet aan het plan gekoppeld. Laat het plan in de Beregeningsplanner goedkeuren als dat nodig is.' }),
          melding: 'De offerte staat als concept klaar, met de materiaalprijzen en het uurtarief van AquaTech. Controleer hem in AquaTech en verstuur hem daar zelf.',
        });
      }
      if (!withinLimit(workOrdersPerHour, req) || !withinLimit(workOrdersPerDay, req)) return errorOf('Te veel werkorders via de AI-koppeling in korte tijd. Probeer het later opnieuw.');
      const articles = articlesOf(req.tenantId);
      const steps = lines.filter((line) => line.section === 'arbeid').filter((line) => Number(line.qty) > 0).slice(0, MAX_ORDER_ITEMS).map((line) => ({ phase: 'uitvoering', title: cleanText(line.description, 300), hours: Number(line.qty) }));
      const materials = [];
      const skipped = [];
      for (const line of lines.filter((entry) => entry.section === 'materiaal' && entry.code && Number(entry.qty) > 0)) {
        const match = findArticle(articles, line.code);
        if (!match || (Array.isArray(match.article.subItems) && match.article.subItems.length)) { skipped.push(`${line.code} (${line.qty})`); continue; }
        materials.push({ code: match.article.code, description: match.article.name || line.description, qty: line.qty, unit: match.article.unit || line.unit || 'st' });
      }
      const cappedMaterials = materials.slice(0, MAX_ORDER_ITEMS);
      if (materials.length > MAX_ORDER_ITEMS) skipped.push(`${materials.length - MAX_ORDER_ITEMS} materiaalregels (te veel voor één werkorder)`);
      const internalNote = [sourceNote, ...(!customer.name ? ['Geen klant gekoppeld.'] : []), ...(skipped.length ? [`Niet op de werkorder gezet: ${skipped.join(', ')}.`] : []), ...warnings].join('\n');
      const workOrder = ctx.createWorkOrder(req, { title, customer, instructions: `Uitvoering beregeningsplan. Plan: ${planUrl}`, steps, materials: cappedMaterials, internalNote }, customerId);
      ctx.audit(req, 'werkorder_concept_via_ai', { workOrderId: workOrder.id, number: workOrder.number, stappen: steps.length, materiaal: cappedMaterials.length, planId: plan.id, via: 'plan' });
      return resultOf({
        werkorderId: workOrder.id, nummer: workOrder.number, status: workOrder.status, link: ctx.appUrl(req, `werkorders/?id=${encodeURIComponent(workOrder.id)}`), planLink: planUrl,
        stappen: steps.length, materiaalregels: cappedMaterials.length, nietOpDeWerkorder: skipped, aandachtspunten: warnings,
        melding: 'De werkorder staat klaar (niet ingepland, geen uitvoerder) en het materiaal is gereserveerd. Controleer stappen en materiaal in AquaTech.',
      });
    },
  },
  };
}

module.exports = { createPlanTools };
