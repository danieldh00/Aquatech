// Mijn profiel: eigen naam, contactgegevens, voorkeuren en wachtwoord.
// API: api/account/profile (GET/PUT) en api/account/password (POST).
(function () {
  const $ = (id) => document.getElementById(id);
  const tools = window.AquatechModuleTools;
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

  async function api(path, opts = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store', ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || 'Er ging iets mis.'), { field: body.field });
    return body;
  }

  // Melding naast de knop van een formulier.
  function say(form, text, kind = '') {
    const el = form.querySelector('.form-msg');
    el.textContent = text;
    el.className = `form-msg ${kind}`;
  }

  async function busy(form, fn) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    say(form, 'Bezig met opslaan…');
    try { await fn(); } catch (e) { say(form, e.message || 'Opslaan mislukt.', 'err'); } finally { btn.disabled = false; }
  }

  let me = null;
  let profile = null;

  function fill() {
    const u = profile.user;
    $('d-name').value = u.displayName;
    $('d-email').value = u.email || '';
    $('d-phone').value = u.phone || '';
    $('d-username').textContent = u.username;
    $('pw-user').value = u.username;
    $('d-role').textContent = me.platformAdmin ? 'hoofdbeheerder' : (u.roleLabel || u.role).toLowerCase();
    $('d-created').textContent = fmtDate(u.createdAt);
    const org = me.loginCode || '';
    $('d-org').textContent = org;
    $('d-org').hidden = !org;
    $('d-org-label').hidden = !org;
    fillPrefs();
    showVersion();
  }

  // Versie van de app: alleen voor beheerders (staat niet meer in de kopbalk).
  function showVersion() {
    if (!(me.rights || []).includes('beheer')) return;
    fetch('../api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.version) return;
        $('d-version').textContent = d.version;
        $('d-version').hidden = false;
        $('d-version-label').hidden = false;
      })
      .catch(() => {});
  }

  function fillPrefs() {
    const p = profile.preferences;
    const start = $('pr-start');
    const options = [{ id: '', title: 'Overzicht' }].concat(modules);
    if (p.startPage && !options.some((m) => m.id === p.startPage)) options.push({ id: p.startPage, title: `${p.startPage} (niet meer beschikbaar)` });
    start.innerHTML = '';
    for (const m of options) start.add(new Option(m.title, m.id, false, m.id === p.startPage));
    // Kopie van verstuurde mail: alleen voor wie offertes of afspraken verstuurt.
    const sends = (me.rights || []).some((r) => r === 'offertes' || r === 'werkorders');
    $('pr-mail-wrap').hidden = !sends;
    $('pr-mail').checked = Boolean(p.mailCopy);
    $('pr-mail').disabled = !profile.user.email;
    $('pr-mail-hint').hidden = !sends || Boolean(profile.user.email);
  }

  let modules = [];

  $('f-details').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    const name = $('d-name').value.trim();
    if (!name) { $('d-name').classList.add('invalid'); say(form, 'Vul je naam in.', 'err'); return; }
    busy(form, async () => {
      try {
        profile = await api('account/profile', { method: 'PUT', body: JSON.stringify({ displayName: name, email: $('d-email').value.trim(), phone: $('d-phone').value.trim() }) });
      } catch (e) {
        const field = { displayName: 'd-name', email: 'd-email', phone: 'd-phone' }[e.field];
        if (field) { $(field).classList.add('invalid'); $(field).focus(); }
        throw e;
      }
      fill();
      // Naam en initialen in de kopbalk bijwerken.
      window.AquatechAccount.load('../', { fresh: true });
      say(form, 'Opgeslagen.', 'ok');
    });
  });

  $('f-prefs').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    busy(form, async () => {
      profile = await api('account/profile', { method: 'PUT', body: JSON.stringify({ preferences: { startPage: $('pr-start').value, mailCopy: $('pr-mail').checked } }) });
      fillPrefs();
      say(form, 'Opgeslagen.', 'ok');
    });
  });

  $('f-password').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const cur = $('pw-cur').value, n1 = $('pw-new1').value, n2 = $('pw-new2').value;
    if (!cur) { say(form, 'Vul je huidige wachtwoord in.', 'err'); return; }
    if (n1.length < 12) { say(form, 'Het nieuwe wachtwoord moet minimaal 12 tekens hebben.', 'err'); return; }
    if (n1 !== n2) { say(form, 'De twee nieuwe wachtwoorden zijn niet gelijk.', 'err'); return; }
    busy(form, async () => {
      await api('account/password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: n1 }) });
      form.reset();
      $('pw-user').value = profile.user.username;
      say(form, 'Je wachtwoord is gewijzigd.', 'ok');
    });
  });

  async function init() {
    me = await window.AquatechAccount.load('../');
    const blocked = (text) => { $('p-blocked').textContent = text; $('p-blocked').hidden = false; };
    if (!me.user || me.user.kind === 'gast') return blocked('Log in met je eigen account om je profiel te bekijken.');
    if (me.impersonation) return blocked('Je werkt namens een andere gebruiker. Ga eerst terug naar je eigen account om je profiel te wijzigen.');
    if (me.user.kind !== 'account') return blocked('Met de toegangscode heb je geen eigen profiel. Maak een eigen account aan in Beheer.');
    // Instellingen (zelfde verzoek als de zijbalk) en profiel tegelijk ophalen.
    const config = window.AquatechCommon ? window.AquatechCommon.getJson('api/config') : api('config').catch(() => null);
    const loading = api('account/profile');
    loading.catch(() => {});
    const disabled = ((await config) || {}).modules || {};
    modules = tools ? tools.visible(me.rights, disabled).filter((m) => m.status === 'actief' && m.href).map((m) => ({ id: m.id, title: m.title })) : [];
    try {
      profile = await loading;
    } catch (e) {
      return blocked(e.message);
    }
    fill();
    $('p-content').hidden = false;
  }

  init();
})();
