// Offertes: klantkeuze en nieuwe klant, btw verlegd en afleveradres in de offerte-editor.
// Het bestand zet een fabriek op window.Offertes; offertes.js geeft de gedeelde
// hulpfuncties en de stand (context) mee en gebruikt wat de fabriek teruggeeft.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Bouwt de functies voor klantkeuze en nieuwe klant, btw verlegd en afleveradres in de offerte-editor.
   * @param {object} context gedeelde hulpfuncties en stand uit offertes.js: esc, nl, state, toast, api, setPath, locked, renderTotals, changed, save, $
   * @returns {object} de functies die offertes.js zelf nodig heeft: renderAccount, renderVatShift, renderDelivery, toggleDelivery, toggleVatShift, openNewCustomer, closeNewCustomer, syncNewCustomerBusiness, saveNewCustomer, closeCustomerList, searchCustomers, pickCustomer
   */
  window.Offertes.createCustomers = function (context) {
    const { esc, nl, state, toast, api, setPath, locked, renderTotals, changed, save, $ } = context;

    /**
     * Toont aan welke klant de offerte hangt (de klant ziet hem dan zelf in de app) en maakt het zoekveld leeg.
     * @param {object} quote de offerte
     */
    function renderAccount(quote) {
      const chosen = $('#e-cust-chosen');
      const account = quote.customerAccount;
      chosen.hidden = !quote.customerId;
      $('#e-cust-name').textContent = quote.customerId ? `Gekoppeld aan ${account ? account.displayName : 'een klant'}` : '';
      $('#e-cust-search').value = '';
      closeCustomerList();
      $('#e-cust-new').hidden = !(state.me.rights || []).includes('klanten') || !$('#e-newcust').hidden;
    }

    /**
     * Toont het blok "Btw verlegd": het vinkje, het btw-nummer van de klant en de uitkomst van de controle bij VIES (zoals de server die bij het opslaan vastlegde).
     * @param {object} quote de offerte
     */
    function renderVatShift(quote) {
      const shift = quote.data.vatShift || {};
      $('#e-vs-on').checked = shift.on === true;
      $('#e-vs-box').hidden = shift.on !== true;
      if (document.activeElement !== $('#e-vs-number')) $('#e-vs-number').value = shift.number || '';
      // Een afnemer in een ander EU-land (btw-nummer door VIES geldig bevonden) heeft een adres buiten PDOK: dat typ je dan zelf.
      const foreign = shift.on === true && shift.status === 'geldig' && /^[A-Za-z]{2}/.test(shift.number || '') && !/^nl/i.test(shift.number);
      for (const address of document.querySelectorAll('#edit-view [data-f="customer.address"], #edit-view [data-f="delivery.address"]')) {
        if (foreign) address.dataset.addressManual = '1'; else delete address.dataset.addressManual;
      }
      const status = $('#e-vs-status');
      if (shift.on !== true) { status.textContent = ''; return; }
      if (!shift.number) status.textContent = 'Vul het btw-nummer van de klant in; zonder nummer wordt de btw niet verlegd.';
      else if (shift.status === 'geldig') status.textContent = `Controle bij VIES: geldig${shift.name ? ` (${shift.name})` : ''}, ${new Date(shift.checkedAt).toLocaleDateString('nl-NL')}${shift.requestId ? `, kenmerk ${shift.requestId}` : ''}. Dit staat als bewijs op de offerte.`;
      else if (shift.status === 'onbereikbaar') status.textContent = 'VIES is nu niet bereikbaar: de btw wordt pas verlegd als de controle is gelukt. Sla de offerte later opnieuw op.';
      else status.textContent = 'Het btw-nummer wordt bij het opslaan gecontroleerd bij VIES; daarna wordt de btw verlegd.';
      if (shift.number) status.textContent += ' De btw-tarieven per regel blijven bewaard, maar tellen niet mee zolang de btw is verlegd.';
    }

    /**
     * Toont het vinkje "Afleveradres gelijk aan adres" en het tweede adresveld alleen als het afleveradres afwijkt.
     * @param {object} quote De offerte in de editor.
     * @returns {void}
     */
    function renderDelivery(quote) {
      const same = !quote.data.delivery || quote.data.delivery.same !== false;
      $('#e-del-same').checked = same;
      $('#e-del-box').hidden = same;
    }

    /** Zet het vinkje "Afleveradres gelijk aan adres" om: bij afwijkend verschijnt het tweede adresveld, bij gelijk wordt het leeggemaakt. */
    function toggleDelivery() {
      const quote = state.quote;
      if (!quote || locked()) return;
      const same = $('#e-del-same').checked;
      quote.data.delivery = same ? { same: true, address: '' } : { same: false, address: (quote.data.delivery && quote.data.delivery.address) || '' };
      $('#e-del-box').querySelector('textarea').value = quote.data.delivery.address;
      renderDelivery(quote);
      if (!same) $('#e-del-box').querySelector('textarea').focus();
      changed();
    }

    /** Zet het vinkje "Btw verlegd" om: de totalen passen zich meteen aan en de offerte wordt bewaard. */
    function toggleVatShift() {
      const quote = state.quote;
      if (!quote || locked()) return;
      quote.data.vatShift = { ...(quote.data.vatShift || { number: '' }), on: $('#e-vs-on').checked, status: '' };
      renderVatShift(quote);
      renderTotals();
      if (quote.data.vatShift.on && !quote.data.vatShift.number) $('#e-vs-number').focus();
      else changed();
    }

    /** Opent het formulier voor een nieuwe klant, leeg, met de bedrijfsvelden alleen bij Zakelijk. */
    function openNewCustomer() {
      const form = $('#e-newcust');
      form.reset();
      $('#e-newcust-err').textContent = '';
      if (!(state.me.rights || []).includes('beheer')) form.customerGroup.querySelector('option[value="zakelijk"]').remove();
      syncNewCustomerBusiness();
      form.hidden = false;
      $('#e-cust-new').hidden = true;
      if (!form.address.dataset.textWatched) { form.address.dataset.textWatched = '1'; state.refreshNewAddress = window.AddressLookup.mirror(form.address, form.querySelector('[data-addr-text]')); } else state.refreshNewAddress();
      form.displayName.focus();
    }

    /** Sluit het formulier voor een nieuwe klant zonder te bewaren. */
    function closeNewCustomer() {
      $('#e-newcust').hidden = true;
      renderAccount(state.quote);
    }

    /** Toont de bedrijfsvelden van het nieuwe-klantformulier alleen bij een zakelijke klant. */
    function syncNewCustomerBusiness() {
      const form = $('#e-newcust');
      const business = form.customerGroup.value === 'zakelijk';
      form.querySelectorAll('[data-business]').forEach((field) => { field.hidden = !business; });
    }

    /**
     * Bewaart de nieuwe klant (die daarmee meteen in de klantenlijst staat) en koppelt hem aan de offerte.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    async function saveNewCustomer(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const quote = state.quote;
      $('#e-newcust-err').textContent = '';
      const body = { displayName: form.displayName.value, email: form.email.value, phone: form.phone.value, address: form.address.value, customerGroup: form.customerGroup.value };
      if (body.customerGroup === 'zakelijk') Object.assign(body, { companyName: form.companyName.value, kvkNumber: form.kvkNumber.value, vatNumber: form.vatNumber.value });
      button.disabled = true;
      try {
        const out = await api('customers', { method: 'POST', body });
        if (state.quote !== quote) return;
        form.hidden = true;
        await pickCustomer(out.customer);
      } catch (error) {
        $('#e-newcust-err').textContent = error.message;
        if (error.field && form[error.field]) form[error.field].focus();
      } finally {
        button.disabled = false;
      }
    }

    /** Sluit de lijst met zoekresultaten van de klantkeuze. */
    function closeCustomerList() {
      const list = $('#e-cust-list');
      list.hidden = true;
      list.innerHTML = '';
      $('#e-cust-search').setAttribute('aria-expanded', 'false');
      state.customerHits = [];
    }

    /**
     * Zoekt klanten op de server en toont de eerste 20 onder het zoekveld.
     * @returns {Promise<void>}
     */
    async function searchCustomers() {
      const search = $('#e-cust-search').value.trim();
      const ticket = (state.customerTicket = (state.customerTicket || 0) + 1);
      let items = [];
      try {
        items = ((await api(`quote-customers?q=${encodeURIComponent(search)}`)) || {}).items || [];
      } catch (error) {
        toast(error.message, true);
        return;
      }
      if (ticket !== state.customerTicket) return;
      state.customerHits = items;
      state.customerHitsFor = search;
      state.customerActive = items.length ? 0 : -1;
      const list = $('#e-cust-list');
      list.innerHTML = items.length
        ? items.map((customer, index) => `<li role="option" data-i="${index}"${index === 0 ? ' class="active"' : ''}><b>${esc(customer.companyName || customer.displayName)}</b>`
          + `<span class="sub">${esc([customer.companyName ? customer.displayName : '', customer.address.replace(/\n/g, ', '), customer.email].filter(Boolean).join(' · ') || customer.username)}</span></li>`).join('')
        : '<li class="none">Geen klanten gevonden.</li>';
      list.hidden = false;
      $('#e-cust-search').setAttribute('aria-expanded', 'true');
    }

    /**
     * Koppelt de offerte aan de gekozen klant en vult naam, contactpersoon, adres, e-mail en telefoon in.
     * @param {object} customer de gekozen klant uit de zoekresultaten
     * @returns {Promise<void>}
     */
    async function pickCustomer(customer) {
      const quote = state.quote;
      if (!quote || locked()) return;
      const fields = {
        'customer.name': customer.companyName || customer.displayName,
        'customer.contact': customer.companyName ? customer.displayName : '',
        'customer.address': customer.address || '',
        'customer.email': customer.email || '',
        'customer.phone': customer.phone || '',
      };
      for (const [path, value] of Object.entries(fields)) {
        setPath(quote.data, path, value);
        const input = document.querySelector(`#edit-view [data-f="${path}"]`);
        if (input) input.value = value;
      }
      // De documenttaal van de klant bepaalt de taal van de offerte (en van de factuur die daaruit volgt).
      if (customer.documentLanguage) {
        quote.data.language = window.DocText.clean(customer.documentLanguage);
        const languageField = document.querySelector('#edit-view [data-f="language"]');
        if (languageField) languageField.value = quote.data.language;
      }
      // De betaaltermijn van de klant (of de standaard) komt op de offerte.
      if (customer.paymentDays != null) {
        quote.data.paymentDays = customer.paymentDays;
        const paymentField = document.querySelector('#edit-view [data-f="paymentDays"]');
        if (paymentField) paymentField.value = customer.paymentDays;
      }
      // Een btw-nummer van de klant komt alvast in het veld "Btw verlegd"; het vinkje blijft aan de gebruiker.
      const vatShift = quote.data.vatShift || { on: false, number: '' };
      if (customer.vatNumber && !vatShift.on) quote.data.vatShift = { ...vatShift, number: customer.vatNumber };
      $('#e-vs-number').value = (quote.data.vatShift || {}).number || '';
      quote.customerId = customer.id;
      quote.customerAccount = { id: customer.id, displayName: customer.displayName };
      state.dirty = true;
      renderAccount(quote);
      if (await save({ customerId: customer.id })) toast('Gegevens van de klant ingevuld');
    }

    return { renderAccount, renderVatShift, renderDelivery, toggleDelivery, toggleVatShift, openNewCustomer, closeNewCustomer, syncNewCustomerBusiness, saveNewCustomer, closeCustomerList, searchCustomers, pickCustomer };
  };
})();
