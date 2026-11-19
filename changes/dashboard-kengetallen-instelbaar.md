---
titel: KPI's op het dashboard zelf kiezen
---

## Nieuws
- [beheer] Kies zelf welke KPI's je op het dashboard ziet, in welke volgorde en over welke periode (Beheer > Modules > Dashboard: KPI's). Er zijn nu ook KPI's voor gefactureerde omzet, geaccepteerde offertes, open werkorders, webshopbestellingen, voorraad onder het minimum en inkooporders onderweg. Bezetting staat standaard uit.

## Changelog
- Nieuwe catalogus `platform/kpi-catalog.js` (vaste KPI's met module, recht, periode en berekening); instelling `dashboardKpis` {items [{key, enabled}], period} per omgeving; `GET /api/admin/kpi-catalog` voor het keuzescherm (`beheer/dashboard-kpis.js`, bewaart bij elke wijziging). `GET /api/kpis` toont alleen aan staande KPI's waarvan de module aan staat en waarvoor de gebruiker het recht heeft, in de gekozen volgorde. Nieuwe KPI's komen automatisch achteraan met hun standaardstand. Standaard aan: openstaand, vervallen, gefactureerd, open offertes; bezetting staat uit. Geen migratie.
