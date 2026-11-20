---
titel: Hersteltest controleert nu ook de app zelf
---

## Nieuws
- [beheer] De wekelijkse hersteltest van de back-up start nu ook een tijdelijke kopie van de app op de teruggezette gegevens, logt daarin in en haalt een paar gegevens op. Pas als dat lukt is de back-up bewezen bruikbaar. Na het uitrollen: servertaak 005 uitvoeren in Beheer > Systeem > Updates.

## Changelog
`restore-test.sh` zet de wegwerpdatabase en de wegwerp-app op een intern Docker-netwerk zonder uitgang (`docker network create --internal`), start het image van de draaiende app (512 MB, alleen-lezen, tmpfs-datamap, hoofdsleutel alleen-lezen, `CAPTCHA_DISABLED=1`) en draait een controlescript in die container: status (geen eerste start), wegwerpwachtwoord op een actieve beheerder in de wegwerpdatabase, inloggen via de echte route, `api/me`, `api/plans`, `api/quotes`, `api/admin/users`. De uitkomsten komen als extra regels in de bestaande sanity-lijst; een mislukte regel maakt de test `mislukt`. Container en netwerk worden altijd opgeruimd. Servertaak `005-hersteltest-app-controle` installeert het script. Tests: nagebootste docker in `restore-test-script.test.js` (geslaagd, inloggen mislukt, app start niet, app niet gezond); het controlescript is daarnaast met de echte app tegen een teruggezette database geprobeerd.
