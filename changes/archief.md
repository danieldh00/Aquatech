---
titel: Archief voor testgegevens
bump: minor
---

## Nieuws
- [beheer] Nieuw: Beheer > Systeem > Archief. Plannen, offertes, werkorders, facturen, webshopbestellingen en klanten (bijvoorbeeld testgegevens vóór go-live) haal je daar in bulk uit de lijsten en KPI's, zonder ze te wissen. Je kunt op datum of zoekterm selecteren, eerst een voorbeeld bekijken en alles terughalen. Nummers blijven bezet; wat de planner heeft geleerd blijft staan.
- [beheer] Het archief kun je ook definitief verwijderen. Definitieve facturen blijven zeven jaar bewaard (bewaarplicht) en worden overgeslagen.

## Changelog
- Migratie 100: kolom `archived_at` (met gedeeltelijke index) op `plans`, `quotes`, `work_orders`, `invoices`, `web_orders` en `users`, en de tabel `number_floors` (hoogste uitgegeven volgnummer per soort en voorvoegsel).
- Definitief verwijderen legt eerst het volgnummer vast (`platform/number-floors.js`); de nummergeneratoren van offertes, werkorders, facturen en bestellingen nemen die ondergrens mee, dus een nummer komt nooit terug.
- `platform/archive.js` (archiveren, terughalen, bulkselectie met voorbeeld, definitief verwijderen), `archive-routes.js` (`/api/admin/archive`, recht beheer, limieten, audit `archief_*`) en `archive-filter.js` (`?archief=verberg|toon|alleen` voor lijsten; standaard verbergen). Offertes-, werkorder-, factuur-, bestelling-, plan- en klantlijsten, de taken-/planningsqueries en de KPI's tellen gearchiveerde stukken niet mee.
- Definitief verwijderen: alleen gearchiveerde stukken, een definitieve factuur jonger dan zeven jaar wordt overgeslagen, gekoppelde stukken (foreign key) worden geweigerd met reden; `plan_recognitions` en `item_specs` blijven staan. Beheerscherm `frontend/beheer/archief.js`.
- Per lijst een archieffilter en knoppen Archiveren/Terughalen volgen in een aparte PR.
