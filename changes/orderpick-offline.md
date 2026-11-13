---
titel: Orderpick werkt ook zonder verbinding
---

## Nieuws
- [orderpick] Orderpick werkt nu ook in een hoek van het magazijn zonder bereik: de bestellingen die al geladen waren blijven openen en een afgemelde pick wordt bewaard en verstuurd zodra je weer online bent. Pakbon en label maak je daarna onder *Net gepickt*.

## Changelog
Orderpick deel 3: offline werken (geen migratie).

- Offline-regels (`shared/offline-core.js`): recht `orderpick` mag offline werken, de bestellijst en -regels worden bewaard, `POST …/pick` mag in de wachtrij; `orderpick/` wordt vooraf in de cache gezet.
- Scherm: opgeslagen-melding, wachtende bestellingen verborgen en genoemd, afhandeling bij verzenden of weggooien uit de wachtrij.
- Tests in `test/offline.test.js`.
