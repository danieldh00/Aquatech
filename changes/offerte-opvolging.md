---
titel: Offertes volgen zichzelf op
---

## Nieuws
- [beheer] Offerte-opvolging: heeft een klant niet gereageerd op een gemailde offerte, dan stuurt AquaTech na het ingestelde aantal dagen vanzelf een vriendelijke herinnering met de knop naar de offerte. Instellen onder Beheer > Instellingen > Offerte-opvolging (standaard uit).

## Changelog
Offerte-opvolging (`verkoop/quote-follow-up.js`, migratie 86 `quotes.followup_count|followup_at`): instelling `quoteFollowUp` {enabled, afterDays 2-60, maxReminders 1-2} (`liveOnly`, per omgeving). Elk uur (`app.locals.quoteFollowUpAll`) krijgt een verzonden offerte zonder antwoord, gemaild naar een geldig adres (`sent_to`) met een actieve link en niet verlopen een herinnering in de documenttaal van de offerte (`mail.followUp*` in `doc-text.js`). De herinnering wordt eerst vastgelegd (voorwaardelijke update, nooit dubbel) en teruggedraaid als de mail mislukt; audit `offerte_opvolging`. Beheer: formulier *Offerte-opvolging*. Test: `test/quote-follow-up.test.js`.
