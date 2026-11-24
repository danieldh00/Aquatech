---
titel: Offertes en werkorders: veiliger akkoord en minder zichtbare gegevens
---

## Nieuws
- [offertes] Een klant tekent nooit meer voor een offerte die ondertussen is aangepast: de pagina vraagt dan eerst om opnieuw te laden.
- [offertes] Als het mailen van een offerte of afspraak mislukt, blijft de offerte een concept en is er geen losse link in omloop.
- [werkorders] Het gewone opslaan van een werkorder verplaatst geen afspraken meer zonder het recht Planning.

## Changelog
Auditthema 4 (1.33.0), eerste deel:
- **B-09**: de klantweergave van een offerte (portaal, openbare link) geeft `version` mee (SHA-256 over nummer en gegevens zonder interne notities, vóór de optiekeuze); het akkoord stuurt hem terug en `decide` weigert met 409 `changed` bij een verschil. Afwijzen heeft de controle niet nodig.
- **B-24**: klant en openbare link krijgen van het bedrijfsprofiel alleen de documentgegevens (`CUSTOMER_PROFILE_FIELDS`); opslag, tarieven en voorrijkosten blijven intern.
- **B-25**: `owner` (id en inlognaam van de medewerker) ontbreekt in alle klantweergaven van een offerte.
- **B-23**: klant- en installatiedossier tonen offertes (met totaal) alleen met het recht `offertes`.
- **B-32**: `PUT /api/workorders/:id` zonder recht `planning` laat datum, tijden, werkdagen en uitvoerder ongemoeid (`keepPlanning`).
- **T-12**: eigen bodygrens van 128 kB voor `/api/quote-templates` en `/api/quote-profile`.
- **T-13**: een mislukte mail zet een concept-offerte terug (`restoreDraft`) en trekt een alleen daarvoor gemaakte afspraaklink in.
- **B-12 (vervolg)**: test dat de openbare offerte- en afspraaklinks binnen de organisatie van de gevonden rij schrijven.
- Tests: `test/audit-quotes-workorders.test.js`; bestaande akkoordtests sturen `version` mee.
