/**
 * Rooktests na een uitrol: controleren alleen of de sleutelpagina's van de live omgeving laden.
 * Alles is alleen lezen; het enige wat wordt aangemaakt is een inlogsessie van het testaccount.
 * Ingelogde tests worden overgeslagen zonder SMOKE_USERNAME en SMOKE_PASSWORD.
 */
const { test, expect } = require('@playwright/test');

const username = process.env.SMOKE_USERNAME || '';
const password = process.env.SMOKE_PASSWORD || '';
const organization = process.env.SMOKE_ORG || '';
const expectedVersion = process.env.EXPECTED_VERSION || '';

/**
 * Verzamelt scriptfouten van de pagina zodat een test ze kan afkeuren.
 * @param {import('@playwright/test').Page} page De pagina om te volgen.
 * @returns {string[]} Lijst die zich vult met foutmeldingen.
 */
function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * Logt in via het inlogscherm (zo werkt ook de onzichtbare captcha) en wacht tot het dashboard er is.
 * @param {import('@playwright/test').Page} page De pagina om mee in te loggen.
 * @returns {Promise<void>} Klaar zodra de sessie bestaat.
 */
async function logIn(page) {
  await page.goto('app/login');
  if (organization && (await page.locator('#org').isVisible())) await page.locator('#org').fill(organization);
  await page.locator('#user').fill(username);
  await page.locator('#code').fill(password);
  await page.locator('#b').click();
  await expect(page.locator('#e')).toHaveText('', { timeout: 15000 }).catch(async () => {
    throw new Error(`Inloggen mislukt: ${await page.locator('#e').innerText()}`);
  });
  await page.waitForURL(/\/app\/(?!login)/, { timeout: 20000 });
}

test.describe('Openbaar', () => {
  test('gezondheidscontrole meldt de verwachte versie', async ({ request }) => {
    const response = await request.get('api/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.maintenance).toBe(false);
    if (expectedVersion) expect(body.version).toBe(expectedVersion);
  });

  test('webshop-startpagina laadt zonder scriptfouten', async ({ page }) => {
    const errors = collectPageErrors(page);
    const response = await page.goto('./');
    expect(response.status()).toBeLessThan(400);
    // Staat de webshop uit, dan stuurt `/` door naar de app; ook dat is een werkende pagina.
    await expect(page.locator('body')).not.toBeEmpty();
    expect(await page.title()).not.toBe('');
    expect(errors).toEqual([]);
  });

  test('een productpagina laadt', async ({ page }) => {
    await page.goto('./');
    const href = await page.locator('a[href*="/product/"]').first().getAttribute('href', { timeout: 5000 }).catch(() => null);
    test.skip(!href, 'Geen productlink op de startpagina (webshop uit of leeg).');
    const errors = collectPageErrors(page);
    const response = await page.goto(href);
    expect(response.status()).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('inlogpagina toont het formulier', async ({ page }) => {
    const response = await page.goto('app/login');
    expect(response.status()).toBe(200);
    await expect(page.locator('#user')).toBeVisible();
    await expect(page.locator('#code')).toBeVisible();
    await expect(page.locator('#b')).toBeEnabled();
  });
});

test.describe('Ingelogd (testaccount)', () => {
  test.skip(!username || !password, 'SMOKE_USERNAME en SMOKE_PASSWORD ontbreken: ingelogde rooktests overgeslagen.');

  test('dashboard en Beheer laden', async ({ page }) => {
    const errors = collectPageErrors(page);
    await logIn(page);

    const me = await page.request.get('app/api/me');
    expect(me.status()).toBe(200);

    const dashboard = await page.goto('app/');
    expect(dashboard.status()).toBe(200);
    await expect(page).not.toHaveURL(/login|wachtwoord/);
    await expect(page.locator('body')).not.toBeEmpty();

    const beheer = await page.goto('app/beheer/');
    expect(beheer.status()).toBe(200);
    await expect(page).toHaveURL(/\/app\/beheer\//);
    await expect(page.locator('body')).not.toBeEmpty();
    expect(errors).toEqual([]);
  });
});
