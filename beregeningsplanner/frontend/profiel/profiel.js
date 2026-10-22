// Mijn profiel: eigen naam, contactgegevens, voorkeuren en wachtwoord.
// API: api/account/profile (GET/PUT) en api/account/password (POST).
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const $ = (id) => document.getElementById(id);
  const tools = window.AquatechModuleTools;
  /**
   * Datum in het Nederlands.
   * @param {string} iso Datum als ISO-tekst.
   * @returns {string} Bijv. "22 oktober 2026" (leeg zonder datum).
   */
  const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

  /**
   * Roept de API aan (relatief vanaf profiel/).
   * @param {string} path Pad onder api/, bijv. "account/profile".
   * @param {object} [requestOptions] Opties voor fetch (method, body).
   * @returns {Promise<object>} Het antwoord (fout = Error met `field` van het foute veld).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store', ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || 'Er ging iets mis.'), { field: body.field });
    return body;
  }

  /**
   * Toont een melding naast de knop van een formulier.
   * @param {HTMLFormElement} form Het formulier.
   * @param {string} text De melding.
   * @param {string} [kind] Extra klasse: ok of err.
   */
  function say(form, text, kind = '') {
    const message = form.querySelector('.form-msg');
    message.textContent = text;
    message.className = `form-msg ${kind}`;
  }

  /**
   * Voert een opslagactie uit met de knop uitgeschakeld en toont een fout als melding.
   * @param {HTMLFormElement} form Het formulier.
   * @param {Function} action Async functie die opslaat.
   * @returns {Promise<void>}
   */
  async function busy(form, action) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    say(form, 'Bezig met opslaan…');
    try { await action(); } catch (error) { say(form, error.message || 'Opslaan mislukt.', 'err'); } finally { button.disabled = false; }
  }

  let me = null;
  let profile = null;

  /** Vult de gegevens, voorkeuren en de versie uit het profiel in. */
  function fill() {
    const user = profile.user;
    $('d-name').value = user.displayName;
    $('d-email').value = user.email || '';
    $('d-phone').value = user.phone || '';
    $('d-username').textContent = user.username;
    $('pw-user').value = user.username;
    $('d-role').textContent = me.platformAdmin ? 'hoofdbeheerder' : (user.roleLabel || user.role).toLowerCase();
    $('d-created').textContent = formatDate(user.createdAt);
    const org = me.loginCode || '';
    $('d-org').textContent = org;
    $('d-org').hidden = !org;
    $('d-org-label').hidden = !org;
    fillPrefs();
    showVersion();
  }

  /** Toont de versie van de app, alleen voor beheerders (staat niet meer in de kopbalk). */
  function showVersion() {
    if (!(me.rights || []).includes('beheer')) return;
    fetch('../api/health', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => {
        if (!health || !health.version) return;
        $('d-version').textContent = health.version;
        $('d-version').hidden = false;
        $('d-version-label').hidden = false;
      })
      .catch(() => {});
  }

  /** Vult de voorkeuren in: startpagina en kopie van verstuurde mail. */
  function fillPrefs() {
    const preferences = profile.preferences;
    const start = $('pr-start');
    const options = [{ id: '', title: 'Overzicht' }].concat(modules);
    if (preferences.startPage && !options.some((option) => option.id === preferences.startPage)) options.push({ id: preferences.startPage, title: `${preferences.startPage} (niet meer beschikbaar)` });
    start.innerHTML = '';
    for (const option of options) start.add(new Option(option.title, option.id, false, option.id === preferences.startPage));
    // Kopie van verstuurde mail: alleen voor wie offertes of afspraken verstuurt.
    const sends = (me.rights || []).some((right) => right === 'offertes' || right === 'werkorders');
    $('pr-mail-wrap').hidden = !sends;
    $('pr-mail').checked = Boolean(preferences.mailCopy);
    $('pr-mail').disabled = !profile.user.email;
    $('pr-mail-hint').hidden = !sends || Boolean(profile.user.email);
  }

  let modules = [];

  $('f-details').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    form.querySelectorAll('.invalid').forEach((input) => input.classList.remove('invalid'));
    const name = $('d-name').value.trim();
    if (!name) { $('d-name').classList.add('invalid'); say(form, 'Vul je naam in.', 'err'); return; }
    busy(form, async () => {
      try {
        profile = await api('account/profile', { method: 'PUT', body: JSON.stringify({ displayName: name, email: $('d-email').value.trim(), phone: $('d-phone').value.trim() }) });
      } catch (error) {
        const field = { displayName: 'd-name', email: 'd-email', phone: 'd-phone' }[error.field];
        if (field) { $(field).classList.add('invalid'); $(field).focus(); }
        throw error;
      }
      fill();
      // Naam en initialen in de kopbalk bijwerken.
      window.AquatechAccount.load('../', { fresh: true });
      say(form, 'Opgeslagen.', 'ok');
    });
  });

  $('f-prefs').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    busy(form, async () => {
      profile = await api('account/profile', { method: 'PUT', body: JSON.stringify({ preferences: { startPage: $('pr-start').value, mailCopy: $('pr-mail').checked } }) });
      fillPrefs();
      say(form, 'Opgeslagen.', 'ok');
    });
  });

  $('f-password').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = $('pw-cur').value, newPassword = $('pw-new1').value, repeatedPassword = $('pw-new2').value;
    if (!currentPassword) { say(form, 'Vul je huidige wachtwoord in.', 'err'); return; }
    if (newPassword.length < 12) { say(form, 'Het nieuwe wachtwoord moet minimaal 12 tekens hebben.', 'err'); return; }
    if (newPassword !== repeatedPassword) { say(form, 'De twee nieuwe wachtwoorden zijn niet gelijk.', 'err'); return; }
    busy(form, async () => {
      await api('account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      form.reset();
      $('pw-user').value = profile.user.username;
      say(form, 'Je wachtwoord is gewijzigd.', 'ok');
    });
  });

  /**
   * Laadt gebruiker, instellingen en profiel en toont de pagina (of een melding waarom niet).
   * @returns {Promise<void>}
   */
  async function init() {
    me = await window.AquatechAccount.load('../');
    /**
     * Toont een melding in plaats van het profiel.
     * @param {string} text De melding.
     * @returns {void}
     */
    const blocked = (text) => { $('p-blocked').textContent = text; $('p-blocked').hidden = false; };
    if (!me.user || me.user.kind === 'gast') return blocked('Log in met je eigen account om je profiel te bekijken.');
    if (me.impersonation) return blocked('Je werkt namens een andere gebruiker. Ga eerst terug naar je eigen account om je profiel te wijzigen.');
    if (me.user.kind !== 'account') return blocked('Met de toegangscode heb je geen eigen profiel. Maak een eigen account aan in Beheer.');
    // Instellingen (zelfde verzoek als de zijbalk) en profiel tegelijk ophalen.
    const config = window.AquatechCommon ? window.AquatechCommon.getJson('api/config') : api('config').catch(() => null);
    const loading = api('account/profile');
    loading.catch(() => {});
    const disabled = ((await config) || {}).modules || {};
    modules = tools ? tools.visible(me.rights, disabled).filter((module) => module.status === 'actief' && module.href).map((module) => ({ id: module.id, title: module.title })) : [];
    try {
      profile = await loading;
    } catch (error) {
      return blocked(error.message);
    }
    fill();
    $('p-content').hidden = false;
  }

  init();
})();
