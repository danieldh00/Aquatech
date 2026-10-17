# Beregeningsplanner

Ontwerp een automatische tuinberegening en exporteer de stuklijst naar Excel.

## Gebruik

1. Vul onder **Configuratie** een `access_code` in (een wachtwoord naar
   keuze). Die heb je nodig om de planner buiten Home Assistant om te
   openen via `https://aquatech.den-hollander.com`.
2. Start (of herstart) de app.
3. Open de planner via het **Beregening**-paneel in het HA-zijmenu (geen code
   nodig), of via de tunnel-URL en log daar één keer in met de code.
4. Klik op **Voorbeeld** om een ingevulde tuin te zien, of begin met
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
