// Startpagina: tegels per module uit modules.js, het laatst bewerkte
// beregeningsplan en de versie. Alle URL's relatief (werkt ook onder een padprefix).
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  const { icon } = window.AquatechModuleTools;

  // Modules die een beheerder bij Beheer > Instellingen heeft uitgezet.
  let disabledModules = {};

  /**
   * Tekent de moduletegels die deze gebruiker mag zien (niet als de zijbalk er staat).
   * @param {object|null} me Antwoord van api/me (null = nog niet binnen).
   */
  function renderModules(me) {
    // Rechten komen van de server (api/me, zie shared/roles.js).
    const rights = (me && me.rights) || [];
    // Beheerders hebben de zijbalk (shared/sidebar.js); geen tegels dubbel.
    // Zolang api/me nog niet binnen is, geldt wat de zijbalk uit de cache koos.
    const sidebar = me ? window.AquatechModuleTools.usesSidebar(rights) : document.body.classList.contains('has-nav');
    $('#modules-section').hidden = sidebar;
    $('#intro-text').textContent = sidebar ? 'Kies links een onderdeel om mee te werken.' : 'Kies een onderdeel om mee te werken.';
    if (sidebar) return;
    const html = window.AquatechModuleTools.visible(rights, disabledModules)
      .map((module) => {
      const active = module.status === 'actief' && module.href;
      const body = `
        <span class="tile-icon">${icon(module.icon)}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(module.title)}${active ? '' : ' <span class="badge">Binnenkort</span>'}${module.id === 'nieuws' && me ? window.AquatechModuleTools.newsBadge(me.news || 0) : ''}</span>
          <span class="tile-desc">${esc(module.description || '')}</span>
        </span>`;
      return active
        ? `<a class="tile" href="${esc(module.href)}" data-module="${esc(module.id)}">${body}</a>`
        : `<div class="tile disabled" aria-disabled="true" data-module="${esc(module.id)}">${body}</div>`;
    }).join('');
    $('#modules').innerHTML = html;
  }

  /**
   * Toont het laatst bewerkte plan uit de localStorage van de planner (per
   * browser), alleen als dat concept van de ingelogde gebruiker is.
   * @param {object|null} me Antwoord van api/me.
   */
  function renderRecent(me) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(`aquatech-beregeningsplanner-v1${window.AquatechEnv ? window.AquatechEnv.storageSuffix() : ''}`) || 'null'); } catch (error) { /* geen opslag */ }
    if (!data || !data.meta) return;
    const common = window.AquatechCommon;
    if (!common || !data.owner || data.owner !== common.ownerOf(me)) return;
    const areas = (data.areas || []).length;
    const sprinklers = (data.sprinklers || []).length;
    if (!areas && !sprinklers) return;
    const subtitle = [data.meta.customer, data.meta.address].filter(Boolean).map(esc).join(' · ');
    const container = $('#recent');
    container.innerHTML = `
      <h2>Verder werken</h2>
      <a class="tile recent-tile" href="beregening/">
        <span class="tile-icon">${icon('sprinkler')}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(data.meta.name || 'Beregeningsplan')}</span>
          <span class="tile-desc">${subtitle ? subtitle + ' · ' : ''}${areas} vlak${areas === 1 ? '' : 'ken'}, ${sprinklers} sproeier${sprinklers === 1 ? '' : 's'}</span>
        </span>
      </a>`;
    container.hidden = false;
  }

  /**
   * Toont de eigen plannen op de server (alleen die van deze gebruiker, maximaal 6).
   * @param {object|null} me Antwoord van api/me.
   * @returns {Promise<void>}
   */
  async function renderMyPlans(me) {
    if (!me || !me.user || location.protocol === 'file:') return;
    let items = [];
    try {
      const res = await fetch('api/plans', { cache: 'no-store' });
      if (res.ok) items = (await res.json()).items || [];
    } catch (error) { return; }
    if (!items.length) return;
    /**
     * Datum en tijd in het Nederlands.
     * @param {string} iso Tijdstip als ISO-tekst.
     * @returns {string} Bijv. "22 okt 2026 10:15".
     */
    const when = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    $('#myplans-list').innerHTML = items.slice(0, 6).map((plan) => `
      <a class="tile" href="beregening/?plan=${encodeURIComponent(plan.id)}">
        <span class="tile-icon">${icon('sprinkler')}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(plan.title)}</span>
          <span class="tile-desc">${[plan.customer, plan.address].filter(Boolean).map(esc).join(' · ')}${plan.customer || plan.address ? ' · ' : ''}gewijzigd ${esc(when(plan.updatedAt))}</span>
        </span>
      </a>`).join('');
    $('#myplans').hidden = false;
  }

  /**
   * Toont bovenaan een melding als er sinds het vorige bezoek nieuws is (api/me `news`).
   * @param {object|null} me Antwoord van api/me.
   */
  function renderNews(me) {
    const count = (me && me.news) || 0;
    const banner = $('#news-banner');
    if (!count) { banner.hidden = true; return; }
    banner.innerHTML = `<span class="news-banner-ico">${icon('news')}</span>
      <span class="news-banner-text"><strong>Er is nieuws sinds je vorige bezoek.</strong> ${count === 1 ? 'Eén nieuw bericht of nieuwe functie' : `${count > 9 ? 'Meer dan 9' : count} nieuwe berichten en functies`} op de pagina Nieuws.</span>
      <a class="btn primary" href="nieuws/">Bekijken</a>`;
    banner.hidden = false;
  }

  /**
   * Zet de begroeting boven het dagoverzicht (installateurs, beheerders).
   * @param {object} me Antwoord van api/me.
   */
  function greet(me) {
    const hour = Number(new Date().toLocaleString('nl-NL', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }));
    const part = hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond';
    const name = String(me.user.displayName || '').split(' ')[0];
    $('.intro h1').textContent = name ? `${part}, ${name}` : part;
    $('#intro-text').textContent = document.body.classList.contains('has-nav') ? 'Dit staat er gepland. Kies links een onderdeel om mee te werken.' : 'Dit staat er gepland.';
  }

  /**
   * Haalt api/config op (zelfde verzoek als de zijbalk, via shared/common.js) en onthoudt de uitgezette modules.
   * @returns {Promise<void>}
   */
  function loadConfig() {
    if (location.protocol === 'file:') return Promise.resolve();
    const common = window.AquatechCommon;
    const request = common ? common.getJson('api/config') : fetch('api/config', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    return request.then((config) => { if (config && config.modules) disabledModules = config.modules; });
  }

  // Startpagina uit Mijn profiel: de server zet die in de pagina en
  // shared/common.js gaat er de eerste keer in dit tabblad meteen heen,
  // zonder het overzicht eerst op te bouwen.
  if (window.AquatechCommon && window.AquatechCommon.leaving) return;

  renderModules(null);

  Promise.all([window.AquatechAccount.load(''), loadConfig()]).then(([me]) => {
    renderModules(me);
    renderRecent(me);
    renderNews(me);
    if (window.AquatechToday && window.AquatechToday.start(me)) greet(me);
    renderMyPlans(me);
    window.AquatechSupport.load(me);
    // Terug op het overzicht via de knop Terug: dagoverzicht en plannen bijwerken.
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(() => {
        if (window.AquatechToday && window.AquatechToday.refresh) window.AquatechToday.refresh();
        renderMyPlans(me);
      });
    }
  });
})();
