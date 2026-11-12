---
titel: AI-koppeling vraagt terug bij onduidelijkheid
---

## Nieuws
- [offertes] De AI-koppeling raadt niet meer: bij meerdere klanten of artikelen, een onbekende artikelcode, een ontbrekende prijs, maat of klant vraagt de AI het eerst aan jou voordat er een concept-offerte komt.

## Changelog
- MCP: de serverinstructies bevatten een terugvraagregel. `zoek_klant` en `zoek_artikelen` geven `keuzeNodig` + `vraag` bij meer dan één of geen treffer (een exacte artikelcode of één treffer niet).
- `maak_concept_offerte` maakt niets aan zolang er open punten zijn (klant ontbreekt, onbekende artikelcode, variant niet gekozen, geen prijs, afwijkende genoemde prijs) en geeft `status: 'terugvragen'` met `vragen`; met `ookMetOpenPunten: true` gaat hij toch door (de notities blijven zoals voorheen). Geen extra gegevens en geen nieuwe query: alleen de bestaande, per omgeving gefilterde zoekresultaten.
- Elicitation is niet gebruikt: de server is stateless (geen stroom naar de app), dus terugvragen loopt via het toolresultaat.
