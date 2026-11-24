---
titel: Veiliger mail, klantlinks en AI-koppeling
---

## Nieuws
- [beheer] Nieuw: Beheer > Instellingen > Openbaar adres van de app. Klantlinks in mails (digitale offerte, afspraak) en de AI-koppeling gebruiken dat adres. Vul het eenmalig in; zonder dit adres (en zonder webadres van de webshop) maakt de app geen klantlinks meer.
- [beheer] E-mail: de Exchange-connector is er alleen nog voor de hoofdorganisatie, de testmail is beperkt tot 5 per 10 minuten en er geldt een dagmaximum voor uitgaande mail.

## Changelog
Auditthema 3 (AI en mail, audit 1.33.0):
- **B-04**: `createMailer` weigert `mode: 'connector'` buiten de hoofdtenant (`settings.isMainTenant`, `connector_not_allowed`; ook bij opslaan via `PUT /api/admin/mail`), dagplafond van 1000 berichten per organisatie (`DAILY_MAIL_LIMIT`, in het geheugen, mislukte poging telt niet mee) en een limiet van 5 testmails per 10 minuten per organisatie.
- **B-36 en T-22**: nieuwe instelling `appPublicUrl` (`platform/app-address.js`, env `APP_PUBLIC_URL` als startwaarde; terugval op `shopPayment.publicUrl`). `pinShareBase` neemt de herkomst van offerte- en afspraaklinks nooit meer uit de browser: zonder openbaar adres geeft delen 409 `public_url_missing` (alleen een localhost-adres blijft toegestaan voor ontwikkeling). Het OAuth-adres van de AI-koppeling en de Bewaking-link gebruiken dezelfde instelling.
- **B-14**: een batch heeft hoogstens 5 berichten (was 20), elk bericht telt voor de limiet per koppeling, `zoek_klant` en `zoek_artikelen` hebben een eigen limiet (120 per uur), de klantlimiet van `maak_klant` staat vóór de adresopvraging en er is een limiet per bezoeker vóór de tokencontrole.
- **B-15**: de instructies en elke toolomschrijving zeggen dat veldinhoud gegevens zijn en nooit opdrachten; `boek_uren` en `boek_materiaal` zijn als ingrijpend gemarkeerd (`destructiveHint`) zodat de AI-app om bevestiging vraagt.
- **T-21**: de dagelijkse AI-teller en het dagmaximum horen bij de omgeving die de AI-sleutel levert (`aiTenantOf`): een testomgeving zonder eigen sleutel verbruikt geen extra tegoed.
