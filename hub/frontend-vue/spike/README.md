# W0-spike: webshop-productpagina met Vue SSR

Doel: bewijzen dat één webshoppagina als Vue-component in de bestaande Node-backend server-side getekend kan worden
(`createSSRApp` + `renderToString`, geen Nuxt), met dezelfde HTML als nu en met hydratie in de browser. Alleen nieuwe
bestanden onder `hub/frontend-vue/spike/`; de bestaande shop is niet aangeraakt.

## Draaien

```sh
cd hub/frontend-vue
node spike/spike.mjs     # HTML-vergelijking oud/nieuw + tijd en CPU
node spike/hydrate.mjs   # hydratie in Chromium (Playwright)
```

## Uitkomst (sandbox, één kern, Node 22)

| Onderdeel | Resultaat |
|---|---|
| HTML van kruimelpad + artikelblok, oud tegen nieuw | **gelijk** na normalisatie van witruimte; de vertrouwensstrook ontbreekt bewust in de spike |
| Tijd per pagina (artikelblok), oud / Vue SSR | ca. 0,06–0,08 ms / 0,06–0,08 ms; CPU ca. 0,08–0,10 / 0,11–0,12 ms |
| Doorvoer | ca. 12.000–16.000 blokken per seconde per kern, beide varianten |
| Hydratie in Chromium | 0 waarschuwingen, 0 consolefouten, markup gelijk voor en na |
| Clientbundel (Vue-runtime + component, minified) | ca. 68 kB |

## Wat dit wel en niet zegt

- Het artikelblok is klein; een volledige pagina (menu, voet, JSON-LD, analytics-attributen) is groter. Vue SSR kost naar schatting
  1,0 tot 1,5 keer de huidige sjabloonfunctie; ruim binnen wat één kern aankan, zeker met HTML-cache per klantgroep (plan W1).
- De 68 kB is Vue zelf. Per pagina hydrateren is dus een vaste kost van ca. 25 kB gzip op de eerste bezoek; daarna uit de cache.
  De huidige shop laadt geen framework. Dit moet in W1 getoetst worden tegen Core Web Vitals (LCP/INP) voordat alle pagina's
  hydrateren; alternatief is hydratie alleen op pagina's met interactie (product, winkelwagen, afrekenen).
- Nog niet in de spike: vertrouwensstrook, varianten- en verpakkingskeuze, JSON-LD en `layout()`, afbeeldings-URL via
  `productImageSrc`, analytics-gebeurtenissen. Die komen in W1 (gedeelde laag) en W2 (productpagina compleet).
- CSP: de spike gebruikt een extern scriptbestand en een `application/json`-blok voor de status; er is geen inline script nodig.
