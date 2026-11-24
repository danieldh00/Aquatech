---
titel: Modules: onderdelen met een eigen schakelaar (voorbereiding nieuw scherm)
---

## Nieuws
- [beheer] De Webshopbestellingen staan alleen nog in het menu als de eigen webshop aan staat, en Uitbesteden alleen als Werkorders aan staat.

## Changelog
Voorbereiding voor het nieuwe scherm Beheer > Modules (geen migratie).
- `frontend/dashboard/modules.js`: categorieën (`CATEGORIES`), de lijst Altijd aan (`ALWAYS_ON`) en schakelaars zonder eigen pagina (`FEATURES`). Een module krijgt `category` + `summary`; een onderdeel met een eigen schakelaar is een module met `partOf` + `ownSwitch` of een regel in `FEATURES`. `needs` = werkt alleen als die module aan staat. Nieuwe hulpfuncties `switchTree`, `switchIds`, `entryOf`, `titleOf`; `isOn` volgt nu ook `needs` en onderdelen van onderdelen.
- Een schakelaar met `setting` bedient een bestaande instelling (offerte-opvolging, betalingsherinneringen, tekening indienen, automatische bestelvoorstellen, de webshop met bestellen, gastbestellen, offerte aanvragen, planner, Google Analytics en Clarity, seizoensherinneringen, AI-koppeling): er blijft één waarheid.
- `platform/module-switches.js`: `flagsOf` (de vlaggen zoals ze gelden, ook in `GET /api/config`), `lockedOf` (uitbesteden zonder multitenancy, de webshop buiten de hoofdtenant) en `apply`. Routes `GET|PUT /api/admin/modules` (recht `beheer`, alles of niets, audit `modules_gewijzigd`; onbekende id 400, op slot 409 `module_locked`, onderdeel van een uitgezette module 409 `module_off`).
- Plannenoverzicht is een onderdeel van de Beregeningsplanner, Webshopbestellingen van de Webshop.
