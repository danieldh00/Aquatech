// Werkorders: werkbon (afdrukversie), Excel-export van een werkorder en van het
// overzicht, en de urenstaat. Wordt door werkorders.js aangemaakt met createExports.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  const { $, esc, nl, date, shortDate, hours, today, state, toast } = window.Werkorders.common;

  /**
   * Maakt het onderdeel exporteren en afdrukken.
   * @param {object} deps functies uit werkorders.js die dit onderdeel nodig heeft: save, visible, designLine, zonesTable, headsTable
   * @returns {object} de functies: renderPrint, printWorkOrder, exportWorkOrderXlsx, exportListXlsx, openHoursExport, runHoursExport
   */
  window.Werkorders.createExports = function (deps) {
    const { save, visible, designLine, zonesTable, headsTable } = deps;
    // ---------- Werkbon (afdrukversie) ----------
    /**
     * Maakt een afvinkvakje voor de werkbon.
     * @param {boolean} checked true = met vinkje
     * @returns {string} HTML van het vakje
     */
    const box = (checked) => `<span class="p-box">${checked ? '✓' : ''}</span>`;

    /** Zet de werkbon (afdrukversie) van de open werkorder klaar. */
    function renderPrint() {
      const workOrder = state.workOrder;
      const data = workOrder.data;
      const profile = state.profile || {};
      const customer = data.customer;
      const progress = WorkOrderCore.progress(data);
      const company = [profile.address, [profile.phone, profile.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
      const to = [customer.name, customer.contact ? `T.a.v. ${customer.contact}` : '', customer.address, customer.phone ? `Tel. ${customer.phone}` : ''].filter(Boolean).join('\n');
      const steps = Object.entries(WorkOrderCore.PHASES).map(([key, label]) => {
        const list = data.steps.filter((step) => step.phase === key);
        if (!list.length) return '';
        return `<tr class="p-section"><td colspan="4">${esc(label)}</td></tr>${list.map((step) => `
          <tr><td class="chk">${box(step.done)}</td><td>${esc(step.title)}${step.details ? `<div class="p-small">${esc(step.details)}</div>` : ''}</td>
          <td class="num">${step.hours ? `${nl(step.hours)} u` : ''}</td><td class="num">${step.actualHours != null ? `${nl(step.actualHours)} u` : '<span class="p-fill"></span>'}</td></tr>`).join('')}`;
      }).join('');
      const mats = data.materials.map((material) => `<tr><td class="chk">${box(material.picked)}</td><td>${esc(material.description)}${material.code ? ` <span class="p-small">${esc(material.code)}</span>` : ''}</td>
        <td class="num">${nl(material.qty)}</td><td>${esc(material.unit)}</td></tr>`).join('');
      const line = designLine(data.design);
      /**
       * Maakt een kop met tekstblok voor de werkbon.
       * @param {string} title de kop
       * @param {string} content de tekst
       * @returns {string} HTML, of leeg zonder tekst
       */
      const text = (title, content) => (content ? `<h2>${esc(title)}</h2><p class="p-text">${esc(content)}</p>` : '');
      const docLayout = window.AquatechDocLayout;
      const layout = state.documentLayout;
      const companyName = profile.companyName || 'AquaTech Service';
      const logoBlock = docLayout ? docLayout.logoHtml(layout, { defaultSrc: '../shared/logo-white.png', name: companyName }) : `<img src="../shared/logo-white.png" alt="${esc(companyName)}">`;
      const footLine = [profile.companyName, profile.website].filter(Boolean).join(' · ');
      const footBlock = docLayout ? docLayout.footerHtml(layout, footLine) : esc(footLine);
      const printHtml = `
        <header class="p-head">
          ${logoBlock}
          <div class="p-company"><b>${esc(profile.companyName || '')}</b>\n${esc(company)}</div>
        </header>
        <div class="p-meta">
          <div class="p-to"><div class="lbl">Klant en adres</div>${esc(to || '–')}</div>
          <div class="p-info"><table>
            <tr><td>Werkorder</td><td><b>${esc(workOrder.number)}</b></td></tr>
            ${data.quoteNumber ? `<tr><td>Offerte</td><td>${esc(data.quoteNumber)}</td></tr>` : ''}
            <tr><td>Datum</td><td>${esc(date(data.plannedDate))}${data.startTime ? `, ${esc(data.startTime)} uur` : ''}</td></tr>
            <tr><td>Uitvoerder</td><td>${esc(workOrder.assignee ? workOrder.assignee.displayName : '–')}</td></tr>
            ${data.crew ? `<tr><td>Ploeg</td><td>${esc(data.crew)}</td></tr>` : ''}
            <tr><td>Geplande uren</td><td>${esc(hours(progress.hours))}</td></tr>
          </table></div>
        </div>
        <h1>Werkbon</h1>
        <div class="p-sub">${esc(data.title)}</div>
        ${line ? `<div class="p-design"><b>Ontwerp${data.planTitle ? ` ${esc(data.planTitle)}` : ''}:</b> ${esc(line)}</div>` : ''}
        ${text('Werkinstructies', data.instructions)}
        ${text('Bijzonderheden locatie', data.siteNotes)}
        ${data.zones.length ? `<h2>Zone-indeling</h2>${zonesTable(data.zones, 'p-lines p-zones')}` : ''}
        ${(data.heads || []).length ? `<h2>Afstelling sproeikoppen</h2><p class="p-note">Linkerrand = begin van de sproeihoek op de tekening (0° = rechts, met de klok mee).</p>${headsTable(data.heads, 'p-lines p-heads')}` : ''}
        <h2>Werkstappen</h2>
        <table class="p-lines p-check">
          <thead><tr><th></th><th>Werkstap</th><th class="num">Gepland</th><th class="num">Werkelijk</th></tr></thead>
          <tbody>${steps || '<tr><td colspan="4">Geen werkstappen.</td></tr>'}</tbody>
        </table>
        <h2>Materialen</h2>
        <table class="p-lines p-check">
          <thead><tr><th></th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th></tr></thead>
          <tbody>${mats || '<tr><td colspan="4">Geen materialen.</td></tr>'}</tbody>
        </table>
        <div class="p-end">
          <h2>Oplevering</h2>
          <p class="p-text p-notes">${esc(data.report.notes || '')}</p>
          <div class="p-sign"><div>Uitvoerder (naam, datum)</div><div>Klant voor gezien${data.report.signedBy ? `: ${esc(data.report.signedBy)}` : ''}${data.report.completedOn ? `, ${esc(shortDate(data.report.completedOn))}` : ''}</div></div>
          <footer class="p-foot">${footBlock}</footer>
        </div>`;
      $('#print').innerHTML = docLayout ? docLayout.wrap(printHtml, layout) : printHtml;
    }

    /**
     * Slaat op en opent het afdrukvenster voor de werkbon (ook voor Opslaan als PDF).
     * @returns {Promise<void>}
     */
    async function printWorkOrder() {
      await save();
      renderPrint();
      const oldTitle = document.title;
      const customerName = state.workOrder.data.customer.name;
      document.title = `Werkbon ${state.workOrder.number}${customerName ? ` ${customerName}` : ''}`;
      const logo = $('#print img');
      if (logo && !logo.complete) await new Promise((resolve) => { logo.onload = resolve; logo.onerror = resolve; });
      window.print();
      setTimeout(() => { document.title = oldTitle; }, 500);
    }

    // ---------- Excel ----------
    /**
     * Laat de browser een bestand downloaden.
     * @param {Blob} blob de inhoud
     * @param {string} filename de bestandsnaam
     */
    function download(blob, filename) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    }
    /**
     * Maakt tekst geschikt voor een bestandsnaam.
     * @param {string} text de tekst
     * @returns {string} alleen letters, cijfers, - en _
     */
    const safeName = (text) => String(text || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
    const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const NAVY = 'FF172F5E';
    /**
     * Geeft een kopregel in Excel de huisstijl (wit op navy, vet).
     * @param {object} row ExcelJS-rij
     */
    const headStyle = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    };
    /**
     * Maakt van een ISO-datum een datum voor Excel.
     * @param {string} iso datum als 'jjjj-mm-dd'
     * @returns {Date|null} de datum (midden op de dag), of null
     */
    const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);

    /**
     * Exporteert de open werkorder als Excel-bestand (werkstappen, zones, koppen, materialen en geboekte uren).
     * @returns {Promise<void>}
     */
    async function exportWorkOrderXlsx() {
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
      await save();
      const workOrder = state.workOrder;
      const data = workOrder.data;
      try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = (state.profile && state.profile.companyName) || 'AquaTech Service';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Werkorder', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
        sheet.columns = [{ width: 16 }, { width: 60 }, { width: 12 }, { width: 12 }, { width: 10 }];
        sheet.addRow([`Werkorder ${workOrder.number}`]).font = { bold: true, size: 14, color: { argb: NAVY } };
        const info = [
          ['Omschrijving', data.title], ['Offerte', data.quoteNumber], ['Status', WorkOrderCore.STATUSES[workOrder.status]],
          ['Datum', asDate(data.plannedDate) || ''], ['Starttijd', data.startTime], ['Uitvoerder', workOrder.assignee ? workOrder.assignee.displayName : ''], ['Ploeg', data.crew],
          ['Klant', data.customer.name], ['Contactpersoon', data.customer.contact], ['Adres', data.customer.address.replace(/\n/g, ', ')],
          ['Telefoon', data.customer.phone], ['E-mail', data.customer.email], ['Ontwerp', designLine(data.design)],
          ['Werkinstructies', data.instructions], ['Bijzonderheden', data.siteNotes],
        ].filter(([, value]) => value !== '' && value != null);
        for (const [label, value] of info) {
          const row = sheet.addRow([label, value]);
          row.getCell(1).font = { bold: true };
          row.getCell(2).alignment = { horizontal: 'left', wrapText: true, vertical: 'top' };
          if (value instanceof Date) row.getCell(2).numFmt = 'dd-mm-yyyy';
        }
        sheet.addRow([]);
        headStyle(sheet.addRow(['Fase', 'Werkstap', 'Gepland (u)', 'Werkelijk (u)', 'Klaar']));
        const firstRow = sheet.lastRow.number + 1;
        for (const [key, label] of Object.entries(WorkOrderCore.PHASES)) {
          for (const step of data.steps.filter((candidate) => candidate.phase === key)) {
            sheet.addRow([label, step.details ? `${step.title} – ${step.details}` : step.title, step.hours || null, step.actualHours, step.done ? 'ja' : 'nee']);
          }
        }
        const lastRow = sheet.lastRow.number;
        const totalRow = sheet.addRow(['', 'Totaal', { formula: `SUM(C${firstRow}:C${Math.max(firstRow, lastRow)})` }, { formula: `SUM(D${firstRow}:D${Math.max(firstRow, lastRow)})` }]);
        totalRow.font = { bold: true };
        if (data.zones.length) {
          const zoneSheet = workbook.addWorksheet('Zones', { views: [{ state: 'frozen', ySplit: 1 }] });
          zoneSheet.columns = [
            { header: 'Zone', key: 'name', width: 12 }, { header: 'Soort', key: 'kind', width: 24 }, { header: 'Onderdelen', key: 'parts', width: 50 },
            { header: 'Debiet (m³/u)', key: 'flow', width: 14, style: { numFmt: '0.00' } }, { header: 'Leiding (m)', key: 'pipe', width: 12, style: { numFmt: '0' } },
            { header: 'Druk laatste kop (bar)', key: 'p', width: 20, style: { numFmt: '0.0' } },
          ];
          for (const zone of data.zones) zoneSheet.addRow({ name: zone.name, kind: zone.kind, parts: zone.parts, flow: zone.flowLph / 1000, pipe: zone.pipeM, p: zone.pressureBar });
          headStyle(zoneSheet.getRow(1));
        }
        if ((data.heads || []).length) {
          const headSheet = workbook.addWorksheet('Afstelling koppen', { views: [{ state: 'frozen', ySplit: 1 }] });
          headSheet.columns = [
            { header: 'Nr', key: 'nr', width: 6 }, { header: 'Zone', key: 'zone', width: 12 }, { header: 'Kop', key: 'nozzle', width: 14 },
            { header: 'Behuizing', key: 'body', width: 30 }, { header: 'Sector', key: 'sector', width: 10 }, { header: 'Sproeihoek (°)', key: 'arc', width: 14 },
            { header: 'Worp (m)', key: 'r', width: 10, style: { numFmt: '0.0' } }, { header: 'Linkerrand', key: 'left', width: 20 },
            { header: 'X (m)', key: 'x', width: 9, style: { numFmt: '0.00' } }, { header: 'Y (m)', key: 'y', width: 9, style: { numFmt: '0.00' } },
          ];
          for (const head of data.heads) headSheet.addRow({ nr: head.nr, zone: head.zone, nozzle: head.nozzle || head.kind, body: head.body || '', sector: head.sector, arc: head.arc || null, r: head.r, left: head.leftText, x: head.x, y: head.y });
          headStyle(headSheet.getRow(1));
        }
        const materialSheet = workbook.addWorksheet('Materialen', { views: [{ state: 'frozen', ySplit: 1 }] });
        materialSheet.columns = [
          { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'description', width: 56 },
          { header: 'Aantal', key: 'qty', width: 10 }, { header: 'Eenheid', key: 'unit', width: 10 }, { header: 'Verzameld', key: 'picked', width: 11 },
        ];
        for (const material of data.materials) materialSheet.addRow({ code: material.code, description: material.description, qty: material.qty, unit: material.unit, picked: material.picked ? 'ja' : 'nee' });
        headStyle(materialSheet.getRow(1));
        materialSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
        // Geboekte uren en materiaalverbruik (worklog.js).
        if (window.WorkLog) await window.WorkLog.addSheets(workbook, { headStyle });
        download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorder_${safeName(workOrder.number)}${data.customer.name ? `_${safeName(data.customer.name)}` : ''}.xlsx`);
      } catch (error) {
        console.error(error);
        toast(`Export mislukt: ${error.message}`, true);
      }
    }

    /**
     * Exporteert de zichtbare werkorders als Excel-bestand.
     * @returns {Promise<void>}
     */
    async function exportListXlsx() {
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
      const items = visible();
      try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'AquaTech Service';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Werkorders', { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = [
          { header: 'Nummer', key: 'number', width: 16 },
          { header: 'Offerte', key: 'quote', width: 16 },
          { header: 'Omschrijving', key: 'title', width: 40 },
          { header: 'Klant', key: 'customer', width: 28 },
          { header: 'Adres', key: 'address', width: 36 },
          { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
          { header: 'Starttijd', key: 'time', width: 10 },
          { header: 'Uitvoerder', key: 'assignee', width: 22 },
          { header: 'Status', key: 'status', width: 14 },
          { header: 'Stappen klaar', key: 'done', width: 13 },
          { header: 'Stappen', key: 'steps', width: 10 },
          { header: 'Uren gepland', key: 'hours', width: 13, style: { numFmt: '0.00' } },
          { header: 'Uren werkelijk', key: 'actual', width: 14, style: { numFmt: '0.00' } },
          { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        ];
        for (const workOrder of items) {
          sheet.addRow({
            number: workOrder.number, quote: workOrder.quoteNumber, title: workOrder.title, customer: workOrder.customer, address: workOrder.address, date: asDate(workOrder.plannedDate),
            time: workOrder.startTime, assignee: workOrder.assignee ? workOrder.assignee.displayName : '', status: WorkOrderCore.STATUSES[workOrder.status] || workOrder.status,
            done: workOrder.progress.done, steps: workOrder.progress.steps, hours: workOrder.progress.hours, actual: workOrder.progress.actualHours, updatedAt: new Date(workOrder.updatedAt),
          });
        }
        headStyle(sheet.getRow(1));
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
        download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorders_${today()}.xlsx`);
        toast(`${items.length} werkorders geëxporteerd`);
      } catch (error) {
        toast(`Export mislukt: ${error.message}`, true);
      }
    }

    // ---------- Urenstaat (worklog.js) ----------
    /** Opent het venster voor de urenstaat, met standaard deze maand tot vandaag. */
    function openHoursExport() {
      const now = new Date();
      /**
       * Vult een getal aan tot twee cijfers.
       * @param {number} number het getal
       * @returns {string} bijv. '07'
       */
      const pad = (number) => String(number).padStart(2, '0');
      if (!$('#he-from').value) $('#he-from').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      if (!$('#he-to').value) $('#he-to').value = today();
      // Met het recht planning: de urenstaat van iedereen of één medewerker; anders alleen je eigen uren.
      $('#he-user-row').hidden = !state.planning;
      if (state.planning) {
        const current = $('#he-user').value;
        $('#he-user').innerHTML = '<option value="">Iedereen</option>' + state.staff.map((user) => `<option value="${esc(user.id)}"${user.id === current ? ' selected' : ''}>${esc(user.displayName)}</option>`).join('');
      }
      $('#he-err').textContent = '';
      $('#hours-export').hidden = false;
    }

    /**
     * Exporteert de urenstaat over de gekozen periode als Excel-bestand (worklog.js).
     * @returns {Promise<void>}
     */
    async function runHoursExport() {
      const from = $('#he-from').value;
      const to = $('#he-to').value;
      if (!from || !to || from > to) { $('#he-err').textContent = 'Kies een geldige periode.'; return; }
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
      $('#he-go').disabled = true;
      try {
        const counts = await window.WorkLog.exportPeriod({ from, to, userId: state.planning ? $('#he-user').value : '', headStyle, download, companyName: state.profile && state.profile.companyName });
        $('#hours-export').hidden = true;
        toast(`Urenstaat met ${counts.hours} urenregel${counts.hours === 1 ? '' : 's'} en ${counts.materials} materiaalregel${counts.materials === 1 ? '' : 's'}`);
      } catch (error) {
        $('#he-err').textContent = `Export mislukt: ${error.message}`;
      } finally {
        $('#he-go').disabled = false;
      }
    }

    return { renderPrint, printWorkOrder, exportWorkOrderXlsx, exportListXlsx, openHoursExport, runHoursExport };
  };
})();
