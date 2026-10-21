/* Stuklijst-generatie en export naar Excel (.xlsx). */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;
  const Hy = window.Hydraulics;

  /** Bouwt de stuklijst op basis van de actuele berekening. */
  function build(state) {
    const calc = state.calc || Hy.calculate(state);
    const level = state.settings.level || 'expert';
    const items = new Map();
    const add = (code, qty, note) => {
      if (!qty || qty <= 0) return;
      const a = C.articles[code];
      if (!a) throw new Error(`Onbekend artikel ${code}`);
      const cur = items.get(code) || { code, name: a.name, unit: a.unit, price: a.price, sku: a.sku || '', url: a.url || '', shop: Boolean(a.shop), qty: 0, notes: new Set() };
      cur.qty += qty;
      if (note) cur.notes.add(note);
      items.set(code, cur);
    };

    // Sproeiers: gekozen behuizing en nozzle uit de bibliotheek, anders de generieke artikelen
    for (const s of state.sprinklers) {
      const bed = Boolean(s.areaId); // in beplanting: hoger sproeierhuis (30 cm)
      // artikel van de bibliotheek alleen als de catalogus het kent (anders generiek)
      const known = (x) => (x && x.code && C.articles[x.code] ? x : null);
      const body = known(C.bodyOf(s));
      const noz = known(C.nozzleOf(s));
      if (s.type === 'spray') {
        if (body && body.code) add(body.code, 1, bed ? 'beplanting' : '');
        else add(bed ? 'SPR-POP30-PRS' : level === 'eco' ? 'SPR-POP10' : 'SPR-POP10-PRS', 1, bed ? 'beplanting' : '');
        add(noz && noz.code ? noz.code : 'SPR-VAN', 1);
        add(level === 'eco' ? 'CON-ECO' : 'CON-FLEX', 1);
      } else if (s.type === 'rotator' || s.type === 'strip') {
        if (body && body.code) add(body.code, 1, bed ? 'beplanting' : '');
        else add(bed ? 'ROT-POP30-PRS' : 'ROT-POP10-PRS', 1, bed ? 'beplanting' : '');
        add(s.type === 'strip' ? 'ROT-STRIP' : (noz && noz.code) || 'ROT-MP2000', 1);
        add(level === 'eco' ? 'CON-ECO' : 'CON-FLEX', 1);
      } else if (s.type === 'rotor') {
        // een rotor wordt geleverd met nozzleset; de gekozen nozzle staat in de instelling
        if (body && body.code) add(body.code, 1, noz ? `nozzle ${noz.name}` : '');
        else add(level === 'premium' ? 'TURB-10-PRO' : 'TURB-10', 1);
        if (noz && noz.code) add(noz.code, 1);
        add(level === 'eco' ? 'CON-ECO' : 'CON-FLEX-TURB', 1);
      }
    }

    // Leidingen (+10% reserve, afgerond op hele meters)
    const meters = {};
    for (const p of calc.pipes) meters[p.dn] = (meters[p.dn] || 0) + p.len;
    for (const dn of Object.keys(meters)) add(`PE-${dn}`, Math.ceil(meters[dn] * 1.1), 'incl. 10% reserve');

    // Hulpstukken per zone (op basis van boomstructuur)
    let reducers = 0;
    for (const zr of calc.zones) {
      if (zr.empty) continue;
      const { degree, dnAt, edges, members } = zr;
      const adjDn = (i) => {
        let dn = dnAt[i] || 0;
        for (const e of edges) if (e.from === i) dn = Math.max(dn, e.dn);
        return dn || 25;
      };
      for (let i = 1; i < degree.length; i++) {
        const m = members[i - 1];
        const dn = Math.min(adjDn(i), 32);
        if (m.kind === 'drip') {
          add('DRIP-ADAPT', 1);
          if (degree[i] >= 2) add(`FIT-T-${dn}`, degree[i] - 1);
          continue;
        }
        if (degree[i] >= 2) add(`FIT-T-${dn}`, degree[i] - 1);
        else add(`FIT-L-${dn}`, 1);
      }
      if (degree[0] > 1) add(`FIT-T-${adjDn(0)}`, degree[0] - 1);
      add('FIT-ADAPT', 1);
      for (const e of edges) if (e.from > 0 && dnAt[e.from] && dnAt[e.from] !== e.dn) reducers++;
    }
    add('FIT-RED', reducers);

    // Druppelirrigatie: druppelslang en/of losse druppelaars
    let dripM = 0, dripRuns = 0, supplyM = 0, supplyRuns = 0, drippers = 0, microM = 0;
    const dripZones = new Set();
    for (const a of Hy.dripAreas(state)) {
      const di = Hy.dripInfo(a, Hy.methodOf(state, a));
      if (a.zone) dripZones.add(a.zone);
      if (di.method === 'drippers') {
        drippers += di.count;
        microM += di.microM;
        supplyM += di.supplyM;
        supplyRuns += di.runs;
        add('DRIP-T', Math.max(1, di.runs - 1) + (a.type === 'planter' ? 1 : 0));
      } else {
        dripM += di.lengthM;
        dripRuns += di.runs;
        add('DRIP-T', Math.max(2, Math.ceil(di.lengthM / 10)));
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
    const zoneCount = calc.zones.filter((z) => !z.empty).length;
    if (zoneCount) {
      add(level === 'premium' ? 'VAL-24V-FC' : 'VAL-24V', zoneCount);
      add('VAL-MANIFOLD', zoneCount);
      let left = zoneCount;
      while (left > 0) {
        if (left > 3) { add('BOX-JUMBO', 1); left -= 6; } else { add('BOX-STD', 1); left -= 3; }
      }
      add(level === 'eco' ? 'CTRL-ECO' : 'CTRL-WIFI', 1, `${zoneCount} stations nodig`);
      if (level !== 'eco') add('SEN-RAIN', 1);
      if (level === 'premium') add('SEN-SOIL', 1);

      const ctrl = state.elements.find((e) => e.kind === 'controller');
      const cableLen = ctrl ? Math.ceil(G.dist(ctrl, calc.vb) * 1.2 + 3) : 10;
      const cores = zoneCount + 1;
      const cables = Math.ceil(cores / 13);
      add(cores <= 7 ? 'CAB-7' : 'CAB-13', cableLen * (cores <= 7 ? 1 : cables));
      add('CAB-CON', cores * 2);
      add('MAIN-VALVE', 1);
      add('BACKFLOW', 1);
      add('FILTER', 1);
      add('TAPE', Math.max(1, Math.ceil(zoneCount / 4)));
    }

    const outlets = state.elements.filter((e) => e.kind === 'outlet').length;
    if (outlets) {
      add('OUTLET', outlets);
      add('FIT-T-32', outlets);
    }

    const order = Object.keys(C.articles);
    return Array.from(items.values())
      .sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))
      .map((it) => ({ ...it, notes: Array.from(it.notes).join('; '), total: it.qty * it.price }));
  }

  /** Beregeningsschema: looptijd per zone voor de gewenste weekgift. */
  function schedule(state) {
    const calc = state.calc;
    const mmWeek = state.settings.targetMm || 20;
    const sessions = Math.max(1, state.settings.sessions || 3);
    return calc.zones.filter((z) => !z.empty).map((zr) => {
      let pr;
      if (zr.zone.group === 'drip' || zr.zone.group === 'drippers') {
        // gemiddelde gift over de beplante oppervlakte van de zone
        const lph = zr.members.reduce((s, m) => s + m.q, 0);
        const area = zr.members.reduce((s, m) => s + (m.drip ? m.drip.areaM2 : 0), 0);
        pr = area > 0 ? lph / area : C.drip.lphPerM / C.drip.rowSpacingBed;
      } else {
        pr = C.groups[zr.zone.group].pr;
      }
      const minutesWeek = (mmWeek / pr) * 60;
      return { zone: zr.zone, pr, minutesWeek, minutesSession: minutesWeek / sessions, sessions };
    });
  }

  function fmtDate(d) {
    return d.toLocaleDateString('nl-NL', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  /** Exporteert planning + stuklijst naar een Excel-werkmap. */
  async function exportXlsx(state, planImageDataUrl) {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) throw new Error('ExcelJS niet geladen');
    const calc = Hy.calculate(state);
    const rows = build(state);
    const sched = schedule(state);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aquatech Beregeningsplanner';
    wb.created = new Date();

    const headerStyle = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0277BD' } };
      row.alignment = { vertical: 'middle' };
    };
    const eur = '€ #,##0.00';

    // 1. Projectinfo
    const info = wb.addWorksheet('Project');
    info.columns = [{ width: 32 }, { width: 50 }];
    const lvl = C.levels[state.settings.level] || C.levels.expert;
    const totalArea = state.areas.filter((a) => a.type === 'lawn').reduce((s, a) => s + G.area(a.pts), 0);
    const meta = state.meta || {};
    [
      ['Beregeningsplan', meta.name || 'Nieuw project'],
      ['Klant', meta.customer || ''],
      ['Adres', meta.address || ''],
      ['Datum', fmtDate(new Date())],
      ['Uitvoeringsniveau', `${lvl.label} – ${lvl.desc}`],
      [],
      ['Waterdruk (dynamisch)', `${G.nlShort(state.settings.pressure, 2)} bar`],
      ['Beschikbaar debiet', `${G.nlShort(state.settings.flow, 2)} m³/u`],
      ['Max. debiet per zone', `${G.nl(calc.maxQ / 1000, 2)} m³/u`],
      ['Gazonoppervlak', `${G.nl(totalArea, 1)} m²`],
      ['Aantal sproeiers', state.sprinklers.length],
      ['Aantal zones', calc.zones.filter((z) => !z.empty).length],
      ['Weekgift (doel)', `${state.settings.targetMm} mm in ${state.settings.sessions} beurten`],
    ].forEach((r) => info.addRow(r));
    info.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF0277BD' } };
    for (let i = 2; i <= 13; i++) info.getCell(`A${i}`).font = { bold: true };
    if (calc.warnings.length) {
      info.addRow([]);
      info.addRow(['Aandachtspunten']).font = { bold: true, color: { argb: 'FFC62828' } };
      calc.warnings.forEach((w) => info.addRow(['', w]));
    }
    if (planImageDataUrl) {
      const imgId = wb.addImage({ base64: planImageDataUrl, extension: 'png' });
      const start = info.rowCount + 2;
      info.addImage(imgId, { tl: { col: 0, row: start }, ext: { width: 720, height: 480 } });
    }

    // 2. Stuklijst met formules
    const ws = wb.addWorksheet('Stuklijst', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
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
    headerStyle(ws.getRow(1));
    rows.forEach((r, i) => {
      const n = i + 2;
      ws.addRow({ code: r.code, name: r.name, qty: r.qty, unit: r.unit, price: r.price, total: { formula: `C${n}*E${n}` }, notes: r.notes, sku: r.sku,
        url: r.url ? { text: 'Bekijk in webshop', hyperlink: r.url } : '' });
      if (r.url) ws.getCell(`I${n}`).font = { color: { argb: 'FF0277BD' }, underline: true };
      ws.getCell(`E${n}`).numFmt = eur;
      ws.getCell(`F${n}`).numFmt = eur;
    });
    const last = rows.length + 1;
    const sumRow = last + 2;
    ws.getCell(`E${sumRow}`).value = 'Subtotaal';
    ws.getCell(`F${sumRow}`).value = { formula: `SUM(F2:F${last})` };
    ws.getCell(`E${sumRow + 1}`).value = 'Btw 21%';
    ws.getCell(`F${sumRow + 1}`).value = { formula: `F${sumRow}*0.21` };
    ws.getCell(`E${sumRow + 2}`).value = 'Totaal incl. btw';
    ws.getCell(`F${sumRow + 2}`).value = { formula: `F${sumRow}+F${sumRow + 1}` };
    for (let i = 0; i < 3; i++) {
      ws.getCell(`E${sumRow + i}`).font = { bold: true };
      ws.getCell(`F${sumRow + i}`).font = { bold: true };
      ws.getCell(`F${sumRow + i}`).numFmt = eur;
    }
    const shop = window.ShopCatalog && window.ShopCatalog.info;
    ws.getCell(`B${sumRow + 4}`).value = shop
      ? `Prijzen excl. btw uit de webshop (${shop.shop}), bijgewerkt ${fmtDate(new Date(shop.syncedAt))}; regels zonder artikelnummer webshop hebben een indicatieve prijs.`
      : 'Prijzen indicatief, excl. btw. Pas kolom E aan naar actuele prijzen.';
    ws.getCell(`B${sumRow + 4}`).font = { italic: true, color: { argb: 'FF757575' } };
    ws.autoFilter = { from: 'A1', to: `I${last}` };

    // 3. Zones
    const zs = wb.addWorksheet('Zones', { views: [{ state: 'frozen', ySplit: 1 }] });
    zs.columns = [
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
    headerStyle(zs.getRow(1));
    calc.zones.filter((z) => !z.empty).forEach((zr) => {
      const sc = sched.find((s) => s.zone.id === zr.zone.id);
      const row = zs.addRow({
        name: zr.zone.name,
        type: C.groups[zr.zone.group].label,
        n: zr.members.length,
        q: +(zr.q / 1000).toFixed(3),
        qm: +(zr.q / 60).toFixed(1),
        p0: +zr.pStart.toFixed(2),
        pc: +zr.critical.toFixed(2),
        req: zr.required,
        ok: zr.ok ? 'In orde' : 'Controleren',
        pr: +sc.pr.toFixed(1),
        ts: Math.round(sc.minutesSession),
        ns: sc.sessions,
      });
      row.getCell('ok').font = { bold: true, color: { argb: zr.ok ? 'FF2E7D32' : 'FFC62828' } };
      row.getCell('name').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + zr.zone.color.slice(1).toUpperCase() } };
      row.getCell('name').font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // 4. Sproeiers
    const ss = wb.addWorksheet('Sproeiers', { views: [{ state: 'frozen', ySplit: 1 }] });
    ss.columns = [
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
    headerStyle(ss.getRow(1));
    const pressureById = new Map();
    calc.zones.forEach((zr) => (zr.members || []).forEach((m) => { if (m.kind === 'spr') pressureById.set(m.ref.id, m.pressure); }));
    state.sprinklers.forEach((s, i) => {
      const t = C.sprinklerTypes[s.type];
      const z = state.zones.find((zz) => zz.id === s.zone);
      ss.addRow({
        nr: i + 1,
        type: t.label,
        zone: z ? z.name : '-',
        x: +s.x.toFixed(2),
        y: +s.y.toFixed(2),
        r: s.type === 'strip' ? `${G.nlShort(s.width, 1)} × ${G.nlShort(s.len, 1)}` : s.r,
        arc: s.type === 'strip' ? '-' : s.arc,
        start: s.start,
        q: +(C.sprinklerFlowLph(s) / 60).toFixed(2),
        p: pressureById.has(s.id) ? +pressureById.get(s.id).toFixed(2) : '',
        noz: s.type === 'strip' ? 'ROT-STRIP' : C.nozzleOf(s) ? `${C.bodyOf(s) ? `${C.bodyOf(s).name} · ` : ''}${C.headSetting(s)}` : s.type === 'spray' ? 'SPR-VAN' : 'TURB-10',
      });
    });

    // 5. Leidingen
    const ls = wb.addWorksheet('Leidingen', { views: [{ state: 'frozen', ySplit: 1 }] });
    ls.columns = [
      { header: 'Zone', key: 'zone', width: 14 },
      { header: 'Diameter (mm)', key: 'dn', width: 14 },
      { header: 'Lengte (m)', key: 'len', width: 12 },
      { header: 'Debiet (l/min)', key: 'q', width: 14 },
      { header: 'Snelheid (m/s)', key: 'v', width: 14 },
      { header: 'Drukverlies (bar)', key: 'loss', width: 16 },
    ];
    headerStyle(ls.getRow(1));
    calc.pipes.forEach((p) => {
      const z = state.zones.find((zz) => zz.id === p.zone);
      ls.addRow({
        zone: p.main ? 'Hoofdleiding' : p.outlet ? 'Waterpunt' : z ? z.name : '-',
        dn: p.dn,
        len: +p.len.toFixed(2),
        q: +(p.q / 60).toFixed(1),
        v: p.v != null ? +p.v.toFixed(2) : '',
        loss: p.loss != null ? +p.loss.toFixed(3) : '',
      });
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const safe = (meta.name || 'beregeningsplan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'beregeningsplan';
    return { blob, filename: `${safe}_stuklijst.xlsx` };
  }

  window.BOM = { build, schedule, exportXlsx };
})();
