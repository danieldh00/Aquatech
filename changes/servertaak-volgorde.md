---
titel: Servertaken: schijf vergroten vóór staging
---

## Nieuws

## Changelog
Servertaak 013 (schijf van apps01 vergroten) draait nu vóór 012 (stagingomgeving inrichten). Staging eist ruim 6 GB vrije ruimte en faalde daardoor op een bijna volle schijf, waarna taak 013 nooit werd uitgevoerd. Alleen de volgorde in `HOST_TASKS` en `HOST_TASK_IDS` is gewisseld; de id's veranderen niet.
