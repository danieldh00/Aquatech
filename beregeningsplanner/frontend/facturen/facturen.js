// Facturen: overzicht (status, periode, zoeken), de factuur zelf (?id=) met
// klant, regels, btw en omzetcategorieën, definitief maken, betaald,
// crediteren, afdrukken als PDF, de export voor de boekhouding (Excel per
// omzetcategorie, Visma eAccounting) en de factuurinstellingen. Gegevens uit
// /api/invoices (recht 'facturen'); rekenwerk in invoice-core.js (gedeeld
// met de server).
(function () {
  const C = window.InvoiceCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (v) => (v == null ? '' : (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }));
  const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const num = (v) => (String(v).trim() === '' ? 0 : Number(String(v).replace(',', '.')) || 0);

  const state = { items: [], tab: 'list', inv: null, settings: null, profile: {}, articles: {}, dirty: false };

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

  const statusPill = (i) => {
    if (i.overdue) return '<span class="pill overdue">Over de vervaldatum</span>';
    return `<span class="pill st-${esc(i.status)}">${esc(C.STATUSES[i.status] || i.status)}</span>`;
  };
  const kindPill = (i) => (i.kind === 'credit' ? ' <span class="pill credit">Credit</span>' : '');

  // ---------- Overzicht ----------
  function visible() {
    const st = $('#f-status').value;
    const s = $('#f-search').value.trim().toLowerCase();
    return state.items.filter((i) => (!st || (st === 'overdue' ? i.overdue : i.status === st))
      && (!s || `${i.number} ${i.customer} ${i.workOrderNumber || ''}`.toLowerCase().includes(s)));
  }

  function renderStats() {
    const open = state.items.filter((i) => i.status === 'definitief');
    const overdue = open.filter((i) => i.overdue);
    const month = C.today().slice(0, 7);
    const thisMonth = state.items.filter((i) => i.status !== 'concept' && i.date.slice(0, 7) === month);
    $('#v-stats').innerHTML = [
      [eur(open.reduce((s, i) => s + i.total, 0)), `openstaand (${open.length})`],
      [eur(overdue.reduce((s, i) => s + i.total, 0)), `over de vervaldatum (${overdue.length})`],
      [eur(thisMonth.reduce((s, i) => s + i.subtotal, 0)), 'gefactureerd deze maand (excl. btw)'],
      [state.items.filter((i) => i.status === 'concept').length, 'concepten'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  }

  function renderList() {
    const t = $('#l-table');
    if (!state.items.length) {
      t.innerHTML = '<tbody><tr><td class="empty">Nog geen facturen. Open een werkorder en kies in het menu <b>Factuur maken</b>, of maak een <b>losse factuur</b>.</td></tr></tbody>';
      return;
    }
    const items = visible();
    t.innerHTML = `<thead><tr><th>Nummer</th><th>Datum</th><th>Klant</th><th>Status</th><th>Vervalt</th><th class="num">Excl. btw</th><th class="num">Totaal</th><th>Geëxporteerd</th></tr></thead>
      <tbody>${items.map((i) => `<tr data-id="${esc(i.id)}">
        <td><b>${esc(i.number || 'Concept')}</b>${kindPill(i)}</td>
        <td>${esc(day(i.date))}</td>
        <td class="wrap">${esc(i.customer || '–')}</td>
        <td>${statusPill(i)}</td>
        <td>${esc(day(i.dueDate))}</td>
        <td class="num${i.subtotal < 0 ? ' neg' : ''}">${esc(eur(i.subtotal))}</td>
        <td class="num${i.total < 0 ? ' neg' : ''}"><b>${esc(eur(i.total))}</b></td>
        <td>${i.exportedAt ? esc(day(i.exportedAt)) : '<span class="muted">–</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">Niets gevonden.</td></tr>'}</tbody>`;
    t.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => openInvoice(tr.dataset.id, true); });
  }

  async function load() {
    const from = $('#f-from').value;
    const to = $('#f-to').value;
    state.items = (await api(`invoices?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).items;
    renderStats();
    renderList();
  }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const n of ['list', 'export', 'settings']) $(`#tab-${n}`).hidden = n !== name;
    if (name === 'settings') renderSettings();
    try { history.replaceState(null, '', `./#${name}`); } catch { /* file:// */ }
  }

  // ---------- Instellingen ----------
  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    const f = $('#s-form');
    f.prefix.value = s.prefix;
    f.paymentDays.value = s.paymentDays;
    f.paymentText.value = s.paymentText;
    f.footer.value = s.footer;
    const example = () => { $('#s-example').textContent = `Volgende nummers zien eruit als ${f.prefix.value.trim()}${C.today().slice(0, 4)}-0001.`; };
    f.prefix.oninput = example;
    example();
    $('#s-cats').innerHTML = `<thead><tr><th>Omzetgroep</th><th>Btw</th><th>Naam in de boekhouding</th><th>Grootboekrekening</th></tr></thead><tbody>${
      Object.entries(C.GROUPS).flatMap(([g, gl]) => C.VAT_RATES.map((r) => {
        const k = C.catKey(g, r);
        return `<tr><td>${esc(gl)}</td><td>${r}%</td><td><input data-k="${k}" data-f="name" maxlength="80" value="${esc(s.categories[k].name)}"></td>
          <td class="acc"><input data-k="${k}" data-f="account" maxlength="20" value="${esc(s.categories[k].account)}" placeholder="bijv. 8000" inputmode="numeric"></td></tr>`;
      })).join('')}</tbody>`;
  }

  function setupSettings() {
    const f = $('#s-form');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('.err', f);
      err.textContent = '';
      const categories = {};
      f.querySelectorAll('#s-cats input').forEach((i) => { (categories[i.dataset.k] = categories[i.dataset.k] || {})[i.dataset.f] = i.value; });
      try {
        state.settings = (await api('invoices/settings', { method: 'PUT', body: {
          prefix: f.prefix.value.trim(), paymentDays: Number(f.paymentDays.value), paymentText: f.paymentText.value, footer: f.footer.value, categories,
        } })).settings;
        renderSettings();
        toast('Instellingen opgeslagen');
      } catch (e) {
        err.textContent = e.message;
      }
    };
  }

  // ---------- Factuur ----------
  const editable = () => state.inv && state.inv.status === 'concept';

  function lineRow(l, ro) {
    const t = C.lineTotal(l);
    if (ro) {
      return `<tr><td class="c-code"><span class="code">${esc(l.code)}</span></td><td class="c-desc">${esc(l.description)}</td><td class="c-qty num">${esc(l.qty)}</td>
        <td class="c-unit">${esc(l.unit)}</td><td class="c-price num">${esc(eur(l.price))}</td><td class="c-vat">${l.vat}%</td><td class="c-group">${esc(C.GROUPS[l.group])}</td>
        <td class="c-total${t < 0 ? ' neg' : ''}">${esc(eur(t))}</td><td class="c-del"></td></tr>`;
    }
    const opt = (o, v) => Object.entries(o).map(([k, lbl]) => `<option value="${esc(k)}"${String(k) === String(v) ? ' selected' : ''}>${esc(lbl)}</option>`).join('');
    return `<tr data-line="${esc(l.id)}">
      <td class="c-code"><input data-f="code" value="${esc(l.code)}" list="article-codes" maxlength="40" placeholder="Code" aria-label="Artikelcode"></td>
      <td class="c-desc"><input data-f="description" value="${esc(l.description)}" maxlength="500" placeholder="Omschrijving" aria-label="Omschrijving"></td>
      <td class="c-qty"><input data-f="qty" value="${esc(l.qty)}" inputmode="decimal" aria-label="Aantal"></td>
      <td class="c-unit"><input data-f="unit" value="${esc(l.unit)}" maxlength="12" placeholder="st" aria-label="Eenheid"></td>
      <td class="c-price"><input data-f="price" value="${esc(l.price)}" inputmode="decimal" aria-label="Prijs excl. btw"></td>
      <td class="c-vat"><select data-f="vat" aria-label="Btw">${opt({ 21: '21%', 9: '9%', 0: '0%' }, l.vat)}</select></td>
      <td class="c-group"><select data-f="group" aria-label="Omzetgroep">${opt(C.GROUPS, l.group)}</select></td>
      <td class="c-total${t < 0 ? ' neg' : ''}">${esc(eur(t))}</td>
      <td class="c-del"><button class="btn small ghost" data-del title="Regel verwijderen" aria-label="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  function renderLines() {
    const d = state.inv.data;
    const ro = !editable();
    $('#e-lines').innerHTML = `<thead><tr><th class="c-code">Code</th><th>Omschrijving</th><th class="c-qty">Aantal</th><th class="c-unit">Eenh.</th><th class="c-price">Prijs excl.</th>
      <th class="c-vat">Btw</th><th class="c-group">Omzetgroep</th><th class="c-total">Totaal</th><th class="c-del"></th></tr></thead>
      <tbody>${d.lines.map((l) => lineRow(l, ro)).join('') || '<tr><td colspan="9" class="empty">Nog geen regels.</td></tr>'}</tbody>`;
    renderTotals();
  }

  function renderTotals() {
    const t = C.totals(state.inv.data, state.settings);
    $('#e-totals').innerHTML = `<div><h4>Omzet per categorie (voor de boekhouding)</h4><table>${t.categories.map((c) => `<tr>
        <td>${esc(c.name)}${c.account ? ` <span class="muted small">(${esc(c.account)})</span>` : ' <span class="muted small">(geen grootboekrekening)</span>'}</td>
        <td class="num">${esc(eur(c.base))}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
      <div><table>
        <tr><td>Subtotaal</td><td class="num">${esc(eur(t.subtotal))}</td></tr>
        ${t.discount ? `<tr><td>Korting ${esc(t.discountPct)}%</td><td class="num">− ${esc(eur(t.discount))}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${esc(eur(t.net))}</td></tr>` : ''}
        ${t.vat.map((v) => `<tr><td>Btw ${v.rate}% over ${esc(eur(v.base))}</td><td class="num">${esc(eur(v.amount))}</td></tr>`).join('')}
        <tr class="grand"><td>Totaal</td><td class="num">${esc(eur(t.total))}</td></tr>
      </table></div>`;
  }

  function renderInvoice() {
    const i = state.inv;
    const d = i.data;
    const ro = !editable();
    $('#e-title').textContent = `${i.kind === 'credit' ? 'Creditfactuur' : 'Factuur'} ${i.number || '(concept)'}`;
    document.title = `${i.number || 'Concept'} – Facturen`;
    $('#e-state').innerHTML = `${statusPill(i)}${i.creditedAt ? ' <span class="pill credit">Gecrediteerd</span>' : ''}${i.exportedAt ? ` <span class="muted small">geëxporteerd ${esc(day(i.exportedAt))}</span>` : ''}`;
    $('#e-save').hidden = ro;
    $('#e-final').hidden = ro;
    $('#e-add').hidden = ro;
    $('#e-del').hidden = ro;
    $('#e-paid').hidden = i.status === 'concept';
    $('#e-paid').textContent = i.status === 'betaald' ? 'Toch niet betaald' : 'Betaald';
    $('#e-credit').hidden = i.status === 'concept' || i.kind === 'credit';
    const links = [];
    if (i.workOrderId) links.push(`Werkorder <a href="../werkorders/?id=${encodeURIComponent(i.workOrderId)}">${esc(d.workOrderNumber || 'openen')}</a>`);
    if (i.quoteId) links.push(`offerte <a href="../offertes/?id=${encodeURIComponent(i.quoteId)}">${esc(d.quoteNumber || 'openen')}</a>`);
    if (i.creditOf) links.push(`credit van <a href="./?id=${encodeURIComponent(i.creditOf)}">${esc(d.creditOfNumber || 'factuur')}</a>`);
    if (i.paidAt) links.push(`betaald op ${esc(day(i.paidAt))}`);
    if (!i.workOrderId && i.status !== 'concept') links.push(i.stockBooked ? 'artikelen van de voorraad afgeboekt' : 'geen voorraad geboekt');
    if (!i.workOrderId && i.status === 'concept') links.push('losse verkoop: bij definitief worden artikelen met een voorraadcode afgeboekt');
    $('#e-links').innerHTML = links.join(' · ');
    const cf = $('#c-form');
    for (const k of ['name', 'contact', 'address', 'email', 'vatNumber']) { cf[k].value = d.customer[k] || ''; cf[k].disabled = ro; }
    const mf = $('#m-form');
    for (const k of ['date', 'dueDate', 'reference', 'intro', 'notes']) { mf[k].value = d[k] || ''; mf[k].disabled = ro; }
    mf.discountPct.value = d.discountPct || '';
    mf.discountPct.disabled = ro;
    $('#article-codes').innerHTML = Object.entries(state.articles).map(([c, a]) => `<option value="${esc(c)}">${esc(a.name)}${a.salePrice != null ? ` – ${esc(eur(a.salePrice))}` : ''}</option>`).join('');
    renderLines();
  }

  function warn(list) {
    const el = $('#e-warn');
    el.hidden = !(list && list.length);
    el.innerHTML = (list || []).map(esc).join('<br>');
  }

  // Formulier -> state.inv.data
  function readForm() {
    const d = state.inv.data;
    const cf = $('#c-form');
    for (const k of ['name', 'contact', 'address', 'email', 'vatNumber']) d.customer[k] = cf[k].value;
    const mf = $('#m-form');
    for (const k of ['date', 'dueDate', 'reference', 'intro', 'notes']) d[k] = mf[k].value;
    d.discountPct = num(mf.discountPct.value);
  }

  function changed() {
    state.dirty = true;
    $('#e-save').textContent = 'Opslaan *';
  }

  async function save() {
    if (!editable()) return true;
    readForm();
    try {
      const out = await api(`invoices/${encodeURIComponent(state.inv.id)}`, { method: 'PUT', body: { data: state.inv.data } });
      state.inv = out;
      state.dirty = false;
      $('#e-save').textContent = 'Opslaan';
      return true;
    } catch (e) {
      toast(`Opslaan mislukt: ${e.message}`, true);
      return false;
    }
  }

  function setupEditor() {
    const back = $('#e-back');
    const from = window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from && new URLSearchParams(location.search).get('id')) {
      back.textContent = from.label;
      back.href = from.href;
      back.onclick = async (e) => { e.preventDefault(); await save(); from.go(); };
    } else {
      back.onclick = async (e) => { e.preventDefault(); await save(); history.pushState(null, '', './'); showList(); load().catch(() => {}); };
    }
    for (const f of [$('#c-form'), $('#m-form')]) {
      f.oninput = () => { changed(); if (f.id === 'm-form') { readForm(); renderTotals(); } };
      f.onsubmit = (ev) => ev.preventDefault();
    }
    $('#m-form').date.onchange = () => {
      const mf = $('#m-form');
      if (C.isDate(mf.date.value)) mf.dueDate.value = C.addDays(mf.date.value, state.settings.paymentDays);
      changed();
    };
    const tbl = $('#e-lines');
    tbl.oninput = (e) => {
      const tr = e.target.closest('tr[data-line]');
      if (!tr) return;
      const l = state.inv.data.lines.find((x) => x.id === tr.dataset.line);
      const f = e.target.dataset.f;
      if (!l || !f) return;
      l[f] = ['qty', 'price', 'vat'].includes(f) ? num(e.target.value) : e.target.value;
      // Bekende artikelcode: omschrijving, eenheid, prijs, btw en groep uit voorraadbeheer.
      if (f === 'code') {
        const a = state.articles[e.target.value.trim().toUpperCase()];
        if (a) {
          Object.assign(l, { code: e.target.value.trim().toUpperCase(), description: l.description || a.name, unit: l.unit || a.unit, vat: a.vatRate, group: a.revenueGroup });
          if (a.salePrice != null && !l.price) l.price = a.salePrice;
          const pos = e.target.selectionStart;
          renderLines();
          const inp = $(`tr[data-line="${l.id}"] input[data-f=code]`);
          if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { /* geen tekstveld */ } }
        }
      }
      const cell = tr.querySelector('.c-total');
      if (cell) cell.textContent = eur(C.lineTotal(l));
      renderTotals();
      changed();
    };
    tbl.onchange = tbl.oninput;
    tbl.onclick = (e) => {
      if (!e.target.closest('[data-del]')) return;
      const tr = e.target.closest('tr[data-line]');
      state.inv.data.lines = state.inv.data.lines.filter((x) => x.id !== tr.dataset.line);
      renderLines();
      changed();
    };
    $('#e-add').onclick = () => {
      state.inv.data.lines.push(C.sanitizeLine({ qty: 1, vat: 21, group: 'producten' }));
      renderLines();
      changed();
      const rows = tbl.querySelectorAll('tr[data-line]');
      if (rows.length) $('input[data-f=code]', rows[rows.length - 1]).focus();
    };
    $('#e-save').onclick = async () => { if (await save()) { renderInvoice(); toast('Opgeslagen'); } };
    $('#e-final').onclick = async () => {
      if (!await save()) return;
      const t = C.totals(state.inv.data, state.settings);
      if (!confirm(`Factuur definitief maken? Totaal ${eur(t.total)}.\n\nHij krijgt dan een factuurnummer en kan niet meer worden aangepast (alleen gecrediteerd).`)) return;
      try {
        state.inv = await api(`invoices/${encodeURIComponent(state.inv.id)}/finalize`, { method: 'POST', body: {} });
        renderInvoice();
        toast(`Factuur ${state.inv.number} is definitief`);
      } catch (e) {
        toast(e.message, true);
      }
    };
    $('#e-paid').onclick = async () => {
      const paid = state.inv.status !== 'betaald';
      try {
        state.inv = await api(`invoices/${encodeURIComponent(state.inv.id)}/paid`, { method: 'POST', body: { paid } });
        renderInvoice();
        toast(paid ? 'Gemarkeerd als betaald' : 'Weer openstaand');
      } catch (e) { toast(e.message, true); }
    };
    $('#e-credit').onclick = async () => {
      if (!confirm(`Een creditfactuur maken voor ${state.inv.number}? Je krijgt een concept met dezelfde regels in min; pas het aan voor een gedeeltelijke creditering.`)) return;
      try {
        const cr = await api(`invoices/${encodeURIComponent(state.inv.id)}/credit`, { method: 'POST', body: {} });
        openInvoice(cr.id, true);
      } catch (e) { toast(e.message, true); }
    };
    $('#e-del').onclick = async () => {
      if (!confirm('Dit concept verwijderen?')) return;
      try {
        await api(`invoices/${encodeURIComponent(state.inv.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast('Concept verwijderd');
        history.pushState(null, '', './');
        showList();
        load().catch(() => {});
      } catch (e) { toast(e.message, true); }
    };
    $('#e-pdf').onclick = printInvoice;
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { save(); e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ---------- Afdrukversie (PDF via de browser) ----------
  function documentHtml(inv) {
    const p = state.profile || {};
    const d = inv.data;
    const t = C.totals(d, state.settings);
    const credit = inv.kind === 'credit';
    const company = [p.address, [p.phone, p.email].filter(Boolean).join(' · '), p.website].filter(Boolean).join('\n');
    const info = [
      [credit ? 'Creditnummer' : 'Factuurnummer', inv.number || 'CONCEPT'],
      ['Factuurdatum', day(d.date)],
      ...(credit ? [['Credit van', d.creditOfNumber]] : [['Vervaldatum', day(d.dueDate)]]),
      ...(d.workOrderNumber ? [['Werkorder', d.workOrderNumber]] : []),
      ...(d.reference ? [['Betreft', d.reference]] : []),
      ...(d.customer.vatNumber ? [['Btw-nummer klant', d.customer.vatNumber]] : []),
    ];
    const foot = [p.companyName, p.kvk ? `KvK ${p.kvk}` : '', p.vatNumber ? `Btw ${p.vatNumber}` : '', p.iban ? `IBAN ${p.iban}` : ''].filter(Boolean).join(' · ');
    return `
      <header class="p-head">
        <img src="../shared/logo-white.png" alt="${esc(p.companyName)}">
        <div class="p-company"><b>${esc(p.companyName)}</b>\n${esc(company)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><span class="lbl">Aan</span>\n<b>${esc(d.customer.name)}</b>${d.customer.contact ? `\nt.a.v. ${esc(d.customer.contact)}` : ''}\n${esc(d.customer.address)}</div>
        <div class="p-info"><table>${info.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
      </div>
      <h1 class="${credit ? 'p-credit' : ''}">${credit ? 'Creditfactuur' : 'Factuur'}${inv.number ? ` ${esc(inv.number)}` : ' (concept)'}</h1>
      ${d.intro ? `<p class="p-text">${esc(d.intro)}</p>` : ''}
      <table class="p-lines">
        <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th class="num">Btw</th><th class="num">Bedrag</th></tr></thead>
        <tbody>${d.lines.map((l) => `<tr><td>${esc(l.description)}${l.code ? ` <span class="muted">(${esc(l.code)})</span>` : ''}</td>
          <td class="num">${esc(String(l.qty).replace('.', ','))}</td><td>${esc(l.unit)}</td><td class="num">${esc(eur(l.price))}</td><td class="num">${l.vat}%</td>
          <td class="num">${esc(eur(C.lineTotal(l)))}</td></tr>`).join('')}</tbody>
      </table>
      <div class="p-end">
        <table class="p-totals">
          <tr><td>Subtotaal</td><td class="num">${esc(eur(t.subtotal))}</td></tr>
          ${t.discount ? `<tr><td>Korting ${esc(t.discountPct)}%</td><td class="num">− ${esc(eur(t.discount))}</td></tr>` : ''}
          ${t.vat.map((v) => `<tr><td>Btw ${v.rate}% over ${esc(eur(v.base))}</td><td class="num">${esc(eur(v.amount))}</td></tr>`).join('')}
          <tr class="grand"><td>Totaal</td><td class="num">${esc(eur(t.total))}</td></tr>
        </table>
        ${d.notes ? `<p class="p-text">${esc(d.notes)}</p>` : ''}
        ${!credit && inv.status !== 'betaald' ? `<div class="p-pay">${esc(C.paymentText(state.settings, { number: inv.number, iban: p.iban, dueDate: day(d.dueDate) }))}</div>` : ''}
        ${inv.status === 'betaald' ? `<div class="p-pay">Deze factuur is voldaan${inv.paidAt ? ` op ${esc(day(inv.paidAt))}` : ''}. Dank u wel.</div>` : ''}
        ${state.settings.footer ? `<p class="p-text small">${esc(state.settings.footer)}</p>` : ''}
      </div>
      <footer class="p-foot">${esc(foot)}</footer>`;
  }

  async function printInvoice() {
    await save();
    $('#print').innerHTML = documentHtml(state.inv);
    const old = document.title;
    const c = state.inv.data.customer.name;
    document.title = `${state.inv.kind === 'credit' ? 'Creditfactuur' : 'Factuur'} ${state.inv.number || 'concept'}${c ? ` ${c}` : ''}`;
    const img = $('#print img');
    if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    window.print();
    setTimeout(() => { document.title = old; }, 500);
  }

  async function openInvoice(id, push = false, pending = null) {
    try {
      state.inv = await (pending || api(`invoices/${encodeURIComponent(id)}`));
    } catch (e) {
      toast(e.status === 404 ? 'Factuur niet gevonden.' : e.message, true);
      showList();
      return;
    }
    if (push) history.pushState(null, '', `./?id=${encodeURIComponent(id)}`);
    state.dirty = false;
    $('#e-save').textContent = 'Opslaan';
    $('#v-list').hidden = true;
    $('#v-edit').hidden = false;
    warn(state.inv.warnings);
    renderInvoice();
    window.scrollTo(0, 0);
  }

  function showList() {
    $('#v-edit').hidden = true;
    $('#v-list').hidden = false;
    document.title = 'Facturen – AquaTech Service';
  }

  // ---------- Export voor de boekhouding (Excel) ----------
  async function exportExcel(ev) {
    ev.preventDefault();
    const f = $('#x-form');
    const err = $('.err', f);
    err.textContent = '';
    $('#x-result').textContent = '';
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    try {
      const out = await api(`invoices/export?from=${encodeURIComponent(f.from.value)}&to=${encodeURIComponent(f.to.value)}${f.onlyNew.checked ? '&new=1' : ''}`);
      if (!out.items.length) { err.textContent = 'Geen facturen om te exporteren in deze periode.'; return; }
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { err.textContent = 'Excel-export niet beschikbaar.'; return; }
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const money = { numFmt: '€ #,##0.00' };
      const date = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);
      const bold = (ws, cols) => { ws.getRow(1).font = { bold: true }; ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + cols)}1` }; };

      // 1. Omzetregels: per factuur per omzetcategorie (verkoopboeking).
      const rows = C.exportRows(out.items, out.settings);
      const ws = wb.addWorksheet('Omzetregels', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
        { header: 'Factuurnummer', key: 'number', width: 15 }, { header: 'Soort', key: 'kind', width: 13 },
        { header: 'Factuurdatum', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Vervaldatum', key: 'dueDate', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Debiteur', key: 'customer', width: 30 }, { header: 'Omschrijving', key: 'reference', width: 30 },
        { header: 'Omzetcategorie', key: 'category', width: 30 }, { header: 'Grootboekrekening', key: 'account', width: 18 },
        { header: 'Btw-tarief', key: 'rate', width: 10 }, { header: 'Bedrag excl. btw', key: 'base', width: 16, style: money },
        { header: 'Btw', key: 'vat', width: 12, style: money }, { header: 'Bedrag incl. btw', key: 'total', width: 16, style: money },
      ];
      for (const r of rows) ws.addRow({ ...r, kind: C.KINDS[r.kind] || r.kind, date: date(r.date), dueDate: date(r.dueDate), rate: `${r.rate}%` });
      bold(ws, 12);

      // 2. Facturen: één regel per factuur.
      const fs = wb.addWorksheet('Facturen', { views: [{ state: 'frozen', ySplit: 1 }] });
      fs.columns = [
        { header: 'Factuurnummer', key: 'number', width: 15 }, { header: 'Soort', key: 'kind', width: 13 },
        { header: 'Factuurdatum', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Vervaldatum', key: 'dueDate', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Debiteur', key: 'customer', width: 30 }, { header: 'Status', key: 'status', width: 12 },
        { header: 'Excl. btw', key: 'net', width: 14, style: money }, { header: 'Btw 21%', key: 'v21', width: 12, style: money },
        { header: 'Btw 9%', key: 'v9', width: 12, style: money }, { header: 'Totaal', key: 'total', width: 14, style: money },
        { header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Betaald op', key: 'paid', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
      ];
      for (const i of out.items) {
        const t = C.totals(i.data, out.settings);
        const v = (rate) => (t.vat.find((x) => x.rate === rate) || {}).amount || 0;
        fs.addRow({ number: i.number, kind: C.KINDS[i.kind], date: date(i.data.date), dueDate: date(i.data.dueDate), customer: i.data.customer.name,
          status: C.STATUSES[i.status], net: t.net, v21: v(21), v9: v(9), total: t.total, wo: i.data.workOrderNumber, paid: i.paidAt ? date(i.paidAt.slice(0, 10)) : null });
      }
      bold(fs, 12);

      // 3. Totalen per omzetcategorie (controle tegen de boekhouding).
      const ts = wb.addWorksheet('Totalen per categorie');
      ts.columns = [
        { header: 'Omzetcategorie', key: 'category', width: 32 }, { header: 'Grootboekrekening', key: 'account', width: 18 },
        { header: 'Btw-tarief', key: 'rate', width: 10 }, { header: 'Bedrag excl. btw', key: 'base', width: 16, style: money },
        { header: 'Btw', key: 'vat', width: 12, style: money }, { header: 'Bedrag incl. btw', key: 'total', width: 16, style: money },
      ];
      const sums = new Map();
      for (const r of rows) {
        const k = `${r.category}|${r.account}|${r.rate}`;
        const s = sums.get(k) || { category: r.category, account: r.account, rate: `${r.rate}%`, base: 0, vat: 0, total: 0 };
        s.base = C.round2(s.base + r.base); s.vat = C.round2(s.vat + r.vat); s.total = C.round2(s.total + r.total);
        sums.set(k, s);
      }
      for (const s of sums.values()) ts.addRow(s);
      ts.getRow(1).font = { bold: true };

      // 4. Debiteuren (om in Visma aan te maken of te controleren).
      const ds = wb.addWorksheet('Debiteuren');
      ds.columns = [{ header: 'Naam', key: 'name', width: 32 }, { header: 'T.a.v.', key: 'contact', width: 22 }, { header: 'Adres', key: 'address', width: 40 },
        { header: 'E-mail', key: 'email', width: 28 }, { header: 'Telefoon', key: 'phone', width: 14 }, { header: 'Btw-nummer', key: 'vatNumber', width: 18 }];
      const seen = new Set();
      for (const i of out.items) {
        const c = i.data.customer;
        const k = c.name.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        ds.addRow({ ...c, address: c.address.replace(/\n/g, ', ') });
      }
      ds.getRow(1).font = { bold: true };

      const buf = await wb.xlsx.writeBuffer();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = `facturen-boekhouding-${f.from.value || 'begin'}-${f.to.value || C.today()}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      const missing = rows.filter((r) => !r.account).length;
      $('#x-result').innerHTML = `${out.items.length} facturen, ${rows.length} omzetregels geëxporteerd.${missing ? ` <b>${missing} regels zonder grootboekrekening</b>: vul die in bij Instellingen.` : ''}`;
      if (out.items.some((i) => !i.exportedAt) && confirm(`${out.items.length} facturen markeren als geëxporteerd? Dan komen ze niet nog eens mee bij "alleen nog niet geëxporteerd".`)) {
        const m = await api('invoices/export/mark', { method: 'POST', body: { ids: out.items.map((i) => i.id) } });
        toast(`${m.marked} facturen gemarkeerd als geëxporteerd`);
        load().catch(() => {});
      }
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Start ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    // De factuur en de instellingen al ophalen terwijl de login-check loopt.
    const pending = id ? api(`invoices/${encodeURIComponent(id)}`) : null;
    if (pending) pending.catch(() => {});
    const pendingConf = api('invoices/settings');
    const pendingArts = api('invoices/articles');
    pendingConf.catch(() => {});
    pendingArts.catch(() => {});
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('facturen')) {
      const d = $('#v-denied');
      d.hidden = false;
      d.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Je rol heeft geen toegang tot de facturen. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    try {
      const [conf, arts] = await Promise.all([pendingConf, pendingArts]);
      state.settings = conf.settings;
      state.profile = conf.profile || {};
      state.articles = arts.articles || {};
    } catch (e) {
      toast(e.message, true);
      state.settings = C.sanitizeSettings({});
    }
    document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
    $('#f-status').onchange = renderList;
    $('#f-search').oninput = renderList;
    $('#f-from').onchange = () => load().catch((e) => toast(e.message, true));
    $('#f-to').onchange = $('#f-from').onchange;
    $('#b-new').onclick = async () => {
      try {
        const inv = await api('invoices', { method: 'POST', body: { data: { lines: [] } } });
        openInvoice(inv.id, true);
      } catch (e) { toast(e.message, true); }
    };
    $('#x-form').onsubmit = exportExcel;
    setupSettings();
    setupEditor();
    window.addEventListener('popstate', () => {
      const pid = new URLSearchParams(location.search).get('id');
      if (pid) openInvoice(pid); else { showList(); load().catch(() => {}); }
    });
    if (id) {
      await openInvoice(id, false, pending);
    } else {
      $('#v-list').hidden = false;
      try { await load(); } catch (e) { toast(e.message, true); }
      const hash = location.hash.slice(1);
      if (['list', 'export', 'settings'].includes(hash)) showTab(hash);
    }
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(() => {
        if (state.inv && !$('#v-edit').hidden && !state.dirty) openInvoice(state.inv.id);
        else if ($('#v-edit').hidden) load().catch(() => {});
      });
    }
  }

  init();
})();
