// Nieuws: berichten van de organisatie (een beheerder plaatst ze) en wat er
// nieuw is in de app (frontend/nieuws/releases.js, via de server gefilterd
// op de rechten). Wat na het vorige bezoek kwam, krijgt het label Nieuw;
// daarna onthoudt de server dat alles gezien is (api/news/seen).
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const $ = (id) => document.getElementById(id);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum in het Nederlands (ook een kale JJJJ-MM-DD).
   * @param {string} iso Datum of tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 oktober 2026" (leeg zonder datum).
   */
  const formatDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 oktober 10:15".
   */
  const formatDateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  /**
   * Roept de API aan (relatief vanaf nieuws/).
   * @param {string} path Pad onder api/, bijv. "news".
   * @param {object} [requestOptions] Opties voor fetch (method, body als JSON-tekst).
   * @returns {Promise<object>} Het antwoord (fout = Error met `field` en `status`).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/${path}`, {
      cache: 'no-store', ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || 'Er ging iets mis.'), { field: body.field, status: res.status });
    return body;
  }

  /**
   * Platte tekst naar alinea's; alleen http(s)-links worden aanklikbaar.
   * @param {string} text De tekst van het bericht.
   * @returns {string} HTML met <p>-alinea's.
   */
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).map((paragraph) => {
      const html = esc(paragraph).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      return `<p>${html.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }
  /**
   * Zet **vet** uit het versielogboek om naar HTML.
   * @param {string} text De tekst.
   * @returns {string} Veilige HTML met <strong>.
   */
  const rich = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  /**
   * Versienummers vergelijken ('0.9.0' < '0.10.0').
   * @param {string} leftVersion Eerste versie.
   * @param {string} rightVersion Tweede versie.
   * @returns {number} Negatief, 0 of positief, zoals bij sorteren.
   */
  function compare(leftVersion, rightVersion) {
    const leftParts = String(leftVersion || '0').split('.').map(Number);
    const rightParts = String(rightVersion || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((leftParts[i] || 0) !== (rightParts[i] || 0)) return (leftParts[i] || 0) - (rightParts[i] || 0);
    return 0;
  }

  let me = null;
  let data = null;
  // Stand van het vorige bezoek (blijft gelden tot de pagina opnieuw laadt).
  let seen = null;
  let editing = null;

  /**
   * Geeft aan of een bericht na het vorige bezoek kwam (niet je eigen bericht).
   * @param {object} post Het bericht.
   * @returns {boolean} true = nieuw.
   */
  const isNewPost = (post) => Boolean(seen && post.createdAt > seen.at && post.authorId !== (me.user && me.user.id));
  /**
   * Geeft aan of een versie na het vorige bezoek kwam.
   * @param {object} release Versie uit het logboek.
   * @param {number} index Plaats in de lijst (0 = nieuwste).
   * @returns {boolean} true = nieuw.
   */
  function isNewRelease(release, index) {
    if (!seen) return false;
    return seen.release ? compare(release.version, seen.release) > 0 : index === 0 && release.date >= String(seen.at).slice(0, 10);
  }

  /** Tekent de berichten, met knoppen voor wie mag plaatsen. */
  function renderPosts() {
    const items = data.items;
    if (!items.length) {
      $('n-posts').innerHTML = `<p class="n-empty">${data.canPost ? 'Nog geen berichten. Met <strong>Nieuw bericht</strong> zet je er een voor je collega\'s neer.' : 'Er zijn nog geen berichten.'}</p>`;
      return;
    }
    $('n-posts').innerHTML = items.map((post) => {
      const tags = [
        isNewPost(post) ? '<span class="tag new">Nieuw</span>' : '',
        post.pinned ? '<span class="tag pin">Vastgezet</span>' : '',
      ].join('');
      const meta = [esc(post.authorName || 'Onbekend'), esc(formatDateTime(post.createdAt)),
        post.updatedAt !== post.createdAt ? 'bewerkt' : '',
        data.canPost ? (post.audience === 'iedereen' ? 'voor iedereen, ook klanten' : 'voor medewerkers') : ''].filter(Boolean).join(' · ');
      const actions = data.canPost ? `<div class="n-actions">
          <button type="button" class="btn small" data-edit="${esc(post.id)}">Bewerken</button>
          <button type="button" class="btn small" data-pin="${esc(post.id)}">${post.pinned ? 'Losmaken' : 'Vastzetten'}</button>
          <button type="button" class="btn small danger" data-del="${esc(post.id)}">Verwijderen</button>
        </div>` : '';
      return `<article class="ncard${post.pinned ? ' pinned' : ''}${isNewPost(post) ? ' is-new' : ''}" id="bericht-${esc(post.id)}">
          <h3>${esc(post.title)}${tags}</h3>
          <p class="n-meta">${meta}</p>
          <div class="n-body">${paragraphs(post.body)}</div>
          ${actions}
        </article>`;
    }).join('');
  }

  /** Tekent het versielogboek. */
  function renderReleases() {
    const list = data.releases;
    if (!list.length) { $('n-releases').innerHTML = '<p class="n-empty">Nog niets te melden.</p>'; return; }
    $('n-releases').innerHTML = list.map((release, index) => `
      <div class="rel${isNewRelease(release, index) ? ' is-new' : ''}">
        <h3>${esc(release.title)}${isNewRelease(release, index) ? '<span class="tag new">Nieuw</span>' : ''}</h3>
        <p class="n-meta">${esc(formatDate(release.date))} · versie ${esc(release.version)}</p>
        <ul>${release.items.map((item) => `<li>${rich(item.text)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  /** Tekent berichten en versielogboek en toont de pagina. */
  function render() {
    renderPosts();
    renderReleases();
    $('n-new').hidden = !data.canPost;
    $('n-content').hidden = false;
  }

  // ---------- Bericht plaatsen of bewerken ----------
  const form = $('n-form');
  /**
   * Toont een melding naast de knop van het formulier.
   * @param {string} text De melding.
   * @param {string} [kind] Extra klasse: ok of err.
   */
  function say(text, kind = '') {
    const message = form.querySelector('.form-msg');
    message.textContent = text;
    message.className = `form-msg ${kind}`;
  }
  /**
   * Opent het formulier voor een nieuw of bestaand bericht.
   * @param {object|null} post Het bericht om te bewerken (null = nieuw).
   */
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
    form.querySelectorAll('.invalid').forEach((field) => field.classList.remove('invalid'));
    say('');
    form.hidden = false;
    $('n-new').hidden = true;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('f-title').focus({ preventScroll: true });
  }
  /** Sluit het formulier. */
  function closeForm() {
    form.hidden = true;
    editing = null;
    $('n-new').hidden = !data.canPost;
  }

  /**
   * Opent het formulier voor een nieuw bericht.
   * @returns {void}
   */
  $('n-new').onclick = () => openForm(null);
  $('f-cancel').onclick = closeForm;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('.invalid').forEach((field) => field.classList.remove('invalid'));
    const body = { title: $('f-title').value.trim(), body: $('f-body').value.trim(), audience: $('f-audience').value, pinned: $('f-pinned').checked };
    if (!body.title) { $('f-title').classList.add('invalid'); return say('Geef het bericht een titel.', 'err'); }
    if (!body.body) { $('f-body').classList.add('invalid'); return say('Schrijf een bericht.', 'err'); }
    if (!editing) body.mail = $('f-mail').checked;
    const button = $('f-submit');
    button.disabled = true;
    say('Bezig met opslaan…');
    try {
      const out = editing
        ? await api(`news/${encodeURIComponent(editing.id)}`, { method: 'PUT', body: JSON.stringify(body) })
        : await api('news', { method: 'POST', body: JSON.stringify(body) });
      await reload();
      closeForm();
      const mailed = out.mailed;
      if (mailed && mailed.error) alert(`Het bericht staat op de pagina, maar is niet gemaild: ${mailed.error}`);
    } catch (error) {
      const field = { title: 'f-title', body: 'f-body' }[error.field];
      if (field) $(field).classList.add('invalid');
      say(error.message || 'Opslaan mislukt.', 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('n-posts').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    /**
     * Zoekt een bericht op id.
     * @param {string} id Het id.
     * @returns {object|undefined} Het bericht.
     */
    const findPost = (id) => data.items.find((post) => post.id === id);
    try {
      if (button.dataset.edit) openForm(findPost(button.dataset.edit));
      else if (button.dataset.pin) {
        button.disabled = true;
        const post = findPost(button.dataset.pin);
        await api(`news/${encodeURIComponent(post.id)}`, { method: 'PUT', body: JSON.stringify({ pinned: !post.pinned }) });
        await reload();
      } else if (button.dataset.del) {
        const post = findPost(button.dataset.del);
        if (!confirm(`Bericht "${post.title}" verwijderen?`)) return;
        button.disabled = true;
        await api(`news/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
        await reload();
      }
    } catch (error) {
      button.disabled = false;
      alert(error.message || 'Er ging iets mis.');
    }
  });

  // ---------- Laden ----------
  /**
   * Haalt de berichten opnieuw op en tekent ze.
   * @returns {Promise<void>}
   */
  async function reload() {
    data = await api('news');
    render();
  }

  /** Alles op deze pagina is nu gezien: de stip in de zijbalk en het menu weg. */
  function markSeen() {
    if (!data.seen) return;
    api('news/seen', { method: 'POST', body: '{}' })
      .then(() => document.querySelectorAll('[data-news-count]').forEach((element) => element.remove()))
      .catch(() => {});
  }

  /**
   * Laadt gebruiker en berichten tegelijk, tekent de pagina en springt naar #bericht-<id>.
   * @returns {Promise<void>}
   */
  async function init() {
    // Login-check en de berichten tegelijk ophalen.
    const loading = api('news');
    loading.catch(() => {});
    me = await window.AquatechAccount.load('../');
    try {
      data = await loading;
    } catch (error) {
      $('n-blocked').textContent = error.status === 401 ? 'Log in om het nieuws te lezen.' : error.message;
      $('n-blocked').hidden = false;
      return;
    }
    seen = data.seen;
    render();
    // Direct naar een bericht (#bericht-<id>).
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({ block: 'start' });
    }
    markSeen();
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => reload().catch(() => {}));
  }

  init();
})();
