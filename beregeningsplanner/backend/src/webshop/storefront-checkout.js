// Afrekenen in de eigen webshop: bij een andere verzendmethode meteen het
// overzicht en het totaal bijwerken, zodat één klik op Bestelling plaatsen
// genoeg is. Bij een ander land wordt de pagina opnieuw berekend; een btw-nummer
// werkt via de knop Totaal bijwerken. Zonder dit script werkt die knop ook.

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
 * Stuurt het formulier als "bijwerken" op, zodat de server land of btw-nummer opnieuw doorrekent.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {void}
 */
function recalculate(form) {
  form.requestSubmit(form.querySelector('.update-totals'));
}

document.documentElement.classList.add('js-on');
const checkoutForm = document.querySelector('form[action="./"]');
if (checkoutForm) {
  for (const radio of checkoutForm.querySelectorAll('input[name="shippingMethod"]')) {
    radio.addEventListener('change', () => showChosenShipping(radio));
  }
  // Een ander land rekent de pagina meteen opnieuw door. Bij een btw-nummer blijft de knop Totaal bijwerken staan, zodat een klik op Bestelling plaatsen niet wordt onderschept.
  const updateButton = checkoutForm.querySelector('.update-totals');
  if (!checkoutForm.querySelector('input[name="vatNumber"]')) updateButton.hidden = true;
  for (const field of checkoutForm.querySelectorAll('select[name="country"]')) {
    field.addEventListener('change', () => recalculate(checkoutForm));
  }
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
