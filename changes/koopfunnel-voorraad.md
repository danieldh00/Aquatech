titel: Voorraad in de webshop en voorraadmelding
## Nieuws
- Bij een kleine voorraad toont de webshop nu "Nog 3 op voorraad". Is een artikel uitverkocht, dan kan een bezoeker zijn e-mailadres achterlaten en krijgt één mail zodra het weer te bestellen is; het adres wordt daarna gewist.
## Changelog
- Voorraadmelding (migratie 76, `stock_alerts`, `webshop/stock-alerts.js`): formulier op de productpagina (alleen met bestellen aan en een mailserver), captcha-actie `stock_alert`, limiet per bezoeker en per adres (10 open), honeypot; elk uur mailt `stockAlertsRun` de meldingen waarvan het artikel weer te bestellen is en wist ze, na 180 dagen of bij een gearchiveerd artikel vervalt een melding.
- Product en variant geven `stockQty`; `stockText` toont "Nog N op voorraad" bij 1 tot en met 5.
