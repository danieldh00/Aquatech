// Beheer > Webshop > Verzending: het formulier voor bezorgmethodes (DPD, pallet, eigen transport) en afhalen met tarieven per land.
// Het opslaan zelf doet beheer.js (instelling shopShipping, zie backend/src/webshop/shipping.js).
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Zet een prijs of bedrag om naar tekst met een komma.
   * @param {number} amount Het bedrag.
   * @returns {string} Bijv. "6,95".
   */
  const decimalText = (amount) => String(amount).replace('.', ',');

  /**
   * Leest een getal met komma of punt.
   * @param {string} text De ingevoerde tekst.
   * @returns {number} Het getal (NaN als het geen getal is).
   */
  const parseDecimal = (text) => (String(text).trim() === '' ? NaN : Number(String(text).trim().replace(',', '.')));

  /** De bezorgmethodes van de webshop met hun titel in het verzendformulier (zelfde sleutels als shipping.js). */
  const SHIPPING_CARRIERS = [['dpd', 'DPD'], ['pallet', 'Pallet'], ['eigen', 'Eigen transport']];

  /**
   * Tekent een regel (land) in het verzendformulier bij een bezorgmethode.
   * @param {HTMLElement} zones De lijst met landen van die methode.
   * @param {{ country: string, name: string, freeFrom: number, tiers: { upToGrams: number, price: number }[] }} zone Het land met zijn tarieven.
   * @param {boolean} [withQtyTiers] true bij pallet en eigen transport: dan komt er een veld voor de aantalstaffel bij.
   * @returns {void}
   */
  function addShippingZone(zones, zone, withQtyTiers = false) {
    const row = document.createElement('div');
    row.className = 'ship-zone';
    row.innerHTML = `<input data-f="country" maxlength="2" size="3" placeholder="NL" aria-label="Landcode" value="${esc(zone.country)}">
      <input data-f="name" maxlength="60" placeholder="Nederland" aria-label="Naam" value="${esc(zone.name)}">
      <input data-f="freeFrom" size="8" placeholder="Gratis vanaf" aria-label="Gratis vanaf" value="${zone.freeFrom ? esc(decimalText(zone.freeFrom)) : ''}">
      <input data-f="tiers" placeholder="2000=6,95; 5000=8,95" aria-label="Weegklassen" value="${esc(zone.tiers.map((tier) => `${tier.upToGrams}=${decimalText(tier.price)}`).join('; '))}">
      ${withQtyTiers ? `<input data-f="qtyTiers" placeholder="Aantalstaffel: 50=45; 200=80" aria-label="Aantalstaffel (t/m aantal=prijs)" value="${esc((zone.qtyTiers || []).map((tier) => `${tier.upToQty}=${decimalText(tier.price)}`).join('; '))}">` : ''}
      <button type="button" class="btn danger" data-remove>Verwijder</button>`;
    /**
     * Verwijdert dit land uit het formulier.
     * @returns {void}
     */
    row.querySelector('[data-remove]').onclick = () => row.remove();
    zones.appendChild(row);
  }

  /**
   * Tekent het blok van één bezorgmethode: aan/uit, de naam bij het afrekenen en de tarieven per land.
   * @param {string} key De methode (dpd, pallet of eigen).
   * @param {string} title De titel van het blok.
   * @param {{ enabled: boolean, label: string, zones: object[] }} carrier De opgeslagen instelling van de methode.
   * @returns {HTMLElement} Het blok (fieldset).
   */
  function shippingCarrierBlock(key, title, carrier) {
    const block = document.createElement('fieldset');
    block.className = 'ship-carrier';
    block.dataset.carrier = key;
    block.innerHTML = `<legend>${esc(title)}</legend>
      <div class="form-grid">
        <label class="field chk"><input type="checkbox" data-c="enabled"> <span>${esc(title)} aanbieden</span></label>
        <label class="field">Naam bij het afrekenen<input data-c="label" maxlength="60"></label>
        <label class="field">Levertijd van (dagen)<input data-c="leadMin" type="number" min="0" max="365" step="1" placeholder="leeg = op aanvraag"></label>
        <label class="field">Levertijd tot (dagen)<input data-c="leadMax" type="number" min="0" max="365" step="1"></label>
        <label class="field">Soort dagen<select data-c="dayType"><option value="calendar">Kalenderdagen</option><option value="working">Werkdagen</option></select></label>
      </div>
      <div data-zones></div>
      <p><button type="button" class="btn" data-add-zone>Land toevoegen</button></p>`;
    block.querySelector('[data-c="enabled"]').checked = carrier.enabled;
    block.querySelector('[data-c="label"]').value = carrier.label;
    block.querySelector('[data-c="leadMin"]').value = carrier.leadDays ? carrier.leadDays.min : '';
    block.querySelector('[data-c="leadMax"]').value = carrier.leadDays ? carrier.leadDays.max : '';
    block.querySelector('[data-c="dayType"]').value = carrier.dayType || 'calendar';
    const zones = block.querySelector('[data-zones]');
    const withQtyTiers = key !== 'dpd';
    for (const zone of carrier.zones) addShippingZone(zones, zone, withQtyTiers);
    /**
     * Voegt een leeg land toe aan de tarieven van deze methode.
     * @returns {void}
     */
    block.querySelector('[data-add-zone]').onclick = () => addShippingZone(zones, { country: '', name: '', freeFrom: 0, tiers: [], qtyTiers: [] }, withQtyTiers);
    return block;
  }

  /**
   * Vult het verzendformulier met de opgeslagen instelling.
   * @param {object} config De instelling shopShipping (afhalen, defaultWeightGrams en per bezorgmethode aan/uit, naam en landen).
   * @returns {void}
   */
  function render(config) {
    const form = $('#s-shipping');
    if (!config || !config.pickup || !config.dpd) return;
    form.pickupEnabled.checked = config.pickup.enabled;
    form.pickupLabel.value = config.pickup.label;
    form.pickupNote.value = config.pickup.note;
    form.defaultWeightGrams.value = config.defaultWeightGrams;
    form.pickupLeadMin.value = config.pickup.leadDays ? config.pickup.leadDays.min : '';
    form.pickupLeadMax.value = config.pickup.leadDays ? config.pickup.leadDays.max : '';
    form.pickupDayType.value = config.pickup.dayType || 'calendar';
    const container = $('#s-shipping-carriers');
    container.innerHTML = '';
    for (const [key, title] of SHIPPING_CARRIERS) container.appendChild(shippingCarrierBlock(key, title, config[key]));
  }

  /**
   * Leest de tarieven per land van één bezorgmethode uit het formulier.
   * @param {HTMLElement} block Het blok van de methode.
   * @returns {{ country: string, name: string, freeFrom: number, tiers: object[] }[]} De landen; een weegklasse die niet te lezen is geeft een fout.
   */
  function readShippingZones(block) {
    return [...block.querySelector('[data-zones]').children].map((row) => {
      /**
       * Leest een veld van dit land.
       * @param {string} name Naam van het veld (data-f).
       * @returns {string} De ingevoerde tekst.
       */
      const field = (name) => row.querySelector(`[data-f="${name}"]`).value;
      const tiers = field('tiers').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [grams, price] = part.split('=');
        const tier = { upToGrams: parseDecimal(grams == null ? '' : grams), price: parseDecimal(price == null ? '' : price) };
        if (!Number.isFinite(tier.upToGrams) || !Number.isFinite(tier.price)) throw new Error(`Weegklasse "${part}" is niet te lezen. Gebruik gram=prijs, bijvoorbeeld 2000=6,95.`);
        return tier;
      });
      const freeFrom = field('freeFrom').trim() ? parseDecimal(field('freeFrom')) : 0;
      if (!Number.isFinite(freeFrom)) throw new Error('Gratis vanaf moet een bedrag zijn.');
      const quantityInput = row.querySelector('[data-f="qtyTiers"]');
      const qtyTiers = quantityInput ? quantityInput.value.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [quantity, price] = part.split('=');
        const tier = { upToQty: parseDecimal(quantity == null ? '' : quantity), price: parseDecimal(price == null ? '' : price) };
        if (!Number.isFinite(tier.upToQty) || !Number.isFinite(tier.price)) throw new Error(`Aantalklasse "${part}" is niet te lezen. Gebruik aantal=prijs, bijvoorbeeld 50=45.`);
        return tier;
      }) : undefined;
      return { country: field('country').trim().toUpperCase(), name: field('name').trim(), freeFrom, tiers, ...(qtyTiers ? { qtyTiers } : {}) };
    });
  }

  /**
   * Leest de verzendinstelling uit het formulier.
   * @returns {object} De instelling (afhalen, standaardgewicht en per bezorgmethode aan/uit, naam en landen); een weegklasse die niet te lezen is geeft een fout.
   */
  function read() {
    const form = $('#s-shipping');
    const config = {
      pickup: { enabled: form.pickupEnabled.checked, label: form.pickupLabel.value, note: form.pickupNote.value, leadDays: { min: form.pickupLeadMin.value, max: form.pickupLeadMax.value }, dayType: form.pickupDayType.value },
      defaultWeightGrams: Number(form.defaultWeightGrams.value || 0),
    };
    for (const [key] of SHIPPING_CARRIERS) {
      const block = form.querySelector(`[data-carrier="${key}"]`);
      config[key] = { enabled: block.querySelector('[data-c="enabled"]').checked, label: block.querySelector('[data-c="label"]').value, zones: readShippingZones(block), leadDays: { min: block.querySelector('[data-c="leadMin"]').value, max: block.querySelector('[data-c="leadMax"]').value }, dayType: block.querySelector('[data-c="dayType"]').value };
    }
    return config;
  }

  window.BeheerVerzending = { render, read };
})();
