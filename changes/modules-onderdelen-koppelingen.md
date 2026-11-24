---
titel: Visma, KPI's, openstaande taken en voorraadmelding apart aan of uit
---

## Nieuws
- [beheer] In Beheer > Modules aan/uit staan nu ook de koppeling met Visma, de KPI's en de openstaande taken van het dashboard en de voorraadmelding van de webshop. Wat uit staat verdwijnt uit het scherm en doet niets meer op de achtergrond.

## Changelog
- Schakelaars `visma` (heeft Facturen nodig; adressen `/api/visma/**` dicht, niet meer automatisch doorsturen), `dashboard-cijfers` (`/api/kpis`, instelling `dashboardKpis`), `dashboard-taken` (`/api/tasks`, blok en bel) en `webshop-voorraadmelding` (formulier op de productpagina en de mails).
- De winkel krijgt `featureOn(id)` mee van de server.
- Een bladwijzer naar een tabblad van Artikelen waarvan het onderdeel uit staat (zoals Telling) opent dat tabblad niet meer.
