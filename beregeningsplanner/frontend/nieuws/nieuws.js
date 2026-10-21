// Nieuws: berichten van de organisatie (een beheerder plaatst ze) en wat er
// nieuw is in de app (frontend/nieuws/releases.js, via de server gefilterd
// op de rechten). Wat na het vorige bezoek kwam, krijgt het label Nieuw;
// daarna onthoudt de server dat alles gezien is (api/news/seen).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const fmtTime = (iso) => new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  async function api(path, opts = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store', ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || 'Er ging iets mis.'), { field: body.field, status: res.status });
    return body;
  }

  // Platte tekst naar alinea's; alleen http(s)-links worden aanklikbaar.
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map((p) => {
      const html = esc(p).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      return `<p>${html.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }
  // **vet** uit het versielogboek.
  const rich = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Versienummers vergelijken ('0.9.0' < '0.10.0').
  function compare(a, b) {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  }

  let me = null;
  let data = null;
  // Stand van het vorige bezoek (blijft gelden tot de pagina opnieuw laadt).
  let seen = null;
  let editing = null;

  const isNewPost = (p) => Boolean(seen && p.createdAt > seen.at && p.authorId !== (me.user && me.user.id));
  function isNewRelease(r, i) {
    if (!seen) return false;
    return seen.release ? compare(r.version, seen.release) > 0 : i === 0 && r.date >= String(seen.at).slice(0, 10);
  }

  function renderPosts() {
    const items = data.items;
    if (!items.length) {
      $('n-posts').innerHTML = `<p class="n-empty">${data.canPost ? 'Nog geen berichten. Met <strong>Nieuw bericht</strong> zet je er een voor je collega\'s neer.' : 'Er zijn nog geen berichten.'}</p>`;
      return;
    }
    $('n-posts').innerHTML = items.map((p) => {
      const tags = [
        isNewPost(p) ? '<span class="tag new">Nieuw</span>' : '',
        p.pinned ? '<span class="tag pin">Vastgezet</span>' : '',
      ].join('');
      const meta = [esc(p.authorName || 'Onbekend'), esc(fmtTime(p.createdAt)),
        p.updatedAt !== p.createdAt ? 'bewerkt' : '',
        data.canPost ? (p.audience === 'iedereen' ? 'voor iedereen, ook klanten' : 'voor medewerkers') : ''].filter(Boolean).join(' · ');
      const actions = data.canPost ? `<div class="n-actions">
          <button type="button" class="btn small" data-edit="${esc(p.id)}">Bewerken</button>
          <button type="button" class="btn small" data-pin="${esc(p.id)}">${p.pinned ? 'Losmaken' : 'Vastzetten'}</button>
          <button type="button" class="btn small danger" data-del="${esc(p.id)}">Verwijderen</button>
        </div>` : '';
      return `<article class="ncard${p.pinned ? ' pinned' : ''}${isNewPost(p) ? ' is-new' : ''}" id="bericht-${esc(p.id)}">
          <h3>${esc(p.title)}${tags}</h3>
          <p class="n-meta">${meta}</p>
          <div class="n-body">${paragraphs(p.body)}</div>
          ${actions}
        </article>`;
    }).join('');
  }

  function renderReleases() {
    const list = data.releases;
    if (!list.length) { $('n-releases').innerHTML = '<p class="n-empty">Nog niets te melden.</p>'; return; }
    $('n-releases').innerHTML = list.map((r, i) => `
      <div class="rel${isNewRelease(r, i) ? ' is-new' : ''}">
        <h3>${esc(r.title)}${isNewRelease(r, i) ? '<span class="tag new">Nieuw</span>' : ''}</h3>
        <p class="n-meta">${esc(fmtDate(r.date))} · versie ${esc(r.version)}</p>
        <ul>${r.items.map((it) => `<li>${rich(it.text)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  function render() {
    renderPosts();
    renderReleases();
    $('n-new').hidden = !data.canPost;
    $('n-content').hidden = false;
  }

  // ---------- Bericht plaatsen of bewerken ----------
  const form = $('n-form');
  function say(text, kind = '') {
    const el = form.querySelector('.form-msg');
    el.textContent = text;
    el.className = `form-msg ${kind}`;
  }
  function openForm(post) {
    editing = post || null;
    $('n-form-title').textContent = post ? 'Bericht bewerken' : 'Nieuw bericht';
    $('f-submit').textContent = post ? 'Opslaan' : 'Plaatsen';
    $('f-title').value = post ? post.title : '';
    $('f-body').value = post ? post.body : '';
    $('f-audience').value = post ? post.audience : 'medewerkers';
    $('f-pinned').checked = Boolean(post && post.pinned);
    $('f-mail').checked = false;
    // E-mail alleen bij een nieuw bericht en met een ingestelde mailserver.
    $('f-mail-wrap').hidden = Boolean(post) || !data.canMail;
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    say('');
    form.hidden = false;
    $('n-new').hidden = true;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('f-title').focus({ preventScroll: true });
  }
  function closeForm() {
    form.hidden = true;
    editing = null;
    $('n-new').hidden = !data.canPost;
  }

  $('n-new').onclick = () => openForm(null);
  $('f-cancel').onclick = closeForm;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    const body = { title: $('f-title').value.trim(), body: $('f-body').value.trim(), audience: $('f-audience').value, pinned: $('f-pinned').checked };
    if (!body.title) { $('f-title').classList.add('invalid'); return say('Geef het bericht een titel.', 'err'); }
    if (!body.body) { $('f-body').classList.add('invalid'); return say('Schrijf een bericht.', 'err'); }
    if (!editing) body.mail = $('f-mail').checked;
    const btn = $('f-submit');
    btn.disabled = true;
    say('Bezig met opslaan…');
    try {
      const out = editing
        ? await api(`news/${encodeURIComponent(editing.id)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api('news', { method: 'POST', body: JSON.stringify(body) });
      await reload();
      closeForm();
      const mailed = out.mailed;
      if (mailed && mailed.error) alert(`Het bericht staat op de pagina, maar is niet gemaild: ${mailed.error}`);
    } catch (e) {
      const field = { title: 'f-title', body: 'f-body' }[e.field];
      if (field) $(field).classList.add('invalid');
      say(e.message || 'Opslaan mislukt.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('n-posts').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const find = (id) => data.items.find((p) => p.id === id);
    try {
      if (btn.dataset.edit) openForm(find(btn.dataset.edit));
      else if (btn.dataset.pin) {
        btn.disabled = true;
        const p = find(btn.dataset.pin);
        await api(`news/${encodeURIComponent(p.id)}`, { method: 'PUT', body: JSON.stringify({ pinned: !p.pinned }) });
        await reload();
      } else if (btn.dataset.del) {
        const p = find(btn.dataset.del);
        if (!confirm(`Bericht "${p.title}" verwijderen?`)) return;
        btn.disabled = true;
        await api(`news/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        await reload();
      }
    } catch (e) {
      btn.disabled = false;
      alert(e.message || 'Er ging iets mis.');
    }
  });

  // ---------- Laden ----------
  async function reload() {
    data = await api('news');
    render();
  }

  // Alles op deze pagina is nu gezien: de stip in de zijbalk en het menu weg.
  function markSeen() {
    if (!data.seen) return;
    api('news/seen', { method: 'POST', body: '{}' })
      .then(() => document.querySelectorAll('[data-news-count]').forEach((el) => el.remove()))
      .catch(() => {});
  }

  async function init() {
    // Login-check en de berichten tegelijk ophalen.
    const loading = api('news');
    loading.catch(() => {});
    me = await window.AquatechAccount.load('../');
    try {
      data = await loading;
    } catch (e) {
      $('n-blocked').textContent = e.status === 401 ? 'Log in om het nieuws te lezen.' : e.message;
      $('n-blocked').hidden = false;
      return;
    }
    seen = data.seen;
    render();
    // Direct naar een bericht (#bericht-<id>).
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1));
      if (el) el.scrollIntoView({ block: 'start' });
    }
    markSeen();
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => reload().catch(() => {}));
  }

  init();
})();
