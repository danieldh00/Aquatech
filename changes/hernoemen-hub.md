---
titel: De app heet nu AquaTech Hub
---

## Nieuws
- De app heet nu **AquaTech Hub**: de naam staat in het tabblad van je browser en bij het installeren op je telefoon. De Beregeningsplanner blijft een onderdeel (module) van de Hub; de webshop blijft AquaTech Shop.

## Changelog
Productnaam AquaTech Hub: de map `beregeningsplanner/` is `hub/` geworden (Dockerfile-context, `docker-compose.yml`, CI, `release.yml`, `version.yml`, `claude-review.yml`, releasetool, tests, docs). Paginatitels, PWA-manifest en de Excel-maker in de stuklijst gebruiken de nieuwe naam; `package.json` heet `aquatech-hub-backend`. De schilcache van de service worker heet `aquatech-hub-shell-<versie>` en de oude `aquatech-shell-*` wordt opgeruimd. Bewust niet hernoemd: de IndexedDB-wachtrij en de datacache (onverzonden werk gaat niet verloren), de opslagsleutel `aquatech-beregeningsplanner-v1` van de planner, het GHCR-image `ghcr.io/danieldh00/aquatech`, de bedrijfsnaam AquaTech Service in documenten en de webshopnaam.
