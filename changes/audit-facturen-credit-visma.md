---
titel: Crediteren, betaald zetten en de Visma-redirect steviger
---

## Nieuws
- [facturen] Een factuur kan niet meer vaker of voor meer gecrediteerd worden dan er gefactureerd is. Een volgende creditfactuur begint met wat er nog niet gecrediteerd is.
- [facturen] Betaald of weer openstaand zetten staat nu in het logboek. Een factuur die de klant online heeft betaald gaat pas na een bevestiging terug naar openstaand.
- [facturen] Visma: de redirect URI volgt uit het webadres van de omgeving als je hem leeg laat; een adres dat niet klopt wordt geweigerd in plaats van stil vervangen.

## Changelog
Audit 1.33.0, thema webshopbetalingen en facturen, deel 2. Geen migratie.

- **T-02 Crediteren begrensd** (`verkoop/invoices.js`): bij definitief maken van een creditfactuur controleert `creditProblem` (met een rijslot op de oorspronkelijke factuur) dat de som van de definitieve credits niet boven het factuurbedrag komt en dat per artikelcode niet meer wordt gecrediteerd dan er gefactureerd is (409); daarmee komt ook de voorraad nooit vaker terug dan hij is afgeboekt. `credit()` maakt een nieuw concept met alleen de regels die nog niet definitief gecrediteerd zijn (`creditedSoFar`) en weigert als alles al gecrediteerd is.
- **B-19 Betaald/onbetaald** (`POST /api/invoices/:id/paid`): auditregels `factuur_betaald` en `factuur_onbetaald` (alleen bij een echte wijziging). Terugzetten op openstaand van een factuur met een geslaagde online betaling (portaal, betaallink of online betaalde webshopbestelling) geeft 409 `confirm_required`; met `confirm: true` gaat het door en staat dat in de auditregel. Facturen vraagt de bevestiging.
- **T-15 Visma-redirect** (`verkoop/visma.js`): de vaste standaard met het productiedomein en het oude pad buiten `/app` is weg. Zonder eigen redirect URI geldt het webadres uit Beheer > Webshop > Betalen + `app/api/visma/callback`; ontbreken beide, dan weigert verbinden met een duidelijke melding. Een ingevulde redirect URI moet met https beginnen en op `/app/api/visma/callback` eindigen, anders 400. Een eerder bewaarde waarde met het oude pad telt als leeg.
- **Betaling op een gecrediteerde factuur** (`verkoop/invoice-payments.js`): nieuwe haak `onPaidAfterCredit`, één keer per betaling; de aansluiting op audit en Bewaking volgt in de laatste PR van dit thema (server.js).
- Tests: crediteren (gedeeltelijk, te veel, alles), auditregels, bevestiging bij online betaald, de haak, en dat webhook en betaallink een factuur van een andere organisatie niet raken (B-12).
