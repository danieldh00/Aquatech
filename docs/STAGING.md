# Staging en develop (Vue-migratie)

Besluit Daniël 2026-11-24. Doel: de frontend stap voor stap naar Vue 3 + TypeScript + Vite ombouwen in een omgeving die
volledig los staat van productie. Plan en fasen: projectbestand `frontend-advies/frontend-advies-vue.xlsx`.

## Branches
- `master` blijft productie; `release.yml` bouwt er `ghcr.io/danieldh00/aquatech:<versie>` uit.
- `develop` is de integratiebranch van de migratie. Alleen de migratiethread (en infrastructuur) werkt erin; alle andere
  threads blijven naar `master` werken.
- PR's naar `develop` krijgen dezelfde controles als naar `master`: CI, security-scans, layoutcheck, `version-must-increase`
  en de Claude code- en security-review (`claude-review.yml`, `version.yml` draaien voor beide branches).
- `develop-sync.yml` voegt `master` elke dag en na elke geslaagde Release samen in `develop`. Bij een conflict komt er
  één issue (label `develop-sync`) "master naar develop: merge-conflict"; de migratiethread lost dat op in een PR naar `develop`.
- Per geaccepteerde module een PR `develop` -> `master` (volledige CI en reviews opnieuw). Een module die op `develop`
  gemigreerd wordt, krijgt tot de overschakeling geen nieuwe features op `master`.

## Images (kan nooit bij productie terechtkomen)
- `staging.yml` bouwt bij een push naar `develop` (en op afroep voor elke ref) naar `ghcr.io/danieldh00/aquatech-staging`
  (`:develop-<12 tekens commit>` en `:latest`); de versie is die van `package.json`.
- `deploy/apps01/update.sh` haalt hard `ghcr.io/danieldh00/aquatech:latest` op en controleert de handtekening van
  `release.yml@refs/heads/master`. Het staging-pakket heeft een andere naam en geen die handtekening.

## Instellingen die Daniël eenmalig doet (GitHub)
1. **Ruleset voor `develop`**: Settings > Rules > Rulesets > de ruleset van `master` dupliceren en als doel `develop`
   kiezen. Dezelfde regels: PR verplicht, geen force-push of verwijderen, dezelfde verplichte checks (o.a. *Claude code review*,
   *Claude security review*, `version-must-increase`, `test`, de PostgreSQL-testjob). Geen bypass voor reviews.
2. **Bypass alleen voor de sync**: de eigenaar van `RELEASE_PUSH_TOKEN` krijgt (net als op `master`) bypass op de ruleset van
   `develop`, zodat `develop-sync.yml` de mergecommit kan pushen.
3. **Branch `develop` aanmaken** vanaf `master` (pas als dit is gemerged en de ruleset staat).
4. Pakket `aquatech-staging` (verschijnt na de eerste staging-build) op **openbaar** zetten, of een pull-token op stg01
   zetten (de servertaak vraagt erom). Het image bevat alleen de (openbare) code, geen geheimen.

## stg01 aanmaken en inrichten
1. **VM maken in Proxmox** (eenmalig, handmatig): Debian 12 of Ubuntu 24.04, naam `stg01`, 2 vCPU, 3 GB RAM (ballooning uit),
   25 GB schijf, gebruiker `daniel` met je ssh-sleutel en `sudo` zonder wachtwoord (zoals op apps01), guest agent aan.
   Proxmox-firewall voor deze VM: inkomend alleen ssh vanaf de Proxmox-host; uitgaand niet naar apps01, de
   productiedatabase of andere interne netwerken (alleen internet: GHCR, Cloudflare, PDOK/VIES).
2. **Cloudflare** (eenmalig, handmatig): een eigen tunnel `staging` met hostnaam `staging.aquatech.den-hollander.com` naar
   `http://aquatech-stg:3300`, en een Access-toepassing op die hostnaam met een beleid dat alleen jouw e-mailadres toelaat.
3. **Master mergen, workflow Staging draaien** (push naar `develop` met wijzigingen in `hub/`, of Actions > Staging > Run workflow): dit bouwt het eerste
   image. Zet daarna het pakket `aquatech-staging` op openbaar.
4. **Servertaak 012** (volgt in een aparte PR, na V-10) staat in Beheer > Systeem > Updates; je voert het ene vaste commando uit (zoals altijd, als root op de
   Proxmox-host). De taak vraagt eenmalig om de tunnel-token (verborgen invoer) en richt stg01 in. Een andere naam of gebruiker:
   `STG01_SSH=gebruiker@adres` voor het commando.
5. **In de app op staging**: eerste beheerder aanmaken (installatiecode: `docker logs aquatech-stg`), E-mail naar `mailpit`
   poort 1025 zetten (berichten bekijken op `127.0.0.1:8025` op de VM, via ssh-tunnel), geen koppelingen instellen (Mollie,
   Visma, Drive, DPD), een eigen AI-sleutel met een lage daglimiet. Testdata: Hoofdbeheer > testomgeving aanmaken >
   testdata vullen.

Wat er nooit gebeurt: gegevens, hoofdsleutel of geheimen uit productie op stg01. Een geanonimiseerde kopie van productie komt
later (bij de migratie van Facturen) als aparte, geteste servertaak.

## Egress
De VM mag alleen naar internet voor GHCR, Cloudflare en (voor de adreszoeker en btw-controle) PDOK en VIES. Er is geen
koppeling met Mollie, Visma, Drive of DPD ingesteld en mail gaat alleen naar Mailpit. Het afsluiten van de rest regel je
in de Proxmox-firewall van de VM (zie stap 1 bij *stg01 aanmaken*).
