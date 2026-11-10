// Afrekenen in de eigen webshop: bij een andere verzendmethode, een ander land of
// een btw-nummer meteen het overzicht en het totaal bijwerken (op de achtergrond),
// zodat één klik op Bestelling plaatsen genoeg is. Zonder dit script werkt de
// knop Totaal bijwerken (een gewone formulierverzending) nog steeds.

/**
 * Zet de tekst van een onderdeel van het overzicht, als dat onderdeel er is.
 * @param {string} selector Selector van het onderdeel.
 * @param {string} text De nieuwe tekst.
 * @returns {void}
 */
function setText(selector, text) {
  const element = document.querySelector(selector);
  if (element) element.textContent = text;
}

/**
 * Werkt het overzicht en het verwachte totaal bij voor de gekozen verzendmethode.
 * @param {HTMLInputElement} radio Het gekozen keuzerondje met de berekende gegevens.
 * @returns {void}
 */
function showChosenShipping(radio) {
  if (!radio.dataset.total) return;
  const shippingRow = document.querySelector('[data-ship-row]');
  if (shippingRow) shippingRow.hidden = false;
  setText('[data-ship-label]', radio.dataset.shipLabel);
  setText('[data-ship-price]', radio.dataset.shipPrice);
  setText('[data-total-caption]', radio.dataset.totalCaption);
  setText('[data-total-text]', radio.dataset.totalText);
  const note = document.querySelector('[data-vat-note]');
  if (note) {
    note.textContent = radio.dataset.note;
    note.hidden = !radio.dataset.note;
  }
  document.querySelector('[data-expected-total]').value = radio.dataset.total;
}

/**
 * Vraagt de server op de achtergrond het overzicht en de verzendopties opnieuw uit te rekenen voor het gekozen land,
 * de gekozen methode en het btw-nummer, en vervangt die onderdelen op de pagina. Eerder ingevulde velden blijven staan.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {Promise<void>} Klaar als de pagina is bijgewerkt (ook als dat niet lukte: dan blijft de pagina zoals hij was).
 */
async function refreshTotals(form) {
  const sequence = ++refreshSequence;
  const body = new URLSearchParams({ action: 'update' });
  for (const name of ['country', 'shippingMethod', 'vatNumber']) {
    const field = name === 'shippingMethod' ? form.querySelector('input[name="shippingMethod"]:checked') : form.querySelector(`[name="${name}"]`);
    if (field) body.set(name, field.value);
  }
  try {
    const response = await fetch(form.getAttribute('action'), { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!response.ok || sequence !== refreshSequence) return;
    const updated = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (sequence !== refreshSequence) return;
    const newOptions = updated.querySelector('[data-shipping-options]');
    const newSummary = updated.querySelector('.checkout-summary');
    const newTotal = updated.querySelector('[data-expected-total]');
    if (!newOptions || !newSummary || !newTotal) return;
    // Koos de klant intussen een andere verzendmethode, dan blijft die keuze staan (ook al kwam het antwoord voor de eerdere keuze).
    const chosenNow = form.querySelector('input[name="shippingMethod"]:checked');
    form.querySelector('[data-shipping-options]').innerHTML = newOptions.innerHTML;
    document.querySelector('.checkout-summary').innerHTML = newSummary.innerHTML;
    form.querySelector('[data-expected-total]').value = newTotal.value;
    if (chosenNow) {
      const sameChoice = [...form.querySelectorAll('input[name="shippingMethod"]')].find((radio) => radio.value === chosenNow.value && !radio.disabled);
      if (sameChoice && !sameChoice.checked) {
        sameChoice.checked = true;
        showChosenShipping(sameChoice);
      }
    }
  } catch (error) {
    // Geen verbinding: de pagina blijft staan en bij het bestellen controleert de server het totaal alsnog.
  }
}

/**
 * Start een achtergrondberekening en onthoudt hem, zodat Bestelling plaatsen kan wachten tot het totaal klopt.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {void}
 */
function scheduleRefresh(form) {
  const refresh = refreshTotals(form).then(() => { if (pendingRefresh === refresh) pendingRefresh = null; });
  pendingRefresh = refresh;
}

let refreshSequence = 0;
let pendingRefresh = null;

document.documentElement.classList.add('js-on');
const checkoutForm = document.querySelector('form[action="./"]');
if (checkoutForm) {
  // Geen knop meer nodig: alles werkt op de achtergrond.
  checkoutForm.querySelector('.update-totals').hidden = true;
  checkoutForm.addEventListener('change', (event) => {
    const field = event.target;
    if (field.name === 'shippingMethod') showChosenShipping(field);
    if (field.name === 'country' || field.name === 'vatNumber') scheduleRefresh(checkoutForm);
  });
  // Wordt er besteld terwijl de berekening nog loopt, dan eerst afwachten zodat het getoonde totaal klopt.
  checkoutForm.addEventListener('submit', (event) => {
    if (!pendingRefresh || event.submitter?.value === 'update') return;
    event.preventDefault();
    const submitter = event.submitter;
    pendingRefresh.then(() => checkoutForm.requestSubmit(submitter));
  });
}

/**
 * Koppelt postcode en huisnummer aan het opzoeken van straat en woonplaats (adres.js). Voor Nederland zijn straat en
 * woonplaats alleen-lezen (ze komen uit PDOK en de server controleert ze nog eens) en wordt er niet besteld zolang er
 * geen adres is gevonden; voor andere landen vult de klant ze zelf in.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {void}
 */
function setUpAddressLookup(form) {
  const row = form.querySelector('[data-address-row]');
  const postcodeInput = form.querySelector('input[name="postcode"]');
  if (!row || !postcodeInput || !window.AddressLookup) return;
  row.hidden = false;
  const countryField = form.querySelector('[name="country"]');
  const streetInput = form.querySelector('input[name="street"]');
  const cityInput = form.querySelector('input[name="city"]');
  const statusElement = row.querySelector('[data-address-status]');
  const manualCheckbox = form.querySelector('[data-address-manual]');
  /**
   * Of straat en woonplaats nu uit de opzoeking komen (Nederland, zonder handmatige invoer) en dus niet met de hand te wijzigen zijn.
   * @returns {boolean} true bij Nederland zonder handmatige invoer.
   */
  const isDutch = () => (!countryField || countryField.value === 'NL') && !(manualCheckbox && manualCheckbox.checked);
  /**
   * Zet straat en woonplaats alleen-lezen voor Nederland en bewerkbaar voor andere landen.
   * @returns {void}
   */
  const syncReadOnly = () => {
    streetInput.readOnly = isDutch();
    cityInput.readOnly = isDutch();
  };
  syncReadOnly();
  if (countryField) countryField.addEventListener('change', syncReadOnly);
  // Adres niet gevonden of PDOK onbereikbaar: de klant vult het zelf in, de server bewaart het als 'niet gecontroleerd' (W-11).
  if (manualCheckbox) manualCheckbox.addEventListener('change', syncReadOnly);
  const lookup = window.AddressLookup.attach({
    postcodeInput,
    numberInput: row.querySelector('[data-address-number]'),
    suffixInput: row.querySelector('[data-address-suffix]'),
    statusElement,
    endpoint: form.dataset.addressEndpoint,
    isActive: isDutch,
    getDestination: () => `${streetInput.value}|${cityInput.value}`,
    onFound: (address) => {
      streetInput.value = window.AddressLookup.streetLine(address);
      postcodeInput.value = address.postcode;
      cityInput.value = address.city;
    },
    onClear: () => {
      streetInput.value = '';
      cityInput.value = '';
    },
  });
  // Bestellen kan pas als er een adres is gevonden (Nederland); de server controleert het adres daarna nog eens.
  form.addEventListener('submit', (event) => {
    if (event.submitter?.value === 'update' || !isDutch()) return;
    const pickup = form.querySelector('input[name="shippingMethod"]:checked')?.value === 'ophalen';
    if (pickup || (streetInput.value && cityInput.value && !lookup.hasProblem())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    statusElement.textContent = streetInput.value && cityInput.value ? statusElement.textContent : 'Vul je postcode en huisnummer in; het adres wordt dan automatisch ingevuld.';
    statusElement.dataset.kind = 'error';
    postcodeInput.focus();
  }, true);
}

if (checkoutForm) setUpAddressLookup(checkoutForm);
