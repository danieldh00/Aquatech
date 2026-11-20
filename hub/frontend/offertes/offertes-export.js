// Offertes: afdrukken en downloaden van een offerte als PDF-afdrukversie of Excel.
// Het bestand zet een fabriek op window.Offertes; offertes.js geeft de gedeelde
// hulpfuncties en de stand (context) mee en gebruikt wat de fabriek teruggeeft.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Bouwt de functies voor afdrukken en downloaden van een offerte als PDF-afdrukversie of Excel.
   * @param {object} context gedeelde hulpfuncties en stand uit offertes.js: QuoteCore, nl, statusOf, statusLabel, QuoteView, state, toast, save, $
   * @returns {object} de functies die offertes.js zelf nodig heeft: printQuote, download, XLSX_TYPE, NAVY, exportQuoteXlsx
   */
  window.Offertes.createExport = function (context) {
    const { QuoteCore, nl, statusOf, statusLabel, QuoteView, state, toast, save, $ } = context;

    // ---------- PDF (afdrukversie) ----------
    /** Zet de afdrukversie van de offerte klaar. */
    function renderPrint() {
      $('#print').innerHTML = QuoteView.documentHtml(state.quote, state.profile, { layout: state.documentLayout });
    }

    /**
     * Slaat op en opent het afdrukvenster (ook voor Opslaan als PDF).
     * @returns {Promise<void>}
     */
    async function printQuote() {
      await save();
      renderPrint();
      // De bestandsnaam van "Opslaan als PDF" volgt de paginatitel.
      const oldTitle = document.title;
      const customerName = state.quote.data.customer.name;
      document.title = `Offerte ${state.quote.number}${customerName ? ` ${customerName}` : ''}`;
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
     * Exporteert de open offerte als Excel-bestand met formules voor de totalen.
     * @returns {Promise<void>}
     */
    async function exportQuoteXlsx() {
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
      await save();
      const quote = state.quote;
      const data = quote.data;
      const profile = state.profile;
      try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = profile.companyName || 'AquaTech Service';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Offerte', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
        sheet.columns = [{ width: 14 }, { width: 58 }, { width: 10 }, { width: 8 }, { width: 13 }, { width: 8 }, { width: 14 }];
        const eurFmt = '€ #,##0.00';
        const bold = { bold: true };
        sheet.addRow([profile.companyName]).font = { bold: true, size: 14, color: { argb: NAVY } };
        for (const infoLine of [profile.address, [profile.phone, profile.email].filter(Boolean).join(' · '), [profile.kvk && `KvK ${profile.kvk}`, profile.vatNumber && `Btw ${profile.vatNumber}`, profile.iban && `IBAN ${profile.iban}`].filter(Boolean).join(' · ')]) {
          if (infoLine) sheet.addRow([infoLine.replace(/\n/g, ', ')]);
        }
        sheet.addRow([]);
        const info = [
          ['Offerte', quote.number], ['Datum', data.date ? new Date(`${data.date}T12:00:00`) : ''], ['Geldig tot', data.validUntil ? new Date(`${data.validUntil}T12:00:00`) : ''],
          ['Klant', data.customer.name], ['T.a.v.', data.customer.contact], ['Adres', data.customer.address.replace(/\n/g, ', ')], ['Afleveradres', data.delivery && data.delivery.same === false ? data.delivery.address.replace(/\n/g, ', ') : ''],
          ['E-mail', data.customer.email], ['Telefoon', data.customer.phone], ['Uw referentie', data.reference], ['Omschrijving', data.title],
          ['Status', statusLabel(statusOf({ ...quote, validUntil: data.validUntil }))],
        ].filter(([, value]) => value !== '');
        for (const [label, value] of info) {
          const row = sheet.addRow([label, value]);
          row.getCell(1).font = bold;
          if (value instanceof Date) row.getCell(2).numFmt = 'dd-mm-yyyy';
          row.getCell(2).alignment = { horizontal: 'left' };
        }
        sheet.addRow([]);
        const head = sheet.addRow(['Artikelcode', 'Omschrijving', 'Aantal', 'Eenheid', 'Prijs', 'Btw %', 'Totaal']);
        head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
        const firstRow = head.number + 1;
        const subtotalCells = [];
        for (const [key, label] of Object.entries(QuoteCore.SECTIONS)) {
          const lines = data.lines.filter((line) => line.section === key);
          if (!lines.length) continue;
          const sectionRow = sheet.addRow(['', label]);
          sectionRow.font = { bold: true, color: { argb: NAVY } };
          const start = sectionRow.number + 1;
          for (const line of lines) {
            const notChosen = !QuoteCore.included(line);
            const row = sheet.addRow([line.code, `${line.description}${line.optional ? (notChosen ? ' (optie, niet gekozen)' : ' (optie)') : ''}`, line.qty, line.unit, line.price, QuoteCore.vatShifted(data) ? 'verlegd' : line.vat]);
            // Een niet gekozen optie telt niet mee in de totalen.
            row.getCell(7).value = notChosen ? 0 : { formula: `C${row.number}*E${row.number}` };
            if (notChosen) row.font = { italic: true, color: { argb: 'FF8A96A3' } };
            row.getCell(5).numFmt = eurFmt;
            row.getCell(7).numFmt = eurFmt;
          }
          const end = sheet.lastRow.number;
          const sumRow = sheet.addRow(['', `Totaal ${label.toLowerCase()}`]);
          sumRow.getCell(7).value = { formula: `SUM(G${start}:G${end})` };
          sumRow.getCell(7).numFmt = eurFmt;
          sumRow.font = bold;
          subtotalCells.push(`G${sumRow.number}`);
        }
        const lastRow = sheet.lastRow.number;
        sheet.addRow([]);
        /**
         * Voegt een regel onder de totalen toe.
         * @param {string} label tekst voor de regel
         * @param {object|number} formula formule of waarde
         * @param {string} numberFormat celopmaak (standaard euro)
         * @returns {number} rijnummer van de nieuwe regel
         */
        const addTotalRow = (label, formula, numberFormat = eurFmt) => {
          const row = sheet.addRow(['', '', '', '', '', label]);
          row.getCell(7).value = formula;
          row.getCell(7).numFmt = numberFormat;
          row.getCell(6).alignment = { horizontal: 'right' };
          row.getCell(6).font = bold;
          row.getCell(7).font = bold;
          return row.number;
        };
        const subtotalRow = addTotalRow('Subtotaal', { formula: subtotalCells.length ? subtotalCells.join('+') : '0' });
        const discountTotals = QuoteCore.totals(data);
        let discountRow;
        if (discountTotals.discountType === 'amount') {
          // Vast bedrag: de regel met het bedrag en daaronder het percentage dat de btw-berekening gebruikt.
          const amountRow = addTotalRow(QuoteCore.discountCaption(discountTotals, 'Korting (€)', ''), discountTotals.discount);
          discountRow = addTotalRow('Korting %', { formula: `IF(G${subtotalRow}=0,0,G${amountRow}/G${subtotalRow})` }, '0.0%');
        } else {
          discountRow = addTotalRow(QuoteCore.discountCaption(discountTotals, 'Korting', nl(discountTotals.discountPct)), data.discountPct / 100, '0.0%');
        }
        const netRow = addTotalRow('Excl. btw', { formula: `G${subtotalRow}*(1-G${discountRow})` });
        const vatRows = [];
        // Btw per tarief: de regels met dat tarief, na korting.
        for (const rate of QuoteCore.VAT_RATES) {
          if (QuoteCore.vatShifted(data)) break;
          if (!data.lines.some((line) => line.vat === rate && QuoteCore.included(line))) continue;
          vatRows.push(addTotalRow(`Btw ${rate}%`, { formula: `SUMIF(F${firstRow}:F${lastRow},${rate},G${firstRow}:G${lastRow})*(1-G${discountRow})*${rate / 100}` }));
        }
        const grand = addTotalRow(QuoteCore.vatShifted(data) ? 'Totaal (btw verlegd)' : 'Totaal incl. btw', { formula: `G${netRow}${vatRows.map((rowNumber) => `+G${rowNumber}`).join('')}` });
        sheet.getRow(grand).getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF19924F' } };
        sheet.getRow(grand).getCell(7).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        for (const [title, text] of [['Inleiding', data.intro], ['Voorwaarden', data.terms]]) {
          if (!text) continue;
          sheet.addRow([]);
          sheet.addRow([title]).font = bold;
          const row = sheet.addRow(['', text]);
          row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
          row.height = Math.min(400, 15 * Math.ceil(text.length / 80 + (text.match(/\n/g) || []).length));
        }
        download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offerte_${safeName(quote.number)}${data.customer.name ? `_${safeName(data.customer.name)}` : ''}.xlsx`);
      } catch (error) {
        console.error(error);
        toast(`Export mislukt: ${error.message}`, true);
      }
    }

    return { printQuote, download, XLSX_TYPE, NAVY, exportQuoteXlsx };
  };
})();
