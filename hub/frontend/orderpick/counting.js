// Voorraad tellen in de orderpick-app: de teller kiest een locatie van de lopende telling, scant per artikel (of tikt het aan), vult het
// getelde aantal in en slaat het op. Het scherm is blind: er staat nooit een verwacht aantal of een prijs op. Elke ingave krijgt een eigen sleutel,
// zodat een herhaalde tik of verzending nooit dubbel telt; een artikel mag opnieuw geteld worden (de laatste telling geldt).
// Gegevens uit /api/orderpick/counts; de rekenregels staan in counting-core.js; de hulpmiddelen (melding, trillen, toon, camera) komen van orderpick.js.
(function () {
  const Core = window.CountingCore;
  const Ui = window.OrderpickUi;
  const { toast, vibrate, beep, esc } = Ui;

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);

  const SECTIONS = ['#op-list', '#op-order', '#op-done', '#rc-list', '#rc-order', '#rc-done', '#ct-list', '#ct-location'];
  const state = { count: null, location: null, lines: [], currentId: null, feedback: null, busy: false, run: 0, pendingKeys: {} };

  /**
   * Toont precies één scherm van de pagina en verbergt de rest.
   * @param {string} selector Het scherm, bijvoorbeeld '#ct-list'.
   */
  function show(selector) {
    for (const section of SECTIONS) { const element = $(section); if (element) element.hidden = section !== selector; }
  }

  /**
   * Zet de adresbalk op het tellen (zonder een nieuwe stap in de geschiedenis) en ververst de zijbalk.
   */
  function setAddress() {
    history.replaceState(null, '', `${location.pathname}#tellen`);
    if (window.AquatechNav && window.AquatechNav.refresh) window.AquatechNav.refresh();
  }

  // ---------- Zonder verbinding ----------
  /**
   * De ingaven van deze telling die nog op verbinding wachten (bewaard op dit toestel).
   * @returns {{ countId: string, lineId: string, qty: number, queueId: string, at: number }[]} De wachtende ingaven.
   */
  const waitingEntries = () => (Ui.readStored('counts_queued') || []).filter((entry) => !state.count || entry.countId === state.count.id);

  /**
   * Zet de ingaven die nog op verbinding wachten als geteld op de regels (de gecachte lijst kent ze nog niet).
   * @param {object[]} lines De regels van de locatie.
   * @returns {object[]} Dezelfde regels, de wachtende gemarkeerd met `queued`.
   */
  function applyWaiting(lines) {
    const waiting = waitingEntries();
    return lines.map((line) => {
      const entry = waiting.find((candidate) => candidate.lineId === line.id);
      return entry ? { ...line, status: 'geteld', countedQty: entry.qty, queued: true } : line;
    });
  }

  /**
   * Onthoudt een ingave die in de offline wachtrij staat.
   * @param {string} lineId Id van de regel.
   * @param {number} qty Het getelde aantal.
   * @param {string} queueId Id in de wachtrij.
   */
  function rememberWaiting(lineId, qty, queueId) {
    const others = (Ui.readStored('counts_queued') || []).filter((entry) => !(entry.countId === state.count.id && entry.lineId === lineId));
    Ui.writeStored('counts_queued', [...others, { countId: state.count.id, lineId, qty, queueId, at: Date.now() }]);
  }

  /**
   * Verwerkt een bericht van de offline wachtrij: een verstuurde (of weggegooide) ingave is niet langer wachtend en de regel krijgt zijn echte stand.
   * @param {{ discarded: boolean, id: string, item: { id: string, url: string }, body: object }} message Het bericht van de service worker.
   */
  function onQueueEvent(message) {
    const all = Ui.readStored('counts_queued') || [];
    if (!all.length) return;
    const queueId = message.discarded ? message.id : message.item && /\/count$/.test(message.item.url || '') ? message.item.id : null;
    if (!queueId || !all.some((entry) => entry.queueId === queueId)) return;
    const remaining = all.filter((entry) => entry.queueId !== queueId);
    Ui.writeStored('counts_queued', remaining.length ? remaining : null);
    if (!state.count || $('#ct-location').hidden) return;
    if (message.body && message.body.line) {
      // Verstuurd: de regel krijgt zijn echte stand van de server.
      const at = state.lines.findIndex((line) => line.id === message.body.line.id);
      if (at >= 0) state.lines[at] = message.body.line;
    } else {
      // Weggegooid: een regel die niet meer wacht, is weer open.
      const waiting = new Set(waitingEntries().map((entry) => entry.lineId));
      state.lines = state.lines.map((line) => (line.queued && !waiting.has(line.id) ? { ...line, status: 'open', countedQty: null, queued: false } : line));
    }
    renderLocation();
  }

  // ---------- Overzicht van de locaties ----------
  /** Toont de lijst met locaties van de lopende telling en laadt hem opnieuw. */
  function showList() {
    Ui.stopCamera();
    state.location = null;
    show('#ct-list');
    setAddress();
    loadList().catch((error) => toast(`Kan de telling niet laden: ${error.message}`, true));
  }

  /**
   * Haalt de lopende telling op en tekent de locaties.
   * @returns {Promise<void>}
   */
  async function loadList() {
    const out = await Ui.api('counts/open');
    state.count = out.count;
    renderLocations();
    // Alle locaties alvast ophalen, zodat tellen ook zonder verbinding door kan (hal zonder bereik).
    if (window.AquatechOffline && out.count) {
      window.AquatechOffline.prefetch(out.count.locations.map((entry) => `api/orderpick/counts/${encodeURIComponent(out.count.id)}/lines?location=${encodeURIComponent(entry.location)}`), '../');
    }
  }

  /** Tekent de locaties met hun voortgang (of een melding als er geen telling loopt). */
  function renderLocations() {
    const count = state.count;
    if (!count) {
      $('#ct-title').textContent = 'Voorraad tellen';
      $('#ct-note').textContent = 'Er loopt nu geen voorraadtelling. Een beheerder start die in Artikelen.';
      $('#ct-locations').innerHTML = '';
      return;
    }
    $('#ct-title').textContent = `Telling ${count.number}`;
    const waiting = waitingEntries().length;
    $('#ct-note').textContent = `Peildatum ${count.referenceDate}. Kies een locatie en tel wat je daar ziet: je ziet niet hoeveel er volgens de administratie ligt.${waiting ? ` ${waiting} ingave${waiting === 1 ? '' : 'n'} wacht${waiting === 1 ? '' : 'en'} op verbinding en word${waiting === 1 ? 't' : 'en'} daarna verstuurd.` : ''}`;
    $('#ct-locations').innerHTML = count.locations.map((entry, index) => {
      const open = entry.total - entry.counted;
      return `<button type="button" class="op-order" data-index="${esc(index)}">
        <span><b>${esc(Core.locationName(entry.location))}</b><span class="sub">${esc(entry.total)} artikel${entry.total === 1 ? '' : 'en'}</span></span>
        <span class="tags">
          <span class="pill">${esc(entry.counted)} van ${esc(entry.total)} geteld</span>
          ${entry.recount ? `<span class="pill">${esc(entry.recount)} hertellen</span>` : ''}
          ${open === 0 && !entry.recount ? '<span class="pill">Klaar</span>' : ''}
        </span>
      </button>`;
    }).join('');
  }

  // ---------- Een locatie tellen ----------
  /**
   * Opent een locatie: laadt de regels en zet de eerste die nog geteld moet worden open.
   * @param {string} locationText De locatie (leeg = geen locatie).
   * @returns {Promise<void>}
   */
  async function openLocation(locationText) {
    if (!state.count) return;
    const run = ++state.run;
    let out;
    try {
      out = await Ui.api(`counts/${encodeURIComponent(state.count.id)}/lines?location=${encodeURIComponent(locationText)}`);
    } catch (error) {
      toast(error.message, true);
      if (error.status === 404 || error.status === 409) showList();
      return;
    }
    if (run !== state.run) return;
    state.location = locationText;
    state.lines = applyWaiting(out.lines);
    const first = Core.nextOpenLine(state.lines);
    state.currentId = first ? first.id : null;
    state.feedback = null;
    show('#ct-location');
    $('#ct-location-title').textContent = Core.locationName(locationText);
    renderLocation();
    focusScan();
  }

  /** Zet de cursor in het scanveld (alleen op een toestel met een echte muis of toetsenbord, anders springt het schermtoetsenbord open). */
  function focusScan() {
    if (window.matchMedia && matchMedia('(pointer: fine)').matches) $('#ct-scan').focus();
  }

  /**
   * De regel waar het scherm nu over gaat.
   * @returns {object|null} De regel of null.
   */
  const currentLine = () => state.lines.find((line) => line.id === state.currentId) || null;

  /** Tekent de hele locatie: de open regel en de lijst met alle regels. */
  function renderLocation() {
    const total = Core.summarize(state.lines);
    $('#ct-location-meta').textContent = `${total.counted} van ${total.total} geteld${total.recount ? ` · ${total.recount} hertellen` : ''}`;
    renderCurrent();
    renderLines();
  }

  /** Tekent de regel die nu aan de beurt is met het invoerveld voor het getelde aantal. */
  function renderCurrent() {
    const box = $('#ct-current');
    const line = currentLine();
    if (!line) {
      box.className = 'op-current';
      box.innerHTML = `<p class="muted" style="margin:0">${state.lines.length ? 'Alles op deze locatie is geteld. Kies een andere locatie of tik een artikel hieronder aan om opnieuw te tellen.' : 'Er staan geen artikelen op deze locatie.'}</p>`;
      return;
    }
    const feedback = state.feedback;
    box.className = `op-current${feedback ? ` ${feedback.kind}` : line.status === 'geteld' ? ' ok' : ''}`;
    let text = 'Tel het artikel en vul het aantal in';
    let css = 'wait';
    if (feedback) { text = feedback.text; css = feedback.kind === 'ok' ? 'good' : 'error'; }
    else if (line.status === 'hertellen') { text = 'Tel dit artikel opnieuw'; css = 'error'; }
    else if (line.status === 'geteld') { text = `✓ Geteld: ${Core.parseQuantity(line.countedQty)}${line.unit ? ` ${line.unit}` : ''}. Je kunt het opnieuw invullen.`; css = 'good'; }
    box.innerHTML = `
      <span class="op-loc${line.location ? '' : ' none'}">${esc(Core.locationName(line.location))}</span>
      <div class="op-name">${esc(line.name)}</div>
      <div class="op-code">${esc(line.code)}${line.ean ? ` · ${esc(line.ean)}` : ''}</div>
      <p class="op-scanstate ${css}">${esc(text)}</p>
      ${(line.packagings || []).map((pack, index) => `<div class="op-qty">
        <input class="ct-pack" data-index="${index}" type="number" inputmode="numeric" min="0" step="1" value="" placeholder="Aantal" aria-label="Aantal ${esc(pack.name)}">
        <span class="of">× ${esc(pack.name)} (${esc(pack.factor)}${line.unit ? ` ${esc(line.unit)}` : ''})</span>
      </div>`).join('')}
      <div class="op-qty">
        <input id="ct-qty" type="number" inputmode="decimal" min="0" step="any" value="" placeholder="${(line.packagings || []).length ? 'Losse stuks' : 'Aantal'}" aria-label="Getelde hoeveelheid${line.unit ? ` (${esc(line.unit)})` : ''}">
        <span class="of">${esc(line.unit || '')}</span>
      </div>
      ${(line.packagings || []).length ? '<p class="muted" id="ct-total" style="margin:0 0 8px"></p>' : ''}
      <div class="op-actions">
        <button type="button" class="btn big primary" id="ct-save"${state.busy ? ' disabled' : ''}>Opslaan</button>
        <button type="button" class="btn big" id="ct-zero"${state.busy ? ' disabled' : ''}>Niets aanwezig (0)</button>
      </div>`;
    const input = $('#ct-qty');
    if (input && window.matchMedia && matchMedia('(pointer: fine)').matches && !feedback) input.focus();
  }

  /**
   * Leest de ingevulde verpakkingen en losse stuks van de open regel en rekent ze om naar één totaal.
   * @param {object} line De regel met zijn verpakkingen.
   * @returns {number|null} Het totaal, of null als er niets of iets ongeldigs is ingevuld.
   */
  function enteredTotal(line) {
    const packs = (line.packagings || []).map((pack, index) => {
      const field = document.querySelector(`.ct-pack[data-index="${index}"]`);
      return { factor: pack.factor, count: field ? field.value : '' };
    });
    const input = $('#ct-qty');
    return Core.totalOf(input && input.value, packs);
  }

  /** Toont het totaal van losse stuks en verpakkingen onder de invoer. */
  function showTotal() {
    const line = currentLine();
    const element = $('#ct-total');
    if (!line || !element) return;
    const total = enteredTotal(line);
    element.textContent = total === null ? '' : `Totaal: ${total}${line.unit ? ` ${line.unit}` : ''}`;
  }

  /** Tekent de lijst met alle regels van de locatie (tikken opent een regel). */
  function renderLines() {
    $('#ct-lines').innerHTML = state.lines.map((line) => {
      let mark = '○';
      let css = '';
      let right = '';
      if (line.status === 'geteld') { mark = '✓'; css = ' picked'; right = `${line.countedQty}${line.unit ? ` ${line.unit}` : ''}${line.queued ? ' · wacht op verbinding' : ''}`; }
      else if (line.status === 'hertellen') { mark = '↻'; css = ' absent'; right = 'hertellen'; }
      return `<button type="button" class="op-line${css}${line.id === state.currentId ? ' current' : ''}" data-id="${esc(line.id)}">
        <span class="mark">${mark}</span>
        <span class="main">${esc(line.name)}<span class="sub">${esc(line.code)}${line.ean ? ` · ${esc(line.ean)}` : ''}</span></span>
        <span class="qty">${esc(right)}</span>
      </button>`;
    }).join('');
  }

  /**
   * Verwerkt een scan: goed = groen en naar die regel, onbekend = rood met trillen.
   * @param {string} text De gescande of ingetypte code.
   */
  function handleScan(text) {
    if (!state.count || !String(text).trim()) return;
    const found = Core.findLine(state.lines, text);
    if (!found) {
      state.feedback = { kind: 'bad', text: `✗ Deze code hoort niet bij deze locatie (${String(text).trim()})` };
      vibrate([200, 80, 200]);
      beep(false);
      renderCurrent();
      return;
    }
    state.currentId = found.id;
    state.feedback = null;
    vibrate(40);
    beep(true);
    renderLocation();
  }

  // ---------- Opslaan ----------
  /**
   * Slaat het getelde aantal van de open regel op. Een mislukte verzending houdt dezelfde sleutel, dus opnieuw proberen telt nooit dubbel.
   * @param {number|null} fixed Een vast aantal (0 bij "Niets aanwezig"), of null om het ingevulde aantal te lezen.
   * @returns {Promise<void>}
   */
  async function save(fixed) {
    const line = currentLine();
    if (!line || state.busy || !state.count) return;
    const input = $('#ct-qty');
    const qty = fixed !== null ? fixed : (line.packagings || []).length ? enteredTotal(line) : Core.parseQuantity(input && input.value);
    if (qty === null) { toast('Vul het getelde aantal in (0 of meer).', true); if (input) input.focus(); return; }
    const key = `${line.id}:${qty}`;
    if (!state.pendingKeys[key]) state.pendingKeys[key] = Core.newClientId(window.crypto);
    state.busy = true;
    renderCurrent();
    try {
      const out = await Ui.api(`counts/${encodeURIComponent(state.count.id)}/lines/${encodeURIComponent(line.id)}/count`, { method: 'POST', body: Core.countBody(qty, state.pendingKeys[key]), offlineLabel: `Telling: ${line.name} geteld` });
      delete state.pendingKeys[key];
      const index = state.lines.findIndex((entry) => entry.id === line.id);
      if (out.queued) {
        // Zonder verbinding: de ingave staat in de wachtrij; de regel telt alvast als geteld.
        rememberWaiting(line.id, qty, out.id);
        if (index >= 0) state.lines[index] = { ...line, status: 'geteld', countedQty: qty, queued: true };
      } else if (index >= 0 && out.line) state.lines[index] = out.line;
      vibrate(40);
      beep(true);
      const next = Core.nextOpenLine(state.lines, line.id);
      state.currentId = next ? next.id : null;
      state.feedback = null;
    } catch (error) {
      if (error.code === 'closed' || error.status === 404) {
        toast(`${error.message} De lijst wordt ververst.`, true);
        state.busy = false;
        showList();
        return;
      }
      toast(error.message, true);
    } finally {
      state.busy = false;
    }
    if (!$('#ct-location').hidden) { renderLocation(); focusScan(); }
  }

  // ---------- Opstarten ----------
  /** Koppelt de knoppen en invoervelden (één keer, via delegatie op de vaste vakken). */
  function bind() {
    document.addEventListener('input', (event) => { if (event.target && event.target.classList && (event.target.classList.contains('ct-pack') || event.target.id === 'ct-qty')) showTotal(); });
    document.addEventListener('click', (event) => {
      const mode = event.target.closest && event.target.closest('.op-mode');
      if (mode && mode.dataset.mode === 'count' && $('#ct-list').hidden && $('#ct-location').hidden) showList();
    });
    // De zijbalk kan naar #tellen wijzen op dezelfde pagina: het scherm volgt de hash.
    window.addEventListener('hashchange', () => {
      if (location.hash === '#tellen' && $('#ct-list').hidden && $('#ct-location').hidden) showList();
    });
    $('#ct-refresh').addEventListener('click', () => loadList().catch((error) => toast(error.message, true)));
    $('#ct-locations').addEventListener('click', (event) => {
      const row = event.target.closest('[data-index]');
      const entry = row && state.count && state.count.locations[Number(row.dataset.index)];
      if (entry) openLocation(entry.location);
    });
    $('#ct-back').addEventListener('click', showList);
    $('#ct-scan').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      handleScan(value);
    });
    $('#ct-camera').addEventListener('click', () => Ui.startCamera(handleScan));
    $('#ct-current').addEventListener('click', (event) => {
      if (event.target.id === 'ct-save') save(null);
      else if (event.target.id === 'ct-zero') save(0);
    });
    $('#ct-current').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.target.id === 'ct-qty' || (event.target.classList && event.target.classList.contains('ct-pack')))) { event.preventDefault(); save(null); }
    });
    $('#ct-lines').addEventListener('click', (event) => {
      const row = event.target.closest('[data-id]');
      if (!row) return;
      state.currentId = row.dataset.id;
      state.feedback = null;
      renderLocation();
    });
    if ('BarcodeDetector' in window && navigator.mediaDevices) $('#ct-camera').hidden = false;
    window.AquatechCommon.onReturn(() => { if (!$('#ct-list').hidden) loadList().catch(() => {}); });
  }

  /**
   * Wacht tot orderpick.js klaar is, controleert het recht en opent zo nodig het telscherm (#tellen).
   * @returns {Promise<void>}
   */
  async function init() {
    await Ui.ready;
    if (!Ui.allowed) return;
    bind();
    if (window.AquatechOffline) window.AquatechOffline.on('synced', onQueueEvent);
    if (location.hash === '#tellen') showList();
  }

  init();
})();
