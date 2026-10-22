// Inlogstatus (wie ben ik, welke rol) voor het dashboard en de modules.
// AquatechAccount.load(base) haalt api/me op en vult #account; `base` is het
// relatieve pad naar de app-root ('' op het dashboard, '../' in een module).
(function (root) {
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Haalt api/me op en vult #account. `fresh`: opnieuw ophalen (bijv. na het
   * opslaan van het profiel); anders hetzelfde verzoek als de zijbalk (shared/common.js).
   * @param {string} [base] Relatief pad naar de app-root ('' op het dashboard, '../' in een module).
   * @param {object} [options] { fresh }.
   * @returns {Promise<object>} Antwoord van api/me (als gast zonder verbinding).
   */
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
        } catch (error) { /* offline: als gast tonen */ }
      }
    }
    render(me, base);
    return me;
  }

  /**
   * Tekent de inlogstatus: gebruikersmenu, inloglink voor gasten of de knop terug naar het eigen account.
   * @param {object} me Antwoord van api/me.
   * @param {string} base Relatief pad naar de app-root.
   */
  function render(me, base) {
    const container = document.getElementById('account');
    if (!container || location.protocol === 'file:') return;
    const user = me.user;
    if (user && user.kind !== 'gast' && me.impersonation) {
      // Een hoofdbeheerder werkt als deze gebruiker: in plaats van uitloggen terug naar het eigen account.
      container.innerHTML = `<span title="Namens ${esc(me.impersonation.by)}">${esc(user.displayName)} <span class="role">· ${esc((user.roleLabel || user.role).toLowerCase())} (via ${esc(me.impersonation.by)})</span></span><button type="button" data-stop-imp title="Terug naar je eigen account">Eigen account</button>`;
      /**
       * Stopt het werken namens een andere gebruiker.
       * @param {MouseEvent} event De klik.
       * @returns {Promise<void>}
       */
      container.querySelector('[data-stop-imp]').onclick = (event) => window.AquatechEnv.stopImpersonation(event.currentTarget);
      return;
    }
    if (user && user.kind !== 'gast') {
      const role = me.platformAdmin ? 'hoofdbeheerder' : (user.roleLabel || user.role).toLowerCase();
      // Gebruikersmenu: Mijn profiel (alleen met een eigen account, niet met
      // de toegangscode) en uitloggen.
      const profile = user.kind === 'account' ? `<a role="menuitem" href="${esc(base)}profiel/">Mijn profiel</a>` : '';
      // Nieuws met het aantal nieuwe items (ook als stip op het rondje).
      const tools = root.AquatechModuleTools;
      const count = tools && tools.newsBadge ? tools.newsBadge(me.news || 0) : '';
      const news = `<a role="menuitem" href="${esc(base)}nieuws/">Nieuws ${count}</a>`;
      const dot = me.news > 0 ? '<span class="news-dot" data-news-count aria-hidden="true"></span>' : '';
      container.innerHTML = `<div class="user-menu">
          <button type="button" class="user-btn" aria-haspopup="true" aria-expanded="false" title="${esc(user.displayName)} · ${esc(role)}">
            <span class="avatar" aria-hidden="true">${esc(initials(user.displayName))}${dot}</span><span class="user-name">${esc(user.displayName)}</span>
          </button>
          <div class="user-pop" role="menu" hidden>
            <div class="user-head"><strong>${esc(user.displayName)}</strong><span>${esc(role)}${user.email ? ` · ${esc(user.email)}` : ''}</span></div>
            ${news}${profile}<button type="button" role="menuitem" data-logout>Uitloggen</button>
          </div>
        </div>`;
      wireMenu(container.querySelector('.user-menu'));
    } else {
      container.innerHTML = `<span class="role">Gast</span><a href="${esc(base)}login">Inloggen</a>`;
    }
    if (user && user.kind !== 'gast' && me.environments > 1) renderSwitcher(container, me, base);
    const logoutButton = container.querySelector('[data-logout]');
    if (logoutButton) {
      /**
       * Logt uit na een waarschuwing als er nog onverstuurde wijzigingen zijn en wist de offline gegevens.
       * @returns {Promise<void>}
       */
      logoutButton.onclick = async () => {
        // Nog niet verstuurde wijzigingen (offline gemaakt) gaan bij uitloggen
        // verloren: de offline gegevens worden op dit toestel gewist.
        const common = window.AquatechCommon;
        const offlineStatus = common && common.offline ? await common.offline({ type: 'status' }, 1500) : null;
        let queuedWorklog = 0;
        try { queuedWorklog = Object.keys(localStorage).filter((key) => key.startsWith('aquatech_worklog_queue')).reduce((count, key) => count + (JSON.parse(localStorage.getItem(key) || '[]').length || 0), 0); } catch (error) { /* geen opslag */ }
        const waiting = (offlineStatus && offlineStatus.items ? offlineStatus.items.length : 0) + queuedWorklog;
        if (waiting && !confirm(`Er ${waiting === 1 ? 'staat nog 1 wijziging' : `staan nog ${waiting} wijzigingen`} op dit toestel die nog niet ${waiting === 1 ? 'is' : 'zijn'} verstuurd. Bij uitloggen ${waiting === 1 ? 'gaat die' : 'gaan die'} verloren. Toch uitloggen?`)) return;
        try { await fetch(`${base}api/auth/logout`, { method: 'POST' }); } catch (error) { /* negeren */ }
        if (common && common.offline) await common.offline({ type: 'wipe' }, 1500);
        // Ook de oude wachtrij van de urenregistratie (zonder service worker).
        try { Object.keys(localStorage).filter((key) => key.startsWith('aquatech_worklog_queue')).forEach((key) => localStorage.removeItem(key)); } catch (error) { /* geen opslag */ }
        // Na opnieuw inloggen weer naar de eigen startpagina (zie dashboard.js).
        try { sessionStorage.removeItem('aquatech_started'); } catch (error) { /* geen opslag */ }
        location.href = base || './';
      };
    }
  }

  /**
   * Initialen voor het rondje in de kopbalk ("Bea Beheer (test)" -> "BB").
   * @param {string} name Weergavenaam.
   * @returns {string} Eerste letter van het eerste en laatste woord (? als er niets is).
   */
  function initials(name) {
    const words = String(name || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
    const chosen = words.length > 1 ? [words[0], words[words.length - 1]] : words;
    return chosen.map((word) => word[0]).join('').toUpperCase() || '?';
  }

  /**
   * Openen/sluiten van het gebruikersmenu (klik buiten het menu of Escape sluit).
   * @param {HTMLElement} menu Het element .user-menu.
   */
  function wireMenu(menu) {
    const toggle = menu.querySelector('.user-btn');
    const popup = menu.querySelector('.user-pop');
    /**
     * Opent of sluit het menu.
     * @param {boolean} open true = openen.
     */
    const setOpen = (open) => { popup.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); };
    /**
     * Klik op het rondje: menu open of dicht.
     * @param {MouseEvent} event De klik.
     */
    toggle.onclick = (event) => { event.stopPropagation(); setOpen(popup.hidden); };
    document.addEventListener('click', (event) => { if (!menu.contains(event.target)) setOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !popup.hidden) { setOpen(false); toggle.focus(); } });
  }

  /**
   * Wisselaar tussen live en testomgevingen (en voor een hoofdbeheerder tussen
   * tenants) zonder opnieuw in te loggen. Na het wisselen wordt de pagina
   * opnieuw geladen, zodat alle gegevens uit de nieuwe omgeving komen.
   * @param {HTMLElement} container Het element #account.
   * @param {object} me Antwoord van api/me.
   * @param {string} base Relatief pad naar de app-root.
   * @returns {Promise<void>}
   */
  async function renderSwitcher(container, me, base) {
    let data;
    try {
      const res = await fetch(`${base}api/environments`, { cache: 'no-store' });
      if (!res.ok) return;
      data = await res.json();
    } catch (error) { return; }
    const items = data.items || [];
    if (items.length < 2) return;
    /**
     * Naam van een omgeving in de keuzelijst.
     * @param {object} tenant De omgeving.
     * @returns {string} Bijv. "Aquatech · test: Demo" (met "(uit)" als hij uit staat).
     */
    const label = (tenant) => (tenant.environment === 'test' ? `${tenant.parentName || ''} · test: ${tenant.name}` : tenant.name) + (tenant.disabled ? ' (uit)' : '');
    // Live-tenants op naam, de testomgevingen direct onder hun live-tenant.
    const live = items.filter((tenant) => tenant.environment === 'live');
    const ordered = [];
    for (const tenant of live) {
      ordered.push(tenant);
      for (const environment of items) if (environment.parentId === tenant.id) ordered.push(environment);
    }
    for (const tenant of items) if (!ordered.includes(tenant)) ordered.push(tenant);
    const select = document.createElement('select');
    select.className = 'env-select';
    select.title = 'Omgeving wisselen';
    select.setAttribute('aria-label', 'Omgeving');
    select.innerHTML = ordered.map((tenant) => `<option value="${esc(tenant.id)}"${tenant.id === data.current ? ' selected' : ''}>${esc(label(tenant))}</option>`).join('');
    /**
     * Wisselt naar de gekozen omgeving en laadt de pagina opnieuw.
     * @returns {Promise<void>}
     */
    select.onchange = async () => {
      select.disabled = true;
      try {
        const res = await fetch(`${base}api/environment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: select.value }) });
        if (!res.ok) throw new Error();
        location.reload();
      } catch (error) {
        select.disabled = false;
        select.value = data.current;
      }
    };
    container.insertBefore(select, container.firstChild);
  }

  root.AquatechAccount = { load };
})(window);
