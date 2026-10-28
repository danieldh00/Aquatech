/* Zone-indeling, leidingtracé (minimum spanning tree) en drukverliesberekening (Hazen-Williams). */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;
  const HydraulicsSettings = Catalog.hydraulics;

  // Zonekleuren: verzadigd en zonder groen- of bruintinten, zodat leidingen op
  // gazon, beplanting en de ingeladen tekening goed zichtbaar blijven.
  const ZONE_COLORS = ['#d50000', '#2962ff', '#ff6d00', '#aa00ff', '#00b8d4', '#ffd600', '#e91e63', '#212121',
    '#1a237e', '#ff8a80', '#7c4dff', '#ffab00', '#880e4f', '#18ffff', '#bf360c', '#f50057'];
  // Vorig palet (met groen); bewaarde plannen krijgen de nieuwe kleur op dezelfde plek
  const OLD_ZONE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324',
    '#469990', '#800000', '#808000', '#000075', '#bfef45', '#fabed4', '#dcbeff', '#aaffc3'];

  /**
   * Zet zonekleuren uit het oude palet om naar het contrastrijke palet.
   * @param {object} state de planstand
   */
  function refreshZoneColors(state) {
    for (const zone of state.zones || []) {
      const i = OLD_ZONE_COLORS.indexOf(String(zone.color || '').toLowerCase());
      if (i >= 0) zone.color = ZONE_COLORS[i];
    }
  }

  /**
   * Drukverlies (Hazen-Williams) in bar voor een leidinglengte, debiet en binnendiameter.
   * @param {number} lengthM lengte in meters
   * @param {number} flowLph debiet in l/u
   * @param {number} innerDiameterMm binnendiameter in mm
   * @returns {number} drukverlies in bar (met toeslag voor hulpstukken)
   */
  function lossBar(lengthM, flowLph, innerDiameterMm) {
    if (lengthM <= 0 || flowLph <= 0) return 0;
    const flowM3s = flowLph / 3.6e6; // m³/s
    const diameterM = innerDiameterMm / 1000;
    const headLossM = (10.67 * lengthM * Math.pow(flowM3s, 1.852)) / (Math.pow(HydraulicsSettings.hazenC, 1.852) * Math.pow(diameterM, 4.87));
    return (headLossM / 10.197) * HydraulicsSettings.minorLossFactor;
  }

  /**
   * Stroomsnelheid in een leiding.
   * @param {number} flowLph debiet in l/u
   * @param {number} innerDiameterMm binnendiameter in mm
   * @returns {number} snelheid in m/s
   */
  function velocity(flowLph, innerDiameterMm) {
    const flowM3s = flowLph / 3.6e6;
    const crossSection = Math.PI * Math.pow(innerDiameterMm / 2000, 2);
    return flowM3s / crossSection;
  }

  /**
   * Kiest de kleinste leiding waarin de stroomsnelheid binnen het maximum blijft.
   * @param {number} flowLph debiet in l/u
   * @param {number} minNominal kleinste toegestane nominale maat (standaard 25)
   * @returns {object} de leiding uit de catalogus (de grootste als niets past)
   */
  function pickPipe(flowLph, minNominal = 25) {
    for (const pipe of Catalog.pipes) {
      if (pipe.dn < minNominal) continue;
      if (velocity(flowLph, pipe.id) <= HydraulicsSettings.maxVelocity) return pipe;
    }
    return Catalog.pipes[Catalog.pipes.length - 1];
  }

  /**
   * Gekozen beregeningsmethode van een vlak: eigen keuze, anders projectstandaard, anders typestandaard.
   * @param {object} state de planstand
   * @param {object} area het vlak
   * @returns {string} 'dripline', 'drippers', 'sprinklers' of 'none'
   */
  function methodOf(state, area) {
    const areaType = Catalog.areaTypes[area.type];
    if (!areaType || !areaType.methods) return area.type === 'lawn' ? 'sprinklers' : 'none';
    if (area.method && areaType.methods.includes(area.method)) return area.method;
    const projectDefault = state && state.settings && state.settings.methods && state.settings.methods[area.type];
    return projectDefault && areaType.methods.includes(projectDefault) ? projectDefault : areaType.defaultMethod;
  }

  /**
   * Zegt of een methode druppelirrigatie is.
   * @param {string} method de methode
   * @returns {boolean} true bij druppelslang of druppelaars
   */
  const isDripMethod = (method) => method === 'dripline' || method === 'drippers';

  /**
   * Vlakken die druppelirrigatie krijgen.
   * @param {object} state de planstand
   * @returns {object[]} de vlakken
   */
  function dripAreas(state) {
    return state.areas.filter((area) => area.pts.length >= 3 && isDripMethod(methodOf(state, area)));
  }

  /**
   * Zegt of het plan iets te beregenen heeft (sproeiers of druppelvlakken).
   * @param {object} state de planstand
   * @returns {boolean} true als er iets is
   */
  function hasIrrigation(state) {
    return state.sprinklers.length > 0 || dripAreas(state).length > 0;
  }

  /**
   * Druppelgegevens van een vlak voor de gegeven methode (druppelslang of druppelaars).
   * @param {object} area het vlak
   * @param {string} method 'dripline' (standaard) of 'drippers'
   * @returns {object} lengte of aantal, debiet, neerslag en aantal strengen
   */
  function dripInfo(area, method = 'dripline') {
    const surface = Geo.area(area.pts);
    const rect = Geo.minWidthRect(area.pts);
    if (method === 'drippers') {
      const Drippers = Catalog.drippers;
      let count;
      if (area.type === 'hedge') count = Math.ceil(rect.length / Drippers.spacingHedge) * Math.max(1, Math.round(rect.width / 0.6));
      else if (area.type === 'planter') count = Math.max(Drippers.minPerPlanter, Math.ceil(surface * Drippers.perM2Planter));
      else count = Math.max(1, Math.ceil(surface * Drippers.perM2Bed));
      const rows = area.type === 'planter' ? 1 : Math.max(1, Math.round(rect.width / Drippers.supplyRowSpacing));
      const supplyM = Math.ceil(rect.length * rows + 1);
      const lph = count * Drippers.lph;
      return { method, count, supplyM, microM: Math.ceil(count * Drippers.microTubeM), lph, areaM2: surface, mmh: lph / Math.max(surface, 0.1), runs: rows };
    }
    const spacing = area.type === 'hedge' ? Catalog.drip.rowSpacingHedge : area.type === 'planter' ? Catalog.drip.rowSpacingPlanter : Catalog.drip.rowSpacingBed;
    let lengthM;
    if (area.type === 'hedge') {
      // haag: lengte langs de lange zijde, aantal lijnen afhankelijk van de breedte
      const rect = Geo.minWidthRect(area.pts);
      const lines = Math.max(1, Math.round(rect.width / spacing));
      lengthM = rect.length * lines;
    } else {
      lengthM = Math.max(1, surface / spacing);
    }
    lengthM = Math.ceil(lengthM);
    const lph = lengthM * Catalog.drip.lphPerM;
    return { method, lengthM, lph, areaM2: surface, spacing, mmh: lph / Math.max(surface, 0.1), runs: Math.max(1, Math.ceil(lengthM / Catalog.drip.maxRunM)) };
  }

  /**
   * Zoekt het eerste element van een soort.
   * @param {object} state de planstand
   * @param {string} kind soort element (bijv. 'source')
   * @returns {object|null} het element, of null
   */
  function element(state, kind) {
    return state.elements.find((element) => element.kind === kind) || null;
  }

  /**
   * Ankerpunt voor leidingen: ventielkast, anders wateraansluiting, anders zwaartepunt van de sproeiers.
   * @param {object} state de planstand
   * @returns {{x: number, y: number}} het punt
   */
  function valveBoxPos(state) {
    const anchor = element(state, 'valvebox') || element(state, 'source');
    if (anchor) return { x: anchor.x, y: anchor.y };
    const positions = state.sprinklers.map((sprinkler) => ({ x: sprinkler.x, y: sprinkler.y }));
    if (!positions.length) return { x: 0, y: 0 };
    return { x: positions.reduce((sum, point) => sum + point.x, 0) / positions.length, y: positions.reduce((sum, point) => sum + point.y, 0) / positions.length };
  }

  /**
   * Grootste debiet per zone uit het beschikbare debiet.
   * @param {object} state de planstand
   * @returns {number} debiet in l/u
   */
  function maxZoneLph(state) {
    return state.settings.flow * 1000 * HydraulicsSettings.zoneFlowFactor;
  }

  /**
   * Alle beregenbare leden (sproeiers + druppelvlakken) met groep, debiet en aansluitpunt.
   * @param {object} state de planstand
   * @returns {object[]} de leden
   */
  function members(state) {
    const anchor = valveBoxPos(state);
    const list = [];
    for (const sprinkler of state.sprinklers) {
      const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
      // sproeiers in beplanting krijgen eigen zones (andere waterbehoefte dan gazon)
      const group = sprinkler.areaId ? `bed-${sprinklerType.group === 'rotator' ? 'rotator' : 'spray'}` : sprinklerType.group;
      list.push({ kind: 'spr', ref: sprinkler, group, q: Catalog.sprinklerFlowLph(sprinkler), pos: { x: sprinkler.x, y: sprinkler.y } });
    }
    for (const area of dripAreas(state)) {
      const method = methodOf(state, area);
      const drip = dripInfo(area, method);
      const entry = Geo.pointInPolygon(anchor, area.pts) ? anchor : Geo.closestOnPolygon(anchor, area.pts).pt;
      list.push({ kind: 'drip', ref: area, group: method === 'drippers' ? 'drippers' : 'drip', q: drip.lph, pos: entry, drip });
    }
    return list;
  }

  /**
   * Automatische zone-indeling: per groep, gretig clusteren vanaf de verste kop.
   * @param {object} state de planstand (zones en zone van elk lid worden aangepast)
   */
  function autoZones(state) {
    const anchor = valveBoxPos(state);
    const maxFlow = maxZoneLph(state);
    const allMembers = members(state);
    const zones = [];
    const order = ['spray', 'rotator', 'rotor', 'bed-spray', 'bed-rotator', 'drip', 'drippers'];
    for (const group of order) {
      const pool = allMembers.filter((member) => member.group === group);
      // Evenwichtige verdeling: streef naar gelijke zones binnen het maximum
      const total = pool.reduce((sum, member) => sum + member.q, 0);
      const zoneCount = Math.max(1, Math.ceil(total / maxFlow - 1e-9));
      const capacity = Math.min(maxFlow, (total / zoneCount) * 1.12);
      while (pool.length) {
        pool.sort((left, right) => Geo.dist(right.pos, anchor) - Geo.dist(left.pos, anchor));
        const seed = pool.shift();
        const zone = { id: Geo.uid('z'), group, members: [seed], q: seed.q };
        let added = true;
        while (added) {
          added = false;
          let best = null, bestDistance = Infinity;
          for (const member of pool) {
            if (zone.q + member.q > capacity) continue;
            const distance = Math.min(...zone.members.map((zoneMember) => Geo.dist(zoneMember.pos, member.pos)));
            if (distance < bestDistance) { bestDistance = distance; best = member; }
          }
          if (best) {
            pool.splice(pool.indexOf(best), 1);
            zone.members.push(best);
            zone.q += best.q;
            added = true;
          }
        }
        zones.push(zone);
      }
    }
    // Zones nummeren: dichtstbijzijnde eerst
    zones.sort((left, right) => {
      const leftDistance = Math.min(...left.members.map((member) => Geo.dist(member.pos, anchor)));
      const rightDistance = Math.min(...right.members.map((member) => Geo.dist(member.pos, anchor)));
      return leftDistance - rightDistance;
    });
    state.zones = zones.map((zone, i) => ({
      id: zone.id,
      name: `Zone ${i + 1}`,
      group: zone.group,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
    }));
    for (const sprinkler of state.sprinklers) sprinkler.zone = null;
    for (const area of state.areas) if (area.zone) area.zone = null;
    zones.forEach((zone) => zone.members.forEach((member) => { member.ref.zone = zone.id; }));
  }

  /**
   * Minimale opspannende boom (Prim) vanaf knoop 0.
   * @param {Array<{x: number, y: number}>} points de knopen
   * @returns {number[]} ouder per knoop (-1 voor de wortel)
   */
  function mst(points) {
    const count = points.length;
    const inTree = new Array(count).fill(false);
    const best = new Array(count).fill(Infinity);
    const parent = new Array(count).fill(-1);
    best[0] = 0;
    for (let step = 0; step < count; step++) {
      let nearest = -1;
      for (let i = 0; i < count; i++) if (!inTree[i] && (nearest < 0 || best[i] < best[nearest])) nearest = i;
      inTree[nearest] = true;
      for (let node = 0; node < count; node++) {
        if (inTree[node]) continue;
        const distance = Geo.dist(points[nearest], points[node]);
        if (distance < best[node]) { best[node] = distance; parent[node] = nearest; }
      }
    }
    return parent;
  }

  /**
   * Berekent leidingen en drukken voor alle zones. Resultaat in state.calc (niet opgeslagen).
   * @param {object} state de planstand
   * @returns {object} leidingen, resultaten per zone, waarschuwingen en hoofdleiding
   */
  function calculate(state) {
    refreshZoneColors(state);
    const anchor = valveBoxPos(state);
    const source = element(state, 'source');
    const srcPos = source ? { x: source.x, y: source.y } : anchor;
    const allMembers = members(state);
    const warnings = [];
    const pipes = [];
    const zoneResults = [];

    if (!element(state, 'valvebox')) warnings.push('Geen ventielkast geplaatst: leidingen starten vanaf de wateraansluiting.');
    if (!source) warnings.push('Geen wateraansluiting geplaatst.');

    const zoneMembers = new Map(state.zones.map((zone) => [zone.id, []]));
    const unassigned = [];
    for (const member of allMembers) {
      const zoneId = member.ref.zone;
      if (zoneId && zoneMembers.has(zoneId)) zoneMembers.get(zoneId).push(member);
      else unassigned.push(member);
    }
    if (unassigned.length) warnings.push(`${unassigned.length} onderdeel/onderdelen zonder zone. Gebruik "Zones automatisch indelen".`);

    const maxZoneFlow = Math.max(0, ...state.zones.map((zone) => (zoneMembers.get(zone.id) || []).reduce((sum, member) => sum + member.q, 0)));
    const mainLen = Geo.dist(srcPos, anchor) * 1.15;
    const mainPipe = pickPipe(Math.max(maxZoneFlow, 1), 32);
    if (mainLen > 0.1) {
      pipes.push({ zone: null, main: true, a: srcPos, b: anchor, dn: mainPipe.dn, q: maxZoneFlow, len: mainLen });
    }

    const maxFlow = maxZoneLph(state);
    for (const zone of state.zones) {
      const zoneMembersList = zoneMembers.get(zone.id) || [];
      if (!zoneMembersList.length) {
        zoneResults.push({ zone, members: [], q: 0, empty: true });
        continue;
      }
      const flow = zoneMembersList.reduce((sum, member) => sum + member.q, 0);
      const points = [anchor, ...zoneMembersList.map((member) => member.pos)];
      const parent = mst(points);
      const children = points.map(() => []);
      for (let i = 1; i < points.length; i++) children[parent[i]].push(i);
      const nodeFlow = points.map((_, i) => (i === 0 ? 0 : zoneMembersList[i - 1].q));
      const subtreeFlow = new Array(points.length).fill(0);
      /**
       * Telt het debiet van een knoop en alles erachter op.
       * @param {number} i index van de knoop
       * @returns {number} debiet in l/u
       */
      const sumSubtree = (i) => { subtreeFlow[i] = nodeFlow[i] + children[i].reduce((sum, child) => sum + sumSubtree(child), 0); return subtreeFlow[i]; };
      sumSubtree(0);

      const mainLoss = lossBar(mainLen, flow, mainPipe.id);
      const startPressure = state.settings.pressure - HydraulicsSettings.headerLossBar - mainLoss - HydraulicsSettings.valveLossBar;
      const pressure = new Array(points.length).fill(0);
      pressure[0] = startPressure;
      const edges = [];
      const nominalAt = new Array(points.length).fill(0);
      /**
       * Loopt de boom af en berekent per leidingstuk maat, drukverlies en druk.
       * @param {number} i index van de knoop
       */
      const walkTree = (i) => {
        for (const child of children[i]) {
          const length = Geo.dist(points[i], points[child]) * 1.05;
          const pipe = pickPipe(subtreeFlow[child]);
          const loss = lossBar(length, subtreeFlow[child], pipe.id);
          pressure[child] = pressure[i] - loss;
          nominalAt[child] = pipe.dn;
          edges.push({ zone: zone.id, a: points[i], b: points[child], dn: pipe.dn, q: subtreeFlow[child], len: length, from: i, to: child,
            v: velocity(subtreeFlow[child], pipe.id), loss });
          walkTree(child);
        }
      };
      walkTree(0);
      pipes.push(...edges);

      let required = 0;
      let critical = Infinity;
      zoneMembersList.forEach((member, index) => {
        const needed = member.kind === 'drip' ? Catalog.drip.regBar + 0.3 : Catalog.headMinBar(member.ref);
        required = Math.max(required, needed);
        critical = Math.min(critical, pressure[index + 1]);
        member.pressure = pressure[index + 1];
      });
      const degree = points.map((_, i) => children[i].length + (i === 0 ? 0 : 1));
      const isOk = critical >= required && flow <= maxFlow * 1.0001;
      const zoneResult = { zone, members: zoneMembersList, q: flow, pStart: startPressure, critical, required, ok: isOk, edges, degree, dnAt: nominalAt, points,
        overflow: flow > maxFlow * 1.0001 };
      zoneResults.push(zoneResult);
      if (zoneResult.overflow) warnings.push(`${zone.name}: debiet ${Geo.nl(flow / 1000, 2)} m³/u is hoger dan het beschikbare debiet.`);
      if (critical < required) warnings.push(`${zone.name}: druk bij de laatste sproeier ${Geo.nl(critical, 2)} bar is lager dan de vereiste ${Geo.nl(required, 1)} bar.`);
      const groups = new Set(zoneMembersList.map((member) => member.group));
      if (groups.size > 1) warnings.push(`${zone.name}: verschillende sproeiertypes in één zone (ongelijke neerslag).`);
    }

    // Waterpunten op de hoofdleiding
    const outlets = state.elements.filter((element) => element.kind === 'outlet');
    for (const outlet of outlets) {
      const closest = Geo.closestOnSegment(outlet, srcPos, anchor);
      const length = Geo.dist(outlet, closest) * 1.1;
      if (length > 0.1) pipes.push({ zone: null, outlet: true, a: { x: closest.x, y: closest.y }, b: { x: outlet.x, y: outlet.y }, dn: 32, q: 0, len: length });
    }

    state.calc = { pipes, zones: zoneResults, warnings, mainPipe, mainLen, vb: anchor, srcPos, maxQ: maxFlow, unassigned };
    return state.calc;
  }

  window.Hydraulics = { lossBar, velocity, pickPipe, dripInfo, methodOf, dripAreas, hasIrrigation, isDripMethod, autoZones, calculate, members, valveBoxPos, maxZoneLph, ZONE_COLORS, refreshZoneColors };
})();
