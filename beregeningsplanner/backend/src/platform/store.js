// Gegevenslaag bovenop db.js: gebruikers, plannen en de aanvraaghistorie.
// Elke functie krijgt de tenant mee; niets leest buiten de eigen tenant.
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { AsyncLocalStorage } = require('async_hooks');
const { transaction, listTables, tableColumns, foreignKeys, deferForeignKeys, jsonWithout, jsonDigest } = require('../database/db');

// Geheugen per HTTP-verzoek (server.js: withRequestCache): dezelfde tenant
// wordt binnen één verzoek vaak meerdere keren opgevraagd (identiteit,
// omgeving, organisatiecode); met PostgreSQL is elke query een rondgang naar
// de database. Buiten een verzoek (scripts, tests) wordt niets onthouden, en
// elke wijziging van een tenant via de store wist het geheugen.
const requestCache = new AsyncLocalStorage();
/**
 * Voert een functie uit met een eigen geheugen voor dit HTTP-verzoek (zie requestCache).
 * @param {Function} callback De afhandeling van het verzoek.
 * @returns {*} Wat de functie teruggeeft.
 */
const withRequestCache = (callback) => requestCache.run(new Map(), callback);

// Kolommen van users en tenants voor de sessiecontrole (één query per
// verzoek: sessie + gebruiker + tenant).
const USER_COLUMNS = ['id', 'tenant_id', 'username', 'display_name', 'role', 'kind', 'password_hash', 'disabled', 'created_at',
  'last_seen_at', 'platform_admin', 'must_change_password', 'email', 'phone', 'preferences'];
const TENANT_COLUMNS = ['id', 'slug', 'name', 'created_at', 'environment', 'parent_id', 'disabled', 'updated_at'];
// Nergens SELECT *: een nieuwe (grote) kolom komt zo nooit ongemerkt mee.
const USER_COLS = USER_COLUMNS.join(', ');
const TENANT_COLS = TENANT_COLUMNS.join(', ');

const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const { createRoleStore } = require('./roles');
const ROLES = Object.keys(Roles.ROLES);
// Opeenvolgende wijzigingen van één gebruiker aan één plan binnen dit venster
// vormen één regel in de historie (anders levert automatisch opslaan honderden
// regels per plan op).
const HISTORY_MERGE_MS = 30 * 60 * 1000;

/**
 * Huidig tijdstip als ISO-tekst.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Nieuw willekeurig id (UUID).
 * @returns {string} Het id.
 */
const newId = () => crypto.randomUUID();

// ---------- Wachtwoorden (scrypt, ingebouwd in Node) ----------
// Parameters volgens de OWASP-aanbeveling voor scrypt (N=2^17, r=8, p=1:
// 128 MiB geheugen per berekening). Asynchroon, zodat de server tijdens het
// rekenen andere verzoeken blijft beantwoorden. Oudere, lichtere hashes worden
// bij de eerstvolgende geslaagde inlog vervangen (needsRehash).
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * scrypt als Promise.
 * @param {string} password Het wachtwoord.
 * @param {Buffer} salt Het zout.
 * @param {number} keylen Lengte van de sleutel in bytes.
 * @param {{ N: number, r: number, p: number }} params Kosten (N), blokgrootte (r) en parallellisatie (p); de namen N/r/p zijn die van scrypt zelf.
 * @returns {Promise<Buffer>} De afgeleide sleutel.
 */
function scrypt(password, salt, keylen, { N: cost, r: blockSize, p: parallelization }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N: cost, r: blockSize, p: parallelization, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Maakt een hash van een wachtwoord met scrypt (OWASP-parameters) en een willekeurig zout.
 * @param {string} password Het wachtwoord.
 * @returns {Promise<string>} 'scrypt$N$r$p$zout$hash'.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/**
 * Controleert een wachtwoord tegen een opgeslagen hash (in constante tijd).
 * @param {string} password Het ingevoerde wachtwoord.
 * @param {string} stored De opgeslagen hash.
 * @returns {Promise<boolean>} true als het wachtwoord klopt.
 */
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, cost, blockSize, parallelization, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: +cost, r: +blockSize, p: +parallelization });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Of een hash met oudere, lichtere parameters is gemaakt (dan bij de volgende inlog vervangen).
 * @param {string} stored De opgeslagen hash.
 * @returns {boolean} true als de hash opnieuw moet.
 */
function needsRehash(stored) {
  const [, cost, blockSize, parallelization] = String(stored || '').split('$');
  return +cost !== SCRYPT.N || +blockSize !== SCRYPT.r || +parallelization !== SCRYPT.p;
}

// Veelgebruikte (delen van) wachtwoorden; vergeleken zonder cijfers en tekens,
// dus 'Wachtwoord2024!' valt er ook onder.
const COMMON = new Set(`
  wachtwoord password paswoord passwoord welkom welkomwelkom geheim geheimpje qwerty qwertyuiop azerty asdfgh
  asdfghjkl zxcvbn abcdef abcdefgh abc letmein admin administrator beheerder gebruiker iloveyou monkey dragon
  football voetbal ajax feyenoord psv sunshine princess zomer winter lente herfst voorjaar najaar maandag
  aquatech aquatechservice beregening beregeningsplanner tuin tuinman sproeier water nunspeet nederland holland
  amsterdam rotterdam utrecht test testtest changeme default master login secret trustno
`.split(/\s+/).filter(Boolean));

/**
 * Wachtwoordbeleid (OWASP ASVS): lengte boven complexiteitsregels; geen
 * gebruikersnaam en geen veelgebruikte of herhalende wachtwoorden.
 * @param {string} password Het wachtwoord.
 * @param {string} [username] De gebruikersnaam.
 * @returns {string|null} De foutmelding, of null als het wachtwoord voldoet.
 */
function passwordProblem(password, username = '') {
  const text = String(password || '');
  if (text.length < 12) return 'Wachtwoord: minimaal 12 tekens.';
  if (text.length > 128) return 'Wachtwoord: maximaal 128 tekens.';
  const lower = text.toLowerCase();
  const user = String(username || '').toLowerCase();
  if (user.length >= 3 && lower.includes(user)) return 'Het wachtwoord mag je gebruikersnaam niet bevatten.';
  const core = lower.replace(/[^a-zà-ÿ]/g, '');
  if (COMMON.has(core) || COMMON.has(lower) || new Set(lower).size < 5 || /^(.{1,4})\1+$/.test(lower)) {
    return 'Dit wachtwoord is te voorspelbaar. Kies bijvoorbeeld een zin van een paar woorden.';
  }
  return null;
}

let dummyHash;
/**
 * Een hash van een willekeurig wachtwoord, zodat inloggen met een onbekende naam even lang duurt (eenmalig berekend).
 * @returns {Promise<string>} De hash.
 */
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

// ---------- Samenvatting van een plan (voor de historie) ----------
/**
 * Oppervlakte van een veelhoek (schoenveterformule).
 * @param {{ x: number, y: number }[]} points De hoekpunten.
 * @returns {number} De oppervlakte (0 bij minder dan 3 punten).
 */
function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let doubleArea = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i], next = points[(i + 1) % points.length];
    doubleArea += (Number(current?.x) || 0) * (Number(next?.y) || 0) - (Number(next?.x) || 0) * (Number(current?.y) || 0);
  }
  return Math.abs(doubleArea) / 2;
}

const REVIEW_STATUSES = ['concept', 'ter_controle', 'goedgekeurd'];

/**
 * Samenvatting van een plan voor de historie en overzichten: aantal vlakken,
 * m² per type en in totaal, en aantallen sproeiers, zones en elementen.
 * @param {object} data Het plan (of een jsonDigest met al getelde aantallen).
 * @returns {{ areas: number, totalM2: number, m2ByType: object, sprinklers: number, zones: number, elements: number }} De samenvatting.
 */
function summarize(data) {
  const areas = Array.isArray(data?.areas) ? data.areas : [];
  const m2ByType = {};
  for (const area of areas) {
    const type = String(area?.type || 'onbekend');
    m2ByType[type] = (m2ByType[type] || 0) + polygonArea(area?.pts);
  }
  /**
   * Rondt af op één decimaal.
   * @param {number} value Het getal.
   * @returns {number} Het afgeronde getal.
   */
  const round = (value) => Math.round(value * 10) / 10;
  for (const type of Object.keys(m2ByType)) m2ByType[type] = round(m2ByType[type]);
  /**
   * Aantal elementen van een lijst in het plan (of een al getelde waarde).
   * @param {string} field Naam van de lijst.
   * @returns {number} Het aantal.
   */
  const count = (field) => (Array.isArray(data?.[field]) ? data[field].length : Number.isFinite(data?.[field]) ? data[field] : 0);
  return {
    areas: areas.length,
    totalM2: round(Object.values(m2ByType).reduce((sum, value) => sum + value, 0)),
    m2ByType,
    sprinklers: count('sprinklers'),
    zones: count('zones'),
    elements: count('elements'),
  };
}

/**
 * Titel, klant en adres van een plan (uit data.meta).
 * @param {object} data Het plan.
 * @returns {{ title: string, customer: string, address: string }} De gegevens.
 */
function metaOf(data) {
  const meta = (data && typeof data.meta === 'object' && data.meta) || {};
  /**
   * Nette tekst van een waarde, ingekort.
   * @param {*} value De waarde.
   * @param {number} maxLength Maximaal aantal tekens.
   * @returns {string} De tekst.
   */
  const cleanText = (value, maxLength) => String(value == null ? '' : value).trim().slice(0, maxLength);
  return {
    title: cleanText(meta.name, 200) || 'Naamloos plan',
    customer: cleanText(meta.customer, 200),
    address: cleanText(meta.address, 300),
  };
}

/**
 * Het plan zonder achtergrond (foto/PDF van de tekening kan megabytes groot
 * zijn; die hoort bij het plan, maar niet in elke historieregel).
 * @param {object} data Het plan.
 * @returns {object} Het plan zonder het veld background.
 */
function withoutBackground(data) {
  const { background, ...rest } = data || {};
  return rest;
}

// ---------- Mijn profiel ----------
// Persoonlijke voorkeuren staan als JSON in users.preferences; alleen deze
// sleutels (met hun standaardwaarde) worden bewaard.
// newsSeenAt/seenRelease: vorige bezoek aan Nieuws (zie news.js), niet in het profielformulier.
// seasonReminders: klant wil seizoensherinneringen per mail (season-reminders.js, uit te zetten in het portaal).
const PREFERENCES = { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '', seasonReminders: true };
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const PHONE = /^\+?[0-9 ()./-]{6,25}$/;

/**
 * Schoont voorkeuren op: alleen de sleutels uit PREFERENCES, met hun eigen controle.
 * @param {object} input De nieuwe voorkeuren.
 * @param {object} [base] De huidige voorkeuren (ontbrekende sleutels blijven zo).
 * @returns {object} De complete voorkeuren.
 */
function cleanPreferences(input, base = PREFERENCES) {
  const requested = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...PREFERENCES, ...base };
  if (requested.startPage !== undefined) out.startPage = /^[a-z0-9-]{0,40}$/.test(String(requested.startPage)) ? String(requested.startPage) : '';
  if (requested.mailCopy !== undefined) out.mailCopy = requested.mailCopy === true;
  if (requested.seasonReminders !== undefined) out.seasonReminders = requested.seasonReminders !== false;
  if (requested.newsSeenAt !== undefined) out.newsSeenAt = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(requested.newsSeenAt)) ? String(requested.newsSeenAt) : '';
  if (requested.seenRelease !== undefined) out.seenRelease = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(requested.seenRelease)) ? String(requested.seenRelease) : '';
  return out;
}

/**
 * De voorkeuren van een gebruiker, altijd compleet.
 * @param {object} user Rij uit users.
 * @returns {object} De voorkeuren.
 */
function preferencesOf(user) {
  let raw = {};
  try { raw = JSON.parse(user?.preferences || '{}'); } catch (error) { /* kapot: standaard */ }
  return cleanPreferences(raw);
}

/**
 * Maakt de gegevenslaag: tenants, gebruikers, sessies, auditlog, historie en plannen.
 * @param {object} db Databaseverbinding.
 * @returns {object} Alle opslagfuncties (zie het return-object onderaan).
 */
function createStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);
  // Rollen per organisatie (Beheer > Rollen).
  const roles = createRoleStore(db);

  /**
   * De tenant met deze slug; maakt hem aan als hij niet bestaat (standaard de hoofdtenant).
   * @param {string} [slug] De slug.
   * @param {string} [name] Naam bij het aanmaken.
   * @returns {object} De tenant.
   */
  function ensureTenant(slug = 'default', name = 'Aquatech') {
    const row = prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE slug = ?`).get(slug);
    if (row) return row;
    const tenant = { id: newId(), slug, name, created_at: currentTimestamp() };
    prepare('INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(tenant.id, tenant.slug, tenant.name, tenant.created_at);
    forgetTenants();
    return tenant;
  }

  // ---------- Gebruikers ----------
  // Wat publicUser nodig heeft (zonder wachtwoord-hash en voorkeuren).
  const PUBLIC_USER_COLUMNS = ['id', 'tenant_id', 'username', 'display_name', 'role', 'kind', 'disabled', 'platform_admin',
    'must_change_password', 'created_at', 'last_seen_at', 'email', 'phone'].map((column) => `u.${column}`).join(', ');

  /**
   * Een gebruiker zoals de API hem toont (zonder wachtwoord-hash en voorkeuren).
   * @param {object|null} user Rij uit users.
   * @returns {object|null} De gebruiker, of null.
   */
  function publicUser(user) {
    if (!user) return null;
    return { id: user.id, tenantId: user.tenant_id, username: user.username, displayName: user.display_name, role: user.role, kind: user.kind,
      roleLabel: user.platform_admin ? 'Hoofdbeheerder' : roles.label(user.tenant_id, user.role),
      disabled: Boolean(user.disabled), platformAdmin: Boolean(user.platform_admin), mustChangePassword: Boolean(user.must_change_password), createdAt: user.created_at, lastSeenAt: user.last_seen_at,
      email: user.email || '', phone: user.phone || '' };
  }

  /**
   * De gebruiker wijzigt zijn eigen naam, contactgegevens en voorkeuren. Alleen meegegeven velden veranderen.
   * @param {string} id Id van de gebruiker.
   * @param {object} [input] displayName, email, phone en/of preferences.
   * @returns {{ user: object, changed: string[] }|{ error: string, field: string|null }} De bijgewerkte gebruiker en de gewijzigde velden, of een foutmelding.
   */
  function updateProfile(id, input = {}) {
    const user = getUser(id);
    if (!user || user.kind !== 'account' || user.disabled) return { error: 'Alleen een eigen account heeft een profiel.', field: null };
    const next = { display_name: user.display_name, email: user.email || '', phone: user.phone || '' };
    if (input.displayName !== undefined) {
      const name = String(input.displayName ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return { error: 'Vul je naam in.', field: 'displayName' };
      if (name.length > 80) return { error: 'Je naam mag maximaal 80 tekens hebben.', field: 'displayName' };
      next.display_name = name;
    }
    if (input.email !== undefined) {
      const email = String(input.email ?? '').trim().toLowerCase();
      if (email && (email.length > 200 || !EMAIL.test(email))) return { error: 'Vul een geldig e-mailadres in.', field: 'email' };
      next.email = email;
    }
    if (input.phone !== undefined) {
      const phone = String(input.phone ?? '').replace(/\s+/g, ' ').trim();
      if (phone && !PHONE.test(phone)) return { error: 'Vul een geldig telefoonnummer in (cijfers, spaties, +, - en haakjes).', field: 'phone' };
      next.phone = phone;
    }
    const prefs = input.preferences !== undefined ? cleanPreferences(input.preferences, preferencesOf(user)) : preferencesOf(user);
    // Alleen wat echt anders is (zonder wijziging ook geen schrijfactie of auditregel).
    const changed = [
      next.display_name !== user.display_name && 'displayName',
      next.email !== (user.email || '') && 'email',
      next.phone !== (user.phone || '') && 'phone',
      JSON.stringify(prefs) !== JSON.stringify(preferencesOf(user)) && 'preferences',
    ].filter(Boolean);
    if (!changed.length) return { user, changed };
    prepare('UPDATE users SET display_name = ?, email = ?, phone = ?, preferences = ? WHERE id = ?')
      .run(next.display_name, next.email, next.phone, JSON.stringify(prefs), user.id);
    return { user: getUser(user.id), changed };
  }

  /**
   * Haalt een gebruiker op.
   * @param {string} id Id van de gebruiker.
   * @returns {object|null} Rij uit users, of null.
   */
  function getUser(id) {
    return prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(String(id)) || null;
  }

  /**
   * Voegt een gebruiker toe.
   * @param {string} tenantId De tenant.
   * @param {object} fields username, displayName, role, kind, passwordHash, platformAdmin en mustChangePassword.
   * @returns {object} De nieuwe rij.
   */
  function insertUser(tenantId, { username, displayName, role, kind, passwordHash = null, platformAdmin = false, mustChangePassword = false }) {
    const user = { id: newId(), tenant_id: tenantId, username, display_name: displayName, role, kind, password_hash: passwordHash, disabled: 0,
      platform_admin: platformAdmin ? 1 : 0, must_change_password: mustChangePassword ? 1 : 0, created_at: currentTimestamp(), last_seen_at: null };
    prepare(`INSERT INTO users (id, tenant_id, username, display_name, role, kind, password_hash, disabled, platform_admin, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(user.id, tenantId, username, displayName, role, kind, passwordHash, user.platform_admin, user.must_change_password, user.created_at);
    return user;
  }

  // Vaste beheerder: inloggen met de (optionele) toegangscode.
  // Eigenaar van plannen, offertes en werkorders van verwijderde gebruikers; de
  // tilde kan niet in een gebruikersnaam van een account voorkomen.
  const DELETED_USER = 'verwijderd~';

  /**
   * Vaste systeemgebruiker van een tenant (bijv. de beheerder van de toegangscode of 'Verwijderde gebruiker'); wordt zo nodig aangemaakt.
   * @param {string} tenantId De tenant.
   * @param {string} username Vaste gebruikersnaam.
   * @param {string} displayName Weergavenaam.
   * @returns {object} De gebruiker.
   */
  function systemUser(tenantId, username, displayName) {
    return prepare(`SELECT ${USER_COLS} FROM users WHERE tenant_id = ? AND username = ?`).get(tenantId, username)
      || insertUser(tenantId, { username, displayName, role: 'beheerder', kind: 'systeem' });
  }

  /**
   * Maakt een anonieme gast (rol klant) aan.
   * @param {string} tenantId De tenant.
   * @returns {object} De gastgebruiker.
   */
  function createGuest(tenantId) {
    const tag = crypto.randomBytes(4).toString('hex');
    return insertUser(tenantId, { username: `gast-${tag}`, displayName: `Gast ${tag}`, role: 'klant', kind: 'gast' });
  }

  /**
   * Zet oude rolnamen (zoals 'gebruiker') om naar de huidige.
   * @param {object} input Invoer met eventueel role.
   * @returns {object} De invoer met de huidige rolnaam.
   */
  const withRole = (input) => (input.role === undefined ? input : { ...input, role: Roles.normalize(input.role) });

  /**
   * Controleert de gegevens van een account.
   * @param {string} tenantId De tenant (voor de rollen).
   * @param {object} account username, displayName, role en password.
   * @param {{ partial?: boolean }} [options] partial = alleen de meegegeven velden controleren.
   * @returns {string|null} De foutmelding, of null.
   */
  function validateAccount(tenantId, { username, displayName, role, password }, { partial = false } = {}) {
    if (!partial || username !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(String(username || ''))) return 'Gebruikersnaam: 3–40 tekens, kleine letters, cijfers, punt, streepje of underscore.';
      if (/^(gast-|ha-|beheerder$)/.test(username)) return 'Deze gebruikersnaam is gereserveerd.';
    }
    if (displayName !== undefined && String(displayName).trim().length > 80) return 'Naam is te lang.';
    if ((!partial || role !== undefined) && !roles.exists(tenantId, role)) return 'Ongeldige rol.';
    if (!partial || password !== undefined) return passwordProblem(password, username);
    return null;
  }

  /**
   * Maakt een account aan. Gebruikersnamen zijn uniek binnen de organisatie (live
   * + testomgevingen); bij het inloggen bepaalt de organisatiecode de tenant.
   * @param {string} tenantId De tenant.
   * @param {object} rawInput username, displayName, role en password.
   * @param {{ platformAdmin?: boolean, mustChangePassword?: boolean }} [options] Hoofdbeheerder, en of de gebruiker bij de eerste aanmelding zelf een wachtwoord moet kiezen.
   * @returns {Promise<{ user: object }|{ error: string }>} Het account of een foutmelding.
   */
  async function createAccount(tenantId, rawInput, { platformAdmin = false, mustChangePassword = false } = {}) {
    const input = withRole(rawInput);
    const problem = validateAccount(tenantId, input);
    if (problem) return { error: problem };
    if (usernameTaken(tenantId, input.username)) {
      return { error: 'Deze gebruikersnaam bestaat al.' };
    }
    const passwordHash = await hashPassword(input.password);
    if (usernameTaken(tenantId, input.username)) return { error: 'Deze gebruikersnaam bestaat al.' };
    const user = insertUser(tenantId, {
      username: input.username,
      displayName: String(input.displayName || '').trim() || input.username,
      role: input.role,
      kind: 'account',
      passwordHash,
      platformAdmin,
      mustChangePassword,
    });
    return { user: user };
  }

  /**
   * Wijzigt een account. De laatste actieve beheerder en hoofdbeheerder blijven
   * dat; een nieuw wachtwoord of uitschakelen logt overal uit.
   * @param {string} tenantId De tenant.
   * @param {string} id Id van de gebruiker.
   * @param {object} rawInput displayName, role, disabled, platformAdmin, mustChangePassword en/of password.
   * @returns {Promise<{ user: object }|{ error: string, status?: number }>} De gebruiker of een foutmelding.
   */
  async function updateAccount(tenantId, id, rawInput) {
    const input = withRole(rawInput);
    const user = prepare('SELECT id, username, role, kind, disabled, platform_admin FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!user) return { error: 'Gebruiker niet gevonden.', status: 404 };
    if (user.kind !== 'account') return { error: 'Systeem- en gastgebruikers zijn niet aan te passen.', status: 409 };
    const problem = validateAccount(tenantId, { ...input, username: input.username ?? (input.password !== undefined ? user.username : undefined) }, { partial: true });
    if (problem) return { error: problem };
    if (input.username !== undefined) return { error: 'De gebruikersnaam is niet te wijzigen.' };
    // De laatste actieve beheerder blijft beheerder: anders verschijnt het
    // instelscherm voor een eerste beheerder weer voor iedereen.
    const losesAdmin = user.role === 'beheerder' && !user.disabled && ((input.role !== undefined && input.role !== 'beheerder') || input.disabled);
    if (losesAdmin && countAdmins(tenantId) <= 1) {
      return { error: 'Dit is de enige actieve beheerder. Maak eerst een andere beheerder aan.', status: 409 };
    }
    // De laatste actieve hoofdbeheerder blijft dat ook: anders kan niemand
    // meer bij het hoofdbeheer.
    const losesPlatform = user.platform_admin && !user.disabled && (losesAdmin || input.disabled || input.platformAdmin === false);
    if (losesPlatform && countPlatformAdmins() <= 1) {
      return { error: 'Dit is de enige actieve hoofdbeheerder. Maak eerst een andere hoofdbeheerder aan.', status: 409 };
    }
    if (input.displayName !== undefined) prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(input.displayName).trim() || user.username, user.id);
    if (input.role !== undefined) prepare('UPDATE users SET role = ? WHERE id = ?').run(input.role, user.id);
    if (input.disabled !== undefined) prepare('UPDATE users SET disabled = ? WHERE id = ?').run(input.disabled ? 1 : 0, user.id);
    // Hoofdbeheerder worden of af: een hoofdbeheerder is altijd beheerder.
    if (input.platformAdmin !== undefined) {
      prepare('UPDATE users SET platform_admin = ? WHERE id = ?').run(input.platformAdmin ? 1 : 0, user.id);
      if (input.platformAdmin) prepare("UPDATE users SET role = 'beheerder' WHERE id = ?").run(user.id);
    }
    if (input.mustChangePassword !== undefined) prepare('UPDATE users SET must_change_password = ? WHERE id = ?').run(input.mustChangePassword ? 1 : 0, user.id);
    const newHash = input.password !== undefined ? await hashPassword(input.password) : null;
    if (newHash) prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    // Nieuw wachtwoord of uitgeschakeld: op alle toestellen uitgelogd.
    if (newHash || input.disabled) revokeSessions(tenantId, user.id);
    return { user: getUser(user.id) };
  }

  /**
   * Verwijdert een gebruiker definitief (AVG). Het account, de sessies en de
   * supporttoestemmingen verdwijnen; plannen, offertes en werkorders blijven
   * (bedrijfsadministratie) en gaan naar de systeemgebruiker "Verwijderde
   * gebruiker" van de tenant waarin ze staan. Verwijzingen in historie en
   * auditlog worden leeg (de regels zelf blijven). Niet voor de laatste actieve
   * beheerder van de tenant of de laatste actieve hoofdbeheerder.
   * @param {string} tenantId De tenant.
   * @param {string} id Id van de gebruiker.
   * @returns {{ user: object, moved: object }|{ error: string, status: number }} De verwijderde gebruiker en het aantal overgezette items per tabel, of een foutmelding.
   */
  function deleteAccount(tenantId, id) {
    const user = prepare('SELECT id, tenant_id, username, role, kind, disabled, platform_admin FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!user) return { error: 'Gebruiker niet gevonden.', status: 404 };
    if (user.kind === 'systeem') return { error: 'Systeemgebruikers zijn niet te verwijderen.', status: 409 };
    if (user.kind === 'account' && user.role === 'beheerder' && !user.disabled && countAdmins(tenantId) <= 1) {
      return { error: 'Dit is de enige actieve beheerder. Maak eerst een andere beheerder aan.', status: 409 };
    }
    if (user.platform_admin && !user.disabled && countPlatformAdmins() <= 1) {
      return { error: 'Dit is de enige actieve hoofdbeheerder. Maak eerst een andere hoofdbeheerder aan.', status: 409 };
    }
    return transaction(db, () => {
      const moved = {};
      for (const table of ['plans', 'quotes', 'work_orders']) {
        const tenants = prepare(`SELECT DISTINCT tenant_id FROM ${table} WHERE owner_id = ?`).all(user.id).map((row) => row.tenant_id);
        moved[table] = 0;
        for (const tenantId of tenants) {
          const heir = systemUser(tenantId, DELETED_USER, 'Verwijderde gebruiker');
          moved[table] += prepare(`UPDATE ${table} SET owner_id = ? WHERE tenant_id = ? AND owner_id = ?`).run(heir.id, tenantId, user.id).changes;
        }
      }
      prepare('UPDATE quotes SET customer_id = NULL WHERE customer_id = ?').run(user.id);
      prepare('UPDATE service_requests SET customer_id = NULL WHERE customer_id = ?').run(user.id);
      prepare('UPDATE service_requests SET handled_by = NULL WHERE handled_by = ?').run(user.id);
      prepare('UPDATE work_orders SET assignee_id = NULL WHERE assignee_id = ?').run(user.id);
      prepare('UPDATE work_order_photos SET uploaded_by = NULL WHERE uploaded_by = ?').run(user.id);
      // Geboekte uren en materiaal blijven (urenstaat, voorraad); de naam staat in user_name.
      for (const table of ['work_order_hours', 'work_order_materials']) {
        prepare(`UPDATE ${table} SET user_id = NULL WHERE user_id = ?`).run(user.id);
        prepare(`UPDATE ${table} SET created_by = NULL WHERE created_by = ?`).run(user.id);
      }
      prepare('UPDATE settings SET updated_by = NULL WHERE updated_by = ?').run(user.id);
      prepare('UPDATE history SET user_id = NULL WHERE user_id = ?').run(user.id);
      prepare('UPDATE audit SET user_id = NULL WHERE user_id = ?').run(user.id);
      prepare('UPDATE news SET author_id = NULL WHERE author_id = ?').run(user.id);
      prepare('DELETE FROM impersonations WHERE admin_id = ? OR user_id = ?').run(user.id, user.id);
      prepare('DELETE FROM support_grants WHERE user_id = ?').run(user.id);
      prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      prepare('DELETE FROM season_reminders_sent WHERE user_id = ?').run(user.id);
      prepare('DELETE FROM users WHERE id = ?').run(user.id);
      return { user: user, moved };
    });
  }

  /**
   * Aantal actieve beheerders met een eigen account (geen systeem- of gastgebruikers).
   * @param {string} tenantId De tenant.
   * @returns {number} Het aantal.
   */
  function countAdmins(tenantId) {
    return prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND kind = 'account' AND role = 'beheerder' AND disabled = 0").get(tenantId).n;
  }

  /**
   * De omgevingen van een organisatie: de live-tenant plus zijn testomgevingen.
   * Binnen die familie is een gebruikersnaam uniek, zodat inloggen met de
   * organisatiecode altijd één account vindt.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @returns {string[]} Id's van de omgevingen (live eerst).
   */
  function familyIds(tenantId) {
    const tenant = tenantId && getTenant(tenantId);
    if (!tenant) return [];
    const root = tenant.environment === 'test' && tenant.parent_id ? tenant.parent_id : tenant.id;
    return [root, ...prepare('SELECT id FROM tenants WHERE parent_id = ? ORDER BY created_at').all(root).map((row) => row.id)];
  }

  /**
   * Of een gebruikersnaam al bestaat in de organisatie.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} username De gebruikersnaam.
   * @param {{ except?: string }} [options] Een omgeving die niet meetelt.
   * @returns {boolean} true als de naam bezet is.
   */
  const usernameTaken = (tenantId, username, { except = null } = {}) => familyIds(tenantId)
    .some((id) => id !== except && prepare('SELECT 1 FROM users WHERE tenant_id = ? AND username = ?').get(id, username));

  /**
   * Aantal actieve hoofdbeheerders op het platform.
   * @returns {number} Het aantal.
   */
  function countPlatformAdmins() {
    return prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'account' AND platform_admin = 1 AND disabled = 0").get().n;
  }

  // ---------- Tenants en omgevingen ----------
  /**
   * Een tenant zoals de API hem toont.
   * @param {object|null} tenant Rij uit tenants.
   * @returns {object|null} De tenant (camelCase), of null.
   */
  function tenantRow(tenant) {
    if (!tenant) return null;
    return { id: tenant.id, slug: tenant.slug, name: tenant.name, environment: tenant.environment || 'live', parentId: tenant.parent_id || null,
      disabled: Boolean(tenant.disabled), createdAt: tenant.created_at, updatedAt: tenant.updated_at || tenant.created_at };
  }

  /**
   * Haalt een tenant op (binnen een HTTP-verzoek onthouden).
   * @param {string} id Id van de tenant.
   * @returns {object|null} Rij uit tenants, of null.
   */
  function getTenant(id) {
    const memo = requestCache.getStore();
    const key = `tenant:${id}`;
    if (memo && memo.has(key)) return memo.get(key);
    const tenant = prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE id = ?`).get(String(id)) || null;
    if (memo) memo.set(key, tenant);
    return tenant;
  }
  /**
   * Wist het geheugen van dit verzoek (na een wijziging van een tenant).
   * @returns {void}
   */
  const forgetTenants = () => requestCache.getStore()?.clear();
  /**
   * Haalt een tenant op met zijn slug (organisatiecode).
   * @param {string} slug De slug.
   * @returns {object|null} Rij uit tenants, of null.
   */
  const getTenantBySlug = (slug) => prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE slug = ?`).get(String(slug)) || null;

  /**
   * Alle live-tenants met hun testomgevingen en aantallen (gebruikers, beheerders, plannen, laatste activiteit), voor het hoofdbeheer.
   * @returns {object[]} De live-tenants, elk met environments.
   */
  function listTenants() {
    const rows = prepare(`SELECT ${TENANT_COLUMNS.map((column) => `t.${column}`).join(', ')},
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.kind = 'account') AS user_count,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.kind = 'account' AND u.role = 'beheerder' AND u.disabled = 0) AS admin_count,
        (SELECT COUNT(*) FROM plans p WHERE p.tenant_id = t.id AND p.deleted_at IS NULL) AS plan_count,
        (SELECT MAX(h.updated_at) FROM history h WHERE h.tenant_id = t.id) AS last_activity
      FROM tenants t ORDER BY lower(t.name), t.created_at`).all();
    /**
     * Tenant met de aantallen uit de query.
     * @param {object} row Rij uit de query van listTenants.
     * @returns {object} De tenant met userCount, adminCount, planCount en lastActivity.
     */
    const withStats = (row) => ({ ...tenantRow(row), userCount: row.user_count, adminCount: row.admin_count, planCount: row.plan_count, lastActivity: row.last_activity });
    const live = rows.filter((row) => (row.environment || 'live') === 'live').map((tenant) => ({ ...withStats(tenant), environments: [] }));
    const byId = new Map(live.map((tenant) => [tenant.id, tenant]));
    for (const row of rows) if (row.environment === 'test' && byId.has(row.parent_id)) byId.get(row.parent_id).environments.push(withStats(row));
    return live;
  }

  /**
   * Controleert naam en slug van een tenant.
   * @param {{ name?: string, slug?: string }} tenant De invoer.
   * @param {{ partial?: boolean }} [options] partial = alleen de meegegeven velden controleren.
   * @returns {string|null} De foutmelding, of null.
   */
  function validateTenant({ name, slug }, { partial = false } = {}) {
    if (!partial || name !== undefined) {
      const trimmed = String(name || '').trim();
      if (trimmed.length < 2 || trimmed.length > 80) return 'Naam: 2–80 tekens.';
    }
    if (!partial || slug !== undefined) {
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(String(slug || ''))) return 'Code: 2–40 tekens, kleine letters, cijfers of streepje.';
      if (getTenantBySlug(slug)) return 'Deze code is al in gebruik.';
    }
    return null;
  }

  /**
   * Maakt een nieuwe live-tenant (organisatie).
   * @param {{ name: string, slug: string }} tenant Naam en organisatiecode.
   * @returns {{ tenant: object }|{ error: string }} De tenant of een foutmelding.
   */
  function createTenant({ name, slug }) {
    const problem = validateTenant({ name, slug });
    if (problem) return { error: problem };
    const timestamp = currentTimestamp();
    const tenant = { id: newId(), slug, name: String(name).trim() };
    prepare("INSERT INTO tenants (id, slug, name, environment, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?)").run(tenant.id, tenant.slug, tenant.name, timestamp, timestamp);
    forgetTenants();
    return { tenant: getTenant(tenant.id) };
  }

  /**
   * Wijzigt naam of status van een tenant. De hoofdtenant (slug 'default') host de hoofdbeheerders en blijft altijd aan.
   * @param {string} id Id van de tenant.
   * @param {{ name?: string, disabled?: boolean }} changes De wijzigingen.
   * @returns {{ tenant: object }|{ error: string, status?: number }} De tenant of een foutmelding.
   */
  function updateTenant(id, { name, disabled }) {
    const tenant = getTenant(id);
    if (!tenant) return { error: 'Tenant niet gevonden.', status: 404 };
    const problem = validateTenant({ name }, { partial: true });
    if (problem) return { error: problem };
    if (disabled && tenant.slug === 'default') return { error: 'De hoofdtenant kan niet worden uitgeschakeld.', status: 409 };
    if (name !== undefined) prepare('UPDATE tenants SET name = ? WHERE id = ?').run(String(name).trim(), tenant.id);
    if (disabled !== undefined) prepare('UPDATE tenants SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, tenant.id);
    prepare('UPDATE tenants SET updated_at = ? WHERE id = ?').run(currentTimestamp(), tenant.id);
    forgetTenants();
    return { tenant: getTenant(tenant.id) };
  }

  /**
   * Maakt een slug van een naam (kleine letters, zonder accenten, streepjes).
   * @param {string} text De naam.
   * @returns {string} De slug (hoogstens 20 tekens).
   */
  const slugify = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

  /**
   * Nieuwe testomgeving bij een live-tenant. De instellingen (API-sleutel,
   * limieten, modules) worden gekopieerd; met copyPlans ook de huidige plannen
   * (nieuwe id's, zelfde eigenaar), zodat je met echte data kunt testen zonder
   * live te raken.
   * @param {string} parentId Id van de live-tenant.
   * @param {{ name?: string, copyPlans?: boolean, skipSettings?: string[] }} [options] Naam, plannen kopiëren, en instellingen die de server zelf (opnieuw versleuteld) kopieert.
   * @returns {{ tenant: object, copied: number }|{ error: string, status?: number }} De omgeving en het aantal gekopieerde plannen, of een foutmelding.
   */
  function createEnvironment(parentId, { name, copyPlans = false, skipSettings = [] } = {}) {
    const parent = getTenant(parentId);
    if (!parent || parent.environment !== 'live') return { error: 'Live-tenant niet gevonden.', status: 404 };
    const label = String(name || '').trim() || 'Test';
    if (label.length > 60) return { error: 'Naam: maximaal 60 tekens.' };
    const base = `${parent.slug}-${slugify(label) || 'test'}`.slice(0, 36);
    let slug = base;
    for (let i = 2; getTenantBySlug(slug); i++) slug = `${base}-${i}`;
    return transaction(db, () => {
      const timestamp = currentTimestamp();
      const id = newId();
      prepare("INSERT INTO tenants (id, slug, name, environment, parent_id, created_at, updated_at) VALUES (?, ?, ?, 'test', ?, ?, ?)")
        .run(id, slug, label, parent.id, timestamp, timestamp);
      forgetTenants();
      // Versleutelde geheimen horen bij de tenant (zie settings.js); die
      // kopieert de server opnieuw versleuteld (skipSettings).
      for (const row of prepare('SELECT key, value, updated_by FROM settings WHERE tenant_id = ?').all(parent.id)) {
        if (skipSettings.includes(row.key)) continue;
        prepare('INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').run(id, row.key, row.value, timestamp, row.updated_by);
      }
      let copied = 0;
      if (copyPlans) {
        for (const plan of prepare(`SELECT owner_id, title, customer, address, data, created_at, updated_at, review_status, review_question, review_requested_at,
            reviewed_by, reviewed_at, submitted_via FROM plans WHERE tenant_id = ? AND deleted_at IS NULL`).all(parent.id)) {
          prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at,
              review_status, review_question, review_requested_at, reviewed_by, reviewed_at, submitted_via)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId(), id, plan.owner_id, plan.title, plan.customer, plan.address, plan.data, plan.created_at, plan.updated_at,
            plan.review_status, plan.review_question, plan.review_requested_at, plan.reviewed_by, plan.reviewed_at, plan.submitted_via);
          copied++;
        }
      }
      return { tenant: getTenant(id), copied };
    });
  }

  /**
   * Draait een net aangemaakte tenant terug (bijv. als de eerste beheerder niet aan te maken was), alleen zolang er nog niets in staat.
   * @param {string} id Id van de tenant.
   * @returns {boolean} true als de tenant is verwijderd.
   */
  function dropEmptyTenant(id) {
    const busy = prepare('SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = ?) OR EXISTS (SELECT 1 FROM plans WHERE tenant_id = ?) OR EXISTS (SELECT 1 FROM tenants WHERE parent_id = ?) AS n').get(id, id, id).n;
    if (busy) return false;
    transaction(db, () => {
      prepare('DELETE FROM settings WHERE tenant_id = ?').run(id);
      prepare('DELETE FROM shop_products WHERE tenant_id = ?').run(id);
      prepare('DELETE FROM shop_sync WHERE tenant_id = ?').run(id);
      prepare('DELETE FROM audit WHERE tenant_id = ?').run(id);
      prepare('DELETE FROM tenants WHERE id = ?').run(id);
    });
    forgetTenants();
    return true;
  }

  /**
   * Controleert een nieuw account zonder het aan te maken.
   * @param {string} tenantId De tenant.
   * @param {object} input username, displayName, role en password.
   * @returns {string|null} De foutmelding, of null.
   */
  function accountProblem(tenantId, input) {
    return validateAccount(tenantId, input) || (usernameTaken(tenantId, input.username) ? 'Deze gebruikersnaam bestaat al.' : null);
  }

  /**
   * Haalt een testomgeving op (geen live-tenant).
   * @param {string} id Id van de omgeving.
   * @returns {{ tenant: object }|{ error: string, status: number }} De omgeving of een foutmelding.
   */
  function testEnvironment(id) {
    const tenant = getTenant(id);
    if (!tenant) return { error: 'Omgeving niet gevonden.', status: 404 };
    if (tenant.environment !== 'test') return { error: 'Alleen testomgevingen kunnen worden leeggemaakt of verwijderd.', status: 409 };
    return { tenant: tenant };
  }

  /**
   * Maakt een omgeving leeg: plannen, offertes, werkorders, voorraad, facturen,
   * debiteuren, historie, auditlog, sessies en gasten weg; instellingen blijven.
   * @param {string} tenantId De omgeving.
   * @returns {void}
   */
  function clearData(tenantId) {
    prepare('DELETE FROM history WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM audit WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM sessions WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM season_reminders_sent WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM work_order_photos WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM work_order_hours WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM work_order_materials WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM work_order_offers WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM news WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM sprinkler_library WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM ai_usage WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM plan_recognitions WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM invoices WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM debtors WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM stock_reservations WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM stock_movements WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM stock_items WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM work_orders WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM impersonations WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM support_grants WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM quotes WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM plans WHERE tenant_id = ?').run(tenantId);
    prepare(`DELETE FROM users WHERE tenant_id = ? AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.owner_id = users.id)
      AND NOT EXISTS (SELECT 1 FROM quotes o WHERE o.owner_id = users.id)`).run(tenantId);
  }

  /**
   * Maakt een testomgeving leeg (instellingen blijven).
   * @param {string} id Id van de testomgeving.
   * @returns {{ tenant: object }|{ error: string, status: number }} De omgeving of een foutmelding.
   */
  function resetEnvironment(id) {
    const out = testEnvironment(id);
    if (out.error) return out;
    transaction(db, () => clearData(out.tenant.id));
    return { tenant: out.tenant };
  }

  /**
   * Verwijdert een testomgeving met alles erin.
   * @param {string} id Id van de testomgeving.
   * @returns {{ ok: true }|{ error: string, status: number }} Klaar, of een foutmelding.
   */
  function deleteEnvironment(id) {
    const out = testEnvironment(id);
    if (out.error) return out;
    transaction(db, () => {
      clearData(out.tenant.id);
      prepare('DELETE FROM settings WHERE tenant_id = ?').run(out.tenant.id);
      prepare('DELETE FROM shop_products WHERE tenant_id = ?').run(out.tenant.id);
      prepare('DELETE FROM shop_sync WHERE tenant_id = ?').run(out.tenant.id);
      prepare('DELETE FROM tenants WHERE id = ?').run(out.tenant.id);
    });
    forgetTenants();
    return { ok: true };
  }

  /**
   * Verwijdert een live-tenant definitief, met al zijn testomgevingen: alle rijen
   * met een tenant_id van die omgevingen gaan weg. De tabellen worden uit het
   * schema gelezen, zodat een nieuwe tabel vanzelf meegaat. Verwijzingen elders
   * naar de gewiste gebruikers (bijv. in het auditlog van de hoofdtenant) worden
   * leeggemaakt. De hoofdtenant kan niet.
   * @param {string} id Id van de live-tenant.
   * @param {string} mainTenantId Id van de hoofdtenant.
   * @returns {{ tenant: object, ids: string[], counts: object }|{ error: string, status: number }} De tenant, de gewiste omgevingen en het aantal rijen per tabel, of een foutmelding.
   */
  function deleteTenant(id, mainTenantId) {
    const tenant = getTenant(id);
    if (!tenant) return { error: 'Tenant niet gevonden.', status: 404 };
    if (tenant.environment !== 'live') return { error: 'Verwijder een testomgeving via de testomgeving zelf.', status: 409 };
    if (tenant.id === mainTenantId || tenant.slug === 'default') return { error: 'De hoofdtenant kan niet worden verwijderd.', status: 409 };
    const ids = [tenant.id, ...prepare('SELECT id FROM tenants WHERE parent_id = ?').all(tenant.id).map((row) => row.id)];
    const tables = listTables(db).filter((name) => name !== 'tenants');
    /**
     * Kolommen van een tabel.
     * @param {string} table Naam van de tabel.
     * @returns {object[]} De kolommen.
     */
    const columns = (table) => tableColumns(db, table);
    const marks = ids.map(() => '?').join(', ');
    const counts = {};
    transaction(db, () => {
      // Pas bij COMMIT controleren: de volgorde van wissen doet er dan niet toe.
      deferForeignKeys(db);
      const users = prepare(`SELECT id FROM users WHERE tenant_id IN (${marks})`).all(...ids).map((row) => row.id);
      for (const table of tables) {
        if (!columns(table).some((column) => column.name === 'tenant_id')) continue;
        const changes = prepare(`DELETE FROM ${table} WHERE tenant_id IN (${marks})`).run(...ids).changes;
        if (changes) counts[table] = changes;
      }
      if (users.length) {
        const userMarks = users.map(() => '?').join(', ');
        for (const table of tables) {
          const columnInfo = columns(table);
          for (const fk of foreignKeys(db, table)) {
            if (fk.table !== 'users' || columnInfo.find((column) => column.name === fk.from)?.notnull) continue;
            prepare(`UPDATE ${table} SET ${fk.from} = NULL WHERE ${fk.from} IN (${userMarks})`).run(...users);
          }
        }
      }
      prepare(`DELETE FROM tenants WHERE parent_id = ?`).run(tenant.id);
      prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id);
    });
    forgetTenants();
    return { tenant: tenant, ids, counts };
  }

  /**
   * Vult een testomgeving met testdata (opgebouwd in test-data.js): eerst
   * leegmaken, dan de testaccounts (allemaal met dezelfde wachtwoord-hash),
   * plannen met een regel in de historie en offertes. De accounts horen bij de
   * testomgeving zelf, dus "Leegmaken" en "Verwijderen" ruimen ze mee op.
   * @param {string} id Id van de testomgeving.
   * @param {{ accounts: object[], plans: object[], quotes: object[] }} data De testdata.
   * @param {{ passwordHash: string, numberPrefix?: string }} options Gedeelde wachtwoord-hash en voorvoegsel van offertenummers.
   * @returns {object} tenant, users, byKey, planIds, quoteIds en counts, of { error, status }.
   */
  function seedEnvironment(id, { accounts, plans, quotes }, { passwordHash, numberPrefix = 'OF-' }) {
    const out = testEnvironment(id);
    if (out.error) return out;
    const tenantId = out.tenant.id;
    const clash = accounts.find((account) => usernameTaken(tenantId, account.username, { except: tenantId }));
    if (clash) return { error: `De gebruikersnaam ${clash.username} bestaat al binnen deze organisatie.`, status: 409 };
    return transaction(db, () => {
      clearData(tenantId);
      const users = {};
      for (const account of accounts) {
        users[account.key] = insertUser(tenantId, { username: account.username, displayName: account.displayName, role: account.role, kind: 'account', passwordHash });
        prepare('UPDATE users SET email = ?, phone = ?, preferences = ? WHERE id = ?')
          .run(account.email || '', account.phone || '', JSON.stringify(cleanPreferences(account.preferences)), users[account.key].id);
        Object.assign(users[account.key], { email: account.email || '', phone: account.phone || '' });
      }
      const planIds = {};
      for (const plan of plans) {
        const planId = newId();
        const meta = metaOf(plan.data);
        // Ingediend zonder account: een gast met de contactgegevens is eigenaar.
        let owner = users[plan.owner];
        if (plan.guest) {
          owner = insertUser(tenantId, { username: `aanvraag-${crypto.randomBytes(4).toString('hex')}`, displayName: plan.guest.name, role: 'klant', kind: 'gast' });
          prepare('UPDATE users SET email = ?, phone = ? WHERE id = ?').run(plan.guest.email || '', plan.guest.phone || '', owner.id);
        }
        const review = plan.review || { status: 'concept' };
        const requested = review.status === 'concept' ? null : plan.at;
        prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at,
            review_status, review_question, review_requested_at, reviewed_by, reviewed_at, submitted_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(planId, tenantId, owner.id, meta.title, meta.customer, meta.address, JSON.stringify(plan.data), plan.at, plan.at,
          review.status, review.question || '', review.status === 'goedgekeurd' ? null : requested, review.by ? users[review.by].id : null, review.by ? plan.at : null, review.via || '');
        const historyId = record({ tenantId: tenantId, userId: owner.id, planId: planId, action: 'aangemaakt', data: plan.data });
        prepare('UPDATE history SET created_at = ?, updated_at = ? WHERE id = ?').run(plan.at, plan.at, historyId);
        planIds[plan.key] = planId;
      }
      const seq = {};
      const quoteIds = new Map();
      for (const quote of [...quotes].sort((left, right) => left.at.localeCompare(right.at))) {
        const year = quote.data.date.slice(0, 4);
        seq[year] = (seq[year] || 0) + 1;
        const data = { ...quote.data, planId: planIds[quote.planKey] || '' };
        const quoteId = newId();
        quoteIds.set(quote, quoteId);
        // Een offerte met een reactie van de klant staat eerst op verzonden;
        // de reactie zelf loopt daarna via de offerteopslag (testdata.seedFeatures).
        prepare(`INSERT INTO quotes (id, tenant_id, owner_id, plan_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, customer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(quoteId, tenantId, users[quote.owner].id, data.planId || null, `${numberPrefix}${year}-${String(seq[year]).padStart(4, '0')}`, quote.response ? 'verzonden' : quote.status,
            data.title, data.customer.name, quote.totalExcl, quote.totalIncl, JSON.stringify(data), quote.at, quote.at, quote.customerKey ? users[quote.customerKey].id : null);
      }
      return {
        tenant: out.tenant, users: Object.values(users), byKey: users, planIds, quoteIds: quotes.map((quote) => quoteIds.get(quote)),
        counts: { accounts: accounts.length, plans: plans.length, quotes: quotes.length },
      };
    });
  }

  /**
   * Omgevingen waarin deze gebruiker mag werken: een hoofdbeheerder overal, een
   * beheerder in de eigen tenant en de testomgevingen daarvan, anderen alleen in
   * de eigen tenant. Uitgeschakelde tenants vallen af (behalve voor de hoofdbeheerder).
   * @param {object|null} user De gebruiker.
   * @returns {object[]} Rijen uit tenants.
   */
  function accessibleTenants(user) {
    if (!user) return [];
    if (user.platform_admin) return prepare(`SELECT ${TENANT_COLS} FROM tenants ORDER BY lower(name)`).all();
    const home = getTenant(user.tenant_id);
    if (!home || home.disabled) return [];
    if (!Roles.can(user, 'beheer')) return [home];
    return [home, ...prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE parent_id = ? AND environment = 'test' AND disabled = 0 ORDER BY lower(name)`).all(home.id)];
  }

  /**
   * De tenant waarin met een organisatiecode wordt ingelogd. Leeg = de
   * hoofdtenant (daar staan de hoofdbeheerders). De code van een testomgeving
   * leidt naar de live-tenant, want daar horen de gebruikers bij.
   * @param {string} code De organisatiecode.
   * @returns {object|null} De tenant, of null bij een onbekende code.
   */
  function loginTenant(code) {
    const slug = String(code ?? '').trim().toLowerCase();
    const tenant = slug ? getTenantBySlug(slug) : getTenantBySlug('default');
    if (!tenant) return null;
    return tenant.environment === 'test' && tenant.parent_id ? getTenant(tenant.parent_id) : getTenant(tenant.id);
  }

  /**
   * De organisatie (live-tenant) waarvan een testomgeving een account met deze
   * gebruikersnaam heeft. Testaccounts hebben platformbreed unieke namen
   * (<ingekorte slug>.<naam>); gewone gebruikersnamen leiden hier nooit heen.
   * @param {string} username De gebruikersnaam.
   * @returns {{ home: object, environmentId: string }|null} De live-tenant en het id van de testomgeving, of null.
   */
  function loginTenantOfTestAccount(username) {
    const row = prepare(`SELECT t.id, t.parent_id FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = ? AND u.kind = 'account' AND t.environment = 'test' AND t.parent_id IS NOT NULL LIMIT 1`).get(String(username || '').trim().toLowerCase());
    const home = row ? getTenant(row.parent_id) : null;
    return home ? { home, environmentId: row.id } : null;
  }

  /**
   * Controleert gebruikersnaam en wachtwoord binnen de organisatie (live-tenant
   * en zijn testomgevingen; dezelfde naam kan in andere organisaties voorkomen).
   * Rekent ook zonder gebruiker een hash uit (gelijke looptijd) en vervangt een
   * verouderde hash door een sterkere.
   * @param {string} tenantId De tenant van de organisatiecode.
   * @param {string} username De gebruikersnaam.
   * @param {string} password Het wachtwoord.
   * @returns {Promise<object|null>} De gebruiker, of null.
   */
  async function authenticate(tenantId, username, password) {
    // Alleen binnen de organisatie zoeken (live-tenant en zijn testomgevingen):
    // dezelfde gebruikersnaam kan in andere organisaties voorkomen. Zonder
    // tenant (onbekende code) wordt niemand gevonden.
    const name = String(username || '').trim().toLowerCase();
    const ids = familyIds(tenantId);
    const user = ids.length
      ? prepare(`SELECT ${USER_COLS} FROM users WHERE username = ? AND kind = 'account' AND tenant_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY tenant_id = ? DESC LIMIT 1`).get(name, ...ids, ids[0])
      : null;
    // Ook zonder gebruiker een hash uitrekenen: gelijke looptijd.
    const ok = await verifyPassword(password, user?.password_hash || await getDummyHash());
    if (!(ok && user && !user.disabled)) return null;
    if (needsRehash(user.password_hash)) {
      // Zelfde wachtwoord, sterkere hash; de lopende sessies blijven geldig.
      const hash = await hashPassword(password);
      prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(hash, user.id, user.password_hash);
      prepare('UPDATE sessions SET fingerprint = ? WHERE user_id = ? AND via = ?').run(fingerprintOf(hash), user.id, 'user');
      return getUser(user.id);
    }
    return user;
  }

  /**
   * De gebruiker kiest zelf een nieuw wachtwoord (met het huidige ter controle).
   * Daarna vervallen alle sessies; de aanroeper geeft dit toestel een nieuwe.
   * @param {string} id Id van de gebruiker.
   * @param {string} current Het huidige wachtwoord.
   * @param {string} next Het nieuwe wachtwoord.
   * @returns {Promise<{ user: object }|{ error: string, status: number, wrong?: boolean }>} De gebruiker of een foutmelding.
   */
  async function changeOwnPassword(id, current, next) {
    const user = getUser(id);
    if (!user || user.kind !== 'account' || user.disabled) return { error: 'Alleen een eigen account kan het wachtwoord wijzigen.', status: 400 };
    if (!(await verifyPassword(String(current ?? ''), user.password_hash))) return { error: 'Je huidige wachtwoord klopt niet.', status: 401, wrong: true };
    if (String(next ?? '') === String(current ?? '')) return { error: 'Kies een ander wachtwoord dan je huidige.', status: 400 };
    const problem = passwordProblem(next, user.username);
    if (problem) return { error: problem, status: 400 };
    const hash = await hashPassword(next);
    prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
    revokeSessions(user.tenant_id, user.id);
    return { user: getUser(user.id) };
  }

  // ---------- Sessies ----------
  /**
   * Hash van een sessietoken (de database kent alleen de hash, het token staat alleen in de cookie).
   * @param {string} token Het token.
   * @returns {string} SHA-256 in base64url.
   */
  const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

  /**
   * Maakt een sessie aan.
   * @param {object} session tenantId, userId, via ('code'|'user'), fingerprint (van wachtwoord of toegangscode), maxMs, ip en userAgent.
   * @returns {string} Het token voor de cookie.
   */
  function createSession({ tenantId, userId, via, fingerprint, maxMs, ip = '', userAgent = '' }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const startedAt = Date.now();
    prepare(`INSERT INTO sessions (id_hash, tenant_id, user_id, via, fingerprint, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tokenHash(token), tenantId, userId, via, fingerprint,
      new Date(startedAt).toISOString(), new Date(startedAt).toISOString(), new Date(startedAt + maxMs).toISOString(), String(ip).slice(0, 64), String(userAgent).slice(0, 200));
    return token;
  }

  // Sessie met de gebruiker en diens tenant in één query (bij elk verzoek):
  // { row, user, tenant } of null. De tenant gaat ook in het geheugen van het
  // verzoek, zodat getTenant hem daarna niet opnieuw ophaalt.
  const SESSION_SQL = `SELECT s.id_hash, s.tenant_id, s.user_id, s.via, s.fingerprint, s.created_at, s.last_seen_at, s.expires_at,
      ${USER_COLUMNS.map((column) => `u.${column} AS u_${column}`).join(', ')}, ${TENANT_COLUMNS.map((column) => `t.${column} AS t_${column}`).join(', ')}
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN tenants t ON t.id = u.tenant_id
    WHERE s.id_hash = ?`;
  /**
   * Zoekt bij elk verzoek de sessie met de gebruiker en diens tenant in één
   * query op. De tenant gaat ook in het geheugen van het verzoek, zodat
   * getTenant hem daarna niet opnieuw ophaalt.
   * @param {string} token Het token uit de cookie.
   * @returns {{ row: object, user: object|null, tenant: object|null }|null} Sessie, gebruiker en tenant, of null.
   */
  function findSessionWithUser(token) {
    if (typeof token !== 'string' || !/^[\w-]{40,60}$/.test(token)) return null;
    const joined = prepare(SESSION_SQL).get(tokenHash(token));
    if (!joined) return null;
    /**
     * Haalt de kolommen met een voorvoegsel (u_ of t_) uit de samengevoegde rij.
     * @param {string} prefix Het voorvoegsel.
     * @param {string[]} cols De kolomnamen zonder voorvoegsel.
     * @returns {object} Kolomnaam → waarde.
     */
    const pick = (prefix, cols) => Object.fromEntries(cols.map((column) => [column, joined[`${prefix}${column}`]]));
    const row = { id_hash: joined.id_hash, tenant_id: joined.tenant_id, user_id: joined.user_id, via: joined.via, fingerprint: joined.fingerprint,
      created_at: joined.created_at, last_seen_at: joined.last_seen_at, expires_at: joined.expires_at };
    const user = joined.u_id ? pick('u_', USER_COLUMNS) : null;
    const tenant = joined.t_id ? pick('t_', TENANT_COLUMNS) : null;
    const memo = requestCache.getStore();
    if (memo && tenant) memo.set(`tenant:${tenant.id}`, tenant);
    return { row, user, tenant };
  }

  /**
   * Werkt het laatst-gezien-moment van een sessie bij, hooguit eens per vijf minuten.
   * @param {object} row De sessierij.
   */
  function touchSession(row) {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    if (row.last_seen_at < cutoff) prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(currentTimestamp(), row.id_hash);
  }

  /**
   * Beëindigt de sessie van een token (uitloggen).
   * @param {string} token Het token uit de cookie.
   * @returns {number} Aantal verwijderde sessies (0 of 1).
   */
  const deleteSession = (token) => prepare('DELETE FROM sessions WHERE id_hash = ?').run(tokenHash(token)).changes;
  /**
   * Verwijdert een sessierij (verlopen of ongeldig geworden).
   * @param {object} row De sessierij.
   * @returns {object} Resultaat van de query.
   */
  const dropSession = (row) => prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
  /**
   * Beëindigt alle sessies van een gebruiker binnen een tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} userId Id van de gebruiker.
   * @returns {number} Aantal verwijderde sessies.
   */
  const revokeSessions = (tenantId, userId) => prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId).changes;

  // ---------- Auditlog ----------
  // Beveiligingsgebeurtenissen (inloggen, gebruikers, instellingen). Nooit
  // wachtwoorden, codes of sleutels in `detail`.
  /**
   * Schrijft een regel in het auditlog.
   * @param {object} entry tenantId, userId, action, detail (zonder geheimen) en ip.
   */
  function audit({ tenantId, userId = null, action, detail = {}, ip = '' }) {
    prepare('INSERT INTO audit (id, tenant_id, user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), tenantId, userId, action, JSON.stringify(detail || {}), String(ip).slice(0, 64), currentTimestamp());
  }

  /**
   * Bladert door het auditlog van een tenant, nieuwste eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [options] limit, offset en action (filter).
   * @returns {{ total: number, items: object[] }} Totaal aantal en de regels van deze pagina.
   */
  function listAudit(tenantId, { limit = 100, offset = 0, action = '' } = {}) {
    const where = ['a.tenant_id = ?'];
    const args = [tenantId];
    if (action) { where.push('a.action = ?'); args.push(String(action)); }
    const from = `FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`;
    const total = prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const items = prepare(`SELECT a.id, a.user_id, a.action, a.detail, a.ip, a.created_at, u.username, u.display_name ${from} ORDER BY a.created_at DESC, a.id LIMIT ? OFFSET ?`).all(...args, pageSize, skip)
      .map((entry) => ({ id: entry.id, action: entry.action, detail: JSON.parse(entry.detail || '{}'), ip: entry.ip, createdAt: entry.created_at,
        user: entry.user_id ? { id: entry.user_id, username: entry.username, displayName: entry.display_name } : null }));
    return { total, items };
  }

  // ---------- Bewaartermijnen (AVG) ----------
  // IP-adressen wissen na ipDays, auditregels verwijderen na auditDays,
  // verlopen sessies opruimen.
  /**
   * Past de bewaartermijnen toe: IP-adressen wissen na ipDays, auditregels
   * verwijderen na auditDays en verlopen sessies opruimen.
   * @param {string} tenantId Id van de tenant.
   * @param {{ ipDays: number, auditDays: number }} terms De bewaartermijnen in dagen.
   * @returns {object} Aantal gewijzigde regels per soort.
   */
  function applyRetention(tenantId, { ipDays, auditDays }) {
    /**
     * Het moment dat een aantal dagen geleden ligt.
     * @param {number} days Aantal dagen.
     * @returns {string} Tijdstip als ISO-tekst.
     */
    const before = (days) => new Date(Date.now() - days * 86400000).toISOString();
    return transaction(db, () => ({
      historyIps: prepare("UPDATE history SET ip = '' WHERE tenant_id = ? AND ip <> '' AND updated_at < ?").run(tenantId, before(ipDays)).changes,
      auditIps: prepare("UPDATE audit SET ip = '' WHERE tenant_id = ? AND ip <> '' AND created_at < ?").run(tenantId, before(ipDays)).changes,
      sessionIps: prepare("UPDATE sessions SET ip = '' WHERE tenant_id = ? AND ip <> '' AND created_at < ?").run(tenantId, before(ipDays)).changes,
      audit: prepare('DELETE FROM audit WHERE tenant_id = ? AND created_at < ?').run(tenantId, before(auditDays)).changes,
      sessions: prepare('DELETE FROM sessions WHERE expires_at < ?').run(currentTimestamp()).changes,
    }));
  }

  /**
   * Werkt het laatst-gezien-moment van een gebruiker bij, hooguit eens per vijf
   * minuten. Met de rij uit users (in plaats van alleen het id) wordt er niet
   * eens geschreven zolang last_seen_at nog vers is: geen query per verzoek.
   * @param {string|object} idOrRow Id of rij van de gebruiker.
   */
  function touchUser(idOrRow) {
    // Hooguit eens per vijf minuten schrijven.
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const row = idOrRow && typeof idOrRow === 'object' ? idOrRow : null;
    if (row && row.last_seen_at && row.last_seen_at >= cutoff) return;
    prepare('UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(currentTimestamp(), row ? row.id : idOrRow, cutoff);
  }

  /**
   * Alle gebruikers van een tenant met het aantal plannen, historieregels en actieve sessies.
   * @param {string} tenantId Id van de tenant.
   * @param {{ includeGuests?: boolean }} [options] Gasten meenemen (standaard ja).
   * @returns {object[]} De gebruikers (openbare velden).
   */
  function listUsers(tenantId, { includeGuests = true } = {}) {
    return prepare(`
      SELECT ${PUBLIC_USER_COLUMNS},
        (SELECT COUNT(*) FROM plans p WHERE p.owner_id = u.id AND p.deleted_at IS NULL) AS plan_count,
        (SELECT COUNT(*) FROM history h WHERE h.user_id = u.id) AS history_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.expires_at > ?) AS session_count
      FROM users u WHERE u.tenant_id = ? ${includeGuests ? '' : "AND u.kind <> 'gast'"}
      ORDER BY CASE u.kind WHEN 'systeem' THEN 0 WHEN 'account' THEN 1 ELSE 2 END, lower(u.display_name)`)
      .all(currentTimestamp(), tenantId)
      .map((user) => ({ ...publicUser(user), planCount: user.plan_count, historyCount: user.history_count, sessionCount: user.session_count }));
  }

  /**
   * Klantaccounts van een of meer tenants (om een offerte aan te koppelen), in
   * één query en in de volgorde van de lijst.
   * @param {string|string[]} tenantIds Een tenant-id of een lijst.
   * @returns {{ id: string, username: string, displayName: string }[]} De klanten.
   */
  function listCustomers(tenantIds) {
    const ids = (Array.isArray(tenantIds) ? tenantIds : [tenantIds]).map(String);
    const keys = roles.keysOfKind(ids[0], 'klant');
    if (!keys.length) return [];
    const order = ids.map(() => 'WHEN ? THEN').map((whenClause, i) => `${whenClause} ${i}`).join(' ');
    return prepare(`SELECT id, username, display_name FROM users WHERE tenant_id IN (${ids.map(() => '?').join(', ')})
      AND kind = 'account' AND role IN (${keys.map(() => '?').join(', ')}) AND disabled = 0 ORDER BY CASE tenant_id ${order} END, lower(display_name)`)
      .all(...ids, ...keys, ...ids).map((user) => ({ id: user.id, username: user.username, displayName: user.display_name }));
  }

  // ---------- Historie ----------
  /**
   * Legt een actie op een plan vast in de historie. Met merge worden
   * wijzigingen van dezelfde gebruiker binnen 30 minuten samengevoegd.
   * @param {object} entry tenantId, userId, planId, action, data (het plan), summary, title, ip en merge.
   * @returns {string} Id van de historieregel.
   */
  function record({ tenantId, userId, planId = null, action, data = null, summary: extra = null, title = '', ip = '', merge = false }) {
    const timestamp = currentTimestamp();
    const meta = data ? metaOf(data) : { title, customer: '', address: '' };
    const summary = JSON.stringify(extra || (data ? summarize(data) : {}));
    const snapshot = data ? JSON.stringify(withoutBackground(data)) : null;
    if (merge && planId) {
      const since = new Date(Date.now() - HISTORY_MERGE_MS).toISOString();
      const last = prepare(`SELECT id FROM history WHERE tenant_id = ? AND plan_id = ? AND user_id = ?
        AND action IN ('aangemaakt', 'bijgewerkt') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`).get(tenantId, planId, userId, since);
      if (last) {
        prepare('UPDATE history SET title = ?, customer = ?, address = ?, summary = ?, snapshot = ?, ip = ?, updated_at = ? WHERE id = ?')
          .run(meta.title, meta.customer, meta.address, summary, snapshot, ip, timestamp, last.id);
        return last.id;
      }
    }
    const id = newId();
    prepare(`INSERT INTO history (id, tenant_id, user_id, plan_id, action, title, customer, address, summary, snapshot, ip, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, userId, planId, action, meta.title, meta.customer, meta.address, summary, snapshot, ip, timestamp, timestamp);
    return id;
  }

  /**
   * Zet een historierij om naar het formaat van de API.
   * @param {object} entry De rij uit HISTORY_SELECT.
   * @param {boolean} withSnapshot Ook de kopie van het plan meegeven.
   * @returns {object} De historieregel.
   */
  function historyRow(entry, withSnapshot) {
    const out = {
      id: entry.id, planId: entry.plan_id, action: entry.action, title: entry.title, customer: entry.customer, address: entry.address,
      summary: JSON.parse(entry.summary || '{}'), ip: entry.ip, createdAt: entry.created_at, updatedAt: entry.updated_at,
      user: entry.user_id ? { id: entry.user_id, username: entry.username, displayName: entry.display_name, role: entry.role, kind: entry.kind } : null,
      planDeleted: entry.plan_id ? !entry.plan_exists : false,
      hasSnapshot: Boolean(entry.has_snapshot),
    };
    if (withSnapshot) out.snapshot = entry.snapshot ? JSON.parse(entry.snapshot) : null;
    return out;
  }

  const HISTORY_SELECT = `
    SELECT h.id, h.plan_id, h.user_id, h.action, h.title, h.customer, h.address, h.summary, h.ip, h.created_at, h.updated_at,
      h.snapshot IS NOT NULL AS has_snapshot,
      u.username, u.display_name, u.role, u.kind,
      EXISTS (SELECT 1 FROM plans p WHERE p.id = h.plan_id AND p.deleted_at IS NULL) AS plan_exists`;

  /**
   * Bladert door de historie van een tenant, laatst gewijzigd eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [options] limit, offset en de filters userId, search, action en planId.
   * @returns {{ total: number, items: object[] }} Totaal aantal en de regels van deze pagina.
   */
  function listHistory(tenantId, { limit = 100, offset = 0, userId = '', search = '', action = '', planId = '' } = {}) {
    const where = ['h.tenant_id = ?'];
    const args = [tenantId];
    if (planId) { where.push('h.plan_id = ?'); args.push(String(planId)); }
    if (userId) { where.push('h.user_id = ?'); args.push(String(userId)); }
    if (action) { where.push('h.action = ?'); args.push(String(action)); }
    if (search) {
      // lower(): LIKE is in SQLite hoofdletterongevoelig, in PostgreSQL niet.
      const cols = ['h.title', 'h.customer', 'h.address', 'u.display_name', 'u.username'];
      where.push(`(${cols.map((column) => `lower(${column}) LIKE lower(?) ESCAPE '\\'`).join(' OR ')})`);
      const like = `%${String(search).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      args.push(like, like, like, like, like);
    }
    const from = `FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE ${where.join(' AND ')}`;
    const total = prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const rows = prepare(`${HISTORY_SELECT} ${from} ORDER BY h.updated_at DESC, h.id LIMIT ? OFFSET ?`).all(...args, pageSize, skip);
    return { total, items: rows.map((entry) => historyRow(entry, false)) };
  }

  /**
   * Eén historieregel met de kopie van het plan.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de historieregel.
   * @returns {object|null} De regel, of null.
   */
  function getHistory(tenantId, id) {
    const entry = prepare(`${HISTORY_SELECT}, h.snapshot FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.tenant_id = ? AND h.id = ?`).get(tenantId, String(id));
    return entry ? historyRow(entry, true) : null;
  }

  // ---------- Plannen ----------
  // Controle (migratie 19): concept -> ter_controle -> goedgekeurd. Alleen
  // wie het recht plannen.goedkeuren heeft keurt goed; wijzigt een klant een
  // goedgekeurd plan, dan gaat het opnieuw ter controle.
  const REVIEW_COLS = 'p.review_status, p.review_question, p.review_requested_at, p.reviewed_at, p.submitted_via, p.reviewed_by, r.display_name AS reviewer_name';
  const REVIEW_JOIN = 'LEFT JOIN users r ON r.id = p.reviewed_by';
  /**
   * Zet de controlekolommen van een plan om naar een object.
   * @param {object} plan Planrij met REVIEW_COLS.
   * @returns {object} status, question, requestedAt, reviewedAt, reviewedBy en via.
   */
  function reviewOf(plan) {
    return {
      status: plan.review_status || 'concept',
      question: plan.review_question || '',
      requestedAt: plan.review_requested_at || null,
      reviewedAt: plan.reviewed_at || null,
      reviewedBy: plan.reviewed_by ? plan.reviewer_name || 'Verwijderde gebruiker' : null,
      via: plan.submitted_via || '',
    };
  }

  /**
   * Zet een planrij om naar het formaat van de API; welke velden er zijn hangt
   * af van de kolommen in de rij.
   * @param {object} plan De planrij.
   * @param {boolean} withData Ook het volledige plan meegeven.
   * @returns {object} Het plan.
   */
  function planRow(plan, withData) {
    const out = { id: plan.id, title: plan.title, customer: plan.customer, address: plan.address, createdAt: plan.created_at, updatedAt: plan.updated_at };
    if (plan.owner_name !== undefined) {
      out.owner = { id: plan.owner_id, username: plan.owner_username, displayName: plan.owner_name, kind: plan.owner_kind };
      // Contactgegevens van wie een tekening zonder account indiende.
      if (plan.owner_kind === 'gast') Object.assign(out.owner, { email: plan.owner_email || '', phone: plan.owner_phone || '' });
    }
    if (plan.review_status !== undefined) out.review = reviewOf(plan);
    if (plan.lite !== undefined) {
      let data = null;
      try { data = JSON.parse(plan.lite); } catch { /* beschadigd plan: lege samenvatting */ }
      out.summary = summarize(data);
      out.deletedAt = plan.deleted_at || null;
    }
    if (plan.history_count !== undefined) out.historyCount = plan.history_count;
    if (withData) out.data = JSON.parse(plan.data);
    return out;
  }

  /**
   * Plannen van een tenant met samenvatting (vlakken, m², sproeiers, zones)
   * voor de overzichten; de grote achtergrondafbeelding blijft in de database.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [options] ownerId, includeDeleted, withHistory (aantal historieregels, voor beheerders) en reviewStatus.
   * @returns {object[]} De plannen, laatst gewijzigd eerst.
   */
  function listPlans(tenantId, { ownerId = null, includeDeleted = false, withHistory = false, reviewStatus = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT p.id, p.title, p.customer, p.address, p.created_at, p.updated_at, p.deleted_at, p.owner_id,
        ${jsonDigest(db, 'p.data', { values: ['areas'], counts: ['sprinklers', 'zones', 'elements'] })} AS lite,
        ${withHistory ? '(SELECT COUNT(*) FROM history h WHERE h.tenant_id = p.tenant_id AND h.plan_id = p.id) AS history_count,' : ''}
        u.username AS owner_username, u.display_name AS owner_name, u.kind AS owner_kind, u.email AS owner_email, u.phone AS owner_phone,
        ${REVIEW_COLS}
      FROM plans p JOIN users u ON u.id = p.owner_id ${REVIEW_JOIN} WHERE p.tenant_id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}`;
    if (ownerId) { sql += ' AND p.owner_id = ?'; args.push(ownerId); }
    if (REVIEW_STATUSES.includes(reviewStatus)) { sql += ' AND p.review_status = ?'; args.push(reviewStatus); }
    return prepare(`${sql} ORDER BY p.updated_at DESC, p.id`).all(...args).map((plan) => planRow(plan, false));
  }

  /**
   * Zoekt een plan op dat de gebruiker mag zien: de eigenaar, of wie het recht
   * plannen.alle heeft, binnen de eigen tenant.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} [cols] Alleen de kolommen die nodig zijn (bij opslaan niet het hele plan met achtergrond).
   * @returns {object|null} De planrij, of null.
   */
  function findPlan(user, id, cols = '*') {
    const plan = prepare(`SELECT ${cols} FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`).get(user.tenant_id, String(id));
    if (!plan) return null;
    if (plan.owner_id !== user.id && !Roles.can(user, 'plannen.alle')) return null;
    return plan;
  }

  /**
   * Een plan met de volledige inhoud, voor de planner.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @returns {object|null} Het plan, of null.
   */
  function getPlan(user, id) {
    const plan = findPlan(user, id, `id, owner_id, title, customer, address, data, created_at, updated_at,
      review_status, review_question, review_requested_at, reviewed_at, submitted_via, reviewed_by`);
    if (!plan) return null;
    if (plan.reviewed_by) plan.reviewer_name = prepare('SELECT display_name FROM users WHERE id = ?').get(plan.reviewed_by)?.display_name;
    return planRow(plan, true);
  }

  /**
   * Controlestatus van een plan binnen de tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {string|null} De status, of null als het plan niet bestaat of verwijderd is.
   */
  function planReviewStatus(tenantId, id) {
    return prepare('SELECT review_status FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id || ''))?.review_status || null;
  }

  /**
   * Biedt een plan ter controle aan (eigenaar of wie alle plannen mag
   * bewerken), met een vraag aan de installateur.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} question De vraag bij de aanvraag.
   * @returns {object|null} De nieuwe controlestand, of null.
   */
  function requestReview(user, id, question) {
    return transaction(db, () => {
      const plan = findPlan(user, id, 'id, owner_id, submitted_via');
      if (!plan) return null;
      const timestamp = currentTimestamp();
      prepare(`UPDATE plans SET review_status = 'ter_controle', review_question = ?, review_requested_at = ?, reviewed_by = NULL, reviewed_at = NULL,
          submitted_via = ? WHERE id = ?`).run(String(question || '').trim().slice(0, 2000), timestamp, plan.submitted_via || 'account', plan.id);
      return getPlanReview(user.tenant_id, plan.id);
    });
  }

  /**
   * Keurt een plan goed of trekt de goedkeuring in (terug naar concept). Het
   * recht plannen.goedkeuren controleert server.js.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} action 'approve' of iets anders (intrekken).
   * @returns {object|null} De nieuwe controlestand, of null.
   */
  function reviewPlan(user, id, action) {
    return transaction(db, () => {
      const plan = findPlan(user, id, 'id, owner_id');
      if (!plan) return null;
      if (action === 'approve') {
        prepare("UPDATE plans SET review_status = 'goedgekeurd', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, currentTimestamp(), plan.id);
      } else {
        prepare("UPDATE plans SET review_status = 'concept', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").run(plan.id);
      }
      return getPlanReview(user.tenant_id, plan.id);
    });
  }

  /**
   * De controlestand van een plan.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {object|null} De controlestand, of null.
   */
  function getPlanReview(tenantId, id) {
    const plan = prepare(`SELECT p.id, ${REVIEW_COLS} FROM plans p ${REVIEW_JOIN} WHERE p.tenant_id = ? AND p.id = ?`).get(tenantId, id);
    return plan ? reviewOf(plan) : null;
  }

  /**
   * Slaat een tekening op die zonder account is ingediend (openbare planner):
   * een gast met de contactgegevens wordt eigenaar, het plan staat meteen ter controle.
   * @param {string} tenantId Id van de tenant.
   * @param {object} drawing name, email, phone, address, question, data (het plan) en ip.
   * @returns {{ id: string, title: string, reference: string }} Het plan en het kenmerk voor de indiener.
   */
  function submitDrawing(tenantId, { name, email, phone, address, question, data, ip }) {
    return transaction(db, () => {
      const tag = crypto.randomBytes(4).toString('hex');
      const guest = insertUser(tenantId, { username: `aanvraag-${tag}`, displayName: name, role: 'klant', kind: 'gast' });
      prepare('UPDATE users SET email = ?, phone = ? WHERE id = ?').run(email, phone, guest.id);
      const meta = { ...(data.meta || {}) };
      if (!String(meta.customer || '').trim()) meta.customer = name;
      if (address) meta.address = address;
      if (!String(meta.name || '').trim()) meta.name = `Tekening van ${name}`;
      const plan = { ...data, meta };
      const planMeta = metaOf(plan);
      const planId = newId();
      const timestamp = currentTimestamp();
      prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at,
          review_status, review_question, review_requested_at, submitted_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ter_controle', ?, ?, 'openbaar')`)
        .run(planId, tenantId, guest.id, planMeta.title, planMeta.customer, planMeta.address, JSON.stringify(plan), timestamp, timestamp, question, timestamp);
      record({ tenantId, userId: guest.id, planId: planId, action: 'aangemaakt', data: plan, ip });
      return { id: planId, title: planMeta.title, reference: planId.slice(0, 8).toUpperCase() };
    });
  }

  /**
   * Maakt een nieuw plan aan (zonder id) of slaat een bestaand plan op. Past
   * een klant een goedgekeurd plan aan, dan gaat het opnieuw ter controle.
   * @param {object} user De ingelogde gebruiker.
   * @param {string|null} id Id van het plan, of leeg voor een nieuw plan.
   * @param {object} data Het plan.
   * @param {string} ip IP-adres voor de historie.
   * @returns {object|null} Het plan met reviewStatus, of null als het niet gevonden is.
   */
  function savePlan(user, id, data, ip) {
    return transaction(db, () => {
      const meta = metaOf(data);
      const timestamp = currentTimestamp();
      const json = JSON.stringify(data);
      if (!id) {
        const planId = newId();
        prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(planId, user.tenant_id, user.id, meta.title, meta.customer, meta.address, json, timestamp, timestamp);
        record({ tenantId: user.tenant_id, userId: user.id, planId: planId, action: 'aangemaakt', data, ip });
        return { ...planRow({ id: planId, ...meta, created_at: timestamp, updated_at: timestamp }, false), reviewStatus: 'concept' };
      }
      const plan = findPlan(user, id, 'id, owner_id, created_at, review_status');
      if (!plan) return null;
      prepare('UPDATE plans SET title = ?, customer = ?, address = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(meta.title, meta.customer, meta.address, json, timestamp, plan.id);
      // Een klant past een goedgekeurd plan aan: opnieuw ter controle.
      if (plan.review_status === 'goedgekeurd' && !Roles.can(user, 'plannen.goedkeuren')) {
        prepare("UPDATE plans SET review_status = 'ter_controle', review_requested_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").run(timestamp, plan.id);
      }
      const reviewStatus = plan.review_status === 'goedgekeurd' && !Roles.can(user, 'plannen.goedkeuren') ? 'ter_controle' : plan.review_status;
      record({ tenantId: user.tenant_id, userId: user.id, planId: plan.id, action: 'bijgewerkt', data, ip, merge: true });
      return { ...planRow({ id: plan.id, ...meta, created_at: plan.created_at, updated_at: timestamp }, false), reviewStatus };
    });
  }

  /**
   * Wist een plan definitief (AVG-verzoek): het plan zelf en de
   * persoonsgegevens in de historie (kopie, klant, adres, titel, IP). De regels
   * blijven staan als spoor, zonder inhoud. Werkt ook voor verwijderde plannen.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {{ plan: boolean, history: number }|null} Wat er gewist is, of null als er niets was.
   */
  function purgePlan(tenantId, id) {
    return transaction(db, () => {
      const plan = prepare('SELECT id FROM plans WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
      const clearedHistory = prepare(`UPDATE history SET snapshot = NULL, title = 'Gewist plan', customer = '', address = '', summary = '{}', ip = ''
        WHERE tenant_id = ? AND plan_id = ?`).run(tenantId, String(id)).changes;
      if (!plan && !clearedHistory) return null;
      if (plan) prepare('DELETE FROM plans WHERE id = ?').run(plan.id);
      return { plan: Boolean(plan), history: clearedHistory };
    });
  }

  /**
   * Verwijdert een plan (zacht: deleted_at) en legt het vast in de historie.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} ip IP-adres voor de historie.
   * @returns {boolean} Of het plan gevonden en verwijderd is.
   */
  function deletePlan(user, id, ip) {
    return transaction(db, () => {
      // De historie bewaart het plan zonder achtergrond: die hoeft niet mee.
      const plan = findPlan(user, id, `id, owner_id, ${jsonWithout(db, 'data', 'background')} AS data`);
      if (!plan) return false;
      prepare('UPDATE plans SET deleted_at = ? WHERE id = ?').run(currentTimestamp(), plan.id);
      record({ tenantId: user.tenant_id, userId: user.id, planId: plan.id, action: 'verwijderd', data: JSON.parse(plan.data), ip });
      return true;
    });
  }

  return {
    getTenant, getTenantBySlug, tenantRow, listTenants, createTenant, updateTenant, createEnvironment, resetEnvironment, deleteEnvironment, deleteTenant, seedEnvironment,
    roles, accessibleTenants, countPlatformAdmins, dropEmptyTenant, accountProblem, listCustomers,
    ensureTenant, systemUser, createGuest, createAccount, updateAccount, deleteAccount, changeOwnPassword, updateProfile, countAdmins, authenticate, loginTenant, loginTenantOfTestAccount, getUser, touchUser, listUsers, publicUser,
    createSession, findSessionWithUser, touchSession, deleteSession, dropSession, revokeSessions, audit, listAudit, applyRetention,
    record, listHistory, getHistory, listPlans, getPlan, savePlan, deletePlan, purgePlan,
    planReviewStatus, requestReview, reviewPlan, getPlanReview, submitDrawing,
  };
}

/**
 * Vingerafdruk van een wachtwoord-hash voor de sessies (geen geheim, wel
 * uniek per wachtwoord): een nieuw wachtwoord maakt oude sessies ongeldig.
 * @param {string} value De wachtwoord-hash of toegangscode.
 * @returns {string} Korte SHA-256 in base64url.
 */
const fingerprintOf = (value) => crypto.createHash('sha256').update(`fp:${value || ''}`).digest('base64url').slice(0, 22);

module.exports = { createStore, withRequestCache, preferencesOf, PREFERENCES, hashPassword, verifyPassword, needsRehash, passwordProblem, fingerprintOf, summarize, ROLES };
