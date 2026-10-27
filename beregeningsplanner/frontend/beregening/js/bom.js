/* Stuklijst-generatie en export naar Excel (.xlsx). */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;
  const Hydraulics = window.Hydraulics;

  /**
   * Bouwt de stuklijst op basis van de actuele berekening.
   * @param {object} state de planstand
   * @returns {object[]} regels (code, naam, eenheid, prijs, aantal, opmerkingen, totaal); `rows.missing` = artikelen buiten het eigen assortiment
   */
  function build(state) {
    const calc = state.calc || Hydraulics.calculate(state);
    const level = state.settings.level || 'expert';
    const items = new Map();
    // Met een eigen assortiment (Catalog.setAssortment) alleen artikelen die
    // erin staan; wat ontbreekt komt in rows.missing (niet in de stuklijst).
    const missing = new Map();
    const pick = Catalog.pick || ((...codes) => codes[0]);
    /**
     * Telt een artikel op in de stuklijst (of bij de ontbrekende artikelen als het niet in het assortiment staat).
     * @param {string} code artikelcode
     * @param {number} qty aantal (0 of minder = niets)
     * @param {string} note opmerking bij de regel
     */
    const add = (code, qty, note) => {
      if (!qty || qty <= 0) return;
      const article = Catalog.articles[code];
      if (!article) throw new Error(`Onbekend artikel ${code}`);
      if (Catalog.available && !Catalog.available(code)) {
        const missingRow = missing.get(code) || { code, name: article.name, unit: article.unit, qty: 0 };
        missingRow.qty += qty;
        missing.set(code, missingRow);
        return;
      }
      const row = items.get(code) || { code, name: article.name, unit: article.unit, price: article.price, sku: article.sku || '', url: article.url || '', shop: Boolean(article.shop), qty: 0, notes: new Set() };
      row.qty += qty;
      if (note) row.notes.add(note);
      items.set(code, row);
    };

    // Sproeiers: gekozen behuizing en nozzle uit de bibliotheek, anders de generieke artikelen
    for (const sprinkler of state.sprinklers) {
      const inBed = Boolean(sprinkler.areaId); // in beplanting: hoger sproeierhuis (30 cm)
      /**
       * Geeft een onderdeel uit de bibliotheek alleen terug als de catalogus het kent en het in het assortiment staat.
       * @param {object|null} part behuizing of nozzle
       * @returns {object|null} het onderdeel, of null (dan het generieke artikel)
       */
      const known = (part) => (part && part.code && Catalog.articles[part.code] && (!Catalog.available || Catalog.available(part.code)) ? part : null);
      const body = known(Catalog.bodyOf(sprinkler));
      const nozzle = known(Catalog.nozzleOf(sprinkler));
      if (sprinkler.type === 'spray') {
        if (body) add(body.code, 1, inBed ? 'beplanting' : '');
        else add(inBed ? pick('SPR-POP30-PRS', 'SPR-POP10-PRS', 'SPR-POP10') : level === 'eco' ? pick('SPR-POP10', 'SPR-POP10-PRS') : pick('SPR-POP10-PRS', 'SPR-POP10'), 1, inBed ? 'beplanting' : '');
        add(nozzle ? nozzle.code : 'SPR-VAN', 1);
        add(level === 'eco' ? pick('CON-ECO', 'CON-FLEX') : pick('CON-FLEX', 'CON-ECO'), 1);
      } else if (sprinkler.type === 'rotator' || sprinkler.type === 'strip') {
        if (body) add(body.code, 1, inBed ? 'beplanting' : '');
        else add(inBed ? pick('ROT-POP30-PRS', 'ROT-POP10-PRS') : 'ROT-POP10-PRS', 1, inBed ? 'beplanting' : '');
        add(sprinkler.type === 'strip' ? 'ROT-STRIP' : nozzle ? nozzle.code : Catalog.rotatorModels[Catalog.rotatorModelOf(sprinkler)].code, 1);
        add(level === 'eco' ? pick('CON-ECO', 'CON-FLEX') : pick('CON-FLEX', 'CON-ECO'), 1);
      } else if (sprinkler.type === 'rotor') {
        // een rotor wordt geleverd met nozzleset; de gekozen nozzle staat in de instelling
        if (body) add(body.code, 1, nozzle ? `nozzle ${nozzle.name}` : '');
        else add(level === 'premium' ? pick('TURB-10-PRO', 'TURB-10') : pick('TURB-10', 'TURB-10-PRO'), 1);
        if (nozzle) add(nozzle.code, 1);
        add(level === 'eco' ? pick('CON-ECO', 'CON-FLEX-TURB') : pick('CON-FLEX-TURB', 'CON-ECO'), 1);
      }
    }

    // Leidingen (+10% reserve, afgerond op hele meters)
    const meters = {};
    for (const pipe of calc.pipes) meters[pipe.dn] = (meters[pipe.dn] || 0) + pipe.len;
    for (const dn of Object.keys(meters)) add(`PE-${dn}`, Math.ceil(meters[dn] * 1.1), 'incl. 10% reserve');

    // Hulpstukken per zone (op basis van boomstructuur)
    let reducers = 0;
    for (const zoneResult of calc.zones) {
      if (zoneResult.empty) continue;
      const { degree, dnAt, edges, members } = zoneResult;
      /**
       * Grootste leidingmaat bij een knoop (inkomend of uitgaand).
       * @param {number} i index van de knoop
       * @returns {number} nominale maat (minstens 25)
       */
      const largestDnAt = (i) => {
        let nominal = dnAt[i] || 0;
        for (const edge of edges) if (edge.from === i) nominal = Math.max(nominal, edge.dn);
        return nominal || 25;
      };
      for (let i = 1; i < degree.length; i++) {
        const member = members[i - 1];
        const nominal = Math.min(largestDnAt(i), 32);
        if (member.kind === 'drip') {
          add('DRIP-ADAPT', 1);
          if (degree[i] >= 2) add(`FIT-T-${nominal}`, degree[i] - 1);
          continue;
        }
        if (degree[i] >= 2) add(`FIT-T-${nominal}`, degree[i] - 1);
        else add(`FIT-L-${nominal}`, 1);
      }
      if (degree[0] > 1) add(`FIT-T-${largestDnAt(0)}`, degree[0] - 1);
      add('FIT-ADAPT', 1);
      for (const edge of edges) if (edge.from > 0 && dnAt[edge.from] && dnAt[edge.from] !== edge.dn) reducers++;
    }
    add('FIT-RED', reducers);

    // Druppelirrigatie: druppelslang en/of losse druppelaars
    let dripM = 0, dripRuns = 0, supplyM = 0, supplyRuns = 0, drippers = 0, microM = 0;
    const dripZones = new Set();
    for (const area of Hydraulics.dripAreas(state)) {
      const drip = Hydraulics.dripInfo(area, Hydraulics.methodOf(state, area));
      if (area.zone) dripZones.add(area.zone);
      if (drip.method === 'drippers') {
        drippers += drip.count;
        microM += drip.microM;
        supplyM += drip.supplyM;
        supplyRuns += drip.runs;
        add('DRIP-T', Math.max(1, drip.runs - 1) + (area.type === 'planter' ? 1 : 0));
      } else {
        dripM += drip.lengthM;
        dripRuns += drip.runs;
        add('DRIP-T', Math.max(2, Math.ceil(drip.lengthM / 10)));
      }
    }
    if (dripM) {
      add('DRIP-16', Math.ceil(dripM * 1.05), 'incl. 5% reserve');
      add('DRIP-PIN', Math.ceil(dripM));
      if (level !== 'eco') add('DRIP-FLUSH', dripRuns);
    }
    if (drippers) {
      add('DRIP-PE16', Math.ceil(supplyM * 1.05), 'aanvoer druppelaars, incl. 5% reserve');
      add('DRIPPER-2', drippers);
      add('MICRO-46', Math.ceil(microM * 1.1), 'incl. 10% reserve');
      add('MICRO-CON', drippers * 2);
      add('MICRO-PIN', drippers);
      add('DRIP-PIN', Math.ceil(supplyM));
      add('PUNCH', 1);
    }
    if (dripM || drippers) {
      add('DRIP-END', (dripRuns + supplyRuns) * 2);
      add('DRIP-PRV', Math.max(1, dripZones.size));
    }

    // Ventielen, kast, besturing
    const zoneCount = calc.zones.filter((zone) => !zone.empty).length;
    if (zoneCount) {
      add(level === 'premium' ? pick('VAL-24V-FC', 'VAL-24V') : pick('VAL-24V', 'VAL-24V-FC'), zoneCount);
      add('VAL-MANIFOLD', zoneCount);
      // Ventielkasten: zonder jumbo alleen standaardkasten (en andersom).
      const jumbo = Catalog.available ? Catalog.available('BOX-JUMBO') : true;
      const standardBox = Catalog.available ? Catalog.available('BOX-STD') : true;
      let left = zoneCount;
      while (left > 0) {
        if ((left > 3 && jumbo) || !standardBox) { add('BOX-JUMBO', 1); left -= 6; } else { add('BOX-STD', 1); left -= 3; }
      }
      add(level === 'eco' ? pick('CTRL-ECO', 'CTRL-WIFI') : pick('CTRL-WIFI', 'CTRL-ECO'), 1, `${zoneCount} stations nodig`);
      if (level !== 'eco') add('SEN-RAIN', 1);
      if (level === 'premium') add('SEN-SOIL', 1);

      const controller = state.elements.find((element) => element.kind === 'controller');
      const cableLen = controller ? Math.ceil(Geo.dist(controller, calc.vb) * 1.2 + 3) : 10;
      const cores = zoneCount + 1;
      const cables = Math.ceil(cores / 13);
      const cableCode = cores <= 7 ? pick('CAB-7', 'CAB-13') : 'CAB-13';
      add(cableCode, cableLen * (cableCode === 'CAB-7' ? 1 : cables));
      add('CAB-CON', cores * 2);
      add('MAIN-VALVE', 1);
      add('BACKFLOW', 1);
      add('FILTER', 1);
      add('TAPE', Math.max(1, Math.ceil(zoneCount / 4)));
    }

    const outlets = state.elements.filter((element) => element.kind === 'outlet').length;
    if (outlets) {
      add('OUTLET', outlets);
      add('FIT-T-32', outlets);
    }

    const order = Object.keys(Catalog.articles);
    /**
     * Sorteert regels in de volgorde van de catalogus.
     * @param {{code: string}} left regel
     * @param {{code: string}} right regel
     * @returns {number} sorteervolgorde
     */
    const byCatalogOrder = (left, right) => order.indexOf(left.code) - order.indexOf(right.code);
    const rows = Array.from(items.values())
      .sort(byCatalogOrder)
      .map((row) => ({ ...row, notes: Array.from(row.notes).join('; '), total: row.qty * row.price }));
    rows.missing = Array.from(missing.values()).sort(byCatalogOrder);
    return rows;
  }

  /**
   * Beregeningsschema: looptijd per zone voor de gewenste weekgift.
   * @param {object} state de planstand (met state.calc)
   * @returns {object[]} per zone de neerslag, minuten per week en per beurt
   */
  function schedule(state) {
    const calc = state.calc;
    const mmWeek = state.settings.targetMm || 20;
    const sessions = Math.max(1, state.settings.sessions || 3);
    return calc.zones.filter((zone) => !zone.empty).map((zoneResult) => {
      let precipitation;
      if (zoneResult.zone.group === 'drip' || zoneResult.zone.group === 'drippers') {
        // gemiddelde gift over de beplante oppervlakte van de zone
        const lph = zoneResult.members.reduce((sum, member) => sum + member.q, 0);
        const area = zoneResult.members.reduce((sum, member) => sum + (member.drip ? member.drip.areaM2 : 0), 0);
        precipitation = area > 0 ? lph / area : Catalog.drip.lphPerM / Catalog.drip.rowSpacingBed;
      } else {
        precipitation = Catalog.groups[zoneResult.zone.group].pr;
      }
      const minutesWeek = (mmWeek / precipitation) * 60;
      return { zone: zoneResult.zone, pr: precipitation, minutesWeek, minutesSession: minutesWeek / sessions, sessions };
    });
  }

  /**
   * Formatteert een datum kort.
   * @param {Date} date de datum
   * @returns {string} bijv. '27-10-2026'
   */
  function formatDate(date) {
    return date.toLocaleDateString('nl-NL', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  /**
   * Exporteert planning + stuklijst naar een Excel-werkmap.
   * @param {object} state de planstand
   * @param {string} planImageDataUrl afbeelding van het plan (PNG als data-URL), of leeg
   * @returns {Promise<{blob: Blob, filename: string}>} het bestand
   */
  async function exportXlsx(state, planImageDataUrl) {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) throw new Error('ExcelJS niet geladen');
    const calc = Hydraulics.calculate(state);
    const rows = build(state);
    const scheduleRows = schedule(state);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aquatech Beregeningsplanner';
    workbook.created = new Date();

    /**
     * Geeft een kopregel de huisstijl (wit op blauw, vet).
     * @param {object} row ExcelJS-rij
     */
    const headerStyle = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0277BD' } };
      row.alignment = { vertical: 'middle' };
    };
    const eur = '€ #,##0.00';

    // 1. Projectinfo
    const info = workbook.addWorksheet('Project');
    info.columns = [{ width: 32 }, { width: 50 }];
    const levelInfo = Catalog.levels[state.settings.level] || Catalog.levels.expert;
    const totalArea = state.areas.filter((area) => area.type === 'lawn').reduce((sum, area) => sum + Geo.area(area.pts), 0);
    const meta = state.meta || {};
    /**
     * Een veld uit het project altijd als tekst: een object (bijv. { formula })
     * zou ExcelJS als formule in het werkblad zetten.
     * @param {*} value De waarde uit state.meta.
     * @returns {string} De tekst (leeg als het geen tekst of getal is).
     */
    const metaText = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
    [
      ['Beregeningsplan', metaText(meta.name) || 'Nieuw project'],
      ['Klant', metaText(meta.customer)],
      ['Adres', metaText(meta.address)],
      ['Datum', formatDate(new Date())],
      ['Uitvoeringsniveau', `${levelInfo.label} – ${levelInfo.desc}`],
      [],
      ['Waterdruk (dynamisch)', `${Geo.nlShort(state.settings.pressure, 2)} bar`],
      ['Beschikbaar debiet', `${Geo.nlShort(state.settings.flow, 2)} m³/u`],
      ['Max. debiet per zone', `${Geo.nl(calc.maxQ / 1000, 2)} m³/u`],
      ['Gazonoppervlak', `${Geo.nl(totalArea, 1)} m²`],
      ['Aantal sproeiers', state.sprinklers.length],
      ['Aantal zones', calc.zones.filter((zone) => !zone.empty).length],
      ['Weekgift (doel)', `${state.settings.targetMm} mm in ${state.settings.sessions} beurten`],
    ].forEach((row) => info.addRow(row));
    info.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF0277BD' } };
    for (let i = 2; i <= 13; i++) info.getCell(`A${i}`).font = { bold: true };
    if (calc.warnings.length) {
      info.addRow([]);
      info.addRow(['Aandachtspunten']).font = { bold: true, color: { argb: 'FFC62828' } };
      calc.warnings.forEach((warning) => info.addRow(['', warning]));
    }
    if (planImageDataUrl) {
      const imageId = workbook.addImage({ base64: planImageDataUrl, extension: 'png' });
      const start = info.rowCount + 2;
      info.addImage(imageId, { tl: { col: 0, row: start }, ext: { width: 720, height: 480 } });
    }

    // 2. Stuklijst met formules
    const sheet = workbook.addWorksheet('Stuklijst', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Omschrijving', key: 'name', width: 62 },
      { header: 'Aantal', key: 'qty', width: 10 },
      { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Prijs/eenheid', key: 'price', width: 14 },
      { header: 'Totaal', key: 'total', width: 14 },
      { header: 'Opmerking', key: 'notes', width: 28 },
      { header: 'Artikelnr. webshop', key: 'sku', width: 18 },
      { header: 'Link webshop', key: 'url', width: 22 },
    ];
    headerStyle(sheet.getRow(1));
    rows.forEach((row, i) => {
      const rowNumber = i + 2;
      sheet.addRow({ code: row.code, name: row.name, qty: row.qty, unit: row.unit, price: row.price, total: { formula: `C${rowNumber}*E${rowNumber}` }, notes: row.notes, sku: row.sku,
        url: row.url ? { text: 'Bekijk in webshop', hyperlink: row.url } : '' });
      if (row.url) sheet.getCell(`I${rowNumber}`).font = { color: { argb: 'FF0277BD' }, underline: true };
      sheet.getCell(`E${rowNumber}`).numFmt = eur;
      sheet.getCell(`F${rowNumber}`).numFmt = eur;
    });
    const last = rows.length + 1;
    const sumRow = last + 2;
    sheet.getCell(`E${sumRow}`).value = 'Subtotaal';
    sheet.getCell(`F${sumRow}`).value = { formula: `SUM(F2:F${last})` };
    sheet.getCell(`E${sumRow + 1}`).value = 'Btw 21%';
    sheet.getCell(`F${sumRow + 1}`).value = { formula: `F${sumRow}*0.21` };
    sheet.getCell(`E${sumRow + 2}`).value = 'Totaal incl. btw';
    sheet.getCell(`F${sumRow + 2}`).value = { formula: `F${sumRow}+F${sumRow + 1}` };
    for (let i = 0; i < 3; i++) {
      sheet.getCell(`E${sumRow + i}`).font = { bold: true };
      sheet.getCell(`F${sumRow + i}`).font = { bold: true };
      sheet.getCell(`F${sumRow + i}`).numFmt = eur;
    }
    const shop = window.ShopCatalog && window.ShopCatalog.info;
    sheet.getCell(`B${sumRow + 4}`).value = shop
      ? `Prijzen excl. btw uit de webshop (${shop.shop}), bijgewerkt ${formatDate(new Date(shop.syncedAt))}; regels zonder artikelnummer webshop hebben een indicatieve prijs.`
      : 'Prijzen indicatief, excl. btw. Pas kolom E aan naar actuele prijzen.';
    sheet.getCell(`B${sumRow + 4}`).font = { italic: true, color: { argb: 'FF757575' } };
    if (rows.missing && rows.missing.length) {
      let rowNumber = sumRow + 6;
      sheet.getCell(`A${rowNumber}`).value = 'Niet in het eigen assortiment (niet meegeteld)';
      sheet.getCell(`A${rowNumber}`).font = { bold: true, color: { argb: 'FFC62828' } };
      for (const missingRow of rows.missing) {
        rowNumber++;
        sheet.getCell(`A${rowNumber}`).value = missingRow.code;
        sheet.getCell(`B${rowNumber}`).value = missingRow.name;
        sheet.getCell(`C${rowNumber}`).value = missingRow.qty;
        sheet.getCell(`D${rowNumber}`).value = missingRow.unit;
      }
    }
    sheet.autoFilter = { from: 'A1', to: `I${last}` };

    // 3. Zones
    const zoneSheet = workbook.addWorksheet('Zones', { views: [{ state: 'frozen', ySplit: 1 }] });
    zoneSheet.columns = [
      { header: 'Zone', key: 'name', width: 12 },
      { header: 'Type', key: 'type', width: 20 },
      { header: 'Aantal onderdelen', key: 'n', width: 18 },
      { header: 'Debiet (m³/u)', key: 'q', width: 14 },
      { header: 'Debiet (l/min)', key: 'qm', width: 14 },
      { header: 'Druk na ventiel (bar)', key: 'p0', width: 20 },
      { header: 'Druk laatste sproeier (bar)', key: 'pc', width: 24 },
      { header: 'Vereist (bar)', key: 'req', width: 13 },
      { header: 'Status', key: 'ok', width: 12 },
      { header: 'Neerslag (mm/u)', key: 'pr', width: 16 },
      { header: 'Looptijd per beurt (min)', key: 'ts', width: 22 },
      { header: 'Beurten/week', key: 'ns', width: 13 },
    ];
    headerStyle(zoneSheet.getRow(1));
    calc.zones.filter((zone) => !zone.empty).forEach((zoneResult) => {
      const scheduleRow = scheduleRows.find((entry) => entry.zone.id === zoneResult.zone.id);
      const row = zoneSheet.addRow({
        name: zoneResult.zone.name,
        type: Catalog.groups[zoneResult.zone.group].label,
        n: zoneResult.members.length,
        q: +(zoneResult.q / 1000).toFixed(3),
        qm: +(zoneResult.q / 60).toFixed(1),
        p0: +zoneResult.pStart.toFixed(2),
        pc: +zoneResult.critical.toFixed(2),
        req: zoneResult.required,
        ok: zoneResult.ok ? 'In orde' : 'Controleren',
        pr: +scheduleRow.pr.toFixed(1),
        ts: Math.round(scheduleRow.minutesSession),
        ns: scheduleRow.sessions,
      });
      row.getCell('ok').font = { bold: true, color: { argb: zoneResult.ok ? 'FF2E7D32' : 'FFC62828' } };
      row.getCell('name').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + zoneResult.zone.color.slice(1).toUpperCase() } };
      row.getCell('name').font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // 4. Sproeiers
    const sprinklerSheet = workbook.addWorksheet('Sproeiers', { views: [{ state: 'frozen', ySplit: 1 }] });
    sprinklerSheet.columns = [
      { header: 'Nr', key: 'nr', width: 6 },
      { header: 'Type', key: 'type', width: 34 },
      { header: 'Zone', key: 'zone', width: 10 },
      { header: 'X (m)', key: 'x', width: 9 },
      { header: 'Y (m)', key: 'y', width: 9 },
      { header: 'Worpwijdte / strook (m)', key: 'r', width: 22 },
      { header: 'Sproeihoek (°)', key: 'arc', width: 14 },
      { header: 'Richting (°)', key: 'start', width: 12 },
      { header: 'Debiet (l/min)', key: 'q', width: 14 },
      { header: 'Druk (bar)', key: 'p', width: 11 },
      { header: 'Sproeikop / instelling', key: 'noz', width: 34 },
    ];
    headerStyle(sprinklerSheet.getRow(1));
    const pressureById = new Map();
    calc.zones.forEach((zoneResult) => (zoneResult.members || []).forEach((member) => { if (member.kind === 'spr') pressureById.set(member.ref.id, member.pressure); }));
    state.sprinklers.forEach((sprinkler, i) => {
      const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
      const zone = state.zones.find((candidate) => candidate.id === sprinkler.zone);
      sprinklerSheet.addRow({
        nr: i + 1,
        type: sprinklerType.label,
        zone: zone ? zone.name : '-',
        x: +sprinkler.x.toFixed(2),
        y: +sprinkler.y.toFixed(2),
        r: sprinkler.type === 'strip' ? `${Geo.nlShort(sprinkler.width, 1)} × ${Geo.nlShort(sprinkler.len, 1)}` : sprinkler.r,
        arc: sprinkler.type === 'strip' ? '-' : sprinkler.arc,
        start: sprinkler.start,
        q: +(Catalog.sprinklerFlowLph(sprinkler) / 60).toFixed(2),
        p: pressureById.has(sprinkler.id) ? +pressureById.get(sprinkler.id).toFixed(2) : '',
        noz: sprinkler.type === 'strip' ? 'ROT-STRIP' : Catalog.nozzleOf(sprinkler) ? `${Catalog.bodyOf(sprinkler) ? `${Catalog.bodyOf(sprinkler).name} · ` : ''}${Catalog.headSetting(sprinkler)}` : sprinkler.type === 'spray' ? 'SPR-VAN' : 'TURB-10',
      });
    });

    // 5. Leidingen
    const pipeSheet = workbook.addWorksheet('Leidingen', { views: [{ state: 'frozen', ySplit: 1 }] });
    pipeSheet.columns = [
      { header: 'Zone', key: 'zone', width: 14 },
      { header: 'Diameter (mm)', key: 'dn', width: 14 },
      { header: 'Lengte (m)', key: 'len', width: 12 },
      { header: 'Debiet (l/min)', key: 'q', width: 14 },
      { header: 'Snelheid (m/s)', key: 'v', width: 14 },
      { header: 'Drukverlies (bar)', key: 'loss', width: 16 },
    ];
    headerStyle(pipeSheet.getRow(1));
    calc.pipes.forEach((pipe) => {
      const zone = state.zones.find((candidate) => candidate.id === pipe.zone);
      pipeSheet.addRow({
        zone: pipe.main ? 'Hoofdleiding' : pipe.outlet ? 'Waterpunt' : zone ? zone.name : '-',
        dn: pipe.dn,
        len: +pipe.len.toFixed(2),
        q: +(pipe.q / 60).toFixed(1),
        v: pipe.v != null ? +pipe.v.toFixed(2) : '',
        loss: pipe.loss != null ? +pipe.loss.toFixed(3) : '',
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const safeName = (meta.name || 'beregeningsplan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'beregeningsplan';
    return { blob, filename: `${safeName}_stuklijst.xlsx` };
  }

  window.BOM = { build, schedule, exportXlsx };
})();
