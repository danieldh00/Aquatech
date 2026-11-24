// Vaste zijbalk met de modules voor beheerders en hoofdbeheerders, op elke
// pagina (in plaats van het tegeldashboard). Vereist dashboard/modules.js.
// Wie de zijbalk krijgt en welke modules erin staan volgt uit de rechten
// (api/me, shared/roles.js) en de uitgezette modules (api/config), net als
// de tegels. Om verspringen te voorkomen tekent de zijbalk eerst uit de
// laatste stand (localStorage) en daarna opnieuw met wat de server zegt.
//
// - Breed scherm: vast links, in te klappen tot een smalle iconenbalk
//   (per browser onthouden). Pagina's met <body data-nav-compact> (de
//   planner) beginnen ingeklapt.
// - Een module met een #-adres (artikelen/#orders) is een tabblad van een andere pagina; de zijbalk markeert het open tabblad.
// - Modules staan in genestelde, inklapbare groepen (Verkoop, Artikelen,
//   Planner & werk, Beheer, ...; indeling in NAV_GROUPS en `navGroup` in
//   dashboard/modules.js). De groep met de huidige pagina staat open, de rest
//   onthoudt de gebruiker. Aantallen (Nieuws) staan als bolletje bij de link
//   en, bij een ingeklapte groep, op de groepskop. Onderaan een compacte
//   voetregel (webshop, Hoofdbeheer, profiel).
// - Bovenaan staat een zoekveld (api/search): klanten, offertes, werkorders, facturen en artikelen in één keer; Ctrl+K of / focust het.
// - Smal scherm (< 900px): lade van links via de menuknop in de kopbalk.
(function (root) {
  const tools = root.AquatechModuleTools;
  if (!tools || location.protocol === 'file:') return;
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  // Relatief pad naar de app-root, afgeleid van dit script ('' of '../').
  const script = document.currentScript;
  const base = script ? (script.getAttribute('src') || '').replace(/shared\/sidebar\.js(\?.*)?$/, '') : '';
  const CACHE = 'aquatech_nav';
  const COMPACT = 'aquatech_nav_compact';
  const OPEN_GROUPS = 'aquatech_nav_groups';
  /**
   * Aantal te tonen bij een module (bolletje), per module-id. Alleen waar de
   * gegevens al in api/me zitten; een nieuw aantal is hier één regel.
   */
  const BADGES = { nieuws: (data) => data.news || 0 };
  const store = {
    /**
     * Leest een waarde uit localStorage.
     * @param {string} key De sleutel.
     * @returns {string|null} De waarde (null zonder opslag).
     */
    get(key) { try { return localStorage.getItem(key); } catch (error) { return null; } },
    /**
     * Schrijft een waarde naar localStorage (null = verwijderen).
     * @param {string} key De sleutel.
     * @param {string|null} value De waarde.
     */
    set(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (error) { /* geen opslag */ } },
  };

  const body = document.body;
  let nav = null;
  let lastSignature = '';
  let lastData = null;

  /** De groep die nu openstaat (hoogstens één); undefined zolang de zijbalk nog niet getekend is. */
  let openKey;
  /** Wordt true zodra de gebruiker zelf een groep open- of dichtklapt; daarna bepaalt de render de open groep niet meer. */
  let userChose = false;

  /**
   * Leest de groep die de gebruiker zelf opengeklapt had (per browser onthouden, hoogstens één).
   * @returns {string} Groepsleutel, of een lege tekst.
   */
  function readOpenGroup() {
    const saved = store.get(OPEN_GROUPS) || '';
    // Oudere versies bewaarden een object met meerdere groepen: neem er één van.
    if (saved.startsWith('{')) {
      try { return Object.keys(JSON.parse(saved) || {})[0] || ''; } catch (error) { return ''; }
    }
    return saved;
  }

  /**
   * Geeft aan of de zijbalk ingeklapt moet zijn (per browser onthouden, anders data-nav-compact op de pagina).
   * @returns {boolean} true = ingeklapt.
   */
  function isCompact() {
    const saved = store.get(COMPACT);
    return saved == null ? body.hasAttribute('data-nav-compact') : saved === '1';
  }

  /**
   * Huidige module: de langste module-URL waar dit pad mee begint. Modules die
   * naar een tabblad van een andere pagina wijzen (`artikelen/#orders`) tellen
   * alleen mee als dat #-adres open staat; de module zonder #-adres is de terugval.
   * @param {object[]} items Modules met id en href.
   * @returns {string|null} Het id van de huidige module.
   */
  function currentId(items) {
    const here = location.pathname;
    let best = null;
    let bestScore = -1;
    for (const module of items) {
      const url = new URL(module.href, location.href);
      const path = url.pathname;
      if (!(here === path || here.startsWith(path))) continue;
      if (url.hash && url.hash !== location.hash) continue;
      const score = path.length * 2 + (url.hash ? 1 : 0);
      if (score > bestScore) { best = module.id; bestScore = score; }
    }
    return best;
  }

  /**
   * Tekent de zijbalk (maakt hem de eerste keer aan). Alleen modules die er al
   * zijn; geplande modules staan in Beheer > Modules en komen pas in de
   * zijbalk als ze klaar zijn.
   * @param {object} data { rights, disabled, profile, news }.
   */
  function render(data) {
    // Dezelfde stand als de vorige keer (cache en server zijn meestal gelijk): niet opnieuw tekenen.
    // Het #-adres hoort erbij: een tabblad van een module is een eigen zijbalkregel.
    const signature = JSON.stringify(data) + location.hash;
    if (nav && signature === lastSignature) return;
    lastSignature = signature;
    lastData = data;
    // Alleen modules die er al zijn; geplande modules staan in Beheer >
    // Modules en komen pas in de zijbalk als ze klaar zijn.
    const items = [{ id: '', navGroup: 'top', title: 'Overzicht', icon: 'home', status: 'actief', href: base || './' }]
      .concat(tools.visible(data.rights, data.disabled).filter((module) => module.status === 'actief' && module.href).map((module) => ({ ...module, href: base + module.href })));
    const profile = { id: 'profiel', href: `${base}profiel/` };
    const active = currentId(items.concat(data.profile ? [profile] : []));
    /**
     * Aantal dat bij een module hoort (0 = geen bolletje).
     * @param {object} module De module.
     * @returns {number} Het aantal.
     */
    const countOf = (module) => (BADGES[module.id] ? BADGES[module.id](data) : 0);
    /**
     * Link naar een module in de zijbalk.
     * @param {object} module De module (id, title, icon, href).
     * @returns {string} HTML van de link.
     */
    const link = (module) => {
      const badge = module.id === 'nieuws' && tools.newsBadge ? tools.newsBadge(countOf(module)) : '';
      const title = module.navTitle || module.title;
      const label = `<span class="at-nav-ico">${tools.icon(module.icon)}${badge}</span><span class="at-nav-label">${esc(title)}</span>`;
      const currentAttribute = module.id === active ? ' aria-current="page"' : '';
      return `<a class="at-nav-item" href="${esc(module.href)}" title="${esc(title)}"${currentAttribute}>${label}</a>`;
    };
    // Accordeon: hoogstens één groep open. Bij het laden staat dat de groep met de huidige pagina, anders de laatst gekozen.
    if (!userChose) {
      const activeGroup = tools.navSections(items).find((section) => section.title && section.items.some((module) => module.id === active));
      openKey = activeGroup ? activeGroup.key : readOpenGroup();
    }
    /**
     * Inklapbare groep met de modules ingesprongen eronder; met één module is het gewoon een link.
     * Alleen de groep in `openKey` staat open; de groep met de huidige pagina is altijd gemarkeerd.
     * @param {{key: string, title: string, icon: string, items: object[]}} group De groep.
     * @returns {string} HTML van de groep.
     */
    const collapsible = (group) => {
      if (!group.title || group.items.length < 2) return group.items.map(link).join('');
      const hasActive = group.items.some((module) => module.id === active);
      const open = openKey === group.key;
      const total = group.items.reduce((sum, module) => sum + countOf(module), 0);
      const totalBadge = total > 0 ? `<span class="at-nav-sec-count" title="Nieuw sinds je vorige bezoek">${total > 9 ? '9+' : total}</span>` : '';
      return `<div class="at-nav-sec${open ? ' open' : ''}${hasActive ? ' has-active' : ''}" data-group="${esc(group.key)}">
        <button type="button" class="at-nav-sec-head" aria-expanded="${open}" aria-controls="at-nav-sec-${esc(group.key)}">
          <span class="at-nav-ico">${tools.icon(group.icon)}</span><span class="at-nav-label">${esc(group.title)}</span>${totalBadge}
          <svg class="ico at-nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="at-nav-list at-nav-sec-body" id="at-nav-sec-${esc(group.key)}">${group.items.map(link).join('')}</div>
      </div>`;
    };
    const sections = tools.navSections(items);
    const footerItems = (sections.find((section) => section.key === 'footer') || { items: [] }).items;
    const mainSections = sections.filter((section) => section.key !== 'footer');
    const mainHtml = mainSections.map((section) => `<div class="at-nav-list${section.key === 'top' ? ' at-nav-top' : ''}">${collapsible(section)}</div>`).join('');
    const footerLinks = (data.shop ? link({ id: 'webshop', title: 'Naar de webshop', icon: 'cart', status: 'actief', href: `${base}../` }) : '')
      + footerItems.map(link).join('')
      + (data.profile ? link({ id: 'profiel', title: 'Mijn profiel', icon: 'user', status: 'actief', href: profile.href }) : '');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'at-nav';
      nav.id = 'at-nav';
      nav.setAttribute('aria-label', 'Modules');
      body.insertBefore(nav, body.firstChild);
      const backdrop = document.createElement('div');
      backdrop.className = 'at-nav-backdrop';
      /**
       * Sluit de lade bij een klik naast de zijbalk.
       * @returns {void}
       */
      backdrop.onclick = () => setOpen(false);
      body.insertBefore(backdrop, nav.nextSibling);
      addToggle();
      syncTopbarHeight();
      /**
       * Klapt een groep open of dicht en onthoudt dat.
       * @param {MouseEvent} event De klik.
       */
      nav.addEventListener('click', (event) => {
        const head = event.target.closest('.at-nav-sec-head');
        if (!head) return;
        const group = head.closest('.at-nav-sec');
        const open = !group.classList.contains('open');
        // Hoogstens één groep open: de andere klappen dicht.
        nav.querySelectorAll('.at-nav-sec.open').forEach((other) => {
          other.classList.remove('open');
          other.querySelector('.at-nav-sec-head').setAttribute('aria-expanded', 'false');
        });
        group.classList.toggle('open', open);
        head.setAttribute('aria-expanded', String(open));
        openKey = open ? group.dataset.group : '';
        userChose = true;
        // De groep met de huidige pagina staat bij elk bezoek weer open; de keuze telt alleen op pagina's zonder groep.
        if (!nav.querySelector('.at-nav-sec.has-active')) store.set(OPEN_GROUPS, openKey);
      });
      attachSearch();
      /**
       * Sluit de lade met Escape.
       * @param {KeyboardEvent} event De toets.
       */
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && body.classList.contains('nav-open')) setOpen(false); });
    }
    nav.innerHTML = `
      <div class="at-nav-head">
        <a class="at-nav-brand" href="${esc(base || './')}" title="Overzicht">
          <img class="at-nav-logo" src="${esc(base)}shared/logo-white.png" alt="AquaTech Service">
          <img class="at-nav-mark" src="${esc(base)}shared/icons/logo-icon.png" alt="AquaTech Service">
        </a>
        <button type="button" class="at-nav-close" aria-label="Menu sluiten" title="Menu sluiten">✕</button>
      </div>
      <div class="at-nav-search" role="search">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" class="at-search-input" placeholder="Zoeken (Ctrl+K)" aria-label="Zoeken in klanten, offertes, werkorders, facturen en artikelen" autocomplete="off" spellcheck="false" maxlength="80" aria-controls="at-search-results" aria-expanded="false">
        <div class="at-search-results" id="at-search-results" role="listbox" hidden></div>
      </div>
      ${mainHtml}
      ${footerLinks ? `<div class="at-nav-list at-nav-foot">${footerLinks}</div>` : ''}
      <button type="button" class="at-nav-collapse" title="Zijbalk in- of uitklappen" aria-label="Zijbalk in- of uitklappen">
        <span class="at-nav-ico"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></span><span class="at-nav-label">Inklappen</span>
      </button>`;
    /**
     * Sluit de lade.
     * @returns {void}
     */
    nav.querySelector('.at-nav-close').onclick = () => setOpen(false);
    /** Klapt de zijbalk in of uit en onthoudt dat. */
    nav.querySelector('.at-nav-collapse').onclick = () => {
      const next = !body.classList.contains('nav-compact');
      body.classList.toggle('nav-compact', next);
      store.set(COMPACT, next ? '1' : '0');
      // Canvas-pagina's (planner) passen zich aan bij een resize.
      root.dispatchEvent(new Event('resize'));
    };
    body.classList.add('has-nav');
    body.classList.toggle('nav-compact', isCompact());
  }

  /**
   * Globaal zoeken in de zijbalk (GET api/search): tikken zoekt na een korte pauze in klanten, offertes, werkorders,
   * facturen en artikelen; pijltjestoetsen en Enter openen een resultaat; Ctrl+K of / zet de cursor in het veld.
   * De handlers hangen aan de zijbalk zelf, zodat ze een nieuwe tekening van de zijbalk overleven.
   * @returns {void}
   */
  function attachSearch() {
    let timer = null;
    let controller = null;
    let shown = [];
    let selected = -1;
    /**
     * Het zoekveld en het resultatenpaneel (opnieuw opgezocht, de zijbalk wordt soms opnieuw getekend).
     * @returns {{ input: HTMLInputElement, panel: HTMLElement }|null} De elementen.
     */
    const parts = () => {
      const input = nav && nav.querySelector('.at-search-input');
      return input ? { input, panel: nav.querySelector('.at-search-results') } : null;
    };
    /**
     * Sluit het resultatenpaneel.
     * @returns {void}
     */
    const close = () => {
      const found = parts();
      if (!found) return;
      found.panel.hidden = true;
      found.input.setAttribute('aria-expanded', 'false');
      shown = [];
      selected = -1;
    };
    /**
     * Markeert een resultaat als gekozen (pijltjestoetsen).
     * @param {number} index Positie in de lijst (buiten de lijst = niets gekozen).
     * @returns {void}
     */
    const select = (index) => {
      selected = index;
      shown.forEach((link, position) => {
        link.classList.toggle('is-selected', position === index);
        link.setAttribute('aria-selected', String(position === index));
      });
      if (shown[index]) shown[index].scrollIntoView({ block: 'nearest' });
    };
    /**
     * Toont de groepen met resultaten (of de melding dat er niets is).
     * @param {{ groups: object[] }} result Het antwoord van api/search.
     * @returns {void}
     */
    const show = (result) => {
      const found = parts();
      if (!found) return;
      const html = (result.groups || []).map((group) => `<div class="at-search-group" role="group" aria-label="${esc(group.title)}">
        <div class="at-search-title">${esc(group.title)}</div>
        ${group.items.map((entry) => `<a class="at-search-item" role="option" aria-selected="false" href="${esc(base + entry.href)}">
          <span class="at-search-main">${esc(entry.title)}</span>${entry.subtitle ? `<span class="at-search-sub">${esc(entry.subtitle)}</span>` : ''}</a>`).join('')}
      </div>`).join('');
      found.panel.innerHTML = html || '<div class="at-search-empty">Niets gevonden.</div>';
      found.panel.hidden = false;
      found.input.setAttribute('aria-expanded', 'true');
      shown = [...found.panel.querySelectorAll('.at-search-item')];
      selected = -1;
    };
    /**
     * Zoekt (na de pauze) en toont het resultaat; een nieuwere zoekopdracht breekt de vorige af.
     * @param {string} text De zoektekst.
     * @returns {void}
     */
    const run = (text) => {
      if (controller) controller.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      fetch(`${base}api/search?q=${encodeURIComponent(text)}`, { cache: 'no-store', credentials: 'same-origin', signal: controller ? controller.signal : undefined })
        .then((response) => (response.ok ? response.json() : { groups: [], failed: true }))
        .then((result) => {
          const found = parts();
          if (!found || found.input.value.trim() !== text) return;
          if (result.failed) {
            found.panel.innerHTML = '<div class="at-search-empty">Zoeken lukt nu niet.</div>';
            found.panel.hidden = false;
            return;
          }
          show(result);
        })
        .catch(() => { /* afgebroken of offline: laat het paneel zoals het was */ });
    };
    /**
     * Zoekt na een korte pauze in het typen; minder dan twee tekens sluit het paneel.
     * @param {Event} event Het invoer-event.
     * @returns {void}
     */
    nav.addEventListener('input', (event) => {
      if (!event.target.classList.contains('at-search-input')) return;
      clearTimeout(timer);
      const text = event.target.value.trim();
      if (text.length < 2) { close(); return; }
      timer = setTimeout(() => run(text), 250);
    });
    /**
     * Pijltjestoetsen kiezen een resultaat, Enter opent het (of het eerste), Escape sluit.
     * @param {KeyboardEvent} event De toets.
     * @returns {void}
     */
    nav.addEventListener('keydown', (event) => {
      if (!event.target.classList.contains('at-search-input')) return;
      if (event.key === 'ArrowDown' && shown.length) { event.preventDefault(); select((selected + 1) % shown.length); }
      else if (event.key === 'ArrowUp' && shown.length) { event.preventDefault(); select((selected - 1 + shown.length) % shown.length); }
      else if (event.key === 'Enter' && shown.length) { event.preventDefault(); (shown[selected] || shown[0]).click(); }
      else if (event.key === 'Escape') { if (event.target.value || shown.length) { event.stopPropagation(); event.target.value = ''; close(); } }
    });
    nav.addEventListener('focusin', (event) => {
      if (event.target.classList.contains('at-search-input') && event.target.value.trim().length >= 2 && shown.length) parts().panel.hidden = false;
    });
    /**
     * Sluit het paneel bij een klik buiten het zoekveld.
     * @param {MouseEvent} event De klik.
     * @returns {void}
     */
    document.addEventListener('click', (event) => { if (!event.target.closest('.at-nav-search')) close(); });
    /**
     * Ctrl+K (of Cmd+K) en / zetten de cursor in het zoekveld; een ingeklapte zijbalk of lade gaat daarvoor open.
     * @param {KeyboardEvent} event De toets.
     * @returns {void}
     */
    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      const wanted = ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey);
      const found = parts();
      if (!wanted || !found) return;
      event.preventDefault();
      if (body.classList.contains('nav-compact') && root.matchMedia('(min-width: 900px)').matches) body.classList.remove('nav-compact');
      setOpen(true);
      found.input.focus();
      found.input.select();
    });
  }

  /**
   * De kop van de zijbalk volgt de hoogte van de kopbalk (die verschilt per
   * pagina en verandert bij een andere schermbreedte).
   */
  function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    /**
     * Zet de hoogte van de kopbalk in de CSS-variabele --at-topbar-h.
     * @returns {void}
     */
    const apply = () => document.documentElement.style.setProperty('--at-topbar-h', `${bar.getBoundingClientRect().height}px`);
    apply();
    if (root.ResizeObserver) new ResizeObserver(apply).observe(bar);
    else root.addEventListener('resize', apply);
  }

  /** Zet de menuknop vooraan in de kopbalk (alleen zichtbaar op een smal scherm). */
  function addToggle() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'at-nav-toggle';
    button.setAttribute('aria-label', 'Modules');
    button.setAttribute('aria-controls', 'at-nav');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'Modules';
    button.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    /**
     * Opent of sluit de lade.
     * @returns {void}
     */
    button.onclick = () => setOpen(!body.classList.contains('nav-open'));
    bar.insertBefore(button, bar.firstChild);
  }

  /**
   * Opent of sluit de lade op een smal scherm.
   * @param {boolean} open true = openen.
   */
  function setOpen(open) {
    body.classList.toggle('nav-open', open);
    const button = document.querySelector('.at-nav-toggle');
    if (button) button.setAttribute('aria-expanded', String(open));
  }

  /** Haalt de zijbalk weg (gebruiker heeft hem niet, bijv. na wisselen van omgeving). */
  function remove() {
    if (nav) nav.remove();
    document.querySelectorAll('.at-nav-backdrop, .at-nav-toggle').forEach((element) => element.remove());
    nav = null;
    lastSignature = '';
    lastData = null;
    body.classList.remove('has-nav', 'nav-compact', 'nav-open');
  }

  // 1. Direct uit de cache (geen verspringen bij het laden van een pagina).
  let cached = null;
  try { cached = JSON.parse(store.get(CACHE) || 'null'); } catch (error) { /* kapotte cache */ }
  if (cached && tools.usesSidebar(cached.rights)) render(cached);

  // 2. Opnieuw met de echte rechten en instellingen.
  // Via shared/common.js: dezelfde verzoeken als de kopbalk en de module.
  const common = root.AquatechCommon;
  if (common && common.leaving) return;
  /**
   * Gedeeld verzoek via shared/common.js (dezelfde als de kopbalk en de module), anders zelf ophalen.
   * @param {string} path Pad vanaf de app-root, bijv. "api/me".
   * @returns {Promise<object|null>} Het antwoord (null bij een fout).
   */
  const getJson = (path) => (common ? common.getJson(path) : fetch(base + path, { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null));
  Promise.all([getJson('api/me'), getJson('api/config')]).then(([me, config]) => {
    if (!me) return; // offline: laat de laatste stand staan
    // Vaste stukken van de pagina die bij een uitgezet onderdeel horen (data-feature) verdwijnen.
    if (config && tools.applyFeatures) tools.applyFeatures(config.modules || {});
    // Mijn profiel alleen met een eigen account (niet met de toegangscode).
    const data = { rights: me.rights || [], disabled: (config && config.modules) || {}, profile: Boolean(me.preferences), news: me.news || 0, shop: Boolean(config && config.shop) };
    if (tools.usesSidebar(data.rights)) {
      store.set(CACHE, JSON.stringify(data));
      render(data);
    } else {
      store.set(CACHE, null);
      remove();
    }
  });

  root.AquatechNav = {
    /** Opent de lade (smal scherm). */
    open: () => { setOpen(true); },
    /** Sluit de lade. */
    close: () => { setOpen(false); },
    /** Tekent de markering opnieuw, bijvoorbeeld nadat een pagina van tabblad (#-adres) is gewisseld. */
    refresh: () => { if (lastData) render(lastData); },
    /**
     * Neemt nieuwe modulevlaggen over (na Beheer > Modules) en tekent de zijbalk opnieuw.
     * @param {object} flags De vlaggen uit api/config (`modules`).
     */
    setDisabled: (flags) => {
      if (!lastData) return;
      const data = { ...lastData, disabled: flags || {} };
      store.set(CACHE, JSON.stringify(data));
      render(data);
    },
  };
  root.addEventListener('hashchange', () => { if (lastData) render(lastData); });
})(window);
