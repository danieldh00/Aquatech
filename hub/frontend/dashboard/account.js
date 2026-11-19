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
      // Bij een klantweergave (beheerder bekijkt als klant) terug naar Beheer.
      const back = me.impersonation.mode === 'klant' ? ['Terug naar beheer', 'Terug naar Beheer als jezelf'] : ['Eigen account', 'Terug naar je eigen account'];
      container.innerHTML = `<span title="Namens ${esc(me.impersonation.by)}">${esc(user.displayName)} <span class="role">· ${esc((user.roleLabel || user.role).toLowerCase())} (via ${esc(me.impersonation.by)})</span></span><button type="button" data-stop-imp title="${back[1]}">${back[0]}</button>`;
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
      setupBell(container, me, base);
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
        // Ook de oude wachtrij van de urenregistratie (zonder service worker) en
        // het lokale concept van de planner (staat ook op de server bij Mijn plannen);
        // een tekening zonder account (-tekenen) blijft.
        try {
          Object.keys(localStorage)
            .filter((key) => key.startsWith('aquatech_worklog_queue') || (key.startsWith('aquatech-beregeningsplanner-v1') && !key.endsWith('-tekenen')))
            .forEach((key) => localStorage.removeItem(key));
        } catch (error) { /* geen opslag */ }
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

  /** Ruimt het huidige belletje op (null zolang er geen is). */
  let stopBell = null;

  /**
   * Zet het meldingenbelletje met teller links van het gebruikersmenu (alleen voor wie taken kan hebben).
   * De melding komt uit api/tasks (zelfde bron als het blok Openstaande taken); een klik gaat direct naar het scherm.
   * @param {HTMLElement} container Het element #account.
   * @param {object} me Antwoord van api/me.
   * @param {string} base Relatief pad naar de app-root.
   * @returns {void}
   */
  function setupBell(container, me, base) {
    const common = window.AquatechCommon;
    const rights = me.rights || [];
    if (!common || !(rights.includes('beheer') || rights.includes('voorraad'))) return;
    // Bij opnieuw tekenen (bijv. na het opslaan van het profiel) eerst de vorige luisteraars en timer opruimen.
    if (stopBell) stopBell();
    const wrap = document.createElement('div');
    wrap.className = 'bell-menu';
    wrap.innerHTML = `<button type="button" class="bell-btn" aria-haspopup="true" aria-expanded="false" title="Openstaande taken" aria-label="Openstaande taken">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 8H4c0-1 2-2 2-8zM10 21h4"/></svg>
        <span class="bell-count" hidden></span>
      </button>
      <div class="bell-pop" role="menu" hidden></div>`;
    container.insertBefore(wrap, container.querySelector('.user-menu'));
    const toggle = wrap.querySelector('.bell-btn');
    const popup = wrap.querySelector('.bell-pop');
    const badge = wrap.querySelector('.bell-count');
    /**
     * Tekent de teller en de lijst met taken.
     * @param {object[]} tasks Taken uit api/tasks.
     * @returns {void}
     */
    const draw = (tasks) => {
      const total = tasks.reduce((sum, task) => sum + task.count, 0);
      badge.hidden = total === 0;
      badge.textContent = total > 99 ? '99+' : String(total);
      toggle.title = total ? `${total} openstaande ${total === 1 ? 'taak' : 'taken'}` : 'Geen openstaande taken';
      popup.innerHTML = tasks.length
        ? tasks.map((task) => {
          const href = task.count === 1 && task.items && task.items[0] ? task.items[0].href : task.href;
          return `<a role="menuitem" href="${esc(base)}${esc(href)}"><span>${esc(task.title)}</span><span class="bell-num">${esc(task.count)}</span></a>`;
        }).join('')
        : '<p class="bell-empty">Niets te doen. 🎉</p>';
    };
    /**
     * Haalt de taken op en tekent ze.
     * @param {boolean} fresh true = opnieuw bij de server vragen.
     * @returns {Promise<void>}
     */
    const refresh = async (fresh) => {
      const data = await common.getJson('api/tasks', { fresh });
      if (data) draw(data.tasks || []);
    };
    /**
     * Opent of sluit het venster (bij openen eerst verversen).
     * @param {boolean} open true = openen.
     * @returns {void}
     */
    const setOpen = (open) => {
      popup.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        // Het gebruikersmenu sluit mee (de klik bereikt wireMenu niet door stopPropagation).
        const userPopup = container.querySelector('.user-pop');
        const userButton = container.querySelector('.user-btn');
        if (userPopup) userPopup.hidden = true;
        if (userButton) userButton.setAttribute('aria-expanded', 'false');
        refresh(true);
      }
    };
    /**
     * Klik op het belletje: venster open of dicht.
     * @param {MouseEvent} event De klik.
     */
    toggle.onclick = (event) => { event.stopPropagation(); setOpen(popup.hidden); };
    /**
     * Klik buiten het venster sluit het.
     * @param {MouseEvent} event De klik.
     */
    const onDocumentClick = (event) => { if (!wrap.contains(event.target)) { popup.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } };
    /**
     * Escape sluit het venster.
     * @param {KeyboardEvent} event De toets.
     */
    const onKeydown = (event) => { if (event.key === 'Escape' && !popup.hidden) { setOpen(false); toggle.focus(); } };
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    refresh(false);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, 3 * 60 * 1000);
    /**
     * Ruimt luisteraars en timer van dit belletje op.
     * @returns {void}
     */
    stopBell = () => {
      clearInterval(timer);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKeydown);
      stopBell = null;
    };
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
