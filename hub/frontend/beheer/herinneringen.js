// Beheer > Instellingen: de formulieren Seizoensherinneringen en Betalingsherinneringen (invullen en uitlezen).
// Het opslaan zelf doet beheer.js (instellingen seasonReminders en paymentReminders).
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

  // Februari altijd 28, net als op de server: de datum moet elk jaar bestaan.
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  /**
   * Vult het formulier Seizoensherinneringen: aan/uit, portaaladres (standaard
   * het portaal van deze installatie) en per herinnering titel, datum en tekst.
   * @param {object} config De instelling seasonReminders.
   * @returns {void}
   */
  function renderSeason(config) {
    const seasonForm = $('#s-season');
    seasonForm.enabled.checked = config.enabled;
    seasonForm.portalUrl.value = config.portalUrl || new URL('../portaal/', location.href).href;
    $('#s-season-items').innerHTML = config.items.map((item) => `
      <fieldset class="season-item" data-key="${esc(item.key)}">
        <div class="row">
          <label>Onderwerp<input name="title" maxlength="100" required value="${esc(item.title)}"></label>
          <label>Dag<input name="day" type="number" min="1" max="31" step="1" required value="${item.day}"></label>
          <label>Maand<select name="month">${MONTHS.map((month, index) => `<option value="${index + 1}"${index + 1 === item.month ? ' selected' : ''}>${month}</option>`).join('')}</select></label>
        </div>
        <label>Tekst in de mail en het portaal<textarea name="text" rows="3" maxlength="1000">${esc(item.text)}</textarea></label>
      </fieldset>`).join('');
  }

  /**
   * Toont de instelling paymentReminders in het formulier Betalingsherinneringen.
   * @param {object} config De instelling paymentReminders.
   * @returns {void}
   */
  function renderPaymentReminders(config) {
    const reminderForm = $('#s-payment-reminders');
    reminderForm.enabled.checked = config.enabled;
    reminderForm.stopAfterDays.value = config.stopAfterDays;
    $('#s-payment-reminders-steps').innerHTML = config.steps.map((step) => `
      <div class="field" data-key="${esc(step.key)}">
        <label class="chk"><input type="checkbox" name="stepEnabled"${step.enabled ? ' checked' : ''}> ${esc(step.title)}</label>
        <label>Dagen over de vervaldatum<input name="stepDays" type="number" min="1" max="364" step="1" required value="${step.days}"></label>
      </div>`).join('');
  }

  /**
   * Leest het formulier Betalingsherinneringen uit.
   * @returns {object} De instelling paymentReminders.
   */
  function readPaymentReminders() {
    const reminderForm = $('#s-payment-reminders');
    return {
      enabled: reminderForm.enabled.checked,
      stopAfterDays: Number(reminderForm.stopAfterDays.value),
      steps: [...reminderForm.querySelectorAll('[data-key]')].map((field) => ({
        key: field.dataset.key, enabled: field.querySelector('[name="stepEnabled"]').checked, days: Number(field.querySelector('[name="stepDays"]').value),
      })),
    };
  }

  /**
   * Leest het formulier Seizoensherinneringen uit.
   * @returns {object} De instelling seasonReminders.
   */
  function readSeason() {
    const seasonForm = $('#s-season');
    const items = [...seasonForm.querySelectorAll('.season-item')].map((fieldset) => ({
      key: fieldset.dataset.key,
      title: fieldset.querySelector('[name="title"]').value.trim(),
      day: Number(fieldset.querySelector('[name="day"]').value),
      month: Number(fieldset.querySelector('[name="month"]').value),
      text: fieldset.querySelector('[name="text"]').value.trim(),
    }));
    return { enabled: seasonForm.enabled.checked, portalUrl: seasonForm.portalUrl.value.trim(), items };
  }

  window.BeheerHerinneringen = { MONTHS, MONTH_DAYS, renderSeason, readSeason, renderPaymentReminders, readPaymentReminders };
})();
