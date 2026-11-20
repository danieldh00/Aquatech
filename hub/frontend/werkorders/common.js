// Werkorders: gedeelde hulpfuncties en de gedeelde toestand van de pagina
// (opmaak van getallen en datums, melding, API-aanroep, state). Zet alles op
// window.Werkorders.common; de andere werkorderscripts lezen het daar uit.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Formatteert een getal op z'n Nederlands.
   * @param {number} value het getal
   * @param {number} digits maximaal aantal decimalen (standaard 2)
   * @returns {string} bijv. '12,5'
   */
  const nl = (value, digits = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: digits });
  /**
   * Formatteert een bedrag in euro's.
   * @param {number} value het bedrag
   * @returns {string} bijv. '€ 12,50'
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Formatteert een datum voluit met weekdag.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. 'di 3 november 2026', of '–' zonder datum
   */
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  /**
   * Formatteert een datum kort.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. '3-11-2026', of leeg zonder datum
   */
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');
  /**
   * Formatteert een aantal uren.
   * @param {number} hourCount aantal uren
   * @returns {string} bijv. '2,5 u', of '–' zonder uren
   */
  const hours = (hourCount) => (hourCount ? `${nl(hourCount)} u` : '–');
  /**
   * Geeft de datum van vandaag (lokale tijd).
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const today = () => {
    const now = new Date();
    /**
     * Vult een getal aan tot twee cijfers.
     * @param {number} number het getal
     * @returns {string} bijv. '07'
     */
    const pad = (number) => String(number).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  /**
   * Geeft de plannerbibliotheken die nodig zijn om de zones uit een plan te halen.
   * @returns {{Catalog: object, Hydraulics: object}} de bibliotheken
   */
  const LIB = () => ({ Catalog: window.Catalog, Hydraulics: window.Hydraulics });
  const FINISHED = ['gereed', 'geannuleerd'];

  const state = {
    me: null, admin: false, staff: [], profile: null, documentLayout: null, mail: false,
    items: [], sort: { key: 'plannedDate', dir: 1 },
    workOrder: null, saveTimer: null, saving: null, dirty: false, warnings: [],
  };

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast screen show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast screen'; }, 3500);
  }

  /**
   * Roept de API aan en geeft de JSON terug. Met `offline` mag de wijziging zonder verbinding in de wachtrij (zie shared/offline.js); het antwoord is dan { queued: true }.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object, offline: object}} request methode, inhoud en eventueel de gegevens voor de offline wachtrij
   * @returns {Promise<object>} het antwoord (met cachedAt als het uit de offline cache komt); gooit een fout met code bij een foutstatus
   */
  async function api(url, { method = 'GET', body, offline } = {}) {
    const extra = offline && window.AquatechOffline ? window.AquatechOffline.headers(offline) : {};
    const response = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || AquatechCommon.statusMessage(response.status)), { code: result.error });
    // Zonder verbinding uit de offline cache: van wanneer de gegevens zijn.
    const cachedAt = response.headers.get('X-Aquatech-Cached-At');
    if (cachedAt && result && typeof result === 'object') Object.defineProperty(result, 'cachedAt', { value: cachedAt, enumerable: false });
    return result;
  }
  /**
   * Formatteert de tijd van een tijdstip.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} bijv. '14:05'
   */
  const clock = (iso) => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

  window.Werkorders = window.Werkorders || {};
  window.Werkorders.common = { $, esc, nl, eur, date, shortDate, hours, today, clock, LIB, FINISHED, state, toast, api };
})();
