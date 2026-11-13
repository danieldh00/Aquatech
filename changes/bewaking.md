---
titel: Bewaking en meldingen bij storingen
bump: minor
---

## Nieuws
- [beheer] Nieuw in Beheer > Systeem > Bewaking: de app controleert zelf of de database, back-ups, updates en koppelingen (Google Drive, mail, Mollie, Visma, webshop, AI) werken en meldt een storing per e-mail of webhook, met een herstelmelding en herinneringen.
- [beheer] Een extern heartbeat-adres laat je weten als de app of de server zelf uitvalt.

## Changelog
Bewaking: tabel `monitor_incidents` (migratie 72), `platform/monitoring.js` (incidenten, meldingen, heartbeat), `monitoring-checks.js` (controles), `monitoring-routes.js` (`/api/admin/monitoring`) en het scherm `beheer/bewaking.js`. Instelling `monitoring` per omgeving (ontvangers, webhook, herinneringen, drempels, dempen); platformcontroles alleen voor wie ook mag updaten. `errorCounter` in `error-report.js` telt 500-antwoorden; `mailer.verify` en `mollie.checkKey` zijn nieuw. Testdata: twee voorbeeldincidenten.
