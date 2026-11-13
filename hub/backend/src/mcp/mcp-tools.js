// De tools van de MCP-server (mcp-server.js): wat een AI-app (Claude, ChatGPT) namens de gebruiker in AquaTech mag doen.
// - zoek_klant: klanten zoeken (zoals de klantkeuze in de offerte).
// - maak_klant: een particuliere klant aanmaken, met het adres via de postcode (PDOK).
// - zoek_artikelen: artikelen met verkoopprijs (excl. btw) en voorraad zoeken.
// - maak_concept_offerte: een offerte als CONCEPT aanmaken. Prijzen, btw en eenheden komen altijd uit AquaTech, nooit van
//   de AI; twijfel of een onbekend artikel komt als interne notitie bij de regel (de klant ziet die nooit).
// - klant_details: de klantkaart (klantgroep, betaaltermijn, openstaand bedrag, recente offertes en werkorders).
// - prijs_voor_klant: wat een klant voor artikelen betaalt (offerteprijs en webshopprijs met zakelijke prijs/korting) en de voorraad.
// - status_opvragen: de status van een offerte, werkorder, factuur of webshopbestelling op nummer.
// - openstaande_debiteuren: wie nog moet betalen (definitieve, onbetaalde facturen), grootste bedrag eerst.
// - maak_concept_werkorder: een werkorder zonder offerte als NIEUW (open, niet ingepland, geen uitvoerder) aanmaken, met stappen en materiaal.
// - boek_uren en boek_materiaal: uren en materiaalverbruik op een werkorder boeken, altijd op naam van de gebruiker zelf (zoals in de app).
// - maak_rapport_excel: een rapport (urenstaat, openstaande facturen, voorraadlijst) als Excel-bestand; de AI krijgt een link die alleen werkt
//   voor deze gebruiker, ingelogd in AquaTech, 15 minuten lang (mcp-downloads.js). Nooit CSV.
// Onduidelijk? De tools raden niet: zoeken met meerdere treffers geeft keuzeNodig, en maak_concept_offerte maakt niets aan zolang er
//   open punten zijn (status 'terugvragen'); de AI-app vraagt dat aan de gebruiker. Alleen met ookMetOpenPunten=true gaat hij door.
// Elke tool vraagt een recht uit de toestemming (scope) én het recht van de rol van de gebruiker op dit moment.
// Versturen, wijzigen of verwijderen kan de AI niet: daar is geen tool voor.
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { DOCUMENT_KINDS } = require('./mcp-lookups');
const { buildWorkbook } = require('./xlsx-writer');

/** Hoeveel klanten zoek_klant hoogstens teruggeeft. */
const CUSTOMER_RESULTS = 10;
/** Hoeveel regels een concept-offerte via de AI hoogstens heeft. */
const MAX_LINES = 100;
/** Hoeveel stappen en materiaalregels een werkorder via de AI hoogstens krijgt. */
const MAX_ORDER_ITEMS = 50;
/** Werkorders met deze status liggen vast voor wie geen recht planning heeft (zoals in de app). */
const LOCKED_STATUSES = ['gereed', 'geannuleerd'];
/** Binnen hoeveel minuten een gelijke boeking als mogelijk dubbel telt. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
/** De soorten uren die de AI kan boeken (zoals Core.KINDS). */
const HOUR_KINDS = ['werk', 'reistijd', 'meerwerk'];
/** Welke soorten rapport maak_rapport_excel kent, en het recht dat ze vragen. */
const REPORT_RIGHTS = { urenstaat: 'werkorders', openstaande_facturen: 'facturen', voorraadlijst: 'voorraad' };
/** Hoeveel dagen een urenstaat hoogstens beslaat (zoals in de app). */
const MAX_REPORT_DAYS = 400;
/** Hoeveel regels per tabblad een rapport hoogstens krijgt; meer wordt afgekapt en dat staat in de uitkomst. */
const MAX_REPORT_ROWS = 5000;
/** Hoeveel artikelen prijs_voor_klant in één keer prijst. */
const MAX_PRICE_CODES = 25;
/** Het recht dat de app vraagt om een soort document te zien (zelfde als de modules). */
const DOCUMENT_RIGHTS = { offerte: 'offertes', werkorder: 'werkorders', factuur: 'facturen', bestelling: 'beheer' };
/** Het meervoud van een soort document, voor de meldingen. */
const DOCUMENT_PLURALS = { offerte: 'offertes', werkorder: 'werkorders', factuur: 'facturen', bestelling: 'webshopbestellingen' };
/** Waar een soort document in de app staat (bestellingen hebben geen eigen adres per bestelling). */
const DOCUMENT_PAGES = { offerte: 'offertes', werkorder: 'werkorders', factuur: 'facturen', bestelling: 'webshop-bestellingen' };
/** Melding als de leesfuncties (klant_details, prijs_voor_klant, status_opvragen) hun limiet per uur bereiken. */
const READS_LIMITED = 'Te veel opvragingen dit uur via de AI-koppeling. Probeer het later opnieuw of kijk in AquaTech.';
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
 * Een aanwijzing voor de AI als een zoekopdracht niet tot één duidelijk resultaat leidt: meer dan één treffer of geen enkele.
 * @param {number} count Het aantal treffers.
 * @param {string} noun Wat er gezocht werd (klant of artikel).
 * @param {string} ifNone Wat de AI bij geen treffer moet doen.
 * @param {number} cap Het maximale aantal resultaten dat de zoekopdracht teruggeeft.
 * @returns {object} { keuzeNodig, vraag } of een leeg object als er precies één treffer is.
 */
function choiceHint(count, noun, ifNone, cap) {
  if (count === 1) return {};
  if (count === 0) return { keuzeNodig: true, vraag: `Geen ${noun} gevonden. ${ifNone}` };
  // Bij de limiet kan er meer zijn dan wat we tonen: dat niet als exact aantal melden.
  if (count >= cap) return { keuzeNodig: true, vraag: `Er zijn ${cap} of meer mogelijke treffers; alleen de eerste ${cap} worden getoond. Vraag de gebruiker om de zoekterm te verfijnen; kies niet zelf.` };
  return { keuzeNodig: true, vraag: `Er zijn ${count} mogelijke treffers. Vraag de gebruiker welke bedoeld wordt; kies niet zelf.` };
}

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
 *   lookupAddress(invoer), verifyAddress(tekst), articleChoices(tenantId), quoteProfile(req), createDraft(req, data, customerId), quoteUrl(req, id),
 *   appUrl(req, pad), periodLog(req, { from, to, userId }), openInvoiceRows(req, limit), storeReport(req, bestandsnaam, buffer), createWorkOrder(req, data), findWorkOrder(req, nummer), workLogOf(req, werkorderId), bookHours(req, werkorderId, invoer), bookMaterial(req, werkorderId, invoer), today(), customerOverview(req, klantId, gevraagd), defaultPaymentDays(req), customerBalance(req, klantId), priceCart(req, regels, klant),
 *   documentStatus(req, soort, nummer, opties), openInvoices(req, opties), audit(req, actie, detail) }.
 * @returns {{ list: Function, has: Function, call: Function }} De tools.
 */
function createMcpTools(ctx) {
  const articleCache = new Map();
  const quotesPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `mcp-offerte:${req.tenantId}|${req.user.id}` });
  const quotesPerDay = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 150, keyFn: (req) => `mcp-offerte-dag:${req.tenantId}|${req.user.id}` });
  const workOrdersPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => `mcp-werkorder:${req.tenantId}|${req.user.id}` });
  const workOrdersPerDay = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 100, keyFn: (req) => `mcp-werkorder-dag:${req.tenantId}|${req.user.id}` });
  const bookingsPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `mcp-boeken:${req.tenantId}|${req.user.id}` });
  const customersPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `mcp-klant:${req.tenantId}|${req.user.id}` });
  // Leesfuncties samen: genoeg voor een drukke werkdag, maar geen onbeperkt aflopen van nummers of klant-id's.
  const readsPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 300, keyFn: (req) => `mcp-lezen:${req.tenantId}|${req.user.id}` });
  const reportsPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => `mcp-rapport:${req.tenantId}|${req.user.id}` });
  const debtorListsPerHour = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `mcp-debiteuren:${req.tenantId}|${req.user.id}` });

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

  /**
   * De werkorder voor een boeking: bestaat in deze omgeving en is (voor wie niet mag beheren) niet afgerond.
   * @param {object} args De invoer met werkorderNummer.
   * @param {object} req Het verzoek.
   * @returns {{ order?: object, out?: object }} De werkorder, of de uitkomst die de AI moet krijgen.
   */
  function openOrderFor(args, req) {
    if (!withinLimit(readsPerHour, req)) return { out: errorOf(READS_LIMITED) };
    const number = cleanText(args.werkorderNummer, 40);
    const order = number ? ctx.findWorkOrder(req, number) : null;
    if (!order) return { out: errorOf('Geen werkorder met dit nummer gevonden in deze omgeving. Controleer het nummer (bijv. WO-2026-0003).') };
    if (LOCKED_STATUSES.includes(order.status) && !ctx.can(req.user, 'planning')) {
      return { out: errorOf(`Werkorder ${order.number} is afgerond; vraag de planner of beheerder om de registratie aan te passen.`) };
    }
    return { order };
  }

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
        return resultOf({ klanten: items, aantal: items.length, ...choiceHint(items.length, 'klant',
          'Vraag de gebruiker om een andere schrijfwijze of een straat/postcode, en of hij een nieuwe klant wil laten aanmaken. Maak niet zelf een klant aan.', CUSTOMER_RESULTS) });
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
        const exact = found.allWords && (found.items.length === 1 || (found.items.length > 1 && fold(found.items[0].code) === fold(search)));
        return resultOf({ artikelen: found.items.map(articleView), aantal: found.items.length,
          ...(exact ? {} : found.items.length && !found.allWords
            ? { keuzeNodig: true, vraag: 'Geen artikel met alle zoekwoorden. Vraag de gebruiker welk artikel bedoeld is; kies niet zelf.' }
            : choiceHint(found.items.length, 'artikel', 'Vraag de gebruiker welk artikel hij bedoelt, of laat hem iets anders omschrijven. Verzin geen artikelcode.', limit)),
          ...(found.items.length && !found.allWords ? { let_op: 'Geen artikel met alle zoekwoorden; dit zijn de beste gedeeltelijke treffers. Twijfel je, zet dan twijfel=true bij de regel.' } : {}) });
      },
    },
    klant_details: {
      scope: 'klanten.lezen', rights: ['klanten'],
      definition: {
        title: 'Klantkaart bekijken',
        description: 'Geeft de klantkaart van één klant (id uit zoek_klant): klantgroep (particulier/zakelijk), groothandelskorting, betaaltermijn, documenttaal, '
          + 'contactgegevens en, als de gebruiker dat in AquaTech mag zien, het openstaande bedrag en de recente offertes en werkorders.',
        inputSchema: { type: 'object', properties: { klantId: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['klantId'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Geeft de klantkaart.
       * @param {object} args { klantId }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        if (!withinLimit(readsPerHour, req)) return errorOf(READS_LIMITED);
        const customer = ctx.getCustomer(req, cleanText(args.klantId, 64));
        if (!customer) return errorOf('Deze klant bestaat niet. Zoek opnieuw met zoek_klant.');
        const business = customer.customerGroup === 'zakelijk';
        const standardDays = ctx.defaultPaymentDays(req);
        const mayInvoices = ctx.can(req.user, 'facturen');
        const overview = ctx.customerOverview(req, customer.id, { quotes: ctx.can(req.user, 'offertes'), workOrders: ctx.can(req.user, 'werkorders'), invoices: false });
        return resultOf({
          id: customer.id, naam: customer.displayName, bedrijf: customer.companyName || '', actief: !customer.disabled,
          klantgroep: business ? 'zakelijk' : 'particulier',
          ...(business ? { kvkNummer: customer.kvkNumber || '', btwNummer: customer.vatNumber || '',
            groothandel: customer.wholesale ? { korting: customer.wholesaleDiscount } : null } : {}),
          betaaltermijnDagen: customer.paymentDays == null ? standardDays : customer.paymentDays,
          betaaltermijnBron: customer.paymentDays == null ? 'standaard' : 'eigen afspraak',
          documenttaal: customer.documentLanguage === 'en' ? 'Engels' : 'Nederlands',
          email: customer.email || '', telefoon: customer.phone || '', adres: String(customer.address || '').split(/\s*\n\s*/).join(', '),
          ...(mayInvoices ? { openstaand: ctx.customerBalance(req, customer.id) } : {}),
          ...(overview.quotes ? { recenteOffertes: overview.quotes.slice(0, 5).map((quote) => ({ nummer: quote.number, status: quote.status, titel: quote.title, totaalInclBtw: quote.total })) } : {}),
          ...(overview.workOrders ? { recenteWerkorders: overview.workOrders.slice(0, 5).map((order) => ({ nummer: order.number, status: order.status, titel: order.title, geplandOp: order.plannedDate })) } : {}),
          link: ctx.appUrl(req, `klanten/?id=${encodeURIComponent(customer.id)}`),
        });
      },
    },
    prijs_voor_klant: {
      scope: ['artikelen.lezen', 'klanten.lezen'], rights: ['offertes'],
      definition: {
        title: 'Prijs voor een klant',
        description: 'Wat een klant betaalt voor één of meer artikelen (codes uit zoek_artikelen), met de beschikbare voorraad. Geeft de offerteprijs '
          + '(die maak_concept_offerte gebruikt) en de webshopprijs voor deze klant: zakelijke prijs, staffel- en groothandelskorting tellen daar mee.',
        inputSchema: {
          type: 'object',
          properties: {
            klantId: { type: 'string', minLength: 1, maxLength: 64, description: 'Id uit zoek_klant.' },
            artikelen: {
              type: 'array', minItems: 1, maxItems: MAX_PRICE_CODES,
              items: { type: 'object', properties: { artikelcode: { type: 'string', minLength: 1, maxLength: 40 }, aantal: { type: 'integer', minimum: 1, maximum: 9999, default: 1 } },
                required: ['artikelcode'], additionalProperties: false },
            },
          },
          required: ['klantId', 'artikelen'], additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Prijst de artikelen voor de klant.
       * @param {object} args { klantId, artikelen }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        if (!withinLimit(readsPerHour, req)) return errorOf(READS_LIMITED);
        const customer = ctx.getCustomer(req, cleanText(args.klantId, 64));
        if (!customer) return errorOf('Deze klant bestaat niet. Zoek opnieuw met zoek_klant.');
        const wanted = (Array.isArray(args.artikelen) ? args.artikelen : []).slice(0, MAX_PRICE_CODES)
          .map((entry) => ({ code: cleanText(entry && entry.artikelcode, 40), qty: Math.min(9999, Math.max(1, Number.parseInt(entry && entry.aantal, 10) || 1)) }))
          .filter((entry) => entry.code);
        if (!wanted.length) return errorOf('Geef minstens één artikelcode.');
        const business = customer.customerGroup === 'zakelijk';
        const cart = ctx.priceCart(req, wanted, customer);
        const shopLines = new Map(cart.lines.map((line) => [fold(line.code), line]));
        const articles = articlesOf(req.tenantId);
        const items = wanted.map((entry) => {
          const match = findArticle(articles, entry.code);
          if (!match) return { artikelcode: entry.code, gevonden: false };
          const article = match.article;
          if (Array.isArray(article.variants) && article.variants.length) {
            return { artikelcode: article.code, naam: article.name, gevonden: true, let_op: 'Dit artikel heeft varianten: vraag de prijs per variantcode.' };
          }
          const shop = shopLines.get(fold(article.code));
          return {
            artikelcode: article.code, naam: article.name || (match.parent ? match.parent.name : article.code), gevonden: true, aantal: entry.qty, eenheid: article.unit || 'st',
            offerteprijsExclBtw: article.salePrice == null ? null : article.salePrice, btw: article.vatRate == null ? null : article.vatRate, beschikbaar: article.available,
            webshop: shop ? { prijsExclBtw: shop.unitExcl, prijsInclBtw: shop.unitIncl, ...(shop.discountPct ? { kortingProcent: shop.discountPct, kortingVia: shop.discountSource } : {}),
              ...(shop.packProblem ? { let_op: shop.packProblem } : {}) } : null,
          };
        });
        return resultOf({ klant: customer.displayName, klantgroep: business ? 'zakelijk' : 'particulier', groothandel: Boolean(business && customer.wholesale), artikelen: items,
          uitleg: 'offerteprijsExclBtw = de prijs in een offerte. webshop = wat de klant in de webshop betaalt (null als het artikel niet in de webshop staat).' });
      },
    },
    status_opvragen: {
      scope: 'status.lezen', rights: Object.values(DOCUMENT_RIGHTS),
      definition: {
        title: 'Status opvragen',
        description: 'De status van een offerte (bijv. OF-2026-0012), werkorder (WO-2026-0003), factuur of webshopbestelling (WEB-2026-0040) op nummer. '
          + 'Alleen de soorten die de gebruiker in AquaTech mag zien.',
        inputSchema: {
          type: 'object',
          properties: { soort: { type: 'string', enum: DOCUMENT_KINDS }, nummer: { type: 'string', minLength: 1, maxLength: 40 } },
          required: ['soort', 'nummer'], additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Zoekt het document op.
       * @param {object} args { soort, nummer }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        if (!withinLimit(readsPerHour, req)) return errorOf(READS_LIMITED);
        const kind = DOCUMENT_KINDS.includes(args.soort) ? args.soort : '';
        if (!kind) return errorOf(`Kies de soort: ${DOCUMENT_KINDS.join(', ')}.`);
        if (!ctx.can(req.user, DOCUMENT_RIGHTS[kind])) return errorOf(`Je mag in AquaTech geen ${DOCUMENT_PLURALS[kind]} bekijken.`);
        const found = ctx.documentStatus(req, kind, args.nummer, { withWorkOrders: ctx.can(req.user, 'werkorders') });
        if (!found) return errorOf(`Geen ${kind} met dit nummer gevonden in deze omgeving.`);
        const { id, ...shown } = found;
        return resultOf({ soort: kind, ...shown, link: ctx.appUrl(req, kind === 'bestelling' ? `${DOCUMENT_PAGES[kind]}/` : `${DOCUMENT_PAGES[kind]}/?id=${encodeURIComponent(id)}`) });
      },
    },
    openstaande_debiteuren: {
      scope: 'facturen.lezen', rights: ['facturen'],
      definition: {
        title: 'Openstaande debiteuren',
        description: 'Wie er nog moet betalen: definitieve, onbetaalde facturen per klant, grootste bedrag eerst, met het bedrag over de vervaldatum. '
          + 'Bedragen incl. btw; creditnota\'s tellen negatief mee. totaalOpenstaand, totaalTeLaat, aantalDebiteuren en aantalTeLaat gelden altijd voor alle debiteuren; '
          + 'per debiteur komen hoogstens tien facturen mee (facturenGetoond tegenover aantalFacturen).',
        inputSchema: {
          type: 'object',
          properties: {
            alleenTeLaat: { type: 'boolean', description: 'true = alleen klanten met een factuur over de vervaldatum.' },
            maxResultaten: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      /**
       * Geeft het overzicht van openstaande facturen.
       * @param {object} args { alleenTeLaat, maxResultaten }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        if (!withinLimit(debtorListsPerHour, req)) return errorOf('Te vaak opgevraagd dit uur. Probeer het later opnieuw of kijk in AquaTech bij Facturen.');
        const limit = Math.min(50, Math.max(1, Number.parseInt(args.maxResultaten, 10) || 20));
        const out = ctx.openInvoices(req, { onlyLate: args.alleenTeLaat === true, limit });
        return resultOf({ ...out, link: ctx.appUrl(req, 'facturen/') });
      },
    },
    boek_uren: {
      scope: 'werkregistratie.boeken', rights: ['werkorders'],
      definition: {
        title: 'Uren boeken',
        description: 'Boekt uren op een werkorder (nummer, bijv. WO-2026-0003), altijd op naam van de gebruiker zelf; collega\'s kan de AI niet boeken. '
          + 'Geef het aantal uren, of een begin- en eindtijd. Zonder datum geldt vandaag. De regel staat direct in AquaTech bij de werkorder en de gebruiker kan hem daar wijzigen of verwijderen. '
          + 'Is iets onduidelijk (werkorder niet gevonden, afgeronde werkorder, lijkt dubbel), dan boekt de tool niets en geeft status "terugvragen": vraag het aan de gebruiker.',
        inputSchema: {
          type: 'object',
          properties: {
            werkorderNummer: { type: 'string', minLength: 1, maxLength: 40, description: 'Bijv. WO-2026-0003 (zie status_opvragen).' },
            uren: { type: 'number', exclusiveMinimum: 0, maximum: 24, description: 'Aantal uren, bijv. 2.5. Niet nodig als begintijd en eindtijd zijn gegeven.' },
            begintijd: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM.' },
            eindtijd: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM.' },
            pauzeMinuten: { type: 'integer', minimum: 0, maximum: 600, description: 'Alleen met begin- en eindtijd.' },
            datum: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'JJJJ-MM-DD; standaard vandaag. Niet verder dan morgen.' },
            soort: { type: 'string', enum: HOUR_KINDS, description: 'werk (standaard), reistijd of meerwerk.' },
            notitie: { type: 'string', maxLength: 500 },
            ookAlsHetDubbelLijkt: { type: 'boolean', description: 'Alleen true nadat de gebruiker bevestigde dat dezelfde boeking echt nog een keer moet.' },
          },
          required: ['werkorderNummer'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Boekt de uren.
       * @param {object} args De invoer.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const order = openOrderFor(args, req);
        if (order.out) return order.out;
        const hasTimes = Boolean(args.begintijd && args.eindtijd);
        if (!hasTimes && !(Number(args.uren) > 0)) return errorOf('Geef het aantal uren, of een begintijd en eindtijd.');
        if ((args.begintijd || args.eindtijd) && !hasTimes) return errorOf('Geef zowel een begintijd als een eindtijd.');
        const input = {
          workDate: cleanText(args.datum, 10) || ctx.today(), startTime: hasTimes ? cleanText(args.begintijd, 5) : '', endTime: hasTimes ? cleanText(args.eindtijd, 5) : '',
          breakMinutes: hasTimes ? args.pauzeMinuten : 0, hours: hasTimes ? undefined : Number(args.uren), kind: HOUR_KINDS.includes(args.soort) ? args.soort : 'werk', note: cleanText(args.notitie, 500),
        };
        const log = ctx.workLogOf(req, order.order.id);
        const similar = log.hours.find((entry) => entry.user.id === req.user.id && entry.workDate === input.workDate && entry.kind === input.kind
          && Date.now() - Date.parse(entry.createdAt) < DUPLICATE_WINDOW_MS && (hasTimes ? entry.startTime === input.startTime && entry.endTime === input.endTime : entry.minutes === Math.round(input.hours * 60)));
        if (similar && args.ookAlsHetDubbelLijkt !== true) {
          return resultOf({ status: 'terugvragen', geboekt: false, vragen: [{ onderwerp: 'dubbel', vraag: `Er is zojuist al een gelijke boeking gemaakt op ${order.order.number} (${(similar.minutes / 60).toFixed(2)} uur op ${similar.workDate}). Wil de gebruiker dit echt nog een keer boeken? Zo ja, zet ookAlsHetDubbelLijkt=true.` }],
            melding: 'Er is niets geboekt.' });
        }
        if (!withinLimit(bookingsPerHour, req)) return errorOf('Te veel boekingen dit uur via de AI-koppeling. Probeer het later opnieuw of boek in AquaTech.');
        const out = ctx.bookHours(req, order.order.id, input);
        if (out.error) return errorOf(out.message);
        ctx.audit(req, 'uren_geboekt', { workOrderId: order.order.id, number: order.order.number, entryId: out.entry.id, minutes: out.entry.minutes, forUserId: req.user.id, via: 'ai-koppeling' });
        const totalMinutes = log.hours.reduce((sum, entry) => sum + entry.minutes, 0) + out.entry.minutes;
        return resultOf({
          geboekt: true, werkorder: order.order.number, datum: out.entry.workDate, uren: round2(out.entry.minutes / 60), soort: out.entry.kind, boekingId: out.entry.id,
          totaalUrenOpWerkorder: round2(totalMinutes / 60), link: ctx.appUrl(req, `werkorders/?id=${encodeURIComponent(order.order.id)}`),
          melding: 'De uren staan op jouw naam bij de werkorder. Je kunt ze daar in AquaTech zelf wijzigen of verwijderen.',
        });
      },
    },
    boek_materiaal: {
      scope: 'werkregistratie.boeken', rights: ['werkorders'],
      definition: {
        title: 'Materiaal boeken',
        description: 'Boekt verbruikt materiaal op een werkorder (nummer, bijv. WO-2026-0003), altijd op naam van de gebruiker zelf. De voorraad gaat daarbij omlaag, zoals in de app. '
          + 'Gebruik de artikelcode uit zoek_artikelen (bij een artikel met varianten de code van de variant). Zonder datum geldt vandaag. De regel kan in AquaTech worden gewijzigd of verwijderd. '
          + 'Is iets onduidelijk (werkorder of artikel niet gevonden, afgeronde werkorder, lijkt dubbel), dan boekt de tool niets en geeft status "terugvragen".',
        inputSchema: {
          type: 'object',
          properties: {
            werkorderNummer: { type: 'string', minLength: 1, maxLength: 40, description: 'Bijv. WO-2026-0003.' },
            artikelcode: { type: 'string', minLength: 1, maxLength: 40, description: 'Code uit zoek_artikelen.' },
            aantal: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'Verbruikt aantal in de eenheid van het artikel. Een retour boek je in AquaTech.' },
            datum: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'JJJJ-MM-DD; standaard vandaag. Niet verder dan morgen.' },
            notitie: { type: 'string', maxLength: 500 },
            ookAlsHetDubbelLijkt: { type: 'boolean', description: 'Alleen true nadat de gebruiker bevestigde dat dezelfde boeking echt nog een keer moet.' },
          },
          required: ['werkorderNummer', 'artikelcode', 'aantal'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Boekt het materiaal.
       * @param {object} args De invoer.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const order = openOrderFor(args, req);
        if (order.out) return order.out;
        const qty = Number(args.aantal);
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return errorOf('Geef een aantal groter dan nul.');
        const code = cleanText(args.artikelcode, 40);
        const match = code ? findArticle(articlesOf(req.tenantId), code) : null;
        if (!match) {
          return resultOf({ status: 'terugvragen', geboekt: false, vragen: [{ onderwerp: 'artikel', vraag: `Artikelcode ${code || '(leeg)'} bestaat niet. Zoek het juiste artikel met zoek_artikelen en vraag de gebruiker welk artikel bedoeld is.` }], melding: 'Er is niets geboekt.' });
        }
        const article = match.article;
        if (Array.isArray(article.variants) && article.variants.length) {
          return resultOf({ status: 'terugvragen', geboekt: false, vragen: [{ onderwerp: 'variant', vraag: `${article.code} heeft varianten: welke maat/kleur is gebruikt? Gebruik de code van de variant.` }], melding: 'Er is niets geboekt.' });
        }
        const input = {
          usedOn: cleanText(args.datum, 10) || ctx.today(), code: article.code, qty, unit: article.unit || 'st', note: cleanText(args.notitie, 500),
          description: article.name || (match.parent ? `${match.parent.name} ${Object.values(article.values || {}).join(' ')}`.trim() : article.code),
        };
        const log = ctx.workLogOf(req, order.order.id);
        const similar = log.materials.find((entry) => entry.user.id === req.user.id && entry.code === input.code && entry.usedOn === input.usedOn && entry.qty === round2(qty)
          && Date.now() - Date.parse(entry.createdAt) < DUPLICATE_WINDOW_MS);
        if (similar && args.ookAlsHetDubbelLijkt !== true) {
          return resultOf({ status: 'terugvragen', geboekt: false, vragen: [{ onderwerp: 'dubbel', vraag: `Er is zojuist al ${similar.qty} ${similar.unit} ${similar.code} geboekt op ${order.order.number}. Wil de gebruiker dit echt nog een keer boeken? Zo ja, zet ookAlsHetDubbelLijkt=true.` }],
            melding: 'Er is niets geboekt.' });
        }
        if (!withinLimit(bookingsPerHour, req)) return errorOf('Te veel boekingen dit uur via de AI-koppeling. Probeer het later opnieuw of boek in AquaTech.');
        const out = ctx.bookMaterial(req, order.order.id, input);
        if (out.error) return errorOf(out.message);
        ctx.audit(req, 'materiaal_geboekt', { workOrderId: order.order.id, number: order.order.number, entryId: out.entry.id, code: out.entry.code, qty: out.entry.qty, forUserId: req.user.id, via: 'ai-koppeling' });
        return resultOf({
          geboekt: true, werkorder: order.order.number, artikelcode: out.entry.code, omschrijving: out.entry.description, aantal: out.entry.qty, eenheid: out.entry.unit, datum: out.entry.usedOn,
          boekingId: out.entry.id, link: ctx.appUrl(req, `werkorders/?id=${encodeURIComponent(order.order.id)}`),
          melding: 'Het materiaal staat op jouw naam bij de werkorder en is van de voorraad afgeboekt. Je kunt de regel in AquaTech wijzigen of verwijderen.',
        });
      },
    },
    maak_concept_werkorder: {
      scope: 'werkorders.concept', rights: ['werkorders'],
      definition: {
        title: 'Concept-werkorder maken',
        description: 'Maakt een werkorder zonder offerte aan met status Nieuw: niet ingepland en zonder uitvoerder (de planner plant hem in AquaTech). '
          + 'Voor een klus die niet uit een offerte komt, bijvoorbeeld onderhoud of een reparatie. Is iets onduidelijk (klant, artikel, variant), dan maakt deze tool niets aan '
          + 'maar geeft status "terugvragen" met vragen: stel die aan de gebruiker, pas de invoer aan en roep opnieuw aan. Alleen als de gebruiker bewust met open punten door wil: ookMetOpenPunten=true. '
          + 'Artikelen op de werkorder reserveren voorraad; de medewerker kan alles in AquaTech aanpassen.',
        inputSchema: {
          type: 'object',
          properties: {
            klantId: { type: 'string', maxLength: 64, description: 'Id uit zoek_klant of maak_klant (aanbevolen: dan staan naam en werkadres goed).' },
            klant: {
              type: 'object', description: 'Alleen als er geen klantId is: de klantgegevens uit het gesprek (zonder adres).',
              properties: { naam: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 }, telefoon: { type: 'string', maxLength: 40 } },
              additionalProperties: false,
            },
            titel: { type: 'string', minLength: 1, maxLength: 200, description: 'Bijv. "Winterklaar maken beregening".' },
            instructies: { type: 'string', maxLength: 4000, description: 'Wat er moet gebeuren en wat de monteur moet weten.' },
            stappen: {
              type: 'array', maxItems: MAX_ORDER_ITEMS, description: 'De uit te voeren stappen met geplande uren.',
              items: { type: 'object', properties: { titel: { type: 'string', minLength: 1, maxLength: 300 }, uren: { type: 'number', minimum: 0, maximum: 1000 } }, required: ['titel'], additionalProperties: false },
            },
            materiaal: {
              type: 'array', maxItems: MAX_ORDER_ITEMS, description: 'Het benodigde materiaal (wordt gereserveerd in de voorraad).',
              items: {
                type: 'object',
                properties: {
                  artikelcode: { type: 'string', minLength: 1, maxLength: 40, description: 'Code uit zoek_artikelen (bij een artikel met varianten de code van de variant).' },
                  aantal: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
                },
                required: ['artikelcode', 'aantal'], additionalProperties: false,
              },
            },
            ookMetOpenPunten: { type: 'boolean', description: 'Alleen true nadat de gebruiker de vragen uit een eerder antwoord (status "terugvragen") heeft beantwoord of bewust met open punten door wil.' },
          },
          required: ['titel'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Maakt de concept-werkorder.
       * @param {object} args De invoer.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst.
       */
      run: (args, req) => {
        const title = cleanText(args.titel, 200).replace(/\s+/g, ' ');
        if (!title) return errorOf('Geef een titel voor de werkorder.');
        const rawSteps = Array.isArray(args.stappen) ? args.stappen : [];
        const rawMaterials = Array.isArray(args.materiaal) ? args.materiaal : [];
        if (rawSteps.length > MAX_ORDER_ITEMS || rawMaterials.length > MAX_ORDER_ITEMS) return errorOf(`Hoogstens ${MAX_ORDER_ITEMS} stappen en ${MAX_ORDER_ITEMS} materiaalregels.`);
        let customer = { name: '', contact: '', address: '', email: '', phone: '' };
        const wantedId = cleanText(args.klantId, 64);
        if (wantedId) {
          // De klantkaart (adres, e-mail, telefoon) is voor medewerkers met het recht klanten; anderen geven de klant als tekst op.
          if (!ctx.can(req.user, 'klanten')) return errorOf('Je mag in AquaTech geen klantgegevens opzoeken. Geef de klant als tekst op (klant.naam) in plaats van klantId.');
          const account = ctx.getCustomer(req, wantedId);
          if (!account || account.disabled) return errorOf('Deze klant bestaat niet (meer). Zoek opnieuw met zoek_klant.');
          customer = { name: account.companyName || account.displayName, contact: account.companyName ? account.displayName : '', address: account.address || '', email: account.email || '', phone: account.phone || '' };
        } else if (args.klant && typeof args.klant === 'object') {
          customer = { ...customer, name: cleanText(args.klant.naam, 200), email: cleanText(args.klant.email, 200), phone: cleanText(args.klant.telefoon, 40) };
        }
        const questions = [];
        if (!customer.name) questions.push({ onderwerp: 'klant', vraag: 'Voor welke klant is de werkorder? Zoek hem met zoek_klant of maak hem aan met maak_klant.' });
        const steps = [];
        for (const [index, raw] of rawSteps.entries()) {
          const stepTitle = cleanText(raw && raw.titel, 300);
          const hours = Number(raw && raw.uren);
          if (!stepTitle) return errorOf(`Stap ${index + 1}: geef een titel.`);
          if (raw.uren !== undefined && (!Number.isFinite(hours) || hours < 0 || hours > 1000)) return errorOf(`Stap ${index + 1}: geef een geldig aantal uren.`);
          steps.push({ phase: 'uitvoering', title: stepTitle, hours: raw.uren === undefined ? 0 : hours });
        }
        const articles = articlesOf(req.tenantId);
        const materials = [];
        const notes = [];
        for (const [index, raw] of rawMaterials.entries()) {
          const code = cleanText(raw && raw.artikelcode, 40);
          const qty = Number(raw && raw.aantal);
          if (!code) return errorOf(`Materiaalregel ${index + 1}: geef een artikelcode.`);
          if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return errorOf(`Materiaalregel ${index + 1}: geef een aantal groter dan nul.`);
          const match = findArticle(articles, code);
          if (!match) {
            questions.push({ regel: index + 1, vraag: `Artikelcode ${code} bestaat niet. Zoek het juiste artikel met zoek_artikelen en vraag de gebruiker welk artikel bedoeld is.` });
            notes.push(`Materiaal ${code} (${qty}) niet gevonden: niet op de werkorder gezet`);
            continue;
          }
          const article = match.article;
          if (Array.isArray(article.variants) && article.variants.length) {
            questions.push({ regel: index + 1, vraag: `${article.code} heeft varianten: welke maat/kleur is nodig? Gebruik de code van de variant.` });
            notes.push(`Materiaal ${article.code} (${qty}) heeft een maat/variant nodig: niet op de werkorder gezet`);
            continue;
          }
          materials.push({ code: article.code, description: article.name || (match.parent ? `${match.parent.name} ${Object.values(article.values || {}).join(' ')}`.trim() : article.code), qty, unit: article.unit || 'st' });
        }
        if (questions.length && args.ookMetOpenPunten !== true) {
          // Een terugvraag telt mee in de leeslimiet, zodat een AI die steeds terugvraagt niet onbeperkt doorgaat.
          if (!withinLimit(readsPerHour, req)) return errorOf(READS_LIMITED);
          return resultOf({ status: 'terugvragen', aangemaakt: false, vragen: questions,
            melding: 'Er is nog niets aangemaakt. Leg de vragen voor aan de gebruiker, pas de invoer aan en roep opnieuw aan (of zet ookMetOpenPunten=true als de gebruiker bewust met open punten door wil).' });
        }
        if (!withinLimit(workOrdersPerHour, req) || !withinLimit(workOrdersPerDay, req)) return errorOf('Te veel werkorders via de AI-koppeling in korte tijd. Probeer het later opnieuw.');
        const internalNote = ['Aangemaakt via de AI-koppeling: controleer stappen en materiaal.', ...(!customer.name ? ['Geen klant gekoppeld.'] : []), ...notes].join('\n');
        const workOrder = ctx.createWorkOrder(req, { title, customer, instructions: cleanText(args.instructies, 4000), steps, materials, internalNote });
        ctx.audit(req, 'werkorder_concept_via_ai', { workOrderId: workOrder.id, number: workOrder.number, stappen: steps.length, materiaal: materials.length, openPunten: questions.length });
        return resultOf({
          werkorderId: workOrder.id, nummer: workOrder.number, status: workOrder.status, link: ctx.appUrl(req, `werkorders/?id=${encodeURIComponent(workOrder.id)}`),
          stappen: steps.length, materiaalregels: materials.length, ...(notes.length ? { aandachtspunten: notes } : {}),
          ...(customer.name ? {} : { let_op: 'Geen klant op de werkorder.' }),
          melding: 'De werkorder staat klaar met status Nieuw (niet ingepland, geen uitvoerder). Controleer hem in AquaTech en plan hem daar in.',
        });
      },
    },
    maak_rapport_excel: {
      scope: 'rapporten.excel', rights: ['werkorders', 'facturen', 'voorraad'],
      definition: {
        title: 'Rapport als Excel',
        description: 'Maakt een rapport als Excel-bestand (.xlsx) en geeft een downloadlink. De link werkt 15 minuten, alleen voor deze gebruiker en alleen als hij in AquaTech is ingelogd; '
          + 'geef de link aan de gebruiker, open hem niet zelf. Soorten: urenstaat (uren en materiaalverbruik over een periode van hooguit 400 dagen; met het recht planning van iedereen, anders alleen de eigen regels), '
          + 'openstaande_facturen (alle definitieve, onbetaalde facturen per klant) en voorraadlijst (artikelen met prijs en beschikbare voorraad). Er is geen CSV.',
        inputSchema: {
          type: 'object',
          properties: {
            soort: { type: 'string', enum: Object.keys(REPORT_RIGHTS) },
            van: { type: 'string', description: 'Urenstaat: eerste datum (JJJJ-MM-DD).' },
            tot: { type: 'string', description: 'Urenstaat: laatste datum (JJJJ-MM-DD).' },
          },
          required: ['soort'], additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      /**
       * Bouwt het rapport en zet het klaar voor download.
       * @param {object} args { soort, van, tot }.
       * @param {object} req Het verzoek.
       * @returns {object} De uitkomst met de link.
       */
      run: (args, req) => {
        if (!withinLimit(reportsPerHour, req)) return errorOf('Te veel rapporten dit uur via de AI-koppeling. Probeer het later opnieuw of maak het rapport in AquaTech.');
        const kind = Object.prototype.hasOwnProperty.call(REPORT_RIGHTS, args.soort) ? args.soort : '';
        if (!kind) return errorOf(`Kies de soort rapport: ${Object.keys(REPORT_RIGHTS).join(', ')}.`);
        if (!ctx.can(req.user, REPORT_RIGHTS[kind])) return errorOf('Je mag dit rapport in AquaTech niet bekijken.');
        const day = ctx.today();
        let sheets;
        let fileName;
        let summary;
        let truncated = false;
        if (kind === 'urenstaat') {
          /**
           * Of de tekst een bestaande datum (JJJJ-MM-DD) is.
           * @param {string} value De tekst.
           * @returns {boolean} true bij een geldige datum.
           */
          const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
          const from = cleanText(args.van, 10) || `${day.slice(0, 8)}01`;
          const to = cleanText(args.tot, 10) || day;
          if (!isDay(from) || !isDay(to) || from > to) return errorOf('Geef een geldige periode (van en tot als JJJJ-MM-DD, van niet na tot).');
          if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > MAX_REPORT_DAYS) return errorOf(`Kies een periode van hooguit ${MAX_REPORT_DAYS} dagen.`);
          const userId = ctx.can(req.user, 'planning') ? null : req.user.id;
          const fullLog = ctx.periodLog(req, { from, to, userId });
          truncated = fullLog.hours.length > MAX_REPORT_ROWS || fullLog.materials.length > MAX_REPORT_ROWS;
          const log = { hours: fullLog.hours.slice(0, MAX_REPORT_ROWS), materials: fullLog.materials.slice(0, MAX_REPORT_ROWS) };
          sheets = [
            { name: 'Uren', columns: [
              { header: 'Datum', key: 'datum', type: 'date', width: 12 }, { header: 'Medewerker', key: 'medewerker', width: 22 }, { header: 'Werkorder', key: 'werkorder', width: 14 },
              { header: 'Klant', key: 'klant', width: 24 }, { header: 'Soort', key: 'soort', width: 12 }, { header: 'Begin', key: 'begin', width: 8 }, { header: 'Eind', key: 'eind', width: 8 },
              { header: 'Pauze (min)', key: 'pauze', type: 'number', width: 11 }, { header: 'Uren', key: 'uren', type: 'number', width: 8 }, { header: 'Notitie', key: 'notitie', width: 30 }],
            rows: log.hours.map((entry) => ({ datum: entry.workDate, medewerker: entry.user.displayName, werkorder: entry.workOrder ? entry.workOrder.number : '', klant: entry.workOrder ? entry.workOrder.customer : '',
              soort: entry.kind, begin: entry.startTime || '', eind: entry.endTime || '', pauze: entry.breakMinutes, uren: round2(entry.minutes / 60), notitie: entry.note || '' })) },
            { name: 'Materiaal', columns: [
              { header: 'Datum', key: 'datum', type: 'date', width: 12 }, { header: 'Medewerker', key: 'medewerker', width: 22 }, { header: 'Werkorder', key: 'werkorder', width: 14 },
              { header: 'Klant', key: 'klant', width: 24 }, { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'omschrijving', width: 32 },
              { header: 'Eenheid', key: 'eenheid', width: 9 }, { header: 'Aantal', key: 'aantal', type: 'number', width: 9 }, { header: 'Notitie', key: 'notitie', width: 30 }],
            rows: log.materials.map((entry) => ({ datum: entry.usedOn, medewerker: entry.user.displayName, werkorder: entry.workOrder ? entry.workOrder.number : '', klant: entry.workOrder ? entry.workOrder.customer : '',
              code: entry.code || '', omschrijving: entry.description || '', eenheid: entry.unit || '', aantal: entry.qty, notitie: entry.note || '' })) },
          ];
          fileName = `urenstaat-${from}-${to}`;
          summary = { periode: { van: from, tot: to }, aantalUrenregels: fullLog.hours.length, totaalUren: round2(fullLog.hours.reduce((sum, entry) => sum + Number(entry.minutes), 0) / 60),
            aantalMateriaalregels: fullLog.materials.length, alleenEigenRegels: Boolean(userId) };
        } else if (kind === 'openstaande_facturen') {
          const { rows, truncated: tooMany } = ctx.openInvoiceRows(req, MAX_REPORT_ROWS);
          truncated = tooMany;
          sheets = [{ name: 'Openstaand', columns: [
            { header: 'Klant', key: 'klant', width: 28 }, { header: 'Nummer', key: 'nummer', width: 14 }, { header: 'Soort', key: 'soort', width: 12 }, { header: 'Datum', key: 'datum', type: 'date', width: 12 },
            { header: 'Vervaldatum', key: 'vervaldatum', type: 'date', width: 12 }, { header: 'Dagen te laat', key: 'dagen', type: 'number', width: 12 }, { header: 'Bedrag incl. btw', key: 'bedrag', type: 'money', width: 16 }],
          rows: rows.map((invoice) => ({ klant: invoice.klant, nummer: invoice.nummer, soort: invoice.soort, datum: invoice.datum, vervaldatum: invoice.vervaldatum, dagen: invoice.dagenTeLaat, bedrag: invoice.bedragInclBtw })) }];
          fileName = `openstaande-facturen-${day}`;
          summary = { aantalFacturen: rows.length, totaalOpenstaand: tooMany ? ctx.openInvoices(req, { limit: 1 }).totaalOpenstaand : round2(rows.reduce((sum, invoice) => sum + Number(invoice.bedragInclBtw || 0), 0)) };
        } else {
          const rows = [];
          for (const article of articlesOf(req.tenantId)) {
            if (rows.length >= MAX_REPORT_ROWS) { truncated = true; break; }
            const variants = Array.isArray(article.variants) ? article.variants : [];
            if (variants.length) {
              for (const variant of variants) rows.push({ code: variant.code, naam: `${article.name} ${Object.values(variant.values || {}).join(' ')}`.trim(), eenheid: article.unit || 'st', prijs: variant.salePrice, btw: article.vatRate, beschikbaar: variant.available });
            } else rows.push({ code: article.code, naam: article.name, eenheid: article.unit || 'st', prijs: article.salePrice, btw: article.vatRate, beschikbaar: article.available });
          }
          sheets = [{ name: 'Voorraad', columns: [
            { header: 'Code', key: 'code', width: 16 }, { header: 'Naam', key: 'naam', width: 40 }, { header: 'Eenheid', key: 'eenheid', width: 9 },
            { header: 'Prijs excl. btw', key: 'prijs', type: 'money', width: 15 }, { header: 'Btw %', key: 'btw', type: 'number', width: 8 }, { header: 'Beschikbaar', key: 'beschikbaar', type: 'number', width: 12 }], rows }];
          fileName = `voorraadlijst-${day}`;
          summary = { aantalArtikelen: rows.length };
        }
        const stored = ctx.storeReport(req, fileName, buildWorkbook(sheets));
        if (!stored) return errorOf('Het rapport kon nu niet klaargezet worden. Probeer het over een paar minuten opnieuw.');
        ctx.audit(req, 'rapport_via_ai', { soort: kind, via: 'ai-koppeling' });
        return resultOf({ status: 'klaar', soort: kind, ...summary, bestand: stored.fileName, downloadLink: stored.url, geldigTot: new Date(stored.expiresAt).toISOString(),
          ...(truncated ? { afgekapt: true, waarschuwing: `Het rapport bevat hoogstens ${MAX_REPORT_ROWS} regels per tabblad; er zijn er meer. Zeg dat tegen de gebruiker en kies bij een urenstaat een kortere periode.` } : {}),
          let_op: 'Geef de link aan de gebruiker; hij moet in AquaTech ingelogd zijn en de link werkt 15 minuten.' });
      },
    },
    maak_concept_offerte: {
      scope: 'offertes.concept', rights: ['offertes'],
      definition: {
        title: 'Concept-offerte maken',
        description: 'Maakt een offerte als CONCEPT in AquaTech (niet versturen; de medewerker controleert hem). Prijzen, btw en eenheden van artikelen komen uit AquaTech. '
          + 'Is iets onduidelijk (klant, artikel, variant, prijs), dan maakt deze tool niets aan maar geeft status "terugvragen" met vragen: stel die aan de gebruiker, '
          + 'pas de invoer aan en roep opnieuw aan. Alleen als de gebruiker bewust met open punten door wil: ookMetOpenPunten=true. '
          + 'Twijfel=true met een notitie per regel is voor wat de gebruiker zelf onzeker liet; de notitie is intern en de klant ziet hem nooit.',
        inputSchema: {
          type: 'object',
          properties: {
            klantId: { type: 'string', maxLength: 64, description: 'Id uit zoek_klant of maak_klant (aanbevolen: dan staan naam en adres goed).' },
            klant: {
              type: 'object', description: 'Alleen als er geen klantId is: de klantgegevens uit het gesprek (zonder adres).',
              properties: { naam: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 }, telefoon: { type: 'string', maxLength: 40 } },
              additionalProperties: false,
            },
            ookMetOpenPunten: { type: 'boolean', description: 'Alleen true nadat de gebruiker de vragen uit een eerder antwoord (status "terugvragen") heeft beantwoord of bewust wil doorgaan met open punten.' },
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
        const questions = [];
        if (!customerId && !customer.name) questions.push({ onderwerp: 'klant', vraag: 'Voor welke klant is de offerte? Zoek hem met zoek_klant of maak hem aan met maak_klant.' });
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
            if (hasVariants) { notes.push('Kies de maat (variant)'); questions.push({ regel: index + 1, vraag: `${article.code} heeft varianten: welke maat/kleur wil de klant? Gebruik de code van de variant.` }); }
            if (article.salePrice == null) { notes.push('Geen verkoopprijs bekend: prijs invullen'); if (!hasVariants) questions.push({ regel: index + 1, vraag: `${article.code} heeft geen verkoopprijs in AquaTech. Welke prijs excl. btw geldt?` }); }
            line = { section: section || 'materiaal', code: article.code, description: article.name || (match.parent ? `${match.parent.name} ${Object.values(article.values || {}).join(' ')}`.trim() : article.code),
              qty, unit: article.unit || 'st', price: article.salePrice == null ? 0 : article.salePrice, vat: article.vatRate == null ? profile.vatRate : article.vatRate };
            if (raw.prijsExclBtw !== undefined && round2(raw.prijsExclBtw) !== round2(line.price)) {
              notes.push(`Genoemde prijs € ${round2(raw.prijsExclBtw).toFixed(2)} wijkt af van de artikelprijs`);
              questions.push({ regel: index + 1, vraag: `De genoemde prijs € ${round2(raw.prijsExclBtw).toFixed(2)} wijkt af van de artikelprijs € ${round2(line.price).toFixed(2)} van ${article.code}. Welke geldt?` });
            }
          } else {
            const description = cleanText(raw.omschrijving, 500);
            if (!description && !code) return errorOf(`Regel ${index + 1}: geef een artikelcode of een omschrijving.`);
            if (code) { notes.push(`Artikelcode ${code} niet gevonden`); questions.push({ regel: index + 1, vraag: `Artikelcode ${code} bestaat niet. Zoek het juiste artikel met zoek_artikelen en vraag de gebruiker welk artikel bedoeld is.` }); }
            const unit = cleanText(raw.eenheid, 12) || (section === 'arbeid' ? 'uur' : 'st');
            const labor = section === 'arbeid' || /^u(ur|ren)?$/i.test(unit);
            const given = Number(raw.prijsExclBtw);
            const price = raw.prijsExclBtw !== undefined && Number.isFinite(given) && given >= 0 ? round2(given) : labor ? Number(profile.hourlyRate) || 0 : 0;
            if (!labor && raw.prijsExclBtw === undefined) {
              notes.push('Prijs nog invullen');
              if (!code) questions.push({ regel: index + 1, vraag: `"${(description || code).slice(0, 60)}" heeft geen artikel en geen prijs. Welk artikel uit zoek_artikelen is het, of welke prijs excl. btw geldt?` });
            }
            line = { section: section || (labor ? 'arbeid' : 'overig'), code: '', description: description || code, qty, unit, price, vat: profile.vatRate };
          }
          line.note = notes.join(' · ').slice(0, 300);
          if (line.note) problems.push({ regel: index + 1, omschrijving: line.description, notitie: line.note });
          lines.push(line);
        }
        if (questions.length && args.ookMetOpenPunten !== true) {
          // Een terugvraag telt mee in de leeslimiet, zodat een AI die steeds terugvraagt niet onbeperkt doorgaat.
          if (!withinLimit(readsPerHour, req)) return errorOf(READS_LIMITED);
          return resultOf({ status: 'terugvragen', aangemaakt: false, vragen: questions,
            melding: 'Er is nog niets aangemaakt. Leg de vragen voor aan de gebruiker, pas de invoer aan en roep opnieuw aan (of zet ookMetOpenPunten=true als de gebruiker bewust met open punten door wil).' });
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
   * Of de gebruiker van dit verzoek een tool mag gebruiken: elk recht uit de toestemming dat de tool vraagt én het recht van zijn rol.
   * @param {object} tool De tool (scope is één recht of een lijst die allemaal nodig zijn).
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const allowed = (tool, req) => [].concat(tool.scope).every((scope) => req.mcpScopes.has(scope)) && tool.rights.some((right) => ctx.can(req.user, right));

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
