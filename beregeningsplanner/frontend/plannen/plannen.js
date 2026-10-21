// Plannenoverzicht: een tabel met de plannen en hun projectgegevens.
// Een klant ziet zijn eigen plannen (/api/plans); een installateur alle
// plannen van de organisatie (/api/plans?all=1); een beheerder daarbij ook
// verwijderde plannen en per plan de tijdlijn uit de historie
// (/api/admin/plans). De server bepaalt wat iemand mag zien.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const ACTIONS = { aangemaakt: 'Aangemaakt', bijgewerkt: 'Bijgewerkt', verwijderd: 'Verwijderd' };
  const areaLabel = (t) => (window.Catalog && window.Catalog.areaTypes[t] ? window.Catalog.areaTypes[t].label : t);
  const lawnM2 = (p) => (p.summary && p.summary.m2ByType ? p.summary.m2ByType.lawn || 0 : 0);
  // Controle: een plan van een klant is pas definitief na goedkeuring.
  const REVIEW = { concept: 'Concept', ter_controle: 'Ter controle', goedgekeurd: 'Goedgekeurd' };
  const reviewOf = (p) => (p.review ? p.review.status : 'concept');
  const reviewPill = (p) => `<span class="pill rv-${esc(reviewOf(p))}">${esc(REVIEW[reviewOf(p)] || reviewOf(p))}</span>${p.review && p.review.via === 'openbaar' ? '<span class="sub">zonder account</span>' : ''}`;

  const state = { me: null, admin: false, team: false, quotes: false, approver: false, plans: [], sort: { key: 'updatedAt', dir: -1 } };

  // Kolommen: key, kop, waarde (voor sorteren/Excel) en weergave.
  const COLUMNS = [
    { key: 'title', label: 'Projectnaam', value: (p) => p.title, html: (p) => `<b>${esc(p.title)}</b>${p.customer ? `<span class="sub">${esc(p.customer)}</span>` : ''}`, cls: 'wrap' },
    { key: 'address', label: 'Adres', value: (p) => p.address, html: (p) => esc(p.address || '–'), cls: 'wrap' },
    { key: 'owner', label: 'Gebruiker', team: true, value: (p) => (p.owner ? p.owner.displayName : ''), html: (p) => esc(p.owner ? p.owner.displayName : '–') },
    { key: 'review', label: 'Status', value: reviewOf, html: reviewPill },
    { key: 'lawn', label: 'Gazon m²', value: lawnM2, html: (p) => num(lawnM2(p)), cls: 'num' },
    { key: 'totalM2', label: 'Totaal m²', value: (p) => p.summary.totalM2, html: (p) => num(p.summary.totalM2), cls: 'num' },
    { key: 'areas', label: 'Vlakken', value: (p) => p.summary.areas, html: (p) => p.summary.areas, cls: 'num' },
    { key: 'sprinklers', label: 'Sproeiers', value: (p) => p.summary.sprinklers, html: (p) => p.summary.sprinklers, cls: 'num' },
    { key: 'zones', label: 'Zones', value: (p) => p.summary.zones, html: (p) => p.summary.zones, cls: 'num' },
    { key: 'createdAt', label: 'Aangemaakt', value: (p) => p.createdAt, html: (p) => esc(when(p.createdAt)) },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (p) => p.updatedAt, html: (p) => esc(when(p.updatedAt)) },
    { key: 'historyCount', label: 'Aanvragen', admin: true, value: (p) => p.historyCount, html: (p) => p.historyCount ?? '–', cls: 'num' },
  ];
  const columns = () => COLUMNS.filter((c) => (!c.admin || state.admin) && (!c.team || state.team));

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  async function load() {
    const url = state.admin ? `../api/admin/plans${$('#f-deleted').checked ? '?deleted=1' : ''}` : `../api/plans${state.team ? '?all=1' : ''}`;
    try {
      state.plans = (await getJson(url)).items || [];
    } catch (e) {
      $('#p-table').innerHTML = `<tr><td class="empty">Kan de plannen niet laden (${esc(e.message)}).</td></tr>`;
      return;
    }
    if (state.team) {
      const sel = $('#f-owner');
      const cur = sel.value;
      const owners = new Map(state.plans.filter((p) => p.owner).map((p) => [p.owner.id, p.owner.displayName]));
      sel.innerHTML = '<option value="">Alle gebruikers</option>' + [...owners].sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      sel.value = owners.has(cur) ? cur : '';
    }
    render();
  }

  function visible() {
    const q = $('#f-search').value.trim().toLowerCase();
    const owner = $('#f-owner').value;
    const review = $('#f-review').value;
    const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
    return state.plans
      .filter((p) => !owner || (p.owner && p.owner.id === owner))
      .filter((p) => !review || reviewOf(p) === review)
      .filter((p) => !q || [p.title, p.customer, p.address, p.owner && p.owner.displayName].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        const cmp = typeof va === 'number' || typeof vb === 'number' ? (va || 0) - (vb || 0) : String(va || '').localeCompare(String(vb || ''), 'nl');
        return cmp * state.sort.dir;
      });
  }

  function renderStats(items) {
    const sum = (f) => items.reduce((s, p) => s + (Number(f(p)) || 0), 0);
    const owners = new Set(items.map((p) => p.owner && p.owner.id).filter(Boolean)).size;
    const tiles = [
      [items.length, items.length === 1 ? 'plan' : 'plannen'],
      [num(sum(lawnM2), 0), 'm² gazon'],
      [num(sum((p) => p.summary.totalM2), 0), 'm² in totaal'],
      [sum((p) => p.summary.sprinklers), 'sproeiers'],
    ];
    if (state.team) tiles.push([owners, owners === 1 ? 'gebruiker' : 'gebruikers']);
    if (state.approver) tiles.push([items.filter((p) => reviewOf(p) === 'ter_controle').length, 'ter controle']);
    $('#stats').innerHTML = tiles.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#stats').hidden = !state.plans.length;
  }

  function render() {
    const items = visible();
    renderStats(items);
    const tbl = $('#p-table');
    if (!state.plans.length) {
      tbl.innerHTML = `<tr><td class="empty">Nog geen plannen. Een plan verschijnt hier zodra je in de <a href="../beregening/">beregeningsplanner</a> een vlak tekent.</td></tr>`;
      $('#p-count').textContent = '';
      return;
    }
    const cols = columns();
    const head = cols.map((c) => {
      const sorted = c.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${c.key}" class="${c.cls === 'num' ? 'num' : ''}${sorted}">${esc(c.label)}</th>`;
    }).join('');
    tbl.innerHTML = `<thead><tr>${head}<th></th></tr></thead><tbody>${items.map((p) => `
      <tr data-id="${esc(p.id)}" class="${p.deletedAt ? 'deleted' : ''}">
        ${cols.map((c) => `<td class="${c.cls || ''}">${c.html(p)}</td>`).join('')}
        <td>${p.deletedAt ? '<span class="pill verwijderd">verwijderd</span>' : `<button class="btn small" data-open="${esc(p.id)}">Openen</button>`}</td>
      </tr>`).join('')}</tbody>`;
    if (!items.length) tbl.querySelector('tbody').innerHTML = `<tr><td class="empty" colspan="${cols.length + 1}">Geen plannen gevonden.</td></tr>`;
    tbl.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['title', 'address', 'owner'].includes(key) ? 1 : -1) };
        render();
      };
    });
    tbl.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('[data-open]')) return;
        showDetail(tr.dataset.id);
      };
    });
    tbl.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openPlan(state.plans.find((p) => p.id === b.dataset.open)); });
    $('#p-count').textContent = `${items.length} van ${state.plans.length} plannen`;
  }

  // Eigen plan: openen in de planner. Wie plannen goedkeurt opent ook het
  // plan van een ander zelf (om het te controleren). Anders als kopie, zodat
  // het origineel van de gebruiker niet wijzigt.
  async function openPlan(p, copy = false) {
    const own = !p.owner || !state.me.user || p.owner.id === state.me.user.id;
    if (own || (state.approver && !copy)) { location.href = `../beregening/?plan=${encodeURIComponent(p.id)}`; return; }
    try {
      const plan = await getJson(`../api/plans/${encodeURIComponent(p.id)}`);
      sessionStorage.setItem('aquatech-open-copy', JSON.stringify(plan.data));
      location.href = '../beregening/?copy=1';
    } catch (e) {
      toast(`Kan plan niet openen: ${e.message}`, true);
    }
  }

  async function showDetail(id) {
    const p = state.plans.find((x) => x.id === id);
    if (!p) return;
    const s = p.summary || {};
    const m2 = Object.entries(s.m2ByType || {}).map(([t, v]) => `${esc(areaLabel(t))}: ${num(v)} m²`).join('<br>');
    const own = !p.owner || !state.me.user || p.owner.id === state.me.user.id;
    const r = p.review || { status: 'concept' };
    const contact = p.owner && p.owner.kind === 'gast' && (p.owner.email || p.owner.phone)
      ? `<dt>Contact</dt><dd>${p.owner.email ? `<a href="mailto:${esc(p.owner.email)}">${esc(p.owner.email)}</a>` : ''}${p.owner.email && p.owner.phone ? '<br>' : ''}${p.owner.phone ? `<a href="tel:${esc(p.owner.phone)}">${esc(p.owner.phone)}</a>` : ''}</dd>` : '';
    const approved = r.status === 'goedgekeurd';
    $('#detail-body').innerHTML = `
      <h2>${esc(p.title)}</h2>
      ${p.deletedAt ? '<span class="pill verwijderd">verwijderd</span>' : ''}
      <dl class="kv">
        <dt>Klant</dt><dd>${esc(p.customer || '–')}</dd>
        <dt>Adres</dt><dd>${esc(p.address || '–')}</dd>
        ${p.owner ? `<dt>Gebruiker</dt><dd>${esc(p.owner.displayName)}${p.owner.kind === 'gast' ? ' (zonder account)' : ` (${esc(p.owner.username)})`}</dd>` : ''}
        ${contact}
        <dt>Status</dt><dd><span class="pill rv-${esc(r.status)}">${esc(REVIEW[r.status] || r.status)}</span>${r.via === 'openbaar' ? ' ingediend zonder account' : ''}${approved && r.reviewedBy ? ` door ${esc(r.reviewedBy)} op ${esc(when(r.reviewedAt))}` : ''}${r.status === 'ter_controle' && r.requestedAt ? ` sinds ${esc(when(r.requestedAt))}` : ''}</dd>
        ${r.question ? `<dt>Vraag</dt><dd class="wrap">${esc(r.question)}</dd>` : ''}
        <dt>Vlakken</dt><dd>${s.areas ?? 0} (${num(s.totalM2)} m²)</dd>
        ${m2 ? `<dt>Per soort</dt><dd>${m2}</dd>` : ''}
        <dt>Sproeiers</dt><dd>${s.sprinklers ?? 0}</dd>
        <dt>Zones</dt><dd>${s.zones ?? 0}</dd>
        <dt>Elementen</dt><dd>${s.elements ?? 0}</dd>
        <dt>Aangemaakt</dt><dd>${esc(when(p.createdAt))}</dd>
        <dt>Laatst gewijzigd</dt><dd>${esc(when(p.updatedAt))}</dd>
        ${p.deletedAt ? `<dt>Verwijderd</dt><dd>${esc(when(p.deletedAt))}</dd>` : ''}
      </dl>
      <div class="actions">${p.deletedAt ? '' : `<button class="btn primary" id="d-open">${own || state.approver ? (r.status === 'ter_controle' && state.approver ? 'Controleren in de planner' : 'Openen in de planner') : 'Kopie openen in de planner'}</button>
        ${!own && state.approver ? '<button class="btn" id="d-copy">Kopie openen</button>' : ''}
        ${state.approver ? `<button class="btn" id="d-review">${approved ? 'Goedkeuring intrekken' : 'Goedkeuren'}</button>` : ''}
        ${state.quotes && approved ? `<a class="btn" href="../offertes/?plan=${encodeURIComponent(p.id)}">Offerte maken</a>` : ''}`}
        ${state.admin ? '<button class="btn" id="d-purge">Definitief wissen</button>' : ''}</div>
      ${state.admin ? '<h3>Historie</h3><div id="d-history" class="muted small">Laden…</div>' : ''}`;
    const btn = $('#d-open');
    if (btn) btn.onclick = () => openPlan(p);
    const copyBtn = $('#d-copy');
    if (copyBtn) copyBtn.onclick = () => openPlan(p, true);
    const reviewBtn = $('#d-review');
    if (reviewBtn) {
      reviewBtn.onclick = async () => {
        reviewBtn.disabled = true;
        try {
          const res = await fetch(`../api/plans/${encodeURIComponent(p.id)}/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: approved ? 'reopen' : 'approve' }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
          p.review = body.review;
          toast(approved ? 'Goedkeuring ingetrokken' : 'Plan goedgekeurd');
          render();
          showDetail(p.id);
        } catch (e) {
          toast(`Lukt niet: ${e.message}`, true);
          reviewBtn.disabled = false;
        }
      };
    }
    const purge = $('#d-purge');
    if (purge) {
      // AVG-verzoek: plan en de inhoud van de historie (kopieën, klant, adres) weg.
      purge.onclick = async () => {
        if (!confirm(`"${p.title}" definitief wissen, inclusief klantgegevens en kopieën in de historie? Dit kan niet ongedaan worden gemaakt (oude back-ups bevatten het plan nog tot ze verlopen).`)) return;
        try {
          const res = await fetch(`../api/admin/plans/${encodeURIComponent(p.id)}`, { method: 'DELETE', cache: 'no-store' });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
          $('#detail').hidden = true;
          toast('Plan definitief gewist');
          load();
        } catch (e) {
          toast(`Wissen mislukt: ${e.message}`, true);
        }
      };
    }
    $('#detail').hidden = false;
    if (!state.admin) return;
    try {
      const { items } = await getJson(`../api/admin/plans/${encodeURIComponent(p.id)}/history`);
      $('#d-history').innerHTML = items.length ? `<ul class="timeline">${items.map((h) => `
        <li><span class="pill ${esc(h.action)}">${esc(ACTIONS[h.action] || h.action)}</span>
          ${h.user ? esc(h.user.displayName) : ''} · ${esc(h.title)}
          <div class="when">${esc(when(h.createdAt))}${h.updatedAt !== h.createdAt ? ` – ${esc(when(h.updatedAt))}` : ''} · ${h.summary.areas ?? 0} vlakken, ${h.summary.sprinklers ?? 0} sproeiers</div></li>`).join('')}</ul>`
        : 'Geen historie.';
    } catch (e) {
      $('#d-history').textContent = `Kan de historie niet laden (${e.message}).`;
    }
  }

  async function exportXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    const btn = $('#f-export');
    btn.disabled = true;
    try {
      const types = [...new Set(items.flatMap((p) => Object.keys(p.summary.m2ByType || {})))];
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Plannen', { views: [{ state: 'frozen', ySplit: 1 }] });
      const dateFmt = { numFmt: 'dd-mm-yyyy hh:mm' };
      ws.columns = [
        { header: 'Projectnaam', key: 'title', width: 30 },
        { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Adres', key: 'address', width: 30 },
        ...(state.team ? [{ header: 'Gebruiker', key: 'owner', width: 22 }] : []),
        { header: 'Status', key: 'review', width: 14 },
        { header: 'Vraag', key: 'question', width: 36 },
        { header: 'Vlakken', key: 'areas', width: 9 },
        { header: 'Totaal m²', key: 'totalM2', width: 11, style: { numFmt: '0.0' } },
        ...types.map((t) => ({ header: `${areaLabel(t)} m²`, key: `m2_${t}`, width: 14, style: { numFmt: '0.0' } })),
        { header: 'Sproeiers', key: 'sprinklers', width: 10 },
        { header: 'Zones', key: 'zones', width: 8 },
        { header: 'Elementen', key: 'elements', width: 10 },
        { header: 'Aangemaakt', key: 'createdAt', width: 18, style: dateFmt },
        { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: dateFmt },
        ...(state.admin ? [{ header: 'Aanvragen', key: 'historyCount', width: 11 }, { header: 'Verwijderd', key: 'deletedAt', width: 18, style: dateFmt }] : []),
      ];
      for (const p of items) {
        const s = p.summary || {};
        const row = {
          title: p.title, customer: p.customer, address: p.address, owner: p.owner ? p.owner.displayName : '',
          review: REVIEW[reviewOf(p)] || reviewOf(p), question: p.review ? p.review.question : '',
          areas: s.areas, totalM2: s.totalM2, sprinklers: s.sprinklers, zones: s.zones, elements: s.elements,
          createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt), historyCount: p.historyCount,
          deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
        };
        for (const t of types) row[`m2_${t}`] = (s.m2ByType || {})[t];
        ws.addRow(row);
      }
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `plannen_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`${items.length} plannen geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    state.team = rights.includes('plannen.alle');
    state.quotes = rights.includes('offertes');
    state.approver = rights.includes('plannen.goedkeuren');
    $('#p-heading').textContent = state.team ? 'Alle plannen' : 'Mijn plannen';
    $('#p-intro').textContent = state.admin
      ? 'Alle plannen van alle gebruikers. Klik op een plan voor de details en de historie van de aanvragen.'
      : state.team
        ? 'Alle plannen van de organisatie. Klik op een plan voor de details, open het in de planner of maak er een offerte van.'
        : 'Je eigen beregeningsplannen. Klik op een plan voor de details of open het in de planner.';
    $('#f-owner').hidden = !state.team;
    $('#f-deleted-wrap').hidden = !state.admin;
    let t;
    $('#f-search').oninput = () => { clearTimeout(t); t = setTimeout(render, 150); };
    $('#f-owner').onchange = render;
    // Direct naar wat er te controleren is: ?review=ter_controle.
    const wanted = new URLSearchParams(location.search).get('review');
    if (wanted && REVIEW[wanted]) $('#f-review').value = wanted;
    $('#f-review').onchange = render;
    $('#f-deleted').onchange = load;
    $('#f-export').onclick = exportXlsx;
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    $('#detail').onclick = (e) => { if (e.target.id === 'detail') $('#detail').hidden = true; };
    if (!state.me.user && !state.me.guest) {
      $('#p-table').innerHTML = '<tr><td class="empty">Log eerst in om je plannen te zien. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    load();
  }

  init();
})();
