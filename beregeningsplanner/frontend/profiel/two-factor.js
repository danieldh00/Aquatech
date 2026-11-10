// Mijn profiel, blok Tweestapsverificatie: aanzetten met een authenticator-app (QR-code of geheim overtypen), de
// herstelcodes één keer tonen en uitzetten met wachtwoord + code. API: api/account/totp[/setup|/confirm|/disable].
// De QR-code tekent shared/qr-code.js in de browser; het geheim gaat nergens anders heen.
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const $ = (id) => document.getElementById(id);

  /**
   * Roept de API aan (relatief vanaf profiel/).
   * @param {string} path Pad onder api/, bijv. "account/totp".
   * @param {object} [body] JSON-body; met body is het een POST.
   * @returns {Promise<object>} Het antwoord (fout = Error met `status`).
   */
  async function api(path, body) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(answer.message || 'Er ging iets mis.'), { status: res.status });
    return answer;
  }

  /**
   * Toont een melding in het blok.
   * @param {string} text De melding.
   * @param {string} [kind] Extra klasse: ok of err.
   * @returns {void}
   */
  function say(text, kind = '') {
    const message = $('tf-msg');
    message.textContent = text;
    message.className = `form-msg ${kind}`;
  }

  /**
   * Laat alleen het gevraagde deel van het blok zien.
   * @param {'off'|'setup'|'codes'|'on'} part Welk deel.
   * @returns {void}
   */
  function show(part) {
    for (const name of ['off', 'setup', 'codes', 'on']) $(`tf-${name}`).hidden = name !== part;
  }

  /**
   * Zet de stand op het scherm.
   * @param {{ enabled: boolean, enabledAt: string|null, recoveryLeft: number }} state De stand van de server.
   * @returns {void}
   */
  function render(state) {
    $('tf-status').textContent = state.enabled ? 'Aan' : 'Uit';
    $('tf-status').className = `tf-badge ${state.enabled ? 'on' : ''}`;
    if (state.enabled) {
      $('tf-left').textContent = `Nog ${state.recoveryLeft} herstelcode${state.recoveryLeft === 1 ? '' : 's'} over.`;
      show('on');
    } else {
      show('off');
    }
  }

  /**
   * Begint met aanzetten: toont de QR-code en het geheim.
   * @returns {Promise<void>}
   */
  async function startSetup() {
    say('');
    try {
      const out = await api('account/totp/setup', {});
      $('tf-qr').innerHTML = window.QrCode.svg(out.uri, { label: 'QR-code voor je authenticator-app' });
      $('tf-secret').textContent = out.secret.replace(/(.{4})/g, '$1 ').trim();
      $('tf-link').href = out.uri;
      $('tf-code').value = '';
      show('setup');
      $('tf-code').focus();
    } catch (error) { say(error.message, 'err'); }
  }

  /**
   * Bevestigt met de eerste code uit de app en toont de herstelcodes.
   * @param {Event} event Het verzendgebeurtenis van het formulier.
   * @returns {Promise<void>}
   */
  async function confirmSetup(event) {
    event.preventDefault();
    say('Bezig met controleren…');
    try {
      const out = await api('account/totp/confirm', { code: $('tf-code').value });
      $('tf-qr').textContent = '';
      $('tf-secret').textContent = '';
      $('tf-recovery').textContent = out.recoveryCodes.join('\n');
      $('tf-status').textContent = 'Aan';
      $('tf-status').className = 'tf-badge on';
      show('codes');
      say('Tweestapsverificatie staat aan.', 'ok');
    } catch (error) { say(error.message, 'err'); }
  }

  /**
   * Zet tweestapsverificatie uit met wachtwoord en code.
   * @param {Event} event Het verzendgebeurtenis van het formulier.
   * @returns {Promise<void>}
   */
  async function disable(event) {
    event.preventDefault();
    say('Bezig…');
    try {
      const state = await api('account/totp/disable', { password: $('tf-off-password').value, code: $('tf-off-code').value });
      $('tf-off-password').value = '';
      $('tf-off-code').value = '';
      render(state);
      say('Tweestapsverificatie staat uit.', 'ok');
    } catch (error) { say(error.message, 'err'); }
  }

  /**
   * Laadt de stand en koppelt de knoppen; zonder eigen account (toegangscode, gast) blijft het blok verborgen.
   * @returns {Promise<void>}
   */
  async function init() {
    const card = $('f-totp');
    if (!card || !window.QrCode) return;
    let state;
    try { state = await api('account/totp'); } catch { return; }
    card.hidden = false;
    render(state);
    $('tf-start').addEventListener('click', startSetup);
    $('tf-cancel').addEventListener('click', () => { say(''); render({ enabled: false }); });
    $('tf-setup').addEventListener('submit', confirmSetup);
    $('tf-done').addEventListener('click', async () => { say(''); render(await api('account/totp')); });
    $('tf-on').addEventListener('submit', disable);
  }

  init();
})();
