// Beheer: historie van aanvragen, alle plannen en gebruikers. Alle gegevens
// komen uit /api/admin/*; de server weigert die voor niet-beheerders.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const ACTIONS = { aangemaakt: 'Aangemaakt', bijgewerkt: 'Bijgewerkt', verwijderd: 'Verwijderd', analyse: 'Plan herkend' };
  const KINDS = { account: 'Account', gast: 'Gast', systeem: 'Systeem' };
  const areaLabel = (t) => (window.Catalog && window.Catalog.areaTypes[t] ? window.Catalog.areaTypes[t].label : t);
  const PAGE = 100;
  const Roles = window.AquatechRoles;
  const roleOptions = (current) => Object.entries(Roles.ROLES)
    .map(([k, r]) => `<option value="${k}"${k === current ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

  const state = { offset: 0, total: 0, users: [], auditOffset: 0 };
  const AUDIT = {
    ingelogd: 'Ingelogd', uitgelogd: 'Uitgelogd', inloggen_mislukt: 'Inloggen mislukt', inloggen_geblokkeerd: 'Inloggen geblokkeerd',
    eerste_beheerder: 'Eerste beheerder', installatie_mislukt: 'Installatiecode onjuist', gebruiker_aangemaakt: 'Gebruiker aangemaakt',
    gebruiker_gewijzigd: 'Gebruiker gewijzigd', plan_gewist: 'Plan definitief gewist', backup_gemaakt: 'Back-up gemaakt',
    backup_gedownload: 'Back-up gedownload', sessies_ingetrokken: 'Uitgelogd op alle toestellen', instellingen_gewijzigd: 'Instellingen gewijzigd',
    offerte_akkoord: 'Offerte geaccepteerd door klant', offerte_afgewezen: 'Offerte afgewezen door klant', offerte_gewist: 'Offerte definitief gewist',
    impersonatie_gestart: 'Hoofdbeheerder werkt als gebruiker', impersonatie_beeindigd: 'Impersonatie beëindigd',
    support_toegang_verleend: 'Supporttoegang gegeven', support_toegang_ingetrokken: 'Supporttoegang ingetrokken',
  };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
    return body;
  }

  // ---------- Aanvragen ----------
  function historyQuery(offset, limit) {
    const p = new URLSearchParams({ limit, offset });
    const q = $('#h-search').value.trim();
    if (q) p.set('q', q);
    if ($('#h-user').value) p.set('user', $('#h-user').value);
    if ($('#h-action').value) p.set('action', $('#h-action').value);
    return `history?${p}`;
  }

  async function loadHistory() {
    const tbl = $('#h-table');
    try {
      const { total, items } = await api(historyQuery(state.offset, PAGE));
      state.total = total;
      if (!items.length) {
        tbl.innerHTML = '<tr><td class="empty">Nog geen aanvragen gevonden.</td></tr>';
      } else {
        tbl.innerHTML = `<thead><tr><th>Laatst bijgewerkt</th><th>Gebruiker</th><th>Actie</th><th>Plan</th><th>Klant</th><th>Adres</th>
          <th class="num">Vlakken</th><th class="num">m²</th><th class="num">Sproeiers</th><th class="num">Zones</th></tr></thead><tbody>${items.map((h) => `
          <tr data-id="${esc(h.id)}">
            <td>${esc(when(h.updatedAt))}</td>
            <td>${h.user ? esc(h.user.displayName) : '–'}${h.user && h.user.role !== 'installateur' ? ` <span class="pill ${esc(h.user.role)}">${esc(Roles.label(h.user.role).toLowerCase())}</span>` : ''}</td>
            <td><span class="pill ${esc(h.action)}">${esc(ACTIONS[h.action] || h.action)}</span></td>
            <td class="wrap">${esc(h.title)}${h.planDeleted && h.action !== 'analyse' ? ' <span class="pill verwijderd">plan verwijderd</span>' : ''}</td>
            <td class="wrap">${esc(h.customer)}</td>
            <td class="wrap">${esc(h.address)}</td>
            <td class="num">${h.summary.areas ?? '–'}</td>
            <td class="num">${h.summary.totalM2 != null ? num(h.summary.totalM2) : '–'}</td>
            <td class="num">${h.summary.sprinklers ?? '–'}</td>
            <td class="num">${h.summary.zones ?? '–'}</td>
          </tr>`).join('')}</tbody>`;
        tbl.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => showHistory(tr.dataset.id); });
      }
      const from = total ? state.offset + 1 : 0;
      $('#h-info').textContent = `${from}–${Math.min(total, state.offset + PAGE)} van ${total}`;
      $('#h-prev').disabled = state.offset === 0;
      $('#h-next').disabled = state.offset + PAGE >= total;
    } catch (e) {
      tbl.innerHTML = `<tr><td class="empty">Kan de historie niet laden (${esc(e.message)}).</td></tr>`;
    }
  }

  function openCopy(data) {
    try {
      sessionStorage.setItem('aquatech-open-copy', JSON.stringify(data));
    } catch (e) {
      toast('Kan de kopie niet doorgeven aan de planner (opslag vol of geblokkeerd).', true);
      return;
    }
    location.href = '../beregening/?copy=1';
  }

  async function showHistory(id) {
    let h;
    try { h = await api(`history/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
    const s = h.summary || {};
    const m2 = Object.entries(s.m2ByType || {}).map(([t, v]) => `${esc(areaLabel(t))}: ${num(v)} m²`).join('<br>');
    $('#detail-body').innerHTML = `
      <h2>${esc(h.title || 'Aanvraag')}</h2>
      <span class="pill ${esc(h.action)}">${esc(ACTIONS[h.action] || h.action)}</span>
      <dl class="kv">
        <dt>Gebruiker</dt><dd>${h.user ? `${esc(h.user.displayName)} (${esc(h.user.username)}, ${esc(KINDS[h.user.kind] || h.user.kind)}, ${esc(h.user.role)})` : '–'}</dd>
        <dt>Eerste keer</dt><dd>${esc(when(h.createdAt))}</dd>
        <dt>Laatst bijgewerkt</dt><dd>${esc(when(h.updatedAt))}</dd>
        ${h.action === 'analyse' ? `<dt>Herkend</dt><dd>${s.areas ?? 0} vlakken, ${s.elements ?? 0} elementen, schaal: ${esc(s.scale || '–')} (${esc(s.confidence || '–')})</dd>` : `
        <dt>Klant</dt><dd>${esc(h.customer || '–')}</dd>
        <dt>Adres</dt><dd>${esc(h.address || '–')}</dd>
        <dt>Vlakken</dt><dd>${s.areas ?? 0} (${num(s.totalM2)} m²)</dd>
        ${m2 ? `<dt>Per soort</dt><dd>${m2}</dd>` : ''}
        <dt>Sproeiers</dt><dd>${s.sprinklers ?? 0}</dd>
        <dt>Zones</dt><dd>${s.zones ?? 0}</dd>
        <dt>Elementen</dt><dd>${s.elements ?? 0}</dd>
        <dt>Plan</dt><dd>${h.planId ? (h.planDeleted ? 'verwijderd door de gebruiker' : 'bestaat nog') : '–'}</dd>`}
        <dt>IP-adres</dt><dd>${esc(h.ip || '–')}</dd>
      </dl>
      <div class="actions">
        ${h.snapshot ? '<button class="btn primary" id="d-copy">Kopie openen in de planner</button>' : ''}
      </div>
      ${h.snapshot ? '<p class="muted small">De kopie wordt een nieuw plan op jouw naam (zonder de achtergrondafbeelding); het plan van de gebruiker blijft ongewijzigd.</p>' : ''}`;
    const copy = $('#d-copy');
    if (copy) copy.onclick = () => openCopy(h.snapshot);
    $('#detail').hidden = false;
  }

  async function fetchAllHistory() {
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const { total, items } = await api(historyQuery(offset, 1000));
      all.push(...items);
      if (all.length >= total || !items.length) break;
    }
    return all;
  }

  async function exportHistory() {
    const btn = $('#h-export');
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    btn.disabled = true;
    btn.textContent = 'Bezig…';
    try {
      const items = await fetchAllHistory();
      const types = [...new Set(items.flatMap((h) => Object.keys(h.summary.m2ByType || {})))];
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Aquatech';
      wb.created = new Date();
      const ws = wb.addWorksheet('Aanvragen', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
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
        ...types.map((t) => ({ header: `${areaLabel(t)} m²`, key: `m2_${t}`, width: 14, style: { numFmt: '0.0' } })),
        { header: 'Sproeiers', key: 'sprinklers', width: 10 },
        { header: 'Zones', key: 'zones', width: 8 },
        { header: 'Elementen', key: 'elements', width: 10 },
        { header: 'IP-adres', key: 'ip', width: 16 },
      ];
      for (const h of items) {
        const s = h.summary || {};
        const row = {
          createdAt: new Date(h.createdAt), updatedAt: new Date(h.updatedAt), action: ACTIONS[h.action] || h.action,
          user: h.user ? h.user.displayName : '', username: h.user ? h.user.username : '', kind: h.user ? KINDS[h.user.kind] || h.user.kind : '',
          role: h.user ? h.user.role : '', title: h.title, customer: h.customer, address: h.address,
          planDeleted: h.action === 'analyse' ? '' : (h.planDeleted ? 'ja' : 'nee'),
          areas: s.areas, totalM2: s.totalM2, sprinklers: s.sprinklers, zones: s.zones, elements: s.elements, ip: h.ip,
        };
        for (const t of types) row[`m2_${t}`] = (s.m2ByType || {})[t];
        ws.addRow(row);
      }
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aanvragen_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`${items.length} aanvragen geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Exporteer naar Excel';
    }
  }

  // ---------- Plannen ----------
  async function loadPlans() {
    const tbl = $('#p-table');
    try {
      const { items } = await api('plans');
      if (!items.length) { tbl.innerHTML = '<tr><td class="empty">Nog geen plannen.</td></tr>'; return; }
      tbl.innerHTML = `<thead><tr><th>Plan</th><th>Klant</th><th>Adres</th><th>Eigenaar</th><th>Aangemaakt</th><th>Gewijzigd</th><th></th></tr></thead><tbody>${items.map((p) => `
        <tr>
          <td class="wrap"><b>${esc(p.title)}</b></td>
          <td class="wrap">${esc(p.customer)}</td>
          <td class="wrap">${esc(p.address)}</td>
          <td>${esc(p.owner.displayName)} <span class="muted small">${esc(KINDS[p.owner.kind] || '')}</span></td>
          <td>${esc(when(p.createdAt))}</td>
          <td>${esc(when(p.updatedAt))}</td>
          <td><button class="btn small" data-copy="${esc(p.id)}">Kopie openen</button></td>
        </tr>`).join('')}</tbody>`;
      tbl.querySelectorAll('[data-copy]').forEach((b) => {
        b.onclick = async () => {
          try { openCopy((await api(`plans/${encodeURIComponent(b.dataset.copy)}`)).data); } catch (e) { toast(e.message, true); }
        };
      });
    } catch (e) {
      tbl.innerHTML = `<tr><td class="empty">Kan de plannen niet laden (${esc(e.message)}).</td></tr>`;
    }
  }

  // ---------- Gebruikers ----------
  async function loadUsers() {
    const { items } = await api('users');
    state.users = items;
    const sel = $('#h-user');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Alle gebruikers</option>' + items
      .filter((u) => u.historyCount > 0 || u.kind !== 'gast')
      .map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}${u.kind === 'gast' ? ' (gast)' : ''}</option>`).join('');
    sel.value = cur;
    renderUsers();
  }

  function renderUsers() {
    const showGuests = $('#u-guests').checked;
    const items = state.users.filter((u) => showGuests || u.kind !== 'gast');
    const tbl = $('#u-table');
    tbl.innerHTML = `<thead><tr><th>Naam</th><th>Gebruikersnaam</th><th>Soort</th><th>Rol</th><th class="num">Plannen</th><th class="num">Aanvragen</th><th>Laatst actief</th><th class="num">Sessies</th><th></th></tr></thead><tbody>${items.map((u) => {
      const editable = u.kind === 'account';
      return `<tr class="${u.disabled ? 'off' : ''}">
        <td>${esc(u.displayName)}${u.disabled ? ' <span class="pill">uitgeschakeld</span>' : ''}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(KINDS[u.kind] || u.kind)}</td>
        <td>${editable ? `<select data-role="${esc(u.id)}" title="${esc(Roles.ROLES[u.role] ? Roles.ROLES[u.role].description : '')}">${roleOptions(u.role)}</select>` : `<span class="pill ${esc(u.role)}">${esc(Roles.label(u.role))}</span>`}</td>
        <td class="num">${u.planCount}</td>
        <td class="num">${u.historyCount}</td>
        <td>${esc(when(u.lastSeenAt))}</td>
        <td class="num">${u.sessionCount || 0}</td>
        <td>${u.sessionCount ? `<button class="btn small" data-logout="${esc(u.id)}">Uitloggen</button> ` : ''}${editable ? `<button class="btn small" data-pw="${esc(u.id)}">Wachtwoord</button> <button class="btn small" data-toggle="${esc(u.id)}">${u.disabled ? 'Inschakelen' : 'Uitschakelen'}</button>` : ''}
          ${u.historyCount ? `<button class="btn small" data-hist="${esc(u.id)}">Aanvragen</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody>`;
    const patch = async (id, body, msg) => {
      try { await api(`users/${encodeURIComponent(id)}`, { method: 'PATCH', body }); toast(msg); } catch (e) { toast(e.message, true); }
      loadUsers();
    };
    tbl.querySelectorAll('[data-role]').forEach((s) => { s.onchange = () => patch(s.dataset.role, { role: s.value }, 'Rol gewijzigd'); });
    tbl.querySelectorAll('[data-toggle]').forEach((b) => {
      const u = state.users.find((x) => x.id === b.dataset.toggle);
      b.onclick = () => patch(u.id, { disabled: !u.disabled }, u.disabled ? 'Gebruiker ingeschakeld' : 'Gebruiker uitgeschakeld');
    });
    tbl.querySelectorAll('[data-pw]').forEach((b) => {
      b.onclick = () => {
        const pw = prompt('Nieuw wachtwoord (minimaal 12 tekens). De gebruiker wordt op alle toestellen uitgelogd.');
        if (pw) patch(b.dataset.pw, { password: pw }, 'Wachtwoord gewijzigd');
      };
    });
    tbl.querySelectorAll('[data-logout]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Deze gebruiker op alle toestellen uitloggen?')) return;
        try { await api(`users/${encodeURIComponent(b.dataset.logout)}/logout`, { method: 'POST' }); toast('Uitgelogd op alle toestellen'); } catch (e) { toast(e.message, true); }
        loadUsers();
      };
    });
    tbl.querySelectorAll('[data-hist]').forEach((b) => {
      b.onclick = () => { $('#h-user').value = b.dataset.hist; state.offset = 0; showTab('history'); loadHistory(); };
    });
  }

  async function addUser(ev) {
    ev.preventDefault();
    const f = ev.target;
    $('#u-err').textContent = '';
    try {
      await api('users', { method: 'POST', body: { username: f.username.value.trim().toLowerCase(), displayName: f.displayName.value, role: f.role.value, password: f.password.value } });
      f.reset();
      toast('Gebruiker toegevoegd');
      loadUsers();
    } catch (e) {
      $('#u-err').textContent = e.message;
    }
  }

  // ---------- Instellingen ----------
  const SOURCES = { instellingen: '', omgeving: 'uit Docker-omgeving', standaard: 'standaard' };

  function renderSettings(view) {
    state.settings = view;
    const ai = $('#s-ai');
    ai.aiEnabled.checked = view.aiEnabled.value;
    ai.aiDailyLimit.value = view.aiDailyLimit.value;
    ai.aiHourlyPerIp.value = view.aiHourlyPerIp.value;
    document.querySelectorAll('[data-origin]').forEach((el) => { el.textContent = SOURCES[view[el.dataset.origin].source] || ''; });
    document.querySelectorAll('[data-reset]').forEach((b) => { b.hidden = view[b.dataset.reset].source !== 'instellingen'; });
    const key = view.anthropicApiKey;
    const keyState = $('[data-state="anthropicApiKey"]');
    keyState.textContent = key.set ? `Ingesteld${key.hint ? ` (eindigt op ${key.hint.replace('…', '')})` : ''}` : 'Niet ingesteld: AI-herkenning staat uit.';
    keyState.className = `state ${key.set ? 'ok' : 'off'}`;
    const code = view.accessCode;
    const codeState = $('[data-state="accessCode"]');
    codeState.textContent = code.set ? 'Ingesteld: inloggen kan ook met de code (als beheerder).' : 'Niet ingesteld: inloggen alleen met een eigen account.';
    $('#s-backup').backupKeepDays.value = view.backupKeepDays.value;
    const sec = $('#s-security');
    for (const k of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays']) sec[k].value = view[k].value;
    const acc = $('#s-access');
    acc.guestAccess.checked = view.guestAccess.value;
    acc.guestAccess.disabled = code.set;
    codeState.className = `state ${code.set ? 'ok' : 'off'}`;
    $('[data-clear="anthropicApiKey"]').disabled = !key.set;
    $('[data-clear="accessCode"]').disabled = !code.set;
    const mods = (window.AquatechModules || []).filter((m) => m.id !== 'beheer' && m.id !== 'hoofdbeheer');
    $('#s-module-list').innerHTML = mods.map((m) => `
      <label class="chk"><input type="checkbox" data-module="${esc(m.id)}"${view.modules.value[m.id] === false ? '' : ' checked'}>
        ${esc(m.title)}${m.status === 'gepland' ? ' <span class="muted small">(binnenkort)</span>' : ''}</label>`).join('');
  }

  const size = (n) => (n >= 1048576 ? `${num(n / 1048576)} MB` : `${num(n / 1024, 0)} kB`);
  async function loadBackups() {
    const el = $('#b-list');
    try {
      const { enabled, items } = await api('backups');
      $('#b-now').disabled = !enabled;
      el.innerHTML = !enabled ? 'Back-ups zijn op deze server niet beschikbaar.'
        : !items.length ? 'Nog geen back-ups.'
          : `<ul class="timeline">${items.map((b) => `<li><a href="../api/admin/backups/${encodeURIComponent(b.name)}" download>${esc(b.name)}</a> · ${esc(when(b.createdAt))} · ${esc(size(b.size))}</li>`).join('')}</ul>`;
    } catch (e) {
      el.textContent = `Kan de back-ups niet laden (${e.message}).`;
    }
  }

  async function loadSettings() {
    if (state.backups) loadBackups();
    try {
      renderSettings((await api('settings')).settings);
    } catch (e) {
      toast(`Kan de instellingen niet laden: ${e.message}`, true);
    }
  }

  async function saveSettings(form, patch, msg) {
    const err = $('.err', form);
    err.textContent = '';
    try {
      const out = await api('settings', { method: 'PUT', body: patch });
      renderSettings(out.settings);
      form.querySelectorAll('input[type=password]').forEach((i) => { i.value = ''; });
      toast(out.changed.length ? msg : 'Niets gewijzigd');
      return true;
    } catch (e) {
      err.textContent = e.message;
      return false;
    }
  }

  function initSettings() {
    const ai = $('#s-ai');
    ai.onsubmit = (ev) => {
      ev.preventDefault();
      const patch = { aiEnabled: ai.aiEnabled.checked, aiDailyLimit: Number(ai.aiDailyLimit.value), aiHourlyPerIp: Number(ai.aiHourlyPerIp.value) };
      if (ai.anthropicApiKey.value.trim()) patch.anthropicApiKey = ai.anthropicApiKey.value.trim();
      saveSettings(ai, patch, 'Instellingen opgeslagen');
    };
    $('#s-test').onclick = async () => {
      const btn = $('#s-test');
      const err = $('.err', ai);
      // Eerst een net ingevulde sleutel opslaan, dan testen.
      if (ai.anthropicApiKey.value.trim() && !(await saveSettings(ai, { anthropicApiKey: ai.anthropicApiKey.value.trim() }, 'Sleutel opgeslagen'))) return;
      btn.disabled = true;
      btn.textContent = 'Bezig…';
      err.textContent = '';
      try {
        await api('settings/test-ai', { method: 'POST' });
        toast('De sleutel werkt.');
      } catch (e) {
        err.textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sleutel testen';
      }
    };
    const acc = $('#s-access');
    acc.guestAccess.onchange = () => {
      saveSettings(acc, { guestAccess: acc.guestAccess.checked }, acc.guestAccess.checked ? 'Gasten toegestaan' : 'Inloggen is nu verplicht');
    };
    acc.onsubmit = (ev) => {
      ev.preventDefault();
      const v = acc.accessCode.value.trim();
      if (!v) { $('.err', acc).textContent = 'Vul een nieuwe code in.'; return; }
      saveSettings(acc, { accessCode: v }, 'Toegangscode opgeslagen');
    };
    document.querySelectorAll('[data-clear]').forEach((b) => {
      b.onclick = () => {
        const field = b.dataset.clear;
        const q = field === 'accessCode'
          ? 'Toegangscode verwijderen? Inloggen kan daarna alleen nog met een eigen account.'
          : 'API-sleutel verwijderen? Automatisch herkennen met AI staat daarna uit.';
        if (confirm(q)) saveSettings(b.closest('form'), { [field]: '' }, field === 'accessCode' ? 'Toegangscode verwijderd' : 'API-sleutel verwijderd');
      };
    });
    document.querySelectorAll('[data-reset]').forEach((b) => {
      b.onclick = () => {
        if (confirm('Terugzetten naar de waarde uit de Docker-omgeving of de standaardwaarde?')) {
          saveSettings(b.closest('form'), { reset: [b.dataset.reset] }, 'Teruggezet');
        }
      };
    });
    const bk = $('#s-backup');
    bk.onsubmit = (ev) => {
      ev.preventDefault();
      saveSettings(bk, { backupKeepDays: Number(bk.backupKeepDays.value) }, 'Instellingen opgeslagen');
    };
    $('#b-now').onclick = async () => {
      const b = $('#b-now');
      b.disabled = true;
      b.textContent = 'Bezig…';
      try { await api('backups', { method: 'POST' }); toast('Back-up gemaakt'); } catch (e) { toast(e.message, true); }
      b.textContent = 'Nu back-up maken';
      loadBackups();
    };
    const sec = $('#s-security');
    sec.onsubmit = (ev) => {
      ev.preventDefault();
      const patch = {};
      for (const k of ['sessionIdleDays', 'sessionMaxDays', 'ipRetentionDays', 'auditRetentionDays']) patch[k] = Number(sec[k].value);
      saveSettings(sec, patch, 'Instellingen opgeslagen');
    };
    const mods = $('#s-modules');
    mods.onsubmit = (ev) => {
      ev.preventDefault();
      const modules = {};
      mods.querySelectorAll('[data-module]').forEach((c) => { modules[c.dataset.module] = c.checked; });
      saveSettings(mods, { modules }, 'Modules opgeslagen');
    };
  }

  // ---------- Auditlog ----------
  function auditDetail(a) {
    const d = a.detail || {};
    const parts = [];
    if (d.username) parts.push(`gebruiker ${d.username}`);
    if (d.via) parts.push(`via ${d.via}`);
    if (d.role) parts.push(`rol ${d.role}`);
    if (d.disabled !== undefined) parts.push(d.disabled ? 'uitgeschakeld' : 'ingeschakeld');
    if (d.fields) parts.push(`velden: ${d.fields.join(', ')}`);
    if (d.count !== undefined) parts.push(`${d.count} sessie(s)`);
    if (d.name) parts.push(d.name);
    if (d.automatisch) parts.push('automatisch');
    return parts.join(' · ');
  }

  async function loadAudit() {
    const tbl = $('#a-table');
    try {
      const { total, items } = await api(`audit?limit=${PAGE}&offset=${state.auditOffset}`);
      tbl.innerHTML = !items.length ? '<tr><td class="empty">Nog geen gebeurtenissen.</td></tr>'
        : `<thead><tr><th>Tijdstip</th><th>Gebeurtenis</th><th>Door</th><th>Details</th><th>IP-adres</th></tr></thead><tbody>${items.map((a) => `
          <tr><td>${esc(when(a.createdAt))}</td><td>${esc(AUDIT[a.action] || a.action)}</td>
            <td>${a.user ? esc(a.user.displayName) : '–'}</td><td class="wrap">${esc(auditDetail(a))}</td><td>${esc(a.ip || '–')}</td></tr>`).join('')}</tbody>`;
      const from = total ? state.auditOffset + 1 : 0;
      $('#a-info').textContent = `${from}–${Math.min(total, state.auditOffset + PAGE)} van ${total}`;
      $('#a-prev').disabled = state.auditOffset === 0;
      $('#a-next').disabled = state.auditOffset + PAGE >= total;
    } catch (e) {
      tbl.innerHTML = `<tr><td class="empty">Kan het auditlog niet laden (${esc(e.message)}).</td></tr>`;
    }
  }

  // ---------- Algemeen ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    if (name === 'plans') loadPlans();
    if (name === 'users') loadUsers();
    if (name === 'settings') loadSettings();
    if (name === 'audit') loadAudit();
    try { window.history.replaceState(null, '', `#${name}`); } catch (e) { /* file:// */ }
  }

  async function init() {
    const me = await window.AquatechAccount.load('../');
    if (!me.user || me.user.role !== 'beheerder') {
      const d = $('#denied');
      d.innerHTML = me.user && me.user.kind !== 'gast'
        ? '<b>Geen toegang.</b> Deze pagina is alleen voor beheerders. <a href="../">Terug naar het overzicht</a>.'
        : '<b>Log in als beheerder</b> om de historie te bekijken: met een beheerdersaccount of de toegangscode. <a href="../login">Inloggen</a>.';
      d.hidden = false;
      return;
    }
    $('#app').hidden = false;
    // Back-ups bevatten de hele database (alle tenants): alleen voor hoofdbeheerders.
    state.backups = Boolean(me.platformAdmin || (me.via === 'code' && me.tenant && me.tenant.slug === 'default'));
    $('#s-backup').hidden = !state.backups;
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
    let timer;
    $('#h-search').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.offset = 0; loadHistory(); }, 250); };
    $('#h-user').onchange = $('#h-action').onchange = () => { state.offset = 0; loadHistory(); };
    $('#h-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); loadHistory(); };
    $('#h-next').onclick = () => { state.offset += PAGE; loadHistory(); };
    $('#h-export').onclick = exportHistory;
    $('#a-prev').onclick = () => { state.auditOffset = Math.max(0, state.auditOffset - PAGE); loadAudit(); };
    $('#a-next').onclick = () => { state.auditOffset += PAGE; loadAudit(); };
    $('#u-form').onsubmit = addUser;
    $('#u-guests').onchange = renderUsers;
    initSettings();
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    $('#detail').onclick = (e) => { if (e.target.id === 'detail') $('#detail').hidden = true; };
    await loadUsers().catch(() => {});
    loadHistory();
    // Direct naar een tabblad via beheer/#settings.
    const hash = location.hash.slice(1);
    if (['plans', 'users', 'settings', 'audit'].includes(hash)) showTab(hash);
  }

  init();
})();
