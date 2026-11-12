---
titel: Instellingen van uitgezette modules verborgen
---

## Nieuws
- [beheer] Zet je een module uit bij Beheer > Modules aan/uit, dan verdwijnen de bijbehorende instellingen uit Beheer (etiketten bij Artikelen, sproeierbibliotheek bij de planner, Uitbesteden, Seizoensherinneringen). Je bewaarde instellingen blijven staan en komen terug zodra je de module weer aanzet.

## Changelog
- Moduleregister (`dashboard/modules.js`): veld `configuration { sections, settings, routes }` en hulpfuncties `isOn`, `hiddenSections`, `lockedSettings`, `lockedRoutes`; `visible` gebruikt `isOn`.
- Beheer verbergt de secties van uitgezette modules en bouwt het menu opnieuw op na het opslaan van Modules aan/uit.
- Server: `moduleFlagsOf(tenantId)` (ook voor `/api/config` en de startpagina), `PUT /api/admin/settings` weigert instellingen van een uitgezette module (409 `module_off`, ook `reset`; een patch die de module tegelijk aanzet telt mee) en een middleware weigert schrijfacties op `configuration.routes` (etiketten, prijsfactor, sproeierbibliotheek, uitbesteden).
- Seizoensherinneringen worden niet verstuurd zolang het klantportaal uit staat.
- Tests: `test/module-settings.test.js`.
