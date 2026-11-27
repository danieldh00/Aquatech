---
titel: Merken en soorten voor sprekende artikelcodes
bump: minor
---

## Nieuws
- [voorraad] Nieuw onderdeel Artikelen > Merken & soorten: leg merken (bijvoorbeeld UD) en soorten (bijvoorbeeld KBI) vast waaruit de artikelcodes worden opgebouwd, met of zonder merk (UD.KBI.20.12 of KBI.20.12). Je kunt er een codevoorstel proberen met diameter en draadmaat in duimen. Het artikelformulier zelf volgt in de volgende stap.

## Changelog
Migratie 104: tabellen `main_groups` (merken) en `sub_groups` (soorten, met of zonder merk), `stock_items.main_group_id`/`sub_group_id` en `item_aliases` (oude nummers en EAN als zoeknaam, uniek per omgeving). Nieuw `frontend/shared/article-code.js` (UMD: `buildCode`, `parseCode`, `threadCode` voor BSP-duimen als cijfers (½" = 12, ¾" = 34, 1¼" = 114), `compareCodes` voor de volgorde klein naar groot) en `backend/src/artikelen/code-groups.js` met routes `GET /api/stock/code-groups`, `POST|PATCH|DELETE /api/stock/main-groups|sub-groups`, `GET /api/stock/code-proposal` (voorstel + uniciteitscontrole; een artikelgroep krijgt MERK.SOORT, daarna een volgnummer) en `GET|PUT /api/stock/items/:id/aliases`. Een merk of soort waar artikelen aan hangen houdt zijn code en wordt gearchiveerd i.p.v. verwijderd. Nieuw tabblad Merken & soorten in Artikelen (zijbalk, Beheer) en testdata.
