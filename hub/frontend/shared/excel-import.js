// Importvenster voor Excel-bestanden (V-05, V-30): bestand kiezen (met een voorbeeldbestand als begin), de controle tonen
// (nieuw, wijzigt, ongewijzigd, fouten met reden) en daarna in één keer verwerken. Het bestand wordt in de browser gelezen
// (ExcelJS, pas geladen bij gebruik) en als kopregel + rijen naar de server gestuurd; de server controleert en schrijft.
(function (root) {
  const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  /** Hoeveel regels het controleoverzicht hoogstens toont (de aantallen bovenaan gelden voor alles). */
  const SHOW_LIMIT = 300;

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De tekst met entiteiten.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Waarde van een cel als tekst of getal (formules: het resultaat, rich text: de tekst, datum: JJJJ-MM-DD).
   * @param {*} value Celwaarde uit ExcelJS.
   * @returns {*} De waarde (leeg = lege tekst).
   */
  function cellValue(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
      if ('result' in value) return cellValue(value.result);
      if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
      if ('text' in value) return value.text;
      if ('error' in value) return '';
    }
    return value;
  }

  /**
   * Leest het eerste blad met gegevens uit een Excel-bestand: de eerste regel is de kopregel.
   * @param {File} file Het gekozen bestand.
   * @returns {Promise<{ headers: string[], rows: any[][] }>} De kopregel en de regels.
   */
  async function readFile(file) {
    const ExcelJS = root.ExcelJS || (root.AquatechCommon && await root.AquatechCommon.excel());
    if (!ExcelJS) throw new Error('Excel kan nu niet worden geladen.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Het bestand is te groot (hoogstens 5 MB).');
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(await file.arrayBuffer()); } catch (error) { throw new Error('Dit is geen Excel-bestand (.xlsx).'); }
    const sheet = workbook.worksheets.find((candidate) => candidate.actualRowCount > 0);
    if (!sheet) throw new Error('Het bestand is leeg.');
    const lines = [];
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      const values = [];
      for (let column = 1; column <= row.cellCount; column++) values.push(cellValue(row.getCell(column).value));
      lines.push({ number, values });
    });
    const [head, ...rest] = lines;
    const width = Math.max(head.values.length, 1);
    // Regelnummers kloppen met Excel zolang er geen lege regels tussen zitten; lege regels vullen we op met lege rijen.
    const rows = [];
    let expected = head.number + 1;
    for (const line of rest) {
      while (expected < line.number) { rows.push([]); expected += 1; }
      rows.push(line.values.slice(0, width));
      expected += 1;
    }
    return { headers: head.values.map((value) => String(value ?? '')), rows };
  }

  /**
   * Bouwt en downloadt het voorbeeldbestand: een kopregel met een voorbeeldregel en een blad met uitleg per kolom.
   * @param {{ fields: { label: string, required: boolean, example: string, hint: string }[] }} spec De velden van de import.
   * @param {string} name Bestandsnaam.
   * @returns {Promise<void>}
   */
  async function downloadTemplate(spec, name) {
    const ExcelJS = root.ExcelJS || (root.AquatechCommon && await root.AquatechCommon.excel());
    if (!ExcelJS) throw new Error('Excel kan nu niet worden geladen.');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Import');
    sheet.columns = spec.fields.map((field) => ({ header: field.label, key: field.label, width: Math.max(14, field.label.length + 4) }));
    sheet.addRow(spec.fields.map((field) => field.example || ''));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const help = workbook.addWorksheet('Uitleg');
    help.columns = [{ header: 'Kolom', key: 'label', width: 26 }, { header: 'Verplicht', key: 'required', width: 12 }, { header: 'Uitleg', key: 'hint', width: 80 }];
    for (const field of spec.fields) help.addRow({ label: field.label, required: field.required ? 'ja' : 'nee', hint: field.hint });
    help.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: SHEET_TYPE }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  /**
   * Tekst van de uitkomst van een regel: wijzigingen, fouten en opmerkingen.
   * @param {object} row De regel uit de controle.
   * @returns {string} HTML.
   */
  function detailsOf(row) {
    const parts = [];
    for (const problem of row.problems || []) parts.push(`<div class="xi-problem">${esc(problem)}</div>`);
    for (const change of row.changes || []) parts.push(`<div class="xi-change">${esc(change.label)}: <s>${esc(change.from || '(leeg)')}</s> → ${esc(change.to || '(leeg)')}</div>`);
    for (const warning of row.warnings || []) parts.push(`<div class="xi-warning">${esc(warning)}</div>`);
    return parts.join('');
  }

  /**
   * Opent het importvenster.
   * @param {{ title: string, intro?: string, subject: string, templateName: string, api: Function, fieldsPath: string, importPath: string, extraBody?: object, onDone?: Function }} options Titel, uitleg, wat er geïmporteerd wordt (meervoud, bijv. "klanten"), bestandsnaam van het voorbeeld, de api-functie van de pagina (path, { method, body }) en de paden van de velden en de import; extraBody gaat mee in elk verzoek; onDone wordt na het verwerken aangeroepen.
   * @returns {void}
   */
  function open(options) {
    const overlay = document.createElement('div');
    overlay.className = 'xi-overlay';
    overlay.innerHTML = `<div class="xi-panel" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
      <h2>${esc(options.title)}</h2>
      <p class="xi-intro">${esc(options.intro || '')}</p>
      <div class="xi-step">
        <button type="button" class="btn" data-xi="template">Voorbeeldbestand (Excel)</button>
        <input type="file" data-xi="file" accept=".xlsx" aria-label="Excel-bestand kiezen">
      </div>
      <div data-xi="status" class="xi-note"></div>
      <div data-xi="review" hidden></div>
      <div class="xi-actions">
        <label data-xi="skip-label" hidden><input type="checkbox" data-xi="skip"> Regels met fouten overslaan</label>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-xi="apply" disabled>Verwerken</button>
        <button type="button" class="btn" data-xi="close">Sluiten</button>
      </div>
      <p data-xi="result" class="xi-result" hidden></p>
    </div>`;
    document.body.appendChild(overlay);
    /**
     * Zoekt een onderdeel van het venster op zijn data-xi-naam.
     * @param {string} name De naam.
     * @returns {Element|null} Het element.
     */
    const $ = (name) => overlay.querySelector(`[data-xi="${name}"]`);
    let table = null;
    let preview = null;
    let done = false;
    let spec = null;

    /**
     * Sluit het venster en ververst de pagina als er iets is verwerkt.
     * @returns {void}
     */
    const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); if (done && options.onDone) options.onDone(); };
    /**
     * Sluit het venster met Escape.
     * @param {KeyboardEvent} event De toets.
     * @returns {void}
     */
    function onKey(event) { if (event.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    $('close').onclick = close;
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });

    /**
     * Toont een melding bij de stap.
     * @param {string} text De melding.
     * @param {boolean} [warn] Als waarschuwing.
     * @returns {void}
     */
    const say = (text, warn = false) => { const box = $('status'); box.textContent = text; box.className = `xi-note${warn ? ' warn' : ''}`; };
    /**
     * Toont het resultaat van het verwerken.
     * @param {string} text De tekst.
     * @param {boolean} [isError] Als fout.
     * @returns {void}
     */
    const showResult = (text, isError = false) => { const box = $('result'); box.hidden = false; box.className = `xi-result${isError ? ' err' : ''}`; box.textContent = text; };

    /**
     * Haalt de velden van de import op (voor het voorbeeldbestand), één keer.
     * @returns {Promise<object>} De velden.
     */
    async function fields() { if (!spec) spec = await options.api(options.fieldsPath); return spec; }

    /**
     * Downloadt het voorbeeldbestand.
     * @returns {Promise<void>}
     */
    $('template').onclick = async () => {
      try { await downloadTemplate(await fields(), options.templateName); } catch (error) { say(error.message, true); }
    };

    /**
     * Toont de controle: aantallen, niet herkende kolommen en de regels (te filteren).
     * @returns {void}
     */
    function renderReview() {
      const counts = preview.counts;
      const box = $('review');
      box.hidden = false;
      const cards = [['nieuw', 'Nieuw'], ['wijzigt', 'Wijzigt'], ['ongewijzigd', 'Ongewijzigd'], ['fout', 'Met fouten']]
        .map(([key, label]) => `<div class="xi-count ${key}"><b>${counts[key] || 0}</b>${label}</div>`).join('');
      const unknown = preview.unknown && preview.unknown.length ? `<p class="xi-note warn">Niet herkende kolommen worden genegeerd: ${esc(preview.unknown.join(', '))}.</p>` : '';
      box.innerHTML = `<div class="xi-counts">${cards}</div>${unknown}
        <label class="xi-note">Tonen: <select data-xi="filter"><option value="">Alle regels</option><option value="fout">Alleen fouten</option><option value="nieuw">Alleen nieuw</option><option value="wijzigt">Alleen wijzigingen</option></select></label>
        <div class="xi-table-wrap"><table class="xi-table"><thead><tr><th>Regel</th><th>Status</th><th>${esc(options.keyLabel || 'Naam')}</th><th>Wat er gebeurt</th></tr></thead><tbody data-xi="rows"></tbody></table></div>
        <p class="xi-note" data-xi="more" hidden></p>`;
      /**
       * Vult de tabel met de regels die bij het filter horen.
       * @returns {void}
       */
      const fill = () => {
        const wanted = box.querySelector('[data-xi="filter"]').value;
        const matching = preview.rows.filter((row) => !wanted || row.status === wanted);
        box.querySelector('[data-xi="rows"]').innerHTML = matching.slice(0, SHOW_LIMIT).map((row) => `<tr><td>${row.line}</td><td><span class="xi-badge ${row.status}">${row.status === 'fout' ? 'fout' : row.status}</span></td><td>${esc(row.code || row.name)}${row.code && row.name ? `<div class="xi-note">${esc(row.name)}</div>` : ''}</td><td>${detailsOf(row)}</td></tr>`).join('');
        const more = box.querySelector('[data-xi="more"]');
        more.hidden = matching.length <= SHOW_LIMIT;
        more.textContent = `Eerste ${SHOW_LIMIT} van ${matching.length} regels getoond.`;
      };
      box.querySelector('[data-xi="filter"]').onchange = fill;
      fill();
      $('skip-label').hidden = !counts.fout;
      $('skip').checked = false;
      updateApply();
    }

    /**
     * Zet de knop Verwerken aan als er iets te doen is en fouten bewust worden overgeslagen.
     * @returns {void}
     */
    function updateApply() {
      const counts = preview ? preview.counts : { nieuw: 0, wijzigt: 0, fout: 0 };
      $('apply').disabled = done || !preview || !(counts.nieuw + counts.wijzigt) || (counts.fout > 0 && !$('skip').checked);
    }
    $('skip').onchange = updateApply;

    /**
     * Leest het gekozen bestand en toont de controle.
     * @returns {Promise<void>}
     */
    $('file').onchange = async () => {
      const file = $('file').files[0];
      if (!file) return;
      $('result').hidden = true;
      preview = null;
      done = false;
      updateApply();
      say('Bestand wordt gelezen en gecontroleerd…');
      try {
        table = await readFile(file);
        preview = await options.api(options.importPath, { method: 'POST', body: { ...(options.extraBody || {}), headers: table.headers, rows: table.rows } });
        say(`${file.name}: ${table.rows.length} regels gelezen. Er is nog niets opgeslagen.`);
        renderReview();
      } catch (error) {
        $('review').hidden = true;
        say(error.message, true);
      }
    };

    /**
     * Verwerkt het gecontroleerde bestand en toont het resultaat.
     * @returns {Promise<void>}
     */
    $('apply').onclick = async () => {
      const counts = preview.counts;
      $('apply').disabled = true;
      try {
        const out = await options.api(options.importPath, { method: 'POST', body: { ...(options.extraBody || {}), headers: table.headers, rows: table.rows, apply: true, skipErrors: $('skip').checked } });
        done = true;
        const failed = out.failed && out.failed.length ? ` ${out.failed.length} regel(s) konden toch niet worden opgeslagen: ${out.failed.slice(0, 5).map((item) => `regel ${item.line}: ${item.message}`).join('; ')}.` : '';
        showResult(`Klaar: ${out.created || 0} nieuw, ${out.updated || 0} gewijzigd, ${out.unchanged ?? counts.ongewijzigd ?? 0} ongewijzigd, ${out.skipped || 0} overgeslagen.${failed}`, Boolean(failed));
        say(`${options.subject} zijn verwerkt.`);
        $('review').hidden = true;
        $('file').value = '';
      } catch (error) {
        showResult(error.message, true);
        updateApply();
      }
    };
  }

  root.AquatechExcelImport = { open, readFile, downloadTemplate, cellValue };
})(window);
