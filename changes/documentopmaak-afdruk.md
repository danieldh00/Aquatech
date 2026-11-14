---
titel: Opmaak ook voor offerte, werkbon en klantdossier
---

## Nieuws
- [beheer] De Documentopmaak uit Beheer geldt nu ook voor de offerte (ook de link die de klant opent), de werkbon en het klantdossier: logo, kopstijl, kleuren, lettertype en voettekst zijn overal gelijk.

## Changelog
- `shared/doc-layout.js|.css`: wikkel (`AquatechDocLayout.wrap`) met CSS-variabelen `--doc-primary`, `--doc-accent`, `--doc-font`, `--doc-logo-height` en klassen `doc-plain`, `doc-logo-right`, `doc-no-company`; `logoHtml` en `footerHtml` voor kop en voet. De afdruk-CSS van `quote-view.css` en `klantdossier.css` gebruikt de variabelen met de oude waarden als terugval.
- `GET /api/quote-profile` en `GET /api/public/quote` geven `documentLayout` mee (geen extra verzoek); `quote-view.js` (`options.layout`), `werkorders.js` en `klantdossier.js` gebruiken hem. De twee nieuwe bestanden staan in `PUBLIC_FILES` voor de openbare offertepagina.
- `werkorders/index.html` laadt nu `offertes/quote-view.css`, zodat de werkbon dezelfde afdrukstijl heeft als de offerte. Geen migratie.
