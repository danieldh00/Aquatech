---
titel: Account- en instellingenroutes aangescherpt
---

## Nieuws
- Tweestapsverificatie aanzetten vraagt nu je wachtwoord, net als uitzetten.

## Changelog
Audit 1.33.0, thema Accounts en toegang, deel 2.
- **B-20**: de routes voor wachtwoord, profiel en 2FA eisen `identify(req)`; een gebruiker van een uitgeschakelde organisatie krijgt 401 `not_logged_in`.
- **B-35**: `POST /api/account/totp/setup` vraagt het huidige wachtwoord (fout = 400 `wrong_password`, telt mee in de pogingenblokkade); profielscherm heeft een wachtwoordveld.
- **B-22**: `settings.view()` slaat velden met `internal` of `platform` over; `GET /api/admin/settings` toont ze niet meer (eigen schermen en API's blijven).
- **B-34**: `guardedWipe` geeft een vaste melding; de databasefout is een verborgen `cause` die `platformError` via `withCause` aan de debugmodus geeft.
- Tests: `two-factor.test.js`, `settings.test.js`, `tenants-delete.test.js`.
