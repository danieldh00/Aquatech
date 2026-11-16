# AI-koppeling / MCP-server (backend/src/mcp)

Alleen de regels voor deze map; het volledige geheugen staat in de root-`CLAUDE.md` (zoek op "AI-koppeling").

- Een nieuwe tool krijgt een scope in `SCOPES` (met de rechten van de rol), een limiet en audit bij schrijven, en schrijft hoogstens een concept: alleen wat in de app zichtbaar en corrigeerbaar is.
- `userForGrant` controleert elk verzoek opnieuw; een klant mag de koppeling niet gebruiken. Tokens alleen als SHA-256 opslaan.
- Leestools geven geen interne velden (`note`, `internalNote`, kostprijs) en tonen per onderdeel alleen wat de rol mag.
- Een nieuw MCP-rapport = een soort in `REPORT_RIGHTS` met zijn recht en bladen via `buildWorkbook`; altijd Excel, nooit CSV en nooit een link die zonder inlog werkt.
- Onduidelijke invoer: `terugvragen` in plaats van raden.
