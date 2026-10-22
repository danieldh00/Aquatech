// Rollen en rechten, gedeeld door de server (require) en de browser
// (window.AquatechRoles). De server beslist; de frontend gebruikt dit alleen
// om te tonen wat iemand mag (tegels, knoppen, keuzelijsten).
//
// Hieronder staan de standaardrollen. Een beheerder kan per organisatie
// (live-tenant, testomgevingen volgen live) de naam, omschrijving en rechten
// van een rol aanpassen en eigen rollen toevoegen (Beheer > Rollen, opslag in
// backend/src/platform/roles.js). De server zet de rechten van de eigen rol dan op
// user.rights; rightsOf() gebruikt die als ze er zijn.
//
// - beheerder:    alles binnen de eigen organisatie (tenant): gebruikers,
//                 instellingen, historie, alle plannen, offertes en werkorders.
//                 Plaatst nieuwsberichten voor de collega's (pagina Nieuws).
//                 Beheert de voorraad (ook installateurs).
//                 Ook opdrachten uitbesteden aan of aannemen van een andere
//                 organisatie (als dat in de instellingen aan staat).
//                 De rechten van deze rol liggen vast.
//                 Maakt facturen en exporteert ze naar de boekhouding.
// - installateur: plannen maken, bewerken en goedkeuren, offertes opstellen en
//                 werkorders uitvoeren voor de hele organisatie en de
//                 voorraad bijhouden; geen gebruikers, instellingen of
//                 historie.
// - planner:      werkorders inplannen in de agenda en de afspraaklink naar de
//                 klant sturen; werkorders en klantdossiers inzien.
// - klant:        alleen de eigen plannen, en de offertes die voor hem zijn
//                 klaargezet inzien en accepteren of afwijzen; in het
//                 klantportaal ook de werkorders uit zijn offertes (afspraak,
//                 voortgang, opleverdossier).
// Een hoofdbeheerder (users.platform_admin) mag alles, in elke tenant.
(function (root) {
  // Soort rol: medewerker (van het bedrijf) of klant. Een klantrol kan alleen
  // klantrechten krijgen en de accounts ervan zijn te koppelen aan offertes.
  const KINDS = { medewerker: 'Medewerker', klant: 'Klant' };

  // Alle rechten met uitleg; `kind` = voor welke soort rol het recht is,
  // `locked` = niet aan of uit te zetten (alleen via de vaste rol beheerder),
  // `needs` = werkt alleen samen met dat recht (gaat dan mee aan).
  const RIGHT_INFO = {
    plannen: { label: 'Beregeningsplanner', description: 'Plannen tekenen en de eigen plannen inzien.', kind: ['medewerker', 'klant'] },
    'plannen.alle': { label: 'Alle plannen', description: 'De plannen van de hele organisatie inzien en bewerken.', kind: ['medewerker'], needs: ['plannen'] },
    'plannen.goedkeuren': { label: 'Plannen goedkeuren', description: 'Plannen controleren en goedkeuren; een plan van een klant is pas definitief na goedkeuring.', kind: ['medewerker'], needs: ['plannen.alle'] },
    offertes: { label: 'Offertes opstellen', description: 'Offertes maken, bewerken en naar de klant sturen.', kind: ['medewerker'] },
    'offertes.alle': { label: 'Alle offertes', description: 'De offertes van de hele organisatie, niet alleen de eigen.', kind: ['medewerker'], needs: ['offertes'] },
    werkorders: { label: 'Werkorders en klantdossiers', description: 'Werkorders inzien en bijwerken, foto\'s toevoegen, klantdossiers bekijken en het blok Vandaag.', kind: ['medewerker'] },
    planning: { label: 'Planning', description: 'Werkorders inplannen in de agenda en de afspraaklink naar de klant sturen.', kind: ['medewerker'], needs: ['werkorders'] },
    uitvoerder: { label: 'Uitvoerder', description: 'Kan als uitvoerder aan een werkorder worden toegewezen en staat als kolom in de planning.', kind: ['medewerker'], needs: ['werkorders'] },
    nieuws: { label: 'Nieuwsberichten plaatsen', description: 'Berichten plaatsen op de pagina Nieuws voor de collega\'s (of ook voor klanten), eventueel ook per e-mail.', kind: ['medewerker'] },
    voorraad: { label: 'Voorraadbeheer', description: 'De voorraad beheren: artikelen, ontvangsten, tellingen, correcties en wat er op werkorders gereserveerd en afgeboekt is.', kind: ['medewerker'] },
    facturen: { label: 'Facturen', description: 'Facturen maken vanuit werkorders of als losse verkoop, crediteren, betalingen bijhouden en exporteren naar de boekhouding.', kind: ['medewerker'] },
    uitbesteden: { label: 'Uitbesteden', description: 'Opdrachten uitbesteden aan of aannemen van een andere organisatie (als dat in de instellingen aan staat).', kind: ['medewerker'], needs: ['werkorders'] },
    'offertes.klant': { label: 'Eigen offertes (klant)', description: 'De offertes die voor dit account klaarstaan inzien en accorderen of afwijzen.', kind: ['klant'] },
    portaal: { label: 'Klantportaal', description: 'Mijn portaal: offertes, afspraken, voortgang en het opleverdossier.', kind: ['klant'] },
    beheer: { label: 'Beheer', description: 'Gebruikers, rollen, instellingen en historie van de organisatie.', kind: [], locked: true },
    hoofdbeheer: { label: 'Hoofdbeheer', description: 'Alle tenants van het platform (alleen hoofdbeheerders).', kind: [], locked: true },
  };
  const RIGHTS = Object.keys(RIGHT_INFO);

  const ROLES = {
    beheerder: {
      label: 'Beheerder',
      kind: 'medewerker',
      locked: true,
      description: 'Alles binnen de organisatie: gebruikers, rollen, instellingen, historie, alle plannen, offertes en werkorders, en opdrachten uitbesteden.',
      rights: ['plannen', 'plannen.alle', 'plannen.goedkeuren', 'offertes', 'offertes.alle', 'werkorders', 'planning', 'uitvoerder', 'nieuws', 'voorraad', 'facturen', 'uitbesteden', 'beheer'],
    },
    installateur: {
      label: 'Installateur',
      kind: 'medewerker',
      description: 'Plannen maken en bewerken, offertes opstellen, werkorders uitvoeren en de voorraad bijhouden; geen gebruikers of instellingen.',
      rights: ['plannen', 'plannen.alle', 'plannen.goedkeuren', 'offertes', 'offertes.alle', 'werkorders', 'planning', 'uitvoerder', 'voorraad'],
    },
    planner: {
      label: 'Planner',
      kind: 'medewerker',
      description: 'Werkorders inplannen in de agenda en afspraken met klanten regelen; werkorders en klantdossiers inzien.',
      rights: ['werkorders', 'planning'],
    },
    klant: {
      label: 'Klant',
      kind: 'klant',
      description: 'Alleen de eigen plannen en de eigen offertes inzien en accepteren; klantportaal met afspraken en opleverdossier.',
      rights: ['plannen', 'offertes.klant', 'portaal'],
    },
  };
  // Oude rolnaam (tot 0.22.0): een 'gebruiker' is nu een installateur.
  const ALIASES = { gebruiker: 'installateur' };

  /**
   * Huidige rolnaam (oude namen omgezet).
   * @param {string} role Rolsleutel.
   * @returns {string} De rolsleutel.
   */
  const normalize = (role) => ALIASES[role] || role;
  /**
   * Is dit een standaardrol?
   * @param {string} role Rolsleutel.
   * @returns {boolean} true als hij in ROLES staat.
   */
  const isRole = (role) => Object.prototype.hasOwnProperty.call(ROLES, role);
  /**
   * Leesbare naam van een rol.
   * @param {string} role Rolsleutel.
   * @returns {string} De naam (of de sleutel zelf).
   */
  const label = (role) => (isRole(role) ? ROLES[role].label : String(role || ''));

  /**
   * Rechten die een rol van deze soort mag hebben (zonder de vaste).
   * @param {string} kind medewerker of klant.
   * @returns {string[]} De rechten.
   */
  const rightsForKind = (kind) => RIGHTS.filter((right) => !RIGHT_INFO[right].locked && RIGHT_INFO[right].kind.includes(kind));

  /**
   * Rechten aangevuld met wat ze nodig hebben (needs), in vaste volgorde.
   * @param {string[]} rights De rechten.
   * @returns {string[]} De aangevulde rechten.
   */
  function withNeeds(rights) {
    const set = new Set(rights);
    for (const right of rights) for (const needed of (RIGHT_INFO[right] && RIGHT_INFO[right].needs) || []) set.add(needed);
    return RIGHTS.filter((right) => set.has(right));
  }
  /**
   * Rechten zonder de rechten die van een uitgezet recht afhangen.
   * @param {string[]} rights De rechten.
   * @param {string} off Het uitgezette recht.
   * @returns {string[]} De overgebleven rechten.
   */
  function withoutDependents(rights, off) {
    return rights.filter((right) => right !== off && !((RIGHT_INFO[right] && RIGHT_INFO[right].needs) || []).includes(off));
  }

  /**
   * Rechten van een gebruiker (database-rij of publicUser-vorm).
   * @param {object|null} user De gebruiker.
   * @returns {string[]} De rechten (hoofdbeheerder: alle).
   */
  function rightsOf(user) {
    if (!user) return [];
    if (user.platform_admin || user.platformAdmin) return RIGHTS.slice();
    if (Array.isArray(user.rights)) return user.rights.slice();
    const role = ROLES[normalize(user.role)];
    return role ? role.rights.slice() : [];
  }

  /**
   * Heeft de gebruiker dit recht?
   * @param {object|null} user De gebruiker.
   * @param {string} right Het recht.
   * @returns {boolean} true als hij het heeft.
   */
  const can = (user, right) => rightsOf(user).includes(right);

  const api = { ROLES, RIGHTS, RIGHT_INFO, KINDS, ALIASES, normalize, isRole, label, rightsForKind, withNeeds, withoutDependents, rightsOf, can };
  root.AquatechRoles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
