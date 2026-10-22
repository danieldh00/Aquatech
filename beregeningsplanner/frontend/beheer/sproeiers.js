// Beheer > Sproeiers: de sproeierbibliotheek van de organisatie (behuizingen en
// nozzles met worp, sproeihoeken, drukbereik en debiet). Downloaden als Excel
// (de huidige bibliotheek is meteen het sjabloon), aangepast weer inlezen, of
// terug naar de standaard. Opslag en controle: backend/src/beregening/sprinklers.js.
(function () {
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
   * Getal in Nederlandse notatie.
   * @param {*} value Het getal (leeg = lege tekst).
   * @param {number} [decimals] Maximaal aantal decimalen.
   * @returns {string} Bijv. "2,5".
   */
  const formatNumber = (value, decimals = 1) => (value == null || value === '' ? '' : Number(value).toLocaleString('nl-NL', { maximumFractionDigits: decimals }));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const SprinklerLib = window.SprinklerLib;
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};
  let current = { own: null, updatedAt: null };

  /**
   * Roept api/sprinkler-library aan.
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(requestOptions = {}) {
    const res = await fetch('../api/sprinkler-library', {
      cache: 'no-store',
      ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * De bibliotheek zoals de planner hem gebruikt: standaard plus de eigen regels.
   * @returns {object} { bodies, nozzles }.
   */
  const library = () => SprinklerLib.merge(current.own && SprinklerLib.sanitize(current.own));

  /** Tekent de status en de tabellen met behuizingen en nozzles. */
  function render() {
    const merged = library();
    const ownCount = current.own ? current.own.bodies.length + current.own.nozzles.length : 0;
    $('#sp-status').innerHTML = ownCount
      ? `<b>${ownCount}</b> eigen regel${ownCount === 1 ? '' : 's'} bovenop de standaard${current.updatedAt ? `, ingelezen op ${esc(when(current.updatedAt))}` : ''}.`
      : 'De standaardbibliotheek is in gebruik (geen eigen regels).';
    $('#sp-reset').disabled = !ownCount;
    /**
     * Label "eigen" bij een regel die niet uit de standaard komt.
     * @param {object} item Behuizing of nozzle.
     * @returns {string} HTML van het label (leeg bij de standaard).
     */
    const sourceBadge = (item) => (item.source === 'eigen' ? '<span class="pill">eigen</span>' : '');
    $('#sp-bodies').innerHTML = `<thead><tr><th>Behuizing</th><th>Merk</th><th class="num">Pop-up</th><th>Aansluiting</th><th class="num">Drukregeling</th><th>Artikelcode</th><th></th></tr></thead>
      <tbody>${merged.bodies.map((body) => `<tr><td>${esc(body.name)}</td><td>${esc(body.brand)}</td><td class="num">${body.popup ? `${body.popup} cm` : ''}</td>
        <td>${esc(SprinklerLib.MOUNTS[body.mount] || body.mount)}</td><td class="num">${body.regBar ? `${formatNumber(body.regBar)} bar` : '–'}</td><td>${esc(body.code)}</td><td>${sourceBadge(body)}</td></tr>`).join('')}</tbody>`;
    $('#sp-nozzles').innerHTML = `<thead><tr><th>Nozzle</th><th>Merk</th><th>Soort</th><th>Aansluiting</th><th>Sproeihoeken</th><th class="num">Worp</th><th class="num">Debiet</th><th></th></tr></thead>
      <tbody>${merged.nozzles.map((nozzle) => {
        const performance = SprinklerLib.perfAt(nozzle, nozzle.bar);
        const range = SprinklerLib.radiusRange(nozzle, nozzle.bar);
        const arcs = nozzle.arcs.map(([fromAngle, toAngle]) => (fromAngle === toAngle ? `${fromAngle}°` : `${fromAngle}–${toAngle}°`)).join(' / ');
        return `<tr><td>${esc(nozzle.name)}</td><td>${esc(nozzle.brand)}</td><td>${esc(SprinklerLib.GROUPS[nozzle.group] || nozzle.group)}</td><td>${esc(SprinklerLib.MOUNTS[nozzle.mount] || nozzle.mount)}</td>
          <td>${esc(arcs)}</td><td class="num">${formatNumber(range.rMin)}–${formatNumber(range.rMax)} m</td>
          <td class="num">${formatNumber(performance.q / 60, 2)} l/min${nozzle.matched ? ' bij 360°' : ''} · ${formatNumber(nozzle.bar)} bar</td><td>${sourceBadge(nozzle)}</td></tr>`;
      }).join('')}</tbody>`;
  }

  /**
   * Laadt de bibliotheek en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    try { current = await api(); render(); } catch (error) { toast(`Kan de sproeierbibliotheek niet laden: ${error.message}`, true); }
  }

  /**
   * Downloadt de huidige bibliotheek als Excel (uitleg plus een blad per soort); dat is meteen het sjabloon.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aquatech';
    workbook.created = new Date();
    const explanationSheet = workbook.addWorksheet('Uitleg');
    explanationSheet.getColumn(1).width = 120;
    SprinklerLib.UITLEG.forEach((line, i) => { const row = explanationSheet.addRow([line]); if (i === 0) row.font = { bold: true, size: 13 }; row.alignment = { wrapText: true }; });
    const data = SprinklerLib.toSheets(library());
    for (const [name, columns] of Object.entries(SprinklerLib.SHEETS)) {
      const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
      data[name].forEach((row) => sheet.addRow(row));
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = 'sproeierbibliotheek.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  /**
   * Waarde van een cel als tekst of getal (formules: het resultaat, rich text: de tekst).
   * @param {*} value Celwaarde uit ExcelJS.
   * @returns {*} De waarde (leeg = lege tekst).
   */
  function cellValue(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
      if ('result' in value) return value.result;
      if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
      if ('text' in value) return value.text;
    }
    return value;
  }

  /**
   * Leest een aangepast Excel-bestand in na bevestiging; vervangt alle eigen regels.
   * @param {File} [file] Het gekozen bestand (max. 5 MB).
   * @returns {Promise<void>}
   */
  async function importExcel(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Het bestand is te groot (max. 5 MB).', true); return; }
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel inlezen niet beschikbaar.', true); return; }
    const resultBox = $('#sp-result');
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheets = {};
      for (const name of Object.keys(SprinklerLib.SHEETS)) {
        const sheet = workbook.worksheets.find((candidate) => candidate.name.trim().toLowerCase() === name.toLowerCase());
        if (!sheet) continue;
        const rows = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const values = [];
          for (let column = 1; column <= row.cellCount; column++) values.push(cellValue(row.getCell(column).value));
          rows.push(values);
        });
        sheets[name] = rows;
      }
      if (!sheets.Behuizingen && !sheets.Nozzles) throw new Error('geen bladen "Behuizingen" of "Nozzles" gevonden; gebruik het Excel-bestand van Downloaden als sjabloon.');
      const raw = SprinklerLib.fromSheets(sheets);
      const check = SprinklerLib.sanitize(raw);
      if (!confirm(`${check.bodies.length} behuizingen en ${check.nozzles.length} nozzles inlezen?${check.problems.length ? ` ${check.problems.length} regel(s) worden overgeslagen.` : ''} Dit vervangt alle eigen regels.`)) return;
      const saved = await api({ method: 'PUT', body: raw });
      current = saved;
      render();
      resultBox.innerHTML = `<p>Ingelezen: <b>${saved.counts.bodies}</b> behuizingen en <b>${saved.counts.nozzles}</b> nozzles, waarvan <b>${saved.counts.own}</b> anders dan de standaard (alleen die worden opgeslagen).</p>${saved.problems.length
        ? `<details open><summary>Overgeslagen (${saved.problems.length})</summary><ul>${saved.problems.map((problem) => `<li>${esc(problem)}</li>`).join('')}</ul></details>` : ''}`;
      toast('Sproeierbibliotheek ingelezen');
    } catch (error) {
      resultBox.innerHTML = `<p class="err">Inlezen mislukt: ${esc(error.message)}</p>`;
    } finally {
      $('#sp-file').value = '';
    }
  }

  /**
   * Verwijdert na bevestiging alle eigen regels (terug naar de standaard).
   * @returns {Promise<void>}
   */
  async function reset() {
    if (!confirm('Alle eigen behuizingen en nozzles verwijderen en terug naar de standaardbibliotheek?')) return;
    try { current = await api({ method: 'DELETE' }); render(); $('#sp-result').innerHTML = ''; toast('Standaardbibliotheek hersteld'); } catch (error) { toast(error.message, true); }
  }

  /**
   * Koppelt de knoppen (één keer, door Beheer).
   * @param {object} options { toast }.
   */
  function init(options) {
    toast = options.toast || toast;
    /**
     * Start de Excel-export.
     * @returns {Promise<void>}
     */
    $('#sp-export').onclick = () => exportExcel().catch((error) => toast(`Export mislukt: ${error.message}`, true));
    /**
     * Opent het bestandsvenster.
     * @returns {void}
     */
    $('#sp-import').onclick = () => $('#sp-file').click();
    /**
     * Leest het gekozen bestand in.
     * @param {Event} event De wijziging van het bestandsveld.
     * @returns {Promise<void>}
     */
    $('#sp-file').onchange = (event) => importExcel(event.target.files[0]);
    $('#sp-reset').onclick = reset;
  }

  window.BeheerSproeiers = { init, load };
})();
