---
titel: Snellere pagina's door verkleinde scripts en stijlen
---

## Nieuws
- Pagina's laden sneller: de scripts en stijlen van de app zijn verkleind.

## Changelog
In de release-image wordt de frontend in een aparte bouwstap verkleind (`backend/tools/minify-frontend.js`, esbuild als
devDependency, alleen in de bouwstap). Alle eigen `.js` en `.css` worden verkleind (witruimte, commentaar, syntaxis; geen
hernoemen van globale namen); `vendor/` en `.min.`-bestanden blijven ongewijzigd. De broncode in de repo blijft leesbaar,
de bestandsnamen en `?v=<versie>`-adressen blijven gelijk (de inhoud verandert alleen mee met een nieuwe versie, dus
Cloudflare-cache en cache-busting werken zoals voorheen). De backend wordt niet verkleind (draait op de server, niet in de
browser).
