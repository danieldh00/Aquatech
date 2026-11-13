---
titel: Orderregels afzonderlijk terugzetten uit een back-up
---

## Nieuws
- [beheer] Beheer > Terugzetten uit back-up: bij een offerte of webshopbestelling kun je nu ook losse regels terugzetten (een verwijderde of gewijzigde regel), zonder de rest van het record aan te raken. Het totaal wordt opnieuw berekend en bij een bestelling volgt de voorraadreservering. Een bestelling die al in behandeling is (verzonden, deels geleverd of online betaald) en een geaccordeerde offerte blijven met rust.

## Changelog
- Nieuw `platform/backup-restore-lines.js`: regelweergave (gelijk, gewijzigd, ontbreekt, nieuw sinds de back-up) en `applyLines` in één transactie; offerteregels op `id` (totalen via `QuoteCore.totals`), bestelregels op `code` (totalen via `totalsOf` inclusief verzendregel, reservering opnieuw gelegd, tekort aan voorraad of totalen die niet bij de regels passen = geweigerd, regel in de geschiedenis).
- Routes `POST /api/admin/backups/restore/lines/preview` en `.../lines/apply` (zelfde bewaking als het terugzetten van records: wachtwoord, 2FA, limiet, veiligheidsback-up, audit `backup_regels_teruggezet`); de bevestiging staat in één hulpfunctie.
- Beheer: knop *Regels afzonderlijk terugzetten* in het voorbeeld van een offerte of bestelling.
