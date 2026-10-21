/* Zone-indeling, leidingtracé (minimum spanning tree) en drukverliesberekening (Hazen-Williams). */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;
  const H = C.hydraulics;

  // Zonekleuren: verzadigd en zonder groen- of bruintinten, zodat leidingen op
  // gazon, beplanting en de ingeladen tekening goed zichtbaar blijven.
  const ZONE_COLORS = ['#d50000', '#2962ff', '#ff6d00', '#aa00ff', '#00b8d4', '#ffd600', '#e91e63', '#212121',
    '#1a237e', '#ff8a80', '#7c4dff', '#ffab00', '#880e4f', '#18ffff', '#bf360c', '#f50057'];
  // Vorig palet (met groen); bewaarde plannen krijgen de nieuwe kleur op dezelfde plek
  const OLD_ZONE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324',
    '#469990', '#800000', '#808000', '#000075', '#bfef45', '#fabed4', '#dcbeff', '#aaffc3'];

  /** Zet zonekleuren uit het oude palet om naar het contrastrijke palet. */
  function refreshZoneColors(state) {
    for (const z of state.zones || []) {
      const i = OLD_ZONE_COLORS.indexOf(String(z.color || '').toLowerCase());
      if (i >= 0) z.color = ZONE_COLORS[i];
    }
  }

  /** Drukverlies in bar voor lengte L [m], debiet q [l/h], binnendiameter d [mm]. */
  function lossBar(L, qLph, dMm) {
    if (L <= 0 || qLph <= 0) return 0;
    const Q = qLph / 3.6e6; // m³/s
    const d = dMm / 1000;
    const hf = (10.67 * L * Math.pow(Q, 1.852)) / (Math.pow(H.hazenC, 1.852) * Math.pow(d, 4.87));
    return (hf / 10.197) * H.minorLossFactor;
  }

  function velocity(qLph, dMm) {
    const Q = qLph / 3.6e6;
    const A = Math.PI * Math.pow(dMm / 2000, 2);
    return Q / A;
  }

  function pickPipe(qLph, minDn = 25) {
    for (const p of C.pipes) {
      if (p.dn < minDn) continue;
      if (velocity(qLph, p.id) <= H.maxVelocity) return p;
    }
    return C.pipes[C.pipes.length - 1];
  }

  /** Gekozen beregeningsmethode van een vlak: eigen keuze, anders projectstandaard, anders typestandaard. */
  function methodOf(state, area) {
    const t = C.areaTypes[area.type];
    if (!t || !t.methods) return area.type === 'lawn' ? 'sprinklers' : 'none';
    if (area.method && t.methods.includes(area.method)) return area.method;
    const d = state && state.settings && state.settings.methods && state.settings.methods[area.type];
    return d && t.methods.includes(d) ? d : t.defaultMethod;
  }

  const isDripMethod = (m) => m === 'dripline' || m === 'drippers';

  /** Vlakken die druppelirrigatie krijgen. */
  function dripAreas(state) {
    return state.areas.filter((a) => a.pts.length >= 3 && isDripMethod(methodOf(state, a)));
  }

  function hasIrrigation(state) {
    return state.sprinklers.length > 0 || dripAreas(state).length > 0;
  }

  /** Druppelgegevens van een vlak voor de gegeven methode (druppelslang of druppelaars). */
  function dripInfo(area, method = 'dripline') {
    const a = G.area(area.pts);
    const rect = G.minWidthRect(area.pts);
    if (method === 'drippers') {
      const D = C.drippers;
      let count;
      if (area.type === 'hedge') count = Math.ceil(rect.length / D.spacingHedge) * Math.max(1, Math.round(rect.width / 0.6));
      else if (area.type === 'planter') count = Math.max(D.minPerPlanter, Math.ceil(a * D.perM2Planter));
      else count = Math.max(1, Math.ceil(a * D.perM2Bed));
      const rows = area.type === 'planter' ? 1 : Math.max(1, Math.round(rect.width / D.supplyRowSpacing));
      const supplyM = Math.ceil(rect.length * rows + 1);
      const lph = count * D.lph;
      return { method, count, supplyM, microM: Math.ceil(count * D.microTubeM), lph, areaM2: a, mmh: lph / Math.max(a, 0.1), runs: rows };
    }
    const spacing = area.type === 'hedge' ? C.drip.rowSpacingHedge : area.type === 'planter' ? C.drip.rowSpacingPlanter : C.drip.rowSpacingBed;
    let lengthM;
    if (area.type === 'hedge') {
      // haag: lengte langs de lange zijde, aantal lijnen afhankelijk van de breedte
      const rect = G.minWidthRect(area.pts);
      const lines = Math.max(1, Math.round(rect.width / spacing));
      lengthM = rect.length * lines;
    } else {
      lengthM = Math.max(1, a / spacing);
    }
    lengthM = Math.ceil(lengthM);
    const lph = lengthM * C.drip.lphPerM;
    return { method, lengthM, lph, areaM2: a, spacing, mmh: lph / Math.max(a, 0.1), runs: Math.max(1, Math.ceil(lengthM / C.drip.maxRunM)) };
  }

  function element(state, kind) {
    return state.elements.find((e) => e.kind === kind) || null;
  }

  /** Ankerpunt voor leidingen: ventielkast, anders wateraansluiting, anders zwaartepunt. */
  function valveBoxPos(state) {
    const vb = element(state, 'valvebox') || element(state, 'source');
    if (vb) return { x: vb.x, y: vb.y };
    const all = state.sprinklers.map((s) => ({ x: s.x, y: s.y }));
    if (!all.length) return { x: 0, y: 0 };
    return { x: all.reduce((s, p) => s + p.x, 0) / all.length, y: all.reduce((s, p) => s + p.y, 0) / all.length };
  }

  function maxZoneLph(state) {
    return state.settings.flow * 1000 * H.zoneFlowFactor;
  }

  /** Alle beregenbare leden (sproeiers + druppelvlakken). */
  function members(state) {
    const vb = valveBoxPos(state);
    const list = [];
    for (const s of state.sprinklers) {
      const t = C.sprinklerTypes[s.type];
      // sproeiers in beplanting krijgen eigen zones (andere waterbehoefte dan gazon)
      const group = s.areaId ? `bed-${t.group === 'rotator' ? 'rotator' : 'spray'}` : t.group;
      list.push({ kind: 'spr', ref: s, group, q: C.sprinklerFlowLph(s), pos: { x: s.x, y: s.y } });
    }
    for (const a of dripAreas(state)) {
      const method = methodOf(state, a);
      const di = dripInfo(a, method);
      const entry = G.pointInPolygon(vb, a.pts) ? vb : G.closestOnPolygon(vb, a.pts).pt;
      list.push({ kind: 'drip', ref: a, group: method === 'drippers' ? 'drippers' : 'drip', q: di.lph, pos: entry, drip: di });
    }
    return list;
  }

  /** Automatische zone-indeling: per groep, gretig clusteren vanaf de verste kop. */
  function autoZones(state) {
    const vb = valveBoxPos(state);
    const maxQ = maxZoneLph(state);
    const all = members(state);
    const zones = [];
    const order = ['spray', 'rotator', 'rotor', 'bed-spray', 'bed-rotator', 'drip', 'drippers'];
    for (const group of order) {
      const pool = all.filter((m) => m.group === group);
      // Evenwichtige verdeling: streef naar gelijke zones binnen het maximum
      const total = pool.reduce((s, m) => s + m.q, 0);
      const k = Math.max(1, Math.ceil(total / maxQ - 1e-9));
      const cap = Math.min(maxQ, (total / k) * 1.12);
      while (pool.length) {
        pool.sort((a, b) => G.dist(b.pos, vb) - G.dist(a.pos, vb));
        const seed = pool.shift();
        const zone = { id: G.uid('z'), group, members: [seed], q: seed.q };
        let added = true;
        while (added) {
          added = false;
          let best = null, bestD = Infinity;
          for (const m of pool) {
            if (zone.q + m.q > cap) continue;
            const d = Math.min(...zone.members.map((z) => G.dist(z.pos, m.pos)));
            if (d < bestD) { bestD = d; best = m; }
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
    zones.sort((a, b) => {
      const da = Math.min(...a.members.map((m) => G.dist(m.pos, vb)));
      const db = Math.min(...b.members.map((m) => G.dist(m.pos, vb)));
      return da - db;
    });
    state.zones = zones.map((z, i) => ({
      id: z.id,
      name: `Zone ${i + 1}`,
      group: z.group,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
    }));
    for (const s of state.sprinklers) s.zone = null;
    for (const a of state.areas) if (a.zone) a.zone = null;
    zones.forEach((z) => z.members.forEach((m) => { m.ref.zone = z.id; }));
  }

  /** Prim-MST vanaf knoop 0. */
  function mst(points) {
    const n = points.length;
    const inTree = new Array(n).fill(false);
    const best = new Array(n).fill(Infinity);
    const parent = new Array(n).fill(-1);
    best[0] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = true;
      for (let v = 0; v < n; v++) {
        if (inTree[v]) continue;
        const d = G.dist(points[u], points[v]);
        if (d < best[v]) { best[v] = d; parent[v] = u; }
      }
    }
    return parent;
  }

  /**
   * Berekent leidingen en drukken voor alle zones. Resultaat in state.calc (niet opgeslagen).
   */
  function calculate(state) {
    refreshZoneColors(state);
    const vb = valveBoxPos(state);
    const src = element(state, 'source');
    const srcPos = src ? { x: src.x, y: src.y } : vb;
    const all = members(state);
    const warnings = [];
    const pipes = [];
    const zoneResults = [];

    if (!element(state, 'valvebox')) warnings.push('Geen ventielkast geplaatst: leidingen starten vanaf de wateraansluiting.');
    if (!src) warnings.push('Geen wateraansluiting geplaatst.');

    const zoneMembers = new Map(state.zones.map((z) => [z.id, []]));
    const unassigned = [];
    for (const m of all) {
      const z = m.ref.zone;
      if (z && zoneMembers.has(z)) zoneMembers.get(z).push(m);
      else unassigned.push(m);
    }
    if (unassigned.length) warnings.push(`${unassigned.length} onderdeel/onderdelen zonder zone. Gebruik "Zones automatisch indelen".`);

    const maxZoneQ = Math.max(0, ...state.zones.map((z) => (zoneMembers.get(z.id) || []).reduce((s, m) => s + m.q, 0)));
    const mainLen = G.dist(srcPos, vb) * 1.15;
    const mainPipe = pickPipe(Math.max(maxZoneQ, 1), 32);
    if (mainLen > 0.1) {
      pipes.push({ zone: null, main: true, a: srcPos, b: vb, dn: mainPipe.dn, q: maxZoneQ, len: mainLen });
    }

    const maxQ = maxZoneLph(state);
    for (const z of state.zones) {
      const ms = zoneMembers.get(z.id) || [];
      if (!ms.length) {
        zoneResults.push({ zone: z, members: [], q: 0, empty: true });
        continue;
      }
      const q = ms.reduce((s, m) => s + m.q, 0);
      const points = [vb, ...ms.map((m) => m.pos)];
      const parent = mst(points);
      const children = points.map(() => []);
      for (let i = 1; i < points.length; i++) children[parent[i]].push(i);
      const nodeQ = points.map((_, i) => (i === 0 ? 0 : ms[i - 1].q));
      const subQ = new Array(points.length).fill(0);
      const post = (i) => { subQ[i] = nodeQ[i] + children[i].reduce((s, c) => s + post(c), 0); return subQ[i]; };
      post(0);

      const pMain = lossBar(mainLen, q, mainPipe.id);
      const pStart = state.settings.pressure - H.headerLossBar - pMain - H.valveLossBar;
      const pressure = new Array(points.length).fill(0);
      pressure[0] = pStart;
      const edges = [];
      const dnAt = new Array(points.length).fill(0);
      const walk = (i) => {
        for (const c of children[i]) {
          const len = G.dist(points[i], points[c]) * 1.05;
          const pipe = pickPipe(subQ[c]);
          const loss = lossBar(len, subQ[c], pipe.id);
          pressure[c] = pressure[i] - loss;
          dnAt[c] = pipe.dn;
          edges.push({ zone: z.id, a: points[i], b: points[c], dn: pipe.dn, q: subQ[c], len, from: i, to: c,
            v: velocity(subQ[c], pipe.id), loss });
          walk(c);
        }
      };
      walk(0);
      pipes.push(...edges);

      let required = 0;
      let critical = Infinity;
      ms.forEach((m, k) => {
        const req = m.kind === 'drip' ? C.drip.regBar + 0.3 : C.headMinBar(m.ref);
        required = Math.max(required, req);
        critical = Math.min(critical, pressure[k + 1]);
        m.pressure = pressure[k + 1];
      });
      const degree = points.map((_, i) => children[i].length + (i === 0 ? 0 : 1));
      const ok = critical >= required && q <= maxQ * 1.0001;
      const zr = { zone: z, members: ms, q, pStart, critical, required, ok, edges, degree, dnAt, points,
        overflow: q > maxQ * 1.0001 };
      zoneResults.push(zr);
      if (zr.overflow) warnings.push(`${z.name}: debiet ${G.nl(q / 1000, 2)} m³/u is hoger dan het beschikbare debiet.`);
      if (critical < required) warnings.push(`${z.name}: druk bij de laatste sproeier ${G.nl(critical, 2)} bar is lager dan de vereiste ${G.nl(required, 1)} bar.`);
      const groups = new Set(ms.map((m) => m.group));
      if (groups.size > 1) warnings.push(`${z.name}: verschillende sproeiertypes in één zone (ongelijke neerslag).`);
    }

    // Waterpunten op de hoofdleiding
    const outlets = state.elements.filter((e) => e.kind === 'outlet');
    for (const o of outlets) {
      const c = G.closestOnSegment(o, srcPos, vb);
      const len = G.dist(o, c) * 1.1;
      if (len > 0.1) pipes.push({ zone: null, outlet: true, a: { x: c.x, y: c.y }, b: { x: o.x, y: o.y }, dn: 32, q: 0, len });
    }

    state.calc = { pipes, zones: zoneResults, warnings, mainPipe, mainLen, vb, srcPos, maxQ, unassigned };
    return state.calc;
  }

  window.Hydraulics = { lossBar, velocity, pickPipe, dripInfo, methodOf, dripAreas, hasIrrigation, isDripMethod, autoZones, calculate, members, valveBoxPos, maxZoneLph, ZONE_COLORS, refreshZoneColors };
})();
