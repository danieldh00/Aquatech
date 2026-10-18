// Offertes: overzicht, een offerte opbouwen uit een beregeningsplan, bewerken
// (klant, regels, korting, btw, teksten), en exporteren als PDF (afdrukversie
// via de browser) of Excel. De server bewaart de offertes (/api/quotes) en
// rekent de totalen voor het overzicht zelf na met dezelfde rekenkern.
// Rollen (shared/roles.js): beheerders en installateurs stellen offertes op;
// een klant ziet alleen de verzonden offertes voor zijn account, als
// document, en geeft akkoord of wijst af.
(function () {
  const Q = window.QuoteCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (v) => (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '–');
  const expired = (q) => q.status !== 'akkoord' && q.status !== 'afgewezen' && q.validUntil && q.validUntil < Q.today();
  const statusOf = (q) => (expired(q) ? 'verlopen' : q.status);
  const statusLabel = (s) => (s === 'verlopen' ? 'Verlopen' : Q.STATUSES[s] || s);

  const state = {
    me: null, admin: false, all: false, klant: false, customers: [], profile: null, canEdit: false,
    items: [], sort: { key: 'updatedAt', dir: -1 },
    quote: null, saveT: null, saving: null, dirty: false, warnings: [],
  };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast screen show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast screen'; }, 3500);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
    return out;
  }

  const params = () => new URLSearchParams(location.search);
  function go(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Overzicht ----------
  const COLUMNS = [
    { key: 'number', label: 'Nummer', value: (q) => q.number, html: (q) => `<b>${esc(q.number)}</b>` },
    { key: 'title', label: 'Omschrijving', value: (q) => q.title, html: (q) => `${esc(q.title)}${q.customer ? `<span class="sub">${esc(q.customer)}</span>` : ''}`, cls: 'wrap' },
    { key: 'owner', label: 'Gebruiker', admin: true, value: (q) => (q.owner ? q.owner.displayName : ''), html: (q) => esc(q.owner ? q.owner.displayName : '–') },
    { key: 'status', label: 'Status', value: statusOf, html: (q) => `<span class="pill ${esc(statusOf(q))}">${esc(statusLabel(statusOf(q)))}</span>` },
    { key: 'totalExcl', label: 'Excl. btw', value: (q) => q.totalExcl, html: (q) => eur(q.totalExcl), cls: 'num' },
    { key: 'totalIncl', label: 'Incl. btw', value: (q) => q.totalIncl, html: (q) => eur(q.totalIncl), cls: 'num' },
    { key: 'validUntil', label: 'Geldig tot', value: (q) => q.validUntil, html: (q) => esc(shortDate(q.validUntil)) },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (q) => q.updatedAt, html: (q) => esc(new Date(q.updatedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })) },
  ];
  const showAll = () => state.all && $('#l-all').checked;
  const columns = () => COLUMNS.filter((c) => !c.admin || showAll());

  async function loadList() {
    try {
      state.items = (await api(`quotes${showAll() ? '?all=1' : ''}`)).items || [];
    } catch (e) {
      $('#l-table').innerHTML = `<tr><td class="empty">Kan de offertes niet laden (${esc(e.message)}).</td></tr>`;
      return;
    }
    renderList();
  }

  function visible() {
    const q = $('#l-search').value.trim().toLowerCase();
    const st = $('#l-status').value;
    const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((x) => !st || statusOf(x) === st)
      .filter((x) => !q || [x.number, x.title, x.customer, x.owner && x.owner.displayName].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        const cmp = typeof va === 'number' || typeof vb === 'number' ? (va || 0) - (vb || 0) : String(va || '').localeCompare(String(vb || ''), 'nl');
        return cmp * state.sort.dir;
      });
  }

  function renderList() {
    const items = visible();
    const open = items.filter((x) => ['concept', 'verzonden'].includes(statusOf(x)));
    const won = items.filter((x) => x.status === 'akkoord');
    $('#l-stats').innerHTML = [
      [items.length, items.length === 1 ? 'offerte' : 'offertes'],
      [eur(open.reduce((s, x) => s + x.totalExcl, 0)), `openstaand (${open.length}), excl. btw`],
      [eur(won.reduce((s, x) => s + x.totalExcl, 0)), `akkoord (${won.length}), excl. btw`],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#l-stats').hidden = !state.items.length;
    const tbl = $('#l-table');
    if (!state.items.length) {
      tbl.innerHTML = state.klant
        ? '<tr><td class="empty">Er staan nog geen offertes voor u klaar.</td></tr>'
        : '<tr><td class="empty">Nog geen offertes. Kies <b>Nieuwe offerte uit plan</b> om de stuklijst van een beregeningsplan over te nemen.</td></tr>';
      $('#l-count').textContent = '';
      return;
    }
    const cols = columns();
    const head = cols.map((c) => {
      const sorted = c.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${c.key}" class="${c.cls === 'num' ? 'num' : ''}${sorted}">${esc(c.label)}</th>`;
    }).join('');
    tbl.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${items.map((x) => `
      <tr data-id="${esc(x.id)}">${cols.map((c) => `<td class="${c.cls || ''}">${c.html(x)}</td>`).join('')}</tr>`).join('')
      || `<tr><td class="empty" colspan="${cols.length}">Geen offertes gevonden.</td></tr>`}</tbody>`;
    tbl.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['number', 'title', 'owner', 'status'].includes(key) ? 1 : -1) };
        renderList();
      };
    });
    tbl.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => go(`id=${encodeURIComponent(tr.dataset.id)}`); });
    $('#l-count').textContent = `${items.length} van ${state.items.length} offertes`;
  }

  // ---------- Nieuwe offerte ----------
  function baseData(extra = {}) {
    const p = state.profile;
    const d = Q.today();
    return { date: d, validUntil: Q.addDays(d, p.validDays || 30), intro: p.intro, terms: p.terms, lines: [], ...extra };
  }

  const LIB = () => ({ Catalog: window.Catalog, Hydraulics: window.Hydraulics, BOM: window.BOM });

  async function createFromPlan(planId) {
    let plan;
    try {
      plan = await api(`plans/${encodeURIComponent(planId)}`);
    } catch (e) {
      toast(`Kan het plan niet laden: ${e.message}`, true);
      return go('');
    }
    let built;
    try {
      built = Q.fromPlan(plan.data, LIB(), state.profile);
    } catch (e) {
      console.error(e);
      built = { lines: [], summary: null, warnings: [`De stuklijst kon niet worden berekend (${e.message}).`] };
    }
    const meta = plan.data.meta || {};
    const data = baseData({
      title: `Aanleg automatische beregening${plan.title ? ` – ${plan.title}` : ''}`,
      customer: { name: meta.customer || '', address: meta.address || '' },
      planId: plan.id, planTitle: plan.title, planSummary: built.summary, lines: built.lines,
    });
    try {
      const q = await api('quotes', { method: 'POST', body: { data } });
      state.warnings = built.warnings;
      history.replaceState(null, '', `?id=${encodeURIComponent(q.id)}`);
      openQuote(q);
      toast(`Offerte ${q.number} aangemaakt uit "${plan.title}"`);
    } catch (e) {
      toast(`Offerte aanmaken mislukt: ${e.message}`, true);
      go('');
    }
  }

  async function createEmpty(data = baseData({ title: 'Offerte' })) {
    try {
      const q = await api('quotes', { method: 'POST', body: { data } });
      state.warnings = [];
      go(`id=${encodeURIComponent(q.id)}`);
    } catch (e) {
      toast(`Offerte aanmaken mislukt: ${e.message}`, true);
    }
  }

  async function pickPlan() {
    const modal = $('#plan-picker');
    const list = $('#pp-list');
    list.innerHTML = '<p class="muted small">Laden…</p>';
    modal.hidden = false;
    let plans = [];
    try {
      plans = (await api(state.all ? 'plans?all=1' : 'plans')).items || [];
    } catch (e) {
      list.innerHTML = `<p class="err">Kan de plannen niet laden (${esc(e.message)}).</p>`;
      return;
    }
    const render = () => {
      const q = $('#pp-search').value.trim().toLowerCase();
      const items = plans.filter((p) => !q || [p.title, p.customer, p.address, p.owner && p.owner.displayName].some((v) => String(v || '').toLowerCase().includes(q)));
      list.innerHTML = items.map((p) => `
        <button data-plan="${esc(p.id)}"><b>${esc(p.title)}</b>
          <span class="sub">${esc([p.customer, p.address].filter(Boolean).join(' · ') || 'Geen klant ingevuld')}</span>
          <span class="sub">${p.summary ? `${p.summary.sprinklers} sproeiers · ${p.summary.zones} zones · ${nl(p.summary.totalM2, 0)} m²` : ''}${p.owner && state.all ? ` · ${esc(p.owner.displayName)}` : ''} · gewijzigd ${esc(shortDate(p.updatedAt))}</span>
        </button>`).join('') || `<p class="muted">${plans.length ? 'Geen plannen gevonden.' : 'Nog geen plannen. Teken eerst een tuin in de <a href="../beregening/">beregeningsplanner</a>.'}</p>`;
      list.querySelectorAll('[data-plan]').forEach((b) => {
        b.onclick = () => { modal.hidden = true; go(`plan=${encodeURIComponent(b.dataset.plan)}`); };
      });
    };
    $('#pp-search').value = '';
    $('#pp-search').oninput = render;
    render();
    $('#pp-search').focus();
  }

  // ---------- Bewerken ----------
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const target = ks.reduce((o, k) => (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}), obj);
    target[last] = v;
  }

  async function loadQuote(id) {
    try {
      const q = await api(`quotes/${encodeURIComponent(id)}`);
      if (state.klant) return viewQuote(q);
      openQuote(q);
    } catch (e) {
      toast(`Kan de offerte niet openen: ${e.message}`, true);
      go('');
    }
  }

  function openQuote(q) {
    q.data = Q.sanitize(q.data);
    state.quote = q;
    state.dirty = false;
    $('#list-view').hidden = true;
    $('#edit-view').hidden = false;
    $('#e-heading').textContent = `Offerte ${q.number}`;
    $('#e-number').value = q.number;
    document.title = `Offerte ${q.number} – AquaTech Service`;
    $('#e-status').value = q.status;
    renderAccount(q);
    $('#e-saved').textContent = '';
    document.querySelectorAll('#edit-view [data-f]').forEach((el) => {
      const v = getPath(q.data, el.dataset.f);
      el.value = v == null ? '' : v;
    });
    const d = q.data;
    $('#e-plan').innerHTML = d.planId
      ? `Opgebouwd uit plan <a href="../beregening/?plan=${encodeURIComponent(d.planId)}">${esc(d.planTitle || 'beregeningsplan')}</a>${d.planSummary ? ` · ${d.planSummary.sprinklers} sproeiers, ${d.planSummary.zones} zones, ${nl(d.planSummary.lawnM2, 0)} m² gazon` : ''}`
      : 'Niet gekoppeld aan een plan.';
    $('#e-menu [data-act=replan]').hidden = !d.planId;
    $('#e-menu [data-act=openplan]').hidden = !d.planId;
    $('#e-menu [data-act=purge]').hidden = !state.admin;
    renderWarnings();
    renderLines();
    window.scrollTo(0, 0);
  }

  // Klantaccount waaraan de offerte hangt (de klant ziet hem dan zelf).
  function renderAccount(q) {
    const sel = $('#e-account');
    const opts = state.customers.slice();
    if (q.customerAccount && !opts.some((c) => c.id === q.customerAccount.id)) opts.push({ ...q.customerAccount, gone: true });
    sel.innerHTML = '<option value="">Geen (alleen intern)</option>' + opts
      .map((c) => `<option value="${esc(c.id)}">${esc(c.displayName)}${c.username ? ` (${esc(c.username)})` : ''}${c.gone ? ' – uitgeschakeld' : ''}</option>`).join('');
    sel.value = q.customerId || '';
  }

  // ---------- Klant: offerte bekijken en akkoord geven ----------
  function viewQuote(q) {
    q.data = Q.sanitize(q.data);
    state.quote = q;
    $('#list-view').hidden = true;
    $('#view-view').hidden = false;
    document.body.classList.add('view-doc');
    $('#print').removeAttribute('aria-hidden');
    $('#v-heading').textContent = `Offerte ${q.number}`;
    document.title = `Offerte ${q.number} – AquaTech Service`;
    const st = statusOf(q);
    $('#v-status').className = `pill ${st}`;
    $('#v-status').textContent = statusLabel(st);
    const open = st === 'verzonden';
    $('#v-accept').hidden = !open;
    $('#v-reject').hidden = !open;
    const notice = {
      verzonden: `Deze offerte is geldig tot ${date(q.data.validUntil)}. Gaat u akkoord, dan nemen wij contact met u op om de werkzaamheden in te plannen.`,
      akkoord: 'U heeft deze offerte geaccepteerd. Wij nemen contact met u op om de werkzaamheden in te plannen.',
      afgewezen: 'U heeft deze offerte afgewezen. Neem gerust contact op als u een aangepaste offerte wilt.',
      verlopen: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.',
    }[st];
    $('#v-notice').textContent = notice || '';
    $('#v-notice').hidden = !notice;
    renderPrint();
    window.scrollTo(0, 0);
  }

  async function respond(answer) {
    const q = state.quote;
    const msg = answer === 'akkoord'
      ? `Akkoord geven op offerte ${q.number} (${eur(q.totalIncl)} incl. btw)?`
      : `Offerte ${q.number} afwijzen?`;
    if (!confirm(msg)) return;
    try {
      viewQuote(await api(`quotes/${encodeURIComponent(q.id)}/respond`, { method: 'POST', body: { answer } }));
      toast(answer === 'akkoord' ? 'Bedankt, de offerte is geaccepteerd' : 'De offerte is afgewezen');
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderWarnings() {
    const w = state.warnings || [];
    $('#e-warnings').hidden = !w.length;
    $('#e-warnings').innerHTML = w.length ? `<b>Let op bij het plan:</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }

  function lineRow(l) {
    const vat = Q.VAT_RATES.map((r) => `<option value="${r}"${r === l.vat ? ' selected' : ''}>${r}%</option>`).join('');
    return `<tr class="line" data-line="${esc(l.id)}">
      <td class="c-desc"><input data-l="description" value="${esc(l.description)}" maxlength="500" placeholder="Omschrijving">${l.code ? `<span class="code">${esc(l.code)}</span>` : ''}</td>
      <td class="c-qty"><input data-l="qty" class="num" type="number" step="any" value="${l.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-l="unit" value="${esc(l.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-price"><input data-l="price" class="num" type="number" step="0.01" value="${Number(l.price).toFixed(2)}" aria-label="Prijs per eenheid"></td>
      <td class="c-vat"><select data-l="vat" aria-label="Btw">${vat}</select></td>
      <td class="c-total num" data-total>${eur(Q.lineTotal(l))}</td>
      <td class="c-del"><button class="btn ghost icon" data-del title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  function renderLines() {
    const d = state.quote.data;
    const t = Q.totals(d);
    $('#e-lines').innerHTML = `<table class="lines">
      <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th>Btw</th><th class="num">Totaal</th><th></th></tr></thead>
      <tbody>${Object.entries(Q.SECTIONS).map(([key, label]) => `
        <tr class="section"><td colspan="7">${esc(label)}<span class="sum" data-sum="${key}">${eur(t.bySection[key] || 0)}</span></td></tr>
        ${d.lines.filter((l) => l.section === key).map(lineRow).join('')}
        <tr class="add"><td colspan="7"><button class="btn small" data-add="${key}">+ Regel ${esc(label.toLowerCase())}</button></td></tr>`).join('')}
      </tbody></table>`;
    renderTotals();
  }

  function renderTotals() {
    const d = state.quote.data;
    const t = Q.totals(d);
    for (const key of Object.keys(Q.SECTIONS)) {
      const el = $(`[data-sum="${key}"]`);
      if (el) el.textContent = eur(t.bySection[key] || 0);
    }
    $('#e-totals').innerHTML = `
      <tr><td>Subtotaal</td><td class="num">${eur(t.subtotal)}</td></tr>
      ${t.discount ? `<tr><td>Korting ${nl(t.discountPct)}%</td><td class="num">− ${eur(t.discount)}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${eur(t.net)}</td></tr>` : ''}
      ${t.vat.filter((v) => v.base).map((v) => `<tr><td>Btw ${v.rate}% over ${eur(v.base)}</td><td class="num">${eur(v.amount)}</td></tr>`).join('')}
      <tr class="grand"><td>Totaal incl. btw</td><td class="num">${eur(t.total)}</td></tr>`;
  }

  function changed() {
    state.dirty = true;
    $('#e-saved').textContent = 'Wijzigingen…';
    clearTimeout(state.saveT);
    state.saveT = setTimeout(save, 1200);
  }

  async function save(extra = {}) {
    clearTimeout(state.saveT);
    const q = state.quote;
    if (!q) return;
    if (state.saving) await state.saving;
    if (!state.dirty && !Object.keys(extra).length) return;
    state.dirty = false;
    $('#e-saved').textContent = 'Opslaan…';
    state.saving = (async () => {
      try {
        const out = await api(`quotes/${encodeURIComponent(q.id)}`, { method: 'PUT', body: { data: q.data, ...extra } });
        if (state.quote === q) {
          q.status = out.status;
          q.totalIncl = out.totalIncl;
          $('#e-saved').textContent = `Opgeslagen ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
        }
      } catch (e) {
        state.dirty = true;
        $('#e-saved').textContent = 'Niet opgeslagen';
        toast(`Opslaan mislukt: ${e.message}`, true);
      } finally {
        state.saving = null;
      }
    })();
    return state.saving;
  }

  function newLine(section) {
    const p = state.profile;
    const labor = section === 'arbeid';
    return Q.sanitizeLine({
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, section,
      qty: 1, unit: labor ? 'uur' : section === 'overig' ? 'post' : 'st', price: labor ? p.hourlyRate : 0, vat: p.vatRate,
    });
  }

  function bindEditor() {
    const view = $('#edit-view');
    view.addEventListener('input', (e) => {
      const q = state.quote;
      if (!q) return;
      const f = e.target.dataset.f;
      if (f) {
        let v = e.target.value;
        if (f === 'discountPct') v = Math.min(100, Math.max(0, Number(v) || 0));
        setPath(q.data, f, v);
        if (f === 'discountPct') renderTotals();
        return changed();
      }
      const key = e.target.dataset.l;
      const tr = e.target.closest('[data-line]');
      if (!key || !tr) return;
      const line = q.data.lines.find((l) => l.id === tr.dataset.line);
      if (!line) return;
      line[key] = ['qty', 'price', 'vat'].includes(key) ? Number(e.target.value) || 0 : e.target.value;
      $('[data-total]', tr).textContent = eur(Q.lineTotal(line));
      renderTotals();
      changed();
    });
    // Datums en keuzelijsten melden zich soms alleen met 'change'.
    view.addEventListener('change', (e) => {
      if (e.target.matches('select[data-l], select[data-f], input[type=date]')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    view.addEventListener('click', (e) => {
      const q = state.quote;
      const add = e.target.closest('[data-add]');
      if (add && q) {
        const section = add.dataset.add;
        const line = newLine(section);
        // Na de laatste regel van dezelfde sectie invoegen.
        let at = -1;
        q.data.lines.forEach((l, i) => { if (l.section === section) at = i; });
        q.data.lines.splice(at < 0 ? q.data.lines.length : at + 1, 0, line);
        renderLines();
        const input = $(`[data-line="${line.id}"] [data-l=description]`);
        if (input) input.focus();
        return changed();
      }
      const del = e.target.closest('[data-del]');
      if (del && q) {
        const id = del.closest('[data-line]').dataset.line;
        q.data.lines = q.data.lines.filter((l) => l.id !== id);
        renderLines();
        return changed();
      }
    });
    $('#e-status').onchange = (e) => save({ status: e.target.value });
    $('#e-account').onchange = async (e) => {
      const q = state.quote;
      await save({ customerId: e.target.value || null });
      if (state.quote === q) q.customerId = e.target.value || null;
    };
    $('#e-back').onclick = async () => { await save(); go(''); };
    $('#e-pdf').onclick = printQuote;
    $('#e-xlsx').onclick = exportQuoteXlsx;
    $('#e-more').onclick = (e) => { e.stopPropagation(); $('#e-menu').hidden = !$('#e-menu').hidden; };
    document.addEventListener('click', () => { $('#e-menu').hidden = true; });
    $('#e-menu').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act) menuAction(act);
    };
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { save(); e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function menuAction(act) {
    const q = state.quote;
    if (!q) return;
    if (act === 'replan') {
      if (!confirm('De regels voor materialen en arbeid opnieuw uit het plan overnemen? Aangepaste prijzen en aantallen in die onderdelen gaan verloren; regels onder "Overig" blijven staan.')) return;
      try {
        const plan = await api(`plans/${encodeURIComponent(q.data.planId)}`);
        const built = Q.fromPlan(plan.data, LIB(), state.profile);
        const keep = q.data.lines.filter((l) => l.section === 'overig');
        const extra = built.lines.filter((l) => l.section === 'overig' && !keep.some((k) => k.description === l.description));
        q.data.lines = [...built.lines.filter((l) => l.section !== 'overig'), ...keep, ...extra].map((l, i) => ({ ...l, id: `r${Date.now().toString(36)}${i}` }));
        q.data.planTitle = plan.title;
        q.data.planSummary = built.summary;
        state.warnings = built.warnings;
        openQuote(q);
        changed();
        toast('Regels bijgewerkt uit het plan');
      } catch (e) {
        toast(`Kan het plan niet laden: ${e.message}`, true);
      }
    } else if (act === 'openplan') {
      await save();
      location.href = `../beregening/?plan=${encodeURIComponent(q.data.planId)}`;
    } else if (act === 'duplicate') {
      await save();
      const d = Q.today();
      createEmpty({ ...JSON.parse(JSON.stringify(q.data)), date: d, validUntil: Q.addDays(d, state.profile.validDays || 30) });
    } else if (act === 'delete') {
      if (!confirm(`Offerte ${q.number} verwijderen?`)) return;
      try {
        await api(`quotes/${encodeURIComponent(q.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Offerte ${q.number} verwijderd`);
        go('');
      } catch (e) {
        toast(`Verwijderen mislukt: ${e.message}`, true);
      }
    } else if (act === 'purge') {
      if (!confirm(`Offerte ${q.number} definitief wissen, inclusief klantgegevens? Dit kan niet ongedaan worden gemaakt.`)) return;
      try {
        await api(`admin/quotes/${encodeURIComponent(q.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Offerte ${q.number} gewist`);
        go('');
      } catch (e) {
        toast(`Wissen mislukt: ${e.message}`, true);
      }
    }
  }

  // ---------- PDF (afdrukversie) ----------
  function renderPrint() {
    const q = state.quote;
    const d = q.data;
    const p = state.profile;
    // Een klant krijgt de totalen van de server (bij "totaal per onderdeel" zonder regelprijzen).
    const t = q.totals || Q.totals(d);
    const c = d.customer;
    const company = [p.address, [p.phone, p.email].filter(Boolean).join(' · '), p.website].filter(Boolean).join('\n');
    const to = [c.name, c.contact ? `T.a.v. ${c.contact}` : '', c.address].filter(Boolean).join('\n');
    const detail = d.layout !== 'totaal';
    const sections = Object.entries(Q.SECTIONS).map(([key, label]) => {
      const lines = d.lines.filter((l) => l.section === key);
      if (!lines.length) return '';
      const rows = lines.map((l) => detail
        ? `<tr><td>${esc(l.description)}</td><td class="num">${nl(l.qty)}</td><td>${esc(l.unit)}</td><td class="num">${eur(l.price)}</td><td class="num">${l.vat}%</td><td class="num">${eur(Q.lineTotal(l))}</td></tr>`
        : `<tr><td colspan="5">${esc(l.description)}</td><td class="num">${nl(l.qty)} ${esc(l.unit)}</td></tr>`).join('');
      return `<tr class="p-section"><td colspan="6">${esc(label)}</td></tr>${rows}
        <tr class="p-sum"><td colspan="5">Totaal ${esc(label.toLowerCase())}</td><td class="num">${eur(t.bySection[key] || 0)}</td></tr>`;
    }).join('');
    const s = d.planSummary;
    const design = s ? [s.lawnM2 ? `${nl(s.lawnM2, 0)} m² gazon` : '', s.sprinklers ? `${s.sprinklers} sproeiers` : '', s.zones ? `${s.zones} zones` : '', s.level ? `uitvoering ${s.level}` : ''].filter(Boolean).join(' · ') : '';
    const foot = [p.companyName, p.kvk ? `KvK ${p.kvk}` : '', p.vatNumber ? `Btw ${p.vatNumber}` : '', p.iban ? `IBAN ${p.iban}` : ''].filter(Boolean).join(' · ');
    $('#print').innerHTML = `
      <header class="p-head">
        <img src="../shared/logo-white.png" alt="${esc(p.companyName)}">
        <div class="p-company"><b>${esc(p.companyName)}</b>\n${esc(company)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">Offerte voor</div>${esc(to || '–')}</div>
        <div class="p-info"><table>
          <tr><td>Offertenummer</td><td><b>${esc(q.number)}</b></td></tr>
          <tr><td>Datum</td><td>${esc(date(d.date))}</td></tr>
          <tr><td>Geldig tot</td><td>${esc(date(d.validUntil))}</td></tr>
          ${d.reference ? `<tr><td>Uw referentie</td><td>${esc(d.reference)}</td></tr>` : ''}
        </table></div>
      </div>
      <h1>Offerte</h1>
      <div class="p-sub">${esc(d.title)}</div>
      ${d.intro ? `<p class="p-text">${esc(d.intro)}</p>` : ''}
      ${design ? `<div class="p-design"><b>Ontwerp${d.planTitle ? ` ${esc(d.planTitle)}` : ''}:</b> ${esc(design)}</div>` : ''}
      <table class="p-lines">
        <thead><tr>${detail ? '<th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th class="num">Btw</th><th class="num">Totaal</th>' : '<th colspan="5">Omschrijving</th><th class="num">Aantal</th>'}</tr></thead>
        <tbody>${sections || '<tr><td colspan="6">Geen regels.</td></tr>'}</tbody>
      </table>
      <table class="p-totals">
        <tr><td>Subtotaal</td><td class="num">${eur(t.subtotal)}</td></tr>
        ${t.discount ? `<tr><td>Korting ${nl(t.discountPct)}%</td><td class="num">− ${eur(t.discount)}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${eur(t.net)}</td></tr>` : ''}
        ${t.vat.filter((v) => v.base).map((v) => `<tr><td>Btw ${v.rate}%</td><td class="num">${eur(v.amount)}</td></tr>`).join('')}
        <tr class="grand"><td>Totaal incl. btw</td><td class="num">${eur(t.total)}</td></tr>
      </table>
      ${d.terms ? `<h2>Voorwaarden</h2><p class="p-text">${esc(d.terms)}</p>` : ''}
      <div class="p-end">
        <h2>Voor akkoord</h2>
        <div class="p-sign"><div>Naam en datum</div><div>Handtekening</div></div>
        <footer class="p-foot">${esc(foot)}</footer>
      </div>`;
  }

  async function printQuote() {
    await save();
    renderPrint();
    // De bestandsnaam van "Opslaan als PDF" volgt de paginatitel.
    const old = document.title;
    const c = state.quote.data.customer.name;
    document.title = `Offerte ${state.quote.number}${c ? ` ${c}` : ''}`;
    const img = $('#print img');
    if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    window.print();
    setTimeout(() => { document.title = old; }, 500);
  }

  // ---------- Excel ----------
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const safeName = (s) => String(s || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NAVY = 'FF172F5E';

  async function exportQuoteXlsx() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    await save();
    const q = state.quote;
    const d = q.data;
    const p = state.profile;
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = p.companyName || 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Offerte', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = [{ width: 14 }, { width: 58 }, { width: 10 }, { width: 8 }, { width: 13 }, { width: 8 }, { width: 14 }];
      const eurFmt = '€ #,##0.00';
      const bold = { bold: true };
      ws.addRow([p.companyName]).font = { bold: true, size: 14, color: { argb: NAVY } };
      for (const l of [p.address, [p.phone, p.email].filter(Boolean).join(' · '), [p.kvk && `KvK ${p.kvk}`, p.vatNumber && `Btw ${p.vatNumber}`, p.iban && `IBAN ${p.iban}`].filter(Boolean).join(' · ')]) {
        if (l) ws.addRow([l.replace(/\n/g, ', ')]);
      }
      ws.addRow([]);
      const info = [
        ['Offerte', q.number], ['Datum', d.date ? new Date(`${d.date}T12:00:00`) : ''], ['Geldig tot', d.validUntil ? new Date(`${d.validUntil}T12:00:00`) : ''],
        ['Klant', d.customer.name], ['T.a.v.', d.customer.contact], ['Adres', d.customer.address.replace(/\n/g, ', ')],
        ['E-mail', d.customer.email], ['Telefoon', d.customer.phone], ['Uw referentie', d.reference], ['Omschrijving', d.title],
        ['Status', statusLabel(statusOf({ ...q, validUntil: d.validUntil }))],
      ].filter(([, v]) => v !== '');
      for (const [k, v] of info) {
        const r = ws.addRow([k, v]);
        r.getCell(1).font = bold;
        if (v instanceof Date) r.getCell(2).numFmt = 'dd-mm-yyyy';
        r.getCell(2).alignment = { horizontal: 'left' };
      }
      ws.addRow([]);
      const head = ws.addRow(['Artikelcode', 'Omschrijving', 'Aantal', 'Eenheid', 'Prijs', 'Btw %', 'Totaal']);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      const first = head.number + 1;
      const subtotalCells = [];
      for (const [key, label] of Object.entries(Q.SECTIONS)) {
        const lines = d.lines.filter((l) => l.section === key);
        if (!lines.length) continue;
        const sr = ws.addRow(['', label]);
        sr.font = { bold: true, color: { argb: NAVY } };
        const start = sr.number + 1;
        for (const l of lines) {
          const r = ws.addRow([l.code, l.description, l.qty, l.unit, l.price, l.vat]);
          r.getCell(7).value = { formula: `C${r.number}*E${r.number}` };
          r.getCell(5).numFmt = eurFmt;
          r.getCell(7).numFmt = eurFmt;
        }
        const end = ws.lastRow.number;
        const sum = ws.addRow(['', `Totaal ${label.toLowerCase()}`]);
        sum.getCell(7).value = { formula: `SUM(G${start}:G${end})` };
        sum.getCell(7).numFmt = eurFmt;
        sum.font = bold;
        subtotalCells.push(`G${sum.number}`);
      }
      const last = ws.lastRow.number;
      ws.addRow([]);
      const tot = (label, formula, fmt = eurFmt) => {
        const r = ws.addRow(['', '', '', '', '', label]);
        r.getCell(7).value = formula;
        r.getCell(7).numFmt = fmt;
        r.getCell(6).alignment = { horizontal: 'right' };
        r.getCell(6).font = bold;
        r.getCell(7).font = bold;
        return r.number;
      };
      const sub = tot('Subtotaal', { formula: subtotalCells.length ? subtotalCells.join('+') : '0' });
      const disc = tot('Korting %', d.discountPct / 100, '0.0%');
      const net = tot('Excl. btw', { formula: `G${sub}*(1-G${disc})` });
      const vatRows = [];
      // Btw per tarief: de regels met dat tarief, na korting.
      for (const rate of Q.VAT_RATES) {
        if (!d.lines.some((l) => l.vat === rate)) continue;
        vatRows.push(tot(`Btw ${rate}%`, { formula: `SUMIF(F${first}:F${last},${rate},G${first}:G${last})*(1-G${disc})*${rate / 100}` }));
      }
      const grand = tot('Totaal incl. btw', { formula: `G${net}${vatRows.map((r) => `+G${r}`).join('')}` });
      ws.getRow(grand).getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF19924F' } };
      ws.getRow(grand).getCell(7).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      for (const [title, text] of [['Inleiding', d.intro], ['Voorwaarden', d.terms]]) {
        if (!text) continue;
        ws.addRow([]);
        ws.addRow([title]).font = bold;
        const r = ws.addRow(['', text]);
        r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
        r.height = Math.min(400, 15 * Math.ceil(text.length / 80 + (text.match(/\n/g) || []).length));
      }
      download(new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offerte_${safeName(q.number)}${d.customer.name ? `_${safeName(d.customer.name)}` : ''}.xlsx`);
    } catch (e) {
      console.error(e);
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  async function exportListXlsx() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Offertes', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
        { header: 'Nummer', key: 'number', width: 16 },
        { header: 'Omschrijving', key: 'title', width: 40 },
        { header: 'Klant', key: 'customer', width: 28 },
        ...(showAll() ? [{ header: 'Gebruiker', key: 'owner', width: 20 }] : []),
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Excl. btw', key: 'totalExcl', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Incl. btw', key: 'totalIncl', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Geldig tot', key: 'validUntil', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Aangemaakt', key: 'createdAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      ];
      for (const x of items) {
        ws.addRow({
          number: x.number, title: x.title, customer: x.customer, owner: x.owner ? x.owner.displayName : '', status: statusLabel(statusOf(x)),
          totalExcl: x.totalExcl, totalIncl: x.totalIncl, validUntil: x.validUntil ? new Date(`${x.validUntil}T12:00:00`) : null,
          createdAt: new Date(x.createdAt), updatedAt: new Date(x.updatedAt),
        });
      }
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      download(new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offertes_${Q.today()}.xlsx`);
      toast(`${items.length} offertes geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  // ---------- Bedrijfsgegevens ----------
  function openProfile() {
    const f = $('#pf');
    for (const el of f.elements) if (el.name) el.value = state.profile[el.name] ?? '';
    $('#profile').hidden = false;
  }

  async function saveProfile(e) {
    e.preventDefault();
    const f = $('#pf');
    const profile = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      profile[el.name] = el.type === 'number' || el.name === 'vatRate' ? Number(el.value) : el.value;
    }
    try {
      state.profile = (await api('quote-profile', { method: 'PUT', body: { profile } })).profile;
      $('#profile').hidden = true;
      toast('Bedrijfsgegevens opgeslagen');
    } catch (err) {
      toast(`Opslaan mislukt: ${err.message}`, true);
    }
  }

  // ---------- Navigatie ----------
  function showList() {
    state.quote = null;
    state.warnings = [];
    document.title = `${state.klant ? 'Mijn offertes' : 'Offertes'} – AquaTech Service`;
    document.body.classList.remove('view-doc');
    $('#print').setAttribute('aria-hidden', 'true');
    $('#view-view').hidden = true;
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  async function route() {
    const ps = params();
    if (state.quote && state.dirty) await save();
    if (ps.get('plan') && !state.klant) return createFromPlan(ps.get('plan'));
    if (ps.get('id')) return loadQuote(ps.get('id'));
    showList();
  }

  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    state.all = rights.includes('offertes.alle');
    state.klant = !rights.includes('offertes') && rights.includes('offertes.klant');
    if (!state.me.user && !state.me.guest) {
      $('#l-table').innerHTML = '<tr><td class="empty">Log eerst in om offertes te maken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    try {
      const out = await api('quote-profile');
      state.profile = out.profile;
      state.canEdit = out.canEdit;
    } catch (e) {
      // Gast zonder account (nog niets bewaard): standaardwaarden van de server ontbreken.
      state.profile = { companyName: 'AquaTech Service', hourlyRate: 55, validDays: 30, vatRate: 21, markupPct: 0, callOutFee: 0, intro: '', terms: '' };
    }
    $('#l-status').innerHTML = '<option value="">Alle statussen</option>' + [...Object.keys(Q.STATUSES), 'verlopen']
      .map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join('');
    $('#e-status').innerHTML = Object.entries(Q.STATUSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('#l-all-wrap').hidden = !state.all;
    $('#l-profile').hidden = !state.canEdit;
    if (state.klant) {
      $('.brand-name').textContent = 'Mijn offertes';
      $('#l-heading').textContent = 'Mijn offertes';
      $('#l-intro').textContent = 'De offertes die voor u klaarstaan. Open een offerte om die te bekijken, af te drukken en akkoord te geven of af te wijzen.';
      for (const id of ['#l-new-plan', '#l-new-empty', '#l-profile']) $(id).hidden = true;
      $('#l-status').innerHTML = '<option value="">Alle statussen</option>' + ['verzonden', 'akkoord', 'afgewezen', 'verlopen']
        .map((s) => `<option value="${s}">${esc(statusLabel(s))}</option>`).join('');
    } else {
      try { state.customers = (await api('quote-customers')).items || []; } catch (e) { state.customers = []; }
    }
    $('#v-back').onclick = () => go('');
    $('#v-pdf').onclick = () => window.print();
    $('#v-accept').onclick = () => respond('akkoord');
    $('#v-reject').onclick = () => respond('afgewezen');
    let t;
    $('#l-search').oninput = () => { clearTimeout(t); t = setTimeout(renderList, 150); };
    $('#l-status').onchange = renderList;
    $('#l-all').onchange = loadList;
    $('#l-new-plan').onclick = pickPlan;
    $('#l-new-empty').onclick = () => createEmpty();
    $('#l-profile').onclick = openProfile;
    $('#l-export').onclick = exportListXlsx;
    $('#pf').onsubmit = saveProfile;
    document.querySelectorAll('.modal').forEach((m) => {
      m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; };
    });
    bindEditor();
    window.addEventListener('popstate', route);
    route();
  }

  init();
})();
