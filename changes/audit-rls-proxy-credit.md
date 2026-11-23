---
titel: Veiliger zonder inlog en gecrediteerde facturen niet meer betaalbaar
---

## Nieuws
- [portaal] Een gecrediteerde factuur staat in het portaal als Gecrediteerd en kan niet meer online betaald worden.

## Changelog
Audit 1.33.0, punten B-05, B-10 en B-12.
- B-05: `payable()` weigert een gecrediteerde factuur (`creditedAt`); het portaal toont `credited`, `start()` en de betaallink geven een nette melding, en een gecrediteerde factuur telt niet meer als te laat.
- B-12: verzoeken zonder inlog draaien nu binnen de RLS-afscherming: de webshop (hoofdmap) in de hoofdtenant, openbare offerte-, afspraak-, tekening- en betaallinks en de Mollie-factuurwebhook in de organisatie van de gevonden rij (`scopeToTenant`). Zoeken op token-hash en inloggen blijven bewust over organisaties heen. Niet gedaan: de scope van een ingelogd verzoek beperken tot de actieve omgeving (gebruikers, rollen en instellingen van de live-tenant worden ook vanuit een testomgeving gelezen).
- B-10: compose.yml geeft `TRUSTED_PROXIES` door; servertaak 008 zet het subnet van het compose-netwerk in `.env` en vernieuwt compose.yml, zodat proxykoppen alleen van de tunnel geloofd worden en niet van elk ander privé-adres (verbindingen via de gepubliceerde poort 3300 komen via de Docker-gateway en blijven vertrouwd).
