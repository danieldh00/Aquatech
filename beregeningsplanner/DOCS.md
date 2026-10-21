# Aquatech

Dashboard met modules. De eerste module is de **beregeningsplanner**:
ontwerp een automatische tuinberegening en exporteer de stuklijst naar
Excel. Planning en voorraadbeheer volgen.

## Gebruik

1. Start de server (zie *Server (Docker)* hieronder) en open de app in de
   browser, bijvoorbeeld `https://aquatech.den-hollander.com`.
2. **Eerste keer**: zolang er nog geen beheerder is, toont de app op elk
   pad het scherm **Welkom bij Aquatech**. Vul je naam, een gebruikersnaam
   en een wachtwoord in; dat wordt het eerste beheerdersaccount en je bent
   meteen ingelogd. Daarna verschijnt dat scherm nooit meer.
3. Daarna logt iedereen in met een eigen account (het toestel onthoudt de
   inlog een jaar). Accounts maak je aan onder **Beheer → Gebruikers**.
4. Klik op de tegel **Beregeningsplanner** (of ga direct naar
   `.../beregening/`) en klik op **Voorbeeld** of begin met **Nieuw**.

## Beregeningsmethode

In stap 1 kies je per soort vlak hoe het water krijgt:

| Vlak | Keuzes (standaard vet) |
|---|---|
| Gazon | **Meerstraalsrotator**, pop-up sproeier, turbinesproeier |
| Beplanting / border | **Druppelslang**, druppelaars, sproeiers, geen |
| Haag | **Druppelslang**, druppelaars, sproeiers, geen |
| Plantenbak | **Druppelaars**, druppelslang, geen |

Per vlak kun je afwijken: selecteer het vlak en kies bij **Beregening** een
andere methode. Iedere methode krijgt eigen zones, omdat de neerslag verschilt.

## Sproeiers plaatsen

**Automatisch plaatsen** (stap 4) werkt zo:

1. De vorm van het gazon wordt eerst **rechtgetrokken**: kartels van de
   herkenning of de toverstaf verdwijnen en randen die bijna recht of haaks
   lopen, worden precies recht of haaks.
2. Daarna rekent de planner tientallen indelingen door: een raster
   **vierkant** of **driehoekig**, in de hoofdrichting van de tuin of langs de
   smalste kant, met verschillende afstanden. Elke indeling krijgt koppen op
   alle hoeken (binnenhoek 270°), op de randen in lijn met het raster en
   binnenin, altijd **kop-tot-kop** (worp = afstand tot de buurkop).
3. De neerslagsimulatie kiest de beste: zo min mogelijk koppen, zo min
   mogelijk water buiten het gazon, gelijkmatige neerslag (DU) en geen droge
   plekken. Een kop telt zwaar mee (huis, nozzle, aansluiting en graafwerk):
   waar het kan, werpen de koppen over de **volle breedte** van het gazon
   (bijv. MP3000/MP3500 langs beide randen in plaats van een raster kleine
   koppen). Het verband mag rechthoekig zijn (langs het gazon een grotere
   afstand dan dwars erop). De beste paar indelingen worden eerst afgesteld en
   dan pas vergeleken. Tot slot wordt per kop gekeken of een iets kortere worp
   (stelschroef) minder water op het terras geeft.

**Meerstraalsrotators** worden altijd binnen het bereik van een echte kop
gezet (standaardbibliotheek, bij 2,8 bar):

| Kop | Worp | Sproeihoek |
|---|---|---|
| MP1000 | 2,5–4,5 m | 90–210°, 210–270°, 360° |
| MP2000 | 4,0–6,4 m | 90–210°, 210–270°, 360° |
| MP3000 | 6,7–9,1 m | 90–210°, 210–270°, 360° |
| MP3500 | 9,4–10,7 m | 90–210° |
| MP Corner | 2,5–4,5 m | 45–105° |

Selecteer een rotator om de **kop** te kiezen (of *Automatisch*) en worp en
sproeihoek in te regelen; dat kan in het eigenschappenpaneel of door in de
tekening aan de **grepen** te slepen (oranje = worp, wit = begin en einde van
de sproeihoek; Alt = zonder afronden). De planner houdt de instelling binnen
het bereik van de kop. Tekening, sproeibereik, neerslagkaart, debiet en
stuklijst rekenen met de ingestelde waarden; de Excel-export toont per kop de
instelling (bijv. *MP2000 (90–210°) op 135° en 5,2 m*).

### Sproeierbibliotheek: behuizing en nozzle kiezen

De planner kent **behuizingen** (sproeierhuizen en rotors) en **nozzles**,
met worp, sproeihoeken, drukbereik en debiet per druk:

| Behuizing | Pop-up | Drukregeling | Nozzles |
|---|---|---|---|
| Rain Bird 1804 / 1806 / 1812 PRS | 10 / 15 / 30 cm | 2,1 bar | HE-VAN, MP Rotator |
| Rain Bird 1804 / 1806 / 1812 SAM-P45 | 10 / 15 / 30 cm | 3,1 bar | MP Rotator, HE-VAN |
| Hunter Pro-Spray PRS40 | 10 / 15 / 30 cm | 2,8 bar | MP Rotator, HE-VAN |
| Rain Bird 5004 PC / 5004 PRS / 5012 PC | 10 / 10 / 30 cm | – / 3,1 / – bar | Rain Curtain 1,5–8,0 |

In stap 4 kies je per sproeiertype de **behuizing** voor automatisch plaatsen
(gazon en beplanting; *Generiek* = de algemene artikelen in de stuklijst). Bij
**Zelf een kop plaatsen** kies je een behuizing en een nozzle (of
*Automatisch*) en tik je op **Plaatsen**: op een hoek of rand stelt de
sproeihoek zich in en de worp staat op de volle worp van de nozzle. In het
eigenschappenpaneel wissel je behuizing en nozzle en stel je worp en hoek in
binnen het bereik van die nozzle bij de werkdruk van het huis (drukregeling)
of de werkdruk van de nozzle.

De planner rekent met de gegevens van de nozzle: **debiet** uit de
prestatietabel (bij MP Rotator en HE-VAN schaalt het mee met hoek en worp,
gelijke neerslag; bij een rotornozzle is het debiet per nozzle, dus kiest de
planner automatisch de nozzle die bij worp en hoek de juiste neerslag geeft),
**neerslag** in de simulatie en **minimale druk** voor de zones. De stuklijst
neemt het gekozen huis en de nozzle over, de werkorder toont per kop ook de
behuizing.

Eigen gegevens: **Beheer → Sproeiers** → *Downloaden als Excel* geeft de hele
bibliotheek (bladen Uitleg, Behuizingen, Nozzles, Prestaties); vul aan of pas
aan met de tabellen van de fabrikant en lees het bestand weer in. Alleen
regels die afwijken van de standaard worden opgeslagen (per omgeving); *Actief
= nee* verbergt een regel. *Terug naar standaard* wist de eigen regels. Met
een eigen assortiment (voorraad of webshop) toont de planner alleen
behuizingen en nozzles waarvan de artikelcode in het assortiment staat.

**Automatisch afstellen** gebeurt altijd: bij automatisch en handmatig
plaatsen en na het verslepen van een kop zoekt de planner per kop de worp,
sproeihoek en richting (en daarmee de kop) met de beste neerslagverdeling en
de minste overspray. Wat je zelf met de grepen of in het paneel instelt, blijft
staan; **Alle koppen opnieuw afstellen** zet alles weer optimaal.

De **werkorder** neemt de afstelling over: per kop nummer (zoals in de
stuklijst), zone, kop (nozzle en behuizing), sector, sproeihoek, worp, **linkerrand** (begin van de
sproeihoek op de tekening; 0° = rechts, met de klok mee) en plek. Dat staat op
het scherm, op de afgedrukte werkbon en in de Excel-export.

## Plan laden en concept maken

Herkennen kan **lokaal** (standaard, zonder AI, gratis) of met **AI** (als er
een API-sleutel is ingesteld).

**Lokaal** werkt op gekleurde tuinontwerpen: digitaal, maar ook een foto of
scan van een met potlood of stift ingekleurde tekening. Ongelijke belichting,
grijs papier en een kleurzweem worden eerst gecorrigeerd; daarna telt de
gemiddelde kleur per plek (zwarte lijnen en tekst tellen niet mee):

| Kleur in het plan | Wordt |
|---|---|
| Licht- en middengroen (ook bleek potlood) | Gazon |
| Donkergroen, blauwgroen | Haag / heesters |
| Bruin, oranje, roze, paars | Beplanting |
| Grijs, licht beige, geel, lichte baksteen | Bebouwing en verharding (droog houden) |
| Blauw | Water (mag nat worden) |
| Wit (papier), zwart (lijnen, tekst) | Genegeerd |

Titelblok, legenda en de rand van een foto (tafel, schaduw) worden genegeerd.
Een vlak midden in een ander vlak (gazon in de verharding) blijft een eigen
vlak; het omringende vlak krijgt daarvoor een smalle snede naar buiten.

**Labels** in het plan bepalen het soort vlak, ook als ze met de hand
geschreven zijn: *gras/gazon*, *border/beplanting/heesters*, *haag*,
*plantenbak*, *terras/woning/pad/oprit*, *vijver/grind*. In een gekleurd plan
gaat het label vóór de kleur. In een lijntekening of handschets wordt het vlak
dat door de lijnen rond het label wordt omsloten automatisch uitgetrokken;
teken de lijnen daarvoor zo gesloten mogelijk. Duidelijk blokschrift wordt het
best gelezen; zeer grillig handschrift lukt niet altijd (dan helpt de
toverstaf of de AI-optie).

De schaal wordt, in deze volgorde, bepaald uit:

1. een maat met maatlijn: "12,00 m", "450 cm" of een getal als "8500"
   (millimeters, zoals op bouwtekeningen);
2. bij een PDF: de schaalaanduiding "1:N" en het paginaformaat;
3. de breedte van de tuin: staat er geen maat op, dan vraagt de planner hoe
   breed de herkende tuin (van links naar rechts) is. Leeg laten = 10 m.

Bij een foto zegt "schaal 1:50" niets, omdat het papierformaat onbekend is.
Kalibreer de schaal na afloop met een bekende maat als die er is.
Lijntekeningen zonder kleur trek je uit met de toverstaf. **AI** leest ook
lijntekeningen, schetsen en luchtfoto's.

1. Ga naar stap 1 en klik op **Plan laden en concept maken…**.
2. Kies een tuinontwerp, plattegrond, schets of luchtfoto (JPG, PNG of PDF;
   bij een PDF wordt de eerste pagina gebruikt).
3. Na 1 à 2 minuten staat er een concept klaar: schaal, vlakken,
   wateraansluiting, besturing, ventielkast, sproeiers, zones en leidingen.
4. Controleer de schaal (stap 1, **Schaal kalibreren**) als de planner meldt
   dat hij geschat is, en pas vlakken en sproeiers aan waar nodig.

Hiervoor is een API-sleutel van Anthropic nodig:

- Maak een sleutel aan op https://console.anthropic.com en vul hem in onder
  **Beheer → Instellingen** (met **Sleutel testen** controleer je hem
  zonder kosten). Hij werkt meteen, zonder herstart.
- Elke analyse kost een paar dubbeltjes aan API-tegoed. Het maximum per dag
  (standaard 30, hele app) en per uur per IP-adres (standaard 10) stel je in
  op dezelfde plek; daar zet je AI-herkenning ook helemaal uit.
- Het plan wordt voor de analyse naar Anthropic gestuurd. Zonder sleutel blijft
  alles lokaal.
- **Elke organisatie gebruikt een eigen sleutel** (en betaalt dus zelf). De
  sleutel uit de Docker-omgeving (`ANTHROPIC_API_KEY`) geldt alleen voor de
  hoofdorganisatie, nooit voor andere organisaties. Een testomgeving zonder
  eigen sleutel gebruikt de sleutel, het model en de koers van haar
  live-omgeving.
- **Model**: kies per organisatie Claude Opus 5.5 (standaard, aanbevolen),
  Sonnet 5.5 (half zo duur), Haiku 5.5 (veruit het goedkoopst, minder
  nauwkeurig bij schetsen) of Fable 5.1 (krachtigst, duurst).

### AI-kosten

**Beheer → AI-kosten** (`.../beheer/#aikosten`) toont elk AI-verzoek: wie,
welke functie, welk model, tokens in en uit (inclusief het denkwerk van het
model), duur, resultaat en de geschatte kosten in euro's. Met totalen per
dag of maand, per gebruiker, per functie en per model, en een
**Excel-export** met alle tabellen en de losse verzoeken.

- Kosten worden bij het verzoek berekend met de prijzen van Anthropic
  (`frontend/shared/ai-models.js`) en omgerekend met de koers uit de
  instellingen (eurocent per dollar, standaard 86). De factuur van
  Anthropic blijft leidend.
- Ook mislukte verzoeken staan erin (een weigering of te lang antwoord kost
  ook tokens).
- Alleen getallen worden bewaard, niet de afbeelding of het antwoord. Regels
  verdwijnen na de bewaartermijn van het auditlog.
- Een beheerder ziet de eigen omgeving; een hoofdbeheerder kan ook **alle
  organisaties** samen bekijken, met een uitsplitsing per organisatie.

## Toverstaf

Werkt zonder API-sleutel. Laad een plan als ondergrond, kies in stap 2 bij een
soort vlak **Toverstaf** en klik midden in het vlak op het plan. De rand wordt
op kleur uitgetrokken; met **Gevoeligheid toverstaf** stel je in hoe sterk
kleuren mogen afwijken.

## Opslag

Plannen worden automatisch op twee plekken bewaard: in de browser van het
toestel en, een paar seconden na elke wijziging, in **Mijn plannen** op de
server (database in Supabase/PostgreSQL, zie *Database: Supabase
(PostgreSQL)*; zonder databaseverbinding het bestand `/data/aquatech.db`). Via **Mijn plannen** in de planner (of op het dashboard) open je
een eerder plan. Iedere gebruiker ziet daar alleen de eigen plannen.
**Opslaan** downloadt daarnaast nog steeds een `.aquaplan.json`-bestand en
**Openen** laadt zo'n bestand als nieuw plan.

## Plannenoverzicht

De tegel **Plannenoverzicht** op het dashboard (of *Alle plannen →* bij
Mijn plannen) toont de plannen als tabel: projectnaam, klant, adres,
oppervlaktes, sproeiers, zones en datums, met zoeken, sorteren (klik op een
kolomkop), totalen en **Exporteer naar Excel**. Een klant ziet zijn eigen
plannen (tegel **Mijn plannen**); installateurs en beheerders zien alle
plannen van de organisatie met de gebruiker en kunnen per gebruiker
filteren; beheerders kunnen ook verwijderde plannen tonen en zien per plan
de historie.

### Tekening indienen en controle van plannen

Op de inlogpagina staat **Direct een tekening maken**: een klant zonder
account opent de planner (`beregening/?tekenen&org=<organisatiecode>`),
tekent de tuin en klikt op **Tekening indienen**. Daarbij vult hij naam,
e-mailadres, eventueel telefoon en adres en een vraag in, en geeft hij
toestemming om de gegevens voor de aanvraag te gebruiken. Tot het indienen
blijft de tekening alleen in de browser; er wordt geen account aangemaakt.
De knop staat er alleen als de organisatie dat toestaat (**Beheer →
Instellingen → Toegang**, standaard aan).

Elk plan heeft een status:

| Status | Betekenis |
|---|---|
| Concept | nog niet aangeboden of goedgekeurd |
| Ter controle | een klant heeft het aangeboden (ingelogd via *Ter controle aanbieden*, of zonder account ingediend) |
| Goedgekeurd | een installateur (recht *Plannen goedkeuren*) heeft het goedgekeurd |

Een plan van een klant is nooit meteen definitief. Een installateur keurt
een eigen plan in één keer goed (balk boven de stappen in de planner, of in
het Plannenoverzicht). Wijzigt een klant een goedgekeurd plan, dan gaat het
opnieuw ter controle. Een **offerte** kan alleen uit een goedgekeurd plan.

Aanvragen staan in het Plannenoverzicht onder het filter *Ter controle*
(direct: `plannen/?review=ter_controle`), met de vraag en de
contactgegevens. Met een mailserver en een e-mailadres in het
bedrijfsprofiel krijgt het bedrijf bij elke aanvraag een e-mail.

Beveiliging: zonder inloggen zijn alleen de code van de planner (geen
gegevens) en één schrijvend endpoint bereikbaar (`POST
/api/public/drawing`): maximaal 10 pogingen per uur per IP-adres en 30
aanvragen per dag per organisatie, 7 MB per tekening, een verborgen veld
tegen bots, invoer op de server gecontroleerd, geen persoonsgegevens in
het auditlog en geen mail naar het opgegeven adres.

## Offertes

De module **Offertes** bouwt een offerte op uit een beregeningsplan. Start
vanuit de planner (stap *Stuklijst & export* → **Offerte maken van dit
plan**), vanuit het plannenoverzicht (**Offerte maken**) of in de module zelf
met **Nieuwe offerte uit plan**.

- **Materialen** komen uit de stuklijst van het plan (zelfde berekening als
  de Excel-stuklijst, inclusief uitvoeringsniveau), met de ingestelde opslag
  op de artikelprijzen.
- **Arbeid** wordt geschat uit het plan: sproeiers, meters sleuf en leiding,
  ventielen en ventielkast, besturing en kabel, druppelslang of druppelaars,
  wateraansluiting, waterpunten en inregelen, afgerond op kwartieren tegen het
  uurtarief. **Overig** bevat de voorrijkosten (als ingesteld) en eigen regels.
- Alles is aan te passen: omschrijving, aantal, eenheid, prijs en btw-tarief
  (21, 9 of 0%) per regel, regels toevoegen en verwijderen, een kortings-
  percentage over het geheel (naar rato over de btw-tarieven), klantgegevens,
  datum, geldigheid, inleiding en voorwaarden. Wijzigingen worden automatisch
  bewaard. **Regels opnieuw uit het plan** neemt een gewijzigd plan over.
- **PDF / afdrukken** opent de afdrukversie in huisstijl (A4); kies in het
  printvenster *Opslaan als PDF*. Op de offerte staan alle regels met
  prijzen, of per onderdeel alleen een totaalbedrag. **Excel** geeft de
  offerte als werkblad met formules.
- Elke offerte krijgt een vast nummer per jaar (`OF-2026-0001`, voorvoegsel
  instelbaar) en een status: concept, verzonden, akkoord of afgewezen;
  verlopen offertes zijn in het overzicht te herkennen. Het overzicht is naar
  Excel te exporteren.
- **Bedrijfsgegevens** (alleen beheerders): naam, adres, contact, KvK, btw-
  nummer en IBAN voor op de offerte, plus uurtarief, opslag materiaal,
  voorrijkosten, standaard btw-tarief, geldigheid en standaardteksten. Ze
  gelden per tenant en omgeving.

Installateurs en beheerders zien hun eigen offertes en met *Van alle
gebruikers* die van de hele organisatie; alleen beheerders kunnen een
offerte definitief wissen (AVG). Een testomgeving heeft eigen offertes en
nummering.

**Klant**: koppel een offerte bij *Klantaccount* aan een account met de rol
klant. Zodra de status **Verzonden** is, ziet de klant de offerte onder
**Mijn offertes** als document (af te drukken als PDF) en kan hij **Akkoord
geven** of **Afwijzen**; de status gaat dan mee en de reactie staat in het
auditlog. Concepten ziet een klant nooit; een verlopen offerte kan hij niet
meer accepteren. Met de opmaak *totaal per onderdeel* krijgt de klant ook
via de API geen prijzen per regel.

### Digitale offerte (online akkoord)

In de editor staat het blok **Digitale offerte**:

- **Link maken** geeft een persoonlijke link
  (`…/openbaar/offerte.html#t=<token>`); de offerte gaat dan naar
  *Verzonden*. **Kopiëren**, **Bekijken** (telt niet als geopend door de
  klant) en **Link intrekken** (de oude link werkt daarna niet meer).
- **Versturen per e-mail** stuurt de klant een bericht met de knop *Offerte
  bekijken en accorderen*. Zonder ingestelde mailserver opent het bericht in
  je eigen mailprogramma, met de link erin.
- Je ziet wanneer de offerte is verstuurd en of, wanneer en hoe vaak de klant
  hem heeft geopend (ook *bekeken* in het overzicht).

De klant hoeft niet in te loggen. Hij ziet de offerte in de huisstijl, vinkt
eventuele **opties** aan of uit (het totaal rekent mee), en geeft akkoord met
zijn naam, een handtekening in het tekenvak en een vinkje voor de offerte en
voorwaarden; afwijzen kan met een reden. Na het antwoord ziet hij het
geaccordeerde document met zijn handtekening en kan hij het als PDF opslaan.

Vastgelegd bij het antwoord: naam, tijdstip, IP-adres (plus het door de proxy
opgegeven adres), browser, handtekening, gekozen opties, totaalbedrag en een
kenmerk (SHA-256) van de geaccordeerde inhoud. Daarna ligt de offerte vast:
wijzigen kan alleen via **Kopie maken**. Het akkoord staat in het auditlog en
onderaan de PDF.

**Opties**: zet bij een regel *Soort* op **Optie** (standaard uit) of
**Optie (aan)**. Een niet gekozen optie telt niet mee in het totaal, de PDF en
de Excel-export.

**E-mail** (beheerder, **Beheer → Instellingen → E-mail**): kies de soort.
*SMTP met inlog*: SMTP-server, poort, STARTTLS of SSL/TLS, gebruikersnaam,
wachtwoord (versleuteld opgeslagen, nooit getoond), afzender en antwoordadres.
*Exchange Online-connector (op IP)*: geen inlog; de app verstuurt via het
MX-adres van het domein (`<domein>.mail.protection.outlook.com`, poort 25,
STARTTLS verplicht). Het scherm toont het **WAN-IP** van de server (het
openbare uitgaande IPv4-adres, opgezocht via api.ipify.org met terugval, een
uur onthouden; vast in te stellen met `WAN_IP` in de Docker-omgeving) en een
korte handleiding: in het Exchange-beheercentrum een connector *van de
e-mailserver van je organisatie naar Office 365* toevoegen die op dat IP
controleert, en `ip4:<WAN-IP>` in het SPF-record. **Testmail sturen**
controleert de instellingen. Met een mailserver krijgt de klant na een akkoord
een bevestiging met een link naar het getekende document, en het bedrijf (het
e-mailadres bij de bedrijfsgegevens) een bericht bij elk akkoord of elke
afwijzing.

Beveiliging: het token (192 bits) staat in het fragment van de link en gaat
alleen als kop `X-Offerte-Token` naar de server, dus niet in logboeken van
proxy's. In de database staat alleen de SHA-256 ervan doorzoekbaar en het
token zelf versleuteld (om de link opnieuw te tonen). De openbare pagina laadt
alleen een vaste lijst bestanden zonder inloggen; de rest van de app blijft
achter de login. Verzoeken op de openbare API zijn per IP begrensd. Een
uitgeschakelde organisatie of ingetrokken link geeft *niet beschikbaar*.

## Werkorders

Module **Werkorders** (tegel op het dashboard), alleen voor beheerders en
installateurs. Een werkorder maak je van een offerte met status **Akkoord**:
in de offerte met **Werkorder maken** (staat er al een, dan opent de knop
die), of in de module met **Nieuwe werkorder uit offerte**.

- **Werkstappen**: de arbeidsregels van de offerte in uitvoeringsvolgorde
  (aansluiting, sleuven, ventielkast, sproeiers, druppelleiding, besturing,
  inregelen), met voorbereiding en oplevering eromheen. Per stap de geplande
  uren uit de offerte en een veld voor de werkelijke uren; stappen zijn toe
  te voegen, aan te passen en af te vinken.
- **Zone-indeling** uit het gekoppelde plan: per zone de onderdelen, het
  debiet, de leidinglengte en de druk bij de laatste kop. Na een wijziging
  in het plan: menu ⋯ → *Zone-indeling opnieuw uit het plan*.
- **Materialen**: de materiaalregels van de offerte zonder prijzen, af te
  vinken bij het verzamelen (⋯ → *Materialen opnieuw uit de offerte*).
- **Planning**: datum, van/tot-tijd, aantal werkdagen, uitvoerder (beheerder of installateur),
  ploeg, werkinstructies en bijzonderheden van de locatie. Status: nieuw,
  gepland, in uitvoering, gereed of geannuleerd; een datum zet een nieuwe
  werkorder op gepland, de eerste afgevinkte stap op in uitvoering.
- **Werkbon**: PDF via het printvenster, met afvinkvakjes en aftekenregels
  voor uitvoerder en klant, of Excel. Het overzicht is filterbaar (ook
  "alleen aan mij toegewezen") en exporteert naar Excel.

Nummering `WO-<jaar>-0001` per tenant en omgeving; een beheerder kan een
werkorder definitief wissen (AVG).

### Uitbesteden aan andere organisaties

Module **Uitbesteden**, alleen voor beheerders (recht `uitbesteden`). Staat
pas aan als de beheerder het aanzet in Beheer → Instellingen → Uitbesteden:
*versturen* (zelf werk uitbesteden) en *ontvangen* (opdrachten van anderen
aannemen) apart, plus een werkgebied dat andere organisaties zien. Een
testomgeving werkt alleen met andere testomgevingen.

- **Aanbieden**: in een werkorder met status Nieuw of Gepland menu ⋯ →
  *Uitbesteden aan andere organisatie*. Kies één organisatie of iedereen die
  opdrachten ontvangt, met een bericht en eventueel een vergoeding. Intrekken
  kan zolang niemand het heeft aangenomen.
- **Aannemen**: in Uitbesteden → *Aangeboden aan ons*. De organisatie ziet
  vooraf alleen omschrijving, plaats (postcodecijfers en woonplaats),
  gewenste planning, werkstappen met uren en materialen. Na aannemen krijgt
  zij een eigen werkorder met klantgegevens, instructies, zones, stappen en
  materialen (zonder offerte, prijzen, foto's of ploeg). Afwijzen kan met een
  toelichting; bij een open aanbod blijft het dan voor de anderen staan.
- **Voortgang**: de uitbesteder ziet bij de werkorder en in *Door ons
  uitbesteed* de status, planning, afgevinkte stappen en opleverdatum bij de
  ontvanger, niets meer.

### Planning en afspraak met de klant

Module **Planning** (tegel op het dashboard en in de zijbalk, zelfde rechten
als Werkorders): een agenda met drie weergaven.

- **Dag**: tijd verticaal, de installateurs als kolommen naast elkaar; op een
  telefoon scroll je horizontaal. Bovenaan per kolom de rij *Geen tijd* voor
  klussen zonder starttijd.
- **Werkweek**: tijd verticaal, de dagen als kolommen (weekend optioneel);
  de kleur van een blok is de uitvoerder.
- **Maand**: maandrooster; tik op een dag voor de dagweergave.

Sleep een werkorder naar een tijdstip (per kwartier) om hem in te plannen of
te verplaatsen; in de dagweergave bepaalt de kolom ook de uitvoerder. Naar
*Geen tijd* slepen haalt de tijden weg, naar *In te plannen* de datum. Op
een telefoon: tik op een werkorder uit *In te plannen* en dan op het
tijdstip. Zonder eindtijd volgt de lengte van het blok uit de **geplande
uren** (de werkstappen uit de offerte): tot 8 uur op één dag, daarboven
verdeeld over gelijke werkdagen. Een klus van meer werkdagen staat op elke
werkdag (zaterdag en zondag tellen niet mee). Een gekleurde stip toont de
stand van de afspraak met de klant; **Excel** exporteert wat in beeld is.

In de werkorder staat onder *Planning* het blok **Afspraak met de klant**.
**Afspraak naar de klant** maakt een link naar de openbare pagina
`openbaar/afspraak.html#t=<token>` (net als de digitale offerte: het token
gaat alleen in een kop naar de server; in de database staan alleen de
SHA-256 en een versleutelde kopie) en verstuurt die per e-mail, of zet het
bericht klaar in je eigen mailprogramma. De klant ziet datum, tijden,
werkdagen en adres (geen werkstappen, materialen of namen van medewerkers),
kan de afspraak in zijn agenda zetten en **bevestigt** met zijn naam of
**vraagt een ander moment** met een toelichting. Het bedrijfsadres uit de
bedrijfsgegevens krijgt daarvan een e-mail.

Een reactie hoort bij het moment (datum, tijden, werkdagen) waarop hij
gegeven is: verschuif je de afspraak, dan staat hij weer op *wacht op
klant* en stuur je de klant de nieuwe afspraak. Standen: geen datum, niet
naar de klant, wacht op klant, bevestigd, klant vraagt ander moment. Een
geannuleerde of uitgevoerde klus en een datum in het verleden zijn niet
meer te bevestigen. **Link intrekken** maakt de oude link ongeldig.

### Foto's en klantdossier

In de werkorder legt de ploeg met de kaart **Foto's van de installatie**
vast hoe de installatie is aangelegd en opgeleverd:

- **Foto maken** opent op een telefoon of tablet direct de camera; **Foto's
  kiezen** pakt er meerdere uit de galerij (of sleep ze op de kaart).
- Kies vooraf de **fase** (voor, tijdens, oplevering; standaard volgens de
  status van de werkorder) en of de foto **zichtbaar voor de klant** is.
  Achteraf per foto aan te passen, met een bijschrift.
- Foto's worden in de browser verkleind tot max. 2048 px; locatie (GPS) en
  andere EXIF-gegevens gaan er daarbij af. Max. 100 foto's per werkorder.
- Opslag versleuteld in de database (AES-256-GCM), dus mee in de back-ups.
  Definitief wissen van een werkorder wist ook de foto's.

De module **Klantdossiers** (beheerder en installateur) bundelt per klant
alle werkorders: opleverdatum, afgetekend door, uitvoerder, opmerkingen,
ontwerp en zones, geplaatste materialen, foto's per fase en de offertes.
**Opleverrapport / PDF** drukt het dossier af (vink *Ook interne foto's* uit
voor een versie voor de klant). Klanten met een klantaccount (gekoppeld aan
de offerte) zien hun zichtbaar gezette foto's in het klantportaal.

## Storing of onderhoud melden

Een klant meldt in **Mijn portaal** (blok *Storingen en onderhoud*) zelf een
storing, een onderhoudsverzoek of een andere vraag: onderwerp, omschrijving,
eventueel spoed, de installatie waar het om gaat, adres, telefoon, een
voorkeursmoment en tot 6 foto's. Zolang de melding nog niet is opgepakt kan
hij foto's toevoegen of verwijderen en de melding intrekken. Het bedrijf
krijgt een e-mail (als er een mailserver is ingesteld).

Medewerkers met het recht *Werkorders* zien de meldingen in de module
**Meldingen**. Daar sturen ze de klant een reactie (in het portaal en per
e-mail), houden ze een interne notitie bij en zetten ze de status. Met
**Werkorder maken** ontstaat een werkorder met de klantgegevens, de
omschrijving als instructie, het ontwerp en de zones van de gekozen
installatie en de foto's van de klant. De klant ziet die werkorder daarna in
zijn portaal en kan de afspraak daar bevestigen.

## Voorraadbeheer

Module **Voorraadbeheer** (recht *Voorraadbeheer*: standaard beheerder en
installateur). Een voorraadartikel heeft een **artikelcode**: dezelfde codes
als de catalogus, de stuklijst van de planner, de offerte en de materiaallijst
van de werkorder. Daardoor is alles vanzelf gekoppeld.

- **Artikelen**: *Uit catalogus* neemt artikelen uit de stuklijst op voorraad
  (omschrijving en eenheid uit de catalogus), *+ Artikel* maakt een eigen
  artikel (met beginvoorraad). Per artikel: locatie, minimumvoorraad,
  inkoopprijs (voor de voorraadwaarde) en notities. Een artikel met mutaties
  wordt bij verwijderen gearchiveerd; het logboek blijft.
- **Mutaties** per artikel: *Ontvangst* (erbij), *Telling* (de stand wordt
  het getelde aantal) en *Correctie* (+ of −, met reden). Elke mutatie komt
  in het logboek met de stand erna, wie en wanneer.
- **Reserveren**: een werkorder met status Nieuw, Gepland of In uitvoering
  reserveert per voorraadartikel uit zijn materiaallijst wat nog niet is
  afgeboekt. Dat volgt elke wijziging van de werkorder (materialen, status,
  verwijderen). *Beschikbaar* = op voorraad − gereserveerd; onder de
  minimumvoorraad staat *Bijbestellen*.
- **Afboeken**: op de werkorder staat het blok **Voorraad** (nodig,
  afgeboekt, gereserveerd, op voorraad, tekort). Afboeken kan daar per regel
  (ook *Retour*) of in één keer voor alles wat gereserveerd staat. Wordt de
  werkorder **Gereed**, dan wordt de rest van de reservering vanzelf
  afgeboekt. Is er op de werkorder materiaalverbruik geregistreerd, dan boekt
  dat verbruik de voorraad af en vervalt bij Gereed alleen de rest van de
  reservering.
- **Excel-export**: de voorraadlijst (met een tabblad Gereserveerd) en de
  mutaties over een gekozen periode.

## Gebruikers, rollen en historie van aanvragen

Elke rol ziet op het dashboard alleen de modules die erbij horen; de server
controleert de rechten zelf. De standaardrollen staan in
`frontend/shared/roles.js`; een beheerder past ze aan onder **Beheer → Rollen**
(zie hieronder).

| Rol | Mag | Wie |
| --- | --- | --- |
| **Hoofdbeheerder** | alles, in elke tenant, plus **Hoofdbeheer** (tenants en testomgevingen) | de eerste beheerder van het platform |
| **Beheerder** | alles binnen de eigen organisatie: gebruikers, instellingen, historie, auditlog, alle plannen en offertes, bedrijfsgegevens, testomgevingen | accounts met rol beheerder, en inloggen met de (optionele) toegangscode |
| **Installateur** | plannen maken en bewerken, alle plannen en offertes van de organisatie, offertes opstellen en aan een klant koppelen; geen gebruikers, instellingen of historie | accounts met rol installateur (vóór 0.22.0: *gebruiker*) |
| **Planner** | werkorders inzien en bijwerken, inplannen in de planning, de afspraaklink naar de klant sturen en klantdossiers bekijken; geen offertes, plannen of beheer, en zelf geen uitvoerder | accounts met rol planner (sinds 0.49.0) |
| **Klant** | alleen de eigen plannen, en de verzonden offertes voor zijn account inzien, afdrukken en accepteren of afwijzen | accounts met rol klant, en gasten |

- **Rollen aanpassen** (**Beheer → Rollen**): een tabel met de rechten als
  rijen en de rollen als kolommen; een vinkje slaat direct op en geldt bij
  het volgende verzoek. Rechten: Beregeningsplanner, Alle plannen, Offertes
  opstellen, Alle offertes, Werkorders en klantdossiers, Planning, Uitvoerder
  (kan worden toegewezen en is een kolom in de planning), Voorraadbeheer, Uitbesteden, en voor klantrollen
  Eigen offertes en Klantportaal. Een recht dat een ander nodig heeft (bijv.
  Planning → Werkorders) gaat automatisch mee aan; uitzetten neemt de
  afhankelijke rechten mee. Naam en omschrijving van elke rol zijn aan te
  passen; een aangepaste standaardrol kan terug naar de standaard.
- **Eigen rollen**: onder **Rol toevoegen** met een naam, de soort
  (medewerker of klant) en eventueel de rechten van een bestaande rol als
  start. Een klantrol kan alleen klantrechten krijgen; accounts met een
  klantrol zijn aan een offerte te koppelen. Een eigen rol is alleen te
  verwijderen als er geen gebruikers meer mee werken.
- **Vaste regels**: de beheerder heeft altijd alle rechten (anders kan
  niemand meer beheren) en alleen die rol heeft **Beheer**. Rollen gelden
  voor de hele organisatie, ook in de testomgevingen; een testaccount kan ze
  niet wijzigen. Elke wijziging staat in het auditlog.
- **Accounts** maak je als beheerder aan onder **Beheer → Gebruikers**
  (gebruikersnaam, naam, rol, wachtwoord van minimaal 8 tekens). Inloggen
  via `.../login` of de knop **Inloggen** rechtsboven. Een nieuw wachtwoord
  of uitschakelen logt de gebruiker op alle toestellen uit.
- **Mijn profiel**: via het gebruikersmenu rechtsboven (rondje met
  initialen) of onderaan de zijbalk. Elke gebruiker met een eigen account
  wijzigt daar naam, e-mailadres, telefoonnummer, voorkeuren (startpagina,
  kopie van verstuurde offertes/afspraken) en het wachtwoord. Beheerders
  zien er ook het versienummer van de app.
- **Eigen wachtwoord**: elke gebruiker met een account wijzigt zijn wachtwoord
  op **Mijn profiel**. Met het vinkje **Wachtwoord wijzigen
  na eerste aanmelding** (standaard aan bij een nieuw account en bij een
  nieuw wachtwoord van de beheerder; per gebruiker aan/uit in de kolom
  *Nieuw ww. verplicht*) moet de gebruiker eerst zelf een wachtwoord kiezen
  voordat de rest van de app opent.
- **Organisatiecode**: een gebruikersnaam is uniek binnen een organisatie
  (de live-tenant met zijn testomgevingen), niet over het hele platform. Twee
  organisaties kunnen dus allebei een *jan* hebben; elke gebruiker heeft in
  de database zijn eigen id. Bij het inloggen vul je de organisatiecode in
  (de code van de tenant, onder **Beheer → Gebruikers** te zien, met een
  inloglink `login?org=<code>` die hem al invult). De browser onthoudt de
  code. Leeg = de hoofdorganisatie, waar ook de hoofdbeheerders inloggen.
- **Gasten**: standaard uit; zonder inloggen zie je alleen de inlogpagina.
  Zet je onder **Beheer → Instellingen** *Gasten zonder inloggen toestaan*
  aan (en is er geen toegangscode), dan kan iedereen de planner gebruiken.
  Elke browser krijgt dan een eigen anonieme gebruiker en ziet alleen de
  eigen plannen.
- De **laatste actieve beheerder** kan niet worden uitgeschakeld of een
  andere rol krijgen; maak eerst een andere beheerder aan.
- **Gebruikers verwijderen** (0.30.0): knop **Verwijderen** in **Beheer →
  Gebruikers** (eigen organisatie) en in **Hoofdbeheer → Gebruikers** (elke
  tenant), altijd na bevestiging. Het account, de sessies en
  supporttoestemmingen verdwijnen definitief. Plannen, offertes en
  werkorders blijven bewaard en staan daarna op naam van de systeemgebruiker
  *Verwijderde gebruiker*; in historie en auditlog blijft de regel staan
  zonder koppeling aan het account. Je kunt je eigen account, de laatste
  actieve beheerder van een tenant en de laatste actieve hoofdbeheerder niet
  verwijderen; een hoofdbeheerder alleen door een andere hoofdbeheerder.
  Tijdelijk blokkeren = **Uitschakelen**.
- **Tenants verwijderen** (0.33.0): **Hoofdbeheer → Verwijderen** bij een
  live-tenant, na het overtypen van de tenantcode. Alles van die tenant en
  zijn testomgevingen wordt definitief gewist (gebruikers, plannen, offertes,
  werkorders, historie, instellingen, webshop, auditlog). De hoofdtenant kan
  niet weg. Oude back-ups bevatten de gegevens nog tot ze verlopen of je ze
  verwijdert. Tijdelijk blokkeren = **Uitschakelen**.
- **Wat kan weg**: plannen (planner; beheerder: definitief wissen in
  Plannen), offertes en werkorders (verwijderen; beheerder: definitief
  wissen), gebruikers, testomgevingen, tenants, back-ups en de
  webshopkoppeling. Een geaccordeerde offerte vraagt het offertenummer ter
  bevestiging. Historie en auditlog zijn bewust niet los te verwijderen
  (sporen voor beveiliging); definitief wissen van een plan haalt wel de
  inhoud uit de historie.
- **Hoofdbeheerders** beheer je in **Hoofdbeheer → Hoofdbeheerders** (de
  gebruikers van de hoofdtenant): vink *Hoofdbeheerder* aan bij een nieuwe
  gebruiker, of gebruik *Hoofdbeheerder maken* / *intrekken* bij een
  bestaand account. Hoofdbeheerders horen bij de hoofdtenant, hebben altijd
  de rol beheerder en loggen in met een lege organisatiecode. Alleen een
  hoofdbeheerder kan een andere hoofdbeheerder wijzigen, uitschakelen of
  uitloggen; de laatste actieve hoofdbeheerder blijft altijd bestaan.
- **Inloggen als een gebruiker (impersonatie)**: een hoofdbeheerder kan in
  **Hoofdbeheer → Gebruikers → Inloggen als** tijdelijk werken met de rol en
  rechten van een gebruiker, om mee te kijken of te helpen.
  - In een **testomgeving** zonder goedkeuring.
  - In **live** alleen als de gebruiker zelf toestemming heeft gegeven op het
    dashboard bij **Support op afstand** (1 uur, 4 uur, 1 dag of 3 dagen).
    De gebruiker kan die toestemming altijd intrekken; een lopende
    impersonatie stopt dan meteen. Hij ziet daar ook wie er onlangs heeft
    meegekeken.
  - Een impersonatie duurt hoogstens 8 uur (in live nooit langer dan de
    toestemming). Zolang die loopt staat onderin elke pagina een rode balk
    met **Terug naar eigen account**; uitloggen stopt de impersonatie ook.
  - Elke start en elk einde staat in het auditlog (van de omgeving én van de
    hoofdtenant, met de optionele reden), en wat er tijdens een impersonatie
    gebeurt staat in het auditlog met de naam van de hoofdbeheerder erbij.
    Een hoofdbeheerder kan niet worden overgenomen, en tijdens een
    impersonatie kun je niet van omgeving wisselen of toestemming geven
    namens de gebruiker.
- **Historie** (**Beheer → Aanvragen**): elke aanvraag krijgt een regel met
  datum, gebruiker, plan, klant, adres, oppervlaktes, sproeiers en zones:
  een nieuw plan, wijzigingen (opeenvolgende wijzigingen van dezelfde
  gebruiker binnen een half uur vormen één regel), een verwijdering en elke
  automatische planherkenning. De historie is alleen voor beheerders, kan
  niet door gebruikers worden gewist en blijft staan als een gebruiker het
  plan verwijdert. Klik op een regel voor de details of om een kopie van dat
  plan in de planner te openen; **Exporteer naar Excel** downloadt de
  (gefilterde) historie als `.xlsx`.
- Achter de Cloudflare-tunnel toont de historie als IP-adres dat van de
  tunnel, niet dat van de bezoeker.

## Testomgeving vullen met testdata

In **Hoofdbeheer** staat bij elke testomgeving de knop **Vullen met
testdata** (alleen voor testomgevingen, nooit voor live). Die maakt in één
keer:

- **Testaccounts** voor elke rol: een beheerder, twee installateurs, een planner en vier
  klanten (`klant1` met een opgeleverde werkorder en `klant4` met een
  ingeplande, om het klantportaal te bekijken), met gebruikersnamen als `<code-van-de-omgeving>.klant1`. Alle
  testaccounts krijgen hetzelfde willekeurige wachtwoord; dat staat alleen
  in het venster na het vullen (ook als Excel te downloaden) en wordt
  nergens bewaard.
- **Nepklanten met tuinen**: zeven plannen met terras, gazon, border, haag,
  plantenbak, systeemelementen, sproeiers en zones, met een regel in de
  historie.
- **Offertes** in alle statussen (concept, verzonden, akkoord, afgewezen),
  opgebouwd uit die plannen met de bedrijfsgegevens van de omgeving; vier
  zijn gekoppeld aan de testklanten. Verstuurde offertes hebben een
  **klantlink** (met verzend- en bekijkgegevens) en opties die de klant zelf
  kiest; drie zijn **digitaal geaccordeerd** (naam, handtekening, gekozen
  opties, via het klantaccount of de link) en één is afgewezen met een reden.
- **Werkorders** bij de geaccordeerde offertes: gepland, in uitvoering
  (deels afgevinkt) en gereed (met opleverrapport), toegewezen aan de
  testinstallateurs, met zone-indeling en materiaallijst, en een
  afspraaklink met een reactie van de klant (bevestigd of ander moment).
- **Voorraad**: de artikelen van de werkorders op voorraad (op één na, die
  laat zien hoe een artikel zonder voorraadbeheer eruitziet) plus een eigen
  artikel, met ontvangsten, een telling en een correctie. De gereede
  werkorder heeft zijn materialen afgeboekt, die in uitvoering deels, de
  open werkorders reserveren de rest; één artikel komt tekort.
- **Webshop**: een nepwinkel (`webshop.voorbeeld.test`) met producten en
  prijzen voor de catalogus, gekoppeld via sku, het productveld
  `aquatech_code` en handmatige koppelingen; een paar artikelen ontbreken
  bewust. Heeft de testomgeving al een eigen webshop, dan blijft die staan.

Wat er al in de testomgeving stond (plannen, offertes, werkorders, historie,
testaccounts) wordt eerst gewist. Opnieuw vullen geeft een nieuw wachtwoord
en logt de testaccounts uit; **Leegmaken** en **Verwijderen** ruimen de
testaccounts mee op.

Testaccounts horen bij de testomgeving zelf: wie ermee inlogt (bijvoorbeeld
in een privévenster) komt direct in die testomgeving, met de rechten van de
rol. Een testbeheerder beheert alleen de testaccounts, nooit de gebruikers
van live. De knop **Testaccounts** toont ze en daar kun je er ook losse bij
maken.

## Instellingen

Beheerders regelen alles onder **Beheer → Instellingen** (ook direct via
`.../beheer/#settings`):

| Instelling | Standaard |
|---|---|
| AI-herkenning aan/uit | aan (werkt alleen met een API-sleutel) |
| API-sleutel van Anthropic | leeg |
| Maximaal aantal AI-analyses per dag (hele app) | 30 |
| Maximaal aantal AI-analyses per uur per IP-adres | 10 |
| AI-model | Claude Opus 5.5 |
| Koers voor AI-kosten (eurocent per dollar) | 86 |
| Gasten zonder inloggen toestaan | uit |
| Tekening indienen zonder account (knop op de inlogpagina) | aan |
| Toegangscode (optioneel, gedeelde beheerderscode) | leeg |
| Modules op het dashboard aan/uit | alle aan |

- De instellingen staan in de database (`/data/aquatech.db`) en werken
  meteen, zonder herstart.
- Geheimen (API-sleutel, toegangscode) gaan nooit terug naar de browser; je
  ziet alleen of ze zijn ingesteld en van de sleutel de laatste 4 tekens.
- Omgevingsvariabelen in Docker (`ACCESS_CODE`, `GUEST_ACCESS`,
  `ANTHROPIC_API_KEY`, `AI_DAILY_LIMIT`, zie `.env.example`) zijn alleen
  **startwaarden**: zodra je een
  instelling in het scherm opslaat, gaat die voor. Met **Terugzetten naar
  startwaarde** haal je de opgeslagen waarde weer weg.
- Wie met de toegangscode is ingelogd kan die niet leegmaken (dan zou je
  jezelf buitensluiten); maak daarvoor eerst een beheerdersaccount aan.

### Kleuren (hoofdbeheerder)

Een hoofdbeheerder kiest de kleuren van de app onder **Hoofdbeheer →
Kleuren**: hoofdkleur (kopbalk, zijbalk, koppen), actiekleur (knoppen,
voortgang) en accentkleur (randen, focusrand). De lichte en donkere tinten
van de actiekleur rekent de app zelf uit. Een voorbeeld toont het resultaat
meteen.

- **Voor**: *Alle organisaties (standaard)* geldt overal, ook op de
  inlogpagina en de openbare offerte- en afspraakpagina. Een organisatie kan
  een **eigen thema** krijgen (handig voor de eigen huisstijl van een klant
  van het platform); haar testomgevingen volgen dat.
- **Leesbaarheid**: op de hoofd- en actiekleur staat witte tekst. De app
  weigert een hoofdkleur onder 4,5:1 en een actiekleur onder 3:1 contrast met
  wit (WCAG 2.1 AA) en toont per kleur de verhouding.
- **Standaardkleuren terugzetten** zet de huisstijl van AquaTech Service
  terug (navy `#172f5e`, groen `#19924f`, teal `#2cb0c0`); bij een
  organisatie verwijdert **Eigen thema verwijderen** het eigen thema.
- Technisch: instelling `theme` (alleen via `/api/platform/theme`), de
  server levert `shared/theme.css` met de CSS-variabelen `--at-*` uit
  `shared/brand.css`. E-mails gebruiken nog de vaste huisstijl.

## Server (Docker)

De app is een gewone webserver in een Docker-container
(`docker-compose.yml` in de root van de repository):

```sh
git clone https://github.com/danieldh00/Aquatech.git && cd Aquatech
docker compose up -d --build        # http://<server>:3300
```

- **Eerste start**: open de app en maak het eerste beheerdersaccount aan
  (zie *Gebruik*). Het scherm vraagt de **installatiecode** die bij het
  starten in het log staat (`docker compose logs aquatech`), of de
  toegangscode als die via `ACCESS_CODE` is ingesteld. Een vaste code kan
  ook met `SETUP_CODE`.
- **Gegevens** staan in het volume `aquatech-data` (`/data` in de container):
  de database met plannen, historie, gebruikers en instellingen, de
  sessiesleutel en (zonder `AQUATECH_MASTER_KEY_FILE`) de hoofdsleutel
  `master-key`. Back-up: `docker compose cp aquatech:/data ./backup`.
- **Bijwerken**: `git pull && docker compose up -d --build`.
- **HTTPS**: zet er een reverse proxy (Caddy, Traefik, nginx) of een
  Cloudflare-tunnel voor die `X-Forwarded-Proto: https` meestuurt; dan
  krijgen de inlogcookies de `Secure`-vlag.
- **Overzetten** van een eerdere installatie: kopieer `aquatech.db`,
  `master-key` en `session-secret` uit de oude `/data`-map naar het volume; alle plannen,
  gebruikers, instellingen en inlogs gaan mee. Heeft die database nog geen
  beheerdersaccount, dan verschijnt bij de eerste aanmelding het scherm om
  er een aan te maken.
- **Cloudflare-tunnel**: laat de tunnel naar `http://<server>:3300` wijzen
  (of naar de containernaam `aquatech:3300` als cloudflared in hetzelfde
  Docker-netwerk draait).

## Database: Supabase (PostgreSQL)

De productieserver draait op Supabase (PostgreSQL), via `DATABASE_URL_FILE`
(een Docker-secret met de URL) of `DATABASE_URL`. Zonder die instelling
gebruikt de app het SQLite-bestand `/data/aquatech.db`: handig voor lokaal
ontwikkelen, de tests en als noodterugval. Beide databases hebben hetzelfde
schema en elke wijziging wordt in CI op beide getest.

- **Back-up nu maken** (ook terwijl de app draait):
  `docker compose exec -u 1000 aquatech node src/backup.js create`. Zo doet
  `update.sh` het ook vóór elke update.

- **Schema** `aquatech` (instelbaar met `DATABASE_SCHEMA`), niet `public`:
  dat schema stelt Supabase open via zijn REST-API. Op elke tabel staat row
  level security aan zonder policies, en de rollen `anon` en `authenticated`
  hebben geen rechten; alleen de app (eigenaar) leest en schrijft.
- **Gelijk aan SQLite**: dezelfde tabellen, kolommen, controles, foreign
  keys en indexen; tekst met bytevolgorde (`COLLATE "C"`), gehele getallen
  64-bits. De app maakt het schema bij de eerste start zelf aan.
- **Verbinding**: gebruik in Supabase *Connect → Session pooler* (poort
  5432, werkt via IPv4). De *Transaction pooler* (6543) weigert de app. TLS
  is verplicht met controle van het certificaat; de root-CA van Supabase
  (*Supabase Root 2021 CA*, SHA-256 `80:70:25:AD:…:CA:FA`) zit in de app.
  Een eigen CA kan met `DATABASE_CA_FILE`. Kies een EU-regio (Frankfurt):
  elke query wacht op de database, dus een korte afstand houdt de app snel.
- **Zuinig met queries** (0.47.0): met PostgreSQL is elke query een
  rondgang over het netwerk. Daarom: sessie, gebruiker en tenant in één
  query per verzoek; `last_seen_at` alleen schrijven als het nodig is;
  statische bestanden van een pagina na een geslaagde controle 30 seconden
  zonder nieuwe sessiequery; detailpagina's in één query; overzichten met
  alleen de kolommen die ze tonen (plannen: alleen vlakken en aantallen, nooit
  de achtergrond; geen versleutelde links, foto's of wachtwoord-hashes in
  lijsten); geen query per regel (portaal, dossiers, supporttoestemmingen).
  `test/queries.test.js` bewaakt dat, en dat er nergens `SELECT *` staat:
  elke query noemt zijn kolommen.
- **Hoofdsleutel blijft nodig**: geheimen staan versleuteld in de database
  met de hoofdsleutel van de app; die sleutel gaat niet naar Supabase.
- **Back-ups**: de dagelijkse versleutelde back-up van de app werkt ook met
  PostgreSQL (een SQLite-bestand met alle rijen). Supabase maakt daarnaast
  eigen back-ups (afhankelijk van het abonnement).

**Overstappen (één op één).** Eerst moet de server deze versie draaien. Dan,
in `/opt/apps/aquatech` (of de map met `docker-compose.yml`):

```sh
# 1. URL van Supabase (Connect -> Session pooler) als secret, met het wachtwoord erin
printf '%s' 'postgresql://postgres.<project>:<wachtwoord>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' > secrets/database-url
sudo chown 1000:1000 secrets/database-url && sudo chmod 400 secrets/database-url
# 2. In compose.yml de regels voor database-url aanzetten (environment + secrets)
# 3. App stoppen en alles kopiëren + controleren
docker compose stop aquatech
docker compose run --rm --no-deps aquatech node src/migrate-to-postgres.js
# 4. Zegt het script "Alles is één op één gelijk", dan starten
docker compose up -d aquatech
docker compose logs aquatech | grep Database     # Database: PostgreSQL (schema aquatech)
```

Het script vergelijkt na het kopiëren per tabel het aantal rijen en een
SHA-256 over alle waarden; bij een verschil stopt het en blijft de app op
SQLite. Het kopieert alleen naar een leeg schema. Later opnieuw controleren:
`node src/migrate-to-postgres.js --check`. **Terug naar SQLite**: de
`DATABASE_URL_FILE`-regel weer uitzetten en herstarten; `/data/aquatech.db`
blijft ongewijzigd staan (zonder wat er daarna in PostgreSQL is veranderd).

**Back-up terugzetten naar PostgreSQL**: ontsleutel de back-up (zie
*Beveiliging en privacy*) en kopieer hem met
`node src/migrate-to-postgres.js --from /data/terug.db --schema <nieuw_schema>`
naar een leeg schema; zet daarna `DATABASE_SCHEMA` op dat schema.

## Beveiliging en privacy

Getoetst aan OWASP ASVS (niveau 2) en de AVG.

| Onderdeel | Hoe |
|---|---|
| Geheimen (API-sleutel, toegangscode) | AES-256-GCM in de database, sleutel per doel afgeleid (HKDF) van de hoofdsleutel |
| Wachtwoorden | scrypt (N=2^17, r=8, p=1), minimaal 12 tekens, geen voorspelbare woorden of gebruikersnaam |
| Sessies | op de server, token alleen als SHA-256-hash opgeslagen; verloopt na 14 dagen zonder gebruik, uiterlijk na 30 dagen |
| Inloggen | max. 10 pogingen per kwartier per IP en per gebruikersnaam (per organisatie); achter de Cloudflare-tunnel telt het IP van de bezoeker (`CF-Connecting-IP`, alleen vertrouwd van een proxy in het eigen netwerk) |
| Verzoeken van andere sites | SameSite=Lax-cookies, schrijven alleen met JSON, en wijzigingen met `Sec-Fetch-Site: same-site/cross-site` (ook andere subdomeinen) worden geweigerd |
| Webshop en mailserver | alleen openbare adressen: de naam wordt opgezocht en lokale/interne adressen (LAN, Docker, Tailscale, localhost) worden geweigerd, zodat een organisatie het netwerk van de server niet kan aftasten (`ALLOW_PRIVATE_HOSTS=1` alleen voor ontwikkelen) |
| Eerste beheerder | alleen met de installatiecode uit het serverlog of de toegangscode |
| Auditlog | inloggen, uitloggen, gebruikers en instellingen (Beheer → Auditlog) |
| Bewaartermijnen | IP-adressen 90 dagen, auditlog 365 dagen (instelbaar) |
| Back-ups | dagelijks, AES-256-GCM, 14 dagen bewaard (instelbaar), downloadbaar voor opslag elders |
| Foto's | verkleind zonder EXIF/GPS, AES-256-GCM in de database (eigen afgeleide sleutel, tenant + foto-id als AAD), alleen JPEG/PNG/WebP |
| Recht op vergetelheid | Plannenoverzicht → plan → *Definitief wissen* (plan + inhoud van de historie) |
| Database | SQLite: rechten 0600, `secure_delete`, integriteitscontrole bij de start; PostgreSQL: TLS met certificaatcontrole, eigen schema met row level security |
| Proces | draait als gewone gebruiker (uid 1000), niet als root |
| Browser | Content-Security-Policy, X-Frame-Options, HSTS via https, `no-store` op de API |

**Hoofdsleutel.** Standaard maakt de app bij de eerste start
`/data/master-key` aan. Daarmee is een gelekt databasebestand alleen niet
genoeg, maar wie het hele volume heeft, heeft ook de sleutel. Beter: zet de
sleutel buiten het volume als Docker-secret:

```sh
mkdir -p secrets && docker compose cp aquatech:/data/master-key secrets/master-key   # of: openssl rand -hex 32 > secrets/master-key (alleen bij een nieuwe installatie)
chmod 600 secrets/master-key
```

en zet in `docker-compose.yml` de regels onder *Hoofdsleutel als
Docker-secret* aan. Bewaar daarnaast een kopie van de sleutel in een
wachtwoordkluis: zonder de sleutel zijn de opgeslagen geheimen onbruikbaar
(een nieuwe sleutel betekent API-sleutel en toegangscode opnieuw invullen).

**Back-ups terugzetten.** Stop de app, ontsleutel de back-up en zet die
als database terug:

```sh
docker compose stop aquatech
docker compose run --rm --no-deps -e RUN_AS_ROOT=1 aquatech \
  node src/backup.js decrypt /data/backups/aquatech-JJJJMMDD-UUMMSS.db.enc /data/terug.db
# controleer, en vervang daarna /data/aquatech.db door /data/terug.db
docker compose start aquatech
```

Een wis-opdracht (definitief wissen) staat nog in de back-ups tot die na de
bewaartermijn verdwijnen; vermeld dat in de privacyverklaring.

**Nog te regelen bij de serverinrichting**

- Schijfversleuteling op de host (LUKS/BitLocker) of een VPS-aanbieder met
  versleutelde opslag in de EU.
- De versleutelde back-ups uit `/data/backups` (of `BACKUP_DIR` op een
  andere schijf) dagelijks naar een andere locatie kopiëren, periodiek een
  terugzettest; de hoofdsleutel apart bewaren.
- HTTPS via de Cloudflare-tunnel of een reverse proxy; poort 3300 niet
  rechtstreeks open zetten naar internet (alleen de tunnel).
- Host bijwerken (`git pull && docker compose up -d --build` voor de app,
  en het besturingssysteem/Docker zelf).
- AVG: verwerkersovereenkomst met hosting- en AI-aanbieder (Anthropic, alleen
  als AI-herkenning aanstaat), privacyverklaring voor klanten en een
  register van verwerkingen.

## Let op

- Prijzen in de stuklijst zijn indicatief.
- Berekeningen zijn indicatief (geen hoogteverschillen). Controleer druk en
  debiet altijd ter plaatse.
