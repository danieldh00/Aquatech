# Changelog

## 0.53.0

Betere automatische sproeierplaatsing en instelbare meerstraalsrotators.

- **Automatisch plaatsen** opnieuw opgezet (`planner.js`): de vorm wordt eerst
  vereenvoudigd (Douglas-Peucker) en rechtgetrokken op de hoofdrichting
  (`Geo.simplifyClosed`, `Geo.dominantAngle`, `Geo.regularize`). Daarna
  worden varianten doorgerekend (vierkant/driehoek, twee richtingen,
  afstanden die het vlak in gelijke stukken delen) met koppen op hoeken,
  randen (zonder gaten) en binnenin, kop-tot-kop. Een snelle eigen beoordeling
  (vaste meetpunten per vlak) kiest de beste; daarna kort een greedy stap per
  kop de worp in als dat minder overspray geeft. Op gekartelde vlakken uit de
  lokale herkenning: 4–8 koppen in plaats van 27–39, DU van 65–77% naar
  86–93%, veel minder water buiten het gazon.
- **Lokaal herkende vlakken worden rechtgetrokken** (`Concept.straighten`),
  zodat ze niet meer uit tientallen kleine knikken bestaan.
- **Meerstraalsrotator per kop instelbaar**: `Catalog.rotatorModels` (MP1000,
  MP2000, MP3000, MP3500, MP Corner met worp- en sectorbereik),
  `fitRotator`, `rotatorModelOf`, `rotatorSetting`. Sproeier krijgt optioneel
  `model`; zonder model kiest de planner de kop bij worp en sproeihoek.
  Eigenschappenpaneel: kop kiezen, worp en sproeihoek binnen het bereik.
- **Grepen in de tekening** voor worp en begin/einde van de sproeihoek van
  de geselecteerde sproeier (alle cirkelsproeiers; rotators binnen het
  bereik van hun kop).
- Stuklijst: sproeikop volgt de gekozen kop (nieuw artikel `ROT-MPCORNER`);
  Excel-blad *Sproeiers* toont de instelling per kop.
- Testdata: rotators met vaste MP-kop, één ingeregeld met de stelschroef.

## 0.52.0

Klanten tekenen zelf, een installateur controleert.

- **Direct een tekening maken** (inlogpagina): een klant zonder account
  opent de beregeningsplanner, tekent de tuin (ook met een foto of PDF als
  ondergrond en de lokale herkenning) en dient de tekening in met naam,
  e-mail, telefoon, adres en een vraag (*"Kan dit gecontroleerd worden?"*).
  Tot het indienen blijft de tekening alleen in de browser. De knop staat
  er alleen als de organisatie (organisatiecode) dat toestaat; instelling
  in **Beheer → Instellingen → Toegang** (standaard aan).
- **Controle van plannen**: een plan heeft nu een status *Concept*, *Ter
  controle* of *Goedgekeurd*. Een plan van een klant is nooit meteen
  definitief: de klant biedt het **ter controle** aan (of dient het in
  zonder account) en een installateur **keurt het goed**. Een installateur
  keurt een eigen plan in één keer goed. Wijzigt een klant een goedgekeurd
  plan, dan gaat het opnieuw ter controle.
- **Offerte alleen uit een goedgekeurd plan** (ook op de server
  afgedwongen); een losse offerte zonder plan blijft mogelijk.
- **Plannenoverzicht**: kolom en filter *Status* (direct naar
  `plannen/?review=ter_controle`), teller *ter controle*, de vraag en
  contactgegevens van wie zonder account indiende, knoppen *Controleren in
  de planner* en *Goedkeuren*; Excel-export met status en vraag.
- Nieuw recht **Plannen goedkeuren** (standaard beheerder en installateur).
- Het bedrijf krijgt een e-mail bij elke nieuwe aanvraag (als de mailserver
  en het e-mailadres in het bedrijfsprofiel zijn ingesteld). De indiener
  krijgt bewust geen mail: anders kon iedereen via het formulier mail naar
  willekeurige adressen laten sturen.
- Bestaande plannen van beheerders en installateurs gelden als goedgekeurd.
- Testdata: een tekening die zonder account is ingediend, een plan van een
  klant ter controle en een nog niet goedgekeurd plan van een installateur.
- Database: migratie 20 (controlestatus op `plans`, index op
  `tenant_id, review_status, updated_at`), voor SQLite en PostgreSQL.
## 0.51.0

Nieuws: berichten van de organisatie en wat is nieuw in de app.

- **Pagina Nieuws** (`nieuws/`, voor iedereen; tegel op het dashboard en in
  de zijbalk, en in het gebruikersmenu): links de berichten van de
  organisatie, rechts *Wat is nieuw in de app*, een versielogboek in gewone
  taal (zonder technische details) per versie. Wat na het vorige bezoek kwam
  heeft het label **Nieuw**.
- **Melding**: een bolletje met het aantal bij Nieuws (zijbalk, tegel,
  gebruikersmenu), een stip op het rondje rechtsboven en een balk op het
  overzicht zolang er iets nieuws is. Na het openen van de pagina is alles
  gezien (bewaard bij het account, dus op elk toestel). Een nieuw account
  krijgt geen lange lijst, alleen de laatste versie.
- **Berichten plaatsen** (nieuw recht *Nieuwsberichten plaatsen*, standaard
  de beheerder; aan te zetten voor andere rollen in Beheer → Rollen): titel,
  tekst (alinea's, aanklikbare links), voor *alle medewerkers* of *iedereen,
  ook klanten*, bovenaan vastzetten, bewerken en verwijderen. Optioneel ook
  per e-mail naar de collega's (los per ontvanger, via de eigen mailserver);
  klanten krijgen nooit een e-mail. Plaatsen, wijzigen en verwijderen staan
  in het auditlog (zonder de tekst).
- **Versielogboek** in `frontend/nieuws/releases.js`, per punt te beperken
  tot rechten (een klant ziet alleen wat voor hem geldt). Een test eist dat
  de versie uit `package.json` erin staat: bij elke versie-bump een regel
  toevoegen. Gevuld met de versies 0.36.0 tot en met 0.51.0.
- API `GET /api/news`, `POST /api/news`, `PUT|DELETE /api/news/:id` (recht
  `nieuws`), `POST /api/news/seen`; `api/me` geeft `news` (aantal nieuwe
  items, uit een cache van 30 s per omgeving, dus geen extra query per
  pagina). Voorkeuren `newsSeenAt` en `seenRelease` op het account.
- Database: tabel `news` (migratie 19, SQLite en PostgreSQL, index op
  tenant + datum). Testdata: drie berichten van de testbeheerder, één ook
  voor klanten en vastgezet.

## 0.50.0

- **E-mailinstellingen in Beheer → Instellingen** (verplaatst uit Offertes →
  Bedrijfsgegevens). Nieuw: soort **Exchange Online-connector (op IP)**,
  zonder gebruikersnaam en wachtwoord, via poort 25 met verplichte STARTTLS.
  De SMTP-server wordt voorgesteld uit het domein van de afzender.
- Het scherm toont het **WAN-IP van de server** (het openbare uitgaande
  adres, niet dat van Cloudflare) om vrij te geven in de connector, met
  knoppen Kopiëren en Opnieuw bepalen, plus een korte handleiding voor
  Office 365. Vast in te stellen met `WAN_IP` in de Docker-omgeving.
- API: `/api/admin/mail[/test]` en `/api/admin/wan-ip` (alleen beheerders);
  het wachtwoord gaat nooit terug naar de browser.

## 0.49.0

- **Rollen aanpassen** (**Beheer → Rollen**): per rol de rechten aan- en
  uitzetten in één tabel, naam en omschrijving wijzigen en eigen rollen
  toevoegen (medewerker of klant, eventueel met de rechten van een bestaande
  rol als start). Wijzigingen gelden direct en staan in het auditlog. De
  beheerder houdt vaste rechten; een eigen rol kan pas weg als niemand hem
  meer heeft. Rollen gelden voor de hele organisatie, ook in test.
- **Nieuwe rol Planner**: plant werkorders in de agenda, stuurt de
  afspraaklink naar de klant en ziet werkorders en klantdossiers, zonder
  offertes, plannen of beheer. Een planner is zelf geen uitvoerder en ziet
  op het startscherm standaard de hele ploeg.
- **Nieuwe rechten** Planning en Uitvoerder: de planning en het inplannen
  of versturen van een afspraak vragen nu het recht Planning; wie als
  uitvoerder kan worden ingepland, bepaalt het recht Uitvoerder (standaard
  beheerder en installateur, zoals voorheen).
- Testdata: een testplanner (`<code>.planner`) die in de planning start.
- Database: migratie 18 (tabel `roles`, rol van een gebruiker is een vrije
  sleutel), voor SQLite en PostgreSQL.

## 0.48.0

Opdrachten uitbesteden aan andere organisaties op het platform.

- **Uitbesteden**: te veel werk? Een beheerder biedt een werkorder (status
  Nieuw of Gepland) aan bij één andere organisatie of bij iedereen die
  opdrachten ontvangt, met een bericht en eventueel een vergoeding. Vanuit de
  werkorder via menu ⋯ → *Uitbesteden aan andere organisatie*, en terug te
  zien in de nieuwe module **Uitbesteden**.
- **Aannemen of afwijzen**: de ontvangende organisatie ziet het aanbod in
  Uitbesteden → *Aangeboden aan ons* en neemt het aan of wijst het af (met
  toelichting). Wie aanneemt krijgt een eigen werkorder (eigen nummer) met de
  klantgegevens, werkstappen, zones en materialen. Bij een open aanbod krijgt
  de eerste die aanneemt de opdracht.
- **Alleen met opt-in**: versturen en ontvangen staan standaard uit en zet de
  beheerder van de organisatie aan in Beheer → Instellingen → Uitbesteden,
  met een werkgebied dat andere organisaties zien. Recht `uitbesteden`
  (beheerder). Een testomgeving werkt alleen met andere testomgevingen.
- **Alleen delen wat nodig is**: vóór het aannemen ziet een andere organisatie
  geen klantnaam, adres, contactgegevens of instructies, alleen omschrijving,
  plaats (postcodecijfers en woonplaats), planning, werkstappen met uren en
  materialen. Offerte, prijzen, foto's en de eigen ploeg gaan nooit mee. De
  uitbesteder ziet daarna alleen de voortgang (status, planning, afgevinkte
  stappen, opleverdatum), bij de werkorder en in Uitbesteden.
- Berichten per e-mail (als er een mailserver is ingesteld) bij een nieuw
  aanbod, aannemen en afwijzen; alles in het auditlog.
- Tabel `work_order_offers` (migratie 17, SQLite en PostgreSQL); testdata
  biedt een geplande werkorder aan andere testomgevingen aan.

## 0.47.0

- **Snellere database (Supabase)**: elk verzoek kost minder rondgangen naar
  de database en haalt alleen op wat het toont. Sessie, gebruiker en tenant
  in één query (was 4 per verzoek); de laatste-activiteit wordt alleen nog
  geschreven als die ouder is dan 5 minuten; scripts en stylesheets van een
  pagina controleren de sessie één keer per 30 seconden.
- **Plannen opslaan** leest het plan (met de achtergrondafbeelding van
  megabytes) niet meer terug uit de database; het plannenoverzicht haalt
  alleen de vlakken en aantallen op. Verwijderen leest het plan zonder
  achtergrond.
- **Eén query in plaats van twee of meer**: offerte en werkorder openen,
  klantportaal (was één query per werkorder), klantdossier (foto's per
  installatie), supporttoestemmingen in Hoofdbeheer, klantaccounts bij een
  offerte, het startscherm (foto's alleen van de klussen van die dag).
- **Geen overbodige kolommen**: gebruikersbeheer zonder wachtwoord-hashes,
  werkorderlijsten zonder versleutelde klantlink, controles bij bewerken
  zonder offerte-inhoud en handtekening.
- **Nieuwe indexen** (migratie 16, SQLite en PostgreSQL): historie en plannen
  per gebruiker, werkorders per uitvoerder en datum, verlopen sessies,
  impersonaties per gebruiker.
- **Nergens meer `SELECT *`**: elke query noemt de kolommen die hij nodig
  heeft, zodat een nieuwe (grote) kolom nooit ongemerkt meekomt.
- `test/queries.test.js` bewaakt het aantal queries, de hoeveelheid data en
  dat er geen `SELECT *` in de backend staat.

## 0.46.1

Beveiligingscontrole.

- **Limieten per bezoeker**: achter de Cloudflare-tunnel kwam elk verzoek van
  hetzelfde adres (de tunnel), dus golden de inloglimiet (10 per kwartier) en
  de limiet op openbare offerte- en afspraaklinks voor alle bezoekers samen:
  één persoon kon zo het inloggen voor iedereen blokkeren. De app gebruikt nu
  het echte bezoekers-IP (`CF-Connecting-IP`), maar alleen als het verzoek van
  een proxy in het eigen netwerk komt. Ook het auditlog toont nu dat adres.
- **Geen toegang tot het eigen netwerk**: de mailserver en de webshop die een
  organisatie invult, moeten een openbaar adres hebben. De naam wordt eerst
  opgezocht; interne adressen (LAN, Docker, Tailscale, localhost) worden
  geweigerd. De mail gaat naar het gecontroleerde adres, het certificaat
  blijft op naam gecontroleerd.
- **Verzoeken van andere subdomeinen** die iets wijzigen worden geweigerd
  (`Sec-Fetch-Site`); SameSite-cookies houden andere sites al buiten, maar
  niet de andere apps onder hetzelfde domein.

## 0.46.0

- **Geen tussenstappen meer**: een offerte die u vanuit het portaal, een
  klantdossier, een werkorder of de planner opent, verschijnt meteen (zonder
  eerst het overzicht), net als werkorders. De terugknop brengt u terug naar
  waar u vandaan kwam (bijv. **← Mijn portaal**, **← Klantdossiers**,
  **← Werkorders**), via de echte terugstap van de browser.
- **Startpagina zonder omweg**: met een startpagina in Mijn profiel gaat de
  app daar direct heen; het dashboard wordt niet eerst opgebouwd (de server
  zet de startpagina in de pagina, `shared/common.js` volgt hem meteen).
- **Sneller laden**: kopbalk, zijbalk en module delen één verzoek voor
  `api/me` en `api/config` (was twee tot vier per pagina); werkorders,
  offertes, profiel, portaal en klantdossier halen hun gegevens tegelijk op
  in plaats van na elkaar. Scripts en stylesheets met versienummer blijven
  in de browsercache (`immutable`), dus geen controle meer bij elke klik. De
  Excel-bibliotheek (bijna 1 MB) laadt pas bij de eerste export.
- Terug op de planning, het dashboard, het portaal of een dossier via de
  knop Terug: de gegevens worden opnieuw opgehaald, zodat een gewijzigde
  status meteen klopt.
- Planner: **Nieuw project** vraagt alleen nog om bevestiging als er
  werkelijk iets verloren kan gaan.

## 0.45.0

- **Rechtstreeks naar de werkorder**: een klik op een afspraak in de planning
  (of op het startscherm, in een klantdossier of vanuit een offerte) opent
  meteen de werkorder, zonder eerst het werkorderoverzicht te tonen. De
  terugknop gaat terug naar waar u vandaan kwam (bijv. **← Planning**).
- **Korte omschrijving op de afspraak**: elke afspraak in de planning toont
  wat er gedaan moet worden: de eerste regel van de instructies, anders de
  omvang (zones, sproeiers, m² gazon) en de uitvoeringsstappen uit de offerte
  (`Core.summary`, veld `summary` in de werkorder-API). Ook op het startscherm
  van de installateur als er geen instructies zijn.

## 0.44.0

- **Kleuren kiezen**: een hoofdbeheerder kiest onder **Hoofdbeheer → Kleuren**
  de hoofd-, actie- en accentkleur van de app, met een live voorbeeld. Het
  standaardthema geldt voor alle organisaties (ook inloggen en de openbare
  offerte- en afspraakpagina); een organisatie kan een eigen thema krijgen,
  dat haar testomgevingen volgen. Zonder keuze blijft de huisstijl van
  AquaTech Service, met een knop om die terug te zetten.
- **Leesbaar**: kleuren die te licht zijn voor witte tekst worden geweigerd
  (hoofdkleur minimaal 4,5:1, actiekleur 3:1); de donkere en lichte tinten
  worden afgeleid en blijven leesbaar.
- Vensters in Beheer/Hoofdbeheer en de hulp in de planner vallen niet meer
  half achter de zijbalk.
## 0.43.0

- **Mijn profiel** (nieuwe pagina `profiel/`, voor elke rol met een eigen
  account): naam, e-mailadres en telefoonnummer wijzigen, persoonlijke
  voorkeuren en het wachtwoord wijzigen op één plek. Bereikbaar via het
  gebruikersmenu rechtsboven en onderaan de zijbalk.
- **Gebruikersmenu in de kopbalk**: de losse knoppen *Wachtwoord* en
  *Uitloggen* zijn vervangen door een rondje met initialen (met de naam op
  een breed scherm) dat een menu opent met *Mijn profiel* en *Uitloggen*.
  Zo past de kopbalk ook op de telefoon.
- **Voorkeuren**: *Startpagina* (de app opent na het starten of inloggen in
  een gekozen module) en *kopie van verstuurde offertes en afspraken* (bcc
  naar het eigen e-mailadres).
- **Versienummer** staat niet meer in de kopbalk; beheerders zien het op
  Mijn profiel.
- Database: kolommen `email`, `phone` en `preferences` (JSON) op `users`
  (migratie 15, SQLite en PostgreSQL). API `GET`/`PUT /api/account/profile`;
  het logboek legt vast welke velden zijn gewijzigd, nooit de waarden.
  Beheerders zien e-mail en telefoon in het gebruikersoverzicht (API).
- Testdata: testaccounts hebben een e-mailadres, telefoonnummer en
  voorkeuren.

## 0.42.0

- **Startscherm voor installateurs**: het overzicht begint met *Vandaag*:
  de klussen die vandaag op je naam staan (ook elke werkdag van een
  meerdaagse klus, met "dag 2 van 3"), op starttijd. Per klus de tijd,
  status, klant, adres met **Route**, **Bellen**, de werkplekafspraken en
  instructies, de voortgang van de werkstappen en directe knoppen naar de
  werkorder en de foto's. Bladeren per dag, **Hele ploeg** toont de klussen
  van iedereen (standaard voor beheerders), en staat er niets gepland dan
  zie je de eerstvolgende klus. Gemaakt voor de telefoon.
- API `GET /api/my-day?date=JJJJ-MM-DD[&all=1]` (recht werkorders).

## 0.41.0

- **Zijbalk netjes uitgelijnd**: de lijn onder het logo in de zijbalk ligt nu
  precies op de onderkant van de kopbalk, op elke pagina (de hoogte van de
  kopbalk wordt gemeten, ook in de planner waar die hoger is).
- **Mijn portaal** heeft een eigen icoon (persoon) in plaats van het huisje,
  zodat het niet meer op een dubbel *Overzicht* lijkt.
- **Geen "Binnenkort" meer in de zijbalk**: de zijbalk toont alleen modules
  die er zijn en aan staan. Aan- en uitzetten gaat bij Beheer > Instellingen >
  *Modules* (geldt voor zijbalk en dashboard); geplande modules staan daar
  als "binnenkort" en zijn aan te zetten zodra ze klaar zijn.

## 0.40.0

- **Planning als agenda** met drie weergaven, te wisselen bovenaan:
  - **Dag**: de tijd verticaal en de installateurs naast elkaar als kolommen
    (Outlook-achtig), met een rode lijn op het huidige tijdstip. Op een
    telefoon scroll je horizontaal langs de installateurs.
  - **Werkweek**: de tijd verticaal en de dagen als kolommen; de kleur van
    een blok is de uitvoerder.
  - **Maand**: maandrooster met de klussen per dag (op een telefoon als
    gekleurde stippen); een dag aantikken opent de dagweergave.
- **Plannen op tijdstip**: sleep een werkorder naar een tijd (per kwartier)
  in de dag- of werkweekweergave. Heeft de werkorder nog geen eindtijd, dan
  volgt het blok meteen uit de **geplande uren uit de offerte** (de
  werkstappen); meer dan een werkdag van 8 uur wordt verdeeld over gelijke
  werkdagen (12 uur vanaf 08:00 = 2 dagen 08:00–14:00). Een blok dat al een
  eindtijd heeft houdt zijn lengte. Hetzelfde gebeurt in de werkorder als je
  een starttijd invult zonder eindtijd. De geplande uren staan op elk blok.
- Filter op uitvoerder (of *Mijn klussen*), weekend aan/uit, naar een datum
  springen, en Excel-export van wat in beeld is. De gekozen weergave wordt
  onthouden; op een telefoon begint de planning in de dagweergave.

## 0.39.0

- **Supabase is de standaard in productie**: de productie-compose gebruikt
  `DATABASE_URL_FILE`; de release-pipeline test elke versie ook tegen
  PostgreSQL voordat er een image komt. SQLite blijft de terugval zonder
  databaseverbinding (lokaal, tests, noodgeval) en het formaat van de
  versleutelde back-ups.
- **Back-up op commando**: `node src/backup.js create` maakt een versleutelde
  back-up, ook van PostgreSQL en terwijl de app draait. `update.sh` doet dat
  vóór elke update (bij Supabase in plaats van de oude kopie van
  `aquatech.db`) en zet bij een mislukte update alleen de image terug.

## 0.38.0

- **Foto's bij werkorders**: in de werkorder de kaart *Foto's van de
  installatie*. Op de telefoon opent **Foto maken** direct de camera,
  **Foto's kiezen** neemt er meerdere tegelijk uit de galerij (op de
  computer ook slepen). Per foto de fase (voor, tijdens, oplevering), een
  bijschrift en of de klant hem mag zien; vergroten met vorige/volgende (ook
  vegen). De browser verkleint foto's naar max. 2048 px (JPEG), waarmee ook
  EXIF en GPS-locatie wegvallen; de server haalt bij JPEG alsnog EXIF/XMP
  weg, accepteert alleen JPEG, PNG en WebP (op inhoud gecontroleerd) en
  max. 100 foto's per werkorder.
- **Veilige opslag**: foto en miniatuur staan versleuteld (AES-256-GCM, eigen
  van de hoofdsleutel afgeleide sleutel, tenant + foto-id als AAD) in de
  database (nieuwe tabel `work_order_photos`, migratie 14). Ze gaan dus mee
  in de versleutelde back-ups en in Supabase, en verdwijnen met het
  definitief wissen van de werkorder, de testomgeving of de tenant.
- **Klantdossiers** (nieuwe module, beheerder en installateur): per klant
  alle installaties met opleverdatum, wie heeft afgetekend en uitgevoerd,
  opmerkingen, ontwerp, zone-indeling, geplaatste materialen, foto's per
  fase en de offertes. Af te drukken als **opleverrapport** (PDF via het
  printvenster), met of zonder interne foto's. Overzicht van alle klanten
  met Excel-export. Een klant hoort bij een dossier via zijn klantaccount of,
  zonder account, via de naam op de werkorder.
- Voor het klantportaal: `GET /api/portal/photos/:id` geeft een klant alleen
  de zichtbaar gezette foto's van zijn eigen werkorders.
- Testdata: foto's bij de opgeleverde werkorder en de werkorder in
  uitvoering.

## 0.37.0

- **Klantportaal** (module *Mijn portaal*, voor klanten): één overzicht met
  wat er voor de klant klaarstaat (offertes om te beantwoorden, afspraken om
  te bevestigen), de werkzaamheden uit zijn offertes met datum, monteur en
  voortgang, zijn offertes en plannen, en de contactgegevens van het bedrijf.
- **Opleverdossier** per werkorder in het portaal: afgevinkte werkzaamheden,
  zones, gebruikte materialen (zonder prijzen), opmerkingen bij de
  oplevering en de foto's voor de klant; af te drukken of op te slaan als
  PDF. Interne gegevens (uren, werkinstructies, locatienotities, ploeg)
  blijven bij de medewerkers.
- Nieuw recht `portaal` voor de rol klant; API `/api/portal`.
- Testdata: een vierde testklant (`klant4`) met een ingeplande werkorder,
  zodat het portaal een afspraak toont.

## 0.36.0

- **Planning** (nieuwe module, tegel op het dashboard en in de zijbalk, voor beheerders en
  installateurs): weekagenda van alle werkorders, met een rij per uitvoerder
  en een kolom per dag (weekend optioneel). Inplannen of verplaatsen door een
  werkorder naar een dag en uitvoerder te slepen; op een telefoon tik je eerst
  op de werkorder en dan op de dag. Ernaast staan de werkorders die nog
  ingepland moeten worden en de klanten die om een ander moment vragen (met
  hun toelichting). Kerncijfers per week en export van de weekplanning naar
  Excel.
- **Werkorders** hebben naast datum en starttijd nu een eindtijd en een
  aantal **werkdagen** (een klus van meer dagen staat op elke werkdag,
  weekenden overgeslagen).
- **Afspraak bevestigen via een link**: vanuit de werkorder stuur je de klant
  de afspraak per e-mail (eigen mailserver), via het eigen mailprogramma of
  als gekopieerde link. Op de openbare pagina (zonder account, ook op de
  telefoon) ziet de klant datum, tijden, werkdagen en adres, zet hij de
  afspraak in zijn agenda (.ics) en **bevestigt** hij met zijn naam, of
  **vraagt hij een ander moment** met een toelichting. Tijdstip, naam en
  IP-adres worden vastgelegd en het bedrijf krijgt een e-mail. Verschuift de
  planning daarna, dan staat de afspraak weer op *wacht op klant* tot de
  klant het nieuwe moment bevestigt. Stand van de afspraak zichtbaar in de
  werkorder, het overzicht en de planning.
- Testdata: de werkorders hebben een afspraaklink en een reactie van de
  klant (bevestigd of ander moment gevraagd).

## 0.35.0

- **Zijbalk voor beheerders**: beheerders en hoofdbeheerders krijgen op elke
  pagina een vaste zijbalk met alle modules (Overzicht, Beregeningsplanner,
  Plannenoverzicht, Offertes, Werkorders, onder *Beheer* Beheer en
  Hoofdbeheer, en de geplande modules onder *Binnenkort*) in plaats van het
  tegeldashboard. De actieve module is gemarkeerd. Welke modules erin staan
  volgt uit de rechten en uit de modules die bij Beheer > Instellingen zijn
  uitgezet, net als bij de tegels; een nieuwe module in
  `dashboard/modules.js` verschijnt er vanzelf in.
- De zijbalk is in te klappen tot een smalle iconenbalk (per browser
  onthouden); de planner begint ingeklapt, zodat de tekening de ruimte houdt.
  Op een smal scherm (telefoon, kleine tablet) is de zijbalk een lade die
  opent met de menuknop links in de kopbalk; het projectmenu van de planner
  blijft rechts.
- Installateurs en klanten houden voorlopig het tegeldashboard.

## 0.34.0

- **Supabase (PostgreSQL) als database**: met `DATABASE_URL` (of
  `DATABASE_URL_FILE` als Docker-secret) gebruikt de app PostgreSQL, bijv.
  Supabase, in plaats van het SQLite-bestand. Zonder die instelling blijft
  alles zoals het was. Het schema in PostgreSQL is gelijk aan dat in SQLite
  (zelfde tabellen, kolommen, controles, foreign keys en indexen), in een
  eigen schema `aquatech` met row level security, zodat de REST-API van
  Supabase er niet bij kan. Verbinding altijd via TLS met controle van het
  certificaat (de root-CA van Supabase zit in de app).
- **Overstap één op één**: `node src/migrate-to-postgres.js` kopieert alle
  gegevens (tenants, gebruikers, sessies, plannen, historie, offertes,
  werkorders, instellingen, webshop, auditlog) ongewijzigd en controleert
  daarna per tabel het aantal rijen en een SHA-256 over alle waarden.
  Versleutelde geheimen blijven met dezelfde hoofdsleutel leesbaar en
  ingelogde gebruikers blijven ingelogd. Stappen in DOCS.md > *Database:
  Supabase (PostgreSQL)*.
- **Back-ups** werken ook met PostgreSQL: de versleutelde back-up is dan een
  kopie van alle rijen als SQLite-bestand (zelfde formaat, zelfde
  terugzetopdracht).
- De hele testsuite draait in CI ook tegen PostgreSQL.

## 0.33.0

- **Tenants verwijderen**: in **Hoofdbeheer** heeft elke live-tenant (behalve
  de hoofdtenant) een knop **Verwijderen**. Ter bevestiging typ je de
  tenantcode over. De tenant gaat definitief weg met al zijn testomgevingen,
  gebruikers, sessies, plannen, historie, offertes, werkorders, instellingen,
  webshopgegevens en auditlog; in de auditlog van de hoofdtenant blijft een
  regel *Tenant verwijderd* staan. Alleen voor hoofdbeheerders.
- **Back-ups verwijderen**: knop **Verwijderen** per back-up in **Beheer →
  Instellingen** (alleen hoofdbeheerders).
- **Geaccordeerde offertes** verwijderen of definitief wissen kan alleen na
  het overtypen van het offertenummer (ook in de API: `{ confirm: nummer }`).
  Verwijderen van een offerte komt nu ook in de auditlog.

## 0.32.0

- **Testdata vult alle features**: naast accounts, plannen en offertes nu ook
  klantlinks (verstuurd en bekeken), opties, digitaal akkoord met naam en
  handtekening, een afwijzing met reden, werkorders (gepland, in uitvoering,
  gereed) en een nepwebshop met prijzen. Klantlinks, reacties en werkorders
  lopen via dezelfde opslaglogica als in de app. Een test controleert dat
  elke tabel met gegevens per tenant testdata krijgt, zodat een nieuwe
  feature de testdata meeneemt.
- **Klantlink zichtbaar bij de offerte**: onder *Digitale offerte* staat het
  adres dat de klant krijgt, met **Kopiëren** en **Openen** (openen telt niet
  als bekeken door de klant). Een verstuurde offerte zonder link zegt dat
  ook; het verzendvenster toont de link die in de e-mail komt.

## 0.31.0

- **Eigen wachtwoord wijzigen**: knop *Wachtwoord* rechtsboven (naast
  Uitloggen) opent de pagina `wachtwoord`. Met het huidige wachtwoord ter
  controle; daarna is de gebruiker op zijn andere toestellen uitgelogd. Na
  10 foute pogingen 15 minuten geblokkeerd; vastgelegd in de auditlog.
- **Wachtwoord wijzigen na eerste aanmelding**: beheerders (Beheer →
  Gebruikers) en hoofdbeheerders (Hoofdbeheer → Gebruikers, nieuwe tenant)
  kunnen per gebruiker afdwingen dat die bij de volgende aanmelding eerst
  zelf een wachtwoord kiest. Standaard aan bij een nieuw account en bij een
  nieuw wachtwoord van een beheerder; aan/uit via de kolom *Nieuw ww.
  verplicht*. Zolang het aan staat toont elke pagina alleen het
  wachtwoordscherm en weigert de API de rest (`password_change_required`).
  Database-migratie 12 (`users.must_change_password`).

## 0.30.0

- **Gebruikers verwijderen**: knop *Verwijderen* (met bevestiging) in Beheer →
  Gebruikers en Hoofdbeheer → Gebruikers, API `DELETE /api/admin/users/:id`
  en `DELETE /api/platform/tenants/:id/users/:uid`. Plannen, offertes en
  werkorders gaan naar de systeemgebruiker *Verwijderde gebruiker*; sessies,
  supporttoestemmingen en impersonaties van het account verdwijnen. Niet
  mogelijk voor het eigen account, de laatste actieve beheerder van een tenant
  en de laatste actieve hoofdbeheerder. Auditregel `gebruiker_verwijderd`.

## 0.29.2

- **Hoofdbeheerder kon niet inloggen** als er nog een organisatiecode in het
  inlogveld stond (de browser onthoudt de code van de vorige inlog) of als
  de naam van de hoofdtenant werd ingevuld. Hoofdbeheerders horen bij de
  hoofdtenant en loggen nu in met elke organisatiecode; gewone gebruikers
  blijven gebonden aan de code van hun eigen organisatie.

## 0.29.1

- **Home Assistant-verpakking verwijderd**: `config.yaml`, `apparmor.txt`,
  `icon.png`, `logo.png` en `repository.yaml` zijn weg. De app draait alleen
  nog als Docker-container (Cloudflare-tunnel, automatische uitrol via CI/CD).
- Versiecheck (`scripts/check_version.py`, workflow `version.yml`) kijkt alleen
  nog naar `backend/package.json`.

## 0.29.0

- **Webshopkoppeling** (prototype, WooCommerce): in **Beheer → Webshop**
  koppelt een beheerder de webshop van de organisatie. De stuklijst in de
  planner, de Excel-export en nieuwe offertes gebruiken dan de naam, prijs
  (omgerekend naar excl. btw), het artikelnummer en de link uit de webshop;
  artikelen zonder koppeling houden de indicatieve prijs.
  - Ophalen via de openbare Store API (geen sleutels) of de REST API v3 met
    alleen-lezen sleutels; de sleutels staan versleuteld in de instellingen.
  - Koppelen op SKU gelijk aan de artikelcode, het productveld
    `aquatech_code` of een handmatige lijst `ARTIKELCODE=SKU`. Het tabblad
    toont welke artikelen nog niet gekoppeld zijn.
  - Per organisatie en per omgeving (een testomgeving heeft een eigen
    koppeling); producten in de nieuwe tabel `shop_products` (migratie 11).
  - In een offerte komt de materiaalopslag niet op regels met een
    webshopprijs (die is al een verkoopprijs); overige regels houden de opslag.
  - Alleen openbare https-adressen; mislukt het ophalen, dan blijven de
    vorige producten staan en ziet de beheerder de foutmelding.

## 0.28.0

- **Werkorders** (nieuwe module, tegel op het dashboard, voor beheerders en
  installateurs; een klant ziet ze niet): van een offerte met status
  **Akkoord** maak je een werkorder, in de offerte met de knop **Werkorder
  maken** of in de module via **Nieuwe werkorder uit offerte**.
- De werkorder bevat het uitvoeringsplan: werkstappen per fase
  (voorbereiding, uitvoering, oplevering) in een logische volgorde, met de
  uren uit de offerte en een kolom voor de werkelijke uren; de zone-indeling
  uit het plan (onderdelen, debiet, leidinglengte en druk per zone); en de
  materiaallijst zonder prijzen om af te vinken bij het verzamelen.
- Inplannen met datum en starttijd, toewijzen aan een uitvoerder, ploeg,
  werkinstructies, bijzonderheden van de locatie en een opleverblok. De
  status volgt vanzelf (datum = gepland, eerste afgevinkte stap = in
  uitvoering) en is ook met de hand te zetten.
- Werkbon als PDF (afdrukversie met afvinkvakjes en aftekenregels) en Excel
  (werkorder, zones en materialen op aparte tabbladen); het overzicht is ook
  naar Excel te exporteren. Nummering `WO-<jaar>-0001` per omgeving.
- Opties uit de offerte die de klant niet heeft gekozen, komen niet in de
  werkorder (materialen en werkstappen).

## 0.27.0

- **Hoofdbeheerders aanmaken**: in Hoofdbeheer opent de knop
  *Hoofdbeheerders* de gebruikers van de hoofdtenant. Daar kun je een nieuwe
  gebruiker meteen hoofdbeheerder maken, of een bestaand account
  hoofdbeheerder maken of dat weer intrekken. Hoofdbeheerders horen altijd
  bij de hoofdtenant en hebben de rol beheerder.
- Alleen een hoofdbeheerder kan een hoofdbeheerder wijzigen, uitschakelen,
  een nieuw wachtwoord geven of uitloggen; een gewone beheerder van de
  hoofdtenant niet meer. De laatste actieve hoofdbeheerder kan niet worden
  ingetrokken of uitgeschakeld.
- **Nieuwe tenant: duidelijke velden voor de eerste beheerder**. Volledige
  naam, gebruikersnaam en wachtwoord staan apart met uitleg eronder; de
  gebruikersnaam vult zich vanuit de naam ("Piet Groen" → `piet.groen`) en
  wordt vanzelf in kleine letters gezet. Een fout geeft een melding die zegt
  wat er mis is, in plaats van de browsermelding "Gebruik de gevraagde
  notatie". Onder het formulier staat waarmee de beheerder inlogt
  (organisatiecode + gebruikersnaam).
- Zelfde uitleg bij het toevoegen van gebruikers in Hoofdbeheer en Beheer.

## 0.26.0

- **Digitale offerte**: per offerte een persoonlijke link (*Digitale offerte*
  in de editor). De klant opent die zonder account, bekijkt de offerte, kiest
  eventuele opties en geeft akkoord met zijn naam, een handtekening (muis,
  vinger of pen) en een vinkje voor de voorwaarden, of wijst af met een reden.
  - Vastgelegd: naam, tijdstip, IP-adres, browser, handtekening, gekozen
    opties, totaalbedrag en een kenmerk (SHA-256) van de geaccordeerde inhoud.
    Daarna ligt de offerte vast; wijzigen kan alleen via een kopie.
  - Je ziet of en hoe vaak de klant de offerte heeft geopend; de link is in
    te trekken. Alleen een hash van het token staat doorzoekbaar in de
    database, het token zelf versleuteld.
  - **Opties**: zet een regel op *Optie* of *Optie (aan)*; de klant vinkt die
    zelf aan of uit en het totaal rekent mee (ook in PDF en Excel).
- **E-mail** via de eigen SMTP-server (Bedrijfsgegevens → E-mail, wachtwoord
  versleuteld): offerte versturen met een knop naar de digitale offerte,
  bevestiging naar de klant na een akkoord en een bericht naar het bedrijf.
  Zonder mailserver opent *Versturen* het bericht in je eigen mailprogramma.
- Klantaccounts geven in *Mijn offertes* op dezelfde manier akkoord (naam,
  handtekening, voorwaarden).

## 0.25.0

- **Gebruikersnamen uniek per organisatie**: de tenant wordt niet meer uit de
  gebruikersnaam afgeleid. Dezelfde naam (bijvoorbeeld een voornaam) kan in
  meerdere organisaties bestaan; elke gebruiker heeft zijn eigen id.
- **Organisatiecode bij het inloggen**: de inlogpagina vraagt de code van de
  organisatie en onthoudt die in de browser; `login?org=<code>` vult hem in.
  Leeg = de hoofdorganisatie (hoofdbeheerders). De code van een testomgeving
  werkt ook. Beheer → Gebruikers toont de code en een inloglink; de Excel met
  testaccounts heeft een kolom Organisatiecode.
- Blokkade na tien mislukte pogingen geldt per organisatie en gebruikersnaam.
- Migratie 8 verwijdert de platformbrede index op gebruikersnaam; bestaande
  accounts blijven ongewijzigd (ze waren al uniek per tenant).

## 0.24.0

- **Inloggen als een gebruiker (impersonatie)** voor de hoofdbeheerder:
  vanuit Hoofdbeheer → Gebruikers werk je tijdelijk met de rol en rechten
  van een gebruiker. In een testomgeving zonder goedkeuring; in live alleen
  met toestemming die de gebruiker zelf geeft op het dashboard (*Support op
  afstand*, voor 1 uur tot 3 dagen, altijd in te trekken).
- Tijdens een impersonatie staat onderin elke pagina een rode balk met
  **Terug naar eigen account** (één klik); hoogstens 8 uur, en uitloggen
  stopt hem ook.
- Auditlog: start, einde (met reden: gestopt, verlopen, toestemming
  ingetrokken) en elke actie tijdens een impersonatie met de naam van de
  hoofdbeheerder. De gebruiker ziet zelf wie er heeft meegekeken.

## 0.23.0

- **Testomgeving vullen met testdata** (Hoofdbeheer): één knop maakt
  testaccounts voor elke rol (beheerder, twee installateurs, drie klanten)
  met één gedeeld wachtwoord, zeven nepklanten met een volledig getekende
  tuin (gebieden, sproeiers, systeemelementen en zones) en vijf offertes in
  alle statussen. De inloggegevens zijn als Excel te downloaden. Alleen in
  testomgevingen; wat er stond wordt eerst gewist.
- Testaccounts horen bij de testomgeving zelf: inloggen brengt je direct
  daar, een testbeheerder beheert alleen de testaccounts en Leegmaken of
  Verwijderen ruimt ze op. In Hoofdbeheer heeft elke testomgeving een knop
  **Testaccounts**.
- Offertes in een testomgeving kun je aan klantaccounts van live én van de
  testomgeving koppelen.

## 0.22.0

- **Rollen**: hoofdbeheerder, beheerder, installateur en klant. Elke rol
  ziet op het dashboard alleen wat erbij hoort en de API controleert de
  rechten zelf (één bron: `frontend/shared/roles.js`).
  - Hoofdbeheerder: alles, in elke tenant.
  - Beheerder: alles binnen de eigen organisatie.
  - Installateur: plannen en offertes van de hele organisatie, zonder
    gebruikers, instellingen of historie.
  - Klant: alleen de eigen plannen en de offertes die voor hem klaarstaan.
- Bestaande gebruikers worden installateur, gasten worden klant (migratie
  van de database; de oude rolnaam *gebruiker* wordt nog geaccepteerd).
- **Mijn offertes** voor klanten: een offerte koppel je bij *Klantaccount*
  aan een klant; vanaf de status Verzonden ziet de klant de offerte als
  document en kan hij akkoord geven of afwijzen (in het auditlog).
- Plannenoverzicht en offertes: installateurs zien alle plannen en offertes
  van de organisatie; de knop Offerte maken alleen voor wie offertes opstelt.

## 0.21.0

- **Offertes** (nieuwe module): een offerte opbouwen uit een
  beregeningsplan. De stuklijst wordt als materiaalregels overgenomen (met
  instelbare opslag) en de arbeid wordt uit het plan geschat (sproeiers,
  sleuven en leidingen, ventielen, besturing, druppelirrigatie,
  wateraansluiting, inregelen) tegen het uurtarief. Prijzen, aantallen,
  btw-tarief per regel, korting, klantgegevens en teksten zijn aan te passen
  en worden automatisch bewaard. Export als PDF (afdrukversie in huisstijl)
  en als Excel met formules; het overzicht van alle offertes ook naar Excel.
- Vast offertenummer per jaar en tenant, status (concept, verzonden,
  akkoord, afgewezen) en herkenbaar verlopen offertes.
- Bedrijfsgegevens, uurtarief, opslag, voorrijkosten en standaardteksten voor
  offertes per tenant (beheerders, in de module Offertes).
- Knop **Offerte maken** in de planner (stap Stuklijst & export) en in het
  plannenoverzicht.

## 0.20.0

- **Multitenant.** De app kan meerdere klanten (tenants) bedienen, elk met
  eigen gebruikers, plannen, historie en instellingen die de andere tenants
  niet zien. Inloggen blijft op dezelfde URL met gebruikersnaam en
  wachtwoord: de tenant volgt uit het account (gebruikersnamen zijn daarom
  uniek over het hele platform).
- **Hoofdbeheer** (nieuwe module, alleen voor hoofdbeheerders): alle tenants
  met gebruikers, plannen en laatste activiteit; tenants aanmaken (met
  meteen de eerste beheerder), hernoemen, uit- en inschakelen, gebruikers van
  een tenant beheren, een tenant openen om erin te werken, en het overzicht
  exporteren naar Excel. De bestaande beheerders van Aquatech zijn
  hoofdbeheerder geworden; de hoofdtenant kan niet worden uitgeschakeld en de
  laatste hoofdbeheerder blijft actief.
- **Testomgevingen naast live.** Per tenant een of meer testomgevingen met
  eigen plannen, historie en instellingen (bij het aanmaken gekopieerd, en
  desgewenst de huidige plannen). Wisselen gaat via de keuzelijst rechtsboven
  zonder opnieuw in te loggen of een andere URL. In een testomgeving staat
  een oranje streep en label in de kopbalk, en heeft de planner een eigen
  lokaal concept. Testomgevingen zijn leeg te maken of te verwijderen; live
  blijft ongemoeid. Beheerders van een tenant kunnen in de eigen
  testomgevingen werken, gewone gebruikers alleen in live.
- Limieten voor automatisch herkennen (per dag en per IP) gelden nu per
  tenant en per omgeving.
- Sessies horen bij de eigen tenant van het account; het auditlog en de
  bewaartermijnen werken per tenant en per testomgeving. Versleutelde
  geheimen worden bij een nieuwe testomgeving opnieuw versleuteld
  overgenomen.
- Back-ups (de hele database, alle tenants) zijn alleen voor
  hoofdbeheerders, of met de toegangscode van de hoofdtenant. Plan
  definitief wissen werkt in de actieve omgeving.
## 0.19.1

- Home Assistant-add-on: stoppen en herstarten gebeurt weer netjes. Sinds
  de app als gewone gebruiker draait, mocht het init-proces het stopsignaal
  niet doorgeven (AppArmor-profiel miste `capability kill`).

## 0.19.0

- **Versleutelde back-ups**: elke dag een kopie van de database in
  `/data/backups` (of `BACKUP_DIR`), versleuteld met een van de hoofdsleutel
  afgeleide sleutel. Standaard 14 dagen bewaard (Beheer → Instellingen →
  Back-ups, 0 = uit). Daar kun je ook direct een back-up maken en een
  back-up downloaden om elders te bewaren. Terugzetten:
  `node src/backup.js decrypt <back-up> <aquatech.db>`.
- **Plan definitief wissen** (AVG-verzoek, alleen beheerders, in het
  Plannenoverzicht): verwijdert het plan en haalt klant, adres, kopieën en
  IP-adressen uit de historie. Komt in het auditlog.

## 0.17.0

- **Na een update altijd de nieuwe opmaak.** Op de iPhone kon de browser (of
  de Cloudflare-tunnel) na een update nog een oude stylesheet gebruiken bij de
  nieuwe pagina, waardoor de kopbalk rommelig werd (losse "Menu"/✕-knop en
  afgesneden knoppen rechtsboven). De server zet nu de appversie achter elke
  stylesheet en elk script (`css/app.css?v=0.17.0`), zodat elke update ook
  nieuwe CSS en JS afdwingt.

## 0.16.0

Beveiliging van de opslag (getoetst aan OWASP ASVS niveau 2 en de AVG).

- **Geheimen versleuteld**: de API-sleutel en de toegangscode staan
  versleuteld in de database (AES-256-GCM). De hoofdsleutel staat in
  `/data/master-key` of, beter, los van de data in `AQUATECH_MASTER_KEY_FILE`
  (Docker-secret). Bestaande waarden worden bij de start vanzelf versleuteld.
  **Bewaar een kopie van de hoofdsleutel**: zonder die sleutel zijn de
  opgeslagen geheimen onbruikbaar.
- **Sessies op de server**: uitloggen, een nieuw wachtwoord, uitschakelen of
  *Uitloggen* bij een gebruiker (Beheer → Gebruikers) beëindigt een sessie
  meteen, ook op andere toestellen. Een sessie verloopt na 14 dagen zonder
  gebruik en uiterlijk na 30 dagen (instelbaar). De cookie bevat alleen een
  willekeurig token; de database alleen de hash daarvan. **Iedereen moet na
  deze update één keer opnieuw inloggen.**
- **Wachtwoorden**: minimaal 12 tekens, niet de gebruikersnaam en geen
  voorspelbare woorden (zoals *wachtwoord2024*). Sterkere hash (scrypt
  volgens OWASP); bestaande wachtwoorden blijven werken en krijgen bij de
  volgende inlog de sterkere hash. Na 10 mislukte pogingen is een account
  een kwartier geblokkeerd.
- **Installatiecode**: het eerste beheerdersaccount aanmaken kan alleen met
  de eenmalige code uit het serverlog (`docker compose logs aquatech`) of
  met de toegangscode, zodat niemand anders het beheer kan overnemen.
- **Auditlog** (Beheer → Auditlog): inloggen (ook mislukt), uitloggen,
  gebruikers- en instellingswijzigingen. Nooit wachtwoorden of sleutels.
- **Bewaartermijnen (AVG)**: IP-adressen in historie en auditlog worden na
  90 dagen gewist, auditregels na 365 dagen verwijderd (instelbaar onder
  Beheer → Instellingen).
- **Database**: alleen leesbaar voor de app (rechten 0600), verwijderde
  gegevens worden overschreven (`secure_delete`), integriteitscontrole bij de
  start. De server draait in de container als gewone gebruiker (niet root).
- **Beveiligingsheaders**: Content-Security-Policy, geen inbedden in frames,
  HSTS via https en geen caching van API-antwoorden.

## 0.15.0

- **Eerste beheerder in de browser.** Zolang er geen beheerdersaccount is,
  toont de app bij het openen het scherm *Welkom bij Aquatech* om het eerste
  beheerdersaccount (naam, gebruikersnaam, wachtwoord) aan te maken. Je bent
  daarna meteen ingelogd en het scherm verschijnt niet meer. De
  automatisch aangemaakte toegangscode in het log is vervallen.
- **Inloggen is standaard verplicht**: iedereen logt in met een eigen
  account. Gasten zonder inloggen kun je weer toestaan onder **Beheer →
  Instellingen**. De toegangscode blijft optioneel bestaan.
- De laatste actieve beheerder kan niet meer worden uitgeschakeld of
  gebruiker gemaakt (anders zou iedereen een nieuwe eerste beheerder kunnen
  aanmaken).
- **Los van Home Assistant**: geen ingress en geen HA-paneel meer (dat gaf
  automatisch beheerdersrechten), geen app-opties (`access_code`,
  `anthropic_api_key`, `ai_daily_limit`) meer; alles staat in de app onder
  Beheer → Instellingen of als omgevingsvariabele in Docker. De versie staat
  nu in `package.json`. De Home Assistant-verpakking blijft tijdelijk alleen
  bestaan zodat de huidige installatie deze update nog krijgt.

## 0.14.0

- **Nieuw: Plannenoverzicht** (tegel op het dashboard en *Alle plannen →*
  bij Mijn plannen): alle plannen in één tabel met projectnaam, klant, adres,
  gazon- en totale oppervlakte, vlakken, sproeiers, zones en datums.
  Sorteren door op een kolomkop te klikken, zoeken, totalen bovenaan en
  export naar Excel. Klik op een plan voor de details of open het in de
  planner.
  - Gebruikers zien alleen hun eigen plannen.
  - Beheerders zien de plannen van iedereen, met de gebruiker, het aantal
    aanvragen, een filter per gebruiker, eventueel ook verwijderde plannen,
    en per plan de tijdlijn uit de historie.

## 0.13.0

- **Mobiele navigatie verbeterd**: geen horizontaal scrollen meer op de
  telefoon.
  - Beregeningsplanner: Voorbeeld, Nieuw, Mijn plannen, Openen, Opslaan,
    Help en Naar het overzicht staan in een **hamburgermenu** (☰) dat als
    lade van rechts uitschuift; ongedaan maken/opnieuw blijven direct
    bereikbaar in de kopbalk. Ook op tablets (tot 1100 px) wordt het menu
    gebruikt, zodat de kopbalk niet meer over meerdere regels loopt.
  - Gereedschapsbalk op de telefoon: alleen iconen, en raster en lagen in
    een uitklapmenu **Lagen ▾**.
  - Dashboard en Beheer: compacte kopbalk (naam ingekort) en de tabbladen
    van Beheer in twee rijen.

## 0.12.0

- **Nieuw: instellingenscherm** onder **Beheer → Instellingen** (alleen
  beheerders), los van de Home Assistant-configuratie:
  - API-sleutel van Anthropic invullen, testen (zonder kosten) en
    verwijderen; de sleutel gaat nooit terug naar de browser, je ziet alleen
    de laatste 4 tekens;
  - AI-herkenning aan/uit, maximum per dag en per uur per IP-adres;
  - toegangscode wijzigen of verwijderen (andere toestellen worden
    uitgelogd, jij niet);
  - modules op het dashboard aan- of uitzetten.
  Alles staat in de database en werkt meteen, zonder herstart. De HA-opties
  `access_code`, `anthropic_api_key` en `ai_daily_limit` blijven werken als
  startwaarden zolang er in het scherm niets is opgeslagen.
- **Klaar voor een losse Docker-server** zonder Home Assistant:
  `docker compose up -d --build` (zie *Losse server (Docker)* in de
  documentatie). Bij de eerste start zonder toegangscode en zonder
  beheerdersaccount maakt de app zelf een toegangscode aan en zet die in het
  log. De container stopt netjes bij `docker stop` en heeft een healthcheck.

## 0.11.0

- **Nieuw: historie van aanvragen en gebruikers met rollen.** De app heeft
  nu een database (`/data/aquatech.db`, in de HA-back-ups).
  - **Mijn plannen**: elk plan wordt automatisch ook op de server bewaard.
    Gebruikers zien alleen hun eigen plannen (in de planner en op het
    dashboard).
  - **Beheer** (nieuwe module, alleen voor beheerders): historie van alle
    aanvragen met zoeken, filteren, details en Excel-export; overzicht van
    alle plannen; gebruikers aanmaken, rol wijzigen, wachtwoord resetten en
    uitschakelen.
  - Rollen: het HA-paneel en inloggen met de toegangscode zijn beheerder;
    accounts krijgen de rol beheerder of gebruiker. Zonder toegangscode
    krijgt elke browser een eigen anonieme gast.
  - Inlogpagina ook op `.../login`, met gebruikersnaam en wachtwoord (of
    alleen de toegangscode, zoals voorheen). Bestaande inlogs blijven geldig.
- Opgelost: automatisch herkennen vanuit de planner (`beregening/`) riep de
  API op het verkeerde pad aan; de API is nu ook onder elke module
  bereikbaar.
## 0.10.0

- **Huisstijl van AquaTech Service** (aquatechservice.nl) in het dashboard,
  de beregeningsplanner en de inlogpagina: het AquaTech Service-logo in de
  bovenbalk (op de telefoon alleen het schild), navy balken en kopteksten,
  groene knoppen en het lettertype Montserrat (lokaal meegeleverd, werkt ook
  zonder internet en onder Home Assistant).
- Nieuw icoon en logo in Home Assistant met het schild van het logo.

## 0.9.0

- **Nieuw: Aquatech-dashboard als startpagina.** De app is nu de basis van
  een groter pakket: de startpagina toont tegels per module. De
  beregeningsplanner is de eerste module; *Planning* en *Voorraadbeheer*
  staan er al als "binnenkort".
- De planner staat nu op `beregening/` (bijv.
  `https://aquatech.den-hollander.com/beregening/`) en heeft linksboven een
  knop **Overzicht** terug naar het dashboard. Het opgeslagen plan blijft
  gewoon staan; het dashboard toont het onder *Verder werken*.
- Het HA-zijpaneel heet nu **Aquatech** (was *Beregening*); de app heet
  in de add-on-winkel ook *Aquatech*. De slug blijft gelijk, dus de
  Cloudflare-tunnel en instellingen werken ongewijzigd.

## 0.8.0

- **Intekenen op telefoon en tablet**:
  - tik om een hoekpunt, element of sproeier te plaatsen (bij loslaten);
    met één vinger slepen verschuift het plan, knijpen met twee vingers
    zoomt — een pinch zet nooit per ongeluk een punt neer;
  - tekenbalk boven het plan met **Punt terug**, **Vorm sluiten** en
    **Stoppen/Annuleren** (vervangt Backspace, Enter en Esc);
  - ruimere raakzones voor hoekpunten, randmiddens, sproeiers en het
    eerste punt (vangzone zichtbaar), grotere grepen en de maat naast in
    plaats van onder de vinger;
  - geen 'ghost click' meer op het paneel dat na een tik verschijnt.
- **Mobiele lay-out**: plan bovenaan, stappenpaneel eronder dat inklapt
  tijdens tekenen (knop **▾ Paneel**), compacte, scrollbare top- en
  gereedschapsbalk en grotere knoppen bij touchbediening.
- Eigenschappen zijn op tablet en telefoon nu bereikbaar als zwevende kaart
  zodra iets geselecteerd is (voorheen verborgen onder 1100 px breed).

## 0.7.0

- **Lokale herkenning werkt nu ook op foto's en scans van getekende plannen**
  (potlood, stift), niet alleen op digitale plannen:
  - ongelijke belichting, grijs of getint papier en een kleurzweem worden
    gecorrigeerd (papierkleur over het hele vel geschat); het papier zelf
    wordt niet meer als één groot "droog te houden" vlak gezien;
  - bleke potloodkleuren en arcering worden uitgemiddeld; zwarte lijnen en
    tekst tellen daarbij niet mee en worden geen grijze "verharding" meer;
  - geel (terras, vlonder) wordt verharding, blauwgroen wordt heesters;
  - een gazon midden in de verharding valt niet meer binnen het
    verhardingsvlak (grote gaten blijven open);
  - titelblok, legenda en de rand van de foto (tafel) worden genegeerd.
- **Schaal**: staat er geen maat met maatlijn op het plan, dan vraagt de
  planner hoe breed de tuin is, in plaats van aan te nemen dat het hele vel
  30 m breed is (leeg laten = tuin 10 m). Bij een PDF met "schaal 1:N" wordt
  de schaal exact uit het paginaformaat berekend.
- Maten lezen is betrouwbaarder: een maatlijn die de tekst raakt wordt goed
  gemeten, "10,00 m" met lage OCR-betrouwbaarheid telt mee, en een gemiste
  komma ("100 m") of "1:100" gelezen als "1100" geeft geen verkeerde schaal
  meer.
- Samen met het lezen van labels uit 0.6.0: de getekende omtrek van een vlak
  (lijn zonder vulling) wordt nog steeds genegeerd, ook met de nieuwe
  sleutelgatsnede.

## 0.6.0

- **Labels lezen, ook handgeschreven.** Woorden als *gras*, *gazon*, *terras*,
  *border*, *beplanting*, *haag*, *vijver*, *grind*, *woning*, *plantenbak*
  (Nederlands, Duits en Engels; kleine schrijf- en leesfouten mogen) bepalen
  het soort vlak waarin ze staan:
  - in een gekleurd plan gaat het label vóór de kleur (een groen vlak met
    "border" wordt beplanting);
  - in een lijntekening of handschets wordt het vlak dat door de getekende
    lijnen rond het label wordt omsloten automatisch uitgetrokken.
- Tekstherkenning met Nederlandse taaldata, in meerdere rondes (normaal en
  zwart-wit, recht en gedraaid) voor betere resultaten bij handschrift.
- Bij een schaal uit één maat toont de planner welke maat gebruikt is en de
  resulterende planbreedte, zodat een verkeerde lezing direct opvalt.

## 0.5.0

- **Plan herkennen zonder AI.** "Plan laden en concept maken" werkt nu ook
  zonder API-sleutel, volledig in de browser en gratis:
  - vlakken worden op kleur herkend (groen = gazon, donkergroen = haag,
    bruin/roze = beplanting, grijs/beige = bebouwing en verharding,
    blauw = water), gaten door tekst en lijnen worden gedicht;
  - de schaal wordt gelezen uit maten met een maatlijn ("12,00 m", "450 cm",
    "8500" mm), ook verticale maten, via lokale tekstherkenning.
- Met een API-sleutel kies je in stap 1 tussen **Lokaal** en **AI**. Lukt de
  AI niet (bijv. geen tegoed), dan wordt automatisch lokaal herkend.

## 0.4.2

- Is het API-tegoed bij Anthropic op, dan meldt "Plan laden en concept maken"
  dat nu duidelijk (in plaats van "Herkennen mislukt (502)").

## 0.4.1

- **Duidelijkere foutmelding bij "Herkennen mislukt".** De melding van de
  AI-dienst wordt nu volledig getoond en in de log gezet.
- Weigert de AI-dienst het verzoek met de fallback-optie, dan probeert de app
  het automatisch één keer zonder.

## 0.4.0

- **Beregeningsmethode kiezen aan het begin (stap 1)** voor borders, hagen en
  plantenbakken: **druppelslang**, **druppelaars** (losse druppelaar per plant
  of pot via microbuis), **sproeiers** (pop-up 30 cm boven de beplanting) of
  **geen beregening**. Ook het sproeiertype voor het gazon kies je hier.
- **Per vlak afwijken** in het eigenschappenpaneel ("Beregening"), met
  hoeveelheden en gift (mm/u) per vlak.
- **Nieuw vlaktype Plantenbak** (standaard druppelaars); ook herkend bij
  "Plan laden en concept maken".
- Elke methode krijgt eigen zones (andere neerslag), het beregeningsschema
  rekent de looptijd per methode en de stuklijst bevat de juiste onderdelen
  (druppelaars, microbuis, aanvoerbuis, ponstang, 30 cm-sproeierhuizen).

## 0.3.0

- **Plan laden en concept maken.** Laad een tuinontwerp, plattegrond, schets
  of luchtfoto (JPG, PNG of **PDF**) en de planner leest zelf de schaal (via
  een maatlijn of schaalstok) en de vlakken: gazon, borders, hagen, woning,
  terras en bestrating. Daarna worden automatisch de wateraansluiting,
  besturing en ventielkast geplaatst, sproeiers verdeeld, zones ingedeeld en
  leidingen berekend. Alles is daarna gewoon aan te passen.
  Vereist een API-sleutel van Anthropic in de app-configuratie
  (`anthropic_api_key`); met `ai_daily_limit` (standaard 30) begrens je het
  aantal analyses per dag.
- **Toverstaf** (stap 2): klik midden in een vlak op het plan en de rand wordt
  op kleur automatisch uitgetrokken. Werkt ook zonder API-sleutel en offline.
- **Slimmere sproeierkeuze:** de worpwijdte wordt gekozen door meerdere
  varianten door te rekenen met de neerslagsimulatie (minder koppen, weinig
  water buiten het gazon, gelijkmatige verdeling).

## 0.2.2

- **Alle termen in correct Nederlands.** Onder meer *turbinesproeier* (was
  turbineregner), *meerstraalsrotator*, *sproeihoek* (was boog),
  *sproeibereik*, *neerslagkaart*, *gelijkmatigheid*, *beregeningscomputer*
  en *knelkoppeling*; uitvoeringsniveaus heten nu **Basis / Standaard /
  Premium**.
- Eenheden in Nederlandse notatie: m³/u, l/u en mm/u, en een decimale komma
  in maten, labels en de Excel-export.

## 0.2.1

- **Toegangscode is optioneel.** Zonder `access_code` is de planner via
  https://aquatech.den-hollander.com zonder inloggen te gebruiken. Vul je een
  code in, dan is inloggen buiten Home Assistant om weer verplicht.

## 0.2.0

- **Bereikbaar via https://aquatech.den-hollander.com** (Cloudflare-tunnel).
  De app luistert daarvoor ook op poort 3300.
- **Inloggen met een toegangscode** buiten Home Assistant om. Stel de code in
  onder **Configuratie** (`access_code`). Via het HA-zijpaneel is geen code
  nodig. Het toestel onthoudt de inlog een jaar; wijzig je de code, dan moeten
  alle toestellen opnieuw inloggen.

## 0.1.0

- **Eerste versie als Home Assistant-add-on.** De planner is te openen via het
  **Beregening**-paneel in het HA-zijmenu (ingress).
- Stappen: ondergrond & schaal, gebieden tekenen, systeemelementen,
  sproeiers (automatisch of handmatig, met neerslagsimulatie), zones &
  leidingen (drukverlies) en stuklijst met export naar Excel.
- Projecten worden in de browser bewaard; met **Opslaan/Openen** werk je met
  een projectbestand.
