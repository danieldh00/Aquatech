---
titel: Cookieverklaring met alle gebruikte diensten
---

## Nieuws
- [beheer] De webshop heeft een pagina Cookieverklaring (link onderaan, naast de privacyverklaring). Per dienst en per cookie staat erin wat er wordt gebruikt: aanbieder, doel, cookienamen, bewaartermijn, doorgifte buiten de EU en het privacybeleid van de aanbieder. Google Analytics, Microsoft Clarity, reCAPTCHA, bestellen als gast en Mollie staan er alleen in als ze aan staan.

## Changelog
- Nieuwe juridische pagina `cookieverklaring` (`webshop/cookie-notice.js`, `legal-pages.js`): noodzakelijke cookies (`aquatech_winkelwagen`, `aquatech_laatste_lijst`, sessie, gastbestelling, cookiekeuze), analytisch (GA4, Clarity, alleen met toestemming) en diensten van derden (reCAPTCHA, Mollie), afgeleid van wat de shop werkelijk laadt (`cookieServicesOf` in storefront.js). De privacyverklaring noemt Google en Microsoft nu ook alleen als ze aan staan en verwijst naar de cookieverklaring. De cookiebanner is ongewijzigd (noemt geen diensten, niets laadt vóór toestemming). Een eigen pagina met de naam `cookieverklaring` in Beheer gaat voor; de standaardtekst in Beheer toont alle diensten als voorbeeld. Geen migratie.
