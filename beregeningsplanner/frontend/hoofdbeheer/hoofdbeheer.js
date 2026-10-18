// Hoofdbeheer: alle tenants van het platform en hun testomgevingen. Alleen
// voor hoofdbeheerders; de server controleert dat zelf (/api/platform/*).
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const state = { items: [], mainId: null, current: null };
  const Roles = window.AquatechRoles;
  const roleOptions = (current) => Object.entries(Roles.ROLES)
    .map(([k, r]) => `<option value="${k}"${k === current ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store',
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
    return body;
  }

  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  // ---------- Overzicht ----------
  const all = () => state.items.flatMap((t) => [t, ...t.environments]);
  const find = (id) => all().find((t) => t.id === id);

  function row(t, env) {
    const pills = [
      env ? '<span class="pill test">test</span>' : '<span class="pill live">live</span>',
      t.disabled ? '<span class="pill uit">uitgeschakeld</span>' : '',
      t.id === state.mainId ? '<span class="pill hoofd">hoofdtenant</span>' : '',
      t.id === state.current ? '<span class="pill hier">je werkt hier</span>' : '',
    ].join(' ');
    const acts = [
      `<button class="btn small" data-act="open">Openen</button>`,
      env ? '' : `<button class="btn small" data-act="env">Testomgeving</button>`,
      env ? '' : `<button class="btn small" data-act="users">Gebruikers</button>`,
      `<button class="btn small" data-act="rename">Naam</button>`,
      t.id === state.mainId ? '' : `<button class="btn small" data-act="toggle">${t.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>`,
      env ? `<button class="btn small" data-act="reset">Leegmaken</button>` : '',
      env ? `<button class="btn small" data-act="delete">Verwijderen</button>` : '',
    ].join('');
    return `<tr class="${env ? 'env' : ''}${t.disabled ? ' off' : ''}" data-tid="${esc(t.id)}">
      <td class="wrap"><b>${esc(t.name)}</b><br><span class="code">${esc(t.slug)}</span></td>
      <td>${pills}</td>
      <td class="num">${env ? '–' : t.userCount}</td>
      <td class="num">${t.planCount}</td>
      <td>${esc(when(t.lastActivity))}</td>
      <td>${esc(when(t.createdAt))}</td>
      <td class="acts">${acts}</td>
    </tr>`;
  }

  function render() {
    const q = $('#t-search').value.trim().toLowerCase();
    const match = (t) => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q);
    const items = state.items.filter((t) => match(t) || t.environments.some(match));
    const tbl = $('#t-table');
    if (!items.length) {
      tbl.innerHTML = `<tr><td class="empty">${state.items.length ? 'Geen tenants gevonden.' : 'Nog geen tenants.'}</td></tr>`;
      return;
    }
    tbl.innerHTML = `<thead><tr><th>Tenant</th><th>Status</th><th class="num">Gebruikers</th><th class="num">Plannen</th>
      <th>Laatste activiteit</th><th>Aangemaakt</th><th>Acties</th></tr></thead>
      <tbody>${items.map((t) => row(t, false) + t.environments.map((e) => row(e, true)).join('')).join('')}</tbody>`;
  }

  async function load() {
    const data = await api('platform/tenants');
    state.items = data.items || [];
    state.mainId = data.mainTenantId;
    state.current = data.current;
    render();
  }

  // ---------- Acties ----------
  async function openIn(t) {
    try {
      await api('environment', { body: { tenantId: t.id } });
      location.href = '../';
    } catch (e) { toast(e.message, true); }
  }

  async function act(name, t) {
    try {
      if (name === 'open') return openIn(t);
      if (name === 'env') return envDialog(t);
      if (name === 'users') return usersDialog(t);
      if (name === 'rename') {
        const v = prompt('Nieuwe naam', t.name);
        if (v == null || v.trim() === t.name) return;
        await api(`platform/tenants/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { name: v.trim() } });
        toast('Naam gewijzigd');
      } else if (name === 'toggle') {
        const what = t.disabled ? 'inschakelen' : 'uitschakelen';
        const extra = t.disabled ? '' : (t.environment === 'live' ? '\n\nGebruikers van deze tenant kunnen dan niet meer inloggen; de gegevens blijven bewaard.' : '\n\nNiemand kan er dan nog in werken; de gegevens blijven bewaard.');
        if (!confirm(`${t.name} ${what}?${extra}`)) return;
        await api(`platform/tenants/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { disabled: !t.disabled } });
        toast(t.disabled ? 'Ingeschakeld' : 'Uitgeschakeld');
      } else if (name === 'reset') {
        if (!confirm(`Testomgeving ${t.name} leegmaken?\n\nAlle plannen en historie in deze testomgeving worden definitief verwijderd. Live blijft ongemoeid.`)) return;
        await api(`platform/tenants/${encodeURIComponent(t.id)}/reset`, { body: {} });
        toast('Testomgeving leeggemaakt');
      } else if (name === 'delete') {
        if (!confirm(`Testomgeving ${t.name} verwijderen?\n\nDe omgeving en alle plannen, historie en instellingen daarin worden definitief verwijderd. Live blijft ongemoeid.`)) return;
        await api(`platform/tenants/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        toast('Testomgeving verwijderd');
      }
      await load();
    } catch (e) { toast(e.message, true); }
  }

  function modal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  }
  const closeModal = () => { $('#modal').hidden = true; };

  function envDialog(t) {
    modal(`<h2>Testomgeving voor ${esc(t.name)}</h2>
      <p class="muted small">Een testomgeving staat volledig los van live: eigen plannen, historie en instellingen (die worden nu gekopieerd). Gebruikers zijn dezelfde; beheerders van ${esc(t.name)} kunnen erin wisselen zonder opnieuw in te loggen.</p>
      <form id="e-form" class="card-form">
        <div class="row">
          <label>Naam<input name="name" maxlength="60" value="Test" required></label>
        </div>
        <label class="chk"><input type="checkbox" name="copyPlans"> Huidige plannen van live kopiëren (${t.planCount})</label>
        <div class="row"><button class="btn primary" type="submit">Aanmaken</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    $('#e-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const out = await api(`platform/tenants/${encodeURIComponent(t.id)}/environments`, { body: { name: f.name.value.trim(), copyPlans: f.copyPlans.checked } });
        closeModal();
        toast(`Testomgeving aangemaakt${out.copied ? `, ${out.copied} plannen gekopieerd` : ''}`);
        await load();
      } catch (e) { $('.err', f).textContent = e.message; }
    };
  }

  async function usersDialog(t) {
    let users = [];
    try { users = (await api(`platform/tenants/${encodeURIComponent(t.id)}/users`)).items || []; } catch (e) { toast(e.message, true); return; }
    const rows = users.map((u) => `<tr data-uid="${esc(u.id)}" class="${u.disabled ? 'off' : ''}">
        <td>${esc(u.displayName)}<br><span class="code">${esc(u.username)}</span></td>
        <td>${u.kind === 'account' ? `<select data-f="role">${roleOptions(u.role)}</select>` : esc(Roles.label(u.role))}${u.platformAdmin ? ' <span class="pill hoofd">hoofdbeheerder</span>' : ''}</td>
        <td>${esc(when(u.lastSeenAt))}</td>
        <td class="acts">${u.kind === 'account' ? `<button class="btn small" data-f="toggle">${u.disabled ? 'Inschakelen' : 'Uitschakelen'}</button><button class="btn small" data-f="password">Wachtwoord</button>` : ''}</td>
      </tr>`).join('');
    modal(`<h2>Gebruikers van ${esc(t.name)}</h2>
      <div class="tablewrap"><table class="grid" id="mu-table">${users.length ? `<thead><tr><th>Gebruiker</th><th>Rol</th><th>Laatst gezien</th><th></th></tr></thead><tbody>${rows}</tbody>` : '<tr><td class="empty">Nog geen gebruikers.</td></tr>'}</table></div>
      <form id="mu-form" class="card-form">
        <h3>Gebruiker toevoegen</h3>
        <div class="row">
          <label>Gebruikersnaam<input name="username" required pattern="[a-z0-9][a-z0-9._\\-]{2,39}" autocomplete="off"></label>
          <label>Naam<input name="displayName" autocomplete="off"></label>
          <label>Rol<select name="role">${roleOptions('beheerder')}</select></label>
          <label>Wachtwoord<input name="password" type="password" minlength="12" maxlength="128" required placeholder="minimaal 12 tekens" autocomplete="new-password"></label>
          <button class="btn primary" type="submit">Toevoegen</button>
        </div>
        <div class="err" role="alert"></div>
      </form>`);
    const base = `platform/tenants/${encodeURIComponent(t.id)}/users`;
    const patch = async (uid, body, msg) => {
      try {
        await api(`${base}/${encodeURIComponent(uid)}`, { method: 'PATCH', body });
        toast(msg);
        await load();
        usersDialog(find(t.id) || t);
      } catch (e) { toast(e.message, true); usersDialog(find(t.id) || t); }
    };
    $('#mu-table').onclick = (ev) => {
      const b = ev.target.closest('button[data-f]');
      const tr = ev.target.closest('tr[data-uid]');
      if (!b || !tr) return;
      const u = users.find((x) => x.id === tr.dataset.uid);
      if (b.dataset.f === 'toggle') patch(u.id, { disabled: !u.disabled }, u.disabled ? 'Ingeschakeld' : 'Uitgeschakeld');
      if (b.dataset.f === 'password') {
        const pw = prompt(`Nieuw wachtwoord voor ${u.displayName} (minimaal 12 tekens)`);
        if (pw) patch(u.id, { password: pw }, 'Wachtwoord gewijzigd');
      }
    };
    $('#mu-table').onchange = (ev) => {
      const tr = ev.target.closest('tr[data-uid]');
      if (tr && ev.target.dataset.f === 'role') patch(tr.dataset.uid, { role: ev.target.value }, 'Rol gewijzigd');
    };
    $('#mu-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        await api(base, { body: { username: f.username.value.trim().toLowerCase(), displayName: f.displayName.value.trim(), role: f.role.value, password: f.password.value } });
        toast('Gebruiker toegevoegd');
        await load();
        usersDialog(find(t.id) || t);
      } catch (e) { $('.err', f).textContent = e.message; }
    };
  }

  // ---------- Nieuwe tenant ----------
  function wireForm() {
    const f = $('#t-form');
    let slugTouched = false;
    f.slug.oninput = () => { slugTouched = true; };
    f.name.oninput = () => { if (!slugTouched) f.slug.value = slugify(f.name.value); };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      $('#t-err').textContent = '';
      const body = { name: f.name.value.trim(), slug: f.slug.value.trim().toLowerCase() };
      if (f.adminUsername.value.trim() || f.adminPassword.value) {
        body.admin = { username: f.adminUsername.value.trim().toLowerCase(), displayName: f.adminName.value.trim(), password: f.adminPassword.value };
      }
      try {
        const out = await api('platform/tenants', { body });
        f.reset();
        slugTouched = false;
        toast(`Tenant ${out.tenant.name} aangemaakt${out.admin ? ` met beheerder ${out.admin.username}` : ''}`);
        await load();
      } catch (e) { $('#t-err').textContent = e.message; }
    };
  }

  // ---------- Excel-export ----------
  async function exportExcel() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tenants');
    ws.columns = [
      { header: 'Tenant', key: 'tenant', width: 32 },
      { header: 'Omgeving', key: 'env', width: 22 },
      { header: 'Code', key: 'slug', width: 26 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Gebruikers', key: 'users', width: 12 },
      { header: 'Plannen', key: 'plans', width: 10 },
      { header: 'Laatste activiteit', key: 'last', width: 20 },
      { header: 'Aangemaakt', key: 'created', width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    const date = (iso) => (iso ? new Date(iso) : null);
    for (const t of state.items) {
      for (const e of [t, ...t.environments]) {
        ws.addRow({ tenant: t.name, env: e === t ? 'Live' : `Test: ${e.name}`, slug: e.slug, status: e.disabled ? 'Uitgeschakeld' : 'Actief',
          users: e === t ? t.userCount : null, plans: e.planCount, last: date(e.lastActivity), created: date(e.createdAt) });
      }
    }
    ws.getColumn('last').numFmt = 'dd-mm-yyyy hh:mm';
    ws.getColumn('created').numFmt = 'dd-mm-yyyy hh:mm';
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `tenants_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Start ----------
  $('#modal-close').onclick = closeModal;
  $('#modal').onclick = (ev) => { if (ev.target.id === 'modal') closeModal(); };
  $('#t-search').oninput = render;
  $('#t-export').onclick = exportExcel;
  $('#t-table').onclick = (ev) => {
    const b = ev.target.closest('button[data-act]');
    const tr = ev.target.closest('tr[data-tid]');
    if (b && tr) act(b.dataset.act, find(tr.dataset.tid));
  };

  window.AquatechAccount.load('../').then(async (me) => {
    if (!me.user) { location.href = '../login'; return; }
    if (!me.platformAdmin) {
      $('#denied').textContent = 'Hoofdbeheer is alleen voor hoofdbeheerders van het platform.';
      $('#denied').hidden = false;
      return;
    }
    $('#app').hidden = false;
    wireForm();
    try { await load(); } catch (e) { toast(e.message, true); }
  });
})();
