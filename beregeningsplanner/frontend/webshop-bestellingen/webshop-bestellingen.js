// Webshopbestellingen (Verkoop): de bestellingen en retouren uit de eigen
// webshop op één pagina met twee tabbladen. De tabellen en het detail komen uit
// bestellingen.js en retouren.js; dit bestand regelt de
// rechtencontrole, de tabbladen en de melding onderin.
(function () {
  'use strict';

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /** Waar het tabblad staat in de adresbalk (#retouren). */
  const TABS = ['bestellingen', 'retouren'];
  /** Welk tabblad al geladen is, zodat een tabblad pas bij het openen ophaalt. */
  const loaded = new Set();

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
   * Toont één tabblad, haalt de gegevens de eerste keer op en onthoudt de keuze in het adres.
   * @param {string} name Naam van het tabblad (bestellingen of retouren).
   * @returns {void}
   */
  function showTab(name) {
    const tab = TABS.includes(name) ? name : TABS[0];
    for (const button of document.querySelectorAll('.tab')) button.classList.toggle('active', button.dataset.tab === tab);
    for (const pane of document.querySelectorAll('.tabpane')) pane.hidden = pane.id !== `tab-${tab}`;
    history.replaceState(null, '', `#${tab}`);
    if (loaded.has(tab)) return;
    loaded.add(tab);
    (tab === 'retouren' ? window.BeheerRetouren : window.BeheerBestellingen).load();
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
    window.BeheerRetouren.init({ toast });
    for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => showTab(button.dataset.tab));
    showTab(location.hash.slice(1));
  }

  init();
})();
