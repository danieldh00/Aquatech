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
  const state = { offset: 0, total: 0, users: [], auditOffset: 0, roles: Object.entries(Roles.ROLES).map(([key, role]) => ({ key, ...role })) };
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
    webshop_gesynchroniseerd: 'Webshopproducten opgehaald', sproeierbibliotheek_ingelezen: 'Sproeierbibliotheek ingelezen', sproeierbibliotheek_standaard: 'Sproeierbibliotheek naar standaard', support_toegang_verleend: 'Supporttoegang gegeven', support_toegang_ingetrokken: 'Supporttoegang ingetrokken',
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
    if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
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
    $('#u-roles').innerHTML = roles.map((role) => `<b>${esc(role.label)}</b>: ${esc(role.description || 'geen omschrijving')}`).join(' ')
      + ' Rechten per rol pas je aan onder <a href="#roles" data-goto="roles">Rollen</a>.';
    const rolesLink = $('#u-roles [data-goto]');
    if (rolesLink) {
      /**
       * Opent het tabblad Rollen.
       * @param {MouseEvent} event de klik
       */
      rolesLink.onclick = (event) => { event.preventDefault(); showTab('roles'); };
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
        <td>${user.sessionCount ? `<button class="btn small" data-logout="${esc(user.id)}">Uitloggen</button> ` : ''}${editable ? `<button class="btn small" data-pw="${esc(user.id)}">Wachtwoord</button> <button class="btn small" data-toggle="${esc(user.id)}">${user.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>` : ''}
          ${user.historyCount ? `<button class="btn small" data-hist="${esc(user.id)}">Aanvragen</button>` : ''}
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
      button.onclick = () => { $('#h-user').value = button.dataset.hist; state.offset = 0; showTab('history'); loadHistory(); };
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
    ai.aiDailyLimit.value = view.aiDailyLimit.value;
    ai.aiHourlyPerIp.value = view.aiHourlyPerIp.value;
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
    const securityForm = $('#s-security');
    for (const key of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays']) securityForm[key].value = view[key].value;
    const accessForm = $('#s-access');
    accessForm.guestAccess.checked = view.guestAccess.value;
    accessForm.guestAccess.disabled = code.set;
    accessForm.drawingRequests.checked = view.drawingRequests.value;
    accessForm.storefront.checked = view.storefront.value;
    accessForm.storefront.closest('label').hidden = !state.storefrontAllowed;
    codeState.className = `state ${code.set ? 'ok' : 'off'}`;
    $('[data-clear="anthropicApiKey"]').disabled = !key.set;
    $('[data-clear="accessCode"]').disabled = !code.set;
    renderSeason(view.seasonReminders.value);
    const outsourcingForm = $('#s-outsourcing');
    const outsourcing = view.outsourcing.value;
    outsourcingForm.send.checked = outsourcing.send;
    outsourcingForm.receive.checked = outsourcing.receive;
    outsourcingForm.region.value = outsourcing.region || '';
    const visibleModules = (window.AquatechModules || []).filter((module) => module.id !== 'beheer' && module.id !== 'hoofdbeheer');
    $('#s-module-list').innerHTML = visibleModules.map((module) => `
      <label class="chk"><input type="checkbox" data-module="${esc(module.id)}"${module.status === 'gepland' ? ' disabled' : view.modules.value[module.id] === false ? '' : ' checked'}>
        ${esc(module.title)}${module.status === 'gepland' ? ' <span class="muted small">(binnenkort: aan te zetten zodra de module klaar is)</span>' : ''}</label>`).join('');
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
      const { enabled, items } = await api('backups');
      $('#b-now').disabled = !enabled;
      list.innerHTML = !enabled ? 'Back-ups zijn op deze server niet beschikbaar.'
        : !items.length ? 'Nog geen back-ups.'
          : `<ul class="timeline">${items.map((backup) => `<li><a href="../api/admin/backups/${encodeURIComponent(backup.name)}" download>${esc(backup.name)}</a> · ${esc(when(backup.createdAt))} · ${esc(size(backup.size))}
            <button class="btn small danger" data-backup-del="${esc(backup.name)}">Verwijderen</button></li>`).join('')}</ul>`;
      list.querySelectorAll('[data-backup-del]').forEach((button) => {
        /**
         * Verwijdert deze back-up na bevestiging.
         * @returns {Promise<void>}
         */
        button.onclick = async () => {
          const name = button.dataset.backupDel;
          if (!confirm(`Back-up ${name} verwijderen?\n\nHet bestand wordt definitief gewist van de server.`)) return;
          try { await api(`backups/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast('Back-up verwijderd'); } catch (error) { toast(error.message, true); }
          loadBackups();
        };
      });
    } catch (error) {
      list.textContent = `Kan de back-ups niet laden (${error.message}).`;
    }
  }

  /**
   * Laadt de instellingen, de e-mail en (voor hoofdbeheerders) de back-ups.
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    if (state.backups) loadBackups();
    loadMail();
    try {
      const result = await api('settings');
      state.aiFromLive = Boolean(result.aiFromLive);
      state.storefrontAllowed = Boolean(result.storefrontAllowed);
      renderSettings(result.settings);
    } catch (error) {
      toast(`Kan de instellingen niet laden: ${error.message}`, true);
    }
  }

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
      form.querySelectorAll('input[type=password]').forEach((input) => { input.value = ''; });
      toast(result.changed.length ? message : 'Niets gewijzigd');
      return true;
    } catch (error) {
      errorBox.textContent = error.message;
      return false;
    }
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
      const patch = { aiEnabled: aiForm.aiEnabled.checked, aiDailyLimit: Number(aiForm.aiDailyLimit.value), aiHourlyPerIp: Number(aiForm.aiHourlyPerIp.value),
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
    /** Zet de eigen webshop (winkel/) aan of uit. */
    accessForm.storefront.onchange = () => {
      saveSettings(accessForm, { storefront: accessForm.storefront.checked }, accessForm.storefront.checked ? 'Webshop staat aan' : 'Webshop staat uit');
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
      for (const key of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays']) patch[key] = Number(securityForm[key].value);
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
    const outsourcingForm = $('#s-outsourcing');
    /**
     * Slaat de instellingen voor uitbesteden op.
     * @param {SubmitEvent} event het verzenden
     */
    outsourcingForm.onsubmit = (event) => {
      event.preventDefault();
      saveSettings(outsourcingForm, { outsourcing: { send: outsourcingForm.send.checked, receive: outsourcingForm.receive.checked, region: outsourcingForm.region.value.trim() } }, 'Uitbesteden opgeslagen');
    };
    const modulesForm = $('#s-modules');
    /**
     * Slaat op welke modules aan staan.
     * @param {SubmitEvent} event het verzenden
     */
    modulesForm.onsubmit = (event) => {
      event.preventDefault();
      const modules = {};
      modulesForm.querySelectorAll('[data-module]:not(:disabled)').forEach((checkbox) => { modules[checkbox.dataset.module] = checkbox.checked; });
      saveSettings(modulesForm, { modules }, 'Modules opgeslagen');
    };
  }

  // ---------- E-mail (SMTP of Exchange-connector) ----------
  /**
   * Laadt de e-mailinstellingen in het formulier.
   * @returns {Promise<void>}
   */
  async function loadMail() {
    const formElement = $('#s-mail');
    try {
      const result = await api('mail');
      const config = result.config;
      for (const key of ['host', 'port', 'user', 'from', 'replyTo']) formElement[key].value = config[key] ?? '';
      formElement.mode.value = config.mode || 'smtp';
      formElement.secure.value = String(Boolean(config.secure));
      formElement.password.value = '';
      formElement.password.placeholder = result.passwordSet ? '•••••••• (ingesteld; leeg = ongewijzigd)' : '';
      const ok = Boolean(config.host && config.from);
      $('#m-state').textContent = ok ? 'De mailserver is ingesteld.' : 'Nog geen mailserver ingesteld.';
      $('#m-state').className = `state ${ok ? 'ok' : 'off'}`;
      mailMode();
    } catch (error) {
      $('#m-state').textContent = `Kan de e-mailinstellingen niet laden: ${error.message}`;
    }
  }

  /**
   * Connector: geen inlog, poort 25; het WAN-IP pas ophalen als het nodig is.
   * @param {boolean} changed true als de soort net is gewijzigd (poort en host invullen)
   */
  function mailMode(changed) {
    const formElement = $('#s-mail');
    const connector = formElement.mode.value === 'connector';
    $('[data-connector]', formElement).hidden = !connector;
    $('[data-login]', formElement).hidden = connector;
    if (changed) {
      formElement.port.value = connector ? 25 : 587;
      formElement.secure.value = 'false';
      const domain = (formElement.from.value.match(/@([^>\s]+)/) || [])[1];
      if (connector && !formElement.host.value && domain) formElement.host.value = `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`;
    }
    if (connector && !state.wanIp) loadWanIp(false);
  }

  /**
   * Haalt het WAN-IP van de server op en toont het.
   * @param {boolean} refresh true om niet de bewaarde waarde te gebruiken
   * @returns {Promise<void>}
   */
  async function loadWanIp(refresh) {
    const ipElement = $('#m-wanip');
    const note = $('#m-wanip-note');
    ipElement.textContent = 'Bezig…';
    try {
      state.wanIp = await api(`wan-ip${refresh ? '?refresh=1' : ''}`);
      ipElement.textContent = state.wanIp.ip;
      note.textContent = state.wanIp.source === 'omgeving'
        ? 'Vast ingesteld (WAN_IP in de Docker-omgeving). Dit adres geef je vrij in de connector van Office 365.'
        : `Opgezocht ${when(state.wanIp.checkedAt)}. Dit adres geef je vrij in de connector van Office 365.`;
    } catch (error) {
      state.wanIp = null;
      ipElement.textContent = 'onbekend';
      note.textContent = error.message;
    }
  }

  /**
   * Slaat de e-mailinstellingen op en laadt ze opnieuw.
   * @returns {Promise<void>}
   */
  async function saveMail() {
    const formElement = $('#s-mail');
    const connector = formElement.mode.value === 'connector';
    const body = {
      config: { mode: formElement.mode.value, host: formElement.host.value.trim(), port: Number(formElement.port.value) || (connector ? 25 : 587), secure: formElement.secure.value === 'true', user: connector ? '' : formElement.user.value.trim(), from: formElement.from.value.trim(), replyTo: formElement.replyTo.value.trim() },
    };
    if (!connector && formElement.password.value) body.password = formElement.password.value;
    await api('mail', { method: 'PUT', body });
    await loadMail();
  }

  /** Koppelt het e-mailformulier en de knoppen. */
  function initMail() {
    const formElement = $('#s-mail');
    /** Past het formulier aan de gekozen soort aan. */
    formElement.mode.onchange = () => { mailMode(true); };
    /**
     * Slaat de e-mailinstellingen op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      $('.err', formElement).textContent = '';
      try { await saveMail(); toast('E-mailinstellingen opgeslagen'); } catch (error) { $('.err', formElement).textContent = error.message; }
    };
    /**
     * Slaat op en verstuurt een testmail.
     * @returns {Promise<void>}
     */
    $('#m-test').onclick = async () => {
      const testButton = $('#m-test');
      $('.err', formElement).textContent = '';
      testButton.disabled = true;
      try {
        await saveMail();
        await api('mail/test', { method: 'POST', body: { to: formElement.testTo.value } });
        toast(`Testmail verstuurd naar ${formElement.testTo.value}`);
      } catch (error) {
        $('.err', formElement).textContent = error.message;
      } finally {
        testButton.disabled = false;
      }
    };
    /**
     * Zoekt het WAN-IP opnieuw op.
     * @returns {Promise<void>}
     */
    $('#m-refresh').onclick = () => loadWanIp(true);
    /**
     * Kopieert het WAN-IP naar het klembord.
     * @returns {Promise<void>}
     */
    $('#m-copy').onclick = async () => {
      if (!state.wanIp) return;
      try { await navigator.clipboard.writeText(state.wanIp.ip); toast('WAN-IP gekopieerd'); } catch (error) { toast('Kopiëren lukt niet; selecteer het adres zelf', true); }
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
   * Toont een tabblad en laadt wat erop staat.
   * @param {string} name naam van het tabblad
   */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach((pane) => { pane.hidden = pane.id !== `tab-${name}`; });
    if (name === 'plans') loadPlans();
    if (name === 'users') loadUsers();
    if (name === 'roles') window.BeheerRollen.load();
    if (name === 'settings') loadSettings();
    if (name === 'webshop') window.BeheerWebshop.load();
    if (name === 'sproeiers') window.BeheerSproeiers.load();
    if (name === 'aikosten') window.BeheerAiKosten.load();
    if (name === 'audit') loadAudit();
    try { window.history.replaceState(null, '', `#${name}`); } catch (error) { /* file:// */ }
  }

  /**
   * Start Beheer: rechten controleren, knoppen koppelen en de eerste gegevens laden.
   * @returns {Promise<void>}
   */
  async function init() {
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
    $('#s-backup').hidden = !state.backups;
    // Gebruikersnamen zijn uniek per organisatie; inloggen gaat met de organisatiecode.
    const link = `../login${me.loginCode ? `?org=${encodeURIComponent(me.loginCode)}` : ''}`;
    $('#u-login').innerHTML = me.loginCode
      ? `Gebruikersnamen zijn uniek binnen deze organisatie. Gebruikers loggen in met organisatiecode <b>${esc(me.loginCode)}</b> (of via <a href="${esc(link)}">deze inloglink</a>, die de code al invult).`
      : 'Gebruikersnamen zijn uniek binnen deze organisatie. Gebruikers loggen in met een lege organisatiecode.';
    document.querySelectorAll('.tab').forEach((tab) => {
      /** Toont dit tabblad. */
      tab.onclick = () => { showTab(tab.dataset.tab); };
    });
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
    $('#u-guests').onchange = renderUsers;
    initSettings();
    initMail();
    window.BeheerWebshop.init({ toast });
    window.BeheerSproeiers.init({ toast });
    window.BeheerRollen.init({ toast, onChange: setRoles });
    window.BeheerAiKosten.init({ toast });
    /** Sluit het detailvenster. */
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    /**
     * Sluit het detailvenster bij een klik naast het venster.
     * @param {MouseEvent} event de klik
     */
    $('#detail').onclick = (event) => { if (event.target.id === 'detail') $('#detail').hidden = true; };
    await loadUsers().catch(() => {});
    loadHistory();
    // Direct naar een tabblad via beheer/#settings.
    const hash = location.hash.slice(1);
    if (['plans', 'users', 'roles', 'settings', 'webshop', 'sproeiers', 'aikosten', 'audit'].includes(hash)) showTab(hash);
  }

  init();
})();
