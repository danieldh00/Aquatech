---
titel: Kleiner image en opgeschoonde documentatie
---

## Changelog
Het eindimage bevat alleen nog `backend/src` en `tools/release-info.js` (dat `update.sh` uit het image haalt); de tests en
overige tools (codestijl, bench, minify, release-notes) blijven buiten het image (`hub/Dockerfile`, `hub/.dockerignore`,
bewaakt door `test/dockerfile.test.js`). Verouderde verwijzingen naar Supabase als productiedatabase gecorrigeerd in
`release.yml`, `ci.yml`, `compose.yml`, `deploy/apps01/README.md` en `DOCS.md` (Supabase is terugvaloptie; app-updates gaan
via de updatetimer, Drive-back-ups zitten in de app).
