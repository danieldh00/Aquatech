---
titel: Betalingsherinnering ook voor gasten en inkooporders mailen
---

## Nieuws
- [voorraad] Een bestelde inkooporder stuur je met één knop (*Versturen naar leverancier*) per e-mail naar de leverancier. Je ziet eerst de ontvanger, het onderwerp en de tekst en kunt ze aanpassen; de inkooporder gaat als PDF mee. Er gaat nooit iets vanzelf weg, en op de order staat wanneer en naar wie hij is verstuurd.
- Ook wie als gast bestelt en de online betaling niet afrondt, krijgt na een uur één herinnering met een link om af te rekenen, op het adres dat bij het afrekenen is ingevuld.

## Changelog
- Betalingsherinnering (#262) geldt nu ook voor gastbestellingen: `webOrders.unpaidOnline` filtert niet meer op `user_id` en `reminderAllowed` eist alleen voor een account een bevestigd, gelijk adres. Limieten ongewijzigd: één per bestelling (`pay.reminderAt`), één per adres per 24 uur (ook over gasten en accounts heen), alleen zolang de reservering loopt, alleen met mailserver en webadres, naam opgeschoond. De mail bevat de persoonlijke gastlink (`?k=`).
- Inkooporder per e-mail naar de leverancier (migratie 80: `purchase_orders.mail_sent_at|mail_sent_to|mail_sent_by|mail_error`): `artikelen/purchase-order-mail.js` (`draft`, `send`), `artikelen/purchase-order-pdf.js` (PDF met de documentopmaak van de organisatie), routes `GET /api/purchase-orders/:id/pdf`, `GET …/mail-draft` en `POST …/send` (recht `voorraad`, 30 per 10 minuten per gebruiker, audit `inkooporder_naar_leverancier_gemaild`). Alleen orders met status besteld of deels ontvangen; één adres tot drie, geen stuurtekens in onderwerp of adres, een lopende verzending blokkeert een tweede klik (409 `busy`), een mislukte poging komt als leesbare melding op de order en wordt bij een geslaagde poging gewist. Opmaak via de bestaande `mailBody`; instelbare mailopmaak volgt later.
