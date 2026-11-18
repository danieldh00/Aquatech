---
titel: Webshop is na een update meteen snel
---

## Nieuws
- Na een update of herstart warmt de webshop zichzelf op, zodat de eerste bezoekers niet 1 tot 3 seconden extra wachten.

## Changelog
- `webshop/warm-up.js`: twee seconden na het starten haalt de server één voor één de startpagina, de winkelwagen en een paar groepen, categorieën en producten op via 127.0.0.1 (User-Agent met "bot": geen koopfunneltelling, geen medewerkersweergave). Dat vult de catalogus en de omschrijvingen in het geheugen. Een fout of een uitgeschakelde shop stopt niets; uitzetten kan met `WARM_UP=0`. Er wordt niets bewaard behalve wat de pagina's al cachen (geen klantgegevens, geen gerenderde pagina's).
