// Wat is nieuw: het versielogboek voor gebruikers, in gewone taal (de
// technische details staan in CHANGELOG.md). Gedeeld door de server (require,
// voor de melding "nieuw sinds je vorige bezoek") en de pagina Nieuws.
//
// Bij elke versie-bump een regel bovenaan toevoegen (test/news.test.js
// controleert dat de versie uit package.json erin staat). Alleen wat een
// gebruiker merkt; een versie zonder zichtbare wijziging krijgt
// `items: []` en wordt dan niet getoond.
//
// Per punt `for`: de rechten (shared/roles.js) waarvan er één nodig is om
// het punt te zien; zonder `for` ziet iedereen het. Zo ziet een klant geen
// nieuws over de planning en een installateur geen nieuws over Beheer.
(function (root) {
  const RELEASES = [
    {
      version: '1.46.9',
      date: '2026-11-27',
      title: 'Ontbrekende webshopartikelen: subartikelen terugzetten en koppelen',
      items: [
        { text: '*Ontbrekende uit webshop toevoegen* zet nu ook gearchiveerde subartikelen terug en koppelt subartikelen die nog niet aan hun webshopproduct hangen. Zo komen ook de artikelen terug die bij het samenvoegen in een artikelgroep zijn gekomen. De Excel (tabblad *Teruggezet*) toont per artikel wat er is gebeurd.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.8',
      date: '2026-11-27',
      title: 'Oude artikelnummers vindbaar in de shop en de AI-koppeling',
      items: [
        { text: 'Een artikel dat een nieuwe sprekende code kreeg, is in de webshop en via de AI-koppeling ook nog te vinden op zijn oude nummer.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.7',
      date: '2026-11-27',
      title: 'Bestaande artikelen omzetten naar sprekende codes',
      items: [
        { text: 'Onder Artikelen > Beheer staat Bestaande omzetten: elk bestaand artikel krijgt een voorstel voor soort, diameter, draadmaat en nieuwe code. Je past aan wat niet klopt, vinkt aan en zet om. De oude code blijft als zoeknaam bestaan, en de lijst is als Excel te bewaren.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.6',
      date: '2026-11-27',
      title: 'Orderhistorie uit WordPress naar Import en export',
      items: [
        { text: 'De orderhistorie uit WordPress staat niet meer onder *Past bij* maar onder *Import en export*, bij de tijdelijke webshopknoppen. Na *Ontbrekende uit webshop toevoegen* worden de orderregels zonder artikel meteen opnieuw gekoppeld.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.5',
      date: '2026-11-27',
      title: 'Past bij: aantal regels per pagina kiezen',
      items: [
        { text: 'Bij Artikelen > Past bij kies je nu hoeveel regels je per pagina ziet, net als bij de artikellijst. De keuze geldt voor beide lijsten.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.4',
      date: '2026-11-27',
      title: 'Gearchiveerde webshopartikelen terugzetten',
      items: [
        { text: '*Ontbrekende uit webshop toevoegen* zet artikelen die wel bestaan maar gearchiveerd zijn (bijvoorbeeld 110-12) weer terug als de webshop ze nog verkoopt, en koppelt ze aan het webshopproduct. Prijs en voorraad blijven zoals ze waren. De Excel heeft een tabblad *Teruggezet*; voor wat overblijft staat de reden duidelijker in *Overgeslagen* (bijvoorbeeld al een subartikel van een artikelgroep).', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.3',
      date: '2026-11-27',
      title: 'Subartikelen van klein naar groot en oude nummers in de keuzelijst',
      items: [
        { text: 'In de artikellijst en de keuzelijst (offerte, werkorder) zoek je ook op oude nummers, en subartikelen staan van klein naar groot.', for: ['voorraad'] },
        { text: 'Het formulier Nieuw voorraadartikel sluit nu bij het wisselen van pagina en blijft niet meer staan.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.2',
      date: '2026-11-27',
      title: 'Reden per overgeslagen webshopartikel',
      items: [
        { text: '*Ontbrekende uit webshop toevoegen* toont nu per overgeslagen artikel waarom het niet is toegevoegd (code bestaat al, ongeldige of te lange code, hoofdproduct ontbreekt). Het venster telt de redenen en de Excel heeft een tabblad *Overgeslagen* met sku, voorgestelde code, omschrijving, reden en webshopadres.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.1',
      date: '2026-11-27',
      title: 'Artikelen: code laten voorstellen en oude nummers zoeken',
      items: [
        { text: 'Bij een nieuw artikel kies je een soort, diameter en draadmaat en het formulier stelt de code voor (bijvoorbeeld UD.KBI.20.34). Een uitgegeven code verandert niet meer.', for: ['voorraad'] },
        { text: 'In de artikellijst zoek je ook op oude nummers.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.46.0',
      date: '2026-11-27',
      title: 'Merken en soorten voor sprekende artikelcodes',
      items: [
        { text: 'Nieuw onderdeel Artikelen > Merken & soorten: leg merken (bijvoorbeeld UD) en soorten (bijvoorbeeld KBI) vast waaruit de artikelcodes worden opgebouwd, met of zonder merk (UD.KBI.20.12 of KBI.20.12). Je kunt er een codevoorstel proberen met diameter en draadmaat in duimen. Het artikelformulier zelf volgt in de volgende stap.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.45.6',
      date: '2026-11-26',
      title: 'Artikelgroepen en subartikelen overal dezelfde naam',
      items: [
        { text: 'Een artikel met maten heet overal een artikelgroep, en de maten eronder heten subartikelen. Er verandert niets aan hoe je werkt.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.45.5',
      date: '2026-11-26',
      title: 'Specificaties in één keer vullen in plaats van AI-teksten',
      items: [
        { text: 'Artikelen > Teksten: *Specificaties vullen* zoekt technische kenmerken op (bij voorkeur bij bosta.com) en zet ze als overzicht bij het artikel. Eigen specificaties blijven staan.', for: ['voorraad'] },
        { text: 'Door de AI geschreven omschrijvingen worden in de webshop niet meer getoond; de specificaties staan wel op de productpagina. De teksten blijven bewaard.' },
      ],
    },
    {
      version: '1.45.4',
      date: '2026-11-26',
      title: 'Artikelen overzichtelijker met subpagina\'s in de zijbalk',
      items: [
        { text: 'Artikelen is opgedeeld: in de zijbalk staan onder Artikelen nu subpagina\'s (Alle artikelen, Voorraad: Gereserveerd en Telling, Inhoud: Specificaties en teksten, Afbeeldingen en Past bij, Beheer: Import en export en Eenheden). De lijst zelf houdt alleen zoeken, filters, + Artikel en Excel-export; de overige knoppen staan op de pagina Import en export.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.45.3',
      date: '2026-11-26',
      title: 'Ontbrekende webshopproducten toevoegen met voortgang',
      items: [
        { text: '*Ontbrekende uit webshop toevoegen* loopt nu op de achtergrond: je ziet de voortgang (ophalen, variaties, toevoegen) en een lijst van de binnengehaalde artikelen, ook als Excel. Het werk gaat door als je het venster sluit.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.45.2',
      date: '2026-11-26',
      title: 'Cookieverklaring met alle gebruikte diensten',
      items: [
        { text: 'De webshop heeft een pagina Cookieverklaring (link onderaan, naast de privacyverklaring). Per dienst en per cookie staat erin wat er wordt gebruikt: aanbieder, doel, cookienamen, bewaartermijn, doorgifte buiten de EU en het privacybeleid van de aanbieder. Google Analytics, Microsoft Clarity, reCAPTCHA, bestellen als gast en Mollie staan er alleen in als ze aan staan.', for: ['beheer'] },
      ],
    },
    {
      version: '1.45.1',
      date: '2026-11-26',
      title: 'Ontbrekende webshopproducten als artikel toevoegen',
      items: [
        { text: 'Bij Artikelen staat een knop *Ontbrekende uit webshop toevoegen*: die maakt artikelen aan voor producten uit de oude webshop die hier nog niet staan, zonder iets te archiveren of te wijzigen. De knop is tijdelijk, zolang WooCommerce nog draait.', for: ['voorraad'] },
        { text: 'Artikelen met de code WC-<nummer> (producten zonder sku) worden weer aan hun webshopproduct gekoppeld.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.45.0',
      date: '2026-11-26',
      title: 'Bewerken-knop alleen met voorraadrecht',
      items: [],
    },
    {
      version: '1.44.9',
      date: '2026-11-26',
      title: 'Aantal artikelen per pagina kiezen',
      items: [
        { text: 'In de artikellijst kies je nu hoeveel artikelen er per pagina staan (25, 50, 100, 300 of alles) en blader je met Vorige en Volgende. Je keuze wordt onthouden.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.44.8',
      date: '2026-11-26',
      title: 'Product bewerken vanuit de webshop',
      items: [
        { text: 'Op een productpagina in de webshop staat voor medewerkers een knop *Bewerken in beheer* die direct de artikelkaart opent.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.44.7',
      date: '2026-11-26',
      title: 'WordPress-bestellingen zichtbaar bij Webshopbestellingen',
      items: [
        { text: 'Bij Webshopbestellingen staan nu ook de bestellingen uit de oude WordPress-webshop, met het label WordPress en een filter op bron. Ze zijn alleen om te bekijken: er gaat niets terug naar WordPress en er raakt geen voorraad, factuur of mail aan vast.', for: ['voorraad', 'beheer'] },
      ],
    },
    {
      version: '1.44.6',
      date: '2026-11-26',
      title: 'Betere vindbaarheid van productteksten',
      items: [
        { text: 'AI-omschrijvingen beginnen met wat het artikel is, het merk en het belangrijkste gegeven, en krijgen een eigen zoekmachine-omschrijving per artikel.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.44.5',
      date: '2026-11-26',
      title: 'Archief in de overzichten',
      items: [
        { text: 'In de overzichten van offertes, werkorders, facturen, webshopbestellingen en plannen kun je met het filter Archief het archief ook tonen of alleen het archief bekijken. Vink stukken aan en kies Archiveren of Terughalen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.44.4',
      date: '2026-11-26',
      title: 'Orderhistorie uit WordPress voor Vaak samen besteld',
      items: [
        { text: 'Vaak samen besteld is meteen gevuld: onder Artikelen > Past bij haal je de orders van de oude WordPress-webshop op. Ze worden aan je artikelen gekoppeld, ook aan varianten van samengevoegde producten, en daarna werkt AquaTech Hub ze elk uur zelf bij. Er gaat niets terug naar WordPress en het zijn geen echte bestellingen (geen voorraad, factuur of mail, niet in omzet of marge).', for: ['voorraad'] },
      ],
    },
    {
      version: '1.44.3',
      date: '2026-11-26',
      title: 'Klanten archiveren en verwijderen vanuit het overzicht',
      items: [
        { text: 'In het klantenoverzicht vink je klanten aan en kies je Archiveren of Terughalen. Met het filter *Actieve klanten / Gearchiveerd / Alles* bekijk je het archief.', for: ['klanten'] },
        { text: 'Beheerders kunnen aangevinkte klanten ook definitief verwijderen (met wachtwoord). Klanten met offertes, werkorders, facturen of bestellingen blijven bewaard en worden met een reden overgeslagen; archiveren is dan het alternatief.', for: ['beheer'] },
      ],
    },
    {
      version: '1.44.2',
      date: '2026-11-26',
      title: 'Achtergrondtaken met AI gaan na een herstart vanzelf verder',
      items: [
        { text: 'Het schrijven van omschrijvingen in bulk en het opzoeken bij Past bij gaan na een herstart van de server (bijvoorbeeld door een update) vanzelf verder met wat nog aan de beurt is. Je hoeft niets opnieuw te starten.', for: ['voorraad'] },
        { text: 'Bij Beheer > Instellingen > AI staan nu de dagplafonds voor omschrijvingen in bulk en voor Past bij opzoeken.', for: ['beheer'] },
      ],
    },
    {
      version: '1.44.1',
      date: '2026-11-26',
      title: 'Nummers van gewiste offertes en werkorders komen nooit terug',
      items: [
        { text: 'Als een offerte of werkorder op verzoek definitief wordt gewist (AVG), krijgt een nieuw document nooit meer dat nummer.', for: ['beheer'] },
      ],
    },
    {
      version: '1.44.0',
      date: '2026-11-26',
      title: 'Archief voor testgegevens',
      items: [
        { text: 'Nieuw: Beheer > Systeem > Archief. Plannen, offertes, werkorders, facturen, webshopbestellingen en klanten (bijvoorbeeld testgegevens vóór go-live) haal je daar in bulk uit de lijsten en KPI\'s, zonder ze te wissen. Je kunt op datum of zoekterm selecteren, eerst een voorbeeld bekijken en alles terughalen. Nummers blijven bezet; wat de planner heeft geleerd blijft staan.', for: ['beheer'] },
        { text: 'Het archief kun je ook definitief verwijderen. Definitieve facturen blijven zeven jaar bewaard (bewaarplicht) en worden overgeslagen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.43.0',
      date: '2026-11-26',
      title: 'Productomschrijvingen in één keer schrijven met AI',
      items: [
        { text: 'Artikelen > Teksten heeft nu *Alles in één keer schrijven*: de AI zoekt de kenmerken van elk artikel op in de bron van de fabrikant en schrijft daar één natuurlijke omschrijving van, alleen met feiten uit die bron en de gegevens van Past bij. Je ziet vooraf de geschatte kosten en kunt het model kiezen (Sonnet is de standaard).', for: ['voorraad'] },
        { text: 'Heeft een artikel al een omschrijving, dan beoordeelt de AI of de nieuwe beter is. Alleen dan wordt hij vervangen; per artikel staat zichtbaar of de tekst nieuw, overschreven of behouden is, en de vorige tekst kun je terugzetten. Een tekst met een getal of bewering die niet in de gegevens staat gaat niet live maar wordt een concept.', for: ['voorraad'] },
        { text: 'Schrijven van omschrijvingen en het opzoeken bij Past bij draaien nu als taak op de server: ze lopen door als je het venster of de browser sluit, en je ziet de voortgang terug als je weer terugkomt. Stoppen kan met de knop Stop.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.42.3',
      date: '2026-11-26',
      title: 'Betaalmethoden in de voet van de webshop instelbaar',
      items: [
        { text: 'In Beheer > Webshop > Betalen stel je in welke betaalmethoden onderaan de webshop staan, inclusief Bitcoin.', for: ['beheer'] },
      ],
    },
    {
      version: '1.42.2',
      date: '2026-11-26',
      title: 'Assortiment op de startpagina compacter op de telefoon',
      items: [
        { text: 'Op de telefoon staat het assortiment op de startpagina van de webshop nu in een compacte rij die je opzij veegt, in plaats van grote tegels onder elkaar.' },
      ],
    },
    {
      version: '1.42.1',
      date: '2026-11-26',
      title: 'AI-kosten tellen Past bij niet meer als mislukt',
      items: [
        { text: 'Bij AI-kosten stonden alle opzoekingen van Past bij ten onrechte als mislukt. Dat is hersteld, ook voor de oude regels. De tekst boven het scherm noemt nu het standaardmodel en meldt dat Past bij een eigen model heeft.', for: ['beheer'] },
      ],
    },
    {
      version: '1.42.0',
      date: '2026-11-26',
      title: 'Cookies en mailvelden veiliger uitlezen',
      items: [],
    },
    {
      version: '1.41.9',
      date: '2026-11-26',
      title: 'Planner zonder account: nettere balk en rondleiding',
      items: [
        { text: 'De balk Tekenen zonder account in de planner is opgeruimd: één groene knop Tekening indienen en daaronder gelijke knoppen Bewaren en Inloggen.' },
        { text: 'Nieuwe bezoekers krijgen de eerste keer een korte rondleiding van zes kaarten. Via Hoe werkt het? in de balk open je hem opnieuw.' },
      ],
    },
    {
      version: '1.41.8',
      date: '2026-11-26',
      title: 'Werkorderschermen extra beschermd',
      items: [],
    },
    {
      version: '1.41.7',
      date: '2026-11-26',
      title: 'Bovengrens op schrijfacties',
      items: [],
    },
    {
      version: '1.41.6',
      date: '2026-11-26',
      title: 'Foutlog beter beschermd',
      items: [],
    },
    {
      version: '1.41.5',
      date: '2026-11-26',
      title: 'Kleiner en veiliger image',
      items: [],
    },
    {
      version: '1.41.4',
      date: '2026-11-26',
      title: 'Planner direct gebruiken zonder account',
      items: [
        { text: 'De knop Planner in de webshop opent de planner meteen, zonder eerst een account te maken. Je tekent, plaatst sproeiers en zet het materiaal in je winkelwagen. Een account heb je pas nodig om je ontwerp te bewaren of te bestellen.' },
        { text: 'In de planner zonder account staat de knop Ontwerp bewaren met account. Na registreren of inloggen staat je ontwerp er gewoon.' },
      ],
    },
    {
      version: '1.41.3',
      date: '2026-11-26',
      title: 'Gerelateerde artikelen: maximaal vier zichtbaar',
      items: [
        { text: 'In de webshop toont het blok "Past bij" (en "Vaak samen besteld") voortaan vier artikelen. De rest staat achter de knop *Bekijk meer*.' },
      ],
    },
    {
      version: '1.41.2',
      date: '2026-11-26',
      title: 'Startpagina: uitlijning en nieuwe quote',
      items: [
        { text: 'Op de startpagina van de webshop vullen de assortimentstegels nu de volle breedte en loopt het plannerblok even breed als de blokken erboven.' },
        { text: 'De quote onder Onze merken staat nu in een kaart met drie kernpunten.' },
      ],
    },
    {
      version: '1.41.1',
      date: '2026-11-26',
      title: 'Nieuw ontwerp voor de startpagina van de webshop',
      items: [
        { text: 'De startpagina van de webshop heeft een nieuw ontwerp: gesplitste kop met foto, assortiment in een navy blok, een plannerblok met drie stappen, afgeronde kaarten voor voordelen en merken.' },
      ],
    },
    {
      version: '1.41.0',
      date: '2026-11-25',
      title: 'Gerelateerde artikelen op de productpagina',
      items: [
        { text: 'Bij elk artikel kun je instellen welke artikelen erbij passen ("Past bij"). De webshop toont ze op de productpagina, alleen als ze leverbaar zijn, met de gewone prijzen.', for: ['voorraad'] },
        { text: 'Onder "Vaak samen besteld" toont de webshop automatisch wat klanten echt samen bestellen, op relevantie en niet alleen op populariteit, met de knop *Alles in winkelwagen*.', for: ['voorraad'] },
        { text: 'Met één knop laat de AI "Past bij" voor alle artikelen invullen op basis van echte specificaties van internet. Bij elke koppeling staat de bron met de letterlijke zin; zonder gevonden specificatie wordt er niets gekoppeld.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.40.8',
      date: '2026-11-25',
      title: 'Retour per regel goedkeuren of afwijzen',
      items: [
        { text: 'Bij een webshopretour kun je nu per regel kiezen: goedkeuren, afwijzen of een deel van het aantal goedkeuren. De creditfactuur, de voorraad en de mail aan de klant gaan alleen over wat is goedgekeurd. De klant ziet per regel wat is goedgekeurd of afgewezen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.40.7',
      date: '2026-11-25',
      title: 'Artikelen samenvoegen zonder handmatige webshopkoppelingen',
      items: [
        { text: 'Artikelen samenvoegen tot één variabel artikel blokkeert niet meer als ze aan een webshopproduct hangen. Aquatech zet het hoofdartikel zelf als één variabel product in de webshop en zet de oude losse producten op concept (niet verwijderd). Lukt het niet in de webshop, dan wordt er niets samengevoegd.', for: ['voorraad'] },
        { text: 'Nieuwe knop *Alles samenvoegen*: één overzicht met alle voorstellen ter bevestiging, daarna worden ze één voor één uitgevoerd met een uitkomst per voorstel.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.40.6',
      date: '2026-11-25',
      title: 'Creditfactuur van een retour direct bij goedkeuren',
      items: [
        { text: 'Nieuwe instelling in Facturen > Instellingen: de creditfactuur van een webshopretour kan nu al bij het goedkeuren worden gemaakt, in plaats van pas bij Afronden. Standaard staat dit uit.', for: ['facturen', 'beheer'] },
      ],
    },
    {
      version: '1.40.5',
      date: '2026-11-25',
      title: 'Develop-branch en stagingcode opgeruimd',
      items: [],
    },
    {
      version: '1.40.4',
      date: '2026-11-25',
      title: 'Stagingomgeving verwijderd',
      items: [],
    },
    {
      version: '1.40.3',
      date: '2026-11-25',
      title: 'Staging probeert bij een handmatige run altijd opnieuw',
      items: [],
    },
    {
      version: '1.40.2',
      date: '2026-11-25',
      title: 'Staging botst niet meer met de testomgeving',
      items: [],
    },
    {
      version: '1.40.1',
      date: '2026-11-25',
      title: 'Servertaken: schijf vergroten vóór staging',
      items: [],
    },
    {
      version: '1.40.0',
      date: '2026-11-25',
      title: 'Servertaak: schijf van apps01 vergroten',
      items: [],
    },
    {
      version: '1.39.9',
      date: '2026-11-25',
      title: 'Staging verbindt met een unieke databasehost',
      items: [],
    },
    {
      version: '1.39.8',
      date: '2026-11-25',
      title: 'Stagingomgeving op apps01',
      items: [],
    },
    {
      version: '1.39.7',
      date: '2026-11-25',
      title: 'Stagingomgeving herkenbaar en niet indexeerbaar',
      items: [],
    },
    {
      version: '1.39.6',
      date: '2026-11-25',
      title: 'Servertaak voor de stagingomgeving',
      items: [],
    },
    {
      version: '1.39.5',
      date: '2026-11-25',
      title: 'Aanbetaling op de offerte',
      items: [
        { text: 'Op een offerte kun je nu een aanbetaling vragen (percentage of vast bedrag, incl. btw). Zodra de klant akkoord geeft, gaat er automatisch een aanbetalingsfactuur met betaallink naar de klant. De eindfactuur uit de werkorder trekt die aanbetaling weer af, dus de klant betaalt alleen het restant.', for: ['offertes', 'facturen'] },
        { text: 'Is er geen mailserver of e-mailadres, dan blijft de aanbetalingsfactuur definitief maar onverstuurd en staat er een taak in Openstaande taken. Automatisch versturen is uit te zetten in Beheer > Modules; de factuur is dan met een knop op de offerte te maken.', for: ['facturen'] },
      ],
    },
    {
      version: '1.39.4',
      date: '2026-11-24',
      title: 'Openbare planner: eigen rekenrij voor tekeningen van bezoekers',
      items: [
        { text: 'Tekeningen van bezoekers zonder account kunnen de berekening van AI-plannen niet meer ophouden: ze hebben een eigen, kleine rekenrij en worden vooraf op grootte gecontroleerd.' },
      ],
    },
    {
      version: '1.39.3',
      date: '2026-11-24',
      title: 'Planner zonder account: prijs, bestellen en offerte-lead',
      items: [
        { text: 'Een tekening die iemand zonder account indient, levert nu meteen een concept-offerte op met materiaal en arbeid uit het plan. Je vindt hem in Offertes en verstuurt hem zelf.', for: ['offertes'] },
        { text: 'Bezoekers van de planner zonder account zien nu een prijsindicatie van hun materiaal en kunnen het in één keer laten bezorgen via de webshop, of een offerte voor de aanleg aanvragen.' },
      ],
    },
    {
      version: '1.39.2',
      date: '2026-11-24',
      title: 'Werkorder automatisch klaar bij akkoord',
      items: [
        { text: 'Zodra een offerte akkoord is, staat de werkorder er automatisch: het materiaal is gereserveerd en hij wacht onder In te plannen. Je hoeft niet meer op Werkorder maken te klikken. In Openstaande taken zie je welke werkorders nog ingepland moeten worden. Uit te zetten in Beheer > Modules (Werkorders).', for: ['werkorders', 'planning'] },
      ],
    },
    {
      version: '1.39.1',
      date: '2026-11-24',
      title: 'Prijslijst inlezen: gearchiveerde leverancier en atomair verwerken',
      items: [],
    },
    {
      version: '1.39.0',
      date: '2026-11-24',
      title: 'Prijslijst van de leverancier inlezen',
      items: [
        { text: 'Een prijslijst van een leverancier lees je nu in één keer uit Excel in (Artikelen > Leveranciers > Prijslijst inlezen), met eerst een controle. De verkoopprijzen volgen daarna automatisch via de prijsfactor.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.38.0',
      date: '2026-11-24',
      title: 'Klanten en artikelen importeren uit Excel',
      items: [
        { text: 'Klanten importeer je nu uit een Excel-bestand: je krijgt een voorbeeldbestand, een controle (wat is nieuw, wat wijzigt, wat klopt niet) en verwerkt daarna alles in één keer.', for: ['klanten'] },
        { text: 'Artikelen importeren of in bulk wijzigen kan nu ook uit Excel, met dezelfde controle vooraf.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.37.3',
      date: '2026-11-24',
      title: 'Marge zichtbaar in de offerte',
      items: [
        { text: 'In de offerte zie je nu de marge: per regel en onder de totalen, met een waarschuwing als de marge onder je minimum ligt. Het minimum stel je in bij Bedrijfsgegevens. De marge staat nooit op het klantdocument.', for: ['nacalculatie', 'beheer'] },
      ],
    },
    {
      version: '1.37.2',
      date: '2026-11-24',
      title: 'Prijsindicatie en bestellen in de planner zonder account',
      items: [
        { text: 'In de planner zonder account ziet een bezoeker straks een prijsindicatie van het materiaal en kan hij het in één keer in de winkelwagen zetten om te laten bezorgen, of een offerte voor de aanleg aanvragen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.37.1',
      date: '2026-11-24',
      title: 'Server en toegangscode aangescherpt',
      items: [
        { text: 'Met de toegangscode kun je weer inloggen als iemand anders eerder de gezamenlijke pogingengrens vol deed.' },
      ],
    },
    {
      version: '1.37.0',
      date: '2026-11-24',
      title: 'Account- en instellingenroutes aangescherpt',
      items: [
        { text: 'Tweestapsverificatie aanzetten vraagt nu je wachtwoord, net als uitzetten.' },
      ],
    },
    {
      version: '1.36.9',
      date: '2026-11-24',
      title: 'Gasten beter begrensd',
      items: [
        { text: 'Gasten (zonder account) kunnen in het klantportaal niets meer indienen of bevestigen; daarvoor is een account nodig.' },
      ],
    },
    {
      version: '1.36.8',
      date: '2026-11-24',
      title: 'Lange lijsten blijven snel',
      items: [
        { text: 'Bij heel veel gegevens toont een lijst de nieuwste en meldt dat er meer zijn, zodat de pagina snel blijft.', for: ['offertes', 'werkorders', 'facturen'] },
      ],
    },
    {
      version: '1.36.7',
      date: '2026-11-24',
      title: 'Offertes en werkorders: veiliger akkoord en minder zichtbare gegevens',
      items: [
        { text: 'Een klant tekent nooit meer voor een offerte die ondertussen is aangepast: de pagina vraagt dan eerst om opnieuw te laden.', for: ['offertes'] },
        { text: 'Als het mailen van een offerte of afspraak mislukt, blijft de offerte een concept en is er geen losse link in omloop.', for: ['offertes'] },
        { text: 'Het gewone opslaan van een werkorder verplaatst geen afspraken meer zonder het recht Planning.', for: ['werkorders'] },
      ],
    },
    {
      version: '1.36.6',
      date: '2026-11-24',
      title: 'Veiliger mail, klantlinks en AI-koppeling',
      items: [
        { text: 'Nieuw: Beheer > Instellingen > Openbaar adres van de app. Klantlinks in mails (digitale offerte, afspraak) en de AI-koppeling gebruiken dat adres. Vul het eenmalig in; zonder dit adres (en zonder webadres van de webshop) maakt de app geen klantlinks meer.', for: ['beheer'] },
        { text: 'E-mail: de Exchange-connector is er alleen nog voor de hoofdorganisatie, de testmail is beperkt tot 5 per 10 minuten en er geldt een dagmaximum voor uitgaande mail.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.5',
      date: '2026-11-24',
      title: 'Back-up en herstel veiliger',
      items: [
        { text: 'Een back-up verwijderen en de koppeling met Google Drive verbreken of opnieuw koppelen vragen nu je wachtwoord, net als terugzetten. De nieuwste back-up kan niet meer handmatig worden verwijderd.', for: ['beheer'] },
        { text: 'Bewaking meldt als de databaseafscherming per organisatie uitstaat en als een back-up handmatig is verwijderd.', for: ['beheer'] },
        { text: 'Terugzetten uit een back-up is sneller: een geopende back-up blijft vijf minuten bewaard in plaats van bij elke stap opnieuw te worden ingelezen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.4',
      date: '2026-11-24',
      title: 'Beheer-menu: één groep tegelijk open',
      items: [
        { text: 'In het Beheer-menu staat nog maar één groep tegelijk open, net als in de zijbalk.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.3',
      date: '2026-11-24',
      title: 'Visma, KPI\'s, openstaande taken en voorraadmelding apart aan of uit',
      items: [
        { text: 'In Beheer > Modules aan/uit staan nu ook de koppeling met Visma, de KPI\'s en de openstaande taken van het dashboard en de voorraadmelding van de webshop. Wat uit staat verdwijnt uit het scherm en doet niets meer op de achtergrond.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.2',
      date: '2026-11-24',
      title: 'Onderdelen van Magazijn en inkoop apart aan of uit',
      items: [
        { text: 'In Beheer > Modules aan/uit kun je bij Artikelen en voorraad nu ook Etiketten, Voorraadtelling, Goederenontvangst en Inkooporder inlezen met AI apart uitzetten. Wat uit staat verdwijnt uit het scherm.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.1',
      date: '2026-11-24',
      title: 'Modules: nacalculatie, offertesjablonen, afspraaklink en meer apart uit te zetten',
      items: [
        { text: 'In Beheer > Modules staan zes nieuwe schakelaars: Nacalculatie, Offertesjablonen, Online betalen van facturen (klantportaal en betaallink), Plan herkennen met AI, Afspraaklink voor de klant en Installatiedossier per adres. Alles staat aan, tot je het zelf uitzet.', for: ['beheer'] },
        { text: 'Zet je zo\'n onderdeel uit, dan verdwijnt het van het scherm (bijvoorbeeld het blok Nacalculatie op de werkorder) en weigert de server het ook. Wat al bewaard is blijft staan.', for: ['beheer'] },
      ],
    },
    {
      version: '1.36.0',
      date: '2026-11-24',
      title: 'Nieuw scherm Modules: alles per categorie aan of uit',
      items: [
        { text: 'Beheer > Modules is vernieuwd: per categorie een kaart per module met een schakelaar, en daaronder de onderdelen met een eigen schakelaar (bijvoorbeeld offerte-opvolging, betalingsherinneringen, automatische bestelvoorstellen, bestellen als gast, Google Analytics en de AI-koppeling). Je kunt zoeken, filteren op aan of uit en ziet in één oogopslag hoeveel er aan staat.', for: ['beheer'] },
        { text: 'Een onderdeel volgt zijn module: staat de module uit, dan zijn de onderdelen grijs. Gegevens en instellingen blijven bewaard. Bij een onderdeel met meer instellingen staat de link Instellen.', for: ['beheer'] },
        { text: 'Na het opslaan past het menu links zich direct aan, zonder de pagina te verversen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.35.1',
      date: '2026-11-24',
      title: 'Modules: onderdelen met een eigen schakelaar (voorbereiding nieuw scherm)',
      items: [
        { text: 'De Webshopbestellingen staan alleen nog in het menu als de eigen webshop aan staat, en Uitbesteden alleen als Werkorders aan staat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.35.0',
      date: '2026-11-24',
      title: 'Webshop: knoppen en pictogram op mobiel hersteld',
      items: [
        { text: 'De winkelwagenknop op productkaarten toont op een smal scherm weer het winkelwagenpictogram, de voorraadtekst is beter leesbaar en de zoekknop is groter om aan te tikken.' },
      ],
    },
    {
      version: '1.34.9',
      date: '2026-11-24',
      title: 'Planner met grotere knoppen op mobiel',
      items: [
        { text: 'In de planner zijn de werkbalkknoppen, ongedaan maken/opnieuw en de stappen op een telefoon groter en makkelijker te raken.', for: ['plannen'] },
      ],
    },
    {
      version: '1.34.8',
      date: '2026-11-24',
      title: 'Beheer en kopbalk netter op de telefoon',
      items: [
        { text: 'Beheer > Webshop-inhoud scrolt op de telefoon niet meer zijwaarts.', for: ['beheer'] },
        { text: 'De kopbalk past op een smal scherm ook met de organisatiewisselaar en de belknop is groter om te tikken.' },
        { text: 'Brede tabellen (zoals Beheer > Gebruikers) tonen op de telefoon een schaduw aan de rand waar je nog kunt schuiven.', for: ['beheer'] },
      ],
    },
    {
      version: '1.34.7',
      date: '2026-11-24',
      title: 'Betalingen: opnieuw proberen, terugstorten gemeld en voorraad sneller vrij',
      items: [
        { text: 'Mislukt de bevestigingsmail of de factuur na een online betaling, dan probeert de app het later vanzelf opnieuw.', for: ['beheer'] },
        { text: 'Betaalt een klant een bestelling die al vervallen of geannuleerd was, of twee keer, dan krijgt hij een mail dat het bedrag teruggaat. Lukt terugstorten niet vanzelf, dan staat dat in Bewaking.', for: ['beheer'] },
        { text: 'De voorraad van een online bestelling die niet betaald wordt komt nu binnen een half uur vrij (controle elke vijf minuten).', for: ['beheer'] },
        { text: 'Een online betaling op een factuur die intussen gecrediteerd is staat in het logboek en in Bewaking.', for: ['facturen'] },
      ],
    },
    {
      version: '1.34.6',
      date: '2026-11-24',
      title: 'Webshop: retour na account maken, pakbon-upload en afrekenlimiet',
      items: [
        { text: 'Een retour die je als gast hebt aangevraagd kun je ook intrekken nadat je een account hebt gemaakt.' },
        { text: 'De upload van een eigen pakbon (dropshipping) en het afrekenen zijn beter begrensd tegen overbelasting.', for: ['beheer'] },
      ],
    },
    {
      version: '1.34.5',
      date: '2026-11-24',
      title: 'Crediteren, betaald zetten en de Visma-redirect steviger',
      items: [
        { text: 'Een factuur kan niet meer vaker of voor meer gecrediteerd worden dan er gefactureerd is. Een volgende creditfactuur begint met wat er nog niet gecrediteerd is.', for: ['facturen'] },
        { text: 'Betaald of weer openstaand zetten staat nu in het logboek. Een factuur die de klant online heeft betaald gaat pas na een bevestiging terug naar openstaand.', for: ['facturen'] },
        { text: 'Visma: de redirect URI volgt uit het webadres van de omgeving als je hem leeg laat; een adres dat niet klopt wordt geweigerd in plaats van stil vervangen.', for: ['facturen'] },
      ],
    },
    {
      version: '1.34.4',
      date: '2026-11-24',
      title: 'Image-handtekening controleren bij een update',
      items: [],
    },
    {
      version: '1.34.3',
      date: '2026-11-24',
      title: 'Online betalen in de webshop steviger',
      items: [
        { text: 'Een online bestelling die nog niet betaald is houdt de voorraad nog maar een half uur vast. Daarna komt de voorraad vrij; de klant kan tot de bewaartijd nog afrekenen zolang de voorraad strekt, en bij het betalen wordt opnieuw gereserveerd.', for: ['beheer'] },
        { text: 'Een gast kan hoogstens twee onbetaalde bestellingen tegelijk open hebben staan per e-mailadres (drie per bezoeker).', for: ['beheer'] },
        { text: 'Wordt een bestelling betaald nadat hij is vervallen of geannuleerd, of komt er een tweede betaling binnen op dezelfde bestelling, dan gaat het bedrag automatisch terug via Mollie. De klant krijgt dan geen bevestiging en er komt geen factuur. Lukt terugbetalen niet, dan staat bij de bestelling dat het nog moet.', for: ['beheer'] },
        { text: 'Een terugbetaling staat direct bij de bestelling, ook als het antwoord van Mollie uitblijft. De app kijkt dan zelf bij Mollie na of hij is uitgevoerd.', for: ['beheer'] },
      ],
    },
    {
      version: '1.34.2',
      date: '2026-11-23',
      title: 'Vingerafdruk van de hoofdsleutel in Beheer',
      items: [
        { text: 'Bij Beheer > Back-ups staat nu een vingerafdruk van de hoofdsleutel. Noteer die bij de kopie van de sleutel in je wachtwoordkluis: zo controleer je altijd dat die kopie bij deze server hoort.', for: ['beheer'] },
      ],
    },
    {
      version: '1.34.1',
      date: '2026-11-23',
      title: 'Mediabibliotheek en knoppen netter',
      items: [
        { text: 'Het tabblad Afbeeldingen bij Artikelen laadt weer.', for: ['voorraad'] },
        { text: 'Kleine knoppen zijn op de telefoon makkelijker aan te tikken en gebruiken overal het huislettertype.' },
      ],
    },
    {
      version: '1.34.0',
      date: '2026-11-23',
      title: 'Veiliger terugvallen na een mislukte update',
      items: [
        { text: 'Mislukt een update en moet de vorige versie terug, dan start die niet meer stilletjes op een nieuwere database. Je krijgt de melding dat een back-up hersteld moet worden.', for: ['beheer'] },
      ],
    },
    {
      version: '1.33.9',
      date: '2026-11-23',
      title: 'AVG-wissen, inkoopontvangst en netwerkfilter aangescherpt',
      items: [
        { text: 'Een klant wissen (AVG) vraagt nu je wachtwoord opnieuw en waarschuwt voor werkorders die alleen op naam aan de klant gekoppeld zijn. De inzage-Excel bevat ook het akkoordbewijs van offertes en het afspraaklogboek.', for: ['beheer'] },
        { text: 'Een inkooporder ontvangen via Artikelen boekt nooit meer dubbel: een herhaling of tweede tabblad wordt geweigerd, en meer ontvangen dan besteld vraagt om een bevestiging.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.33.8',
      date: '2026-11-23',
      title: 'Veiliger zonder inlog en gecrediteerde facturen niet meer betaalbaar',
      items: [
        { text: 'Een gecrediteerde factuur staat in het portaal als Gecrediteerd en kan niet meer online betaald worden.', for: ['portaal'] },
      ],
    },
    {
      version: '1.33.7',
      date: '2026-11-23',
      title: 'Hostscripts draaien op een zichtbare, vaste commit',
      items: [],
    },
    {
      version: '1.33.6',
      date: '2026-11-23',
      title: 'Back-ups met integriteitscontrole',
      items: [
        { text: 'De dagelijkse database-back-up krijgt een controlebestand (HMAC) ernaast. Terugzetten en de hersteltest weigeren een back-up waarvan de controle niet klopt; een back-up zonder controlebestand (van vóór deze maatregel) krijgt alleen een waarschuwing.', for: ['beheer'] },
      ],
    },
    {
      version: '1.33.5',
      date: '2026-11-23',
      title: 'Veiligere standaarden in de voorbeeld-installatie',
      items: [],
    },
    {
      version: '1.33.4',
      date: '2026-11-23',
      title: 'Uitbesteden veiliger',
      items: [
        { text: 'Een opdracht die je aan alle organisaties aanbiedt, gaat pas naar de aanvrager nadat jij die hebt bevestigd. Tot die tijd krijgt niemand de klantgegevens.', for: ['uitbesteden'] },
        { text: 'Je kunt maximaal 20 opdrachten per uur aanbieden, en een organisatie krijgt per werkorder hoogstens één mail.', for: ['uitbesteden'] },
      ],
    },
    {
      version: '1.33.3',
      date: '2026-11-23',
      title: 'Updates stoppen als de back-up mislukt',
      items: [],
    },
    {
      version: '1.33.2',
      date: '2026-11-23',
      title: 'Strengere toegangsregels',
      items: [
        { text: 'De toegangscode en de gastentoegang kan alleen nog een hoofdbeheerder wijzigen, en back-ups zijn alleen voor hoofdbeheerders.', for: ['beheer'] },
        { text: 'Streepjescodes scannen met de camera werkt weer in de orderpick-app.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.33.1',
      date: '2026-11-23',
      title: 'Noodherstel uit de Google Drive-back-up',
      items: [
        { text: 'Gaat de server verloren, dan is de hele database terug te zetten uit de back-up op Google Drive. Het draaiboek staat in de serverdocumentatie en het terugzetten wordt elke week al getest.', for: ['beheer'] },
      ],
    },
    {
      version: '1.33.0',
      date: '2026-11-22',
      title: 'Voorraad tellen werkt ook zonder verbinding',
      items: [
        { text: 'Tellers kunnen in de orderpick-app ook tellen waar geen bereik is: de ingaven wachten op het toestel en worden verstuurd zodra er weer verbinding is.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.32.9',
      date: '2026-11-22',
      title: 'Beregeningsplanner: controle en indienen in een eigen bestand',
      items: [],
    },
    {
      version: '1.32.8',
      date: '2026-11-22',
      title: 'Beheer: herinneringen en etiketten in eigen bestanden',
      items: [],
    },
    {
      version: '1.32.7',
      date: '2026-11-22',
      title: 'Facturen: Visma-scherm in een eigen bestand',
      items: [],
    },
    {
      version: '1.32.6',
      date: '2026-11-22',
      title: 'Voorraadtelling: tellen met verpakkingen',
      items: [
        { text: 'Bij het tellen van een artikel met verpakkingen (bijvoorbeeld bundels of pallets) vul je het aantal per verpakking in, naast losse stuks. De app rekent het totaal voor je uit.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.32.5',
      date: '2026-11-22',
      title: 'Orderpick: terugknop gaat naar de lijst',
      items: [
        { text: 'De terugknop van je telefoon of browser brengt je in een bestelling nu terug naar de lijst met bestellingen, in plaats van de app te verlaten.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.32.4',
      date: '2026-11-22',
      title: 'Werkorderlijst laadt via de pool',
      items: [],
    },
    {
      version: '1.32.3',
      date: '2026-11-22',
      title: 'Offertemails: limiet per ontvanger',
      items: [
        { text: 'Binnen één organisatie gaan naar één e-mailadres hoogstens 5 offertemails per uur, zodat een klant niet overspoeld wordt.', for: ['offertes'] },
      ],
    },
    {
      version: '1.32.2',
      date: '2026-11-21',
      title: 'Database: id\'s en verwijzingen zijn echte uuid\'s',
      items: [],
    },
    {
      version: '1.32.1',
      date: '2026-11-21',
      title: 'Database: reserveringen verwijzen echt naar hun werkorder of bestelling',
      items: [],
    },
    {
      version: '1.32.0',
      date: '2026-11-21',
      title: 'Database: gegevensveld van bestellingen, werkorders, facturen en offertes is JSONB',
      items: [],
    },
    {
      version: '1.31.9',
      date: '2026-11-21',
      title: 'Database: tijdstippen zijn echte tijdstippen',
      items: [],
    },
    {
      version: '1.31.8',
      date: '2026-11-20',
      title: 'Hersteltest Google Drive controleert nu ook de app zelf',
      items: [
        { text: 'De hersteltest van de back-up op Google Drive zet de back-up nu ook terug in een tijdelijke database en start daarop een tijdelijke kopie van de app, die inlogt en gegevens ophaalt. Zo is ook de Drive-kopie bewezen bruikbaar. Na het uitrollen: servertaak 007 uitvoeren in Beheer > Systeem > Updates.', for: ['beheer'] },
      ],
    },
    {
      version: '1.31.7',
      date: '2026-11-20',
      title: 'Zijbalk houdt maximaal één groep open',
      items: [
        { text: 'In de zijbalk staat nog maar één groep tegelijk open: klap je een groep open, dan klapt de vorige dicht. Dat houdt het menu compact.', for: ['beheer'] },
      ],
    },
    {
      version: '1.31.6',
      date: '2026-11-20',
      title: 'Servertaak voor databasegroottes en indexgebruik',
      items: [],
    },
    {
      version: '1.31.5',
      date: '2026-11-20',
      title: 'Database: vlaggen mogen alleen 0 of 1 zijn',
      items: [],
    },
    {
      version: '1.31.4',
      date: '2026-11-20',
      title: 'Database: typeparsers voor de volgende kolomtypen',
      items: [],
    },
    {
      version: '1.31.3',
      date: '2026-11-20',
      title: 'Webshopsync schrijft in bulk en alleen bij verschillen',
      items: [
        { text: 'De synchronisatie met de oude webshop is veel lichter voor de database: een ronde zonder wijzigingen doet nog maar een handvol queries in plaats van duizenden. [beheer]' },
      ],
    },
    {
      version: '1.31.2',
      date: '2026-11-20',
      title: 'Database: foreign keys op de belangrijkste verwijzingen',
      items: [],
    },
    {
      version: '1.31.1',
      date: '2026-11-20',
      title: 'Database: geldbedragen en hoeveelheden exact opgeslagen',
      items: [],
    },
    {
      version: '1.31.0',
      date: '2026-11-20',
      title: 'Database: extra indexen en controles op statussen',
      items: [],
    },
    {
      version: '1.30.9',
      date: '2026-11-20',
      title: 'Hersteltest controleert nu ook de app zelf',
      items: [
        { text: 'De wekelijkse hersteltest van de back-up start nu ook een tijdelijke kopie van de app op de teruggezette gegevens, logt daarin in en haalt een paar gegevens op. Pas als dat lukt is de back-up bewezen bruikbaar. Na het uitrollen: servertaak 005 uitvoeren in Beheer > Systeem > Updates.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.8',
      date: '2026-11-20',
      title: 'Update-controle zonder 429 voor beheerders',
      items: [
        { text: 'Een handmatige update-controle in Beheer > Systeem > Updates kan nu altijd, praktisch zonder melding over te veel verzoeken.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.7',
      date: '2026-11-20',
      title: 'Dagelijkse database-back-up werkt weer',
      items: [
        { text: 'De dagelijkse back-up van de database wordt niet langer ten onrechte afgekeurd. Een servertaak in Beheer > Systeem > Updates installeert de reparatie en maakt meteen een back-up.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.6',
      date: '2026-11-20',
      title: 'Terugzetten vanaf Google Drive',
      items: [
        { text: 'Terugzetten uit een back-up kan nu ook vanaf Google Drive. In Beheer > Systeem > Terugzetten uit back-up staan de back-ups op Drive als aparte groep in de keuzelijst; de app haalt de gekozen back-up eerst op en bewaart hem een kwartier tijdelijk. Verder werkt het hetzelfde: eerst een voorbeeld, wachtwoord ter bevestiging en vooraf een nieuwe back-up.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.5',
      date: '2026-11-20',
      title: 'Hersteltest voor de back-up op Google Drive',
      items: [
        { text: 'Nieuw in Beheer > Systeem: *Hersteltest Google Drive*. Elke week haalt de app de nieuwste back-up van Google Drive op, zet hem tijdelijk terug naast de database en vergelijkt hem met de echte gegevens. Zo weet je zeker dat de kopie op Drive ook echt bruikbaar is. Dit staat los van de hersteltest van de lokale back-up.', for: ['beheer'] },
        { text: 'De lokale hersteltest maakt zelf een back-up als er nog geen is, en geeft duidelijker aan wat er mis is.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.4',
      date: '2026-11-20',
      title: 'Rustiger logboek en betere Excel-export',
      items: [
        { text: 'Het logboek meldt lange taken (back-up naar Google Drive, webshopsynchronisatie) niet meer als trage taak zolang ze binnen hun normale duur blijven.', for: ['beheer'] },
        { text: 'Een trage bewakingsronde laat nu zien welke controle of melding hem ophoudt.', for: ['beheer'] },
        { text: 'De Excel-export van het logboek heeft echte datum- en tijdkolommen, aparte kolommen voor queries en externe aanroepen, een kolom Bereik, een filter en een vaste kopregel.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.3',
      date: '2026-11-20',
      title: 'Hersteltest maakt zelf een back-up als er geen is',
      items: [
        { text: 'De hersteltest van de back-up meldt nu duidelijk wat er mis is als er geen back-up op de server staat, en laat er eerst zelf één maken.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.2',
      date: '2026-11-20',
      title: 'Opruimen van een ongebruikte tabel en een extra index',
      items: [],
    },
    {
      version: '1.30.1',
      date: '2026-11-20',
      title: 'Wekelijkse hersteltest van de back-up',
      items: [
        { text: 'De server test elke week of de nieuwste back-up echt terug te zetten is, in een aparte wegwerpcontainer. De uitslag staat in Beheer > Systeem > Hersteltest, met de dag en tijd in te stellen en een knop *Nu testen*.', for: ['beheer'] },
        { text: 'Mislukt de hersteltest, of is hij al meer dan 9 dagen niet gedraaid, dan meldt de bewaking dat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.30.0',
      date: '2026-11-20',
      title: 'Klantlinks altijd op het openbare webadres en limiet op losse mails',
      items: [
        { text: 'Links naar offertes en afspraken gebruiken altijd het webadres uit Beheer, ook als een medewerker de app via een intern adres opent.' },
      ],
    },
    {
      version: '1.29.9',
      date: '2026-11-20',
      title: 'Backupleverancier zichtbaar bij een niet-leverbare voorkeur',
      items: [
        { text: 'Staat de voorkeursleverancier van een artikel op niet leverbaar, dan zie je dat op het artikel zelf, met de backup waar het bestelvoorstel nu bestelt.', for: ['voorraad'] },
        { text: 'In het blok met automatische voorstellen staat bij elke regel die bij een backup wordt besteld een melding met het meerprijsverschil.', for: ['voorraad'] },
        { text: 'Bij de leveranciers van een artikel maak je met één klik een andere leverancier de voorkeur.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.29.8',
      date: '2026-11-20',
      title: 'Aantalknoppen op productkaarten',
      items: [
        { text: 'Op de productkaarten in de webshop staan nu − en + knoppen naast het aantal.' },
      ],
    },
    {
      version: '1.29.7',
      date: '2026-11-20',
      title: 'Offerte-, factuur- en debiteurenlijsten laden sneller bij drukte',
      items: [],
    },
    {
      version: '1.29.6',
      date: '2026-11-20',
      title: 'Analytisch staat vooraf aan in de cookie-instellingen',
      items: [
        { text: 'Het vakje Analytisch in de cookie-instellingen van de webshop staat vooraf aan zolang een bezoeker nog niets koos. Er wordt niets geladen voordat de bezoeker zelf op een knop drukt.' },
      ],
    },
    {
      version: '1.29.5',
      date: '2026-11-20',
      title: 'Microsoft Clarity beter te vinden in Beheer',
      items: [
        { text: 'Zoeken in Beheer op "clarity", "heatmap" of "cookiebanner" brengt je nu bij Webshop, waar de Clarity-instelling onder Google Analytics staat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.29.4',
      date: '2026-11-20',
      title: 'Cookiebanner volgens de AVG en Microsoft Clarity in de webshop',
      items: [
        { text: 'De webshop heeft een nieuwe cookiebanner: Accepteren en Weigeren zijn even duidelijk, bezoekers kiezen per categorie (Noodzakelijk of Analytisch) en kunnen hun keuze altijd wijzigen of intrekken via *Cookie-instellingen* onderaan de pagina.', for: ['beheer'] },
        { text: 'Microsoft Clarity staat in de webshop en laadt pas nadat de bezoeker Analytisch toestaat. Zet hem aan met je project-ID in Beheer > Webshop > Microsoft Clarity.', for: ['beheer'] },
      ],
    },
    {
      version: '1.29.3',
      date: '2026-11-20',
      title: 'Nieuwspunt over Uitbesteden alleen voor beheerders',
      items: [],
    },
    {
      version: '1.29.2',
      date: '2026-11-20',
      title: 'Ontvangst in de zijbalk opent direct Ontvangen',
      items: [
        { text: 'Vanuit de zijbalk opent Ontvangst nu direct het tabblad Ontvangen, ook als je al op de Orderpick-pagina staat.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.29.1',
      date: '2026-11-20',
      title: 'PDF-knop in Mijn portaal netjes op de rij',
      items: [
        { text: 'In Mijn portaal staat de PDF-knop van een factuur weer op één lijn met de rest van de rij.', for: ['portaal'] },
        { text: 'Het blok Contact onderaan Mijn portaal is weggehaald.', for: ['portaal'] },
      ],
    },
    {
      version: '1.29.0',
      date: '2026-11-20',
      title: 'Automatische controle op uitlijning van alle schermen',
      items: [],
    },
    {
      version: '1.28.9',
      date: '2026-11-20',
      title: 'Kleine uitlijnfouten op mobiel hersteld',
      items: [
        { text: 'Op een telefoon loopt de pagina AI-kosten (Beheer) en de tabbladbalk van Uitbesteden niet meer buiten het scherm, en lange productnamen in de webshop worden niet meer afgekapt midden in een woord.', for: ['beheer', 'uitbesteden'] },
      ],
    },
    {
      version: '1.28.8',
      date: '2026-11-20',
      title: 'Mooiere productkaarten in de webshop',
      items: [
        { text: 'Productkaarten in de webshop hebben een nieuw ontwerp: foto\'s op een vaste hoogte met het voorraadlabel erop, titel, variantkeuze, prijs en winkelwagenknop staan in elke kaart op dezelfde plek, en op de home staan de producten in een raster van vier kolommen.' },
      ],
    },
    {
      version: '1.28.7',
      date: '2026-11-20',
      title: 'Eigen Over ons-tekst uit Beheer in de nieuwe opmaak',
      items: [
        { text: 'Een eigen tekst voor Over ons uit Beheer staat nu ook in het nieuwe ontwerp van de webshop.' },
      ],
    },
    {
      version: '1.28.6',
      date: '2026-11-20',
      title: 'Nieuw ontwerp voor de pagina Over ons in de webshop',
      items: [
        { text: 'De pagina Over ons in de webshop heeft een nieuw ontwerp met bedrijfsgegevens en een contactblok.' },
      ],
    },
    {
      version: '1.28.5',
      date: '2026-11-20',
      title: 'Offertes-script opgesplitst',
      items: [],
    },
    {
      version: '1.28.4',
      date: '2026-11-20',
      title: 'Werkorders-scherm opgesplitst in meerdere bestanden',
      items: [],
    },
    {
      version: '1.28.3',
      date: '2026-11-20',
      title: 'Tenantfilter op gastaccount bij ingediende tekening',
      items: [],
    },
    {
      version: '1.28.2',
      date: '2026-11-20',
      title: 'Artikelen-scherm in kleinere bestanden',
      items: [],
    },
    {
      version: '1.28.1',
      date: '2026-11-20',
      title: 'Geen onterechte webshopsync-waarschuwing meer',
      items: [
        { text: 'Bewaking waarschuwt niet meer dat de webshop "al uren niet gesynchroniseerd" is als de koppeling bewust maar één keer per nacht synchroniseert.', for: ['beheer'] },
      ],
    },
    {
      version: '1.28.0',
      date: '2026-11-20',
      title: 'Gegevenslaag opgesplitst',
      items: [],
    },
    {
      version: '1.27.9',
      date: '2026-11-20',
      title: 'Mail via Microsoft Graph versturen na automatisch instellen',
      items: [
        { text: 'Mailen via Microsoft Graph lukt nu ook direct na het instellen: een net verleende machtiging werd soms nog niet herkend. De foutmeldingen noemen nu de gebruikte afzender en dat een nieuwe machtiging tot ongeveer 15 minuten kan duren.', for: ['beheer'] },
      ],
    },
    {
      version: '1.27.8',
      date: '2026-11-20',
      title: 'Voorraadcode opgesplitst',
      items: [],
    },
    {
      version: '1.27.7',
      date: '2026-11-20',
      title: 'Serverroutes verdeeld over bestanden',
      items: [],
    },
    {
      version: '1.27.6',
      date: '2026-11-20',
      title: 'Drive-back-uproutes naar eigen bestand',
      items: [],
    },
    {
      version: '1.27.5',
      date: '2026-11-20',
      title: 'Rollenroutes naar eigen bestand',
      items: [],
    },
    {
      version: '1.27.4',
      date: '2026-11-19',
      title: 'Leveranciers met backup instellen en terugzien',
      items: [
        { text: 'Bij een artikel zet je de leveranciers nu in volgorde (voorkeur, backup 1, backup 2) en geef je per leverancier aan of het artikel leverbaar is.', for: ['voorraad'] },
        { text: 'Het bestelvoorstel en de inkooporder laten zien als er bij een backup wordt besteld, met het meerprijsverschil ten opzichte van de voorkeur.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.27.3',
      date: '2026-11-19',
      title: 'Meerdere leveranciers per artikel met backup',
      items: [
        { text: 'Een artikel kan meerdere leveranciers hebben met een eigen artikelnummer en inkoopprijs, in volgorde van prioriteit: voorkeur, backup 1, backup 2.', for: ['voorraad'] },
        { text: 'Per leverancier kun je zetten of het artikel leverbaar is. Is de voorkeursleverancier niet leverbaar, dan bestelt het bestelvoorstel automatisch bij de eerste backup, met het prijsverschil erbij.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.27.2',
      date: '2026-11-19',
      title: 'Telstaat en telformulier als pdf',
      items: [
        { text: 'Bij een voorraadtelling kun je nu een telstaat als pdf downloaden (ook met alleen de verschillen) voor de boekhouding.' },
        { text: 'Voor tellen op papier is er een blanco telformulier: per locatie een blad met de artikelen en een leeg vak, zonder verwacht aantal of prijs.' },
      ],
    },
    {
      version: '1.27.1',
      date: '2026-11-19',
      title: 'Mail via Microsoft Graph automatisch instellen werkt weer',
      items: [
        { text: 'Automatisch instellen van Microsoft Graph-mail (Beheer > Instellingen > E-mail) werkt weer: Microsoft weigerde de eerder gebruikte inlog-app. Bij een fout staat er nu een duidelijke melding met verwijzing naar de handleiding in hetzelfde scherm.', for: ['beheer'] },
      ],
    },
    {
      version: '1.27.0',
      date: '2026-11-19',
      title: 'Artikelscherm overzichtelijker',
      items: [
        { text: 'Het artikelscherm is opnieuw ingedeeld: Gegevens staan in groepen naast elkaar (Basis, Prijzen en prijsbepaling, Voorraad en locatie, Verpakking en staffel, Webshop) en Mutatie boeken is een compacte balk over de volle breedte.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.26.9',
      date: '2026-11-19',
      title: 'Voorraad tellen in de orderpick-app',
      items: [
        { text: 'Magazijnmedewerkers kunnen in de orderpick-app voorraad tellen: kies een locatie, scan of tik het artikel aan en vul het getelde aantal in. Je ziet niet hoeveel er volgens de administratie ligt.' },
      ],
    },
    {
      version: '1.26.8',
      date: '2026-11-19',
      title: 'Voorraadtelling in Artikelen',
      items: [
        { text: 'Nieuw tabblad Telling bij Artikelen: een jaarlijkse of tussentijdse voorraadtelling starten, de voortgang per locatie volgen, regels met een groot verschil laten hertellen, afsluiten en alles als Excel downloaden.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.26.7',
      date: '2026-11-19',
      title: 'Voorraadtelling (jaartelling) voorbereid',
      items: [
        { text: 'De voorraadtelling voor de boekhouding is voorbereid: een telling bevriest de lijst op een peildatum, tellers tellen blind per locatie en afsluiten boekt de verschillen. De schermen volgen.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.26.6',
      date: '2026-11-19',
      title: 'Verkoopprijs volgt de factor automatisch',
      items: [
        { text: 'De verkoopprijs van artikelen met prijs volgens factor wordt automatisch bijgewerkt bij een nieuwe inkoopprijs of een andere factor. Prijsvoorstellen en goedkeuren zijn vervallen.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.26.5',
      date: '2026-11-19',
      title: 'Strengere limieten op herstel- en bevestigingsmails',
      items: [
        { text: 'De webshop beperkt nu hoe vaak één e-mailadres een wachtwoordherstelmail kan krijgen en hoe vaak een account een nieuwe bevestigingsmail kan aanvragen.' },
      ],
    },
    {
      version: '1.26.4',
      date: '2026-11-19',
      title: 'Nieuwe productkaarten in de webshop',
      items: [
        { text: 'Productkaarten in de webshop zijn compacter en even hoog: geen grote witte vlakken meer, de keuzelijst voor uitvoeringen staat netjes onder de naam en de knop *In winkelwagen* past op elke kaart (op een telefoon als winkelwagenicoon).' },
      ],
    },
    {
      version: '1.26.3',
      date: '2026-11-19',
      title: 'Offertes in bulk mailen',
      items: [
        { text: 'In het offerteoverzicht kun je meerdere offertes aanvinken en in één keer per e-mail versturen. Elke klant krijgt het standaardbericht met de link; vooraf zie je het aantal en offertes zonder e-mailadres worden overgeslagen.', for: ['offertes'] },
      ],
    },
    {
      version: '1.26.2',
      date: '2026-11-19',
      title: 'Bulkacties in de factuurlijst',
      items: [
        { text: 'In het factuuroverzicht kun je meerdere facturen aanvinken, ze in één keer per e-mail versturen en de selectie naar Excel exporteren.', for: ['facturen'] },
      ],
    },
    {
      version: '1.26.1',
      date: '2026-11-19',
      title: 'Conceptfactuur klaar zodra een werkorder Gereed is',
      items: [
        { text: 'Zet je een werkorder op Gereed, dan staat er meteen een conceptfactuur klaar met de offerteregels, uren en materiaal. Je controleert hem en maakt hem zelf definitief. Uit te zetten bij Facturen > Instellingen.', for: ['facturen'] },
      ],
    },
    {
      version: '1.26.0',
      date: '2026-11-19',
      title: 'AVG-inzage en wissen per persoon',
      items: [
        { text: 'Op de klantkaart staat een kaart Privacy (AVG): met één klik een Excel met alle persoonsgegevens van de klant (inzage), en een wisfunctie die de gegevens anonimiseert na bevestiging met de naam van de klant. Definitieve facturen en de stukken waarop ze rusten blijven zeven jaar bewaard.', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.9',
      date: '2026-11-19',
      title: 'SQLite is uit het systeem gehaald',
      items: [
        { text: 'De app draait alleen nog op PostgreSQL. Back-ups hebben een nieuw formaat; oude back-ups (SQLite) kunnen niet meer in de app worden teruggezet.', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.8',
      date: '2026-11-19',
      title: 'Graph-mail automatisch instellen',
      items: [
        { text: 'Graph-mail stel je automatisch in: je krijgt een Microsoft-code en -link, logt in als globale beheerder en de app maakt zelf de registratie, de machtiging en het geheim aan.', for: ['beheer'] },
        { text: 'Een maand voordat het clientgeheim van de Graph-mail verloopt (en zodra het verlopen is) geeft Bewaking een melding.', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.7',
      date: '2026-11-19',
      title: 'KPI\'s op het dashboard zelf kiezen',
      items: [
        { text: 'Kies zelf welke KPI\'s je op het dashboard ziet, in welke volgorde en over welke periode (Beheer > Modules > Dashboard: KPI\'s). Er zijn nu ook KPI\'s voor gefactureerde omzet, geaccepteerde offertes, open werkorders, webshopbestellingen, voorraad onder het minimum en inkooporders onderweg. Bezetting staat standaard uit.', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.6',
      date: '2026-11-19',
      title: 'Offertesjablonen',
      items: [
        { text: 'Offertesjablonen: kies in de offerte een sjabloon met een vaste inleiding, voorwaarden en standaardregels (bijv. voorrijkosten) in plaats van alles te typen. De beheerder bewaart een offerte als sjabloon met één klik.', for: ['offertes'] },
      ],
    },
    {
      version: '1.25.5',
      date: '2026-11-19',
      title: 'Hoofdbeheer-routes in eigen bestand',
      items: [],
    },
    {
      version: '1.25.4',
      date: '2026-11-19',
      title: 'Bulkacties in de artikelenlijst',
      items: [
        { text: 'In de artikelenlijst kun je meerdere artikelen aanvinken en in één keer archiveren of er etiketten voor printen (aantal per artikel en sjabloon te kiezen).', for: ['voorraad'] },
      ],
    },
    {
      version: '1.25.3',
      date: '2026-11-19',
      title: 'Servertaken alleen tonen als er iets openstaat',
      items: [
        { text: 'Het blok Servertaken onder Updates verschijnt alleen nog als er een taak openstaat; afgeronde taken staan ingeklapt onderaan. Vinkje en titel staan nu links uitgelijnd.', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.2',
      date: '2026-11-19',
      title: 'Offertes volgen zichzelf op',
      items: [
        { text: 'Offerte-opvolging: heeft een klant niet gereageerd op een gemailde offerte, dan stuurt AquaTech na het ingestelde aantal dagen vanzelf een vriendelijke herinnering met de knop naar de offerte. Instellen onder Beheer > Instellingen > Offerte-opvolging (standaard uit).', for: ['beheer'] },
      ],
    },
    {
      version: '1.25.1',
      date: '2026-11-19',
      title: 'Bulkacties in de offertelijst',
      items: [
        { text: 'In het offerteoverzicht kun je meerdere offertes aanvinken: exporteer alleen de selectie naar Excel of sluit alle open offertes in één keer af als afgewezen.', for: ['offertes'] },
      ],
    },
    {
      version: '1.25.0',
      date: '2026-11-19',
      title: 'Beheer-code overzichtelijker opgedeeld',
      items: [],
    },
    {
      version: '1.24.9',
      date: '2026-11-19',
      title: 'MCP-tools in kleinere bestanden',
      items: [],
    },
    {
      version: '1.24.8',
      date: '2026-11-19',
      title: 'Webshop-kop netjes uitgelijnd',
      items: [],
    },
    {
      version: '1.24.7',
      date: '2026-11-19',
      title: 'Eén zoekveld voor alles',
      items: [
        { text: 'Bovenaan de zijbalk staat nu een zoekveld (sneltoets Ctrl+K of /) dat in één keer klanten, offertes, werkorders, facturen en artikelen doorzoekt, op naam, nummer, adres of artikelcode. Je ziet alleen de soorten waar je het recht voor hebt; een klik opent het item direct.', for: ['offertes', 'werkorders', 'facturen', 'voorraad', 'klanten'] },
      ],
    },
    {
      version: '1.24.6',
      date: '2026-11-19',
      title: 'Klanten zoeken houdt de server niet meer op',
      items: [],
    },
    {
      version: '1.24.5',
      date: '2026-11-19',
      title: 'Automatische betalingsherinneringen en aanmaningen',
      items: [
        { text: 'AquaTech mailt de klant nu automatisch een betalingsherinnering en aanmaningen als een factuur over de vervaldatum is. Je stelt het in onder Beheer > Modules > Facturen: betalingsherinneringen (aan/uit, na hoeveel dagen per stap). Standaard staat het uit.', for: ['facturen', 'beheer'] },
        { text: 'Op de factuur zie je welke herinnering of aanmaning is verstuurd, en in de lijst staat de laatste stap bij de status.', for: ['facturen'] },
        { text: 'Op de klantkaart zet je de automatische herinneringen voor één klant uit.', for: ['facturen', 'klanten'] },
        { text: 'De teksten van de herinnering en aanmaningen pas je aan onder Mail-opmaak (groep Facturen).', for: ['beheer'] },
      ],
    },
    {
      version: '1.24.4',
      date: '2026-11-19',
      title: 'Draaiboek voor de verhuizing naar een VPS',
      items: [
        { text: 'Beheer > Systeem heeft een afvinkbaar draaiboek voor de verhuizing naar een VPS: voorbereiden, inrichten, proefverhuizing, verhuisdag, controle en terugvallen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.24.3',
      date: '2026-11-19',
      title: 'Kengetallen op het beheerdersdashboard',
      items: [
        { text: 'Het startscherm toont voor beheerders vier kengetallen: openstaand bedrag, vervallen facturen, open offertes en de bezetting van deze week.', for: ['beheer'] },
      ],
    },
    {
      version: '1.24.2',
      date: '2026-11-19',
      title: 'Betaallink in de factuurmail',
      items: [
        { text: 'De factuurmail bevat een link waarmee de klant de factuur direct online kan betalen (iDEAL en andere methodes via Mollie), ook zonder in te loggen. Na betaling staat de factuur automatisch op betaald.', for: ['facturen'] },
      ],
    },
    {
      version: '1.24.1',
      date: '2026-11-19',
      title: 'Mail versturen via Microsoft 365 (Graph)',
      items: [
        { text: 'Mail kan nu via Microsoft 365 (Graph) worden verstuurd in plaats van SMTP. Dat gaat over HTTPS, dus een geblokkeerde mailpoort bij de internetprovider is geen probleem meer. In Beheer > Instellingen > E-mail staat een stappenplan voor de app-registratie in Microsoft Entra, inclusief het beperken van de app tot één mailbox.', for: ['beheer'] },
      ],
    },
    {
      version: '1.24.0',
      date: '2026-11-19',
      title: 'Kleiner image en opgeschoonde documentatie',
      items: [],
    },
    {
      version: '1.23.9',
      date: '2026-11-19',
      title: 'Servertaken als afvinklijst',
      items: [
        { text: 'Commando\'s die op de server uitgevoerd moeten worden staan nu in Beheer > Systeem > Updates als afvinklijst, met één vast commando en een kopieerknop. Het dashboard toont wat nog openstaat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.23.8',
      date: '2026-11-19',
      title: 'Duidelijkere mailfouten bij de testmail',
      items: [
        { text: 'Als de testmail of een andere mail niet lukt, noemt de melding nu de mailserver en poort en zegt ze wat er mis is: geen antwoord (vaak een geblokkeerde poort), geweigerde verbinding of onbekende servernaam.', for: ['beheer'] },
      ],
    },
    {
      version: '1.23.7',
      date: '2026-11-19',
      title: 'Lange back-uplijsten klappen in',
      items: [
        { text: 'De lijst met back-ups en de lijsten bij Back-ups naar Google Drive (bestanden en logboek) tonen nu de nieuwste vijf regels, met de knop "Toon alle" voor de rest.', for: ['beheer'] },
      ],
    },
    {
      version: '1.23.6',
      date: '2026-11-19',
      title: 'Facturen online betalen in het klantportaal',
      items: [
        { text: 'In het klantportaal staat nu het blok Facturen met uw definitieve en betaalde facturen, met een PDF per factuur.' },
        { text: 'Staat online betalen aan, dan betaalt u een openstaande factuur met de knop "Nu betalen" via iDEAL of een andere methode van Mollie. Na de betaling staat de factuur meteen op betaald, ook bij de debiteuren van het bedrijf.' },
      ],
    },
    {
      version: '1.23.5',
      date: '2026-11-19',
      title: 'Meldingenbelletje met teller in de kopbalk',
      items: [
        { text: '[voorraad] In de kopbalk staat nu een belletje met het aantal openstaande taken (bestellingen verwerken, bestelvoorstellen, prijsvoorstellen). Een klik toont de lijst en brengt je direct naar het juiste scherm; bij één openstaand punt ga je meteen naar dat punt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.23.4',
      date: '2026-11-19',
      title: 'Snellere en stabielere testsuite',
      items: [],
    },
    {
      version: '1.23.3',
      date: '2026-11-19',
      title: 'Logboek: herhaalde meldingen als één regel',
      items: [
        { text: 'In het Logboek staat een herhaalde melding (bijvoorbeeld een trage taak of stilstand) nu als één regel met het aantal en de eerste en laatste keer, ook in de Excel-export.', for: ['beheer'] },
      ],
    },
    {
      version: '1.23.2',
      date: '2026-11-19',
      title: 'Openstaande taken op het dashboard',
      items: [
        { text: 'Op het startscherm staat nu een blok "Openstaande taken" met de binnengekomen webshopbestellingen die nog niet verzonden zijn (de oudste vijf, met link naar elke bestelling).', for: ['beheer'] },
        { text: 'Hetzelfde blok toont de bestelvoorstellen die klaarstaan bij lage voorraad, artikelen onder het minimum zonder voorkeursleverancier en open prijsvoorstellen. Zonder openstaande taken verdwijnt het blok.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.23.1',
      date: '2026-11-19',
      title: 'Snellere pagina\'s door verkleinde scripts en stijlen',
      items: [
        { text: 'Pagina\'s laden sneller: de scripts en stijlen van de app zijn verkleind.' },
      ],
    },
    {
      version: '1.23.0',
      date: '2026-11-19',
      title: 'Handmatig controleren op updates',
      items: [
        { text: 'In Beheer > Systeem > Updates kun je nu met één klik controleren of er een nieuwe versie klaarstaat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.22.9',
      date: '2026-11-19',
      title: 'Rustigere kop in de webshop',
      items: [],
    },
    {
      version: '1.22.8',
      date: '2026-11-19',
      title: 'Webshopsynchronisatie standaard één keer per nacht',
      items: [
        { text: 'De volledige vergelijking met de webshop draait nu standaard één keer per nacht in plaats van elke 10 minuten. In Beheer > Webshop kies je ook elk uur of elke 10 minuten.', for: ['beheer'] },
      ],
    },
    {
      version: '1.22.7',
      date: '2026-11-19',
      title: 'Google-verificatie voor de webshop',
      items: [],
    },
    {
      version: '1.22.6',
      date: '2026-11-19',
      title: 'Nieuw ontwerp voor de winkelwagen van de webshop',
      items: [
        { text: 'De winkelwagen in de webshop is overzichtelijker: de regels staan in een nette kaart, het totaal valt beter op en de knop "Naar afrekenen" is groot en makkelijk te raken, ook op mobiel.' },
      ],
    },
    {
      version: '1.22.5',
      date: '2026-11-19',
      title: 'Orderpick: wisselen tussen Picken en Ontvangen werkt weer',
      items: [
        { text: 'Van Ontvangen terug naar Picken laat nu alleen het pickscherm zien, in plaats van beide schermen onder elkaar.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.22.4',
      date: '2026-11-19',
      title: 'Nieuw ontwerp voor de productpagina van de webshop',
      items: [
        { text: 'De productpagina in de webshop is overzichtelijker: grotere foto, duidelijke prijs en voorraad en een hoge winkelwagenknop die ook op mobiel makkelijk te raken is.' },
      ],
    },
    {
      version: '1.22.3',
      date: '2026-11-19',
      title: 'Stappenplan voor Google Drive-back-ups',
      items: [
        { text: 'Beheer > Systeem > Back-ups naar Google Drive heeft bovenaan een stappenplan om de Google-app in te stellen, en de velden staan netjes op één lijn.', for: ['beheer'] },
      ],
    },
    {
      version: '1.22.2',
      date: '2026-11-19',
      title: 'Nieuw ontwerp voor de categoriepagina van de webshop',
      items: [
        { text: 'Categoriepagina\'s in de webshop zijn rustiger en overzichtelijker: grotere productkaarten met duidelijke prijs en voorraad, nette filters en grotere knoppen op mobiel.' },
      ],
    },
    {
      version: '1.22.1',
      date: '2026-11-19',
      title: 'Prijsvoorstel goedkeuren bij het artikel',
      items: [
        { text: 'Na een nieuwe inkoopprijs zie je bij het artikel direct "Nieuwe verkoopprijs voorgesteld: oud → nieuw" met de knoppen Goedkeuren en Negeren. In de artikellijst staat een label Voorstel bij de verkoopprijs. De prijs verandert nooit vanzelf.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.22.0',
      date: '2026-11-19',
      title: 'Tabellen op mobiel houden de artikelkolom in beeld',
      items: [
        { text: 'Op een telefoon blijft in alle tabellen de eerste kolom (artikel, nummer of naam) links staan als je de rest opzij schuift, zodat je altijd ziet om welk item het gaat.' },
      ],
    },
    {
      version: '1.21.9',
      date: '2026-11-19',
      title: 'Levertijd zichtbaar in shop, mail en Beheer',
      items: [
        { text: 'De webshop toont bij een artikel in gewone taal welke levermethode bij welk aantal geldt, bijvoorbeeld "pallet vanaf 100 stuks".' },
        { text: 'De bestelpagina en de orderbevestigingsmail noemen de verwachte levertijd, steeds als indicatie en niet als toezegging.' },
        { text: 'Bij een webshopbestelling staan de levermethode en de levertijd bij het bestellen, ook in de Excel-export.', for: ['webshop'] },
        { text: 'Bij een artikel toont Beheer per levermethode de aantallen en de levertijd, op voorraad en niet op voorraad.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.21.8',
      date: '2026-11-19',
      title: 'Miniaturen van artikelfoto\'s maken ook in Safari',
      items: [
        { text: '*Afbeeldingen en miniaturen* maakt de miniaturen nu ook in Safari (iPhone, iPad, Mac). Safari kan geen WebP maken, dus daar wordt de miniatuur een JPEG. Bij een eerdere poging gemaakte afbeeldingen krijgen bij een nieuwe run alsnog hun miniatuur.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.21.7',
      date: '2026-11-19',
      title: 'Logboek in Beheer',
      items: [
        { text: 'Nieuw: Beheer > Systeem > Logboek. Zoek op foutcode of verzoek-id en filter op niveau, bron en periode; exporteren naar Excel kan ook. De bewaartermijn van het logboek stel je in bij Sessies en bewaartermijnen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.21.6',
      date: '2026-11-19',
      title: 'Centraal logboek voor fouten en traagheid',
      items: [
        { text: 'Fouten, trage verzoeken en storingen worden nu bewaard in een centraal logboek (zoeken en bekijken in Beheer volgt). Elke foutmelding noemt ook een verzoek-id, zodat de beheerder precies kan terugvinden wat er gebeurde.', for: ['beheer'] },
      ],
    },
    {
      version: '1.21.5',
      date: '2026-11-19',
      title: 'Afbeeldingen uit de oude webshop overnemen werkt ook met AVIF',
      items: [
        { text: '*Afbeeldingen en miniaturen* neemt nu ook de foto\'s over die de oude webshop als AVIF aanbiedt (dat waren alle foto\'s). Je browser zet ze om naar JPEG en maakt meteen de miniatuur. Een eerdere poging die alles als mislukt toonde, kun je gewoon opnieuw starten.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.21.4',
      date: '2026-11-18',
      title: 'Startpagina van de webshop laadt veel lichter',
      items: [
        { text: 'De grote afbeeldingen op de startpagina van de webshop (hoofdbanner, banners en het zakelijke blok) zijn nu ongeveer 70 procent kleiner, op een telefoon nog meer. De pagina laadt daardoor merkbaar sneller.' },
      ],
    },
    {
      version: '1.21.3',
      date: '2026-11-18',
      title: 'Snellere productkaartjes met miniaturen',
      items: [
        { text: 'Productkaartjes in de webshop gebruiken nu een kleine miniatuur van de foto (ongeveer een tiende van de grootte), zodat overzichten sneller laden, vooral op een telefoon. Nieuwe foto\'s krijgen er automatisch een. Voor bestaande foto\'s klik je onder Artikelen op *Afbeeldingen en miniaturen*.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.21.2',
      date: '2026-11-18',
      title: 'Webshop is na een update meteen snel',
      items: [
        { text: 'Na een update of herstart warmt de webshop zichzelf op, zodat de eerste bezoekers niet 1 tot 3 seconden extra wachten.' },
      ],
    },
    {
      version: '1.21.1',
      date: '2026-11-18',
      title: 'Webshop opent ook na een rustig moment snel',
      items: [
        { text: 'De webshop opent nu ook voor de eerste bezoeker na een rustig moment snel: pagina\'s wachten niet meer op het opnieuw opbouwen van het assortiment.' },
      ],
    },
    {
      version: '1.21.0',
      date: '2026-11-18',
      title: 'Mail-opmaak en mailteksten zelf instellen',
      items: [
        { text: 'Nieuw: Beheer > Mail-opmaak. Stel het logo, de kleuren en de voettekst van je e-mails in en pas per soort mail het onderwerp en de tekst aan (orderbevestiging, verzending, retour, betalingsherinnering, account, inkooporder). Je ziet meteen een voorbeeld en kunt een testmail naar jezelf sturen.', for: ['beheer'] },
        { text: 'Alle mails aan klanten staan nu in de huisstijl van je organisatie, met je logo erin.' },
      ],
    },
    {
      version: '1.20.2',
      date: '2026-11-18',
      title: 'Betalingsherinnering ook voor gasten en inkooporders mailen',
      items: [
        { text: 'Een bestelde inkooporder stuur je met één knop (*Versturen naar leverancier*) per e-mail naar de leverancier. Je ziet eerst de ontvanger, het onderwerp en de tekst en kunt ze aanpassen; de inkooporder gaat als PDF mee. Er gaat nooit iets vanzelf weg, en op de order staat wanneer en naar wie hij is verstuurd.', for: ['voorraad'] },
        { text: 'Ook wie als gast bestelt en de online betaling niet afrondt, krijgt na een uur één herinnering met een link om af te rekenen, op het adres dat bij het afrekenen is ingevuld.' },
      ],
    },
    {
      version: '1.20.1',
      date: '2026-11-18',
      title: 'Tabellen kloppen op de telefoon en producttekst bij het artikel',
      items: [
        { text: 'Tabellen (zoals de prijshistorie en voorraadlagen van een artikel) blijven op de telefoon binnen hun kaart en scrollen zijdelings.' },
        { text: 'De producttekst van een artikel schrijf, controleer en keur je nu goed in het artikel zelf. Het tabblad Teksten blijft voor in bulk concepten schrijven en opent het artikel om te beoordelen.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.20.0',
      date: '2026-11-18',
      title: 'Werkorders hangen aan een klant',
      items: [
        { text: 'Een werkorder hangt nu echt aan een klant uit de klantenlijst. In de werkorder kies je de klant (adres, e-mail en telefoon worden ingevuld) of ontkoppel je hem weer; de werkorder staat dan ook op de klantkaart.', for: ['werkorders', 'klanten'] },
        { text: 'Bestaande werkorders zijn gekoppeld via hun offerte of melding. Met *Koppel op naam* in het werkorderoverzicht koppel je de rest als de naam bij precies één klant past (alleen als je op de knop klikt, dus een bewuste ontkoppeling blijft staan); werkorders zonder klant krijgen het label *Niet gekoppeld* en zijn te filteren.', for: ['werkorders', 'klanten'] },
        { text: 'De AI-koppeling zet bij een werkorder de gekozen klant (klantId) nu ook echt vast.', for: ['werkorders'] },
      ],
    },
    {
      version: '1.19.9',
      date: '2026-11-18',
      title: 'Drempelbedrag voor Offerte aanvragen instelbaar',
      items: [
        { text: 'In Beheer > Webshop > Betalen stel je in vanaf welk bedrag (excl. btw) een zakelijke klant in de winkelwagen een offerte kan aanvragen (standaard 500 euro), of zet je Offerte aanvragen helemaal uit.', for: ['beheer'] },
      ],
    },
    {
      version: '1.19.8',
      date: '2026-11-18',
      title: 'Eigen koopfunnelteller in de webshop',
      items: [
        { text: 'Webshopbestellingen heeft een tabblad Funnel: hoe vaak bezoekers een productpagina bekeken, iets in de winkelwagen legden, afrekenen openden, bestelden en online betaalden, met het aandeel ten opzichte van de vorige stap, per periode (7, 30, 90 dagen of 12 maanden) en met Excel-export. Het zijn aantallen, geen unieke bezoekers, en er wordt nooit bewaard wie het was.', for: ['beheer'] },
      ],
    },
    {
      version: '1.19.7',
      date: '2026-11-18',
      title: 'Offerte aanvragen en opnieuw bestellen in de webshop',
      items: [
        { text: 'Een zakelijke klant met een winkelwagen vanaf 500 euro excl. btw kan een offerte aanvragen in plaats van af te rekenen. Dat maakt een concept in Offertes (alleen zichtbaar voor medewerkers, bij "alle offertes") en je krijgt een mail. Je controleert het concept en verstuurt de offerte zelf.', for: ['beheer'] },
        { text: 'Klanten kunnen een eerdere bestelling met één klik opnieuw bestellen: de artikelen komen in de winkelwagen met de actuele prijzen en voorraad; wat niet meer te koop is wordt gemeld.' },
      ],
    },
    {
      version: '1.19.6',
      date: '2026-11-18',
      title: 'Planner promoten in de webshop',
      items: [
        { text: 'De webshop prijst de gratis planner aan: een blok "Ontwerp je beregening gratis, bestel de complete lijst" op de startpagina en in de beregeningscategorieën. Het blok verdwijnt als je de planner uitzet in de instellingen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.19.5',
      date: '2026-11-18',
      title: 'Herinnering bij niet afgeronde betaling',
      items: [
        { text: 'Een klant die een online betaling niet afrondt, krijgt na een uur één herinneringsmail met een link om alsnog te betalen, zolang de reservering loopt. Je zet dit uit in Beheer > Webshop > Betalen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.19.4',
      date: '2026-11-18',
      title: 'Zoeksuggesties en zoektermen zonder resultaat',
      items: [
        { text: 'In de webshop verschijnen onder het zoekveld na twee tekens een paar passende producten. Bezoekers komen zo sneller bij het goede artikel.', for: ['beheer'] },
        { text: 'Bij Webshopbestellingen staat een nieuw tabblad Zoektermen: wat bezoekers zochten zonder iets te vinden, met een Excel-export. Zo zie je welk artikel ontbreekt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.19.3',
      date: '2026-11-18',
      title: 'Beter zoeken in de webshop',
      items: [
        { text: 'Zoeken in de webshop zet de juiste treffer bovenaan: een exacte artikelnummer (ook met streepje of spatie) komt eerst. Vind je niets precies, dan zoekt de webshop ook op meervouden, verwante woorden (sproeier en sprinkler) en kleine typefouten.' },
      ],
    },
    {
      version: '1.19.2',
      date: '2026-11-18',
      title: 'Voorraad in de webshop en voorraadmelding',
      items: [
        { text: 'Bij een kleine voorraad toont de webshop nu "Nog 3 op voorraad". Is een artikel uitverkocht, dan kan een bezoeker zijn e-mailadres achterlaten en krijgt één mail zodra het weer te bestellen is; het adres wordt daarna gewist.' },
      ],
    },
    {
      version: '1.19.1',
      date: '2026-11-18',
      title: 'Winkelwagen en afrekenen duidelijker',
      items: [
        { text: 'De winkelwagen toont nu al de verzendkosten, de levertijd en hoeveel er nog aan gratis bezorging ontbreekt.' },
        { text: 'Bij het afrekenen kies je de verzendmethode uit kaarten met prijs en levertijd, en staat er een strook met levertijd, gratis-vanaf, bedenktijd en het telefoonnummer.' },
        { text: 'Het aantal in de winkelwagen wordt direct bijgewerkt en op een telefoon staat elke regel als kaart. Verder winkelen brengt je terug naar de laatst bekeken categorie.' },
        { text: 'Een zoekopdracht zonder resultaat geeft tips, de categorieën en ons telefoonnummer. Het blok Dropshipping zien alleen zakelijke klanten.' },
      ],
    },
    {
      version: '1.19.0',
      date: '2026-11-18',
      title: 'Producttekst laten schrijven door de AI',
      items: [
        { text: 'Nieuw tabblad Teksten bij Artikelen: de AI schrijft een concept van de omschrijving en de zoekmachineteksten, alleen met de gegevens die bij het artikel staan. Jij controleert en keurt goed; niets gaat vanzelf live.', for: ['voorraad'] },
        { text: 'Getallen, eenheden en beweringen (zoals keuren of garantie) in een concept die niet in de artikelgegevens staan worden gemarkeerd. Goedkeuren vraagt dan een uitdrukkelijke bevestiging.', for: ['voorraad'] },
        { text: 'Concepten schrijven kan voor één artikel of voor een selectie (bijvoorbeeld een categorie of alle artikelen zonder tekst); je keurt ze één voor één of in bulk goed of wijst ze af.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.18.1',
      date: '2026-11-18',
      title: 'Webshoppagina\'s bouwen met blokken',
      items: [
        { text: 'Nieuwe pagina\'s voor de webshop maak je nu zonder code in Beheer > Webshop-inhoud > Pagina\'s: bouw ze uit blokken (tekst, afbeelding, artikelen, veelgestelde vragen en een knop met tekst), zet ze in de gewenste volgorde en bekijk eerst het voorbeeld.', for: ['beheer'] },
        { text: 'Veelgestelde vragen op een pagina komen ook als gestructureerde gegevens (FAQPage) in de pagina, en pagina\'s met een korte omschrijving staan met die omschrijving in llms.txt (zodra de webshop is vrijgegeven voor zoekmachines).', for: ['beheer'] },
      ],
    },
    {
      version: '1.18.0',
      date: '2026-11-18',
      title: 'Levermethode en levertijd per artikel',
      items: [
        { text: 'Per artikel of productcategorie bepaal je welke bezorgmethodes mogen, met een aantalgrens (bijvoorbeeld vanaf 100 stuks alleen pallet). Een bestelling met artikelen die verschillende methodes vragen gaat met de zwaarste methode (pallet) mee.', for: ['beheer', 'voorraad'] },
        { text: 'Pallet en eigen transport kunnen een aantalstaffel krijgen naast de weegklassen. Per methode stel je de levertijd in, in kalender- of werkdagen.', for: ['beheer'] },
        { text: 'De webshop toont een indicatieve levertijd bij het product en bij het afrekenen; is die niet bekend, dan staat er "Levertijd op aanvraag". Een artikel kan een eigen levertijd hebben, en als het niet op voorraad is volgt de levertijd uit de inkooporder of de levertijd van de leverancier.' },
      ],
    },
    {
      version: '1.17.3',
      date: '2026-11-18',
      title: 'SEO-opties voor de webshop',
      items: [
        { text: 'Per artikel stel je nu een eigen titel en omschrijving voor zoekmachines in, plus het merk. Laat je ze leeg, dan maakt de webshop er zelf een goede van.', for: ['beheer', 'voorraad'] },
        { text: 'Ook categorieën (Webshop-inhoud > Menu) en pagina\'s krijgen een eigen titel voor zoekmachines.', for: ['beheer'] },
        { text: 'Nieuw: Beheer > Webshop > Zoekmachines. Zolang je dat niet aanzet, blijft de webshop onzichtbaar voor Google: elke pagina op noindex, robots.txt blokkeert alles en de sitemap bestaat niet. Zet het aan zodra de webshop live gaat.', for: ['beheer'] },
      ],
    },
    {
      version: '1.17.2',
      date: '2026-11-18',
      title: 'Pagina\'s openen niet meer vast tijdens de back-up',
      items: [
        { text: 'De dagelijkse back-up draait voortaan los van de app, zodat pagina\'s niet meer tientallen seconden kunnen blijven hangen terwijl de database wordt gekopieerd.', for: ['beheer'] },
      ],
    },
    {
      version: '1.17.1',
      date: '2026-11-14',
      title: 'Bestellen in de webshop zonder account',
      items: [
        { text: 'Klanten kunnen in de webshop afrekenen zonder account: alleen naam, e-mailadres en adres invullen en direct online betalen. Je volgt je bestelling met de persoonlijke link in de bevestigingsmail en kunt daar ook een retour aanvragen of de factuur downloaden.' },
        { text: 'Na de bestelling kan een klant alsnog een account maken door alleen een wachtwoord te kiezen; de bestelling staat dan in zijn account.' },
        { text: 'Onder Beheer > Webshop > Betalen staat een schakelaar *Bestellen zonder account toestaan*. Zakelijk bestellen, op rekening betalen en dropshipping blijven alleen met een account.', for: ['beheer'] },
      ],
    },
    {
      version: '1.17.0',
      date: '2026-11-14',
      title: 'Onzichtbare captcha op openbare formulieren',
      items: [
        { text: 'Nieuw in Beheer > Toegang & beveiliging: *Onzichtbare captcha*. Met een sleutel van Google reCAPTCHA v3 beschermt de app de inlogpagina, tekening indienen en de webshopformulieren (inloggen, registreren, wachtwoord vergeten, zakelijk aanvragen, afrekenen) tegen robots, zonder dat klanten iets hoeven te doen. Zonder sleutels werkt alles zoals voorheen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.16.9',
      date: '2026-11-14',
      title: 'Google Analytics in de webshop',
      items: [
        { text: 'Je kunt Google Analytics 4 aanzetten voor de webshop (Beheer > Webshop > Google Analytics). Bezoekers krijgen eerst een cookiemelding; zonder toestemming wordt er niets gemeten of van Google geladen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.16.8',
      date: '2026-11-14',
      title: 'Opmaak ook voor offerte, werkbon en klantdossier',
      items: [
        { text: 'De Documentopmaak uit Beheer geldt nu ook voor de offerte (ook de link die de klant opent), de werkbon en het klantdossier: logo, kopstijl, kleuren, lettertype en voettekst zijn overal gelijk.', for: ['beheer'] },
      ],
    },
    {
      version: '1.16.7',
      date: '2026-11-14',
      title: 'Opmaak van factuur en pakbon aanpassen',
      items: [
        { text: 'Nieuw in Beheer: Documentopmaak. Kies je eigen logo, de positie van het logo, een gekleurde of witte kop, de kleuren, het lettertype en een eigen voettekst voor de factuur en de pakbon. Het voorbeeld ernaast past zich meteen aan.', for: ['beheer'] },
      ],
    },
    {
      version: '1.16.6',
      date: '2026-11-14',
      title: 'Goederen ontvangen met de scanner in de orderpick-app',
      items: [
        { text: 'In de orderpick-app staat nu naast Picken het tabblad Ontvangen: kies een bestelde inkooporder of scan het ordernummer, de leveranciersreferentie of een artikel, scan de artikelen, bevestig de aantallen en boek de ontvangst. Een deel ontvangen kan ook; de rest blijft open staan.', for: ['orderpick'] },
        { text: 'Na het ontvangen worden wachtende backorders van webshopbestellingen die nu kunnen worden verzonden meteen weer klaargezet onder Picken.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.16.5',
      date: '2026-11-14',
      title: 'Plan uit de AI-koppeling omzetten naar offerte of werkorder',
      items: [
        { text: 'Via Claude of ChatGPT kun je een gemaakt beregeningsplan nu direct omzetten naar een concept-offerte (materiaal, arbeid en voorrijkosten) of een nieuwe werkorder; je controleert alles daarna in AquaTech.', for: ['plannen', 'offertes', 'werkorders'] },
      ],
    },
    {
      version: '1.16.4',
      date: '2026-11-14',
      title: 'Beregeningsplan maken via de AI-koppeling',
      items: [
        { text: 'Geef Claude of ChatGPT een tekening of foto van de tuin: de AI leest de vlakken af en AquaTech maakt er een beregeningsplan van met sproeiers, zones en een stuklijst met jouw prijzen. Je krijgt een verslag met aandachtspunten om in de chat na te kijken en bij te sturen; het plan staat als concept in de Beregeningsplanner. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.', for: ['plannen'] },
      ],
    },
    {
      version: '1.16.3',
      date: '2026-11-14',
      title: 'Rapporten als Excel via de AI-koppeling',
      items: [
        { text: 'Via Claude of ChatGPT kun je nu een urenstaat, de openstaande facturen of een voorraadlijst als Excel-bestand laten maken. Je krijgt een link die 15 minuten werkt, alleen voor jou en alleen als je in AquaTech bent ingelogd. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.', for: ['werkorders'] },
      ],
    },
    {
      version: '1.16.2',
      date: '2026-11-14',
      title: 'Uren en materiaal boeken via de AI-koppeling',
      items: [
        { text: 'Via Claude of ChatGPT kun je nu uren en verbruikt materiaal op een werkorder boeken, op je eigen naam. Bij twijfel of een dubbele boeking vraagt de AI eerst terug. In AquaTech kun je de regels gewoon wijzigen of verwijderen. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.', for: ['werkorders'] },
      ],
    },
    {
      version: '1.16.1',
      date: '2026-11-14',
      title: 'Concept-werkorder via de AI-koppeling',
      items: [
        { text: 'Via Claude of ChatGPT kun je nu een werkorder laten klaarzetten, bijvoorbeeld voor onderhoud of een reparatie. Hij staat als Nieuw klaar, zonder planning en zonder uitvoerder; jij plant hem zelf in. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.', for: ['werkorders'] },
      ],
    },
    {
      version: '1.16.0',
      date: '2026-11-13',
      title: 'Bewaking en meldingen bij storingen',
      items: [
        { text: 'Nieuw in Beheer > Systeem > Bewaking: de app controleert zelf of de database, back-ups, updates en koppelingen (Google Drive, mail, Mollie, Visma, webshop, AI) werken en meldt een storing per e-mail of webhook, met een herstelmelding en herinneringen.', for: ['beheer'] },
        { text: 'Een extern heartbeat-adres laat je weten als de app of de server zelf uitvalt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.15.7',
      date: '2026-11-13',
      title: 'Automatische bestelvoorstellen',
      items: [
        { text: 'Zakt een artikel onder de minimumvoorraad, dan zet AquaTech elk uur per voorkeursleverancier een concept-inkooporder klaar. Je ziet ze onder Inkoop > Bestelvoorstel, met een label Voorstel bij de Inkooporders. Er wordt nooit iets besteld zonder jouw goedkeuring: goedkeuren, aanpassen of per artikel op "Niet bestellen" zetten.' },
        { text: 'Wat al onderweg is en wat op backorder staat telt mee, zodat niets dubbel wordt besteld. Uitzetten kan in Beheer > Modules > Artikelen: bestelvoorstellen.' },
      ],
    },
    {
      version: '1.15.6',
      date: '2026-11-13',
      title: 'Vijvers en huizen aan de tuinrand beter herkend zonder AI',
      items: [
        { text: 'Plannen lezen zonder AI herkent een lichtblauwe vijver nu als water en een huis dat tegen de rand van de tuin staat als bebouwing.' },
      ],
    },
    {
      version: '1.15.5',
      date: '2026-11-13',
      title: 'Betere herkenning van huis en terras zonder AI',
      items: [
        { text: 'Plannen lezen zonder AI herkent een woning (wit vak met omtrek) en egale terrassen (baksteen, hout) nu als verharding in plaats van als beplanting of niets, zodat daar geen sproeiers of druppelslang komen.' },
      ],
    },
    {
      version: '1.15.4',
      date: '2026-11-13',
      title: 'Verzonnen tuinplannen om de herkenning te meten',
      items: [],
    },
    {
      version: '1.15.3',
      date: '2026-11-13',
      title: 'Tekeningen bewaren om de herkenning te verbeteren',
      items: [
        { text: 'Nieuwe instelling *Tekeningen bewaren om de herkenning te verbeteren* (Beheer → Koppelingen → AI-herkenning, standaard uit). Bij een goedgekeurd plan bewaart de app dan de tekening (versleuteld) en het eindplan, zodat de planner zonder AI steeds beter plannen kan lezen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.15.2',
      date: '2026-11-13',
      title: 'Meetlat voor de planherkenning zonder AI',
      items: [],
    },
    {
      version: '1.15.1',
      date: '2026-11-13',
      title: 'Compactere webshopkop op mobiel',
      items: [
        { text: 'Op de telefoon staan logo, klantenservice, beheer, account en winkelwagen van de webshop nu op één rij met de zoekbalk er direct onder; de mededelingenbalk is kleiner.' },
      ],
    },
    {
      version: '1.15.0',
      date: '2026-11-13',
      title: 'Orderregels afzonderlijk terugzetten uit een back-up',
      items: [
        { text: 'Beheer > Terugzetten uit back-up: bij een offerte of webshopbestelling kun je nu ook losse regels terugzetten (een verwijderde of gewijzigde regel), zonder de rest van het record aan te raken. Het totaal wordt opnieuw berekend en bij een bestelling volgt de voorraadreservering. Een bestelling die al in behandeling is (verzonden, deels geleverd of online betaald) en een geaccordeerde offerte blijven met rust.', for: ['beheer'] },
      ],
    },
    {
      version: '1.14.9',
      date: '2026-11-13',
      title: 'Terugzetten uit een back-up (deels of per record)',
      items: [
        { text: 'Beheer > Terugzetten uit back-up: open een back-up (alleen lezen), zoek een offerte, werkorder, factuur, bestelling, inkooporder, artikel, leverancier, klant of tuinplan en zet hem terug, helemaal of alleen de velden die je kiest. Je ziet eerst precies wat er verandert, en vóór het terugzetten wordt automatisch een nieuwe back-up gemaakt. Je bevestigt met je wachtwoord.', for: ['beheer'] },
      ],
    },
    {
      version: '1.14.8',
      date: '2026-11-13',
      title: 'Back-ups automatisch naar Google Drive',
      items: [
        { text: 'Beheer > Back-ups naar Google Drive: elke nieuwe back-up wordt automatisch (versleuteld) naar je eigen Google Drive gekopieerd. Je verbindt eenmalig met Google, kiest de mapnaam en hoeveel back-ups er blijven staan, en ziet daar ook de bestanden op Drive en een logboek. Gaat er iets mis, dan zie je een waarschuwing.', for: ['beheer'] },
      ],
    },
    {
      version: '1.14.7',
      date: '2026-11-13',
      title: 'Database naar een eigen PostgreSQL naast de app',
      items: [],
    },
    {
      version: '1.14.6',
      date: '2026-11-13',
      title: 'De app heet nu AquaTech Hub',
      items: [
        { text: 'De app heet nu **AquaTech Hub**: de naam staat in het tabblad van je browser en bij het installeren op je telefoon. De Beregeningsplanner blijft een onderdeel (module) van de Hub; de webshop blijft AquaTech Shop.' },
      ],
    },
    {
      version: '1.14.5',
      date: '2026-11-13',
      title: 'Orderpick werkt ook zonder verbinding',
      items: [
        { text: 'Orderpick werkt nu ook in een hoek van het magazijn zonder bereik: de bestellingen die al geladen waren blijven openen en een afgemelde pick wordt bewaard en verstuurd zodra je weer online bent. Pakbon en label maak je daarna onder *Net gepickt*.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.14.4',
      date: '2026-11-13',
      title: 'Orderpick-scherm voor het magazijn',
      items: [
        { text: 'Nieuw scherm *Orderpick* voor het magazijn: kies een bestelling, loop de regels af op volgorde van locatie en scan elk artikel met een scanner of de camera. Groen is goed, rood met trillen is fout. Het aantal staat al ingevuld; bevestig met OK of meld *Niet aanwezig*.', for: ['orderpick'] },
        { text: 'Met *Order gepickt* gaat de bestelling weg met wat er echt gepickt is (de rest blijft op backorder), en maak je meteen de pakbon en, zodra de DPD-koppeling er is, het verzendlabel.', for: ['orderpick'] },
      ],
    },
    {
      version: '1.14.3',
      date: '2026-11-13',
      title: 'Updates installeren vanuit Beheer',
      items: [
        { text: 'Nieuw in Beheer > Systeem > Updates: je ziet welke versie draait en welke klaarstaat, met wat er nieuw is. Met *Nu updaten* (en je wachtwoord ter bevestiging) installeert de server de nieuwe versie meteen. *Automatisch bijwerken* kun je daar ook uitzetten.', for: ['beheer'] },
        { text: 'Tijdens een update staat de site ongeveer een minuut in onderhoudsmodus: bovenin staat een melding, bekijken kan en opslaan even niet. Start de nieuwe versie niet goed, dan gaat de server vanzelf terug naar de vorige versie.' },
      ],
    },
    {
      version: '1.14.2',
      date: '2026-11-13',
      title: 'Nieuwe rol Picker voor het magazijn',
      items: [
        { text: 'Nieuwe rol *Picker* voor medewerkers in het magazijn: die mogen alleen bestellingen picken (de orderpick-app volgt) en zien geen prijzen, adressen of instellingen.', for: ['beheer'] },
        { text: 'Een bestelling die in het magazijn wordt gepickt gaat met de echt gepickte aantallen weg; wat er niet is blijft op backorder staan. De pakbon van die zending toont wat er nu meegaat en wat nog volgt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.14.1',
      date: '2026-11-12',
      title: 'Winkelwagenknop op alle artikelkaarten en verpakking kiezen',
      items: [
        { text: 'In de webshop kun je nu bij elk artikel in het overzicht meteen het aantal invullen en op In winkelwagen drukken.' },
        { text: 'Artikelen met uitvoeringen (zoals maten) staan als gewone kaart in het overzicht, met een keuzelijst voor de uitvoering op de kaart zelf.' },
        { text: 'Op de productpagina kies je de verpakking (per stuk, doos of pallet); prijs en winkelwagen volgen je keuze.' },
      ],
    },
    {
      version: '1.14.0',
      date: '2026-11-12',
      title: 'Backorders en deelleveringen',
      items: [
        { text: 'Webshopbestellingen kunnen nu in delen worden geleverd: per regel zie je besteld, geleverd en backorder, en je verzendt alleen wat er is. Met *Deellevering toestaan* bepaal je per bestelling of een deel alvast mee mag.', for: ['beheer'] },
        { text: 'Nieuw tabblad Backorders bij Webshopbestellingen met de verwachte leverdatum uit je inkooporders en een Excel-export.', for: ['beheer'] },
        { text: 'Komt er voorraad binnen voor een backorder, dan staat de bestelling weer in Te picken met een nieuwe pakbon. De pakbon laat zien wat nu wordt geleverd en wat nog volgt.', for: ['beheer'] },
        { text: 'De klant krijgt bij een deellevering een mail met wat onderweg is en wat nog op backorder staat, met de verwachte datum.' },
      ],
    },
    {
      version: '1.13.3',
      date: '2026-11-12',
      title: 'Uitverkoop-sectie uit de webshop',
      items: [
        { text: 'De uitverkoop-sectie op de webshop is verwijderd. De standaardkolom Uitverkoop is verdwenen van de startpagina.' },
      ],
    },
    {
      version: '1.13.2',
      date: '2026-11-12',
      title: 'Mijn profiel netjes uitgelijnd',
      items: [
        { text: 'Op Mijn profiel staan de kaarten en velden nu netjes onder elkaar op één lijn, op computer en telefoon. Kaarten in een rij zijn even hoog en de knoppen staan onderaan.' },
      ],
    },
    {
      version: '1.13.1',
      date: '2026-11-12',
      title: 'Verzendmethode kiezen bij het afrekenen',
      items: [
        { text: 'Bij het afrekenen in de webshop kies je de verzendmethode in een keuzelijst: bezorging door DPD, per pallet, met eigen transport, of Afhalen in Nunspeet (gratis). Afhalen staat nooit vooraf gekozen. De kosten staan als verzendregel op de bestelling.' },
        { text: 'In Beheer > Instellingen > Verzending zet je per methode aan of uit, geef je hem een eigen naam en stel je de tarieven per land en gewicht in, met gratis vanaf een bedrag. Pallet en eigen transport staan standaard uit.', for: ['beheer'] },
      ],
    },
    {
      version: '1.13.0',
      date: '2026-11-12',
      title: 'Instellingen van uitgezette modules verborgen',
      items: [
        { text: 'Zet je een module uit bij Beheer > Modules aan/uit, dan verdwijnen de bijbehorende instellingen uit Beheer (etiketten bij Artikelen, sproeierbibliotheek bij de planner, Uitbesteden, Seizoensherinneringen). Je bewaarde instellingen blijven staan en komen terug zodra je de module weer aanzet.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.9',
      date: '2026-11-12',
      title: 'Dropshipping met de eigen pakbon van de klant',
      items: [
        { text: 'Klanten van de webshop kunnen een bestelling als dropshipping plaatsen: we bezorgen rechtstreeks bij hun eigen klant. Ze geven een e-mailadres op voor het afleverbewijs en uploaden na het bestellen hun eigen pakbon (PDF) op de pagina van de bestelling.' },
        { text: 'Bij een dropshippingbestelling komt de pakbon van de klant in *Te picken* en *Alles afdrukken* in plaats van onze eigen pakbon (met het bestelnummer erop). Zonder geüploade pakbon staat de bestelling niet in de lijst, maar wel in een melding erboven.', for: ['beheer'] },
        { text: 'De verzendmail met de volgcode gaat bij dropshipping ook naar het e-mailadres voor het afleverbewijs.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.8',
      date: '2026-11-12',
      title: 'Klant zonder KvK-nummer en buitenlandse klant',
      items: [
        { text: 'Een zakelijke klant kan nu zonder KvK-nummer worden aangemaakt, bijvoorbeeld een buitenlands bedrijf.', for: ['klanten'] },
        { text: 'Bij een btw-nummer uit een ander EU-land dat bij VIES geldig is, typ je het adres van de klant zelf in.', for: ['klanten'] },
      ],
    },
    {
      version: '1.12.7',
      date: '2026-11-12',
      title: 'Geen dubbel e-mailadres meer',
      items: [
        { text: 'Een e-mailadres kan maar bij één actief account horen. Ook als je een adres op de klantkaart wijzigt of een uitgeschakeld account weer inschakelt, krijg je een duidelijke melding als een ander account het adres al heeft.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.6',
      date: '2026-11-12',
      title: 'Prijsvoorstellen bij een nieuwe inkoopprijs',
      items: [
        { text: 'Een nieuwe inkoopprijs past de verkoopprijs niet meer vanzelf aan. Bij artikelen met prijs volgens factor komt er een prijsvoorstel (op basis van de ingestelde factor en afronding) onder Inkoop > Prijsfactor. Je keurt het per artikel of voor alles tegelijk goed, of wijst het af. Een afgewezen voorstel komt pas terug als de inkoopprijs verandert. Goedgekeurde prijzen gaan naar de webshop.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.5',
      date: '2026-11-12',
      title: 'Pakbonnen en de lijst Te picken',
      items: [
        { text: 'Nieuw tabblad *Te picken* bij Webshopbestellingen: alle nieuwe bestellingen die klaarstaan, met één knop om alle pakbonnen in één PDF af te drukken.', for: ['beheer'] },
        { text: 'Elke webshopbestelling heeft een pakbon (PDF, zonder prijzen, met het afleveradres en de artikelen op volgorde van magazijnlocatie). Knop *Pakbon* in het detail van de bestelling.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.4',
      date: '2026-11-12',
      title: 'AI-koppeling vraagt terug bij onduidelijkheid',
      items: [
        { text: 'De AI-koppeling raadt niet meer: bij meerdere klanten of artikelen, een onbekende artikelcode, een ontbrekende prijs, maat of klant vraagt de AI het eerst aan jou voordat er een concept-offerte komt.', for: ['offertes'] },
      ],
    },
    {
      version: '1.12.3',
      date: '2026-11-12',
      title: 'Menubalk van de webshop altijd op één regel',
      items: [
        { text: 'De menubalk van de webshop (met Groothandel erbij) blijft op één regel; op smallere schermen worden ruimte en letter iets kleiner.' },
      ],
    },
    {
      version: '1.12.2',
      date: '2026-11-12',
      title: 'Offerte omzetten naar een bestelling',
      items: [
        { text: 'Een geaccordeerde offerte zet u met één knop om in een bestelling: *Omzetten naar bestelling*. De regels, de korting, btw verlegd, de betaaltermijn, de documenttaal, de klant en het afleveradres van de offerte gaan mee. De offerte staat daarna als *Omgezet* in de lijst, met een link naar de bestelling (en andersom), en ligt vast.', for: ['beheer'] },
        { text: 'De factuur van zo\'n bestelling houdt de betaaltermijn en de taal van de offerte aan.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.1',
      date: '2026-11-12',
      title: 'Prijsfactor op de inkoopprijs',
      items: [
        { text: 'Nieuw tabblad Prijsfactor onder Inkoop: de verkoopprijs wordt de inkoopprijs maal een factor. Je stelt een standaardfactor in, en eventueel een eigen factor per categorie, per leverancier of per artikel. Het artikel zelf gaat voor de leverancier, de leverancier voor de categorie en de categorie voor de standaard.', for: ['voorraad'] },
        { text: 'Bij een artikel kies je Prijsbepaling: een vaste verkoopprijs (zoals altijd) of inkoopprijs maal factor. De marge staat nu in de artikellijst en in het artikelformulier.', for: ['voorraad'] },
        { text: 'Prijzen afronden op de cent, 5 of 10 cent, 50 cent, hele euro\'s of eindigend op ,95 of ,99 (naar het dichtstbijzijnde of naar boven). Een voorbeeld toont per artikel de huidige en nieuwe prijs en de marge; pas na Doorvoeren veranderen de prijzen en gaan ze naar de webshop. Het voorbeeld kun je naar Excel exporteren.', for: ['beheer'] },
      ],
    },
    {
      version: '1.12.0',
      date: '2026-11-12',
      title: 'Afwijkend afleveradres bij bestellingen en offertes',
      items: [
        { text: 'Bij afrekenen in de webshop staat nu "Afleveradres gelijk aan factuuradres" standaard aan. Haal het vinkje weg om een ander afleveradres op te geven; de factuur gaat dan naar het factuuradres en het pakket naar het afleveradres.' },
        { text: 'In een offerte kun je een afwijkend afleveradres invullen. Het staat op het offertedocument.', for: ['offertes'] },
      ],
    },
    {
      version: '1.11.9',
      date: '2026-11-12',
      title: 'Kortingen per productcategorie voor zakelijke klanten',
      items: [
        { text: 'Onder Beheer > Webshop > Zakelijke kortingen geef je zakelijke klanten een korting op een hele productcategorie. De prijzen in de webshop, de winkelwagen, de bestelling en de factuur volgen. Een artikel met een eigen zakelijke prijs houdt die prijs; bij groothandelsklanten telt de hoogste korting.', for: ['beheer'] },
      ],
    },
    {
      version: '1.11.8',
      date: '2026-11-12',
      title: 'Versie en releasenotes worden automatisch bijgewerkt',
      items: [],
    },
    {
      version: '1.11.7',
      date: '2026-11-12',
      title: 'Webshop-inhoud laadt weer',
      items: [
        { text: 'Beheer → Webshop → Webshop-inhoud gaf een foutmelding bij het laden. Dat is opgelost: ontbrekende blokken van de startpagina worden aangevuld met de standaard.', for: ['beheer'] },
      ],
    },
    {
      version: '1.11.6',
      date: '2026-11-12',
      title: 'Inkoop in de zijbalk',
      items: [
        { text: 'In de zijbalk staat nu een eigen kopje Inkoop met Bestelvoorstel, Inkooporders, Leveranciers en Mutaties. Het Bestelvoorstel is een scherm geworden waarop je ziet wat er besteld moet worden, met een knop voor concept-orders en voor Excel.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.11.5',
      date: '2026-11-12',
      title: 'Dozen en pallets in de winkelwagen',
      items: [
        { text: 'Artikelen met een verpakking (doos, pallet) kunnen als verpakking in de winkelwagen en bestelling staan, met eigen prijs. De voorraad wordt in stuks afgeboekt.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.11.4',
      date: '2026-11-12',
      title: 'Leveranciersdocument inlezen',
      items: [
        { text: 'In Inkooporders kun je een PDF of foto van een offerte, orderbevestiging, pakbon of factuur laten inlezen. De regels worden aan je artikelen gekoppeld; jij controleert alles en bewaart het als concept, of boekt het meteen in de voorraad. De artikelnummers van de leverancier worden onthouden, zodat de volgende keer meer regels vanzelf goed staan.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.11.3',
      date: '2026-11-12',
      title: 'AI-koppeling op de juiste plek in Beheer',
      items: [
        { text: 'De instelling AI-koppeling (Claude en ChatGPT) stond per ongeluk onder Artikelen: etiketten. Je vindt hem nu onder Beheer → Koppelingen → AI-koppeling (MCP).', for: ['beheer'] },
      ],
    },
    {
      version: '1.11.2',
      date: '2026-11-12',
      title: 'Verpakkingen per artikel',
      items: [
        { text: 'Bij een artikel kun je nu verpakkingen instellen, bijvoorbeeld een doos of een pallet van 144 stuks, met een eigen prijs, een eigen EAN en de klantgroep die ze ziet. De voorraad blijft in stuks staan. In de winkel verschijnen ze in de volgende versie.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.11.1',
      date: '2026-11-12',
      title: 'Etiketten met streepjescode',
      items: [
        { text: 'Bij een artikel kun je nu de EAN (de streepjescode van de fabrikant) invullen en etiketten afdrukken: open het artikel, kies bij Etiketten het sjabloon en het aantal en druk de PDF af op je labelprinter (bijvoorbeeld Zebra). Zonder EAN krijgt het etiket de artikelcode als streepjescode.', for: ['voorraad'] },
        { text: 'De etiketformaten en wat erop staat (omschrijving, artikelcode, prijs) stel je in bij Beheer → Instellingen → Artikelen: etiketten.', for: ['beheer'] },
      ],
    },
    {
      version: '1.11.0',
      date: '2026-11-12',
      title: 'Inkooporders',
      items: [
        { text: 'In Artikelen staat nu een tabblad Inkooporders. Je maakt een bestelling bij een leverancier (ook met één klik uit het bestelvoorstel), zet hem op besteld en boekt de ontvangst per regel: de voorraad en de inkoopprijs worden meteen bijgewerkt. Wat nog onderweg is telt mee in het bestelvoorstel, zodat je niets dubbel bestelt.', for: ['voorraad'] },
        { text: 'Per order is er een Excel voor de leverancier, en de lijst heeft een Excel met een overzicht per leverancier.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.10.9',
      date: '2026-11-12',
      title: 'Bestelvoorstel per leverancier',
      items: [
        { text: 'Het bestelvoorstel in Artikelen rekent nu met je voorkeursleverancier: de hoeveelheid wordt afgerond op de bestelhoeveelheid (bijvoorbeeld hele dozen), de inkoopprijs van de leverancier wordt gebruikt en de Excel is gegroepeerd per leverancier, met een tabblad met het totaal per leverancier.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.10.8',
      date: '2026-11-12',
      title: 'Leveranciers bij artikelen',
      items: [
        { text: 'In Artikelen staat nu een tabblad Leveranciers. Per artikel kun je zetten wie het levert, met het artikelnummer van de leverancier, een eigen inkoopprijs, de bestelhoeveelheid (bijvoorbeeld per doos van 25) en je voorkeursleverancier.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.10.7',
      date: '2026-11-12',
      title: 'Vragen stellen aan AquaTech via Claude of ChatGPT',
      items: [
        { text: 'Via de AI-koppeling kun je nu ook vragen stellen: de klantkaart met betaaltermijn en openstaand bedrag, wat een klant betaalt voor een artikel, de status van een offerte, werkorder, factuur of bestelling op nummer en wie er nog moet betalen. De AI ziet alleen wat jouw rol mag zien. Had je al gekoppeld? Koppel dan opnieuw om deze vragen toe te staan.', for: ['offertes'] },
      ],
    },
    {
      version: '1.10.6',
      date: '2026-11-12',
      title: 'Korting als bedrag, met bijschrift',
      items: [
        { text: 'Bij een offerte en een factuur kun je de korting nu als vast bedrag (excl. btw) geven in plaats van een percentage, en er een bijschrift bij zetten (bijvoorbeeld "seizoensactie"). Het bijschrift staat naast de korting op het document.', for: ['offertes', 'facturen'] },
      ],
    },
    {
      version: '1.10.5',
      date: '2026-11-11',
      title: 'Duidelijker controleren van AI-regels',
      items: [
        { text: 'Bij een regel waar de AI over twijfelt klik je op "Markeer als gecontroleerd". De regel krijgt dan een groene status Gecontroleerd en de notitie blijft voor jou zichtbaar; met Ongedaan maken zet je hem terug. De klant ziet dit nooit.', for: ['offertes'] },
      ],
    },
    {
      version: '1.10.4',
      date: '2026-11-11',
      title: 'Interne notitie bij een offerte',
      items: [
        { text: 'Onderaan een offerte staat nu een interne notitie voor jezelf en collega\'s. De klant ziet hem nooit: niet in de offerte, de pdf, de mail of het portaal.', for: ['offertes'] },
        { text: 'Maak je een werkorder uit de offerte, dan staat de notitie ook in de werkorder (en kun je hem daar aanpassen).', for: ['werkorders'] },
      ],
    },
    {
      version: '1.10.3',
      date: '2026-11-11',
      title: 'Handleiding voor de AI-koppeling',
      items: [
        { text: 'Bij de AI-koppeling (Beheer > Instellingen en Mijn profiel) staat nu een stap-voor-stap handleiding voor Claude en ChatGPT, met een knop om het adres te kopiëren.', for: ['offertes', 'beheer'] },
      ],
    },
    {
      version: '1.10.2',
      date: '2026-11-11',
      title: 'Offertes en facturen in het Engels',
      items: [
        { text: 'Bij een klant kies je de documenttaal (Nederlands of Engels). De offerte, het akkoordformulier, de factuur-PDF en de bijbehorende mails staan dan in die taal.', for: ['klanten', 'offertes', 'facturen'] },
        { text: 'In de offerte kun je de taal per offerte aanpassen.', for: ['offertes'] },
      ],
    },
    {
      version: '1.10.1',
      date: '2026-11-11',
      title: 'Offerte maken met Claude of ChatGPT',
      items: [
        { text: 'Koppel AquaTech aan Claude of ChatGPT (ook in de app op je telefoon): spreek een gesprek in en de AI zoekt de klant en de artikelen en zet een concept-offerte klaar. Jij controleert en verstuurt hem zelf.', for: ['offertes'] },
        { text: 'Regels waar de AI over twijfelt krijgen een gele notitie in de offerte; klik op Gecontroleerd als het klopt. De klant ziet die notities nooit.', for: ['offertes'] },
        { text: 'Beheer zet de AI-koppeling per omgeving aan onder Instellingen. In Mijn profiel zie je welke apps gekoppeld zijn en trek je een koppeling in.', for: ['beheer', 'offertes'] },
      ],
    },
    {
      version: '1.10.0',
      date: '2026-11-11',
      title: 'Betaaltermijn per klant',
      items: [
        { text: 'Bij een klant stel je een eigen betaaltermijn in (in dagen). Zonder eigen termijn geldt de standaard uit de factuurinstellingen.', for: ['klanten'] },
        { text: 'De betaaltermijn staat op de offerte, wordt vastgelegd bij het akkoord en bepaalt de vervaldatum van de factuur.', for: ['offertes', 'facturen'] },
      ],
    },
    {
      version: '1.9.9',
      date: '2026-11-11',
      title: 'Nieuwe klant en btw verleggen in de offerte',
      items: [
        { text: 'In de offerte maak je met één knop een nieuwe klant aan (particulier of zakelijk) en kies je hem meteen.', for: ['offertes', 'klanten'] },
        { text: 'Btw verleggen voor een zakelijke klant in een ander EU-land: vul het btw-nummer in, het wordt bij VIES gecontroleerd en de offerte en factuur gaan zonder btw.', for: ['offertes'] },
      ],
    },
    {
      version: '1.9.8',
      date: '2026-11-11',
      title: 'Klant kiezen in de offerte',
      items: [
        { text: 'Offerte maken gaat sneller: kies bovenaan een klant uit de klantenlijst en naam, adres, e-mail en telefoon worden meteen ingevuld.', for: ['offertes'] },
        { text: 'Het formulier voor een nieuwe klant is overzichtelijker: het adres staat als gewone tekst, en bedrijfsgegevens zie je alleen bij een zakelijke klant.', for: ['klanten'] },
      ],
    },
    {
      version: '1.9.7',
      date: '2026-11-11',
      title: 'Klanten op één plek',
      items: [
        { text: 'Nieuwe pagina Klanten (onder Verkoop): zoeken op naam, bedrijf, e-mail, telefoon of adres, filteren op particulier, zakelijk of groothandel, en exporteren naar Excel.', for: ['klanten'] },
        { text: 'Een klant aanmaken kan nu zonder inlog, met het adres via postcode en huisnummer. Wil je dat de klant zelf kan inloggen, vink dan de uitnodiging aan: de klant krijgt een mail om een wachtwoord te kiezen.', for: ['klanten'] },
        { text: 'De klantkaart toont de gegevens, de offertes, werkorders en facturen van de klant. Klantgroep, groothandelskorting en het goedkeuren van een zakelijke aanvraag staan daar nu, niet meer in de gebruikerslijst.', for: ['klanten'] },
        { text: 'Gebruiker toevoegen in Beheer is opgeruimd: vier velden op een rij en de uitleg per rol ingeklapt. De gebruikerslijst is korter geworden.', for: ['beheer'] },
      ],
    },
    {
      version: '1.9.6',
      date: '2026-11-11',
      title: 'Kleine verbeteringen',
      items: [
        { text: 'Verbinding met Visma verbreken is nu betrouwbaarder: tijdens het verbreken wordt er niets meer doorgestuurd. Pauzeren werkt ook als je het precies tijdens het doorsturen doet.', for: ['facturen'] },
        { text: 'Een account uit een testomgeving kan de kleuren van de live-omgeving niet meer wijzigen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.9.5',
      date: '2026-11-11',
      title: 'Visma-koppeling zelf bedienen',
      items: [
        { text: 'Bij Facturen > Visma kun je de koppeling nu pauzeren en hervatten, en facturen, creditfacturen en het aanmaken van klanten los aan of uit zetten. Elke wijziging staat in het logboek.', for: ['facturen'] },
        { text: 'Verbinding verbreken trekt de toegang nu ook bij Visma in. Lukt dat niet, dan zie je dat en kun je het zelf bij Visma doen.', for: ['facturen'] },
      ],
    },
    {
      version: '1.9.4',
      date: '2026-11-11',
      title: 'Visma-koppeling inzichtelijk',
      items: [
        { text: 'Bij Facturen > Visma staat nu in gewone taal welke toestemmingen Visma gaf, wat er heen en weer gaat en wat de koppeling niet doet.', for: ['facturen'] },
        { text: 'Nieuw logboek bij Visma: wat er wanneer naar Visma is gestuurd of ervan gelezen, ook de fouten. Een fout die steeds terugkomt staat één keer, met een teller.', for: ['facturen'] },
      ],
    },
    {
      version: '1.9.3',
      date: '2026-11-11',
      title: 'Kleuren en Visma per organisatie',
      items: [
        { text: 'De kleuren van de app stel je nu in via Beheer > Kleuren, voor je eigen organisatie. Hoofdbeheer bevat alleen nog wat voor het hele platform geldt.', for: ['beheer'] },
        { text: 'Elke organisatie vult de app-gegevens van Visma nu zelf in, onder Facturen > Visma, en heeft dus een eigen koppeling.', for: ['facturen'] },
      ],
    },
    {
      version: '1.9.2',
      date: '2026-11-11',
      title: 'Snel van de webshop naar het beheer',
      items: [
        { text: 'Ben je als medewerker of beheerder ingelogd in de webshop? Dan staat er in de kop een knop Beheer die je meteen naar de app brengt.', for: ['werkorders', 'beheer'] },
      ],
    },
    {
      version: '1.9.1',
      date: '2026-11-11',
      title: 'Kleine verbetering in foutmeldingen bij instellingen',
      items: [],
    },
    {
      version: '1.9.0',
      date: '2026-11-11',
      title: 'Duidelijkere meldingen bij betalen en facturen in de webshop',
      items: [
        { text: 'Lukt terugbetalen via Mollie of het maken van een factuur bij een webshopbestelling niet, dan zie je nu of Mollie even niet bereikbaar is of dat het in de app misging, zonder technische tekst.', for: ['facturen', 'beheer'] },
      ],
    },
    {
      version: '1.8.9',
      date: '2026-11-11',
      title: 'Begrijpelijke meldingen als iets niet lukt',
      items: [
        { text: 'Lukt een actie niet, dan zie je nu wat er aan de hand is (bijvoorbeeld geen verbinding, geen rechten of niet meer ingelogd) in plaats van een technische code zoals "HTTP 500".' },
      ],
    },
    {
      version: '1.8.8',
      date: '2026-11-11',
      title: 'Kleine verbeteringen in de meldingen bij e-mail',
      items: [
        { text: 'Bij een mislukte e-mail staat nu duidelijker of het aan de mailserver ligt of aan de app.', for: ['offertes', 'werkorders', 'facturen'] },
      ],
    },
    {
      version: '1.8.7',
      date: '2026-11-11',
      title: 'Duidelijkere meldingen als een e-mail niet verstuurd kan worden',
      items: [
        { text: 'Lukt het versturen van een offerte, afspraak of factuur niet, dan zie je nu waar het aan ligt, bijvoorbeeld een verkeerd wachtwoord van de mailserver of een poort die niet klopt, met wat je kunt controleren.', for: ['offertes', 'werkorders', 'facturen'] },
      ],
    },
    {
      version: '1.8.6',
      date: '2026-11-11',
      title: 'Duidelijkere meldingen bij de webshopkoppeling',
      items: [
        { text: 'Weigert de webshop een artikel (bijvoorbeeld omdat de artikelcode daar al bestaat), dan zie je nu de reden die de webshop geeft in plaats van alleen een statuscode.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.8.5',
      date: '2026-11-11',
      title: 'Duidelijkere foutmeldingen en een debugmodus',
      items: [
        { text: 'Gaat er onverwacht iets mis, dan krijg je een melding met een foutcode. Geef die code door aan de beheerder: daarmee is de fout terug te vinden.' },
        { text: 'Nieuw in Beheer > Instellingen > Foutopsporing: de debugmodus. Staat die aan, dan zie je als beheerder bij een fout een paneel met de details (wat er misging en waar), dat je met één klik kunt kopiëren. Klanten en medewerkers zien die details nooit.', for: ['beheer'] },
      ],
    },
    {
      version: '1.8.4',
      date: '2026-11-11',
      title: 'Controle van wijzigingen door CodeRabbit',
      items: [],
    },
    {
      version: '1.8.2',
      date: '2026-11-11',
      title: 'Controle van wijzigingen door Claude',
      items: [],
    },
    {
      version: '1.8.0',
      date: '2026-11-11',
      title: 'Multitenancy uit te zetten',
      items: [
        { text: 'Werk je met één organisatie, dan staat multitenancy nu standaard uit: geen organisatiecode bij het inloggen en geen tenantbeheer. Testomgevingen blijven gewoon werken. Een hoofdbeheerder zet het weer aan via Hoofdbeheer > Multitenancy.', for: ['hoofdbeheer'] },
      ],
    },
    {
      version: '1.7.9',
      date: '2026-11-10',
      title: 'Testomgeving verwijderen werkt weer',
      items: [
        { text: 'Een testomgeving of tenant verwijderen of leegmaken lukt weer. Gaat het toch mis, dan staat in de melding wat de oorzaak is en is er niets gewist.', for: ['beheer'] },
      ],
    },
    {
      version: '1.7.8',
      date: '2026-11-10',
      title: 'Overzichtelijker zijbalk',
      items: [
        { text: 'De zijbalk is opnieuw ingedeeld: Verkoop, Artikelen, Planner & werk en Beheer zijn nette, inklapbare groepen met compactere regels. Alleen de groep waarin je zit staat open en de actieve pagina is duidelijk gemarkeerd.', for: ['beheer'] },
        { text: 'Het menu binnen Beheer is ook inklapbaar en compacter; de webshopinstellingen staan nu bij elkaar in een eigen groep.', for: ['beheer'] },
        { text: 'Onderaan de zijbalk staan nu de webshop, Hoofdbeheer en je profiel bij elkaar.', for: ['beheer'] },
      ],
    },
    {
      version: '1.7.7',
      date: '2026-11-10',
      title: 'Sneller bij drukte',
      items: [
        { text: 'De app en de webshop wachten minder op elkaar: het controleren van je sessie en het laden van de webshopcatalogus gaan nu via meerdere databaseverbindingen tegelijk, zodat andere verzoeken intussen doorlopen.' },
      ],
    },
    {
      version: '1.7.6',
      date: '2026-11-10',
      title: 'Herstelcode makkelijker invoeren',
      items: [
        { text: 'Inloggen met een herstelcode op je telefoon: het codeveld toont nu een gewoon toetsenbord, zodat je ook letters en het streepje kunt typen.' },
      ],
    },
    {
      version: '1.7.5',
      date: '2026-11-10',
      title: 'Tweestapsverificatie, productomschrijvingen en slimmer reserveren',
      items: [
        { text: 'Productpagina’s in de webshop tonen nu een omschrijving en een tabel met specificaties. Zolang je bij een artikel niets invult, komt de tekst uit de oude webshop.' },
        { text: 'Artikelen: nieuwe velden Omschrijving en Specificaties voor de webshop, met een knop om de tekst uit de oude webshop over te nemen en aan te passen.', for: ['voorraad'] },
        { text: 'Een bestelling op rekening houdt de voorraad nu een vast aantal dagen vast (standaard 14, in te stellen bij Beheer > Webshop > Betalen). Daarna komt de voorraad weer vrij in de shop; de bestelling blijft staan en kan nog verzonden worden.', for: ['beheer'] },
        { text: 'Je kunt je account nu extra beveiligen met tweestapsverificatie: zet het aan bij Mijn profiel en scan de QR-code met een authenticator-app. Bij het inloggen vraagt de app dan ook om de code van je telefoon. Bewaar de herstelcodes voor als je je telefoon kwijt bent.' },
        { text: 'Beheer > Gebruikers: is een collega de telefoon kwijt, dan kun je diens tweestapsverificatie uitzetten met de knop 2FA uitzetten.', for: ['beheer'] },
        { text: 'Inloggen: na drie verkeerde wachtwoorden wacht elke volgende poging iets langer. Na een tikfout merk je er niets van; raden wordt zo erg traag.' },
      ],
    },
    {
      version: '1.7.4',
      date: '2026-11-10',
      title: 'Veiliger en slimmer: webshop, inloggen en testomgeving',
      items: [
        { text: 'Wachtwoord vergeten in de webshop? Vraag een nieuw wachtwoord aan via de link bij Inloggen; je krijgt een mail met een link die één uur en één keer werkt. Bij een nieuw account bevestig je je e-mailadres via een mail.', for: ['portaal'] },
        { text: 'Staat je adres niet in de lijst, bijvoorbeeld bij nieuwbouw? Bij afrekenen kun je straat en woonplaats nu zelf invullen. De bevestiging van je bestelling gaat altijd naar het e-mailadres van je account.', for: ['portaal'] },
        { text: 'Alles in winkelwagen vanuit de planner kijkt nu naar de eenheid: verkopen we een artikel per rol, dan rekent de winkel de meters om naar rollen (als bij het artikel de inhoud per eenheid is ingevuld), anders zie je welk artikel je zelf moet kiezen.' },
        { text: 'Artikelen: nieuw veld Inhoud per eenheid, bijvoorbeeld 50 voor een rol van 50 meter. De planner gebruikt dat om meters om te rekenen naar rollen.', for: ['voorraad'] },
        { text: 'Retouren: stuurt een particuliere klant alles terug, dan gaan de verzendkosten mee in de creditnota. Online betaalde bestellingen betaal je terug met één knop (Terugbetalen via Mollie) bij de retour of bij een geannuleerde bestelling, en terugboekingen door de bank zie je bij de bestelling.', for: ['beheer'] },
        { text: 'Btw verleggen voor zakelijke klanten in de EU gebeurt alleen nog met het goedgekeurde btw-nummer en na een controle bij VIES (de btw-database van de EU). De uitkomst staat bij de bestelling als bewijs.', for: ['beheer'] },
        { text: 'Een nieuwe testomgeving neemt de koppelingen met de webshop, betalen, mail en de boekhouding niet meer over, en ook geen sleutels of wachtwoorden. Testen kan zo nooit de echte webshop, boekhouding of klanten raken.', for: ['beheer'] },
        { text: 'Inloggen: iemand die het wachtwoord van een ander probeert te raden, blokkeert alleen zichzelf en niet meer de echte gebruiker. De toegangscode moet minstens 12 tekens zijn.', for: ['beheer'] },
        { text: 'Tekening indienen zonder account staat standaard uit (aanzetten in Beheer > Instellingen). Links naar offertes en afspraken verlopen na een tijd, en onbehandelde ingediende tekeningen worden na 60 dagen gewist.', for: ['beheer'] },
        { text: 'Een artikel dat in een open webshopbestelling zit kan niet meer worden verwijderd of gearchiveerd, zodat de bestelling gewoon verzonden kan worden.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.7.3',
      date: '2026-11-08',
      title: 'Van de planner naar de webshop',
      items: [
        { text: 'In de planner staat nu een knop Webshop bovenin, zodat je met één klik terug bent in de winkel.' },
        { text: 'Bij de stuklijst staat de knop Alles in winkelwagen: al het materiaal uit je plan staat dan meteen in je winkelwagen, met de prijzen en de voorraad van dat moment. Nogmaals klikken zet niets dubbel.' },
      ],
    },
    {
      version: '1.7.2',
      date: '2026-11-07',
      title: 'Webshop beter te vinden',
      items: [
        { text: 'De webshop is nu klaargezet voor Google, Bing en AI-zoekers zoals ChatGPT en Perplexity: producten, prijzen en voorraad staan in een vorm die zij goed kunnen lezen.' },
        { text: 'Er is een sitemap, een samenvatting voor AI (llms.txt) en een productfeed voor Google Merchant Center. Vul bij Beheer > Betalen het webadres van de webshop in, dan gebruiken ze het juiste adres.', for: ['beheer'] },
        { text: 'Zet een pagina met de naam "veelgestelde-vragen" in Beheer > Webshop-inhoud: elke kop is een vraag, de tekst eronder het antwoord. Zoekmachines tonen die dan als vraag en antwoord.', for: ['beheer'] },
      ],
    },
    {
      version: '1.7.1',
      date: '2026-11-07',
      title: 'De webshop is de startpagina',
      items: [
        { text: 'De webshop staat nu op de hoofdpagina (aquatech.den-hollander.com). De app, met planner, offertes, werkorders en Beheer, staat onder /app/. Oude adressen worden doorgestuurd.' },
        { text: 'Staat de webshop uit (Beheer > Instellingen > Toegang), dan stuurt de hoofdpagina door naar /app/. Gebruik voor links in offertes en seizoensherinneringen het adres met /app/.', for: ['beheer'] },
      ],
    },
    {
      version: '1.7.0',
      date: '2026-11-06',
      title: 'Menu van de webshop zelf aanpassen',
      items: [
        { text: 'Submenu\'s in de webshop klappen nu naar rechts open; alleen als er rechts geen ruimte meer is gaan ze naar links.' },
        { text: 'In Beheer > Webshop-inhoud staat een tabblad Menu: je hernoemt, verplaatst, voegt toe of verbergt categorieën en subcategorieën, met uitleg en afbeelding per categorie. Pas na Publiceren staat het live; met Voorbeeld bekijken zie je het eerst.', for: ['beheer'] },
      ],
    },
    {
      version: '1.6.9',
      date: '2026-11-06',
      title: 'Overzichtelijker menu en categoriepagina\'s in de webshop',
      items: [
        { text: 'Het menu van de webshop heeft nu submenu\'s per niveau: je klapt een hoofdcategorie open en kiest direct de juiste subcategorie, zonder tussenpagina.' },
        { text: 'Categoriepagina\'s lijken nu op die van aquatechshop.nl: met zijbalk, prijsfilter, uitleg, blokken met subcategorieën, sorteren en meerdere pagina\'s.' },
      ],
    },
    {
      version: '1.6.8',
      date: '2026-11-06',
      title: 'Nieuwe startpagina voor de webshop',
      items: [
        { text: 'De startpagina van de webshop lijkt nu op die van aquatechshop.nl: met meest verkochte producten, twee bannerblokken, kolommen met producten en een formulier voor een zakelijk account.' },
        { for: ['beheer'], text: 'Bij Webshop-inhoud pas je de banners, de kolommen met producten, het citaat en het zakelijke formulier zelf aan. Aanvragen voor een zakelijk account komen per mail binnen.' },
      ],
    },
    {
      version: '1.6.7',
      date: '2026-11-06',
      title: 'Voorraad in de webshop klopt weer',
      items: [
        { text: 'Producten die in de oude webshop op voorraad staan maar waar geen aantal van wordt bijgehouden, staan nu ook in de nieuwe webshop op voorraad.' },
        { for: ['voorraad'], text: 'Zodra je voor zo\'n artikel voorraad ontvangt of telt, houdt Aquatech de voorraad bij en telt het aantal.' },
      ],
    },
    {
      version: '1.6.6',
      date: '2026-11-05',
      title: 'Sneller winkelen en artikelen openen',
      items: [
        { text: 'De winkelwagen en het afrekenen in de webshop rekenen de beschikbare voorraad sneller uit.' },
        { for: ['voorraad'], text: 'Een artikel met maten of kleuren opent sneller.' },
      ],
    },
    {
      version: '1.6.5',
      date: '2026-11-05',
      title: 'Veiliger en sneller',
      items: [
        { text: 'Foto\'s en afbeeldingen die je uploadt worden nu altijd ontdaan van verborgen gegevens zoals de locatie, ook bij PNG- en WebP-bestanden.' },
        { for: ['voorraad'], text: 'Productfoto\'s in de webshop laden sneller, vooral als veel bezoekers dezelfde categorie bekijken.' },
      ],
    },
    {
      version: '1.6.4',
      date: '2026-11-05',
      title: 'Duidelijker bij het overnemen van afbeeldingen',
      items: [
        { for: ['voorraad'], text: 'Bij het overnemen van afbeeldingen uit de webshop zie je nu hoeveel afbeeldingen er echt zijn bewaard. Dezelfde foto staat maar één keer opgeslagen, ook als veel artikelen hem gebruiken.' },
      ],
    },
    {
      version: '1.6.3',
      date: '2026-11-05',
      title: 'Kleine correctie in de inkoopprijs bij retouren',
      items: [],
    },
    {
      version: '1.6.2',
      date: '2026-11-05',
      title: 'Inkoopprijzen en een margerapportage voor de webshop',
      items: [
        { text: 'Bij elk artikel staat nu het blok Inkoopprijs en voorraadlagen. Een nieuwe inkoopprijs voeg je toe met een datum; de oude prijs blijft bewaard, zodat je ziet hoe de prijs zich ontwikkelt. Bij een ontvangst kun je de inkoopprijs van die levering meteen invullen.', for: ['voorraad'] },
        { text: 'De voorraad werkt volgens FIFO: elke levering is een eigen partij met zijn eigen inkoopprijs en bij verkoop of verbruik gaat de oudste partij eerst. Stijgt de inkoopprijs, dan houden eerdere verkopen de prijs waarvoor ze echt zijn ingekocht. Is de inkoopprijs van een partij onbekend, dan staat dat er zo bij en kun je hem achteraf invullen.', for: ['voorraad'] },
        { text: 'Nieuw tabblad Rapportage bij Webshopbestellingen: omzet, inkoopwaarde, brutowinst en marge over een periode naar keuze, met een grafiek over de tijd, de artikelen en categorieën met de meeste winst, de voorraadwaarde en een export naar Excel.', for: ['beheer'] },
      ],
    },
    {
      version: '1.6.1',
      date: '2026-11-04',
      title: 'Groothandelsvenster voor bestellen in bulk',
      items: [
        { text: 'Bestel je in bulk? Als groothandelsklant heb je in de webshop een eigen venster Groothandel. Daar staan alle artikelen en varianten in één lijst met een aantalvak per regel: zoek of filter op categorie, vul de aantallen in en klik één keer op Alles in winkelwagen. Je ziet je groothandelsprijzen excl. btw, met de staffelprijzen eronder.' },
        { text: 'Bestellen op artikelcode: plak een lijst met per regel een artikelcode en een aantal (bijvoorbeeld uit Excel) en alles staat in één keer in je winkelwagen. Met Opnieuw bestellen zet je een eerdere bestelling met één klik terug in de wagen.' },
        { text: 'Sommige artikelen hebben een verpakkingseenheid of minimale afname (bijvoorbeeld alleen per 25). Een aantal dat daar niet bij past, ronden we voor je naar boven af en we melden dat erbij. In de winkelwagen kun je nu ook meer dan 99 stuks van een artikel kiezen.' },
        { text: 'In Beheer > Gebruikers kun je bij een zakelijke klant Groothandel aanvinken en eventueel een vaste korting instellen; bij een staffelkorting geldt steeds de hoogste van de twee. Bij een artikel (Artikelen) stel je de verpakkingseenheid, de minimale afname en de staffelkorting in, bijvoorbeeld 50:10, 100:15 voor 10% vanaf 50 stuks en 15% vanaf 100 stuks.', for: ['beheer', 'voorraad'] },
      ],
    },
    {
      version: '1.6.0',
      date: '2026-11-04',
      title: 'Zakelijke klanten zien prijzen excl. btw',
      items: [
        { text: 'Bestel je zakelijk bij de webshop? Vink bij het registreren Zakelijke klant aan en vul je bedrijfsnaam en KvK-nummer in (het btw-nummer mag ook). Heb je al een account, dan vraag je het aan op Mijn account. Zodra AquaTech Service je aanvraag goedkeurt, zie je in de hele shop de prijzen exclusief btw, met eronder in het klein wat het incl. btw is. Winkelwagen, afrekenen en factuur rekenen de btw gewoon bij, behalve bij een levering met DPD naar een ander EU-land met een geldig btw-nummer: dan wordt de btw verlegd (0% over artikelen en verzending).' },
        { text: 'Bij Afrekenen staan je bedrijfsnaam en btw-nummer al ingevuld.' },
        { text: 'In Beheer > Gebruikers staat bij een klant nu een keuze Particulier of Zakelijk, de knop Bedrijfsgegevens (bedrijfsnaam, KvK- en btw-nummer) en bij een openstaande aanvraag de knoppen Goedkeuren en Afwijzen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.5.9',
      date: '2026-11-04',
      title: 'Samenvoegen van artikelen terugdraaien',
      items: [
        { text: 'Heb je artikelen samengevoegd tot een variabel artikel en wil je dat terug? Open het hoofdartikel en kies onder Varianten Samenvoeging ongedaan maken. Na een bevestiging worden de varianten weer losse artikelen met hun eigen code, prijzen, voorraad (ook wat er sinds het samenvoegen is binnengekomen of verbruikt) en afbeelding, en verdwijnt het hoofdartikel.', for: ['voorraad'] },
        { text: 'Heeft een artikel vóór het samenvoegen een eigen webshopkoppeling gehad, dan komt die terug. Bij samenvoegingen die al zijn gedaan voordat deze functie er was, worden de varianten wel losgemaakt, maar komen de oude webshopkoppelingen niet terug. Is het hoofdartikel inmiddels in de webshop gezet, dan haal je dat product daar eerst weg.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.5.8',
      date: '2026-11-04',
      title: 'Artikelen samenvoegen tot een variabel artikel',
      items: [
        { text: 'Onder Artikelen staat een nieuwe knop Samenvoegen tot variabel artikel. Losse artikelen die eigenlijk maten of kleuren van één product zijn (bijvoorbeeld PE-buis 16, 20 en 25 mm) maak je zo tot één variabel artikel met varianten. Het systeem stelt zelf groepen voor; je kunt ook zelf artikelen aanvinken.', for: ['voorraad'] },
        { text: 'Voor het samenvoegen controleer je eerst code, omschrijving en de maat per artikel. Voorraad, prijzen, afbeelding en alle verwijzingen in werkorders, offertes en facturen blijven gewoon bestaan. Is een artikel apart aan een webshopproduct gekoppeld, dan zet je daarna het hoofdartikel in de webshop als één variabel product.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.5.7',
      date: '2026-11-04',
      title: 'Afbeeldingen bij artikelen',
      items: [
        { text: 'Je kunt nu een afbeelding uploaden bij een artikel, zowel bij een nieuw artikel als bij een bestaand artikel. Grote foto\'s worden automatisch verkleind. De afbeelding staat in de webshop bij het product.', for: ['voorraad'] },
        { text: 'Onder Artikelen staat een knop Afbeeldingen uit webshop: die neemt de afbeeldingen die nu nog van de oude webshop komen over in dit systeem. Het kan zo vaak als je wilt; alleen wat nog ontbreekt wordt opgehaald.', for: ['voorraad'] },
        { text: 'Nieuw tabblad Afbeeldingen bij Artikelen: de mediabibliotheek met alle productafbeeldingen, bij welke artikelen ze horen en welke artikelen nog geen afbeelding hebben. Klik op een afbeelding om het artikel te openen.', for: ['voorraad'] },
        { text: 'In het formulier Nieuw voorraadartikel staan de knoppen Toevoegen en Annuleren nu ruimer onder de velden.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.5.6',
      date: '2026-11-02',
      title: 'Adres alleen via postcode en huisnummer',
      items: [
        { text: 'Het adres is niet meer met de hand te typen: vul alleen postcode, huisnummer en eventueel een toevoeging in, dan staan straat en woonplaats er automatisch. Zo klopt elk adres, ook bij offertes, werkorders, facturen, meldingen en het afrekenen in de webshop. Bestaande adressen blijven zichtbaar. Vindt het systeem geen adres, dan staat er een melding en kun je pas verder als de postcode en het huisnummer kloppen.' },
      ],
    },
    {
      version: '1.5.5',
      date: '2026-11-02',
      title: 'Adres invullen met postcode en huisnummer',
      items: [
        { text: 'Vul een postcode en huisnummer in en straat en woonplaats staan er meteen. Dat voorkomt typefouten. Je vindt het bij het afrekenen in de webshop en bij elk adresveld van klanten: offertes, werkorders, facturen en debiteuren en het meldingsformulier in het klantportaal.' },
        { text: 'Bij het afrekenen werkt het totaal zich nu vanzelf bij als je een ander land of een btw-nummer kiest. De knop Totaal bijwerken is niet meer nodig.' },
        { text: 'Het adres blijft altijd handmatig aan te passen. Is de adresdienst even niet bereikbaar of vindt hij niets, dan staat er een melding en kun je het adres zelf invullen.', for: ['beheer', 'werkorders'] },
      ],
    },
    {
      version: '1.5.4',
      date: '2026-11-02',
      title: 'Webshop: afrekenen, retouren en mededelingenbalk',
      items: [
        { text: 'Webshopbestellingen en -retouren staan nu onder Verkoop, naast Offertes en Facturen.', for: ['beheer'] },
        { text: 'Bij afrekenen werkt het overzicht en het totaal direct bij als de klant kiest tussen bezorgen en ophalen: één klik op Bestelling plaatsen is genoeg. Verzendkosten staan er nu met "incl. btw" of "excl. btw" bij.', for: ['beheer'] },
        { text: 'In de webshop zie je bij een product met varianten nu "3 varianten", de voorraadregel staat op elke kaart onderaan en op de productpagina staat het aantal varianten netjes bij de keuzelijst.', for: ['beheer'] },
        { text: 'Het retourformulier en de eerdere retouren van een klant hebben dezelfde opmaak als de rest van de webshop. Een afgewezen retour kan niet opnieuw worden ingediend; na intrekken kan dat wel.', for: ['beheer'] },
        { text: 'Het retourdetail in Beheer is netter opgemaakt: artikelnaam en artikelnummer onder elkaar, tekstvak en knoppen in de stijl van Beheer.', for: ['beheer'] },
        { text: 'De mededelingenbalk bovenaan de webshop kun je nu ook een andere achtergrondkleur geven, naast het aanpassen van de tekst en het aan- of uitzetten (Beheer, Webshop-inhoud).', for: ['beheer'] },
      ],
    },
    {
      version: '1.5.3',
      date: '2026-10-31',
      title: 'Online betalen in de webshop',
      items: [
        { text: 'Klanten kunnen in de webshop nu online betalen met iDEAL of een andere betaalmethode (via Mollie), naast bestellen op rekening. De bestelling wordt bevestigd zodra de betaling binnen is.', for: ['beheer'] },
        { text: 'Bij Beheer, Webshop, Betalen vul je je Mollie-sleutel in (begin met een testsleutel) en kies je of op rekening nog mag. Een onbetaalde online bestelling kun je pas verzenden als hij betaald is en vervalt na een instelbare tijd.', for: ['beheer'] },
        { text: 'Bij Bestellingen zie je of een bestelling betaald is. Een online betaalde bestelling krijgt al bij de betaling een betaalde factuur.', for: ['beheer'] },
      ],
    },
    {
      version: '1.5.2',
      date: '2026-10-31',
      title: 'Voorwaarden en privacy in de webshop',
      items: [
        { text: 'De webshop heeft nu algemene voorwaarden, een privacyverklaring en een pagina Herroepingsrecht met modelformulier, te vinden onderaan elke pagina. Het zijn standaardteksten: laat ze door de eigenaar controleren.', for: ['beheer'] },
        { text: 'Bij Beheer, Webshop-inhoud, Pagina\'s pas je die teksten aan met de knop naast de pagina; na Publiceren gaat jouw versie voor.', for: ['beheer'] },
        { text: 'Bij afrekenen moet de klant akkoord gaan met de voorwaarden. Dat akkoord (met tijdstip) wordt bij de bestelling bewaard.', for: ['beheer'] },
      ],
    },
    {
      version: '1.5.1',
      date: '2026-10-30',
      title: 'Retouren in de webshop',
      items: [
        { text: 'Klanten kunnen binnen 14 dagen na verzending een retour aanvragen op hun bestelpagina: artikelen, aantal en reden. Ze kunnen een aangevraagde retour ook weer intrekken.', for: ['beheer'] },
        { text: 'Bij Beheer, Webshopretouren keur je een retour goed of wijs je hem af. Bij Retour ontvangen gaan de artikelen terug op voorraad en maakt Aquatech de creditnota; de klant krijgt bij elke stap een mail.', for: ['beheer'] },
      ],
    },
    {
      version: '1.5.0',
      date: '2026-10-30',
      title: 'Verzendmail en bestelhistorie',
      items: [
        { text: 'Zodra je een webshopbestelling op Verzonden zet, krijgt de klant een mail met de volgcode van DPD (of dat de bestelling klaarstaat om op te halen). Voeg je de volgcode later toe, dan volgt één mail met die code.', for: ['beheer'] },
        { text: 'Klanten zien onder Mijn account al hun bestellingen, met verloop, volgcode en de factuur als PDF.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.9',
      date: '2026-10-30',
      title: 'Facturen voor webshopbestellingen',
      items: [
        { text: 'Zodra je een webshopbestelling op Verzonden zet, maakt Aquatech automatisch een definitieve factuur met de klant als debiteur. Bij btw verlegd staat dat op de factuur. Visma en het mailen van de factuur volgen je bestaande instellingen.', for: ['beheer', 'facturen'] },
        { text: 'Bij Beheer, Bestellingen zie je de factuur van een bestelling en kun je hem zo nodig opnieuw laten maken. Zet de factuur zelf op betaald in Facturen zodra de klant heeft betaald.', for: ['beheer', 'facturen'] },
        { text: 'In Facturen, Instellingen kies je of dit automatisch gebeurt en of de factuur meteen definitief wordt.', for: ['facturen'] },
      ],
    },
    {
      version: '1.4.8',
      date: '2026-10-30',
      title: 'Zakelijke klanten in de webshop',
      items: [
        { text: 'Je kunt een klant als zakelijk markeren bij Beheer, Gebruikers (kolom Klantgroep). Zo iemand ziet in de winkelwagen de zakelijke prijs excl. btw en moet een bedrijfsnaam invullen.', for: ['beheer'] },
        { text: 'Bij Artikelen vul je optioneel een zakelijke prijs excl. btw in. Zonder zakelijke prijs geldt de gewone verkoopprijs.', for: ['beheer', 'voorraad'] },
        { text: 'Een zakelijke klant met een btw-nummer uit het land van aflevering (buiten Nederland, binnen de EU) krijgt de btw verlegd. We controleren alleen het formaat van het nummer; controleer het zelf voordat je factureert.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.7',
      date: '2026-10-30',
      title: 'Verzending in de webshop',
      items: [
        { text: 'Klanten kiezen bij het afrekenen tussen ophalen (gratis, zonder adres) en bezorging door DPD. De verzendkosten hangen af van het land en het gewicht, en boven een bedrag naar keuze is bezorgen gratis.', for: ['beheer'] },
        { text: 'Je stelt ophalen en de DPD-tarieven in bij Beheer, Webshop en WooCommerce, Verzending. Het gewicht per artikel vul je in bij Artikelen.', for: ['beheer'] },
        { text: 'Bij Verzonden kun je de DPD-volgcode invullen (of later toevoegen). De klant ziet dan een link om het pakket te volgen.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.6',
      date: '2026-10-30',
      title: 'Bestellen in de webshop',
      items: [
        { text: 'Klanten kunnen in de webshop artikelen in de winkelwagen leggen en bestellen op rekening. Je zet dit aan bij Beheer, Webshop en WooCommerce.', for: ['beheer'] },
        { text: 'Nieuwe bestellingen zie je bij Beheer, Webshopbestellingen. Een bestelling reserveert de voorraad; bij Verzonden worden de artikelen afgeboekt en bij Annuleren komt de voorraad weer vrij. De klant krijgt een bevestiging per mail.', for: ['beheer'] },
        { text: 'Je kunt de bestellingen exporteren naar Excel.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.5',
      date: '2026-10-30',
      title: 'Voorraad in de webshop',
      items: [
        { text: 'De webshop toont per artikel (en per variant) of het op voorraad is, op basis van de voorraad bij Artikelen min wat voor werkorders is gereserveerd. In een categorie of zoekresultaat kun je kiezen voor Alleen op voorraad.', for: ['beheer', 'voorraad'] },
        { text: 'Staat alles in de webshop op "Niet op voorraad", dan is bij die artikelen nog geen voorraad ingevuld bij Artikelen. Zodra je de voorraad telt of boekt, verschijnt die in de webshop.', for: ['beheer', 'voorraad'] },
      ],
    },
    {
      version: '1.4.4',
      date: '2026-10-30',
      title: 'Beheer overal gelijk uitgelijnd',
      items: [
        { text: 'In Beheer staat het menu links nu strak uitgelijnd en heeft de inhoud op elk tabblad dezelfde plek en breedte, zodat er bij het wisselen niets meer heen en weer springt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.3',
      date: '2026-10-30',
      title: 'Artikelen met varianten in de webshop',
      items: [
        { text: 'In de webshop staat een artikel met varianten (bijvoorbeeld een koppeling in meerdere maten) nu als één regel met een keuzelijst. Kies je een maat, dan wisselen artikelnummer, prijs en voorraad meteen.', for: ['beheer', 'voorraad'] },
      ],
    },
    {
      version: '1.4.2',
      date: '2026-10-30',
      title: 'Webshop zelf bewerken',
      items: [
        { text: 'Je kunt de teksten en afbeeldingen van de webshop nu zelf aanpassen bij Beheer, onder Webshop-inhoud: de mededeling bovenaan, de grote afbeelding, de voordelen, de merken, het zakelijke blok en de contactgegevens.', for: ['beheer'] },
        { text: 'Je kunt eigen pagina\'s maken, zoals Klantenservice of Verzending & retour, met een eenvoudige editor en eigen afbeeldingen. Eerst een concept bekijken en dan pas publiceren kan ook.', for: ['beheer'] },
      ],
    },
    {
      version: '1.4.1',
      date: '2026-10-30',
      title: 'Webshop netter uitgelijnd en Over ons',
      items: [
        { text: 'In de webshop staan de producten en regels nu netjes op één lijn: titel, prijs en voorraad staan op elke kaart op dezelfde plek. De lichte streep boven de foto is weg.' },
        { text: 'De webshop heeft een eigen pagina Over ons, met het verhaal van Aquatechshop.nl.' },
      ],
    },
    {
      version: '1.4.0',
      date: '2026-10-30',
      title: 'Voorraadbeheer heet nu Artikelen',
      items: [
        { text: 'Voorraadbeheer heet overal Artikelen: in het menu, op het dashboard, in de rollen en in de verwijzingen vanuit werkorders, de planner en Beheer. Het adres is nu artikelen/; opgeslagen links naar het oude adres blijven werken.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.3.9',
      date: '2026-10-30',
      title: 'Beheer en menu overzichtelijker',
      items: [
        { text: 'Beheer heeft een eigen menu met zes groepen (Organisatie & gebruikers, Modules, Integraties, Toegang & beveiliging, Systeem en Overzicht). Elke instelling staat op één plek en je kunt ze opzoeken met het zoekveld.', for: ['beheer'] },
        { text: 'Het menu links is opgedeeld in Ontwerpen, Verkoop en Uitvoering. Klik een kopje open of dicht; de app onthoudt wat je open had.', for: ['beheer'] },
        { text: 'Voorraadbeheer heet in het menu nu Artikelen.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.3.8',
      date: '2026-10-30',
      title: 'Nieuwe opzet webshop',
      items: [
        { text: 'De webshop heeft de opzet van aquatechshop.nl gekregen: een foto bovenaan, populaire producten met plaatjes, merken en een duidelijker menu met het klantenservicenummer.' },
        { text: 'Een oude opmaak uit de browser kan de webshop niet meer verstoren na een nieuwe versie.' },
      ],
    },
    {
      version: '1.3.7',
      date: '2026-10-30',
      title: 'Account in de webshop',
      items: [
        { text: 'Klanten kunnen zich in de webshop registreren en inloggen. Het is hetzelfde account als in de planner en het klantportaal.' },
        { text: 'In de webshop staat een kopje Planner: met alleen naam, e-mail en wachtwoord maak je een account en ga je meteen door naar de planner. Aan of uit te zetten in Beheer → Instellingen → Toegang.', for: ['beheer'] },
      ],
    },
    {
      version: '1.3.6',
      date: '2026-10-30',
      title: 'Bekijken als klant',
      items: [
        { text: 'In een testomgeving kun je in Beheer → Gebruikers de app bekijken zoals een klant hem ziet. Bovenin staat dan een balk met Terug naar beheer. Start en einde staan in het auditlog.', for: ['beheer'] },
      ],
    },
    {
      version: '1.3.5',
      date: '2026-10-30',
      title: 'Nieuw ontwerp voor de webshop',
      items: [
        { text: 'De webshop heeft een echt ontwerp gekregen: kopbalk met zoekveld, menu met productgroepen en subcategorieën, uitgelichte producten met foto en een voet. Zoeken op productnaam of artikelnummer werkt al; de winkelwagen volgt later.', for: ['beheer'] },
        { text: 'Tekens als &amp; staan niet meer letterlijk in categorie- en productnamen van de webshop.', for: ['beheer'] },
        { text: 'Het nieuwe icoon staat als favicon in de browser en als logo in de ingeklapte zijbalk.' },
      ],
    },
    {
      version: '1.3.4',
      date: '2026-10-30',
      title: 'Varianten: kleine correcties',
      items: [
        { text: 'Bij een hoofdartikel telt een werkorder met twee maten nu als één werkorder.', for: ['voorraad'] },
        { text: 'Een losse factuur met de code van een hoofdartikel boekt geen voorraad meer af op het hoofdartikel; kies op de factuur de maat (variant).', for: ['facturen'] },
      ],
    },
    {
      version: '1.3.3',
      date: '2026-10-30',
      title: 'Artikelen met varianten',
      items: [
        { text: 'Een artikel kan nu **varianten** hebben, bijvoorbeeld per maat of lengte. Geef op de artikelpagina de kenmerken op (bijv. Maat: 16 mm, 20 mm); elke combinatie wordt een variant met een eigen code, prijs, inkoopprijs, voorraad, minimum en bestelniveau. In de voorraadlijst klap je een hoofdartikel uit naar zijn varianten.', for: ['voorraad'] },
        { text: 'Met **+ Uit voorraad** kies je in een werkorder of offerte eerst het artikel en daarna de maat. Staat er een artikel met varianten op, dan zie je de knop **Kies maat**.', for: ['werkorders', 'offertes'] },
        { text: 'De webshopkoppeling kent nu variabele producten: variaties komen als varianten binnen, prijs en voorraad gaan per variant heen en weer, en een nieuwe variant uit Aquatech verschijnt vanzelf in de webshop. Met **In webshop zetten** maak je een artikel (met varianten) als nieuw product in de webshop aan.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.3.2',
      date: '2026-10-30',
      title: 'Eenheden beheren',
      items: [
        { text: 'In Voorraadbeheer kies je de eenheid van een artikel nu uit een lijst. Via de knop **Eenheden** maak je zelf eenheden aan (bijv. rol of pallet). De knoppen op de artikelpagina hebben ook meer ruimte gekregen.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.3.1',
      date: '2026-10-29',
      title: 'Eerste opzet eigen webshop',
      items: [
        { text: 'De eigen webshop heeft een eerste opzet: een openbare startpagina, categorieën en productpagina\'s op winkel/ (alleen bekijken, nog niet bestellen). Zet hem aan in Beheer → Instellingen → Toegang.', for: ['beheer'] },
      ],
    },
    {
      version: '1.3.0',
      date: '2026-10-29',
      title: 'Voorraad vult zich uit de webshop',
      items: [
        { text: 'Met een webshopkoppeling neemt **Alles uit webshop** in Voorraadbeheer alle producten over, ook zonder SKU (die krijgen de code WC-<id>). Artikelen die niet in de webshop staan worden gearchiveerd.', for: ['voorraad'] },
      ],
    },
    {
      version: '1.1.1',
      date: '2026-10-29',
      title: 'Inloggen met testaccounts',
      items: [
        { text: 'Inloggen met een **testaccount** (bijv. klant) lukt nu ook als de organisatiecode leeg is of van de vorige keer komt.', for: ['beheer'] },
      ],
    },
    {
      version: '1.0.1',
      date: '2026-10-29',
      title: 'Planner gebruikt de volle breedte',
      items: [],
    },
    {
      version: '0.72.1',
      date: '2026-10-28',
      title: 'Kleine verbetering klantportaal',
      items: [],
    },
    {
      version: '0.72.0',
      date: '2026-10-28',
      title: 'Seizoensherinneringen voor klanten',
      items: [
        { text: 'Klanten met een installatie krijgen in het voorjaar en het najaar een **herinnering per mail** om de beregening op te starten of winterklaar te maken. Zet het aan en pas de datums en teksten aan in Beheer > Instellingen.', for: ['beheer'] },
        { text: 'In je portaal staat in het voorjaar en najaar een **herinnering voor onderhoud**, met een knop om direct een afspraak aan te vragen. Wil je de mails niet meer? Zet ze uit met het vinkje eronder.', for: ['portaal'] },
      ],
    },
    {
      version: '0.71.0',
      date: '2026-10-28',
      title: 'Nacalculatie per werkorder',
      items: [
        { text: 'Op elke werkorder staat nu een **Nacalculatie**: begroot volgens de offerte naast de geboekte uren en het materiaalverbruik, met het verschil, de kosten, wat er gefactureerd is en de marge. Ook als Excel te downloaden.', for: ['nacalculatie'] },
        { text: 'Vul bij Offertes > Bedrijfsgegevens de **kostprijs per uur** in en in de voorraad de inkoopprijzen, dan klopt de marge.', for: ['nacalculatie'] },
      ],
    },
    {
      version: '0.70.2',
      date: '2026-10-28',
      title: 'Installatiedossier per locatie',
      items: [
        { text: 'In **Klantdossiers** staat nu ook een overzicht **per locatie**: per adres de tekening, offertes, werkorders, opleverfoto\'s, meldingen en de gebruikte materialen bij elkaar.', for: ['werkorders'] },
        { text: 'In uw **portaal** ziet u per adres het **installatiedossier**: wat er is aangelegd, de foto\'s van de oplevering en uw meldingen.', for: ['portaal'] },
      ],
    },
    {
      version: '0.70.1',
      date: '2026-10-28',
      title: 'Opgeschoonde code (planner)',
      items: [],
    },
    {
      version: '0.70.0',
      date: '2026-10-27',
      title: 'Bestelvoorstel bij lage voorraad',
      items: [
        { text: 'In **Voorraadbeheer** maakt de knop **Bestelvoorstel** een Excel met elk artikel dat onder de minimumvoorraad zit en hoeveel je moet bestellen. Per artikel stel je in tot welk aantal je aanvult (**Bestellen tot**, leeg = 2× het minimum).', for: ['voorraad'] },
      ],
    },
    {
      version: '0.69.1',
      date: '2026-10-27',
      title: 'Opgeschoonde code (deel 3 van de schermen)',
      items: [],
    },
    {
      version: '0.69.0',
      date: '2026-10-23',
      title: 'Veiligheid verder aangescherpt',
      items: [
        { text: 'Log je uit, of gebruikt iemand anders daarna dezelfde browser, dan blijft het **lokale concept van de planner** van jou: een volgende gebruiker ziet het niet meer.', for: ['plannen'] },
        { text: 'Wijzigingen die **zonder verbinding** zijn bewaard, worden alleen nog verstuurd onder het account dat ze maakte.', for: ['werkorders'] },
        { text: 'De beregeningsplanner is alleen nog te gebruiken met het recht **Beregeningsplanner** (Beheer > Rollen).', for: ['beheer'] },
      ],
    },
    {
      version: '0.68.6',
      date: '2026-10-22',
      title: 'Opgeschoonde code (deel 2 van de schermen)',
      items: [],
    },
    {
      version: '0.68.5',
      date: '2026-10-22',
      title: 'Opgeschoonde code (deel 1 van de schermen)',
      items: [],
    },
    {
      version: '0.68.4',
      date: '2026-10-22',
      title: 'Opgeschoonde tests',
      items: [],
    },
    {
      version: '0.68.3',
      date: '2026-10-22',
      title: 'Opgeschoonde servercode (deel 3)',
      items: [],
    },
    {
      version: '0.68.2',
      date: '2026-10-22',
      title: 'Opgeschoonde servercode (deel 2)',
      items: [],
    },
    {
      version: '0.68.1',
      date: '2026-10-22',
      title: 'Opgeschoonde servercode (deel 1)',
      items: [],
    },
    {
      version: '0.68.0',
      date: '2026-10-22',
      title: 'Automatisch plaatsen: zo groen mogelijk met zo min mogelijk koppen',
      items: [
        { text: '**Automatisch plaatsen** stuurt nu op een groene neerslagkaart: elke plek die te weinig (geel) of te veel (blauw) water krijgt, telt mee bij het kiezen. Op onregelmatige gazons is gemiddeld zo’n 95% groen, waar dat eerst rond de 80% lag.', for: ['plannen'] },
        { text: 'Teken je een vlak **Moet droog blijven** (huis, terras), dan houdt de planner daar extra rekening mee: water daarop telt zes keer zo zwaar als op beplanting.', for: ['plannen'] },
      ],
    },
    {
      version: '0.67.2',
      date: '2026-10-22',
      title: 'Nettere mappenindeling van de server',
      items: [],
    },
    {
      version: '0.67.1',
      date: '2026-10-22',
      title: 'Afspraken voor nette, leesbare code',
      items: [],
    },
    {
      version: '0.67.0',
      date: '2026-10-22',
      title: 'Automatisch het beste sproeiertype, en een rustigere indeling',
      items: [
        { text: 'Nieuw sproeiertype **Automatisch: beste type per gazon**: de planner rekent rotators, sproeiers en turbines door en kiest per gazon de indeling met de minste koppen, het minste water op terras en bestrating en de minste gele of droge plekken. Alleen wat in je assortiment zit en bij de waterdruk past. Dit is de standaard voor nieuwe plannen.', for: ['plannen'] },
        { text: '**Automatisch plaatsen** is rustiger: geen kluitjes koppen meer op elk trapje of hoekje van een terrasrand, overbodige koppen gaan eruit en water dat ver naast het gazon valt (bijv. van turbines) telt volledig mee. Op een voorbeeldtuin met een getrapt terras gaat het van 20 naar 12 rotators met een gelijkmatigere neerslag.', for: ['plannen'] },
        { text: 'De **neerslagkaart** kleurt elk gazon nu ten opzichte van zijn eigen gemiddelde. Een gazon met rotators naast een gazon met turbines kleurt daardoor niet meer onterecht geel.', for: ['plannen'] },
      ],
    },
    {
      version: '0.66.0',
      date: '2026-10-21',
      title: 'Sproeiers kiezen uit een bibliotheek, en minder koppen met een grotere worp',
      items: [
        { text: '**Automatisch plaatsen** benut nu waar het kan de volle breedte van het gazon: grote rotators (bijv. MP3000/MP3500) langs de randen in plaats van een raster kleine koppen. Op een gemiddeld gazon scheelt dat een derde van de koppen.', for: ['plannen'] },
        { text: 'Kies zelf een **behuizing** (bijv. Rain Bird 1800 of Hunter Pro-Spray van 10, 15 of 30 cm, of een Rain Bird 5004/5012) en een passende **nozzle** (MP Rotator, HE-VAN, Rain Curtain) en plaats die in de tekening. Worp en sproeihoek stel je in binnen wat die nozzle kan; debiet, neerslag, druk en stuklijst rekenen met de echte gegevens.', for: ['plannen'] },
        { text: 'Bij automatisch plaatsen kies je ook de behuizing voor gazon en beplanting; de werkbon toont per kop de behuizing.', for: ['plannen'] },
        { text: 'Nieuw in **Beheer → Sproeiers**: download de sproeierbibliotheek als Excel, vul aan met je eigen sproeiers en nozzles (worp, sproeihoeken, druk en debiet uit de tabel van de fabrikant) en lees hem weer in.', for: ['beheer'] },
      ],
    },
    {
      version: '0.65.0',
      date: '2026-10-21',
      title: 'Facturen gaan rechtstreeks naar Visma eAccounting',
      items: [
        { text: 'Verbind je eigen **Visma eAccounting**-administratie in **Facturen → Visma**. Een definitieve factuur gaat dan als verkoopfactuur naar Visma, en een nieuwe debiteur wordt daar een klant met hetzelfde nummer. Per omzetcategorie kies je het Visma-artikel, dat de grootboekrekening en btw bepaalt.', for: ['facturen'] },
        { text: 'Zelf de controle houden: doorsturen gaat met de knop **Naar Visma** op een factuur of **Nu doorsturen**. Automatisch doorsturen zet je aan als je wilt, vanaf een datum die je kiest, zodat facturen die al in Visma staan er niet dubbel in komen.', for: ['facturen'] },
      ],
    },
    {
      version: '0.64.2',
      date: '2026-10-21',
      title: 'Inzoomen: tekening en vlakken scherp en op hun plek',
      items: [
        { text: 'Bij het automatisch herkennen van een plan volgen de vlakken nu ook **bochten** in de tekening. Eerder werden randen te hard rechtgetrokken, waardoor ze ingezoomd tot een halve meter naast de tekening lagen. De randen van vlakken zijn ook beter zichtbaar.' },
        { text: 'Ingezoomd op de **iPhone** blijft de tekening scherp en op zijn plek: fijne lijnen vallen niet meer weg en vlakken verspringen niet meer ten opzichte van de tekening.' },
      ],
    },
    {
      version: '0.64.1',
      date: '2026-10-21',
      title: 'Kopbalk past weer op de telefoon',
      items: [
        { text: 'Op de telefoon staat bovenin nu alleen de paginanaam naast het menu, zodat de organisatiekiezer en je profielrondje altijd volledig in beeld zijn. Het logo zie je in het menu en op het overzicht.' },
      ],
    },
    {
      version: '0.64.0',
      date: '2026-10-21',
      title: 'De planner werkt met je eigen artikelen',
      items: [
        { text: 'Staan er artikelen in **Voorraadbeheer** of zijn er webshopproducten gekoppeld, dan gebruikt de planner alleen die artikelen: sproeiers, rotatorkoppen, buisdiameters en hulpstukken. Ontbreekt een onderdeel, dan kiest de planner een alternatief dat je wel hebt of toont het onder **Niet in je assortiment**, zodat het niet ongemerkt in de stuklijst of offerte komt. Organisaties zonder eigen artikelen houden de standaardcatalogus.', for: ['offertes', 'voorraad'] },
        { text: 'Verkoopprijzen uit Voorraadbeheer gelden nu ook in de planner en offertes als er geen webshop is gekoppeld.', for: ['offertes', 'voorraad'] },
      ],
    },
    {
      version: '0.63.0',
      date: '2026-10-21',
      title: 'Webshopbestellingen worden facturen, en facturen gaan vanzelf per mail',
      items: [
        { text: 'Een **afgeronde bestelling in de webshop** wordt vanzelf een factuur, met de klant als debiteur. Betaald via iDEAL? Dan staat de factuur meteen op betaald. Zet het aan bij **Facturen → Instellingen**, met de datum vanaf wanneer (oudere bestellingen zijn al gefactureerd).', for: ['facturen'] },
        { text: 'Facturen **versturen per e-mail** met de factuur als **PDF** in de bijlage, met de knop *Versturen* of automatisch zodra een factuur definitief is. Onderwerp en tekst stel je zelf in.', for: ['facturen'] },
        { text: 'Nieuw tabblad **Debiteuren**: elke klant met een factuur krijgt een debiteurnummer, met het aantal facturen en wat er openstaat. Het nummer gaat ook mee in de export voor Visma.', for: ['facturen'] },
      ],
    },
    {
      version: '0.62.0',
      date: '2026-10-21',
      title: 'Vlakken corrigeren en verschuiven tijdens het tekenen',
      items: [
        { text: 'Een getekend vlak (bijv. het gazon) pas je achteraf aan: selecteer het, sleep een hoekpunt, sleep een middenstip voor een extra punt, of tik een hoekpunt aan en kies **Punt verwijderen**. Met **Opnieuw tekenen** teken je de vorm opnieuw; naam en type blijven. Sproeiers op de rand zitten daarbij niet meer in de weg.' },
        { text: 'Tijdens het tekenen kun je het plan verschuiven zonder je vorm kwijt te raken: met **✋ Schuiven** in de tekenbalk, het scrollwiel of touchpad, de spatiebalk of de pijltjestoetsen. Zoomen doe je met Ctrl + scrollen of door te knijpen.' },
        { text: 'Leidingen hebben duidelijkere kleuren (geen groen meer op het gazon) en een witte rand, zodat ze op elke ondergrond zichtbaar zijn.' },
      ],
    },
    {
      version: '0.61.0',
      date: '2026-10-21',
      title: 'Facturen, verkoopprijzen en de webshop vanuit AquaTech',
      items: [
        { text: 'Nieuwe module **Facturen**: maak een factuur met één klik vanuit een werkorder (de offerteregels, plus meerwerk dat op de werkorder is geboekt) of als losse verkoop. Een concept pas je vrij aan; definitief krijgt hij een doorlopend factuurnummer. Afdrukken of opslaan als PDF, betaald markeren en crediteren.', for: ['facturen'] },
        { text: 'Export voor de boekhouding: een Excel-bestand voor **Visma** met per factuur de omzet per categorie (bijv. *Omzet producten hoog 21%*) en de grootboekrekening, plus de debiteuren. Naam en rekeningnummer per categorie stel je zelf in.', for: ['facturen'] },
        { text: 'In **Voorraadbeheer** heeft elk artikel nu een verkoopprijs, btw-tarief en omzetgroep. Met de webshopkoppeling aan gaan prijs en voorraad vanzelf naar de webshop, en wat in de webshop verkocht is, wordt hier afgeboekt. Producten uit de webshop neem je met één klik over als artikel.', for: ['voorraad'] },
      ],
    },
    {
      version: '0.60.0',
      date: '2026-10-21',
      title: 'Storing of onderhoud melden via het portaal',
      items: [
        { text: 'Werkt er iets niet of wilt u onderhoud? In **Mijn portaal** meldt u nu zelf een storing of onderhoudsverzoek, met een omschrijving en foto\'s. U ziet daar ook onze reactie en wanneer we komen.', for: ['portaal'] },
        { text: 'Nieuwe module **Meldingen**: storingen en onderhoudsverzoeken van klanten met hun foto\'s. Stuur de klant een reactie of maak er met één klik een werkorder van; de gegevens van de installatie en de foto\'s gaan mee, en de klant ziet de afspraak in zijn portaal.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.59.0',
      date: '2026-10-21',
      title: 'Voorraadbeheer',
      items: [
        { text: 'Nieuwe module **Voorraadbeheer**: wat er op voorraad ligt, met locatie, minimumvoorraad en voorraadwaarde. Artikelen neem je met één klik over uit de catalogus van de stuklijst. Ontvangsten, tellingen en correcties boek je per artikel, en alles is als Excel te exporteren.', for: ['voorraad'] },
        { text: 'Een werkorder **reserveert** zijn materialen zolang hij open staat, en wordt hij **Gereed**, dan worden ze vanzelf van de voorraad **afgeboekt**. Op de werkorder zie je in het blok **Voorraad** wat er nodig is, wat er ligt en waar een tekort is; daar kun je ook zelf afboeken of een retour boeken.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.58.0',
      date: '2026-10-21',
      title: 'Werken zonder bereik op locatie',
      items: [
        { text: 'AquaTech is nu als **app op je telefoon** te zetten: kies in de browser *Toevoegen aan beginscherm* (iPhone: deelknop) of *App installeren* (Android).', for: ['werkorders'] },
        { text: 'Geen bereik op locatie? Je **startscherm en werkorders blijven werken**. De klussen van vandaag staan al op je toestel zodra je het overzicht met verbinding hebt geopend. Afvinken, uren, notities en **foto\'s** worden bewaard en vanzelf verstuurd zodra er weer verbinding is. Rechtsonder zie je wat er nog wacht.', for: ['werkorders'] },
        { text: 'Heeft kantoor dezelfde werkorder intussen ook gewijzigd, dan worden beide wijzigingen samengevoegd. Alleen als jullie hetzelfde veld anders invulden, kies je zelf welke versie blijft.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.57.0',
      date: '2026-10-21',
      title: 'Uren en materiaal boeken op de werkorder',
      items: [
        { text: 'In elke werkorder staat nu **Uren en materiaalverbruik**: boek per dag je gewerkte uren (begin, eind en pauze, of gewoon een aantal uren), reistijd en meerwerk, en het materiaal dat je hebt gebruikt of retour neemt. Je ziet meteen hoeveel er geboekt is tegenover de planning.', for: ['werkorders'] },
        { text: 'Geen bereik op de klus? Wat je boekt, blijft op je telefoon bewaard en wordt vanzelf verstuurd zodra je weer verbinding hebt.', for: ['werkorders'] },
        { text: 'Met de knop **Urenstaat** in Werkorders exporteer je de uren en het materiaalverbruik over een periode naar Excel, per medewerker en per dag. Planners en beheerders boeken ook voor een collega en zien de uren van iedereen.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.56.0',
      date: '2026-10-21',
      title: 'Herkennen zonder AI leert van de AI',
      items: [
        { text: 'Herkennen **zonder AI** is veel beter op gekleurde tuinontwerpen: getekende planten en bomen worden geen gazon meer, tekst of een watermerk over het gras snijdt geen stukken uit het gazon, en een logo of legenda naast de tuin wordt genegeerd. Daardoor komen de sproeiers weer netjes langs de randen.' },
        { text: 'Dezelfde tekening geeft met AI nu **altijd hetzelfde resultaat**, en de tweede keer kost het geen API-tegoed. Klopt het resultaat niet, dan kan het in stap 1 opnieuw met **Opnieuw herkennen met AI**.' },
        { text: 'De herkenning zonder AI **leert** van elke AI-herkenning en van elk goedgekeurd plan in je organisatie: welke kleuren en texturen gazon, beplanting, haag of bestrating zijn. Er gaat geen afbeelding mee, alleen kleurtellingen. Hoe vaker er met AI herkend en goedgekeurd wordt, hoe beter het zonder AI gaat.' },
      ],
    },
    {
      version: '0.55.0',
      date: '2026-10-21',
      title: 'Legenda in de tekening',
      items: [
        { text: 'De beregeningsplanner toont nu in elke stap een **legenda** rechtsboven in de tekening: welk vlak wat is (met oppervlak), druppelslang en druppelaars, sproeiers, zones en de systeemelementen. In te klappen met een klik.' },
        { text: 'De legenda staat ook naast de tekening bij **Plan als PNG**, in de Excel-export en op de afdruk.' },
      ],
    },
    {
      version: '0.54.0',
      date: '2026-10-21',
      title: 'AI-kosten in beeld en modelkeuze',
      items: [
        { text: 'Nieuw in Beheer: **AI-kosten**. Je ziet per dag of maand, per gebruiker en per model hoeveel het automatisch herkennen van plannen kost, en per verzoek hoeveel tokens het gebruikte en hoe lang het duurde. Ook te exporteren naar Excel.', for: ['beheer'] },
        { text: 'Kies in **Beheer → Instellingen** welk AI-model plannen herkent: Opus 5.5 (aanbevolen), het goedkopere Sonnet 5.5 of Haiku 5.5, of het krachtigste Fable 5.1.', for: ['beheer'] },
        { text: 'Elke organisatie gebruikt voor AI een **eigen API-sleutel** van Anthropic; vul die in bij Beheer → Instellingen.', for: ['beheer'] },
      ],
    },
    {
      version: '0.53.0',
      date: '2026-10-21',
      title: 'Slimmere sproeierplaatsing en instelbare rotators',
      items: [
        { text: '**Automatisch plaatsen** maakt nu een nette kop-tot-kopindeling: hoeken, randen en binnenin in lijn, met minder koppen, een gelijkmatigere neerslag en veel minder water op terras en paden. Herkende vlakken worden eerst rechtgetrokken.' },
        { text: 'Elke **meerstraalsrotator** wordt automatisch optimaal afgesteld: de juiste kop (MP1000 t/m MP3500 of MP Corner), worp, sproeihoek en richting. Ook bij handmatig plaatsen en verslepen. Bijstellen kan in het paneel of door in de tekening aan de grepen te slepen.' },
        { text: 'De **werkorder** toont per sproeikop de afstelling (kop, sector, sproeihoek, worp en linkerrand), ook op de afgedrukte werkbon en in Excel.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.52.0',
      date: '2026-10-21',
      title: 'Tekening indienen en plannen goedkeuren',
      items: [
        { text: 'Klanten kunnen zonder account **direct een tekening maken** (knop op de inlogpagina) en die ter controle indienen met hun contactgegevens en een vraag.' },
        { text: 'Plannen hebben een **status**: concept, ter controle of goedgekeurd. Een plan van een klant is pas definitief als een installateur het heeft goedgekeurd; een offerte maak je alleen van een goedgekeurd plan.', for: ['plannen.alle', 'offertes'] },
        { text: 'Klaar met tekenen? Met **Ter controle aanbieden** laat je je plan nakijken door een installateur.', for: ['portaal'] },
        { text: 'In het **Plannenoverzicht** zie je met het filter *Ter controle* welke tekeningen op je wachten, met de vraag en de contactgegevens.', for: ['plannen.goedkeuren'] },
        { text: 'Tekening indienen zonder account zet je aan of uit in **Beheer → Instellingen → Toegang**.', for: ['beheer'] },
      ],
    },
    {
      version: '0.51.0',
      date: '2026-10-21',
      title: 'Nieuws en wat is nieuw',
      items: [
        { text: 'Nieuwe pagina **Nieuws**: berichten van je organisatie en een overzicht van wat er in de app is veranderd. Een stip bij Nieuws laat zien dat er iets nieuws is sinds je vorige bezoek.' },
        { text: 'Beheerders plaatsen zelf **nieuwsberichten** voor alle collega\'s (of ook voor klanten), kunnen een bericht bovenaan vastzetten en het desgewenst ook per e-mail versturen.', for: ['nieuws'] },
      ],
    },
    {
      version: '0.50.0',
      date: '2026-10-21',
      title: 'E-mailinstellingen in Beheer',
      items: [
        { text: 'De instellingen voor het versturen van e-mail staan nu in **Beheer → Instellingen**, met ondersteuning voor een Exchange Online-connector (Office 365) en een korte handleiding.', for: ['beheer'] },
      ],
    },
    {
      version: '0.49.0',
      date: '2026-10-20',
      title: 'Rollen zelf instellen',
      items: [
        { text: 'Onder **Beheer → Rollen** stel je per rol in wat iemand mag, wijzig je de naam en maak je eigen rollen aan.', for: ['beheer'] },
        { text: 'Nieuwe rol **Planner**: plant klussen in de agenda en regelt afspraken met klanten, zonder toegang tot offertes of beheer.', for: ['beheer', 'planning'] },
      ],
    },
    {
      version: '0.48.0',
      date: '2026-10-20',
      title: 'Werk uitbesteden',
      items: [
        { text: 'Te veel werk? Bied een werkorder aan bij een andere organisatie op het platform, of neem opdrachten van anderen aan. Nieuwe module **Uitbesteden**; de beheerder zet het aan in de instellingen.', for: ['uitbesteden', 'beheer'] },
        { text: 'Een andere organisatie ziet pas na het aannemen de gegevens van de klant. Jij volgt daarna de voortgang bij de werkorder.', for: ['uitbesteden', 'beheer'] },
      ],
    },
    {
      version: '0.47.0',
      date: '2026-10-20',
      title: 'Sneller',
      items: [
        { text: 'De app reageert sneller: pagina\'s halen minder en alleen de nodige gegevens op.' },
      ],
    },
    {
      version: '0.46.1',
      date: '2026-10-20',
      title: 'Beveiliging',
      items: [
        { text: 'Extra beveiliging bij inloggen en bij de openbare offerte- en afspraaklinks.', for: ['beheer'] },
      ],
    },
    {
      version: '0.46.0',
      date: '2026-10-20',
      title: 'Geen tussenstappen meer',
      items: [
        { text: 'Een offerte of werkorder die je vanuit een ander onderdeel opent, verschijnt meteen. De terugknop brengt je terug naar waar je vandaan kwam.' },
        { text: 'Pagina\'s laden vlotter en de app opent direct op je eigen startpagina.' },
      ],
    },
    {
      version: '0.45.0',
      date: '2026-10-20',
      title: 'Planning overzichtelijker',
      items: [
        { text: 'Elke afspraak in de planning laat kort zien wat er gedaan moet worden, en een klik opent meteen de werkorder.', for: ['planning', 'werkorders'] },
      ],
    },
    {
      version: '0.44.0',
      date: '2026-10-20',
      title: 'Eigen kleuren',
      items: [
        { text: 'De kleuren van de app zijn aan te passen aan de huisstijl van de organisatie; te lichte kleuren worden geweigerd zodat alles leesbaar blijft.', for: ['hoofdbeheer'] },
      ],
    },
    {
      version: '0.43.0',
      date: '2026-10-20',
      title: 'Mijn profiel',
      items: [
        { text: 'Via het rondje met je initialen rechtsboven open je **Mijn profiel**: naam, e-mailadres, telefoonnummer en wachtwoord wijzigen op één plek.' },
        { text: 'Kies een **startpagina**: de app opent dan meteen in het onderdeel waar je het meest mee werkt.' },
        { text: 'Ontvang desgewenst een kopie van de offertes en afspraken die je per e-mail verstuurt.', for: ['offertes', 'werkorders'] },
      ],
    },
    {
      version: '0.42.0',
      date: '2026-10-20',
      title: 'Startscherm voor de installateur',
      items: [
        { text: 'Het overzicht begint met **Vandaag**: je klussen van de dag met adres, route, bellen, instructies en voortgang. Gemaakt voor de telefoon.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.40.0',
      date: '2026-10-20',
      title: 'Planning als agenda',
      items: [
        { text: 'De planning is een agenda met een dag-, werkweek- en maandweergave. Sleep een werkorder naar een tijdstip; de duur volgt uit de uren in de offerte.', for: ['planning'] },
      ],
    },
    {
      version: '0.38.0',
      date: '2026-10-20',
      title: 'Foto\'s en klantdossiers',
      items: [
        { text: 'Maak bij een werkorder foto\'s van voor, tijdens en na de aanleg, rechtstreeks met de camera van je telefoon.', for: ['werkorders'] },
        { text: 'Nieuwe module **Klantdossiers**: per klant alle installaties met foto\'s, materialen en zones, af te drukken als opleverrapport.', for: ['werkorders'] },
        { text: 'In je portaal staan nu ook de foto\'s van de aanleg in het opleverdossier.', for: ['portaal'] },
      ],
    },
    {
      version: '0.37.0',
      date: '2026-10-20',
      title: 'Mijn portaal',
      items: [
        { text: 'In **Mijn portaal** ziet u alles over uw tuinberegening op één plek: offertes, afspraken, de voortgang van de aanleg en het opleverdossier.', for: ['portaal'] },
      ],
    },
    {
      version: '0.36.0',
      date: '2026-10-20',
      title: 'Planning en afspraken',
      items: [
        { text: 'Nieuwe module **Planning**: werkorders inplannen door ze naar een dag en uitvoerder te slepen.', for: ['planning', 'werkorders'] },
        { text: 'De klant bevestigt de afspraak via een link, of vraagt om een ander moment.', for: ['planning', 'werkorders'] },
        { text: 'U krijgt een link om de afspraak voor de aanleg te bevestigen of een ander moment te vragen.', for: ['portaal'] },
      ],
    },
  ];

  /**
   * De versies met alleen de punten die iemand met deze rechten ziet.
   * @param {string[]} rights Rechten van de gebruiker.
   * @returns {object[]} De versies met zichtbare punten (lege versies vallen weg).
   */
  function visibleFor(rights) {
    /**
     * Mag de gebruiker een punt zien?
     * @param {string[]} [list] Rechten waarvan er één nodig is (leeg = iedereen).
     * @returns {boolean} true als het punt zichtbaar is.
     */
    const has = (list) => !list || list.some((right) => (rights || []).includes(right));
    return RELEASES
      .map((release) => ({ ...release, items: release.items.filter((item) => has(item.for)).map(({ text }) => ({ text })) }))
      .filter((release) => release.items.length);
  }

  /**
   * Vergelijkt twee versienummers ('0.9.0' < '0.10.0').
   * @param {string} left Eerste versie.
   * @param {string} right Tweede versie.
   * @returns {number} Negatief, 0 of positief (zoals bij sort).
   */
  function compare(left, right) {
    const leftParts = String(left || '0').split('.').map(Number);
    const rightParts = String(right || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((leftParts[i] || 0) !== (rightParts[i] || 0)) return (leftParts[i] || 0) - (rightParts[i] || 0);
    return 0;
  }

  const api = { RELEASES, visibleFor, compare, latest: RELEASES[0].version };
  root.AquatechReleases = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
