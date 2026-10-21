// Voorraad bij een werkorder: per artikel uit de materiaallijst wat nodig is,
// wat er gereserveerd en afgeboekt staat en wat er nog beschikbaar is
// (/api/stock/workorders/:id). Reserveren gaat vanzelf bij elke wijziging van
// de werkorder; afboeken vanzelf als hij Gereed wordt, of hier met de hand
// (alles wat gereserveerd staat, of per regel een aantal; negatief = retour).
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: 3 });
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };
  const state = { wo: null, data: null, opts: {}, seq: 0 };
  const $ = (sel) => document.querySelector(sel);

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
  const toast = (msg, err) => (state.opts.toast ? state.opts.toast(msg, err) : null);

  function statusOf(l) {
    if (l.shortage > 0) return `<span class="pill st-short">Tekort ${esc(nl(l.shortage))}</span>`;
    if (l.needed > 0 && l.issued >= l.needed) return '<span class="pill st-done">Afgeboekt</span>';
    if (l.reserved > 0) return '<span class="pill st-ok">Gereserveerd</span>';
    if (!l.needed && l.issued) return '<span class="pill">Extra</span>';
    return '<span class="pill">–</span>';
  }

  function render() {
    const el = $('#st-body');
    const d = state.data;
    if (!el || !d) return;
    const stockLink = state.opts.manage ? '../voorraad/' : null;
    const open = ['open', 'gepland', 'bezig'].includes(d.workOrder.status);
    const reserved = d.lines.reduce((s, l) => s + (l.reserved > 0 ? 1 : 0), 0);
    const short = d.lines.filter((l) => l.shortage > 0).length;
    $('#st-summary').textContent = d.lines.length
      ? `${reserved} van ${d.lines.length} artikelen gereserveerd${short ? ` · tekort bij ${short}` : ''}`
      : '';
    const rows = d.lines.map((l) => `<tr data-code="${esc(l.code)}"${l.shortage > 0 ? ' class="bad"' : ''}>
      <td><b>${esc(l.code)}</b><span class="sub">${esc(l.name)}${l.location ? ` · ${esc(l.location)}` : ''}</span></td>
      <td class="num">${esc(nl(l.needed))} ${esc(l.unit)}</td>
      <td class="num">${esc(nl(l.issued))}</td>
      <td class="num">${esc(nl(l.reserved))}</td>
      <td class="num">${esc(nl(l.onHand))}<span class="sub">vrij ${esc(nl(l.available))}</span></td>
      <td>${statusOf(l)}</td>
      <td class="st-act"><input type="number" step="any" inputmode="decimal" aria-label="Aantal" placeholder="${l.needed > l.issued ? esc(nl(l.needed - l.issued)) : ''}">
        <button class="btn small" data-issue>Afboeken</button><button class="btn small ghost" data-return title="Terug op voorraad">Retour</button></td>
    </tr>`).join('');
    const missing = d.notInStock.length
      ? `<p class="muted small">Niet op voorraad bijgehouden: ${d.notInStock.map((m) => `<span class="code">${esc(m.code)}</span>`).join(' ')}${stockLink ? ` · <a href="${stockLink}?codes=${encodeURIComponent(d.notInStock.map((m) => m.code).join(','))}">Op voorraad nemen</a>` : ''}</p>`
      : '';
    const moves = d.movements.length ? `<details class="st-moves"><summary>Geboekt op deze werkorder (${d.movements.length})</summary>
      <table class="grid"><tbody>${d.movements.map((m) => `<tr><td>${esc(when(m.createdAt))}</td><td>${esc(KINDS[m.kind] || m.kind)}</td>
        <td><span class="code">${esc(m.code)}</span> ${esc(m.name)}</td><td class="num">${esc(nl(-m.qty))} ${esc(m.unit)}</td><td class="muted">${esc(m.userName)}${m.note ? ` · ${esc(m.note)}` : ''}</td></tr>`).join('')}</tbody></table></details>` : '';
    el.innerHTML = d.lines.length || d.notInStock.length ? `${d.lines.length ? `<div class="tablewrap"><table class="grid st-lines">
        <thead><tr><th>Artikel</th><th class="num">Nodig</th><th class="num">Afgeboekt</th><th class="num">Gereserveerd</th><th class="num">Op voorraad</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}
      ${missing}
      ${d.usage ? '<p class="muted small">Het geregistreerde materiaalverbruik wordt van de voorraad afgeboekt; bij Gereed vervalt de rest van de reservering.</p>'
        : open && reserved ? '<p class="muted small">Wordt de werkorder Gereed, dan wordt wat nog gereserveerd staat vanzelf afgeboekt.</p>' : ''}
      ${reserved ? '<div class="row"><button class="btn" data-issue-all>Alles afboeken wat gereserveerd staat</button></div>' : ''}
      ${moves}`
      : `<p class="muted small">Geen materialen met een artikelcode op deze werkorder.${stockLink ? ' Voorraad bijhouden doe je in <a href="../voorraad/">Voorraadbeheer</a>.' : ''}</p>`;
    el.querySelectorAll('tr[data-code]').forEach((tr) => {
      const input = tr.querySelector('input');
      const go = (sign) => {
        const v = Number(String(input.value || input.placeholder).replace(',', '.'));
        if (!(v > 0)) { toast('Vul een aantal in.', true); return; }
        issue([{ code: tr.dataset.code, qty: sign * v }], sign > 0 ? 'Afgeboekt' : 'Retour geboekt');
      };
      tr.querySelector('[data-issue]').onclick = () => go(1);
      tr.querySelector('[data-return]').onclick = () => go(-1);
    });
    const all = el.querySelector('[data-issue-all]');
    if (all) all.onclick = () => issue(undefined, 'Gereserveerde materialen afgeboekt');
  }

  async function issue(lines, done) {
    try {
      state.data = await api(`stock/workorders/${encodeURIComponent(state.wo.id)}/issue`, { method: 'POST', body: lines ? { lines } : {} });
      render();
      toast(done);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function refresh(wo = state.wo) {
    if (!wo || !$('#st-card')) return;
    state.wo = wo;
    const seq = ++state.seq;
    try {
      const data = await api(`stock/workorders/${encodeURIComponent(wo.id)}`);
      if (seq !== state.seq) return;
      state.data = data;
      $('#st-card').hidden = false;
      render();
    } catch (e) {
      if (seq === state.seq) $('#st-card').hidden = true;
    }
  }

  // opts: { toast, manage (recht 'voorraad': link naar Voorraadbeheer) }
  function open(wo, opts = {}) {
    state.opts = opts;
    state.data = null;
    const body = $('#st-body');
    if (body) body.innerHTML = '<p class="muted small">Voorraad laden…</p>';
    refresh(wo);
  }

  window.WorkOrderStock = { open, refresh };
})();
