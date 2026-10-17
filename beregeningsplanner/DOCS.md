# Beregeningsplanner

Ontwerp een automatische tuinberegening en exporteer de stuklijst naar Excel.

## Gebruik

1. Start de app. Zonder verdere instellingen is de planner bereikbaar via
   het **Beregening**-paneel in het HA-zijmenu en via
   `https://aquatech.den-hollander.com`, zonder inloggen.
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

**Lokaal** werkt het best op gekleurde tuinontwerpen:

| Kleur in het plan | Wordt |
|---|---|
| Licht- en middengroen | Gazon |
| Donkergroen | Haag / heesters |
| Bruin, oranje, roze, paars | Beplanting |
| Grijs, licht beige | Bebouwing en verharding (droog houden) |
| Blauw | Water (mag nat worden) |
| Wit (papier), zwart (lijnen, tekst) | Genegeerd |

De schaal wordt gelezen uit een maat met maatlijn: "12,00 m", "450 cm" of
een getal als "8500" (millimeters, zoals op bouwtekeningen). Staat er geen
maat op, kalibreer dan de schaal zelf. Lijntekeningen zonder kleur trek je uit
met de toverstaf. **AI** leest ook lijntekeningen, schetsen en luchtfoto's.

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

Projecten worden in de browser van het toestel bewaard (niet in de add-on).
Gebruik **Opslaan** om een `.aquaplan.json`-bestand te downloaden en
**Openen** om het later (of op een ander toestel) weer te laden.
Let op: het HA-zijpaneel en `aquatech.den-hollander.com` zijn voor de browser
twee verschillende websites en delen dus geen opgeslagen project.

## Let op

- Prijzen in de stuklijst zijn indicatief.
- Berekeningen zijn indicatief (geen hoogteverschillen). Controleer druk en
  debiet altijd ter plaatse.
