# Releasenotes per wijziging

Een PR verhoogt het versienummer niet en past `CHANGELOG.md` en `frontend/nieuws/releases.js` niet aan.
Voeg in plaats daarvan één bestand toe: `changes/<korte-naam>.md`. Na het mergen geeft `release.yml`
de wijziging het volgende versienummer (patch + 1; na x.y.9 komt x.(y+1).0), zet de notes in
`CHANGELOG.md` en `releases.js`, verwijdert het bestand en bouwt het image.

```
---
titel: Korte titel voor de pagina Nieuws
bump: minor        (optioneel; alleen patch of minor, standaard patch)
---

## Nieuws
- [voorraad, beheer] Wat een gebruiker merkt, in gewone taal. Tussen [..] de rechten die het punt mogen zien.
- Zonder haakjes ziet iedereen het punt.

## Changelog
Technische beschrijving (markdown), komt onder "## <versie>" in CHANGELOG.md.
```

- `## Nieuws` mag leeg zijn of ontbreken (een wijziging zonder zichtbaar effect); `## Changelog` is verplicht.
- Alleen docs/CI zonder effect op de app: geef de PR het label `geen-releasenotes`, dan is geen bestand nodig.
- Een major-versie verhoogt alleen de beheerder met de hand.
