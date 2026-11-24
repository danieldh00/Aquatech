// Moduleregister van het Aquatech-dashboard.
//
// Een nieuwe module toevoegen:
//   1. maak een map `frontend/<id>/` met een eigen `index.html` (alle URL's
//      relatief, net als de beregeningsplanner);
//   2. voeg hieronder een regel toe met `status: 'actief'` en `href: '<id>/'`.
// De server serveert elke map met een `index.html` automatisch als module
// (ook diepe paden en `<id>` zonder slash), dus aan de backend hoeft niets te
// veranderen. Modules met `status: 'gepland'` staan als "binnenkort" op het
// dashboard en zijn nog niet aan te klikken. `right` bepaalt wie de tegel
// ziet: een recht uit shared/roles.js (of een lijst, één ervan is genoeg),
// bijv. 'beheer' (beheerders) of 'hoofdbeheer' (hoofdbeheerders van het
// platform). Zonder `right` ziet iedereen de module. Met `alt` krijgt wie
// het recht `alt.right` heeft (en niet `alt.unless`) een andere titel en
// omschrijving. `navGroup` plaatst een module in de zijbalk: een sleutel uit
// NAV_GROUPS hieronder (de volgorde van de groepen en van de modules in een
// groep volgt de lijst; een groep met één module is gewoon een link, een groep
// zonder zichtbare modules bestaat niet). `navTitle` is een kortere titel voor
// de zijbalk. Een `href` mag eindigen op een #-adres naar een tabblad van een andere module
// (`artikelen/#orders`); de zijbalk markeert dan het tabblad dat open staat. `partOf` hoort
// bij een andere module: uitgezet als die uit staat en niet apart in Beheer > Modules. Toekomstige pagina's (klanten, inkooporders, leveranciers,
// backorders, te picken, ...) krijgen hun plek door één regel met de juiste
// `navGroup`; zolang `status` niet 'actief' is verschijnt er niets in de zijbalk.
// `configuration` zegt wat bij de module hoort aan instellingen: `sections` (id's uit
// beheer/indeling.js, verborgen in Beheer als de module uit staat), `settings`
// (sleutels uit settings.js die de server dan niet meer wijzigt) en `routes` (API-adressen
// waarvan de server dan alle schrijfacties weigert met 409 `module_off`; lezen blijft
// werken) en `blocked` (patronen met `*` voor één deel van het pad, `/**` aan het eind = alles eronder: daar weigert de server dan ook het lezen). Een nieuwe module met eigen instellingen vult alleen dit veld; Beheer en de
// server volgen vanzelf (zie `isOn`, `hiddenSections`, `lockedSettings`, `lockedRoutes`).
// **Modules aan/uit (Beheer > Modules)**: een module met `category` (sleutel uit CATEGORIES) krijgt daar een kaart met
// een schakelaar en de korte tekst `summary` (`switchTitle` = een andere naam op die kaart). Een onderdeel met een eigen schakelaar is een module met `partOf` en
// `ownSwitch: true`, of een regel in FEATURES (schakelaars zonder eigen pagina; met `category` een eigen kaart, met
// `partOf` een onderdeel van een kaart). `needs` = werkt alleen als die andere module aan staat. Een regel in FEATURES
// met `setting` bedient een bestaande instelling uit settings.js (één waarheid: `{ key }` voor een ja/nee-instelling,
// `{ key, field }` voor een veld in een object); `mainOnly` = alleen in de hoofdtenant; `section` = de sectie van Beheer
// (id uit beheer/indeling.js) met de verdere instellingen, voor de link Instellen. Een nieuw onderdeel staat
// standaard aan (wat ontbreekt in de vlaggen staat aan) en krijgt hier zijn regel in dezelfde PR als de functie zelf:
// een schakelaar verschijnt pas als de server hem ook echt volgt.
// De API controleert de rechten ook zelf. Beheerders en hoofdbeheerders zien de
// modules in een vaste zijbalk (shared/sidebar.js) in plaats van als tegels; een
// nieuwe module verschijnt daar vanzelf.
(function (root) {
  /**
   * De groepen van de zijbalk, in volgorde. `top` en `footer` zijn geen
   * inklapbare groep: bovenaan en in de voetregel staan losse links.
   */
  const NAV_GROUPS = [
    { key: 'top', title: '', icon: 'home' },
    { key: 'verkoop', title: 'Verkoop', icon: 'tag' },
    { key: 'magazijn', title: 'Magazijn', icon: 'box' },
    { key: 'artikelen', title: 'Artikelen', icon: 'box' },
    { key: 'inkoop', title: 'Inkoop', icon: 'truck' },
    { key: 'planner', title: 'Planner & werk', icon: 'sprinkler' },
    { key: 'webshop', title: 'Webshop', icon: 'cart' },
    { key: 'rapportage', title: 'Rapportage', icon: 'chart' },
    { key: 'beheer', title: 'Beheer', icon: 'shield' },
    { key: 'footer', title: '', icon: 'user' },
  ];

  /** De categorieën van Beheer > Modules, in volgorde. */
  const CATEGORIES = [
    { key: 'verkoop', title: 'Verkoop' },
    { key: 'werk', title: 'Planner en werk' },
    { key: 'magazijn', title: 'Magazijn en inkoop' },
    { key: 'webshop', title: 'Webshop' },
    { key: 'klantcontact', title: 'Klantcontact' },
    { key: 'koppelingen', title: 'Koppelingen' },
    { key: 'app', title: 'Dashboard en app' },
  ];

  /** Wat de Hub nodig heeft om te werken en dus geen schakelaar heeft (alleen ter informatie in Beheer > Modules). */
  const ALWAYS_ON = ['Dashboard', 'Klanten', 'Gebruikers en rollen', 'Inloggen en tweestapsverificatie', 'Mijn profiel', 'Beheer en instellingen',
    'Back-ups en hersteltest', 'Updates', 'Bewaking en logboek', 'Mail versturen'];

  /**
   * Schakelaars zonder eigen pagina: een eigen kaart (`category`) of een onderdeel van een module (`partOf`).
   * Met `setting` is de schakelaar de bestaande instelling zelf; zonder `setting` staat hij in de vlaggen van `modules`.
   */
  const FEATURES = [
    { id: 'offertesjablonen', partOf: 'offertes', title: 'Offertesjablonen', configuration: { blocked: ['/api/quote-templates/**'] } },
    { id: 'offerte-opvolging', partOf: 'offertes', title: 'Automatische opvolging', section: 'offerteopvolging', setting: { key: 'quoteFollowUp', field: 'enabled' } },
    { id: 'betalingsherinneringen', partOf: 'facturen', title: 'Betalingsherinneringen en aanmaningen', section: 'paymentreminders', setting: { key: 'paymentReminders', field: 'enabled' } },
    { id: 'factuur-online-betalen', partOf: 'facturen', title: 'Online betalen (klantportaal en betaallink)' },
    { id: 'nacalculatie', category: 'verkoop', needs: 'werkorders', title: 'Nacalculatie', summary: 'Opbrengst, kosten en marge per werkorder.', configuration: { blocked: ['/api/workorders/*/costing'] } },
    { id: 'plan-herkennen-ai', partOf: 'beregening', title: 'Plan herkennen met AI', section: 'ai', configuration: { blocked: ['/api/plan/analyze'] } },
    { id: 'tekening-indienen', partOf: 'beregening', title: 'Tekening indienen zonder account', section: 'access', setting: { key: 'drawingRequests' } },
    { id: 'afspraaklink', partOf: 'planning', title: 'Afspraaklink voor de klant', configuration: { blocked: ['POST /api/workorders/*/share', '/api/workorders/*/send'] } },
    { id: 'bestelvoorstellen-automatisch', partOf: 'voorraad', title: 'Automatische bestelvoorstellen', setting: { key: 'purchaseProposals', field: 'enabled' } },
    { id: 'webshop', category: 'webshop', title: 'Webshop', summary: 'De eigen winkel op het hoofdadres, met de bestellingen.', section: 'webshop', setting: { key: 'storefront' }, mainOnly: true },
    { id: 'webshop-bestellen', partOf: 'webshop', title: 'Bestellen en afrekenen', setting: { key: 'shopOrdering' }, mainOnly: true },
    { id: 'webshop-gast', partOf: 'webshop', title: 'Bestellen als gast', setting: { key: 'shopPayment', field: 'guestCheckout' }, mainOnly: true },
    { id: 'webshop-offerte', partOf: 'webshop', title: 'Offerte aanvragen', setting: { key: 'shopPayment', field: 'quoteRequest' }, mainOnly: true },
    { id: 'webshop-planner', partOf: 'webshop', title: 'Planner in de webshop', setting: { key: 'shopPlanner' }, mainOnly: true },
    { id: 'webshop-analytics', partOf: 'webshop', title: 'Google Analytics', section: 'webshop', setting: { key: 'shopAnalytics', field: 'enabled' }, mainOnly: true },
    { id: 'webshop-clarity', partOf: 'webshop', title: 'Microsoft Clarity', section: 'webshop', setting: { key: 'shopClarity', field: 'enabled' }, mainOnly: true },
    { id: 'installatiedossier', partOf: 'portaal', title: 'Installatiedossier per adres', configuration: { blocked: ['/api/portal/locations/*'] } },
    { id: 'seizoensherinneringen', partOf: 'portaal', title: 'Seizoensherinneringen', section: 'season', setting: { key: 'seasonReminders', field: 'enabled' } },
    { id: 'ai-koppeling', category: 'koppelingen', title: 'AI-koppeling', summary: 'Claude of ChatGPT laten meewerken in de Hub.', section: 'ai-connector', setting: { key: 'aiConnector' } },
  ];

  const MODULES = [
    {
      id: 'portaal',
      category: 'klantcontact',
      switchTitle: 'Klantportaal',
      summary: 'Klanten zien hun offertes, afspraken, werkorders en facturen.',
      navGroup: 'top',
      title: 'Mijn portaal',
      description: 'Alles over uw tuinberegening op één plek: offertes, geplande afspraken, de voortgang van de aanleg, het opleverdossier met foto\'s en een storing of onderhoud melden.',
      href: 'portaal/',
      icon: 'user',
      status: 'actief',
      right: 'portaal',
      configuration: { sections: ['season'], settings: ['seasonReminders'] },
    },
    {
      id: 'nieuws',
      category: 'klantcontact',
      summary: 'Berichten voor collega\'s en klanten en wat er nieuw is in de app.',
      navGroup: 'top',
      title: 'Nieuws',
      description: 'Berichten van je organisatie en wat er nieuw is in de app sinds je vorige bezoek.',
      href: 'nieuws/',
      icon: 'news',
      status: 'actief',
    },
    {
      id: 'offertes',
      category: 'verkoop',
      summary: 'Offertes maken, versturen en digitaal laten tekenen.',
      navGroup: 'verkoop',
      title: 'Offertes',
      description: 'Offertes opbouwen uit een beregeningsplan: stuklijst en arbeid worden overgenomen, met bewerkbare prijzen, korting en btw, klantgegevens en export als PDF of Excel.',
      href: 'offertes/',
      icon: 'quote',
      status: 'actief',
      right: ['offertes', 'offertes.klant'],
      // Een klant (die zelf geen offertes opstelt) ziet de tegel zo.
      alt: { right: 'offertes.klant', unless: 'offertes', title: 'Mijn offertes', description: 'De offertes die voor u klaarstaan: bekijken, afdrukken en akkoord geven of afwijzen.' },
    },
    {
      id: 'webshop-bestellingen',
      partOf: 'webshop',
      navGroup: 'verkoop',
      title: 'Webshopbestellingen',
      navTitle: 'Bestellingen',
      description: 'Bestellingen en retouren uit de eigen webshop: status wijzigen, verzenden met volgcode, retouren goedkeuren of afwijzen, een rapportage van omzet, inkoop en marge, en exporteren naar Excel.',
      href: 'webshop-bestellingen/',
      icon: 'box',
      status: 'actief',
      right: 'beheer',
    },
    {
      id: 'orderpick',
      category: 'magazijn',
      summary: 'Picken en ontvangen met scanner of telefoon.',
      navGroup: 'magazijn',
      title: 'Orderpick',
      description: 'Bestellingen picken in het magazijn: de regels op volgorde van locatie, scannen met scanner of camera, aantal bevestigen, "niet aanwezig" melden en de order afmelden met pakbon en verzendlabel.',
      href: 'orderpick/',
      icon: 'box',
      status: 'actief',
      right: 'orderpick',
    },
    {
      id: 'ontvangst',
      navGroup: 'magazijn',
      partOf: 'voorraad',
      title: 'Goederenontvangst',
      navTitle: 'Ontvangst',
      description: 'Geleverde goederen van een inkooporder ontvangen: de order kiezen of het ordernummer scannen, de artikelen scannen, aantallen bevestigen (deelontvangst kan) en inboeken. Wachtende backorders staan daarna weer klaar om te picken.',
      href: 'orderpick/#ontvangst',
      icon: 'truck',
      status: 'actief',
      right: 'orderpick',
    },
    {
      id: 'klanten',
      navGroup: 'verkoop',
      title: 'Klanten',
      description: 'De klantenlijst: zoeken, een klant aanmaken (adres via postcode), gegevens wijzigen en per klant de offertes, werkorders en facturen zien.',
      href: 'klanten/',
      icon: 'user',
      status: 'actief',
      right: 'klanten',
    },
    {
      id: 'klantdossier',
      category: 'klantcontact',
      summary: 'Alle installaties en foto\'s per klant en locatie bij elkaar.',
      navGroup: 'verkoop',
      title: 'Klantdossiers',
      description: "Per klant alle installaties: oplevering, ontwerp en zones, geplaatste materialen en de foto's van voor, tijdens en na de aanleg. Af te drukken als opleverrapport (PDF).",
      href: 'klantdossier/',
      icon: 'folder',
      status: 'actief',
      right: 'werkorders',
    },
    {
      id: 'facturen',
      category: 'verkoop',
      summary: 'Facturen, creditfacturen en debiteuren.',
      navGroup: 'verkoop',
      title: 'Facturen',
      description: 'Facturen maken vanuit een werkorder of als losse verkoop, met doorlopende nummering, btw per regel en PDF. Crediteren, betalingen bijhouden en exporteren naar de boekhouding (Visma) per omzetcategorie.',
      href: 'facturen/',
      icon: 'invoice',
      status: 'actief',
      right: 'facturen',
      configuration: { sections: ['paymentreminders'], settings: ['paymentReminders'] },
    },
    {
      id: 'voorraad',
      category: 'magazijn',
      switchTitle: 'Artikelen en voorraad',
      summary: 'Artikelen, voorraadstanden, inkoop en leveranciers.',
      navGroup: 'artikelen',
      title: 'Artikelen',
      description: 'Artikelen op voorraad met stand, locatie en minimumvoorraad. Werkorders reserveren hun materialen en boeken ze af bij verbruik of oplevering; ontvangsten, tellingen en correcties, met Excel-export.',
      href: 'artikelen/',
      icon: 'box',
      status: 'actief',
      right: 'voorraad',
      // Bestelvoorstellen: alleen de voorstel-routes vergrendeld, niet /api/purchase-orders zelf (die volgt het recht voorraad).
      configuration: { sections: ['labels', 'bestelvoorstellen'], settings: ['labelTemplates', 'priceFactors', 'purchaseProposals'], routes: ['/api/stock/label-templates', '/api/stock/labels', '/api/stock/price-factors', '/api/purchase-orders/proposals', '/api/orderpick/receipts', '/api/stock-counts', '/api/orderpick/counts', '/api/stock/item-texts'] },
    },
    {
      id: 'bestelvoorstel',
      navGroup: 'inkoop',
      partOf: 'voorraad',
      title: 'Bestelvoorstel',
      description: 'Wat er onder de minimumvoorraad zit, per voorkeursleverancier en aangevuld tot Bestellen tot, met concept-orders en Excel.',
      href: 'artikelen/#reorder',
      icon: 'clipboard',
      status: 'actief',
      right: 'voorraad',
    },
    {
      id: 'inkooporders',
      navGroup: 'inkoop',
      partOf: 'voorraad',
      title: 'Inkooporders',
      description: 'Bestellingen bij leveranciers: een order maken, uit een leveranciersdocument inlezen en de ontvangst inboeken in de voorraad.',
      href: 'artikelen/#orders',
      icon: 'truck',
      status: 'actief',
      right: 'voorraad',
    },
    {
      id: 'prijsfactor',
      navGroup: 'inkoop',
      partOf: 'voorraad',
      title: 'Prijsfactor',
      description: 'Verkoopprijs uit de inkoopprijs maal een factor (standaard, per categorie, leverancier of artikel), met afronding, marge en een voorbeeld voordat de prijzen worden doorgevoerd.',
      href: 'artikelen/#pricefactor',
      icon: 'tag',
      status: 'actief',
      right: 'voorraad',
    },
    {
      id: 'leveranciers',
      navGroup: 'inkoop',
      partOf: 'voorraad',
      title: 'Leveranciers',
      description: 'Leveranciers met artikelnummer, inkoopprijs en bestelhoeveelheid per artikel en een voorkeursleverancier.',
      href: 'artikelen/#suppliers',
      icon: 'handshake',
      status: 'actief',
      right: 'voorraad',
    },
    {
      id: 'mutaties',
      navGroup: 'inkoop',
      partOf: 'voorraad',
      title: 'Voorraadmutaties',
      navTitle: 'Mutaties',
      description: 'Het logboek van alle voorraadboekingen: ontvangsten, verbruik, tellingen en correcties, met Excel-export.',
      href: 'artikelen/#moves',
      icon: 'table',
      status: 'actief',
      right: 'voorraad',
    },
    {
      id: 'beregening',
      category: 'werk',
      summary: 'Tuin tekenen, sproeiers plaatsen en een stuklijst maken.',
      navGroup: 'planner',
      title: 'Beregeningsplanner',
      description: 'Tuinberegening ontwerpen: vlakken tekenen of een plan laten herkennen, sproeiers, zones en leidingen, en een stuklijst met Excel-export.',
      href: 'beregening/',
      icon: 'sprinkler',
      status: 'actief',
      right: 'plannen',
      configuration: { sections: ['sproeiers'], routes: ['/api/sprinkler-library'] },
    },
    {
      id: 'plannen',
      partOf: 'beregening',
      ownSwitch: true,
      navGroup: 'planner',
      title: 'Plannenoverzicht',
      description: 'Alle beregeningsplannen in één tabel: projectnaam, klant, adres, oppervlaktes, sproeiers en zones, met Excel-export. Installateurs en beheerders zien de plannen van de hele organisatie.',
      href: 'plannen/',
      icon: 'table',
      status: 'actief',
      right: 'plannen',
      alt: { right: 'plannen', unless: 'plannen.alle', title: 'Mijn plannen', description: 'Uw beregeningsplannen in één tabel: projectnaam, adres, oppervlaktes, sproeiers en zones, met Excel-export.' },
    },
    {
      id: 'planning',
      category: 'werk',
      summary: 'Agenda per dag, week en maand, met een afspraaklink voor de klant.',
      navGroup: 'planner',
      title: 'Planning',
      description: 'Weekagenda van de werkorders per uitvoerder: inplannen door te slepen, en de klant bevestigt de afspraak via een link.',
      href: 'planning/',
      icon: 'calendar',
      status: 'actief',
      right: 'planning',
    },
    {
      id: 'werkorders',
      category: 'werk',
      summary: 'Uitvoering met werkstappen, uren, materiaal en foto\'s.',
      navGroup: 'planner',
      title: 'Werkorders',
      description: 'Werkorders uit geaccordeerde offertes: uitvoeringsplan met werkstappen en uren, zone-indeling, materiaallijst om te verzamelen, planning, toewijzing en een werkbon als PDF of Excel.',
      href: 'werkorders/',
      icon: 'clipboard',
      status: 'actief',
      right: 'werkorders',
    },
    {
      id: 'meldingen',
      category: 'werk',
      summary: 'Storingen en onderhoudsverzoeken van klanten.',
      navGroup: 'planner',
      title: 'Meldingen',
      description: 'Storingen en onderhoudsverzoeken die klanten via hun portaal melden, met foto\'s: reageren en er met één klik een werkorder van maken.',
      href: 'meldingen/',
      icon: 'alert',
      status: 'actief',
      right: 'werkorders',
    },
    {
      id: 'uitbesteden',
      category: 'werk',
      needs: 'werkorders',
      summary: 'Werk doorgeven aan een andere organisatie op het platform.',
      navGroup: 'planner',
      title: 'Uitbesteden',
      description: 'Te veel werk? Bied een werkorder aan bij een andere organisatie op het platform, of neem opdrachten van anderen aan. Staat aan als de beheerder het in de instellingen aanzet.',
      href: 'uitbesteden/',
      icon: 'handshake',
      status: 'actief',
      right: 'uitbesteden',
      configuration: { sections: ['outsourcing'], settings: ['outsourcing'], routes: ['/api/outsourcing'] },
    },
    {
      id: 'beheer',
      navGroup: 'beheer',
      title: 'Beheer',
      description: 'Historie van alle aanvragen, de plannen van alle gebruikers, gebruikersbeheer en de instellingen van de app (API-sleutel, toegangscode, modules).',
      href: 'beheer/',
      icon: 'shield',
      status: 'actief',
      right: 'beheer',
    },
    {
      id: 'hoofdbeheer',
      navGroup: 'footer',
      title: 'Hoofdbeheer',
      description: 'Alle tenants (klanten) van het platform: aanmaken, wijzigen, uitschakelen, gebruikers beheren en testomgevingen naast live draaien.',
      href: 'hoofdbeheer/',
      icon: 'globe',
      status: 'actief',
      right: 'hoofdbeheer',
    },
  ];

  // Iconen (SVG-paden, 24x24) voor de tegels en de zijbalk.
  const ICONS = {
    news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 8h3v9a2 2 0 0 1-2 2"/><path d="M7.5 9h6"/><path d="M7.5 12.5h6"/><path d="M7.5 16h4"/>',
    handshake: '<path d="M3 8h4l5 4 5-4h4"/><path d="M7 8v7l5 4 5-4V8"/><path d="m10 13 2 2 2-2"/>',
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    sprinkler: '<path d="M12 21v-6"/><path d="M8 21h8"/><circle cx="12" cy="12" r="3"/><path d="M5 9c1.5-2 4-3.5 7-3.5S17.5 7 19 9"/><path d="M2.5 6C5 3.5 8.3 2 12 2s7 1.5 9.5 4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5"/><path d="M12 12v9"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M3 14h18"/><path d="M9 9v11"/>',
    invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h3"/>',
    quote: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6"/><path d="M10 17h6"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 12 2 2 4-4"/><path d="M9 17h6"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="14" r="2.5"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    cart: '<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
    truck: '<path d="M2 6h11v10H2z"/><path d="M13 9h4l4 3v4h-8z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/>',
    module: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  };
  /**
   * SVG-icoon voor een module.
   * @param {string} name Sleutel in ICONS (onbekend = module).
   * @returns {string} De SVG als HTML.
   */
  const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.module}</svg>`;

  /**
   * De modules die iemand met deze rechten ziet (tegels en zijbalk), met de
   * `alt`-titel waar die geldt.
   * @param {string[]} rights Rechten van de gebruiker.
   * @param {object} [disabled] De instelling `modules` uit api/config (een beheerder kan modules uitzetten; beheer blijft altijd).
   * @returns {object[]} De zichtbare modules.
   */
  function visible(rights, disabled) {
    /**
     * Heeft de gebruiker (een van) deze rechten?
     * @param {string|string[]} wanted Recht of lijst van rechten.
     * @returns {boolean} true als er één klopt.
     */
    const has = (wanted) => [].concat(wanted).some((right) => (rights || []).includes(right));
    return MODULES
      .filter((module) => !module.right || has(module.right))
      .filter((module) => isOn(disabled, module.id))
      .map((module) => (module.alt && has(module.alt.right) && !has(module.alt.unless) ? { ...module, ...module.alt } : module));
  }

  /**
   * Wie krijgt de vaste zijbalk in plaats van het tegeldashboard (shared/sidebar.js): beheerders en hoofdbeheerders.
   * @param {string[]} rights Rechten van de gebruiker.
   * @returns {boolean} true voor de zijbalk.
   */
  const usesSidebar = (rights) => (rights || []).includes('beheer') || (rights || []).includes('hoofdbeheer');

  /**
   * Deelt de modules in over de groepen van de zijbalk (zuivere functie, getest).
   * Een module met een onbekende of ontbrekende `navGroup` komt als losse link
   * onderaan de hoofdlijst terecht, zodat er niets zoekraakt.
   * @param {object[]} items De modules die de gebruiker ziet (al op status en recht gefilterd).
   * @returns {{key: string, title: string, icon: string, items: object[]}[]} De groepen met minstens één module, in de volgorde van NAV_GROUPS; losse modules in een groep `overig` vóór `beheer`.
   */
  function navSections(items) {
    const known = new Set(NAV_GROUPS.map((group) => group.key));
    const sections = NAV_GROUPS.map((group) => ({ ...group, items: items.filter((module) => module.navGroup === group.key) }));
    const loose = items.filter((module) => !known.has(module.navGroup));
    if (loose.length) sections.splice(sections.findIndex((section) => section.key === 'beheer'), 0, { key: 'overig', title: '', icon: 'module', items: loose });
    return sections.filter((section) => section.items.length);
  }


  /**
   * Zoekt een module of schakelaar op.
   * @param {string} id Id uit MODULES of FEATURES.
   * @returns {object|undefined} De regel, of niets als de id onbekend is.
   */
  const entryOf = (id) => MODULES.find((module) => module.id === id) || FEATURES.find((feature) => feature.id === id);

  /**
   * Staat deze module of dit onderdeel aan? Een onderdeel (`partOf`) volgt zijn hoofdmodule en `needs` de module die
   * het nodig heeft; Beheer en Hoofdbeheer staan altijd aan.
   * @param {object} [flags] De vlaggen zoals ze gelden (id → false = uit; wat ontbreekt staat aan).
   * @param {string} id Id van de module of het onderdeel.
   * @returns {boolean} true als het aan staat.
   */
  function isOn(flags, id) {
    if (id === 'beheer' || id === 'hoofdbeheer') return true;
    const own = entryOf(id);
    const off = flags || {};
    if (own && own.partOf && !isOn(off, own.partOf)) return false;
    if (own && own.needs && !isOn(off, own.needs)) return false;
    return off[id] !== false;
  }

  /**
   * De titel van een module of schakelaar zoals Beheer > Modules hem toont.
   * @param {string} id Id uit MODULES of FEATURES.
   * @returns {string} De titel (de id zelf als die onbekend is).
   */
  const titleOf = (id) => { const entry = entryOf(id); return entry ? entry.switchTitle || entry.title : id; };

  /**
   * De indeling van Beheer > Modules: per categorie de kaarten (modules en losse schakelaars) met hun onderdelen.
   * @returns {{key: string, title: string, cards: {id: string, title: string, summary: string, needs: string, parts: {id: string, title: string}[]}[]}[]} De categorieën met minstens één kaart.
   */
  function switchTree() {
    const candidates = [...MODULES, ...FEATURES];
    /**
     * De onderdelen met een eigen schakelaar van een kaart.
     * @param {string} cardId Id van de kaart.
     * @returns {{id: string, title: string}[]} De onderdelen, in de volgorde van het register.
     */
    const partsOf = (cardId) => candidates
      .filter((entry) => entry.partOf === cardId && (entry.ownSwitch || FEATURES.includes(entry)))
      .map((entry) => ({ id: entry.id, title: entry.title }));
    return CATEGORIES.map((category) => ({
      ...category,
      cards: candidates.filter((entry) => entry.category === category.key && !entry.partOf && entry.status !== 'gepland')
        .map((entry) => ({ id: entry.id, title: entry.switchTitle || entry.title, summary: entry.summary || '', needs: entry.needs || '', parts: partsOf(entry.id) })),
    })).filter((category) => category.cards.length);
  }

  /**
   * Alle id's die in Beheer > Modules een schakelaar hebben.
   * @returns {string[]} De id's van kaarten en onderdelen.
   */
  const switchIds = () => switchTree().flatMap((category) => category.cards.flatMap((card) => [card.id, ...card.parts.map((part) => part.id)]));

  /**
   * De modules en onderdelen die uit staan en een `configuration` hebben.
   * @param {object} [flags] De vlaggen zoals ze gelden.
   * @returns {object[]} De configuratie-blokken van wat uit staat.
   */
  const offConfigurations = (flags) => [...MODULES, ...FEATURES].filter((entry) => entry.configuration && !isOn(flags, entry.id)).map((entry) => entry.configuration);

  /**
   * Id's van de Beheer-secties die bij uitgezette modules horen (Beheer verbergt ze).
   * @param {object} [flags] De instelling `modules`.
   * @returns {Set<string>} Sectie-id's uit beheer/indeling.js.
   */
  const hiddenSections = (flags) => new Set(offConfigurations(flags).flatMap((configuration) => configuration.sections || []));

  /**
   * Sleutels van instellingen die bij uitgezette modules horen (de server weigert een wijziging).
   * @param {object} [flags] De instelling `modules`.
   * @returns {Set<string>} Sleutels uit settings.js.
   */
  const lockedSettings = (flags) => new Set(offConfigurations(flags).flatMap((configuration) => configuration.settings || []));

  /**
   * API-adressen die bij uitgezette modules horen (de server weigert daar schrijfacties).
   * @param {object} [flags] De instelling `modules`.
   * @returns {string[]} Adressen, zonder slash aan het eind.
   */
  const lockedRoutes = (flags) => offConfigurations(flags).flatMap((configuration) => configuration.routes || []);

  /**
   * API-adressen die helemaal dicht zijn (ook lezen) omdat het onderdeel zelf is uitgezet: patronen waarin `*` voor
   * precies één deel van het pad staat (zie `configuration.blocked` in het register). Staat alleen de module erboven
   * uit, dan geldt de bestaande regel van die module (schrijven dicht, lezen blijft).
   * @param {object} [flags] De vlaggen zoals ze gelden.
   * @returns {string[]} De patronen.
   */
  const blockedRoutes = (flags) => [...MODULES, ...FEATURES].filter((entry) => (flags || {})[entry.id] === false).flatMap((entry) => (entry.configuration && entry.configuration.blocked) || []);

  /**
   * Past een pad bij een patroon uit `blocked`? Per deel vergeleken, `*` = één willekeurig deel, even veel delen; een
   * patroon dat op `/**` eindigt geldt voor het adres ervoor en alles eronder. Begint het patroon met een methode
   * (`POST /api/…`), dan geldt het alleen voor die methode.
   * @param {string} pattern Het patroon uit `configuration.blocked`.
   * @param {string} routePath Het pad in kleine letters, zonder slash aan het eind.
   * @param {string} [method] De methode van het verzoek; weggelaten = elke methode.
   * @returns {boolean} true als het pad onder het patroon valt.
   */
  function matchesRoute(pattern, routePath, method) {
    const [onlyMethod, address] = pattern.includes(' ') ? pattern.split(' ') : ['', pattern];
    if (onlyMethod && method && onlyMethod !== String(method).toUpperCase()) return false;
    const open = address.endsWith('/**');
    const wanted = (open ? address.slice(0, -3) : address).split('/');
    const given = routePath.split('/');
    if (open ? given.length < wanted.length : given.length !== wanted.length) return false;
    return wanted.every((part, index) => part === '*' || part === given[index]);
  }

  /**
   * Vraagt (via het gedeelde verzoek api/config van de pagina) of een module of onderdeel aan staat. Bij twijfel (geen
   * antwoord, file://) aan: de server weigert zelf wat uit staat.
   * @param {string} id Id van de module of het onderdeel.
   * @returns {Promise<boolean>} true als het aan staat.
   */
  function featureOn(id) {
    const common = root.AquatechCommon;
    if (!common || !common.getJson) return Promise.resolve(true);
    return common.getJson('api/config').then((config) => isOn((config && config.modules) || {}, id)).catch(() => true);
  }

  root.AquatechModules = MODULES;
  /**
   * Aantal nieuwe items bij Nieuws (api/me `news`) als bolletje; de pagina Nieuws
   * haalt ze weg ([data-news-count]) zodra alles gezien is.
   * @param {number} count Aantal nieuwe items.
   * @returns {string} HTML van het bolletje (leeg bij 0).
   */
  const newsBadge = (count) => (count > 0 ? `<span class="news-count" data-news-count title="Nieuw sinds je vorige bezoek">${count > 9 ? '9+' : count}</span>` : '');

  root.AquatechModuleTools = { ICONS, NAV_GROUPS, CATEGORIES, FEATURES, ALWAYS_ON, entryOf, titleOf, switchTree, switchIds, icon, visible, usesSidebar, navSections, newsBadge, isOn, hiddenSections, lockedSettings, lockedRoutes, blockedRoutes, matchesRoute, featureOn };
  // Voor de server: de hulpfuncties hangen als `tools` aan de geëxporteerde lijst (niet-opsombaar, de lijst blijft een gewone array).
  if (typeof module !== 'undefined' && module.exports) module.exports = Object.defineProperty(MODULES, 'tools', { value: root.AquatechModuleTools });
})(typeof window !== 'undefined' ? window : globalThis);
