// Webshopbestellingen (Verkoop): de bestellingen, retouren en de rapportage van de eigen
// webshop op één pagina met vijf tabbladen. De tabellen en het detail komen uit
// bestellingen.js, te-picken.js, retouren.js en rapportage.js; dit bestand regelt de
// rechtencontrole, de tabbladen en de melding onderin.
(function () {
  'use strict';

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /** Waar het tabblad staat in de adresbalk (#retouren, #rapportage). */
  const TABS = ['bestellingen', 'te-picken', 'backorders', 'retouren', 'rapportage'];
  /** De code achter elk tabblad. */
  const PANES = { bestellingen: () => window.BeheerBestellingen, 'te-picken': () => window.BeheerTePicken, backorders: () => window.BeheerBackorders, retouren: () => window.BeheerRetouren, rapportage: () => window.BeheerRapportage };

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message De tekst.
   * @param {boolean} [isError] true voor een foutmelding (rood).
   * @returns {void}
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Toont één tabblad, haalt de gegevens opnieuw op en onthoudt de keuze in het adres.
   * @param {string} name Naam van het tabblad (bestellingen, retouren of rapportage).
   * @returns {void}
   */
  function showTab(name) {
    const tab = TABS.includes(name) ? name : TABS[0];
    for (const button of document.querySelectorAll('.tab')) {
      button.classList.toggle('active', button.dataset.tab === tab);
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
      button.tabIndex = button.dataset.tab === tab ? 0 : -1;
    }
    for (const pane of document.querySelectorAll('.tabpane')) pane.hidden = pane.id !== `tab-${tab}`;
    history.replaceState(null, '', `#${tab}`);
    PANES[tab]().load();
  }

  /**
   * Start de pagina: rechten controleren, tabbladen koppelen en het gekozen tabblad laden.
   * @returns {Promise<void>}
   */
  async function init() {
    const me = await window.AquatechAccount.load('../');
    if (!me.user || !(me.rights || []).includes('beheer')) {
      const deniedBox = $('#denied');
      deniedBox.innerHTML = me.user && me.user.kind !== 'gast'
        ? '<b>Geen toegang.</b> Deze pagina is alleen voor beheerders. <a href="../">Terug naar het overzicht</a>.'
        : '<b>Log in als beheerder</b> om de bestellingen te bekijken. <a href="../login">Inloggen</a>.';
      deniedBox.hidden = false;
      return;
    }
    $('#app').hidden = false;
    window.BeheerBestellingen.init({ toast });
    window.BeheerTePicken.init({ toast });
    window.BeheerBackorders.init({ toast });
    window.BeheerRetouren.init({ toast });
    window.BeheerRapportage.init({ toast });
    for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => showTab(button.dataset.tab));
    // Pijltoetsen wisselen tussen de tabbladen (ARIA-patroon voor tabs); alleen het actieve tabblad staat in de tabvolgorde.
    $('.tabs').addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!step && event.key !== 'Home' && event.key !== 'End') return;
      const current = TABS.findIndex((name) => $(`#t-${name}`) === document.activeElement);
      if (current < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (current + step + TABS.length) % TABS.length;
      event.preventDefault();
      showTab(TABS[next]);
      $(`#t-${TABS[next]}`).focus();
    });
    showTab(location.hash.slice(1));
  }

  init();
})();
