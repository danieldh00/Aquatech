# Staging en develop (Vue-migratie)

Besluit Daniël 2026-11-24. Doel: de frontend stap voor stap naar Vue 3 + TypeScript + Vite ombouwen in een omgeving die
volledig los staat van productie. Plan en fasen: projectbestand `frontend-advies/frontend-advies-vue.xlsx`.

## Branches
- `master` blijft productie; `release.yml` bouwt er `ghcr.io/danieldh00/aquatech:<versie>` uit.
- `develop` is de integratiebranch van de migratie. Alleen de migratiethread (en infrastructuur) werkt erin; alle andere
  threads blijven naar `master` werken.
- PR's naar `develop` krijgen dezelfde controles als naar `master`: CI, security-scans, layoutcheck, `version-must-increase`
  en de Claude code- en security-review (`claude-review.yml`, `version.yml` draaien voor beide branches).
- `sync-develop.yml` voegt `master` elke dag, na elke push en na elke Release samen in `develop`. Bij een conflict komt er
  één issue "Sync master naar develop: conflict"; de migratiethread lost dat op in een PR naar `develop`.
- Per geaccepteerde module een PR `develop` -> `master` (volledige CI en reviews opnieuw). Een module die op `develop`
  gemigreerd wordt, krijgt tot de overschakeling geen nieuwe features op `master`.

## Images (kan nooit bij productie terechtkomen)
- `staging.yml` bouwt bij een push naar `develop` (en op afroep voor elke ref) naar `ghcr.io/danieldh00/aquatech-staging`
  (`:sha-<commit>` en `:staging`), met versie `<package.json>-staging.<commit>`.
- `deploy/apps01/update.sh` haalt hard `ghcr.io/danieldh00/aquatech:latest` op en controleert de handtekening van
  `release.yml@refs/heads/master`. Het staging-pakket heeft een andere naam en geen die handtekening.

## Instellingen die Daniël eenmalig doet (GitHub)
1. **Ruleset voor `develop`**: Settings > Rules > Rulesets > de ruleset van `master` dupliceren en als doel `develop`
   kiezen. Dezelfde regels: PR verplicht, geen force-push of verwijderen, dezelfde verplichte checks (o.a. *Claude code review*,
   *Claude security review*, `version-must-increase`, `test`, de PostgreSQL-testjob). Geen bypass voor reviews.
2. **Bypass alleen voor de sync**: de eigenaar van `RELEASE_PUSH_TOKEN` krijgt (net als op `master`) bypass op de ruleset van
   `develop`, zodat `sync-develop.yml` de mergecommit kan pushen.
3. **Branch `develop` aanmaken** vanaf `master` (pas als dit is gemerged en de ruleset staat).
4. Pakket `aquatech-staging` (verschijnt na de eerste staging-build) op **openbaar** zetten, of een pull-token op stg01
   zetten (de servertaak vraagt erom). Het image bevat alleen de (openbare) code, geen geheimen.
