# AquaTech Hub: Vue-frontend (`hub/frontend-vue/`)

Gemigreerde modules in Vue 3 + TypeScript + Vite. Plan en fasen: `frontend-advies/frontend-advies-vue.xlsx` in de projectbestanden.
De Node-backend en alle API's blijven zoals ze zijn; een gemigreerde module vervangt alleen de map `hub/frontend/<module>/`.

> **Status: vooruitbouwen in losse branches (`vue/<module>`).** Dit project is nog niet aangesloten op het image, de CI of de tests van de
> backend. Wat daarvoor nog gebeurt (Dockerfile, `ci.yml`, `layout.yml`, `sw.js`, codestyle-baseline) staat onder *Nog aan te sluiten*.

## Indeling

| Pad | Inhoud |
|---|---|
| `src/modules/<id>/` | één map per gemigreerde module: `index.html`, `main.ts`, componenten, `<id>.css`. De mapnaam is de URL onder `/app/`. |
| `src/shared/` | gedeelde code: `api.ts` (getypte API-client), `shell.ts` (brug naar de oude schil), `router.ts`, `toast.ts` + `ToastHost.vue`, `AddressField.vue`, `format.ts`, `bootstrap.ts` |
| `tools/shell-html.ts` | Vite-plugin die de schil (CSS en gewone scripts van `hub/frontend/shared`, zijbalk, rekeningmenu) in elke modulepagina zet |
| `tools/check-stijl.mjs` | stijlcontrole voor `.ts` en `.vue` (zelfde regels als de oude codestijl, plus geen `v-html`) |
| `test/` | Vitest + `@vue/test-utils` (jsdom); `test/<module>/` per module |
| `e2e/` | Playwright-scripts tegen de echte backend: `seed.mjs`, `auth.cjs`, `vergelijk-<module>.cjs` (oud tegen nieuw: structuur en afmetingen op 1440 en 375) en `<module>.e2e.cjs` (gedrag) |

## Commando's

```sh
cd hub/frontend-vue && npm ci
npm test                 # Vitest
npm run typecheck        # vue-tsc
npm run stijl            # stijlcontrole
npm run build            # typecheck + vite build -> dist/<module>/index.html + dist/assets/
BACKEND_URL=http://localhost:3300 npm run dev   # http://localhost:5173/<module>/
```

De ontwikkelserver geeft alles wat niet van een gemigreerde module is (API, schil, nog niet gemigreerde modules) door aan de gewone
backend (standaard poort 3300, pad `/app/`). Draai de backend dus gewoon zoals altijd (`DATABASE_URL=… node src/server.js`) en log in op
`http://localhost:5173/klanten/`.

## Gemigreerde modules

| Module | Branch | Pariteitslijst |
|---|---|---|
| Klanten (pilot) | `vue/klanten` | `src/modules/klanten/PARITEIT-klanten.xlsx` |

## Regels

- **Zelfde uiterlijk, zelfde adressen.** Een module gebruikt dezelfde CSS-klassen en dezelfde schil als de oude pagina; `?id=…`, `?nieuw` en `#tab`-adressen blijven werken
  (Vue Router in history-modus met de paginamap als basis; de weergave volgt uit `route.query`).
- **Alle adressen relatief** (`../api/…`, `../shared/…`); Vite `base: './'`. Geen CDN's: alles zit in de bundel.
- **De UMD-rekenkernen blijven** (quote-core, invoice-core, roles, doc-text, barcode, …): Vue-code gebruikt ze via de brug in `src/shared/shell.ts`, nooit een herschreven kopie.
- **Geen `v-html`** (templates escapen vanzelf; de stijlcontrole faalt erop). Kleuren via `--at-*`-variabelen; bestaande CSS van een module wordt letterlijk meegenomen (pixelgelijk).
- **Functies krijgen een `/** … */`-blok in het Nederlands**, geen namen van één letter, bestanden beginnen met een kopcommentaar (bewaakt door `npm run stijl` en `test/stijl.test.ts`).
- **De adreszoeker** (`shared/address-lookup.js`) zet zijn rijtje als broertje vóór het label in de ouder (`.form-grid > .addr-lookup`): gebruik `AddressField.vue` dus direct in een `.form-grid`, niet in een v-if/v-for dat het label los van zijn ouder verwijdert.
- Per module: pariteitslijst in Excel (`<id>/PARITEIT-<id>.xlsx`): elke functie van de oude module met bewijs (testnaam of controle).
- Alleen devDependencies voor de bouwstap. Het runtime-image bevat geen Node-tooling van dit project (Vite en esbuild draaien alleen in de Docker-bouwstap).

## Nog aan te sluiten (wacht op de coördinator; raakt gedeelde bestanden)

1. ~~`hub/Dockerfile`~~ **gedaan**: bouwargument `VUE_MODULES` (kommagescheiden, bijvoorbeeld `klanten`) laat de stap `frontend-build` `npm ci` + `npm run build` draaien en legt `dist/<module>/` over de oude pagina en `dist/assets/` ernaast. Leeg (productie) = niets extra's. Staging bouwt standaard elke Vue-module in develop (`VUE_MODULES:-alle` in `deploy/staging/compose.yml`), dus een gemergde module verschijnt bij de volgende timerronde zonder handwerk; productie blijft leeg.
2. `frontend/sw.js`: de gehashte bestanden in `assets/` en de gemigreerde modulepagina's in de precache (lijst uit `dist/.vite/manifest.json`); offline-test per module.
3. `ci.yml`: stap `npm ci && npm run typecheck && npm test && npm run stijl && npm run build` in `hub/frontend-vue`; `layout.yml` bouwt vóór de run.
4. `server.js` serveert modulemappen generiek, dus een gemigreerde module hoeft daar niets te veranderen; de CSP (`script-src 'self'`) past bij de externe modules van Vite.
5. `test/codestyle.test.js` en `tools/codestyle-baseline.json` blijven voor de oude `.js`; zodra een module gemigreerd is, valt zijn oude `.js` weg uit de baseline.
