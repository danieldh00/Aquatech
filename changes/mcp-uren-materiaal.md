---
titel: Uren en materiaal boeken via de AI-koppeling
---

## Nieuws
- [werkorders] Via Claude of ChatGPT kun je nu uren en verbruikt materiaal op een werkorder boeken, op je eigen naam. Bij twijfel of een dubbele boeking vraagt de AI eerst terug. In AquaTech kun je de regels gewoon wijzigen of verwijderen. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.

## Changelog
- MCP-tools `boek_uren` en `boek_materiaal` met nieuwe scope `werkregistratie.boeken` (recht `werkorders`): boeken via `workLogStore.addHours/addMaterial` op naam van de gebruiker zelf, werkorder op nummer (`mcpLookups.workOrderByNumber`, per omgeving). Afgeronde of geannuleerde werkorder alleen met recht `planning`; een gelijke boeking binnen 10 minuten geeft `terugvragen`; onbekend artikel of variant geeft `terugvragen`; datum niet verder dan morgen (zoals in de app). Limiet 60 boekingen per uur per gebruiker, audit met `via: 'ai-koppeling'`.
