// De tools van de MCP-server (mcp-server.js): wat een AI-app (Claude, ChatGPT) namens de gebruiker in AquaTech mag doen.
// - zoek_klant: klanten zoeken (zoals de klantkeuze in de offerte).
// - maak_klant: een particuliere klant aanmaken, met het adres via de postcode (PDOK).
// - zoek_artikelen: artikelen met verkoopprijs (excl. btw) en voorraad zoeken.
// - maak_concept_offerte: een offerte als CONCEPT aanmaken. Prijzen, btw en eenheden komen altijd uit AquaTech, nooit van
//   de AI; twijfel of een onbekend artikel komt als interne notitie bij de regel (de klant ziet die nooit).
// Elke tool vraagt een recht uit de toestemming (scope) én het recht van de rol van de gebruiker op dit moment.
// Versturen, wijzigen of verwijderen kan de AI niet: daar is geen tool voor.
const { createRateLimiter } = require('../beveiliging/rate-limit');

/** Hoeveel klanten zoek_klant hoogstens teruggeeft. */
const CUSTOMER_RESULTS = 10;
/** Hoeveel regels een concept-offerte via de AI hoogstens heeft. */
const MAX_LINES = 100;
/** Hoelang de artikellijst per omgeving wordt onthouden (prijzen kunnen dus zo lang achterlopen). */
const ARTICLE_CACHE_MS = 30 * 1000;

/**
 * Maakt tekst vergelijkbaar voor zoeken: kleine letters, zonder accenten.
 * @param {*} text De tekst.
 * @returns {string} De vergelijkbare tekst.
 */
const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Korte, schone tekst uit de invoer van de AI (zonder stuurtekens, begrensd).
 * @param {*} value De invoer.
 * @param {number} max Het maximale aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

/**
 * Rondt af op twee decimalen.
 * @param {number} value Het getal.
 * @returns {number} Het afgeronde getal.
 */
const round2 = (value) => Math.round(Number(value) * 100) / 100;

/**
 * De uitkomst van een tool: als tekst (JSON) én als gestructureerde gegevens.
 * @param {object} data De gegevens.
 * @returns {object} De MCP-uitkomst.
 */
const resultOf = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
/**
 * Een fout die de AI moet lezen en waar hij op kan reageren (geen protocolfout).
 * @param {string} message De uitleg.
 * @param {object} [extra] Extra gegevens (bijv. een bestaande klant).
 * @returns {object} De MCP-uitkomst.
 */
const errorOf = (message, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ fout: message, ...extra }) }], structuredContent: { fout: message, ...extra }, isError: true });

/**
 * Zoekt in een lijst artikelen (met varianten) op woorden in code en naam. Eerst artikelen waar alle woorden in staan;
 * zijn die er niet, dan de artikelen met de meeste woorden.
 * @param {object[]} articles De artikelen (stock.articleChoices).
 * @param {string} query De zoektekst.
 * @param {number} limit Hoeveel resultaten.
 * @returns {{ items: object[], allWords: boolean }} De gevonden artikelen en of alle woorden erin stonden.
 */
function searchArticles(articles, query, limit) {
  const words = fold(query).split(/[^a-z0-9.,/-]+/).filter(Boolean).slice(0, 8);
  if (!words.length) return { items: [], allWords: true };
  const scored = [];
  for (const article of articles) {
    const variants = Array.isArray(article.variants) ? article.variants : [];
    const haystack = fold([article.code, article.name, ...variants.map((variant) => `${variant.code} ${variant.name} ${Object.values(variant.values || {}).join(' ')}`)].join(' '));
    const code = fold(article.code);
    const hits = words.filter((word) => haystack.includes(word)).length;
    if (!hits) continue;
    let score = hits * 10;
    if (words.length === 1 && code === words[0]) score += 100;
    else if (words.some((word) => code.startsWith(word))) score += 20;
    scored.push({ article, hits, score });
  }
  const complete = scored.filter((entry) => entry.hits === words.length);
  const chosen = complete.length ? complete : scored;
  chosen.sort((left, right) => right.score - left.score || String(left.article.code).localeCompare(String(right.article.code)));
  return { items: chosen.slice(0, limit).map((entry) => entry.article), allWords: Boolean(complete.length) };
}

/**
 * Een artikel zoals de AI het te zien krijgt.
 * @param {object} article Het artikel (stock.articleChoices).
 * @returns {object} code, naam, eenheid, prijs excl. btw, btw, beschikbaar en de varianten.
 */
const articleView = (article) => ({
  code: article.code, naam: article.name, eenheid: article.unit || 'st', prijsExclBtw: article.salePrice == null ? null : article.salePrice,
  btw: article.vatRate == null ? null : article.vatRate, beschikbaar: article.available,
  ...(Array.isArray(article.variants) && article.variants.length ? {
    varianten: article.variants.slice(0, 30).map((variant) => ({ code: variant.code, naam: variant.name, kenmerken: variant.values || {},
      prijsExclBtw: variant.salePrice == null ? null : variant.salePrice, beschikbaar: variant.available })),
    let_op: 'Gebruik de code van een variant (maat/kleur); de code van het hoofdartikel heeft geen eigen prijs of voorraad.',
  } : {}),
});

/**
 * Zoekt een artikelcode in de lijst (ook de codes van varianten), hoofdletterongevoelig.
 * @param {object[]} articles De artikelen.
 * @param {string} code De code.
 * @returns {{ article: object, parent: object|null }|null} Het artikel (en bij een variant het hoofdartikel), of null.
 */
function findArticle(articles, code) {
  const wanted = fold(code);
  if (!wanted) return null;
  for (const article of articles) {
    if (fold(article.code) === wanted) return { article, parent: null };
    for (const variant of article.variants || []) if (fold(variant.code) === wanted) return { article: variant, parent: article };
  }
  return null;
}

/**
 * Maakt de tools van de MCP-server.
 * @param {object} ctx { can(user, recht), searchCustomers(req, zoektekst), getCustomer(req, id), createCustomer(req, invoer),
 *   lookupAddress(invoer), verifyAddress(tekst), articleChoices(tenantId), quoteProfile(req), createDraft(req, data, customerId), quoteUrl(req, id), audit(req, actie, detail) }.
 * @returns {{ list: Function, has: Function, call: Function }} De tools.
 */
function createMcpTools(ctx) {
  const articleCache = new Map();
  const quotesPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `mcp-offerte:${req.tenantId}|${req.user.id}` });
  const quotesPerDay = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 150, keyFn: (req) => `mcp-offerte-dag:${req.tenantId}|${req.user.id}` });
  const customersPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `mcp-klant:${req.tenantId}|${req.user.id}` });

  /**
   * De artikellijst van een omgeving (30 s onthouden: de AI zoekt vaak een paar keer achter elkaar).
   * @param {string} tenantId De omgeving.
   * @returns {object[]} De artikelen.
   */
  function articlesOf(tenantId) {
    const cached = articleCache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.items;
    const items = ctx.articleChoices(tenantId);
    if (articleCache.size > 200) articleCache.clear();
    articleCache.set(tenantId, { items, expires: Date.now() + ARTICLE_CACHE_MS });
    return items;
  }

  /**
   * Of een begrenzer dit verzoek nog toelaat (zonder een HTTP-antwoord te sturen).
   * @param {Function} limiter De begrenzer (createRateLimiter).
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const withinLimit = (limiter, req) => {
    let allowed = false;
    limiter(req, { setHeader: () => {}, status: () => ({ json: () => {} }) }, () => { allowed = true; });
    return allowed;
  };

  const TOOLS = {
    zoek_klant: {
      scope: 'klanten.lezen', rights: ['offertes', 'klanten'],
      definition: {
        title: 'Klant zoeken',
        description: 'Zoekt bestaande klanten op naam, bedrijfsnaam, e-mail, telefoon of adres (max. 10). Gebruik het id van de klant bij maak_concept_offerte.',
        inputSchema: { type: 'object', properties: { zoekterm: { type: 'string', minLength: 1, maxLength: 100, description: 'Bijv. de achternaam, een straat of een e-mailadres.' } }, required: ['zoekterm'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Zoekt klanten.
       * @param {object} args { zoekterm }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const search = cleanText(args.zoekterm, 100);
        if (!search) return errorOf('Geef een zoekterm.');
        const items = ctx.searchCustomers(req, search).slice(0, CUSTOMER_RESULTS).map((customer) => ({
          id: customer.id, naam: customer.displayName, bedrijf: customer.companyName || '', email: customer.email || '', telefoon: customer.phone || '',
          adres: String(customer.address || '').split(/\s*\n\s*/).join(', '),
        }));
        return resultOf({ klanten: items, aantal: items.length });
      },
    },
    maak_klant: {
      scope: 'klanten.aanmaken', rights: ['klanten'],
      definition: {
        title: 'Klant aanmaken',
        description: 'Maakt een nieuwe particuliere klant (zonder inlog). Zoek eerst met zoek_klant of de klant al bestaat. Het adres komt uit de BAG via postcode en huisnummer; zakelijke klanten maakt de medewerker zelf in AquaTech.',
        inputSchema: {
          type: 'object',
          properties: {
            naam: { type: 'string', minLength: 1, maxLength: 80, description: 'Voor- en achternaam.' },
            email: { type: 'string', maxLength: 200 },
            telefoon: { type: 'string', maxLength: 25 },
            postcode: { type: 'string', maxLength: 10, description: 'Nederlandse postcode, bijv. 8071 AB.' },
            huisnummer: { type: 'string', maxLength: 10 },
            toevoeging: { type: 'string', maxLength: 6 },
            ookAlsNaamBestaat: { type: 'boolean', description: 'Alleen true als zoek_klant een andere klant met dezelfde naam vond en dit echt een nieuwe klant is.' },
          },
          required: ['naam'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Maakt een klant.
       * @param {object} args De invoer.
       * @param {object} req Het verzoek.
       * @returns {Promise<object>} De uitkomst.
       */
      run: async (args, req) => {
        const name = cleanText(args.naam, 80).replace(/\s+/g, ' ');
        if (!name) return errorOf('Geef de naam van de klant.');
        const sameName = ctx.searchCustomers(req, name).filter((customer) => fold(customer.displayName) === fold(name));
        if (sameName.length && args.ookAlsNaamBestaat !== true) {
          return errorOf('Er is al een klant met deze naam. Gebruik die (id), of zet ookAlsNaamBestaat op true als het echt een andere klant is.',
            { bestaand: sameName.map((customer) => ({ id: customer.id, naam: customer.displayName, adres: String(customer.address || '').split(/\s*\n\s*/).join(', '), email: customer.email || '' })) });
        }
        let address = '';
        const postcode = cleanText(args.postcode, 10);
        const houseNumber = cleanText(args.huisnummer, 10);
        if (postcode || houseNumber) {
          let found;
          try {
            found = await ctx.lookupAddress({ postcode, houseNumber, suffix: cleanText(args.toevoeging, 6) });
          } catch (error) {
            if (error.code === 'invalid') return errorOf('Ongeldige postcode of huisnummer.');
            return errorOf('Het adres kon nu niet worden opgezocht (BAG onbereikbaar). Maak de klant zonder adres of probeer het later opnieuw.');
          }
          if (!found.found) {
            return errorOf(found.suffixRequired ? 'Bij dit huisnummer hoort een toevoeging (bijv. A of 2). Vraag die na.'
              : found.suffixUnknown ? 'Deze toevoeging bestaat niet bij dit huisnummer.' : 'Dit adres bestaat niet volgens de BAG. Controleer postcode en huisnummer.');
          }
          address = `${found.street} ${found.houseNumber}${found.suffix || ''}\n${found.postcode} ${found.city}`;
          const verified = await ctx.verifyAddress(address);
          if (!verified.ok) return errorOf(verified.message);
        }
        if (!withinLimit(customersPerHour, req)) return errorOf('Te veel nieuwe klanten dit uur via de AI-koppeling. Probeer het later opnieuw.');
        const out = ctx.createCustomer(req, { displayName: name, email: args.email, phone: args.telefoon, address });
        if (out.error) return errorOf(out.error);
        return resultOf({ id: out.customer.id, naam: out.customer.displayName, adres: address.split('\n').join(', '), email: out.customer.email || '', telefoon: out.customer.phone || '' });
      },
    },
    zoek_artikelen: {
      scope: 'artikelen.lezen', rights: ['offertes', 'voorraad', 'werkorders'],
      definition: {
        title: 'Artikelen zoeken',
        description: 'Zoekt artikelen in het assortiment van AquaTech op code of woorden in de naam (bijv. "pop-up sproeier", "PE buis 25", "beregeningscomputer"). Geeft code, naam, eenheid, verkoopprijs excl. btw, btw-tarief en beschikbare voorraad.',
        inputSchema: {
          type: 'object',
          properties: {
            zoekterm: { type: 'string', minLength: 1, maxLength: 100 },
            maxResultaten: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
          },
          required: ['zoekterm'], additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Zoekt artikelen.
       * @param {object} args { zoekterm, maxResultaten }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const search = cleanText(args.zoekterm, 100);
        if (!search) return errorOf('Geef een zoekterm.');
        const limit = Math.min(25, Math.max(1, Number.parseInt(args.maxResultaten, 10) || 10));
        const found = searchArticles(articlesOf(req.tenantId), search, limit);
        return resultOf({ artikelen: found.items.map(articleView), aantal: found.items.length,
          ...(found.items.length && !found.allWords ? { let_op: 'Geen artikel met alle zoekwoorden; dit zijn de beste gedeeltelijke treffers. Twijfel je, zet dan twijfel=true bij de regel.' } : {}) });
      },
    },
    maak_concept_offerte: {
      scope: 'offertes.concept', rights: ['offertes'],
      definition: {
        title: 'Concept-offerte maken',
        description: 'Maakt een offerte als CONCEPT in AquaTech (niet versturen; de medewerker controleert hem). Prijzen, btw en eenheden van artikelen komen uit AquaTech. '
          + 'Geef bij twijfel twijfel=true en een notitie per regel; die is intern en de klant ziet hem nooit.',
        inputSchema: {
          type: 'object',
          properties: {
            klantId: { type: 'string', maxLength: 64, description: 'Id uit zoek_klant of maak_klant (aanbevolen: dan staan naam en adres goed).' },
            klant: {
              type: 'object', description: 'Alleen als er geen klantId is: de klantgegevens uit het gesprek (zonder adres).',
              properties: { naam: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 }, telefoon: { type: 'string', maxLength: 40 } },
              additionalProperties: false,
            },
            titel: { type: 'string', maxLength: 200, description: 'Bijv. "Beregening achtertuin".' },
            inleiding: { type: 'string', maxLength: 2000, description: 'Korte inleiding voor de klant (optioneel; anders de standaardtekst).' },
            regels: {
              type: 'array', minItems: 1, maxItems: MAX_LINES,
              items: {
                type: 'object',
                properties: {
                  artikelcode: { type: 'string', maxLength: 40, description: 'Code uit zoek_artikelen (bij een artikel met varianten de code van de variant).' },
                  omschrijving: { type: 'string', maxLength: 500, description: 'Verplicht als er geen artikelcode is (bijv. "Sleuf graven en buis leggen").' },
                  aantal: { type: 'number', minimum: 0, maximum: 100000 },
                  eenheid: { type: 'string', maxLength: 12, description: 'Alleen zonder artikelcode, bijv. "uur", "m" of "post".' },
                  soort: { type: 'string', enum: ['materiaal', 'arbeid', 'overig'], description: 'Arbeid = uren (uurtarief uit AquaTech).' },
                  prijsExclBtw: { type: 'number', minimum: 0, maximum: 1000000, description: 'Alleen voor een regel zonder artikelcode die de medewerker met een prijs noemde.' },
                  twijfel: { type: 'boolean', description: 'true als het artikel of aantal niet zeker is.' },
                  notitie: { type: 'string', maxLength: 250, description: 'Interne notitie voor de medewerker (waarom twijfel, wat er gezegd is).' },
                },
                required: ['aantal'], additionalProperties: false,
              },
            },
          },
          required: ['regels'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Maakt de concept-offerte.
       * @param {object} args De invoer.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const rawLines = Array.isArray(args.regels) ? args.regels : [];
        if (!rawLines.length) return errorOf('Geef minstens één regel.');
        if (rawLines.length > MAX_LINES) return errorOf(`Hoogstens ${MAX_LINES} regels.`);
        const profile = ctx.quoteProfile(req);
        let customer = { name: '', contact: '', address: '', email: '', phone: '' };
        let customerId = null;
        const wantedId = cleanText(args.klantId, 64);
        if (wantedId) {
          const account = ctx.getCustomer(req, wantedId);
          if (!account || account.disabled) return errorOf('Deze klant bestaat niet (meer). Zoek opnieuw met zoek_klant.');
          customerId = account.id;
          customer = { name: account.companyName || account.displayName, contact: account.companyName ? account.displayName : '', address: account.address || '', email: account.email || '', phone: account.phone || '' };
        } else if (args.klant && typeof args.klant === 'object') {
          customer = { ...customer, name: cleanText(args.klant.naam, 200), email: cleanText(args.klant.email, 200), phone: cleanText(args.klant.telefoon, 40) };
        }
        const articles = articlesOf(req.tenantId);
        const lines = [];
        const problems = [];
        for (const [index, raw] of rawLines.entries()) {
          if (!raw || typeof raw !== 'object') return errorOf(`Regel ${index + 1} is ongeldig.`);
          const qty = Number(raw.aantal);
          if (!Number.isFinite(qty) || qty < 0 || qty > 100000) return errorOf(`Regel ${index + 1}: geef een geldig aantal.`);
          const notes = [];
          if (raw.twijfel === true) notes.push('AI twijfelt');
          const aiNote = cleanText(raw.notitie, 250);
          if (aiNote) notes.push(aiNote);
          const code = cleanText(raw.artikelcode, 40);
          const section = ['materiaal', 'arbeid', 'overig'].includes(raw.soort) ? raw.soort : null;
          const match = code ? findArticle(articles, code) : null;
          let line;
          if (match) {
            const article = match.article;
            const hasVariants = Array.isArray(article.variants) && article.variants.length > 0;
            if (hasVariants) notes.push('Kies de maat (variant)');
            if (article.salePrice == null) notes.push('Geen verkoopprijs bekend: prijs invullen');
            line = { section: section || 'materiaal', code: article.code, description: article.name || (match.parent ? `${match.parent.name} ${Object.values(article.values || {}).join(' ')}`.trim() : article.code),
              qty, unit: article.unit || 'st', price: article.salePrice == null ? 0 : article.salePrice, vat: article.vatRate == null ? profile.vatRate : article.vatRate };
            if (raw.prijsExclBtw !== undefined && round2(raw.prijsExclBtw) !== round2(line.price)) notes.push(`Genoemde prijs € ${round2(raw.prijsExclBtw).toFixed(2)} wijkt af van de artikelprijs`);
          } else {
            const description = cleanText(raw.omschrijving, 500);
            if (!description && !code) return errorOf(`Regel ${index + 1}: geef een artikelcode of een omschrijving.`);
            if (code) notes.push(`Artikelcode ${code} niet gevonden`);
            const unit = cleanText(raw.eenheid, 12) || (section === 'arbeid' ? 'uur' : 'st');
            const labor = section === 'arbeid' || /^u(ur|ren)?$/i.test(unit);
            const given = Number(raw.prijsExclBtw);
            const price = raw.prijsExclBtw !== undefined && Number.isFinite(given) && given >= 0 ? round2(given) : labor ? Number(profile.hourlyRate) || 0 : 0;
            if (!labor && raw.prijsExclBtw === undefined) notes.push('Prijs nog invullen');
            line = { section: section || (labor ? 'arbeid' : 'overig'), code: '', description: description || code, qty, unit, price, vat: profile.vatRate };
          }
          line.note = notes.join(' · ').slice(0, 300);
          if (line.note) problems.push({ regel: index + 1, omschrijving: line.description, notitie: line.note });
          lines.push(line);
        }
        if (!withinLimit(quotesPerHour, req) || !withinLimit(quotesPerDay, req)) return errorOf('Te veel offertes via de AI-koppeling in korte tijd. Probeer het later opnieuw.');
        const title = cleanText(args.titel, 200) || (customer.name ? `Beregening ${customer.name}` : 'Beregening');
        const intro = cleanText(args.inleiding, 2000) || profile.intro || '';
        const quote = ctx.createDraft(req, { title, intro, terms: profile.terms || '', customer, lines }, customerId);
        ctx.audit(req, 'offerte_concept_via_ai', { quoteId: quote.id, number: quote.number, regels: lines.length, notities: problems.length });
        return resultOf({
          offerteId: quote.id, nummer: quote.number, status: 'concept', link: ctx.quoteUrl(req, quote.id), totaalExclBtw: quote.totalExcl, totaalInclBtw: quote.totalIncl,
          regels: lines.length, aandachtspunten: problems,
          ...(customerId ? {} : { let_op: 'Niet gekoppeld aan een klant: het adres ontbreekt. Maak of zoek de klant en kies hem in de offerte.' }),
          melding: 'De offerte staat als concept klaar. Controleer hem in AquaTech en verstuur hem daar zelf.',
        });
      },
    },
  };

  /**
   * Of de gebruiker van dit verzoek een tool mag gebruiken: het recht uit de toestemming én het recht van zijn rol.
   * @param {object} tool De tool.
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const allowed = (tool, req) => req.mcpScopes.has(tool.scope) && tool.rights.some((right) => ctx.can(req.user, right));

  return {
    /**
     * De tools die deze gebruiker mag gebruiken (voor tools/list).
     * @param {object} req Het verzoek.
     * @returns {object[]} De definities.
     */
    list: (req) => Object.entries(TOOLS).filter(([, tool]) => allowed(tool, req)).map(([name, tool]) => ({ name, ...tool.definition })),
    /**
     * Of er een tool met deze naam bestaat.
     * @param {string} name De naam.
     * @returns {boolean} true als hij bestaat.
     */
    has: (name) => Object.prototype.hasOwnProperty.call(TOOLS, name),
    /**
     * Voert een tool uit. Een fout in de tool zelf komt terug als uitkomst met isError (de AI kan dan iets anders proberen).
     * @param {string} name De naam.
     * @param {object} args De invoer.
     * @param {object} req Het verzoek.
     * @returns {Promise<object>} De uitkomst.
     */
    call: async (name, args, req) => {
      const tool = TOOLS[name];
      if (!allowed(tool, req)) return errorOf('Hiervoor heb je (of heeft deze koppeling) geen toestemming.');
      try {
        return await tool.run(args, req);
      } catch (error) {
        console.error(`[mcp] ${name} mislukt: ${error && error.message}`);
        return errorOf('Er ging iets mis in AquaTech. Probeer het opnieuw of maak de offerte in de app.');
      }
    },
  };
}

module.exports = { createMcpTools, searchArticles, findArticle };
