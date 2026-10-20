// Beheer > Rollen: rechten per rol aan- en uitzetten, rollen hernoemen en
// eigen rollen toevoegen (API /api/admin/roles, zie backend/src/roles.js).
// Rollen gelden voor de hele organisatie, ook in de testomgevingen.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const Roles = window.AquatechRoles;
  const state = { roles: [], editable: true };
  let toast = () => {};
  let onChange = () => {};

  async function api(path, opts = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  const badge = (r) => (r.locked ? '<span class="pill">vast</span>' : r.builtin ? `<span class="pill">${r.customized ? 'standaard, aangepast' : 'standaard'}</span>` : '<span class="pill bijgewerkt">eigen rol</span>');
  // Rechten die in Beheer aan of uit kunnen (beheer en hoofdbeheer niet).
  const shownRights = () => Roles.RIGHTS.filter((r) => !Roles.RIGHT_INFO[r].locked);

  // Tabel: rechten als rijen, rollen als kolommen; een vinkje slaat direct op.
  function renderMatrix() {
    const roles = state.roles;
    const head = roles.map((r) => `<th class="role-col" title="${esc(r.description)}">${esc(r.label)}<span class="sub">${esc(Roles.KINDS[r.kind] || r.kind)}</span></th>`).join('');
    const rows = shownRights().map((right) => {
      const info = Roles.RIGHT_INFO[right];
      const cells = roles.map((r) => {
        if (!Roles.rightsForKind(r.kind).includes(right)) return '<td class="cell na" title="Niet voor deze soort rol">–</td>';
        const on = r.rights.includes(right);
        const dis = r.locked || !state.editable;
        return `<td class="cell"><input type="checkbox" data-role="${esc(r.key)}" data-right="${esc(right)}"${on ? ' checked' : ''}${dis ? ' disabled' : ''}
          aria-label="${esc(`${info.label} voor ${r.label}`)}"></td>`;
      }).join('');
      return `<tr><td class="wrap"><b>${esc(info.label)}</b><span class="sub">${esc(info.description)}</span></td>${cells}</tr>`;
    }).join('');
    const admin = `<tr class="off"><td class="wrap"><b>${esc(Roles.RIGHT_INFO.beheer.label)}</b><span class="sub">${esc(Roles.RIGHT_INFO.beheer.description)} Alleen de rol beheerder.</span></td>${roles.map((r) => `<td class="cell">${r.rights.includes('beheer') ? '✓' : ''}</td>`).join('')}</tr>`;
    const tbl = $('#r-matrix');
    tbl.innerHTML = `<thead><tr><th>Recht</th>${head}</tr></thead><tbody>${rows}${admin}</tbody>`;
    tbl.querySelectorAll('input[data-right]').forEach((c) => {
      c.onchange = async () => {
        const r = state.roles.find((x) => x.key === c.dataset.role);
        // Aan: wat het recht nodig heeft gaat mee aan; uit: wat ervan afhangt gaat mee uit.
        const rights = c.checked ? Roles.withNeeds([...r.rights, c.dataset.right]) : Roles.withoutDependents(r.rights, c.dataset.right);
        try {
          await api(`roles/${encodeURIComponent(r.key)}`, { method: 'PATCH', body: { rights } });
          toast(`${Roles.RIGHT_INFO[c.dataset.right].label} ${c.checked ? 'aan' : 'uit'} voor ${r.label}`);
        } catch (e) { toast(e.message, true); }
        load();
      };
    });
  }

  // Per rol: naam en omschrijving, terugzetten of verwijderen.
  function renderList() {
    const box = $('#r-list');
    box.innerHTML = state.roles.map((r) => `
      <form class="card-form role-card" data-key="${esc(r.key)}">
        <div class="role-head"><h3>${esc(r.label)}</h3>${badge(r)}<span class="muted small">${r.userCount} gebruiker${r.userCount === 1 ? '' : 's'} · code <code>${esc(r.key)}</code></span></div>
        <div class="row">
          <label>Naam<input name="label" maxlength="40" required value="${esc(r.label)}"${state.editable ? '' : ' disabled'}></label>
          <label class="grow">Omschrijving<input name="description" maxlength="300" value="${esc(r.description)}"${state.editable ? '' : ' disabled'}></label>
          ${state.editable ? `<button class="btn primary" type="submit">Opslaan</button>
          ${r.builtin && r.customized ? '<button class="btn" type="button" data-reset>Terug naar standaard</button>' : ''}
          ${!r.builtin ? '<button class="btn danger" type="button" data-del>Verwijderen</button>' : ''}` : ''}
        </div>
        <div class="err" role="alert"></div>
      </form>`).join('');
    box.querySelectorAll('form[data-key]').forEach((f) => {
      const r = state.roles.find((x) => x.key === f.dataset.key);
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        $('.err', f).textContent = '';
        try {
          await api(`roles/${encodeURIComponent(r.key)}`, { method: 'PATCH', body: { label: f.label.value, description: f.description.value } });
          toast('Rol opgeslagen');
          load();
        } catch (e) { $('.err', f).textContent = e.message; }
      };
      const reset = $('[data-reset]', f);
      if (reset) {
        reset.onclick = async () => {
          if (!confirm(`${r.label} terugzetten naar de standaardnaam en -rechten?`)) return;
          try { await api(`roles/${encodeURIComponent(r.key)}`, { method: 'DELETE' }); toast('Rol teruggezet'); } catch (e) { toast(e.message, true); }
          load();
        };
      }
      const del = $('[data-del]', f);
      if (del) {
        del.onclick = async () => {
          if (!confirm(`De rol ${r.label} verwijderen?`)) return;
          try { await api(`roles/${encodeURIComponent(r.key)}`, { method: 'DELETE' }); toast('Rol verwijderd'); } catch (e) { $('.err', f).textContent = e.message; return; }
          load();
        };
      }
    });
  }

  function renderForm() {
    const f = $('#r-form');
    f.hidden = !state.editable;
    const cur = f.copyOf.value;
    f.copyOf.innerHTML = '<option value="">Geen (alles uit)</option>' + state.roles.filter((r) => !r.locked)
      .map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
    f.copyOf.value = state.roles.some((r) => r.key === cur) ? cur : '';
    $('#r-readonly').hidden = state.editable;
  }

  async function load() {
    try {
      const out = await api('roles');
      state.roles = out.items;
      state.editable = out.editable !== false;
      renderForm();
      renderMatrix();
      renderList();
      onChange(state.roles);
    } catch (e) {
      $('#r-matrix').innerHTML = `<tr><td class="empty">Kan de rollen niet laden (${esc(e.message)}).</td></tr>`;
    }
  }

  async function add(ev) {
    ev.preventDefault();
    const f = ev.target;
    $('#r-err').textContent = '';
    const from = state.roles.find((r) => r.key === f.copyOf.value);
    // Overnemen van een rol van een andere soort kan niet: dan begint de rol leeg.
    const body = { label: f.label.value, description: f.description.value, kind: f.kind.value };
    if (from && from.kind === f.kind.value) body.copyOf = from.key;
    try {
      const role = await api('roles', { method: 'POST', body });
      f.reset();
      toast(`Rol ${role.label} toegevoegd; zet hieronder de rechten aan`);
      load();
    } catch (e) { $('#r-err').textContent = e.message; }
  }

  function init(opts = {}) {
    toast = opts.toast || toast;
    onChange = opts.onChange || onChange;
    $('#r-form').onsubmit = add;
  }

  window.BeheerRollen = { init, load };
})();
