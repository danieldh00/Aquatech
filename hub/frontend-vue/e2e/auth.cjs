// Logt één keer in op de oude app (poort 3300) en op de Vue-ontwikkelserver (poort 5173) en bewaart de cookies in /tmp/state-oud.json en /tmp/state-vue.json.
// Playwright staat in de cloud-sandbox globaal; lokaal: npm i -g playwright.
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
(async () => {
  const browser = await chromium.launch();
  const states = {};
  for (const [name, url] of [['oud', 'http://127.0.0.1:3300/app/api/auth/login'], ['vue', 'http://127.0.0.1:5173/api/auth/login']]) {
    const context = await browser.newContext();
    const res = await context.request.post(url, { data: { username: 'baas', password: 'Tuin-Plan-2026!' } });
    console.log(name, res.status());
    await context.storageState({ path: `/tmp/state-${name}.json` });
    const page = await context.newPage();
    await page.goto(url.replace('api/auth/login', name === 'oud' ? '' : 'klanten/'));
    console.log(name, 'rechten', await page.evaluate(async () => JSON.stringify((await (await fetch('../api/me')).json()).rights)));
    await context.close();
  }
  await browser.close();
})();
