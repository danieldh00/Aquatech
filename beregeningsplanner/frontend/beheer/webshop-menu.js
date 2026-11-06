// Beheer > Webshop-inhoud > Menu: de categorieboom van de eigen webshop. Per
// hoofdcategorie (kop in het menu) de categorieën en subcategorieën hernoemen,
// verplaatsen, verbergen, toevoegen en verwijderen, met uitleg, afbeelding en de
// webshopcategorieën waarop producten worden ingedeeld. Werkt met een concept dat
// pas live gaat na Publiceren (API api/admin/shop-content/menu, zie
// backend/src/webshop/shop-content.js).
(function () {
  'use strict';

  /** Hoeveel niveaus onder een kop (hoofdcategorie) mogen staan; gelijk aan de grens op de server. */
  const MAX_DEPTH = 6;
  /** Adres (vanuit Beheer) van een geüploade afbeelding. */
  const IMAGE_URL = '../api/admin/shop-content/images/';

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "30 okt 2026 10:15".
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /**
   * Maakt van een categorienaam een vergelijkbare tekst (zoals de server: kleine letters, zonder leestekens).
   * @param {string} name De naam.
   * @returns {string} De vergelijkbare tekst.
   */
  const plain = (name) => String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' en ').replace(/[^a-z0-9]+/g, ' ').trim();

  /** De toestand: de gegevens van de server, de bewerkbare boom, het element waarin getekend wordt en de hulpfuncties van het scherm. */
  const state = { view: null, roots: [], host: null, api: null, adopt: null, toast: () => {} };

  /**
   * Zet de boom van de server om in een bewerkbare boom met schermvlaggen (_open, _detail, _new).
   * @param {object[]} list De knopen van één niveau.
   * @param {number} depth Diepte (0 = kop).
   * @returns {object[]} De bewerkbare knopen.
   */
  function toEditable(list, depth) {
    return list.map((node) => ({
      name: node.name, slug: node.slug, intro: node.intro || '', image: node.image || '', hidden: node.hidden === true, match: [...(node.match || [])], group: node.group,
      children: toEditable(node.children || [], depth + 1), _open: depth === 0, _detail: false, _new: false,
    }));
  }

  /**
   * De boom die nu getoond wordt: het concept, anders de gepubliceerde boom, anders de standaard.
   * @returns {object[]} De bewerkbare boom.
   */
  function currentTree() {
    const { menu, defaults } = state.view;
    const source = (menu.draft || menu.published || defaults.menu).roots;
    return toEditable(source, 0);
  }

  /**
   * Zet de bewerkbare boom om in wat de server verwacht (zonder schermvlaggen).
   * @param {object[]} list De knopen van één niveau.
   * @returns {object[]} De knopen voor de server.
   */
  function forServer(list) {
    return list.map((node) => ({
      name: node.name, slug: node.slug, intro: node.intro, image: node.image, hidden: node.hidden, match: node.match, group: node.group, children: forServer(node.children),
    }));
  }

  /**
   * Zoekt een knoop op zijn pad (indexen per niveau).
   * @param {number[]} path Het pad, bijv. [2, 0, 1].
   * @returns {object} De knoop.
   */
  function nodeAt(path) {
    let list = state.roots;
    let node = null;
    for (const index of path) { node = list[index]; list = node.children; }
    return node;
  }

  /**
   * De lijst waarin een knoop staat (zijn broers en zussen).
   * @param {number[]} path Het pad van de knoop.
   * @returns {object[]} De lijst.
   */
  function siblingsOf(path) {
    return path.length === 1 ? state.roots : nodeAt(path.slice(0, -1)).children;
  }

  /**
   * Het aantal niveaus van een knoop met alles eronder (1 = alleen de knoop zelf).
   * @param {object} node De knoop.
   * @returns {number} De hoogte.
   */
  const heightOf = (node) => 1 + Math.max(0, ...node.children.map(heightOf));

  /**
   * Alle namen waarop de boom nu producten indeelt (naam of ingevulde webshopcategorieën), vergelijkbaar gemaakt.
   * @returns {Set<string>} De namen.
   */
  function placedNames() {
    const names = new Set();
    /**
     * Voegt de namen van een knoop en zijn kinderen toe.
     * @param {object[]} list De knopen van één niveau.
     * @returns {void}
     */
    const visit = (list) => {
      for (const node of list) {
        for (const name of node.match.length ? node.match : [node.name]) names.add(plain(name));
        visit(node.children);
      }
    };
    visit(state.roots);
    return names;
  }

  /**
   * Keuzelijst voor de afbeelding van een categorie: standaardafbeeldingen en eigen uploads.
   * @param {string} value De huidige verwijzing ('asset:…' of 'media:…', leeg = geen).
   * @returns {string} HTML van de keuze met voorbeeld.
   */
  function imagePicker(value) {
    const { assets, images } = state.view;
    const options = [
      `<option value=""${value ? '' : ' selected'}>Geen afbeelding</option>`,
      `<optgroup label="Standaardafbeeldingen">${assets.map((name) => `<option value="asset:${esc(name)}"${value === `asset:${name}` ? ' selected' : ''}>${esc(name)}</option>`).join('')}</optgroup>`,
      images.length ? `<optgroup label="Eigen afbeeldingen">${images.map((image) => `<option value="media:${esc(image.id)}"${value === `media:${image.id}` ? ' selected' : ''}>${esc(image.name)}</option>`).join('')}</optgroup>` : '',
    ].join('');
    return `<span class="sc-picker"><img class="sc-thumb" src="${esc(imageUrl(value))}" alt="" ${value ? '' : 'hidden'}><select data-mf="image" aria-label="Afbeelding kiezen">${options}</select></span>`;
  }

  /**
   * Adres om een afbeeldingsverwijzing te tonen in Beheer.
   * @param {string} reference 'asset:bestand' of 'media:id'.
   * @returns {string} Het adres, of een lege tekst.
   */
  function imageUrl(reference) {
    const [kind, name] = String(reference || '').split(':');
    if (kind === 'asset' && name) return `../winkel/assets/${encodeURIComponent(name)}`;
    return kind === 'media' && name ? `${IMAGE_URL}${encodeURIComponent(name)}` : '';
  }

  /**
   * De velden onder een categorie: uitleg, afbeelding en de webshopcategorieën waarop producten worden ingedeeld.
   * @param {object} node De categorie.
   * @param {boolean} isRoot Of het een kop (hoofdcategorie) is.
   * @returns {string} HTML van het paneel.
   */
  function detailHtml(node, isRoot) {
    return `<div class="mn-detail">
      <label>Uitleg boven de pagina<textarea data-mf="intro" rows="3" maxlength="2000">${esc(node.intro)}</textarea><span class="hint">Een lege regel begint een nieuwe alinea; een regel die met ## begint is een tussenkop.</span></label>
      <label>Afbeelding in het blok${imagePicker(node.image)}<span class="hint">Eigen foto's upload je eerst bij het tabblad Afbeeldingen.</span></label>
      ${isRoot ? '' : `<label>Webshopcategorieën<input data-mf="match" maxlength="400" value="${esc(node.match.join(' | '))}" autocomplete="off" placeholder="Leeg = de naam hierboven"><span class="hint">Producten met een van deze categorieën in de webshop komen in deze categorie; meerdere namen scheid je met |. Een andere naam hierboven verandert dit niet.</span></label>`}
      ${node._new ? '' : `<p class="muted small">Adres: <code>winkel/${isRoot ? 'groep' : 'categorie'}/${esc(isRoot ? node.group : node.slug)}/</code> (blijft gelijk bij hernoemen)</p>`}
    </div>`;
  }

  /**
   * Een regel van de boom met knoppen, en eronder (indien open) het detailpaneel en de subcategorieën.
   * @param {object} node De categorie.
   * @param {number[]} path Haar pad.
   * @returns {string} HTML van de regel en alles eronder.
   */
  function rowHtml(node, path) {
    const depth = path.length - 1;
    const isRoot = depth === 0;
    const index = path[path.length - 1];
    const siblings = siblingsOf(path);
    const canIndent = index > 0 && depth + heightOf(node) <= MAX_DEPTH && depth + 1 <= MAX_DEPTH;
    const canOutdent = depth >= 2;
    const canAdd = depth < MAX_DEPTH;
    /**
     * Een kleine knop in de regel.
     * @param {string} action De actie (data-m).
     * @param {string} symbol Wat op de knop staat.
     * @param {string} label Uitleg (voor hulpmiddelen en de muis).
     * @param {boolean} enabled Of de knop werkt.
     * @returns {string} HTML van de knop.
     */
    const button = (action, symbol, label, enabled = true) => `<button type="button" class="btn small" data-m="${action}" title="${esc(label)}" aria-label="${esc(label)}"${enabled ? '' : ' disabled'}>${symbol}</button>`;
    const head = `<div class="mn-row${isRoot ? ' mn-root' : ''}" style="--depth:${depth}" data-path="${path.join('.')}">
      <button type="button" class="btn small ghost" data-m="fold" aria-label="${node._open ? 'Inklappen' : 'Uitklappen'}" aria-expanded="${node._open}"${node.children.length ? '' : ' disabled'}>${node._open ? '▾' : '▸'}</button>
      <input class="mn-name" data-mf="name" value="${esc(node.name)}" maxlength="80" aria-label="Naam" autocomplete="off">
      ${isRoot ? '<span class="muted small">kop in het menu</span>' : `<label class="chk"><input type="checkbox" data-mf="hidden"${node.hidden ? ' checked' : ''}> Verbergen</label>`}
      <span class="mn-actions">
        ${isRoot ? '' : `${button('up', '↑', 'Omhoog', index > 0)}${button('down', '↓', 'Omlaag', index < siblings.length - 1)}${button('out', '←', 'Een niveau terug', canOutdent)}${button('in', '→', 'Onder de categorie erboven', canIndent)}`}
        ${button('add', '+', 'Subcategorie toevoegen', canAdd)}
        <button type="button" class="btn small${node._detail ? ' primary' : ''}" data-m="detail" aria-expanded="${node._detail}">Details</button>
        ${isRoot ? '' : button('remove', 'Verwijderen', 'Deze categorie verwijderen')}
      </span></div>`;
    const below = node._open ? node.children.map((child, childIndex) => rowHtml(child, [...path, childIndex])).join('') : '';
    return `${head}${node._detail ? `<div class="mn-detail-wrap" style="--depth:${depth}">${detailHtml(node, isRoot)}</div>` : ''}${below}`;
  }

  /**
   * Statusregel boven de boom: live of concept.
   * @returns {string} HTML van de regel.
   */
  function statusLine() {
    const { menu } = state.view;
    const published = menu.publishedAt ? `Gepubliceerd op ${esc(when(menu.publishedAt))}` : 'Nog niet aangepast: de shop toont de standaardindeling van aquatechshop.nl';
    const live = !menu.hasDraft;
    return `<p class="sc-status"><span class="sc-badge ${live ? 'live' : 'draft'}">${live ? 'Live' : 'Concept'}</span> ${published}${menu.hasDraft ? ' · <b>er zijn wijzigingen die nog niet live staan</b>' : ''}</p>`;
  }

  /**
   * De lijst met webshopcategorieën die nog in geen enkele categorie van het menu staan, met een knop om ze toe te voegen.
   * @returns {string} HTML van het blok (leeg als alles is ingedeeld).
   */
  function unplacedHtml() {
    const placed = placedNames();
    const loose = (state.view.unplaced || []).filter((entry) => !placed.has(plain(entry.name)));
    if (!loose.length) return '';
    return `<fieldset class="sc-block"><legend>Nog niet ingedeeld</legend>
      <p class="muted small">Deze categorieën uit de webshop staan nog niet in het menu. Producten erin staan nu los onder de kop die het best past; voeg ze toe en verplaats ze naar de juiste plek.</p>
      ${loose.map((entry, position) => `<div class="mn-loose"><span>${esc(entry.name)} <span class="muted small">(${entry.count} ${entry.count === 1 ? 'product' : 'producten'})</span></span><button type="button" class="btn small" data-m="place" data-position="${position}">Toevoegen aan het menu</button></div>`).join('')}</fieldset>`;
  }

  /**
   * Tekent de editor opnieuw.
   * @returns {void}
   */
  function render() {
    const { menu } = state.view;
    state.host.innerHTML = `<p class="muted small">Pas hier de indeling van het menu en de categoriepagina's aan. De koppen (Beregening, Pomp & techniek, …) kun je hernoemen; daaronder maak je zelf categorieën en subcategorieën. Wijzigingen blijven een concept totdat je op <b>Publiceren</b> klikt.</p>
      ${statusLine()}
      <div class="mn-tree">${state.roots.map((root, index) => rowHtml(root, [index])).join('')}</div>
      ${unplacedHtml()}
      <div class="row sc-actions">
        <button class="btn" type="button" data-m="save">Concept opslaan</button>
        <button class="btn" type="button" data-m="preview">Voorbeeld bekijken</button>
        <button class="btn primary" type="button" data-m="publish">Publiceren</button>
        <button class="btn ghost" type="button" data-m="discard"${menu.hasDraft ? '' : ' disabled'}>Concept weggooien</button>
        <button class="btn ghost" type="button" data-m="revert"${menu.canRevert ? '' : ' disabled'}>Vorige versie terugzetten</button>
      </div><div class="err" role="alert"></div>`;
  }

  /**
   * Slaat het concept van de boom op en neemt het antwoord van de server over.
   * @returns {Promise<void>}
   */
  async function saveDraft() {
    state.adopt(await state.api('menu', { method: 'PUT', body: { roots: forServer(state.roots) } }));
    state.view = state.adopt.current();
    state.roots = currentTree();
  }

  /**
   * Voert een knop onder de boom uit: opslaan, voorbeeld, publiceren, concept weggooien of vorige versie terugzetten.
   * @param {string} action 'save', 'preview', 'publish', 'discard' of 'revert'.
   * @returns {Promise<void>}
   */
  async function runAction(action) {
    const errorBox = state.host.querySelector('.err');
    errorBox.textContent = '';
    try {
      if (action === 'preview') {
        const tab = window.open('about:blank', '_blank');
        try { await saveDraft(); } catch (error) { if (tab) tab.close(); throw error; }
        if (tab) tab.location.href = '../winkel/?voorbeeld=1';
        else state.toast('Het voorbeeldtabblad kon niet worden geopend. Sta pop-ups toe voor deze pagina.', true);
        render();
        return;
      }
      if (action === 'discard' && !confirm('Het concept weggooien? Je wijzigingen sinds de laatste publicatie gaan verloren.')) return;
      if (action === 'save' || action === 'publish') await saveDraft();
      if (action !== 'save') {
        state.adopt(await state.api(`menu/${action}`, { method: 'POST', body: {} }));
        state.view = state.adopt.current();
        if (action === 'discard' || action === 'revert') state.roots = currentTree();
      }
      state.toast({ save: 'Concept opgeslagen', publish: 'Gepubliceerd: het menu staat nu live', discard: 'Concept weggegooid', revert: 'Vorige versie teruggezet' }[action]);
      render();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Het pad van de regel waarin een element staat.
   * @param {Element} element Een element in de regel.
   * @returns {number[]} Het pad.
   */
  const pathOf = (element) => element.closest('[data-path]').dataset.path.split('.').map(Number);

  /**
   * Verplaatst, voegt toe of verwijdert een categorie.
   * @param {string} action 'up', 'down', 'out', 'in', 'add', 'remove', 'fold' of 'detail'.
   * @param {number[]} path Het pad van de categorie.
   * @returns {void}
   */
  function change(action, path) {
    const node = nodeAt(path);
    const siblings = siblingsOf(path);
    const index = path[path.length - 1];
    if (action === 'fold') node._open = !node._open;
    else if (action === 'detail') node._detail = !node._detail;
    else if (action === 'add') { node.children.push({ name: 'Nieuwe categorie', slug: '', intro: '', image: '', hidden: false, match: [], group: undefined, children: [], _open: false, _detail: true, _new: true }); node._open = true; }
    else if (action === 'up' && index > 0) [siblings[index - 1], siblings[index]] = [siblings[index], siblings[index - 1]];
    else if (action === 'down' && index < siblings.length - 1) [siblings[index + 1], siblings[index]] = [siblings[index], siblings[index + 1]];
    else if (action === 'in' && index > 0) { siblings.splice(index, 1); siblings[index - 1].children.push(node); siblings[index - 1]._open = true; }
    else if (action === 'out' && path.length >= 3) {
      siblings.splice(index, 1);
      const parentPath = path.slice(0, -1);
      siblingsOf(parentPath).splice(parentPath[parentPath.length - 1] + 1, 0, node);
    } else if (action === 'remove') {
      const hasContent = node.children.length || node.intro || node.image || node.match.length;
      if (hasContent && !confirm(`"${node.name}" verwijderen${node.children.length ? ' met alle subcategorieën' : ''}?`)) return;
      siblings.splice(index, 1);
    }
    render();
  }

  /**
   * Voegt een webshopcategorie die nog niet in het menu staat toe als nieuwe categorie onder de best passende kop.
   * @param {number} position Welke uit de lijst "Nog niet ingedeeld".
   * @returns {void}
   */
  function place(position) {
    const placed = placedNames();
    const loose = (state.view.unplaced || []).filter((entry) => !placed.has(plain(entry.name)));
    const entry = loose[position];
    if (!entry) return;
    const heading = state.roots.find((root) => root.group === entry.groupSlug) || state.roots[0];
    heading.children.push({ name: entry.name, slug: '', intro: '', image: '', hidden: false, match: [entry.name], group: undefined, children: [], _open: false, _detail: false, _new: true });
    heading._open = true;
    render();
  }

  /**
   * Afhandeling van alle klikken in de editor.
   * @param {MouseEvent} event De klik.
   * @returns {Promise<void>}
   */
  async function onClick(event) {
    const target = event.target.closest('button[data-m]');
    if (!target || target.disabled) return;
    const action = target.dataset.m;
    if (['save', 'preview', 'publish', 'discard', 'revert'].includes(action)) await runAction(action);
    else if (action === 'place') place(Number(target.dataset.position));
    else change(action, pathOf(target));
  }

  /**
   * Neemt een gewijzigd veld over in de boom (zonder opnieuw te tekenen, zodat de cursor blijft staan).
   * @param {Event} event De input- of change-gebeurtenis.
   * @returns {void}
   */
  function onField(event) {
    const field = event.target.closest('[data-mf]');
    if (!field) return;
    const path = pathOf(field);
    const node = nodeAt(path);
    const name = field.dataset.mf;
    if (name === 'hidden') node.hidden = field.checked;
    else if (name === 'match') node.match = field.value.split('|').map((entry) => entry.trim()).filter(Boolean);
    else if (name === 'name') {
      // Een bestaande categorie houdt haar indeling als de naam verandert: de oude naam wordt de webshopcategorie.
      if (!node._new && path.length > 1 && !node.match.length && node.name) node.match = [node.name];
      node.name = field.value;
    } else if (name === 'image') {
      node.image = field.value;
      const thumb = field.parentElement.querySelector('.sc-thumb');
      thumb.src = imageUrl(field.value);
      thumb.hidden = !field.value;
    } else node[name] = field.value;
  }

  /**
   * Koppelt de editor aan een element en tekent hem.
   * @param {Element} host Het element waarin de editor komt.
   * @param {{ view: object, api: Function, adopt: Function, toast: Function }} options view = de stand van Webshop-inhoud, api(pad, opties) = roept de API aan, adopt(view) = neemt een nieuwe stand over (adopt.current() geeft hem terug) en toast(tekst, isFout) = melding tonen.
   * @returns {void}
   */
  function mount(host, options) {
    state.view = options.view;
    state.api = options.api;
    state.adopt = options.adopt;
    state.toast = options.toast;
    state.host = host;
    // Niet-opgeslagen wijzigingen blijven staan zolang het tabblad open blijft; alleen de eerste keer wordt de boom geladen.
    if (!state.roots.length) state.roots = currentTree();
    host.onclick = onClick;
    host.oninput = onField;
    host.onchange = onField;
    render();
  }

  /**
   * Vergeet de bewerkbare boom (bij het opnieuw laden van de hele stand).
   * @returns {void}
   */
  function reset() {
    state.roots = [];
  }

  window.BeheerWebshopMenu = { mount, reset };
})();
