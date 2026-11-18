---
titel: Producttekst laten schrijven door de AI
bump: minor
---

## Nieuws
- [voorraad] Nieuw tabblad Teksten bij Artikelen: de AI schrijft een concept van de omschrijving en de zoekmachineteksten, alleen met de gegevens die bij het artikel staan. Jij controleert en keurt goed; niets gaat vanzelf live.
- [voorraad] Getallen, eenheden en beweringen (zoals keuren of garantie) in een concept die niet in de artikelgegevens staan worden gemarkeerd. Goedkeuren vraagt dan een uitdrukkelijke bevestiging.
- [voorraad] Concepten schrijven kan voor één artikel of voor een selectie (bijvoorbeeld een categorie of alle artikelen zonder tekst); je keurt ze één voor één of in bulk goed of wijst ze af.

## Changelog
- Migratie 75: tabel `item_text_drafts` (één concept per artikel: omschrijving, zoekmachinetitel en -omschrijving, waarschuwingen, vingerafdruk van de live tekst bij het schrijven). Wordt gewist met het artikel (`removeRow`, samenvoegen).
- `artikelen/item-text-writer.js`: AI-schrijver met de sleutel en het model van de organisatie (`aiTenantOf`), gestructureerde uitvoer, opdracht die alleen de bronvelden toestaat; webadressen en tags worden uit het antwoord gehaald. Verbruik komt als functie `product_tekst` in Beheer > AI-kosten.
- `artikelen/item-text-check.js`: bronvelden uit het artikel (`buildFacts`) en feitencontrole (`checkText`): losse getallen, getal + eenheid (schrijfwijzen als 2,5/2.5, meter/m), codes (PN10, DN25) en beweringen (keuren, garantie, waterdicht, …) moeten in de bron staan, anders een waarschuwing; ook een melding als er weinig gegevens zijn.
- `artikelen/item-text-drafts.js`: opslag en routes onder `/api/stock/item-texts` (recht `voorraad`): lijst met filters, detail, `generate` (hoogstens 5 per verzoek, 3 tegelijk, deels mislukken kan, een fatale fout als geen tegoed stopt de portie, dagelijks maximum telt per artikel), aanpassen, afwijzen, goedkeuren. Goedkeuren bepaalt de waarschuwingen opnieuw, eist `acknowledgeWarnings` bij waarschuwingen en `overwrite` als de live tekst sinds het schrijven is gewijzigd. Varianten en gearchiveerde artikelen krijgen geen concept. De routes vallen onder `configuration.routes` van de module voorraad.
- Frontend: tabblad Teksten (`artikelen/item-texts.js`).
