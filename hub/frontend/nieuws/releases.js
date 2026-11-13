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
