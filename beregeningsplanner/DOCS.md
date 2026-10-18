# Aquatech

Dashboard met modules. De eerste module is de **beregeningsplanner**:
ontwerp een automatische tuinberegening en exporteer de stuklijst naar
Excel. Planning en voorraadbeheer volgen.

## Gebruik

1. Start de app. Zonder verdere instellingen is het dashboard bereikbaar
   via het **Aquatech**-paneel in het HA-zijmenu en via
   `https://aquatech.den-hollander.com`, zonder inloggen. Klik op de tegel
   **Beregeningsplanner** (of ga direct naar `.../beregening/`); met
   **Overzicht** linksboven in de planner ga je terug naar het dashboard.
2. Wil je de publieke URL afschermen? Vul dan onder **Configuratie** een
   `access_code` in en herstart de app. Buiten Home Assistant om moet je dan
   één keer inloggen (het toestel onthoudt dat een jaar); via het HA-paneel
   is nooit een code nodig.
3. Klik op **Voorbeeld** om een ingevulde tuin te zien, of begin met
   **Nieuw** en doorloop de zes stappen links.

## Cloudflare-tunnel

De app luistert op poort 3300. In de Cloudflared-app staat daarvoor bij
`additional_hosts`:

```yaml
- hostname: aquatech.den-hollander.com
  service: http://c1355dc8-beregeningsplanner:3300
```

`c1355dc8-beregeningsplanner` is de slug van deze app met `_` vervangen door
`-`. Na wijzigen de Cloudflared-app herstarten.

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
  **Configuratie** als `anthropic_api_key`. Herstart daarna de app.
- Elke analyse kost een paar dubbeltjes aan API-tegoed. `ai_daily_limit`
  (standaard 30) begrenst het aantal analyses per dag voor de hele app; daarnaast
  geldt een maximum van 10 per uur per verbinding.
- Het plan wordt voor de analyse naar Anthropic gestuurd. Zonder sleutel blijft
  alles lokaal.

## Toverstaf

Werkt zonder API-sleutel. Laad een plan als ondergrond, kies in stap 2 bij een
soort vlak **Toverstaf** en klik midden in het vlak op het plan. De rand wordt
op kleur uitgetrokken; met **Gevoeligheid toverstaf** stel je in hoe sterk
kleuren mogen afwijken.

## Opslag

Plannen worden automatisch op twee plekken bewaard: in de browser van het
toestel en, een paar seconden na elke wijziging, in **Mijn plannen** op de
server (database `/data/aquatech.db`, zit in de back-ups van Home
Assistant). Via **Mijn plannen** in de planner (of op het dashboard) open je
een eerder plan. Iedere gebruiker ziet daar alleen de eigen plannen.
**Opslaan** downloadt daarnaast nog steeds een `.aquaplan.json`-bestand en
**Openen** laadt zo'n bestand als nieuw plan.

## Gebruikers, rollen en historie van aanvragen

Er zijn twee rollen:

| Rol | Ziet | Wie |
| --- | --- | --- |
| **Beheerder** | alle plannen, de historie van alle aanvragen, gebruikersbeheer (module **Beheer**) | het HA-paneel, inloggen met de `access_code`, accounts met rol beheerder |
| **Gebruiker** | alleen de eigen plannen | accounts met rol gebruiker, en gasten |

- **Accounts** maak je als beheerder aan onder **Beheer → Gebruikers**
  (gebruikersnaam, naam, rol, wachtwoord van minimaal 8 tekens). Inloggen
  via `.../login` of de knop **Inloggen** rechtsboven. Een nieuw wachtwoord
  of uitschakelen logt de gebruiker op alle toestellen uit.
- **Gasten**: zolang er geen `access_code` is, kan iedereen de planner
  zonder inloggen gebruiken. Elke browser krijgt dan een eigen anonieme
  gebruiker en ziet alleen de eigen plannen. Met een `access_code` zijn er
  geen gasten: inloggen (code of account) is verplicht.
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

## Let op

- Prijzen in de stuklijst zijn indicatief.
- Berekeningen zijn indicatief (geen hoogteverschillen). Controleer druk en
  debiet altijd ter plaatse.
