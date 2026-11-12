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
 * @param {HTMLOptionElement} radio De gekozen verzendmethode (optie van de keuzelijst) met de berekende gegevens.
 * @returns {void}
 */
function showChosenShipping(radio) {
  const shipNote = document.querySelector('[data-ship-note]');
  if (shipNote) {
    shipNote.textContent = radio.dataset.methodNote || '';
    shipNote.hidden = !radio.dataset.methodNote;
  }
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
    const field = form.querySelector(`[name="${name}"]`);
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
    const chosenNow = form.querySelector('select[name="shippingMethod"]');
    const chosenValue = chosenNow ? chosenNow.value : '';
    form.querySelector('[data-shipping-options]').innerHTML = newOptions.innerHTML;
    document.querySelector('.checkout-summary').innerHTML = newSummary.innerHTML;
    form.querySelector('[data-expected-total]').value = newTotal.value;
    const list = form.querySelector('select[name="shippingMethod"]');
    if (chosenValue && list) {
      const sameChoice = [...list.options].find((option) => option.value === chosenValue && !option.disabled);
      if (sameChoice && list.value !== chosenValue) list.value = chosenValue;
      if (sameChoice) showChosenShipping(list.selectedOptions[0]);
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
    if (field.name === 'shippingMethod') showChosenShipping(field.selectedOptions[0]);
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
 * Koppelt postcode en huisnummer van één adresblok aan het opzoeken van straat en woonplaats (adres.js). Voor Nederland zijn straat
 * en woonplaats alleen-lezen (ze komen uit PDOK en de server controleert ze nog eens); voor andere landen vult de klant ze zelf in.
 * @param {HTMLElement} block Het adresblok (factuuradres of afleveradres) met postcode, straat, woonplaats en het vinkje voor een adres dat niet gevonden wordt.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @param {{ prefix: string, countryOf: Function, isUsed: Function }} options `prefix` is het voorvoegsel van de veldnamen ('' of 'delivery'); `countryOf` geeft het land van dit adres; `isUsed` zegt of dit adres nu meetelt (het afleveradres telt niet mee als het gelijk is aan het factuuradres).
 * @returns {{ validate: Function, refresh: Function }|null} `validate()` geeft true als het adres klopt (anders staat er een melding), `refresh()` past alleen-lezen aan na een andere landkeuze; null als dit blok niet te koppelen is.
 */
function setUpAddressBlock(block, form, { prefix, countryOf, isUsed }) {
  /**
   * De veldnaam met het voorvoegsel van dit adresblok.
   * @param {string} name Basisnaam (street, postcode, city).
   * @returns {string} De veldnaam in het formulier.
   */
  const fieldName = (name) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  const row = block.querySelector('[data-address-row]');
  const postcodeInput = block.querySelector(`input[name="${fieldName('postcode')}"]`);
  if (!row || !postcodeInput || !window.AddressLookup) return null;
  row.hidden = false;
  const streetInput = block.querySelector(`input[name="${fieldName('street')}"]`);
  const cityInput = block.querySelector(`input[name="${fieldName('city')}"]`);
  const statusElement = row.querySelector('[data-address-status]');
  const manualCheckbox = block.querySelector('[data-address-manual]');
  /**
   * Of straat en woonplaats nu uit de opzoeking komen (Nederland, zonder handmatige invoer) en dus niet met de hand te wijzigen zijn.
   * @returns {boolean} true bij Nederland zonder handmatige invoer.
   */
  const isDutch = () => countryOf() === 'NL' && !(manualCheckbox && manualCheckbox.checked);
  /**
   * Zet straat en woonplaats alleen-lezen voor Nederland en bewerkbaar voor andere landen.
   * @returns {void}
   */
  const syncReadOnly = () => {
    streetInput.readOnly = isDutch();
    cityInput.readOnly = isDutch();
  };
  syncReadOnly();
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
  /**
   * Controleert dit adres voor het bestellen (Nederland: er moet een adres gevonden zijn) en zet anders een melding en de focus.
   * @returns {boolean} true als het adres klopt of niet meetelt.
   */
  const validate = () => {
    if (!isUsed() || !isDutch()) return true;
    if (streetInput.value && cityInput.value && !lookup.hasProblem()) return true;
    statusElement.textContent = streetInput.value && cityInput.value ? statusElement.textContent : 'Vul je postcode en huisnummer in; het adres wordt dan automatisch ingevuld.';
    statusElement.dataset.kind = 'error';
    postcodeInput.focus();
    return false;
  };
  return { validate, refresh: syncReadOnly };
}

/**
 * Zet het factuuradres en het afleveradres op: het vinkje "Afleveradres gelijk aan factuuradres" (standaard aan) laat het tweede
 * blok verdwijnen, en bij een afwijkend afleveradres kiest de klant ook het land van het factuuradres. Bestellen kan pas als de
 * Nederlandse adressen die meetellen zijn gevonden; de server controleert ze daarna nog eens.
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {void}
 */
function setUpAddresses(form) {
  const billingBlock = form.querySelector('[data-address-block="billing"]');
  const deliveryBlock = form.querySelector('[data-address-block="delivery"]');
  const sameBox = form.querySelector('[data-delivery-same]');
  if (!billingBlock || !deliveryBlock || !sameBox) return;
  const countryField = form.querySelector('[name="country"]');
  const billingCountryField = form.querySelector('[name="billingCountry"]');
  /**
   * Of de klant voor ophalen koos (dan is geen adres nodig).
   * @returns {boolean} true bij ophalen.
   */
  const pickup = () => form.querySelector('[name="shippingMethod"]')?.value === 'ophalen';
  /**
   * Het land van aflevering (zonder keuzelijst is dat Nederland).
   * @returns {string} Landcode.
   */
  const deliveryCountry = () => (countryField ? countryField.value : 'NL');
  /**
   * Het land van het factuuradres: gelijk aan dat van de aflevering, of de aparte keuze bij een afwijkend afleveradres.
   * @returns {string} Landcode.
   */
  const billingCountry = () => (sameBox.checked || !billingCountryField ? deliveryCountry() : billingCountryField.value);
  const billing = setUpAddressBlock(billingBlock, form, { prefix: '', countryOf: billingCountry, isUsed: () => !pickup() });
  const delivery = setUpAddressBlock(deliveryBlock, form, { prefix: 'delivery', countryOf: deliveryCountry, isUsed: () => !pickup() && !sameBox.checked });
  /**
   * Past de pagina aan op het vinkje: toont of verbergt het afleveradres en de landkeuze van het factuuradres.
   * @returns {void}
   */
  const sync = () => {
    deliveryBlock.hidden = sameBox.checked;
    const countryRow = form.querySelector('[data-billing-country]');
    if (countryRow) countryRow.hidden = sameBox.checked;
    if (billing) billing.refresh();
    if (delivery) delivery.refresh();
  };
  sync();
  sameBox.addEventListener('change', sync);
  for (const field of [countryField, billingCountryField]) if (field) field.addEventListener('change', sync);
  // Bestellen kan pas als de adressen die meetellen zijn gevonden (Nederland).
  form.addEventListener('submit', (event) => {
    if (event.submitter?.value === 'update') return;
    const valid = [billing, delivery].every((part) => !part || part.validate());
    if (valid) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

if (checkoutForm) setUpAddresses(checkoutForm);

/**
 * Dropshipping op het afrekenformulier: het veld voor het e-mailadres van het afleverbewijs staat er alleen als het vinkje aan staat,
 * en het hele blok verdwijnt bij ophalen (dat kan niet met dropshipping).
 * @param {HTMLFormElement} form Het afrekenformulier.
 * @returns {void}
 */
function setUpDropshipping(form) {
  const section = form.querySelector('[data-dropship-section]');
  const box = form.querySelector('[data-dropship]');
  const fields = form.querySelector('[data-dropship-fields]');
  if (!section || !box || !fields) return;
  const proofInput = fields.querySelector('input');
  /**
   * Past het blok aan op de keuze: verbergt het bij ophalen (en zet het vinkje dan uit) en toont het e-mailveld alleen bij een vinkje.
   * @returns {void}
   */
  const sync = () => {
    const pickup = form.querySelector('[name="shippingMethod"]')?.value === 'ophalen';
    section.hidden = pickup;
    if (pickup) box.checked = false;
    fields.hidden = !box.checked;
    proofInput.required = box.checked;
  };
  sync();
  box.addEventListener('change', sync);
  form.addEventListener('change', (event) => { if (event.target.name === 'shippingMethod') sync(); });
}

if (checkoutForm) setUpDropshipping(checkoutForm);
