---
titel: Specificaties in één keer vullen in plaats van AI-teksten
---

## Nieuws
- [voorraad] Artikelen > Teksten: *Specificaties vullen* zoekt technische kenmerken op (bij voorkeur bij bosta.com) en zet ze als overzicht bij het artikel. Eigen specificaties blijven staan.
- Door de AI geschreven omschrijvingen worden in de webshop niet meer getoond; de specificaties staan wel op de productpagina. De teksten blijven bewaard.

## Changelog
- Bulkrun (`item-text-bulk.js`): standaardmodus `specs` (`mode: 'texts'` houdt het oude schrijven). `drafts.applySpecs` zet de gevalideerde kenmerken uit `item_specs` als `stock_items.specifications` (leeg = alles, anders alleen nieuwe namen; nooit overschrijven) en legt `specsAt` vast (`recordSpecs`); `bulkTodo({ mode: 'specs' })` toont wat nog niet gevuld is. Geen tekst, dus geen schrijver nodig.
- Zoekopdracht kenmerken (`FEATURES_SYSTEM`): voorkeursbron bosta.com (alleen via het zoekgereedschap, bron per kenmerk met bronzin), technische details met vaste Nederlandse namen. `PROMPT_VERSION` van Past bij blijft gelijk.
- Webshop (`storefront-data.js` `readDetails`): een omschrijving met `item_specs.textLog.action` nieuw of overschreven wordt niet getoond (ook niet in de feed en JSON-LD); een webshoptekst die ervoor stond komt weer tevoorschijn. Geen migratie.
