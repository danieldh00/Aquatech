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
