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
      version: '0.70.0',
      date: '2026-10-27',
      title: 'Seizoensherinneringen voor klanten',
      items: [
        { text: 'Klanten met een installatie krijgen in het voorjaar en het najaar een **herinnering per mail** om de beregening op te starten of winterklaar te maken. Zet het aan en pas de datums en teksten aan in Beheer > Instellingen.', for: ['beheer'] },
        { text: 'In je portaal staat in het voorjaar en najaar een **herinnering voor onderhoud**, met een knop om direct een afspraak aan te vragen. Wil je de mails niet meer? Zet ze uit met het vinkje eronder.', for: ['portaal'] },
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
