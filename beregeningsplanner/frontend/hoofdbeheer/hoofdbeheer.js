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

  // Gebruikersnaam uit vrije tekst: kleine letters, zonder accenten, spaties
  // worden een punt ("Piet Groen" -> "piet.groen").
  const userify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 40);

  // Invoerregels met een uitleg in gewone taal, in plaats van de algemene
  // browsermelding bij een pattern ("Gebruik de gevraagde notatie").
  const RULES = {
    slug: (v) => (/^[a-z0-9][a-z0-9-]{1,39}$/.test(v) ? '' : 'Organisatiecode: 2–40 tekens, alleen kleine letters, cijfers en streepjes (bijv. groen-beregening).'),
    username: (v) => (/^[a-z0-9][a-z0-9._-]{2,39}$/.test(v) ? '' : 'Gebruikersnaam: 3–40 tekens, alleen kleine letters, cijfers, punt, streepje of underscore, zonder spaties (bijv. piet.groen).'),
    password: (v) => (v.length >= 12 ? '' : 'Wachtwoord: minimaal 12 tekens.'),
  };

  // Controleert de velden met een regel (data-rule); lege optionele velden
  // slaat hij over. Geeft de eerste fout of ''.
  function checkForm(f, { optional = [] } = {}) {
    let first = '';
    for (const el of f.querySelectorAll('[data-rule]')) {
      const v = el.value.trim();
      const msg = !v && (optional.includes(el.name) || !el.required) ? '' : RULES[el.dataset.rule](el.type === 'password' ? el.value : v);
      el.classList.toggle('invalid', Boolean(msg));
      if (msg && !first) { first = msg; el.focus(); }
    }
    return first;
  }

  function wireUsername(input, nameInput) {
    let touched = false;
    input.addEventListener('input', () => {
      touched = Boolean(input.value);
      const v = userify(input.value);
      if (v !== input.value) input.value = v;
      input.classList.remove('invalid');
    });
    if (nameInput) nameInput.addEventListener('input', () => { if (!touched) input.value = userify(nameInput.value); input.dispatchEvent(new Event('change')); });
    return () => { touched = false; };
  }

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
      `<button class="btn small" data-act="users">${env ? 'Testaccounts' : 'Gebruikers'}</button>`,
      env ? `<button class="btn small" data-act="seed">Vullen met testdata</button>` : '',
      `<button class="btn small" data-act="rename">Naam</button>`,
      t.id === state.mainId ? '' : `<button class="btn small" data-act="toggle">${t.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>`,
      env ? `<button class="btn small" data-act="reset">Leegmaken</button>` : '',
      env ? `<button class="btn small" data-act="delete">Verwijderen</button>` : '',
    ].join('');
    return `<tr class="${env ? 'env' : ''}${t.disabled ? ' off' : ''}" data-tid="${esc(t.id)}">
      <td class="wrap"><b>${esc(t.name)}</b><br><span class="code">${esc(t.slug)}</span></td>
      <td>${pills}</td>
      <td class="num">${t.userCount}</td>
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
      if (name === 'seed') return await seed(t);
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
        if (!confirm(`Testomgeving ${t.name} leegmaken?\n\nAlle plannen, offertes, historie en testaccounts in deze testomgeving worden definitief verwijderd. Live blijft ongemoeid.`)) return;
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

  // ---------- Testdata ----------
  async function seed(t) {
    const msg = `${t.name} vullen met testdata?\n\nEr komen testaccounts voor elke rol (beheerder, installateurs, klanten), nepklanten met plannen en offertes in alle statussen. Wat er nu in deze testomgeving staat (plannen, offertes, historie, testaccounts) wordt eerst gewist. Live blijft ongemoeid.`;
    if (!confirm(msg)) return;
    toast('Testdata aanmaken…');
    const out = await api(`platform/tenants/${encodeURIComponent(t.id)}/testdata`, { body: {} });
    await load();
    seedResult(t, out);
  }

  function seedResult(t, out) {
    const rows = out.accounts.map((u) => `<tr><td>${esc(u.displayName)}</td><td class="code">${esc(u.username)}</td><td>${esc(Roles.label(u.role))}</td></tr>`).join('');
    modal(`<h2>Testdata in ${esc(t.name)}</h2>
      <p class="muted small">${out.counts.plans} plannen en ${out.counts.quotes} offertes aangemaakt. Alle testaccounts hebben hetzelfde wachtwoord; dat wordt nergens bewaard en is alleen nu te zien. Opnieuw vullen geeft een nieuw wachtwoord.</p>
      <p>Wachtwoord: <b class="code" id="s-pw">${esc(out.password)}</b> <button class="btn small" id="s-copy">Kopiëren</button></p>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Naam</th><th>Gebruikersnaam</th><th>Rol</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Inloggen met een testaccount (bijvoorbeeld in een privévenster) brengt je direct in deze testomgeving, met de rechten van die rol. Organisatiecode: <b class="code">${esc(t.slug)}</b>.</p>
      <div class="row"><button class="btn" id="s-xlsx">Inloggegevens naar Excel</button></div>`);
    $('#s-copy').onclick = () => navigator.clipboard.writeText(out.password).then(() => toast('Wachtwoord gekopieerd'), () => toast('Kopiëren lukt niet; selecteer het wachtwoord zelf.', true));
    $('#s-xlsx').onclick = () => accountsExcel(t, out).catch((e) => toast(e.message, true));
  }

  async function accountsExcel(t, out) {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Testaccounts');
    ws.columns = [
      { header: 'Naam', key: 'name', width: 32 },
      { header: 'Organisatiecode', key: 'org', width: 26 },
      { header: 'Gebruikersnaam', key: 'username', width: 34 },
      { header: 'Rol', key: 'role', width: 16 },
      { header: 'Wachtwoord', key: 'password', width: 30 },
      { header: 'Testomgeving', key: 'env', width: 26 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const u of out.accounts) ws.addRow({ name: u.displayName, org: t.slug, username: u.username, role: Roles.label(u.role), password: out.password, env: t.name });
    await download(wb, `testaccounts_${t.slug}.xlsx`);
  }

  async function download(wb, name) {
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    const canImpersonate = (u) => u.kind === 'account' && !u.platformAdmin && !u.disabled;
    // Hoofdbeheerders wonen in de hoofdtenant en loggen in zonder organisatiecode.
    const isMain = t.id === state.mainId;
    const admins = users.filter((u) => u.platformAdmin && !u.disabled).length;
    const support = (u) => (u.platformAdmin || u.kind !== 'account' || t.environment === 'test' ? '–' : u.support ? `<span class="pill live" title="Supporttoegang voor live">tot ${esc(when(u.support.expiresAt))}</span>` : '<span class="muted">geen</span>');
    const rows = users.map((u) => `<tr data-uid="${esc(u.id)}" class="${u.disabled ? 'off' : ''}">
        <td>${esc(u.displayName)}<br><span class="code">${esc(u.username)}</span></td>
        <td>${u.kind === 'account' && !u.platformAdmin ? `<select data-f="role">${roleOptions(u.role)}</select>` : esc(Roles.label(u.role))}${u.platformAdmin ? ' <span class="pill hoofd">hoofdbeheerder</span>' : ''}</td>
        <td>${esc(when(u.lastSeenAt))}</td>
        <td>${support(u)}</td>
        <td class="acts">${canImpersonate(u) ? '<button class="btn small" data-f="impersonate">Inloggen als</button>' : ''}${u.kind === 'account' ? `<button class="btn small" data-f="toggle">${u.disabled ? 'Inschakelen' : 'Uitschakelen'}</button><button class="btn small" data-f="password">Wachtwoord</button>` : ''}${isMain && u.kind === 'account' ? `<button class="btn small" data-f="platform">${u.platformAdmin ? 'Hoofdbeheerder intrekken' : 'Hoofdbeheerder maken'}</button>` : ''}</td>
      </tr>`).join('');
    modal(`<h2>${t.environment === 'test' ? 'Testaccounts' : 'Gebruikers'} van ${esc(t.name)}</h2>
      ${t.environment === 'test' ? '<p class="muted small">Accounts die alleen in deze testomgeving bestaan. Ze verdwijnen bij Leegmaken of Verwijderen.</p>' : ''}
      ${isMain ? `<p class="muted small">Dit is de hoofdtenant. Hoofdbeheerders kunnen alle tenants beheren en loggen in met een lege organisatiecode. Er is altijd minstens één actieve hoofdbeheerder (nu ${admins}).</p>` : `<p class="muted small">Deze gebruikers loggen in met organisatiecode <b class="code">${esc(t.slug)}</b>.</p>`}
      <div class="tablewrap"><table class="grid" id="mu-table">${users.length ? `<thead><tr><th>Gebruiker</th><th>Rol</th><th>Laatst gezien</th><th>Support (live)</th><th></th></tr></thead><tbody>${rows}</tbody>` : '<tr><td class="empty">Nog geen gebruikers.</td></tr>'}</table></div>
      <form id="mu-form" class="card-form" novalidate>
        <h3>Gebruiker toevoegen</h3>
        <div class="row">
          <label>Volledige naam<input name="displayName" maxlength="80" autocomplete="off" placeholder="bijv. Piet Groen"></label>
          <label>Gebruikersnaam<input name="username" required maxlength="40" autocomplete="off" placeholder="piet.groen" data-rule="username"><span class="hint">3–40 tekens: kleine letters, cijfers, punt, streepje of underscore.</span></label>
          <label>Rol<select name="role">${roleOptions('beheerder')}</select></label>
          <label>Wachtwoord<input name="password" type="password" maxlength="128" required placeholder="minimaal 12 tekens" autocomplete="new-password" data-rule="password"><span class="hint">Minimaal 12 tekens.</span></label>
        </div>
        ${isMain ? '<label class="chk"><input type="checkbox" name="platformAdmin"> Hoofdbeheerder (alle tenants beheren; altijd met de rol beheerder)</label>' : ''}
        <div class="row"><button class="btn primary" type="submit">Toevoegen</button></div>
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
      if (b.dataset.f === 'impersonate') return impersonateDialog(t, u);
      if (b.dataset.f === 'toggle') patch(u.id, { disabled: !u.disabled }, u.disabled ? 'Ingeschakeld' : 'Uitgeschakeld');
      if (b.dataset.f === 'platform') {
        const msg = u.platformAdmin
          ? `${u.displayName} is dan geen hoofdbeheerder meer en blijft beheerder van ${t.name}. Doorgaan?`
          : `${u.displayName} hoofdbeheerder maken?\n\nEen hoofdbeheerder kan alle tenants, gebruikers en testomgevingen beheren en wordt beheerder van ${t.name}.`;
        if (confirm(msg)) patch(u.id, { platformAdmin: !u.platformAdmin }, u.platformAdmin ? 'Hoofdbeheerder ingetrokken' : 'Hoofdbeheerder gemaakt');
      }
      if (b.dataset.f === 'password') {
        const pw = prompt(`Nieuw wachtwoord voor ${u.displayName} (minimaal 12 tekens)`);
        if (pw) patch(u.id, { password: pw }, 'Wachtwoord gewijzigd');
      }
    };
    $('#mu-table').onchange = (ev) => {
      const tr = ev.target.closest('tr[data-uid]');
      if (tr && ev.target.dataset.f === 'role') patch(tr.dataset.uid, { role: ev.target.value }, 'Rol gewijzigd');
    };
    const mu = $('#mu-form');
    wireUsername(mu.username, mu.displayName);
    if (mu.platformAdmin) mu.platformAdmin.onchange = () => { mu.role.disabled = mu.platformAdmin.checked; if (mu.platformAdmin.checked) mu.role.value = 'beheerder'; };
    mu.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const problem = checkForm(f);
      $('.err', f).textContent = problem;
      if (problem) return;
      try {
        const body = { username: f.username.value.trim().toLowerCase(), displayName: f.displayName.value.trim(), role: f.role.value, password: f.password.value };
        if (f.platformAdmin?.checked) body.platformAdmin = true;
        await api(base, { body });
        toast('Gebruiker toegevoegd');
        await load();
        usersDialog(find(t.id) || t);
      } catch (e) { $('.err', f).textContent = e.message; }
    };
  }

  // ---------- Inloggen als een gebruiker (impersonatie) ----------
  // In een testomgeving zonder goedkeuring; in live alleen als de gebruiker
  // supporttoegang heeft gegeven. Terug kan altijd met de rode balk onderin.
  function impersonateDialog(t, u) {
    // Een testaccount bestaat alleen in zijn eigen testomgeving.
    if (t.environment === 'test') u = { ...u, support: null };
    const envs = t.environment === 'test' ? [t] : (find(t.id) || t).environments || [];
    const opts = t.environment === 'test' ? `<option value="${esc(t.id)}">Test: ${esc(t.name)} (zonder goedkeuring)</option>` : [
      ...envs.filter((e) => !e.disabled).map((e) => `<option value="${esc(e.id)}">Test: ${esc(e.name)} (zonder goedkeuring)</option>`),
      `<option value="${esc(t.id)}"${u.support ? '' : ' disabled'}>Live${u.support ? ` (toestemming tot ${esc(when(u.support.expiresAt))})` : ' (geen toestemming)'}</option>`,
    ].join('');
    const hint = u.support || t.environment === 'test'
      ? ''
      : `<p class="muted small">Voor live is toestemming nodig: ${esc(u.displayName)} geeft die zelf op het dashboard bij <b>Support op afstand</b>, voor een beperkte tijd.${envs.length ? '' : ' Deze tenant heeft nog geen testomgeving.'}</p>`;
    modal(`<h2>Inloggen als ${esc(u.displayName)}</h2>
      <p class="muted small">Je werkt dan met de rol en rechten van ${esc(u.displayName)} (${esc(Roles.label(u.role))}). Alles wat je doet komt met jouw naam in het auditlog. Terug naar je eigen account kan altijd met de rode balk onderin.</p>
      ${hint}
      <form id="imp-form" class="card-form">
        <div class="row">
          <label>Omgeving<select name="tenantId">${opts}</select></label>
          <label>Reden (optioneel)<input name="reason" maxlength="200" autocomplete="off" placeholder="bijv. vraag over offerte"></label>
        </div>
        <div class="row"><button class="btn primary" type="submit">Inloggen als ${esc(u.displayName)}</button></div>
        <div class="err" role="alert"></div>
      </form>`);
    const f = $('#imp-form');
    const sel = f.tenantId;
    if (sel.options[sel.selectedIndex]?.disabled) sel.selectedIndex = -1;
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!sel.value) { $('.err', f).textContent = 'Kies een omgeving.'; return; }
      try {
        await api('platform/impersonate', { body: { userId: u.id, tenantId: sel.value, reason: f.reason.value.trim() } });
        location.href = '../';
      } catch (e) { $('.err', f).textContent = e.message; }
    };
  }

  // ---------- Nieuwe tenant ----------
  function wireForm() {
    const f = $('#t-form');
    let slugTouched = false;
    const resetUser = wireUsername(f.adminUsername, f.adminName);
    const hint = () => {
      $('#t-login-org').textContent = f.slug.value || '…';
      $('#t-login-user').textContent = f.adminUsername.value || '…';
    };
    f.slug.oninput = () => {
      slugTouched = Boolean(f.slug.value);
      const v = slugify(f.slug.value.replace(/-$/, '')) + (f.slug.value.endsWith('-') ? '-' : '');
      if (v !== f.slug.value) f.slug.value = v;
      f.slug.classList.remove('invalid');
      hint();
    };
    f.name.oninput = () => { if (!slugTouched) f.slug.value = slugify(f.name.value); hint(); };
    f.adminUsername.addEventListener('input', hint);
    f.adminUsername.addEventListener('change', hint);
    hint();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const withAdmin = Boolean(f.adminUsername.value.trim() || f.adminPassword.value || f.adminName.value.trim());
      let problem = f.name.value.trim().length < 2 ? 'Vul de naam van de organisatie in (minimaal 2 tekens).' : '';
      // Zonder eerste beheerder mogen die velden leeg blijven; met een van
      // de drie ingevuld zijn gebruikersnaam en wachtwoord verplicht.
      problem = problem || checkForm(f, { optional: withAdmin ? [] : ['adminUsername', 'adminPassword'] });
      if (!problem && withAdmin && !f.adminUsername.value.trim()) problem = 'Vul de gebruikersnaam van de eerste beheerder in.';
      if (!problem && withAdmin && !f.adminPassword.value) problem = 'Vul het wachtwoord van de eerste beheerder in (minimaal 12 tekens).';
      $('#t-err').textContent = problem;
      if (problem) return;
      const body = { name: f.name.value.trim(), slug: f.slug.value.trim().toLowerCase() };
      if (withAdmin) body.admin = { username: f.adminUsername.value.trim().toLowerCase(), displayName: f.adminName.value.trim(), password: f.adminPassword.value };
      try {
        const out = await api('platform/tenants', { body });
        f.reset();
        slugTouched = false;
        resetUser();
        hint();
        toast(`Tenant ${out.tenant.name} aangemaakt${out.admin ? ` met beheerder ${out.admin.username} (organisatiecode ${out.tenant.slug})` : ''}`);
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
          users: e.userCount, plans: e.planCount, last: date(e.lastActivity), created: date(e.createdAt) });
      }
    }
    ws.getColumn('last').numFmt = 'dd-mm-yyyy hh:mm';
    ws.getColumn('created').numFmt = 'dd-mm-yyyy hh:mm';
    await download(wb, `tenants_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ---------- Start ----------
  $('#modal-close').onclick = closeModal;
  $('#modal').onclick = (ev) => { if (ev.target.id === 'modal') closeModal(); };
  $('#t-search').oninput = render;
  $('#t-export').onclick = exportExcel;
  $('#t-admins').onclick = () => { const m = find(state.mainId); if (m) usersDialog(m); };
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
