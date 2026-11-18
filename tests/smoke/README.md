# Rooktests na een uitrol

Playwright-tests tegen de live omgeving, alleen lezen. De workflow `.github/workflows/rooktests.yml` start na elke
geslaagde *Release*, wacht tot de server de nieuwe versie draait (`wait-for-version.js`, tot 30 min; de server rolt
binnen ~15 min uit) en voert dan `rooktests.spec.js` uit. Bij een fout faalt de run en komt er een GitHub-issue
(label `rooktest`), of een opmerking bij het open issue.

Secrets (Settings > Secrets and variables > Actions), alle optioneel; zonder gebruikersnaam en wachtwoord worden de ingelogde tests overgeslagen:

| Secret | Inhoud |
|---|---|
| `SMOKE_USERNAME` | Testaccount met recht `beheer`, zonder tweestapsverificatie en zonder verplichte wachtwoordwijziging |
| `SMOKE_PASSWORD` | Wachtwoord van dat account |
| `SMOKE_ORG` | Organisatiecode (alleen bij multitenancy) |

Optionele repository-variabele `SMOKE_BASE_URL` (standaard `https://aquatech.den-hollander.com`).
Handmatig starten: Actions > Rooktests > Run workflow (optioneel zonder te wachten op een versie).
Lokaal: `cd tests/smoke && npm ci && npx playwright install chromium && SMOKE_BASE_URL=… npx playwright test`.
