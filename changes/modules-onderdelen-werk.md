---
titel: Modules: nacalculatie, offertesjablonen, afspraaklink en meer apart uit te zetten
---

## Nieuws
- [beheer] In Beheer > Modules staan zes nieuwe schakelaars: Nacalculatie, Offertesjablonen, Online betalen van facturen (klantportaal en betaallink), Plan herkennen met AI, Afspraaklink voor de klant en Installatiedossier per adres. Alles staat aan, tot je het zelf uitzet.
- [beheer] Zet je zo'n onderdeel uit, dan verdwijnt het van het scherm (bijvoorbeeld het blok Nacalculatie op de werkorder) en weigert de server het ook. Wat al bewaard is blijft staan.

## Changelog
Onderdelen met een eigen schakelaar voor Verkoop, Planner en werk en Klantcontact (geen migratie).
- Register: `configuration.blocked` (patronen met `*` voor één deel van het pad): staat het onderdeel zelf uit, dan geeft de server op die adressen 409 `module_off`, ook bij lezen (staat alleen de module erboven uit, dan geldt haar bestaande regel: schrijven dicht, lezen blijft) (`blockedRoutes`, `matchesRoute`; middleware in server.js, hoofdletters en een slash aan het eind tellen mee). `configuration` geldt nu ook voor regels in `FEATURES`.
- Nieuwe schakelaars: `nacalculatie` (kaart, nodig: werkorders), `offertesjablonen`, `factuur-online-betalen` (`invoicePayments.enabled` via `switchedOn`: geen knop Nu betalen, geen betaallink in de mail; lopende betalingen en de webhook blijven werken), `plan-herkennen-ai` (`aiAvailable`, de planner valt terug op lokale herkenning), `afspraaklink` (maken en versturen dicht; een al verstuurde link blijft voor de klant werken en is nog in te trekken) en `installatiedossier`.
- Frontend: `AquatechModuleTools.featureOn(id)` (via het gedeelde `api/config`); de werkorder verbergt Nacalculatie en het blok Afspraak, de offerte de sjabloonkaart, het portaal de installaties per adres.
