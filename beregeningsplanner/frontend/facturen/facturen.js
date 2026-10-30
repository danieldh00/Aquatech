// Facturen: overzicht (status, periode, zoeken), webshopbestellingen ophalen,
// de factuur zelf (?id=) met klant, regels, btw en omzetcategorieën,
// definitief maken, betaald, crediteren, PDF (gemaakt door de server) en
// versturen per e-mail, de debiteuren, de export voor de boekhouding (Excel
// per omzetcategorie), de koppeling met Visma eAccounting en de
// factuurinstellingen. Gegevens uit /api/invoices, /api/debtors en /api/visma
// (recht 'facturen'); rekenwerk in invoice-core.js (gedeeld met de server).
(function () {
  const InvoiceCore = window.InvoiceCore;
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
   * Formatteert een bedrag in euro's.
   * @param {number|null} value het bedrag
   * @returns {string} bijv. '€ 12,50', of leeg zonder bedrag
   */
  const eur = (value) => (value == null ? '' : (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }));
  /**
   * Formatteert een datum kort.
   * @param {string} iso datum (of tijdstip) in ISO-formaat
   * @returns {string} bijv. '3 nov 2026', of leeg
   */
  const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  /**
   * Leest een getal uit een invoerveld (komma of punt).
   * @param {string} value de invoer
   * @returns {number} het getal (0 bij lege of ongeldige invoer)
   */
  const num = (value) => (String(value).trim() === '' ? 0 : Number(String(value).replace(',', '.')) || 0);

  const state = { items: [], tab: 'list', invoice: null, settings: null, profile: {}, articles: {}, dirty: false, config: {}, debtors: [], debtor: null, visma: null, vismaOptions: null };
  /**
   * Formatteert een tijdstip kort met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} bijv. '3 nov 14:05', of leeg
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object}} request methode en inhoud (standaard GET zonder inhoud)
   * @returns {Promise<object>} het antwoord; gooit een fout met code, field en status bij een foutstatus
   */
  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(result.message || `HTTP ${res.status}`), { code: result.error, field: result.field, status: res.status });
    return result;
  }

  /**
   * Maakt het statuslabel van een factuur.
   * @param {object} invoice de factuur
   * @returns {string} HTML van het label
   */
  const statusPill = (invoice) => {
    if (invoice.overdue) return '<span class="pill overdue">Over de vervaldatum</span>';
    return `<span class="pill st-${esc(invoice.status)}">${esc(InvoiceCore.STATUSES[invoice.status] || invoice.status)}</span>`;
  };
  /**
   * Maakt de labels Credit en Webshop.
   * @param {object} invoice de factuur
   * @returns {string} HTML van de labels, of leeg
   */
  const kindPill = (invoice) => (invoice.kind === 'credit' ? ' <span class="pill credit">Credit</span>' : '') + (invoice.source === 'webshop' ? ' <span class="pill src">Webshop</span>' : '');
  /**
   * Boekhouding: in Visma (met het Visma-nummer), mislukt, geëxporteerd of nog niet.
   * @param {object} invoice de factuur
   * @returns {string} HTML van de cel
   */
  const bookCell = (invoice) => (invoice.vismaInvoiceId ? `Visma ${esc(invoice.vismaNumber || '')}`
    : invoice.vismaError ? `<span class="fail" title="${esc(invoice.vismaError)}">Visma mislukt</span>`
      : invoice.exportedAt ? esc(day(invoice.exportedAt)) : '<span class="muted">–</span>');
  /**
   * Toont wanneer de factuur is verstuurd (of dat het mislukte).
   * @param {object} invoice de factuur
   * @returns {string} HTML van de cel
   */
  const sentCell = (invoice) => (invoice.sentAt ? esc(day(invoice.sentAt)) : invoice.sendError ? '<span class="fail" title="' + esc(invoice.sendError) + '">mislukt</span>' : '<span class="muted">–</span>');

  // ---------- Overzicht ----------
  /**
   * Geeft de facturen die door het statusfilter en de zoekterm komen.
   * @returns {object[]} de zichtbare facturen
   */
  function visible() {
    const status = $('#f-status').value;
    const term = $('#f-search').value.trim().toLowerCase();
    return state.items.filter((invoice) => (!status || (status === 'overdue' ? invoice.overdue : invoice.status === status))
      && (!term || `${invoice.number} ${invoice.customer} ${invoice.workOrderNumber || ''}`.toLowerCase().includes(term)));
  }

  /** Tekent de tellers boven het overzicht. */
  function renderStats() {
    const open = state.items.filter((invoice) => invoice.status === 'definitief');
    const overdue = open.filter((invoice) => invoice.overdue);
    const month = InvoiceCore.today().slice(0, 7);
    const thisMonth = state.items.filter((invoice) => invoice.status !== 'concept' && invoice.date.slice(0, 7) === month);
    $('#v-stats').innerHTML = [
      [eur(open.reduce((total, invoice) => total + invoice.total, 0)), `openstaand (${open.length})`],
      [eur(overdue.reduce((total, invoice) => total + invoice.total, 0)), `over de vervaldatum (${overdue.length})`],
      [eur(thisMonth.reduce((total, invoice) => total + invoice.subtotal, 0)), 'gefactureerd deze maand (excl. btw)'],
      [state.items.filter((invoice) => invoice.status === 'concept').length, 'concepten'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
  }

  /** Tekent de tabel met facturen. */
  function renderList() {
    const table = $('#l-table');
    if (!state.items.length) {
      table.innerHTML = '<tbody><tr><td class="empty">Nog geen facturen. Open een werkorder en kies in het menu <b>Factuur maken</b>, of maak een <b>losse factuur</b>.</td></tr></tbody>';
      return;
    }
    const items = visible();
    table.innerHTML = `<thead><tr><th>Nummer</th><th>Datum</th><th>Klant</th><th>Status</th><th>Vervalt</th><th class="num">Excl. btw</th><th class="num">Totaal</th><th>Verstuurd</th><th>Boekhouding</th></tr></thead>
      <tbody>${items.map((invoice) => `<tr data-id="${esc(invoice.id)}">
        <td><b>${esc(invoice.number || 'Concept')}</b>${kindPill(invoice)}</td>
        <td>${esc(day(invoice.date))}</td>
        <td class="wrap">${esc(invoice.customer || '–')}</td>
        <td>${statusPill(invoice)}</td>
        <td>${esc(day(invoice.dueDate))}</td>
        <td class="num${invoice.subtotal < 0 ? ' neg' : ''}">${esc(eur(invoice.subtotal))}</td>
        <td class="num${invoice.total < 0 ? ' neg' : ''}"><b>${esc(eur(invoice.total))}</b></td>
        <td>${sentCell(invoice)}</td>
        <td>${bookCell(invoice)}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Niets gevonden.</td></tr>'}</tbody>`;
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Opent de factuur.
       * @returns {Promise<void>}
       */
      row.onclick = () => openInvoice(row.dataset.id, true);
    });
  }

  /**
   * Laadt de facturen in de gekozen periode en tekent het overzicht.
   * @returns {Promise<void>}
   */
  async function load() {
    const from = $('#f-from').value;
    const to = $('#f-to').value;
    state.items = (await api(`invoices?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).items;
    renderStats();
    renderList();
    renderOrders();
  }

  // ---------- Webshopbestellingen ----------
  /** Toont de knop en de uitleg voor webshopbestellingen (als die aan staan). */
  function renderOrders() {
    const shopOrders = state.settings && state.settings.shopOrders;
    const enabled = Boolean(shopOrders && shopOrders.enabled && state.config.shop && state.config.shop.url);
    $('#b-orders').hidden = !enabled;
    const panel = $('#l-orders');
    const orderStatus = state.config.shop && state.config.shop.orders;
    panel.hidden = !enabled;
    if (!enabled) return;
    panel.innerHTML = `Webshopbestellingen met status <b>${esc(InvoiceCore.SHOP_STATUSES[shopOrders.status])}</b> worden elke 10 minuten gefactureerd${orderStatus && orderStatus.syncedAt ? ` (laatst opgehaald ${esc(when(orderStatus.syncedAt))})` : ''}.`
      + (orderStatus && orderStatus.error ? ` <span class="fail">${esc(orderStatus.error)}</span>` : '');
  }

  /**
   * Haalt nu de webshopbestellingen op en maakt er facturen van.
   * @returns {Promise<void>}
   */
  async function fetchOrders() {
    const ordersButton = $('#b-orders');
    ordersButton.disabled = true;
    try {
      const result = await api('invoices/shop-orders/sync', { method: 'POST', body: {} });
      state.config.shop.orders = result.status;
      const parts = [`${result.imported} nieuwe ${result.imported === 1 ? 'factuur' : 'facturen'}`];
      if (result.sent) parts.push(`${result.sent} verstuurd`);
      if (result.paid) parts.push(`${result.paid} al betaald`);
      toast(`Webshop: ${parts.join(', ')}`);
      await load();
    } catch (error) {
      toast(error.message, true);
    } finally {
      ordersButton.disabled = false;
    }
  }

  // ---------- Debiteuren ----------
  /**
   * Laadt de debiteuren (met de zoekterm) en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadDebtors() {
    const term = $('#d-search').value.trim();
    state.debtors = (await api(`debtors?q=${encodeURIComponent(term)}`)).items;
    renderDebtors();
  }

  /** Tekent de tabel met debiteuren. */
  function renderDebtors() {
    const table = $('#d-table');
    if (!state.debtors.length) {
      table.innerHTML = `<tbody><tr><td class="empty">${$('#d-search').value.trim() ? 'Niets gevonden.' : 'Nog geen debiteuren. Een debiteur ontstaat vanzelf als een factuur definitief wordt of uit een webshopbestelling komt.'}</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `<thead><tr><th>Nummer</th><th>Naam</th><th>E-mail</th><th>Plaats</th><th>Bron</th><th class="num">Facturen</th><th class="num">Openstaand</th><th>Laatste factuur</th></tr></thead>
      <tbody>${state.debtors.map((debtor) => {
        const place = (debtor.address.split('\n').slice(-1)[0] || '').replace(/^\d{4}\s?[A-Z]{2}\s+/, '');
        return `<tr data-id="${esc(debtor.id)}">
          <td><b>${esc(debtor.number)}</b></td>
          <td class="wrap">${esc(debtor.name)}${debtor.contact ? `<span class="sub">t.a.v. ${esc(debtor.contact)}</span>` : ''}</td>
          <td>${esc(debtor.email || '–')}</td>
          <td>${esc(place || '–')}</td>
          <td>${debtor.source === 'webshop' ? '<span class="pill src">Webshop</span>' : esc(debtor.source === 'handmatig' ? 'Handmatig' : 'Factuur')}</td>
          <td class="num">${esc(debtor.invoiceCount)}</td>
          <td class="num">${debtor.openTotal ? `<b>${esc(eur(debtor.openTotal))}</b>` : '<span class="muted">–</span>'}</td>
          <td>${esc(day(debtor.lastInvoice) || '–')}</td>
        </tr>`;
      }).join('')}</tbody>`;
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /** Opent de debiteur om te wijzigen. */
      row.onclick = () => { editDebtor(row.dataset.id); };
    });
  }

  /**
   * Opent het formulier van een debiteur.
   * @param {string} id id van de debiteur
   */
  function editDebtor(id) {
    const debtor = state.debtors.find((candidate) => candidate.id === id);
    if (!debtor) return;
    state.debtor = debtor;
    const formElement = $('#d-form');
    $('#d-title').textContent = `Debiteur ${debtor.number}`;
    for (const key of ['name', 'contact', 'address', 'email', 'phone', 'vatNumber']) formElement[key].value = debtor[key] || '';
    $('.err', formElement).textContent = '';
    formElement.hidden = false;
    formElement.name.focus();
  }

  /** Koppelt zoeken en het formulier van de debiteuren. */
  function setupDebtors() {
    let timer = null;
    /** Zoekt kort na het typen opnieuw. */
    $('#d-search').oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadDebtors().catch((error) => toast(error.message, true)), 250); };
    const formElement = $('#d-form');
    /** Sluit het formulier. */
    $('#d-cancel').onclick = () => { formElement.hidden = true; state.debtor = null; };
    /**
     * Slaat de debiteur op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const body = {};
      for (const key of ['name', 'contact', 'address', 'email', 'phone', 'vatNumber']) body[key] = formElement[key].value;
      try {
        await api(`debtors/${encodeURIComponent(state.debtor.id)}`, { method: 'PUT', body });
        formElement.hidden = true;
        toast('Debiteur opgeslagen');
        await loadDebtors();
      } catch (error) {
        $('.err', formElement).textContent = error.message;
      }
    };
  }

  const TABS = ['list', 'debtors', 'visma', 'export', 'settings'];
  /**
   * Toont een tabblad en laadt wat erop staat.
   * @param {string} name 'list', 'debtors', 'visma', 'export' of 'settings'
   */
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    for (const tabName of TABS) $(`#tab-${tabName}`).hidden = tabName !== name;
    if (name === 'settings') renderSettings();
    if (name === 'visma') loadVisma(true).catch((error) => toast(error.message, true));
    if (name === 'debtors') loadDebtors().catch((error) => toast(error.message, true));
    try { history.replaceState(null, '', `./#${name}`); } catch { /* file:// */ }
  }

  // ---------- Instellingen ----------
  /** Vult het formulier Instellingen (nummering, betaling, mail, webshop, omzetcategorieën). */
  function renderSettings() {
    const settings = state.settings;
    if (!settings) return;
    const formElement = $('#s-form');
    formElement.prefix.value = settings.prefix;
    formElement.paymentDays.value = settings.paymentDays;
    formElement.paymentText.value = settings.paymentText;
    formElement.footer.value = settings.footer;
    formElement.debtorStart.value = settings.debtorStart;
    formElement.autoSend.checked = settings.autoSend;
    formElement.mailSubject.value = settings.mailSubject;
    formElement.mailText.value = settings.mailText;
    $('#s-mailwarn').hidden = state.config.mail !== false;
    const shop = state.config.shop || {};
    formElement.ordersStatus.innerHTML = Object.entries(InvoiceCore.SHOP_STATUSES).map(([key, label]) => `<option value="${esc(key)}"${key === settings.shopOrders.status ? ' selected' : ''}>${esc(label)}</option>`).join('');
    formElement.ordersEnabled.checked = settings.shopOrders.enabled;
    formElement.ordersSince.value = settings.shopOrders.since;
    formElement.ordersFinalize.checked = settings.shopOrders.finalize;
    formElement.webEnabled.checked = settings.webOrders.enabled;
    formElement.webFinalize.checked = settings.webOrders.finalize;
    const noShop = !shop.url || !shop.rest;
    formElement.ordersEnabled.disabled = noShop && !settings.shopOrders.enabled;
    $('#s-shopinfo').innerHTML = !shop.url ? 'Er is nog geen webshop gekoppeld (Beheer → Integraties → Webshop).'
      : !shop.rest ? 'Bestellingen ophalen kan alleen met de REST API van WooCommerce (Beheer → Integraties → Webshop, met API-sleutels).'
        : shop.stockSynced ? 'De voorraad van webshopverkopen wordt al afgeboekt via de webshopkoppeling; de factuur boekt niets extra af.'
          : 'De voorraad gaat niet naar de webshop, dus een definitieve webshopfactuur boekt de artikelen af van de voorraad.';
    /** Toont hoe het volgende factuurnummer eruitziet. */
    const showExample = () => { $('#s-example').textContent = `Volgende nummers zien eruit als ${formElement.prefix.value.trim()}${InvoiceCore.today().slice(0, 4)}-0001.`; };
    formElement.prefix.oninput = showExample;
    showExample();
    $('#s-cats').innerHTML = `<thead><tr><th>Omzetgroep</th><th>Btw</th><th>Naam in de boekhouding</th><th>Grootboekrekening</th></tr></thead><tbody>${
      Object.entries(InvoiceCore.GROUPS).flatMap(([group, groupLabel]) => InvoiceCore.VAT_RATES.map((rate) => {
        const key = InvoiceCore.catKey(group, rate);
        return `<tr><td>${esc(groupLabel)}</td><td>${rate}%</td><td><input data-k="${key}" data-f="name" maxlength="80" value="${esc(settings.categories[key].name)}"></td>
          <td class="acc"><input data-k="${key}" data-f="account" maxlength="20" value="${esc(settings.categories[key].account)}" placeholder="bijv. 8000" inputmode="numeric"></td></tr>`;
      })).join('')}</tbody>`;
  }

  /** Koppelt het formulier Instellingen. */
  function setupSettings() {
    const formElement = $('#s-form');
    /**
     * Slaat de factuurinstellingen op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      const categories = {};
      formElement.querySelectorAll('#s-cats input').forEach((input) => { (categories[input.dataset.k] = categories[input.dataset.k] || {})[input.dataset.f] = input.value; });
      try {
        state.settings = (await api('invoices/settings', { method: 'PUT', body: {
          prefix: formElement.prefix.value.trim(), paymentDays: Number(formElement.paymentDays.value), paymentText: formElement.paymentText.value, footer: formElement.footer.value, categories,
          debtorStart: Number(formElement.debtorStart.value) || undefined, autoSend: formElement.autoSend.checked, mailSubject: formElement.mailSubject.value, mailText: formElement.mailText.value,
          shopOrders: { enabled: formElement.ordersEnabled.checked, status: formElement.ordersStatus.value, since: formElement.ordersSince.value, finalize: formElement.ordersFinalize.checked },
          webOrders: { enabled: formElement.webEnabled.checked, finalize: formElement.webFinalize.checked },
        } })).settings;
        renderSettings();
        renderOrders();
        toast('Instellingen opgeslagen');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  // ---------- Visma eAccounting ----------
  const ENVS = { sandbox: 'sandbox', production: 'productie' };

  /**
   * Laadt de stand van de Visma-koppeling.
   * @param {boolean} withOptions true om ook de artikelen en termijnen uit Visma op te halen
   * @returns {Promise<void>}
   */
  async function loadVisma(withOptions = false) {
    state.visma = await api('visma');
    renderVisma();
    if (withOptions && state.visma.connected && !state.vismaOptions) await loadVismaOptions();
  }

  /**
   * Haalt de artikelen en betalingstermijnen uit Visma op.
   * @returns {Promise<void>}
   */
  async function loadVismaOptions() {
    try {
      state.vismaOptions = await api('visma/options');
    } catch (error) {
      state.vismaOptions = null;
      $('.err', $('#vi-form')).textContent = error.message;
      return;
    }
    renderVismaForm();
  }

  /** Toont de stand van de Visma-koppeling en de knoppen die erbij horen. */
  function renderVisma() {
    const visma = state.visma;
    if (!visma) return;
    const settings = visma.settings;
    let html;
    if (!visma.configured) html = '<p class="notice warn">De koppeling met Visma is nog niet ingesteld door de beheerder van het platform. Zodra dat is gebeurd, kun je hier je administratie verbinden.</p>';
    else if (!visma.connected) html = `<p>Nog niet verbonden. Met <b>Verbinden met Visma</b> log je in bij Visma (${esc(ENVS[visma.environment])}) en kies je de administratie.</p>`;
    else {
      html = `<p><span class="pill st-betaald">Verbonden</span> ${esc(settings.companyName || 'Visma-administratie')}${settings.environment === 'sandbox' ? ' <span class="pill">sandbox</span>' : ''}`
        + `${settings.connectedAt ? ` <span class="muted small">sinds ${esc(when(settings.connectedAt))}${settings.connectedBy ? ` door ${esc(settings.connectedBy)}` : ''}</span>` : ''}</p>`
        + `<p class="muted small">${settings.autoSync ? 'Automatisch doorsturen staat aan' : 'Automatisch doorsturen staat uit; gebruik <b>Nu doorsturen</b> of de knop op een factuur'}${settings.since ? `, facturen vanaf ${esc(day(settings.since))}` : ''}. `
        + `${visma.pending ? `<b>${esc(visma.pending)}</b> ${visma.pending === 1 ? 'factuur wacht' : 'facturen wachten'}${visma.failed ? `, waarvan <span class="fail">${esc(visma.failed)} met een fout</span> (zie de factuur)` : ''}.` : 'Alles is doorgestuurd.'}</p>`;
    }
    $('#vi-status').innerHTML = html;
    $('#vi-connect').hidden = !visma.configured || visma.connected;
    $('#vi-sync').hidden = !visma.connected;
    $('#vi-disconnect').hidden = !visma.connected;
    $('#vi-form').hidden = !visma.connected;
    if (visma.connected) renderVismaForm();
  }

  /** Vult het formulier met de Visma-instellingen (artikel per omzetcategorie, termijn). */
  function renderVismaForm() {
    const visma = state.visma;
    const settings = visma.settings;
    const options = state.vismaOptions || { articles: [], terms: [] };
    const formElement = $('#vi-form');
    const known = new Set(options.articles.map((article) => article.id));
    /**
     * Maakt de keuzelijst met Visma-artikelen.
     * @param {string} current het gekozen artikel
     * @returns {string} HTML met option-elementen
     */
    const articleOptions = (current) => `<option value="">– geen –</option>${options.articles.map((article) => `<option value="${esc(article.id)}"${article.id === current ? ' selected' : ''}>${esc(article.number)} · ${esc(article.name)}</option>`).join('')}`
      + (current && !known.has(current) ? `<option value="${esc(current)}" selected>(gekozen artikel${state.vismaOptions ? ' bestaat niet meer' : ''})</option>` : '');
    const categories = state.settings ? state.settings.categories : {};
    $('#vi-arts').innerHTML = `<thead><tr><th>Omzetcategorie</th><th>Grootboek (export)</th><th>Artikel in Visma</th></tr></thead><tbody>${
      Object.keys(InvoiceCore.GROUPS).flatMap((group) => InvoiceCore.VAT_RATES.map((rate) => {
        const key = InvoiceCore.catKey(group, rate);
        const category = categories[key] || {};
        return `<tr><td>${esc(category.name || key)}</td><td>${esc(category.account || '–')}</td><td><select data-k="${esc(key)}" aria-label="Artikel voor ${esc(category.name || key)}">${articleOptions(settings.articles[key])}</select></td></tr>`;
      })).join('')}</tbody>`;
    const knownTerm = options.terms.some((term) => term.id === settings.termsOfPaymentId);
    formElement.terms.innerHTML = `<option value="">– kies –</option>${options.terms.map((term) => `<option value="${esc(term.id)}"${term.id === settings.termsOfPaymentId ? ' selected' : ''}>${esc(term.name)}</option>`).join('')}`
      + (settings.termsOfPaymentId && !knownTerm ? `<option value="${esc(settings.termsOfPaymentId)}" selected>(gekozen termijn)</option>` : '');
    formElement.autoSync.checked = settings.autoSync;
    formElement.since.value = settings.since;
  }

  /** Koppelt de knoppen en het formulier van Visma. */
  function setupVisma() {
    const formElement = $('#vi-form');
    /**
     * Start het verbinden met Visma (doorsturen naar de aanmelding).
     * @returns {Promise<void>}
     */
    $('#vi-connect').onclick = async () => {
      try {
        const result = await api('visma/connect', { method: 'POST', body: {} });
        location.href = result.url;
      } catch (error) { toast(error.message, true); }
    };
    /**
     * Verbreekt de verbinding na bevestiging.
     * @returns {Promise<void>}
     */
    $('#vi-disconnect').onclick = async () => {
      if (!confirm('De verbinding met Visma verbreken? Facturen gaan dan niet meer naar Visma tot je opnieuw verbindt. Wat al in Visma staat, blijft daar.')) return;
      try {
        state.visma = await api('visma/disconnect', { method: 'POST', body: {} });
        state.vismaOptions = null;
        renderVisma();
        toast('Verbinding met Visma verbroken');
      } catch (error) { toast(error.message, true); }
    };
    /**
     * Stuurt de wachtende facturen nu naar Visma.
     * @returns {Promise<void>}
     */
    $('#vi-sync').onclick = async () => {
      const syncButton = $('#vi-sync');
      syncButton.disabled = true;
      try {
        const result = await api('visma/sync', { method: 'POST', body: {} });
        state.visma = result.status;
        renderVisma();
        const message = `${result.sent} ${result.sent === 1 ? 'factuur' : 'facturen'} naar Visma${result.failed ? `, ${result.failed} mislukt: ${result.errors[0] || ''}` : ''}`;
        toast(message, Boolean(result.failed));
        load().catch(() => {});
      } catch (error) {
        toast(error.message, true);
      } finally {
        syncButton.disabled = false;
      }
    };
    /** Haalt de artikelen en termijnen opnieuw uit Visma. */
    $('#vi-reload').onclick = () => { state.vismaOptions = null; $('.err', formElement).textContent = ''; loadVismaOptions(); };
    /**
     * Slaat de Visma-instellingen op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      const articles = {};
      formElement.querySelectorAll('#vi-arts select').forEach((select) => { if (select.value) articles[select.dataset.k] = select.value; });
      try {
        state.visma = await api('visma/settings', { method: 'PUT', body: { articles, termsOfPaymentId: formElement.terms.value, autoSync: formElement.autoSync.checked, since: formElement.since.value } });
        renderVisma();
        toast('Visma-instellingen opgeslagen');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  /**
   * Terug van Visma na het verbinden (?visma=…): melding, adres opschonen.
   * @param {URLSearchParams} params de querystring van de pagina
   * @returns {boolean} true als de pagina terugkwam van Visma
   */
  function vismaReturn(params) {
    const result = params.get('visma');
    if (!result) return false;
    const reasons = {
      invalid_state: 'de aanmelding was verlopen; probeer het opnieuw',
      token_failed: 'Visma weigerde de aanmelding (controleer de app-gegevens in Hoofdbeheer)',
      not_configured: 'de koppeling is nog niet ingesteld',
      unreachable: 'Visma was niet bereikbaar',
    };
    if (result === 'verbonden') toast('Verbonden met Visma');
    else if (result === 'geweigerd') toast('Verbinden met Visma is afgebroken.', true);
    else toast(`Verbinden met Visma mislukt: ${reasons[params.get('reden')] || 'onbekende fout'}.`, true);
    try { history.replaceState(null, '', './#visma'); } catch { /* file:// */ }
    return true;
  }

  // ---------- Factuur ----------
  /**
   * Zegt of de geopende factuur nog te wijzigen is (concept).
   * @returns {boolean} true bij een concept
   */
  const editable = () => state.invoice && state.invoice.status === 'concept';

  /**
   * Maakt een factuurregel: alleen lezen of met invoervelden.
   * @param {object} line de regel
   * @param {boolean} readOnly true voor een definitieve factuur
   * @returns {string} HTML van de regel
   */
  function lineRow(line, readOnly) {
    const total = InvoiceCore.lineTotal(line);
    if (readOnly) {
      return `<tr><td class="c-code"><span class="code">${esc(line.code)}</span></td><td class="c-desc">${esc(line.description)}</td><td class="c-qty num">${esc(line.qty)}</td>
        <td class="c-unit">${esc(line.unit)}</td><td class="c-price num">${esc(eur(line.price))}</td><td class="c-vat">${line.vat}%</td><td class="c-group">${esc(InvoiceCore.GROUPS[line.group])}</td>
        <td class="c-total${total < 0 ? ' neg' : ''}">${esc(eur(total))}</td><td class="c-del"></td></tr>`;
    }
    /**
     * Maakt option-elementen uit een object.
     * @param {object} choices waarde → label
     * @param {*} selected de gekozen waarde
     * @returns {string} HTML met option-elementen
     */
    const optionList = (choices, selected) => Object.entries(choices).map(([key, label]) => `<option value="${esc(key)}"${String(key) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<tr data-line="${esc(line.id)}">
      <td class="c-code"><input data-f="code" value="${esc(line.code)}" list="article-codes" maxlength="40" placeholder="Code" aria-label="Artikelcode"></td>
      <td class="c-desc"><input data-f="description" value="${esc(line.description)}" maxlength="500" placeholder="Omschrijving" aria-label="Omschrijving"></td>
      <td class="c-qty"><input data-f="qty" value="${esc(line.qty)}" inputmode="decimal" aria-label="Aantal"></td>
      <td class="c-unit"><input data-f="unit" value="${esc(line.unit)}" maxlength="12" placeholder="st" aria-label="Eenheid"></td>
      <td class="c-price"><input data-f="price" value="${esc(line.price)}" inputmode="decimal" aria-label="Prijs excl. btw"></td>
      <td class="c-vat"><select data-f="vat" aria-label="Btw">${optionList({ 21: '21%', 9: '9%', 0: '0%' }, line.vat)}</select></td>
      <td class="c-group"><select data-f="group" aria-label="Omzetgroep">${optionList(InvoiceCore.GROUPS, line.group)}</select></td>
      <td class="c-total${total < 0 ? ' neg' : ''}">${esc(eur(total))}</td>
      <td class="c-del"><button class="btn small ghost" data-del title="Regel verwijderen" aria-label="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  /** Tekent de regels en de totalen. */
  function renderLines() {
    const data = state.invoice.data;
    const readOnly = !editable();
    $('#e-lines').innerHTML = `<thead><tr><th class="c-code">Code</th><th>Omschrijving</th><th class="c-qty">Aantal</th><th class="c-unit">Eenh.</th><th class="c-price">Prijs excl.</th>
      <th class="c-vat">Btw</th><th class="c-group">Omzetgroep</th><th class="c-total">Totaal</th><th class="c-del"></th></tr></thead>
      <tbody>${data.lines.map((line) => lineRow(line, readOnly)).join('') || '<tr><td colspan="9" class="empty">Nog geen regels.</td></tr>'}</tbody>`;
    renderTotals();
  }

  /** Tekent de totalen, de btw en de omzet per categorie. */
  function renderTotals() {
    const totals = InvoiceCore.totals(state.invoice.data, state.settings);
    $('#e-totals').innerHTML = `<div><h4>Omzet per categorie (voor de boekhouding)</h4><table>${totals.categories.map((category) => `<tr>
        <td>${esc(category.name)}${category.account ? ` <span class="muted small">(${esc(category.account)})</span>` : ' <span class="muted small">(geen grootboekrekening)</span>'}</td>
        <td class="num">${esc(eur(category.base))}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
      <div><table>
        <tr><td>Subtotaal</td><td class="num">${esc(eur(totals.subtotal))}</td></tr>
        ${totals.discount ? `<tr><td>Korting ${esc(totals.discountPct)}%</td><td class="num">− ${esc(eur(totals.discount))}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${esc(eur(totals.net))}</td></tr>` : ''}
        ${totals.vat.map((vatLine) => `<tr><td>Btw ${vatLine.rate}% over ${esc(eur(vatLine.base))}</td><td class="num">${esc(eur(vatLine.amount))}</td></tr>`).join('')}
        <tr class="grand"><td>Totaal</td><td class="num">${esc(eur(totals.total))}</td></tr>
      </table></div>`;
  }

  /** Tekent de geopende factuur: kop, knoppen, koppelingen, klant, gegevens en regels. */
  function renderInvoice() {
    const invoice = state.invoice;
    const data = invoice.data;
    const readOnly = !editable();
    $('#e-title').textContent = `${invoice.kind === 'credit' ? 'Creditfactuur' : 'Factuur'} ${invoice.number || '(concept)'}`;
    document.title = `${invoice.number || 'Concept'} – Facturen`;
    $('#e-state').innerHTML = `${statusPill(invoice)}${invoice.creditedAt ? ' <span class="pill credit">Gecrediteerd</span>' : ''}${invoice.exportedAt ? ` <span class="muted small">geëxporteerd ${esc(day(invoice.exportedAt))}</span>` : ''}`;
    $('#e-save').hidden = readOnly;
    $('#e-final').hidden = readOnly;
    $('#e-add').hidden = readOnly;
    $('#e-del').hidden = readOnly;
    $('#e-paid').hidden = invoice.status === 'concept';
    $('#e-paid').textContent = invoice.status === 'betaald' ? 'Toch niet betaald' : 'Betaald';
    $('#e-credit').hidden = invoice.status === 'concept' || invoice.kind === 'credit';
    $('#e-send').hidden = invoice.status === 'concept';
    $('#e-send').textContent = invoice.sentAt ? 'Opnieuw versturen' : 'Versturen';
    $('#e-visma').hidden = invoice.status === 'concept' || Boolean(invoice.vismaInvoiceId) || !(state.visma && state.visma.connected);
    $('#e-sendform').hidden = true;
    const links = [];
    if (invoice.workOrderId) links.push(`Werkorder <a href="../werkorders/?id=${encodeURIComponent(invoice.workOrderId)}">${esc(data.workOrderNumber || 'openen')}</a>`);
    if (invoice.quoteId) links.push(`offerte <a href="../offertes/?id=${encodeURIComponent(invoice.quoteId)}">${esc(data.quoteNumber || 'openen')}</a>`);
    if (invoice.creditOf) links.push(`credit van <a href="./?id=${encodeURIComponent(invoice.creditOf)}">${esc(data.creditOfNumber || 'factuur')}</a>`);
    if (invoice.source === 'webshop') links.push(esc(data.reference || 'webshopbestelling'));
    if (invoice.debtorNumber) links.push(`debiteur ${esc(invoice.debtorNumber)}`);
    if (invoice.paidAt) links.push(`betaald op ${esc(day(invoice.paidAt))}`);
    if (invoice.sentAt) links.push(`verstuurd naar ${esc(invoice.sentTo)} op ${esc(when(invoice.sentAt))}`);
    if (invoice.vismaInvoiceId) links.push(`in Visma als factuur ${esc(invoice.vismaNumber || '')} (${esc(when(invoice.vismaSyncedAt))})`);
    if (!invoice.workOrderId && invoice.status !== 'concept') links.push(invoice.stockBooked ? 'artikelen van de voorraad afgeboekt' : invoice.source === 'webshop' ? 'voorraad via de webshop' : 'geen voorraad geboekt');
    if (!invoice.workOrderId && invoice.source !== 'webshop' && invoice.status === 'concept') links.push('losse verkoop: bij definitief worden artikelen met een voorraadcode afgeboekt');
    $('#e-links').innerHTML = links.join(' · ');
    const customerForm = $('#c-form');
    for (const key of ['name', 'contact', 'address', 'email', 'vatNumber']) { customerForm[key].value = data.customer[key] || ''; customerForm[key].disabled = readOnly; }
    const metaForm = $('#m-form');
    for (const key of ['date', 'dueDate', 'reference', 'intro', 'notes']) { metaForm[key].value = data[key] || ''; metaForm[key].disabled = readOnly; }
    metaForm.discountPct.value = data.discountPct || '';
    metaForm.discountPct.disabled = readOnly;
    $('#article-codes').innerHTML = Object.entries(state.articles).map(([code, article]) => `<option value="${esc(code)}">${esc(article.name)}${article.salePrice != null ? ` – ${esc(eur(article.salePrice))}` : ''}</option>`).join('');
    renderLines();
  }

  /**
   * Toont waarschuwingen boven de factuur (ook een mislukte verzending of Visma-fout).
   * @param {string[]} list waarschuwingen van de server
   */
  function warn(list) {
    const invoice = state.invoice;
    const allWarnings = [...(list || []), ...(invoice && invoice.sendError && !invoice.sentAt ? [invoice.sendError] : []),
      ...(invoice && invoice.vismaError && !invoice.vismaInvoiceId ? [`Visma: ${invoice.vismaError}`] : [])];
    const warningBox = $('#e-warn');
    warningBox.hidden = !allWarnings.length;
    warningBox.innerHTML = allWarnings.map(esc).join('<br>');
  }

  /** Formulier -> state.invoice.data */
  function readForm() {
    const data = state.invoice.data;
    const customerForm = $('#c-form');
    for (const key of ['name', 'contact', 'address', 'email', 'vatNumber']) data.customer[key] = customerForm[key].value;
    const metaForm = $('#m-form');
    for (const key of ['date', 'dueDate', 'reference', 'intro', 'notes']) data[key] = metaForm[key].value;
    data.discountPct = num(metaForm.discountPct.value);
  }

  /** Markeert dat er niet-opgeslagen wijzigingen zijn. */
  function changed() {
    state.dirty = true;
    $('#e-save').textContent = 'Opslaan *';
  }

  /**
   * Slaat een concept op.
   * @returns {Promise<boolean>} true als het lukte (of er niets op te slaan was)
   */
  async function save() {
    if (!editable()) return true;
    readForm();
    try {
      const saved = await api(`invoices/${encodeURIComponent(state.invoice.id)}`, { method: 'PUT', body: { data: state.invoice.data } });
      state.invoice = saved;
      state.dirty = false;
      $('#e-save').textContent = 'Opslaan';
      return true;
    } catch (error) {
      toast(`Opslaan mislukt: ${error.message}`, true);
      return false;
    }
  }

  /** Koppelt alle knoppen en formulieren van de factuur. */
  function setupEditor() {
    const back = $('#e-back');
    const from = window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from && new URLSearchParams(location.search).get('id')) {
      back.textContent = from.label;
      back.href = from.href;
      /**
       * Slaat op en gaat terug naar de pagina waar je vandaan kwam.
       * @param {MouseEvent} event de klik
       * @returns {Promise<void>}
       */
      back.onclick = async (event) => { event.preventDefault(); await save(); from.go(); };
    } else {
      /**
       * Slaat op en gaat terug naar het overzicht.
       * @param {MouseEvent} event de klik
       * @returns {Promise<void>}
       */
      back.onclick = async (event) => { event.preventDefault(); await save(); history.pushState(null, '', './'); showList(); load().catch(() => {}); };
    }
    for (const formElement of [$('#c-form'), $('#m-form')]) {
      /** Markeert een wijziging en werkt bij de gegevens de totalen bij. */
      formElement.oninput = () => { changed(); if (formElement.id === 'm-form') { readForm(); renderTotals(); } };
      /**
       * Voorkomt het verzenden van het formulier (opslaan gaat via de knop).
       * @param {SubmitEvent} event het verzenden
       * @returns {*} niets
       */
      formElement.onsubmit = (event) => event.preventDefault();
    }
    /** Vult de vervaldatum uit de factuurdatum en de betaaltermijn. */
    $('#m-form').date.onchange = () => {
      const metaForm = $('#m-form');
      if (InvoiceCore.isDate(metaForm.date.value)) metaForm.dueDate.value = InvoiceCore.addDays(metaForm.date.value, state.settings.paymentDays);
      changed();
    };
    const table = $('#e-lines');
    /**
     * Verwerkt een wijziging in een regel (bekende artikelcode vult de rest in).
     * @param {InputEvent} event de invoer
     */
    table.oninput = (event) => {
      const row = event.target.closest('tr[data-line]');
      if (!row) return;
      const line = state.invoice.data.lines.find((candidate) => candidate.id === row.dataset.line);
      const field = event.target.dataset.f;
      if (!line || !field) return;
      line[field] = ['qty', 'price', 'vat'].includes(field) ? num(event.target.value) : event.target.value;
      // Bekende artikelcode: omschrijving, eenheid, prijs, btw en groep uit voorraadbeheer.
      if (field === 'code') {
        const article = state.articles[event.target.value.trim().toUpperCase()];
        if (article) {
          Object.assign(line, { code: event.target.value.trim().toUpperCase(), description: line.description || article.name, unit: line.unit || article.unit, vat: article.vatRate, group: article.revenueGroup });
          if (article.salePrice != null && !line.price) line.price = article.salePrice;
          const cursor = event.target.selectionStart;
          renderLines();
          const codeInput = $(`tr[data-line="${line.id}"] input[data-f=code]`);
          if (codeInput) { codeInput.focus(); try { codeInput.setSelectionRange(cursor, cursor); } catch { /* geen tekstveld */ } }
        }
      }
      const cell = row.querySelector('.c-total');
      if (cell) cell.textContent = eur(InvoiceCore.lineTotal(line));
      renderTotals();
      changed();
    };
    table.onchange = table.oninput;
    /**
     * Verwijdert een regel.
     * @param {MouseEvent} event de klik
     */
    table.onclick = (event) => {
      if (!event.target.closest('[data-del]')) return;
      const row = event.target.closest('tr[data-line]');
      state.invoice.data.lines = state.invoice.data.lines.filter((line) => line.id !== row.dataset.line);
      renderLines();
      changed();
    };
    /** Voegt een lege regel toe. */
    $('#e-add').onclick = () => {
      state.invoice.data.lines.push(InvoiceCore.sanitizeLine({ qty: 1, vat: 21, group: 'producten' }));
      renderLines();
      changed();
      const rows = table.querySelectorAll('tr[data-line]');
      if (rows.length) $('input[data-f=code]', rows[rows.length - 1]).focus();
    };
    /**
     * Slaat op.
     * @returns {Promise<void>}
     */
    $('#e-save').onclick = async () => { if (await save()) { renderInvoice(); toast('Opgeslagen'); } };
    /**
     * Maakt de factuur definitief na bevestiging.
     * @returns {Promise<void>}
     */
    $('#e-final').onclick = async () => {
      if (!await save()) return;
      const totals = InvoiceCore.totals(state.invoice.data, state.settings);
      if (!confirm(`Factuur definitief maken? Totaal ${eur(totals.total)}.\n\nHij krijgt dan een factuurnummer en kan niet meer worden aangepast (alleen gecrediteerd).`)) return;
      try {
        state.invoice = await api(`invoices/${encodeURIComponent(state.invoice.id)}/finalize`, { method: 'POST', body: {} });
        renderInvoice();
        warn([]);
        toast(`Factuur ${state.invoice.number} is definitief${state.invoice.autoSent ? ` en verstuurd naar ${state.invoice.sentTo}` : ''}`);
      } catch (error) {
        toast(error.message, true);
      }
    };
    /**
     * Markeert de factuur als betaald (of weer als openstaand).
     * @returns {Promise<void>}
     */
    $('#e-paid').onclick = async () => {
      const paid = state.invoice.status !== 'betaald';
      try {
        state.invoice = await api(`invoices/${encodeURIComponent(state.invoice.id)}/paid`, { method: 'POST', body: { paid } });
        renderInvoice();
        toast(paid ? 'Gemarkeerd als betaald' : 'Weer openstaand');
      } catch (error) { toast(error.message, true); }
    };
    /**
     * Maakt een creditfactuur en opent die.
     * @returns {Promise<void>}
     */
    $('#e-credit').onclick = async () => {
      if (!confirm(`Een creditfactuur maken voor ${state.invoice.number}? Je krijgt een concept met dezelfde regels in min; pas het aan voor een gedeeltelijke creditering.`)) return;
      try {
        const credit = await api(`invoices/${encodeURIComponent(state.invoice.id)}/credit`, { method: 'POST', body: {} });
        openInvoice(credit.id, true);
      } catch (error) { toast(error.message, true); }
    };
    /**
     * Verwijdert het concept na bevestiging.
     * @returns {Promise<void>}
     */
    $('#e-del').onclick = async () => {
      if (!confirm('Dit concept verwijderen?')) return;
      try {
        await api(`invoices/${encodeURIComponent(state.invoice.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast('Concept verwijderd');
        history.pushState(null, '', './');
        showList();
        load().catch(() => {});
      } catch (error) { toast(error.message, true); }
    };
    /**
     * Eerst opslaan, dan de PDF van de server in een nieuw tabblad.
     * @returns {Promise<void>}
     */
    $('#e-pdf').onclick = async () => {
      // Eerst opslaan, dan de PDF van de server in een nieuw tabblad.
      const newWindow = window.open('', '_blank');
      await save();
      const url = `../api/invoices/${encodeURIComponent(state.invoice.id)}/pdf`;
      if (newWindow) newWindow.location.href = url; else location.href = `${url}?download=1`;
    };
    const sendForm = $('#e-sendform');
    /**
     * Opent het verzendformulier met het voorstel van de server.
     * @returns {Promise<void>}
     */
    $('#e-send').onclick = async () => {
      try {
        const mail = await api(`invoices/${encodeURIComponent(state.invoice.id)}/mail`);
        if (!mail.configured) { toast('Er is geen mailserver ingesteld (Beheer → Integraties → E-mail).', true); return; }
        sendForm.to.value = mail.to;
        sendForm.subject.value = mail.subject;
        sendForm.message.value = mail.message;
        $('.err', sendForm).textContent = '';
        sendForm.hidden = false;
        const field = mail.to ? sendForm.message : sendForm.to;
        field.focus();
        if (field === sendForm.message) { sendForm.message.setSelectionRange(0, 0); sendForm.message.scrollTop = 0; }
      } catch (error) { toast(error.message, true); }
    };
    /** Sluit het verzendformulier. */
    $('#e-sendcancel').onclick = () => { sendForm.hidden = true; };
    /**
     * Stuurt de factuur naar Visma.
     * @returns {Promise<void>}
     */
    $('#e-visma').onclick = async () => {
      const vismaButton = $('#e-visma');
      vismaButton.disabled = true;
      try {
        state.invoice = await api(`visma/invoices/${encodeURIComponent(state.invoice.id)}`, { method: 'POST', body: {} });
        renderInvoice();
        warn([]);
        toast(`In Visma als factuur ${state.invoice.vismaNumber || ''}`);
      } catch (error) {
        // De fout staat nu ook bij de factuur.
        try { state.invoice = await api(`invoices/${encodeURIComponent(state.invoice.id)}`); renderInvoice(); warn([]); } catch { /* niet erg */ }
        toast(error.message, true);
      } finally {
        vismaButton.disabled = false;
      }
    };
    /**
     * Verstuurt de factuur per e-mail.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    sendForm.onsubmit = async (event) => {
      event.preventDefault();
      const submitButton = $('button[type=submit]', sendForm);
      submitButton.disabled = true;
      try {
        state.invoice = await api(`invoices/${encodeURIComponent(state.invoice.id)}/send`, { method: 'POST', body: { to: sendForm.to.value, subject: sendForm.subject.value, message: sendForm.message.value } });
        renderInvoice();
        warn([]);
        toast(`Verstuurd naar ${state.invoice.sentTo}`);
      } catch (error) {
        $('.err', sendForm).textContent = error.message;
      } finally {
        submitButton.disabled = false;
      }
    };
    window.addEventListener('beforeunload', (event) => {
      if (state.dirty) { save(); event.preventDefault(); event.returnValue = ''; }
    });
  }

  /**
   * Opent een factuur.
   * @param {string} id id van de factuur
   * @param {boolean} push true om het adres (?id=) in de geschiedenis te zetten
   * @param {Promise<object>|null} pending het al lopende verzoek om de factuur (of null)
   * @returns {Promise<void>}
   */
  async function openInvoice(id, push = false, pending = null) {
    try {
      state.invoice = await (pending || api(`invoices/${encodeURIComponent(id)}`));
    } catch (error) {
      toast(error.status === 404 ? 'Factuur niet gevonden.' : error.message, true);
      showList();
      return;
    }
    if (push) history.pushState(null, '', `./?id=${encodeURIComponent(id)}`);
    state.dirty = false;
    $('#e-save').textContent = 'Opslaan';
    $('#v-list').hidden = true;
    $('#v-edit').hidden = false;
    warn(state.invoice.warnings);
    renderInvoice();
    window.scrollTo(0, 0);
  }

  /** Toont het overzicht in plaats van de factuur. */
  function showList() {
    $('#v-edit').hidden = true;
    $('#v-list').hidden = false;
    document.title = 'Facturen – AquaTech Service';
  }

  // ---------- Export voor de boekhouding (Excel) ----------
  /**
   * Export voor de boekhouding: Excel met omzetregels, facturen, totalen per
   * categorie en debiteuren; daarna optioneel markeren als geëxporteerd.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function exportExcel(event) {
    event.preventDefault();
    const formElement = $('#x-form');
    const errorBox = $('.err', formElement);
    errorBox.textContent = '';
    $('#x-result').textContent = '';
    const submitButton = $('button[type=submit]', formElement);
    submitButton.disabled = true;
    try {
      const result = await api(`invoices/export?from=${encodeURIComponent(formElement.from.value)}&to=${encodeURIComponent(formElement.to.value)}${formElement.onlyNew.checked ? '&new=1' : ''}`);
      if (!result.items.length) { errorBox.textContent = 'Geen facturen om te exporteren in deze periode.'; return; }
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { errorBox.textContent = 'Excel-export niet beschikbaar.'; return; }
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const money = { numFmt: '€ #,##0.00' };
      /**
       * Maakt een Date van een datum.
       * @param {string} iso datum als 'jjjj-mm-dd'
       * @returns {Date|null} de datum, of null
       */
      const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);
      /**
       * Maakt de kopregel vet en zet er een filter op.
       * @param {object} sheet het werkblad
       * @param {number} columnCount aantal kolommen
       */
      const styleHeader = (sheet, columnCount) => { sheet.getRow(1).font = { bold: true }; sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columnCount)}1` }; };

      // 1. Omzetregels: per factuur per omzetcategorie (verkoopboeking).
      const rows = InvoiceCore.exportRows(result.items, result.settings);
      const revenueSheet = workbook.addWorksheet('Omzetregels', { views: [{ state: 'frozen', ySplit: 1 }] });
      revenueSheet.columns = [
        { header: 'Factuurnummer', key: 'number', width: 15 }, { header: 'Soort', key: 'kind', width: 13 },
        { header: 'Factuurdatum', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Vervaldatum', key: 'dueDate', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Debiteurnummer', key: 'debtorNumber', width: 15 }, { header: 'Debiteur', key: 'customer', width: 30 }, { header: 'Omschrijving', key: 'reference', width: 30 },
        { header: 'Omzetcategorie', key: 'category', width: 30 }, { header: 'Grootboekrekening', key: 'account', width: 18 },
        { header: 'Btw-tarief', key: 'rate', width: 10 }, { header: 'Bedrag excl. btw', key: 'base', width: 16, style: money },
        { header: 'Btw', key: 'vat', width: 12, style: money }, { header: 'Bedrag incl. btw', key: 'total', width: 16, style: money },
      ];
      for (const row of rows) revenueSheet.addRow({ ...row, kind: InvoiceCore.KINDS[row.kind] || row.kind, date: asDate(row.date), dueDate: asDate(row.dueDate), rate: `${row.rate}%` });
      styleHeader(revenueSheet, 13);

      // 2. Facturen: één regel per factuur.
      const invoiceSheet = workbook.addWorksheet('Facturen', { views: [{ state: 'frozen', ySplit: 1 }] });
      invoiceSheet.columns = [
        { header: 'Factuurnummer', key: 'number', width: 15 }, { header: 'Soort', key: 'kind', width: 13 },
        { header: 'Factuurdatum', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Vervaldatum', key: 'dueDate', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Debiteurnummer', key: 'debtorNumber', width: 15 }, { header: 'Debiteur', key: 'customer', width: 30 }, { header: 'Status', key: 'status', width: 12 },
        { header: 'Excl. btw', key: 'net', width: 14, style: money }, { header: 'Btw 21%', key: 'v21', width: 12, style: money },
        { header: 'Btw 9%', key: 'v9', width: 12, style: money }, { header: 'Totaal', key: 'total', width: 14, style: money },
        { header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Betaald op', key: 'paid', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
      ];
      for (const invoice of result.items) {
        const totals = InvoiceCore.totals(invoice.data, result.settings);
        /**
         * Geeft het btw-bedrag van een tarief.
         * @param {number} rate 21 of 9
         * @returns {number} het bedrag (0 als het tarief niet voorkomt)
         */
        const vatOf = (rate) => (totals.vat.find((vatLine) => vatLine.rate === rate) || {}).amount || 0;
        invoiceSheet.addRow({ number: invoice.number, kind: InvoiceCore.KINDS[invoice.kind], date: asDate(invoice.data.date), dueDate: asDate(invoice.data.dueDate), debtorNumber: invoice.debtorNumber || '', customer: invoice.data.customer.name,
          status: InvoiceCore.STATUSES[invoice.status], net: totals.net, v21: vatOf(21), v9: vatOf(9), total: totals.total, wo: invoice.data.workOrderNumber, paid: invoice.paidAt ? asDate(invoice.paidAt.slice(0, 10)) : null });
      }
      styleHeader(invoiceSheet, 13);

      // 3. Totalen per omzetcategorie (controle tegen de boekhouding).
      const totalsSheet = workbook.addWorksheet('Totalen per categorie');
      totalsSheet.columns = [
        { header: 'Omzetcategorie', key: 'category', width: 32 }, { header: 'Grootboekrekening', key: 'account', width: 18 },
        { header: 'Btw-tarief', key: 'rate', width: 10 }, { header: 'Bedrag excl. btw', key: 'base', width: 16, style: money },
        { header: 'Btw', key: 'vat', width: 12, style: money }, { header: 'Bedrag incl. btw', key: 'total', width: 16, style: money },
      ];
      const sums = new Map();
      for (const row of rows) {
        const key = `${row.category}|${row.account}|${row.rate}`;
        const sum = sums.get(key) || { category: row.category, account: row.account, rate: `${row.rate}%`, base: 0, vat: 0, total: 0 };
        sum.base = InvoiceCore.round2(sum.base + row.base); sum.vat = InvoiceCore.round2(sum.vat + row.vat); sum.total = InvoiceCore.round2(sum.total + row.total);
        sums.set(key, sum);
      }
      for (const sum of sums.values()) totalsSheet.addRow(sum);
      totalsSheet.getRow(1).font = { bold: true };

      // 4. Debiteuren (om in Visma aan te maken of te controleren).
      const debtorSheet = workbook.addWorksheet('Debiteuren');
      debtorSheet.columns = [{ header: 'Debiteurnummer', key: 'debtorNumber', width: 15 }, { header: 'Naam', key: 'name', width: 32 }, { header: 'T.a.v.', key: 'contact', width: 22 }, { header: 'Adres', key: 'address', width: 40 },
        { header: 'E-mail', key: 'email', width: 28 }, { header: 'Telefoon', key: 'phone', width: 14 }, { header: 'Btw-nummer', key: 'vatNumber', width: 18 }];
      const seen = new Set();
      for (const invoice of result.items) {
        const customer = invoice.data.customer;
        const key = invoice.debtorNumber || customer.name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        debtorSheet.addRow({ ...customer, debtorNumber: invoice.debtorNumber || '', address: customer.address.replace(/\n/g, ', ') });
      }
      debtorSheet.getRow(1).font = { bold: true };

      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      link.download = `facturen-boekhouding-${formElement.from.value || 'begin'}-${formElement.to.value || InvoiceCore.today()}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      const missing = rows.filter((row) => !row.account).length;
      $('#x-result').innerHTML = `${result.items.length} facturen, ${rows.length} omzetregels geëxporteerd.${missing ? ` <b>${missing} regels zonder grootboekrekening</b>: vul die in bij Instellingen.` : ''}`;
      if (result.items.some((invoice) => !invoice.exportedAt) && confirm(`${result.items.length} facturen markeren als geëxporteerd? Dan komen ze niet nog eens mee bij "alleen nog niet geëxporteerd".`)) {
        const marked = await api('invoices/export/mark', { method: 'POST', body: { ids: result.items.map((invoice) => invoice.id) } });
        toast(`${marked.marked} facturen gemarkeerd als geëxporteerd`);
        load().catch(() => {});
      }
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  }

  // ---------- Start ----------
  /**
   * Start de pagina: rechten controleren, instellingen laden en het overzicht of
   * de factuur uit de URL tonen.
   * @returns {Promise<void>}
   */
  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    // De factuur en de instellingen al ophalen terwijl de login-check loopt.
    const pending = id ? api(`invoices/${encodeURIComponent(id)}`) : null;
    if (pending) pending.catch(() => {});
    const pendingConfig = api('invoices/settings');
    const pendingArticles = api('invoices/articles');
    const pendingVisma = api('visma');
    pendingVisma.catch(() => {});
    pendingConfig.catch(() => {});
    pendingArticles.catch(() => {});
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('facturen')) {
      const deniedBox = $('#v-denied');
      deniedBox.hidden = false;
      deniedBox.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Je rol heeft geen toegang tot de facturen. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    try {
      const [configResponse, articles] = await Promise.all([pendingConfig, pendingArticles]);
      state.settings = configResponse.settings;
      state.profile = configResponse.profile || {};
      state.config = configResponse;
      state.articles = articles.articles || {};
      state.visma = await pendingVisma.catch(() => null);
    } catch (error) {
      toast(error.message, true);
      state.settings = InvoiceCore.sanitizeSettings({});
    }
    document.querySelectorAll('.tab').forEach((button) => {
      /** Toont dit tabblad. */
      button.onclick = () => { showTab(button.dataset.tab); };
    });
    $('#f-status').onchange = renderList;
    $('#f-search').oninput = renderList;
    /**
     * Laadt het overzicht opnieuw voor de gekozen periode.
     * @returns {Promise<void>}
     */
    $('#f-from').onchange = () => load().catch((error) => toast(error.message, true));
    $('#f-to').onchange = $('#f-from').onchange;
    /**
     * Maakt een losse factuur en opent die.
     * @returns {Promise<void>}
     */
    $('#b-new').onclick = async () => {
      try {
        const created = await api('invoices', { method: 'POST', body: { data: { lines: [] } } });
        openInvoice(created.id, true);
      } catch (error) { toast(error.message, true); }
    };
    $('#x-form').onsubmit = exportExcel;
    $('#b-orders').onclick = fetchOrders;
    setupSettings();
    setupDebtors();
    setupVisma();
    setupEditor();
    window.addEventListener('popstate', () => {
      const invoiceId = new URLSearchParams(location.search).get('id');
      if (invoiceId) openInvoice(invoiceId); else { showList(); load().catch(() => {}); }
    });
    if (id) {
      await openInvoice(id, false, pending);
    } else {
      $('#v-list').hidden = false;
      try { await load(); } catch (error) { toast(error.message, true); }
      const hash = vismaReturn(params) ? 'visma' : location.hash.slice(1);
      if (TABS.includes(hash)) showTab(hash);
    }
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(() => {
        if (state.invoice && !$('#v-edit').hidden && !state.dirty) openInvoice(state.invoice.id);
        else if ($('#v-edit').hidden) load().catch(() => {});
      });
    }
  }

  init();
})();
