// Rollen en rechten, gedeeld door de server (require) en de browser
// (window.AquatechRoles). De server beslist; de frontend gebruikt dit alleen
// om te tonen wat iemand mag (tegels, knoppen, keuzelijsten).
//
// - beheerder:    alles binnen de eigen organisatie (tenant): gebruikers,
//                 instellingen, historie, alle plannen, offertes en werkorders,
//                 en opdrachten uitbesteden aan of aannemen van een andere
//                 organisatie (als dat in de instellingen aan staat).
// - installateur: plannen maken en bewerken, offertes opstellen en
//                 werkorders uitvoeren voor de hele organisatie; geen
//                 gebruikers, instellingen of historie.
// - klant:        alleen de eigen plannen, en de offertes die voor hem zijn
//                 klaargezet inzien en accepteren of afwijzen; in het
//                 klantportaal ook de werkorders uit zijn offertes (afspraak,
//                 voortgang, opleverdossier).
// Een hoofdbeheerder (users.platform_admin) mag alles, in elke tenant.
(function (root) {
  const ROLES = {
    beheerder: {
      label: 'Beheerder',
      description: 'Alles binnen de organisatie: gebruikers, instellingen, historie, alle plannen, offertes en werkorders, en opdrachten uitbesteden.',
      rights: ['plannen', 'plannen.alle', 'offertes', 'offertes.alle', 'werkorders', 'uitbesteden', 'beheer'],
    },
    installateur: {
      label: 'Installateur',
      description: 'Plannen maken en bewerken, offertes opstellen en werkorders uitvoeren; geen gebruikers of instellingen.',
      rights: ['plannen', 'plannen.alle', 'offertes', 'offertes.alle', 'werkorders'],
    },
    klant: {
      label: 'Klant',
      description: 'Alleen de eigen plannen en de eigen offertes inzien en accepteren; klantportaal met afspraken en opleverdossier.',
      rights: ['plannen', 'offertes.klant', 'portaal'],
    },
  };
  // Alle rechten; een hoofdbeheerder heeft ze allemaal plus 'hoofdbeheer'.
  const RIGHTS = ['plannen', 'plannen.alle', 'offertes', 'offertes.alle', 'offertes.klant', 'portaal', 'werkorders', 'uitbesteden', 'beheer', 'hoofdbeheer'];
  // Oude rolnaam (tot 0.22.0): een 'gebruiker' is nu een installateur.
  const ALIASES = { gebruiker: 'installateur' };

  const normalize = (role) => ALIASES[role] || role;
  const isRole = (role) => Object.prototype.hasOwnProperty.call(ROLES, role);
  const label = (role) => (isRole(role) ? ROLES[role].label : String(role || ''));

  /** Rechten van een gebruiker (database-rij of publicUser-vorm). */
  function rightsOf(user) {
    if (!user) return [];
    if (user.platform_admin || user.platformAdmin) return RIGHTS.slice();
    const r = ROLES[normalize(user.role)];
    return r ? r.rights.slice() : [];
  }

  const can = (user, right) => rightsOf(user).includes(right);

  const api = { ROLES, RIGHTS, ALIASES, normalize, isRole, label, rightsOf, can };
  root.AquatechRoles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
