---
titel: Rustiger logboek en betere Excel-export
---

## Nieuws
- [beheer] Het logboek meldt lange taken (back-up naar Google Drive, webshopsynchronisatie) niet meer als trage taak zolang ze binnen hun normale duur blijven.
- [beheer] Een trage bewakingsronde laat nu zien welke controle of melding hem ophoudt.
- [beheer] De Excel-export van het logboek heeft echte datum- en tijdkolommen, aparte kolommen voor queries en externe aanroepen, een kolom Bereik, een filter en een vaste kopregel.

## Changelog
- `createSlowLog({ taskThresholdMs })`: eigen drempel per taaknaam (server.js: Drive-back-up en back-up 90 s, webshopsynchronisatie 5 min, bestellingen ophalen en Visma 30 s, bewaking 25 s); overige taken blijven op `SLOW_REQUEST_MS`.
- Bewaking (`monitoring.js`, `noteSlow`): een controle of melding van 5 s of langer komt als `taak`-regel `Trage bewaking (controle|melding): <titel>` in het logboek (samenvoegbaar, met `controle` en `fase` in de details).
- `beheer/logboek.js`: Excel-export met Date-cellen, kolommen Bereik, Queries, Database (ms), Externe aanroepen, Extern (ms) en Overige details, autofilter en vaste kopregel.
