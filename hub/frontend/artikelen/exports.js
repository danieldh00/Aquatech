// Artikelen: Excel-export van de voorraad, de mutaties en het bestelvoorstel, plus de gedeelde Excel-hulpfuncties
// (werkmap maken, downloaden, datumstempel). Staat los van artikelen.js; die geeft via setup() de gedeelde state mee.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  const WorkOrderCore = window.WorkOrderCore;
  let state; let api; let toast; let visible; let valuesText; let loadMoves; let movesShown; let KINDS;

  /**
   * Geeft de module wat hij van de pagina nodig heeft (gedeelde state en hulpfuncties van artikelen.js).
   * @param {object} context state, api, toast, visible, valuesText, loadMoves, movesShown en KINDS uit artikelen.js
   * @returns {void}
   */
  function setup(context) {
    ({ state, api, toast, visible, valuesText, loadMoves, movesShown, KINDS } = context);
  }

  // ---------- Excel ----------
  /**
   * Maakt een nieuwe Excel-werkmap (laadt ExcelJS zo nodig).
   * @returns {Promise<object|null>} de werkmap, of null als Excel niet beschikbaar is
   */
  async function workbook() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return null; }
    const excelWorkbook = new ExcelJS.Workbook();
    excelWorkbook.creator = 'AquaTech Service';
    excelWorkbook.created = new Date();
    return excelWorkbook;
  }

  /**
   * Voegt het blad Mutaties toe.
   * @param {object} excelWorkbook de werkmap
   * @param {object[]} items de mutaties
   */
  function movesSheet(excelWorkbook, items) {
    const worksheet = excelWorkbook.addWorksheet('Mutaties', { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = [
      { header: 'Datum', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      { header: 'Soort', key: 'kind', width: 12 },
      { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Omschrijving', key: 'name', width: 40 },
      { header: 'Aantal', key: 'qty', width: 10, style: { numFmt: '#,##0.###' } },
      { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Stand na mutatie', key: 'balance', width: 16, style: { numFmt: '#,##0.###' } },
      { header: 'Werkorder', key: 'wo', width: 14 },
      { header: 'Door', key: 'user', width: 20 },
      { header: 'Opmerking', key: 'note', width: 40 },
    ];
    for (const movement of items) {
      worksheet.addRow({ at: new Date(movement.createdAt), kind: KINDS[movement.kind] || movement.kind, code: movement.code, name: movement.name, qty: movement.qty, unit: movement.unit, balance: movement.balance,
        wo: movement.workOrderNumber, user: movement.userName, note: movement.note });
    }
    worksheet.getRow(1).font = { bold: true };
    worksheet.autoFilter = { from: 'A1', to: 'J1' };
  }

  /**
   * Laat de werkmap downloaden.
   * @param {object} excelWorkbook de werkmap
   * @param {string} name bestandsnaam
   * @returns {Promise<void>}
   */
  async function save(excelWorkbook, name) {
    const buffer = await excelWorkbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Geeft de datum van vandaag voor in een bestandsnaam.
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const stamp = () => new Date().toISOString().slice(0, 10);

  /**
   * Exporteert de zichtbare voorraad en de reserveringen naar Excel.
   * @returns {Promise<void>}
   */
  async function exportStock() {
    const exportButton = $('#b-export');
    exportButton.disabled = true;
    try {
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      const worksheet = excelWorkbook.addWorksheet('Voorraad', { views: [{ state: 'frozen', ySplit: 1 }] });
      const quantityStyle = { numFmt: '#,##0.###' };
      worksheet.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Omschrijving', key: 'name', width: 44 },
        { header: 'Artikelgroep', key: 'articleGroup', width: 16 },
        { header: 'Subartikel', key: 'subItem', width: 22 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Locatie', key: 'location', width: 18 },
        { header: 'Op voorraad', key: 'onHand', width: 13, style: quantityStyle },
        { header: 'Gereserveerd', key: 'reserved', width: 13, style: quantityStyle },
        { header: 'Beschikbaar', key: 'available', width: 13, style: quantityStyle },
        { header: 'Minimum', key: 'minQty', width: 11, style: quantityStyle },
        { header: 'Bestellen tot', key: 'reorderQty', width: 13, style: quantityStyle },
        { header: 'Bijbestellen', key: 'low', width: 12 },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Waarde', key: 'value', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Verkoopprijs excl. btw', key: 'salePrice', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Btw', key: 'vat', width: 7 },
        { header: 'Omzetgroep', key: 'group', width: 12 },
        { header: 'Webshop', key: 'shop', width: 16 },
        { header: 'Gearchiveerd', key: 'archived', width: 13 },
        { header: 'Notities', key: 'notes', width: 30 },
      ];
      const GROUPS = { producten: 'Producten', arbeid: 'Arbeid', overig: 'Overig' };
      // Artikelgroepen hebben geen eigen voorraad: alleen de subartikelen (met hun artikelgroep) komen erin.
      const codeOf = new Map(state.items.map((item) => [item.id, item.code]));
      // Past de artikelgroep bij de zoekterm, dan gaan al zijn subartikelen mee (zoals in het overzicht).
      const matched = visible();
      const matchedGroup = new Set(matched.filter((item) => item.isGroup).map((item) => item.id));
      const matchedIds = new Set(matched.map((item) => item.id));
      // Met "Alleen onder minimum" telt per subartikel het eigen minimum (zoals in het overzicht).
      const lowOnly = $('#f-low').checked;
      const items = state.items.filter((item) => !item.isGroup && (matchedIds.has(item.id) || (item.groupId && matchedGroup.has(item.groupId) && (!lowOnly || item.low))));
      for (const item of items) {
        worksheet.addRow({ ...item, articleGroup: item.groupId ? codeOf.get(item.groupId) || '' : '', subItem: valuesText(item), low: item.low ? 'ja' : '', archived: item.archived ? 'ja' : '', costPrice: item.costPrice, value: item.value, salePrice: item.salePrice,
          vat: `${item.vatRate}%`, group: GROUPS[item.revenueGroup] || item.revenueGroup,
          shop: !item.shopSync ? 'concept' : item.shop.error ? 'fout' : item.shop.productId ? `product ${item.shop.productId}` : 'niet gekoppeld' });
      }
      worksheet.getRow(1).font = { bold: true };
      worksheet.autoFilter = `A1:T${items.length + 1}`;
      const reservedSheet = excelWorkbook.addWorksheet('Gereserveerd', { views: [{ state: 'frozen', ySplit: 1 }] });
      reservedSheet.columns = [
        { header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Titel', key: 'title', width: 30 }, { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Status', key: 'status', width: 14 }, { header: 'Gepland', key: 'date', width: 12 },
        { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 40 },
        { header: 'Gereserveerd', key: 'qty', width: 13, style: quantityStyle }, { header: 'Eenheid', key: 'unit', width: 9 },
      ];
      for (const reservation of state.reservations) {
        reservedSheet.addRow({ wo: reservation.workOrder.number, title: reservation.workOrder.title, customer: reservation.workOrder.customer, status: (WorkOrderCore && WorkOrderCore.STATUSES[reservation.workOrder.status]) || reservation.workOrder.status,
          date: reservation.workOrder.plannedDate ? new Date(`${reservation.workOrder.plannedDate}T12:00:00`) : null, code: reservation.code, name: reservation.name, qty: reservation.qty, unit: reservation.unit });
      }
      reservedSheet.getColumn('date').numFmt = 'dd-mm-yyyy';
      reservedSheet.getRow(1).font = { bold: true };
      await save(excelWorkbook, `voorraad-${stamp()}.xlsx`);
    } finally {
      exportButton.disabled = false;
    }
  }

  /**
   * Exporteert de mutaties in beeld naar Excel.
   * @returns {Promise<void>}
   */
  async function exportMoves() {
    const exportButton = $('#m-export');
    exportButton.disabled = true;
    try {
      if (!state.moves) await loadMoves();
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      movesSheet(excelWorkbook, movesShown());
      await save(excelWorkbook, `voorraadmutaties-${$('#m-from').value || 'begin'}-${$('#m-to').value || stamp()}.xlsx`);
    } finally {
      exportButton.disabled = false;
    }
  }

  /**
   * Bestelvoorstel als Excel: per artikel onder het minimum hoeveel er bij
   * moet om aan te vullen tot "bestellen tot" (de server rekent het uit).
   * @returns {Promise<void>}
   */
  async function exportReorder() {
    const button = $('#b-reorder');
    button.disabled = true;
    try {
      const proposal = await api('stock/reorder');
      if (!proposal.items.length) { toast('Niets te bestellen: alle artikelen zitten op of boven de minimumvoorraad.'); return; }
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      const sheet = excelWorkbook.addWorksheet('Bestelvoorstel', { views: [{ state: 'frozen', ySplit: 1 }] });
      const quantity = { numFmt: '#,##0.###' };
      const euro = { numFmt: '€ #,##0.00' };
      sheet.columns = [
        { header: 'Leverancier', key: 'supplierName', width: 24 },
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Art.nr. leverancier', key: 'supplierSku', width: 18 },
        { header: 'Omschrijving', key: 'name', width: 44 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Locatie', key: 'location', width: 18 },
        { header: 'Op voorraad', key: 'onHand', width: 13, style: quantity },
        { header: 'Gereserveerd', key: 'reserved', width: 13, style: quantity },
        { header: 'Beschikbaar', key: 'available', width: 13, style: quantity },
        { header: 'Minimum', key: 'minQty', width: 11, style: quantity },
        { header: 'Bestellen tot', key: 'target', width: 13, style: quantity },
        { header: 'Te bestellen', key: 'orderQty', width: 13, style: quantity },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: euro },
        { header: 'Bedrag', key: 'amount', width: 12, style: euro },
      ];
      // Per leverancier bij elkaar (op naam, zonder leverancier als laatste), zoals de server de groepen geeft.
      const groupOrder = new Map(proposal.suppliers.map((group, index) => [group.supplierId, index]));
      const sorted = [...proposal.items].sort((left, right) => groupOrder.get(left.supplierId) - groupOrder.get(right.supplierId));
      for (const item of sorted) sheet.addRow({ ...item, supplierName: item.supplierName || 'Zonder leverancier' });
      const totalRow = sheet.addRow({ name: 'Totaal (artikelen met inkoopprijs)', amount: proposal.total });
      totalRow.font = { bold: true };
      sheet.getRow(1).font = { bold: true };
      // Filter over de kop en de artikelregels, zonder de totaalregel.
      sheet.autoFilter = `A1:N${proposal.items.length + 1}`;
      const summary = excelWorkbook.addWorksheet('Per leverancier', { views: [{ state: 'frozen', ySplit: 1 }] });
      summary.columns = [
        { header: 'Leverancier', key: 'supplierName', width: 28 },
        { header: 'Regels', key: 'count', width: 10 },
        { header: 'Bedrag (artikelen met inkoopprijs)', key: 'total', width: 34, style: euro },
      ];
      for (const group of proposal.suppliers) summary.addRow({ ...group, supplierName: group.supplierName || 'Zonder leverancier' });
      summary.getRow(1).font = { bold: true };
      await save(excelWorkbook, `bestelvoorstel-${stamp()}.xlsx`);
    } finally {
      button.disabled = false;
    }
  }

  window.ArtikelenExports = { setup, workbook, save, stamp, exportStock, exportMoves, exportReorder };
})();
