// Inlogstatus (wie ben ik, welke rol) voor het dashboard en de modules.
// AquatechAccount.load(base) haalt api/me op en vult #account; `base` is het
// relatieve pad naar de app-root ('' op het dashboard, '../' in een module).
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // `fresh`: opnieuw ophalen (bijv. na het opslaan van het profiel); anders
  // hetzelfde verzoek als de zijbalk (shared/common.js).
  async function load(base = '', { fresh = false } = {}) {
    let me = { user: null, via: null, guest: true };
    if (location.protocol !== 'file:') {
      const common = window.AquatechCommon;
      if (common) {
        me = (await common.getJson('api/me', { fresh })) || me;
      } else {
        try {
          const res = await fetch(`${base}api/me`, { cache: 'no-store' });
          if (res.ok) me = await res.json();
        } catch (e) { /* offline: als gast tonen */ }
      }
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
      el.innerHTML = `<span title="Namens ${esc(me.impersonation.by)}">${esc(u.displayName)} <span class="role">· ${esc((u.roleLabel || u.role).toLowerCase())} (via ${esc(me.impersonation.by)})</span></span><button type="button" data-stop-imp title="Terug naar je eigen account">Eigen account</button>`;
      el.querySelector('[data-stop-imp]').onclick = (ev) => window.AquatechEnv.stopImpersonation(ev.currentTarget);
      return;
    }
    if (u && u.kind !== 'gast') {
      const role = me.platformAdmin ? 'hoofdbeheerder' : (u.roleLabel || u.role).toLowerCase();
      // Gebruikersmenu: Mijn profiel (alleen met een eigen account, niet met
      // de toegangscode) en uitloggen.
      const profile = u.kind === 'account' ? `<a role="menuitem" href="${esc(base)}profiel/">Mijn profiel</a>` : '';
      // Nieuws met het aantal nieuwe items (ook als stip op het rondje).
      const tools = root.AquatechModuleTools;
      const count = tools && tools.newsBadge ? tools.newsBadge(me.news || 0) : '';
      const news = `<a role="menuitem" href="${esc(base)}nieuws/">Nieuws ${count}</a>`;
      const dot = me.news > 0 ? '<span class="news-dot" data-news-count aria-hidden="true"></span>' : '';
      el.innerHTML = `<div class="user-menu">
          <button type="button" class="user-btn" aria-haspopup="true" aria-expanded="false" title="${esc(u.displayName)} · ${esc(role)}">
            <span class="avatar" aria-hidden="true">${esc(initials(u.displayName))}${dot}</span><span class="user-name">${esc(u.displayName)}</span>
          </button>
          <div class="user-pop" role="menu" hidden>
            <div class="user-head"><strong>${esc(u.displayName)}</strong><span>${esc(role)}${u.email ? ` · ${esc(u.email)}` : ''}</span></div>
            ${news}${profile}<button type="button" role="menuitem" data-logout>Uitloggen</button>
          </div>
        </div>`;
      wireMenu(el.querySelector('.user-menu'));
    } else {
      el.innerHTML = `<span class="role">Gast</span><a href="${esc(base)}login">Inloggen</a>`;
    }
    if (u && u.kind !== 'gast' && me.environments > 1) renderSwitcher(el, me, base);
    const btn = el.querySelector('[data-logout]');
    if (btn) {
      btn.onclick = async () => {
        // Nog niet verstuurde wijzigingen (offline gemaakt) gaan bij uitloggen
        // verloren: de offline gegevens worden op dit toestel gewist.
        const common = window.AquatechCommon;
        const st = common && common.offline ? await common.offline({ type: 'status' }, 1500) : null;
        let old = 0;
        try { old = Object.keys(localStorage).filter((k) => k.startsWith('aquatech_worklog_queue')).reduce((n, k) => n + (JSON.parse(localStorage.getItem(k) || '[]').length || 0), 0); } catch (e) { /* geen opslag */ }
        const waiting = (st && st.items ? st.items.length : 0) + old;
        if (waiting && !confirm(`Er ${waiting === 1 ? 'staat nog 1 wijziging' : `staan nog ${waiting} wijzigingen`} op dit toestel die nog niet ${waiting === 1 ? 'is' : 'zijn'} verstuurd. Bij uitloggen ${waiting === 1 ? 'gaat die' : 'gaan die'} verloren. Toch uitloggen?`)) return;
        try { await fetch(`${base}api/auth/logout`, { method: 'POST' }); } catch (e) { /* negeren */ }
        if (common && common.offline) await common.offline({ type: 'wipe' }, 1500);
        // Ook de oude wachtrij van de urenregistratie (zonder service worker).
        try { Object.keys(localStorage).filter((k) => k.startsWith('aquatech_worklog_queue')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* geen opslag */ }
        // Na opnieuw inloggen weer naar de eigen startpagina (zie dashboard.js).
        try { sessionStorage.removeItem('aquatech_started'); } catch (e) { /* geen opslag */ }
        location.href = base || './';
      };
    }
  }

  // Initialen voor het rondje in de kopbalk ("Bea Beheer (test)" -> "BB").
  function initials(name) {
    const words = String(name || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
    const pick = words.length > 1 ? [words[0], words[words.length - 1]] : words;
    return pick.map((w) => w[0]).join('').toUpperCase() || '?';
  }

  // Openen/sluiten van het gebruikersmenu (klik buiten het menu of Escape sluit).
  function wireMenu(menu) {
    const toggle = menu.querySelector('.user-btn');
    const pop = menu.querySelector('.user-pop');
    const set = (open) => { pop.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
    toggle.onclick = (e) => { e.stopPropagation(); set(pop.hidden); };
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { set(false); toggle.focus(); } });
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
