# AGENTS.md — AquaTech Hub

Korte ingang voor AI-agents. Details: `CLAUDE.md` (volledig werkgeheugen per onderdeel), `README.md` (overzicht), `hub/DOCS.md`.
**Eén bron voor de regels:** staat iets in beide, dan geldt `CLAUDE.md`; dit bestand is de snelle kaart.

## Wat is dit
AquaTech Hub: multitenant SaaS voor beregeningsexperts, opgebouwd uit modules (dashboard → modules, o.a. Beregeningsplanner, offertes, werkorders, planning, facturen, artikelen/voorraad/inkoop, klanten, portaal, orderpick, webshop).
Webshop = `/` (hoofdmap), de app = `/app/` (dashboard, modules, `/app/api`). Draait als gewone webserver in Docker (poort 3300), niets hangt van Home Assistant af. UI-teksten, commentaar en docs in het **Nederlands**.

## Kaart van de codebase
| Pad | Inhoud |
|---|---|
| `hub/backend/src/server.js` | Express-app, routes samenstellen, `identify()`, CSP (hoofdbeheerroutes `/api/platform` staan in `platform/platform-routes.js`) |
| `hub/backend/src/<onderwerp>/` | `database/` (db.js migraties `MIGRATIONS`, pgschema.js `PG_MIGRATIONS`), `beveiliging/`, `platform/` (store, instellingen, rollen, mail, nieuws, bewaking, back-ups), `beregening/`, `verkoop/` (offertes, facturen, klanten, Visma), `webshop/`, `uitvoering/` (werkorders, planning, portaal), `artikelen/` (voorraad, inkoop, prijsfactor), `mcp/` (AI-koppeling), `paginas/` (HTML door de server gevuld) |
| `hub/backend/test/` | `node --test`; gedeelde hulp in `test/helpers/` (`http-client.js`, fakes voor Mollie/PDOK/VIES/captcha/Google) |
| `hub/backend/tools/` | `codestyle.js`, `tenant-filter.js`, `release-notes.js`, baselines |
| `hub/frontend/<module>/` | één map per module met eigen `index.html`; gedeeld in `shared/`; moduleregister `dashboard/modules.js`; rechten `shared/roles.js` |
| `deploy/apps01/` | serverscripts (update.sh, systemd-timers, `pve/db-local.sh`, compose-bestanden) |
| `changes/` | releasenotes-fragmenten (zie `changes/README.md`) |
| `.github/workflows/` | `ci.yml`, `version.yml`, `release.yml`, `claude-review.yml` |

Per onderdeel staat een korte `CLAUDE.md` met alleen de regels van die map (`hub/backend/src/{webshop,artikelen,verkoop,uitvoering,beregening,platform,mcp}/` en `hub/frontend/`); lees die van de map waarin je werkt in plaats van het grote root-`CLAUDE.md`.

Nieuwe migratie: toevoegen in `MIGRATIONS` (db.js) **én** `PG_MIGRATIONS` (pgschema.js); controleer eerst het laatste vrije nummer (90+ is gereserveerd). Een nieuwe module: map onder `frontend/`, regel in `modules.js`, laadt `dashboard/modules.js` en daarna `shared/sidebar.js`.

## Commando's
```sh
cd hub/backend && npm install
DATA_DIR=/tmp/bp PORT=3300 node src/server.js     # http://localhost:3300/app/ → eerste beheerder
npm test                                           # node --test (SQLite)
TEST_DATABASE_URL=postgres://… npm test            # dezelfde suite tegen PostgreSQL (CI: test-postgres)
npm run codestyle                                  # namen + doc-blokken
npm run tenant-filter                              # tenant_id-filter in queries
kill $(lsof -ti tcp:3300)                          # testserver stoppen (nooit pkill -f)
```
Docker is niet beschikbaar in de cloud-sandbox. Er is geen aparte linter; `codestyle` en `tenant-filter` zijn onderdeel van `npm test`.

## Werkwijze en PR
- Algemene werkwijze: `docs/WERKWIJZE.md` (projectonafhankelijk); AquaTech-context: `docs/AQUATECH-CONTEXT.md`. **Wie de werkwijze verandert, werkt `docs/WERKWIJZE.md` bij in dezelfde PR** (de kopie in de projectbestanden, `werkwijze/WERKWIJZE.md`, wordt door de coördinator gelijkgehouden).
- Nooit rechtstreeks op `master`. Branch vers vanaf `origin/master` (`feature/<naam>` of `claude/<naam>`), kleine PR's, één onderwerp per PR.
- Volgorde: wijzigen → `npm test` → `changes/<naam>.md` (als `hub/` wijzigt) → `README.md` bijwerken bij features/setup → push → PR → CI groen + verplichte **Claude code review** en **Claude security review** → bevindingen oplossen vóór auto-merge.
- **Versie, `CHANGELOG.md` en `frontend/nieuws/releases.js` nooit zelf aanraken**; `release.yml` doet dat na de merge. Alleen docs/CI zonder effect: PR-label `geen-releasenotes`.
- Geen backwards-compatibiliteit nodig tijdens de ontwikkeling.
- Geen modelnamen/-ID's in commits, PR's, code of docs. Geen secrets in repo of chat.

## Servertaken (hosttaken)
Moet Daniël na een PR iets op de server doen (een serverscript opnieuw draaien, een unit installeren), geef hem dan **nooit een los commando in de chat**. Voeg een genummerde taak toe:
1. `HOST_TASKS` in `hub/backend/src/platform/host-tasks.js`: nieuwe id `NNN-korte-naam` (volgnummer erachter, een bestaande id verandert nooit), titel, uitleg, `addedAt`.
2. In `deploy/apps01/pve/servertaken.sh`: dezelfde id in `HOST_TASK_IDS` en een functie `hosttask_NNN_korte_naam` (idempotent; haal bestanden op `$TASKS_REF` op via `fetch_task_file`).
3. Klaar: de taak staat in Beheer > Systeem > Updates (afvinklijst, ook in het dashboardblok Openstaande taken) en Daniël voert het ene vaste commando uit (`HOST_COMMAND`, op de PVE-host als root; hij gebruikt `APPS01_SSH=daniel@apps01` + sudo). Gelukte taken worden door de server afgevinkt (`update/status/host-tasks.json`). `test/host-tasks.test.js` bewaakt dat app-lijst en script gelijk blijven.

## Codeconventies
- Beschrijvende namen (geen namen van één letter behalve `i`/`j`/`x`/`y`, geen cryptische afkortingen) en een `/** … */`-blok in het Nederlands bij elke functie; bestand begint met een kopcommentaar. Bewaakt door `test/codestyle.test.js`.
- Backend: geen `SELECT *`/`t.*`, geen N+1, elke query op een tabel met `tenant_id` filtert daarop, parameters altijd via `?`. SQL moet in SQLite én PostgreSQL werken.
- Frontend: gewone `<script>`-tags, alle URL's **relatief**, geen CDN (vendor lokaal), kleuren via `--at-*`-variabelen, scripts/CSS met `?v=<versie>`.
- Rechten op de server met `requireRight(recht)`; tests voor elke nieuwe route: andere tenant → 404, ontbrekend recht → 403. Elk openbaar of duur endpoint krijgt een limiet (`createRateLimiter`).
- Tests verplicht, ook voor randgevallen; unit + PostgreSQL.
- UI netjes uitgelijnd op 1440 en 375 px (gedeelde klassen in `shared/layout.css`); controleer via DOM/CSS, geen schermafbeeldingen.
- Exports altijd **Excel (.xlsx)**, nooit CSV tenzij expliciet gevraagd.

## Bedrijfsregels om te onthouden
- **Prijsvolgorde**: prijsfactor artikel > voorkeursleverancier > diepste categorie > standaard, daarna afronding. Zakelijke categoriekorting komt erbovenop; groothandel = hoogste van staffel, klant en categorie (niet opgeteld); particulier nooit categoriekorting. Gebruik `PriceFactor.priceFrom`/`roundPrice`, `priceBusiness`/`priceCart`.
- Voorraad wijzigen alleen via `stock.book`; inkoopontvangst via `purchaseOrders.receive`.
- Elke tenant gebruikt een **eigen AI-sleutel**; nooit een Claude-abonnement of setup-token voor AI in de app.
- De webshop is nog **niet live**: niet laten indexeren (noindex/geen webadres/sitemap) tot go-live. Geen verborgen tekst voor bots (cloaking).
- Een instelling die een extern systeem aanstuurt krijgt `liveOnly: true`. Een nieuw openbaar formulier krijgt een captcha-actie en limiet.
- Nooit tokens of geheimen in logs, audit of frontend.

## Deploy in het kort
`release.yml` bouwt na een merge met fragment het image `ghcr.io/danieldh00/aquatech:<versie>` (+ `:latest`); op de server rolt een timer (`deploy/apps01/update.sh`, ~15 min, met rollback) het uit. Database: eigen PostgreSQL-container naast de app (`deploy/apps01/pve/db-local.sh`), Supabase alleen als terugval, SQLite voor lokaal/tests. Scripts voor de beheerder draaien **vanaf de Proxmox-host** (via `pct exec`/`qm guest exec`/ssh naar de gast). Tijdzone Europe/Amsterdam.

## Zuinig werken (vaste werkwijze, besluit Daniël 2026-11-16)
1. **Gerichte opdracht**: lees alleen de genoemde bestanden en hun directe afhankelijkheden; geen brede greps, geen subagents tenzij de kwaliteit aantoonbaar stijgt. `CLAUDE.md` is groot: zoek er gericht in (bijv. "Prijsfactor", "Orderpick") in plaats van het hele bestand te lezen.
2. **Reviews alleen waar het telt**: `claude-review.yml` slaat de Claude-codereview automatisch over als een PR geen code raakt (alleen docs, tests, afbeeldingen of een versie-bump); een label is daarvoor niet nodig. De securityreview draait bij elke wijziging in `hub/backend/src`, `hub/frontend`, `deploy/` of de Docker-bestanden en blijft verplicht. Concept-PR's worden niet gereviewd: werk in een **draft-PR** en zet hem pas op *ready for review* als het werk klaar is, zodat de reviews niet bij elke push draaien. Een nieuwe push annuleert een lopende review (`cancel-in-progress`).
3. **Lokaal eerst alleen de geraakte tests** (`node --test test/<bestand>.test.js`), pas daarna pushen naar CI; dat scheelt rondes van push, falen en fixen.
4. **Kleine PR's**: één afgebakend onderdeel per PR; grote items worden opgesplitst.
5. **Na de merge direct stoppen**: geen extra samenvattingen of verificatierondes, tenzij Daniël erom vraagt.
6. **Simpele klussen** (tekst, releasenotes, kleine fixes) mogen op een lichter model.
7. Projectgeheugen compact houden: geen lijsten met afgeronde PR-nummers.
8. **Verkenners voor zoeken en testen** (`.claude/agents/`, model Haiku): breed zoeken in de repo (`map`), aanroepen vinden (`callers`) en tests draaien (`tests`) gaan via deze subagents, zodat de hoofdsessie klein blijft. De hoofdsessie schrijft de code; kwaliteitsoordelen en de uiteindelijke beslissing blijven daar. Gerichte opzoekingen van één bestand doe je gewoon zelf.
