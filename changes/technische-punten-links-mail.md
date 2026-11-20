---
titel: Klantlinks altijd op het openbare webadres en limiet op losse mails
bump: patch
---

## Nieuws
- Links naar offertes en afspraken gebruiken altijd het webadres uit Beheer, ook als een medewerker de app via een intern adres opent.

## Changelog
- Offerte- en afspraaklinks: de herkomst komt uit `shopPayment.publicUrl` (`pinShareBase`), niet uit de browser van de medewerker; zonder ingevuld webadres blijft het gedrag gelijk.
- Losse mails (offerte, werkorder-afspraak, factuur) hebben een limiet van 30 per uur per gebruiker.
