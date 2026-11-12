// Inkooporders (module Artikelen): het tabblad Inkooporders met de lijst, een order aanmaken of wijzigen
// zolang hij concept is, bestellen, een (deel)ontvangst boeken, afsluiten of annuleren, een order maken uit
// het bestelvoorstel en Excel (per order voor de leverancier, en de lijst met een overzicht per leverancier).
// Praat met /api/purchase-orders (recht 'voorraad'); de server rekent en controleert alles.
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null, getItems: null, workbook: null, save: null, stamp: null };
  const state = { orders: [], suppliers: [], order: null, lines: [], unmatched: [], imported: false };
  const STATUS_LABELS = { concept: 'Concept', besteld: 'Besteld', deels_ontvangen: 'Deels ontvangen', ontvangen: 'Ontvangen', geannuleerd: 'Geannuleerd' };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * Laadt de orders met het gekozen statusfilter en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function load() {
    const status = $('#po-status').value;
    const result = await context.api(`purchase-orders${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    state.orders = result.items;
    renderList();
  }

  /** Tekent de tabel met orders. */
  function renderList() {
    const { esc, nl, eur } = context;
    $('#po-table').innerHTML = state.orders.length ? `<thead><tr><th>Nummer</th><th>Leverancier</th><th>Status</th><th>Verwacht</th><th class="num">Regels</th><th class="num">Nog open</th><th class="num">Totaal</th><th></th></tr></thead>
      <tbody>${state.orders.map((order) => `<tr class="${order.status === 'geannuleerd' ? 'arch' : ''}">
        <td>${esc(order.number)}</td><td class="wrap">${esc(order.supplierName)}</td><td><span class="pill">${esc(STATUS_LABELS[order.status] || order.status)}</span></td>
        <td>${esc(order.expectedDate)}</td><td class="num">${order.lineCount}</td><td class="num">${nl(order.openQty)}</td><td class="num">${order.total == null ? '' : eur(order.total)}</td>
        <td class="num"><button class="btn small" type="button" data-open="${esc(order.id)}">Openen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Geen inkooporders.</td></tr></tbody>';
  }

  /**
   * Haalt de leveranciers (voor de keuzelijst) en de artikelcodes (voor het toevoegen van regels) op.
   * @returns {Promise<void>}
   */
  async function loadChoices() {
    const result = await context.api('suppliers');
    state.suppliers = result.items;
    const items = context.getItems().filter((item) => !item.hasVariants && !item.archived);
    $('#po-add-codes').innerHTML = items.map((item) => `<option value="${context.esc(item.code)}">${context.esc(item.name)}</option>`).join('');
  }

  /**
   * Opent het formulier voor een nieuwe order of een bestaande.
   * @param {object|null} order De order om te tonen, of null voor een nieuwe.
   * @returns {Promise<void>}
   */
  async function openForm(order) {
    await loadChoices();
    const form = $('#order-form');
    state.order = order;
    state.lines = order ? order.lines.map((line) => ({ ...line })) : [];
    state.unmatched = [];
    state.imported = false;
    form.reset();
    form.supplierReference.value = order ? order.supplierReference || '' : '';
    $('h3', form).textContent = order ? `Inkooporder ${order.number} (${STATUS_LABELS[order.status] || order.status})` : 'Nieuwe inkooporder';
    const choices = state.suppliers.filter((supplier) => !supplier.archived || (order && supplier.id === order.supplierId));
    form.supplierId.innerHTML = `<option value="">Kies een leverancier…</option>${choices.map((supplier) => `<option value="${context.esc(supplier.id)}">${context.esc(supplier.name)}</option>`).join('')}`;
    form.supplierId.value = order ? order.supplierId : '';
    form.expectedDate.value = order ? order.expectedDate : '';
    form.notes.value = order ? order.notes : '';
    $('.err', form).textContent = '';
    renderLines();
    form.hidden = false;
    form.scrollIntoView({ block: 'nearest' });
  }

  /** Tekent de regels en zet de knoppen die bij de status passen aan of uit. */
  function renderLines() {
    const { esc, nl, eur } = context;
    const form = $('#order-form');
    const status = state.order ? state.order.status : 'concept';
    const editable = status === 'concept';
    const receiving = status === 'besteld' || status === 'deels_ontvangen';
    form.supplierId.disabled = !editable;
    form.expectedDate.disabled = !editable;
    form.notes.disabled = !editable;
    form.supplierReference.disabled = !editable;
    $('#po-remember-row').hidden = !(editable && state.imported);
    $('[data-act=receivenow]', form).hidden = !(editable && !state.order);
    renderUnmatched();
    $('#po-add-row').hidden = !editable;
    const show = { save: editable, receivenow: editable && !state.order, place: editable && Boolean(state.order), receive: receiving, excel: Boolean(state.order), close: status === 'deels_ontvangen', cancel: status === 'concept' ? false : status === 'besteld', remove: editable && Boolean(state.order) };
    for (const [action, visible] of Object.entries(show)) $(`[data-act=${action}]`, form).hidden = !visible;
    $('#po-add-row').hidden = !editable;
    const head = receiving || !editable
      ? '<th>Code</th><th>Omschrijving</th><th>Art.nr. leverancier</th><th class="num">Besteld</th><th class="num">Ontvangen</th><th class="num">Nog open</th><th class="num">Prijs</th>' + (receiving ? '<th class="num">Nu ontvangen</th>' : '')
      : '<th>Code</th><th>Omschrijving</th><th>Art.nr. leverancier</th><th class="num">Aantal</th><th class="num">Inkoopprijs (€)</th><th></th>';
    const rows = state.lines.map((line, index) => {
      if (editable) {
        return `<tr data-line="${index}"><td>${esc(line.code)}</td><td class="wrap">${esc(line.name)}</td><td>${esc(line.supplierSku)}</td>
          <td class="num"><input data-field="qty" type="number" min="0" step="any" inputmode="decimal" value="${line.qty}" aria-label="Aantal"></td>
          <td class="num"><input data-field="unitCost" type="number" min="0" step="0.0001" inputmode="decimal" value="${line.unitCost == null ? '' : line.unitCost}" placeholder="standaard" aria-label="Inkoopprijs"></td>
          <td class="num"><button class="btn small danger" type="button" data-drop="${index}">Weghalen</button></td></tr>`;
      }
      return `<tr data-line="${index}"><td>${esc(line.code)}</td><td class="wrap">${esc(line.name)}</td><td>${esc(line.supplierSku)}</td>
        <td class="num">${nl(line.qty)} ${esc(line.unit)}</td><td class="num">${nl(line.receivedQty)}</td><td class="num">${nl(line.openQty)}</td><td class="num">${line.unitCost == null ? '' : eur(line.unitCost)}</td>
        ${receiving ? `<td class="num"><input data-field="receive" type="number" min="0" step="any" inputmode="decimal" value="${line.openQty || ''}" aria-label="Nu ontvangen"></td>` : ''}</tr>`;
    });
    $('#po-lines').innerHTML = state.lines.length ? `<thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody>` : '<tbody><tr><td class="muted">Nog geen regels.</td></tr></tbody>';
  }

  /** Neemt aantallen en prijzen uit de tabel over in de regels (voor weghalen of toevoegen). */
  function readLines() {
    document.querySelectorAll('#po-lines tr[data-line]').forEach((row) => {
      const line = state.lines[Number(row.dataset.line)];
      const qty = row.querySelector('[data-field=qty]');
      const cost = row.querySelector('[data-field=unitCost]');
      if (qty) line.qty = qty.value;
      if (cost) line.unitCost = cost.value;
    });
  }

  /**
   * De invoer van het formulier zoals de server hem verwacht.
   * @returns {object} supplierId, expectedDate, notes en lines.
   */
  function bodyOf() {
    const form = $('#order-form');
    readLines();
    return {
      supplierId: form.supplierId.value, expectedDate: form.expectedDate.value, notes: form.notes.value, supplierReference: form.supplierReference.value,
      rememberSkus: state.imported && form.rememberSkus.checked,
      lines: state.lines.map((line) => ({ itemId: line.itemId, qty: line.qty, unitCost: line.unitCost, supplierSku: line.supplierSku || '' })),
    };
  }

  /**
   * Voert een actie op de order uit en toont de uitkomst in het formulier en de lijst.
   * @param {string} message Wat er na gelukt melden.
   * @param {Function} action Haalt de bijgewerkte order op (of null als het formulier dicht moet).
   * @returns {Promise<void>}
   */
  async function run(message, action) {
    const form = $('#order-form');
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      const order = await action();
      await load();
      if (order) await openForm(order); else form.hidden = true;
      context.toast(message);
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      for (const button of form.querySelectorAll('button')) button.disabled = false;
    }
  }

  /**
   * Bewaart de order (nieuw of wijziging van een concept).
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submitForm(event) {
    event.preventDefault();
    const body = bodyOf();
    await run('Inkooporder bewaard', () => (state.order
      ? context.api(`purchase-orders/${encodeURIComponent(state.order.id)}`, { method: 'PUT', body })
      : context.api('purchase-orders', { method: 'POST', body })));
  }

  /**
   * Zet het concept (eerst bewaard met de ingevulde regels) op besteld.
   * @returns {Promise<void>}
   */
  async function place() {
    const body = bodyOf();
    await run('Inkooporder besteld', async () => {
      await context.api(`purchase-orders/${encodeURIComponent(state.order.id)}`, { method: 'PUT', body });
      return context.api(`purchase-orders/${encodeURIComponent(state.order.id)}/place`, { method: 'POST' });
    });
  }

  /**
   * Boekt de ingevulde ontvangen aantallen in de voorraad.
   * @returns {Promise<void>}
   */
  async function receive() {
    const entries = [];
    document.querySelectorAll('#po-lines tr[data-line]').forEach((row) => {
      const input = row.querySelector('[data-field=receive]');
      const qty = input ? Number(input.value) : 0;
      if (qty > 0) entries.push({ lineId: state.lines[Number(row.dataset.line)].id, qty });
    });
    if (!entries.length) { $('#order-form .err').textContent = 'Vul bij minstens één regel in wat er is ontvangen.'; return; }
    await run('Ontvangst geboekt, de voorraad is bijgewerkt', () => context.api(`purchase-orders/${encodeURIComponent(state.order.id)}/receive`, { method: 'POST', body: { lines: entries } }));
  }

  /**
   * Maakt per voorkeursleverancier een concept-order van het bestelvoorstel.
   * @returns {Promise<void>}
   */
  async function fromProposal() {
    const button = $('#b-po-proposal');
    button.disabled = true;
    try {
      const result = await context.api('purchase-orders/from-proposal', { method: 'POST' });
      await load();
      if (context.afterProposal) context.afterProposal();
      const skipped = result.skipped ? ` ${result.skipped} artikel${result.skipped === 1 ? '' : 'en'} zonder voorkeursleverancier blijven buiten beeld.` : '';
      context.toast(result.orders.length ? `${result.orders.length} concept-order${result.orders.length === 1 ? '' : 's'} gemaakt.${skipped}` : `Niets te bestellen.${skipped}`);
    } catch (error) {
      context.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  /** Tekent de regels uit het document die nog niet aan een artikel zijn gekoppeld. */
  function renderUnmatched() {
    const { esc, nl } = context;
    const box = $('#po-unmatched');
    box.hidden = !state.unmatched.length;
    if (!state.unmatched.length) return;
    $('#po-unmatched-note').textContent = `${state.unmatched.length} regel${state.unmatched.length === 1 ? '' : 's'} uit het document ${state.unmatched.length === 1 ? 'is' : 'zijn'} nog niet gekoppeld en ${state.unmatched.length === 1 ? 'komt' : 'komen'} niet op de order. Kies een artikelcode of laat de regel weg.`;
    $('#po-unmatched-table').innerHTML = `<thead><tr><th>Art.nr.</th><th>Omschrijving</th><th class="num">Aantal</th><th>Artikelcode</th><th></th></tr></thead><tbody>${state.unmatched.map((row, index) => `<tr data-un="${index}">
      <td>${esc(row.supplierSku)}</td><td class="wrap">${esc(row.description)}${row.unitNote ? `<br><span class="err">${esc(row.unitNote)} Controleer het aantal en de prijs.</span>` : ''}${row.suggestions.length ? `<br><span class="muted">Misschien: ${row.suggestions.map((hint) => esc(hint.code)).join(', ')}</span>` : ''}</td><td class="num">${nl(row.qty)} ${esc(row.unit)}</td>
      <td><input data-field="code" list="po-add-codes" value="${esc(row.suggestions[0] ? row.suggestions[0].code : '')}" autocomplete="off" aria-label="Artikelcode"></td>
      <td class="num"><button class="btn small" type="button" data-link="${index}">Koppelen</button> <button class="btn small danger" type="button" data-skip="${index}">Weglaten</button></td></tr>`).join('')}</tbody>`;
  }

  /**
   * Geeft een melding als de eenheid op het document afwijkt van die van het artikel.
   * @param {object} row De gelezen regel.
   * @param {object} item Het artikel.
   * @returns {string} De melding, of leeg als de eenheid klopt of ontbreekt.
   */
  function unitMismatch(row, item) {
    const documentUnit = String(row.unit || '').trim().toLowerCase();
    if (!documentUnit || documentUnit === String(item.unit || '').trim().toLowerCase()) return '';
    return `Eenheid op het document (${row.unit}) wijkt af van het artikel (${item.unit}).`;
  }

  /**
   * Zet een gelezen regel op de order als het artikel er nog niet op staat.
   * @param {object} row De gelezen regel (qty, unitPrice, supplierSku).
   * @param {object} item Het artikel.
   * @returns {boolean} false als het artikel al op de order staat.
   */
  function addImported(row, item) {
    if (state.lines.some((line) => line.itemId === item.id)) return false;
    state.lines.push({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, supplierSku: row.supplierSku, qty: row.qty, unitCost: row.unitPrice == null ? '' : row.unitPrice });
    return true;
  }

  /**
   * Koppelt een niet-gekoppelde regel aan de ingevulde artikelcode of laat hem weg.
   * @param {MouseEvent} event de klik
   */
  function resolveUnmatched(event) {
    const link = event.target.closest('[data-link]');
    const skip = event.target.closest('[data-skip]');
    if (!link && !skip) return;
    readLines();
    const index = Number((link || skip).dataset.link ?? (link || skip).dataset.skip);
    const errorBox = $('#order-form .err');
    errorBox.textContent = '';
    if (link) {
      const code = $(`tr[data-un="${index}"] [data-field=code]`).value.trim().toLowerCase();
      const item = context.getItems().find((candidate) => candidate.code.toLowerCase() === code && !candidate.hasVariants && !candidate.archived);
      if (!item) { errorBox.textContent = 'Kies een bestaande artikelcode (geen hoofdartikel).'; return; }
      if (!addImported(state.unmatched[index], item)) { errorBox.textContent = 'Dit artikel staat al op de order.'; return; }
    }
    state.unmatched.splice(index, 1);
    renderLines();
  }

  /**
   * Leest een bestand als data-URL (base64).
   * @param {File} file Het bestand.
   * @returns {Promise<string>} De data-URL.
   */
  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(new Error('Het bestand kon niet worden gelezen.')));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Leest het gekozen bestand met AI en opent de uitkomst als nieuwe order om te controleren.
   * @param {File} file De PDF of foto.
   * @returns {Promise<void>}
   */
  async function readDocument(file) {
    const button = $('#b-po-read');
    if (file.size > 8 * 1024 * 1024) { context.toast('Het bestand is groter dan 8 MB.', true); return; }
    // Een geopend formulier met regels wordt vervangen: alleen dan vragen, want anders gaat er niets verloren.
    if (!$('#order-form').hidden && state.lines.length && !window.confirm('Het geopende formulier wordt vervangen door het ingelezen document. Wat niet is bewaard gaat verloren. Doorgaan?')) return;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Bezig met lezen…';
    try {
      const dataUrl = await fileAsDataUrl(file);
      const result = await context.api('purchase-orders/read', { method: 'POST', body: { file: dataUrl } });
      await openForm(null);
      const form = $('#order-form');
      state.imported = true;
      form.supplierId.value = result.supplier ? result.supplier.id : '';
      form.supplierReference.value = result.documentNumber || '';
      form.notes.value = [result.documentType !== 'overig' ? `Ingelezen ${result.documentType}${result.documentDate ? ` van ${result.documentDate}` : ''}` : '', result.notes].filter(Boolean).join('. ');
      const items = new Map(context.getItems().map((item) => [item.id, item]));
      for (const row of result.lines) {
        const item = row.match && row.match.itemId ? items.get(row.match.itemId) : null;
        // Alleen wat op nummer, code of exacte omschrijving klopt komt vanzelf op de order; een gok op gelijkenis bevestigt de gebruiker zelf (Koppelen).
        const mismatch = item ? unitMismatch(row, item) : '';
        if (item && row.match.sure && !mismatch && addImported(row, item)) continue;
        state.unmatched.push({ ...row, unitNote: mismatch, suggestions: row.match && row.match.itemId ? [{ code: row.match.itemCode }] : (row.match ? row.match.suggestions : []) });
      }
      renderLines();
      const names = result.supplier ? '' : ` Leverancier "${result.supplierName || 'onbekend'}" is niet herkend: kies hem hierboven.`;
      $('#order-form .err').textContent = `${state.lines.length} van ${result.lines.length} regels gekoppeld.${names} Controleer alles voor je bewaart.`;
    } catch (error) {
      context.toast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /**
   * Maakt de order en boekt hem meteen in (de goederen zijn al binnen, bijvoorbeeld bij een pakbon).
   * @returns {Promise<void>}
   */
  async function receiveNow() {
    const body = { ...bodyOf(), receiveNow: true };
    if (!body.lines.length) { $('#order-form .err').textContent = 'Er staan geen regels op de order.'; return; }
    // Een prijs die niet op het document stond raden we niet: de ontvangst zou er een kostprijs aan overhouden.
    if (body.lines.some((line) => line.unitCost === '' || line.unitCost == null)) {
      $('#order-form .err').textContent = 'Vul bij elke regel de inkoopprijs in voordat je inboekt (staat er geen prijs op het document, dan kun je het ook eerst als concept bewaren).';
      return;
    }
    await run('Order aangemaakt en ingeboekt, de voorraad is bijgewerkt', () => context.api('purchase-orders', { method: 'POST', body }));
  }

  /**
   * Excel met de regels van de order, om aan de leverancier te sturen.
   * @returns {Promise<void>}
   */
  async function exportOrder() {
    const order = state.order;
    const excelWorkbook = await context.workbook();
    if (!excelWorkbook) return;
    const sheet = excelWorkbook.addWorksheet(order.number.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Art.nr. leverancier', key: 'supplierSku', width: 20 },
      { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Omschrijving', key: 'name', width: 44 },
      { header: 'Aantal', key: 'qty', width: 11, style: { numFmt: '#,##0.###' } },
      { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Prijs', key: 'unitCost', width: 12, style: { numFmt: '€ #,##0.00##' } },
      { header: 'Bedrag', key: 'amount', width: 12, style: { numFmt: '€ #,##0.00' } },
    ];
    for (const line of order.lines) sheet.addRow(line);
    sheet.addRow({ name: `Totaal ${order.number} - ${order.supplierName}`, amount: order.total }).font = { bold: true };
    sheet.getRow(1).font = { bold: true };
    await context.save(excelWorkbook, `${order.number}-${context.stamp()}.xlsx`);
  }

  /**
   * Excel met de getoonde orders en een overzicht per leverancier (aantal orders, totaal en nog open).
   * @returns {Promise<void>}
   */
  async function exportList() {
    if (!state.orders.length) { context.toast('Geen inkooporders om te exporteren.'); return; }
    const excelWorkbook = await context.workbook();
    if (!excelWorkbook) return;
    const euro = { numFmt: '€ #,##0.00' };
    const sheet = excelWorkbook.addWorksheet('Inkooporders', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Nummer', key: 'number', width: 16 },
      { header: 'Leverancier', key: 'supplierName', width: 28 },
      { header: 'Status', key: 'statusLabel', width: 16 },
      { header: 'Besteld op', key: 'orderedAt', width: 14, style: { numFmt: 'dd-mm-yyyy' } },
      { header: 'Verwacht', key: 'expectedDate', width: 14 },
      { header: 'Regels', key: 'lineCount', width: 9 },
      { header: 'Nog open (aantal)', key: 'openQty', width: 16, style: { numFmt: '#,##0.###' } },
      { header: 'Totaal', key: 'total', width: 13, style: euro },
    ];
    for (const order of state.orders) sheet.addRow({ ...order, statusLabel: STATUS_LABELS[order.status] || order.status, orderedAt: order.orderedAt ? new Date(order.orderedAt) : null });
    sheet.getRow(1).font = { bold: true };
    const perSupplier = new Map();
    for (const order of state.orders) {
      const row = perSupplier.get(order.supplierId) || { supplierName: order.supplierName, orders: 0, total: null, openQty: 0 };
      row.orders += 1;
      row.openQty += order.openQty;
      if (order.total != null) row.total = (row.total || 0) + order.total;
      perSupplier.set(order.supplierId, row);
    }
    const summary = excelWorkbook.addWorksheet('Per leverancier', { views: [{ state: 'frozen', ySplit: 1 }] });
    summary.columns = [
      { header: 'Leverancier', key: 'supplierName', width: 28 },
      { header: 'Orders', key: 'orders', width: 10 },
      { header: 'Totaal', key: 'total', width: 13, style: euro },
      { header: 'Nog open (aantal)', key: 'openQty', width: 16, style: { numFmt: '#,##0.###' } },
    ];
    for (const row of [...perSupplier.values()].sort((left, right) => left.supplierName.localeCompare(right.supplierName, 'nl'))) summary.addRow(row);
    summary.getRow(1).font = { bold: true };
    await context.save(excelWorkbook, `inkooporders-${context.stamp()}.xlsx`);
  }

  /**
   * Stuurt een actie op de geopende order naar de server.
   * @param {string} action De actie in het adres (close of cancel).
   * @param {string} message Wat er na gelukt melden.
   * @returns {Promise<void>}
   */
  function orderAction(action, message) {
    return run(message, () => context.api(`purchase-orders/${encodeURIComponent(state.order.id)}/${action}`, { method: 'POST' }));
  }

  /**
   * Sluit een deels ontvangen order af: wat nog niet is geleverd vervalt.
   * @returns {Promise<void>}
   */
  function closeOrder() { return orderAction('close', 'Order afgesloten'); }

  /**
   * Annuleert een bestelde order die nog niets heeft ontvangen.
   * @returns {Promise<void>}
   */
  function cancelOrder() { return orderAction('cancel', 'Order geannuleerd'); }

  /**
   * Gooit het concept weg.
   * @returns {Promise<void>}
   */
  function removeOrder() {
    return run('Concept weggegooid', async () => {
      await context.api(`purchase-orders/${encodeURIComponent(state.order.id)}`, { method: 'DELETE' });
      return null;
    });
  }

  /** Sluit het formulier zonder iets te bewaren. */
  function hideForm() { $('#order-form').hidden = true; }

  /**
   * Koppelt de knoppen en formulieren.
   * @param {{ api: Function, toast: Function, esc: Function, nl: Function, eur: Function, getItems: Function, workbook: Function, save: Function, stamp: Function }} options Hulpfuncties van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    const form = $('#order-form');
    /** Opent het formulier voor een nieuwe order. */
    $('#b-po-new').onclick = () => { openForm(null).catch((error) => context.toast(error.message, true)); };
    /** Maakt concept-orders uit het bestelvoorstel. */
    $('#b-po-proposal').onclick = () => { fromProposal(); };
    /** Exporteert de lijst naar Excel. */
    $('#b-po-excel').onclick = () => { exportList().catch((error) => context.toast(error.message, true)); };
    /** Laadt de lijst opnieuw met het gekozen filter. */
    $('#po-status').onchange = () => { load().catch((error) => context.toast(error.message, true)); };
    form.onsubmit = submitForm;
    /** Opent de bestandskeuze voor het inlezen. */
    $('#b-po-read').onclick = () => { $('#po-read-file').click(); };
    /**
     * Leest het gekozen bestand.
     * @param {Event} event de keuze
     */
    $('#po-read-file').onchange = (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) readDocument(file);
    };
    $('#po-unmatched-table').onclick = resolveUnmatched;
    /**
     * Opent de order waarop is geklikt (de lijst heeft geen regels, dus de volledige order wordt opgehaald).
     * @param {MouseEvent} event de klik
     */
    $('#po-table').onclick = (event) => {
      const button = event.target.closest('[data-open]');
      if (!button) return;
      context.api(`purchase-orders/${encodeURIComponent(button.dataset.open)}`).then((order) => openForm(order)).catch((error) => context.toast(error.message, true));
    };
    /**
     * Haalt een regel weg (pas bewaard met Bewaren).
     * @param {MouseEvent} event de klik
     */
    $('#po-lines').onclick = (event) => {
      const button = event.target.closest('[data-drop]');
      if (!button) return;
      readLines();
      state.lines.splice(Number(button.dataset.drop), 1);
      renderLines();
    };
    /** Zet het ingevulde artikel als regel op de order (pas bewaard met Bewaren). */
    $('#po-add').onclick = () => {
      const code = $('#po-add-code').value.trim().toLowerCase();
      const qty = Number($('#po-add-qty').value);
      const item = context.getItems().find((candidate) => candidate.code.toLowerCase() === code && !candidate.hasVariants && !candidate.archived);
      const errorBox = $('.err', form);
      errorBox.textContent = '';
      if (!item) { errorBox.textContent = 'Kies een bestaande artikelcode (geen hoofdartikel).'; return; }
      if (!(qty > 0)) { errorBox.textContent = 'Vul een aantal in.'; return; }
      readLines();
      if (state.lines.some((line) => line.itemId === item.id)) { errorBox.textContent = 'Dit artikel staat al op de order.'; return; }
      state.lines.push({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, supplierSku: '', qty, unitCost: '' });
      $('#po-add-code').value = '';
      $('#po-add-qty').value = '';
      renderLines();
    };
    const actions = { receivenow: receiveNow, place, receive, excel: exportOrder, close: closeOrder, cancel: cancelOrder, remove: removeOrder, hide: hideForm };
    /**
     * Voert de actie van de aangeklikte knop uit.
     * @param {MouseEvent} event de klik
     */
    form.onclick = (event) => {
      const button = event.target.closest('[data-act]');
      if (button && actions[button.dataset.act]) Promise.resolve(actions[button.dataset.act]()).catch((error) => context.toast(error.message, true));
    };
  }

  window.ArtikelenOrders = { setup, load };
})();
