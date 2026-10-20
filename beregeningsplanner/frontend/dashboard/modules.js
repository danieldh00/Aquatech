// Moduleregister van het Aquatech-dashboard.
//
// Een nieuwe module toevoegen:
//   1. maak een map `frontend/<id>/` met een eigen `index.html` (alle URL's
//      relatief, net als de beregeningsplanner);
//   2. voeg hieronder een regel toe met `status: 'actief'` en `href: '<id>/'`.
// De server serveert elke map met een `index.html` automatisch als module
// (ook diepe paden en `<id>` zonder slash), dus aan de backend hoeft niets te
// veranderen. Modules met `status: 'gepland'` staan als "binnenkort" op het
// dashboard en zijn nog niet aan te klikken. `right` bepaalt wie de tegel
// ziet: een recht uit shared/roles.js (of een lijst, één ervan is genoeg),
// bijv. 'beheer' (beheerders) of 'hoofdbeheer' (hoofdbeheerders van het
// platform). Zonder `right` ziet iedereen de module. Met `alt` krijgt wie
// het recht `alt.right` heeft (en niet `alt.unless`) een andere titel en
// omschrijving. De API controleert de rechten ook zelf.
(function (root) {
  const MODULES = [
    {
      id: 'beregening',
      title: 'Beregeningsplanner',
      description: 'Tuinberegening ontwerpen: vlakken tekenen of een plan laten herkennen, sproeiers, zones en leidingen, en een stuklijst met Excel-export.',
      href: 'beregening/',
      icon: 'sprinkler',
      status: 'actief',
      right: 'plannen',
    },
    {
      id: 'plannen',
      title: 'Plannenoverzicht',
      description: 'Alle beregeningsplannen in één tabel: projectnaam, klant, adres, oppervlaktes, sproeiers en zones, met Excel-export. Installateurs en beheerders zien de plannen van de hele organisatie.',
      href: 'plannen/',
      icon: 'table',
      status: 'actief',
      right: 'plannen',
      alt: { right: 'plannen', unless: 'plannen.alle', title: 'Mijn plannen', description: 'Uw beregeningsplannen in één tabel: projectnaam, adres, oppervlaktes, sproeiers en zones, met Excel-export.' },
    },
    {
      id: 'offertes',
      title: 'Offertes',
      description: 'Offertes opbouwen uit een beregeningsplan: stuklijst en arbeid worden overgenomen, met bewerkbare prijzen, korting en btw, klantgegevens en export als PDF of Excel.',
      href: 'offertes/',
      icon: 'quote',
      status: 'actief',
      right: ['offertes', 'offertes.klant'],
      // Een klant (die zelf geen offertes opstelt) ziet de tegel zo.
      alt: { right: 'offertes.klant', unless: 'offertes', title: 'Mijn offertes', description: 'De offertes die voor u klaarstaan: bekijken, afdrukken en akkoord geven of afwijzen.' },
    },
    {
      id: 'werkorders',
      title: 'Werkorders',
      description: 'Werkorders uit geaccordeerde offertes: uitvoeringsplan met werkstappen en uren, zone-indeling, materiaallijst om te verzamelen, planning, toewijzing en een werkbon als PDF of Excel.',
      href: 'werkorders/',
      icon: 'clipboard',
      status: 'actief',
      right: 'werkorders',
    },
    {
      id: 'planning',
      title: 'Planning',
      description: 'Weekagenda van de werkorders per uitvoerder: inplannen door te slepen, en de klant bevestigt de afspraak via een link.',
      href: 'planning/',
      icon: 'calendar',
      status: 'actief',
      right: 'werkorders',
    },
    {
      id: 'beheer',
      title: 'Beheer',
      description: 'Historie van alle aanvragen, de plannen van alle gebruikers, gebruikersbeheer en de instellingen van de app (API-sleutel, toegangscode, modules).',
      href: 'beheer/',
      icon: 'shield',
      status: 'actief',
      right: 'beheer',
    },
    {
      id: 'hoofdbeheer',
      title: 'Hoofdbeheer',
      description: 'Alle tenants (klanten) van het platform: aanmaken, wijzigen, uitschakelen, gebruikers beheren en testomgevingen naast live draaien.',
      href: 'hoofdbeheer/',
      icon: 'globe',
      status: 'actief',
      right: 'hoofdbeheer',
    },

    {
      id: 'voorraad',
      title: 'Voorraadbeheer',
      description: 'Artikelen, voorraad per locatie en bestellingen, met reservering vanuit de stuklijst.',
      icon: 'box',
      status: 'gepland',
      right: 'offertes',
    },
  ];

  root.AquatechModules = MODULES;
  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
})(typeof window !== 'undefined' ? window : globalThis);
