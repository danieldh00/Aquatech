---
titel: Tekeningen bewaren om de herkenning te verbeteren
---

## Nieuws
- [beheer] Nieuwe instelling *Tekeningen bewaren om de herkenning te verbeteren* (Beheer → Integraties → AI-herkenning, standaard uit). Bij een goedgekeurd plan bewaart de app dan de tekening (versleuteld) en het eindplan, zodat de planner zonder AI steeds beter plannen kan lezen.

## Changelog
- Migratie 70 (`MIGRATIONS` en `PG_MIGRATIONS`): kolommen `corpus_image`, `corpus_width`, `corpus_height`, `corpus_final` op `plan_recognitions`. Geen nieuwe tabel; een bestaande regel van een goedgekeurd plan (`source = 'plan'`) krijgt de tekening en het eindplan.
- Instelling `planCorpus` (bool, standaard uit, per omgeving); `GET /api/config` geeft `planCorpus`. `POST /api/plan/corpus` (recht `plannen.goedkeuren`, alleen een goedgekeurd plan van de eigen omgeving, limiet 20 per uur): de afbeelding wordt op inhoud gecontroleerd (`inspectImage`, metadata eruit, max. 8 MB, 8000 px) en met `vault.sealBytes` (AAD `<tenant>:plan-corpus:<plan>`) bewaard, het eindplan wordt gesaneerd (`sanitizeFinalPlan`). Audit `plan_corpus_bewaard`. Wissen via `store.purgePlan` ruimt de regel mee op.
- De planner stuurt na het goedkeuren (naast de kleurtellingen) de analyse-afbeelding als PNG en het eindplan in pixels (`app.js` `_learnFromPlan`, `Concept.saveCorpus`).
- `tools/corpus-export.js`: ontsleutelt het corpus van een omgeving naar `naam.png` + `naam.json`, de invoer van `tools/recog-bench.js` (PR #226).
