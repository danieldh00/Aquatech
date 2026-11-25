// Vergelijkt de oude klantenpagina (poort 3300) met de Vue-pagina (poort 5173): per weergave en per schermbreedte (1440 en 375 px) dezelfde elementen, klassen, teksten, hidden-vlaggen en afmetingen (max. 1 px verschil).
// Eerst e2e/seed.mjs en e2e/auth.cjs draaien. Eindigt met 'TOTAAL verschillen: 0' als de Vue-module pixelgelijk is.
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const LEGACY = 'http://127.0.0.1:3300/app/klanten/';
const VUE = 'http://127.0.0.1:5173/klanten/';
const PASSWORD = 'Tuin-Plan-2026!';

/** Genormaliseerde lijst van elementen onder een selector: pad, klassen, tekst, hidden en afmetingen. */
async function snapshot(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out = [];
    const walk = (el, depth) => {
      const rect = el.getBoundingClientRect();
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
      const classes = [...el.classList].sort().join('.');
      out.push({ depth, tag: el.tagName.toLowerCase(), id: (el.id || '').replace(/^address-status-\d+$/, 'address-status'), classes, hidden: el.hidden, text: own, disabled: el.disabled === true, href: el.getAttribute('href') || '',
        w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.left), y: Math.round(rect.top) });
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return out;
  }, selector);
}

/** Vergelijkt twee snapshots; geeft verschillen terug. */
function diff(a, b, label) {
  const problems = [];
  if (!a || !b) return [`${label}: ontbreekt (${a ? 'oud ok' : 'oud mist'}, ${b ? 'vue ok' : 'vue mist'})`];
  const sameLen = a.length === b.length;
  if (!sameLen) problems.push(`${label}: aantal elementen ${a.length} vs ${b.length}`);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index]; const right = b[index];
    const keys = ['depth', 'tag', 'id', 'classes', 'hidden', 'text', 'disabled', 'href'];
    const bad = keys.filter((key) => left[key] !== right[key]);
    const geo = ['w', 'h', 'x', 'y'].filter((key) => Math.abs(left[key] - right[key]) > 1);
    if (bad.length || geo.length) {
      problems.push(`${label} #${index} <${left.tag}.${left.classes}#${left.id}>: ${bad.map((key) => `${key}: "${left[key]}" vs "${right[key]}"`).join('; ')} ${geo.map((key) => `${key}: ${left[key]} vs ${right[key]}`).join(', ')}`);
      if (problems.length > 25) break;
    }
  }
  return problems;
}

async function login(context, base) {
  const origin = new URL(base).origin;
  const res = await context.request.post(`${origin}/${origin.endsWith('3300') ? 'app/' : ''}api/auth/login`, { data: { username: 'baas', password: PASSWORD } });
  if (!res.ok()) throw new Error(`login ${origin} ${res.status()}`);
}

(async () => {
  const browser = await chromium.launch();
  const ids = JSON.parse(require('fs').readFileSync('/tmp/ids.json', 'utf8'));
  let total = 0;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    const results = {};
    for (const [name, url] of [['oud', LEGACY], ['vue', VUE]]) {
      const context = await browser.newContext({ viewport, storageState: `/tmp/state-${name}.json` });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      const snaps = {};
      await page.goto(url); await page.waitForSelector('#k-table tbody tr'); await page.waitForTimeout(500);
      snaps.list = await snapshot(page, '#list-view');
      snaps.listOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      snaps.topbar = await snapshot(page, '.topbar');
      snaps.nav = await snapshot(page, 'nav');
      // zoeken
      await page.fill('#k-search', 'Klant 1'); await page.waitForTimeout(900);
      snaps.search = await snapshot(page, '#list-view');
      await page.fill('#k-search', ''); await page.waitForTimeout(900);
      await page.selectOption('#k-group', 'zakelijk'); await page.waitForTimeout(700);
      snaps.group = await snapshot(page, '#list-view');
      await page.selectOption('#k-group', ''); await page.waitForTimeout(700);
      await page.click('#k-next'); await page.waitForTimeout(700);
      snaps.page2 = await snapshot(page, '#list-view');
      // nieuw
      await page.click('#k-new'); await page.waitForSelector('#n-form');
      snaps.newParticulier = await snapshot(page, '#new-view');
      await page.selectOption('#n-form [name=customerGroup]', 'zakelijk');
      snaps.newZakelijk = await snapshot(page, '#new-view');
      snaps.newUrl = new URL(page.url()).search;
      await page.goBack(); await page.waitForTimeout(800);
      snaps.afterBack = await snapshot(page, '#list-view');
      // detail
      await page.goto(`${url}?id=${ids[4]}`); await page.waitForSelector('#c-contact'); await page.waitForTimeout(1200);
      snaps.detail = await snapshot(page, '#detail-view');
      snaps.detailTitle = await page.title();
      snaps.detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.goto(`${url}?id=${ids[0]}`); await page.waitForSelector('#c-contact'); await page.waitForTimeout(1200);
      snaps.detailPart = await snapshot(page, '#detail-view');
      snaps.errors = errors;
      results[name] = snaps;
      await context.close();
    }
    console.log(`\n=== ${viewport.width}px ===`);
    for (const key of Object.keys(results.oud)) {
      if (['listOverflow', 'detailOverflow', 'newUrl', 'detailTitle'].includes(key)) {
        console.log(key, results.oud[key], 'vs', results.vue[key], results.oud[key] === results.vue[key] ? 'OK' : 'VERSCHIL');
        if (results.oud[key] !== results.vue[key]) total += 1;
        continue;
      }
      if (key === 'errors') { console.log('console-fouten oud:', results.oud.errors, 'vue:', results.vue.errors); continue; }
      const problems = diff(results.oud[key], results.vue[key], key);
      console.log(key, problems.length ? `${problems.length} VERSCHILLEN` : `OK (${(results.oud[key] || []).length} elementen)`);
      problems.slice(0, 12).forEach((line) => console.log('   ', line));
      total += problems.length;
    }
  }
  console.log('\nTOTAAL verschillen:', total);
  await browser.close();
})();
