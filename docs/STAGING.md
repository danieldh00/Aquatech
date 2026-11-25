# Staging en develop (Vue-migratie)

Besluit Daniël 2026-11-24. Doel: de frontend stap voor stap naar Vue 3 + TypeScript + Vite ombouwen in een omgeving die los
staat van de testomgeving. Plan en fasen: projectbestand `frontend-advies/frontend-advies-vue.xlsx`.

## Branches
- `master` blijft productie; `release.yml` bouwt er `ghcr.io/danieldh00/aquatech:<versie>` uit.
- `develop` is de integratiebranch van de migratie. Alleen de migratiethread (en infrastructuur) werkt erin; alle andere
  threads blijven naar `master` werken.
- PR's naar `develop` krijgen dezelfde controles als naar `master`: CI, security-scans, layoutcheck, `version-must-increase`
  en de Claude code- en security-review (`claude-review.yml` en `version.yml` draaien voor beide branches).
- `develop-sync.yml` voegt `master` elke dag en na elke geslaagde Release met een eigen mergecommit samen in `develop`
  (nooit geforceerd). Bij een conflict komt er één issue (label `develop-sync`); de migratiethread lost dat op in een PR naar `develop`.
- Per geaccepteerde module een PR `develop` -> `master` (volledige CI en reviews opnieuw).

## Opzet van de stagingomgeving
Een tweede opstelling op apps01, naast de testomgeving. Gedeeld zijn alleen de server en de bestaande Cloudflare-tunnel; verder niets.

| Onderdeel | Staging | Testomgeving |
|---|---|---|
| Map | `/opt/apps/aquatech-staging` (eigen clone `repo/`) | `/opt/apps/aquatech` |
| Compose-project | `aquatech-staging` | `aquatech` |
| Image | `aquatech-staging:<commit>`, op de server gebouwd, label `nl.aquatech.staging=1` | `ghcr.io/danieldh00/aquatech` |
| Containers | `aquatech-staging`, `aquatech-staging-postgres` | `aquatech`, `aquatech-postgres` |
| Database, geheimen, mappen | eigen (`pgdata/`, `secrets/`, `data/`) | eigen |
| Updatemechanisme | geen koppeling (geen `update/`-mappen) | `update.sh`, app-update |
| Poort | alleen `127.0.0.1:3310`; in het tunnelnetwerk de alias `aquatech-staging` | `3300` |

- De app krijgt `AQUATECH_STAGING=1`: elke pagina toont de balk "STAGING" en alle antwoorden krijgen `noindex`.
- Images van derden staan op een vaste digest (Renovate werkt ze bij); het app-image wordt nooit uit een registry gehaald.
- **Geen koppelingen**: geen mail, geen back-up naar buiten, geen betalingen, geen andere externe diensten. `.env.example` laat die leeg.
  Een AI-sleutel alleen met een lage daglimiet (liever in de app zelf).
- De enige proxy die de app gelooft (`TRUSTED_PROXIES`) is het IP-adres van de tunnelcontainer; het script leest dat bij elke run.

## `deploy/staging/install-staging.sh`
Eén script (root, veilig herhaalbaar, met lockbestand) dat inricht én bijwerkt:
- Volgt `origin/develop`, en `origin/master` zolang `develop` niet bestaat.
- Eerste installatie: weigert bij minder dan 6 GB vrij op de Docker-schijf (opruimen: `servertaken.sh schijf`), maakt een `.env`
  (mode 600) en eigen geheimen in `secrets/` (nooit afgedrukt) en neemt van de testomgeving alleen de naam van de
  tunnelcontainer en van zijn netwerk over (alleen-lezen via `docker inspect`).
- Bouwt het image op de server, start eerst de database, zet het wachtwoord van de databaserol van de app (via stdin, buiten het
  log), start de app en wacht op de health-check. De uitgerolde commit staat in `state/deployed`.
- Start een commit niet gezond (of bouwt hij niet), dan draait de vorige weer en wordt die commit overgeslagen tot er een
  nieuwere komt (`state/skipped`).
- Vult een lege database met verzonnen testdata: eerste beheerder `beheer` (wachtwoord in `secrets/admin-password`), een
  testomgeving "Staging testdata" met testaccounts (gedeeld wachtwoord in `secrets/testdata-password`). Nooit gegevens van de testomgeving.
- Ruimt alleen oude images met het eigen label op (de draaiende en de vorige blijven).
- Installeert `aquatech-staging-update.service` en `.timer`: elke 15 minuten `--timer`. Dat doet niets bij dezelfde commit, een
  gezonde app en hetzelfde tunnel-IP; is het IP veranderd, dan gaat de opstelling opnieuw omhoog; is er even geen IP en draait
  staging gezond op de juiste commit, dan logt het en stopt met code 0.
- Het script op de server is de kopie die servertaak 012 op een vaste commit ophaalt; wijzigingen aan het script zelf komen dus alleen
  op de server via die taak (opnieuw draaien). De rest (compose, Dockerfile, app) komt mee met `develop`.

## Inrichten: servertaak 012
Draai het vaste commando uit Beheer > Systeem > Updates (zoals altijd, als root op de Proxmox-host); taak
`012-staging-op-apps01-inrichten` haalt het script op de vaste commit op en voert het uit, zonder invoer. Daarna twee handelingen in
Cloudflare (het script drukt ze aan het eind af):
1. Zero Trust > Netwerken > Tunnels > de bestaande tunnel > Gepubliceerde toepassing: `aquatech-staging.den-hollander.com` naar `http://aquatech-staging:3300`.
2. Zero Trust > Toegang > Toepassingen: een zelf gehoste toepassing voor die hostnaam met een beleid dat alleen jouw e-mailadres toelaat.

Controleren op de server: `docker ps --filter name=aquatech-staging`, `journalctl -u aquatech-staging-update.service`.

## Instellingen die Daniël eenmalig doet (GitHub)
1. **Ruleset voor `develop`**: Settings > Rules > Rulesets > de ruleset van `master` dupliceren met doel `develop` (PR verplicht,
   geen force-push, dezelfde verplichte checks incl. *Claude code review*, *Claude security review*, `version-must-increase`).
2. **Bypass alleen voor de sync**: de eigenaar van `RELEASE_PUSH_TOKEN` krijgt bypass op de ruleset van `develop`.

## Wat er nooit gebeurt
Gegevens, hoofdsleutel of geheimen uit de testomgeving op staging. Een geanonimiseerde kopie komt later (bij de migratie van
Facturen) als aparte, geteste servertaak.
