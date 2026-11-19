---
titel: Nieuwe productkaarten in de webshop
---

## Nieuws
- Productkaarten in de webshop zijn compacter en even hoog: geen grote witte vlakken meer, de keuzelijst voor uitvoeringen staat netjes onder de naam en de knop *In winkelwagen* past op elke kaart (op een telefoon als winkelwagenicoon).

## Changelog
Alleen `webshop/storefront.css`: één kaartontwerp voor home en categorieën (de aparte `.browse`-kaartregels zijn samengevoegd). Foto met vaste verhouding die meegroeit, naam op twee regels, prijs en voorraad onder elkaar, aantal en knop onderaan op één lijn; container query op de kaart (`max-width: 200px`) maakt van de knop een icoon. Het artikelnummer en het aantal varianten staan niet meer op de kaart (zijn nog wel in de HTML voor het script).
