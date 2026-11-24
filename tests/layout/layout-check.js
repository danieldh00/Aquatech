/**
 * Layoutcheck: start de app in dit proces (PostgreSQL via TEST_DATABASE_URL), vult een testomgeving met testdata en
 * doorloopt met Playwright alle app- en shoppagina's per rol (ook hoofdbeheerder) op 1440 en 375 px. Elke pagina gaat door de detectoren in
 * detectors.js. Gebruik: `node layout-check.js [--rol=klant] [--update-baseline]`; bevindingen die niet in
 * baseline.json staan laten het proces falen (exitcode 1). Rapport: layout-rapport.json (en een tabel in de uitvoer).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { detectLayoutProblems } = require('./detectors');

const BACKEND = path.join(__dirname, '..', '..', 'hub', 'backend');
const { createApp } = require(path.join(BACKEND, 'src', 'server'));
const { openDb } = require(path.join(BACKEND, 'src', 'database', 'db'));
const { createStore } = require(path.join(BACKEND, 'src', 'platform', 'store'));
const { createClient, listen } = require(path.join(BACKEND, 'test', 'helpers', 'http-client'));

const PASSWORD = 'Tuin-Plan-2026!';
const VIEWPORTS = [{ name: '1440', width: 1440, height: 900 }, { name: '375', width: 375, height: 812 }];
const BASELINE_FILE = path.join(__dirname, 'baseline.json');
const ARTICLE_TABS = ['stock', 'reserved', 'moves', 'reorder', 'suppliers', 'orders', 'pricefactor', 'counts', 'media', 'texts'];

/**
 * Leest de ids van de Beheer-secties uit indeling.js.
 * @returns {string[]} De sectie-ids.
 */
function adminSections() {
  const source = fs.readFileSync(path.join(BACKEND, '..', 'frontend', 'beheer', 'indeling.js'), 'utf8');
  return [...source.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((match) => match[1]);
}

/**
 * Pagina's per rol.
 * @param {string[]} sections Beheer-secties.
 * @returns {Record<string, string[]>} Paden (zonder /app/) per rol.
 */
function pagesPerRole(sections) {
  const modules = ['', 'nieuws/', 'profiel/', 'plannen/', 'offertes/', 'klanten/', 'klantdossier/', 'facturen/', 'artikelen/', 'werkorders/', 'planning/', 'meldingen/', 'uitbesteden/', 'webshop-bestellingen/', 'orderpick/', 'beregening/', 'hoofdbeheer/'];
  return {
    beheerder: [...modules, ...ARTICLE_TABS.map((tab) => `artikelen/#${tab}`), ...sections.map((id) => `beheer/#${id}`)],
    installateur: ['', 'nieuws/', 'profiel/', 'plannen/', 'offertes/', 'klanten/', 'werkorders/', 'planning/', 'meldingen/', 'artikelen/', 'beregening/'],
    planner: ['', 'planning/', 'werkorders/', 'plannen/'],
    hoofdbeheerder: ['', 'hoofdbeheer/', 'facturen/', 'webshop-bestellingen/', 'klanten/', 'offertes/', ...sections.map((id) => `beheer/#${id}`)],
    picker: ['', 'orderpick/', 'orderpick/#ontvangst', 'orderpick/#tellen'],
    klant: ['', 'portaal/', 'nieuws/', 'plannen/', 'profiel/', 'offertes/', 'beregening/'],
  };
}

/**
 * Maakt de wereld: hoofdtenant met webshop en artikelen, een testomgeving met testdata en een winkelklant.
 * @returns {Promise<{ base: string, server: object, jars: Record<string, Map>, shopper: Map }>} Adres en cookiepotten per rol.
 */
async function buildWorld() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD, mustChangePassword: false }, { platformAdmin: true });
  const app = createApp({ env: { MULTITENANCY: '1' }, secret: 'l'.repeat(64), db, loginDelayMs: 0, mailerFor: () => ({ configured: () => true, send: async () => {} }) });
  const { server, base } = await listen(app);
  const admin = createClient(base);
  await admin.login('baas', PASSWORD);
  const tenant = (await admin.post('/app/api/platform/tenants', { name: 'Layout BV', slug: 'layout', admin: { username: 'piet', password: PASSWORD, mustChangePassword: false } })).body.tenant;
  const environment = (await admin.post(`/app/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
  const seeded = await admin.post(`/app/api/platform/tenants/${environment.id}/testdata`);
  if (seeded.status !== 201) throw new Error(`Testdata mislukt: ${seeded.status} ${seeded.text}`);
  const names = { beheerder: 'beheerder', installateur: 'installateur', planner: 'planner', picker: 'picker', klant: 'klant1' };
  const jars = {};
  for (const [role, suffix] of Object.entries(names)) {
    const client = createClient(base);
    const username = seeded.body.accounts.find((account) => account.username.endsWith(`.${suffix}`)).username;
    const login = await client.login(username, seeded.body.password, 'layout');
    if (login.status !== 200) throw new Error(`Inloggen ${role} mislukt: ${login.status} ${login.text}`);
    jars[role] = client.jar;
  }
  // Webshop op de hoofdtenant met een paar artikelen en een geregistreerde klant.
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: { pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [{ country: 'NL', tiers: [{ upToGrams: 2000, price: 6.95 }] }] } } });
  const articleNames = ['Sproeier Hunter MP Rotator 800', 'Druppelslang 16 mm per meter', 'Beregeningscomputer 6 zones wifi', 'Magneetventiel 24V 1 inch met debietregeling', 'PE-buis 25 mm 100 m rol', 'Pop-up sproeier 10 cm', 'Regensensor draadloos', 'Koppelstuk'];
  for (const [index, name] of articleNames.entries()) {
    await admin.post('/app/api/stock/items', { code: `LAY${index}`, name, onHand: 40, salePrice: 5 + index * 7.5, weightGrams: 300 });
  }
  const shopper = createClient(base);
  const body = new URLSearchParams({ displayName: 'Layout Klant', email: 'layout@voorbeeld.nl', password: PASSWORD, password2: PASSWORD, website: '' });
  const registered = await fetch(`${base}/registreren/`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body });
  for (const header of registered.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const at = pair.indexOf('=');
    shopper.jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  // De hoofdbeheerder ('baas') in de hoofdtenant ziet alle Beheer-secties en Hoofdbeheer.
  jars.hoofdbeheerder = admin.jar;
  return { base, server, jars, shopper: shopper.jar, adminJar: admin.jar };
}

/**
 * Cookies uit een jar voor Playwright.
 * @param {Map<string, string>} jar Cookiepot.
 * @param {string} base Adres van de server.
 * @returns {Array<{ name: string, value: string, url: string }>} Cookies.
 */
const cookiesOf = (jar, base) => [...jar].map(([name, value]) => ({ name, value, url: base }));

/**
 * Zoekt per soort één voorbeeldadres (groep, categorie, product) in de shop.
 * @param {import('playwright').Page} page Een pagina op de shop.
 * @param {string} base Adres van de server.
 * @returns {Promise<string[]>} Extra paden.
 */
async function shopSamples(page, base) {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const links = await page.$$eval('a[href]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
  const pick = (pattern) => links.find((href) => pattern.test(href));
  return [pick(/groep\/[^/]+\/?$/), pick(/categorie\/[^/]+\/?$/), pick(/product\/[^/]+\/?$/)].filter(Boolean).map((href) => new URL(href, `${base}/`).pathname);
}

/**
 * Stabiele sleutel van een consolemelding: CSP-meldingen (de tekst verschilt per Chromium-versie) worden
 * `csp <richtlijn> <soort>`, de rest verliest adres, versie en id's.
 * @param {string} message De melding.
 * @returns {string} Sleutel voor de baseline.
 */
function consoleKey(message) {
  if (/Content Security Policy/i.test(message)) {
    const directive = (message.match(/directive[: ]+['"]?([a-z-]+)/i) || [])[1] || '?';
    const kind = (message.match(/inline style|inline script|image|script|font|frame|connect/i) || ['?'])[0].toLowerCase();
    return `csp ${directive} ${kind}`;
  }
  return message.replace(/https?:\/\/[^/\s]+/g, '').replace(/[?&]v=[\d.]+/g, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'uuid').slice(0, 80);
}

let jobCounter = 0;

/**
 * Controleert één pagina op één schermbreedte.
 * @param {import('playwright').Browser} browser De browser.
 * @param {object} job role, url, viewport, cookies.
 * @returns {Promise<object[]>} Bevindingen met rol, pagina en schermbreedte.
 */
async function checkPage(browser, { role, url, viewport, cookies, base }) {
  jobCounter += 1;
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', extraHTTPHeaders: { 'CF-Connecting-IP': `10.1.${Math.floor(jobCounter / 250)}.${jobCounter % 250}` } });
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 600)); });
  page.on('response', (reply) => { if (reply.status() >= 400 && !/favicon/.test(reply.url())) consoleErrors.push(`HTTP ${reply.status()} ${reply.url().replace(/^https?:\/\/[^/]+/, '')}`.slice(0, 160)); });
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(400);
    const shown = new URL(page.url()).pathname + new URL(page.url()).hash;
    if (process.env.LAYOUT_SHOTS) {
      fs.mkdirSync(process.env.LAYOUT_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.LAYOUT_SHOTS, `${role}-${viewport.name}-${url.replace(base, '').replace(/[^a-z0-9]+/gi, '_')}.png`), fullPage: true });
    }
    const findings = await page.evaluate(detectLayoutProblems, { tolerance: 2 });
    const label = url.replace(base, '');
    const redirected = shown !== label && !label.includes('#') ? ` (doorgestuurd naar ${shown})` : '';
    for (const message of [...new Set(consoleErrors)]) findings.push({ kind: 'console-fout', selector: consoleKey(message), detail: message.slice(0, 160) });
    const result = findings.map((finding) => ({ role, page: label, viewport: viewport.name, ...finding }));
    if (response && response.status() >= 400) result.push({ role, page: label, viewport: viewport.name, kind: 'http-fout', selector: '', detail: `status ${response.status()}` });
    for (const message of errors) result.push({ role, page: label, viewport: viewport.name, kind: 'scriptfout', selector: '', detail: message.slice(0, 160) });
    if (redirected) result.push({ role, page: label, viewport: viewport.name, kind: 'info-doorverwezen', selector: '', detail: redirected.trim() });
    return result;
  } catch (error) {
    return [{ role, page: url.replace(base, ''), viewport: viewport.name, kind: 'laden-mislukt', selector: '', detail: String(error.message).slice(0, 160) }];
  } finally {
    await context.close();
  }
}

/**
 * Sleutel van een bevinding voor de baseline (zonder getallen, zodat kleine verschuivingen niet opnieuw melden).
 * @param {object} finding De bevinding.
 * @returns {string} Sleutel.
 */
const keyOf = (finding) => [finding.role, finding.page, finding.viewport, finding.kind, finding.selector].join('|');

/**
 * Hoofdprogramma: wereld bouwen, pagina's doorlopen, rapporteren.
 * @returns {Promise<void>}
 */
async function main() {
  const onlyRole = (process.argv.find((arg) => arg.startsWith('--rol=')) || '').slice(6);
  const world = await buildWorld();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
  const roles = pagesPerRole(adminSections());
  const jobs = [];
  for (const [role, pages] of Object.entries(roles)) {
    if (onlyRole && role !== onlyRole) continue;
    for (const viewport of VIEWPORTS) {
      for (const pagePath of pages) jobs.push({ role, url: `${world.base}/app/${pagePath}`, viewport, cookies: cookiesOf(world.jars[role], world.base), base: world.base });
    }
  }
  // Shop: bezoeker, ingelogde klant en medewerker.
  const probe = await (await browser.newContext()).newPage();
  const samples = await shopSamples(probe, world.base);
  const shopPaths = ['/', '/inloggen/', '/registreren/', '/over-ons/', '/winkelwagen/', '/zoeken/?q=sproeier', '/groothandel/', '/planner', '/wachtwoord-vergeten/', ...samples];
  const accountPaths = ['/account/', '/bestellingen/', '/afrekenen/'];
  if (!onlyRole || onlyRole === 'shop') {
    for (const viewport of VIEWPORTS) {
      for (const pagePath of shopPaths) jobs.push({ role: 'shop-bezoeker', url: `${world.base}${pagePath}`, viewport, cookies: [], base: world.base });
      for (const pagePath of [...shopPaths.slice(0, 1), ...accountPaths]) jobs.push({ role: 'shop-klant', url: `${world.base}${pagePath}`, viewport, cookies: cookiesOf(world.shopper, world.base), base: world.base });
      for (const pagePath of ['/', '/winkelwagen/']) jobs.push({ role: 'shop-medewerker', url: `${world.base}${pagePath}`, viewport, cookies: cookiesOf(world.adminJar, world.base), base: world.base });
    }
  }
  const findings = [];
  let next = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next]; next += 1;
      findings.push(...await checkPage(browser, job));
    }
  });
  await Promise.all(workers);
  await browser.close();
  world.server.close();

  findings.sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  fs.writeFileSync(path.join(__dirname, 'layout-rapport.json'), JSON.stringify(findings, null, 2));
  const problems = findings.filter((finding) => !finding.kind.startsWith('info-'));
  const keys = [...new Set(problems.map(keyOf))].sort();
  if (process.argv.includes('--update-baseline')) { fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(keys, null, 2)}\n`); console.log(`Baseline bijgewerkt: ${keys.length} bevindingen.`); return; }
  const baseline = new Set(fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : []);
  const fresh = problems.filter((finding) => !baseline.has(keyOf(finding)));
  console.log(`${jobs.length} paginaweergaven gecontroleerd; ${problems.length} bevindingen, ${fresh.length} nieuw t.o.v. de baseline.`);
  for (const finding of fresh) console.log(`${finding.role} | ${finding.viewport} | ${finding.page} | ${finding.kind} | ${finding.selector} | ${finding.detail}`);
  if (fresh.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(2); });
