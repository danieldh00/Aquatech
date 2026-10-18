/* Applicatielogica: status, stappen, panelen, opslaan/laden en export. */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;
  const Hy = window.Hydraulics;
  const Sim = window.Simulation;
  const BOM = window.BOM;

  const STORAGE_KEY = 'aquatech-beregeningsplanner-v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const eur = (v) => `€ ${fmt(v, 2)}`;

  const STEPS = [
    { id: 'project', title: 'Project & ondergrond' },
    { id: 'areas', title: 'Gebieden tekenen' },
    { id: 'system', title: 'Systeemelementen' },
    { id: 'sprinklers', title: 'Sproeiers' },
    { id: 'zones', title: 'Zones & leidingen' },
    { id: 'bom', title: 'Stuklijst & export' },
  ];

  function emptyState() {
    return {
      version: 1,
      meta: { name: 'Nieuw beregeningsplan', customer: '', address: '' },
      settings: { pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'rotator', radius: null,
        methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray' },
      background: null,
      areas: [],
      elements: [],
      sprinklers: [],
      zones: [],
      calc: null,
    };
  }

  const App = {
    state: emptyState(),
    step: 0,
    undoStack: [],
    redoStack: [],
    editor: null,
    sim: null,

    init() {
      this.editor = new window.Editor($('#canvas'), this);
      this._load();
      this._bindGlobal();
      this.renderSteps();
      this.showStep(this.step);
      this.recalc();
      this.refreshBackground().then(() => this.editor.fit());
      this.refreshAiStatus();
    },

    // ---------- Status & undo ----------
    snapshot() {
      const { areas, elements, sprinklers, zones, settings, meta } = this.state;
      return JSON.stringify({ areas, elements, sprinklers, zones, settings, meta });
    },
    checkpoint() {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
    },
    _restore(json) {
      Object.assign(this.state, JSON.parse(json));
      this.editor.selection = null;
      this.commit(false);
    },
    undo() {
      if (!this.undoStack.length) return;
      this.redoStack.push(this.snapshot());
      this._restore(this.undoStack.pop());
      this.toast('Ongedaan gemaakt');
    },
    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(this.snapshot());
      this._restore(this.redoStack.pop());
    },
    invalidate() {
      this.state.calc = null;
    },
    /** Na elke wijziging: herberekenen, opslaan en UI verversen. */
    commit(save = true) {
      this.recalc();
      if (save) this._save();
      this.onSelectionChanged();
      this.renderStepPanel();
      this.editor.render();
    },
    recalc() {
      const st = this.state;
      if (st.zones.length) Hy.calculate(st); else st.calc = null;
      if (this.editor.layers.heatmap) this.updateHeat();
      this.renderWarnings();
    },
    updateHeat() {
      const st = this.state;
      const lawnArea = st.areas.filter((a) => a.type === 'lawn').reduce((s, a) => s + G.area(a.pts), 0);
      const cell = Math.max(0.15, Math.min(0.5, Math.sqrt((lawnArea * 2 + 50) / 120000)));
      const sim = st.sprinklers.length ? Sim.simulate(st, cell) : null;
      this.sim = sim;
      this.editor.heat = sim ? { sim, canvas: Sim.toCanvas(sim) } : null;
    },

    _save() {
      try {
        const data = { ...this.state, calc: null, step: this.step };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        // Opslag vol (bijv. grote achtergrond) of geblokkeerd: zonder achtergrond proberen
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.state, calc: null, background: null, step: this.step }));
        } catch (e2) { /* negeren */ }
      }
    },
    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        this._apply(data);
        this.step = Math.min(STEPS.length - 1, data.step || 0);
      } catch (e) { /* negeren */ }
    },
    _apply(data) {
      const base = emptyState();
      this.state = {
        ...base,
        ...data,
        meta: { ...base.meta, ...(data.meta || {}) },
        settings: { ...base.settings, ...(data.settings || {}) },
        calc: null,
      };
    },

    // ---------- Objecten ----------
    findObject(hit) {
      if (!hit) return null;
      const st = this.state;
      if (hit.kind === 'area' || hit.kind === 'vertex' || hit.kind === 'midpoint') return st.areas.find((a) => a.id === hit.id);
      if (hit.kind === 'sprinkler') return st.sprinklers.find((s) => s.id === hit.id);
      if (hit.kind === 'element') return st.elements.find((e) => e.id === hit.id);
      return null;
    },
    addArea(type, pts) {
      this.checkpoint();
      const n = this.state.areas.filter((a) => a.type === type).length + 1;
      const area = { id: G.uid('a'), type, name: `${C.areaTypes[type].label} ${n}`, pts: pts.map((p) => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) })), zone: null };
      this.state.areas.push(area);
      this.editor.selection = { kind: 'area', id: area.id };
      this.commit();
      this.toast(`${C.areaTypes[type].label} toegevoegd (${fmt(G.area(area.pts))} m²)`);
    },
    placeElement(kind, w) {
      const et = C.elementTypes[kind];
      this.checkpoint();
      let el = et.single ? this.state.elements.find((e) => e.kind === kind) : null;
      if (el) { el.x = w.x; el.y = w.y; } else {
        el = { id: G.uid('e'), kind, x: w.x, y: w.y };
        this.state.elements.push(el);
      }
      this.editor.selection = { kind: 'element', id: el.id };
      this.commit();
      if (et.single) this.editor.setTool('select');
    },
    placeSprinkler(type, w) {
      const t = C.sprinklerTypes[type];
      this.checkpoint();
      const lawns = this.state.areas.filter((a) => a.type === 'lawn' && a.pts.length >= 3);
      const r = this.state.settings.radius || t.rDefault;
      const s = { id: G.uid('s'), type, x: w.x, y: w.y, r, start: 0, arc: 360, zone: null };
      if (type === 'strip') { s.r = 0; s.arc = 0; s.width = 1.5; s.len = 4.6; }
      const tol = Math.max(0.5, 10 / this.editor.view.scale);
      let best = null;
      for (const a of lawns) {
        const pts = G.orientCW(a.pts);
        // hoekpunt?
        for (let i = 0; i < pts.length; i++) {
          if (G.dist(pts[i], w) < tol) {
            const prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
            const start = G.angleOf(G.sub(next, pts[i]));
            const interior = G.normDeg(G.angleOf(G.sub(prev, pts[i])) - start) || 360;
            best = { pt: pts[i], start, arc: interior, edgeDir: G.sub(next, pts[i]) };
            break;
          }
        }
        if (best) break;
        const c = G.closestOnPolygon(w, pts);
        if (c.d < tol) {
          const a0 = pts[c.edge], b0 = pts[(c.edge + 1) % pts.length];
          best = { pt: c.pt, start: G.angleOf(G.sub(b0, a0)), arc: 180, edgeDir: G.sub(b0, a0) };
          break;
        }
      }
      if (best) {
        s.x = best.pt.x; s.y = best.pt.y;
        s.start = Math.round(best.start);
        if (type !== 'strip') s.arc = Math.round(best.arc);
      }
      this.state.sprinklers.push(s);
      this.editor.selection = { kind: 'sprinkler', id: s.id };
      this.commit();
    },
    deleteSelection() {
      const sel = this.editor.selection;
      if (!sel) return;
      this.checkpoint();
      const st = this.state;
      if (sel.kind === 'area') {
        st.areas = st.areas.filter((a) => a.id !== sel.id);
        st.sprinklers = st.sprinklers.filter((s) => s.areaId !== sel.id);
      }
      if (sel.kind === 'sprinkler') st.sprinklers = st.sprinklers.filter((s) => s.id !== sel.id);
      if (sel.kind === 'element') st.elements = st.elements.filter((e) => e.id !== sel.id);
      this.editor.selection = null;
      this._pruneZones();
      this.commit();
    },
    _pruneZones() {
      const st = this.state;
      const used = new Set([...st.sprinklers.map((s) => s.zone), ...st.areas.map((a) => a.zone)].filter(Boolean));
      st.zones = st.zones.filter((z) => used.has(z.id));
    },

    autoPlace(areaIds) {
      const st = this.state;
      const type = st.settings.sprinklerType;
      const lawns = st.areas.filter((a) => a.type === 'lawn' && a.pts.length >= 3 && (!areaIds || areaIds.includes(a.id)));
      if (!lawns.length) { this.toast('Teken eerst een gazonvlak (stap 2).', true); return; }
      this.checkpoint();
      let count = this._placeSprinklers(lawns, type);
      if (!areaIds) count += this._syncBedSprinklers(true);
      this.commit();
      this.toast(`${count} sproeiers geplaatst. Controleer de neerslagkaart.`);
    },
    /**
     * Sproeiers in beplanting/hagen in lijn brengen met de gekozen methode:
     * plaatsen waar 'sproeiers' gekozen is (of opnieuw bij `force`), weghalen waar niet.
     * @returns aantal geplaatste sproeiers
     */
    _syncBedSprinklers(force = false, onlyArea = null) {
      const st = this.state;
      let placed = 0;
      for (const a of st.areas) {
        if (onlyArea && a.id !== onlyArea) continue;
        if (a.type === 'lawn' || a.pts.length < 3) continue;
        const want = Hy.methodOf(st, a) === 'sprinklers';
        const has = st.sprinklers.some((s) => s.areaId === a.id);
        if (want && has && !force) continue;
        st.sprinklers = st.sprinklers.filter((s) => s.areaId !== a.id);
        if (!want) continue;
        const heads = window.Planner.autoPlace(a.pts, st.settings.bedSprinklerType || 'spray');
        heads.forEach((h) => { h.areaId = a.id; });
        st.sprinklers.push(...heads);
        placed += heads.length;
      }
      // bestaande indeling klopt niet meer als er sproeiers bij- of afkomen
      st.sprinklers.forEach((s) => { if (s.areaId && !st.zones.some((z) => z.id === s.zone)) s.zone = null; });
      this._pruneZones();
      return placed;
    },
    /** Na wijzigen van een methode: sproeiers bijwerken en zones opnieuw indelen als die er al waren. */
    _applyMethods(onlyArea = null) {
      const hadZones = this.state.zones.length > 0;
      this._syncBedSprinklers(false, onlyArea);
      if (hadZones && Hy.hasIrrigation(this.state)) Hy.autoZones(this.state);
    },
    _placeSprinklers(lawns, type) {
      const st = this.state;
      let count = 0;
      for (const a of lawns) {
        // verwijder bestaande sproeiers binnen of op de rand van dit vlak
        st.sprinklers = st.sprinklers.filter((s) => s.areaId || !(G.pointInPolygon(s, a.pts) || G.closestOnPolygon(s, a.pts).d < 0.05));
        const heads = window.Planner.autoPlace(a.pts, type, { r: st.settings.radius || null });
        st.sprinklers.push(...heads);
        count += heads.length;
      }
      this._pruneZones();
      st.zones = [];
      st.sprinklers.forEach((s) => { s.zone = null; });
      this.editor.layers.heatmap = true;
      $('#layer-heatmap').checked = true;
      return count;
    },
    autoZones() {
      if (!Hy.hasIrrigation(this.state)) {
        this.toast('Plaats eerst sproeiers of teken beplanting.', true);
        return;
      }
      this.checkpoint();
      Hy.autoZones(this.state);
      this.commit();
      this.toast(`${this.state.zones.length} zones ingedeeld`);
    },

    calibrate(measured) {
      const real = parseFloat(String(prompt(`Gemeten lijn: ${measured.toFixed(2)} (huidige eenheid).\nWat is de werkelijke lengte in meters?`, '') || '').replace(',', '.'));
      this.editor.setTool('select');
      if (!real || real <= 0) return;
      const f = real / measured;
      const st = this.state;
      this.checkpoint();
      if (st.background) {
        st.background.scale *= f;
        st.background.x *= f;
        st.background.y *= f;
      }
      const hasGeom = st.areas.length || st.sprinklers.length || st.elements.length;
      if (hasGeom && confirm('Ook de reeds getekende vlakken en elementen meeschalen?')) {
        st.areas.forEach((a) => { a.pts = a.pts.map((p) => ({ x: p.x * f, y: p.y * f })); });
        st.elements.forEach((e) => { e.x *= f; e.y *= f; });
        st.sprinklers.forEach((s) => { s.x *= f; s.y *= f; });
      }
      this.editor.view.scale /= f;
      this.editor.view.x *= f;
      this.editor.view.y *= f;
      this.commit();
      this.toast(`Schaal ingesteld (factor ${f.toFixed(3)})`);
    },

    refreshBackground() {
      const bg = this.state.background;
      if (!bg || !bg.dataUrl) { this.editor.bgImg = null; this.editor.render(); return Promise.resolve(); }
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { this.editor.bgImg = img; this.editor.render(); resolve(); };
        img.onerror = () => resolve();
        img.src = bg.dataUrl;
      });
    },
    /** Laadt een plan (JPG/PNG/PDF) als ondergrond; met `concept` meteen automatisch herkennen. */
    async loadBackground(file, { concept = false } = {}) {
      this.busy('Plan wordt geladen…');
      let loaded;
      try {
        loaded = await window.PlanImport.load(file);
      } catch (e) {
        this.busy(null);
        this.toast(`Kan plan niet laden: ${e.message}`, true);
        return;
      }
      const b = loaded.background;
      // voorlopige schaal: plan ca. 30 m breed; daarna herkennen of kalibreren
      this.state.background = { dataUrl: b.dataUrl, width: b.width, height: b.height, paper: b.paper || null, x: 0, y: 0, scale: window.Concept.FALLBACK_WIDTH_M / b.width, opacity: 0.6 };
      this._analyzeImage = loaded.analyze;
      if (!this.state.meta.name || this.state.meta.name === 'Nieuw beregeningsplan') this.state.meta.name = file.name.replace(/\.[^.]+$/, '');
      await this.refreshBackground();
      this._save();
      this.editor.fit();
      this.busy(null);
      this.renderStepPanel();
      if (loaded.pages > 1) this.toast(`PDF heeft ${loaded.pages} pagina's; de eerste pagina is geladen.`);
      if (concept) await this.makeConcept();
      else this.toast('Ondergrond geladen. Kalibreer de schaal of laat het concept automatisch maken.');
    },

    /** Plan laten herkennen en er een volledig, bewerkbaar concept van maken. */
    async makeConcept() {
      const st = this.state;
      if (!st.background || !st.background.dataUrl) { this.toast('Laad eerst een plan.', true); return; }
      if ((st.areas.length || st.sprinklers.length) && !confirm('Het huidige ontwerp wordt vervangen door een nieuw concept. Doorgaan?')) return;
      const useAi = this.aiStatus && this.aiStatus.available && st.settings.recognizer === 'ai';
      let result;
      const extraWarnings = [];
      try {
        const img = this._analyzeImage || await window.PlanImport.analyzeImageFrom(st.background.dataUrl);
        if (!img.paper && st.background.paper) img.paper = st.background.paper;
        this._analyzeImage = img;
        let raw = null;
        if (useAi) {
          this.busy('Plan wordt gelezen met AI: schaal, gazon, borders en bebouwing herkennen… Dit duurt meestal 1 à 2 minuten.');
          try {
            raw = await window.Concept.analyze(img);
          } catch (e) {
            extraWarnings.push(`AI-herkenning niet gelukt (${e.message}); lokaal herkend.`);
          }
        }
        if (!raw) {
          this.busy('Plan wordt lokaal gelezen (zonder AI)…');
          raw = await window.LocalRecognizer.analyze(img, (msg) => this.busy(`Plan wordt lokaal gelezen: ${msg}`));
        }
        result = window.Concept.build(raw, img);
        if (result.scaleInfo.estimated && result.gardenWidthPx) {
          // geen maat op het plan: liever de gebruiker vragen dan sproeiers op een verkeerde schaal plaatsen
          this.busy(null);
          const answer = prompt(`Er staat geen leesbare maat op het plan.\nHoe breed is de tuin ongeveer (de herkende vlakken, van links naar rechts) in meters?\n\nLeeg laten = aanname ${window.Concept.FALLBACK_GARDEN_M} m; kalibreren kan later altijd in stap 1.`, '');
          const widthM = parseFloat(String(answer || '').replace(',', '.'));
          if (widthM > 0 && widthM < 1000) result = window.Concept.build(raw, img, { gardenWidthM: widthM });
        }
        result.warnings.unshift(...extraWarnings);
        result.local = Boolean(raw.local);
      } catch (e) {
        this.busy(null);
        this.toast(e.message, true);
        this.conceptWarnings = [e.message];
        this.renderWarnings();
        this.refreshAiStatus();
        return;
      }
      this.checkpoint();
      Object.assign(st.background, { x: 0, y: 0, scale: result.backgroundScale });
      st.areas = result.areas;
      st.elements = result.elements;
      st.sprinklers = [];
      st.zones = [];
      this.editor.selection = null;
      const lawns = st.areas.filter((a) => a.type === 'lawn');
      let count = lawns.length ? this._placeSprinklers(lawns, st.settings.sprinklerType) : 0;
      count += this._syncBedSprinklers(true);
      if (Hy.hasIrrigation(st)) Hy.autoZones(st);
      this.conceptWarnings = result.warnings;
      this.busy(null);
      this.commit();
      this.editor.fit();
      this.showStep(3);
      const sc = result.scaleInfo;
      const scaleTxt = sc.estimated ? 'schaal niet gevonden' : `schaal via ${sc.method}${sc.confidence ? ` (${sc.confidence})` : ''}`;
      this.toast(`Concept gemaakt${result.local ? ' (lokaal)' : ' (AI)'}: ${st.areas.length} vlakken, ${count} sproeiers, ${st.zones.length} zones; ${scaleTxt}. Pas aan waar nodig.`);
      this.refreshAiStatus();
    },

    async refreshAiStatus() {
      this.aiStatus = await window.Concept.status();
      if (STEPS[this.step].id === 'project') this.renderStepPanel();
    },

    /** Toverstaf: vlak met dezelfde kleur rond het aangeklikte punt uittrekken. */
    wandAt(w, areaType) {
      const bg = this.state.background;
      if (!bg || !this.editor.bgImg) { this.toast('De toverstaf werkt op een geladen plan (stap 1).', true); return; }
      const ix = (w.x - bg.x) / bg.scale, iy = (w.y - bg.y) / bg.scale;
      const r = window.AutoTrace.wand(this.editor.bgImg, ix, iy, this.state.settings.wandTol || 40);
      if (r.error) { this.toast(r.error, true); return; }
      const pts = r.points.map((p) => ({ x: bg.x + p.x * bg.scale, y: bg.y + p.y * bg.scale }));
      this.addArea(areaType, pts);
    },

    busy(text) {
      const el = $('#busy');
      if (!el) return;
      el.classList.toggle('open', Boolean(text));
      if (text) $('#busy-text').textContent = text;
    },

    // ---------- Bestanden ----------
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    saveProject() {
      const data = { ...this.state, calc: null };
      const name = (this.state.meta.name || 'beregeningsplan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'beregeningsplan';
      this.download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${name}.aquaplan.json`);
    },
    openProject(file) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || !Array.isArray(data.areas)) throw new Error('Ongeldig bestand');
          this.checkpoint();
          this._apply(data);
          this.editor.selection = null;
          this.refreshBackground().then(() => this.editor.fit());
          this.commit();
          this.toast('Project geopend');
        } catch (e) {
          this.toast(`Kan bestand niet openen: ${e.message}`, true);
        }
      };
      reader.readAsText(file);
    },
    newProject() {
      if (!confirm('Nieuw project starten? Niet-opgeslagen wijzigingen gaan verloren.')) return;
      this.checkpoint();
      this.state = emptyState();
      this.conceptWarnings = [];
      this._analyzeImage = null;
      this.editor.selection = null;
      this.editor.bgImg = null;
      this.editor.heat = null;
      this.showStep(0);
      this.commit();
      this.editor.fit();
    },
    async exportExcel() {
      const btn = $('#btn-export-xlsx');
      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
        if (!this.state.zones.length) Hy.autoZones(this.state);
        Hy.calculate(this.state);
        const png = this.editor.exportPng(1500, 1000);
        const { blob, filename } = await BOM.exportXlsx(this.state, png);
        this.download(blob, filename);
        this.commit();
        this.toast('Excel-bestand gedownload');
      } catch (e) {
        console.error(e);
        this.toast(`Export mislukt: ${e.message}`, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Exporteer naar Excel'; }
      }
    },
    exportPlanPng() {
      const url = this.editor.exportPng(2400, 1600);
      fetch(url).then((r) => r.blob()).then((b) => this.download(b, 'beregeningsplan.png'));
    },

    // ---------- UI ----------
    _bindGlobal() {
      $('#btn-new').onclick = () => this.newProject();
      $('#btn-open').onclick = () => $('#file-open').click();
      $('#file-open').onchange = (e) => { if (e.target.files[0]) this.openProject(e.target.files[0]); e.target.value = ''; };
      $('#btn-save').onclick = () => this.saveProject();
      $('#btn-undo').onclick = () => this.undo();
      $('#btn-redo').onclick = () => this.redo();
      $('#btn-help').onclick = () => $('#help').classList.toggle('open');
      $('#help-close').onclick = () => $('#help').classList.remove('open');
      $('#tool-select').onclick = () => this.editor.setTool('select');
      $('#tool-pan').onclick = () => this.editor.setTool('pan');
      $('#tool-measure').onclick = () => this.editor.setTool('measure');
      $('#tool-fit').onclick = () => this.editor.fit();
      $('#tool-zoomin').onclick = () => this.editor.zoomAt(this.editor.w / 2, this.editor.h / 2, 1.25);
      $('#tool-zoomout').onclick = () => this.editor.zoomAt(this.editor.w / 2, this.editor.h / 2, 0.8);
      $('#btn-prev').onclick = () => this.showStep(this.step - 1);
      $('#btn-next').onclick = () => this.showStep(this.step + 1);
      for (const key of ['background', 'coverage', 'heatmap', 'pipes', 'labels']) {
        const el = $(`#layer-${key}`);
        el.checked = this.editor.layers[key];
        el.onchange = () => {
          this.editor.layers[key] = el.checked;
          if (key === 'heatmap' && el.checked) this.updateHeat();
          this.renderStepPanel();
          this.editor.render();
        };
      }
      $('#snap').checked = this.editor.snap;
      $('#snap').onchange = (e) => { this.editor.snap = e.target.checked; };
      // Tekenbalk (touch heeft geen Enter/Backspace/Esc)
      document.querySelectorAll('#drawbar [data-db]').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.db === 'undo') this.editor.undoPoint();
          else if (b.dataset.db === 'finish') this.editor.finishPolygon();
          else this.editor.cancelDraw();
        };
      });
      $('#btn-sheet').onclick = () => this._setSheet(document.body.classList.contains('sheet-collapsed'));
      $('#props-close').onclick = () => { this.editor.selection = null; this.onSelectionChanged(); this.renderStepPanel(); this.editor.render(); };
    },

    /** Mobiel: stappenpaneel in- of uitklappen voor meer tekenruimte. */
    _setSheet(open) {
      document.body.classList.toggle('sheet-collapsed', !open);
      const b = $('#btn-sheet');
      b.textContent = open ? '▾ Paneel' : '▴ Paneel';
      b.setAttribute('aria-expanded', String(open));
    },
    _isMobile() { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); },

    /** Toont de tekenbalk zolang er een teken- of plaatsgereedschap actief is. */
    updateDrawBar() {
      const bar = $('#drawbar');
      if (!bar || !this.editor) return;
      const ed = this.editor;
      const t = ed.tool;
      const show = t !== 'select' && t !== 'pan' && (ed.touch || t === 'polygon');
      bar.hidden = !show;
      if (!show) return;
      const n = ed.draft ? ed.draft.length : 0;
      bar.querySelector('[data-db="undo"]').hidden = t !== 'polygon';
      bar.querySelector('[data-db="undo"]').disabled = !n;
      bar.querySelector('[data-db="finish"]').hidden = t !== 'polygon';
      bar.querySelector('[data-db="finish"]').disabled = n < 3;
      bar.querySelector('[data-db="cancel"] span').textContent = n ? 'Annuleren' : 'Stoppen';
      const o = ed.toolOpts || {};
      const name = o.areaType ? C.areaTypes[o.areaType].label : o.kind ? C.elementTypes[o.kind].label : o.type ? C.sprinklerTypes[o.type].label : '';
      $('#drawbar-label').textContent = t === 'polygon' ? `${name}: ${n} punt${n === 1 ? '' : 'en'}` : name;
    },

    renderSteps() {
      $('#steps').innerHTML = STEPS.map((s, i) => `<button class="step" data-i="${i}"><span class="num">${i + 1}</span><span>${esc(s.title)}</span></button>`).join('');
      $('#steps').querySelectorAll('.step').forEach((b) => { b.onclick = () => this.showStep(+b.dataset.i); });
    },
    showStep(i) {
      this.step = Math.max(0, Math.min(STEPS.length - 1, i));
      document.querySelectorAll('#steps .step').forEach((b, k) => {
        b.classList.toggle('active', k === this.step);
        b.classList.toggle('done', k < this.step);
      });
      $('#btn-prev').disabled = this.step === 0;
      $('#btn-next').disabled = this.step === STEPS.length - 1;
      if (this.editor.tool !== 'select') this.editor.setTool('select');
      // passende lagen per stap
      if (STEPS[this.step].id === 'zones' && !this.state.zones.length && Hy.hasIrrigation(this.state)) {
        Hy.autoZones(this.state);
        this.recalc();
      }
      this.renderStepPanel();
      this._save();
      this.editor.render();
    },

    renderStepPanel() {
      const id = STEPS[this.step].id;
      const el = $('#step-panel');
      el.innerHTML = `<h2>${this.step + 1}. ${esc(STEPS[this.step].title)}</h2>` + this[`_panel_${id}`]();
      const bind = this[`_bind_${id}`];
      if (bind) bind.call(this, el);
    },

    // --- Stap 1
    _panel_project() {
      const m = this.state.meta;
      const bg = this.state.background;
      const ai = this.aiStatus ? { ...this.aiStatus, checked: true } : { available: false, checked: false };
      const s = this.state.settings;
      return `
        <label>Projectnaam<input id="m-name" value="${esc(m.name)}"></label>
        <label>Klant<input id="m-customer" value="${esc(m.customer)}"></label>
        <label>Adres<input id="m-address" value="${esc(m.address)}"></label>
        <h3>Beregeningsmethode</h3>
        <p class="hint small">Kies per soort vlak hoe het water krijgt. Per vlak kun je hier later van afwijken (eigenschappenpaneel).</p>
        <label>Gazon<select id="mth-lawn">${['rotator', 'spray', 'rotor'].map((k) => `<option value="${k}" ${s.sprinklerType === k ? 'selected' : ''}>${esc(C.sprinklerTypes[k].label)}</option>`).join('')}</select></label>
        ${['bed', 'hedge', 'planter'].map((type) => {
          const at = C.areaTypes[type];
          const cur = (s.methods && s.methods[type]) || at.defaultMethod;
          return `<label>${esc(at.label)}<select data-mth="${type}">${at.methods.map((k) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(C.methods[k].label)}</option>`).join('')}</select></label>`;
        }).join('')}
        <h3>Plan</h3>
        <p class="hint">Laad een tuinontwerp, plattegrond, schets of luchtfoto (JPG, PNG of PDF). De planner leest de schaal en de vlakken en maakt een concept met sproeiers, zones en leidingen dat je daarna aanpast.</p>
        ${ai.available ? `<label>Herkennen met<select id="recognizer">
            <option value="local" ${s.recognizer !== 'ai' ? 'selected' : ''}>Lokaal (zonder AI, gratis)</option>
            <option value="ai" ${s.recognizer === 'ai' ? 'selected' : ''}>AI (nauwkeuriger, API-tegoed; nog ${ai.remainingToday} vandaag)</option>
          </select></label>` : ''}
        <button id="plan-concept" class="btn primary">Plan laden en concept maken…</button>
        ${bg ? '<button id="bg-concept" class="btn">Concept maken van deze ondergrond</button>' : ''}
        <p class="hint small">${s.recognizer === 'ai' && ai.available
          ? 'De AI leest ook lijntekeningen en schetsen.'
          : 'Lokaal herkennen werkt het best op <b>gekleurde</b> tuinontwerpen: groen = gazon, donkergroen = haag, bruin/roze = beplanting, grijs/beige = bebouwing en verharding, blauw = water. De schaal wordt gelezen uit een maat met maatlijn (bijv. "12,00 m" of "1250").'}</p>
        <button id="bg-load" class="btn">${bg ? 'Ander plan als ondergrond laden…' : 'Alleen als ondergrond laden…'}</button>
        <input type="file" id="bg-file" accept="image/*,application/pdf,.pdf" hidden>
        ${bg ? `
          <h3>Schaal</h3>
          <p class="hint small">Huidige schaal: plan is ${fmt((bg.width || (this.editor.bgImg && this.editor.bgImg.naturalWidth) || 0) * bg.scale)} m breed.</p>
          <button id="bg-cal" class="btn">Schaal kalibreren</button>
          <p class="hint">Trek een lijn over een bekende maat (bijv. gevel of tegelpad) en voer de lengte in.</p>
          <label>Transparantie <input id="bg-op" type="range" min="0.1" max="1" step="0.05" value="${bg.opacity}"></label>
          <button id="bg-del" class="btn danger">Ondergrond verwijderen</button>` : ''}
      `;
    },
    _bind_project(el) {
      const m = this.state.meta;
      ['name', 'customer', 'address'].forEach((k) => {
        $(`#m-${k}`, el).oninput = (e) => { m[k] = e.target.value; this._save(); if (k === 'name') $('#project-title').textContent = m.name; };
      });
      $('#project-title').textContent = m.name;
      if ($('#recognizer', el)) $('#recognizer', el).onchange = (e) => { this.state.settings.recognizer = e.target.value; this._save(); this.renderStepPanel(); };
      $('#mth-lawn', el).onchange = (e) => { this.state.settings.sprinklerType = e.target.value; this.state.settings.radius = null; this._save(); };
      el.querySelectorAll('[data-mth]').forEach((sel) => {
        sel.onchange = () => {
          this.checkpoint();
          this.state.settings.methods = { ...(this.state.settings.methods || {}), [sel.dataset.mth]: sel.value };
          this._applyMethods();
          this.commit();
          this.toast(`${C.areaTypes[sel.dataset.mth].label}: ${C.methods[sel.value].label}`);
        };
      });
      let concept = false;
      $('#bg-load', el).onclick = () => { concept = false; $('#bg-file', el).click(); };
      if ($('#plan-concept', el)) $('#plan-concept', el).onclick = () => { concept = true; $('#bg-file', el).click(); };
      if ($('#bg-concept', el)) $('#bg-concept', el).onclick = () => this.makeConcept();
      $('#bg-file', el).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadBackground(f, { concept }); };
      if ($('#bg-cal', el)) {
        $('#bg-cal', el).onclick = () => { this.editor.setTool('calibrate'); this.toast('Trek een lijn over een bekende maat.'); };
        $('#bg-op', el).oninput = (e) => { this.state.background.opacity = +e.target.value; this.editor.render(); };
        $('#bg-op', el).onchange = () => this._save();
        $('#bg-del', el).onclick = () => { this.state.background = null; this.editor.bgImg = null; this._save(); this.renderStepPanel(); this.editor.render(); };
      }
    },

    // --- Stap 2
    _panel_areas() {
      const rows = this.state.areas.map((a) => `
        <tr data-id="${a.id}" class="${this.editor.selection && this.editor.selection.id === a.id ? 'sel' : ''}">
          <td><span class="swatch" style="background:${C.areaTypes[a.type].stroke}"></span>${esc(a.name)}</td>
          <td class="num">${fmt(G.area(a.pts))} m²</td>
        </tr>`).join('');
      const btns = Object.entries(C.areaTypes).map(([k, t]) => `
        <div class="area-tool">
          <span class="swatch" style="background:${t.stroke}"></span><span class="lbl">${esc(t.label)}</span>
          ${this.state.background ? `<button class="btn sm" data-tool="wand" data-type="${k}" title="Klik in het plan om het vlak automatisch uit te trekken">Toverstaf</button>` : ''}
          <button class="btn sm" data-tool="polygon" data-type="${k}" title="Vrije vorm">Vrije vorm</button>
          <button class="btn sm" data-tool="rect" data-type="${k}" title="Rechthoek">Rechthoek</button>
        </div>`).join('');
      return `
        <p class="hint">Teken eerst het gazon, daarna beplanting en hagen (druppelirrigatie) en vlakken die nat mogen worden of droog moeten blijven.</p>
        ${btns}
        ${this.state.background ? `<label>Gevoeligheid toverstaf <input id="wand-tol" type="range" min="10" max="120" step="5" value="${this.state.settings.wandTol || 40}"></label>
        <p class="hint small"><b>Toverstaf:</b> klik midden in een vlak op het plan; de planner trekt de rand met dezelfde kleur uit. Te veel? Verlaag de gevoeligheid. Te weinig? Verhoog hem.</p>` : ''}
        <p class="hint small"><b>Vrije vorm:</b> klik punten, sluit door op het eerste punt te klikken, dubbel te klikken of Enter. Backspace = laatste punt weg, Shift = hoeken van 45°, Alt = niet op het raster uitlijnen.<br>
        <b>Bewerken:</b> selecteer een vlak; sleep hoekpunten of de middenpunten van randen (nieuw hoekpunt).</p>
        <h3>Vlakken</h3>
        ${rows ? `<table class="list">${rows}</table>` : '<p class="hint">Nog geen vlakken.</p>'}
      `;
    },
    _bind_areas(el) {
      if ($('#wand-tol', el)) $('#wand-tol', el).onchange = (e) => { this.state.settings.wandTol = +e.target.value; this._save(); };
      el.querySelectorAll('[data-tool]').forEach((b) => {
        b.onclick = () => this.editor.setTool(b.dataset.tool, { areaType: b.dataset.type });
      });
      el.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.onclick = () => { this.editor.selection = { kind: 'area', id: tr.dataset.id }; this.onSelectionChanged(); this.renderStepPanel(); this.editor.render(); };
      });
    },

    // --- Stap 3
    _panel_system() {
      const s = this.state.settings;
      const btns = Object.entries(C.elementTypes).map(([k, t]) => {
        const placed = this.state.elements.filter((e) => e.kind === k).length;
        return `<button class="btn elem" data-kind="${k}"><span class="badge" style="background:${t.color}">${t.short}</span>${esc(t.label)}${placed ? ` <span class="ok">✓${placed > 1 ? ' ' + placed : ''}</span>` : ''}</button>`;
      }).join('');
      return `
        <p class="hint">Plaats de wateraansluiting, de beregeningscomputer en de ventielkast. Waterpunten (tappunten) worden op de hoofdleiding aangesloten.</p>
        ${btns}
        <h3>Wateraansluiting</h3>
        <label>Dynamische waterdruk (bar)<input id="s-pressure" type="number" step="0.1" min="1" max="10" value="${s.pressure}"></label>
        <label>Beschikbaar debiet (m³/u)<input id="s-flow" type="number" step="0.1" min="0.3" max="20" value="${s.flow}"></label>
        <p class="hint small"><b>Emmertest:</b> vul een emmer van 10 liter bij volledig geopende kraan en meet de tijd t (s). Debiet = 36 / t m³/u (bijv. 18 s → 2,0 m³/u). Meet de druk met een manometer terwijl de kraan open staat.</p>
        <p class="hint small">Max. debiet per zone: <b>${fmt(Hy.maxZoneLph(this.state) / 1000, 2)} m³/u</b> (${Math.round(C.hydraulics.zoneFlowFactor * 100)}% van het beschikbare debiet).</p>
      `;
    },
    _bind_system(el) {
      el.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => this.editor.setTool('element', { kind: b.dataset.kind }); });
      $('#s-pressure', el).onchange = (e) => { this.checkpoint(); this.state.settings.pressure = +e.target.value || 3.5; this.commit(); };
      $('#s-flow', el).onchange = (e) => { this.checkpoint(); this.state.settings.flow = +e.target.value || 2; this.commit(); };
    },

    // --- Stap 4
    _panel_sprinklers() {
      const s = this.state.settings;
      const types = ['rotator', 'spray', 'rotor'].map((k) => {
        const t = C.sprinklerTypes[k];
        return `<label class="radio"><input type="radio" name="stype" value="${k}" ${s.sprinklerType === k ? 'checked' : ''}>
          <span><b>${esc(t.label)}</b><br><span class="small">${G.nlShort(t.rMin, 1)}–${G.nlShort(t.rMax, 1)} m · ${t.pr} mm/u · min. ${G.nlShort(t.minBar, 1)} bar. ${esc(t.note)}</span></span></label>`;
      }).join('');
      const sim = this.editor.layers.heatmap ? this.sim : null;
      const st = sim && sim.stats;
      const counts = {};
      this.state.sprinklers.forEach((x) => { counts[x.type] = (counts[x.type] || 0) + 1; });
      const countTxt = Object.entries(counts).map(([k, n]) => `${n}× ${C.sprinklerTypes[k].short}`).join(', ') || 'geen';
      return `
        <h3>Sproeiertype</h3>
        ${types}
        <label class="inline"><input type="checkbox" id="r-auto" ${s.radius ? '' : 'checked'}> Worpwijdte automatisch</label>
        ${s.radius ? `<label>Worpwijdte (m)<input id="r-val" type="number" step="0.1" value="${s.radius}"></label>` : ''}
        <button id="auto-place" class="btn primary">Automatisch plaatsen</button>
        <p class="hint small">Plaatst sproeiers op alle gazons en in beplanting waarvoor <b>Sproeiers</b> als methode gekozen is (stap 1).</p>
        <div class="row">
          <button class="btn" id="manual-place">Handmatig plaatsen</button>
          <button class="btn" id="manual-strip">Strooksproeier</button>
        </div>
        <button class="btn danger" id="clear-spr">Alle sproeiers verwijderen</button>
        <p class="hint small">Smalle stroken (&lt; ${window.Planner.NARROW_WIDTH} m) krijgen automatisch strooksproeiers. Bij handmatig plaatsen op een rand of hoek wordt de sproeihoek automatisch ingesteld. Sleep een sproeier om te verplaatsen; pas sproeihoek en worpwijdte aan in het eigenschappenpaneel.</p>
        <h3>Neerslagsimulatie</h3>
        <p class="small">Sproeiers: ${countTxt}</p>
        ${st ? `
          <table class="kv">
            <tr><td>Gem. neerslag gazon</td><td>${fmt(st.mean)} mm/u</td></tr>
            <tr><td>Gelijkmatigheid (DU)</td><td class="${st.du >= 0.7 ? 'good' : st.du >= 0.55 ? 'warn' : 'bad'}">${fmt(st.du * 100, 0)}%</td></tr>
            <tr><td>Droge plekken</td><td class="${st.dryPct < 2 ? 'good' : st.dryPct < 6 ? 'warn' : 'bad'}">${fmt(st.dryPct)}%</td></tr>
            <tr><td>Water op droog te houden vlakken</td><td class="${sim.overspray < 0.5 ? 'good' : 'warn'}">${fmt(sim.overspray)} m²</td></tr>
          </table>
          <div class="legend"><span style="background:#d32f2f"></span>droog <span style="background:#ffc107"></span>weinig <span style="background:#388e3c"></span>goed <span style="background:#1e88e5"></span>veel</div>
          <p class="hint small">Streefwaarde gelijkmatigheid ≥ 70% (goed), ≥ 55% (acceptabel).</p>`
        : '<p class="hint">Zet de laag <b>Neerslagkaart</b> aan om de verdeling te zien.</p>'}
      `;
    },
    _bind_sprinklers(el) {
      const s = this.state.settings;
      el.querySelectorAll('input[name=stype]').forEach((r) => { r.onchange = () => { s.sprinklerType = r.value; s.radius = null; this._save(); this.renderStepPanel(); }; });
      $('#r-auto', el).onchange = (e) => { s.radius = e.target.checked ? null : C.sprinklerTypes[s.sprinklerType].rDefault; this._save(); this.renderStepPanel(); };
      if ($('#r-val', el)) $('#r-val', el).onchange = (e) => { const t = C.sprinklerTypes[s.sprinklerType]; s.radius = Math.max(t.rMin, Math.min(t.rMax, +e.target.value || t.rDefault)); this._save(); this.renderStepPanel(); };
      $('#auto-place', el).onclick = () => this.autoPlace();
      $('#manual-place', el).onclick = () => this.editor.setTool('sprinkler', { type: s.sprinklerType });
      $('#manual-strip', el).onclick = () => this.editor.setTool('sprinkler', { type: 'strip' });
      $('#clear-spr', el).onclick = () => {
        if (!this.state.sprinklers.length || !confirm('Alle sproeiers verwijderen?')) return;
        this.checkpoint();
        this.state.sprinklers = [];
        this._pruneZones();
        this.commit();
      };
    },

    // --- Stap 5
    _panel_zones() {
      const calc = this.state.calc;
      const zr = calc ? calc.zones.filter((z) => !z.empty) : [];
      const rows = zr.map((z) => `
        <tr>
          <td><span class="swatch" style="background:${z.zone.color}"></span>${esc(z.zone.name)}</td>
          <td>${esc(C.groups[z.zone.group].label)}</td>
          <td class="num">${z.members.length}</td>
          <td class="num">${fmt(z.q / 1000, 2)}</td>
          <td class="num ${z.ok ? 'good' : 'bad'}">${fmt(z.critical, 2)}</td>
        </tr>`).join('');
      const pipeTot = {};
      if (calc) calc.pipes.forEach((p) => { pipeTot[p.dn] = (pipeTot[p.dn] || 0) + p.len; });
      return `
        <p class="hint">Sproeiers worden per type gegroepeerd in zones die binnen het beschikbare debiet (${fmt(Hy.maxZoneLph(this.state) / 1000, 2)} m³/u) blijven. Leidingen worden als kortste boomstructuur vanaf de ventielkast berekend, inclusief drukverlies (Hazen-Williams).</p>
        <button id="auto-zones" class="btn primary">Zones automatisch indelen</button>
        <p class="hint small">Een sproeier handmatig naar een andere zone verplaatsen? Selecteer de sproeier en kies de zone in het eigenschappenpaneel.</p>
        ${rows ? `
          <table class="list zones">
            <tr><th>Zone</th><th>Type</th><th>Aantal</th><th>m³/u</th><th>bar*</th></tr>
            ${rows}
          </table>
          <p class="hint small">* druk bij de laatste sproeier, na aftrek van de verliezen in hoofdleiding, ventiel en leidingen.</p>
          <h3>Leidingen</h3>
          <table class="kv">${Object.keys(pipeTot).sort((a, b) => a - b).map((dn) => `<tr><td>PE ${dn} mm</td><td>${fmt(pipeTot[dn])} m</td></tr>`).join('')}</table>`
        : '<p class="hint">Nog geen zones.</p>'}
      `;
    },
    _bind_zones(el) {
      $('#auto-zones', el).onclick = () => this.autoZones();
    },

    // --- Stap 6
    _panel_bom() {
      const s = this.state.settings;
      if (!this.state.zones.length && Hy.hasIrrigation(this.state)) {
        Hy.autoZones(this.state);
        Hy.calculate(this.state);
      }
      let rows = [];
      try { rows = this.state.calc ? BOM.build(this.state) : []; } catch (e) { console.error(e); }
      const total = rows.reduce((t, r) => t + r.total, 0);
      const sched = this.state.calc ? BOM.schedule(this.state) : [];
      const levels = Object.entries(C.levels).map(([k, l]) => `
        <label class="radio"><input type="radio" name="level" value="${k}" ${s.level === k ? 'checked' : ''}><span><b>${l.label}</b> – <span class="small">${esc(l.desc)}</span></span></label>`).join('');
      return `
        <h3>Uitvoeringsniveau</h3>
        ${levels}
        <button id="btn-export-xlsx" class="btn primary">Exporteer naar Excel</button>
        <div class="row">
          <button id="btn-export-png" class="btn">Plan als PNG</button>
          <button id="btn-print" class="btn">Afdrukken</button>
        </div>
        <h3>Beregeningsschema</h3>
        <div class="row">
          <label>Weekgift (mm)<input id="t-mm" type="number" min="5" max="50" value="${s.targetMm}"></label>
          <label>Beurten/week<input id="t-ses" type="number" min="1" max="7" value="${s.sessions}"></label>
        </div>
        ${sched.length ? `<table class="list"><tr><th>Zone</th><th>mm/u</th><th>min/beurt</th></tr>
          ${sched.map((x) => `<tr><td><span class="swatch" style="background:${x.zone.color}"></span>${esc(x.zone.name)}</td><td class="num">${fmt(x.pr, 0)}</td><td class="num">${Math.round(x.minutesSession)}</td></tr>`).join('')}</table>` : ''}
        <h3>Stuklijst (${rows.length} regels)</h3>
        ${rows.length ? `<table class="list bom">
          <tr><th>Omschrijving</th><th>Aantal</th><th>Totaal</th></tr>
          ${rows.map((r) => `<tr title="${esc(r.code)}${r.notes ? ' – ' + esc(r.notes) : ''}"><td>${esc(r.name)}</td><td class="num">${r.qty} ${esc(r.unit)}</td><td class="num">${eur(r.total)}</td></tr>`).join('')}
          <tr class="total"><td>Totaal excl. btw (indicatief)</td><td></td><td class="num">${eur(total)}</td></tr>
        </table>` : '<p class="hint">Nog geen onderdelen – plaats sproeiers en deel zones in.</p>'}
      `;
    },
    _bind_bom(el) {
      const s = this.state.settings;
      el.querySelectorAll('input[name=level]').forEach((r) => { r.onchange = () => { s.level = r.value; this._save(); this.renderStepPanel(); }; });
      $('#btn-export-xlsx', el).onclick = () => this.exportExcel();
      $('#btn-export-png', el).onclick = () => this.exportPlanPng();
      $('#btn-print', el).onclick = () => window.print();
      $('#t-mm', el).onchange = (e) => { s.targetMm = Math.max(1, +e.target.value || 20); this._save(); this.renderStepPanel(); };
      $('#t-ses', el).onchange = (e) => { s.sessions = Math.max(1, Math.min(7, +e.target.value || 3)); this._save(); this.renderStepPanel(); };
    },

    // --- Eigenschappenpaneel
    onSelectionChanged() {
      const el = $('#props');
      const sel = this.editor.selection;
      const obj = this.findObject(sel);
      document.body.classList.toggle('has-sel', !!obj);
      if (!obj) {
        el.innerHTML = '<p class="hint">Selecteer een vlak, sproeier of element om de eigenschappen te bewerken.</p>';
        return;
      }
      if (sel.kind === 'area') el.innerHTML = this._propsArea(obj);
      else if (sel.kind === 'sprinkler') el.innerHTML = this._propsSprinkler(obj);
      else el.innerHTML = this._propsElement(obj);
      this._bindProps(el, sel, obj);
    },
    _propsArea(a) {
      const opts = Object.entries(C.areaTypes).map(([k, t]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
      let extra = '';
      const at = C.areaTypes[a.type];
      if (at.methods && a.pts.length >= 3) {
        const method = Hy.methodOf(this.state, a);
        const def = (this.state.settings.methods && this.state.settings.methods[a.type]) || at.defaultMethod;
        const mOpts = `<option value="">Standaard (${esc(C.methods[def].label)})</option>` + at.methods.map((k) => `<option value="${k}" ${a.method === k ? 'selected' : ''}>${esc(C.methods[k].label)}</option>`).join('');
        extra = `<label>Beregening<select data-f="method">${mOpts}</select></label><p class="hint small">${esc(C.methods[method].desc)}</p>`;
        if (method === 'dripline') {
          const di = Hy.dripInfo(a, method);
          extra += `<table class="kv"><tr><td>Druppelslang</td><td>${di.lengthM} m</td></tr><tr><td>Rijafstand</td><td>${fmt(di.spacing * 100, 0)} cm</td></tr><tr><td>Debiet</td><td>${fmt(di.lph / 60)} l/min</td></tr><tr><td>Gift</td><td>${fmt(di.mmh)} mm/u</td></tr></table>`;
        } else if (method === 'drippers') {
          const di = Hy.dripInfo(a, method);
          extra += `<table class="kv"><tr><td>Druppelaars</td><td>${di.count} × ${fmt(C.drippers.lph, 0)} l/u</td></tr><tr><td>Aanvoerbuis 16 mm</td><td>${di.supplyM} m</td></tr><tr><td>Microbuis</td><td>${di.microM} m</td></tr><tr><td>Debiet</td><td>${fmt(di.lph / 60)} l/min</td></tr><tr><td>Gift</td><td>${fmt(di.mmh)} mm/u</td></tr></table>`;
        } else if (method === 'sprinklers') {
          const n = this.state.sprinklers.filter((s) => s.areaId === a.id).length;
          extra += `<table class="kv"><tr><td>Sproeiers</td><td>${n}</td></tr></table><button class="btn" data-act="bedplace">Sproeiers opnieuw plaatsen</button>`;
        }
      }
      if (a.type === 'lawn') {
        const rect = G.minWidthRect(a.pts);
        extra = `<table class="kv"><tr><td>Min. breedte</td><td>${fmt(rect.width, 2)} m</td></tr></table><button class="btn primary" data-act="autoplace">Sproeiers plaatsen in dit vlak</button>`;
      }
      return `
        <h3>Vlak</h3>
        <label>Naam<input data-f="name" value="${esc(a.name)}"></label>
        <label>Type<select data-f="type">${opts}</select></label>
        <table class="kv"><tr><td>Oppervlak</td><td>${fmt(G.area(a.pts))} m²</td></tr><tr><td>Omtrek</td><td>${fmt(G.perimeter(a.pts))} m</td></tr><tr><td>Hoekpunten</td><td>${a.pts.length}</td></tr></table>
        ${extra}
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    _propsSprinkler(s) {
      const t = C.sprinklerTypes[s.type];
      const typeOpts = Object.entries(C.sprinklerTypes).map(([k, tt]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${esc(tt.label)}</option>`).join('');
      const zoneOpts = `<option value="">– geen –</option>` + this.state.zones.map((z) => `<option value="${z.id}" ${s.zone === z.id ? 'selected' : ''}>${esc(z.name)} (${esc(C.groups[z.group].label)})</option>`).join('');
      let p = null;
      if (this.state.calc) this.state.calc.zones.forEach((zr) => (zr.members || []).forEach((m) => { if (m.ref === s) p = m.pressure; }));
      const geom = s.type === 'strip'
        ? `<label>Breedte (m)<input data-f="width" type="number" step="0.1" min="${t.wMin}" max="${t.wMax}" value="${s.width}"></label>
           <label>Lengte (m)<input data-f="len" type="number" step="0.1" min="${t.lMin}" max="${t.lMax}" value="${s.len}"></label>`
        : `<label>Worpwijdte (m) <span class="small">${G.nlShort(t.rMin, 1)}–${G.nlShort(t.rMax, 1)}</span><input data-f="r" type="number" step="0.1" min="${t.rMin}" max="${t.rMax}" value="${s.r}"></label>
           <label>Sproeihoek (°)<input data-f="arc" type="number" step="5" min="10" max="360" value="${s.arc}"></label>
           <div class="row"><button class="btn sm" data-arc="90">90°</button><button class="btn sm" data-arc="180">180°</button><button class="btn sm" data-arc="270">270°</button><button class="btn sm" data-arc="360">360°</button></div>`;
      return `
        <h3>Sproeier</h3>
        <label>Type<select data-f="type">${typeOpts}</select></label>
        ${geom}
        <label>Richting (°)<input data-f="start" type="number" step="5" value="${s.start}"></label>
        <div class="row"><button class="btn sm" data-rot="-15">⟲ 15°</button><button class="btn sm" data-rot="15">⟳ 15°</button><button class="btn sm" data-rot="90">⟳ 90°</button></div>
        <label>Zone<select data-f="zone">${zoneOpts}</select></label>
        <table class="kv">
          <tr><td>Debiet</td><td>${fmt(C.sprinklerFlowLph(s) / 60, 2)} l/min</td></tr>
          <tr><td>Neerslag</td><td>${t.pr} mm/u</td></tr>
          <tr><td>Min. druk</td><td>${G.nlShort(t.minBar, 1)} bar</td></tr>
          ${p != null ? `<tr><td>Berekende druk</td><td class="${p >= t.minBar ? 'good' : 'bad'}">${fmt(p, 2)} bar</td></tr>` : ''}
        </table>
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    _propsElement(e) {
      const et = C.elementTypes[e.kind];
      const s = this.state.settings;
      return `
        <h3>${esc(et.label)}</h3>
        ${e.kind === 'source' ? `
          <label>Waterdruk (bar)<input data-s="pressure" type="number" step="0.1" value="${s.pressure}"></label>
          <label>Debiet (m³/u)<input data-s="flow" type="number" step="0.1" value="${s.flow}"></label>` : ''}
        <table class="kv"><tr><td>Positie</td><td>${fmt(e.x, 2)}, ${fmt(e.y, 2)} m</td></tr></table>
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    _bindProps(el, sel, obj) {
      el.querySelectorAll('[data-f]').forEach((inp) => {
        inp.onchange = () => {
          this.checkpoint();
          const f = inp.dataset.f;
          let v = inp.value;
          if (inp.type === 'number') v = parseFloat(v);
          if (f === 'zone') v = v || null;
          if (sel.kind === 'sprinkler') {
            const t0 = C.sprinklerTypes[obj.type];
            if (f === 'type') {
              const nt = C.sprinklerTypes[v];
              obj.type = v;
              if (v === 'strip') { obj.width = obj.width || 1.5; obj.len = obj.len || 4.6; }
              else obj.r = Math.max(nt.rMin, Math.min(nt.rMax, obj.r || nt.rDefault));
              if (v !== 'strip' && !obj.arc) obj.arc = 180;
              const z = this.state.zones.find((zz) => zz.id === obj.zone);
              if (z && z.group !== nt.group) obj.zone = null;
            } else if (f === 'r') obj.r = Math.max(t0.rMin, Math.min(t0.rMax, v || t0.rDefault));
            else if (f === 'arc') obj.arc = Math.max(10, Math.min(360, v || 180));
            else if (f === 'start') obj.start = G.normDeg(v || 0);
            else if (f === 'width') obj.width = Math.max(t0.wMin, Math.min(t0.wMax, v || 1.5));
            else if (f === 'len') obj.len = Math.max(t0.lMin, Math.min(t0.lMax, v || 4.6));
            else obj[f] = v;
          } else if (sel.kind === 'area') {
            if (f === 'method') obj.method = v || null;
            else obj[f] = v;
            if (f === 'type') { obj.zone = null; obj.method = null; }
            if (f === 'type' || f === 'method') this._applyMethods(obj.id);
          }
          this._pruneZones();
          this.commit();
        };
      });
      el.querySelectorAll('[data-s]').forEach((inp) => {
        inp.onchange = () => { this.checkpoint(); this.state.settings[inp.dataset.s] = parseFloat(inp.value) || this.state.settings[inp.dataset.s]; this.commit(); };
      });
      el.querySelectorAll('[data-arc]').forEach((b) => { b.onclick = () => { this.checkpoint(); obj.arc = +b.dataset.arc; this.commit(); }; });
      el.querySelectorAll('[data-rot]').forEach((b) => { b.onclick = () => { this.checkpoint(); obj.start = G.normDeg(obj.start + +b.dataset.rot); this.commit(); }; });
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.act === 'delete') this.deleteSelection();
          if (b.dataset.act === 'autoplace') this.autoPlace([obj.id]);
          if (b.dataset.act === 'bedplace') { this.checkpoint(); this._syncBedSprinklers(true, obj.id); if (this.state.zones.length) Hy.autoZones(this.state); this.commit(); }
        };
      });
    },

    renderWarnings() {
      const el = $('#warnings');
      if (!el) return;
      const calc = this.state.calc;
      const list = (this.conceptWarnings || []).concat(calc ? calc.warnings : []);
      if (this.sim && this.editor.layers.heatmap && this.sim.stats && this.sim.stats.dryPct > 6) list.push(`Droge plekken: ${fmt(this.sim.stats.dryPct)}% van het gazon krijgt te weinig water.`);
      if (this.sim && this.editor.layers.heatmap && this.sim.overspray > 0.5) list.push(`Er valt water op ${fmt(this.sim.overspray)} m² die droog moet blijven.`);
      el.innerHTML = list.length ? `<h3>Aandachtspunten</h3><ul>${list.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    },

    onToolChanged(tool, opts) {
      const touch = this.editor && this.editor.touch;
      const touchHints = {
        select: 'Tik om te selecteren · sleep om te verplaatsen · één vinger op een lege plek = verschuiven · knijpen = zoomen',
        pan: 'Sleep om het plan te verschuiven · knijpen = zoomen',
        polygon: `Tekenen: ${opts.areaType ? C.areaTypes[opts.areaType].label : ''} – tik de hoekpunten aan; tik op het eerste punt of op Vorm sluiten · slepen = verschuiven`,
        element: `Plaats: ${opts.kind ? C.elementTypes[opts.kind].label : ''} – tik op het plan`,
        sprinkler: `Plaats: ${opts.type ? C.sprinklerTypes[opts.type].label : ''} – tik in of op de rand van het gazon`,
        wand: `Toverstaf: ${opts.areaType ? C.areaTypes[opts.areaType].label : ''} – tik midden in het vlak op het plan`,
      };
      const hints = {
        select: 'Klik om te selecteren · sleep om te verplaatsen · scrollen = zoomen · spatiebalk of rechtermuisknop + slepen = verschuiven',
        pan: 'Sleep om het plan te verschuiven',
        polygon: `Tekenen: ${opts.areaType ? C.areaTypes[opts.areaType].label : ''} – klik de hoekpunten aan, sluit af op het eerste punt of met Enter · Esc = annuleren`,
        rect: `Rechthoek: ${opts.areaType ? C.areaTypes[opts.areaType].label : ''} – sleep van hoek naar hoek`,
        element: `Plaats: ${opts.kind ? C.elementTypes[opts.kind].label : ''} – klik op het plan`,
        sprinkler: `Plaats: ${opts.type ? C.sprinklerTypes[opts.type].label : ''} – klik in of op de rand van het gazon · Esc = stoppen`,
        calibrate: 'Kalibreren: sleep een lijn over een bekende maat',
        wand: `Toverstaf: ${opts.areaType ? C.areaTypes[opts.areaType].label : ''} – klik midden in het vlak op het plan · Esc = stoppen`,
        measure: 'Meten: sleep een lijn',
      };
      $('#hint').textContent = (touch && touchHints[tool]) || hints[tool] || '';
      // mobiel: bij tekenen het paneel inklappen voor meer ruimte, bij selecteren weer openen
      if (this._isMobile() && tool !== 'pan' && tool !== this._lastTool) this._setSheet(tool === 'select');
      this._lastTool = tool;
      document.querySelectorAll('.toolbar [data-t]').forEach((b) => b.classList.toggle('active', b.dataset.t === tool));
    },
    onMouseMove(w) {
      $('#coords').textContent = `x ${fmt(w.x, 2)} m · y ${fmt(w.y, 2)} m`;
    },

    toast(msg, err = false) {
      const t = $('#toast');
      t.textContent = msg;
      t.className = `toast show${err ? ' err' : ''}`;
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { t.className = 'toast'; }, 3500);
    },

    /** Voorbeeldproject om de werking te tonen. */
    loadDemo() {
      this.checkpoint();
      const st = emptyState();
      st.meta.name = 'Voorbeeldtuin';
      st.areas = [
        { id: G.uid('a'), type: 'dry', name: 'Woning', pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }, { x: 0, y: 4 }] },
        { id: G.uid('a'), type: 'dry', name: 'Terras', pts: [{ x: 2, y: 4 }, { x: 9, y: 4 }, { x: 9, y: 8 }, { x: 2, y: 8 }] },
        { id: G.uid('a'), type: 'lawn', name: 'Gazon achter', pts: [{ x: 0, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 20 }, { x: 0, y: 20 }] },
        { id: G.uid('a'), type: 'lawn', name: 'Gazonstrook', pts: [{ x: 13.5, y: 0 }, { x: 15.5, y: 0 }, { x: 15.5, y: 20 }, { x: 13.5, y: 20 }] },
        { id: G.uid('a'), type: 'bed', name: 'Border', pts: [{ x: 0, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 21.5 }, { x: 0, y: 21.5 }] },
        { id: G.uid('a'), type: 'hedge', name: 'Haag', pts: [{ x: 0, y: 21.5 }, { x: 15.5, y: 21.5 }, { x: 15.5, y: 22.3 }, { x: 0, y: 22.3 }] },
      ];
      st.elements = [
        { id: G.uid('e'), kind: 'source', x: 11.5, y: 3.5 },
        { id: G.uid('e'), kind: 'controller', x: 11.5, y: 1 },
        { id: G.uid('e'), kind: 'valvebox', x: 12.8, y: 6 },
        { id: G.uid('e'), kind: 'outlet', x: 9.5, y: 7.5 },
      ];
      this.state = st;
      this.editor.selection = null;
      this.editor.bgImg = null;
      this.commit();
      this.autoPlace();
      Hy.autoZones(this.state);
      this.commit();
      this.editor.fit();
      this.showStep(3);
    },
  };

  window.App = App;
  window.addEventListener('DOMContentLoaded', () => {
    App.init();
    const demo = document.getElementById('btn-demo');
    if (demo) demo.onclick = () => App.loadDemo();
  });
})();
