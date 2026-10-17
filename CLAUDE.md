# Aquatech Beregeningsplanner — werkgeheugen

Webapp om tuinberegening te ontwerpen (in de lijn van de DVS Beregnungsplaner).
Draait voorlopig als Home Assistant-add-on (alleen ingress, paneel
**Beregening**); later op een eigen server via `docker-compose.yml`.

Zusterprojecten met hetzelfde add-on-patroon: `danieldh00/Hardlooptool`
(poort 3200), `danieldh00/Lijstjes` (3100), `danieldh00/Russianlanguageapp`
(3000). Deze add-on gebruikt **poort 3300**.

## Branchmodel

- Supervisor kloont de **default branch** van GitHub. Die is nu nog
  `feature/beregeningsplanner` (eerste push); doel is **`master`** als
  productiebranch en GitHub-default, met features via `feature/<naam>` of
  `claude/<naam>`. Na het omzetten van de default branch de repository in HA
  verwijderen en opnieuw toevoegen (let op: dan verandert de slug).
- Elke wijziging in `beregeningsplanner/` op de productiebranch vereist een
  **versie-bump** in `beregeningsplanner/config.yaml` + entry in `CHANGELOG.md`,
  anders biedt HA geen update aan. `scripts/check_addon_version.py` (workflow
  `addon-version.yml`, op `master`) bewaakt dat.

## Home Assistant

- Repository `https://github.com/danieldh00/Aquatech` (store-slug `c1355dc8`),
  app-slug **`c1355dc8_beregeningsplanner`**, auto_update + watchdog aan.
- Alleen ingress (paneel **Beregening**), geen gepubliceerde poort en geen login.
- Logs: `ha_get_logs(source="supervisor", slug="c1355dc8_beregeningsplanner")`;
  health via ingress: `ha_manage_app(slug=..., path="/api/health")`.

## Harde regels

- **Alle URL's in de frontend relatief** (`css/app.css`, nooit `/css/...`):
  onder ingress draait de app op `/api/hassio_ingress/<token>/`. Geen CDN's:
  vendor-bestanden lokaal in `frontend/vendor/` (test controleert dit).
- Frontend gebruikt gewone `<script>`-tags (geen ES-modules), zodat
  `index.html` ook via `file://` werkt.
- Geen native npm-modules (multi-arch: aarch64 + amd64, image wordt op de host gebouwd).
- UI-teksten, commentaar, changelog en docs in het **Nederlands**.
- Exports: **Excel (.xlsx), geen CSV**, tenzij expliciet anders gevraagd.
- Geen modelnamen/-ID's in commits, PR's, code of docs.
- Prijzen in `frontend/js/catalog.js` zijn indicatieve placeholders.
- **Nooit `pkill -f`** in de cloud-sandbox; stop een testserver met
  `kill $(lsof -ti tcp:3300)`.

## Lokaal draaien en testen

```sh
cd beregeningsplanner/backend && npm install
PORT=3300 node src/server.js      # http://localhost:3300
npm test                          # node --test
```

Docker is niet beschikbaar in de cloud-sandbox; CI (`ci.yml`) bouwt en
smoketest de image voor amd64 en arm64. Playwright/Chromium staat klaar
(`$(npm root -g)/playwright`, browsers in `/opt/pw-browsers`).
