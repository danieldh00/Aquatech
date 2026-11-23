---
titel: Updates stoppen als de back-up mislukt
---

## Changelog
- Audit T-06: `update.sh` stopt de update vóór het vervangen van de container als `backup.js create` faalt (alleen exitcode 2 = oude versie kent `create` niet, of een eerste installatie zonder draaiende versie, gaat door met een waarschuwing); de huidige versie blijft draaien en run.json meldt `mislukt`. Servertaak `009-update-script-stopt-bij-mislukte-back-up` (zelfde handeling als 001) installeert het nieuwe script.
