---
titel: Versie en releasenotes worden automatisch bijgewerkt
---

## Changelog
Versienummer, changelog en releasenotes worden niet meer per PR aangepast, zodat PR's elkaar daar niet meer in de weg zitten. Geen migratie.

- **Fragment per PR**: `changes/<naam>.md` met titel, punten voor Nieuws (met rechten) en een changelogtekst (zie `changes/README.md`).
- **Na de merge** (`release.yml`, job *Versie en notes*): `tools/release-notes.js` geeft elk fragment het volgende versienummer (patch + 1, na x.y.9 de volgende minor; `bump: minor` kan), werkt `package.json`, `CHANGELOG.md` en `releases.js` bij, verwijdert de fragmenten en commit naar master met `[skip ci]`. Daarna testen en bouwen van het image zoals voorheen. Gelijktijdige merges: de runs wachten op elkaar (`concurrency`) en een mislukte push wordt opnieuw geprobeerd op de nieuwste master.
- **Controle in PR's** (`version.yml`, check `version-must-increase`): faalt als een PR het versienummer, `CHANGELOG.md` of `releases.js` zelf wijzigt of als een fragment ontbreekt (uitzondering: label `geen-releasenotes`).
- Tests: `release-notes.test.js`.
