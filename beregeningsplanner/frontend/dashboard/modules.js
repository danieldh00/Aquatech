// Moduleregister van het Aquatech-dashboard.
//
// Een nieuwe module toevoegen:
//   1. maak een map `frontend/<id>/` met een eigen `index.html` (alle URL's
//      relatief, net als de beregeningsplanner);
//   2. voeg hieronder een regel toe met `status: 'actief'` en `href: '<id>/'`.
// De server serveert elke map met een `index.html` automatisch als module
// (ook diepe paden en `<id>` zonder slash), dus aan de backend hoeft niets te
// veranderen. Modules met `status: 'gepland'` staan als "binnenkort" op het
// dashboard en zijn nog niet aan te klikken.
(function (root) {
  const MODULES = [
    {
      id: 'beregening',
      title: 'Beregeningsplanner',
      description: 'Tuinberegening ontwerpen: vlakken tekenen of een plan laten herkennen, sproeiers, zones en leidingen, en een stuklijst met Excel-export.',
      href: 'beregening/',
      icon: 'sprinkler',
      status: 'actief',
    },
    {
      id: 'planning',
      title: 'Planning',
      description: 'Werkzaamheden en ploegen inplannen, gekoppeld aan projecten uit de beregeningsplanner.',
      icon: 'calendar',
      status: 'gepland',
    },
    {
      id: 'voorraad',
      title: 'Voorraadbeheer',
      description: 'Artikelen, voorraad per locatie en bestellingen, met reservering vanuit de stuklijst.',
      icon: 'box',
      status: 'gepland',
    },
  ];

  root.AquatechModules = MODULES;
  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
})(typeof window !== 'undefined' ? window : globalThis);
