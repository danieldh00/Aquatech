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
4. Het pakket `aquatech-staging` (verschijnt na de eerste staging-build) erft de zichtbaarheid van de repository; controleer
   bij Packages dat het openbaar is. Het image bevat alleen de (openbare) code, geen geheimen.

## stg01 aanmaken en inrichten (één commando)
Alles loopt via **servertaak 012** in Beheer > Systeem > Updates: je voert het ene vaste commando uit (als root op de
Proxmox-host, zoals altijd). De taak doet zelf:
1. **VM stg01 aanmaken** (`deploy/staging/pve/stg01-create.sh`): Debian 12 cloud-image (controlesom van Debian gecontroleerd),
   2 vCPU, 3 GB RAM, 32 GB schijf, gebruiker `daniel` met de ssh-sleutel van de host, guest agent. Bestaat de VM al, dan
   gebeurt er niets. VM-id 9101 (`VMID=` in de omgeving om af te wijken).
2. **Cloudflare via de API** (`deploy/staging/pve/cloudflare-staging.py`): tunnel `aquatech-staging`, DNS en Access voor
   `aquatech-staging.den-hollander.com` (de app) en `aquatech-staging-mail.den-hollander.com` (Mailpit). Access laat alleen
   één e-mailadres toe: dat van de accounteigenaar (alleen als er precies één eigenaar is; anders stopt het script en geef je `CF_ACCESS_EMAIL=...` mee in het commando). De hostnamen staan één niveau
   onder het domein, dus het gratis Cloudflare-certificaat dekt ze.
3. **Inrichten** (`deploy/staging/setup-staging.sh`): Docker, eigen PostgreSQL, Mailpit, de app uit
   `ghcr.io/danieldh00/aquatech-staging` en de updatetimer.

**Eenmalig vraagt de taak om een Cloudflare API-token** (onzichtbare invoer, wordt nergens opgeslagen; alleen het tunnel-token
komt als bestand op stg01). Maak het in Cloudflare > Mijn profiel > API-tokens > Eigen token, met alleen deze rechten:
Account: Cloudflare Tunnel Bewerken; Account: Toegang: Apps en beleid bewerken; Account: Accountinstellingen lezen;
Zone (den-hollander.com): DNS bewerken en Zone lezen. Laat je het token leeg, dan staat staging er wel maar zonder tunnel
en blijft de taak openstaan tot je het commando opnieuw draait. Het commando is veilig herhaalbaar.

Voorwaarden: de workflow *Staging* heeft minstens één image gebouwd (Actions > Staging > Run workflow op `develop`) en het
pakket `aquatech-staging` is leesbaar zonder inloggen (het erft de zichtbaarheid van de repository).

**In de app op staging**: eerste beheerder aanmaken (installatiecode: `docker logs aquatech-stg` op de VM), E-mail naar
`mailpit` poort 1025 zetten (berichten bekijken op https://aquatech-staging-mail.den-hollander.com), geen koppelingen instellen
(Mollie, Visma, Drive, DPD), een eigen AI-sleutel met een lage daglimiet. Testdata: Hoofdbeheer > testomgeving aanmaken >
testdata vullen.

Wat er nooit gebeurt: gegevens, hoofdsleutel of geheimen uit productie op stg01. Een geanonimiseerde kopie van productie komt
later (bij de migratie van Facturen) als aparte, geteste servertaak.

## Egress
De VM mag alleen naar internet voor GHCR, Cloudflare en (voor de adreszoeker en btw-controle) PDOK en VIES. Er is geen
koppeling met Mollie, Visma, Drive of DPD ingesteld en mail gaat alleen naar Mailpit. Het afsluiten van de rest regel je
in de Proxmox-firewall van de VM. Dat is niet geautomatiseerd (een fout regel kan de VM van DNS of updates afsluiten); er is ook niets ingesteld wat naar buiten kan sturen.
