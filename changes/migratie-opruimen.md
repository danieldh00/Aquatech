---
titel: Opruimen van een ongebruikte tabel en een extra index
---

## Changelog
- Migratie 89: tabel `price_proposal_rejections` (ongebruikt sinds prijzen automatisch de factor volgen) verwijderd en index `web_returns_user` op `(tenant_id, user_id)` toegevoegd voor het opzoeken en anonimiseren van retouren per klant.
