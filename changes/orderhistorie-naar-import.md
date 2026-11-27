---
titel: Orderhistorie uit WordPress naar Import en export
---

## Nieuws
- [voorraad] De orderhistorie uit WordPress staat niet meer onder *Past bij* maar onder *Import en export*, bij de tijdelijke webshopknoppen. Na *Ontbrekende uit webshop toevoegen* worden de orderregels zonder artikel meteen opnieuw gekoppeld.

## Changelog
- Het blok `#rl-wp` is van het tabblad Past bij naar het tabblad Import verhuisd; `ArtikelenRelated.loadWp` laadt het bij het openen van dat tabblad.
- `stock-routes.js`: na de taak *Ontbrekende uit webshop toevoegen* roept `ctx.rematchWpOrders` (= `wpOrderHistory.rematch`) de koppeling van de orderregels opnieuw aan.
