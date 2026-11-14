---
titel: Onzichtbare captcha op openbare formulieren
---

## Nieuws
- [beheer] Nieuw in Beheer > Toegang & beveiliging: *Onzichtbare captcha*. Met een sleutel van Google reCAPTCHA v3 beschermt de app de inlogpagina, tekening indienen en de webshopformulieren (inloggen, registreren, wachtwoord vergeten, zakelijk aanvragen, afrekenen) tegen robots, zonder dat klanten iets hoeven te doen. Zonder sleutels werkt alles zoals voorheen.

## Changelog
- Nieuw `beveiliging/captcha.js` (`createCaptcha`): instelling `captcha` {enabled, siteKey, minScore, onUnreachable} en geheim `captchaSecret` (versleuteld, `liveOnly`, nooit naar de browser), controle van het token bij Google (`siteverify`, 4 s, de actie en de minimumscore moeten kloppen), `captchaFetch` in `createApp` voor tests.
- Formulieren: `POST /api/auth/login` (hoofdtenant), `POST /api/public/drawing` (per organisatie) en in de shop inloggen, registreren, planner, wachtwoord vergeten, zakelijk aanvragen en afrekenen (alleen bij plaatsen, niet bij *Totaal bijwerken*). Een weigering geeft 400 `captcha_failed` (of 503 `captcha_unavailable`) en komt als `captcha_geweigerd` in het auditlog (zonder token). De controle staat vóór de wachtwoordcontrole, zodat een geweigerde robot niet meetelt voor de blokkering van een account.
- Google onbereikbaar of een geheim dat Google weigert: standaard doorlaten (`onUnreachable: allow`, de limieten en de inlogblokkering blijven gelden) of blokkeren; altijd een waarschuwing in Bewaking (`captcha`) die bij herstel sluit. Noodschakelaar: omgeving `CAPTCHA_DISABLED=1`.
- De CSP wordt alleen uitgebreid (script-src, connect-src, frame-src van reCAPTCHA) op de inlogpagina, de openbare planner (`?tekenen`) en de shop als de captcha aan staat. Het script van Google laadt pas als een bezoeker een formulier gaat gebruiken (`shared/captcha.js`); het kenmerk van Google is verborgen en vervangen door de vermelding onder het formulier. Staat los van de toestemming voor Google Analytics.
- Beheer: formulier *Onzichtbare captcha* met controle van de geheime sleutel (`POST /api/admin/captcha/check`). Geen migratie.
