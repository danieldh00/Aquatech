// Onzichtbare captcha (Google reCAPTCHA v3) in de browser. Twee gebruiksmanieren:
// 1) Een formulier met <input type="hidden" name="captchaToken" data-site-key="…" data-captcha-action="login"> krijgt vanzelf een
//    token vlak vóór het verzenden (de webshop en de openbare formulieren).
// 2) Code die zelf een verzoek doet (de inlogpagina, tekening indienen) vraagt `AquatechCaptcha.token(siteKey, actie)`.
// Het script van Google wordt pas geladen als de bezoeker met zo'n formulier begint (of verstuurt), niet bij het openen van de pagina.
(function () {
  'use strict';

  /** Hoe lang (ms) we op Google wachten voordat we het opgeven en zonder token verzenden (de server toont dan een duidelijke melding). */
  const TIMEOUT_MS = 10000;

  /** Lopende of voltooide laadpoging per sitesleutel. */
  const loading = new Map();

  /**
   * Laadt het script van Google voor een sitesleutel (één keer per sleutel).
   * @param {string} siteKey De sitesleutel van reCAPTCHA.
   * @returns {Promise<object>} Het object `grecaptcha`, klaar voor gebruik.
   */
  function load(siteKey) {
    if (loading.has(siteKey)) return loading.get(siteKey);
    const promise = new Promise((resolve, reject) => {
      if (window.grecaptcha && window.grecaptcha.execute) { window.grecaptcha.ready(() => resolve(window.grecaptcha)); return; }
      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
      script.async = true;
      /**
       * Zodra het script er is: wachten tot Google klaar is.
       * @returns {void}
       */
      script.onload = () => { if (window.grecaptcha) window.grecaptcha.ready(() => resolve(window.grecaptcha)); else reject(new Error('captcha')); };
      /**
       * Het script kon niet laden (adblocker, geen verbinding).
       * @returns {void}
       */
      script.onerror = () => reject(new Error('captcha'));
      document.head.appendChild(script);
    });
    // Een mislukte poging (adblocker, geen verbinding) mag een volgende poging niet blokkeren.
    promise.catch(() => loading.delete(siteKey));
    loading.set(siteKey, promise);
    return promise;
  }

  /**
   * Vraagt een token voor één actie; elk token is eenmalig en twee minuten geldig, dus vraag er vlak voor het verzenden een.
   * @param {string} siteKey De sitesleutel van reCAPTCHA.
   * @param {string} action De actienaam (letters, cijfers en underscores; moet bij de server passen).
   * @returns {Promise<string>} Het token; de belofte wordt verworpen als Google niet binnen de tijd antwoordt.
   */
  function token(siteKey, action) {
    const run = load(siteKey).then((grecaptcha) => grecaptcha.execute(siteKey, { action }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS));
    return Promise.race([run, timeout]);
  }

  /**
   * Het veld van een formulier dat een token nodig heeft.
   * @param {Element} form Het formulier.
   * @returns {?HTMLInputElement} Het verborgen veld, of null als het formulier geen captcha heeft.
   */
  function fieldOf(form) {
    return form && form.querySelector ? form.querySelector('input[name="captchaToken"][data-site-key]') : null;
  }

  // Begint de bezoeker met een formulier met captcha, dan alvast het script van Google laden (het token zelf pas bij het verzenden).
  document.addEventListener('focusin', (event) => {
    const field = fieldOf(event.target.form);
    if (field) load(field.dataset.siteKey).catch(() => {});
  });

  // Vlak voor het verzenden een vers token in het veld zetten en daarna hetzelfde formulier opnieuw verzenden (met dezelfde knop).
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    const field = fieldOf(form);
    if (!field || form.dataset.captchaReady === '1' || (event.submitter && event.submitter.hasAttribute('data-captcha-skip'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const submitter = event.submitter;
    try { field.value = await token(field.dataset.siteKey, field.dataset.captchaAction); } catch (error) { field.value = ''; }
    form.dataset.captchaReady = '1';
    try {
      if (form.requestSubmit) form.requestSubmit(submitter || undefined); else form.submit();
    } catch (error) {
      form.submit();
    } finally {
      delete form.dataset.captchaReady;
    }
  }, true);

  window.AquatechCaptcha = { token, load };
})();
