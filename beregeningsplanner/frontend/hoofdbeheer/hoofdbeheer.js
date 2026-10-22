// Hoofdbeheer: alle tenants van het platform en hun testomgevingen. Alleen
// voor hoofdbeheerders; de server controleert dat zelf (/api/platform/*).
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
   * Formatteert een tijdstip als datum met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} leesbare datum en tijd, of '–'
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const state = { items: [], mainId: null, current: null };
  const Roles = window.AquatechRoles;
  // Rollen van de getoonde tenant (zijn eigen rollen, zie Beheer > Rollen).
  let tenantRoles = Object.entries(Roles.ROLES).map(([key, role]) => ({ key, ...role }));
  /**
   * Geeft de naam van een rol (eigen rollen van de tenant eerst).
   * @param {string} key sleutel van de rol
   * @returns {string} de naam van de rol
   */
  const roleLabel = (key) => { const role = tenantRoles.find((candidate) => candidate.key === key); return role ? role.label : Roles.label(key); };
  /**
   * Maakt de keuzelijst met rollen van de getoonde tenant.
   * @param {string} current de gekozen rol (staat er altijd in, ook als die onbekend is)
   * @returns {string} HTML met option-elementen
   */
  const roleOptions = (current) => tenantRoles.concat(tenantRoles.some((role) => role.key === current) ? [] : [{ key: current, label: current }])
    .map((role) => `<option value="${esc(role.key)}"${role.key === current ? ' selected' : ''}>${esc(role.label)}</option>`).join('');

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
   * Roept de API aan en geeft de JSON terug (met inhoud standaard POST).
   * @param {string} path pad na '../api/'
   * @param {{method: string, body: object}} options methode en inhoud
   * @returns {Promise<object>} het antwoord; gooit een fout met status bij een foutstatus
   */
  async function api(path, options = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store',
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
    return body;
  }

  /**
   * Maakt een organisatiecode van vrije tekst: kleine letters, cijfers en streepjes.
   * @param {string} text de tekst (bijv. de naam van de organisatie)
   * @returns {string} de code (maximaal 40 tekens)
   */
  const slugify = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  /**
   * Gebruikersnaam uit vrije tekst: kleine letters, zonder accenten, spaties
   * worden een punt ("Piet Groen" -> "piet.groen").
   * @param {string} text de tekst
   * @returns {string} de gebruikersnaam (maximaal 40 tekens)
   */
  const userify = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 40);

  // Invoerregels met een uitleg in gewone taal, in plaats van de algemene
  // browsermelding bij een pattern ("Gebruik de gevraagde notatie").
  const RULES = {
    /**
     * Controleert een organisatiecode.
     * @param {string} value de invoer
     * @returns {string} de uitleg bij een fout, of ''
     */
    slug: (value) => (/^[a-z0-9][a-z0-9-]{1,39}$/.test(value) ? '' : 'Organisatiecode: 2–40 tekens, alleen kleine letters, cijfers en streepjes (bijv. groen-beregening).'),
    /**
     * Controleert een gebruikersnaam.
     * @param {string} value de invoer
     * @returns {string} de uitleg bij een fout, of ''
     */
    username: (value) => (/^[a-z0-9][a-z0-9._-]{2,39}$/.test(value) ? '' : 'Gebruikersnaam: 3–40 tekens, alleen kleine letters, cijfers, punt, streepje of underscore, zonder spaties (bijv. piet.groen).'),
    /**
     * Controleert de lengte van een wachtwoord.
     * @param {string} value de invoer
     * @returns {string} de uitleg bij een fout, of ''
     */
    password: (value) => (value.length >= 12 ? '' : 'Wachtwoord: minimaal 12 tekens.'),
  };

  /**
   * Controleert de velden met een regel (data-rule); lege optionele velden
   * slaat hij over en markeert foute velden.
   * @param {HTMLFormElement} formElement het formulier
   * @param {{optional: string[]}} settings namen van velden die leeg mogen blijven
   * @returns {string} de eerste fout, of ''
   */
  function checkForm(formElement, { optional = [] } = {}) {
    let first = '';
    for (const field of formElement.querySelectorAll('[data-rule]')) {
      const value = field.value.trim();
      const problem = !value && (optional.includes(field.name) || !field.required) ? '' : RULES[field.dataset.rule](field.type === 'password' ? field.value : value);
      field.classList.toggle('invalid', Boolean(problem));
      if (problem && !first) { first = problem; field.focus(); }
    }
    return first;
  }

  /**
   * Maakt een gebruikersnaamveld netjes en vult het uit de naam zolang het niet zelf is ingevuld.
   * @param {HTMLInputElement} input het veld voor de gebruikersnaam
   * @param {HTMLInputElement} nameInput het veld voor de volledige naam (optioneel)
   * @returns {function(): void} zet het veld terug op "nog niet zelf ingevuld"
   */
  function wireUsername(input, nameInput) {
    let touched = false;
    input.addEventListener('input', () => {
      touched = Boolean(input.value);
      const cleaned = userify(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      input.classList.remove('invalid');
    });
    if (nameInput) nameInput.addEventListener('input', () => { if (!touched) input.value = userify(nameInput.value); input.dispatchEvent(new Event('change')); });
    /** Zet het veld terug op "nog niet zelf ingevuld". */
    return () => { touched = false; };
  }

  // ---------- Overzicht ----------
  /**
   * Geeft alle tenants en hun testomgevingen in één lijst.
   * @returns {object[]} tenants en testomgevingen
   */
  const all = () => state.items.flatMap((tenant) => [tenant, ...tenant.environments]);
  /**
   * Zoekt een tenant of testomgeving op id.
   * @param {string} id id van de tenant
   * @returns {object|undefined} de tenant
   */
  const find = (id) => all().find((tenant) => tenant.id === id);

  /**
   * Maakt een tabelregel voor een tenant of testomgeving, met de knoppen die erbij horen.
   * @param {object} tenant de tenant
   * @param {boolean} isEnvironment true voor een testomgeving
   * @returns {string} HTML van de regel
   */
  function row(tenant, isEnvironment) {
    const pills = [
      isEnvironment ? '<span class="pill test">test</span>' : '<span class="pill live">live</span>',
      tenant.disabled ? '<span class="pill uit">uitgeschakeld</span>' : '',
      tenant.id === state.mainId ? '<span class="pill hoofd">hoofdtenant</span>' : '',
      tenant.id === state.current ? '<span class="pill hier">je werkt hier</span>' : '',
    ].join(' ');
    const actions = [
      `<button class="btn small" data-act="open">Openen</button>`,
      isEnvironment ? '' : `<button class="btn small" data-act="env">Testomgeving</button>`,
      `<button class="btn small" data-act="users">${isEnvironment ? 'Testaccounts' : 'Gebruikers'}</button>`,
      isEnvironment ? `<button class="btn small" data-act="seed">Vullen met testdata</button>` : '',
      `<button class="btn small" data-act="rename">Naam</button>`,
      tenant.id === state.mainId ? '' : `<button class="btn small" data-act="toggle">${tenant.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>`,
      isEnvironment ? `<button class="btn small" data-act="reset">Leegmaken</button>` : '',
      isEnvironment || tenant.id !== state.mainId ? `<button class="btn small danger" data-act="delete">Verwijderen</button>` : '',
    ].join('');
    return `<tr class="${isEnvironment ? 'env' : ''}${tenant.disabled ? ' off' : ''}" data-tid="${esc(tenant.id)}">
      <td class="wrap"><b>${esc(tenant.name)}</b><br><span class="code">${esc(tenant.slug)}</span></td>
      <td>${pills}</td>
      <td class="num">${tenant.userCount}</td>
      <td class="num">${tenant.planCount}</td>
      <td>${esc(when(tenant.lastActivity))}</td>
      <td>${esc(when(tenant.createdAt))}</td>
      <td class="acts">${actions}</td>
    </tr>`;
  }

  /** Tekent de tabel met tenants, gefilterd op de zoekterm. */
  function render() {
    const term = $('#t-search').value.trim().toLowerCase();
    /**
     * Zegt of een tenant bij de zoekterm past (naam of code).
     * @param {object} tenant de tenant
     * @returns {boolean} true als hij past
     */
    const matches = (tenant) => !term || tenant.name.toLowerCase().includes(term) || tenant.slug.includes(term);
    const items = state.items.filter((tenant) => matches(tenant) || tenant.environments.some(matches));
    const table = $('#t-table');
    if (!items.length) {
      table.innerHTML = `<tr><td class="empty">${state.items.length ? 'Geen tenants gevonden.' : 'Nog geen tenants.'}</td></tr>`;
      return;
    }
    table.innerHTML = `<thead><tr><th>Tenant</th><th>Status</th><th class="num">Gebruikers</th><th class="num">Plannen</th>
      <th>Laatste activiteit</th><th>Aangemaakt</th><th>Acties</th></tr></thead>
      <tbody>${items.map((tenant) => row(tenant, false) + tenant.environments.map((environment) => row(environment, true)).join('')).join('')}</tbody>`;
  }

  /**
   * Laadt de tenants en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function load() {
    const data = await api('platform/tenants');
    state.items = data.items || [];
    state.mainId = data.mainTenantId;
    state.current = data.current;
    render();
  }

  // ---------- Acties ----------
  /**
   * Wisselt naar een tenant of testomgeving en opent het dashboard.
   * @param {object} tenant de tenant
   * @returns {Promise<void>}
   */
  async function openIn(tenant) {
    try {
      await api('environment', { body: { tenantId: tenant.id } });
      location.href = '../';
    } catch (error) { toast(error.message, true); }
  }

  /**
   * Voert een knop uit de tabel uit (openen, testomgeving, gebruikers, testdata,
   * naam, in-/uitschakelen, leegmaken, verwijderen) en laadt daarna opnieuw.
   * @param {string} name de actie (data-act)
   * @param {object} tenant de tenant
   * @returns {Promise<void>}
   */
  async function act(name, tenant) {
    try {
      if (name === 'open') return openIn(tenant);
      if (name === 'env') return envDialog(tenant);
      if (name === 'users') return usersDialog(tenant);
      if (name === 'seed') return await seed(tenant);
      if (name === 'rename') {
        const newName = prompt('Nieuwe naam', tenant.name);
        if (newName == null || newName.trim() === tenant.name) return;
        await api(`platform/tenants/${encodeURIComponent(tenant.id)}`, { method: 'PATCH', body: { name: newName.trim() } });
        toast('Naam gewijzigd');
      } else if (name === 'toggle') {
        const action = tenant.disabled ? 'inschakelen' : 'uitschakelen';
        const extra = tenant.disabled ? '' : (tenant.environment === 'live' ? '\n\nGebruikers van deze tenant kunnen dan niet meer inloggen; de gegevens blijven bewaard.' : '\n\nNiemand kan er dan nog in werken; de gegevens blijven bewaard.');
        if (!confirm(`${tenant.name} ${action}?${extra}`)) return;
        await api(`platform/tenants/${encodeURIComponent(tenant.id)}`, { method: 'PATCH', body: { disabled: !tenant.disabled } });
        toast(tenant.disabled ? 'Ingeschakeld' : 'Uitgeschakeld');
      } else if (name === 'reset') {
        if (!confirm(`Testomgeving ${tenant.name} leegmaken?\n\nAlle plannen, offertes, historie en testaccounts in deze testomgeving worden definitief verwijderd. Live blijft ongemoeid.`)) return;
        await api(`platform/tenants/${encodeURIComponent(tenant.id)}/reset`, { body: {} });
        toast('Testomgeving leeggemaakt');
      } else if (name === 'delete' && tenant.environment === 'live') {
        const environmentText = tenant.environments?.length ? ` en ${tenant.environments.length} testomgeving(en)` : '';
        const typed = prompt(`Tenant ${tenant.name} definitief verwijderen?\n\nDe tenant${environmentText} worden met alle gebruikers (${tenant.userCount}), plannen (${tenant.planCount}), offertes, werkorders, historie, instellingen en webshopgegevens gewist. Dit kan niet ongedaan worden gemaakt (oude back-ups bevatten de gegevens nog tot ze verlopen). Wil je alleen de toegang blokkeren, gebruik dan Uitschakelen.\n\nTyp ter bevestiging de tenantcode "${tenant.slug}":`);
        if (typed == null) return;
        if (typed.trim().toLowerCase() !== tenant.slug) { toast('De tenantcode klopt niet; er is niets verwijderd.', true); return; }
        await api(`platform/tenants/${encodeURIComponent(tenant.id)}`, { method: 'DELETE', body: { confirm: typed.trim().toLowerCase() } });
        toast(`Tenant ${tenant.name} verwijderd`);
        // Werkte je zelf in deze tenant, dan is die omgeving er niet meer.
        if ([tenant, ...(tenant.environments || [])].some((candidate) => candidate.id === state.current)) { location.reload(); return; }
      } else if (name === 'delete') {
        if (!confirm(`Testomgeving ${tenant.name} verwijderen?\n\nDe omgeving en alle plannen, historie en instellingen daarin worden definitief verwijderd. Live blijft ongemoeid.`)) return;
        await api(`platform/tenants/${encodeURIComponent(tenant.id)}`, { method: 'DELETE' });
        toast('Testomgeving verwijderd');
      }
      await load();
    } catch (error) { toast(error.message, true); }
  }

  // ---------- Testdata ----------
  /**
   * Vult een testomgeving met testdata, na bevestiging.
   * @param {object} tenant de testomgeving
   * @returns {Promise<void>}
   */
  async function seed(tenant) {
    const question = `${tenant.name} vullen met testdata?\n\nEr komen testaccounts voor elke rol (beheerder, installateurs, klanten), nepklanten met plannen, offertes in alle statussen (met klantlinks, opties en digitaal akkoord), werkorders en een nepwebshop met prijzen. Wat er nu in deze testomgeving staat (plannen, offertes, historie, testaccounts) wordt eerst gewist. Live blijft ongemoeid.`;
    if (!confirm(question)) return;
    toast('Testdata aanmaken…');
    // De klantlinks van de offertes wijzen naar de openbare pagina op dit adres.
    const shareBase = new URL('../openbaar/offerte.html', location.href).href;
    const result = await api(`platform/tenants/${encodeURIComponent(tenant.id)}/testdata`, { body: { shareBase } });
    await load();
    seedResult(tenant, result);
  }

  /**
   * Toont de aangemaakte testaccounts met het (eenmalig zichtbare) wachtwoord.
   * @param {object} tenant de testomgeving
   * @param {object} result antwoord van de testdata-API (accounts, password, counts)
   */
  function seedResult(tenant, result) {
    const rows = result.accounts.map((user) => `<tr><td>${esc(user.displayName)}</td><td class="code">${esc(user.username)}</td><td>${esc(Roles.label(user.role))}</td></tr>`).join('');
    modal(`<h2>Testdata in ${esc(tenant.name)}</h2>
      <p class="muted small">${result.counts.plans} plannen, ${result.counts.quotes} offertes (${result.counts.links || 0} met klantlink), ${result.counts.workOrders || 0} werkorders (${result.counts.appointments || 0} met reactie op de afspraak)${result.counts.products ? ` en ${result.counts.products} webshopproducten` : ''} aangemaakt. Alle testaccounts hebben hetzelfde wachtwoord; dat wordt nergens bewaard en is alleen nu te zien. Opnieuw vullen geeft een nieuw wachtwoord.</p>
      <p>Wachtwoord: <b class="code" id="s-pw">${esc(result.password)}</b> <button class="btn small" id="s-copy">Kopiëren</button></p>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Naam</th><th>Gebruikersnaam</th><th>Rol</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Inloggen met een testaccount (bijvoorbeeld in een privévenster) brengt je direct in deze testomgeving, met de rechten van die rol. Organisatiecode: <b class="code">${esc(tenant.slug)}</b>.</p>
      <div class="row"><button class="btn" id="s-xlsx">Inloggegevens naar Excel</button></div>`);
    /**
     * Kopieert het wachtwoord naar het klembord.
     * @returns {Promise<void>}
     */
    $('#s-copy').onclick = () => navigator.clipboard.writeText(result.password).then(() => toast('Wachtwoord gekopieerd'), () => toast('Kopiëren lukt niet; selecteer het wachtwoord zelf.', true));
    /**
     * Zet de inloggegevens in een Excel-bestand.
     * @returns {Promise<void>}
     */
    $('#s-xlsx').onclick = () => accountsExcel(tenant, result).catch((error) => toast(error.message, true));
  }

  /**
   * Exporteert de testaccounts met wachtwoord naar Excel.
   * @param {object} tenant de testomgeving
   * @param {object} result antwoord van de testdata-API
   * @returns {Promise<void>}
   */
  async function accountsExcel(tenant, result) {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Testaccounts');
    worksheet.columns = [
      { header: 'Naam', key: 'name', width: 32 },
      { header: 'Organisatiecode', key: 'org', width: 26 },
      { header: 'Gebruikersnaam', key: 'username', width: 34 },
      { header: 'Rol', key: 'role', width: 16 },
      { header: 'Wachtwoord', key: 'password', width: 30 },
      { header: 'Testomgeving', key: 'env', width: 26 },
    ];
    worksheet.getRow(1).font = { bold: true };
    for (const user of result.accounts) worksheet.addRow({ name: user.displayName, org: tenant.slug, username: user.username, role: Roles.label(user.role), password: result.password, env: tenant.name });
    await download(workbook, `testaccounts_${tenant.slug}.xlsx`);
  }

  /**
   * Laat de werkmap downloaden.
   * @param {object} workbook ExcelJS-werkmap
   * @param {string} name bestandsnaam
   * @returns {Promise<void>}
   */
  async function download(workbook, name) {
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Opent het venster met de gegeven inhoud.
   * @param {string} html inhoud van het venster
   */
  function modal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  }
  /** Sluit het venster. */
  const closeModal = () => { $('#modal').hidden = true; };

  /**
   * Opent het venster om een testomgeving aan te maken.
   * @param {object} tenant de live-tenant
   */
  function envDialog(tenant) {
    modal(`<h2>Testomgeving voor ${esc(tenant.name)}</h2>
      <p class="muted small">Een testomgeving staat volledig los van live: eigen plannen, historie en instellingen (die worden nu gekopieerd). Gebruikers zijn dezelfde; beheerders van ${esc(tenant.name)} kunnen erin wisselen zonder opnieuw in te loggen.</p>
      <form id="e-form" class="card-form">
        <div class="row">
          <label>Naam<input name="name" maxlength="60" value="Test" required></label>
        </div>
        <label class="chk"><input type="checkbox" name="copyPlans"> Huidige plannen van live kopiëren (${tenant.planCount})</label>
        <div class="row"><button class="btn primary" type="submit">Aanmaken</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    /**
     * Maakt de testomgeving aan.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    $('#e-form').onsubmit = async (event) => {
      event.preventDefault();
      const formElement = event.target;
      try {
        const result = await api(`platform/tenants/${encodeURIComponent(tenant.id)}/environments`, { body: { name: formElement.name.value.trim(), copyPlans: formElement.copyPlans.checked } });
        closeModal();
        toast(`Testomgeving aangemaakt${result.copied ? `, ${result.copied} plannen gekopieerd` : ''}`);
        await load();
      } catch (error) { $('.err', formElement).textContent = error.message; }
    };
  }

  /**
   * Opent het venster met de gebruikers (of testaccounts) van een tenant, om
   * rollen, wachtwoorden, hoofdbeheerders en inloggen-als te beheren.
   * @param {object} tenant de tenant
   * @returns {Promise<void>}
   */
  async function usersDialog(tenant) {
    let users = [];
    try {
      const result = await api(`platform/tenants/${encodeURIComponent(tenant.id)}/users`);
      users = result.items || [];
      if (result.roles) tenantRoles = result.roles;
    } catch (error) { toast(error.message, true); return; }
    /**
     * Zegt of je als deze gebruiker kunt inloggen.
     * @param {object} user de gebruiker
     * @returns {boolean} true voor een actief account dat geen hoofdbeheerder is
     */
    const canImpersonate = (user) => user.kind === 'account' && !user.platformAdmin && !user.disabled;
    // Hoofdbeheerders wonen in de hoofdtenant en loggen in zonder organisatiecode.
    const isMain = tenant.id === state.mainId;
    const admins = users.filter((user) => user.platformAdmin && !user.disabled).length;
    /**
     * Toont tot wanneer de gebruiker supporttoegang voor live heeft gegeven.
     * @param {object} user de gebruiker
     * @returns {string} HTML van de cel
     */
    const support = (user) => (user.platformAdmin || user.kind !== 'account' || tenant.environment === 'test' ? '–' : user.support ? `<span class="pill live" title="Supporttoegang voor live">tot ${esc(when(user.support.expiresAt))}</span>` : '<span class="muted">geen</span>');
    const rows = users.map((user) => `<tr data-uid="${esc(user.id)}" class="${user.disabled ? 'off' : ''}">
        <td>${esc(user.displayName)}<br><span class="code">${esc(user.username)}</span></td>
        <td>${user.kind === 'account' && !user.platformAdmin ? `<select data-f="role">${roleOptions(user.role)}</select>` : esc(roleLabel(user.role))}${user.platformAdmin ? ' <span class="pill hoofd">hoofdbeheerder</span>' : ''}</td>
        <td>${esc(when(user.lastSeenAt))}</td>
        <td>${support(user)}</td>
        <td>${user.kind === 'account' ? `<input type="checkbox" data-f="mustchange"${user.mustChangePassword ? ' checked' : ''} aria-label="Wachtwoord wijzigen bij volgende aanmelding">` : ''}</td>
        <td class="acts">${canImpersonate(user) ? '<button class="btn small" data-f="impersonate">Inloggen als</button>' : ''}${user.kind === 'account' ? `<button class="btn small" data-f="toggle">${user.disabled ? 'Inschakelen' : 'Uitschakelen'}</button><button class="btn small" data-f="password">Wachtwoord</button>` : ''}${isMain && user.kind === 'account' ? `<button class="btn small" data-f="platform">${user.platformAdmin ? 'Hoofdbeheerder intrekken' : 'Hoofdbeheerder maken'}</button>` : ''}${user.kind === 'account' && user.id !== state.meId ? '<button class="btn small danger" data-f="delete">Verwijderen</button>' : ''}</td>
      </tr>`).join('');
    modal(`<h2>${tenant.environment === 'test' ? 'Testaccounts' : 'Gebruikers'} van ${esc(tenant.name)}</h2>
      ${tenant.environment === 'test' ? '<p class="muted small">Accounts die alleen in deze testomgeving bestaan. Ze verdwijnen bij Leegmaken of Verwijderen.</p>' : ''}
      ${isMain ? `<p class="muted small">Dit is de hoofdtenant. Hoofdbeheerders kunnen alle tenants beheren en loggen in met een lege organisatiecode. Er is altijd minstens één actieve hoofdbeheerder (nu ${admins}).</p>` : `<p class="muted small">Deze gebruikers loggen in met organisatiecode <b class="code">${esc(tenant.slug)}</b>.</p>`}
      <div class="tablewrap"><table class="grid" id="mu-table">${users.length ? `<thead><tr><th>Gebruiker</th><th>Rol</th><th>Laatst gezien</th><th>Support (live)</th><th title="De gebruiker moet bij de volgende aanmelding zelf een nieuw wachtwoord kiezen">Nieuw ww. verplicht</th><th></th></tr></thead><tbody>${rows}</tbody>` : '<tr><td class="empty">Nog geen gebruikers.</td></tr>'}</table></div>
      <form id="mu-form" class="card-form" novalidate>
        <h3>Gebruiker toevoegen</h3>
        <div class="row">
          <label>Volledige naam<input name="displayName" maxlength="80" autocomplete="off" placeholder="bijv. Piet Groen"></label>
          <label>Gebruikersnaam<input name="username" required maxlength="40" autocomplete="off" placeholder="piet.groen" data-rule="username"><span class="hint">3–40 tekens: kleine letters, cijfers, punt, streepje of underscore.</span></label>
          <label>Rol<select name="role">${roleOptions('beheerder')}</select></label>
          <label>Wachtwoord<input name="password" type="password" maxlength="128" required placeholder="minimaal 12 tekens" autocomplete="new-password" data-rule="password"><span class="hint">Minimaal 12 tekens.</span></label>
        </div>
        <label class="chk"><input type="checkbox" name="mustChangePassword" checked> Wachtwoord wijzigen na eerste aanmelding</label>
        ${isMain ? '<label class="chk"><input type="checkbox" name="platformAdmin"> Hoofdbeheerder (alle tenants beheren; altijd met de rol beheerder)</label>' : ''}
        <div class="row"><button class="btn primary" type="submit">Toevoegen</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    const base = `platform/tenants/${encodeURIComponent(tenant.id)}/users`;
    /**
     * Wijzigt een gebruiker en opent het venster opnieuw.
     * @param {string} userId id van de gebruiker
     * @param {object} body de wijziging
     * @param {string} message melding na het opslaan
     * @returns {Promise<void>}
     */
    const patch = async (userId, body, message) => {
      try {
        await api(`${base}/${encodeURIComponent(userId)}`, { method: 'PATCH', body });
        toast(message);
        await load();
        usersDialog(find(tenant.id) || tenant);
      } catch (error) { toast(error.message, true); usersDialog(find(tenant.id) || tenant); }
    };
    /**
     * Verwijdert een gebruiker en opent het venster opnieuw.
     * @param {string} userId id van de gebruiker
     * @returns {Promise<void>}
     */
    const remove = async (userId) => {
      try {
        await api(`${base}/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        toast('Gebruiker verwijderd');
        await load();
      } catch (error) { toast(error.message, true); }
      usersDialog(find(tenant.id) || tenant);
    };
    /**
     * Voert een knop in de gebruikerstabel uit.
     * @param {MouseEvent} event de klik
     * @returns {*} niets (stopt na inloggen-als)
     */
    $('#mu-table').onclick = (event) => {
      const button = event.target.closest('button[data-f]');
      const row = event.target.closest('tr[data-uid]');
      if (!button || !row) return;
      const user = users.find((candidate) => candidate.id === row.dataset.uid);
      if (button.dataset.f === 'impersonate') return impersonateDialog(tenant, user);
      if (button.dataset.f === 'toggle') patch(user.id, { disabled: !user.disabled }, user.disabled ? 'Ingeschakeld' : 'Uitgeschakeld');
      if (button.dataset.f === 'platform') {
        const question = user.platformAdmin
          ? `${user.displayName} is dan geen hoofdbeheerder meer en blijft beheerder van ${tenant.name}. Doorgaan?`
          : `${user.displayName} hoofdbeheerder maken?\n\nEen hoofdbeheerder kan alle tenants, gebruikers en testomgevingen beheren en wordt beheerder van ${tenant.name}.`;
        if (confirm(question)) patch(user.id, { platformAdmin: !user.platformAdmin }, user.platformAdmin ? 'Hoofdbeheerder ingetrokken' : 'Hoofdbeheerder gemaakt');
      }
      if (button.dataset.f === 'delete') {
        const question = `${user.displayName} (${user.username}) definitief verwijderen uit ${tenant.name}?\n\nHet account en alle sessies verdwijnen; dit kan niet ongedaan worden gemaakt. Plannen, offertes en werkorders blijven bewaard onder "Verwijderde gebruiker". Wil je de toegang alleen tijdelijk blokkeren, gebruik dan Uitschakelen.`;
        if (confirm(question)) remove(user.id);
      }
      if (button.dataset.f === 'password') {
        const password = prompt(`Nieuw wachtwoord voor ${user.displayName} (minimaal 12 tekens)`);
        if (!password) return;
        const mustChangePassword = confirm(`Moet ${user.displayName} na de eerste aanmelding met dit wachtwoord zelf een nieuw wachtwoord kiezen?\n\nOK = ja (aanbevolen), Annuleren = nee`);
        patch(user.id, { password, mustChangePassword }, 'Wachtwoord gewijzigd');
      }
    };
    /**
     * Slaat een gewijzigde rol of "nieuw wachtwoord verplicht" op.
     * @param {Event} event de wijziging
     */
    $('#mu-table').onchange = (event) => {
      const row = event.target.closest('tr[data-uid]');
      if (row && event.target.dataset.f === 'role') patch(row.dataset.uid, { role: event.target.value }, 'Rol gewijzigd');
      if (row && event.target.dataset.f === 'mustchange') patch(row.dataset.uid, { mustChangePassword: event.target.checked }, event.target.checked ? 'Moet bij de volgende aanmelding een nieuw wachtwoord kiezen' : 'Wachtwoord wijzigen niet meer verplicht');
    };
    const userForm = $('#mu-form');
    wireUsername(userForm.username, userForm.displayName);
    if (userForm.platformAdmin) {
      /**
       * Een hoofdbeheerder is altijd beheerder: de rol ligt dan vast.
       */
      userForm.platformAdmin.onchange = () => { userForm.role.disabled = userForm.platformAdmin.checked; if (userForm.platformAdmin.checked) userForm.role.value = 'beheerder'; };
    }
    /**
     * Voegt een gebruiker toe.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    userForm.onsubmit = async (event) => {
      event.preventDefault();
      const formElement = event.target;
      const problem = checkForm(formElement);
      $('.err', formElement).textContent = problem;
      if (problem) return;
      try {
        const body = { username: formElement.username.value.trim().toLowerCase(), displayName: formElement.displayName.value.trim(), role: formElement.role.value, password: formElement.password.value, mustChangePassword: formElement.mustChangePassword.checked };
        if (formElement.platformAdmin?.checked) body.platformAdmin = true;
        await api(base, { body });
        toast('Gebruiker toegevoegd');
        await load();
        usersDialog(find(tenant.id) || tenant);
      } catch (error) { $('.err', formElement).textContent = error.message; }
    };
  }

  // ---------- Inloggen als een gebruiker (impersonatie) ----------
  /**
   * In een testomgeving zonder goedkeuring; in live alleen als de gebruiker
   * supporttoegang heeft gegeven. Terug kan altijd met de rode balk onderin.
   * @param {object} tenant de tenant
   * @param {object} user de gebruiker
   */
  function impersonateDialog(tenant, user) {
    // Een testaccount bestaat alleen in zijn eigen testomgeving.
    if (tenant.environment === 'test') user = { ...user, support: null };
    const environments = tenant.environment === 'test' ? [tenant] : (find(tenant.id) || tenant).environments || [];
    const options = tenant.environment === 'test' ? `<option value="${esc(tenant.id)}">Test: ${esc(tenant.name)} (zonder goedkeuring)</option>` : [
      ...environments.filter((environment) => !environment.disabled).map((environment) => `<option value="${esc(environment.id)}">Test: ${esc(environment.name)} (zonder goedkeuring)</option>`),
      `<option value="${esc(tenant.id)}"${user.support ? '' : ' disabled'}>Live${user.support ? ` (toestemming tot ${esc(when(user.support.expiresAt))})` : ' (geen toestemming)'}</option>`,
    ].join('');
    const hint = user.support || tenant.environment === 'test'
      ? ''
      : `<p class="muted small">Voor live is toestemming nodig: ${esc(user.displayName)} geeft die zelf op het dashboard bij <b>Support op afstand</b>, voor een beperkte tijd.${environments.length ? '' : ' Deze tenant heeft nog geen testomgeving.'}</p>`;
    modal(`<h2>Inloggen als ${esc(user.displayName)}</h2>
      <p class="muted small">Je werkt dan met de rol en rechten van ${esc(user.displayName)} (${esc(roleLabel(user.role))}). Alles wat je doet komt met jouw naam in het auditlog. Terug naar je eigen account kan altijd met de rode balk onderin.</p>
      ${hint}
      <form id="imp-form" class="card-form">
        <div class="row">
          <label>Omgeving<select name="tenantId">${options}</select></label>
          <label>Reden (optioneel)<input name="reason" maxlength="200" autocomplete="off" placeholder="bijv. vraag over offerte"></label>
        </div>
        <div class="row"><button class="btn primary" type="submit">Inloggen als ${esc(user.displayName)}</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    const formElement = $('#imp-form');
    const select = formElement.tenantId;
    if (select.options[select.selectedIndex]?.disabled) select.selectedIndex = -1;
    /**
     * Logt in als de gebruiker in de gekozen omgeving.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      if (!select.value) { $('.err', formElement).textContent = 'Kies een omgeving.'; return; }
      try {
        await api('platform/impersonate', { body: { userId: user.id, tenantId: select.value, reason: formElement.reason.value.trim() } });
        location.href = '../';
      } catch (error) { $('.err', formElement).textContent = error.message; }
    };
  }

  // ---------- Nieuwe tenant ----------
  /** Koppelt het formulier voor een nieuwe tenant (code uit de naam, eerste beheerder). */
  function wireForm() {
    const formElement = $('#t-form');
    let slugTouched = false;
    const resetUser = wireUsername(formElement.adminUsername, formElement.adminName);
    /** Toont onder het formulier waarmee de beheerder straks inlogt. */
    const updateHint = () => {
      $('#t-login-org').textContent = formElement.slug.value || '…';
      $('#t-login-user').textContent = formElement.adminUsername.value || '…';
    };
    /** Maakt de organisatiecode netjes tijdens het typen. */
    formElement.slug.oninput = () => {
      slugTouched = Boolean(formElement.slug.value);
      const cleaned = slugify(formElement.slug.value.replace(/-$/, '')) + (formElement.slug.value.endsWith('-') ? '-' : '');
      if (cleaned !== formElement.slug.value) formElement.slug.value = cleaned;
      formElement.slug.classList.remove('invalid');
      updateHint();
    };
    /** Vult de code uit de naam zolang die niet zelf is ingevuld. */
    formElement.name.oninput = () => { if (!slugTouched) formElement.slug.value = slugify(formElement.name.value); updateHint(); };
    formElement.adminUsername.addEventListener('input', updateHint);
    formElement.adminUsername.addEventListener('change', updateHint);
    updateHint();
    /**
     * Maakt de tenant aan (met eventueel de eerste beheerder).
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const withAdmin = Boolean(formElement.adminUsername.value.trim() || formElement.adminPassword.value || formElement.adminName.value.trim());
      let problem = formElement.name.value.trim().length < 2 ? 'Vul de naam van de organisatie in (minimaal 2 tekens).' : '';
      // Zonder eerste beheerder mogen die velden leeg blijven; met een van
      // de drie ingevuld zijn gebruikersnaam en wachtwoord verplicht.
      problem = problem || checkForm(formElement, { optional: withAdmin ? [] : ['adminUsername', 'adminPassword'] });
      if (!problem && withAdmin && !formElement.adminUsername.value.trim()) problem = 'Vul de gebruikersnaam van de eerste beheerder in.';
      if (!problem && withAdmin && !formElement.adminPassword.value) problem = 'Vul het wachtwoord van de eerste beheerder in (minimaal 12 tekens).';
      $('#t-err').textContent = problem;
      if (problem) return;
      const body = { name: formElement.name.value.trim(), slug: formElement.slug.value.trim().toLowerCase() };
      if (withAdmin) body.admin = { username: formElement.adminUsername.value.trim().toLowerCase(), displayName: formElement.adminName.value.trim(), password: formElement.adminPassword.value, mustChangePassword: formElement.adminMustChange.checked };
      try {
        const result = await api('platform/tenants', { body });
        formElement.reset();
        slugTouched = false;
        resetUser();
        updateHint();
        toast(`Tenant ${result.tenant.name} aangemaakt${result.admin ? ` met beheerder ${result.admin.username} (organisatiecode ${result.tenant.slug})` : ''}`);
        await load();
      } catch (error) { $('#t-err').textContent = error.message; }
    };
  }

  // ---------- Excel-export ----------
  /**
   * Exporteert alle tenants en testomgevingen naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Tenants');
    worksheet.columns = [
      { header: 'Tenant', key: 'tenant', width: 32 },
      { header: 'Omgeving', key: 'env', width: 22 },
      { header: 'Code', key: 'slug', width: 26 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Gebruikers', key: 'users', width: 12 },
      { header: 'Plannen', key: 'plans', width: 10 },
      { header: 'Laatste activiteit', key: 'last', width: 20 },
      { header: 'Aangemaakt', key: 'created', width: 20 },
    ];
    worksheet.getRow(1).font = { bold: true };
    /**
     * Maakt een Date van een tijdstip.
     * @param {string} iso tijdstip in ISO-formaat
     * @returns {Date|null} de datum, of null
     */
    const asDate = (iso) => (iso ? new Date(iso) : null);
    for (const tenant of state.items) {
      for (const environment of [tenant, ...tenant.environments]) {
        worksheet.addRow({ tenant: tenant.name, env: environment === tenant ? 'Live' : `Test: ${environment.name}`, slug: environment.slug, status: environment.disabled ? 'Uitgeschakeld' : 'Actief',
          users: environment.userCount, plans: environment.planCount, last: asDate(environment.lastActivity), created: asDate(environment.createdAt) });
      }
    }
    worksheet.getColumn('last').numFmt = 'dd-mm-yyyy hh:mm';
    worksheet.getColumn('created').numFmt = 'dd-mm-yyyy hh:mm';
    await download(workbook, `tenants_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ---------- Kleuren ----------
  // Standaardthema voor alle organisaties (hoofdtenant) en optioneel een eigen
  // thema per tenant. De server weigert te lichte kleuren voor witte tekst.
  const Theme = window.AquatechTheme;
  /**
   * Contrast tussen twee kleuren als tekst.
   * @param {string} foreground kleur als #rrggbb
   * @param {string} background kleur als #rrggbb
   * @returns {string} bijv. '4,8'
   */
  const ratio = (foreground, background) => Theme.contrast(foreground, background).toFixed(1).replace('.', ',');

  /**
   * Standaardthema voor alle organisaties (hoofdtenant) en optioneel een eigen
   * thema per tenant. De server weigert te lichte kleuren voor witte tekst.
   * @param {string} startId tenant die eerst gekozen is
   * @returns {Promise<void>}
   */
  async function themeDialog(startId) {
    let data;
    try { data = await api('platform/theme'); } catch (error) { toast(error.message, true); return; }
    const scopes = [{ id: data.mainTenantId, name: 'Alle organisaties (standaard)', theme: data.global }, ...data.tenants];
    /**
     * Geeft het opgeslagen thema van een keuze (leeg = geen eigen thema).
     * @param {string} id id van de tenant
     * @returns {object} de kleuren
     */
    const stored = (id) => (scopes.find((candidate) => candidate.id === id) || scopes[0]).theme || {};
    /**
     * Wat een tenant zonder eigen thema ziet: het standaardthema.
     * @param {string} id id van de tenant
     * @returns {object} de kleuren
     */
    const shown = (id) => (Object.keys(stored(id)).length ? stored(id) : stored(data.mainTenantId));
    let scope = scopes.some((candidate) => candidate.id === startId) ? startId : data.mainTenantId;
    const fields = Object.entries(Theme.FIELDS).map(([key, field]) => `
      <label class="th-field">${esc(field.label)}
        <span class="th-pick"><input type="color" data-color="${key}"><input type="text" data-hex="${key}" maxlength="7" spellcheck="false" autocomplete="off"></span>
        <span class="hint">${esc(field.help)}</span><span class="th-ratio" data-ratio="${key}"></span>
      </label>`).join('');
    modal(`<h2>Kleuren</h2>
      <p class="muted small">Kies de kleuren van de app. Zonder keuze geldt de huisstijl van AquaTech Service. Een organisatie kan een eigen thema krijgen; testomgevingen volgen hun organisatie.</p>
      <form id="th-form" class="card-form" novalidate>
        <div class="row"><label>Voor<select id="th-scope">${scopes.map((scopeEntry) => `<option value="${esc(scopeEntry.id)}">${esc(scopeEntry.name)}${scopeEntry.id !== data.mainTenantId && Object.keys(scopeEntry.theme || {}).length ? ' · eigen thema' : ''}</option>`).join('')}</select></label></div>
        <p class="muted small" id="th-note"></p>
        <div class="row th-fields">${fields}</div>
        <div class="th-preview" id="th-preview" aria-label="Voorbeeld">
          <div class="th-bar"><b>AquaTech</b><span>Dashboard</span></div>
          <div class="th-body">
            <h4>Voorbeeld van een pagina</h4>
            <p class="th-soft">Een licht vlak met <b>donkere actietekst</b>.</p>
            <div class="th-card">Kaart met accentrand</div>
            <span class="th-btn">Opslaan</span> <span class="th-btn dark">Knop bij aanwijzen</span>
          </div>
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Opslaan</button>
          <button class="btn" type="button" id="th-reset"></button>
        </div>
        <div id="th-err" class="err" role="alert"></div>
      </form>`);
    const formElement = $('#th-form');
    /**
     * Leest de kleuren uit het formulier.
     * @returns {object} kleur per veld
     */
    const current = () => {
      const result = {};
      for (const input of formElement.querySelectorAll('[data-hex]')) result[input.dataset.hex] = Theme.hex(input.value) || input.value.trim();
      return result;
    };
    /**
     * Controleert de kleuren, toont het contrast per kleur en werkt het voorbeeld bij.
     * @returns {boolean} true als alle kleuren geldig en leesbaar zijn
     */
    function preview() {
      const colors = current();
      const valid = Object.values(colors).every((value) => Theme.hex(value));
      const problems = valid ? Theme.problems(colors) : [];
      for (const [key, definition] of Object.entries(Theme.FIELDS)) {
        const ratioElement = formElement.querySelector(`[data-ratio="${key}"]`);
        const hexInput = formElement.querySelector(`[data-hex="${key}"]`);
        const ok = Boolean(Theme.hex(colors[key]));
        hexInput.classList.toggle('invalid', !ok);
        if (!ok) { ratioElement.textContent = 'Geef een kleur als #rrggbb.'; ratioElement.className = 'th-ratio bad'; continue; }
        const contrast = Theme.contrast(colors[key], '#ffffff');
        const fail = problems.some((problem) => problem.field === key);
        ratioElement.textContent = definition.min
          ? `Contrast met wit ${ratio(colors[key], '#ffffff')}:1 ${fail ? `– te licht, minimaal ${String(definition.min).replace('.', ',')}:1` : contrast >= 4.5 ? '– goed leesbaar' : '– voldoende voor vette tekst'}`
          : `Contrast met wit ${ratio(colors[key], '#ffffff')}:1 (alleen accent)`;
        ratioElement.className = `th-ratio${fail ? ' bad' : contrast >= 4.5 || !definition.min ? ' ok' : ' warn'}`;
      }
      if (valid) for (const [name, value] of Object.entries(Theme.vars(colors))) $('#th-preview').style.setProperty(name, value);
      $('#th-err').textContent = !valid ? 'Niet alle kleuren zijn geldig.' : problems.length ? problems[0].message : '';
      return valid && !problems.length;
    }
    /** Vult het formulier met het thema van de gekozen tenant. */
    function fill() {
      const colors = Theme.resolve(shown(scope));
      for (const [key, value] of Object.entries(colors)) {
        formElement.querySelector(`[data-color="${key}"]`).value = value;
        formElement.querySelector(`[data-hex="${key}"]`).value = value;
      }
      const isMain = scope === data.mainTenantId;
      const own = Object.keys(stored(scope)).length > 0;
      $('#th-note').textContent = isMain
        ? (own ? 'Eigen standaardthema voor alle organisaties zonder eigen thema.' : 'Nu de huisstijl van AquaTech Service.')
        : (own ? 'Deze organisatie heeft een eigen thema.' : 'Deze organisatie volgt nu het standaardthema; opslaan geeft hem een eigen thema.');
      $('#th-reset').textContent = isMain ? 'Standaardkleuren terugzetten' : 'Eigen thema verwijderen';
      $('#th-reset').disabled = !own;
      preview();
    }
    /**
     * Houdt kleurkiezer en tekstveld gelijk en werkt het voorbeeld bij.
     * @param {InputEvent} event de invoer
     */
    formElement.oninput = (event) => {
      const key = event.target.dataset.color || event.target.dataset.hex;
      if (!key) return;
      if (event.target.dataset.color) formElement.querySelector(`[data-hex="${key}"]`).value = event.target.value;
      else if (Theme.hex(event.target.value)) formElement.querySelector(`[data-color="${key}"]`).value = Theme.hex(event.target.value);
      preview();
    };
    $('#th-scope').value = scope;
    /** Kiest een andere tenant. */
    $('#th-scope').onchange = () => { scope = $('#th-scope').value; fill(); };
    /**
     * Slaat het thema op (null = terug naar standaard).
     * @param {object|null} colors de kleuren
     * @returns {Promise<void>}
     */
    async function save(colors) {
      try {
        const result = await api('platform/theme', { method: 'PUT', body: { tenantId: scope, colors } });
        scopes.find((candidate) => candidate.id === scope).theme = result.theme;
        const option = $('#th-scope').selectedOptions[0];
        const scopeEntry = scopes.find((candidate) => candidate.id === scope);
        if (scope !== data.mainTenantId) option.textContent = `${scopeEntry.name}${Object.keys(result.theme).length ? ' · eigen thema' : ''}`;
        // Deze pagina opnieuw in het actieve thema.
        const link = document.querySelector('link[href*="shared/theme.css"]');
        if (link) link.href = `../shared/theme.css?t=${Date.now()}`;
        fill();
        toast(colors ? 'Kleuren opgeslagen' : 'Standaardkleuren teruggezet');
      } catch (error) { $('#th-err').textContent = error.message; }
    }
    /**
     * Slaat de kleuren op als ze in orde zijn.
     * @param {SubmitEvent} event het verzenden
     */
    formElement.onsubmit = (event) => { event.preventDefault(); if (preview()) save(current()); };
    /**
     * Zet de standaardkleuren terug.
     * @returns {Promise<void>}
     */
    $('#th-reset').onclick = () => save(null);
    fill();
  }

  // ---------- Visma eAccounting: de app-registratie voor het hele platform ----------
  /**
   * Elke organisatie verbindt daarna haar eigen administratie in Facturen → Visma.
   * Het secret gaat alleen heen; de server geeft alleen terug of het is ingevuld.
   * @returns {Promise<void>}
   */
  async function vismaDialog() {
    let data;
    try { data = await api('platform/visma'); } catch (error) { toast(error.message, true); return; }
    const app = data.app;
    modal(`<h2>Visma eAccounting</h2>
      <p class="muted small">De gegevens van de app die bij Visma (Visma Developer Portal) is geregistreerd. Ze gelden voor alle organisaties; elke organisatie verbindt daarna haar eigen administratie via Facturen → Visma.</p>
      <form id="vi-form" class="card-form" novalidate>
        <div class="row">
          <label>Client ID<input name="clientId" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(app.clientId)}"></label>
          <label>Omgeving<select name="environment">
            <option value="sandbox"${app.environment === 'sandbox' ? ' selected' : ''}>Sandbox (testen)</option>
            <option value="production"${app.environment === 'production' ? ' selected' : ''}>Productie</option>
          </select></label>
        </div>
        <label>Client secret<input name="clientSecret" type="password" maxlength="500" autocomplete="new-password"
          placeholder="${data.secretSet ? 'Ingevuld; laat leeg om te behouden' : 'Nog niet ingevuld'}"></label>
        ${data.secretSet ? '<label class="chk"><input type="checkbox" name="clearSecret"> Secret wissen</label>' : ''}
        <label>Redirect URI<input name="redirectUri" maxlength="300" spellcheck="false" value="${esc(app.redirectUri)}"></label>
        <p class="muted small">Registreer precies deze redirect URI bij Visma. Standaard: <span class="code">${esc(data.defaultRedirect)}</span>. Andere adressen moeten met https beginnen en op <span class="code">/api/visma/callback</span> eindigen.</p>
        <div class="row"><button class="btn primary" type="submit">Opslaan</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    const formElement = $('#vi-form');
    /**
     * Slaat de Visma-gegevens op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api('platform/visma', { method: 'PUT', body: {
          clientId: formElement.clientId.value.trim(), environment: formElement.environment.value, redirectUri: formElement.redirectUri.value.trim(),
          clientSecret: formElement.clientSecret.value, clearSecret: Boolean(formElement.clearSecret && formElement.clearSecret.checked),
        } });
        closeModal();
        toast('Visma-gegevens opgeslagen');
      } catch (error) { $('.err', formElement).textContent = error.message; }
    };
  }

  // ---------- Start ----------
  $('#modal-close').onclick = closeModal;
  /**
   * Sluit het venster bij een klik naast het venster.
   * @param {MouseEvent} event de klik
   */
  $('#modal').onclick = (event) => { if (event.target.id === 'modal') closeModal(); };
  $('#t-search').oninput = render;
  $('#t-export').onclick = exportExcel;
  /** Opent de gebruikers van de hoofdtenant. */
  $('#t-admins').onclick = () => { const mainTenant = find(state.mainId); if (mainTenant) usersDialog(mainTenant); };
  /**
   * Opent de kleuren.
   * @returns {Promise<void>}
   */
  $('#t-theme').onclick = () => themeDialog(state.mainId);
  $('#t-visma').onclick = vismaDialog;
  /**
   * Voert een knop uit de tenanttabel uit.
   * @param {MouseEvent} event de klik
   */
  $('#t-table').onclick = (event) => {
    const button = event.target.closest('button[data-act]');
    const row = event.target.closest('tr[data-tid]');
    if (button && row) act(button.dataset.act, find(row.dataset.tid));
  };

  window.AquatechAccount.load('../').then(async (me) => {
    if (!me.user) { location.href = '../login'; return; }
    if (!me.platformAdmin) {
      $('#denied').textContent = 'Hoofdbeheer is alleen voor hoofdbeheerders van het platform.';
      $('#denied').hidden = false;
      return;
    }
    state.meId = me.user.id;
    $('#app').hidden = false;
    wireForm();
    try { await load(); } catch (error) { toast(error.message, true); }
  });
})();
