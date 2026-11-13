// Links uit een mail van de webshop (wachtwoord herstellen, e-mailadres
// bevestigen) dragen het token achter # (het deel na # gaat nooit naar de
// server of in een log). Dit script zet het token in het verborgen veld van
// het formulier en haalt het uit de adresbalk. Bij bevestigen verstuurt het
// het formulier meteen, zodat de klant niets hoeft te doen.

/**
 * Leest het token uit het deel na # en zet het in de formulieren op de pagina.
 * @returns {void}
 */
function takeTokenFromLink() {
  const match = /(?:^#|&)t=([A-Za-z0-9_-]{30,64})/.exec(window.location.hash);
  if (!match) return;
  const forms = document.querySelectorAll('form[data-token-form]');
  forms.forEach((form) => {
    const input = form.querySelector('input[name="token"]');
    if (input) input.value = match[1];
  });
  history.replaceState(null, '', window.location.pathname + window.location.search);
  forms.forEach((form) => {
    if (form.hasAttribute('data-auto-submit')) form.submit();
  });
}

takeTokenFromLink();
