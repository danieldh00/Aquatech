// Goederenontvangst in de orderpick-app: een bestelde inkooporder kiezen (of het ordernummer, de leveranciersreferentie of een artikel scannen),
// per regel het artikel scannen en het aantal bevestigen (aantal vooraf ingevuld, minder = deelontvangst, meer dan besteld alleen met bevestiging),
// daarna boeken. De voorraad stijgt en backorders van webshopbestellingen die nu kunnen worden verzonden komen weer in Te picken.
// Gegevens uit /api/orderpick/receipts; de rekenregels staan in receiving-core.js; de hulpmiddelen (melding, trillen, toon, camera) komen van orderpick.js.
(function () {
  const Core = window.ReceivingCore;
  const Ui = window.OrderpickUi;
  const { toast, vibrate, beep, esc, when } = Ui;

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);

  const SECTIONS = ['#op-list', '#op-order', '#op-done', '#rc-list', '#rc-order', '#rc-done'];
  const state = { orders: [], order: null, states: {}, currentIndex: null, scanFeedback: null, busy: false };

  // ---------- Schermen ----------
  /**
   * Toont precies één scherm van de pagina (picken of ontvangen) en verbergt de rest.
   * @param {string} selector Het scherm, bijvoorbeeld '#rc-list'.
   */
  function show(selector) {
    for (const section of SECTIONS) { const element = $(section); if (element) element.hidden = section !== selector; }
  }

  /**
   * Zet de adresbalk op het juiste scherm (zonder een nieuwe stap in de geschiedenis) en ververst de zijbalk.
   * @param {string} search De zoekopdracht, bijvoorbeeld '?ontvangst=abc' of ''.
   * @param {string} hash De hash, bijvoorbeeld '#ontvangst' of ''.
   */
  function setAddress(search, hash) {
    history.replaceState(null, '', `${location.pathname}${search}${hash}`);
    if (window.AquatechNav && window.AquatechNav.refresh) window.AquatechNav.refresh();
  }

  /**
   * Gaat naar de lijst om te picken (het gewone scherm van orderpick.js).
   */
  function toPicking() {
    Ui.stopCamera();
    state.order = null;
    setAddress('', '');
    Ui.showPickList();
  }

  // ---------- Bewaren op het toestel ----------
  /**
   * De sleutel waaronder de voortgang van deze gebruiker op het toestel staat.
   * @returns {string} De sleutel.
   */
  const storageKey = () => `aquatech_orderpick_receipt:${Ui.owner}`;

  /**
   * Een korte handtekening van wat er al ontvangen is: verandert er iets aan de order, dan klopt de bewaarde voortgang niet meer.
   * @param {{ lines: object[] }} order De order.
   * @returns {string} De handtekening.
   */
  const signatureOf = (order) => order.lines.map((line) => `${line.id}:${line.received}`).join('|');

  /** Bewaart de stand van de order in bewerking, zodat een herlaadbeurt of leeg scherm niets kost. */
  function saveProgress() {
    if (!state.order) return;
    try { localStorage.setItem(storageKey(), JSON.stringify({ orderId: state.order.id, signature: signatureOf(state.order), states: state.states, savedAt: Date.now() })); } catch (_) { /* opslag vol of geblokkeerd: het scherm werkt gewoon door */ }
  }

  /** Wist de bewaarde voortgang. */
  function clearProgress() {
    try { localStorage.removeItem(storageKey()); } catch (_) { /* niets te wissen */ }
  }

  /**
   * Zet bewaarde voortgang terug als die bij precies deze order en deze stand hoort en geen dag oud is.
   * @param {object} order De order.
   * @returns {Object<string, object>|null} De stand, of null.
   */
  function restoreProgress(order) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey())); } catch (_) { saved = null; }
    if (!saved || saved.orderId !== order.id || saved.signature !== signatureOf(order) || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return null;
    const restored = Core.initialStates(order);
    for (const line of Core.receivableLines(order)) {
      const old = saved.states && saved.states[line.index];
      if (old && (old.status === 'received' || old.status === 'skipped')) restored[line.index] = { status: old.status, qty: old.status === 'skipped' ? 0 : Core.clampQuantity(old.qty), scanned: Boolean(old.scanned) };
    }
    return restored;
  }

  // ---------- Overzicht ----------
  /**
   * Haalt de te ontvangen orders op en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function loadList() {
    const out = await Ui.api('receipts');
    state.orders = out.items;
    renderOrders(out.items, '');
  }

  /**
   * Tekent de lijst met orders.
   * @param {object[]} items De orders.
   * @param {string} note Een opmerking boven de lijst (bijvoorbeeld wat er gescand is).
   */
  function renderOrders(items, note) {
    $('#rc-orders').innerHTML = items.map((order) => `
      <button type="button" class="op-order" data-id="${esc(order.id)}">
        <span><b>${esc(order.number)}</b><span class="sub">${esc(order.supplierName)}${order.supplierReference ? ` · ${esc(order.supplierReference)}` : ''}${order.expectedDate ? ` · verwacht ${esc(order.expectedDate)}` : ''}</span></span>
        <span class="tags">
          <span class="pill">${esc(order.lineCount)} regel${order.lineCount === 1 ? '' : 's'} · ${esc(order.openQty)} te ontvangen</span>
          ${order.partial ? '<span class="pill">Deels ontvangen</span>' : ''}
        </span>
      </button>`).join('');
    $('#rc-empty').hidden = items.length > 0;
    $('#rc-list-note').textContent = note;
  }

  /** Toont de lijst met orders en laadt hem opnieuw. */
  function showList() {
    Ui.stopCamera();
    state.order = null;
    show('#rc-list');
    setAddress('', '#ontvangst');
    loadList().catch((error) => toast(`Kan de inkooporders niet laden: ${error.message}`, true));
  }

  /**
   * Verwerkt een scan in het zoekveld van de lijst: een ordernummer of referentie opent de order, een artikel toont de orders waar het nog op staat.
   * @param {string} text De gescande of ingetypte code.
   * @returns {Promise<void>}
   */
  async function handleLookup(text) {
    const code = String(text || '').trim();
    if (!code) return;
    try {
      const out = await Ui.api(`receipts/lookup?code=${encodeURIComponent(code)}`);
      if (!out.orders.length) {
        vibrate([200, 80, 200]);
        beep(false);
        toast(`Geen open inkooporder gevonden voor ${code}.`, true);
        return;
      }
      vibrate(40);
      beep(true);
      if (out.orders.length === 1) { await openOrder(out.orders[0].id, out.kind === 'article' ? code : ''); return; }
      renderOrders(out.orders, out.kind === 'article' ? `${out.orders.length} orders met dit artikel. Kies de order van de levering.` : `${out.orders.length} orders gevonden.`);
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- Een order ontvangen ----------
  /**
   * Opent een inkooporder om te ontvangen (met eerder bewaarde voortgang).
   * @param {string} id Id van de inkooporder.
   * @param {string} [firstScan] Een artikelcode die al gescand is om de order te vinden: die regel is meteen gescand.
   * @returns {Promise<void>}
   */
  async function openOrder(id, firstScan = '') {
    try {
      state.order = (await Ui.api(`receipts/${encodeURIComponent(id)}`)).order;
    } catch (error) {
      toast(error.message, true);
      if (error.status === 404 || error.status === 409) loadList().catch(() => {});
      return;
    }
    state.states = restoreProgress(state.order) || Core.initialStates(state.order);
    const first = Core.nextOpenLine(state.order, state.states);
    state.currentIndex = first ? first.index : null;
    state.scanFeedback = null;
    show('#rc-order');
    setAddress(`?ontvangst=${encodeURIComponent(id)}`, '');
    $('#rc-title').textContent = state.order.number;
    $('#rc-meta').textContent = [state.order.supplierName, state.order.supplierReference, state.order.expectedDate ? `verwacht ${state.order.expectedDate}` : ''].filter(Boolean).join(' · ');
    renderOrder();
    if (firstScan) handleScan(firstScan);
    focusScan();
  }

  /** Zet de cursor in het scanveld (alleen op een toestel met een echte muis of toetsenbord, anders springt het schermtoetsenbord open). */
  function focusScan() {
    if (window.matchMedia && matchMedia('(pointer: fine)').matches) $('#rc-scan').focus();
  }

  /**
   * De regel waar het scherm nu over gaat.
   * @returns {object|null} De regel (met `index`) of null.
   */
  function currentLine() {
    return state.order && state.currentIndex !== null ? Core.receivableLines(state.order).find((line) => line.index === state.currentIndex) || null : null;
  }

  /** Tekent de hele order: de open regel, het afronden en de lijst met alle regels. */
  function renderOrder() {
    renderCurrent();
    renderFinish();
    renderLines();
    saveProgress();
  }

  /**
   * De tekst voor een aantal dat hoger is dan wat er openstond.
   * @param {object} line De regel.
   * @param {number} quantity Het ingevulde aantal.
   * @returns {string} Het teveel met eenheid, of een lege tekst als het niet meer is dan besteld.
   */
  function overText(line, quantity) {
    return quantity > line.openQty ? Core.quantityText(line, Math.round((quantity - line.openQty) * 1000) / 1000) : '';
  }

  /** Tekent de regel die nu aan de beurt is met scanstand, aantal en knoppen. */
  function renderCurrent() {
    const line = currentLine();
    const box = $('#rc-current');
    const lineState = line ? state.states[line.index] : null;
    if (!line || !lineState) {
      box.className = 'op-current';
      box.innerHTML = `<p class="muted" style="margin:0">${Core.receivableLines(state.order).length ? 'Alle regels zijn behandeld. Controleer hieronder en boek de ontvangst.' : 'Deze order is helemaal ontvangen.'}</p>`;
      return;
    }
    const feedback = state.scanFeedback;
    box.className = `op-current${feedback ? ` ${feedback.kind}` : lineState.scanned ? ' ok' : ''}`;
    let scanText = 'Scan het artikel';
    let scanClass = 'wait';
    if (feedback) { scanText = feedback.text; scanClass = feedback.kind === 'ok' ? 'good' : 'error'; }
    else if (lineState.scanned) { scanText = '✓ Gescand'; scanClass = 'good'; }
    else if (!line.scannable) { scanText = 'Van dit artikel is geen EAN of code bekend: bevestig het aantal met OK.'; }
    const canConfirm = lineState.scanned || !line.scannable;
    const over = overText(line, lineState.qty);
    box.innerHTML = `
      <span class="op-loc${line.location ? '' : ' none'}">${esc(line.location || 'Geen locatie')}</span>
      <div class="op-name">${esc(line.name)}</div>
      <div class="op-code">${esc(line.code)}${line.supplierSku ? ` · leverancier ${esc(line.supplierSku)}` : ''}</div>
      <p class="op-facts">Besteld ${esc(Core.quantityText(line, line.ordered))}${line.received ? ` · eerder ontvangen ${esc(Core.quantityText(line, line.received))}` : ''}</p>
      <p class="op-scanstate ${scanClass}">${esc(scanText)}</p>
      <div class="op-qty">
        <button type="button" class="btn" data-qty="-1" aria-label="Eén minder">−</button>
        <input id="rc-qty" type="number" inputmode="decimal" min="0" step="any" value="${esc(lineState.qty)}" aria-label="Ontvangen aantal">
        <button type="button" class="btn" data-qty="1" aria-label="Eén meer">+</button>
        <span class="of">van ${esc(Core.quantityText(line, line.openQty))}</span>
      </div>
      <p class="op-over" id="rc-over"${over ? '' : ' hidden'}>${over ? `Let op: ${esc(over)} meer dan besteld.` : ''}</p>
      <div class="op-actions">
        <button type="button" class="btn big primary" id="rc-ok"${canConfirm ? '' : ' disabled'}>OK</button>
        <button type="button" class="btn big danger" id="rc-skip">Niet geleverd</button>
        ${!canConfirm ? '<button type="button" class="op-link wide" id="rc-manual">Barcode werkt niet? Bevestig zonder scan</button>' : ''}
      </div>`;
  }

  /** Tekent het blok onder de open regel: boeken zodra alles behandeld is. */
  function renderFinish() {
    const box = $('#rc-finish');
    const check = Core.canFinish(state.order, state.states);
    const total = Core.summarize(state.order, state.states);
    if (total.open > 0) { box.innerHTML = ''; return; }
    const lines = [`<p><b>${esc(total.pieces)} stuks</b> ontvangen${total.shortPieces ? `, <b>${esc(total.shortPieces)}</b> stuks moeten nog komen.` : '.'}</p>`];
    if (total.overLines) lines.push(`<p class="warn">Bij ${total.overLines} regel${total.overLines === 1 ? '' : 's'} is meer ontvangen dan besteld (${esc(total.overPieces)} stuks extra). Controleer dat voor je boekt.</p>`);
    if (!check.ok) lines.push(`<p class="warn">${esc(check.reason)}</p>`);
    box.innerHTML = `<div class="card">${lines.join('')}<button type="button" class="btn big primary" id="rc-finish-button"${check.ok && !state.busy ? '' : ' disabled'}>Ontvangst boeken</button></div>`;
  }

  /** Tekent de lijst met alle regels (tikken opent een regel). */
  function renderLines() {
    $('#rc-lines').innerHTML = state.order.lines.map((line, index) => {
      const lineState = state.states[index];
      let mark = '○';
      let css = '';
      let right = Core.quantityText(line, line.openQty);
      if (!lineState) { mark = '✓'; css = ' picked'; right = `ontvangen ${Core.quantityText(line, line.received)}`; }
      else if (lineState.status === 'received') { mark = '✓'; css = ' picked'; right = Core.quantityText(line, lineState.qty); }
      else if (lineState.status === 'skipped') { mark = '✗'; css = ' absent'; right = 'niet geleverd'; }
      return `<button type="button" class="op-line${css}${index === state.currentIndex ? ' current' : ''}" data-index="${esc(index)}"${lineState ? '' : ' disabled'}>
        <span class="mark">${mark}</span>
        <span class="main">${esc(line.name)}<span class="sub">${esc(line.location || 'geen locatie')} · ${esc(line.code)}</span></span>
        <span class="qty">${esc(right)}</span>
      </button>`;
    }).join('');
  }

  /** Gaat naar de volgende regel die nog open staat (na een OK of "Niet geleverd"). */
  function advance() {
    const next = Core.nextOpenLine(state.order, state.states, state.currentIndex);
    state.currentIndex = next ? next.index : null;
    state.scanFeedback = null;
    renderOrder();
    focusScan();
    if (!next) $('#rc-finish').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Verwerkt een scan: goed = groen (en naar die regel), onbekend = rood met trillen.
   * @param {string} text De gescande of ingetypte code.
   */
  function handleScan(text) {
    if (!state.order || !String(text).trim()) return;
    const found = Core.findLine(state.order, state.states, text, state.currentIndex);
    if (!found || !found.open) {
      state.scanFeedback = { kind: 'bad', text: found ? `✗ ${found.line.name} is al behandeld. Tik de regel hieronder aan om hem te wijzigen.` : `✗ Deze code hoort niet bij deze inkooporder (${String(text).trim()})` };
      vibrate([200, 80, 200]);
      beep(false);
      renderCurrent();
      return;
    }
    state.currentIndex = found.line.index;
    state.states[found.line.index].scanned = true;
    state.scanFeedback = null;
    vibrate(40);
    beep(true);
    renderOrder();
  }

  /**
   * Zet het aantal van de open regel. Het invoerveld zelf blijft staan tijdens het typen (anders valt een tik op OK weg).
   * @param {number} quantity Het gewenste aantal.
   * @param {boolean} [redraw] true = ook het veld opnieuw tekenen (bij de knoppen + en −).
   */
  function setQuantity(quantity, redraw = false) {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    lineState.qty = Core.clampQuantity(quantity);
    if (redraw) renderCurrent();
    else {
      const note = $('#rc-over');
      const over = overText(line, lineState.qty);
      if (note) { note.hidden = !over; note.textContent = over ? `Let op: ${over} meer dan besteld.` : ''; }
    }
    saveProgress();
  }

  /** Bevestigt de open regel met het ingevulde aantal (0 = niet geleverd). */
  function confirmLine() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    const input = $('#rc-qty');
    if (input) lineState.qty = Core.clampQuantity(input.value);
    lineState.status = lineState.qty > 0 ? 'received' : 'skipped';
    advance();
  }

  /** Zet de open regel op "niet geleverd": er komt niets binnen, de order blijft open voor een volgende levering. */
  function skipLine() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    lineState.status = 'skipped';
    lineState.qty = 0;
    advance();
  }

  /** Neemt een eerder behandelde regel opnieuw open (om het aantal te wijzigen of weer te scannen). */
  function reopenLine() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState || lineState.status === 'pending') return;
    lineState.status = 'pending';
    if (lineState.qty <= 0) lineState.qty = line.openQty;
  }

  // ---------- Boeken ----------
  /**
   * Boekt de ontvangst en toont het eindscherm.
   * @returns {Promise<void>}
   */
  async function finishReceipt() {
    if (state.busy) return;
    const order = state.order;
    const check = Core.canFinish(order, state.states);
    if (!check.ok) { toast(check.reason, true); return; }
    state.busy = true;
    renderFinish();
    try {
      const result = await Ui.api(`receipts/${encodeURIComponent(order.id)}/receive`, { method: 'POST', body: Core.receiveBody(order, state.states) });
      clearProgress();
      showDone(result);
    } catch (error) {
      if (error.code === 'changed' || error.code === 'not_receivable') {
        toast(`${error.message} De lijst wordt ververst.`, true);
        clearProgress();
        showList();
      } else {
        toast(error.message, true);
      }
    } finally {
      state.busy = false;
      if (state.order) renderFinish();
    }
  }

  /**
   * Toont het eindscherm van een geboekte ontvangst.
   * @param {{ number: string, complete: boolean, pieces: number, releasedOrders: number }} result Het antwoord van de server.
   */
  function showDone(result) {
    state.order = null;
    show('#rc-done');
    const done = $('#rc-done');
    done.className = 'op-done';
    const released = result.releasedOrders > 0
      ? `<p><b>${esc(result.releasedOrders)} webshopbestelling${result.releasedOrders === 1 ? '' : 'en'}</b> met een backorder ${result.releasedOrders === 1 ? 'kan' : 'kunnen'} nu worden verzonden en ${result.releasedOrders === 1 ? 'staat' : 'staan'} weer onder Picken.</p>` : '';
    done.innerHTML = `
      <h1>✓ ${esc(result.number)} ontvangen</h1>
      <p>${esc(result.pieces)} stuks ingeboekt in de voorraad${result.complete ? ': de inkooporder is volledig ontvangen.' : '. De rest van de order staat nog open.'}</p>
      ${released}
      <div class="actions">
        <button type="button" class="btn big primary" id="rc-next">Volgende ontvangst</button>
        ${result.releasedOrders > 0 ? '<button type="button" class="btn big" id="rc-to-pick">Naar picken</button>' : ''}
      </div>`;
    setAddress('', '#ontvangst');
  }

  // ---------- Opstarten ----------
  /** Koppelt de knoppen en invoervelden (één keer, via delegatie op de vaste vakken). */
  function bind() {
    document.addEventListener('click', (event) => {
      const mode = event.target.closest('.op-mode');
      if (!mode) return;
      if (mode.dataset.mode === 'receive' && $('#rc-list').hidden) showList();
      else if (mode.dataset.mode === 'pick' && $('#op-list').hidden) toPicking();
    });
    $('#rc-refresh').addEventListener('click', () => loadList().catch((error) => toast(error.message, true)));
    $('#rc-orders').addEventListener('click', (event) => {
      const row = event.target.closest('[data-id]');
      if (row) openOrder(row.dataset.id);
    });
    $('#rc-lookup').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      handleLookup(value);
    });
    $('#rc-back').addEventListener('click', showList);
    $('#rc-scan').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      handleScan(value);
    });
    $('#rc-lookup-camera').addEventListener('click', () => Ui.startCamera(handleLookup));
    $('#rc-camera').addEventListener('click', () => Ui.startCamera(handleScan));
    $('#rc-current').addEventListener('click', (event) => {
      const stepper = event.target.closest('[data-qty]');
      if (stepper) {
        const input = $('#rc-qty');
        setQuantity((Number(input && input.value) || 0) + Number(stepper.dataset.qty), true);
      } else if (event.target.id === 'rc-ok') confirmLine();
      else if (event.target.id === 'rc-skip') skipLine();
      else if (event.target.id === 'rc-manual') {
        const line = currentLine();
        if (line && state.states[line.index]) { state.states[line.index].scanned = true; renderOrder(); }
      }
    });
    $('#rc-current').addEventListener('input', (event) => {
      if (event.target.id === 'rc-qty') setQuantity(event.target.value);
    });
    $('#rc-finish').addEventListener('click', (event) => {
      if (event.target.id === 'rc-finish-button') finishReceipt();
    });
    $('#rc-lines').addEventListener('click', (event) => {
      const row = event.target.closest('[data-index]');
      if (!row || row.disabled) return;
      state.currentIndex = Number(row.dataset.index);
      reopenLine();
      state.scanFeedback = null;
      renderOrder();
      focusScan();
    });
    $('#rc-done').addEventListener('click', (event) => {
      if (event.target.id === 'rc-next') showList();
      else if (event.target.id === 'rc-to-pick') toPicking();
    });
    if ('BarcodeDetector' in window && navigator.mediaDevices) {
      $('#rc-camera').hidden = false;
      $('#rc-lookup-camera').hidden = false;
    }
    window.AquatechCommon.onReturn(() => { if (!$('#rc-list').hidden) loadList().catch(() => {}); });
  }

  /**
   * Wacht tot orderpick.js klaar is, controleert het recht en opent zo nodig het ontvangstscherm (#ontvangst of ?ontvangst=<order>).
   * @returns {Promise<void>}
   */
  async function init() {
    await Ui.ready;
    if (!Ui.allowed) return;
    bind();
    const orderId = new URLSearchParams(location.search).get('ontvangst');
    if (orderId) {
      await openOrder(orderId);
      if (state.order) return;
    }
    if (orderId || location.hash === '#ontvangst') showList();
  }

  init();
})();
