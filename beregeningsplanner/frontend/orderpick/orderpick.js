// Orderpick: het scherm voor het magazijn. Lijst met te picken bestellingen, per bestelling de regels op volgorde van
// magazijnlocatie, scannen (toetsenbord/scanner of camera) met groen of rood met trillen, aantal vooraf ingevuld, "Niet aanwezig"
// en "Order gepickt" (pakbon en verzendlabel erna). De stand van een bestelling in bewerking blijft op het toestel bewaard.
// Gegevens uit /api/orderpick; de rekenregels staan in orderpick-core.js.
(function () {
  const Core = window.OrderpickCore;

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  const RECENT_LIMIT = 10;
  const state = { owner: '', orders: [], order: null, states: {}, currentIndex: null, scanFeedback: null, busy: false, stream: null, cameraTimer: null };

  // ---------- Hulpjes ----------
  /**
   * Toont een korte melding onderin beeld.
   * @param {string} message De melding.
   * @param {boolean} [isError] true = rood.
   */
  function toast(message, isError = false) {
    const element = $('#op-toast');
    element.textContent = message;
    element.className = `op-toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'op-toast'; }, 3500);
  }

  /**
   * Roept de API aan (relatief vanaf orderpick/).
   * @param {string} path Pad onder api/orderpick/.
   * @param {{ method?: string, body?: object, blob?: boolean }} [options] Methode, JSON-inhoud en of er een PDF terugkomt.
   * @returns {Promise<object|Blob>} Het antwoord (een fout is een Error met `status` en `code`).
   */
  async function api(path, { method = 'GET', body, blob = false, offlineLabel } = {}) {
    const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
    // Zonder verbinding gaat een pick in de wachtrij van de service worker (antwoord 202 { queued }); nooit met een samenvoegsleutel, elke pick staat op zichzelf.
    if (offlineLabel && window.AquatechOffline) Object.assign(headers, window.AquatechOffline.headers({ label: offlineLabel }));
    // Een sleutel per pick-aanroep: wordt die na een netwerkfout opnieuw verstuurd, dan wordt er niet dubbel gepickt.
    if (path.endsWith('/pick') && window.crypto && crypto.randomUUID) headers['Idempotency-Key'] = crypto.randomUUID();
    const response = await fetch(`../api/orderpick/${path}`, { method, cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const out = await response.json().catch(() => ({}));
      throw Object.assign(new Error(out.message || window.AquatechCommon.statusMessage(response.status)), { status: response.status, code: out.error });
    }
    return blob ? response.blob() : response.json();
  }

  /**
   * Trilt kort (waar het toestel dat kan).
   * @param {number|number[]} pattern Duur in milliseconden, of een patroon van trillen en pauzes.
   */
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* trillen is een extraatje */ }
  }

  /**
   * Speelt een korte toon (hoog = goed, laag = fout), zodat het ook hoorbaar is in een lawaaiige hal.
   * @param {boolean} good true = goede scan.
   */
  function beep(good) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      beep.context = beep.context || new AudioContextClass();
      const oscillator = beep.context.createOscillator();
      const gain = beep.context.createGain();
      oscillator.frequency.value = good ? 880 : 220;
      gain.gain.value = 0.15;
      oscillator.connect(gain);
      gain.connect(beep.context.destination);
      oscillator.start();
      oscillator.stop(beep.context.currentTime + (good ? 0.09 : 0.3));
    } catch (_) { /* geluid is een extraatje */ }
  }

  // ---------- Bewaren op het toestel ----------
  /**
   * De sleutel waaronder gegevens van deze gebruiker op het toestel staan.
   * @param {string} name Naam van het onderdeel.
   * @returns {string} De sleutel.
   */
  const storageKey = (name) => `aquatech_orderpick_${name}:${state.owner}`;

  /**
   * Leest een bewaarde waarde (JSON) van dit toestel.
   * @param {string} name Naam van het onderdeel.
   * @returns {*} De waarde, of null als er niets (bruikbaars) staat.
   */
  function readStored(name) {
    try { return JSON.parse(localStorage.getItem(storageKey(name))); } catch (_) { return null; }
  }

  /**
   * Bewaart een waarde (JSON) op dit toestel; zonder waarde wordt de sleutel gewist.
   * @param {string} name Naam van het onderdeel.
   * @param {*} value De waarde (null = wissen).
   */
  function writeStored(name, value) {
    try {
      if (value === null) localStorage.removeItem(storageKey(name));
      else localStorage.setItem(storageKey(name), JSON.stringify(value));
    } catch (_) { /* opslag vol of geblokkeerd: het scherm werkt gewoon door */ }
  }

  /** Bewaart de stand van de bestelling in bewerking, zodat een herlaadbeurt of leeg scherm niets kost. */
  function saveProgress() {
    if (!state.order) return;
    writeStored('progress', { orderId: state.order.id, shipmentCount: state.order.shipmentCount, states: state.states, savedAt: Date.now() });
  }

  /**
   * Zet bewaarde voortgang terug als die bij precies deze bestelling en dezelfde zendingen hoort en geen dag oud is.
   * @param {object} order De bestelling.
   * @returns {Object<string, object>|null} De bewaarde stand, of null.
   */
  function restoreProgress(order) {
    const saved = readStored('progress');
    if (!saved || saved.orderId !== order.id || saved.shipmentCount !== order.shipmentCount || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return null;
    const restored = Core.initialStates(order);
    for (const line of Core.pickableLines(order)) {
      const old = saved.states && saved.states[line.index];
      if (old && (old.status === 'picked' || old.status === 'absent')) restored[line.index] = { status: old.status, qty: Core.clampQuantity(old.qty, line.ready), scanned: Boolean(old.scanned) };
    }
    return restored;
  }

  /**
   * Zet een afgemelde bestelling bovenaan de lijst "Net gepickt" (nodig voor de pakbon en het label achteraf).
   * @param {object} entry De bestelling met zending: { orderId, number, shipmentId, complete, pieces, at, label }.
   */
  function rememberDone(entry) {
    const list = (readStored('recent') || []).filter((old) => old.shipmentId !== entry.shipmentId);
    list.unshift(entry);
    writeStored('recent', list.slice(0, RECENT_LIMIT));
  }

  // ---------- Overzicht ----------
  /**
   * Haalt de te picken bestellingen op en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function loadList() {
    const out = await api('orders');
    let waiting = readStored('queued') || [];
    if (waiting.length && window.AquatechOffline) {
      // Een pick die niet meer wacht (verstuurd, weggegooid of door de server afgewezen) hoort niet langer verborgen te zijn: de bestelling staat dan weer in de lijst met wat de server nu zegt.
      const pending = new Set((await window.AquatechOffline.list()).filter((item) => item.state === 'pending').map((item) => item.id));
      const kept = waiting.filter((entry) => pending.has(entry.queueId));
      if (kept.length !== waiting.length) { waiting = kept; writeStored('queued', kept.length ? kept : null); }
    }
    // Een bestelling die offline is afgemeld maar nog niet verstuurd is, hoort niet nog eens in de lijst.
    out.items = out.items.filter((order) => !waiting.some((entry) => entry.orderId === order.id));
    state.orders = out.items;
    renderList(out);
    // Alvast ophalen, zodat de regels ook zonder verbinding openen.
    if (window.AquatechOffline) window.AquatechOffline.prefetch(out.items.slice(0, 30).map((order) => `api/orderpick/orders/${encodeURIComponent(order.id)}`), '../');
  }

  /**
   * Tekent de lijst met bestellingen en het blok "Net gepickt".
   * @param {{ items: object[], waitingForStock: number, truncated: boolean }} out Het antwoord van de lijst.
   */
  function renderList(out) {
    $('#op-orders').innerHTML = out.items.map((order) => `
      <button type="button" class="op-order" data-id="${esc(order.id)}">
        <span><b>${esc(order.number)}</b><span class="sub">${esc(when(order.createdAt))} · ${esc(order.shippingLabel || '')}</span></span>
        <span class="tags">
          <span class="pill">${order.lineCount} regel${order.lineCount === 1 ? '' : 's'} · ${esc(order.pieces)} stuks</span>
          ${order.pickup ? '<span class="pill">Afhalen</span>' : ''}${order.dropshipping ? '<span class="pill">Dropshipping</span>' : ''}${order.hadShipments ? '<span class="pill">Rest van een deellevering</span>' : ''}
        </span>
      </button>`).join('');
    $('#op-empty').hidden = out.items.length > 0;
    const notes = [];
    if (out.waitingForStock) notes.push(`${out.waitingForStock} bestelling${out.waitingForStock === 1 ? '' : 'en'} wacht${out.waitingForStock === 1 ? '' : 'en'} op voorraad.`);
    if (out.truncated) notes.push('Er zijn meer bestellingen dan hier staan.');
    $('#op-list-note').textContent = notes.join(' ');
    renderRecent();
  }

  /** Tekent "Net gepickt" met knoppen voor de pakbon en het label. */
  function renderRecent() {
    const recent = readStored('recent') || [];
    const queued = readStored('queued') || [];
    $('#op-queued').hidden = queued.length === 0;
    $('#op-queued').textContent = queued.length ? `Wacht op verbinding om te versturen: ${queued.map((entry) => entry.number).join(', ')}. Pakbon en label volgen daarna onder Net gepickt.` : '';
    $('#op-recent-block').hidden = recent.length === 0;
    $('#op-recent').innerHTML = recent.map((entry) => `
      <div class="op-recent-row" data-shipment="${esc(entry.shipmentId)}" data-order="${esc(entry.orderId)}">
        <span class="what"><b>${esc(entry.number)}</b><span class="sub" style="display:block;font-size:12px;color:var(--muted)">${esc(when(entry.at))} · ${esc(entry.pieces)} stuks · ${entry.complete ? 'alles verzonden' : 'deels, rest op backorder'}</span></span>
        <button type="button" class="btn" data-doc="packing-slip">Pakbon</button>
        ${entry.label && entry.label.required ? '<button type="button" class="btn" data-doc="label">Label</button>' : ''}
      </div>`).join('');
  }

  /** Toont alleen de lijst. */
  function showList() {
    stopCamera();
    state.order = null;
    $('#op-order').hidden = true;
    $('#op-done').hidden = true;
    $('#op-list').hidden = false;
    history.replaceState(null, '', location.pathname);
    loadList().catch((error) => toast(`Kan de bestellingen niet laden: ${error.message}`, true));
  }

  // ---------- Een bestelling picken ----------
  /**
   * Opent een bestelling om te picken (met eerder bewaarde voortgang).
   * @param {string} id Id van de bestelling.
   * @returns {Promise<void>}
   */
  async function openOrder(id) {
    try {
      const out = await api(`orders/${encodeURIComponent(id)}`);
      state.order = out.order;
    } catch (error) {
      toast(error.message, true);
      if (error.status === 404 || error.status === 409) loadList().catch(() => {});
      return;
    }
    state.states = restoreProgress(state.order) || Core.initialStates(state.order);
    const first = Core.nextOpenLine(state.order, state.states);
    state.currentIndex = first ? first.index : null;
    state.scanFeedback = null;
    $('#op-list').hidden = true;
    $('#op-done').hidden = true;
    $('#op-order').hidden = false;
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
    $('#op-title').textContent = state.order.number;
    $('#op-meta').textContent = [state.order.shippingLabel, state.order.pickup ? 'afhalen' : '', state.order.dropshipping ? 'dropshipping (eigen pakbon van de klant)' : ''].filter(Boolean).join(' · ');
    renderOrder();
    focusScan();
  }

  /** Zet de cursor in het scanveld (alleen op een toestel met een echte muis of toetsenbord, anders springt het schermtoetsenbord open). */
  function focusScan() {
    if (window.matchMedia && matchMedia('(pointer: fine)').matches) $('#op-scan').focus();
  }

  /**
   * De regel waar het scherm nu over gaat.
   * @returns {object|null} De regel of null.
   */
  function currentLine() {
    return state.order && state.currentIndex !== null ? state.order.lines.find((line) => line.index === state.currentIndex) || null : null;
  }

  /** Tekent de hele bestelling: de open regel, het afronden en de lijst met alle regels. */
  function renderOrder() {
    renderCurrent();
    renderFinish();
    renderLines();
    saveProgress();
  }

  /** Tekent de regel die nu aan de beurt is met scanstand, aantal en knoppen. */
  function renderCurrent() {
    const line = currentLine();
    const box = $('#op-current');
    const lineState = line ? state.states[line.index] : null;
    if (!line || !lineState) {
      box.className = 'op-current';
      box.innerHTML = '<p class="muted" style="margin:0">Alle regels zijn behandeld. Controleer hieronder en meld de order af.</p>';
      return;
    }
    const scanned = lineState.scanned;
    const feedback = state.scanFeedback;
    box.className = `op-current${feedback ? ` ${feedback.kind}` : scanned ? ' ok' : ''}`;
    let scanText = 'Scan het artikel';
    let scanClass = 'wait';
    if (feedback) { scanText = feedback.text; scanClass = feedback.kind === 'ok' ? 'good' : 'error'; }
    else if (scanned) { scanText = '✓ Gescand'; scanClass = 'good'; }
    else if (!line.scannable) { scanText = 'Van dit artikel is geen EAN of code bekend: bevestig het aantal met OK.'; }
    const canConfirm = scanned || !line.scannable;
    const backorderNote = line.backorder > 0 ? ` · ${esc(Core.quantityText(line, line.backorder))} nu niet leverbaar` : '';
    box.innerHTML = `
      <span class="op-loc${line.location ? '' : ' none'}">${esc(line.location || 'Geen locatie')}</span>
      <div class="op-name">${esc(line.name)}</div>
      <div class="op-code">${esc(line.code)}${line.packaging ? ` · verpakking ${esc(line.packaging.name || line.packaging.code)} (${esc(line.packaging.factor)} stuks)` : ''}</div>
      <p class="op-facts">Besteld ${esc(Core.quantityText(line, line.ordered))}${line.shipped ? ` · eerder geleverd ${esc(Core.quantityText(line, line.shipped))}` : ''}${backorderNote}</p>
      <p class="op-scanstate ${scanClass}">${esc(scanText)}</p>
      <div class="op-qty">
        <button type="button" class="btn" data-qty="-1" aria-label="Eén minder">−</button>
        <input id="op-qty" type="number" inputmode="decimal" min="0" max="${esc(line.ready)}" step="any" value="${esc(lineState.qty)}" aria-label="Gepickt aantal">
        <button type="button" class="btn" data-qty="1" aria-label="Eén meer">+</button>
        <span class="of">van ${esc(Core.quantityText(line, line.ready))}</span>
      </div>
      <div class="op-actions">
        <button type="button" class="btn big primary" id="op-ok"${canConfirm ? '' : ' disabled'}>OK</button>
        <button type="button" class="btn big danger" id="op-absent">Niet aanwezig</button>
        ${!canConfirm ? '<button type="button" class="op-link wide" id="op-manual">Barcode werkt niet? Bevestig zonder scan</button>' : ''}
      </div>`;
  }

  /** Tekent het blok onder de open regel: afmelden zodra alles behandeld is. */
  function renderFinish() {
    const box = $('#op-finish');
    const order = state.order;
    const check = Core.canFinish(order, state.states);
    const total = Core.summarize(order, state.states);
    if (total.open > 0) { box.innerHTML = ''; return; }
    const partialBlocked = total.short > 0 && order.allowPartial === false;
    const lines = [];
    lines.push(`<p><b>${esc(total.pieces)} stuks</b> gepickt${total.short ? `, <b>${esc(total.missingPieces)}</b> stuks gaan op backorder (${total.short} regel${total.short === 1 ? '' : 's'}).` : '.'}</p>`);
    if (partialBlocked) lines.push('<p class="warn">Deellevering is niet toegestaan voor deze bestelling. Pick alle regels volledig of vraag het kantoor.</p>');
    else if (!check.ok) lines.push(`<p class="warn">${esc(check.reason)}</p>`);
    box.innerHTML = `<div class="card">${lines.join('')}<button type="button" class="btn big primary" id="op-finish-button"${check.ok && !partialBlocked && !state.busy ? '' : ' disabled'}>Order gepickt</button></div>`;
  }

  /** Tekent de lijst met alle regels (tikken opent een regel). */
  function renderLines() {
    $('#op-lines').innerHTML = state.order.lines.map((line) => {
      const lineState = state.states[line.index];
      const waiting = !lineState;
      let mark = '○';
      let css = '';
      let right = Core.quantityText(line, line.ready);
      if (waiting) { mark = '⏳'; css = ' wait'; right = 'wacht op voorraad'; }
      else if (lineState.status === 'picked') { mark = '✓'; css = ' picked'; right = Core.quantityText(line, lineState.qty); }
      else if (lineState.status === 'absent') { mark = '✗'; css = ' absent'; right = 'niet aanwezig'; }
      return `<button type="button" class="op-line${css}${line.index === state.currentIndex ? ' current' : ''}" data-index="${esc(line.index)}"${waiting ? ' disabled' : ''}>
        <span class="mark">${mark}</span>
        <span class="main">${esc(line.name)}<span class="sub">${esc(line.location || 'geen locatie')} · ${esc(line.code)}</span></span>
        <span class="qty">${esc(right)}</span>
      </button>`;
    }).join('');
  }

  /**
   * Maakt een regel de open regel.
   * @param {number} index De regelindex.
   */
  function selectLine(index) {
    state.currentIndex = index;
    state.scanFeedback = null;
    renderOrder();
    focusScan();
  }

  /** Gaat naar de volgende regel die nog open staat (na een OK of "Niet aanwezig"). */
  function advance() {
    const next = Core.nextOpenLine(state.order, state.states, state.currentIndex);
    state.currentIndex = next ? next.index : null;
    state.scanFeedback = null;
    renderOrder();
    focusScan();
    if (!next) $('#op-finish').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Verwerkt een scan: goed = groen (en naar die regel), onbekend = rood met trillen.
   * @param {string} text De gescande of ingetypte code.
   */
  function handleScan(text) {
    if (!state.order || !text.trim()) return;
    const found = Core.findLine(Core.pickableLines(state.order), state.states, text, state.currentIndex);
    if (!found) {
      state.scanFeedback = { kind: 'bad', text: `✗ Deze code hoort niet bij deze bestelling (${text.trim()})` };
      vibrate([200, 80, 200]);
      beep(false);
      renderCurrent();
      return;
    }
    if (!found.open) {
      state.scanFeedback = { kind: 'bad', text: `✗ ${found.line.name} is al behandeld. Tik de regel hieronder aan om hem te wijzigen.` };
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
   * Zet het aantal van de open regel.
   * @param {number} quantity Het gewenste aantal (wordt binnen de grenzen gezet).
   */
  function setQuantity(quantity) {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    lineState.qty = Core.clampQuantity(quantity, line.ready);
    renderCurrent();
    saveProgress();
  }

  /** Bevestigt de open regel met het ingevulde aantal (0 = niet aanwezig). */
  function confirmLine() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    const input = $('#op-qty');
    if (input) lineState.qty = Core.clampQuantity(input.value, line.ready);
    lineState.status = lineState.qty > 0 ? 'picked' : 'absent';
    advance();
  }

  /** Zet de open regel op "niet aanwezig": niets gepickt, het hele aantal gaat op backorder. */
  function markAbsent() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState) return;
    lineState.status = 'absent';
    lineState.qty = 0;
    advance();
  }

  /** Neemt een eerder behandelde regel opnieuw open (om het aantal te wijzigen of weer te scannen). */
  function reopenLine() {
    const line = currentLine();
    const lineState = line && state.states[line.index];
    if (!lineState || lineState.status === 'pending') return;
    lineState.status = 'pending';
    if (lineState.qty <= 0) lineState.qty = line.ready;
  }

  // ---------- Afmelden ----------
  /**
   * Meldt de bestelling af en toont het eindscherm met pakbon en label.
   * @returns {Promise<void>}
   */
  async function finishOrder() {
    if (state.busy) return;
    const order = state.order;
    const check = Core.canFinish(order, state.states);
    if (!check.ok) { toast(check.reason, true); return; }
    state.busy = true;
    renderFinish();
    try {
      const result = await api(`orders/${encodeURIComponent(order.id)}/pick`, { method: 'POST', body: Core.pickBody(order, state.states), offlineLabel: `Orderpick ${order.number} gepickt` });
      writeStored('progress', null);
      if (result.queued) {
        const pieces = Core.pickBody(order, state.states).lines.reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);
        writeStored('queued', [...(readStored('queued') || []), { orderId: order.id, number: order.number, queueId: result.id, pieces }]);
        showQueued(order, pieces);
        return;
      }
      const pieces = result.shipment.lines.reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);
      rememberDone({ orderId: order.id, number: result.number, shipmentId: result.shipment.id, complete: result.complete, pieces, at: result.shipment.at, label: result.label });
      showDone(order, result, pieces);
    } catch (error) {
      if (error.code === 'changed' || error.code === 'not_pickable') {
        toast(`${error.message} De lijst wordt ververst.`, true);
        writeStored('progress', null);
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
   * Toont het eindscherm van een bestelling die zonder verbinding is afgemeld: ze wordt verstuurd zodra er weer verbinding is.
   * @param {object} order De bestelling zoals die gepickt is.
   * @param {number} pieces Het aantal gepickte stuks.
   */
  function showQueued(order, pieces) {
    state.order = null;
    $('#op-order').hidden = true;
    $('#op-list').hidden = true;
    const done = $('#op-done');
    done.hidden = false;
    done.className = 'op-done';
    done.innerHTML = `
      <h1>✓ ${esc(order.number)} opgeslagen</h1>
      <p>Er is geen verbinding. ${esc(pieces)} stuks worden verstuurd zodra je weer online bent; pakbon en label maak je daarna onder <b>Net gepickt</b>.</p>
      <div class="actions"><button type="button" class="btn big primary" id="op-next">Volgende order</button></div>`;
    history.replaceState(null, '', location.pathname);
  }

  /**
   * Verwerkt een bericht van de offline wachtrij: een verstuurde pick komt onder "Net gepickt", een weggegooide pick (of een afgewezen: dan toont het paneel de fout) komt weer in de lijst.
   * @param {{ discarded: boolean, id: string, item: { url: string }, status: number, body: object }} message Het bericht van de service worker.
   */
  function onQueueEvent(message) {
    const waiting = readStored('queued') || [];
    if (!waiting.length) return;
    if (message.discarded) {
      writeStored('queued', waiting.filter((entry) => entry.queueId !== message.id));
    } else if (message.item && /\/pick$/.test(message.item.url || '') && message.body && message.body.shipment) {
      const entry = waiting.find((candidate) => candidate.queueId === message.item.id);
      if (!entry) return;
      writeStored('queued', waiting.filter((candidate) => candidate !== entry));
      const result = message.body;
      rememberDone({ orderId: entry.orderId, number: result.number || entry.number, shipmentId: result.shipment.id, complete: result.complete, pieces: entry.pieces, at: result.shipment.at, label: result.label });
    } else {
      return;
    }
    if (!state.order && !$('#op-list').hidden) showList();
  }

  /**
   * Toont het eindscherm van een afgemelde bestelling.
   * @param {object} order De bestelling zoals die gepickt is.
   * @param {{ complete: boolean, number: string, shipment: { id: string }, label: { required: boolean, available: boolean } }} result Het antwoord van de pick-aanroep.
   * @param {number} pieces Het aantal gepickte stuks.
   */
  function showDone(order, result, pieces) {
    state.order = null;
    $('#op-order').hidden = true;
    $('#op-list').hidden = true;
    const done = $('#op-done');
    done.hidden = false;
    done.className = 'op-done';
    done.dataset.order = order.id;
    done.dataset.shipment = result.shipment.id;
    const labelBlock = !result.label.required ? ''
      : result.label.available ? '<button type="button" class="btn big" data-doc="label">Verzendlabel maken</button>'
        : '<p class="note">De DPD-koppeling is nog niet ingesteld: er kan nog geen verzendlabel worden gemaakt.</p>';
    done.innerHTML = `
      <h1>✓ ${esc(result.number)} gepickt</h1>
      <p>${esc(pieces)} stuks verzonden${result.complete ? ': de bestelling is volledig verzonden.' : '. De rest staat op backorder.'}</p>
      <div class="actions">
        <button type="button" class="btn big primary" data-doc="packing-slip">Pakbon maken</button>
        ${labelBlock}
        <button type="button" class="btn big" id="op-next">Volgende order</button>
      </div>
      <p class="err" id="op-done-error"></p>`;
    history.replaceState(null, '', location.pathname);
  }

  /**
   * Maakt een pakbon of label en toont de knop in een link naar de PDF (een nieuw tabblad openen na een wachttijd wordt door telefoons geblokkeerd).
   * @param {HTMLElement} button De knop waarop getikt is.
   * @param {string} orderId Id van de bestelling.
   * @param {string} shipmentId Id van de zending.
   * @param {string} kind `packing-slip` of `label`.
   * @returns {Promise<void>}
   */
  async function makeDocument(button, orderId, shipmentId, kind) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Bezig…';
    try {
      const pdf = await api(`orders/${encodeURIComponent(orderId)}/shipments/${encodeURIComponent(shipmentId)}/${kind}`, { method: 'POST', body: {}, blob: true });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(pdf);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = button.className;
      link.textContent = kind === 'label' ? 'Label openen' : 'Pakbon openen';
      link.style.textDecoration = 'none';
      link.style.textAlign = 'center';
      link.style.display = button.classList.contains('big') ? 'block' : 'inline-block';
      button.replaceWith(link);
      link.click();
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      const note = $('#op-done-error');
      if (note && !$('#op-done').hidden) note.textContent = error.message;
      toast(error.message, true);
    }
  }

  // ---------- Camera ----------
  /**
   * Opent de camera en leest streepjescodes met de ingebouwde BarcodeDetector (alleen waar de browser die heeft).
   * @returns {Promise<void>}
   */
  async function startCamera() {
    if (!('BarcodeDetector' in window)) { toast('Deze browser kan niet scannen met de camera. Gebruik een scanner of typ de code.', true); return; }
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'qr_code'] });
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const video = $('#op-video');
      video.srcObject = state.stream;
      await video.play();
      $('#op-camera-view').hidden = false;
      let lastCode = '';
      let lastAt = 0;
      state.cameraTimer = setInterval(async () => {
        try {
          const found = await detector.detect(video);
          if (!found.length) return;
          const code = found[0].rawValue;
          if (code === lastCode && Date.now() - lastAt < 1500) return;
          lastCode = code;
          lastAt = Date.now();
          stopCamera();
          handleScan(code);
        } catch (_) { /* een mislukt beeld: volgende poging */ }
      }, 250);
    } catch (error) {
      stopCamera();
      toast(error && error.name === 'NotAllowedError' ? 'Geef de app toestemming voor de camera om te scannen.' : 'De camera kon niet gestart worden.', true);
    }
  }

  /** Sluit de camera. */
  function stopCamera() {
    clearInterval(state.cameraTimer);
    state.cameraTimer = null;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    const view = $('#op-camera-view');
    if (view) view.hidden = true;
  }

  // ---------- Opstarten ----------
  /** Koppelt de knoppen en invoervelden (één keer, via delegatie op de vaste vakken). */
  function bind() {
    $('#op-refresh').addEventListener('click', () => loadList().catch((error) => toast(error.message, true)));
    $('#op-orders').addEventListener('click', (event) => {
      const row = event.target.closest('[data-id]');
      if (row) openOrder(row.dataset.id);
    });
    $('#op-recent').addEventListener('click', (event) => {
      const button = event.target.closest('[data-doc]');
      const row = event.target.closest('[data-shipment]');
      if (button && row) makeDocument(button, row.dataset.order, row.dataset.shipment, button.dataset.doc);
    });
    $('#op-back').addEventListener('click', showList);
    $('#op-scan').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      handleScan(value);
    });
    $('#op-camera').addEventListener('click', startCamera);
    $('#op-camera-close').addEventListener('click', stopCamera);
    $('#op-current').addEventListener('click', (event) => {
      const stepper = event.target.closest('[data-qty]');
      if (stepper) {
        const input = $('#op-qty');
        setQuantity((Number(input && input.value) || 0) + Number(stepper.dataset.qty));
      } else if (event.target.id === 'op-ok') confirmLine();
      else if (event.target.id === 'op-absent') markAbsent();
      else if (event.target.id === 'op-manual') {
        const line = currentLine();
        if (line && state.states[line.index]) { state.states[line.index].scanned = true; renderOrder(); }
      }
    });
    $('#op-current').addEventListener('change', (event) => {
      if (event.target.id === 'op-qty') setQuantity(event.target.value);
    });
    $('#op-finish').addEventListener('click', (event) => {
      if (event.target.id === 'op-finish-button') finishOrder();
    });
    $('#op-lines').addEventListener('click', (event) => {
      const row = event.target.closest('[data-index]');
      if (!row || row.disabled) return;
      state.currentIndex = Number(row.dataset.index);
      reopenLine();
      state.scanFeedback = null;
      renderOrder();
      focusScan();
    });
    $('#op-done').addEventListener('click', (event) => {
      const button = event.target.closest('[data-doc]');
      if (button) makeDocument(button, $('#op-done').dataset.order, $('#op-done').dataset.shipment, button.dataset.doc);
      else if (event.target.id === 'op-next') showList();
    });
    if (window.AquatechOffline) window.AquatechOffline.on('synced', onQueueEvent);
    if ('BarcodeDetector' in window && navigator.mediaDevices) $('#op-camera').hidden = false;
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  }

  /**
   * Controleert de login en het recht en toont de lijst (of met ?id= meteen de bestelling).
   * @returns {Promise<void>}
   */
  async function init() {
    const id = new URLSearchParams(location.search).get('id');
    const me = await window.AquatechAccount.load('../');
    if (!me.user || !(me.rights || []).includes('orderpick')) {
      const denied = $('#op-denied');
      denied.hidden = false;
      denied.innerHTML = me.user && me.user.kind !== 'gast' ? 'Orderpick is er voor medewerkers in het magazijn. Vraag de beheerder om de rol Picker.' : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    state.owner = window.AquatechCommon.ownerOf(me) || 'onbekend';
    bind();
    if (id) {
      await openOrder(id);
      if (state.order) return;
    }
    $('#op-list').hidden = false;
    await loadList().catch((error) => toast(`Kan de bestellingen niet laden: ${error.message}`, true));
    window.AquatechCommon.onReturn(() => { if (!$('#op-list').hidden) loadList().catch(() => {}); });
  }

  init();
})();
