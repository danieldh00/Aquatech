---
titel: Ontvangst in de zijbalk opent direct Ontvangen
---

## Nieuws
- [orderpick] Vanuit de zijbalk opent Ontvangst nu direct het tabblad Ontvangen, ook als je al op de Orderpick-pagina staat.

## Changelog
`orderpick/receiving.js` en `counting.js` luisteren naar `hashchange`: een klik op de zijbalklink `orderpick/#ontvangst` (of `#tellen`) op dezelfde pagina laadt niet opnieuw en toonde daardoor Picken. Het scherm volgt nu de hash.
