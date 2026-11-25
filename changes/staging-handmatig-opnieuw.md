---
titel: Staging probeert bij een handmatige run altijd opnieuw
---

## Changelog
`install-staging.sh` slaat een eerder mislukte commit alleen nog over bij `--timer`; een handmatige run (servertaak) probeert hem opnieuw. Taak 014 deed daardoor niets. Nieuwe servertaak 015 voert de herinrichting alsnog uit.
