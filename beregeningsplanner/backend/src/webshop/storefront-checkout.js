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
    const response = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'text/html' } });
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
 * Koppelt postcode en huisnummer aan het opzoeken van straat en woonplaats (adres.js). Alleen voor Nederland; het
 * adres blijft handmatig aan te passen en bij een storing of geen treffer verandert er niets.
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
  // Wat de opzoeking zelf invulde: alleen dat wordt weer gewist (een handmatig getypt adres blijft staan).
  let lastWritten = null;
  window.AddressLookup.attach({
    postcodeInput,
    numberInput: row.querySelector('[data-address-number]'),
    suffixInput: row.querySelector('[data-address-suffix]'),
    statusElement: row.querySelector('[data-address-status]'),
    endpoint: form.dataset.addressEndpoint,
    isActive: () => !countryField || countryField.value === 'NL',
    getDestination: () => `${streetInput.value}|${cityInput.value}`,
    onFound: (address) => {
      streetInput.value = window.AddressLookup.streetLine(address);
      postcodeInput.value = address.postcode;
      cityInput.value = address.city;
      lastWritten = `${streetInput.value}|${cityInput.value}`;
    },
    onClear: () => {
      if (lastWritten === null || `${streetInput.value}|${cityInput.value}` !== lastWritten) return;
      streetInput.value = '';
      cityInput.value = '';
      lastWritten = null;
    },
  });
}

if (checkoutForm) setUpAddressLookup(checkoutForm);
