// Klantdossiers: per klant alle installaties (werkorders) met de oplevering,
// het ontwerp, de zones, de geplaatste materialen en de foto's. Overzicht als
// tabel (Excel-export), een dossier af te drukken als opleverrapport (PDF via
// de browser). Gegevens uit /api/dossiers; alleen beheerders en installateurs.
(function () {
  const W = window.WorkOrderCore;
  const KINDS = window.WorkOrderPhotos.KINDS;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const eur = (v) => (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const short = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const QUOTE_STATUS = { concept: 'Concept', verzonden: 'Verzonden', akkoord: 'Akkoord', afgewezen: 'Afgewezen', verlopen: 'Verlopen' };

  const state = { me: null, profile: null, items: [], sort: { key: 'lastActivity', dir: -1 }, dossier: null };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast no-print show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast no-print'; }, 3500);
  }

  async function api(url) {
    const res = await fetch(`../api/${url}`, { cache: 'no-store' });
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
    { key: 'name', label: 'Klant', value: (d) => d.name.toLowerCase(), html: (d) => `<b>${esc(d.name)}</b>${d.account ? '<span class="badge-acc" title="Heeft een klantaccount (portaal)">account</span>' : ''}` },
    { key: 'address', label: 'Adres', value: (d) => d.addresses[0] || '', html: (d) => esc(d.addresses.join(' · ') || '–'), cls: 'wrap' },
    { key: 'installations', label: 'Installaties', value: (d) => d.installations, html: (d) => `${d.completed} van ${d.installations} opgeleverd`, cls: 'num' },
    { key: 'photos', label: "Foto's", value: (d) => d.photos, html: (d) => (d.photos ? String(d.photos) : '–'), cls: 'num' },
    { key: 'lastCompletedOn', label: 'Laatst opgeleverd', value: (d) => d.lastCompletedOn || '', html: (d) => esc(short(d.lastCompletedOn) || '–') },
    { key: 'lastActivity', label: 'Laatste activiteit', value: (d) => d.lastActivity, html: (d) => esc(when(d.lastActivity)) },
  ];

  function visible() {
    const term = $('#l-search').value.trim().toLowerCase();
    const done = $('#l-done').checked;
    const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((d) => !done || d.completed > 0)
      .filter((d) => !term || [d.name, ...d.addresses, d.account ? d.account.displayName : ''].join(' ').toLowerCase().includes(term))
      .sort((a, b) => {
        const x = col.value(a), y = col.value(b);
        return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir;
      });
  }

  function renderList() {
    const items = visible();
    const head = `<thead><tr>${COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.cls === 'num' ? 'num ' : ''}${state.sort.key === c.key ? (state.sort.dir > 0 ? 'asc' : 'desc') : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
    const body = items.length
      ? items.map((d) => `<tr data-id="${esc(d.key)}">${COLUMNS.map((c) => `<td class="${c.cls || ''}">${c.html(d)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${COLUMNS.length}">${state.items.length ? 'Geen klanten gevonden met dit filter.' : 'Nog geen dossiers. Een dossier ontstaat zodra er voor een klant een werkorder is.'}</td></tr>`;
    $('#l-table').innerHTML = head + `<tbody>${body}</tbody>`;
    $('#l-count').textContent = `${items.length} van ${state.items.length} klanten`;
    const tot = state.items.reduce((s, d) => ({ i: s.i + d.installations, c: s.c + d.completed, p: s.p + d.photos }), { i: 0, c: 0, p: 0 });
    $('#l-stats').hidden = !state.items.length;
    $('#l-stats').innerHTML = `<div class="stat"><b>${state.items.length}</b><span>klanten</span></div>
      <div class="stat"><b>${tot.c}</b><span>installaties opgeleverd</span></div>
      <div class="stat"><b>${tot.i - tot.c}</b><span>in uitvoering of gepland</span></div>
      <div class="stat"><b>${tot.p}</b><span>foto's</span></div>`;
  }

  async function loadList() {
    try {
      state.items = (await api('dossiers')).items || [];
    } catch (e) {
      state.items = [];
      toast(`Dossiers laden mislukt: ${e.message}`, true);
    }
    renderList();
  }

  async function exportXlsx() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Klantdossiers', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
        { header: 'Klant', key: 'name', width: 30 },
        { header: 'Klantaccount', key: 'account', width: 22 },
        { header: 'Adres(sen)', key: 'address', width: 44 },
        { header: 'Installaties', key: 'installations', width: 12 },
        { header: 'Opgeleverd', key: 'completed', width: 12 },
        { header: "Foto's", key: 'photos', width: 9 },
        { header: 'Laatst opgeleverd', key: 'lastCompletedOn', width: 18 },
        { header: 'Laatste activiteit', key: 'lastActivity', width: 20 },
      ];
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      for (const d of items) {
        ws.addRow({
          name: d.name, account: d.account ? d.account.displayName : '', address: d.addresses.join('; '),
          installations: d.installations, completed: d.completed, photos: d.photos,
          lastCompletedOn: d.lastCompletedOn ? new Date(`${d.lastCompletedOn}T12:00:00`) : null,
          lastActivity: d.lastActivity ? new Date(d.lastActivity) : null,
        });
      }
      ws.getColumn('lastCompletedOn').numFmt = 'dd-mm-yyyy';
      ws.getColumn('lastActivity').numFmt = 'dd-mm-yyyy hh:mm';
      ws.autoFilter = { from: 'A1', to: 'H1' };
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `klantdossiers_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast(`${items.length} klanten geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  // ---------- Dossier ----------
  const field = (label, value) => (value ? `<div><span class="lbl">${esc(label)}</span>${value}</div>` : '');

  function designLine(g) {
    if (!g) return '';
    return [g.lawnM2 ? `${nl(g.lawnM2, 0)} m² gazon` : '', g.sprinklers ? `${g.sprinklers} sproeiers` : '', g.zones ? `${g.zones} zones` : '',
      g.pressureBar ? `${nl(g.pressureBar, 1)} bar` : '', g.flowM3h ? `${nl(g.flowM3h, 1)} m³/u` : '', g.mainPipe ? `hoofdleiding ${g.mainPipe}` : '']
      .filter(Boolean).join(' · ');
  }

  function photoTiles(inst, internal) {
    const list = inst.photos.filter((p) => internal || p.customerVisible);
    if (!list.length) return '<p class="ph-empty">Geen foto\'s bij deze installatie.</p>';
    return Object.entries(KINDS).map(([k, label]) => {
      const group = list.filter((p) => p.kind === k);
      if (!group.length) return '';
      return `<div class="ph-group">${label} (${group.length})</div><div class="ph-grid">${group.map((p) => `
        <div class="ph-tile${p.customerVisible ? '' : ' hidden-for-customer'}" data-photo="${esc(p.id)}" data-inst="${esc(inst.id)}">
          ${p.customerVisible ? '' : '<span class="ph-badge off">Alleen intern</span>'}
          <button class="ph-img" type="button" title="Vergroten"><img loading="lazy" src="../${esc(p.thumbUrl)}" alt="${esc(p.caption || label)}"></button>
          <div class="ph-meta"><span class="ph-cap">${esc(p.caption || label)}</span><span>${esc(when(p.takenAt || p.createdAt))}</span></div>
        </div>`).join('')}</div>`;
    }).join('');
  }

  function installation(inst, internal) {
    const r = inst.report;
    const zones = inst.zones.length ? `<details open><summary>Zone-indeling (${inst.zones.length})</summary>
      <table class="mini"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th><th class="num">l/u</th><th class="num">Leiding</th><th class="num">Druk</th></tr></thead><tbody>
      ${inst.zones.map((z) => `<tr class="${z.ok ? '' : 'bad'}"><td>${esc(z.name)}</td><td>${esc(z.kind)}</td><td>${esc(z.parts)}</td><td class="num">${nl(z.flowLph, 0)}</td><td class="num">${z.pipeM ? `${nl(z.pipeM, 1)} m` : ''}</td><td class="num">${z.pressureBar ? `${nl(z.pressureBar, 1)} bar` : ''}</td></tr>`).join('')}
      </tbody></table></details>` : '';
    const mats = inst.materials.length ? `<details><summary>Geplaatste materialen (${inst.materials.length})</summary>
      <table class="mini"><thead><tr><th>Code</th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th></tr></thead><tbody>
      ${inst.materials.map((m) => `<tr><td>${esc(m.code)}</td><td>${esc(m.description)}</td><td class="num">${nl(m.qty)}</td><td>${esc(m.unit)}</td></tr>`).join('')}
      </tbody></table></details>` : '';
    const line = designLine(inst.design);
    return `<section class="card-form inst st-${esc(inst.status)}">
      <div class="inst-head">
        <h2>${esc(inst.title || 'Installatie')}</h2>
        <span class="pill wo-${esc(inst.status)}">${esc(W.STATUSES[inst.status] || inst.status)}</span>
        <span class="spacer"></span>
        <a class="no-print small" href="../werkorders/?id=${encodeURIComponent(inst.id)}">Werkorder ${esc(inst.number)} openen</a>
      </div>
      <div class="inst-info">
        ${field('Adres', esc(inst.address))}
        ${field('Opgeleverd op', esc(day(inst.completedOn)) || (inst.status === 'gereed' ? '' : '<span class="muted">Nog niet opgeleverd</span>'))}
        ${field('Afgetekend door (klant)', esc(r.signedBy))}
        ${field('Uitgevoerd door', esc([...new Set([inst.assignee, inst.crew].filter(Boolean))].join(', ')))}
        ${field('Gepland', esc(inst.plannedDate && inst.status !== 'gereed' ? day(inst.plannedDate) : ''))}
        ${field('Werkorder', esc(inst.number))}
        ${field('Offerte', inst.quoteId ? `<a href="../offertes/?id=${encodeURIComponent(inst.quoteId)}">${esc(inst.quoteNumber || 'offerte')}</a>` : '')}
        ${field('Ontwerp', inst.planId ? `<a href="../beregening/?plan=${encodeURIComponent(inst.planId)}">${esc(inst.planTitle || 'beregeningsplan')}</a>` : '')}
      </div>
      ${line ? `<div class="design-line"><b>Ontwerp:</b> ${esc(line)}</div>` : ''}
      ${r.notes ? `<h3>Opmerkingen bij de oplevering</h3><div class="notes">${esc(r.notes)}</div>` : ''}
      <h3>Foto's</h3>
      ${photoTiles(inst, internal)}
      ${zones}${mats}
    </section>`;
  }

  function renderDossier() {
    const d = state.dossier;
    const internal = $('#d-internal').checked;
    const c = d.customer;
    const p = state.profile || {};
    const company = [p.companyName, p.address, [p.phone, p.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const done = d.installations.filter((i) => i.status === 'gereed').length;
    const nPhotos = d.installations.reduce((s, i) => s + i.photos.filter((x) => internal || x.customerVisible).length, 0);
    document.title = `Klantdossier ${c.name || ''} – AquaTech Service`;
    $('#d-body').innerHTML = `
      <header class="d-head">
        <img src="../shared/logo-white.png" alt="${esc(p.companyName || 'AquaTech Service')}">
        <div class="d-title"><h1>Klantdossier ${esc(c.name)}</h1><span class="sub">${done} van ${d.installations.length} installaties opgeleverd · ${nPhotos} foto's · bijgewerkt ${esc(day(new Date().toISOString()))}</span></div>
        <div class="d-company">${esc(company)}</div>
      </header>
      <section class="card-form">
        <h3>Klant</h3>
        <div class="d-cust">
          ${field('Naam', esc(c.name))}
          ${field('Contactpersoon', esc(c.contact))}
          ${field('Telefoon', c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : '')}
          ${field('E-mail', c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '')}
          ${field('Adres(sen)', d.addresses.map(esc).join('<br>'))}
          ${field('Klantportaal', d.account ? `account ${esc(d.account.displayName)}` : '<span class="muted">geen klantaccount</span>')}
        </div>
      </section>
      ${d.installations.map((i) => installation(i, internal)).join('')}
      ${d.quotes.length ? `<section class="card-form no-print"><h3>Offertes</h3><table class="mini grid"><thead><tr><th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Totaal incl. btw</th><th>Datum</th></tr></thead><tbody>
        ${d.quotes.map((o) => `<tr><td><a href="../offertes/?id=${encodeURIComponent(o.id)}">${esc(o.number)}</a></td><td>${esc(o.title)}</td><td>${esc(QUOTE_STATUS[o.status] || o.status)}</td><td class="num">${esc(eur(o.totalIncl))}</td><td>${esc(short(o.createdAt))}</td></tr>`).join('')}
        </tbody></table></section>` : ''}
      <p class="d-foot">${esc([p.companyName, p.website].filter(Boolean).join(' · '))}</p>`;
  }

  async function loadDossier(key) {
    $('#list-view').hidden = true;
    $('#detail-view').hidden = false;
    $('#d-body').innerHTML = '<p class="muted">Dossier laden…</p>';
    try {
      state.dossier = await api(`dossiers/${encodeURIComponent(key)}`);
      renderDossier();
      window.scrollTo(0, 0);
    } catch (e) {
      toast(`Kan het dossier niet openen: ${e.message}`, true);
      go('');
    }
  }

  async function printDossier() {
    // Wachten tot alle foto's geladen zijn (lazy loading staat uit bij afdrukken).
    const imgs = [...document.querySelectorAll('#d-body img')];
    imgs.forEach((i) => { i.loading = 'eager'; });
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    // Ingeklapte onderdelen (materialen) komen wel op papier.
    const closed = [...document.querySelectorAll('#d-body details:not([open])')];
    closed.forEach((d) => { d.open = true; });
    window.addEventListener('afterprint', () => closed.forEach((d) => { d.open = false; }), { once: true });
    const old = document.title;
    document.title = `Opleverrapport ${state.dossier.customer.name || ''}`.trim();
    window.print();
    setTimeout(() => { document.title = old; }, 500);
  }

  function showList() {
    state.dossier = null;
    document.title = 'Klantdossiers – AquaTech Service';
    $('#detail-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  function route() {
    const key = params().get('klant');
    if (key) return loadDossier(key);
    showList();
  }

  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    if (!state.me.user || !rights.includes('werkorders')) {
      $('#l-export').hidden = true;
      $('#l-table').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<tr><td class="empty">Klantdossiers zijn alleen voor beheerders en installateurs. <a href="../">Terug naar het overzicht</a></td></tr>'
        : '<tr><td class="empty">Log eerst in om de klantdossiers te bekijken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    try { state.profile = (await api('quote-profile')).profile; } catch (e) { state.profile = { companyName: 'AquaTech Service' }; }
    let t;
    $('#l-search').oninput = () => { clearTimeout(t); t = setTimeout(renderList, 150); };
    $('#l-done').onchange = renderList;
    $('#l-export').onclick = exportXlsx;
    $('#l-table').onclick = (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        state.sort = { key: th.dataset.sort, dir: state.sort.key === th.dataset.sort ? -state.sort.dir : 1 };
        return renderList();
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) go(`klant=${encodeURIComponent(tr.dataset.id)}`);
    };
    $('#d-back').onclick = () => go('');
    $('#d-print').onclick = printDossier;
    $('#d-internal').onchange = () => { if (state.dossier) renderDossier(); };
    $('#d-body').addEventListener('click', (e) => {
      const tile = e.target.closest('.ph-tile');
      if (!tile || !e.target.closest('.ph-img')) return;
      const internal = $('#d-internal').checked;
      const inst = state.dossier.installations.find((i) => i.id === tile.dataset.inst);
      const list = Object.keys(KINDS).flatMap((k) => inst.photos.filter((p) => p.kind === k && (internal || p.customerVisible)));
      window.PhotoViewer.show(list.map((p) => ({ src: `../${p.url}`, caption: p.caption || KINDS[p.kind], sub: [KINDS[p.kind], when(p.takenAt || p.createdAt), inst.number].join(' · ') })),
        list.findIndex((p) => p.id === tile.dataset.photo));
    });
    window.addEventListener('popstate', route);
    route();
  }

  init();
})();
