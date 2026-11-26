/* Rondleiding voor nieuwe bezoekers van de planner zonder account: zes korte kaarten, de eerste keer vanzelf. */
(function () {
  const SEEN_KEY = 'aquatech_planner_rondleiding_gezien';
  const STEPS = [
    { title: 'Welkom bij de beregeningsplanner', text: 'Ontwerp je tuinberegening in zes stappen. Je hebt hiervoor geen account nodig: je tekening blijft in deze browser tot jij hem indient of bewaart.' },
    { title: '1. Project & ondergrond', text: 'Laad een foto, plattegrond of schets van je tuin en klik op Plan laden en concept maken. De planner herkent gazon, borders en bebouwing. Liever zelf beginnen? Dan stel je de schaal zelf in.' },
    { title: '2. Gebieden tekenen', text: 'Teken gazon, beplanting, hagen en plekken die droog moeten blijven. Met de toverstaf klik je in een vlak op je plan en wordt de rand automatisch gevolgd.' },
    { title: '3. Sproeiers en leidingen', text: 'Laat de sproeiers automatisch plaatsen en controleer ze op de kaart. De planner deelt de zones in en rekent leidingen, druk en debiet voor je uit.' },
    { title: '4. Stuklijst en bestellen', text: 'Onder Stuklijst & export zie je een prijsindicatie. Met Materiaal bestellen gaat de hele lijst in één keer naar je winkelwagen.' },
    { title: '5. Indienen of bewaren', text: 'Dien je tekening in en een installateur controleert hem en stuurt een offerte. Wil je hem bewaren? Maak een account met Bewaren: je ontwerp gaat dan mee.' }
  ];
  const STEP_SAVE_ONLY = { title: '5. Bewaren', text: 'Wil je je ontwerp bewaren? Maak een account met Bewaren: je ontwerp gaat dan mee.' };
  let steps = STEPS;
  let index = 0;
  let card = null;

  /**
   * Leest of de bezoeker de rondleiding al eens heeft gezien (zonder opslag: nee).
   * @returns {boolean} true als hij al gezien is.
   */
  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (error) { return false; }
  }

  /** Onthoudt dat de rondleiding gezien is, zodat hij niet elke keer opnieuw opent. */
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (error) { /* geen opslag */ }
  }

  /** Sluit de rondleiding. */
  function close() {
    markSeen();
    document.removeEventListener('keydown', onKey);
    if (card) card.remove();
    card = null;
  }

  /** Tekent de huidige kaart van de rondleiding. */
  function render() {
    const step = steps[index];
    const last = index === steps.length - 1;
    const dots = steps.map((_, position) => `<span class="tour-dot${position === index ? ' on' : ''}"></span>`).join('');
    card.querySelector('.tour-body').innerHTML = `<h2>${step.title}</h2><p>${step.text}</p>
      <div class="tour-dots" aria-hidden="true">${dots}</div>
      <div class="tour-actions"><button type="button" class="btn" data-tour="skip">${last ? 'Sluiten' : 'Overslaan'}</button>
      <span class="tour-nav">${index > 0 ? '<button type="button" class="btn" data-tour="prev">Vorige</button>' : ''}<button type="button" class="btn primary" data-tour="next">${last ? 'Aan de slag' : 'Volgende'}</button></span></div>`;
    card.querySelector('[data-tour="next"]').focus();
  }

  /**
   * Sluit de rondleiding met Escape.
   * @param {KeyboardEvent} event de toetsdruk
   */
  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  /**
   * Opent de rondleiding bij de eerste kaart.
   * @param {{canSubmit?: boolean}} [options] canSubmit false = de laatste kaart noemt alleen Bewaren
   */
  function open(options) {
    if (card) return;
    index = 0;
    steps = options && options.canSubmit === false ? STEPS.slice(0, -1).concat([STEP_SAVE_ONLY]) : STEPS;
    card = document.createElement('div');
    card.className = 'help open tour';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.innerHTML = '<div class="help-card tour-card"><div class="tour-body"></div></div>';
    card.addEventListener('click', (event) => {
      const action = event.target.dataset && event.target.dataset.tour;
      if (event.target === card || action === 'skip') return close();
      if (action === 'prev' && index > 0) { index -= 1; render(); }
      if (action === 'next') {
        if (index >= steps.length - 1) return close();
        index += 1;
        render();
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(card);
    render();
  }

  window.PlannerTour = { open, seen };
})();
