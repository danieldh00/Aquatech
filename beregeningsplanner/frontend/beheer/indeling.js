// Beheer: de indeling in groepen en secties (zijmenu met zoekveld). De
// pagina's en formulieren zelf staan in index.html; dit bestand bepaalt welke
// sectie waar hoort, toont er telkens één en laat de gebruiker zoeken.
(function () {
  'use strict';

  /** De groepen van het zijmenu met hun secties (`pane` = id zonder `tab-`, `form` = het formulier binnen Instellingen). */
  const GROUPS = [
    { title: 'Overzicht', sections: [
      { id: 'history', label: 'Aanvragen', pane: 'history', words: 'historie wijzigingen planherkenning export excel' },
      { id: 'plans', label: 'Plannen', pane: 'plans', words: 'plan overzicht alle gebruikers' },
    ] },
    { title: 'Organisatie & gebruikers', sections: [
      { id: 'users', label: 'Gebruikers', pane: 'users', words: 'account wachtwoord toevoegen bekijken als klant gasten inloglink organisatiecode' },
      { id: 'roles', label: 'Rollen', pane: 'roles', words: 'rechten planner installateur klant' },
    ] },
    { title: 'Modules', sections: [
      { id: 'modules', label: 'Modules aan/uit', pane: 'settings', form: 's-modules', words: 'zijbalk dashboard uitzetten' },
      { id: 'sproeiers', label: 'Planner: sproeierbibliotheek', pane: 'sproeiers', words: 'behuizingen nozzles rotor sproeiers excel' },
      { id: 'outsourcing', label: 'Uitbesteden', pane: 'settings', form: 's-outsourcing', words: 'werkorders organisaties werkgebied ontvangen' },
      { id: 'season', label: 'Seizoensherinneringen', pane: 'settings', form: 's-season', words: 'mail herinnering winterklaar onderhoud klantportaal' },
    ] },
    { title: 'Integraties', sections: [
      { id: 'mail', label: 'E-mail', pane: 'settings', form: 's-mail', words: 'smtp exchange office 365 connector afzender wan ip offertes versturen' },
      { id: 'ai', label: 'AI-herkenning', pane: 'settings', form: 's-ai', words: 'anthropic claude api sleutel model limiet koers dag uur' },
      { id: 'shopinhoud', label: 'Webshop-inhoud', pane: 'shopinhoud', words: 'winkel teksten pagina hero mededeling banner afbeeldingen merken contact over ons klantenservice bewerken publiceren concept' },
      { id: 'webshop', label: 'Webshop en WooCommerce', pane: 'webshop', words: 'woocommerce winkel sku prijzen voorraad synchroniseren koppeling kopje planner' },
    ] },
    { title: 'Toegang & beveiliging', sections: [
      { id: 'access', label: 'Inloggen en bezoekers', pane: 'settings', form: 's-access', words: 'gasten toegangscode tekening indienen openbaar' },
      { id: 'security', label: 'Sessies en bewaartermijnen', pane: 'settings', form: 's-security', words: 'sessie ip adressen avg bewaren uitloggen auditlog' },
      { id: 'audit', label: 'Auditlog', pane: 'audit', words: 'inloggen beveiliging gebeurtenissen' },
    ] },
    { title: 'Systeem', sections: [
      { id: 'backup', label: 'Back-ups', pane: 'settings', form: 's-backup', words: 'kopie database herstellen versleuteld', needs: 'backups' },
      { id: 'aikosten', label: 'AI-kosten', pane: 'aikosten', words: 'verbruik tokens kosten export per gebruiker' },
    ] },
  ];

  /** Oude adressen (beheer/#settings enz.) naar de sectie waar ze nu staan. */
  const ALIASES = { settings: 'modules' };

  /** Alle formulieren van het tabblad Instellingen: er is er telkens één zichtbaar. */
  const SETTINGS_FORMS = ['s-modules', 's-outsourcing', 's-season', 's-mail', 's-ai', 's-access', 's-security', 's-backup'];

  const sections = GROUPS.flatMap((group) => group.sections.map((section) => ({ ...section, group: group.title })));

  /**
   * Haalt een sectie op.
   * @param {string} id Sleutel van de sectie.
   * @returns {object|undefined} De sectie, of niets als die niet bestaat.
   */
  function find(id) {
    return sections.find((section) => section.id === id);
  }

  /**
   * Zet een adres of oude naam om naar een bestaande sectie-id.
   * @param {string} name Tekst na de # in het adres.
   * @returns {string} De sectie-id, of een lege tekst als er geen sectie bij hoort.
   */
  function resolve(name) {
    const id = ALIASES[name] || name;
    return find(id) ? id : '';
  }

  /**
   * Maakt tekst veilig voor in HTML.
   * @param {string} text De tekst.
   * @returns {string} De tekst met HTML-tekens vervangen.
   */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  /**
   * Bouwt het zijmenu met zoekveld.
   * @param {object} options `allowed(section)`: mag deze sectie getoond worden; `onSelect(id)`: er is een sectie gekozen.
   * @returns {void}
   */
  function build(options) {
    const nav = document.getElementById('bh-nav');
    const groups = GROUPS.map((group) => ({ ...group, sections: group.sections.filter(options.allowed) })).filter((group) => group.sections.length);
    nav.innerHTML = `
      <input type="search" id="bh-search" class="bh-search" placeholder="Zoek instelling…" aria-label="Zoek een instelling in Beheer" autocomplete="off">
      <button type="button" class="bh-toggle" id="bh-toggle" aria-expanded="false"><span id="bh-current"></span><span aria-hidden="true">▾</span></button>
      <div class="bh-list" id="bh-list">
        ${groups.map((group) => `<div class="bh-group" data-group="${escapeHtml(group.title)}">
          <div class="bh-group-title">${escapeHtml(group.title)}</div>
          ${group.sections.map((section) => `<a class="bh-link" href="#${escapeHtml(section.id)}" data-section="${escapeHtml(section.id)}"
            data-search="${escapeHtml(`${section.label} ${section.words} ${group.title}`.toLowerCase())}">${escapeHtml(section.label)}</a>`).join('')}
        </div>`).join('')}
        <p class="bh-none muted small" id="bh-none" hidden>Niets gevonden. Probeer een ander woord, bijvoorbeeld <i>sleutel</i>, <i>mail</i> of <i>back-up</i>.</p>
      </div>`;
    const search = document.getElementById('bh-search');
    const list = document.getElementById('bh-list');
    const toggle = document.getElementById('bh-toggle');

    /** Opent of sluit het menu op een smal scherm. */
    toggle.onclick = () => {
      const open = list.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    };

    /**
     * Opent de gekozen sectie via de koppeling (zonder de pagina te herladen).
     * @param {MouseEvent} event De klik.
     */
    list.onclick = (event) => {
      const link = event.target.closest('.bh-link');
      if (!link) return;
      event.preventDefault();
      options.onSelect(link.dataset.section);
    };

    /** Filtert de menu-items op wat er getypt is; groepen zonder treffer verdwijnen. */
    search.oninput = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let found = 0;
      nav.querySelectorAll('.bh-link').forEach((link) => {
        const hit = words.every((word) => link.dataset.search.includes(word));
        link.hidden = !hit;
        if (hit) found += 1;
      });
      nav.querySelectorAll('.bh-group').forEach((group) => { group.hidden = !group.querySelector('.bh-link:not([hidden])'); });
      document.getElementById('bh-none').hidden = found > 0;
      if (words.length) { list.classList.add('open'); toggle.setAttribute('aria-expanded', 'true'); }
    };

    /**
     * Enter opent de eerste treffer, Escape wist de zoekopdracht.
     * @param {KeyboardEvent} event De toets.
     */
    search.onkeydown = (event) => {
      if (event.key === 'Enter') {
        const first = nav.querySelector('.bh-link:not([hidden])');
        if (first) { event.preventDefault(); options.onSelect(first.dataset.section); search.value = ''; search.oninput(); }
      } else if (event.key === 'Escape') {
        search.value = '';
        search.oninput();
      }
    };
  }

  /**
   * Toont één sectie: de bijbehorende pagina (en binnen Instellingen alleen het bijbehorende formulier).
   * @param {object} section De sectie.
   * @returns {void}
   */
  function show(section) {
    document.querySelectorAll('.tabpane').forEach((pane) => { pane.hidden = pane.id !== `tab-${section.pane}`; });
    SETTINGS_FORMS.forEach((formId) => {
      const form = document.getElementById(formId);
      if (form) form.classList.toggle('sec-off', formId !== section.form);
    });
    document.querySelectorAll('.bh-link').forEach((link) => {
      const active = link.dataset.section === section.id;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    document.getElementById('bh-title').textContent = section.label;
    const current = document.getElementById('bh-current');
    if (current) current.textContent = `${section.group}: ${section.label}`;
    const list = document.getElementById('bh-list');
    if (list) list.classList.remove('open');
    const toggle = document.getElementById('bh-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  window.BeheerIndeling = { GROUPS, find, resolve, build, show };
})();
