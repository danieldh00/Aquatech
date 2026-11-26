---
titel: Cookies en mailvelden veiliger uitlezen
---

## Nieuws

## Changelog
Hardening na de CodeQL-scan: `parseCookies` gebruikt een object zonder prototype en `fillParagraphs` (mail-layout.js) vult alleen eigen sleutels in (nooit `constructor` e.d.).
