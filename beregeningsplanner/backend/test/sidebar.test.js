// Tests voor de indeling van de zijbalk: de groepen in dashboard/modules.js
// (NAV_GROUPS, navGroup, navSections) en de bewaking dat er niets zoekraakt.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

const MODULES = require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const tools = globalThis.AquatechModuleTools;

/**
 * Id's van een lijst modules.
 * @param {object[]} list De modules.
 * @returns {string[]} De id's.
 */
const idsOf = (list) => list.map((module) => module.id);

/**
 * De zijbalkgroepen voor een gebruiker, zoals sidebar.js ze krijgt (met de losse link Overzicht vooraan).
 * @param {object} user De gebruiker (rol, platformAdmin).
 * @param {object} [disabled] Uitgezette modules (api/config).
 * @returns {object[]} De groepen uit navSections.
 */
const sectionsFor = (user, disabled) => {
  const items = [{ id: '', navGroup: 'top', title: 'Overzicht', icon: 'home', status: 'actief', href: './' }]
    .concat(tools.visible(Roles.rightsOf(user), disabled).filter((module) => module.status === 'actief' && module.href));
  return tools.navSections(items);
};

test('elke actieve module heeft een bekende navGroup en een titel', () => {
  const known = new Set(tools.NAV_GROUPS.map((group) => group.key));
  assert.strictEqual(known.size, tools.NAV_GROUPS.length, 'dubbele groepsleutel');
  for (const module of MODULES.filter((entry) => entry.status === 'actief')) {
    assert.ok(known.has(module.navGroup), `${module.id}: onbekende navGroup ${module.navGroup}`);
    assert.ok(module.title && module.icon, module.id);
  }
  for (const group of tools.NAV_GROUPS) assert.ok(tools.ICONS[group.icon], `icoon ${group.icon} ontbreekt`);
});

test('beheerder: de groepen staan in de afgesproken volgorde en niets gaat verloren', () => {
  const sections = sectionsFor({ role: 'beheerder' });
  const keys = sections.map((section) => section.key);
  assert.deepStrictEqual(keys, ['top', 'verkoop', 'artikelen', 'inkoop', 'planner', 'beheer']);
  const shown = sections.flatMap((section) => idsOf(section.items)).filter(Boolean);
  const expected = idsOf(tools.visible(Roles.rightsOf({ role: 'beheerder' })).filter((module) => module.status === 'actief'));
  assert.deepStrictEqual([...shown].sort(), [...expected].sort());
  assert.deepStrictEqual(idsOf(sections.find((section) => section.key === 'verkoop').items), ['offertes', 'webshop-bestellingen', 'klanten', 'klantdossier', 'facturen']);
  assert.deepStrictEqual(idsOf(sections.find((section) => section.key === 'planner').items), ['beregening', 'plannen', 'planning', 'werkorders', 'meldingen', 'uitbesteden']);
  assert.strictEqual(sections[0].items[0].id, '', 'Overzicht staat bovenaan');
});

test('Inkoop: tabbladen van Artikelen met een #-adres, volgen de module Artikelen', () => {
  const sections = sectionsFor({ role: 'beheerder' });
  const purchasing = sections.find((section) => section.key === 'inkoop').items;
  assert.deepStrictEqual(idsOf(purchasing), ['bestelvoorstel', 'inkooporders', 'prijsfactor', 'leveranciers', 'mutaties']);
  const tabs = ['reorder', 'orders', 'pricefactor', 'suppliers', 'moves'];
  purchasing.forEach((module, index) => assert.strictEqual(module.href, `artikelen/#${tabs[index]}`));
  const html = require('node:fs').readFileSync(path.join(FRONTEND_DIR, 'artikelen', 'index.html'), 'utf8');
  for (const tab of tabs) assert.match(html, new RegExp(`data-tab="${tab}"`), `tabblad ${tab} ontbreekt in Artikelen`);
  // Artikelen uit = de inkoopregels ook weg, en ze staan niet apart in Beheer > Modules (partOf).
  const off = sectionsFor({ role: 'beheerder' }, { voorraad: false });
  assert.ok(!off.some((section) => section.key === 'inkoop' || section.key === 'artikelen'));
  assert.ok(purchasing.every((module) => MODULES.find((entry) => entry.id === module.id).partOf === 'voorraad'));
});

test('hoofdbeheerder: Hoofdbeheer staat in de voetregel', () => {
  const sections = sectionsFor({ role: 'beheerder', platformAdmin: true });
  const footer = sections.find((section) => section.key === 'footer');
  assert.deepStrictEqual(idsOf(footer.items), ['hoofdbeheer']);
  assert.strictEqual(sections[sections.length - 1].key, 'footer');
  assert.ok(!sectionsFor({ role: 'beheerder' }).some((section) => section.key === 'footer'));
});

test('uitgezette modules verdwijnen en lege groepen bestaan niet', () => {
  const sections = sectionsFor({ role: 'beheerder' }, { werkorders: false, meldingen: false, planning: false, uitbesteden: false, beregening: false, plannen: false });
  assert.ok(!sections.some((section) => section.key === 'planner'));
  for (const section of sections) assert.ok(section.items.length > 0, section.key);
});

test('geplande modules en onbekende groepen: niets in een lege groep, losse link voor beheer', () => {
  const planned = { id: 'backorders', navGroup: 'verkoop', title: 'Backorders', icon: 'user', status: 'gepland' };
  const active = MODULES.filter((module) => module.status === 'actief');
  // sidebar.js filtert op status; een geplande module komt dus niet in de groepen.
  const sections = tools.navSections([planned, ...active].filter((module) => module.status === 'actief'));
  assert.ok(!sections.flatMap((section) => idsOf(section.items)).includes('backorders'));
  // Een module met een onbekende groep verdwijnt niet maar staat los vóór Beheer.
  const stray = { id: 'nieuw', navGroup: 'bestaat-niet', title: 'Nieuw', icon: 'box', status: 'actief', href: 'nieuw/' };
  const keys = tools.navSections([...active, stray]).map((section) => section.key);
  assert.strictEqual(keys[keys.indexOf('beheer') - 1], 'overig');
  // Toekomstige plekken: een nieuwe module in magazijn/inkoop komt in de eigen groep, op de vaste plek.
  const future = [
    { id: 'tepicken', navGroup: 'magazijn', title: 'Te picken', icon: 'box', status: 'actief', href: 'tepicken/' },
    { id: 'retouren', navGroup: 'inkoop', title: 'Retouren', icon: 'truck', status: 'actief', href: 'retouren/' },
  ];
  const order = tools.navSections([...active, ...future]).map((section) => section.key);
  assert.ok(order.indexOf('verkoop') < order.indexOf('magazijn') && order.indexOf('magazijn') < order.indexOf('artikelen') && order.indexOf('artikelen') < order.indexOf('inkoop'));
});

test('navTitle verkort alleen de titel in de zijbalk', () => {
  const orders = MODULES.find((module) => module.id === 'webshop-bestellingen');
  assert.strictEqual(orders.navTitle, 'Bestellingen');
  assert.strictEqual(orders.title, 'Webshopbestellingen');
});
