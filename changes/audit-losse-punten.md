---
titel: AVG-wissen, inkoopontvangst en netwerkfilter aangescherpt
---

## Nieuws
- [beheer] Een klant wissen (AVG) vraagt nu je wachtwoord opnieuw en waarschuwt voor werkorders die alleen op naam aan de klant gekoppeld zijn. De inzage-Excel bevat ook het akkoordbewijs van offertes en het afspraaklogboek.
- [voorraad] Een inkooporder ontvangen via Artikelen boekt nooit meer dubbel: een herhaling of tweede tabblad wordt geweigerd, en meer ontvangen dan besteld vraagt om een bevestiging.

## Changelog
- Audit B-16: bij wissen gaan ook IP-adres, doorgestuurd IP, browser en gebruikers-id uit het offerte-akkoordbewijs; de inzage heeft de tabbladen *Akkoorden offertes* en *Afspraaklogboek*; `POST /api/customers/:id/anonymize` vraagt `password` (en `totp` bij tweestapsverificatie, met een grens van 5 mislukte pogingen per 15 minuten per beheerder, audit `klant_wissen_wachtwoord_fout`); `GET /api/customers/:id/anonymize-preview` telt werkorders die alleen via `customer_id` gekoppeld zijn (`weakLinksOf`) en de klantkaart toont die waarschuwing.
- Audit T-10: `purchaseOrders.receive` dwingt zelf `seen` (409 `changed`) en `allowOver` (409 `over_received`) af, zodat de Artikelen-route en de orderpick-app dezelfde regel delen; de frontend stuurt per poging een `Idempotency-Key` en vraagt bevestiging bij een overschot.
- Audit B-38: netguard blokkeert ook 6to4 (2002::/16), Teredo (2001::/32), IPv4-compatibel (::/96), site-local (fec0::/10) en 192.88.99.0/24.
