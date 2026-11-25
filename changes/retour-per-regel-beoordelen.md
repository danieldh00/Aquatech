---
titel: Retour per regel goedkeuren of afwijzen
---

## Nieuws
- [beheer] Bij een webshopretour kun je nu per regel kiezen: goedkeuren, afwijzen of een deel van het aantal goedkeuren. De creditfactuur, de voorraad en de mail aan de klant gaan alleen over wat is goedgekeurd. De klant ziet per regel wat is goedgekeurd of afgewezen.

## Changelog
`returns.decide(…, lines)` en `POST /api/admin/web-returns/:id/decision` accepteren `lines: [{ code, qty }]` (goedgekeurd aantal per artikel; niet genoemd = helemaal goedgekeurd). Minder goedgekeurd dan gevraagd vraagt een toelichting: `data.requested` bewaart het gevraagde, `data.lines` bevat daarna alleen het goedgekeurde, dus creditnota, voorraadboeking, mails en rapportage rekenen er vanzelf mee. Niets goedgekeurd = afgewezen. Het afgewezen deel telt als gebruikt en kan niet opnieuw worden ingediend (`returnableLines`, `rejectedCodes`). Shape: `partial`, `requested`, `declined`; statuslabel *Deels goedgekeurd*. Geen migratie. Beheer toont een melding als de creditfactuur bij goedkeuren niet gemaakt kon worden. Test in `test/web-returns.test.js`.
