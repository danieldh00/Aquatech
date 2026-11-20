---
titel: Geen onterechte webshopsync-waarschuwing meer
---

## Nieuws
- [beheer] Bewaking waarschuwt niet meer dat de webshop "al uren niet gesynchroniseerd" is als de koppeling bewust maar één keer per nacht synchroniseert.

## Changelog
De controle *Webshopsynchronisatie* (`monitoring-checks.js`) gebruikte vaste drempels (waarschuwing na 3 uur, fout na 24 uur) en negeerde `shopSource.syncSchedule`. Bij het standaardrooster `night` leverde dat dagelijks een onterechte waarschuwing op. De drempels volgen nu het rooster: `night` 30 uur (waarschuwing) en 54 uur (fout), `hourly` en `tenmin` ongewijzigd 3 en 24 uur. Test uitgebreid.
