// Offertes: overzicht, een offerte opbouwen uit een beregeningsplan, bewerken
// (klant, regels, korting, btw, teksten), en exporteren als PDF (afdrukversie
// via de browser) of Excel. De server bewaart de offertes (/api/quotes) en
// rekent de totalen voor het overzicht zelf na met dezelfde rekenkern.
// Rollen (shared/roles.js): beheerders en installateurs stellen offertes op;
// een klant ziet alleen de verzonden offertes voor zijn account, als
// document, en geeft akkoord of wijst af.
// Digitale offerte: een link (openbaar/offerte.html#t=...) waarmee de klant
// zonder account bekijkt, opties kiest en accordeert met naam, handtekening en
// akkoord op de voorwaarden. Na een antwoord ligt de offerte vast.
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

  const V = window.QuoteView;
  const state = {
    me: null, admin: false, all: false, klant: false, customers: [], profile: null, canEdit: false, mail: false,
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
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error, status: res.status });
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
    { key: 'status', label: 'Status', value: statusOf, html: (q) => `<span class="pill ${esc(statusOf(q))}">${esc(statusLabel(statusOf(q)))}</span>${statusOf(q) === 'verzonden' && q.viewedAt ? '<span class="sub">bekeken</span>' : ''}` },
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
      const pre = state.pre && state.pre.id === id ? state.pre.req : null;
      state.pre = null;
      const q = await (pre || api(`quotes/${encodeURIComponent(id)}`));
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
    renderWorkOrder(q);
    renderWarnings();
    renderLines();
    renderLock();
    renderShare();
    window.scrollTo(0, 0);
  }

  // ---------- Digitale offerte: akkoord, vastleggen en de link ----------
  const locked = () => Boolean(state.quote && state.quote.acceptance);

  function acceptanceHtml(a) {
    if (a.answer === 'akkoord') {
      return `<b>Digitaal geaccordeerd</b> door ${esc(a.name)} op ${esc(V.dateTime(a.at))}, voor ${eur(a.totalIncl)} incl. btw
        (${a.via === 'account' ? 'via het klantaccount' : 'via de offertelink'}${a.ip ? `, IP ${esc(a.ip)}` : ''}).
        ${a.options && a.options.length ? `Gekozen opties: ${a.options.length}.` : ''}
        De offerte ligt vast; maak via ⋯ een kopie om iets te wijzigen.
        ${a.signature ? `<img src="${esc(a.signature)}" alt="Handtekening">` : ''}`;
    }
    return `<b>Afgewezen</b>${a.name ? ` door ${esc(a.name)}` : ''} op ${esc(V.dateTime(a.at))}.${a.reason ? ` Reden: ${esc(a.reason)}` : ''}
      De offerte ligt vast; maak via ⋯ een kopie voor een aangepaste offerte.`;
  }

  function renderLock() {
    const q = state.quote;
    const on = locked();
    const box = $('#e-locked');
    box.hidden = !on;
    box.className = `notice ok${on && q.acceptance.answer !== 'akkoord' ? ' rejected' : ''}`;
    box.innerHTML = on ? acceptanceHtml(q.acceptance) : '';
    $('#edit-view').classList.toggle('locked', on);
    document.querySelectorAll('#edit-view .cols input, #edit-view .cols textarea, #edit-view .cols select, #edit-view [data-f], #e-lines input, #e-lines select, #e-lines button, #e-status')
      .forEach((el) => { if (el.id !== 'e-number') el.disabled = on; });
  }

  function renderShare() {
    const q = state.quote;
    const s = q.share || {};
    const body = $('#sh-body');
    const answered = locked();
    if (!s.active) {
      // Verstuurd zonder link (bijv. alleen via het klantaccount): zeggen
      // waarom er geen adres staat.
      const noLink = q.status !== 'concept' ? '<p class="notice warn small">Deze offerte heeft nog geen klantlink. Maak er een om de offerte zelf te openen zoals de klant hem ziet, of om het adres te delen.</p>' : '';
      body.innerHTML = `${noLink}<p class="muted small">Maak een link waarmee de klant de offerte online bekijkt, eventuele opties kiest en digitaal akkoord geeft met naam, handtekening en akkoord op de voorwaarden. Tijdstip en IP-adres worden vastgelegd${state.mail ? ' en de klant krijgt een bevestiging per e-mail' : ''}.</p>
        <div class="actions">${answered ? '' : `<button class="btn primary" data-sh="send">Versturen per e-mail</button>`}
        <button class="btn" data-sh="create">Link maken</button></div>
        ${q.status === 'concept' && !answered ? '<p class="muted small">Met de link gaat de status naar <b>Verzonden</b>.</p>' : ''}`;
      return;
    }
    const stats = [
      s.sharedAt ? `Link gemaakt ${esc(V.dateTime(s.sharedAt))}` : '',
      s.sentAt ? `verstuurd naar <b>${esc(s.sentTo)}</b> op ${esc(V.dateTime(s.sentAt))}` : '',
      s.viewCount ? `<b>${s.viewCount}× bekeken</b>, eerst ${esc(V.dateTime(s.viewedAt))}${s.viewCount > 1 ? `, laatst ${esc(V.dateTime(s.lastViewedAt))}` : ''}` : 'nog niet bekeken',
    ].filter(Boolean).join(' · ');
    body.innerHTML = `
      <label class="link-label" for="sh-url">Klantlink <span class="muted">(dit adres krijgt de klant${s.sentTo ? ' in de e-mail' : ''})</span></label>
      <div class="link-row">
        <input id="sh-url" readonly value="${esc(s.url || '')}" aria-label="Link naar de digitale offerte">
        <button class="btn" data-sh="copy">Kopiëren</button>
        <button class="btn" data-sh="preview" title="Openen zoals de klant hem ziet; telt niet als bekeken door de klant">Openen</button>
      </div>
      <div class="actions">
        ${answered ? '' : '<button class="btn primary" data-sh="send">Versturen per e-mail</button>'}
        <button class="btn" data-sh="revoke">Link intrekken</button>
      </div>
      <p class="stats-line">${stats}</p>`;
  }

  async function shareAction(act) {
    const q = state.quote;
    if (!q) return;
    try {
      if (act === 'create') {
        await save();
        applyServer(await api(`quotes/${encodeURIComponent(q.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
        toast('Link gemaakt');
      } else if (act === 'copy') {
        const input = $('#sh-url');
        try { await navigator.clipboard.writeText(input.value); } catch (e) { input.select(); document.execCommand('copy'); }
        toast('Link gekopieerd');
      } else if (act === 'preview') {
        // Voorbeeld: telt niet als "bekeken" door de klant.
        window.open(`${q.share.url}&voorbeeld=1`, '_blank', 'noopener');
      } else if (act === 'revoke') {
        if (!confirm('De link intrekken? De klant kan de offerte dan niet meer openen; een nieuwe link is daarna een ander adres.')) return;
        applyServer(await api(`quotes/${encodeURIComponent(q.id)}/share`, { method: 'DELETE' }));
        toast('Link ingetrokken');
      } else if (act === 'send') {
        await save();
        openSend();
      }
    } catch (e) {
      toast(e.message, true);
    }
  }

  // Het adres van de openbare pagina volgt uit waar deze module draait (ook
  // achter een padprefix); de server kent dat zelf niet.
  const shareBase = () => new URL('../openbaar/offerte.html', location.href).href;

  // Gegevens van de server overnemen zonder de invoer opnieuw op te bouwen.
  function applyServer(out) {
    const q = state.quote;
    if (!q || out.id !== q.id) return;
    q.status = out.status;
    q.share = out.share;
    q.acceptance = out.acceptance;
    $('#e-status').value = q.status;
    renderShare();
  }

  function openSend() {
    const q = state.quote;
    const d = q.data;
    const p = state.profile;
    const f = $('#sf');
    f.to.value = d.customer.email || '';
    const link = $('#sf-link');
    link.hidden = !(q.share && q.share.url);
    link.innerHTML = link.hidden ? '' : `Link in de e-mail: <a href="${esc(`${q.share.url}&voorbeeld=1`)}" target="_blank" rel="noopener">${esc(q.share.url)}</a>`;
    f.subject.value = `Offerte ${q.number}${d.title ? ` – ${d.title}` : ''}`;
    f.message.value = [
      `Beste ${d.customer.contact || d.customer.name || 'klant'},`,
      `Hierbij ontvangt u onze offerte ${q.number}${d.title ? ` voor ${d.title.toLowerCase()}` : ''}. Via de knop hieronder bekijkt u de offerte online en kunt u direct digitaal akkoord geven. De offerte is geldig tot ${date(d.validUntil)}.`,
      'Heeft u vragen, neem dan gerust contact met ons op.',
      `Met vriendelijke groet,\n${p.companyName || ''}`,
    ].join('\n\n');
    $('#send').hidden = false;
    f.to.focus();
  }

  async function sendQuote(e) {
    e.preventDefault();
    const q = state.quote;
    const f = $('#sf');
    const btn = f.querySelector('[type=submit]');
    if (!state.mail) return mailtoFallback();
    btn.disabled = true;
    try {
      applyServer(await api(`quotes/${encodeURIComponent(q.id)}/send`, {
        method: 'POST', body: { to: f.to.value, subject: f.subject.value, message: f.message.value, url: shareBase() },
      }));
      $('#send').hidden = true;
      toast(`Offerte verstuurd naar ${f.to.value}`);
    } catch (err) {
      if (err.code === 'not_configured') { state.mail = false; return mailtoFallback(); }
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // Zonder eigen mailserver: link maken en het bericht in het eigen
  // mailprogramma openen.
  async function mailtoFallback() {
    const q = state.quote;
    const f = $('#sf');
    try {
      if (!q.share || !q.share.active) applyServer(await api(`quotes/${encodeURIComponent(q.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
      const body = `${f.message.value}\n\nOfferte bekijken en accorderen:\n${q.share.url}`;
      location.href = `mailto:${encodeURIComponent(f.to.value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent(f.subject.value)}&body=${encodeURIComponent(body)}`;
      $('#send').hidden = true;
      toast('Er is geen mailserver ingesteld; het bericht staat klaar in je mailprogramma');
    } catch (err) {
      toast(err.message, true);
    }
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

  // Werkorder (module Werkorders): alleen bij een offerte met status akkoord.
  async function renderWorkOrder(q) {
    const btn = $('#e-wo');
    btn.hidden = !state.werkorders || q.status !== 'akkoord';
    if (btn.hidden) return;
    btn.textContent = 'Werkorder maken';
    btn.onclick = () => { location.href = `../werkorders/?quote=${encodeURIComponent(q.id)}`; };
    try {
      const items = (await api(`workorders?quote=${encodeURIComponent(q.id)}`)).items || [];
      if (items.length && state.quote === q) {
        btn.textContent = `Werkorder ${items[0].number}`;
        btn.onclick = () => { location.href = `../werkorders/?id=${encodeURIComponent(items[0].id)}`; };
      }
    } catch (e) { /* knop blijft "Werkorder maken" */ }
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
    const open = st === 'verzonden' && !q.acceptance;
    const notice = {
      verzonden: `Deze offerte is geldig tot ${date(q.data.validUntil)}. Gaat u akkoord, dan nemen wij contact met u op om de werkzaamheden in te plannen.`,
      akkoord: 'U heeft deze offerte geaccepteerd. Wij nemen contact met u op om de werkzaamheden in te plannen.',
      afgewezen: 'U heeft deze offerte afgewezen. Neem gerust contact op als u een aangepaste offerte wilt.',
      verlopen: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.',
    }[st];
    $('#v-notice').textContent = notice || '';
    $('#v-notice').hidden = !notice;
    $('#print').innerHTML = V.documentHtml(q, state.profile, { interactive: open });
    $('#v-sign').hidden = !open;
    if (open) {
      // Opties aanvinken rekent het totaal opnieuw uit.
      $('#print').onchange = (e) => {
        const id = e.target.dataset && e.target.dataset.opt;
        const line = id && q.data.lines.find((l) => l.id === id);
        if (!line) return;
        line.selected = e.target.checked;
        const pos = window.scrollY;
        $('#print').innerHTML = V.documentHtml(q, state.profile, { interactive: true });
        window.scrollTo(0, pos);
        form.update();
      };
      const form = V.signForm($('#v-sign'), {
        termsLink: Boolean(q.data.terms),
        total: () => V.totalsOf(q).total,
        onRespond: async (payload) => {
          const out = await api(`quotes/${encodeURIComponent(q.id)}/respond`, { method: 'POST', body: { ...payload, options: V.selectedOptions(q) } });
          viewQuote(out);
          toast(payload.answer === 'akkoord' ? 'Bedankt, de offerte is geaccordeerd' : 'De offerte is afgewezen');
        },
      });
    } else {
      $('#print').onchange = null;
      $('#v-sign').innerHTML = '';
    }
    window.scrollTo(0, 0);
  }

  function renderWarnings() {
    const w = state.warnings || [];
    $('#e-warnings').hidden = !w.length;
    $('#e-warnings').innerHTML = w.length ? `<b>Let op bij het plan:</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }

  function lineRow(l) {
    const vat = Q.VAT_RATES.map((r) => `<option value="${r}"${r === l.vat ? ' selected' : ''}>${r}%</option>`).join('');
    const kind = l.optional ? (l.selected ? 'aan' : 'optie') : 'vast';
    const kinds = [['vast', 'Vast'], ['optie', 'Optie'], ['aan', 'Optie (aan)']]
      .map(([k, label]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${label}</option>`).join('');
    return `<tr class="line${l.optional ? ` opt${l.selected ? '' : ' off'}` : ''}" data-line="${esc(l.id)}">
      <td class="c-desc"><input data-l="description" value="${esc(l.description)}" maxlength="500" placeholder="Omschrijving">${l.code ? `<span class="code">${esc(l.code)}</span>` : ''}</td>
      <td class="c-qty"><input data-l="qty" class="num" type="number" step="any" value="${l.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-l="unit" value="${esc(l.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-price"><input data-l="price" class="num" type="number" step="0.01" value="${Number(l.price).toFixed(2)}" aria-label="Prijs per eenheid"></td>
      <td class="c-vat"><select data-l="vat" aria-label="Btw">${vat}</select></td>
      <td class="c-kind"><select data-l="kind" aria-label="Soort regel" title="Een optie kiest de klant zelf; 'Optie (aan)' staat standaard aangevinkt">${kinds}</select></td>
      <td class="c-total num" data-total>${eur(Q.lineTotal(l))}</td>
      <td class="c-del"><button class="btn ghost icon" data-del title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  function renderLines() {
    const d = state.quote.data;
    const t = Q.totals(d);
    $('#e-lines').innerHTML = `<table class="lines">
      <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th>Btw</th><th>Soort</th><th class="num">Totaal</th><th></th></tr></thead>
      <tbody>${Object.entries(Q.SECTIONS).map(([key, label]) => `
        <tr class="section"><td colspan="8">${esc(label)}<span class="sum" data-sum="${key}">${eur(t.bySection[key] || 0)}</span></td></tr>
        ${d.lines.filter((l) => l.section === key).map(lineRow).join('')}
        <tr class="add"><td colspan="8"><button class="btn small" data-add="${key}">+ Regel ${esc(label.toLowerCase())}</button></td></tr>`).join('')}
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
    if (!q || locked()) { state.dirty = false; return; }
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
          q.share = out.share;
          $('#e-saved').textContent = `Opgeslagen ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
        }
      } catch (e) {
        if (e.code === 'locked') {
          // Inmiddels beantwoord door de klant: de serverversie tonen.
          $('#e-saved').textContent = '';
          toast(e.message, true);
          loadQuote(q.id);
          return;
        }
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
      if (!q || locked()) return;
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
      if (key === 'kind') {
        line.optional = e.target.value !== 'vast';
        line.selected = e.target.value === 'aan';
        tr.className = `line${line.optional ? ` opt${line.selected ? '' : ' off'}` : ''}`;
      } else {
        line[key] = ['qty', 'price', 'vat'].includes(key) ? Number(e.target.value) || 0 : e.target.value;
      }
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
      const sh = e.target.closest('[data-sh]');
      if (sh) return shareAction(sh.dataset.sh);
      if (locked()) return;
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
    $('#e-status').onchange = async (e) => {
      await save({ status: e.target.value });
      if (state.quote) renderWorkOrder(state.quote);
    };
    $('#e-account').onchange = async (e) => {
      const q = state.quote;
      await save({ customerId: e.target.value || null });
      if (state.quote === q) q.customerId = e.target.value || null;
    };
    $('#e-back').onclick = async () => { await save(); if (state.back) state.back.go(); else go(''); };
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
      const body = acceptedConfirm(q, 'verwijderen');
      if (body === null) return;
      if (!body && !confirm(`Offerte ${q.number} verwijderen?`)) return;
      try {
        await api(`quotes/${encodeURIComponent(q.id)}`, { method: 'DELETE', body: body || undefined });
        state.dirty = false;
        toast(`Offerte ${q.number} verwijderd`);
        go('');
      } catch (e) {
        toast(`Verwijderen mislukt: ${e.message}`, true);
      }
    } else if (act === 'purge') {
      const body = acceptedConfirm(q, 'definitief wissen');
      if (body === null) return;
      if (!body && !confirm(`Offerte ${q.number} definitief wissen, inclusief klantgegevens? Dit kan niet ongedaan worden gemaakt.`)) return;
      try {
        await api(`admin/quotes/${encodeURIComponent(q.id)}`, { method: 'DELETE', body: body || undefined });
        state.dirty = false;
        toast(`Offerte ${q.number} gewist`);
        go('');
      } catch (e) {
        toast(`Wissen mislukt: ${e.message}`, true);
      }
    }
  }

  // Een geaccordeerde offerte alleen weg na het overtypen van het nummer.
  // Geeft { confirm } terug, false als er geen extra bevestiging nodig is en
  // null als de gebruiker afbreekt of zich vertypt.
  function acceptedConfirm(q, what) {
    if (q.status !== 'akkoord') return false;
    const typed = prompt(`Offerte ${q.number} is geaccordeerd door de klant${q.acceptance?.name ? ` (${q.acceptance.name})` : ''}.\n\nWeet je zeker dat je deze offerte wilt ${what}? Gekoppelde werkorders blijven bestaan. Dit kan niet ongedaan worden gemaakt.\n\nTyp ter bevestiging het offertenummer "${q.number}":`);
    if (typed == null) return null;
    if (typed.trim() !== q.number) { toast('Het offertenummer klopt niet; er is niets verwijderd.', true); return null; }
    return { confirm: typed.trim() };
  }

  // ---------- PDF (afdrukversie) ----------
  function renderPrint() {
    $('#print').innerHTML = V.documentHtml(state.quote, state.profile);
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
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
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
          const off = !Q.included(l);
          const r = ws.addRow([l.code, `${l.description}${l.optional ? (off ? ' (optie, niet gekozen)' : ' (optie)') : ''}`, l.qty, l.unit, l.price, l.vat]);
          // Een niet gekozen optie telt niet mee in de totalen.
          r.getCell(7).value = off ? 0 : { formula: `C${r.number}*E${r.number}` };
          if (off) r.font = { italic: true, color: { argb: 'FF8A96A3' } };
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
        if (!d.lines.some((l) => l.vat === rate && Q.included(l))) continue;
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
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
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
    loadMail();
  }

  async function loadMail() {
    const f = $('#mf');
    try {
      const out = await api('quote-mail');
      for (const k of ['host', 'port', 'user', 'from', 'replyTo']) f[k].value = out.config[k] ?? '';
      f.secure.value = String(Boolean(out.config.secure));
      f.password.value = '';
      f.password.placeholder = out.passwordSet ? '•••••••• (ingesteld; leeg laten = ongewijzigd)' : '';
      f.testTo.value = f.testTo.value || state.profile.email || '';
      $('#mf-state').textContent = out.config.host && out.config.from ? 'De mailserver is ingesteld.' : 'Nog geen mailserver ingesteld: versturen gaat dan via je eigen mailprogramma.';
    } catch (e) {
      $('#mf-state').textContent = `Kan de e-mailinstellingen niet laden: ${e.message}`;
    }
  }

  async function saveMail(e) {
    if (e) e.preventDefault();
    const f = $('#mf');
    const body = {
      config: { host: f.host.value, port: Number(f.port.value) || 587, secure: f.secure.value === 'true', user: f.user.value, from: f.from.value, replyTo: f.replyTo.value },
    };
    if (f.password.value) body.password = f.password.value;
    const out = await api('quote-mail', { method: 'PUT', body });
    state.mail = Boolean(out.config.host && out.config.from);
    await loadMail();
    return out;
  }

  async function testMail() {
    const f = $('#mf');
    const btn = $('#mf-test');
    btn.disabled = true;
    try {
      await saveMail();
      await api('quote-mail/test', { method: 'POST', body: { to: f.testTo.value } });
      toast(`Testmail verstuurd naar ${f.testTo.value}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
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
    $('#v-sign').hidden = true;
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
    const ps = params();
    const direct = ps.get('id') || ps.get('plan');
    // Rechtstreeks naar een offerte (vanuit portaal, dossier, werkorder of
    // planner): het overzicht niet eerst laten zien, en de terugknop gaat
    // terug naar waar je vandaan kwam.
    if (direct) $('#list-view').hidden = true;
    const from = direct && window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from) {
      state.back = from;
      $('#e-back').textContent = from.label;
      $('#v-back').textContent = from.label;
    }
    // De offerte alvast ophalen, tegelijk met api/me.
    if (ps.get('id') && !ps.get('plan') && location.protocol !== 'file:') {
      const req = api(`quotes/${encodeURIComponent(ps.get('id'))}`);
      req.catch(() => {});
      state.pre = { id: ps.get('id'), req };
    }
    // Webshopprijzen (als de organisatie een webshop heeft gekoppeld) vóór het opbouwen uit een plan.
    const shop = window.ShopCatalog ? window.ShopCatalog.load() : null;
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    state.all = rights.includes('offertes.alle');
    state.klant = !rights.includes('offertes') && rights.includes('offertes.klant');
    state.werkorders = rights.includes('werkorders');
    if (!state.me.user && !state.me.guest) {
      $('#list-view').hidden = false;
      $('#l-table').innerHTML = '<tr><td class="empty">Log eerst in om offertes te maken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    // Bedrijfsprofiel, klanten en webshopprijzen tegelijk.
    const [out, customers] = await Promise.all([
      api('quote-profile').catch(() => null),
      state.klant ? null : api('quote-customers').catch(() => null),
      shop,
    ]);
    if (out) {
      state.profile = out.profile;
      state.canEdit = out.canEdit;
      state.mail = Boolean(out.mail);
    } else {
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
      state.customers = (customers && customers.items) || [];
    }
    $('#v-back').onclick = () => { if (state.back) state.back.go(); else go(''); };
    $('#v-pdf').onclick = () => window.print();
    let t;
    $('#l-search').oninput = () => { clearTimeout(t); t = setTimeout(renderList, 150); };
    $('#l-status').onchange = renderList;
    $('#l-all').onchange = loadList;
    $('#l-new-plan').onclick = pickPlan;
    $('#l-new-empty').onclick = () => createEmpty();
    $('#l-profile').onclick = openProfile;
    $('#l-export').onclick = exportListXlsx;
    $('#pf').onsubmit = saveProfile;
    $('#mf').onsubmit = async (e) => {
      try { await saveMail(e); toast('E-mailinstellingen opgeslagen'); } catch (err) { toast(`Opslaan mislukt: ${err.message}`, true); }
    };
    $('#mf-test').onclick = testMail;
    $('#sf').onsubmit = sendQuote;
    document.querySelectorAll('.modal').forEach((m) => {
      m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; };
    });
    bindEditor();
    window.addEventListener('popstate', route);
    // Terug via de knop Terug van de browser: het overzicht opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => { if (!state.quote) loadList(); });
    route();
  }

  init();
})();
