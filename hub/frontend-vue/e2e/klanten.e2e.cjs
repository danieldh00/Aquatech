// Gedragstest van de Vue-klantenmodule tegen de echte backend (via Vite op 5173): nieuw, wijzigen, zakelijk, groothandel, wissen (AVG), Excel-export, import, terugknop en foutmeldingen.
// Eerst e2e/seed.mjs en e2e/auth.cjs draaien. Eindigt met 'ALLES OK'.
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const fs = require('fs');
const VUE = 'http://127.0.0.1:5173/klanten/';
let failures = 0;
function check(name, ok, extra = '') { console.log(`${ok ? 'OK ' : 'FOUT'} ${name} ${ok ? '' : extra}`); if (!ok) failures += 1; }
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, storageState: '/tmp/state-vue.json' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  let lastWanted = '';
  const toastHas = async (text) => { await page.waitForFunction((wanted) => { const el = document.querySelector('#toast.show'); return el && el.textContent.includes(wanted); }, text, { timeout: 4000 }); return true; };

  // Nieuwe klant maken
  await page.goto(VUE); await page.waitForSelector('#k-table tbody tr');
  const count = await page.textContent('#k-count');
  check('lijst toont aantal', /van 5[7-9] klanten/.test(count) || /van \d+ klanten/.test(count), count);
  await page.click('#k-new'); await page.waitForSelector('#n-form');
  check('formulier focus op naam', await page.evaluate(() => document.activeElement && document.activeElement.name === 'displayName'));
  check('bedrijfsvelden verborgen bij particulier', await page.evaluate(() => [...document.querySelectorAll('[data-business]')].every((el) => el.hidden)));
  check('postcodezoeker staat boven het adresveld (alleen-lezen veld)', await page.evaluate(() => { const row = document.querySelector('#n-form .form-grid > .addr-lookup'); const field = document.querySelector('#n-form textarea'); return Boolean(row) && field.readOnly && row.nextElementSibling === field.closest('label'); }));
  await page.selectOption('[name=customerGroup]', 'zakelijk');
  check('bedrijfsvelden zichtbaar bij zakelijk', await page.evaluate(() => [...document.querySelectorAll('[data-business]')].every((el) => !el.hidden)));
  await page.fill('[name=vatNumber]', 'DE123456789');
  check('buitenlands btw zet adres op handmatig', await page.evaluate(() => document.querySelector('#n-form textarea').dataset.addressManual === '1'));
  await page.fill('[name=vatNumber]', 'NL123456789B01');
  check('NL btw haalt handmatig weg', await page.evaluate(() => document.querySelector('#n-form textarea').dataset.addressManual === undefined));
  await page.selectOption('[name=customerGroup]', '');
  await page.fill('[name=displayName]', 'E2E Proefklant');
  await page.fill('[name=email]', `e2e-${Date.now()}@example.nl`);
  await page.click('#n-form button[type=submit]');
  console.log('n-err:', await page.textContent('#n-err').catch(() => ''));
  check('toast na opslaan', await toastHas('Klant opgeslagen'));
  await page.waitForSelector('#c-contact');
  const url = new URL(page.url());
  check('detailadres ?id=', url.searchParams.has('id'), page.url());
  const id = url.searchParams.get('id');
  check('titel', (await page.title()) === 'E2E Proefklant – Klanten – AquaTech Hub', await page.title());

  // Contactgegevens wijzigen
  await page.fill('#c-contact [name=phone]', '0612345678');
  await page.fill('#c-contact [name=paymentDays]', '45');
  await page.click('#c-contact button[type=submit]');
  check('toast gegevens', await toastHas('Gegevens opgeslagen'));
  await page.reload(); await page.waitForSelector('#c-contact');
  check('telefoon bewaard', (await page.inputValue('#c-contact [name=phone]')) === '0612345678');
  check('betaaltermijn bewaard', (await page.inputValue('#c-contact [name=paymentDays]')) === '45');

  // Foutmelding bij ongeldige invoer
  await page.fill('#c-contact [name=email]', 'geen-email@@');
  await page.evaluate(() => { document.querySelector('#c-contact [name=email]').type = 'text'; });
  await page.click('#c-contact button[type=submit]');
  await page.waitForTimeout(800);
  const err = await page.textContent('#c-contact-err');
  check('serverfout zichtbaar op de kaart', err.length > 0, 'leeg');

  // Zakelijk maken
  await page.reload(); await page.waitForSelector('#c-business');
  check('bedrijfsvelden verborgen in kaart', await page.evaluate(() => [...document.querySelectorAll('#c-business [data-business]')].every((el) => el.hidden)));
  await page.selectOption('#c-business [name=customerGroup]', 'zakelijk');
  check('bedrijfsvelden zichtbaar na keuze', await page.evaluate(() => [...document.querySelectorAll('#c-business [data-business]')].every((el) => !el.hidden)));
  check('korting verborgen zonder groothandel', await page.evaluate(() => document.querySelector('[data-wholesale]').hidden));
  await page.check('#c-business [name=wholesale]');
  check('korting zichtbaar met groothandel', await page.evaluate(() => !document.querySelector('[data-wholesale]').hidden));
  await page.fill('#c-business [name=companyName]', 'E2E BV');
  await page.fill('#c-business [name=kvkNumber]', '12345678');
  await page.fill('#c-business [name=wholesaleDiscount]', '12.5');
  await page.click('#c-business button[type=submit]');
  check('toast opgeslagen', await toastHas('Opgeslagen'));
  await page.reload(); await page.waitForSelector('#c-business');
  check('groothandel bewaard', await page.isChecked('#c-business [name=wholesale]'));
  check('pillen zakelijk + groothandel', (await page.textContent('.klant-title')).includes('Zakelijk') && (await page.textContent('.klant-title')).includes('Groothandel'));

  // Uitnodigen kan niet zonder mail en webadres: knop uit met uitleg ernaast
  check('uitnodigen uit met uitleg', (await page.isDisabled('[data-invite]')) && (await page.textContent('.card:has([data-invite]) .form-actions')).length > 25, await page.textContent('.card:has([data-invite]) .form-actions'));

  // Wissen (AVG)
  const eraseBtn = '[data-erase]';
  check('wisknop uit', await page.isDisabled(eraseBtn));
  await page.fill('#c-erase-confirm', 'E2E Proefklant');
  check('wisknop nog uit zonder wachtwoord', await page.isDisabled(eraseBtn));
  await page.fill('#c-erase-password', 'Tuin-Plan-2026!');
  check('wisknop aan', !(await page.isDisabled(eraseBtn)));
  await page.click(eraseBtn);
  check('toast gewist', await toastHas('Persoonsgegevens gewist'));
  await page.waitForSelector('text=Deze klant is gewist.');
  check('klant gewist getoond', true);

  // Excel-export
  await page.goto(VUE); await page.waitForSelector('#k-table tbody tr');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#k-export')]);
  const file = await download.path();
  const size = fs.statSync(file).size;
  check('export is xlsx (zip) met inhoud', download.suggestedFilename() === 'klanten.xlsx' && size > 3000 && fs.readFileSync(file).subarray(0, 2).toString() === 'PK', `${download.suggestedFilename()} ${size}`);

  // Importvenster van de schil
  await page.goto(VUE); await page.waitForSelector('#k-table tbody tr');
  await page.click('#k-import'); await page.waitForSelector('.xi-overlay');
  check('importvenster opent', (await page.textContent('.xi-panel h2')) === 'Klanten importeren uit Excel');
  await page.click('[data-xi=close]');

  // Terugknop en directe link
  await page.goto(`${VUE}?id=${id}`); await page.waitForSelector('#c-contact');
  await page.click('#d-back'); await page.waitForSelector('#k-table tbody tr');
  check('terug naar lijst zonder ?id', !new URL(page.url()).searchParams.has('id'));
  await page.goBack(); await page.waitForSelector('#c-contact');
  check('browser-terug opent kaart weer', new URL(page.url()).searchParams.get('id') === id);
  await page.goto(`${VUE}?id=00000000-0000-4000-8000-000000000000`); await page.waitForSelector('.notice');
  check('onbekende klant toont melding met terug-link', (await page.textContent('.notice')).includes('Terug naar de klanten'), await page.textContent('.notice'));

  // Rij aanklikken en ctrl-klik
  await page.goto(VUE); await page.waitForSelector('#k-table tbody tr');
  await page.click('#k-table tbody tr:first-child td:nth-child(4)');
  await page.waitForSelector('#c-contact');
  check('klik op regel opent kaart', new URL(page.url()).searchParams.has('id'));
  const unexpected = errors.filter((text) => !/status of (400|404)/.test(text));
  check('geen onverwachte consolefouten (400/404 uit de test zelf genegeerd)', unexpected.length === 0, unexpected.join(' | '));
  console.log(failures ? `\n${failures} FOUT(EN)` : '\nALLES OK');
  await browser.close();
})();
