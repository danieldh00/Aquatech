---
titel: Nieuw scherm Modules: alles per categorie aan of uit
bump: minor
---

## Nieuws
- [beheer] Beheer > Modules is vernieuwd: per categorie een kaart per module met een schakelaar, en daaronder de onderdelen met een eigen schakelaar (bijvoorbeeld offerte-opvolging, betalingsherinneringen, automatische bestelvoorstellen, bestellen als gast, Google Analytics en de AI-koppeling). Je kunt zoeken, filteren op aan of uit en ziet in één oogopslag hoeveel er aan staat.
- [beheer] Een onderdeel volgt zijn module: staat de module uit, dan zijn de onderdelen grijs. Gegevens en instellingen blijven bewaard. Bij een onderdeel met meer instellingen staat de link Instellen.
- [beheer] Na het opslaan past het menu links zich direct aan, zonder de pagina te verversen.

## Changelog
Scherm Beheer > Modules (`frontend/beheer/modules.js`, eigen paneel `tab-modules`, stijl `.md-*` in beheer.css; geen migratie).
- Tekent de indeling uit `switchTree()` en leest en schrijft via `GET|PUT /api/admin/modules`; alleen gewijzigde schakelaars gaan mee. Zoekveld, filter Alles/Aan/Uit, teller, snelkeuze per categorie, Alles aan/uit per categorie, blok Altijd aan.
- Schakelaars zijn echte checkboxen met `role="switch"` (toetsenbord en schermlezer), tikdoel 40 px; op slot (webshop buiten de hoofdorganisatie, uitbesteden zonder multitenancy) met de reden erbij.
- Register: `section` (link Instellen naar de sectie van Beheer) en `switchTitle` (naam op de kaart).
- `AquatechNav.setDisabled(flags)` in `shared/sidebar.js`: de zijbalk volgt direct na het opslaan.
- Het oude formulier `s-modules` is weg.
