---
titel: Offertesjablonen
---

## Nieuws
- [offertes] Offertesjablonen: kies in de offerte een sjabloon met een vaste inleiding, voorwaarden en standaardregels (bijv. voorrijkosten) in plaats van alles te typen. De beheerder bewaart een offerte als sjabloon met één klik.

## Changelog
Instelling `quoteTemplates` (per organisatie, `internal` + `notInView`, alleen via `GET|PUT /api/quote-templates` en `DELETE /api/quote-templates/:id`; kiezen met recht `offertes`, bewaren en verwijderen met `beheer`, audit `offertesjabloon_bewaard`/`_verwijderd`). `verkoop/quote-templates.js`: hoogstens 30 sjablonen met een unieke naam (hoofdletters tellen niet), per sjabloon inleiding, voorwaarden en hoogstens 60 regels (zonder interne notitie en klantkeuze). Een bestaande naam wordt vervangen. In de offerte-editor: kaart *Sjabloon* (Toepassen vervangt inleiding en voorwaarden, met vraag als er al andere tekst staat, en voegt de regels onderaan toe; geen migratie). Test: `test/quote-templates.test.js`.
