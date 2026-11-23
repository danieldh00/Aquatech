---
titel: Vingerafdruk van de hoofdsleutel in Beheer
---

## Nieuws
- [beheer] Bij Beheer > Back-ups staat nu een vingerafdruk van de hoofdsleutel. Noteer die bij de kopie van de sleutel in je wachtwoordkluis: zo controleer je altijd dat die kopie bij deze server hoort.

## Changelog
Audit B-33 (vervolg): `vault.fingerprint()` geeft een SHA-256 over een apart met HKDF afgeleide sleutel, ingekort tot 96 bit (zes groepen van vier tekens); niet terug te rekenen naar de hoofdsleutel. `GET /api/admin/backups` (alleen hoofdbeheerders) geeft `keyFingerprint` mee; Beheer toont hem in het blok Back-ups. Tests in `backup-restore-routes.test.js`.
