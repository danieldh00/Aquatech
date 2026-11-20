// Offertes: bulkacties op de offertelijst (mailen, sluiten) en de Excel-export van de lijst.
// Het bestand zet een fabriek op window.Offertes; offertes.js geeft de gedeelde
// hulpfuncties en de stand (context) mee en gebruikt wat de fabriek teruggeeft.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Bouwt de functies voor bulkacties op de offertelijst (mailen, sluiten) en de Excel-export van de lijst.
   * @param {object} context gedeelde hulpfuncties en stand uit offertes.js: QuoteCore, statusOf, statusLabel, state, toast, api, showAll, loadList, visible, shareBase, download, XLSX_TYPE, NAVY, $
   * @returns {object} de functies die offertes.js zelf nodig heeft: renderBulkBar, mailSelected, closeSelected, exportListXlsx
   */
  window.Offertes.createBulk = function (context) {
    const { QuoteCore, statusOf, statusLabel, state, toast, api, showAll, loadList, visible, shareBase, download, XLSX_TYPE, NAVY, $ } = context;

    // ---------- Bulkacties ----------
    /**
     * Geeft de geselecteerde offertes die nu zichtbaar zijn (door zoekveld en statusfilter); verborgen offertes tellen niet mee in de bulkacties.
     * @returns {object[]} de geselecteerde, zichtbare offertes
     */
    const selectedQuotes = () => visible().filter((quote) => state.selected.has(quote.id));

    /**
     * Of een offerte nog open is: concept of verzonden en niet omgezet (de server weigert het daarna als de klant al antwoordde).
     * @param {object} quote de offerte uit de lijst
     * @returns {boolean} true als hij open is
     */
    const isOpenQuote = (quote) => !quote.order && ['concept', 'verzonden'].includes(quote.status);

    /** Toont of verbergt de balk met bulkacties en werkt het aantal bij. */
    function renderBulkBar() {
      for (const id of [...state.selected]) if (!state.items.some((quote) => quote.id === id)) state.selected.delete(id);
      const chosen = selectedQuotes();
      const bar = $('#l-bulk');
      bar.hidden = !chosen.length;
      $('#l-bulk-count').textContent = `${chosen.length} geselecteerd`;
      const closable = chosen.filter(isOpenQuote);
      $('#l-bulk-mail').hidden = !state.mail;
      $('#l-bulk-mail').disabled = !closable.length || closable.length > MAX_BULK_MAIL;
      $('#l-bulk-mail').textContent = closable.length > MAX_BULK_MAIL ? `Versturen per e-mail (max. ${MAX_BULK_MAIL})` : `Versturen per e-mail (${closable.length})`;
      $('#l-bulk-close').disabled = !closable.length;
      $('#l-bulk-close').textContent = `Afsluiten als afgewezen (${closable.length})`;
      $('#l-export').textContent = chosen.length ? `Exporteer selectie (${chosen.length}) naar Excel` : 'Exporteer naar Excel';
    }

    /** Hoeveel offertes in één keer gemaild mogen worden (gelijk aan de grens op de server). */
    const MAX_BULK_MAIL = 10;

    /**
     * Mailt de geselecteerde open offertes met het standaardbericht naar het e-mailadres van de klant op de offerte; vooraf één bevestiging met het aantal.
     * @returns {Promise<void>}
     */
    async function mailSelected() {
      const mailable = selectedQuotes().filter(isOpenQuote);
      if (!mailable.length) return;
      if (mailable.length > MAX_BULK_MAIL) { toast(`Hoogstens ${MAX_BULK_MAIL} offertes per keer mailen; je hebt er ${mailable.length} gekozen.`, true); return; }
      if (!confirm(`${mailable.length} ${mailable.length === 1 ? 'offerte' : 'offertes'} nu per e-mail versturen aan de klant? Elke klant krijgt het standaardbericht met de link om de offerte te bekijken en akkoord te geven. Offertes zonder geldig e-mailadres worden overgeslagen.`)) return;
      const button = $('#l-bulk-mail');
      button.disabled = true;
      try {
        const result = await api('quotes-bulk/send', { method: 'POST', body: { ids: mailable.map((quote) => quote.id), url: shareBase() } });
        for (const entry of result.sent) state.selected.delete(entry.id);
        await loadList();
        const skipped = result.skipped.map((entry) => `${entry.number || 'offerte'}: ${entry.reason}`);
        toast(`${result.sent.length} ${result.sent.length === 1 ? 'offerte' : 'offertes'} verstuurd${skipped.length ? `; overgeslagen: ${skipped.join('; ')}` : ''}`, skipped.length > 0);
      } catch (error) {
        toast(error.message, true);
        renderBulkBar();
      }
    }

    /**
     * Zet de geselecteerde open offertes (concept of verzonden) op afgewezen; een offerte die de klant al beantwoordde of is omgezet blijft staan.
     * @returns {Promise<void>}
     */
    async function closeSelected() {
      const closable = selectedQuotes().filter(isOpenQuote);
      if (!closable.length) return;
      if (!confirm(`${closable.length} ${closable.length === 1 ? 'offerte' : 'offertes'} afsluiten als afgewezen? Je kunt de status per offerte weer aanpassen.`)) return;
      const button = $('#l-bulk-close');
      button.disabled = true;
      let done = 0;
      const skipped = [];
      for (const quote of closable) {
        try {
          await api(`quotes/${encodeURIComponent(quote.id)}`, { method: 'PUT', body: { status: 'afgewezen' } });
          done += 1;
          state.selected.delete(quote.id);
        } catch (error) {
          skipped.push(`${quote.number}: ${error.message}`);
        }
      }
      await loadList();
      toast(`${done} ${done === 1 ? 'offerte' : 'offertes'} afgesloten${skipped.length ? `; overgeslagen: ${skipped.join('; ')}` : ''}`, skipped.length > 0);
    }

    /**
     * Exporteert de zichtbare offertes als Excel-bestand.
     * @returns {Promise<void>}
     */
    async function exportListXlsx() {
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
      const chosen = selectedQuotes();
      const items = chosen.length ? chosen : visible();
      try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'AquaTech Service';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Offertes', { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = [
          { header: 'Nummer', key: 'number', width: 16 },
          { header: 'Omschrijving', key: 'title', width: 40 },
          { header: 'Klant', key: 'customer', width: 28 },
          ...(showAll() ? [{ header: 'Gebruiker', key: 'owner', width: 20 }] : []),
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Excl. btw', key: 'totalExcl', width: 14, style: { numFmt: '€ #,##0.00' } },
          { header: 'Incl. btw', key: 'totalIncl', width: 14, style: { numFmt: '€ #,##0.00' } },
          { header: 'Geldig tot', key: 'validUntil', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
          { header: 'Aangemaakt', key: 'createdAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
          { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        ];
        for (const quote of items) {
          sheet.addRow({
            number: quote.number, title: quote.title, customer: quote.customer, owner: quote.owner ? quote.owner.displayName : '', status: statusLabel(statusOf(quote)),
            totalExcl: quote.totalExcl, totalIncl: quote.totalIncl, validUntil: quote.validUntil ? new Date(`${quote.validUntil}T12:00:00`) : null,
            createdAt: new Date(quote.createdAt), updatedAt: new Date(quote.updatedAt),
          });
        }
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
        download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offertes_${QuoteCore.today()}.xlsx`);
        toast(`${items.length} offertes geëxporteerd`);
      } catch (error) {
        toast(`Export mislukt: ${error.message}`, true);
      }
    }

    return { renderBulkBar, mailSelected, closeSelected, exportListXlsx };
  };
})();
