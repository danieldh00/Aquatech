---
titel: Online betalen in de webshop steviger
---

## Nieuws
- [beheer] Een online bestelling die nog niet betaald is houdt de voorraad nog maar een half uur vast. Daarna komt de voorraad vrij; de klant kan tot de bewaartijd nog afrekenen zolang de voorraad strekt, en bij het betalen wordt opnieuw gereserveerd.
- [beheer] Een gast kan hoogstens twee onbetaalde bestellingen tegelijk open hebben staan per e-mailadres (drie per bezoeker).
- [beheer] Wordt een bestelling betaald nadat hij is vervallen of geannuleerd, of komt er een tweede betaling binnen op dezelfde bestelling, dan gaat het bedrag automatisch terug via Mollie. De klant krijgt dan geen bevestiging en er komt geen factuur. Lukt terugbetalen niet, dan staat bij de bestelling dat het nog moet.
- [beheer] Een terugbetaling staat direct bij de bestelling, ook als het antwoord van Mollie uitblijft. De app kijkt dan zelf bij Mollie na of hij is uitgevoerd.

## Changelog
Audit 1.33.0, thema webshopbetalingen (deel 1).
- **B-13** Online bestellingen krijgen `data.stockHoldUntil` (30 minuten, `PAY_HOLD_MINUTES`). `releaseUnpaidHolds` geeft daarna de voorraad vrij (`reservationReleasedAt`); `holdForPayment` reserveert opnieuw bij het starten van een betaling (onder het rijslot, geweigerd bij te weinig voorraad: `?betaalfout=2`) en `changePay` reserveert opnieuw bij betaald na vrijgave. Plafond op openstaande onbetaalde gastbestellingen: 2 per e-mailadres (`countOpenUnpaidGuest`), 3 per bezoeker (in het geheugen, `unpaidAmong`). De herinneringsmail belooft na het vrijgeven geen reservering meer.
- **T-08** Betaald op een geannuleerde bestelling: geen betaalhaken (bevestiging, factuur), `pay.paidAfterCancel`, automatisch terugbetalen (sleutel `annulering`) en de nieuwe haak `onLatePayment`. Vervallen annuleert de openstaande betaling bij Mollie waar dat kan (`mollie.cancelPayment`); een nieuwe betaling wordt alleen vastgelegd als de bestelling onder het rijslot nog nieuw is.
- **T-16** `onPaid(hook, { key })`: stappen met een sleutel worden bijgehouden in `pay.hooks` en door `catchUpPaid` opnieuw geprobeerd (na 10 minuten, hoogstens 5 keer, daarna `onHookFailed`). De sleutels worden in een volgende wijziging aan de factuur en de bevestigingsmail gehangen.
- **T-17** Een tweede geslaagde betaling komt in `pay.duplicates` en wordt op die betaling zelf terugbetaald.
- **T-18** Terugbetalen in drie stappen: aanvraag vastleggen (`status: 'aangevraagd'`, onder het rijslot), Mollie, afronden. Een weigering haalt de aanvraag weg; bij een onbekende uitkomst stemt `reconcileRefunds` af met `mollie.listRefunds` (onze sleutel gaat als metadata mee) en vervalt de aanvraag na 15 minuten zonder spoor.
- **T-20** De Mollie-webhook werkt ook als de webshop uit staat.
- De uurlijkse vervalronde (`expireUnpaid`) doet ook het vrijgeven, het afstemmen en het inhalen.
