// Adres invullen bij postcode + huisnummer (PDOK-gegevens via onze eigen server).
// Eén gedeelde component voor de hele app en de webshop:
// - AddressLookup.attach({...}): koppelt drie invoervelden (postcode, huisnummer,
//   toevoeging) aan het opzoeken; ook voor het afrekenformulier van de shop.
// - AddressLookup.enhance(veld): zet boven een adresveld (textarea of input) een
//   rijtje Postcode / Huisnr. / Toev. en vult het veld bij een treffer.
// - Elk element met data-address-lookup wordt automatisch uitgebreid.
// Het veld blijft altijd handmatig te bewerken; bij een storing of geen treffer
// staat er een melding en verandert er niets aan wat al is ingevuld.
(function (root) {
  /** Wachttijd na de laatste toetsaanslag voordat er wordt opgezocht (ms). */
  const DEBOUNCE_MS = 400;
  /** Standaardadres van de opzoek-API, relatief aan de pagina. */
  const DEFAULT_ENDPOINT = 'api/address-lookup';
  /** Teller voor unieke id's van de meldingen. */
  let counter = 0;

  /**
   * Controleert een Nederlandse postcode en zet hem in de gewone schrijfwijze.
   * @param {*} value Wat de gebruiker intikte, bijvoorbeeld "1234ab".
   * @returns {string} "1234 AB", of een lege tekst als het geen geldige postcode is.
   */
  function parsePostcode(value) {
    const compact = String(value || '').replace(/\s+/g, '').toUpperCase();
    return /^[1-9]\d{3}(?!SA|SD|SS)[A-Z]{2}$/.test(compact) ? `${compact.slice(0, 4)} ${compact.slice(4)}` : '';
  }

  /**
   * Controleert een huisnummer.
   * @param {*} value Wat de gebruiker intikte.
   * @returns {string} Het huisnummer als cijfers, of een lege tekst als het geen geldig huisnummer is.
   */
  function parseHouseNumber(value) {
    const text = String(value || '').trim();
    return /^\d{1,5}$/.test(text) && Number(text) > 0 ? String(Number(text)) : '';
  }

  /**
   * Zet straat, huisnummer en toevoeging op één regel.
   * @param {{ street: string, houseNumber: string, suffix?: string }} address Een gevonden adres.
   * @returns {string} Bijvoorbeeld "Kerkstraat 12A".
   */
  function streetLine(address) {
    return `${address.street} ${address.houseNumber}${address.suffix || ''}`;
  }

  /**
   * Zet een gevonden adres op papier: straatregel en daaronder postcode en plaats.
   * @param {{ street: string, houseNumber: string, suffix?: string, postcode: string, city: string }} address Een gevonden adres.
   * @param {string} separator Wat tussen de twee regels komt ("\n" voor een tekstvak, ", " voor een enkele regel).
   * @returns {string} Bijvoorbeeld "Kerkstraat 12A\n1234 AB Plaats".
   */
  function fullAddress(address, separator) {
    return `${streetLine(address)}${separator}${address.postcode} ${address.city}`;
  }

  /**
   * Koppelt drie invoervelden aan het opzoeken van een adres. Zodra postcode en huisnummer geldig zijn
   * (na een korte pauze in het typen) wordt het adres opgevraagd; een oudere vraag wordt afgebroken.
   * @param {{ postcodeInput: HTMLInputElement, numberInput: HTMLInputElement, suffixInput?: HTMLInputElement, statusElement: HTMLElement, endpoint?: string, isActive?: Function, onFound: Function, fetchImpl?: Function }} options De velden, het element voor de melding, het adres van de API, isActive() = of er nu opgezocht mag worden (bijvoorbeeld alleen voor Nederland), onFound(adres) = wat er met een treffer gebeurt en fetchImpl (alleen voor tests).
   * @returns {{ check: Function, reset: Function }} check() zoekt meteen op (zonder pauze); reset() vergeet de laatste treffer.
   */
  function attach({ postcodeInput, numberInput, suffixInput = null, statusElement, endpoint = DEFAULT_ENDPOINT, isActive = () => true, onFound, fetchImpl = (...args) => fetch(...args) }) {
    let timer = null;
    let controller = null;
    let sequence = 0;
    // Laatste opgezochte combinatie: dezelfde invoer vult het adres niet nog eens in (een handmatige aanpassing blijft staan).
    let lastKey = '';
    let lastMessage = { text: '', kind: '' };
    // Combinatie waarvoor nu een vraag onderweg is, zodat bijvoorbeeld de blur direct na de pauze niet nog een vraag stuurt.
    let inFlightKey = '';

    /**
     * Toont een melding bij de velden.
     * @param {string} text De melding (leeg = niets tonen).
     * @param {'ok'|'error'|''} kind Soort melding, voor de kleur.
     * @returns {void}
     */
    function say(text, kind = '') {
      statusElement.textContent = text;
      statusElement.dataset.kind = kind;
    }

    /**
     * Toont een melding en onthoudt hem, zodat hij terugkomt als dezelfde invoer nog eens wordt gecontroleerd.
     * @param {string} text De melding.
     * @param {'ok'|'error'|''} kind Soort melding.
     * @returns {void}
     */
    function settle(text, kind = '') {
      lastMessage = { text, kind };
      say(text, kind);
    }

    /**
     * Vraagt het adres op en geeft een treffer door aan onFound.
     * @returns {Promise<void>} Klaar als de melding is getoond.
     */
    async function lookup() {
      if (!isActive()) { say(''); return; }
      const postcode = parsePostcode(postcodeInput.value);
      const houseNumber = parseHouseNumber(numberInput.value);
      if (!postcode || !houseNumber) {
        const typed = postcodeInput.value.replace(/\s+/g, '');
        if (typed.length >= 6 && !postcode) say('Controleer de postcode: die bestaat uit vier cijfers en twee letters, bijvoorbeeld 1234 AB.', 'error');
        else say('');
        return;
      }
      const key = `${postcode}|${houseNumber}|${suffixInput ? suffixInput.value.trim().toUpperCase() : ''}`;
      if (key === lastKey) { say(lastMessage.text, lastMessage.kind); return; }
      if (key === inFlightKey) return;
      inFlightKey = key;
      if (controller) controller.abort();
      controller = new AbortController();
      const mine = ++sequence;
      say('Adres opzoeken…');
      const query = new URLSearchParams({ postcode, huisnummer: houseNumber, toevoeging: suffixInput ? suffixInput.value : '' });
      try {
        const response = await fetchImpl(`${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`, { signal: controller.signal, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (mine !== sequence) return;
        if (response.status === 400) { settle('Controleer de postcode en het huisnummer.', 'error'); return; }
        if (!response.ok) throw new Error(`status ${response.status}`);
        const address = await response.json();
        if (mine !== sequence) return;
        if (!address.found) { settle('Geen adres gevonden bij deze postcode en dit huisnummer. Controleer de invoer of vul het adres zelf in.', 'error'); return; }
        lastKey = key;
        onFound(address);
        const typedSuffix = suffixInput ? suffixInput.value.trim() : '';
        let note = '';
        if (address.suffixRequired) note = ' Bij dit huisnummer hoort een toevoeging (bijvoorbeeld A); vul die in.';
        else if (typedSuffix && address.suffixMatched === false) note = ` De toevoeging "${typedSuffix}" komt niet voor bij dit huisnummer; controleer die.`;
        settle(`Adres ingevuld: ${fullAddress(address, ', ')}.${note}`, note ? 'error' : 'ok');
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (mine !== sequence) return;
        settle('Het adres kon nu niet worden opgezocht. Vul het adres zelf in.', 'error');
      } finally {
        if (mine === sequence) inFlightKey = '';
      }
    }

    /**
     * Plant een opzoeking na een korte pauze in het typen.
     * @returns {void}
     */
    function schedule() {
      clearTimeout(timer);
      sequence += 1;
      if (controller) controller.abort();
      inFlightKey = '';
      timer = setTimeout(lookup, DEBOUNCE_MS);
    }

    for (const input of [postcodeInput, numberInput, suffixInput]) {
      if (!input) continue;
      input.addEventListener('input', schedule);
      input.addEventListener('blur', () => { clearTimeout(timer); lookup(); });
    }
    /**
     * Vergeet de laatste treffer, zodat dezelfde invoer opnieuw wordt opgezocht (nadat het adresveld is leeggemaakt of gewijzigd).
     * @returns {void}
     */
    function reset() {
      lastKey = '';
    }

    return { check: lookup, reset };
  }

  /**
   * Zet de opmaak van het rijtje één keer in de pagina (met kleuren uit de huisstijl).
   * @returns {void}
   */
  function injectStyles() {
    if (document.getElementById('address-lookup-style')) return;
    const style = document.createElement('style');
    style.id = 'address-lookup-style';
    style.textContent = `
.addr-lookup { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin: 0 0 8px; }
.addr-lookup label { display: grid; gap: 4px; font-size: 0.85rem; }
.addr-lookup input { min-width: 0; }
.addr-lookup .addr-status { grid-column: 1 / -1; margin: 0; font-size: 0.85rem; min-height: 1.2em; opacity: 0.85; }
.addr-lookup .addr-status[data-kind="ok"] { color: var(--at-green-dark); opacity: 1; }
.addr-lookup .addr-status[data-kind="error"] { color: var(--at-danger); opacity: 1; }
.addr-lookup[hidden] { display: none; }`;
    document.head.appendChild(style);
  }

  /**
   * Zet boven een adresveld een rijtje Postcode / Huisnr. / Toev. en vult het veld bij een treffer.
   * @param {HTMLTextAreaElement|HTMLInputElement} field Het adresveld (bij een textarea komen straat en postcode/plaats op twee regels).
   * @param {{ endpoint?: string, fetchImpl?: Function }} [options] endpoint = adres van de API, fetchImpl alleen voor tests.
   * @returns {HTMLElement|null} Het toegevoegde rijtje, of niets als het veld al is uitgebreid of niet bestaat.
   */
  function enhance(field, { endpoint = DEFAULT_ENDPOINT, fetchImpl } = {}) {
    if (!field || field.dataset.addressEnhanced) return null;
    field.dataset.addressEnhanced = '1';
    injectStyles();
    const label = field.closest('label') || field;
    // Staat het veld naast andere velden in een rij, dan komt het rijtje boven die hele rij.
    const anchor = label.parentNode && label.parentNode.classList && label.parentNode.classList.contains('row') ? label.parentNode : label;
    const group = document.createElement('div');
    group.className = 'addr-lookup';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Adres opzoeken met postcode en huisnummer');
    group.innerHTML = `
      <label>Postcode<input type="text" maxlength="7" autocomplete="off" placeholder="1234 AB" spellcheck="false"></label>
      <label>Huisnr.<input type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="12"></label>
      <label>Toev.<input type="text" maxlength="6" autocomplete="off" placeholder="A"></label>
      <p class="addr-status" role="status" aria-live="polite"></p>`;
    const [postcodeInput, numberInput, suffixInput] = group.querySelectorAll('input');
    const statusElement = group.querySelector('.addr-status');
    counter += 1;
    statusElement.id = `address-status-${counter}`;
    for (const input of [postcodeInput, numberInput, suffixInput]) input.setAttribute('aria-describedby', statusElement.id);
    anchor.parentNode.insertBefore(group, anchor);
    const separator = field.tagName === 'TEXTAREA' ? '\n' : ', ';
    /**
     * Of het adresveld nu te bewerken is (ook niet via een uitgeschakelde fieldset eromheen).
     * @returns {boolean} true als er ingevuld mag worden.
     */
    const isEditable = () => !field.matches(':disabled') && !field.readOnly;
    let filling = false;
    const lookup = attach({
      postcodeInput, numberInput, suffixInput, statusElement, endpoint, fetchImpl,
      isActive: isEditable,
      onFound: (address) => {
        filling = true;
        field.value = fullAddress(address, separator);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        filling = false;
      },
    });
    // Past iemand het adresveld zelf aan (of wordt het door de pagina gevuld), dan mag dezelfde postcode en hetzelfde huisnummer opnieuw invullen.
    field.addEventListener('input', () => { if (!filling) lookup.reset(); });
    /**
     * Verbergt het rijtje zolang het adresveld niet te bewerken is (bijvoorbeeld een vergrendelde factuur).
     * @returns {void}
     */
    const syncEditable = () => { group.hidden = !isEditable(); };
    syncEditable();
    const observer = new MutationObserver(syncEditable);
    observer.observe(field, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
    const fieldset = field.closest('fieldset');
    if (fieldset) observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] });
    return group;
  }

  /**
   * Breidt alle adresvelden met data-address-lookup uit.
   * @param {ParentNode} [scope] Waar gezocht wordt (standaard het hele document).
   * @returns {void}
   */
  function enhanceAll(scope = document) {
    for (const field of scope.querySelectorAll('textarea[data-address-lookup], input[data-address-lookup]')) enhance(field);
  }

  const api = { parsePostcode, parseHouseNumber, streetLine, fullAddress, attach, enhance, enhanceAll };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AddressLookup = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhanceAll());
  else enhanceAll();
})(typeof window !== 'undefined' ? window : globalThis);
