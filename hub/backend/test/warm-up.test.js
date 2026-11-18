// Opwarmen van de webshop na het starten: welke pagina's, in welke volgorde, en dat een fout niets stopt.
const test = require('node:test');
const assert = require('node:assert');
const { warmShop, linksOf } = require('../src/webshop/warm-up');

const HOME = '<a href="groep/beregening/">A</a><a href="./categorie/slangen/">B</a><a href="product/druppelslang-16/">C</a><a href="groep/beregening/">dubbel</a><a href="https://elders.nl/groep/x/">extern</a>';

test('linksOf: groepen, categorieën en producten uit de startpagina, zonder dubbele en zonder externe adressen', () => {
  assert.deepStrictEqual(linksOf(HOME), ['/groep/beregening/', '/categorie/slangen/', '/product/druppelslang-16/']);
});

test('warmShop: eerst de startpagina, dan winkelwagen en de gevonden pagina\'s, één voor één', async () => {
  const asked = [];
  let running = 0;
  let maxRunning = 0;
  /**
   * Nep-fetch die telt hoeveel aanroepen tegelijk lopen.
   * @param {string} url Het adres.
   * @returns {Promise<{ status: number, text: Function }>} Het antwoord.
   */
  const fetchImpl = async (url) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    asked.push(url);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    return { status: 200, text: async () => (url.endsWith(':3300/') ? HOME : '') };
  };
  const visited = await warmShop({ baseUrl: 'http://127.0.0.1:3300', fetchImpl });
  assert.deepStrictEqual(visited, ['/', '/winkelwagen/', '/groep/beregening/', '/categorie/slangen/', '/product/druppelslang-16/']);
  assert.strictEqual(maxRunning, 1);
});

test('warmShop: een shop die uit staat (404) of een fout stopt zonder gooien', async () => {
  assert.deepStrictEqual(await warmShop({ baseUrl: 'http://x', fetchImpl: async () => ({ status: 404, text: async () => 'Niet gevonden.' }) }), []);
  assert.deepStrictEqual(await warmShop({ baseUrl: 'http://x', fetchImpl: async () => ({ status: 302, text: async () => '' }) }), [], 'een doorverwijzing (shop uit) telt niet als opgewarmd');
  const logged = [];
  const visited = await warmShop({ baseUrl: 'http://x', fetchImpl: async () => { throw new Error('verbinding geweigerd'); }, log: (message) => logged.push(message) });
  assert.deepStrictEqual(visited, []);
  assert.match(logged[0], /verbinding geweigerd/);
});
