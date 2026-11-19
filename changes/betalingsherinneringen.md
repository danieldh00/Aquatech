---
titel: Automatische betalingsherinneringen en aanmaningen
---

## Nieuws
- [facturen, beheer] AquaTech mailt de klant nu automatisch een betalingsherinnering en aanmaningen als een factuur over de vervaldatum is. Je stelt het in onder Beheer > Modules > Facturen: betalingsherinneringen (aan/uit, na hoeveel dagen per stap). Standaard staat het uit.
- [facturen] Op de factuur zie je welke herinnering of aanmaning is verstuurd, en in de lijst staat de laatste stap bij de status.
- [facturen, klanten] Op de klantkaart zet je de automatische herinneringen voor één klant uit.
- [beheer] De teksten van de herinnering en aanmaningen pas je aan onder Mail-opmaak (groep Facturen).

## Changelog
- Nieuw: `verkoop/payment-reminders.js` (instelling `paymentReminders`, `liveOnly`; store, uurlijkse runner `app.locals.paymentRemindersAll`). Stappen herinnering (7 dgn), aanmaning (21), laatste aanmaning (35, standaard uit); alleen de laatst passende stap, nooit dubbel (unieke rij per factuur+stap), niet bij betaald, gecrediteerd, klant uit, ouder dan `stopAfterDays` (90). Factuur-PDF als bijlage; Engelse facturen krijgen Engelse tekst (`DocText`).
- Migratie: tabel `invoice_reminders` en kolom `users.reminders_off` (SQLite en PostgreSQL). Mailtypes `factuur_herinnering`, `factuur_aanmaning`, `factuur_laatste_aanmaning` in Mail-opmaak. `GET /api/invoices/:id` geeft `reminders`, de lijst `reminder`; `PATCH /api/customers/:id` accepteert `remindersOff`. Testdata en tests (`payment-reminders.test.js`).
