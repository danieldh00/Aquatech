// Voorraadbeheer: overzicht van de voorraad (stand, gereserveerd, beschikbaar),
// de reserveringen van open werkorders, het logboek met mutaties en per
// artikel (?id=) de gegevens, mutaties boeken (ontvangst, telling, correctie)
// en de geschiedenis. Gegevens uit /api/stock (recht 'voorraad'). Artikelcodes
// zijn die van de catalogus (window.Catalog), zodat stuklijst, offerte en
// werkorder vanzelf aan de voorraad gekoppeld zijn. Export als Excel.
(function () {
  const W = window.WorkOrderCore;
  const C = window.Catalog || { articles: {} };
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 3) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const eur = (v) => (v == null ? '' : (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const day = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const num = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(',', '.')));
  const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };

  const state = { items: [], reservations: [], moves: null, tab: 'stock', item: null };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error, field: out.field, status: res.status });
    return out;
  }

  const woLink = (w) => (w && w.id ? `<a href="../werkorders/?id=${encodeURIComponent(w.id)}">${esc(w.number || 'werkorder')}</a>` : '');
  const kindPill = (k) => `<span class="pill k-${esc(k)}">${esc(KINDS[k] || k)}</span>`;

  // ---------- Overzicht ----------
  function visible() {
    const s = $('#f-search').value.trim().toLowerCase();
    const low = $('#f-low').checked;
    return state.items.filter((i) => (!low || i.low) && (!s || `${i.code} ${i.name} ${i.location}`.toLowerCase().includes(s)));
  }

  function renderStats() {
    const live = state.items.filter((i) => !i.archived);
    const value = live.reduce((s, i) => s + (i.value || 0), 0);
    const orders = new Set(state.reservations.map((r) => r.workOrder.id)).size;
    $('#v-stats').innerHTML = [
      [live.length, 'artikelen op voorraad'],
      [live.filter((i) => i.low).length, 'onder de minimumvoorraad'],
      [live.filter((i) => i.available < 0).length, 'met tekort (meer gereserveerd dan er ligt)'],
      [orders, 'open werkorders met een reservering'],
      [eur(value), 'voorraadwaarde (inkoop)'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#t-reserved').textContent = state.reservations.length ? String(state.reservations.length) : '';
  }

  function renderStock() {
    const t = $('#s-table');
    if (!state.items.length) {
      t.innerHTML = '<tbody><tr><td class="empty">Nog geen voorraadartikelen. Kies <b>Uit catalogus</b> om artikelen uit de stuklijst op voorraad te nemen, of <b>+ Artikel</b> voor een eigen artikel.</td></tr></tbody>';
      return;
    }
    const items = visible();
    t.innerHTML = `<thead><tr><th>Artikel</th><th>Locatie</th><th class="num">Op voorraad</th><th class="num">Gereserveerd</th><th class="num">Beschikbaar</th><th class="num">Minimum</th><th class="num">Waarde</th></tr></thead>
      <tbody>${items.map((i) => `<tr data-id="${esc(i.id)}" class="${i.low ? 'low' : ''}${i.archived ? ' arch' : ''}">
        <td class="wrap"><b class="code">${esc(i.code)}</b>${i.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}<span class="sub">${esc(i.name)}</span></td>
        <td>${esc(i.location)}</td>
        <td class="num${i.onHand < 0 ? ' neg' : ''}">${esc(nl(i.onHand))} ${esc(i.unit)}</td>
        <td class="num">${i.reserved ? `${esc(nl(i.reserved))}<span class="sub">${i.orders} werkorder${i.orders === 1 ? '' : 's'}</span>` : ''}</td>
        <td class="num avail">${esc(nl(i.available))}${i.low ? ' <span class="pill low">Bijbestellen</span>' : ''}</td>
        <td class="num">${i.minQty ? esc(nl(i.minQty)) : ''}</td>
        <td class="num">${esc(eur(i.value))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Niets gevonden.</td></tr>'}</tbody>`;
    t.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => openItem(tr.dataset.id, true); });
  }

  function renderReserved() {
    const t = $('#r-table');
    if (!state.reservations.length) {
      t.innerHTML = '<tbody><tr><td class="empty">Er staat niets gereserveerd.</td></tr></tbody>';
      return;
    }
    t.innerHTML = `<thead><tr><th>Werkorder</th><th>Status</th><th>Gepland</th><th>Artikel</th><th class="num">Gereserveerd</th></tr></thead>
      <tbody>${state.reservations.map((r) => `<tr>
        <td class="wrap">${woLink(r.workOrder)}<span class="sub">${esc(r.workOrder.title)}${r.workOrder.customer ? ` · ${esc(r.workOrder.customer)}` : ''}</span></td>
        <td><span class="pill wo-${esc(r.workOrder.status)}">${esc((W && W.STATUSES[r.workOrder.status]) || r.workOrder.status)}</span></td>
        <td>${esc(day(r.workOrder.plannedDate)) || '<span class="muted">–</span>'}</td>
        <td class="wrap"><span class="code">${esc(r.code)}</span><span class="sub">${esc(r.name)}</span></td>
        <td class="num">${esc(nl(r.qty))} ${esc(r.unit)}</td>
      </tr>`).join('')}</tbody>`;
  }

  async function loadMoves() {
    const from = $('#m-from').value;
    const to = $('#m-to').value;
    try {
      state.moves = (await api(`stock/movements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).items;
    } catch (e) {
      toast(e.message, true);
      state.moves = [];
    }
    renderMoves();
  }

  const movesShown = () => {
    const k = $('#m-kind').value;
    return (state.moves || []).filter((m) => !k || m.kind === k);
  };

  function renderMoves() {
    const t = $('#m-table');
    const items = movesShown();
    t.innerHTML = items.length ? `<thead><tr><th>Datum</th><th>Soort</th><th>Artikel</th><th class="num">Aantal</th><th class="num">Stand</th><th>Werkorder</th><th>Door</th><th>Opmerking</th></tr></thead>
      <tbody>${items.map((m) => `<tr>
        <td>${esc(when(m.createdAt))}</td><td>${kindPill(m.kind)}</td>
        <td class="wrap"><span class="code">${esc(m.code)}</span><span class="sub">${esc(m.name)}</span></td>
        <td class="num${m.qty < 0 ? ' neg' : ''}">${m.qty > 0 ? '+' : ''}${esc(nl(m.qty))} ${esc(m.unit)}</td>
        <td class="num">${esc(nl(m.balance))}</td>
        <td>${m.workOrderId ? woLink({ id: m.workOrderId, number: m.workOrderNumber }) : ''}</td>
        <td>${esc(m.userName)}</td><td class="wrap">${esc(m.note)}</td>
      </tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">Geen mutaties in deze periode.</td></tr></tbody>';
  }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const n of ['stock', 'reserved', 'moves']) $(`#tab-${n}`).hidden = n !== name;
    if (name === 'moves' && !state.moves) loadMoves();
    try { history.replaceState(null, '', `./#${name}`); } catch { /* file:// */ }
  }

  async function load() {
    const [stock, res] = await Promise.all([api(`stock${$('#f-archived').checked ? '?archived=1' : ''}`), api('stock/reservations')]);
    state.items = stock.items;
    state.reservations = res.items;
    renderStats();
    renderStock();
    renderReserved();
    if (state.moves) loadMoves();
  }

  // ---------- Nieuw artikel en uit de catalogus ----------
  function openNew() {
    const f = $('#new-form');
    $('#import-form').hidden = true;
    f.reset();
    $('.err', f).textContent = '';
    const have = new Set(state.items.map((i) => i.code));
    $('#catalog-codes').innerHTML = Object.entries(C.articles).filter(([c]) => !have.has(c)).map(([c, a]) => `<option value="${esc(c)}">${esc(a.name)}</option>`).join('');
    f.hidden = false;
    f.code.focus();
  }

  function setupNew() {
    const f = $('#new-form');
    f.code.oninput = () => {
      const a = C.articles[f.code.value.trim().toUpperCase()];
      if (a && !f.name.value) { f.name.value = a.name; f.unit.value = a.unit || 'st'; }
    };
    $('[data-cancel]', f).onclick = () => { f.hidden = true; };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('.err', f);
      err.textContent = '';
      try {
        const item = await api('stock/items', { method: 'POST', body: {
          code: f.code.value, name: f.name.value, unit: f.unit.value, location: f.location.value,
          onHand: num(f.onHand.value), minQty: num(f.minQty.value), costPrice: num(f.costPrice.value),
        } });
        f.hidden = true;
        toast(`${item.code} toegevoegd`);
        await load();
      } catch (e) {
        err.textContent = e.message;
        if (e.field && f[e.field]) f[e.field].focus();
      }
    };
  }

  function openImport(preselect = []) {
    const f = $('#import-form');
    $('#new-form').hidden = true;
    $('.err', f).textContent = '';
    const have = new Set(state.items.map((i) => i.code));
    const pre = new Set(preselect.map((c) => c.toUpperCase()));
    $('#i-list').innerHTML = Object.entries(C.articles).map(([c, a]) => (have.has(c)
      ? `<label class="have"><input type="checkbox" disabled checked> <span><span class="code">${esc(c)}</span> ${esc(a.name)} (al op voorraad)</span></label>`
      : `<label data-s="${esc(`${c} ${a.name}`.toLowerCase())}"><input type="checkbox" value="${esc(c)}"${pre.has(c) ? ' checked' : ''}> <span><span class="code">${esc(c)}</span> ${esc(a.name)}</span></label>`)).join('');
    $('#i-search').value = '';
    f.hidden = false;
    if (pre.size) f.scrollIntoView();
  }

  function setupImport() {
    const f = $('#import-form');
    $('[data-cancel]', f).onclick = () => { f.hidden = true; };
    $('#i-search').oninput = () => {
      const s = $('#i-search').value.trim().toLowerCase();
      f.querySelectorAll('#i-list label[data-s]').forEach((l) => { l.hidden = Boolean(s) && !l.dataset.s.includes(s); });
    };
    $('#i-all').onclick = () => f.querySelectorAll('#i-list label[data-s]:not([hidden]) input').forEach((i) => { i.checked = true; });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const codes = [...f.querySelectorAll('#i-list input:checked:not([disabled])')].map((i) => i.value);
      const err = $('.err', f);
      if (!codes.length) { err.textContent = 'Kies een of meer artikelen.'; return; }
      try {
        const out = await api('stock/import', { method: 'POST', body: { codes } });
        f.hidden = true;
        toast(`${out.created} artikel${out.created === 1 ? '' : 'en'} op voorraad genomen`);
        await load();
      } catch (e) {
        err.textContent = e.message;
      }
    };
  }

  // ---------- Artikel ----------
  function renderItem() {
    const i = state.item;
    $('#d-title').innerHTML = `<span class="code">${esc(i.code)}</span> ${esc(i.name)}${i.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}`;
    document.title = `${i.code} – Voorraadbeheer`;
    $('#d-stats').innerHTML = [
      [`${nl(i.onHand)} ${i.unit}`, 'op voorraad'],
      [nl(i.reserved), `gereserveerd (${i.orders} werkorder${i.orders === 1 ? '' : 's'})`],
      [nl(i.available), i.low ? 'beschikbaar: onder het minimum' : 'beschikbaar'],
      [i.location || '–', 'locatie'],
      [eur(i.value) || '–', 'waarde (inkoop)'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    const f = $('#edit-form');
    for (const k of ['code', 'name', 'unit', 'location', 'notes']) f[k].value = i[k] || '';
    f.minQty.value = i.minQty || '';
    f.costPrice.value = i.costPrice == null ? '' : i.costPrice;
    $('#d-remove').hidden = i.archived;
    $('#d-restore').hidden = !i.archived;
    $('#move-form').hidden = i.archived;
    $('#d-res').innerHTML = i.reservations.length ? `<thead><tr><th>Werkorder</th><th>Status</th><th>Gepland</th><th class="num">Gereserveerd</th></tr></thead>
      <tbody>${i.reservations.map((r) => `<tr><td class="wrap">${woLink(r.workOrder)}<span class="sub">${esc(r.workOrder.title)}</span></td>
        <td><span class="pill wo-${esc(r.workOrder.status)}">${esc((W && W.STATUSES[r.workOrder.status]) || r.workOrder.status)}</span></td>
        <td>${esc(day(r.workOrder.plannedDate))}</td><td class="num">${esc(nl(r.qty))} ${esc(i.unit)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Niet gereserveerd.</td></tr></tbody>';
    $('#d-moves').innerHTML = i.movements.length ? `<thead><tr><th>Datum</th><th>Soort</th><th class="num">Aantal</th><th class="num">Stand</th><th>Werkorder</th><th>Door</th><th>Opmerking</th></tr></thead>
      <tbody>${i.movements.map((m) => `<tr><td>${esc(when(m.createdAt))}</td><td>${kindPill(m.kind)}</td>
        <td class="num${m.qty < 0 ? ' neg' : ''}">${m.qty > 0 ? '+' : ''}${esc(nl(m.qty))}</td><td class="num">${esc(nl(m.balance))}</td>
        <td>${m.workOrderId ? woLink({ id: m.workOrderId, number: m.workOrderNumber }) : ''}</td><td>${esc(m.userName)}</td><td class="wrap">${esc(m.note)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Nog geen mutaties.</td></tr></tbody>';
  }

  async function openItem(id, push = false, pending = null) {
    try {
      state.item = await (pending || api(`stock/items/${encodeURIComponent(id)}`));
    } catch (e) {
      toast(e.status === 404 ? 'Artikel niet gevonden.' : e.message, true);
      showList();
      return;
    }
    if (push) history.pushState(null, '', `./?id=${encodeURIComponent(id)}`);
    $('#v-list').hidden = true;
    $('#v-item').hidden = false;
    renderItem();
    window.scrollTo(0, 0);
  }

  function showList() {
    $('#v-item').hidden = true;
    $('#v-list').hidden = false;
    document.title = 'Voorraadbeheer – AquaTech Service';
  }

  function setupItem() {
    const back = $('#d-back');
    const from = window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from && new URLSearchParams(location.search).get('id')) {
      back.textContent = from.label;
      back.href = from.href;
      back.onclick = (e) => { e.preventDefault(); from.go(); };
    } else {
      back.onclick = (e) => { e.preventDefault(); history.pushState(null, '', `./#${state.tab}`); showList(); load().catch(() => {}); };
    }
    const mf = $('#move-form');
    mf.kind.onchange = () => { mf.qty.min = mf.kind.value === 'correctie' ? '' : '0'; };
    mf.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('.err', mf);
      err.textContent = '';
      const qty = num(mf.qty.value);
      if (qty === null || !Number.isFinite(qty)) { err.textContent = 'Vul een aantal in.'; return; }
      try {
        state.item = await api(`stock/items/${encodeURIComponent(state.item.id)}/movements`, { method: 'POST', body: { kind: mf.kind.value, qty, note: mf.note.value } });
        mf.qty.value = '';
        mf.note.value = '';
        renderItem();
        toast('Geboekt');
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const ef = $('#edit-form');
    ef.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('.err', ef);
      err.textContent = '';
      try {
        state.item = { ...state.item, ...await api(`stock/items/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body: {
          code: ef.code.value, name: ef.name.value, unit: ef.unit.value, location: ef.location.value, notes: ef.notes.value,
          minQty: num(ef.minQty.value), costPrice: num(ef.costPrice.value),
        } }) };
        renderItem();
        toast('Opgeslagen');
      } catch (e) {
        err.textContent = e.message;
      }
    };
    $('#d-remove').onclick = async () => {
      const i = state.item;
      if (!confirm(`${i.code} verwijderen?\n\nHeeft het artikel al mutaties, dan wordt het gearchiveerd (het logboek blijft bewaard). Reserveringen op werkorders vervallen.`)) return;
      try {
        const out = await api(`stock/items/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
        toast(out.archived ? `${i.code} gearchiveerd` : `${i.code} verwijderd`);
        history.pushState(null, '', './');
        showList();
        await load();
      } catch (e) {
        toast(e.message, true);
      }
    };
    $('#d-restore').onclick = async () => {
      try {
        state.item = { ...state.item, ...await api(`stock/items/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body: { archived: false } }) };
        renderItem();
        toast('Teruggezet');
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  // ---------- Excel ----------
  async function workbook() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return null; }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AquaTech Service';
    wb.created = new Date();
    return wb;
  }

  function movesSheet(wb, items) {
    const ws = wb.addWorksheet('Mutaties', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Datum', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      { header: 'Soort', key: 'kind', width: 12 },
      { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Omschrijving', key: 'name', width: 40 },
      { header: 'Aantal', key: 'qty', width: 10, style: { numFmt: '#,##0.###' } },
      { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Stand na mutatie', key: 'balance', width: 16, style: { numFmt: '#,##0.###' } },
      { header: 'Werkorder', key: 'wo', width: 14 },
      { header: 'Door', key: 'user', width: 20 },
      { header: 'Opmerking', key: 'note', width: 40 },
    ];
    for (const m of items) {
      ws.addRow({ at: new Date(m.createdAt), kind: KINDS[m.kind] || m.kind, code: m.code, name: m.name, qty: m.qty, unit: m.unit, balance: m.balance,
        wo: m.workOrderNumber, user: m.userName, note: m.note });
    }
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: 'A1', to: 'J1' };
  }

  async function save(wb, name) {
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  async function exportStock() {
    const btn = $('#b-export');
    btn.disabled = true;
    try {
      const wb = await workbook();
      if (!wb) return;
      const ws = wb.addWorksheet('Voorraad', { views: [{ state: 'frozen', ySplit: 1 }] });
      const q = { numFmt: '#,##0.###' };
      ws.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Omschrijving', key: 'name', width: 44 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Locatie', key: 'location', width: 18 },
        { header: 'Op voorraad', key: 'onHand', width: 13, style: q },
        { header: 'Gereserveerd', key: 'reserved', width: 13, style: q },
        { header: 'Beschikbaar', key: 'available', width: 13, style: q },
        { header: 'Minimum', key: 'minQty', width: 11, style: q },
        { header: 'Bijbestellen', key: 'low', width: 12 },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Waarde', key: 'value', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Gearchiveerd', key: 'archived', width: 13 },
        { header: 'Notities', key: 'notes', width: 30 },
      ];
      for (const i of visible()) {
        ws.addRow({ ...i, low: i.low ? 'ja' : '', archived: i.archived ? 'ja' : '', costPrice: i.costPrice, value: i.value });
      }
      ws.getRow(1).font = { bold: true };
      ws.autoFilter = { from: 'A1', to: 'M1' };
      const rs = wb.addWorksheet('Gereserveerd', { views: [{ state: 'frozen', ySplit: 1 }] });
      rs.columns = [
        { header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Titel', key: 'title', width: 30 }, { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Status', key: 'status', width: 14 }, { header: 'Gepland', key: 'date', width: 12 },
        { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 40 },
        { header: 'Gereserveerd', key: 'qty', width: 13, style: q }, { header: 'Eenheid', key: 'unit', width: 9 },
      ];
      for (const r of state.reservations) {
        rs.addRow({ wo: r.workOrder.number, title: r.workOrder.title, customer: r.workOrder.customer, status: (W && W.STATUSES[r.workOrder.status]) || r.workOrder.status,
          date: r.workOrder.plannedDate ? new Date(`${r.workOrder.plannedDate}T12:00:00`) : null, code: r.code, name: r.name, qty: r.qty, unit: r.unit });
      }
      rs.getColumn('date').numFmt = 'dd-mm-yyyy';
      rs.getRow(1).font = { bold: true };
      await save(wb, `voorraad-${stamp()}.xlsx`);
    } finally {
      btn.disabled = false;
    }
  }

  async function exportMoves() {
    const btn = $('#m-export');
    btn.disabled = true;
    try {
      if (!state.moves) await loadMoves();
      const wb = await workbook();
      if (!wb) return;
      movesSheet(wb, movesShown());
      await save(wb, `voorraadmutaties-${$('#m-from').value || 'begin'}-${$('#m-to').value || stamp()}.xlsx`);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Start ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    // Het artikel zelf al ophalen terwijl de login-check loopt.
    const pendingItem = id ? api(`stock/items/${encodeURIComponent(id)}`) : null;
    if (pendingItem) pendingItem.catch(() => {});
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('voorraad')) {
      const d = $('#v-denied');
      d.hidden = false;
      d.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Je rol heeft geen toegang tot voorraadbeheer. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    $('#m-kind').innerHTML += Object.entries(KINDS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
    $('#f-search').oninput = renderStock;
    $('#f-low').onchange = renderStock;
    $('#f-archived').onchange = () => load().catch((e) => toast(e.message, true));
    $('#b-new').onclick = openNew;
    $('#b-import').onclick = () => openImport();
    $('#b-export').onclick = () => exportStock().catch((e) => toast(`Export mislukt: ${e.message}`, true));
    $('#m-export').onclick = () => exportMoves().catch((e) => toast(`Export mislukt: ${e.message}`, true));
    $('#m-from').onchange = loadMoves;
    $('#m-to').onchange = loadMoves;
    $('#m-kind').onchange = renderMoves;
    $('#b-resync').onclick = async () => {
      try {
        const out = await api('stock/resync', { method: 'POST', body: {} });
        toast(`Reserveringen van ${out.workOrders} werkorder${out.workOrders === 1 ? '' : 's'} bijgewerkt`);
        await load();
      } catch (e) { toast(e.message, true); }
    };
    setupNew();
    setupImport();
    setupItem();
    window.addEventListener('popstate', () => {
      const pid = new URLSearchParams(location.search).get('id');
      if (pid) openItem(pid); else { showList(); load().catch(() => {}); }
    });
    if (id) {
      await openItem(id, false, pendingItem);
      load().catch(() => {});
    } else {
      $('#v-list').hidden = false;
      try { await load(); } catch (e) { toast(e.message, true); }
      const hash = location.hash.slice(1);
      if (['stock', 'reserved', 'moves'].includes(hash)) showTab(hash);
      // Vanuit een werkorder: "Op voorraad nemen" met de ontbrekende codes.
      const codes = (params.get('codes') || '').split(',').map((c) => c.trim()).filter((c) => C.articles[c.toUpperCase()]);
      if (codes.length) openImport(codes);
    }
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(() => {
        if (state.item && !$('#v-item').hidden) openItem(state.item.id);
        else load().catch(() => {});
      });
    }
  }

  init();
})();
