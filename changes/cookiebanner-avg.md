---
titel: Cookiebanner volgens de AVG en Microsoft Clarity in de webshop
---

## Nieuws
- [beheer] De webshop heeft een nieuwe cookiebanner: Accepteren en Weigeren zijn even duidelijk, bezoekers kiezen per categorie (Noodzakelijk of Analytisch) en kunnen hun keuze altijd wijzigen of intrekken via *Cookie-instellingen* onderaan de pagina.
- [beheer] Microsoft Clarity staat in de webshop en laadt pas nadat de bezoeker Analytisch toestaat. Het project-ID staat al ingevuld en is aan of uit te zetten in Beheer > Webshop > Microsoft Clarity.

## Changelog
- Webshop: toestemmingsbalk herbouwd (`webshop/storefront-analytics.js`, `storefront.css`): titel, Accepteren/Weigeren (zelfde grootte) en *Instellingen* met een venster per categorie (Noodzakelijk altijd aan, Analytisch standaard uit). De balk verschijnt zodra Google Analytics of Clarity actief is; zonder beide staat er niets in de pagina.
- De keuze staat in `localStorage` (`aquatech_shop_consent`) als JSON met versie, keuze en datum; een oude of andere versie vraagt opnieuw. Intrekken wist de cookies van Google Analytics (`_ga*`) en Clarity (`_clck`, `_clsk`, e.a.).
- Nieuwe instelling `shopClarity` {enabled, projectId} (`liveOnly`, alleen hoofdtenant, standaard aan met het project van AquaTech Service), formulier in Beheer > Webshop. Het script `https://www.clarity.ms/tag/<id>` wordt pas na toestemming ingevoegd, met `consentv2` (advertentie-opslag altijd geweigerd), `data-clarity-mask` op alle invoervelden en formulieren, en wordt niet geladen voor medewerkers. De CSP krijgt `clarity.ms`, `c.bing.com` en `worker-src blob:` alleen als Clarity actief is.
- Privacyverklaring: sectie *Cookies en meten* vervangt de tekst "geen tracking" en beschrijft de categorieën, bewaartermijn van de keuze, de cookies en de verwerkers.
