---
titel: Mail-opmaak en mailteksten zelf instellen
bump: minor
---

## Nieuws
- [beheer] Nieuw: Beheer > Mail-opmaak. Stel het logo, de kleuren en de voettekst van je e-mails in en pas per soort mail het onderwerp en de tekst aan (orderbevestiging, verzending, retour, betalingsherinnering, account, inkooporder). Je ziet meteen een voorbeeld en kunt een testmail naar jezelf sturen.
- Alle mails aan klanten staan nu in de huisstijl van je organisatie, met je logo erin.

## Changelog
- Nieuwe instelling `mailLayout` (per organisatie, `internal`, alleen via `GET|PUT /api/admin/mail-layout`, `POST …/preview` en `POST …/test`; geen migratie): logo (documentopmaak, eigen of geen), positie, kop (balk of wit met lijn), kop-, knop- en accentkleur (terugval: eigen → documentopmaak → thema → huisstijl), bedrijfsgegevens in de voet, eigen voettekst en per mailtype een afwijkend onderwerp en eigen tekst met invulvelden (`platform/mail-layout.js`).
- `renderMail` vervangt de vaste HTML van `mailBody` (die nu een dunne laag is): e-mailveilige tabellen met inline styles, knop met `bgcolor`, logo als ingebed data-adres dat `mailer.send` omzet in een `cid:`-bijlage (`inlineImages`, hoogstens twee afbeeldingen). Alle ±25 aanroepen geven `mailStyleOf(settings)` mee.
- `composeFor(settings, type, values)` stelt onderwerp en alinea's samen uit de eigen of standaardtekst (precies de teksten van vóór deze wijziging). Een alinea waarvan alle velden leeg zijn vervalt; onbekende velden of een ontbrekend verplicht veld (de link) worden bij opslaan geweigerd; de tekst over het herroepingsrecht blijft altijd automatisch onderaan de orderbevestiging.
- Mailtypes met instelbare tekst: orderbevestiging (betaald/op rekening), verzonden (met/zonder volgcode, ophalen, ook als deellevering), betalingsherinnering (open/mislukt), artikel weer op voorraad, retour (ontvangen/goedgekeurd/afgewezen/afgehandeld), account (uitnodiging/wachtwoord/bevestigen) en inkooporder. Interne meldingen, nieuws en door de medewerker nagekeken mails (offerte, afspraak, factuur) krijgen de opmaak maar houden hun tekst.
- `settings.tenantId` toegevoegd aan het instellingenobject (voor de thema-terugval).
