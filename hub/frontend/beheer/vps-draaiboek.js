// Beheer > Systeem > Draaiboek VPS-verhuizing: afvinkbare stappen. De vinkjes staan alleen in deze browser
// (localStorage, een gemak per gebruiker); het draaiboek zelf staat als vaste tekst in index.html.
(function () {
  const STORAGE_KEY = 'aquatech_vps_draaiboek';

  /**
   * Leest welke stappen zijn afgevinkt.
   * @returns {object} Stap-id → true.
   */
  function readDone() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (error) { return {}; }
  }

  /**
   * Bewaart de afgevinkte stappen (zonder opslag werkt het draaiboek gewoon, alleen zonder geheugen).
   * @param {object} done Stap-id → true.
   * @returns {void}
   */
  function saveDone(done) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(done)); } catch (error) { /* geen opslag */ }
  }

  /**
   * Toont hoeveel stappen klaar zijn.
   * @param {HTMLFormElement} form Het formulier van het draaiboek.
   * @returns {void}
   */
  function showProgress(form) {
    const boxes = form.querySelectorAll('input[data-step]');
    const checked = form.querySelectorAll('input[data-step]:checked').length;
    form.querySelector('#v-progress').textContent = `${checked} van ${boxes.length} stappen klaar.`;
  }

  /**
   * Zet de opgeslagen vinkjes terug en koppelt de knoppen.
   * @returns {void}
   */
  function start() {
    const form = document.getElementById('s-vps');
    if (!form) return;
    const done = readDone();
    for (const box of form.querySelectorAll('input[data-step]')) box.checked = Boolean(done[box.dataset.step]);
    showProgress(form);
    form.addEventListener('change', (event) => {
      const box = event.target;
      if (!box.dataset || !box.dataset.step) return;
      const saved = readDone();
      if (box.checked) saved[box.dataset.step] = true; else delete saved[box.dataset.step];
      saveDone(saved);
      showProgress(form);
    });
    form.querySelector('#v-reset').addEventListener('click', () => {
      for (const box of form.querySelectorAll('input[data-step]')) box.checked = false;
      saveDone({});
      showProgress(form);
    });
  }

  start();
})();
