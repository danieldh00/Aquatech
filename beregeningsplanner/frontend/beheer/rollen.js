// Beheer > Rollen: rechten per rol aan- en uitzetten, rollen hernoemen en
// eigen rollen toevoegen (API /api/admin/roles, zie backend/src/platform/roles.js).
// Rollen gelden voor de hele organisatie, ook in de testomgevingen.
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
  const Roles = window.AquatechRoles;
  const state = { roles: [], editable: true };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};
  /** Wordt aangeroepen na het laden van de rollen; door init vervangen. */
  let onChange = () => {};

  /**
   * Roept de beheer-API aan.
   * @param {string} path Pad onder api/admin/, bijv. "roles".
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Label bij een rol: vast, standaard (aangepast) of eigen rol.
   * @param {object} role De rol.
   * @returns {string} HTML van het label.
   */
  const badge = (role) => (role.locked ? '<span class="pill">vast</span>' : role.builtin ? `<span class="pill">${role.customized ? 'standaard, aangepast' : 'standaard'}</span>` : '<span class="pill bijgewerkt">eigen rol</span>');
  /**
   * Rechten die in Beheer aan of uit kunnen (beheer en hoofdbeheer niet).
   * @returns {string[]} De sleutels van die rechten.
   */
  const shownRights = () => Roles.RIGHTS.filter((right) => !Roles.RIGHT_INFO[right].locked);

  /** Tekent de tabel met rechten als rijen en rollen als kolommen; een vinkje slaat direct op. */
  function renderMatrix() {
    const roles = state.roles;
    const head = roles.map((role) => `<th class="role-col" title="${esc(role.description)}">${esc(role.label)}<span class="sub">${esc(Roles.KINDS[role.kind] || role.kind)}</span></th>`).join('');
    const rows = shownRights().map((right) => {
      const info = Roles.RIGHT_INFO[right];
      const cells = roles.map((role) => {
        if (!Roles.rightsForKind(role.kind).includes(right)) return '<td class="cell na" title="Niet voor deze soort rol">–</td>';
        const enabled = role.rights.includes(right);
        const disabled = role.locked || !state.editable;
        return `<td class="cell"><input type="checkbox" data-role="${esc(role.key)}" data-right="${esc(right)}"${enabled ? ' checked' : ''}${disabled ? ' disabled' : ''}
          aria-label="${esc(`${info.label} voor ${role.label}`)}"></td>`;
      }).join('');
      return `<tr><td class="wrap"><b>${esc(info.label)}</b><span class="sub">${esc(info.description)}</span></td>${cells}</tr>`;
    }).join('');
    const admin = `<tr class="off"><td class="wrap"><b>${esc(Roles.RIGHT_INFO.beheer.label)}</b><span class="sub">${esc(Roles.RIGHT_INFO.beheer.description)} Alleen de rol beheerder.</span></td>${roles.map((role) => `<td class="cell">${role.rights.includes('beheer') ? '✓' : ''}</td>`).join('')}</tr>`;
    const table = $('#r-matrix');
    table.innerHTML = `<thead><tr><th>Recht</th>${head}</tr></thead><tbody>${rows}${admin}</tbody>`;
    table.querySelectorAll('input[data-right]').forEach((checkbox) => {
      /**
       * Zet het recht aan of uit voor de rol (met wat het nodig heeft of wat ervan afhangt) en laadt opnieuw.
       * @returns {Promise<void>}
       */
      checkbox.onchange = async () => {
        const role = state.roles.find((candidate) => candidate.key === checkbox.dataset.role);
        // Aan: wat het recht nodig heeft gaat mee aan; uit: wat ervan afhangt gaat mee uit.
        const rights = checkbox.checked ? Roles.withNeeds([...role.rights, checkbox.dataset.right]) : Roles.withoutDependents(role.rights, checkbox.dataset.right);
        try {
          await api(`roles/${encodeURIComponent(role.key)}`, { method: 'PATCH', body: { rights } });
          toast(`${Roles.RIGHT_INFO[checkbox.dataset.right].label} ${checkbox.checked ? 'aan' : 'uit'} voor ${role.label}`);
        } catch (error) { toast(error.message, true); }
        load();
      };
    });
  }

  /** Tekent per rol een kaart met naam en omschrijving, terugzetten of verwijderen. */
  function renderList() {
    const box = $('#r-list');
    box.innerHTML = state.roles.map((role) => `
      <form class="card-form role-card" data-key="${esc(role.key)}">
        <div class="role-head"><h3>${esc(role.label)}</h3>${badge(role)}<span class="muted small">${role.userCount} gebruiker${role.userCount === 1 ? '' : 's'} · code <code>${esc(role.key)}</code></span></div>
        <div class="row">
          <label>Naam<input name="label" maxlength="40" required value="${esc(role.label)}"${state.editable ? '' : ' disabled'}></label>
          <label class="grow">Omschrijving<input name="description" maxlength="300" value="${esc(role.description)}"${state.editable ? '' : ' disabled'}></label>
          ${state.editable ? `<button class="btn primary" type="submit">Opslaan</button>
          ${role.builtin && role.customized ? '<button class="btn" type="button" data-reset>Terug naar standaard</button>' : ''}
          ${!role.builtin ? '<button class="btn danger" type="button" data-del>Verwijderen</button>' : ''}` : ''}
        </div>
        <div class="err" role="alert"></div>
      </form>`).join('');
    box.querySelectorAll('form[data-key]').forEach((form) => {
      const role = state.roles.find((candidate) => candidate.key === form.dataset.key);
      /**
       * Slaat naam en omschrijving van de rol op.
       * @param {SubmitEvent} event Het verzenden.
       * @returns {Promise<void>}
       */
      form.onsubmit = async (event) => {
        event.preventDefault();
        $('.err', form).textContent = '';
        try {
          await api(`roles/${encodeURIComponent(role.key)}`, { method: 'PATCH', body: { label: form.label.value, description: form.description.value } });
          toast('Rol opgeslagen');
          load();
        } catch (error) { $('.err', form).textContent = error.message; }
      };
      const reset = $('[data-reset]', form);
      if (reset) {
        /**
         * Zet een standaardrol na bevestiging terug naar de standaardnaam en -rechten.
         * @returns {Promise<void>}
         */
        reset.onclick = async () => {
          if (!confirm(`${role.label} terugzetten naar de standaardnaam en -rechten?`)) return;
          try { await api(`roles/${encodeURIComponent(role.key)}`, { method: 'DELETE' }); toast('Rol teruggezet'); } catch (error) { toast(error.message, true); }
          load();
        };
      }
      const deleteButton = $('[data-del]', form);
      if (deleteButton) {
        /**
         * Verwijdert een eigen rol na bevestiging.
         * @returns {Promise<void>}
         */
        deleteButton.onclick = async () => {
          if (!confirm(`De rol ${role.label} verwijderen?`)) return;
          try { await api(`roles/${encodeURIComponent(role.key)}`, { method: 'DELETE' }); toast('Rol verwijderd'); } catch (error) { $('.err', form).textContent = error.message; return; }
          load();
        };
      }
    });
  }

  /** Vult het formulier voor een nieuwe rol (keuzelijst "overnemen van"). */
  function renderForm() {
    const form = $('#r-form');
    form.hidden = !state.editable;
    const current = form.copyOf.value;
    form.copyOf.innerHTML = '<option value="">Geen (alles uit)</option>' + state.roles.filter((role) => !role.locked)
      .map((role) => `<option value="${esc(role.key)}">${esc(role.label)}</option>`).join('');
    form.copyOf.value = state.roles.some((role) => role.key === current) ? current : '';
    $('#r-readonly').hidden = state.editable;
  }

  /**
   * Laadt de rollen en tekent formulier, tabel en kaarten.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      const out = await api('roles');
      state.roles = out.items;
      state.editable = out.editable !== false;
      renderForm();
      renderMatrix();
      renderList();
      onChange(state.roles);
    } catch (error) {
      $('#r-matrix').innerHTML = `<tr><td class="empty">Kan de rollen niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Voegt een nieuwe rol toe, eventueel met de rechten van een bestaande rol van dezelfde soort.
   * @param {SubmitEvent} event Het verzenden.
   * @returns {Promise<void>}
   */
  async function add(event) {
    event.preventDefault();
    const form = event.target;
    $('#r-err').textContent = '';
    const source = state.roles.find((role) => role.key === form.copyOf.value);
    // Overnemen van een rol van een andere soort kan niet: dan begint de rol leeg.
    const body = { label: form.label.value, description: form.description.value, kind: form.kind.value };
    if (source && source.kind === form.kind.value) body.copyOf = source.key;
    try {
      const role = await api('roles', { method: 'POST', body });
      form.reset();
      toast(`Rol ${role.label} toegevoegd; zet hieronder de rechten aan`);
      load();
    } catch (error) { $('#r-err').textContent = error.message; }
  }

  /**
   * Koppelt het formulier (één keer, door Beheer).
   * @param {object} [options] { toast, onChange }.
   */
  function init(options = {}) {
    toast = options.toast || toast;
    onChange = options.onChange || onChange;
    $('#r-form').onsubmit = add;
  }

  window.BeheerRollen = { init, load };
})();
