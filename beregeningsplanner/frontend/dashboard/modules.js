// Moduleregister van het Aquatech-dashboard.
//
// Een nieuwe module toevoegen:
//   1. maak een map `frontend/<id>/` met een eigen `index.html` (alle URL's
//      relatief, net als de beregeningsplanner);
//   2. voeg hieronder een regel toe met `status: 'actief'` en `href: '<id>/'`.
// De server serveert elke map met een `index.html` automatisch als module
// (ook diepe paden en `<id>` zonder slash), dus aan de backend hoeft niets te
// veranderen. Modules met `status: 'gepland'` staan als "binnenkort" op het
// dashboard en zijn nog niet aan te klikken. Met `role: 'beheerder'` is een
// module alleen voor beheerders zichtbaar, met `role: 'hoofdbeheerder'` alleen
// voor hoofdbeheerders van het platform (de API controleert dat ook zelf).
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
      id: 'plannen',
      title: 'Plannenoverzicht',
      description: 'Alle beregeningsplannen in één tabel: projectnaam, klant, adres, oppervlaktes, sproeiers en zones, met Excel-export. Beheerders zien de plannen van iedereen met de historie.',
      href: 'plannen/',
      icon: 'table',
      status: 'actief',
    },
    {
      id: 'offertes',
      title: 'Offertes',
      description: 'Offertes opbouwen uit een beregeningsplan: stuklijst en arbeid worden overgenomen, met bewerkbare prijzen, korting en btw, klantgegevens en export als PDF of Excel.',
      href: 'offertes/',
      icon: 'quote',
      status: 'actief',
    },
    {
      id: 'beheer',
      title: 'Beheer',
      description: 'Historie van alle aanvragen, de plannen van alle gebruikers, gebruikersbeheer en de instellingen van de app (API-sleutel, toegangscode, modules).',
      href: 'beheer/',
      icon: 'shield',
      status: 'actief',
      role: 'beheerder',
    },
    {
      id: 'hoofdbeheer',
      title: 'Hoofdbeheer',
      description: 'Alle tenants (klanten) van het platform: aanmaken, wijzigen, uitschakelen, gebruikers beheren en testomgevingen naast live draaien.',
      href: 'hoofdbeheer/',
      icon: 'globe',
      status: 'actief',
      role: 'hoofdbeheerder',
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
