// Beheer > Webshop-inhoud: de blokken van de eigen webshop (mededeling, hero,
// voordelen, merken, zakelijk blok, contactgegevens), vaste pagina's met een
// eenvoudige tekst-editor en de afbeeldingen. Alles werkt met een concept dat
// pas zichtbaar wordt in de shop na Publiceren (API api/admin/shop-content,
// zie backend/src/webshop/shop-content.js).
(function () {
  'use strict';

  /** Grootste zijde (px) waarop een geüploade afbeelding wordt verkleind, en vanaf welke bestandsgrootte (bytes) dat gebeurt. */
  const MAX_SIDE = 2400;
  const RESIZE_FROM_BYTES = 1.5 * 1024 * 1024;
  /** Adres (vanuit Beheer) van een geüploade afbeelding, voor in de editor en de keuzelijsten. */
  const IMAGE_URL = '../api/admin/shop-content/images/';

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "30 okt 2026 10:15" (– zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

  /** De toestand van het scherm: de gegevens van de server, het open tabblad en de pagina die wordt bewerkt. */
  const state = { view: null, tab: 'site', editing: null };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de API van de webshop-inhoud aan.
   * @param {string} path Pad onder api/admin/shop-content, bijv. "site" (leeg = de hele stand).
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path, requestOptions = {}) {
    const hasBody = requestOptions.body !== undefined;
    const response = await fetch(`../api/admin/shop-content${path ? `/${path}` : ''}`, {
      cache: 'no-store',
      ...requestOptions,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  }

  /**
   * Adres van een afbeeldingsverwijzing ('asset:bestand' of 'media:id') om te tonen in Beheer.
   * @param {string} reference De verwijzing.
   * @returns {string} Het adres, of een lege tekst.
   */
  function imageUrl(reference) {
    const [kind, name] = String(reference || '').split(':');
    if (kind === 'asset' && name) return `../winkel/assets/${encodeURIComponent(name)}`;
    return kind === 'media' && name ? `${IMAGE_URL}${encodeURIComponent(name)}` : '';
  }

  /**
   * Keuzelijst voor een afbeelding: standaardafbeeldingen en eigen uploads, met voorbeeld en uploadknop.
   * @param {string} path Het veldpad, bijv. "hero.image" (data-f) of de sleutel in een rij (data-k).
   * @param {string} value De huidige verwijzing.
   * @param {{ optional?: boolean, inList?: boolean }} [options] optional = ook "geen afbeelding"; inList = veld in een lijstrij (data-k).
   * @returns {string} HTML van de keuze.
   */
  function imagePicker(path, value, { optional = false, inList = false } = {}) {
    const { assets, images } = state.view;
    const options = [
      optional ? `<option value=""${value ? '' : ' selected'}>Geen afbeelding</option>` : '',
      `<optgroup label="Standaardafbeeldingen">${assets.map((name) => `<option value="asset:${esc(name)}"${value === `asset:${name}` ? ' selected' : ''}>${esc(name)}</option>`).join('')}</optgroup>`,
      images.length ? `<optgroup label="Eigen afbeeldingen">${images.map((image) => `<option value="media:${esc(image.id)}"${value === `media:${image.id}` ? ' selected' : ''}>${esc(image.name)}</option>`).join('')}</optgroup>` : '',
    ].join('');
    return `<span class="sc-picker"><img class="sc-thumb" src="${esc(imageUrl(value))}" alt="" ${value ? '' : 'hidden'}>
      <select ${inList ? 'data-k' : 'data-f'}="${esc(path)}" data-image="1" aria-label="Afbeelding kiezen">${options}</select>
      <button type="button" class="btn small" data-upload="pick">Uploaden…</button></span>`;
  }

  /**
   * Tekstveld of tekstvak voor een blokveld.
   * @param {string} label Naam van het veld.
   * @param {string} path Het veldpad (data-f) of de sleutel (data-k).
   * @param {string} value De waarde.
   * @param {{ long?: boolean, max?: number, inList?: boolean, hint?: string }} [options] long = tekstvak, max = maximale lengte, inList = veld in een lijstrij en hint = uitleg eronder.
   * @returns {string} HTML van het veld.
   */
  function textField(label, path, value, { long = false, max = 160, inList = false, hint = '' } = {}) {
    const attribute = `${inList ? 'data-k' : 'data-f'}="${esc(path)}" maxlength="${max}"`;
    const control = long ? `<textarea ${attribute} rows="2">${esc(value)}</textarea>` : `<input ${attribute} value="${esc(value)}" autocomplete="off">`;
    return `<label>${esc(label)}${control}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
  }

  /**
   * Vinkje voor een blokveld.
   * @param {string} label Tekst naast het vinkje.
   * @param {string} path Het veldpad (data-f).
   * @param {boolean} checked Of het aan staat.
   * @returns {string} HTML van het vinkje.
   */
  function checkField(label, path, checked) {
    return `<label class="chk"><input type="checkbox" data-f="${esc(path)}"${checked ? ' checked' : ''}> ${esc(label)}</label>`;
  }

  /**
   * Zet een waarde op een pad als "hero.title" in een object.
   * @param {object} target Het object.
   * @param {string} path Het pad met punten.
   * @param {*} value De waarde.
   * @returns {void}
   */
  function setPath(target, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const holder = parts.reduce((current, part) => { current[part] = current[part] || {}; return current[part]; }, target);
    holder[last] = value;
  }

  /**
   * Leest de blokken uit het formulier.
   * @returns {object} De blokken zoals de server ze verwacht.
   */
  function collectSite() {
    const form = $('#sc-site');
    const site = {};
    form.querySelectorAll('[data-f]').forEach((field) => setPath(site, field.dataset.f, field.type === 'checkbox' ? field.checked : field.value));
    for (const list of form.querySelectorAll('[data-list]')) {
      setPath(site, list.dataset.list, [...list.querySelectorAll('.sc-row')].map((row) => {
        const item = {};
        row.querySelectorAll('[data-k]').forEach((field) => { item[field.dataset.k] = field.value; });
        return item;
      }));
    }
    return site;
  }

  /**
   * Een regel in een lijst (voordeel of merk) met velden en een verwijderknop.
   * @param {string} fields HTML van de velden.
   * @returns {string} HTML van de rij.
   */
  const listRow = (fields) => `<div class="sc-row">${fields}<button type="button" class="btn small danger" data-remove="row" aria-label="Verwijderen">Verwijderen</button></div>`;

  /**
   * Statusregel boven een onderdeel: gepubliceerd, concept en wat er gebeurt.
   * @param {object} part Het onderdeel (hasDraft, publishedAt, isDefault of published).
   * @returns {string} HTML van de regel.
   */
  function statusLine(part) {
    const published = part.publishedAt ? `Gepubliceerd op ${esc(when(part.publishedAt))}` : (part.isDefault ? 'Nog niet aangepast: de shop toont de standaardtekst' : 'Nog niet gepubliceerd');
    const live = !part.hasDraft && Boolean(part.publishedAt || part.isDefault);
    return `<p class="sc-status"><span class="sc-badge ${live ? 'live' : 'draft'}">${live ? 'Live' : 'Concept'}</span> ${published}${part.hasDraft ? ' · <b>er zijn wijzigingen die nog niet live staan</b>' : ''}</p>`;
  }

  /**
   * De knoppen onder een onderdeel (opslaan, voorbeeld, publiceren, weggooien, terugzetten).
   * @param {object} part Het onderdeel (hasDraft, canRevert).
   * @returns {string} HTML van de knoppen.
   */
  function actionButtons(part) {
    return `<div class="row sc-actions">
      <button class="btn" type="button" data-act="save">Concept opslaan</button>
      <button class="btn" type="button" data-act="preview">Voorbeeld bekijken</button>
      <button class="btn primary" type="button" data-act="publish">Publiceren</button>
      <button class="btn ghost" type="button" data-act="discard"${part.hasDraft ? '' : ' disabled'}>Concept weggooien</button>
      <button class="btn ghost" type="button" data-act="revert"${part.canRevert ? '' : ' disabled'}>Vorige versie terugzetten</button>
    </div><div class="err" role="alert"></div>`;
  }

  /**
   * Tekent het tabblad met de blokken van de startpagina, kop en voet.
   * @returns {string} HTML van het formulier.
   */
  function siteTab() {
    const part = state.view.site;
    const site = part.draft || part.published || state.view.defaults.site;
    const benefits = site.benefits.items.map((item) => listRow(`${imagePicker('image', item.image, { optional: true, inList: true })}${textField('Kop', 'title', item.title, { inList: true, max: 80 })}${textField('Tekst', 'text', item.text, { inList: true })}`)).join('');
    const brands = site.brands.items.map((item) => listRow(`${imagePicker('image', item.image, { inList: true })}${textField('Naam (alt-tekst)', 'name', item.name, { inList: true, max: 60 })}`)).join('');
    return `<form id="sc-site" class="card-form settings" autocomplete="off">
      ${statusLine(part)}
      <fieldset class="sc-block"><legend>Mededelingenbalk</legend>
        ${checkField('Toon de balk bovenaan de shop', 'notice.enabled', site.notice.enabled)}
        ${textField('Tekst', 'notice.text', site.notice.text, { long: true, max: 300 })}
      </fieldset>
      <fieldset class="sc-block"><legend>Hero (grote afbeelding bovenaan)</legend>
        <label>Afbeelding${imagePicker('hero.image', site.hero.image)}</label>
        ${textField('Kop', 'hero.title', site.hero.title, { max: 120 })}
        ${textField('Tekst', 'hero.text', site.hero.text, { long: true, max: 300 })}
        <div class="row">${textField('Knoptekst', 'hero.button', site.hero.button, { max: 40, hint: 'Leeg = "Bekijk <eerste productgroep>".' })}${textField('Link van de knop', 'hero.link', site.hero.link, { max: 300, hint: 'Leeg = eerste productgroep. Een volledig adres (https://…) of een pad in de shop, bijv. pagina/verzending/.' })}</div>
      </fieldset>
      <fieldset class="sc-block"><legend>Voordelen (onder de producten)</legend>
        ${checkField('Toon dit blok', 'benefits.enabled', site.benefits.enabled)}
        <div data-list="benefits.items">${benefits}</div>
        <button type="button" class="btn small" data-add="benefits"${site.benefits.items.length >= 6 ? ' disabled' : ''}>Voordeel toevoegen</button>
      </fieldset>
      <fieldset class="sc-block"><legend>Merken</legend>
        ${checkField('Toon dit blok', 'brands.enabled', site.brands.enabled)}
        ${textField('Titel', 'brands.title', site.brands.title, { max: 80 })}
        <div data-list="brands.items">${brands}</div>
        <button type="button" class="btn small" data-add="brands"${site.brands.items.length >= 16 ? ' disabled' : ''}>Merk toevoegen</button>
      </fieldset>
      <fieldset class="sc-block"><legend>Zakelijk account (blok onderaan)</legend>
        ${checkField('Toon dit blok', 'business.enabled', site.business.enabled)}
        <label>Achtergrondafbeelding${imagePicker('business.image', site.business.image, { optional: true })}</label>
        ${textField('Kop', 'business.title', site.business.title, { max: 120 })}
        ${textField('Tekst', 'business.text', site.business.text, { long: true, max: 300 })}
        <div class="row">${textField('Knoptekst', 'business.button', site.business.button, { max: 40, hint: 'Leeg = geen knop.' })}${textField('Link van de knop', 'business.link', site.business.link, { max: 300, hint: 'Leeg = account aanmaken.' })}</div>
      </fieldset>
      <fieldset class="sc-block"><legend>Contactgegevens en voet</legend>
        <div class="row">${textField('Telefoon', 'contact.phone', site.contact.phone, { max: 30 })}${textField('E-mail', 'contact.email', site.contact.email, { max: 120 })}${textField('K.v.k.-nummer', 'contact.kvk', site.contact.kvk, { max: 20 })}</div>
        ${textField('Adres', 'contact.address', site.contact.address, { max: 120 })}
        ${textField('Korte tekst bij "Over ons" in de voet', 'footer.about', site.footer.about, { long: true, max: 300 })}
      </fieldset>
      ${actionButtons(part)}
    </form>`;
  }

  /**
   * Tekent het tabblad met de lijst van vaste pagina's.
   * @returns {string} HTML van de lijst.
   */
  function pagesTab() {
    const { pages } = state.view;
    const rows = pages.map((page) => {
      const working = page.draft || page.published;
      const status = page.hasDraft ? (page.published ? 'Live, met wijzigingen in concept' : 'Alleen concept') : 'Live';
      const path = page.slug === 'over-ons' ? 'over-ons/' : `pagina/${page.slug}/`;
      return `<tr><td><b>${esc(working.title)}</b><br><span class="muted small">${esc(path)}</span></td>
        <td><span class="sc-badge ${page.hasDraft ? 'draft' : 'live'}">${esc(status)}</span></td><td>${esc(when(page.publishedAt || page.updatedAt))}</td>
        <td class="sc-row-actions"><button class="btn small" type="button" data-edit="${esc(page.slug)}">Bewerken</button>
        <button class="btn small danger" type="button" data-delete="${esc(page.slug)}">Verwijderen</button></td></tr>`;
    }).join('');
    const hasAbout = pages.some((page) => page.slug === 'over-ons');
    const legalButtons = Object.values(state.view.defaults.legal || {}).filter((legal) => !pages.some((page) => page.slug === legal.slug))
      .map((legal) => `<button class="btn" type="button" data-new="${esc(legal.slug)}">${esc(legal.title)} aanpassen</button>`).join(' ');
    return `<p class="muted small">Vaste pagina's zoals Klantenservice of Verzending &amp; retour. Een pagina staat op <code>winkel/pagina/&lt;naam&gt;/</code> en kan in het menu en/of de voet komen. Pas na Publiceren zien bezoekers de pagina.</p>
      <div class="row sc-toolbar"><button class="btn primary" type="button" data-new="1">Nieuwe pagina</button>
      ${hasAbout ? '' : '<button class="btn" type="button" data-new="over-ons">Standaardpagina Over ons aanpassen</button>'} ${legalButtons}</div>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Pagina</th><th>Stand</th><th>Laatst</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="4">Nog geen eigen pagina\'s. De standaardpagina Over ons en de juridische pagina\'s (voorwaarden, privacy, herroepingsrecht) staan altijd in de webshop.</td></tr>'}</tbody></table></div>`;
  }

  /**
   * Zet de HTML van een pagina om voor in de editor (eigen afbeeldingen krijgen een adres vanuit Beheer).
   * @param {string} html HTML zoals opgeslagen (met src="media:<id>").
   * @returns {string} HTML voor de editor.
   */
  const bodyForEditor = (html) => String(html || '').replace(/src="media:([0-9a-f-]{36})"/g, (_, id) => `src="${IMAGE_URL}${id}"`);

  /**
   * Zet de inhoud van de editor om naar HTML voor de server (adressen terug naar media:<id>).
   * @param {string} html HTML uit de editor.
   * @returns {string} HTML zoals de server het verwacht.
   */
  const bodyForServer = (html) => html.replace(/src="[^"]*\/api\/admin\/shop-content\/images\/([0-9a-f-]{36})"/g, (_, id) => `src="media:${id}"`);

  /**
   * Tekent het scherm voor het bewerken van één pagina, met de tekst-editor.
   * @returns {string} HTML van het formulier.
   */
  function pageEditor() {
    const { slug, isNew, fields, part } = state.editing;
    const toolbar = [
      ['h2', 'Kop'], ['h3', 'Subkop'], ['p', 'Tekst'], ['bold', 'Vet'], ['italic', 'Cursief'], ['ul', 'Lijst'], ['ol', 'Genummerd'],
      ['blockquote', 'Citaat'], ['link', 'Link'], ['unlink', 'Link weg'], ['image', 'Afbeelding'], ['clear', 'Opmaak wissen'],
    ].map(([command, label]) => `<button type="button" class="btn small" data-cmd="${command}">${label}</button>`).join('');
    return `<form id="sc-page" class="card-form settings" autocomplete="off">
      <p><button type="button" class="btn small" data-back="1">← Alle pagina's</button></p>
      ${statusLine(part)}
      <div class="row">
        ${textField('Titel', 'title', fields.title, { max: 120 })}
        <label>Naam in het adres<input data-slug="1" value="${esc(slug)}" maxlength="60" pattern="[a-z0-9][a-z0-9-]{1,58}[a-z0-9]" ${isNew && slug !== 'over-ons' && !(state.view.defaults.legal || {})[slug] ? '' : 'readonly'} placeholder="bijv. klantenservice">
          <span class="hint">Kleine letters, cijfers en streepjes: winkel/pagina/<b>${esc(slug || 'naam')}</b>/</span></label>
      </div>
      ${textField('Korte omschrijving (voor zoekmachines)', 'description', fields.description, { max: 200 })}
      <div class="row">
        ${checkField('In het menu', 'menu', fields.menu)}${checkField('In de voet', 'footer', fields.footer)}
        <label>Volgorde<input type="number" data-f="order" min="0" max="999" value="${esc(fields.order)}"></label>
      </div>
      <div class="sc-toolbar-rich" role="toolbar" aria-label="Opmaak">${toolbar}</div>
      <div id="sc-images" class="sc-image-pick" hidden></div>
      <div id="sc-editor" class="sc-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Tekst van de pagina">${bodyForEditor(fields.body)}</div>
      ${actionButtons(part)}
    </form>`;
  }

  /**
   * Tekent het tabblad met de geüploade afbeeldingen.
   * @returns {string} HTML van het raster.
   */
  function imagesTab() {
    const { images } = state.view;
    return `<p class="muted small">Afbeeldingen die je in blokken en pagina's gebruikt (JPEG, PNG of WebP, groter dan ${MAX_SIDE} pixels wordt verkleind). Een afbeelding in gebruik kan niet worden verwijderd.</p>
      <div class="row sc-toolbar"><button class="btn primary" type="button" data-upload="library">Afbeelding uploaden…</button></div>
      <div class="sc-gallery">${images.map((image) => `<figure><img src="${IMAGE_URL}${esc(image.id)}" alt="${esc(image.name)}" loading="lazy">
        <figcaption><b>${esc(image.name)}</b><br><span class="muted small">${image.width}×${image.height} · ${Math.round(image.size / 1024)} kB</span><br>
        <button class="btn small danger" type="button" data-delete-image="${esc(image.id)}">Verwijderen</button></figcaption></figure>`).join('') || '<p class="muted">Nog geen eigen afbeeldingen.</p>'}</div>`;
  }

  /**
   * Tekent het hele scherm: melding of tabbladen met hun inhoud.
   * @returns {void}
   */
  function render() {
    const root = $('#sc-root');
    const { view } = state;
    if (!view.available) { root.innerHTML = `<div class="notice">${esc(view.message)}</div>`; return; }
    const tabs = [['site', 'Startpagina en gegevens'], ['pages', "Pagina's"], ['images', 'Afbeeldingen']];
    root.innerHTML = `${view.storefront ? '' : '<div class="notice small">De eigen webshop staat uit: bezoekers zien hem pas na het aanzetten bij <a href="#webshop">Webshop en WooCommerce</a>. Het voorbeeld werkt wel.</div>'}
      <p class="muted small">Pas hier de teksten en afbeeldingen van <code>winkel/</code> aan. Wijzigingen blijven een concept totdat je op <b>Publiceren</b> klikt; met <b>Voorbeeld bekijken</b> zie je het concept zoals bezoekers het straks zien.</p>
      <div class="sc-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" class="btn${state.tab === id ? ' primary' : ''}" aria-selected="${state.tab === id}" data-tab="${id}">${label}</button>`).join('')}</div>
      ${state.tab === 'site' ? siteTab() : state.tab === 'images' ? imagesTab() : (state.editing ? pageEditor() : pagesTab())}`;
    if (state.editing) document.execCommand('defaultParagraphSeparator', false, 'p');
  }

  /**
   * Laadt de stand van de server en tekent het scherm.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      state.view = await api('');
      render();
    } catch (error) {
      $('#sc-root').innerHTML = `<div class="notice">Kan de webshop-inhoud niet laden: ${esc(error.message)}</div>`;
    }
  }

  /**
   * Zet een antwoord van de server als nieuwe stand, ook voor de pagina die open staat.
   * @param {object} view De nieuwe stand.
   * @returns {void}
   */
  function adopt(view) {
    state.view = view;
    if (state.editing) {
      const part = view.pages.find((page) => page.slug === state.editing.slug);
      if (part) state.editing.part = part;
      else state.editing = state.tab === 'pages' && state.editing.isNew ? state.editing : null;
    }
  }

  /**
   * De velden van de pagina die wordt bewerkt, zoals ze nu in het formulier staan.
   * @returns {object} title, description, body, menu, footer en order.
   */
  function collectPage() {
    const form = $('#sc-page');
    const fields = {};
    form.querySelectorAll('[data-f]').forEach((field) => { fields[field.dataset.f] = field.type === 'checkbox' ? field.checked : field.value; });
    fields.order = Number(fields.order);
    fields.body = bodyForServer($('#sc-editor').innerHTML);
    return fields;
  }

  /**
   * Slaat het concept van het open onderdeel (blokken of pagina) op.
   * @returns {Promise<void>}
   */
  async function saveDraft() {
    if (state.editing) {
      const slug = $('[data-slug]', $('#sc-page')).value.trim().toLowerCase();
      const fields = collectPage();
      state.editing = { ...state.editing, slug, fields };
      adopt(await api(`pages/${encodeURIComponent(slug)}`, { method: 'PUT', body: fields }));
      state.editing = { ...state.editing, isNew: false, part: state.view.pages.find((page) => page.slug === slug) };
    } else {
      adopt(await api('site', { method: 'PUT', body: collectSite() }));
    }
  }

  /**
   * Het pad onder api/admin/shop-content van het open onderdeel.
   * @returns {string} 'site' of 'pages/<naam>'.
   */
  const partPath = () => (state.editing ? `pages/${encodeURIComponent(state.editing.slug)}` : 'site');

  /**
   * Voert een knop onder een onderdeel uit: opslaan, voorbeeld, publiceren, concept weggooien of vorige versie terugzetten.
   * @param {string} action 'save', 'preview', 'publish', 'discard' of 'revert'.
   * @returns {Promise<void>}
   */
  async function runAction(action) {
    const errorBox = $('.err', $(state.editing ? '#sc-page' : '#sc-site'));
    errorBox.textContent = '';
    try {
      if (action === 'preview') {
        const tab = window.open('about:blank', '_blank');
        try { await saveDraft(); } catch (error) { if (tab) tab.close(); throw error; }
        const slug = state.editing ? state.editing.slug : '';
        const previewPath = state.editing ? (slug === 'over-ons' ? 'over-ons/' : `pagina/${encodeURIComponent(slug)}/`) : '';
        if (tab) tab.location.href = `../winkel/${previewPath}?voorbeeld=1`;
        render();
        return;
      }
      if (action === 'save' || action === 'publish') await saveDraft();
      if (action === 'discard' && !confirm('Het concept weggooien? Je wijzigingen sinds de laatste publicatie gaan verloren.')) return;
      if (action !== 'save') adopt(await api(`${partPath()}/${action}`, { method: 'POST', body: {} }));
      if (action === 'discard' || action === 'revert') {
        if (state.editing) {
          const part = state.view.pages.find((page) => page.slug === state.editing.slug);
          state.editing = part ? { slug: part.slug, isNew: false, part, fields: pageFields(part.draft || part.published) } : null;
        }
      }
      toast({ save: 'Concept opgeslagen', publish: 'Gepubliceerd: de wijziging staat nu live', discard: 'Concept weggegooid', revert: 'Vorige versie teruggezet' }[action]);
      render();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * De velden van een pagina voor de editor, met standaardwaarden voor ontbrekende velden.
   * @param {object} [page] De opgeslagen pagina.
   * @returns {object} title, description, body, menu, footer en order.
   */
  const pageFields = (page = {}) => ({ title: page.title || '', description: page.description || '', body: page.body || '', menu: page.menu === true, footer: page.footer !== false, order: page.order ?? 100 });

  /**
   * Verkleint een afbeelding indien nodig (groot bestand of grote zijden) en geeft hem als data-URL.
   * @param {File} file Het gekozen bestand.
   * @returns {Promise<string>} De afbeelding als data-URL.
   */
  async function prepareImage(file) {
    /**
     * Leest een bestand als data-URL.
     * @param {Blob} blob Het bestand.
     * @returns {Promise<string>} De data-URL.
     */
    const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(new Error('Het bestand kan niet worden gelezen.')));
      reader.readAsDataURL(blob);
    });
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Kies een JPEG-, PNG- of WebP-afbeelding.');
    let bitmap = null;
    try { bitmap = await createImageBitmap(file); } catch { /* geen preview mogelijk: de server controleert */ }
    if (!bitmap || (file.size <= RESIZE_FROM_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE)) return readAsDataUrl(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : file.type;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
    return readAsDataUrl(blob || file);
  }

  /**
   * Laat de gebruiker een afbeelding kiezen en uploadt hem.
   * @returns {Promise<object|null>} De nieuwe afbeelding, of null bij annuleren.
   */
  function chooseAndUpload() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      /** Uploadt het gekozen bestand en geeft de nieuwe afbeelding terug. */
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        try {
          const out = await api('images', { method: 'POST', body: { name: file.name, data: await prepareImage(file) } });
          state.view.images = out.images;
          toast('Afbeelding geüpload');
          resolve(out.image);
        } catch (error) {
          toast(error.message, true);
          resolve(null);
        }
      };
      input.click();
    });
  }

  /**
   * Voert een opmaakopdracht uit in de tekst-editor.
   * @param {string} command Sleutel van de knop (h2, h3, p, bold, italic, ul, ol, blockquote, link, unlink, image, clear).
   * @returns {void}
   */
  function formatText(command) {
    const editor = $('#sc-editor');
    editor.focus();
    const blocks = { h2: 'h2', h3: 'h3', p: 'p', blockquote: 'blockquote' };
    if (blocks[command]) document.execCommand('formatBlock', false, blocks[command]);
    else if (command === 'bold') document.execCommand('bold');
    else if (command === 'italic') document.execCommand('italic');
    else if (command === 'ul') document.execCommand('insertUnorderedList');
    else if (command === 'ol') document.execCommand('insertOrderedList');
    else if (command === 'unlink') document.execCommand('unlink');
    else if (command === 'clear') document.execCommand('removeFormat');
    else if (command === 'link') {
      const address = prompt('Adres van de link (https://…, mailto: of tel:)', 'https://');
      if (address && /^(https?:\/\/|mailto:|tel:)/i.test(address.trim())) document.execCommand('createLink', false, address.trim());
      else if (address) toast('Gebruik een adres dat begint met https://, mailto: of tel:', true);
    } else if (command === 'image') {
      const box = $('#sc-images');
      box.hidden = !box.hidden;
      box.innerHTML = state.view.images.map((image) => `<button type="button" class="sc-pick" data-insert="${esc(image.id)}" title="${esc(image.name)}"><img src="${IMAGE_URL}${esc(image.id)}" alt="${esc(image.name)}"></button>`).join('')
        + '<button type="button" class="btn small" data-upload="insert">Nieuwe afbeelding uploaden…</button>';
    }
  }

  /**
   * Zet een afbeelding in de tekst op de plek van de cursor.
   * @param {string} id Id van de afbeelding.
   * @returns {void}
   */
  function insertImage(id) {
    const editor = $('#sc-editor');
    editor.focus();
    document.execCommand('insertImage', false, `${IMAGE_URL}${id}`);
    const box = $('#sc-images');
    if (box) box.hidden = true;
  }

  /**
   * Opent een pagina in de editor (nieuw, of een bestaande).
   * @param {string} slug Naam in het adres (leeg bij een nieuwe pagina).
   * @param {{ isNew?: boolean }} [options] isNew = de pagina bestaat nog niet.
   * @returns {void}
   */
  function openPage(slug, { isNew = false } = {}) {
    const part = state.view.pages.find((page) => page.slug === slug) || { hasDraft: false, canRevert: false, publishedAt: null };
    const stored = part.draft || part.published;
    const legal = (state.view.defaults.legal || {})[slug];
    const fields = pageFields(stored || (slug === 'over-ons' ? { title: 'Over ons', body: state.view.defaults.aboutBody, menu: false, footer: false } : legal ? { title: legal.title, description: legal.description, body: legal.body, menu: false, footer: false } : {}));
    state.editing = { slug, isNew, fields, part };
    render();
  }

  /**
   * Afhandeling van alle klikken in het scherm (tabbladen, knoppen, lijsten).
   * @param {MouseEvent} event De klik.
   * @returns {Promise<void>}
   */
  async function onClick(event) {
    const target = event.target.closest('button');
    if (!target) return;
    const data = target.dataset;
    try {
      if (data.tab) {
        if (state.editing && data.tab !== 'pages' && !confirm('Je bewerkt een pagina. Niet-opgeslagen wijzigingen gaan verloren. Doorgaan?')) return;
        state.tab = data.tab;
        if (data.tab !== 'pages') state.editing = null;
        render();
      } else if (data.act) await runAction(data.act);
      else if (data.cmd) formatText(data.cmd);
      else if (data.insert) insertImage(data.insert);
      else if (data.new) openPage(data.new === '1' ? '' : data.new, { isNew: true });
      else if (data.edit) openPage(data.edit);
      else if (data.back) { state.editing = null; render(); }
      else if (data.delete) {
        if (!confirm('Deze pagina helemaal verwijderen, ook de versie die nu live staat?')) return;
        adopt(await api(`pages/${encodeURIComponent(data.delete)}`, { method: 'DELETE' }));
        render();
      } else if (data.deleteImage) {
        adopt({ ...state.view, ...(await api(`images/${encodeURIComponent(data.deleteImage)}`, { method: 'DELETE' })) });
        render();
      } else if (data.add) {
        const site = collectSite();
        const list = site[data.add].items;
        list.push(data.add === 'benefits' ? { image: '', title: '', text: '' } : { image: state.view.assets.find((name) => name.startsWith('merk-')) ? `asset:${state.view.assets.find((name) => name.startsWith('merk-'))}` : '', name: '' });
        state.view.site = { ...state.view.site, draft: site };
        render();
      } else if (data.remove) {
        target.closest('.sc-row').remove();
        state.view.site = { ...state.view.site, draft: collectSite() };
        render();
      } else if (data.upload) {
        const image = await chooseAndUpload();
        if (!image) return;
        if (data.upload === 'insert') { insertImage(image.id); return; }
        if (data.upload === 'pick') {
          const select = target.closest('.sc-picker').querySelector('select');
          select.append(new Option(image.name, `media:${image.id}`));
          select.value = `media:${image.id}`;
          state.view.site = { ...state.view.site, draft: collectSite() };
        }
        render();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Toont het voorbeeld van een nieuw gekozen afbeelding.
   * @param {Event} event De change-gebeurtenis.
   * @returns {void}
   */
  function onChange(event) {
    const select = event.target.closest('select[data-image]');
    if (!select) return;
    const thumb = $('.sc-thumb', select.parentElement);
    thumb.src = imageUrl(select.value);
    thumb.hidden = !select.value;
  }

  /**
   * Plakt alleen platte tekst in de editor, zonder opmaak van andere programma's.
   * @param {ClipboardEvent} event De plak-gebeurtenis.
   * @returns {void}
   */
  function onPaste(event) {
    if (!event.target.closest('#sc-editor')) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  }

  /**
   * Koppelt het scherm (één keer, door Beheer).
   * @param {{ toast: Function }} options toast(tekst, isFout) = melding tonen.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast;
    const root = $('#sc-root');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('paste', onPaste);
  }

  window.BeheerWebshopInhoud = { init, load };
})();
