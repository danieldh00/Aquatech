---
titel: Servertaak voor databasegroottes en indexgebruik
---

## Changelog
Servertaak `006-database-grootte-en-indexgebruik` (alleen lezen, `PGOPTIONS default_transaction_read_only`): toont de 25 grootste tabellen en de ongebruikte indexen van de productiedatabase en bewaart de uitvoer in `update/status/db-stats.txt`. Geeft de cijfers voor de beslissing over zware kolomomzettingen (database-doorlichting 2026-11-20).
