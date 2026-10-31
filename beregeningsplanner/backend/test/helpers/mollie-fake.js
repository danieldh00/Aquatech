// Nagebootste Mollie API voor de tests van online betalen: betalingen aanmaken
// en opvragen zonder het netwerk te gebruiken. Een test zet de stand van een
// betaling met set() en laat daarna de webhook of de terugkeer van de klant lopen.

/**
 * Maakt de nagebootste Mollie.
 * @returns {{ fetchImpl: Function, payments: Map<string, object>, calls: object[], set: Function, down: { on: boolean } }} fetchImpl voor createApp({ mollieFetch }), de betalingen, alle aanroepen, set(id, status, extra) en down.on om Mollie onbereikbaar te maken.
 */
function createMollieFake() {
  const payments = new Map();
  const byKey = new Map();
  const calls = [];
  const down = { on: false };
  let counter = 0;

  /**
   * Maakt een antwoord zoals fetch het geeft.
   * @param {number} status De HTTP-status.
   * @param {object} payload De JSON-inhoud.
   * @returns {{ ok: boolean, status: number, json: Function }} Het antwoord.
   */
  const respond = (status, payload) => ({ ok: status < 300, status, json: async () => payload });

  /**
   * Doet alsof dit de Mollie API is.
   * @param {string} url Het adres.
   * @param {object} [init] Methode, koppen en inhoud.
   * @returns {Promise<object>} Het antwoord.
   */
  async function fetchImpl(url, init = {}) {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (down.on) throw new Error('verbinding verbroken');
    if (!String(init.headers.Authorization || '').startsWith('Bearer test_')) return respond(401, { title: 'Unauthorized Request', detail: 'Missing or invalid API key' });
    const apiPath = url.replace('https://api.mollie.com/v2', '');
    if (init.method === 'POST' && apiPath === '/payments') {
      const key = init.headers['Idempotency-Key'];
      if (key && byKey.has(key)) return respond(201, payments.get(byKey.get(key)));
      const body = JSON.parse(init.body);
      counter += 1;
      const id = `tr_test${String(counter).padStart(4, '0')}`;
      const payment = {
        id, status: 'open', mode: 'test', amount: body.amount, metadata: body.metadata, method: null, paidAt: null,
        redirectUrl: body.redirectUrl, webhookUrl: body.webhookUrl, _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } },
      };
      payments.set(id, payment);
      if (key) byKey.set(key, id);
      return respond(201, payment);
    }
    const match = apiPath.match(/^\/payments\/(tr_[A-Za-z0-9]+)$/);
    if (init.method === 'GET' && match) return payments.has(match[1]) ? respond(200, payments.get(match[1])) : respond(404, { title: 'Not Found', detail: 'No payment exists with token' });
    return respond(404, { title: 'Not Found', detail: 'Onbekend pad' });
  }

  /**
   * Zet een betaling op een nieuwe stand (bijvoorbeeld paid met methode ideal).
   * @param {string} id Het betaling-id.
   * @param {string} status De Mollie-status: paid, failed, canceled, expired of open.
   * @param {object} [extra] Andere velden (method, paidAt).
   * @returns {void}
   */
  function set(id, status, extra = {}) {
    const payment = payments.get(id);
    payment.status = status;
    if (status === 'paid') Object.assign(payment, { method: 'ideal', paidAt: new Date().toISOString() });
    Object.assign(payment, extra);
  }

  return { fetchImpl, payments, calls, set, down };
}

module.exports = { createMollieFake };
