// Klanten: de klantenlijst (zoeken, filter, pagina's, Excel), een nieuwe klant aanmaken en de klantkaart met
// gegevens, zakelijke instellingen, toegang (uitnodiging) en de offertes, werkorders en facturen van de klant.
// Gegevens uit /api/customers; alleen voor medewerkers met het recht klanten. Indeling: shared/layout.css.
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
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
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Datum kort in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "22-10-2026" (leeg zonder datum).
   */
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');

  const PAGE_SIZE = 50;
  const QUOTE_STATUS = { concept: 'Concept', verzonden: 'Verzonden', akkoord: 'Akkoord', afgewezen: 'Afgewezen', verlopen: 'Verlopen', omgezet: 'Omgezet' };
  const WORK_ORDER_STATUS = { open: 'Open', gepland: 'Gepland', bezig: 'Bezig', gereed: 'Gereed', geannuleerd: 'Geannuleerd' };
  const INVOICE_STATUS = { concept: 'Concept', definitief: 'Definitief', betaald: 'Betaald' };

  const state = { items: [], total: 0, offset: 0, search: '', group: '', customer: null, detail: null };
  // Telt elke lijstopvraging; een antwoord dat na een nieuwere vraag terugkomt wordt genegeerd.
  let listVersion = 0;
  let searchTimer = null;

  /**
   * Toont een melding onderin beeld (3,5 s).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Doet een verzoek aan de API (relatief vanaf klanten/).
   * @param {string} path Pad onder api/.
   * @param {{ method?: string, body?: object }} [options] Methode en JSON-body.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server en eventueel het veld).
   */
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`../api/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(out.message || window.AquatechCommon.statusMessage(response.status)), { field: out.field || null });
    return out;
  }

  /**
   * Toont één van de drie weergaves.
   * @param {'list'|'new'|'detail'} view De weergave.
   * @returns {void}
   */
  function show(view) {
    $('#list-view').hidden = view !== 'list';
    $('#new-view').hidden = view !== 'new';
    $('#detail-view').hidden = view !== 'detail';
  }

  /**
   * Gaat naar een andere weergave zonder de pagina te herladen.
   * @param {string} query Zoekparameters, bijv. "id=…" of "nieuw" (leeg = lijst).
   * @returns {void}
   */
  function navigate(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Lijst ----------
  /**
   * De pillen bij een klant: groep, groothandel, open aanvraag en of er een inlog is.
   * @param {object} customer De klant.
   * @returns {string} HTML met de pillen.
   */
  function pillsOf(customer) {
    return [
      customer.customerGroup === 'zakelijk' ? '<span class="pill zakelijk">Zakelijk</span>' : '<span class="pill">Particulier</span>',
      customer.wholesale ? '<span class="pill groothandel">Groothandel</span>' : '',
      customer.businessRequest === 'aangevraagd' ? '<span class="pill aanvraag">Aanvraag zakelijk</span>' : '',
      customer.hasLogin ? '<span class="pill inlog">Inlog</span>' : '',
      customer.disabled ? '<span class="pill">Uitgeschakeld</span>' : '',
    ].filter(Boolean).join(' ');
  }

  /**
   * Haalt een pagina klanten op met het huidige zoekwoord en filter en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadList() {
    const version = ++listVersion;
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
    if (state.search) query.set('q', state.search);
    if (state.group) query.set('group', state.group);
    try {
      const out = await api(`customers?${query}`);
      if (version !== listVersion) return;
      state.items = out.items;
      state.total = out.total;
      renderList();
    } catch (error) {
      if (version !== listVersion) return;
      $('#k-table').innerHTML = `<tbody><tr><td class="empty">Kan de klanten niet laden (${esc(error.message)}).</td></tr></tbody>`;
    }
  }

  /** Tekent de tabel met klanten en de knoppen onder de tabel. */
  function renderList() {
    const rows = state.items.map((customer) => `<tr class="row-link${customer.disabled ? ' off' : ''}" data-id="${esc(customer.id)}">
      <td><a href="?id=${encodeURIComponent(customer.id)}"><b>${esc(customer.displayName)}</b></a></td>
      <td class="wrap">${esc(customer.companyName || '')}</td>
      <td class="wrap">${esc((customer.address || '').replace(/\n/g, ', '))}</td>
      <td>${esc(customer.email)}</td>
      <td>${esc(customer.phone)}</td>
      <td>${pillsOf(customer)}</td>
    </tr>`).join('');
    const empty = state.search || state.group ? 'Geen klanten gevonden met dit zoekwoord of filter.' : 'Nog geen klanten. Maak de eerste aan met Nieuwe klant.';
    $('#k-table').innerHTML = `<thead><tr><th>Naam</th><th>Bedrijf</th><th>Adres</th><th>E-mail</th><th>Telefoon</th><th>Groep</th></tr></thead>
      <tbody>${rows || `<tr><td class="empty" colspan="6">${empty}</td></tr>`}</tbody>`;
    const from = state.total ? state.offset + 1 : 0;
    const to = Math.min(state.total, state.offset + state.items.length);
    $('#k-count').textContent = `${from}–${to} van ${state.total} klanten`;
    $('#k-prev').disabled = state.offset <= 0;
    $('#k-next').disabled = state.offset + PAGE_SIZE >= state.total;
  }

  /**
   * Exporteert alle klanten met het huidige zoekwoord en filter naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = $('#k-export');
    button.disabled = true;
    try {
      const customers = [];
      for (let offset = 0; ; offset += 200) {
        const query = new URLSearchParams({ limit: '200', offset: String(offset) });
        if (state.search) query.set('q', state.search);
        if (state.group) query.set('group', state.group);
        const out = await api(`customers?${query}`);
        customers.push(...out.items);
        if (!out.items.length || customers.length >= out.total) break;
      }
      const ExcelJS = window.ExcelJS || (window.AquatechCommon && await window.AquatechCommon.excel());
      if (!ExcelJS) throw new Error('Excel-export niet beschikbaar.');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Klanten');
      sheet.columns = [
        { header: 'Naam', key: 'displayName', width: 28 }, { header: 'Bedrijf', key: 'companyName', width: 28 }, { header: 'KvK', key: 'kvkNumber', width: 12 },
        { header: 'Btw-nummer', key: 'vatNumber', width: 18 }, { header: 'Adres', key: 'address', width: 40 }, { header: 'E-mail', key: 'email', width: 30 },
        { header: 'Telefoon', key: 'phone', width: 16 }, { header: 'Groep', key: 'group', width: 14 }, { header: 'Groothandelskorting %', key: 'discount', width: 20 }, { header: 'Inlog', key: 'login', width: 8 },
      ];
      for (const customer of customers) {
        sheet.addRow({ displayName: customer.displayName, companyName: customer.companyName, kvkNumber: customer.kvkNumber, vatNumber: customer.vatNumber,
          address: (customer.address || '').replace(/\n/g, ', '), email: customer.email, phone: customer.phone,
          group: customer.wholesale ? 'Groothandel' : customer.customerGroup === 'zakelijk' ? 'Zakelijk' : 'Particulier', discount: customer.wholesale ? customer.wholesaleDiscount : '', login: customer.hasLogin ? 'ja' : 'nee' });
      }
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      link.download = 'klanten.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Nieuwe klant ----------
  /**
   * Toont of verbergt de bedrijfsvelden in het formulier, naar de gekozen soort klant.
   * @param {HTMLFormElement} form Het formulier.
   * @returns {void}
   */
  function syncBusinessFields(form) {
    const business = form.customerGroup.value === 'zakelijk';
    form.querySelectorAll('[data-business]').forEach((field) => { field.hidden = !business; });
  }

  /**
   * Toont het adres uit het (verborgen) adresveld als gewone tekst, met een korte aanwijzing zolang er nog geen is.
   * @param {HTMLFormElement} form Het formulier met het adresveld.
   * @returns {void}
   */
  function showAddressText(form) {
    const text = form.querySelector('[data-addr-text]');
    const address = form.address.value.trim().split(/\s*\n\s*/).join(', ');
    text.textContent = address || 'Vul hierboven postcode en huisnummer in';
    text.classList.toggle('empty', !address);
  }

  /**
   * Houdt de adrestekst bij als de postcodezoeker het adres invult of wist.
   * @param {HTMLFormElement} form Het formulier met het adresveld.
   * @returns {void}
   */
  function watchAddressText(form) {
    form.address.addEventListener('input', () => showAddressText(form));
    showAddressText(form);
  }

  /** Maakt het formulier voor een nieuwe klant leeg. */
  function openNew() {
    const form = $('#n-form');
    form.reset();
    $('#n-err').textContent = '';
    syncBusinessFields(form);
    form.querySelectorAll('.addr-lookup').forEach((group) => group.remove());
    delete form.address.dataset.addressEnhanced;
    if (window.AddressLookup) window.AddressLookup.enhance(form.address);
    if (!form.address.dataset.textWatched) { form.address.dataset.textWatched = '1'; watchAddressText(form); } else showAddressText(form);
    show('new');
    form.displayName.focus();
  }

  /**
   * Bewaart een nieuwe klant en opent zijn klantkaart.
   * @param {SubmitEvent} event Het verzenden.
   * @returns {Promise<void>}
   */
  async function saveNew(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    $('#n-err').textContent = '';
    const body = { displayName: form.displayName.value, email: form.email.value, phone: form.phone.value, address: form.address.value, customerGroup: form.customerGroup.value, invite: form.invite.checked };
    if (body.customerGroup === 'zakelijk') Object.assign(body, { companyName: form.companyName.value, kvkNumber: form.kvkNumber.value, vatNumber: form.vatNumber.value });
    button.disabled = true;
    try {
      const out = await api('customers', { method: 'POST', body });
      if (out.invite && !out.invite.sent) toast(`Klant opgeslagen. Uitnodiging niet verstuurd: ${out.invite.problem}`, true);
      else toast(out.invite ? 'Klant opgeslagen en uitnodiging verstuurd' : 'Klant opgeslagen');
      navigate(`id=${encodeURIComponent(out.customer.id)}`);
    } catch (error) {
      $('#n-err').textContent = error.message;
      if (error.field && form[error.field]) form[error.field].focus();
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Klantkaart ----------
  /**
   * Een kleine tabel met documenten van de klant, elk een directe link.
   * @param {string} title Titel van de kaart.
   * @param {object[]|null} rows De regels; null = geen recht om dit te zien.
   * @param {Function} rowHtml Maakt de cellen van een regel.
   * @param {string} headHtml De kopcellen.
   * @param {string} emptyText Tekst als er niets is.
   * @returns {string} HTML van de kaart (leeg als de aanvrager dit niet mag zien).
   */
  function documentsCard(title, rows, rowHtml, headHtml, emptyText) {
    if (rows === null) return '';
    const body = rows.length ? `<table class="mini"><thead><tr>${headHtml}</tr></thead><tbody>${rows.map((row) => `<tr>${rowHtml(row)}</tr>`).join('')}</tbody></table>` : `<p class="empty">${emptyText}</p>`;
    return `<section class="card"><h3>${esc(title)}${rows.length ? ` (${rows.length})` : ''}</h3>${body}</section>`;
  }

  /**
   * De kaart met de contactgegevens van de klant.
   * @param {object} customer De klant.
   * @returns {string} HTML van de kaart.
   */
  function contactCard(customer) {
    return `<form class="card" id="c-contact" autocomplete="off"><h3>Gegevens</h3>
      <div class="form-grid">
        <label class="field full">Naam<input name="displayName" required maxlength="80" value="${esc(customer.displayName)}"></label>
        <label class="field">E-mailadres<input name="email" type="email" maxlength="200" value="${esc(customer.email)}"></label>
        <label class="field">Telefoon<input name="phone" type="tel" maxlength="25" value="${esc(customer.phone)}"></label>
        <label class="field full addr-result">Adres<span class="addr-text" data-addr-text></span><textarea name="address" data-address-lookup hidden maxlength="400">${esc(customer.address)}</textarea></label>
      </div>
      <div class="err" id="c-contact-err" role="alert"></div>
      <div class="form-actions"><button class="btn primary" type="submit">Gegevens opslaan</button></div>
    </form>`;
  }

  /**
   * De kaart met klantgroep, bedrijfsgegevens en groothandel. Wie geen prijzen mag wijzigen ziet de groep en de groothandel alleen.
   * @param {object} customer De klant.
   * @param {boolean} mayPrice Of de aanvrager de klantgroep en groothandel mag wijzigen.
   * @returns {string} HTML van de kaart.
   */
  function businessCard(customer, mayPrice) {
    const business = customer.customerGroup === 'zakelijk';
    const request = customer.businessRequest === 'aangevraagd'
      ? `<div class="request-banner"><span class="pill aanvraag">Aanvraag zakelijk</span><span>De klant vroeg een zakelijk account aan.</span><span class="spacer"></span>${mayPrice ? '<button type="button" class="btn small" data-approve>Goedkeuren</button> <button type="button" class="btn small" data-reject>Afwijzen</button>' : ''}</div>` : '';
    const group = mayPrice
      ? `<label class="field">Klantgroep<select name="customerGroup"><option value="">Particulier</option><option value="zakelijk"${business ? ' selected' : ''}>Zakelijk</option></select><span class="hint">Zakelijk: prijzen excl. btw in de webshop.</span></label>`
      : `<div class="field">Klantgroep<b>${business ? 'Zakelijk' : 'Particulier'}</b><span class="hint">Alleen een beheerder wijzigt de klantgroep.</span></div>`;
    const wholesale = mayPrice
      ? `<label class="field chk" data-business><input type="checkbox" name="wholesale"${customer.wholesale ? ' checked' : ''}> Groothandelsklant (groothandelsvenster in de webshop)</label>
         <label class="field" data-wholesale><span>Vaste korting (%)</span><input name="wholesaleDiscount" type="number" min="0" max="50" step="0.5" value="${esc(String(customer.wholesaleDiscount || 0))}"><span class="hint">Naast de staffelkorting geldt de hoogste van de twee.</span></label>`
      : customer.wholesale ? `<div class="field" data-business>Groothandel<b>Ja, vaste korting ${esc(String(customer.wholesaleDiscount || 0))}%</b></div>` : '';
    return `<form class="card" id="c-business" autocomplete="off"><h3>Zakelijk en prijzen</h3>${request}
      <div class="form-grid">
        ${group}
        <label class="field full" data-business>Bedrijfsnaam<input name="companyName" maxlength="80" value="${esc(customer.companyName)}"></label>
        <label class="field" data-business>KvK-nummer<input name="kvkNumber" inputmode="numeric" maxlength="12" value="${esc(customer.kvkNumber)}"></label>
        <label class="field" data-business>Btw-nummer<input name="vatNumber" maxlength="20" value="${esc(customer.vatNumber)}"><span class="hint">Optioneel.</span></label>
        ${wholesale}
      </div>
      <div class="err" id="c-business-err" role="alert"></div>
      <div class="form-actions"><button class="btn primary" type="submit">Opslaan</button></div>
    </form>`;
  }

  /**
   * De kaart over toegang: of de klant kan inloggen, en een uitnodiging sturen.
   * @param {object} customer De klant.
   * @param {string} inviteProblem Waarom uitnodigen nu niet kan (leeg = kan).
   * @returns {string} HTML van de kaart.
   */
  function accessCard(customer, inviteProblem) {
    return `<section class="card"><h3>Toegang</h3>
      <dl class="fact-list">
        <dt>Inlog</dt><dd>${customer.hasLogin ? `Ja${customer.emailVerified ? ' (e-mailadres bevestigd)' : ''}` : 'Nee, nog geen wachtwoord gekozen'}</dd>
        <dt>Gebruikersnaam</dt><dd>${esc(customer.username)}</dd>
        ${customer.disabled ? '<dt>Status</dt><dd>Uitgeschakeld</dd>' : ''}
      </dl>
      <p class="muted small">${customer.hasLogin ? 'De klant kan al inloggen en wijzigt het wachtwoord zelf via Wachtwoord vergeten.' : 'Stuur een uitnodiging per e-mail; de klant kiest zelf een wachtwoord (de link werkt zeven dagen).'}
        Wachtwoord, uitschakelen en verwijderen doe je in <a href="../beheer/#users">Beheer &gt; Gebruikers</a>.</p>
      <div class="err" id="c-access-err" role="alert"></div>
      <div class="form-actions"><button type="button" class="btn" data-invite${inviteProblem || customer.disabled ? ' disabled' : ''}>Uitnodiging sturen</button>
        ${inviteProblem ? `<span class="muted small">${esc(inviteProblem)}</span>` : ''}</div>
    </section>`;
  }

  /**
   * Haalt de klantkaart op en tekent hem.
   * @param {string} id Id van de klant.
   * @returns {Promise<void>}
   */
  async function loadDetail(id) {
    show('detail');
    $('#d-body').innerHTML = '<p class="muted">Laden…</p>';
    try {
      state.detail = await api(`customers/${encodeURIComponent(id)}`);
    } catch (error) {
      $('#d-body').innerHTML = `<div class="notice">${esc(error.message)} <a href="./">Terug naar de klanten</a></div>`;
      return;
    }
    renderDetail();
  }

  /** Tekent de klantkaart uit state.detail. */
  function renderDetail() {
    const { customer, quotes, workOrders, invoices, mayPrice, mayDossier, dossierKey, inviteProblem } = state.detail;
    document.title = `${customer.displayName} – Klanten – AquaTech Service`;
    $('#d-body').innerHTML = `
      <div class="klant-title"><h1>${esc(customer.displayName)}</h1>${pillsOf(customer)}<span class="spacer"></span>
        ${mayDossier ? `<a class="btn" href="../klantdossier/?klant=${encodeURIComponent(dossierKey)}">Klantdossier</a>` : ''}</div>
      <div class="card-grid">${contactCard(customer)}${businessCard(customer, mayPrice)}${accessCard(customer, inviteProblem)}</div>
      <div class="docs-grid">
        ${documentsCard('Offertes', quotes, (quote) => `<td><a href="../offertes/?id=${encodeURIComponent(quote.id)}">${esc(quote.number)}</a></td><td>${esc(quote.title)}</td><td>${esc(QUOTE_STATUS[quote.status] || quote.status)}</td><td class="num">${eur(quote.total)}</td>`,
          '<th>Nummer</th><th>Titel</th><th>Status</th><th class="num">Totaal</th>', 'Nog geen offertes voor deze klant.')}
        ${documentsCard('Werkorders', workOrders, (workOrder) => `<td><a href="../werkorders/?id=${encodeURIComponent(workOrder.id)}">${esc(workOrder.number)}</a></td><td>${esc(workOrder.title)}</td><td>${esc(WORK_ORDER_STATUS[workOrder.status] || workOrder.status)}</td><td class="num">${esc(shortDate(workOrder.plannedDate))}</td>`,
          '<th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Gepland</th>', 'Nog geen werkorders voor deze klant.')}
        ${documentsCard('Facturen', invoices, (invoice) => `<td><a href="../facturen/?id=${encodeURIComponent(invoice.id)}">${esc(invoice.number || 'Concept')}</a></td><td>${esc(INVOICE_STATUS[invoice.status] || invoice.status)}${invoice.kind === 'credit' ? ' (credit)' : ''}</td><td>${esc(shortDate(invoice.invoiceDate))}</td><td class="num">${eur(invoice.total)}</td>`,
          '<th>Nummer</th><th>Status</th><th>Datum</th><th class="num">Totaal</th>', 'Nog geen facturen voor deze klant.')}
      </div>`;
    wireDetail();
  }

  /**
   * Zet de wijziging van een klant door en tekent de kaart opnieuw.
   * @param {object} body De te wijzigen velden.
   * @param {string} errorSelector Waar een foutmelding komt.
   * @param {string} message Melding na het opslaan.
   * @returns {Promise<void>}
   */
  async function patchCustomer(body, errorSelector, message) {
    const errorElement = $(errorSelector);
    if (errorElement) errorElement.textContent = '';
    try {
      const out = await api(`customers/${encodeURIComponent(state.detail.customer.id)}`, { method: 'PATCH', body });
      state.detail.customer = { ...state.detail.customer, ...out.customer };
      toast(message);
      renderDetail();
    } catch (error) {
      if (errorElement) errorElement.textContent = error.message; else toast(error.message, true);
    }
  }

  /** Koppelt de formulieren en knoppen van de klantkaart. */
  function wireDetail() {
    const contact = $('#c-contact');
    if (window.AddressLookup) window.AddressLookup.enhance(contact.address);
    watchAddressText(contact);
    /**
     * Slaat naam, e-mail, telefoon en adres op.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {void}
     */
    contact.onsubmit = (event) => {
      event.preventDefault();
      patchCustomer({ displayName: contact.displayName.value, email: contact.email.value, phone: contact.phone.value, address: contact.address.value }, '#c-contact-err', 'Gegevens opgeslagen');
    };
    const business = $('#c-business');
    /** Toont de bedrijfsvelden alleen voor een zakelijke klant. */
    const syncBusiness = () => {
      const isBusiness = business.customerGroup ? business.customerGroup.value === 'zakelijk' : state.detail.customer.customerGroup === 'zakelijk';
      business.querySelectorAll('[data-business]').forEach((field) => { field.hidden = !isBusiness; });
      business.querySelectorAll('[data-wholesale]').forEach((field) => { field.hidden = !isBusiness || !(business.wholesale && business.wholesale.checked); });
    };
    syncBusiness();
    if (business.customerGroup) business.customerGroup.onchange = syncBusiness;
    if (business.wholesale) business.wholesale.onchange = syncBusiness;
    /**
     * Slaat klantgroep, bedrijfsgegevens en groothandel op.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {void}
     */
    business.onsubmit = (event) => {
      event.preventDefault();
      const mayPrice = Boolean(business.customerGroup);
      const isBusiness = mayPrice ? business.customerGroup.value === 'zakelijk' : state.detail.customer.customerGroup === 'zakelijk';
      const body = {};
      if (mayPrice) body.customerGroup = business.customerGroup.value;
      if (isBusiness) Object.assign(body, { companyName: business.companyName.value, kvkNumber: business.kvkNumber.value, vatNumber: business.vatNumber.value });
      if (mayPrice && isBusiness) Object.assign(body, { wholesale: business.wholesale.checked, ...(business.wholesale.checked ? { wholesaleDiscount: Number(business.wholesaleDiscount.value) || 0 } : {}) });
      if (!Object.keys(body).length) return;
      patchCustomer(body, '#c-business-err', 'Opgeslagen');
    };
    const approve = $('[data-approve]');
    const reject = $('[data-reject]');
    if (approve) {
      /** Keurt de aanvraag voor een zakelijk account goed. */
      approve.onclick = () => { patchCustomer({ customerGroup: 'zakelijk' }, '#c-business-err', 'Zakelijk account goedgekeurd: prijzen excl. btw'); };
    }
    if (reject) {
      /** Wijst de aanvraag af; de klant blijft particulier. */
      reject.onclick = () => { patchCustomer({ customerGroup: '' }, '#c-business-err', 'Aanvraag afgewezen: de klant blijft particulier'); };
    }
    const invite = $('[data-invite]');
    if (invite) {
      /**
       * Stuurt de uitnodiging.
       * @returns {Promise<void>}
       */
      invite.onclick = async () => {
        $('#c-access-err').textContent = '';
        invite.disabled = true;
        try {
          await api(`customers/${encodeURIComponent(state.detail.customer.id)}/invite`, { method: 'POST', body: {} });
          toast('Uitnodiging verstuurd');
        } catch (error) {
          $('#c-access-err').textContent = error.message;
        }
        invite.disabled = false;
      };
    }
  }

  // ---------- Routing en opstarten ----------
  /**
   * Kiest de weergave bij het adres: ?id=… (klantkaart), ?nieuw of de lijst.
   * @returns {void}
   */
  function route() {
    const params = new URLSearchParams(location.search);
    document.title = 'Klanten – AquaTech Service';
    if (params.get('id')) loadDetail(params.get('id'));
    else if (params.has('nieuw')) openNew();
    else { show('list'); loadList(); }
  }

  /** Koppelt de bediening van de lijst en start de pagina. */
  function init() {
    /** Zoekt na een korte pauze in het typen. */
    $('#k-search').oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = $('#k-search').value.trim(); state.offset = 0; loadList(); }, 300);
    };
    /**
     * Past het groepsfilter toe.
     * @returns {void}
     */
    $('#k-group').onchange = () => { state.group = $('#k-group').value; state.offset = 0; loadList(); };
    /** Opent het formulier voor een nieuwe klant. */
    $('#k-new').onclick = () => { navigate('nieuw'); };
    $('#k-export').onclick = exportExcel;
    /** Vorige pagina. */
    $('#k-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadList(); };
    /** Volgende pagina. */
    $('#k-next').onclick = () => { state.offset += PAGE_SIZE; loadList(); };
    /**
     * Opent een klant met een klik op de regel (Ctrl/Cmd/Shift-klik op de naam opent een nieuw tabblad).
     * @param {MouseEvent} event De klik.
     * @returns {void}
     */
    $('#k-table').onclick = (event) => {
      const link = event.target.closest('a[href^="?id="]');
      if (link && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
      const row = event.target.closest('tr[data-id]');
      if (!row) return;
      event.preventDefault();
      navigate(`id=${encodeURIComponent(row.dataset.id)}`);
    };
    $('#n-form').onsubmit = saveNew;
    /**
     * Toont de bedrijfsvelden bij een zakelijke klant.
     * @returns {void}
     */
    $('#n-form').customerGroup.onchange = () => syncBusinessFields($('#n-form'));
    /** Terug naar de lijst. */
    const backToList = () => { navigate(''); };
    $('#n-back').onclick = backToList;
    $('#n-cancel').onclick = backToList;
    $('#d-back').onclick = backToList;
    window.addEventListener('popstate', route);
    if (window.AquatechCommon) window.AquatechCommon.onReturn(route);
    // Een zakelijke klant (prijzen excl. btw) maakt alleen een beheerder aan: voor anderen verdwijnt die keuze.
    if (window.AquatechCommon) {
      window.AquatechCommon.getJson('api/me').then((me) => {
        if (!((me && me.rights) || []).includes('beheer')) $('#n-form').customerGroup.querySelector('option[value="zakelijk"]').remove();
      }).catch(() => {});
    }
    route();
  }

  init();
})();
