/**
 * Aantalknoppen (− / +) op de productkaarten van de webshop.
 * Zonder script blijft het aantal een gewoon invoerveld; dit script zet er knoppen omheen.
 */
(function () {
  'use strict';

  /**
   * Maakt een knop voor het verlagen of verhogen van het aantal.
   * @param {string} step Stap van de knop: '-1' of '1'.
   * @returns {HTMLButtonElement} De nieuwe knop.
   */
  function createStepButton(step) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'qty-step';
    button.setAttribute('data-qty-step', step);
    button.setAttribute('aria-label', step === '1' ? 'Aantal verhogen' : 'Aantal verlagen');
    button.textContent = step === '1' ? '+' : '−';
    return button;
  }

  /**
   * Zet de knoppen om een aantalveld en houdt hun stand gelijk aan het veld.
   * @param {HTMLInputElement} input Het aantalveld van een productkaart.
   * @returns {void}
   */
  function enhance(input) {
    if (input.getAttribute('data-qty-ready')) return;
    input.setAttribute('data-qty-ready', '1');
    var group = document.createElement('div');
    group.className = 'qty-group';
    var minus = createStepButton('-1');
    var plus = createStepButton('1');
    input.parentNode.insertBefore(group, input);
    group.appendChild(minus);
    group.appendChild(input);
    group.appendChild(plus);

    /** Past de beschikbaarheid van de knoppen aan op waarde en grenzen van het veld. */
    function refresh() {
      var min = Number(input.min) || 1;
      var max = Number(input.max) || 99;
      var value = Number(input.value) || min;
      minus.disabled = input.disabled || value <= min;
      plus.disabled = input.disabled || value >= max;
    }

    group.addEventListener('click', function (event) {
      var button = event.target.closest('[data-qty-step]');
      if (!button || button.disabled) return;
      var min = Number(input.min) || 1;
      var max = Number(input.max) || 99;
      var next = (Number(input.value) || min) + Number(button.getAttribute('data-qty-step'));
      input.value = String(Math.min(max, Math.max(min, next)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      refresh();
    });
    input.addEventListener('input', refresh);
    // Het varianten-script zet het veld uit bij een uitverkocht artikel; volg dat.
    new MutationObserver(refresh).observe(input, { attributes: true, attributeFilter: ['disabled'] });
    refresh();
  }

  var inputs = document.querySelectorAll('.product-card .card-order input[name="qty"]');
  for (var i = 0; i < inputs.length; i += 1) enhance(inputs[i]);
})();
