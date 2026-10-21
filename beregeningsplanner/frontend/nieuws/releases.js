// Wat is nieuw: het versielogboek voor gebruikers, in gewone taal (de
// technische details staan in CHANGELOG.md). Gedeeld door de server (require,
// voor de melding "nieuw sinds je vorige bezoek") en de pagina Nieuws.
//
// Bij elke versie-bump een regel bovenaan toevoegen (test/news.test.js
// controleert dat de versie uit package.json erin staat). Alleen wat een
// gebruiker merkt; een versie zonder zichtbare wijziging krijgt
// `items: []` en wordt dan niet getoond.
//
// Per punt `for`: de rechten (shared/roles.js) waarvan er één nodig is om
// het punt te zien; zonder `for` ziet iedereen het. Zo ziet een klant geen
// nieuws over de planning en een installateur geen nieuws over Beheer.
(function (root) {
  const RELEASES = [
    {
      version: '0.50.0',
      date: '2026-10-21',
      title: 'Nieuws en wat is nieuw',
      items: [
        { text: 'Nieuwe pagina **Nieuws**: berichten van je organisatie en een overzicht van wat er in de app is veranderd. Een stip bij Nieuws laat zien dat er iets nieuws is sinds je vorige bezoek.' },
        { text: 'Beheerders plaatsen zelf **nieuwsberichten** voor alle collega\'s (of ook voor klanten), kunnen een bericht bovenaan vastzetten en het desgewenst ook per e-mail versturen.', for: ['nieuws'] },
      ],
    },
    {
      version: '0.49.0',
      date: '2026-10-20',
      title: 'Rollen zelf instellen',
      items: [
        { text: 'Onder **Beheer → Rollen** stel je per rol in wat iemand mag, wijzig je de naam en maak je eigen rollen aan.', for: ['beheer'] },
        { text: 'Nieuwe rol **Planner**: plant klussen in de agenda en regelt afspraken met klanten, zonder toegang tot offertes of beheer.', for: ['beheer', 'planning'] },
      ],
    },
    {
      version: '0.48.0',
      date: '2026-10-20',
      title: 'Werk uitbesteden',
      items: [
        { text: 'Te veel werk? Bied een werkorder aan bij een andere organisatie op het platform, of neem opdrachten van anderen aan. Nieuwe module **Uitbesteden**; de beheerder zet het aan in de instellingen.', for: ['uitbesteden', 'beheer'] },
        { text: 'Een andere organisatie ziet pas na het aannemen de gegevens van de klant. Jij volgt daarna de voortgang bij de werkorder.', for: ['uitbesteden', 'beheer'] },
      ],
    },
    {
      version: '0.47.0',
      date: '2026-10-20',
      title: 'Sneller',
      items: [
        { text: 'De app reageert sneller: pagina\'s halen minder en alleen de nodige gegevens op.' },
      ],
    },
    {
      version: '0.46.1',
      date: '2026-10-20',
      title: 'Beveiliging',
      items: [
        { text: 'Extra beveiliging bij inloggen en bij de openbare offerte- en afspraaklinks.', for: ['beheer'] },
      ],
    },
    {
      version: '0.46.0',
      date: '2026-10-20',
      title: 'Geen tussenstappen meer',
      items: [
        { text: 'Een offerte of werkorder die je vanuit een ander onderdeel opent, verschijnt meteen. De terugknop brengt je terug naar waar je vandaan kwam.' },
        { text: 'Pagina\'s laden vlotter en de app opent direct op je eigen startpagina.' },
      ],
    },
    {
      version: '0.45.0',
      date: '2026-10-20',
      title: 'Planning overzichtelijker',
      items: [
        { text: 'Elke afspraak in de planning laat kort zien wat er gedaan moet worden, en een klik opent meteen de werkorder.', for: ['planning', 'werkorders'] },
      ],
    },
    {
      version: '0.44.0',
      date: '2026-10-20',
      title: 'Eigen kleuren',
      items: [
        { text: 'De kleuren van de app zijn aan te passen aan de huisstijl van de organisatie; te lichte kleuren worden geweigerd zodat alles leesbaar blijft.', for: ['hoofdbeheer'] },
      ],
    },
    {
      version: '0.43.0',
      date: '2026-10-20',
      title: 'Mijn profiel',
      items: [
        { text: 'Via het rondje met je initialen rechtsboven open je **Mijn profiel**: naam, e-mailadres, telefoonnummer en wachtwoord wijzigen op één plek.' },
        { text: 'Kies een **startpagina**: de app opent dan meteen in het onderdeel waar je het meest mee werkt.' },
        { text: 'Ontvang desgewenst een kopie van de offertes en afspraken die je per e-mail verstuurt.', for: ['offertes', 'werkorders'] },
      ],
    },
    {
      version: '0.42.0',
      date: '2026-10-20',
      title: 'Startscherm voor de installateur',
      items: [
        { text: 'Het overzicht begint met **Vandaag**: je klussen van de dag met adres, route, bellen, instructies en voortgang. Gemaakt voor de telefoon.', for: ['werkorders'] },
      ],
    },
    {
      version: '0.40.0',
      date: '2026-10-20',
      title: 'Planning als agenda',
      items: [
        { text: 'De planning is een agenda met een dag-, werkweek- en maandweergave. Sleep een werkorder naar een tijdstip; de duur volgt uit de uren in de offerte.', for: ['planning'] },
      ],
    },
    {
      version: '0.38.0',
      date: '2026-10-20',
      title: 'Foto\'s en klantdossiers',
      items: [
        { text: 'Maak bij een werkorder foto\'s van voor, tijdens en na de aanleg, rechtstreeks met de camera van je telefoon.', for: ['werkorders'] },
        { text: 'Nieuwe module **Klantdossiers**: per klant alle installaties met foto\'s, materialen en zones, af te drukken als opleverrapport.', for: ['werkorders'] },
        { text: 'In je portaal staan nu ook de foto\'s van de aanleg in het opleverdossier.', for: ['portaal'] },
      ],
    },
    {
      version: '0.37.0',
      date: '2026-10-20',
      title: 'Mijn portaal',
      items: [
        { text: 'In **Mijn portaal** ziet u alles over uw tuinberegening op één plek: offertes, afspraken, de voortgang van de aanleg en het opleverdossier.', for: ['portaal'] },
      ],
    },
    {
      version: '0.36.0',
      date: '2026-10-20',
      title: 'Planning en afspraken',
      items: [
        { text: 'Nieuwe module **Planning**: werkorders inplannen door ze naar een dag en uitvoerder te slepen.', for: ['planning', 'werkorders'] },
        { text: 'De klant bevestigt de afspraak via een link, of vraagt om een ander moment.', for: ['planning', 'werkorders'] },
        { text: 'U krijgt een link om de afspraak voor de aanleg te bevestigen of een ander moment te vragen.', for: ['portaal'] },
      ],
    },
  ];

  /** De versies met alleen de punten die iemand met deze rechten ziet. */
  function visibleFor(rights) {
    const has = (list) => !list || list.some((r) => (rights || []).includes(r));
    return RELEASES
      .map((r) => ({ ...r, items: r.items.filter((it) => has(it.for)).map(({ text }) => ({ text })) }))
      .filter((r) => r.items.length);
  }

  /** Vergelijkt twee versienummers ('0.9.0' < '0.10.0'). */
  function compare(a, b) {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  }

  const api = { RELEASES, visibleFor, compare, latest: RELEASES[0].version };
  root.AquatechReleases = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
