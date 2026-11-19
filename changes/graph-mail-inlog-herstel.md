---
titel: Mail via Microsoft Graph automatisch instellen werkt weer
---

## Nieuws
- [beheer] Automatisch instellen van Microsoft Graph-mail (Beheer > Instellingen > E-mail) werkt weer: Microsoft weigerde de eerder gebruikte inlog-app. Bij een fout staat er nu een duidelijke melding met verwijzing naar de handleiding in hetzelfde scherm.

## Changelog
- `mail-graph-setup.js`: standaard inlog-client is nu Microsoft Graph Command Line Tools (`14d82eec-…`, device code flow) in plaats van de Azure CLI-client, die Microsoft met AADSTS65002 weigert voor Graph-tokens van app-registraties. Nog steeds te vervangen met `GRAPH_SETUP_CLIENT_ID`.
- `loginProblem`: AADSTS-codes uit de Microsoft-inlog (65002, 65001, 90094/90095, 700016, 50105, 53003, 50076) worden Nederlandse meldingen met verwijzing naar de handleiding; ook een mislukte start geeft nu de oorzaak.
- Test uitgebreid in `test/mail-graph-setup.test.js`.
