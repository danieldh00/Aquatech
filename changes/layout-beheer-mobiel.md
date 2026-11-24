---
titel: Beheer en kopbalk netter op de telefoon
---

## Nieuws
- [beheer] Beheer > Webshop-inhoud scrolt op de telefoon niet meer zijwaarts.
- De kopbalk past op een smal scherm ook met de organisatiewisselaar en de belknop is groter om te tikken.
- [beheer] Brede tabellen (zoals Beheer > Gebruikers) tonen op de telefoon een schaduw aan de rand waar je nog kunt schuiven.

## Changelog
Layoutcheck-bevindingen L-02, L-03, L-10, L-12 en L-13 (thema Beheer + app-shell mobiel):
- `beheer.css`: `.sc-block`, labels en keuzelijsten krimpen (min-width: 0), zodat de fieldsets op 375 px niet breder zijn dan het scherm; `.btn.small` (ook als `a`) is op smal scherm 40 px hoog.
- `dashboard.css`: organisatiewisselaar mag krimpen, gebruikersmenu en belknop niet; belknop 40x40 px.
- `brand.css`: scrollschaduw op `.tablewrap` onder 700 px; `sidebar.css`: nieuwsbadge 11 px.
- `profiel/ai-connections.js`: een klant vraagt de AI-koppelingen niet meer op (voorkomt een 403 in de console).
