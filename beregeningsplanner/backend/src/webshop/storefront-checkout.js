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
