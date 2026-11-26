// Beheer: historie van aanvragen, alle plannen en gebruikers. Alle gegevens
// komen uit /api/admin/*; de server weigert die voor niet-beheerders.
(function () {
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
   * Formatteert een getal in Nederlandse notatie.
   * @param {number} value het getal
   * @param {number} decimals aantal decimalen (standaard 1)
   * @returns {string} het getal als tekst, of '–'
   */
  const num = (value, decimals = 1) => (value == null || !isFinite(value) ? '–' : Number(value).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  /**
   * Formatteert een tijdstip als datum met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} leesbare datum en tijd, of '–'
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const ACTIONS = { aangemaakt: 'Aangemaakt', bijgewerkt: 'Bijgewerkt', verwijderd: 'Verwijderd', analyse: 'Plan herkend' };
  const KINDS = { account: 'Account', gast: 'Gast', systeem: 'Systeem' };
  /**
   * Geeft de naam van een vlaksoort uit de catalogus.
   * @param {string} type sleutel van de vlaksoort
   * @returns {string} leesbare naam, of de sleutel zelf
   */
  const areaLabel = (type) => (window.Catalog && window.Catalog.areaTypes[type] ? window.Catalog.areaTypes[type].label : type);
  const PAGE = 100;
  const Roles = window.AquatechRoles;
  // Rollen van de organisatie (Beheer > Rollen); tot ze geladen zijn de standaard.
  const state = { hiddenSections: new Set(), offset: 0, total: 0, users: [], auditOffset: 0, roles: Object.entries(Roles.ROLES).map(([key, role]) => ({ key, ...role })) };
  /**
   * Zoekt een rol van de organisatie.
   * @param {string} key sleutel van de rol
   * @returns {object|undefined} de rol
   */
  const roleOf = (key) => state.roles.find((role) => role.key === key);
  /**
   * Geeft de naam van een rol.
   * @param {string} key sleutel van de rol
   * @returns {string} de naam
   */
  const roleLabel = (key) => (roleOf(key) ? roleOf(key).label : Roles.label(key));
  /**
   * Maakt de keuzelijst met rollen (een onbekende huidige rol staat er ook in).
   * @param {string} current de gekozen rol
   * @returns {string} HTML met option-elementen
   */
  const roleOptions = (current) => state.roles.concat(roleOf(current) || !current ? [] : [{ key: current, label: current }])
    .map((role) => `<option value="${esc(role.key)}"${role.key === current ? ' selected' : ''}>${esc(role.label)}</option>`).join('');
  const AUDIT = {
    ingelogd: 'Ingelogd', uitgelogd: 'Uitgelogd', inloggen_mislukt: 'Inloggen mislukt', inloggen_geblokkeerd: 'Inloggen geblokkeerd',
    eerste_beheerder: 'Eerste beheerder', installatie_mislukt: 'Installatiecode onjuist', gebruiker_aangemaakt: 'Gebruiker aangemaakt',
    gebruiker_gewijzigd: 'Gebruiker gewijzigd', gebruiker_verwijderd: 'Gebruiker verwijderd', plan_gewist: 'Plan definitief gewist', backup_gemaakt: 'Back-up gemaakt',
    backup_gedownload: 'Back-up gedownload', sessies_ingetrokken: 'Uitgelogd op alle toestellen', instellingen_gewijzigd: 'Instellingen gewijzigd',
    offerte_akkoord: 'Offerte geaccepteerd door klant', offerte_afgewezen: 'Offerte afgewezen door klant', offerte_gewist: 'Offerte definitief gewist', offerte_verwijderd: 'Offerte verwijderd', backup_verwijderd: 'Back-up verwijderd',
    rol_aangemaakt: 'Rol aangemaakt', rol_gewijzigd: 'Rol gewijzigd', rol_verwijderd: 'Rol verwijderd', rol_teruggezet: 'Rol teruggezet naar standaard',
    tenant_verwijderd: 'Tenant verwijderd', testomgeving_verwijderd: 'Testomgeving verwijderd', werkorder_verwijderd: 'Werkorder verwijderd', werkorder_gewist: 'Werkorder definitief gewist',
    impersonatie_gestart: 'Hoofdbeheerder werkt als gebruiker', impersonatie_beeindigd: 'Impersonatie beëindigd',
    klantweergave_gestart: 'Beheerder bekijkt als klant', klantweergave_beeindigd: 'Bekijken als klant beëindigd',
    webshop_gesynchroniseerd: 'Webshopproducten opgehaald', webshop_bestelling_geplaatst: 'Webshopbestelling geplaatst', webshop_bestelling_status: 'Webshopbestelling: status gewijzigd', webshop_inhoud_concept: 'Webshop-inhoud: concept opgeslagen', webshop_inhoud_gepubliceerd: 'Webshop-inhoud gepubliceerd', webshop_inhoud_concept_verworpen: 'Webshop-inhoud: concept weggegooid', webshop_inhoud_teruggezet: 'Webshop-inhoud: vorige versie teruggezet', webshop_pagina_verwijderd: 'Webshoppagina verwijderd', webshop_afbeelding_toegevoegd: 'Webshopafbeelding geüpload', webshop_afbeelding_verwijderd: 'Webshopafbeelding verwijderd', sproeierbibliotheek_ingelezen: 'Sproeierbibliotheek ingelezen', sproeierbibliotheek_standaard: 'Sproeierbibliotheek naar standaard', support_toegang_verleend: 'Supporttoegang gegeven', support_toegang_ingetrokken: 'Supporttoegang ingetrokken',
    opdracht_aangeboden: 'Opdracht uitbesteed (aangeboden)', opdracht_ingetrokken: 'Uitbesteding ingetrokken', opdracht_aangenomen: 'Opdracht aangenomen', opdracht_afgewezen: 'Opdracht afgewezen',
  };

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
   * Roept de beheer-API aan en geeft de JSON terug.
   * @param {string} path pad na '../api/admin/'
   * @param {RequestInit} options fetch-opties; `body` als object
   * @returns {Promise<object>} het antwoord; gooit een fout met status bij een foutstatus
   */
  async function api(path, options = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || AquatechCommon.statusMessage(res.status)), { status: res.status });
    return body;
  }

  // ---------- Aanvragen ----------
  /**
   * Maakt het adres voor de historie met de filters van de pagina.
   * @param {number} offset vanaf welke regel
   * @param {number} limit hoeveel regels
   * @returns {string} pad met querystring
   */
  function historyQuery(offset, limit) {
    const params = new URLSearchParams({ limit, offset });
    const term = $('#h-search').value.trim();
    if (term) params.set('q', term);
    if ($('#h-user').value) params.set('user', $('#h-user').value);
    if ($('#h-action').value) params.set('action', $('#h-action').value);
    return `history?${params}`;
  }

  /**
   * Laadt een pagina van de historie van aanvragen en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadHistory() {
    const table = $('#h-table');
    try {
      const { total, items } = await api(historyQuery(state.offset, PAGE));
      state.total = total;
      if (!items.length) {
        table.innerHTML = '<tr><td class="empty">Nog geen aanvragen gevonden.</td></tr>';
      } else {
        table.innerHTML = `<thead><tr><th>Laatst bijgewerkt</th><th>Gebruiker</th><th>Actie</th><th>Plan</th><th>Klant</th><th>Adres</th>
          <th class="num">Vlakken</th><th class="num">m²</th><th class="num">Sproeiers</th><th class="num">Zones</th></tr></thead><tbody>${items.map((entry) => `
          <tr data-id="${esc(entry.id)}">
            <td>${esc(when(entry.updatedAt))}</td>
            <td>${entry.user ? esc(entry.user.displayName) : '–'}${entry.user && entry.user.role !== 'installateur' ? ` <span class="pill ${esc(entry.user.role)}">${esc(roleLabel(entry.user.role).toLowerCase())}</span>` : ''}</td>
            <td><span class="pill ${esc(entry.action)}">${esc(ACTIONS[entry.action] || entry.action)}</span></td>
            <td class="wrap">${esc(entry.title)}${entry.planDeleted && entry.action !== 'analyse' ? ' <span class="pill verwijderd">plan verwijderd</span>' : ''}</td>
            <td class="wrap">${esc(entry.customer)}</td>
            <td class="wrap">${esc(entry.address)}</td>
            <td class="num">${entry.summary.areas ?? '–'}</td>
            <td class="num">${entry.summary.totalM2 != null ? num(entry.summary.totalM2) : '–'}</td>
            <td class="num">${entry.summary.sprinklers ?? '–'}</td>
            <td class="num">${entry.summary.zones ?? '–'}</td>
          </tr>`).join('')}</tbody>`;
        table.querySelectorAll('tr[data-id]').forEach((row) => {
          /**
           * Toont de details van deze aanvraag.
           * @returns {Promise<void>}
           */
          row.onclick = () => showHistory(row.dataset.id);
        });
      }
      const from = total ? state.offset + 1 : 0;
      $('#h-info').textContent = `${from}–${Math.min(total, state.offset + PAGE)} van ${total}`;
      $('#h-prev').disabled = state.offset === 0;
      $('#h-next').disabled = state.offset + PAGE >= total;
    } catch (error) {
      table.innerHTML = `<tr><td class="empty">Kan de historie niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Opent een kopie van een plan in de planner (via sessionStorage).
   * @param {object} data de plangegevens
   */
  function openCopy(data) {
    try {
      sessionStorage.setItem('aquatech-open-copy', JSON.stringify(data));
    } catch (error) {
      toast('Kan de kopie niet doorgeven aan de planner (opslag vol of geblokkeerd).', true);
      return;
    }
    location.href = '../beregening/?copy=1';
  }

  /**
   * Toont de details van een aanvraag uit de historie.
   * @param {string} id id van de aanvraag
   * @returns {Promise<void>}
   */
  async function showHistory(id) {
    let entry;
    try { entry = await api(`history/${encodeURIComponent(id)}`); } catch (error) { toast(error.message, true); return; }
    const summary = entry.summary || {};
    const m2 = Object.entries(summary.m2ByType || {}).map(([type, value]) => `${esc(areaLabel(type))}: ${num(value)} m²`).join('<br>');
    $('#detail-body').innerHTML = `
      <h2>${esc(entry.title || 'Aanvraag')}</h2>
      <span class="pill ${esc(entry.action)}">${esc(ACTIONS[entry.action] || entry.action)}</span>
      <dl class="kv">
        <dt>Gebruiker</dt><dd>${entry.user ? `${esc(entry.user.displayName)} (${esc(entry.user.username)}, ${esc(KINDS[entry.user.kind] || entry.user.kind)}, ${esc(entry.user.role)})` : '–'}</dd>
        <dt>Eerste keer</dt><dd>${esc(when(entry.createdAt))}</dd>
        <dt>Laatst bijgewerkt</dt><dd>${esc(when(entry.updatedAt))}</dd>
        ${entry.action === 'analyse' ? `<dt>Herkend</dt><dd>${summary.areas ?? 0} vlakken, ${summary.elements ?? 0} elementen, schaal: ${esc(summary.scale || '–')} (${esc(summary.confidence || '–')})</dd>` : `
        <dt>Klant</dt><dd>${esc(entry.customer || '–')}</dd>
        <dt>Adres</dt><dd>${esc(entry.address || '–')}</dd>
        <dt>Vlakken</dt><dd>${summary.areas ?? 0} (${num(summary.totalM2)} m²)</dd>
        ${m2 ? `<dt>Per soort</dt><dd>${m2}</dd>` : ''}
        <dt>Sproeiers</dt><dd>${summary.sprinklers ?? 0}</dd>
        <dt>Zones</dt><dd>${summary.zones ?? 0}</dd>
        <dt>Elementen</dt><dd>${summary.elements ?? 0}</dd>
        <dt>Plan</dt><dd>${entry.planId ? (entry.planDeleted ? 'verwijderd door de gebruiker' : 'bestaat nog') : '–'}</dd>`}
        <dt>IP-adres</dt><dd>${esc(entry.ip || '–')}</dd>
      </dl>
      <div class="actions">
        ${entry.snapshot ? '<button class="btn primary" id="d-copy">Kopie openen in de planner</button>' : ''}
      </div>
      ${entry.snapshot ? '<p class="muted small">De kopie wordt een nieuw plan op jouw naam (zonder de achtergrondafbeelding); het plan van de gebruiker blijft ongewijzigd.</p>' : ''}`;
    const copy = $('#d-copy');
    if (copy) {
      /** Opent de kopie in de planner. */
      copy.onclick = () => { openCopy(entry.snapshot); };
    }
    $('#detail').hidden = false;
  }

  /**
   * Haalt de hele historie (met de filters) in stukken van 1000 op.
   * @returns {Promise<object[]>} alle aanvragen
   */
  async function fetchAllHistory() {
    const allItems = [];
    for (let offset = 0; ; offset += 1000) {
      const { total, items } = await api(historyQuery(offset, 1000));
      allItems.push(...items);
      if (allItems.length >= total || !items.length) break;
    }
    return allItems;
  }

  /**
   * Exporteert de historie (met de filters) naar Excel.
   * @returns {Promise<void>}
   */
  async function exportHistory() {
    const exportButton = $('#h-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    exportButton.disabled = true;
    exportButton.textContent = 'Bezig…';
    try {
      const items = await fetchAllHistory();
      const types = [...new Set(items.flatMap((entry) => Object.keys(entry.summary.m2ByType || {})))];
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet('Aanvragen', { views: [{ state: 'frozen', ySplit: 1 }] });
      worksheet.columns = [
        { header: 'Eerste keer', key: 'createdAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        { header: 'Laatst bijgewerkt', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        { header: 'Actie', key: 'action', width: 14 },
        { header: 'Gebruiker', key: 'user', width: 24 },
        { header: 'Gebruikersnaam', key: 'username', width: 18 },
        { header: 'Soort', key: 'kind', width: 10 },
        { header: 'Rol', key: 'role', width: 11 },
        { header: 'Plan', key: 'title', width: 30 },
        { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Adres', key: 'address', width: 30 },
        { header: 'Plan verwijderd', key: 'planDeleted', width: 10 },
        { header: 'Vlakken', key: 'areas', width: 9 },
        { header: 'Totaal m²', key: 'totalM2', width: 11, style: { numFmt: '0.0' } },
        ...types.map((type) => ({ header: `${areaLabel(type)} m²`, key: `m2_${type}`, width: 14, style: { numFmt: '0.0' } })),
        { header: 'Sproeiers', key: 'sprinklers', width: 10 },
        { header: 'Zones', key: 'zones', width: 8 },
        { header: 'Elementen', key: 'elements', width: 10 },
        { header: 'IP-adres', key: 'ip', width: 16 },
      ];
      for (const entry of items) {
        const summary = entry.summary || {};
        const row = {
          createdAt: new Date(entry.createdAt), updatedAt: new Date(entry.updatedAt), action: ACTIONS[entry.action] || entry.action,
          user: entry.user ? entry.user.displayName : '', username: entry.user ? entry.user.username : '', kind: entry.user ? KINDS[entry.user.kind] || entry.user.kind : '',
          role: entry.user ? entry.user.role : '', title: entry.title, customer: entry.customer, address: entry.address,
          planDeleted: entry.action === 'analyse' ? '' : (entry.planDeleted ? 'ja' : 'nee'),
          areas: summary.areas, totalM2: summary.totalM2, sprinklers: summary.sprinklers, zones: summary.zones, elements: summary.elements, ip: entry.ip,
        };
        for (const type of types) row[`m2_${type}`] = (summary.m2ByType || {})[type];
        worksheet.addRow(row);
      }
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columns.length } };
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `aanvragen_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${items.length} aanvragen geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = 'Exporteer naar Excel';
    }
  }

  // ---------- Plannen ----------
  /**
   * Laadt alle plannen en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadPlans() {
    const table = $('#p-table');
    try {
      const { items } = await api('plans');
      if (!items.length) { table.innerHTML = '<tr><td class="empty">Nog geen plannen.</td></tr>'; return; }
      table.innerHTML = `<thead><tr><th>Plan</th><th>Klant</th><th>Adres</th><th>Eigenaar</th><th>Aangemaakt</th><th>Gewijzigd</th><th></th></tr></thead><tbody>${items.map((plan) => `
        <tr>
          <td class="wrap"><b>${esc(plan.title)}</b></td>
          <td class="wrap">${esc(plan.customer)}</td>
          <td class="wrap">${esc(plan.address)}</td>
          <td>${esc(plan.owner.displayName)} <span class="muted small">${esc(KINDS[plan.owner.kind] || '')}</span></td>
          <td>${esc(when(plan.createdAt))}</td>
          <td>${esc(when(plan.updatedAt))}</td>
          <td><button class="btn small" data-copy="${esc(plan.id)}">Kopie openen</button></td>
        </tr>`).join('')}</tbody>`;
      table.querySelectorAll('[data-copy]').forEach((button) => {
        /**
         * Opent een kopie van het plan in de planner.
         * @returns {Promise<void>}
         */
        button.onclick = async () => {
          try { openCopy((await api(`plans/${encodeURIComponent(button.dataset.copy)}`)).data); } catch (error) { toast(error.message, true); }
        };
      });
    } catch (error) {
      table.innerHTML = `<tr><td class="empty">Kan de plannen niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  // ---------- Gebruikers ----------
  /**
   * Laadt de gebruikers, vult het gebruikersfilter van de historie en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadUsers() {
    const { items, roles } = await api('users');
    state.users = items;
    if (roles) setRoles(roles);
    const select = $('#h-user');
    const current = select.value;
    select.innerHTML = '<option value="">Alle gebruikers</option>' + items
      .filter((user) => user.historyCount > 0 || user.kind !== 'gast')
      .map((user) => `<option value="${esc(user.id)}">${esc(user.displayName)}${user.kind === 'gast' ? ' (gast)' : ''}</option>`).join('');
    select.value = current;
    renderUsers();
    loadCustomerView();
  }

  // ---------- Bekijken als klant (alleen in een testomgeving) ----------
  /**
   * Vult het blok Bekijken als klant: in een testomgeving de klanten om uit te
   * kiezen, in live alleen de uitleg.
   * @returns {Promise<void>}
   */
  async function loadCustomerView() {
    const formElement = $('#u-view');
    let view;
    try { view = await api('view-as-customer'); } catch (error) { formElement.hidden = true; return; }
    formElement.hidden = false;
    // .row is flex, dus het attribuut hidden alleen werkt niet.
    $('#u-view-row').style.display = view.available && view.items.length ? '' : 'none';
    $('#u-view-info').textContent = !view.available
      ? 'Wil je zien hoe de app er voor een klant uitziet? Dat kan alleen in een testomgeving: wissel via je naam rechtsboven naar een testomgeving.'
      : view.items.length
        ? `Bekijk de app in testomgeving ${view.environment} precies zoals een klant hem ziet. Je hebt dan alleen de rechten van die klant; met Terug naar beheer bovenin ben je weer jezelf. Start en einde komen in het auditlog.`
        : `Er zijn nog geen klantaccounts. Maak een gebruiker met de rol Klant aan of vul de testomgeving met testgegevens.`;
    formElement.userId.innerHTML = view.items.map((customer) => `<option value="${esc(customer.id)}">${esc(customer.displayName)} (${esc(customer.username)})</option>`).join('');
  }

  /**
   * Start de klantweergave en opent het dashboard zoals de klant het ziet.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function startCustomerView(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const button = formElement.querySelector('button[type="submit"]');
    $('#u-view-err').textContent = '';
    button.disabled = true;
    try {
      await api('view-as-customer', { method: 'POST', body: { userId: formElement.userId.value } });
      location.href = '../';
    } catch (error) {
      $('#u-view-err').textContent = error.message;
      button.disabled = false;
    }
  }

  /**
   * Keuzelijst bij Gebruiker toevoegen en de uitleg per rol.
   * @param {object[]} roles de rollen van de organisatie
   */
  function setRoles(roles) {
    state.roles = roles;
    const select = $('#u-form').role;
    const current = select.value || 'installateur';
    select.innerHTML = roleOptions(current);
    $('#u-roles').innerHTML = `<ul>${roles.map((role) => `<li><b>${esc(role.label)}</b>: ${esc(role.description || 'geen omschrijving')}</li>`).join('')}</ul>`
      + '<p>Rechten per rol pas je aan onder <a href="#roles" data-goto="roles">Rollen</a>.</p>';
    /** Toont de omschrijving van de gekozen rol onder de keuzelijst. */
    const showRoleHint = () => {
      const role = roleOf(select.value);
      const text = role && role.description ? role.description : '';
      $('#u-role-hint').textContent = text.length > 80 ? `${text.slice(0, 77).trim()}…` : text;
    };
    select.onchange = showRoleHint;
    showRoleHint();
    const rolesLink = $('#u-roles [data-goto]');
    if (rolesLink) {
      /**
       * Opent de sectie Rollen.
       * @param {MouseEvent} event de klik
       */
      rolesLink.onclick = (event) => { event.preventDefault(); showTab('roles', true); };
    }
  }

  /** Tekent de gebruikerstabel met de knoppen per gebruiker. */
  function renderUsers() {
    const showGuests = $('#u-guests').checked;
    const items = state.users.filter((user) => showGuests || user.kind !== 'gast');
    const table = $('#u-table');
    table.innerHTML = `<thead><tr><th>Naam</th><th>Gebruikersnaam</th><th>Soort</th><th>Rol</th><th class="num">Plannen</th><th class="num">Aanvragen</th><th>Laatst actief</th><th class="num">Sessies</th><th title="De gebruiker moet bij de volgende aanmelding zelf een nieuw wachtwoord kiezen">Nieuw ww. verplicht</th><th></th></tr></thead><tbody>${items.map((user) => {
      const editable = user.kind === 'account';
      return `<tr class="${user.disabled ? 'off' : ''}">
        <td>${esc(user.displayName)}${user.disabled ? ' <span class="pill">uitgeschakeld</span>' : ''}</td>
        <td>${esc(user.username)}</td>
        <td>${esc(KINDS[user.kind] || user.kind)}</td>
        <td>${editable ? `<select data-role="${esc(user.id)}" title="${esc(roleOf(user.role) ? roleOf(user.role).description : '')}">${roleOptions(user.role)}</select>` : `<span class="pill ${esc(user.role)}">${esc(roleLabel(user.role))}</span>`}</td>
        <td class="num">${user.planCount}</td>
        <td class="num">${user.historyCount}</td>
        <td>${esc(when(user.lastSeenAt))}</td>
        <td class="num">${user.sessionCount || 0}</td>
        <td>${editable ? `<input type="checkbox" data-mustchange="${esc(user.id)}"${user.mustChangePassword ? ' checked' : ''} aria-label="Wachtwoord wijzigen bij volgende aanmelding">` : ''}</td>
        <td>${user.sessionCount ? `<button class="btn small" data-logout="${esc(user.id)}">Uitloggen</button> ` : ''}${user.twoFactor ? `<button class="btn small" data-totp="${esc(user.id)}" title="Tweestapsverificatie staat aan">2FA uitzetten</button> ` : ''}${editable ? `<button class="btn small" data-pw="${esc(user.id)}">Wachtwoord</button> <button class="btn small" data-toggle="${esc(user.id)}">${user.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>` : ''}
          ${editable && roleOf(user.role) && roleOf(user.role).kind === 'klant' ? `<a class="btn small" href="../klanten/?id=${encodeURIComponent(user.id)}" title="Klantgroep, bedrijfsgegevens en groothandel staan op de klantkaart">Klantkaart</a> ` : ''}${user.historyCount ? `<button class="btn small" data-hist="${esc(user.id)}">Aanvragen</button>` : ''}
          ${user.kind !== 'systeem' && user.id !== state.meId ? `<button class="btn small danger" data-del="${esc(user.id)}">Verwijderen</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody>`;
    /**
     * Wijzigt een gebruiker en laadt de lijst opnieuw.
     * @param {string} id id van de gebruiker
     * @param {object} body de wijziging
     * @param {string} message melding na het opslaan
     * @returns {Promise<void>}
     */
    const patch = async (id, body, message) => {
      try { await api(`users/${encodeURIComponent(id)}`, { method: 'PATCH', body }); toast(message); } catch (error) { toast(error.message, true); }
      loadUsers();
    };
    table.querySelectorAll('[data-role]').forEach((select) => {
      /**
       * Slaat de gekozen rol op.
       * @returns {Promise<void>}
       */
      select.onchange = () => patch(select.dataset.role, { role: select.value }, 'Rol gewijzigd');
    });
    table.querySelectorAll('[data-toggle]').forEach((button) => {
      const user = state.users.find((candidate) => candidate.id === button.dataset.toggle);
      /**
       * Schakelt de gebruiker in of uit.
       * @returns {Promise<void>}
       */
      button.onclick = () => patch(user.id, { disabled: !user.disabled }, user.disabled ? 'Gebruiker ingeschakeld' : 'Gebruiker uitgeschakeld');
    });
    table.querySelectorAll('[data-pw]').forEach((button) => {
      /** Stelt een nieuw wachtwoord in. */
      button.onclick = () => {
        const password = prompt('Nieuw wachtwoord (minimaal 12 tekens). De gebruiker wordt op alle toestellen uitgelogd.');
        if (!password) return;
        const mustChangePassword = confirm('Moet de gebruiker na de eerste aanmelding met dit wachtwoord zelf een nieuw wachtwoord kiezen?\n\nOK = ja (aanbevolen), Annuleren = nee');
        patch(button.dataset.pw, { password, mustChangePassword }, 'Wachtwoord gewijzigd');
      };
    });
    table.querySelectorAll('[data-mustchange]').forEach((checkbox) => {
      /**
       * Slaat "nieuw wachtwoord verplicht" op.
       * @returns {Promise<void>}
       */
      checkbox.onchange = () => patch(checkbox.dataset.mustchange, { mustChangePassword: checkbox.checked }, checkbox.checked ? 'Moet bij de volgende aanmelding een nieuw wachtwoord kiezen' : 'Wachtwoord wijzigen niet meer verplicht');
    });
    table.querySelectorAll('[data-logout]').forEach((button) => {
      /**
       * Logt de gebruiker uit op alle toestellen.
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (!confirm('Deze gebruiker op alle toestellen uitloggen?')) return;
        try { await api(`users/${encodeURIComponent(button.dataset.logout)}/logout`, { method: 'POST' }); toast('Uitgelogd op alle toestellen'); } catch (error) { toast(error.message, true); }
        loadUsers();
      };
    });
    table.querySelectorAll('[data-totp]').forEach((button) => {
      /**
       * Zet de tweestapsverificatie van de gebruiker uit (telefoon kwijt); daarna logt hij in met alleen het wachtwoord.
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (!confirm('Tweestapsverificatie van deze gebruiker uitzetten? Hij logt daarna in met alleen zijn wachtwoord en kan het op zijn profiel opnieuw aanzetten.')) return;
        try { await api(`users/${encodeURIComponent(button.dataset.totp)}/totp`, { method: 'DELETE' }); toast('Tweestapsverificatie uitgezet'); } catch (error) { toast(error.message, true); }
        loadUsers();
      };
    });
    table.querySelectorAll('[data-del]').forEach((button) => {
      const user = state.users.find((candidate) => candidate.id === button.dataset.del);
      /**
       * Verwijdert de gebruiker na bevestiging.
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (!confirm(deleteQuestion(user))) return;
        try { await api(`users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }); toast('Gebruiker verwijderd'); } catch (error) { toast(error.message, true); }
        loadUsers();
      };
    });
    table.querySelectorAll('[data-hist]').forEach((button) => {
      /** Toont de aanvragen van deze gebruiker. */
      button.onclick = () => { $('#h-user').value = button.dataset.hist; state.offset = 0; showTab('history', true); loadHistory(); };
    });
  }

  /**
   * Maakt de vraag bij het verwijderen van een gebruiker.
   * @param {object} user de gebruiker
   * @returns {string} de vraag
   */
  function deleteQuestion(user) {
    const keep = user.planCount ? `\n\nDe ${user.planCount} plan(nen), offertes en werkorders van deze gebruiker blijven bewaard onder "Verwijderde gebruiker".` : '';
    return `${user.displayName} (${user.username}) definitief verwijderen?\n\nHet account en alle sessies verdwijnen; dit kan niet ongedaan worden gemaakt. Wil je de toegang alleen tijdelijk blokkeren, gebruik dan Uitschakelen.${keep}`;
  }

  /**
   * Voegt een gebruiker toe.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function addUser(event) {
    event.preventDefault();
    const formElement = event.target;
    $('#u-err').textContent = '';
    try {
      await api('users', { method: 'POST', body: { username: formElement.username.value.trim().toLowerCase(), displayName: formElement.displayName.value, role: formElement.role.value, password: formElement.password.value, mustChangePassword: formElement.mustChangePassword.checked } });
      formElement.reset();
      toast('Gebruiker toegevoegd');
      loadUsers();
    } catch (error) {
      $('#u-err').textContent = error.message;
    }
  }

  // ---------- Instellingen ----------
  const SOURCES = { instellingen: '', omgeving: 'uit Docker-omgeving', standaard: 'standaard' };

  /**
   * Vult de formulieren van Instellingen met de huidige waarden en hun herkomst.
   * @param {object} view de instellingen (per veld value/source, geheimen alleen set/hint)
   */
  function renderSettings(view) {
    state.settings = view;
    const ai = $('#s-ai');
    ai.aiEnabled.checked = view.aiEnabled.value;
    ai.planCorpus.checked = view.planCorpus.value;
    ai.aiDailyLimit.value = view.aiDailyLimit.value;
    ai.aiHourlyPerIp.value = view.aiHourlyPerIp.value;
    ai.descriptionBulkDailyItems.value = view.descriptionBulkDailyItems.value;
    ai.relatedAiDailyItems.value = view.relatedAiDailyItems.value;
    ai.aiEurCentsPerUsd.value = view.aiEurCentsPerUsd.value;
    const AiModels = window.AquatechAiModels;
    ai.aiModel.innerHTML = AiModels.SELECTABLE.map((key) => `<option value="${esc(key)}"${key === view.aiModel.value ? ' selected' : ''}>${esc(AiModels.MODELS[key].label)}${key === AiModels.DEFAULT ? ' (aanbevolen)' : ''}</option>`).join('');
    modelInfo();
    document.querySelectorAll('[data-origin]').forEach((element) => { element.textContent = SOURCES[view[element.dataset.origin].source] || ''; });
    document.querySelectorAll('[data-reset]').forEach((button) => { button.hidden = view[button.dataset.reset].source !== 'instellingen'; });
    const key = view.anthropicApiKey;
    const keyState = $('[data-state="anthropicApiKey"]');
    keyState.textContent = key.set ? `Ingesteld${key.hint ? ` (eindigt op ${key.hint.replace('…', '')})` : ''}`
      : state.aiFromLive ? 'Geen eigen sleutel: deze testomgeving gebruikt de sleutel, het model en de koers van de live-omgeving.'
        : 'Niet ingesteld: AI-herkenning staat uit. Elke organisatie gebruikt een eigen sleutel.';
    keyState.className = `state ${key.set || state.aiFromLive ? 'ok' : 'off'}`;
    const code = view.accessCode;
    const codeState = $('[data-state="accessCode"]');
    codeState.textContent = code.set ? 'Ingesteld: inloggen kan ook met de code (als beheerder).' : 'Niet ingesteld: inloggen alleen met een eigen account.';
    $('#s-backup').backupKeepDays.value = view.backupKeepDays.value;
    const addressForm = $('#s-app-address');
    addressForm.appPublicUrl.value = view.appPublicUrl?.value?.url || '';
    const shopUrl = view.shopPayment?.value?.publicUrl || '';
    $('#s-app-address-info').textContent = addressForm.appPublicUrl.value ? '' : shopUrl ? `Leeg: het webadres van de webshop (${shopUrl}) wordt gebruikt.` : 'Nog niet ingesteld: klantlinks maken kan pas na het invullen van dit adres.';
    const securityForm = $('#s-security');
    for (const key of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays', 'logRetentionDays', 'logErrorRetentionDays']) securityForm[key].value = view[key].value;
    const accessForm = $('#s-access');
    accessForm.guestAccess.checked = view.guestAccess.value;
    accessForm.guestAccess.disabled = code.set;
    accessForm.drawingRequests.checked = view.drawingRequests.value;
    $('#s-debug').debugMode.checked = Boolean(view.debugMode?.value);
    $('#s-ai-connector').aiConnector.checked = Boolean(view.aiConnector?.value);
    $('#s-purchase-proposals').purchaseProposalsEnabled.checked = view.purchaseProposals?.value?.enabled !== false;
    $('#s-ai-connector-url').textContent = new URL('../mcp', location.href).href;
    showConnectorUrl();
    const shopForm = $('#s-shop');
    shopForm.storefront.checked = Boolean(view.storefront?.value);
    shopForm.shopPlanner.checked = view.shopPlanner?.value !== false;
    shopForm.shopOrdering.checked = Boolean(view.shopOrdering?.value);
    shopForm.hidden = !state.storefrontAllowed;
    window.BeheerVerzending.render(view.shopShipping?.value);
    $('#s-shipping').hidden = !state.storefrontAllowed;
    renderPayment(view);
    renderAnalytics(view);
    renderClarity(view);
    renderSeo(view);
    renderCaptcha(view);
    codeState.className = `state ${code.set ? 'ok' : 'off'}`;
    $('[data-clear="anthropicApiKey"]').disabled = !key.set;
    $('[data-clear="accessCode"]').disabled = !code.set;
    renderSeason(view.seasonReminders.value);
    if (view.paymentReminders) renderPaymentReminders(view.paymentReminders.value);
    const followUpForm = $('#s-quote-followup');
    const followUp = view.quoteFollowUp?.value || {};
    followUpForm.enabled.checked = Boolean(followUp.enabled);
    followUpForm.afterDays.value = followUp.afterDays || 7;
    followUpForm.maxReminders.value = String(followUp.maxReminders || 1);
    if (view.labelTemplates) renderLabelTemplates(view.labelTemplates.value);
    const outsourcingForm = $('#s-outsourcing');
    const outsourcing = view.outsourcing.value;
    outsourcingForm.send.checked = outsourcing.send;
    outsourcingForm.receive.checked = outsourcing.receive;
    outsourcingForm.region.value = outsourcing.region || '';
  }

  /** Uitleg en prijs bij het gekozen model. */
  function modelInfo() {
    const AiModels = window.AquatechAiModels;
    const model = AiModels.MODELS[$('#s-ai-model').value];
    if (!model) return;
    $('#s-ai-model-info').textContent = `${model.description} Prijs: $ ${model.input} per miljoen tokens in, $ ${model.output} per miljoen tokens uit `
      + '(een plan herkennen kost meestal enkele duizenden tokens in en 5.000–15.000 uit). Het verbruik per verzoek zie je bij AI-kosten.';
  }

  /**
   * Formatteert een bestandsgrootte.
   * @param {number} bytes aantal bytes
   * @returns {string} bijv. '12,5 MB' of '840 kB'
   */
  const size = (bytes) => (bytes >= 1048576 ? `${num(bytes / 1048576)} MB` : `${num(bytes / 1024, 0)} kB`);
  /**
   * Laadt de lijst met back-ups.
   * @returns {Promise<void>}
   */
  async function loadBackups() {
    const list = $('#b-list');
    try {
      const { enabled, items, keyFingerprint } = await api('backups');
      $('#b-fingerprint').textContent = keyFingerprint || 'onbekend';
      const driveNames = await api('backups/drive').then((drive) => new Set(drive.items.filter((item) => item.onDrive).map((item) => item.name))).catch(() => new Set());
      $('#b-now').disabled = !enabled;
      list.innerHTML = !enabled ? 'Back-ups zijn op deze server niet beschikbaar.'
        : !items.length ? 'Nog geen back-ups.'
          : window.BeheerCollapse.render(items.map((backup) => `<li><a href="../api/admin/backups/${encodeURIComponent(backup.name)}" download>${esc(backup.name)}</a> · ${esc(when(backup.createdAt))} · ${esc(size(backup.size))}${driveNames.has(backup.name) ? ' · op Drive' : ''}
            <button class="btn small danger" data-backup-del="${esc(backup.name)}">Verwijderen</button></li>`), { expanded: window.BeheerCollapse.isExpanded(list) });
      list.querySelectorAll('[data-backup-del]').forEach((button) => {
        /**
         * Verwijdert deze back-up na bevestiging.
         * @returns {Promise<void>}
         */
        button.onclick = async () => {
          const name = button.dataset.backupDel;
          const credentials = await window.BeheerReauth.ask(`Back-up ${name} verwijderen?`, 'Het bestand wordt definitief gewist van de server. Bevestig met je wachtwoord. De nieuwste back-up kan niet worden verwijderd.');
          if (!credentials) return;
          try { await api(`backups/${encodeURIComponent(name)}`, { method: 'DELETE', body: credentials }); toast('Back-up verwijderd'); } catch (error) { toast(error.message, true); }
          loadBackups();
        };
      });
    } catch (error) {
      list.textContent = `Kan de back-ups niet laden (${error.message}).`;
    }
  }

  /**
   * Haalt de instellingen op en tekent de formulieren; state.settings wordt pas gevuld als dat lukt.
   * @returns {Promise<void>}
   */
  async function fetchSettings() {
    try {
      const result = await api('settings');
      state.aiFromLive = Boolean(result.aiFromLive);
      state.storefrontAllowed = Boolean(result.storefrontAllowed);
      renderSettings(result.settings);
    } catch (error) {
      toast(`Kan de instellingen niet laden: ${error.message}`, true);
    }
  }

  /**
   * Laadt de instellingen en wat de gekozen sectie extra nodig heeft (e-mail of, voor hoofdbeheerders, de back-ups).
   * Instellingen en e-mail worden per paginabezoek één keer succesvol geladen (een lopend verzoek wordt gedeeld), zodat wisselen tussen
   * secties geen ingevulde maar nog niet opgeslagen velden wist; na een fout wordt het bij de volgende keer opnieuw geprobeerd.
   * Opslaan tekent de formulieren zelf opnieuw.
   * @param {string} [sectionId] De sectie die getoond wordt; leeg = alleen de instellingen zelf.
   * @returns {Promise<void>}
   */
  async function loadSettings(sectionId) {
    const pending = state.pending || (state.pending = {});
    if (sectionId === 'backup' && state.backups) loadBackups();
    if (sectionId === 'backup-drive' && state.backups) window.BeheerDrive.load();
    if (sectionId === 'restore' && state.backups) window.BeheerRestore.load();
    if (sectionId === 'mail' && !state.mailLoaded && !pending.mail) {
      pending.mail = window.BeheerMail.load().then((loaded) => { state.mailLoaded = loaded; }).finally(() => { pending.mail = null; });
    }
    if (state.settings) return;
    if (!pending.settings) pending.settings = fetchSettings().finally(() => { pending.settings = null; });
    await pending.settings;
  }

  const { MONTHS, MONTH_DAYS, renderSeason, readSeason, renderPaymentReminders, readPaymentReminders } = window.BeheerHerinneringen;
  const { labelTemplateHtml, renderLabelTemplates, updateLabelButtons, readLabelTemplates } = window.BeheerEtiketten;

  /**
   * Slaat instellingen op en toont de nieuwe stand.
   * @param {HTMLFormElement} form het formulier (voor de foutmelding)
   * @param {object} patch de gewijzigde instellingen
   * @param {string} message melding na het opslaan
   * @returns {Promise<boolean>} true als het opslaan lukte
   */
  async function saveSettings(form, patch, message) {
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    try {
      const result = await api('settings', { method: 'PUT', body: patch });
      renderSettings(result.settings);
      if (patch.modules) await refreshMenu();
      form.querySelectorAll('input[type=password]').forEach((input) => { input.value = ''; });
      toast(result.changed.length ? message : 'Niets gewijzigd');
      return true;
    } catch (error) {
      errorBox.textContent = error.message;
      return false;
    }
  }

  /**
   * Toont het adres van de AI-koppeling zoals de server het opgeeft (het webadres uit Beheer als dat is ingevuld).
   * @returns {Promise<void>}
   */
  async function showConnectorUrl() {
    try {
      const res = await fetch('../api/account/connections', { cache: 'no-store' });
      const body = await res.json();
      if (res.ok && body.url) $('#s-ai-connector-url').textContent = body.url;
    } catch {
      // Het adres van deze pagina blijft dan staan.
    }
  }

  /**
   * Vult het formulier Google Analytics met de opgeslagen instelling en toont of de meting nu actief is.
   * @param {object} view De instellingen zoals de server ze toont (shopAnalytics).
   * @returns {void}
   */
  function renderAnalytics(view) {
    const form = $('#s-analytics');
    const analytics = view.shopAnalytics?.value || {};
    form.hidden = !state.storefrontAllowed;
    form.enabled.checked = Boolean(analytics.enabled);
    form.measurementId.value = analytics.measurementId || '';
    const status = $('#s-analytics-state');
    const active = Boolean(analytics.enabled && analytics.measurementId);
    status.textContent = active ? `Actief: de webshop meet met ${analytics.measurementId}, na toestemming van de bezoeker.` : analytics.enabled ? 'Niet actief: vul een geldig meet-ID in.' : 'Uit: de webshop laadt niets van Google.';
    status.className = `state ${active ? 'ok' : 'off'}`;
  }

  /**
   * Vult het formulier Microsoft Clarity met de opgeslagen instelling en toont of Clarity nu actief is.
   * @param {object} view De instellingen zoals de server ze toont (shopClarity).
   * @returns {void}
   */
  function renderClarity(view) {
    const form = $('#s-clarity');
    const clarity = view.shopClarity?.value || {};
    form.hidden = !state.storefrontAllowed;
    form.enabled.checked = Boolean(clarity.enabled);
    form.projectId.value = clarity.projectId || '';
    const status = $('#s-clarity-state');
    const active = Boolean(clarity.enabled && clarity.projectId);
    status.textContent = active ? `Actief: Clarity (${clarity.projectId}) laadt alleen na toestemming van de bezoeker.` : clarity.enabled ? 'Niet actief: vul een geldig project-ID in.' : 'Uit: de webshop laadt niets van Clarity.';
    status.className = `state ${active ? 'ok' : 'off'}`;
  }

  /**
   * Vult het formulier Zoekmachines met de opgeslagen instelling en toont of de webshop voor zoekmachines open staat.
   * @param {object} view De instellingen zoals de server ze toont (shopSeo en shopPayment).
   * @returns {void}
   */
  function renderSeo(view) {
    const form = $('#s-seo');
    form.hidden = !state.storefrontAllowed;
    const open = Boolean(view.shopSeo?.value?.indexing);
    const hasUrl = Boolean(view.shopPayment?.value?.publicUrl);
    form.indexing.checked = open;
    const status = $('#s-seo-state');
    status.textContent = open && hasUrl ? 'Open: zoekmachines mogen de webshop opnemen.' : open ? 'Nog dicht: vul eerst het webadres van de webshop in (bij Betalen).' : 'Dicht: de webshop staat op noindex en robots.txt blokkeert alles.';
    status.className = `state ${open && hasUrl ? 'ok' : 'off'}`;
  }

  /**
   * Vult het formulier Onzichtbare captcha met de opgeslagen instelling en toont of de captcha nu actief is.
   * @param {object} view De instellingen zoals de server ze toont (captcha en captchaSecret).
   * @returns {void}
   */
  function renderCaptcha(view) {
    const form = $('#s-captcha');
    const captcha = view.captcha?.value || {};
    const secret = view.captchaSecret || {};
    form.enabled.checked = Boolean(captcha.enabled);
    form.siteKey.value = captcha.siteKey || '';
    form.minScore.value = captcha.minScore == null ? 0.5 : captcha.minScore;
    form.onUnreachable.value = captcha.onUnreachable === 'block' ? 'block' : 'allow';
    const secretState = $('#s-captcha-secret-state');
    secretState.textContent = secret.set ? 'Ingesteld.' : 'Niet ingesteld.';
    secretState.className = `state ${secret.set ? 'ok' : 'off'}`;
    const status = $('#s-captcha-state');
    const active = Boolean(captcha.enabled && captcha.siteKey && secret.set);
    status.textContent = active ? 'Actief: de openbare formulieren controleren bezoekers op de achtergrond.' : captcha.enabled ? 'Niet actief: vul een geldige sitesleutel en een geheime sleutel in.' : 'Uit: de formulieren werken zonder captcha.';
    status.className = `state ${active ? 'ok' : 'off'}`;
  }

  /**
   * Vult het formulier Betalen met de opgeslagen instelling.
   * @param {object} view De instellingen zoals de server ze toont (shopPayment en mollieApiKey).
   * @returns {void}
   */
  function renderPayment(view) {
    const form = $('#s-payment');
    const payment = view.shopPayment?.value || {};
    const key = view.mollieApiKey || {};
    form.hidden = !state.storefrontAllowed;
    form.online.checked = Boolean(payment.online);
    form.publicUrl.value = payment.publicUrl || '';
    form.guestCheckout.checked = payment.guestCheckout !== false;
    const footerMethods = Array.isArray(payment.footerMethods) ? payment.footerMethods : ['ideal', 'creditcard', 'bancontact', 'paypal', 'applepay', 'banktransfer'];
    form.querySelectorAll('input[name="footerMethod"]').forEach((box) => { box.checked = footerMethods.includes(box.value); });
    form.paymentReminder.checked = payment.paymentReminder !== false;
    form.quoteRequest.checked = payment.quoteRequest !== false;
    form.quoteRequestMin.value = payment.quoteRequestMin || 500;
    form.onAccount.value = payment.onAccount || 'iedereen';
    form.holdHours.value = payment.holdHours || 24;
    form.accountHoldDays.value = payment.accountHoldDays == null ? 14 : payment.accountHoldDays;
    const keyState = $('#s-payment-key-state');
    keyState.textContent = key.set ? `Ingesteld${key.hint ? ` (${key.hint})` : ''}.` : 'Niet ingesteld: online betalen kan pas met een sleutel.';
    keyState.className = `state ${key.set ? 'ok' : 'off'}`;
  }

  /** Koppelt de formulieren en knoppen van Instellingen. */
  function initSettings() {
    const aiForm = $('#s-ai');
    /**
     * Slaat de AI-instellingen op.
     * @param {SubmitEvent} event het verzenden
     */
    aiForm.onsubmit = (event) => {
      event.preventDefault();
      const patch = { aiEnabled: aiForm.aiEnabled.checked, planCorpus: aiForm.planCorpus.checked, aiDailyLimit: Number(aiForm.aiDailyLimit.value), aiHourlyPerIp: Number(aiForm.aiHourlyPerIp.value),
        descriptionBulkDailyItems: Number(aiForm.descriptionBulkDailyItems.value), relatedAiDailyItems: Number(aiForm.relatedAiDailyItems.value),
        aiModel: aiForm.aiModel.value, aiEurCentsPerUsd: Number(aiForm.aiEurCentsPerUsd.value) };
      if (aiForm.anthropicApiKey.value.trim()) patch.anthropicApiKey = aiForm.anthropicApiKey.value.trim();
      saveSettings(aiForm, patch, 'Instellingen opgeslagen');
    };
    aiForm.aiModel.onchange = modelInfo;
    /**
     * Test de API-sleutel (een net ingevulde sleutel wordt eerst opgeslagen).
     * @returns {Promise<void>}
     */
    $('#s-test').onclick = async () => {
      const testButton = $('#s-test');
      const errorBox = $('.err', aiForm);
      // Eerst een net ingevulde sleutel opslaan, dan testen.
      if (aiForm.anthropicApiKey.value.trim() && !(await saveSettings(aiForm, { anthropicApiKey: aiForm.anthropicApiKey.value.trim() }, 'Sleutel opgeslagen'))) return;
      testButton.disabled = true;
      testButton.textContent = 'Bezig…';
      errorBox.textContent = '';
      try {
        const result = await api('settings/test-ai', { method: 'POST' });
        toast(`De sleutel werkt${result.model ? ` met ${window.AquatechAiModels.label(result.model)}` : ''}.`);
      } catch (error) {
        errorBox.textContent = error.message;
      } finally {
        testButton.disabled = false;
        testButton.textContent = 'Sleutel testen';
      }
    };
    const accessForm = $('#s-access');
    /** Zet gasttoegang aan of uit. */
    accessForm.guestAccess.onchange = () => {
      saveSettings(accessForm, { guestAccess: accessForm.guestAccess.checked }, accessForm.guestAccess.checked ? 'Gasten toegestaan' : 'Inloggen is nu verplicht');
    };
    /** Zet tekening indienen zonder account aan of uit. */
    accessForm.drawingRequests.onchange = () => {
      saveSettings(accessForm, { drawingRequests: accessForm.drawingRequests.checked }, accessForm.drawingRequests.checked ? 'Tekening indienen zonder account staat aan' : 'Tekening indienen zonder account staat uit');
    };
    const debugForm = $('#s-debug');
    /** Zet de debugmodus (foutdetails voor beheerders) aan of uit. */
    debugForm.debugMode.onchange = () => {
      saveSettings(debugForm, { debugMode: debugForm.debugMode.checked }, debugForm.debugMode.checked ? 'Debugmodus staat aan' : 'Debugmodus staat uit');
    };
    debugForm.addEventListener('submit', (event) => event.preventDefault());
    const proposalsForm = $('#s-purchase-proposals');
    /** Zet de automatische bestelvoorstellen (concept-inkooporders bij te weinig voorraad) aan of uit. */
    proposalsForm.purchaseProposalsEnabled.onchange = () => {
      const enabled = proposalsForm.purchaseProposalsEnabled.checked;
      saveSettings(proposalsForm, { purchaseProposals: { enabled } }, enabled ? 'Automatische bestelvoorstellen staan aan' : 'Automatische bestelvoorstellen staan uit');
    };
    proposalsForm.addEventListener('submit', (event) => event.preventDefault());
    const connectorForm = $('#s-ai-connector');
    /** Zet de AI-koppeling (Claude en ChatGPT, concept-offertes) aan of uit. */
    connectorForm.aiConnector.onchange = () => {
      saveSettings(connectorForm, { aiConnector: connectorForm.aiConnector.checked }, connectorForm.aiConnector.checked ? 'AI-koppeling staat aan' : 'AI-koppeling staat uit');
    };
    connectorForm.addEventListener('submit', (event) => event.preventDefault());
    $('#s-ai-connector-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#s-ai-connector-url').textContent);
        toast('Adres gekopieerd');
      } catch {
        getSelection().selectAllChildren($('#s-ai-connector-url'));
      }
    });
    const shopForm = $('#s-shop');
    /** Zet de eigen webshop (startpagina /) aan of uit. */
    shopForm.storefront.onchange = () => {
      saveSettings(shopForm, { storefront: shopForm.storefront.checked }, shopForm.storefront.checked ? 'Webshop staat aan' : 'Webshop staat uit');
    };
    /** Zet bestellen in de webshop aan of uit. */
    shopForm.shopOrdering.onchange = () => {
      saveSettings(shopForm, { shopOrdering: shopForm.shopOrdering.checked }, shopForm.shopOrdering.checked ? 'Bestellen in de webshop staat aan' : 'Bestellen in de webshop staat uit');
    };
    const paymentForm = $('#s-payment');
    /**
     * Slaat de betaalinstelling op; een ingevulde API-sleutel gaat mee, een lege blijft ongewijzigd.
     * @param {SubmitEvent} event het verzenden
     */
    paymentForm.onsubmit = (event) => {
      event.preventDefault();
      const patch = { shopPayment: { online: paymentForm.online.checked, publicUrl: paymentForm.publicUrl.value.trim(), onAccount: paymentForm.onAccount.value, guestCheckout: paymentForm.guestCheckout.checked, footerMethods: [...paymentForm.querySelectorAll('input[name="footerMethod"]:checked')].map((box) => box.value), paymentReminder: paymentForm.paymentReminder.checked, quoteRequest: paymentForm.quoteRequest.checked, quoteRequestMin: Number(paymentForm.quoteRequestMin.value), holdHours: Number(paymentForm.holdHours.value), accountHoldDays: paymentForm.accountHoldDays.value.trim() === '' ? '' : Number(paymentForm.accountHoldDays.value) } };
      if (paymentForm.mollieApiKey.value.trim()) patch.mollieApiKey = paymentForm.mollieApiKey.value.trim();
      saveSettings(paymentForm, patch, 'Betalen opgeslagen');
    };
    const captchaForm = $('#s-captcha');
    /**
     * Slaat de captcha-instelling op. Een nieuw geheim wordt eerst bij Google gecontroleerd: een geweigerd geheim wordt niet bewaard,
     * een onbereikbaar Google geeft een waarschuwing maar bewaart wel.
     * @param {SubmitEvent} event het verzenden
     */
    captchaForm.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', captchaForm);
      errorBox.textContent = '';
      const siteKey = captchaForm.siteKey.value.trim();
      const secret = captchaForm.captchaSecret.value.trim();
      if (siteKey && !/^6L[A-Za-z0-9_-]{38}$/.test(siteKey)) { errorBox.textContent = 'Dit is geen geldige sitesleutel van reCAPTCHA. Hij begint met 6L en is 40 tekens lang.'; return; }
      if (captchaForm.enabled.checked && !siteKey) { errorBox.textContent = 'Vul een sitesleutel in om de captcha aan te zetten.'; return; }
      const score = Number(String(captchaForm.minScore.value).replace(',', '.'));
      if (!(score >= 0.1 && score <= 0.9)) { errorBox.textContent = 'De minimumscore ligt tussen 0,1 en 0,9.'; return; }
      let warning = '';
      if (captchaForm.enabled.checked || secret) {
        try {
          const checked = await api('captcha/check', { method: 'POST', body: secret ? { secret } : {} });
          if (checked.result === 'invalid') { errorBox.textContent = 'Google herkent deze geheime sleutel niet. Controleer of je de geheime sleutel (niet de sitesleutel) van een reCAPTCHA v3-sleutel hebt gekopieerd.'; return; }
          if (checked.result === 'not_set' && captchaForm.enabled.checked) { errorBox.textContent = 'Vul ook de geheime sleutel in om de captcha aan te zetten.'; return; }
          if (checked.result === 'unreachable') warning = ' (Google was nu niet bereikbaar: de sleutel is niet gecontroleerd)';
        } catch (error) {
          errorBox.textContent = error.message;
          return;
        }
      }
      const patch = { captcha: { enabled: captchaForm.enabled.checked, siteKey, minScore: score, onUnreachable: captchaForm.onUnreachable.value } };
      if (secret) patch.captchaSecret = secret;
      saveSettings(captchaForm, patch, `Captcha opgeslagen${warning}`);
    };
    const analyticsForm = $('#s-analytics');
    /**
     * Slaat de instelling voor Google Analytics op; een ongeldig meet-ID wordt niet bewaard.
     * @param {SubmitEvent} event het verzenden
     */
    analyticsForm.onsubmit = (event) => {
      event.preventDefault();
      const measurementId = analyticsForm.measurementId.value.trim().toUpperCase();
      if (measurementId && !/^G-[A-Z0-9]{4,14}$/.test(measurementId)) { $('.err', analyticsForm).textContent = 'Dit is geen geldig meet-ID. Het begint met G- en heeft 4 tot 14 letters of cijfers.'; return; }
      if (analyticsForm.enabled.checked && !measurementId) { $('.err', analyticsForm).textContent = 'Vul een meet-ID in om Google Analytics aan te zetten.'; return; }
      saveSettings(analyticsForm, { shopAnalytics: { enabled: analyticsForm.enabled.checked, measurementId } }, 'Google Analytics opgeslagen');
    };
    const clarityForm = $('#s-clarity');
    /**
     * Slaat de instelling voor Clarity op; een ongeldig project-ID wordt niet bewaard.
     * @param {SubmitEvent} event het verzenden
     */
    clarityForm.onsubmit = (event) => {
      event.preventDefault();
      const projectId = clarityForm.projectId.value.trim().toLowerCase();
      if (projectId && !/^[a-z0-9]{6,16}$/.test(projectId)) { $('.err', clarityForm).textContent = 'Dit is geen geldig project-ID. Het bestaat uit 6 tot 16 letters of cijfers.'; return; }
      if (clarityForm.enabled.checked && !projectId) { $('.err', clarityForm).textContent = 'Vul een project-ID in om Clarity aan te zetten.'; return; }
      saveSettings(clarityForm, { shopClarity: { enabled: clarityForm.enabled.checked, projectId } }, 'Clarity opgeslagen');
    };
    const seoForm = $('#s-seo');
    /**
     * Slaat de vrijgave voor zoekmachines op.
     * @param {SubmitEvent} event het verzenden
     */
    seoForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(seoForm, { shopSeo: { indexing: seoForm.indexing.checked } }, 'Zoekmachines opgeslagen');
    };
    const shippingForm = $('#s-shipping');
    /**
     * Slaat de verzendinstelling op.
     * @param {SubmitEvent} event het verzenden
     */
    shippingForm.onsubmit = (event) => {
      event.preventDefault();
      try { saveSettings(shippingForm, { shopShipping: window.BeheerVerzending.read() }, 'Verzending opgeslagen'); } catch (error) { $('.err', shippingForm).textContent = error.message; }
    };
    /** Zet het kopje Planner in de webshop aan of uit. */
    shopForm.shopPlanner.onchange = () => {
      saveSettings(shopForm, { shopPlanner: shopForm.shopPlanner.checked }, shopForm.shopPlanner.checked ? 'Kopje Planner in de webshop staat aan' : 'Kopje Planner in de webshop staat uit');
    };
    /**
     * Slaat een nieuwe toegangscode op.
     * @param {SubmitEvent} event het verzenden
     */
    accessForm.onsubmit = (event) => {
      event.preventDefault();
      const code = accessForm.accessCode.value.trim();
      if (!code) { $('.err', accessForm).textContent = 'Vul een nieuwe code in.'; return; }
      saveSettings(accessForm, { accessCode: code }, 'Toegangscode opgeslagen');
    };
    document.querySelectorAll('[data-clear]').forEach((button) => {
      /** Verwijdert de toegangscode of API-sleutel na bevestiging. */
      button.onclick = () => {
        const field = button.dataset.clear;
        const question = field === 'accessCode'
          ? 'Toegangscode verwijderen? Inloggen kan daarna alleen nog met een eigen account.'
          : 'API-sleutel verwijderen? Automatisch herkennen met AI staat daarna uit.';
        if (confirm(question)) saveSettings(button.closest('form'), { [field]: '' }, field === 'accessCode' ? 'Toegangscode verwijderd' : 'API-sleutel verwijderd');
      };
    });
    document.querySelectorAll('[data-reset]').forEach((button) => {
      /** Zet een instelling terug naar de waarde uit de omgeving of de standaard. */
      button.onclick = () => {
        if (confirm('Terugzetten naar de waarde uit de Docker-omgeving of de standaardwaarde?')) {
          saveSettings(button.closest('form'), { reset: [button.dataset.reset] }, 'Teruggezet');
        }
      };
    });
    const addressForm = $('#s-app-address');
    /**
     * Slaat het openbare adres van de app op (basis van klantlinks en AI-koppeling).
     * @param {Event} event Het indienen van het formulier.
     */
    addressForm.onsubmit = (event) => {
      event.preventDefault();
      const typed = addressForm.appPublicUrl.value.trim();
      if (typed && !/^https:\/\/[^/\s]+/i.test(typed) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(typed)) {
        $('.err', addressForm).textContent = 'Vul een adres in dat met https:// begint.';
        return;
      }
      saveSettings(addressForm, { appPublicUrl: { url: addressForm.appPublicUrl.value.trim() } }, 'Openbaar adres opgeslagen');
    };
    const backupForm = $('#s-backup');
    /**
     * Slaat de bewaartermijn van back-ups op.
     * @param {SubmitEvent} event het verzenden
     */
    backupForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(backupForm, { backupKeepDays: Number(backupForm.backupKeepDays.value) }, 'Instellingen opgeslagen');
    };
    /**
     * Maakt nu een back-up.
     * @returns {Promise<void>}
     */
    $('#b-now').onclick = async () => {
      const button = $('#b-now');
      button.disabled = true;
      button.textContent = 'Bezig…';
      try { await api('backups', { method: 'POST' }); toast('Back-up gemaakt'); } catch (error) { toast(error.message, true); }
      button.textContent = 'Nu back-up maken';
      loadBackups();
    };
    const securityForm = $('#s-security');
    /**
     * Slaat de beveiligingsinstellingen op.
     * @param {SubmitEvent} event het verzenden
     */
    securityForm.onsubmit = (event) => {
      event.preventDefault();
      const patch = {};
      for (const key of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays', 'logRetentionDays', 'logErrorRetentionDays']) patch[key] = Number(securityForm[key].value);
      saveSettings(securityForm, patch, 'Instellingen opgeslagen');
    };
    const seasonForm = $('#s-season');
    /**
     * Slaat de seizoensherinneringen op.
     * @param {SubmitEvent} event het verzenden
     */
    seasonForm.onsubmit = (event) => {
      event.preventDefault();
      const config = readSeason();
      // De server maakt van 31 februari 28 februari; liever meteen melden.
      const wrongDate = config.items.find((item) => item.day > MONTH_DAYS[item.month - 1]);
      if (wrongDate) {
        $('.err', seasonForm).textContent = `${wrongDate.title || 'Herinnering'}: ${MONTHS[wrongDate.month - 1]} heeft maar ${MONTH_DAYS[wrongDate.month - 1]} dagen.`;
        return;
      }
      saveSettings(seasonForm, { seasonReminders: config }, 'Seizoensherinneringen opgeslagen');
    };
    const paymentRemindersForm = $('#s-payment-reminders');
    /**
     * Slaat de betalingsherinneringen op.
     * @param {SubmitEvent} event het verzenden
     */
    paymentRemindersForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(paymentRemindersForm, { paymentReminders: readPaymentReminders() }, 'Betalingsherinneringen opgeslagen');
    };
    const followUpForm = $('#s-quote-followup');
    /**
     * Slaat de offerte-opvolging op.
     * @param {SubmitEvent} event het verzenden
     */
    followUpForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(followUpForm, { quoteFollowUp: { enabled: followUpForm.enabled.checked, afterDays: Number(followUpForm.afterDays.value), maxReminders: Number(followUpForm.maxReminders.value) } }, 'Offerte-opvolging opgeslagen');
    };
    const labelsForm = $('#s-labels');
    /**
     * Voegt een leeg etiketsjabloon toe.
     * @returns {void}
     */
    $('#s-labels-add').onclick = () => {
      $('#s-labels-list').insertAdjacentHTML('beforeend', labelTemplateHtml({ name: '', widthMm: 57, heightMm: 32, barcode: 'auto', price: 'incl' }, false));
      updateLabelButtons();
      $('#s-labels-list').lastElementChild.querySelector('[name="name"]').focus();
    };
    labelsForm.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-label]');
      if (!button) return;
      button.closest('.label-template').remove();
      updateLabelButtons();
    });
    /**
     * Slaat de etiketsjablonen op (eerst de maten in de browser controleren).
     * @param {SubmitEvent} event het verzenden
     */
    labelsForm.onsubmit = (event) => {
      event.preventDefault();
      const config = readLabelTemplates();
      const wrong = config.templates.find((template) => !template.name || !(template.widthMm >= 15 && template.widthMm <= 150) || !(template.heightMm >= 15 && template.heightMm <= 150));
      if (wrong) {
        $('.err', labelsForm).textContent = `${wrong.name || 'Sjabloon zonder naam'}: geef een naam en een breedte en hoogte van 15 tot 150 mm.`;
        return;
      }
      saveSettings(labelsForm, { labelTemplates: config }, 'Etiketten opgeslagen');
    };
    const outsourcingForm = $('#s-outsourcing');
    /**
     * Slaat de instellingen voor uitbesteden op.
     * @param {SubmitEvent} event het verzenden
     */
    outsourcingForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(outsourcingForm, { outsourcing: { send: outsourcingForm.send.checked, receive: outsourcingForm.receive.checked, region: outsourcingForm.region.value.trim() } }, 'Uitbesteden opgeslagen');
    };
  }

  // ---------- Auditlog ----------
  /**
   * Maakt de details van een auditregel leesbaar.
   * @param {object} entry de auditregel
   * @returns {string} de details, gescheiden door ' · '
   */
  function auditDetail(entry) {
    const detail = entry.detail || {};
    const parts = [];
    if (detail.username) parts.push(`gebruiker ${detail.username}`);
    if (detail.via) parts.push(`via ${detail.via}`);
    if (detail.role) parts.push(`rol ${detail.role}`);
    if (detail.disabled !== undefined) parts.push(detail.disabled ? 'uitgeschakeld' : 'ingeschakeld');
    if (detail.fields) parts.push(`velden: ${detail.fields.join(', ')}`);
    if (detail.count !== undefined) parts.push(`${detail.count} sessie(s)`);
    if (detail.name) parts.push(detail.name);
    if (detail.aan) parts.push(`aan ${detail.aan}`);
    if (detail.van) parts.push(`van ${detail.van}`);
    if (detail.door) parts.push(`door ${detail.door}`);
    if (detail.automatisch) parts.push('automatisch');
    return parts.join(' · ');
  }

  /**
   * Laadt een pagina van het auditlog en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function loadAudit() {
    const table = $('#a-table');
    try {
      const { total, items } = await api(`audit?limit=${PAGE}&offset=${state.auditOffset}`);
      table.innerHTML = !items.length ? '<tr><td class="empty">Nog geen gebeurtenissen.</td></tr>'
        : `<thead><tr><th>Tijdstip</th><th>Gebeurtenis</th><th>Door</th><th>Details</th><th>IP-adres</th></tr></thead><tbody>${items.map((entry) => `
          <tr><td>${esc(when(entry.createdAt))}</td><td>${esc(AUDIT[entry.action] || entry.action)}</td>
            <td>${entry.user ? esc(entry.user.displayName) : '–'}</td><td class="wrap">${esc(auditDetail(entry))}</td><td>${esc(entry.ip || '–')}</td></tr>`).join('')}</tbody>`;
      const from = total ? state.auditOffset + 1 : 0;
      $('#a-info').textContent = `${from}–${Math.min(total, state.auditOffset + PAGE)} van ${total}`;
      $('#a-prev').disabled = state.auditOffset === 0;
      $('#a-next').disabled = state.auditOffset + PAGE >= total;
    } catch (error) {
      table.innerHTML = `<tr><td class="empty">Kan het auditlog niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  // ---------- Algemeen ----------
  /**
   * Haalt op welke modules uit staan (zoals de server ze laat gelden) en onthoudt welke secties van Beheer daarbij horen:
   * die staan in het moduleregister (`configuration.sections`, dashboard/modules.js) en verdwijnen uit het menu.
   * @param {boolean} [fresh] true = niet de gedeelde kopie van deze pagina maar opnieuw bij de server vragen.
   * @returns {Promise<void>}
   */
  async function loadModuleFlags(fresh = false) {
    const config = await window.AquatechCommon.getJson('api/config', { fresh }).catch(() => null);
    state.hiddenSections = window.AquatechModuleTools.hiddenSections((config && config.modules) || {});
  }

  /**
   * Bouwt het zijmenu van Beheer: zonder back-ups voor wie ze niet mag zien en zonder secties van modules die uit staan.
   * @param {string} startId Sectie waarmee de pagina opent (haar groep staat open).
   * @returns {void}
   */
  function buildMenu(startId) {
    window.BeheerIndeling.build({
      startId,
      /**
       * Back-ups zijn alleen voor hoofdbeheerders zichtbaar, Updates alleen voor wie mag bijwerken; instellingen van een uitgezette module helemaal niet.
       * @param {object} section De sectie.
       * @returns {boolean} true als de sectie in het menu hoort.
       */
      allowed: (section) => (section.needs !== 'backups' || state.backups) && (section.needs !== 'updates' || state.updates) && !state.hiddenSections.has(section.id),
      /**
       * Opent de gekozen sectie als nieuwe stap in de browsergeschiedenis.
       * @param {string} id Sleutel van de sectie.
       */
      onSelect: (id) => showTab(id, true),
    });
  }

  /**
   * Na het opslaan van Modules aan/uit: het menu van Beheer en de zijbalk opnieuw opbouwen, zodat secties en modules die
   * net uit zijn gezet weg zijn (en aangezette terug), met Modules aan/uit zelf als open sectie.
   * @returns {Promise<void>}
   */
  async function refreshMenu() {
    await loadModuleFlags(true);
    const config = await window.AquatechCommon.getJson('api/config').catch(() => null);
    if (window.AquatechNav && window.AquatechNav.setDisabled && config) window.AquatechNav.setDisabled(config.modules || {});
    buildMenu('modules');
    window.BeheerIndeling.show(window.BeheerIndeling.find('modules'));
  }

  /** Sleutel van de sectie die nu open staat (om opnieuw klikken op dezelfde sectie te herkennen). */
  let activePane = '';
  /**
   * Toont een sectie van Beheer en laadt wat erop staat. Een sectie waar de gebruiker geen toegang toe heeft (Back-ups zonder hoofdbeheer) valt terug op Aanvragen.
   * @param {string} name sleutel van de sectie (zie indeling.js; oude adressen als `settings` werken ook)
   * @param {boolean} [push] true = een nieuwe stap in de browsergeschiedenis (menukeuze), anders de huidige vervangen (starten, terugknop).
   */
  function showTab(name, push = false) {
    const wanted = window.BeheerIndeling.find(window.BeheerIndeling.resolve(name));
    if (!wanted) return;
    const section = (wanted.needs === 'backups' && !state.backups) || (wanted.needs === 'updates' && !state.updates) || state.hiddenSections.has(wanted.id) ? window.BeheerIndeling.find('history') : wanted;
    // Weggaan bij Webshop-inhoud met niet-opgeslagen menuwijzigingen: eerst vragen, bij annuleren blijft de sectie staan.
    if (activePane === 'shopinhoud' && section.pane !== 'shopinhoud' && window.BeheerWebshopMenu && window.BeheerWebshopMenu.hasChanges()
      && !confirm('Er zijn niet-opgeslagen wijzigingen in het menu. Toch weggaan? Die gaan dan verloren.')) return;
    window.BeheerIndeling.show(section);
    if (section.pane === 'plans') loadPlans();
    if (section.pane === 'users') loadUsers();
    if (section.pane === 'roles') window.BeheerRollen.load();
    if (section.pane === 'settings') loadSettings(section.id);
    if (section.pane === 'webshop') { loadSettings(section.id); window.BeheerWebshop.load(); }
    // Opnieuw klikken op de al geopende sectie laadt niets opnieuw, zodat niet-opgeslagen menuwijzigingen blijven staan.
    if (section.pane === 'shopinhoud' && activePane !== 'shopinhoud') window.BeheerWebshopInhoud.load();
    if (section.pane === 'modules') window.BeheerModules.load();
    if (section.pane === 'shopkortingen') window.BeheerKortingen.load();
    if (section.pane === 'shopleveren') window.BeheerLevermethodes.load();
    if (section.pane === 'sproeiers') window.BeheerSproeiers.load();
    if (section.pane === 'archief') window.BeheerArchief.load();
    if (section.pane === 'aikosten') window.BeheerAiKosten.load();
    if (section.pane === 'kleuren') window.BeheerKleuren.load();
    if (section.pane === 'documentopmaak') window.BeheerDocumentopmaak.load();
    if (section.pane === 'mailopmaak') window.BeheerMailopmaak.load();
    if (section.pane === 'updates') window.BeheerUpdates.load(); else window.BeheerUpdates.stop();
    if (section.pane === 'hersteltest') window.BeheerHersteltest.load(); else window.BeheerHersteltest.stop();
    if (section.pane === 'hersteltest-drive') window.BeheerHersteltestDrive.load(); else window.BeheerHersteltestDrive.stop();
    if (section.pane === 'logboek') window.BeheerLogboek.load();
    if (section.pane === 'bewaking') window.BeheerBewaking.load(); else window.BeheerBewaking.stop();
    if (section.pane === 'audit') loadAudit();
    activePane = section.pane;
    if (location.hash === `#${section.id}`) return;
    try { window.history[push ? 'pushState' : 'replaceState'](null, '', `#${section.id}`); } catch (error) { /* file:// */ }
  }

  /**
   * Start Beheer: rechten controleren, knoppen koppelen en de eerste gegevens laden.
   * @returns {Promise<void>}
   */
  async function init() {
    // Oude adressen: de bestellingen en retouren staan onder Verkoop > Webshopbestellingen.
    if (/^#(bestellingen|retouren)$/.test(location.hash)) { location.replace(`../webshop-bestellingen/${location.hash}`); return; }
    const me = await window.AquatechAccount.load('../');
    state.meId = me.user ? me.user.id : null;
    if (!me.user || !(me.rights || []).includes('beheer')) {
      const deniedBox = $('#denied');
      deniedBox.innerHTML = me.user && me.user.kind !== 'gast'
        ? '<b>Geen toegang.</b> Deze pagina is alleen voor beheerders. <a href="../">Terug naar het overzicht</a>.'
        : '<b>Log in als beheerder</b> om de historie te bekijken: met een beheerdersaccount of de toegangscode. <a href="../login">Inloggen</a>.';
      deniedBox.hidden = false;
      return;
    }
    $('#app').hidden = false;
    // Back-ups bevatten de hele database (alle tenants): alleen voor hoofdbeheerders.
    state.backups = Boolean(me.platformAdmin || (me.via === 'code' && me.tenant && me.tenant.slug === 'default'));
    state.updates = Boolean(me.systemUpdate);
    $('#s-backup').hidden = !state.backups;
    // Gebruikersnamen zijn uniek per organisatie; inloggen gaat met de organisatiecode.
    const link = `../login${me.loginCode ? `?org=${encodeURIComponent(me.loginCode)}` : ''}`;
    $('#u-login').innerHTML = me.loginCode
      ? `Gebruikersnamen zijn uniek binnen deze organisatie. Gebruikers loggen in met organisatiecode <b>${esc(me.loginCode)}</b> (of via <a href="${esc(link)}">deze inloglink</a>, die de code al invult).`
      : 'Gebruikersnamen zijn uniek binnen deze organisatie. Gebruikers loggen in met een lege organisatiecode.';
    await loadModuleFlags();
    buildMenu(window.BeheerIndeling.resolve(location.hash.slice(1)) || 'history');
    let searchTimer;
    /** Zoekt kort na het typen opnieuw in de historie. */
    $('#h-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.offset = 0; loadHistory(); }, 250); };
    /** Filtert de historie opnieuw vanaf de eerste pagina. */
    $('#h-user').onchange = $('#h-action').onchange = () => { state.offset = 0; loadHistory(); };
    /** Vorige pagina van de historie. */
    $('#h-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); loadHistory(); };
    /** Volgende pagina van de historie. */
    $('#h-next').onclick = () => { state.offset += PAGE; loadHistory(); };
    $('#h-export').onclick = exportHistory;
    /** Vorige pagina van het auditlog. */
    $('#a-prev').onclick = () => { state.auditOffset = Math.max(0, state.auditOffset - PAGE); loadAudit(); };
    /** Volgende pagina van het auditlog. */
    $('#a-next').onclick = () => { state.auditOffset += PAGE; loadAudit(); };
    $('#u-form').onsubmit = addUser;
    $('#u-view').onsubmit = startCustomerView;
    $('#u-guests').onchange = renderUsers;
    initSettings();
    window.BeheerMail.init({ toast });
    window.BeheerWebshop.init({ toast });
    window.BeheerWebshopInhoud.init({ toast });
    window.BeheerKortingen.init({ toast });
    window.BeheerArchief.init({ toast });
    window.BeheerModules.init({ toast, onSaved: refreshMenu });
    window.BeheerLevermethodes.init({ toast });
    window.BeheerSproeiers.init({ toast });
    window.BeheerRollen.init({ toast, onChange: setRoles });
    window.BeheerAiKosten.init({ toast });
    window.BeheerKleuren.init({ toast });
    window.BeheerDocumentopmaak.init({ toast });
    window.BeheerMailopmaak.init({ toast });
    /** Sluit het detailvenster. */
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    /**
     * Sluit het detailvenster bij een klik naast het venster.
     * @param {MouseEvent} event de klik
     */
    $('#detail').onclick = (event) => { if (event.target.id === 'detail') $('#detail').hidden = true; };
    await loadUsers().catch(() => {});
    loadHistory();
    // Direct naar een sectie via beheer/#mail; zonder adres beginnen we bij de aanvragen.
    const start = window.BeheerIndeling.resolve(location.hash.slice(1)) || 'history';
    showTab(start);
    /** Een ander adres (terugknop, bladwijzer, link vanuit een andere pagina) opent de bijbehorende sectie. */
    window.addEventListener('hashchange', () => { showTab(location.hash.slice(1)); });
  }

  init();
})();
