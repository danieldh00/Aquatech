// Nagebootst Google reCAPTCHA voor de tests: `fetchImpl` vervangt de aanroep naar siteverify. Een token heeft de vorm
// `mens:<actie>:<score>` (dat is wat de "browser" in de tests meegeeft); elk token telt één keer, zoals bij Google.

/** Het geheim dat de nagebootste Google kent. */
const SECRET = 'geheim-van-de-test-0123456789abcdef';
/** Een sitesleutel in het formaat van reCAPTCHA (40 tekens, begint met 6L). */
const SITE_KEY = '6LtestSleutelVoorDeTests0123456789abcdef';

/**
 * Maakt de nagebootste Google.
 * @returns {{ fetchImpl: Function, calls: object[], mode: { value: string }, token: Function }} fetchImpl voor createApp({ captchaFetch }), de ontvangen
 *   aanroepen, de stand (ok | offline | fout500 | rommel) en een hulp die een geldig token maakt.
 */
function createCaptchaFake() {
  const calls = [];
  const used = new Set();
  const mode = { value: 'ok' };

  /**
   * Antwoordt zoals siteverify van Google.
   * @param {string} url Het adres.
   * @param {{ body: string }} init De aanvraag (formulier).
   * @returns {Promise<{ ok: boolean, status: number, json: Function }>} Het antwoord.
   */
  async function fetchImpl(url, init) {
    const form = new URLSearchParams(init.body);
    calls.push({ url, secret: form.get('secret'), response: form.get('response'), remoteip: form.get('remoteip') });
    if (mode.value === 'offline') throw new Error('ECONNREFUSED');
    if (mode.value === 'fout500') return { ok: false, status: 500, json: async () => ({}) };
    if (mode.value === 'rommel') return { ok: true, status: 200, json: async () => { throw new Error('geen json'); } };
    /**
     * Een antwoord met gegevens.
     * @param {object} body De gegevens.
     * @returns {{ ok: boolean, status: number, json: Function }} Het antwoord.
     */
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (form.get('secret') !== SECRET) return reply({ success: false, 'error-codes': ['invalid-input-secret'] });
    const token = form.get('response') || '';
    const [kind, action, score] = token.split(':');
    if (kind !== 'mens') return reply({ success: false, 'error-codes': ['invalid-input-response'] });
    if (used.has(token)) return reply({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    used.add(token);
    return reply({ success: true, score: Number(score), action, hostname: 'winkel.example', challenge_ts: new Date().toISOString() });
  }

  let counter = 0;
  /**
   * Een geldig, nog ongebruikt token.
   * @param {string} action De actie waarvoor het token is gevraagd.
   * @param {number} [score] De score die Google eraan hangt.
   * @returns {string} Het token.
   */
  const token = (action, score = 0.9) => { counter += 1; return `mens:${action}:${score}:${counter}`; };

  return { fetchImpl, calls, mode, token };
}

module.exports = { createCaptchaFake, SECRET, SITE_KEY };
