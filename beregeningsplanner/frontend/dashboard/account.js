// Inlogstatus (wie ben ik, welke rol) voor het dashboard en de modules.
// AquatechAccount.load(base) haalt api/me op en vult #account; `base` is het
// relatieve pad naar de app-root ('' op het dashboard, '../' in een module).
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function load(base = '') {
    let me = { user: null, via: null, guest: true };
    if (location.protocol !== 'file:') {
      try {
        const res = await fetch(`${base}api/me`, { cache: 'no-store' });
        if (res.ok) me = await res.json();
      } catch (e) { /* offline: als gast tonen */ }
    }
    render(me, base);
    return me;
  }

  function render(me, base) {
    const el = document.getElementById('account');
    if (!el || location.protocol === 'file:') return;
    const u = me.user;
    if (u && u.kind !== 'gast' && me.impersonation) {
      // Een hoofdbeheerder werkt als deze gebruiker: in plaats van uitloggen terug naar het eigen account.
      el.innerHTML = `<span title="Namens ${esc(me.impersonation.by)}">${esc(u.displayName)} <span class="role">· ${esc(u.role)} (via ${esc(me.impersonation.by)})</span></span><button type="button" data-stop-imp title="Terug naar je eigen account">Eigen account</button>`;
      el.querySelector('[data-stop-imp]').onclick = (ev) => window.AquatechEnv.stopImpersonation(ev.currentTarget);
      return;
    }
    if (u && u.kind !== 'gast') {
      const role = me.platformAdmin ? 'hoofdbeheerder' : u.role;
      const out = '<button type="button" data-logout>Uitloggen</button>';
      el.innerHTML = `<span>${esc(u.displayName)} <span class="role">· ${role}</span></span>${out}`;
    } else {
      el.innerHTML = `<span class="role">Gast</span><a href="${esc(base)}login">Inloggen</a>`;
    }
    if (u && u.kind !== 'gast' && me.environments > 1) renderSwitcher(el, me, base);
    const btn = el.querySelector('[data-logout]');
    if (btn) {
      btn.onclick = async () => {
        try { await fetch(`${base}api/auth/logout`, { method: 'POST' }); } catch (e) { /* negeren */ }
        location.href = base || './';
      };
    }
  }

  // Wisselen tussen live en testomgevingen (en voor een hoofdbeheerder tussen
  // tenants) zonder opnieuw in te loggen. Na het wisselen wordt de pagina
  // opnieuw geladen, zodat alle gegevens uit de nieuwe omgeving komen.
  async function renderSwitcher(el, me, base) {
    let data;
    try {
      const res = await fetch(`${base}api/environments`, { cache: 'no-store' });
      if (!res.ok) return;
      data = await res.json();
    } catch (e) { return; }
    const items = data.items || [];
    if (items.length < 2) return;
    const label = (t) => (t.environment === 'test' ? `${t.parentName || ''} · test: ${t.name}` : t.name) + (t.disabled ? ' (uit)' : '');
    // Live-tenants op naam, de testomgevingen direct onder hun live-tenant.
    const live = items.filter((t) => t.environment === 'live');
    const ordered = [];
    for (const t of live) {
      ordered.push(t);
      for (const e of items) if (e.parentId === t.id) ordered.push(e);
    }
    for (const t of items) if (!ordered.includes(t)) ordered.push(t);
    const sel = document.createElement('select');
    sel.className = 'env-select';
    sel.title = 'Omgeving wisselen';
    sel.setAttribute('aria-label', 'Omgeving');
    sel.innerHTML = ordered.map((t) => `<option value="${esc(t.id)}"${t.id === data.current ? ' selected' : ''}>${esc(label(t))}</option>`).join('');
    sel.onchange = async () => {
      sel.disabled = true;
      try {
        const res = await fetch(`${base}api/environment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: sel.value }) });
        if (!res.ok) throw new Error();
        location.reload();
      } catch (e) {
        sel.disabled = false;
        sel.value = data.current;
      }
    };
    el.insertBefore(sel, el.firstChild);
  }

  root.AquatechAccount = { load };
})(window);
