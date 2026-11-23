---
titel: Strengere toegangsregels
---

## Nieuws
- [beheer] De toegangscode en de gastentoegang kan alleen nog een hoofdbeheerder wijzigen, en back-ups zijn alleen voor hoofdbeheerders.
- [orderpick] Streepjescodes scannen met de camera werkt weer in de orderpick-app.

## Changelog
- Audit B-06: de controle op verplicht wachtwoord wijzigen, de no-store-kop en het 404-antwoord voor onbekende API-routes herkennen het API-pad nu hoofdletterongevoelig (`isApiPath`), dus `/API/…` omzeilt ze niet meer.
- Audit T-04: Permissions-Policy `camera=(self)` (eigen site) in plaats van `camera=()`; de rest blijft uit.
- Audit B-07: `accessCode` en `guestAccess` wijzigen (en resetten) mag alleen een hoofdbeheerder of wie al met de toegangscode is ingelogd; de back-uppoort laat de systeemgebruiker (toegangscode) niet meer toe. Test: `entry-hardening.test.js`.
