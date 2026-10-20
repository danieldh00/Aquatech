// Uitbesteden: werkorders aanbieden aan andere organisaties op het platform
// en opdrachten van anderen aannemen of afwijzen. Gegevens uit /api/outsourcing;
// alleen voor beheerders (recht 'uitbesteden'), en alleen als versturen of
// ontvangen in Beheer > Instellingen aan staat. Een nieuwe uitbesteding begint
// vanuit een werkorder (?wo=<id>).
(function () {
  const W = window.WorkOrderCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const eur = (v) => (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const STATUS = { aangeboden: 'Aangeboden', geaccepteerd: 'Aangenomen', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken' };

  const state = { data: null, wo: null, tab: 'incoming' };

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
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error });
    return out;
  }

  // Planning in woorden: "di 13 april 2027, 08:00–12:00 uur (2 werkdagen)".
  function planning(p) {
    if (!p.plannedDate) return 'Nog geen datum: in overleg';
    const time = p.startTime ? `, ${p.startTime}${p.endTime ? `–${p.endTime}` : ''} uur` : '';
    return `${day(p.plannedDate)}${time}${p.days > 1 ? ` (${p.days} werkdagen)` : ''}`;
  }

  const pill = (s, label) => `<span class="pill of-${esc(s)}">${esc(label || STATUS[s] || s)}</span>`;

  // ---------- Aangeboden aan ons ----------
  function detailsOf(p) {
    const g = p.design;
    const design = g ? [g.zones ? `${g.zones} zones` : '', g.sprinklers ? `${g.sprinklers} sproeiers` : '', g.lawnM2 ? `${nl(g.lawnM2, 0)} m² gazon` : '', g.mainPipe || '']
      .filter(Boolean).join(' · ') : '';
    const steps = (p.steps || []).map((s) => `<tr><td>${esc(W.PHASES[s.phase] || s.phase)}</td><td>${esc(s.title)}</td><td class="num">${s.hours ? `${nl(s.hours)} u` : ''}</td></tr>`).join('');
    const mats = (p.materials || []).map((m) => `<tr><td>${esc(m.code)}</td><td>${esc(m.description)}</td><td class="num">${nl(m.qty)} ${esc(m.unit)}</td></tr>`).join('');
    return `${design ? `<p class="small">${esc(design)}</p>` : ''}
      <details><summary>Werkstappen (${(p.steps || []).length})</summary><table class="mini"><tbody>${steps || '<tr><td class="muted">Geen</td></tr>'}</tbody></table></details>
      <details><summary>Materialen (${(p.materials || []).length})</summary><table class="mini"><tbody>${mats || '<tr><td class="muted">Geen</td></tr>'}</tbody></table></details>`;
  }

  function renderIncoming() {
    const all = $('#i-all').checked;
    const items = (state.data.incoming || []).filter((o) => all || o.myStatus === 'aangeboden');
    const open = (state.data.incoming || []).filter((o) => o.myStatus === 'aangeboden').length;
    $('#t-incoming').textContent = open ? String(open) : '';
    const el = $('#i-list');
    if (!state.data.settings.receive) {
      el.innerHTML = '<p class="notice">Opdrachten ontvangen staat uit. Een beheerder zet het aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.</p>';
      return;
    }
    if (!items.length) {
      el.innerHTML = `<p class="notice muted">${all ? 'Nog geen opdrachten aangeboden.' : 'Er staan geen opdrachten voor je klaar.'}</p>`;
      return;
    }
    el.innerHTML = items.map((o) => {
      const p = o.preview || {};
      const actions = o.myStatus === 'aangeboden'
        ? `<button class="btn primary" data-accept="${esc(o.id)}">Aannemen</button><button class="btn" data-decline="${esc(o.id)}">Afwijzen</button>`
        : o.receivedWorkOrderId ? `<a class="btn" href="../werkorders/?id=${encodeURIComponent(o.receivedWorkOrderId)}">Naar onze werkorder</a>` : '';
      return `<article class="card-form offer st-${esc(o.myStatus)}">
        <div class="offer-head">
          <h2>${esc(p.title || 'Werkorder')}${p.place ? ` <span class="muted">· ${esc(p.place)}</span>` : ''}</h2>
          <span class="spacer"></span>
          ${pill(o.myStatus)}
        </div>
        <div class="offer-info">
          <div><span class="lbl">Van</span>${esc(o.fromName)}${o.createdBy ? ` <span class="muted small">(${esc(o.createdBy)})</span>` : ''}</div>
          <div><span class="lbl">Gewenste planning</span>${esc(planning(p))}</div>
          <div><span class="lbl">Geschat werk</span>${p.hours ? `${nl(p.hours)} uur` : '–'}${p.zones ? ` · ${p.zones} zones` : ''}</div>
          <div><span class="lbl">Vergoeding</span>${o.fee != null ? `${esc(eur(o.fee))} excl. btw` : 'In overleg'}</div>
          <div><span class="lbl">Aangeboden</span>${esc(when(o.createdAt))}${o.direct ? ' · alleen aan jullie' : ' · aan meerdere organisaties'}</div>
        </div>
        ${o.message ? `<p class="offer-msg">${esc(o.message)}</p>` : ''}
        ${p.summary ? `<p class="small muted">${esc(p.summary)}</p>` : ''}
        ${detailsOf(p)}
        ${actions ? `<div class="row offer-actions">${actions}</div>` : ''}
      </article>`;
    }).join('');
    el.querySelectorAll('[data-accept]').forEach((b) => { b.onclick = () => accept(b.dataset.accept); });
    el.querySelectorAll('[data-decline]').forEach((b) => { b.onclick = () => decline(b.dataset.decline); });
  }

  async function accept(id) {
    const o = state.data.incoming.find((x) => x.id === id);
    if (!confirm(`Opdracht "${o.preview.title}" van ${o.fromName} aannemen?\n\nJullie krijgen een eigen werkorder met de klantgegevens; ${o.fromName} ziet daarna de voortgang (status, planning en afgevinkte stappen).`)) return;
    try {
      const out = await api(`outsourcing/offers/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {} });
      toast(`Aangenomen: werkorder ${out.workOrder.number}`);
      location.href = `../werkorders/?id=${encodeURIComponent(out.workOrder.id)}`;
    } catch (e) {
      toast(e.message, true);
      load();
    }
  }

  async function decline(id) {
    const reason = prompt('Opdracht afwijzen. Toelichting voor de aanbieder (optioneel):', '');
    if (reason === null) return;
    try {
      await api(`outsourcing/offers/${encodeURIComponent(id)}/decline`, { method: 'POST', body: { reason } });
      toast('Afgewezen');
    } catch (e) {
      toast(e.message, true);
    }
    load();
  }

  // ---------- Door ons uitbesteed ----------
  function execution(o) {
    const x = o.execution;
    if (!x) return '<span class="muted">–</span>';
    if (x.removed) return '<span class="muted">Werkorder bij de ontvanger verwijderd</span>';
    return `<span class="pill wo-${esc(x.status)}">${esc(W.STATUSES[x.status] || x.status)}</span><span class="sub">${x.plannedDate ? esc(planning(x)) : 'Nog niet gepland'}</span>
      <span class="sub">${x.progress.done}/${x.progress.steps} stappen${x.completedOn ? ` · opgeleverd ${esc(day(x.completedOn))}` : ''}</span>`;
  }

  function renderOutgoing() {
    const items = state.data.outgoing || [];
    $('#t-outgoing').textContent = items.filter((o) => o.status === 'aangeboden' || o.status === 'geaccepteerd').length || '';
    const t = $('#o-table');
    if (!items.length) {
      t.innerHTML = `<tbody><tr><td class="empty">${state.data.settings.send ? 'Nog niets uitbesteed. Open een werkorder en kies in het menu ⋯ “Uitbesteden”.' : 'Uitbesteden staat uit. Een beheerder zet het aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.'}</td></tr></tbody>`;
      return;
    }
    t.innerHTML = `<thead><tr><th>Werkorder</th><th>Aan</th><th>Status</th><th>Uitvoering</th><th>Aangeboden</th><th></th></tr></thead><tbody>${items.map((o) => `<tr>
      <td class="wrap"><a href="../werkorders/?id=${encodeURIComponent(o.workOrderId)}"><b>${esc(o.preview.title || 'Werkorder')}</b></a><span class="sub">${esc(o.preview.place || '')}${o.fee != null ? ` · ${esc(eur(o.fee))}` : ''}</span></td>
      <td>${o.receiverName ? esc(o.receiverName) : '<span class="muted">Alle organisaties</span>'}${!o.direct && o.status === 'aangeboden' && o.declinedCount ? `<span class="sub">${o.declinedCount}× afgewezen</span>` : ''}</td>
      <td>${pill(o.status)}${o.respondedAt ? `<span class="sub">${esc(when(o.respondedAt))}${o.respondedBy ? ` · ${esc(o.respondedBy)}` : ''}</span>` : ''}${o.reason ? `<span class="sub">“${esc(o.reason)}”</span>` : ''}</td>
      <td>${execution(o)}</td>
      <td>${esc(when(o.createdAt))}<span class="sub">${esc(o.createdBy)}</span></td>
      <td>${o.status === 'aangeboden' ? `<button class="btn small danger" data-withdraw="${esc(o.id)}">Intrekken</button>` : ''}</td>
    </tr>`).join('')}</tbody>`;
    t.querySelectorAll('[data-withdraw]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Aanbod intrekken? Andere organisaties kunnen het dan niet meer aannemen.')) return;
        try { await api(`outsourcing/offers/${encodeURIComponent(b.dataset.withdraw)}`, { method: 'DELETE' }); toast('Ingetrokken'); } catch (e) { toast(e.message, true); }
        load();
      };
    });
  }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('#tab-incoming').hidden = name !== 'incoming';
    $('#tab-outgoing').hidden = name !== 'outgoing';
    try { history.replaceState(null, '', `${location.search}#${name}`); } catch { /* file:// */ }
  }

  // ---------- Nieuwe uitbesteding ----------
  async function openNew(id) {
    const f = $('#u-new');
    const err = $('.err', f);
    let wo;
    try {
      wo = await api(`workorders/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(`Kan de werkorder niet openen: ${e.message}`, true);
      return;
    }
    state.wo = wo;
    f.hidden = false;
    $('#n-cancel').href = `../werkorders/?id=${encodeURIComponent(wo.id)}`;
    $('#n-heading').textContent = `Werkorder ${wo.number} uitbesteden`;
    $('#n-wo').innerHTML = `<b>${esc(wo.title)}</b> · ${esc(wo.customer || '–')} · ${esc(wo.address || '')}
      <span class="sub">${esc(planning(wo.data))} · ${nl(wo.progress.hours)} uur · ${wo.data.steps.length} stappen · ${wo.data.materials.length} materialen</span>`;
    const partners = state.data.partners || [];
    f.to.innerHTML = `<option value="">Alle organisaties die opdrachten ontvangen (${partners.length})</option>${partners
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.region ? ` – ${esc(p.region)}` : ''}</option>`).join('')}`;
    const blocked = !state.data.settings.send ? 'Uitbesteden staat uit voor je organisatie. Een beheerder zet het aan in Beheer → Instellingen → Uitbesteden.'
      : wo.outsourcing && wo.outsourcing.role === 'uitbesteed' ? `Deze werkorder is al ${wo.outsourcing.status === 'geaccepteerd' ? `uitbesteed aan ${wo.outsourcing.partner}` : 'aangeboden'}.`
        : wo.outsourcing && wo.outsourcing.role === 'aangenomen' ? `Deze werkorder hebben jullie aangenomen van ${wo.outsourcing.partner}; die kun je niet verder uitbesteden.`
          : !['open', 'gepland'].includes(wo.status) ? 'Alleen een werkorder met status Nieuw of Gepland kan worden uitbesteed.'
            : !partners.length ? 'Er zijn nog geen andere organisaties die opdrachten ontvangen.' : '';
    err.textContent = blocked;
    f.querySelectorAll('select, input, textarea, button[type=submit]').forEach((el) => { el.disabled = Boolean(blocked); });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const fee = f.fee.value.trim() === '' ? null : Number(f.fee.value.replace(',', '.'));
      if (fee !== null && !(fee >= 0)) { err.textContent = 'Vul een geldig bedrag in, of laat de vergoeding leeg.'; return; }
      const target = partners.find((p) => p.id === f.to.value);
      if (!confirm(`Werkorder ${wo.number} aanbieden aan ${target ? target.name : `alle ${partners.length} organisaties die opdrachten ontvangen`}?`)) return;
      try {
        await api('outsourcing/offers', { method: 'POST', body: { workOrderId: wo.id, toTenantId: f.to.value || null, fee, message: f.message.value } });
        toast(`Werkorder ${wo.number} aangeboden`);
        history.replaceState(null, '', './#outgoing');
        f.hidden = true;
        await load();
        showTab('outgoing');
      } catch (e) {
        err.textContent = e.message;
      }
    };
  }

  async function load() {
    try {
      state.data = await api('outsourcing');
    } catch (e) {
      $('#u-denied').hidden = false;
      $('#u-denied').textContent = `Kan Uitbesteden niet laden: ${e.message}`;
      return;
    }
    const s = state.data.settings;
    const off = $('#u-off');
    off.hidden = s.send || s.receive;
    off.innerHTML = 'Uitbesteden staat uit voor je organisatie. Zet versturen en/of ontvangen aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.'
      + (state.data.environment === 'test' ? ' Dit is een testomgeving: die werkt alleen met andere testomgevingen.' : '');
    $('#u-app').hidden = false;
    renderIncoming();
    renderOutgoing();
  }

  async function init() {
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('uitbesteden')) {
      const d = $('#u-denied');
      d.hidden = false;
      d.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Uitbesteden is alleen voor beheerders. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
    $('#i-all').onchange = renderIncoming;
    await load();
    const hash = location.hash.slice(1);
    if (hash === 'outgoing' || hash === 'incoming') showTab(hash);
    else if (state.data && !(state.data.incoming || []).some((o) => o.myStatus === 'aangeboden') && (state.data.outgoing || []).length) showTab('outgoing');
    const wo = new URLSearchParams(location.search).get('wo');
    if (wo && state.data) openNew(wo);
    if (window.AquatechCommon) window.AquatechCommon.onReturn(load);
  }

  init();
})();
