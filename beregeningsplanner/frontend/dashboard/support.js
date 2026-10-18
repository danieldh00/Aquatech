// Support op afstand: de gebruiker geeft een hoofdbeheerder van het platform
// tijdelijk toestemming om in live als hem mee te kijken en te helpen
// (impersonatie). Hier staat ook wie er onlangs heeft meegekeken.
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const hours = (h) => (h % 24 === 0 ? `${h / 24} ${h === 24 ? 'dag' : 'dagen'}` : `${h} uur`);

  async function call(method, body) {
    const res = await fetch('api/support', {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
    return out;
  }

  async function load(me) {
    const el = document.getElementById('support');
    if (!el || location.protocol === 'file:') return;
    if (!me || !me.user || me.user.kind !== 'account' || me.platformAdmin || me.impersonation) return;
    let data;
    try { data = await call('GET'); } catch (e) { return; }
    if (!data.applicable) return;
    render(el, data, me);
  }

  function render(el, data, me) {
    const g = data.grant;
    const recent = (data.recent || []).slice(0, 5).map((r) => `<li>${esc(r.by)} · ${esc(r.environment)} · ${esc(when(r.startedAt))}${r.endedAt ? ` – ${esc(when(r.endedAt))}` : ' · <b>nu bezig</b>'}</li>`).join('');
    el.innerHTML = `
      <h2>Support op afstand</h2>
      <div class="support-card">
        <p>${g
          ? `Support mag als jou meekijken tot <b>${esc(when(g.expiresAt))}</b>. Intrekken stopt dat meteen.`
          : 'Heb je hulp nodig? Geef support tijdelijk toestemming om als jou in te loggen en mee te kijken. Alles wat support doet wordt vastgelegd.'}</p>
        <div class="support-actions">
          ${g ? '' : `<select id="support-hours" aria-label="Hoe lang">${data.options.map((h) => `<option value="${h}"${h === data.defaultHours ? ' selected' : ''}>${esc(hours(h))}</option>`).join('')}</select>`}
          <button type="button" class="btn ${g ? '' : 'primary'}" id="support-btn">${g ? 'Toestemming intrekken' : 'Toestemming geven'}</button>
        </div>
        <div class="err" role="alert"></div>
        ${recent ? `<details class="support-recent"><summary>Wie heeft er meegekeken?</summary><ul>${recent}</ul></details>` : ''}
      </div>`;
    el.hidden = false;
    el.querySelector('#support-btn').onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        if (g) await call('DELETE');
        else await call('POST', { hours: Number(el.querySelector('#support-hours').value) });
        load(me);
      } catch (e) {
        el.querySelector('.err').textContent = e.message;
        ev.currentTarget.disabled = false;
      }
    };
  }

  root.AquatechSupport = { load };
})(window);
