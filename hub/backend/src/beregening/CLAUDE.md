# Beregening: planner-backend, herkenning, bibliotheek (backend/src/beregening)

Alleen de regels voor deze map; bij tegenspraak geldt de root-`CLAUDE.md`. de plannerkern staat in `hub/frontend/beregening/js/`; het volledige geheugen in de root-`CLAUDE.md` (zoek op de term).

- Plan herkennen: één AI-aanroep met vaste uitkomst per afbeelding+model+`PROMPT_VERSION`; kosten begrensd met `aiDailyLimit`/`aiHourlyPerIp`. Elke tenant gebruikt een eigen AI-sleutel; nooit een Claude-abonnement voor AI in de app. Tests bootsen de API na.
- Andere vakjesindeling bij het leren: `FEATURE_VERSION` ophogen in `localrecog.js` én `recognitions.js`.
- Een nieuwe plannerberekening via MCP gebruikt `plan-builder.js` (eigen vm-sandbox, werkthread met limiet), nooit een kopie van de rekenkern.
- De plannerkern is DOM-vrij en wordt in sandboxes geladen: elke pagina/sandbox laadt `sprinklerlib.js` vóór `catalog.js`. Nieuwe artikelcodes in `bom.js` via `add()`.
- Een tekening indienen is openbaar: limiet per IP en tenant, honeypot en captcha-actie.
- De opslagsleutel `aquatech-beregeningsplanner-v1` verandert nooit.
