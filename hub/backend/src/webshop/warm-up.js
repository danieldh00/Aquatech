// Opwarmen van de webshop (de User-Agent bevat 'bot', zodat de koopfunnel deze aanroepen niet meetelt) na het starten: een paar interne aanroepen van de belangrijkste pagina's, zodat de
// catalogus en de omschrijvingen al in het geheugen staan voordat de eerste bezoeker komt (zonder opwarmen kost
// die bezoeker na elke uitrol 1 tot 3 seconden extra). Er wordt niets bewaard behalve wat de pagina's zelf cachen.

/** Pagina's die altijd worden opgewarmd (relatief aan de hoofdmap van de shop). */
const FIXED_PATHS = ['/', '/winkelwagen/'];
/** Hoogstens zoveel groepen/categorieën en productpagina's uit de startpagina erbij. */
const MAX_LISTINGS = 6;
const MAX_PRODUCTS = 6;

/**
 * Haalt de adressen van groepen, categorieën en producten uit de HTML van de startpagina.
 * @param {string} html De HTML van de startpagina.
 * @returns {string[]} Adressen die met een schuine streep beginnen, zonder dubbele.
 */
function linksOf(html) {
  const listings = [];
  const products = [];
  for (const match of String(html).matchAll(/href="(?:\.\/)?((?:groep|categorie|product)\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/)"/gi)) {
    const target = `/${match[1]}`;
    const list = target.startsWith('/product/') ? products : listings;
    if (!list.includes(target)) list.push(target);
  }
  return [...listings.slice(0, MAX_LISTINGS), ...products.slice(0, MAX_PRODUCTS)];
}

/**
 * Roept de belangrijkste shoppagina's één voor één aan (nooit tegelijk, zodat het opwarmen zelf niemand ophoudt).
 * Een fout bij één pagina stopt het opwarmen niet.
 * @param {{ baseUrl: string, fetchImpl?: Function, log?: Function }} options baseUrl = het interne adres van de app (met poort); fetchImpl = fetch (voor tests); log = meldingen.
 * @returns {Promise<string[]>} De aangeroepen adressen.
 */
async function warmShop({ baseUrl, fetchImpl = fetch, log = () => {} }) {
  const visited = [];
  /**
   * Haalt één pagina op en leest hem uit.
   * @param {string} target Het adres met beginnende schuine streep.
   * @returns {Promise<string>} De HTML, of een lege tekst bij een fout of niet-200.
   */
  const get = async (target) => {
    try {
      const response = await fetchImpl(`${baseUrl}${target}`, { headers: { 'User-Agent': 'AquaTech-warmup-bot' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      // Alleen een echte pagina telt (een uitgeschakelde shop stuurt door naar de app).
      if (response.status !== 200) return '';
      visited.push(target);
      return await response.text();
    } catch (error) {
      log(`Opwarmen van ${target} mislukt: ${error.message}`);
      return '';
    }
  };
  const home = await get(FIXED_PATHS[0]);
  if (!home) return visited;
  for (const target of [...FIXED_PATHS.slice(1), ...linksOf(home)]) await get(target);
  return visited;
}

module.exports = { warmShop, linksOf };
