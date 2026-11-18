// Winkelwagenpagina van de eigen webshop: een gewijzigd aantal wordt direct doorgevoerd, zonder op Wijzig te klikken.
// Zonder dit script blijft de knop Wijzig bij elk aantal staan en werkt de pagina als gewoon formulier.

/** Wachttijd (ms) na de laatste toetsaanslag voordat het aantal wordt verstuurd. */
const TYPING_DELAY_MS = 700;

/**
 * Koppelt één aantalformulier: bij een wijziging van het aantal verstuurt het formulier zichzelf (bij typen met een korte wachttijd).
 * @param {HTMLFormElement} form Het aantalformulier van een winkelwagenregel.
 * @returns {void}
 */
function setUpQuantityForm(form) {
  const input = form.querySelector('input[name="qty"]');
  const saveButton = form.querySelector('.cart-qty-save');
  if (!input || !saveButton) return;
  saveButton.hidden = true;
  let timer = null;
  /**
   * Verstuurt het formulier als het aantal een geldig getal is dat verschilt van het huidige.
   * @returns {void}
   */
  const submitNow = () => {
    window.clearTimeout(timer);
    if (input.value === '' || !input.checkValidity() || input.value === input.defaultValue) return;
    form.requestSubmit();
  };
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(submitNow, TYPING_DELAY_MS);
  });
  input.addEventListener('change', submitNow);
}

for (const form of document.querySelectorAll('form[data-cart-qty]')) setUpQuantityForm(form);
