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
// omschrijving. `group: 'beheer'` zet een module in de zijbalk onder het
// kopje Beheer. De API controleert de rechten ook zelf. Beheerders en
// hoofdbeheerders zien de modules in een vaste zijbalk (shared/sidebar.js)
// in plaats van als tegels; een nieuwe module verschijnt daar vanzelf.
(function (root) {
  const MODULES = [
    {
      id: 'portaal',
      title: 'Mijn portaal',
      description: 'Alles over uw tuinberegening op één plek: offertes, geplande afspraken, de voortgang van de aanleg en het opleverdossier met foto\'s.',
      href: 'portaal/',
      icon: 'user',
      status: 'actief',
      right: 'portaal',
    },
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
      id: 'klantdossier',
      title: 'Klantdossiers',
      description: "Per klant alle installaties: oplevering, ontwerp en zones, geplaatste materialen en de foto's van voor, tijdens en na de aanleg. Af te drukken als opleverrapport (PDF).",
      href: 'klantdossier/',
      icon: 'folder',
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
      right: 'planning',
    },
    {
      id: 'beheer',
      title: 'Beheer',
      description: 'Historie van alle aanvragen, de plannen van alle gebruikers, gebruikersbeheer en de instellingen van de app (API-sleutel, toegangscode, modules).',
      href: 'beheer/',
      icon: 'shield',
      status: 'actief',
      right: 'beheer',
      group: 'beheer',
    },
    {
      id: 'hoofdbeheer',
      title: 'Hoofdbeheer',
      description: 'Alle tenants (klanten) van het platform: aanmaken, wijzigen, uitschakelen, gebruikers beheren en testomgevingen naast live draaien.',
      href: 'hoofdbeheer/',
      icon: 'globe',
      status: 'actief',
      right: 'hoofdbeheer',
      group: 'beheer',
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

  // Iconen (SVG-paden, 24x24) voor de tegels en de zijbalk.
  const ICONS = {
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    sprinkler: '<path d="M12 21v-6"/><path d="M8 21h8"/><circle cx="12" cy="12" r="3"/><path d="M5 9c1.5-2 4-3.5 7-3.5S17.5 7 19 9"/><path d="M2.5 6C5 3.5 8.3 2 12 2s7 1.5 9.5 4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5"/><path d="M12 12v9"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M3 14h18"/><path d="M9 9v11"/>',
    quote: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6"/><path d="M10 17h6"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 12 2 2 4-4"/><path d="M9 17h6"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="14" r="2.5"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    module: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  };
  const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.module}</svg>`;

  // De modules die iemand met deze rechten ziet (tegels en zijbalk), met de
  // `alt`-titel waar die geldt. `disabled` = de instelling `modules` uit
  // api/config (een beheerder kan modules uitzetten; beheer blijft altijd).
  function visible(rights, disabled) {
    const has = (r) => [].concat(r).some((x) => (rights || []).includes(x));
    return MODULES
      .filter((m) => !m.right || has(m.right))
      .filter((m) => m.id === 'beheer' || m.id === 'hoofdbeheer' || !disabled || disabled[m.id] !== false)
      .map((m) => (m.alt && has(m.alt.right) && !has(m.alt.unless) ? { ...m, ...m.alt } : m));
  }

  // Wie krijgt de vaste zijbalk in plaats van het tegeldashboard
  // (shared/sidebar.js): beheerders en hoofdbeheerders.
  const usesSidebar = (rights) => (rights || []).includes('beheer') || (rights || []).includes('hoofdbeheer');

  root.AquatechModules = MODULES;
  root.AquatechModuleTools = { ICONS, icon, visible, usesSidebar };
  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
})(typeof window !== 'undefined' ? window : globalThis);
