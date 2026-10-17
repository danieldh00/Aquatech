# Changelog

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
