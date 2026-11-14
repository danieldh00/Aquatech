---
titel: Google Analytics in de webshop
---

## Nieuws
- [beheer] Je kunt Google Analytics 4 aanzetten voor de webshop (Beheer > Webshop > Google Analytics). Bezoekers krijgen eerst een cookiemelding; zonder toestemming wordt er niets gemeten of van Google geladen.

## Changelog
- Nieuwe instelling `shopAnalytics` (aan/uit en GA4-meet-ID, alleen live en hoofdtenant) met formulier in Beheer > Webshop.
- Cookiemelding en Consent Mode v2 in `analytiek.js`: standaard alles geweigerd, Google pas geladen na Accepteren, alleen `analytics_storage`, link *Cookie-instellingen* in de voet.
- Koopfunnel-gebeurtenissen: view_item_list, select_item, view_search_results, search_no_results, view_item, add_to_cart, remove_from_cart, view_cart, planner_to_cart, begin_checkout, checkout_login_wall, add_shipping_info, add_payment_info, checkout_error en purchase (zonder persoonsgegevens; purchase één keer per bestelnummer).
- De Content-Security-Policy van de shop krijgt alleen met een actief meet-ID de Google-adressen in `script-src` en `connect-src`; geen inline scripts. Zonder meet-ID verandert er niets in de pagina's of de policy.
- Medewerkers meten mee als intern verkeer (`traffic_type`); een voorbeeld meet niet. Robots, webadres en indexering zijn niet aangeraakt.
