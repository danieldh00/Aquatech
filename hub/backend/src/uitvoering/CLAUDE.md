# Uitvoering: werkorders, planning, portaal, foto's (backend/src/uitvoering)

Alleen de regels voor deze map; het volledige geheugen staat in de root-`CLAUDE.md` (zoek op de term).

- Een klant ziet alleen eigen gegevens (`quotes.customer_id` of `service_requests.customer_id`) en nooit uren, notities, instructies, kostprijs of interne velden; `customerWorkOrder` en `handoverOf` zijn whitelists.
- Een schrijfactie die offline moet kunnen: kop via `AquatechOffline.headers`, 202 `{ queued }` afhandelen, server met `Idempotency-Key`/`ifBaseOf`, en in `QUEUEABLE`. Een nieuwe offline GET komt in `CACHEABLE`, een nieuwe offline pagina in `PRECACHE_PAGES`.
- Foto's: type op inhoud controleren, EXIF strippen, opslaan via `vault.sealBytes` (AAD `<tenant>:foto:<id>:…`).
- Uren en materiaal boeken via `workLogStore` (idempotent met `client_id`); voorraad volgt via `workLogStore.hook`.
- Uitbesteden: vóór aannemen alleen `previewOf` (geen klantgegevens), daarna `handoverOf`.
- Openbare klantlinks: token alleen als SHA-256 opslaan, via een kop versturen en laten verlopen (`public-links.js`).
