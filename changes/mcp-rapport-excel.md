---
titel: Rapporten als Excel via de AI-koppeling
---

## Nieuws
- [werkorders] Via Claude of ChatGPT kun je nu een urenstaat, de openstaande facturen of een voorraadlijst als Excel-bestand laten maken. Je krijgt een link die 15 minuten werkt, alleen voor jou en alleen als je in AquaTech bent ingelogd. Je moet de AI-koppeling opnieuw koppelen om dit te kunnen gebruiken.

## Changelog
- MCP-tool `maak_rapport_excel` met nieuwe scope `rapporten.excel`: soorten `urenstaat` (periode hooguit 400 dagen; met recht `planning` iedereen, anders alleen eigen regels; bladen Uren en Materiaal), `openstaande_facturen` (recht `facturen`) en `voorraadlijst` (recht `voorraad`). Eigen kleine xlsx-schrijver zonder bibliotheek (`mcp/xlsx-writer.js`, cellen die op een formule lijken worden tekst). Het bestand wacht 15 minuten in het geheugen (`mcp/mcp-downloads.js`, maximaal 10 per gebruiker en 50 MB totaal) en wordt opgehaald via `GET /app/api/mcp-download/<token>` voor dezelfde gebruiker en omgeving (anders 404, niet ingelogd 401). Limiet 20 rapporten per uur, audit `rapport_via_ai` en `rapport_gedownload`.
