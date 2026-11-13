/* Canvas-editor: weergave, zoom/pan, tekenen, selecteren en verslepen. */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;

  class Editor {
    /**
     * Maakt de editor op een canvas en koppelt de muis-, touch- en toetsenbordbediening.
     * @param {HTMLCanvasElement} canvas het tekenvlak
     * @param {object} app de planner-app (state, acties en terugmeldingen)
     */
    constructor(canvas, app) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.app = app;
      this.view = { x: -2, y: -2, scale: 40 }; // px per meter
      this.tool = 'select';
      this.toolOpts = {};
      this.draft = null; // punten tijdens tekenen
      this.hover = null;
      this.selection = null; // {kind:'area'|'sprinkler'|'element', id}
      this.drag = null;
      this.mouse = { x: 0, y: 0, wx: 0, wy: 0 };
      this.snap = true;
      this.gridStep = 0.5;
      this.layers = { background: true, coverage: true, heatmap: false, pipes: true, labels: true };
      this.bgImg = null;
      this.heat = null;
      this.spaceDown = false;
      // Handje tijdens het tekenen: verschuiven zonder de lopende vorm af te breken
      this.panHold = false;
      // Aangetikt hoekpunt van het geselecteerde vlak (verwijderen met Delete of de knop)
      this.activeVertex = null;
      // Touch: actieve vingers, pinch-gebaar en grotere tolerantie voor vingers
      this.pointers = new Map();
      this.pinch = null;
      this.gestureLock = false;
      this.touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      this._bind();
      this.resize();
    }

    /**
     * De actuele planstand van de app.
     * @returns {object} de planstand
     */
    get state() { return this.app.state; }

    // ---------- Transformaties ----------
    /**
     * Rekent een punt in meters om naar schermpixels.
     * @param {{x: number, y: number}} point punt in meters
     * @returns {{x: number, y: number}} punt in schermpixels
     */
    toScreen(point) { return { x: (point.x - this.view.x) * this.view.scale, y: (point.y - this.view.y) * this.view.scale }; }
    /**
     * Rekent schermpixels om naar een punt in meters.
     * @param {number} screenX x in schermpixels
     * @param {number} screenY y in schermpixels
     * @returns {{x: number, y: number}} punt in meters
     */
    toWorld(screenX, screenY) { return { x: screenX / this.view.scale + this.view.x, y: screenY / this.view.scale + this.view.y }; }

    /** Past het canvas aan de maat van het omliggende element aan (ook voor scherpe weergave op retina) en tekent opnieuw. */
    resize() {
      const rect = this.cv.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.cv.width = Math.max(1, Math.floor(rect.width * dpr));
      this.cv.height = Math.max(1, Math.floor(rect.height * dpr));
      this.cv.style.width = `${rect.width}px`;
      this.cv.style.height = `${rect.height}px`;
      this.dpr = dpr;
      this.w = rect.width;
      this.h = rect.height;
      this.render();
    }

    /**
     * Zoomt in of uit rond een schermpunt; dat punt blijft op dezelfde plek staan.
     * @param {number} screenX x van het zoompunt in schermpixels
     * @param {number} screenY y van het zoompunt in schermpixels
     * @param {number} factor zoomfactor (groter dan 1 = inzoomen)
     */
    zoomAt(screenX, screenY, factor) {
      const before = this.toWorld(screenX, screenY);
      this.view.scale = Math.max(2, Math.min(400, this.view.scale * factor));
      const after = this.toWorld(screenX, screenY);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
      this.render();
    }

    /** Zoomt zo dat alle vlakken, sproeiers, elementen en de ondergrond in beeld passen. */
    fit() {
      const points = [];
      this.state.areas.forEach((area) => points.push(...area.pts));
      this.state.sprinklers.forEach((sprinkler) => points.push(sprinkler));
      this.state.elements.forEach((element) => points.push(element));
      const bg = this.state.background;
      if (bg && bg.dataUrl && this.bgImg) {
        points.push({ x: bg.x, y: bg.y }, { x: bg.x + this.bgImg.width * bg.scale, y: bg.y + this.bgImg.height * bg.scale });
      }
      if (!points.length) { this.view = { x: -2, y: -2, scale: 40 }; this.render(); return; }
      const box = Geo.bbox(points);
      const pad = 1.5;
      const scaleX = this.w / (box.w + 2 * pad || 10);
      const scaleY = this.h / (box.h + 2 * pad || 10);
      this.view.scale = Math.max(2, Math.min(200, Math.min(scaleX, scaleY)));
      this.view.x = box.minX - pad - (this.w / this.view.scale - box.w - 2 * pad) / 2;
      this.view.y = box.minY - pad - (this.h / this.view.scale - box.h - 2 * pad) / 2;
      this.render();
    }

    /**
     * Kiest een gereedschap en breekt een lopende tekening af.
     * @param {string} tool gereedschap (select, pan, polygon, rect, element, wand, sprinkler, calibrate, measure)
     * @param {object} opts opties van het gereedschap (zoals vlaktype of sproeiertype)
     */
    setTool(tool, opts = {}) {
      this.tool = tool;
      this.toolOpts = opts;
      this.draft = null;
      this.panHold = false;
      this.activeVertex = null;
      this._cursor();
      this.app.onToolChanged(tool, opts);
      this.render();
    }

    /** Zet de muisaanwijzer die bij het gereedschap past. */
    _cursor() {
      const tool = this.tool;
      this.cv.style.cursor = tool === 'pan' || this.panHold || this.spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    }

    /**
     * Is er een teken- of plaatsgereedschap actief (alles behalve selecteren/schuiven)?
     * @returns {boolean} true tijdens tekenen of plaatsen
     */
    isDrawing() { return this.tool !== 'select' && this.tool !== 'pan'; }

    /**
     * Handje: tijdens het tekenen schakelt het verschuiven aan of uit zonder
     * het gereedschap of de lopende vorm te verliezen; anders gereedschap 'pan'.
     */
    togglePan() {
      if (!this.isDrawing()) { this.setTool(this.tool === 'pan' ? 'select' : 'pan'); return; }
      this.panHold = !this.panHold;
      this._cursor();
      this.app.onToolChanged(this.tool, this.toolOpts);
      this.render();
    }

    /**
     * Verschuift het beeld met een aantal schermpixels.
     * @param {number} dx verschuiving horizontaal in schermpixels
     * @param {number} dy verschuiving verticaal in schermpixels
     */
    panBy(dx, dy) {
      this.view.x += dx / this.view.scale;
      this.view.y += dy / this.view.scale;
      this.render();
    }

    /**
     * Tolerantie in schermpixels; ruimer bij bediening met de vinger.
     * @param {number} px tolerantie voor de muis
     * @returns {number} tolerantie voor het huidige invoerapparaat
     */
    _tol(px) { return this.touch ? Math.round(px * 2.2) : px; }

    /**
     * Vangt een punt: op een bestaand hoekpunt, met Shift op een veelvoud van 45° vanaf het vorige punt, en op het raster (Alt = niet).
     * @param {{x: number, y: number}} point punt in meters
     * @param {Event} [event] muisgebeurtenis (voor Shift/Alt)
     * @returns {{x: number, y: number, snapped?: boolean}} het gevangen punt; `snapped` alleen als een bestaand hoekpunt is geraakt
     */
    snapPoint(point, event) {
      let result = { x: point.x, y: point.y };
      // Snap naar bestaande hoekpunten
      const tol = this._tol(8) / this.view.scale;
      for (const area of this.state.areas) {
        for (const vertex of area.pts) if (Geo.dist(vertex, point) < tol) return { x: vertex.x, y: vertex.y, snapped: true };
      }
      if (this.draft && this.draft.length) {
        for (const vertex of this.draft) if (Geo.dist(vertex, point) < tol) return { x: vertex.x, y: vertex.y, snapped: true };
        if (event && event.shiftKey) {
          const last = this.draft[this.draft.length - 1];
          const delta = Geo.sub(point, last);
          const angle = Math.round(Math.atan2(delta.y, delta.x) / (Math.PI / 4)) * (Math.PI / 4);
          const length = Geo.len(delta);
          result = { x: last.x + Math.cos(angle) * length, y: last.y + Math.sin(angle) * length };
        }
      }
      if (this.snap && !(event && event.altKey)) {
        const step = this.gridStep;
        result = { x: Math.round(result.x / step) * step, y: Math.round(result.y / step) * step };
      }
      return result;
    }

    // ---------- Hit-testing ----------
    /**
     * Zoekt wat er onder een punt ligt: greep, hoekpunt, element, sproeier of vlak.
     * @param {{x: number, y: number}} world punt in meters
     * @returns {object|null} wat geraakt is ({kind, id, ...}) of null
     */
    hitTest(world) {
      const tol = this._tol(7) / this.view.scale;
      // Hoekpunten en middens van het geselecteerde vlak gaan voor: er staan
      // vaak sproeiers op de rand, die mogen het bewerken niet blokkeren.
      if (this.selection && this.selection.kind === 'area') {
        const area = this.state.areas.find((candidate) => candidate.id === this.selection.id);
        if (area) {
          let best = null;
          for (let i = 0; i < area.pts.length; i++) {
            const distance = Geo.dist(area.pts[i], world);
            if (distance < tol && (!best || distance < best.d)) best = { d: distance, hit: { kind: 'vertex', id: area.id, index: i } };
          }
          if (best) return best.hit;
          for (let i = 0; i < area.pts.length; i++) {
            const next = area.pts[(i + 1) % area.pts.length];
            const mid = { x: (area.pts[i].x + next.x) / 2, y: (area.pts[i].y + next.y) / 2 };
            if (Geo.dist(mid, world) < tol) return { kind: 'midpoint', id: area.id, index: i };
          }
        }
      }
      for (const element of [...this.state.elements].reverse()) {
        if (Geo.dist(element, world) < Math.max(tol * 1.5, 0.35)) return { kind: 'element', id: element.id };
      }
      // grepen van de geselecteerde sproeier (worp en sproeihoek)
      if (this.selection && this.selection.kind === 'sprinkler') {
        const sprinkler = this.state.sprinklers.find((candidate) => candidate.id === this.selection.id);
        if (sprinkler) for (const handle of this.sprinklerHandles(sprinkler)) if (Geo.dist(handle, world) < tol * 1.4) return { kind: 'handle', id: sprinkler.id, which: handle.which };
      }
      for (const sprinkler of [...this.state.sprinklers].reverse()) {
        if (Geo.dist(sprinkler, world) < Math.max(tol, 0.25)) return { kind: 'sprinkler', id: sprinkler.id };
      }
      // kleinste vlak eerst (zodat bedden binnen een gazon selecteerbaar zijn)
      const hits = this.state.areas.filter((area) => area.pts.length >= 3 && Geo.pointInPolygon(world, area.pts));
      hits.sort((left, right) => Geo.area(left.pts) - Geo.area(right.pts));
      if (hits.length) return { kind: 'area', id: hits[0].id };
      return null;
    }

    /**
     * Grepen van een sproeier: worp (midden van de boog) en begin/einde van de sproeihoek.
     * @param {object} sprinkler de sproeier
     * @returns {Array<{x: number, y: number, which: string}>} de grepen ('r', 'a0', 'a1')
     */
    sprinklerHandles(sprinkler) {
      if (sprinkler.type === 'strip' || !(sprinkler.r > 0)) return [];
      /**
       * Punt op de worpcirkel onder een hoek, als greep.
       * @param {number} deg hoek in graden
       * @param {string} which soort greep
       * @returns {{x: number, y: number, which: string}} de greep
       */
      const handleAt = (deg, which) => ({ x: sprinkler.x + Math.cos(Geo.rad(deg)) * sprinkler.r, y: sprinkler.y + Math.sin(Geo.rad(deg)) * sprinkler.r, which });
      if (sprinkler.arc >= 359.9) return [handleAt(sprinkler.start, 'r')];
      return [handleAt(sprinkler.start + sprinkler.arc / 2, 'r'), handleAt(sprinkler.start, 'a0'), handleAt(sprinkler.start + sprinkler.arc, 'a1')];
    }

    /**
     * Slepen aan een greep: worp of sproeihoek aanpassen (rotators binnen het bereik van hun kop).
     * @param {object} sprinkler de sproeier (wordt aangepast)
     * @param {string} which de greep ('r' = worp, 'a0' = begin, 'a1' = einde van de sproeihoek)
     * @param {{x: number, y: number}} world muispositie in meters
     * @param {boolean} free zonder afronding (Alt ingedrukt)
     */
    _dragHandle(sprinkler, which, world, free) {
      const range = Catalog.headRange(sprinkler);
      /**
       * Rondt een hoek af op hele graden (vrij) of op 5°.
       * @param {number} degrees hoek in graden
       * @returns {number} afgeronde hoek
       */
      const snapDegrees = (degrees) => (free ? Math.round(degrees) : Math.round(degrees / 5) * 5);
      if (which === 'r') {
        const radius = Geo.dist(sprinkler, world);
        sprinkler.r = Math.max(range.rMin, Math.min(range.rMax, free ? Math.round(radius * 100) / 100 : Math.round(radius * 10) / 10));
        Catalog.fitRotator(sprinkler);
        return;
      }
      const angle = snapDegrees(Geo.angleOf(Geo.sub(world, sprinkler)));
      if (which === 'a1') {
        sprinkler.arc = Math.max(10, Geo.normDeg(angle - sprinkler.start) || 360);
        Catalog.fitRotator(sprinkler);
      } else {
        const end = sprinkler.start + sprinkler.arc;
        sprinkler.start = Geo.normDeg(angle);
        sprinkler.arc = Math.max(10, Geo.normDeg(end - sprinkler.start) || 360);
        Catalog.fitRotator(sprinkler);
        sprinkler.start = Math.round(Geo.normDeg(end - sprinkler.arc)); // einde blijft staan, ook als de sector de hoek begrenst
      }
    }

    // ---------- Events ----------
    /** Koppelt de muis-, touch-, wiel- en toetsenbordgebeurtenissen aan de editor. */
    _bind() {
      const cv = this.cv;
      cv.addEventListener('contextmenu', (event) => event.preventDefault());
      // Scrollwiel/touchpad schuift het plan (Shift = horizontaal); Ctrl/Cmd +
      // scrollen of knijpen op het touchpad zoomt. Werkt ook tijdens het tekenen.
      cv.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = cv.getBoundingClientRect();
        if (event.ctrlKey || event.metaKey) {
          this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * 0.004));
          return;
        }
        const unitFactor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.h : 1;
        let dx = event.deltaX * unitFactor, dy = event.deltaY * unitFactor;
        if (event.shiftKey && !dx) { dx = dy; dy = 0; }
        this.panBy(dx, dy);
        this._move(event);
      }, { passive: false });

      cv.addEventListener('pointerdown', (event) => this._down(event));
      cv.addEventListener('pointermove', (event) => this._move(event));
      cv.addEventListener('pointerup', (event) => this._up(event));
      cv.addEventListener('pointercancel', (event) => this._cancel(event));
      // Geen 'ghost click' na een tik: anders landt de klik op het paneel dat net onder de vinger verschijnt
      cv.addEventListener('touchend', (event) => { if (event.cancelable) event.preventDefault(); }, { passive: false });
      cv.addEventListener('dblclick', (event) => this._dbl(event));
      window.addEventListener('resize', () => this.resize());
      // Paneel in- of uitklappen (mobiel) verandert de canvasmaat zonder window-resize
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(cv.parentElement);
      window.addEventListener('keydown', (event) => {
        if (event.target && /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
        if (event.code === 'Space') { this.spaceDown = true; cv.style.cursor = 'grab'; event.preventDefault(); }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[event.key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const step = event.shiftKey ? this.w / 2 : 80;
          this.panBy(arrows[event.key][0] * step, arrows[event.key][1] * step);
          event.preventDefault();
        }
        if (event.key === 'Escape') {
          if (this.draft) { this.draft = null; this.render(); } else this.setTool('select');
        }
        if (event.key === 'Enter' && this.draft) this._finishPolygon();
        if (event.key === 'Backspace' && this.draft && this.draft.length) { this.undoPoint(); event.preventDefault(); }
        else if ((event.key === 'Delete' || event.key === 'Backspace') && !this.draft && this.activeVertex) { this.removeVertex(); event.preventDefault(); }
        else if ((event.key === 'Delete' || event.key === 'Backspace') && !this.draft && this.selection) { this.app.deleteSelection(); event.preventDefault(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? this.app.redo() : this.app.undo(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); this.app.redo(); }
      });
      window.addEventListener('keyup', (event) => {
        if (event.code === 'Space') { this.spaceDown = false; this._cursor(); }
      });
    }

    /**
     * Positie van een muisgebeurtenis op het scherm en in meters.
     * @param {MouseEvent} event de gebeurtenis
     * @returns {{sx: number, sy: number, w: {x: number, y: number}}} schermpositie en punt in meters
     */
    _evPos(event) {
      const rect = this.cv.getBoundingClientRect();
      const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
      const world = this.toWorld(sx, sy);
      return { sx, sy, w: world };
    }

    /**
     * Begin van een klik of aanraking: tekent, plaatst, selecteert of start slepen/verschuiven.
     * @param {PointerEvent} event de gebeurtenis
     */
    _down(event) {
      const { sx, sy, w: world } = this._evPos(event);
      this.cv.setPointerCapture(event.pointerId);
      const touch = event.pointerType === 'touch';
      if (touch !== this.touch) { this.touch = touch; this.app.onToolChanged(this.tool, this.toolOpts); }
      this.pointers.set(event.pointerId, { x: sx, y: sy });
      if (this.pointers.size >= 2) { this._startPinch(); return; }
      if (this.gestureLock) return;
      this.mouse = { x: sx, y: sy, wx: world.x, wy: world.y };
      if (event.button === 1 || event.button === 2 || this.tool === 'pan' || this.spaceDown || this.panHold) {
        this.drag = { mode: 'pan', sx, sy, vx: this.view.x, vy: this.view.y };
        this.cv.style.cursor = 'grabbing';
        return;
      }
      const tool = this.tool;
      // Vinger: tikken plaatst een punt of element (bij loslaten), slepen verschuift het plan.
      // Zo zet een tweevinger-pinch nooit per ongeluk een punt neer.
      if (touch && (tool === 'polygon' || tool === 'element' || tool === 'wand' || tool === 'sprinkler')) {
        this.drag = { mode: 'tap', sx, sy, vx: this.view.x, vy: this.view.y, w: tool === 'polygon' ? this.snapPoint(world, event) : world };
        this.mouse = { x: sx, y: sy, wx: this.drag.w.x, wy: this.drag.w.y };
        this.render();
        return;
      }
      if (tool === 'polygon') {
        const point = this.snapPoint(world, event);
        if (!this.draft) this.draft = [point];
        else if (this.draft.length >= 3 && Geo.dist(point, this.draft[0]) < this._tol(10) / this.view.scale) this._finishPolygon();
        else this.draft.push(point);
        this.render();
        return;
      }
      if (tool === 'rect' || tool === 'calibrate' || tool === 'measure') {
        const point = tool === 'rect' ? this.snapPoint(world, event) : world;
        this.drag = { mode: tool, start: point, end: point };
        return;
      }
      if (tool === 'element') {
        this.app.placeElement(this.toolOpts.kind, world);
        return;
      }
      if (tool === 'wand') {
        this.app.wandAt(world, this.toolOpts.areaType);
        return;
      }
      if (tool === 'sprinkler') {
        this.app.placeSprinkler(this.toolOpts.type, world, this.toolOpts);
        return;
      }
      // select
      const hit = this.hitTest(world);
      if (hit && hit.kind === 'handle') {
        this.drag = { mode: 'handle', id: hit.id, which: hit.which, moved: false, sx, sy };
        return;
      }
      if (hit && hit.kind === 'vertex') {
        this._setActiveVertex({ id: hit.id, index: hit.index });
        this.drag = { mode: 'vertex', id: hit.id, index: hit.index, moved: false, sx, sy };
        this.render();
        return;
      }
      if (hit && hit.kind === 'midpoint') {
        const area = this.state.areas.find((candidate) => candidate.id === hit.id);
        this.app.checkpoint();
        area.pts.splice(hit.index + 1, 0, this.snapPoint(world, event));
        this._setActiveVertex({ id: hit.id, index: hit.index + 1 });
        this.drag = { mode: 'vertex', id: hit.id, index: hit.index + 1, moved: true, noCheckpoint: true };
        this.render();
        return;
      }
      this.activeVertex = null;
      this.selection = hit;
      this.app.onSelectionChanged();
      if (hit) {
        const obj = this.app.findObject(hit);
        const orig = hit.kind === 'area' ? obj.pts.map((point) => ({ ...point })) : { x: obj.x, y: obj.y };
        this.drag = { mode: 'move', hit, start: world, orig, moved: false, withHeads: hit.kind === 'area' && event.altKey };
      } else if (touch) {
        // vinger op een lege plek: slepen verschuift het plan
        this.drag = { mode: 'pan', sx, sy, vx: this.view.x, vy: this.view.y };
      }
      this.render();
    }

    /**
     * Beweging van muis of vinger: verschuift, sleept of werkt de hover bij.
     * @param {PointerEvent} event de gebeurtenis
     */
    _move(event) {
      const { sx, sy, w: world } = this._evPos(event);
      if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: sx, y: sy });
      if (this.pinch) { this._updatePinch(); return; }
      if (this.gestureLock) return;
      this.mouse = { x: sx, y: sy, wx: world.x, wy: world.y };
      this.app.onMouseMove(world);
      const drag = this.drag;
      if (drag) {
        if (drag.mode === 'pan') {
          this.view.x = drag.vx - (sx - drag.sx) / this.view.scale;
          this.view.y = drag.vy - (sy - drag.sy) / this.view.scale;
        } else if (drag.mode === 'tap') {
          if (!drag.panning && Math.hypot(sx - drag.sx, sy - drag.sy) > 10) drag.panning = true;
          if (drag.panning) {
            this.view.x = drag.vx - (sx - drag.sx) / this.view.scale;
            this.view.y = drag.vy - (sy - drag.sy) / this.view.scale;
          }
          // voorbeeldlijn blijft naar het getikte punt wijzen
          const screenPoint = this.toScreen(drag.w);
          this.mouse = { x: screenPoint.x, y: screenPoint.y, wx: drag.w.x, wy: drag.w.y };
        } else if (drag.mode === 'rect') {
          drag.end = this.snapPoint(world, event);
        } else if (drag.mode === 'calibrate' || drag.mode === 'measure') {
          drag.end = world;
        } else if (drag.mode === 'vertex') {
          if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < (this.touch ? 6 : 1)) return;
          if (!drag.moved && !drag.noCheckpoint) this.app.checkpoint();
          drag.moved = true;
          const area = this.state.areas.find((candidate) => candidate.id === drag.id);
          area.pts[drag.index] = this.snapPoint(world, event);
          this.app.invalidate();
        } else if (drag.mode === 'handle') {
          if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < (this.touch ? 6 : 1)) return;
          if (!drag.moved) this.app.checkpoint();
          drag.moved = true;
          const sprinkler = this.state.sprinklers.find((candidate) => candidate.id === drag.id);
          if (sprinkler) this._dragHandle(sprinkler, drag.which, world, event.altKey);
          this.app.invalidate();
        } else if (drag.mode === 'move') {
          const dx = world.x - drag.start.x, dy = world.y - drag.start.y;
          if (!drag.moved && Math.hypot(dx, dy) * this.view.scale < this._tol(3)) return;
          if (!drag.moved) this.app.checkpoint();
          drag.moved = true;
          const obj = this.app.findObject(drag.hit);
          if (drag.hit.kind === 'area') {
            let ox = dx, oy = dy;
            if (this.snap && !event.altKey) { ox = Math.round(dx / this.gridStep) * this.gridStep; oy = Math.round(dy / this.gridStep) * this.gridStep; }
            obj.pts = drag.orig.map((point) => ({ x: point.x + ox, y: point.y + oy }));
          } else {
            obj.x = drag.orig.x + dx;
            obj.y = drag.orig.y + dy;
            if (this.snap && !event.altKey && drag.hit.kind === 'sprinkler') {
              // snap sproeier op dichtstbijzijnde vlakrand als dichtbij
              const tol = this._tol(8) / this.view.scale;
              for (const area of this.state.areas) {
                const closest = Geo.closestOnPolygon(obj, area.pts);
                if (closest.d < tol) { obj.x = closest.pt.x; obj.y = closest.pt.y; break; }
              }
            }
          }
          this.app.invalidate();
        }
        this.render();
        return;
      }
      if (event.pointerType === 'touch') return;
      if (this.draft || this.tool !== 'select') { this.render(); return; }
      const hovered = this.hitTest(world);
      const changed = JSON.stringify(hovered) !== JSON.stringify(this.hover);
      this.hover = hovered;
      this.cv.style.cursor = hovered ? (hovered.kind === 'vertex' || hovered.kind === 'midpoint' ? 'pointer' : hovered.kind === 'handle' ? 'crosshair' : 'move') : 'default';
      if (changed) this.render();
    }

    /**
     * Einde van een klik of aanraking: rondt het slepen af (vlak toevoegen, kalibreren, meten of vastleggen).
     * @param {PointerEvent} event de gebeurtenis
     */
    _up(event) {
      this.pointers.delete(event.pointerId);
      if (this.pinch || this.gestureLock) {
        if (this.pointers.size < 2) this.pinch = null;
        if (!this.pointers.size) this.gestureLock = false;
        this.render();
        return;
      }
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      if (drag.mode === 'pan') { this._cursor(); return; }
      if (drag.mode === 'tap') {
        if (!drag.panning) this._tap(drag.w);
        this.render();
        return;
      }
      if (drag.mode === 'rect') {
        const startCorner = drag.start, endCorner = drag.end;
        if (Math.abs(startCorner.x - endCorner.x) > 0.2 && Math.abs(startCorner.y - endCorner.y) > 0.2) {
          this.app.addArea(this.toolOpts.areaType, [
            { x: startCorner.x, y: startCorner.y }, { x: endCorner.x, y: startCorner.y }, { x: endCorner.x, y: endCorner.y }, { x: startCorner.x, y: endCorner.y },
          ]);
        }
        this.render();
        return;
      }
      if (drag.mode === 'calibrate') {
        const length = Geo.dist(drag.start, drag.end);
        if (length > 0.01) this.app.calibrate(length);
        this.render();
        return;
      }
      if (drag.mode === 'measure') {
        this.lastMeasure = { a: drag.start, b: drag.end };
        this.render();
        return;
      }
      if ((drag.mode === 'move' || drag.mode === 'vertex' || drag.mode === 'handle') && drag.moved) {
        if (drag.mode === 'move' && drag.hit.kind === 'sprinkler') this.app.afterSprinklerMoved(drag.hit.id);
        this.app.commit();
      }
    }

    /**
     * Geannuleerde aanraking: vingers vergeten en het slepen afbreken.
     * @param {PointerEvent} event de gebeurtenis
     */
    _cancel(event) {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!this.pointers.size) this.gestureLock = false;
      this._abortDrag();
      this.render();
    }

    /** Breekt een lopende sleepactie af (tweede vinger of geannuleerd gebaar). */
    _abortDrag() {
      const drag = this.drag;
      this.drag = null;
      if (drag && (drag.mode === 'move' || drag.mode === 'vertex' || drag.mode === 'handle') && drag.moved) this.app.commit();
    }

    /**
     * Tik met de vinger in een teken- of plaatsgereedschap.
     * @param {{x: number, y: number}} world getikt punt in meters
     */
    _tap(world) {
      const tool = this.tool;
      if (tool === 'polygon') {
        if (!this.draft) this.draft = [world];
        else if (this.draft.length >= 3 && Geo.dist(world, this.draft[0]) < this._tol(10) / this.view.scale) this._finishPolygon();
        else this.draft.push(world);
      } else if (tool === 'element') this.app.placeElement(this.toolOpts.kind, world);
      else if (tool === 'wand') this.app.wandAt(world, this.toolOpts.areaType);
      else if (tool === 'sprinkler') this.app.placeSprinkler(this.toolOpts.type, world, this.toolOpts);
    }

    // ---------- Pinch (twee vingers: zoomen en verschuiven) ----------
    /**
     * Afstand en midden van de twee vingers.
     * @returns {{dist: number, mid: {x: number, y: number}}} afstand en middelpunt in schermpixels
     */
    _pinchInfo() {
      const [first, second] = [...this.pointers.values()];
      return { dist: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), mid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } };
    }

    /** Begint een pinch-gebaar (twee vingers): onthoudt afstand, ankerpunt en zoom. */
    _startPinch() {
      this._abortDrag();
      this.gestureLock = true;
      const info = this._pinchInfo();
      this.pinch = { dist: info.dist, anchor: this.toWorld(info.mid.x, info.mid.y), scale: this.view.scale };
      this.render();
    }

    /** Werkt zoom en positie bij tijdens een pinch-gebaar. */
    _updatePinch() {
      if (this.pointers.size < 2) return;
      const info = this._pinchInfo();
      const pinch = this.pinch;
      // het wereldpunt onder het beginmidden blijft onder het huidige midden van de vingers
      this.view.scale = Math.max(2, Math.min(400, pinch.scale * (info.dist / pinch.dist)));
      this.view.x = pinch.anchor.x - info.mid.x / this.view.scale;
      this.view.y = pinch.anchor.y - info.mid.y / this.view.scale;
      this.render();
    }

    /**
     * Onthoudt het aangetikte hoekpunt; het eigenschappenpaneel toont dan 'Punt verwijderen'.
     * @param {{id: string, index: number}|null} vertex vlak-id en index van het hoekpunt
     */
    _setActiveVertex(vertex) {
      const changed = JSON.stringify(vertex) !== JSON.stringify(this.activeVertex);
      this.activeVertex = vertex;
      if (changed) this.app.onSelectionChanged();
    }

    /**
     * Verwijdert het aangetikte hoekpunt van het geselecteerde vlak (minimaal 3 blijven).
     * @param {{id: string, index: number}} vertex vlak-id en index van het hoekpunt
     * @returns {boolean} true als het punt verwijderd is
     */
    removeVertex(vertex = this.activeVertex) {
      const area = vertex && this.state.areas.find((candidate) => candidate.id === vertex.id);
      if (!area || !area.pts[vertex.index]) return false;
      if (area.pts.length <= 3) { this.app.toast('Een vlak heeft minimaal 3 punten. Verwijder het vlak of teken het opnieuw.', true); return false; }
      this.app.checkpoint();
      area.pts.splice(vertex.index, 1);
      this.activeVertex = null;
      this.app.areaShapeChanged(area.id);
      return true;
    }

    /** Punt terug tijdens tekenen (knop of Backspace). */
    undoPoint() {
      if (!this.draft) return;
      this.draft.pop();
      if (!this.draft.length) this.draft = null;
      this.render();
    }

    /** Huidige vorm sluiten (knop of Enter). */
    finishPolygon() { if (this.draft) this._finishPolygon(); }

    /** Tekenen afbreken; zonder lopende vorm terug naar selecteren. */
    cancelDraw() {
      if (this.draft && !this.toolOpts.redrawId) { this.draft = null; this.panHold = false; this._cursor(); this.render(); } else this.setTool('select');
    }

    /**
     * Dubbelklik: hoekpunt verwijderen of de getekende vorm sluiten.
     * @param {MouseEvent} event de gebeurtenis
     */
    _dbl(event) {
      if (this.touch) return; // dubbeltik op touch: niet als 'sluiten' opvatten
      if (this.tool === 'select' && this.activeVertex && event) {
        // dubbelklik op een hoekpunt van het geselecteerde vlak: punt weg
        const hit = this.hitTest(this._evPos(event).w);
        if (hit && hit.kind === 'vertex') { this.removeVertex({ id: hit.id, index: hit.index }); return; }
      }
      if (this.tool === 'polygon' && this.draft) {
        // dubbelklik voegt een extra punt toe bij mousedown; verwijder duplicaat
        if (this.draft.length >= 2) {
          const count = this.draft.length;
          if (Geo.dist(this.draft[count - 1], this.draft[count - 2]) < 1e-6) this.draft.pop();
        }
        this._finishPolygon();
      }
    }

    /** Sluit de getekende vorm: nieuw vlak, of de nieuwe vorm van een opnieuw getekend vlak. */
    _finishPolygon() {
      const points = this.draft || [];
      this.draft = null;
      this.panHold = false;
      this._cursor();
      const clean = points.filter((point, i) => i === 0 || Geo.dist(point, points[i - 1]) > 1e-6);
      if (clean.length >= 3 && this.toolOpts.redrawId) {
        // 'Opnieuw tekenen': zelfde vlak (naam, type, zone) met de nieuwe vorm
        const id = this.toolOpts.redrawId;
        this.setTool('select');
        this.app.replaceAreaPoints(id, clean);
        return;
      }
      if (clean.length >= 3) this.app.addArea(this.toolOpts.areaType, clean);
      this.render();
    }

    // ---------- Rendering ----------
    /** Vraagt een nieuwe tekening aan (hooguit één per beeldverversing) en werkt tekenbalk en legenda bij. */
    render() {
      if (this.app.updateDrawBar) this.app.updateDrawBar();
      if (this.app.updateLegend) this.app.updateLegend();
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(this.ctx, this.w, this.h, this.dpr); });
    }

    /**
     * Tekent de volledige scène; herbruikbaar voor export naar PNG.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {number} width breedte in CSS-pixels
     * @param {number} height hoogte in CSS-pixels
     * @param {number} dpr pixelverhouding van het scherm
     * @param {{noGrid: boolean, noScale: boolean}} opts raster of schaalbalk weglaten
     */
    draw(ctx, width, height, dpr = 1, opts = {}) {
      const planState = this.state;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, 0, width, height);
      const scale = this.view.scale;
      /**
       * Rekent een punt in meters om naar schermpixels.
       * @param {{x: number, y: number}} point punt in meters
       * @returns {{x: number, y: number}} punt in schermpixels
       */
      const toScreenPoint = (point) => this.toScreen(point);

      // Achtergrond
      if (this.layers.background && planState.background && planState.background.dataUrl && this.bgImg && this.bgImg.complete) {
        const bg = planState.background;
        const source = this._bgSource(bg, width, height);
        if (source) {
          ctx.globalAlpha = bg.opacity != null ? bg.opacity : 0.6;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(this.bgImg, source.sx, source.sy, source.sw, source.sh, source.dx, source.dy, source.dw, source.dh);
          ctx.globalAlpha = 1;
        }
      }

      if (!opts.noGrid) this._grid(ctx, width, height);

      // Vlakken
      for (const area of planState.areas) {
        if (area.pts.length < 2) continue;
        const areaType = Catalog.areaTypes[area.type] || Catalog.areaTypes.lawn;
        ctx.beginPath();
        area.pts.forEach((point, i) => { const screenPoint = toScreenPoint(point); i ? ctx.lineTo(screenPoint.x, screenPoint.y) : ctx.moveTo(screenPoint.x, screenPoint.y); });
        ctx.closePath();
        ctx.fillStyle = areaType.fill;
        ctx.fill();
        const selected = this.selection && this.selection.kind === 'area' && this.selection.id === area.id;
        const hovered = this.hover && this.hover.kind === 'area' && this.hover.id === area.id;
        ctx.strokeStyle = selected ? '#ff6f00' : areaType.stroke;
        // rand op elk zoomniveau goed zichtbaar op een drukke tekening
        ctx.lineWidth = selected ? 3 : hovered ? 2.5 : 2;
        if (area.type === 'wet') ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const method = window.Hydraulics.methodOf(planState, area);
        if (method === 'dripline') this._dripHatch(ctx, area);
        else if (method === 'drippers') this._drippersDots(ctx, area);
        if (area.zone && window.Hydraulics.isDripMethod(method)) {
          const zone = planState.zones.find((candidate) => candidate.id === area.zone);
          if (zone) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 5; ctx.stroke();
            ctx.strokeStyle = zone.color; ctx.lineWidth = 3; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
          }
        }
      }

      // Neerslagkaart
      if (this.layers.heatmap && this.heat) {
        const sim = this.heat.sim;
        const corner = toScreenPoint({ x: sim.minX - sim.cellX / 2, y: sim.minY - sim.cellY / 2 });
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.heat.canvas, corner.x, corner.y, sim.nx * sim.cellX * scale, sim.ny * sim.cellY * scale);
      }

      // Leidingen
      if (this.layers.pipes && planState.calc) {
        for (const pipe of planState.calc.pipes) {
          const from = toScreenPoint(pipe.a), to = toScreenPoint(pipe.b);
          const zone = planState.zones.find((candidate) => candidate.id === pipe.zone);
          const lineWidth = Math.max(1.5, (pipe.dn / 25) * 2.2);
          if (pipe.outlet) ctx.setLineDash([5, 3]);
          // witte rand eronder: de leiding blijft zichtbaar op gazon en tekening
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = lineWidth + 3;
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
          ctx.strokeStyle = pipe.main ? '#01579b' : pipe.outlet ? '#00838f' : zone ? zone.color : '#555';
          ctx.lineWidth = lineWidth;
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
          ctx.setLineDash([]);
          if (this.layers.labels && scale > 25 && pipe.len > 1.5) {
            const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
            this._label(ctx, `${pipe.dn}`, middle.x, middle.y, '#fff', ctx.strokeStyle, 9);
          }
        }
      }

      // Worpbereik van sproeiers
      if (this.layers.coverage) {
        for (const sprinkler of planState.sprinklers) this._coverage(ctx, sprinkler);
      }

      // Sproeierkoppen
      for (const sprinkler of planState.sprinklers) this._head(ctx, sprinkler);

      // Grepen van de geselecteerde sproeier
      if (this.selection && this.selection.kind === 'sprinkler') {
        const sprinkler = planState.sprinklers.find((candidate) => candidate.id === this.selection.id);
        if (sprinkler) this._sprinklerGrips(ctx, sprinkler);
      }

      // Systeemelementen
      for (const element of planState.elements) this._element(ctx, element);

      // Geselecteerd vlak: hoekpunten + randmaten
      if (this.selection && this.selection.kind === 'area') {
        const area = planState.areas.find((candidate) => candidate.id === this.selection.id);
        if (area) this._areaHandles(ctx, area);
      }

      // Concept-polygoon. Op touch alleen een voorbeeldlijn zolang de vinger een nieuw punt vasthoudt.
      const activeDrag = this.drag;
      const tapPt = activeDrag && activeDrag.mode === 'tap' && !activeDrag.panning && this.tool === 'polygon' ? activeDrag.w : null;
      if (this.draft && this.draft.length) {
        const live = !this.touch || tapPt;
        const target = tapPt || this.snapPoint({ x: this.mouse.wx, y: this.mouse.wy });
        ctx.strokeStyle = '#ff6f00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        this.draft.forEach((point, i) => { const screenPoint = toScreenPoint(point); i ? ctx.lineTo(screenPoint.x, screenPoint.y) : ctx.moveTo(screenPoint.x, screenPoint.y); });
        const targetScreen = toScreenPoint(target);
        if (live) ctx.lineTo(targetScreen.x, targetScreen.y);
        ctx.stroke();
        ctx.setLineDash([]);
        this.draft.forEach((point) => { const screenPoint = toScreenPoint(point); ctx.fillStyle = '#ff6f00'; ctx.fillRect(screenPoint.x - 3, screenPoint.y - 3, 6, 6); });
        const last = this.draft[this.draft.length - 1];
        const offset = this.touch ? 34 : 12; // label niet onder de vinger
        if (live) this._label(ctx, `${Geo.nl(Geo.dist(last, target), 2)} m`, targetScreen.x + offset, targetScreen.y - offset, '#ff6f00', '#fff', this.touch ? 13 : 11);
        if (this.touch && this.draft.length >= 3) {
          // vangzone van het eerste punt: hier tikken sluit de vorm
          const firstPoint = toScreenPoint(this.draft[0]);
          ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(firstPoint.x, firstPoint.y, this._tol(10), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,111,0,0.15)'; ctx.fill(); ctx.stroke();
        }
      }
      if (tapPt) {
        const tapScreen = toScreenPoint(tapPt);
        ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tapScreen.x, tapScreen.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tapScreen.x - 14, tapScreen.y); ctx.lineTo(tapScreen.x + 14, tapScreen.y); ctx.moveTo(tapScreen.x, tapScreen.y - 14); ctx.lineTo(tapScreen.x, tapScreen.y + 14); ctx.stroke();
      }

      const drag = this.drag;
      if (drag && (drag.mode === 'rect')) {
        const from = toScreenPoint(drag.start), to = toScreenPoint(drag.end);
        ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(from.x - to.x), Math.abs(from.y - to.y));
        ctx.setLineDash([]);
        this._label(ctx, `${Geo.nl(Math.abs(drag.end.x - drag.start.x), 2)} × ${Geo.nl(Math.abs(drag.end.y - drag.start.y), 2)} m`, to.x + 12, to.y - 12, '#ff6f00', '#fff', 11);
      }
      const measureLine = drag && (drag.mode === 'calibrate' || drag.mode === 'measure') ? { a: drag.start, b: drag.end } : this.tool === 'measure' ? this.lastMeasure : null;
      if (measureLine) {
        const from = toScreenPoint(measureLine.a), to = toScreenPoint(measureLine.b);
        ctx.strokeStyle = drag && drag.mode === 'calibrate' ? '#d81b60' : '#6a1b9a';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        this._label(ctx, `${Geo.nl(Geo.dist(measureLine.a, measureLine.b), 2)} m`, (from.x + to.x) / 2, (from.y + to.y) / 2 - 12, ctx.strokeStyle, '#fff', 11);
      }

      if (!opts.noScale) this._scaleBar(ctx, width, height);
    }

    /**
     * Alleen het zichtbare deel van de ondergrond (bronrechthoek in beeldpixels + doel op het scherm).
     * Ingezoomd zou het hele beeld vele malen groter dan het canvas getekend worden; Safari op de
     * iPhone verliest dan fijne lijnen en zet de tekening soms verschoven neer.
     * @param {object} bg de ondergrond (x, y, scale)
     * @param {number} width breedte van het canvas in CSS-pixels
     * @param {number} height hoogte van het canvas in CSS-pixels
     * @returns {object|null} bron (sx, sy, sw, sh) en doel (dx, dy, dw, dh), of null als niets zichtbaar is
     */
    _bgSource(bg, width, height) {
      const image = this.bgImg, scale = this.view.scale, pixelScale = bg.scale * scale; // schermpx per beeldpx
      if (!(pixelScale > 0)) return null;
      const origin = this.toScreen({ x: bg.x, y: bg.y });
      const sx = Math.max(0, Math.floor(-origin.x / pixelScale)), sy = Math.max(0, Math.floor(-origin.y / pixelScale));
      const ex = Math.min(image.width, Math.ceil((width - origin.x) / pixelScale)), ey = Math.min(image.height, Math.ceil((height - origin.y) / pixelScale));
      if (ex <= sx || ey <= sy) return null;
      return { sx, sy, sw: ex - sx, sh: ey - sy, dx: origin.x + sx * pixelScale, dy: origin.y + sy * pixelScale, dw: (ex - sx) * pixelScale, dh: (ey - sy) * pixelScale };
    }

    /**
     * Tekent het raster; de stap volgt het zoomniveau.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {number} width breedte in CSS-pixels
     * @param {number} height hoogte in CSS-pixels
     */
    _grid(ctx, width, height) {
      const scale = this.view.scale;
      let step = 1;
      if (scale < 8) step = 10; else if (scale < 20) step = 5; else if (scale > 120) step = 0.5;
      const topLeft = this.toWorld(0, 0), bottomRight = this.toWorld(width, height);
      ctx.lineWidth = 1;
      // Met een telling in plaats van x += step: bij heel grote coördinaten
      // verandert x anders niet meer en blijft de lus eindeloos doorgaan.
      const firstX = Math.floor(topLeft.x / step), firstY = Math.floor(topLeft.y / step);
      const countX = Math.floor(bottomRight.x / step) - firstX, countY = Math.floor(bottomRight.y / step) - firstY;
      if (!Number.isFinite(countX) || !Number.isFinite(countY) || countX > 4000 || countY > 4000) return;
      for (let i = 0; i <= countX; i++) {
        const x = (firstX + i) * step;
        const screenX = Math.round((x - this.view.x) * scale) + 0.5;
        ctx.strokeStyle = Math.abs(x % (step * 5)) < 1e-6 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.05)';
        ctx.beginPath(); ctx.moveTo(screenX, 0); ctx.lineTo(screenX, height); ctx.stroke();
      }
      for (let j = 0; j <= countY; j++) {
        const y = (firstY + j) * step;
        const screenY = Math.round((y - this.view.y) * scale) + 0.5;
        ctx.strokeStyle = Math.abs(y % (step * 5)) < 1e-6 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.05)';
        ctx.beginPath(); ctx.moveTo(0, screenY); ctx.lineTo(width, screenY); ctx.stroke();
      }
    }

    /**
     * Tekent de rijen druppelslang als arcering in een vlak.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} area het vlak
     */
    _dripHatch(ctx, area) {
      const spacing = area.type === 'hedge' ? Catalog.drip.rowSpacingHedge : area.type === 'planter' ? Catalog.drip.rowSpacingPlanter : Catalog.drip.rowSpacingBed;
      const scale = this.view.scale;
      if (spacing * scale < 4) return;
      const rect = Geo.minWidthRect(area.pts);
      ctx.save();
      ctx.beginPath();
      area.pts.forEach((point, i) => { const screenPoint = this.toScreen(point); i ? ctx.lineTo(screenPoint.x, screenPoint.y) : ctx.moveTo(screenPoint.x, screenPoint.y); });
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(62,39,35,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      for (let offset = rect.minV + spacing / 2; offset < rect.maxV; offset += spacing) {
        const p1 = this.toScreen(Geo.add(Geo.mul(rect.u, rect.minU), Geo.mul(rect.v, offset)));
        const p2 = this.toScreen(Geo.add(Geo.mul(rect.u, rect.maxU), Geo.mul(rect.v, offset)));
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      ctx.restore();
    }

    /**
     * Druppelaars: stippen op de plantafstand.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} area het vlak
     */
    _drippersDots(ctx, area) {
      const scale = this.view.scale;
      const perSquareMetre = area.type === 'planter' ? Catalog.drippers.perM2Planter : Catalog.drippers.perM2Bed;
      const step = 1 / Math.sqrt(perSquareMetre);
      if (step * scale < 6) return;
      const box = Geo.bbox(area.pts);
      ctx.fillStyle = 'rgba(62,39,35,0.7)';
      for (let y = box.minY + step / 2; y < box.maxY; y += step) {
        for (let x = box.minX + step / 2; x < box.maxX; x += step) {
          if (!Geo.pointInPolygon({ x, y }, area.pts)) continue;
          const screenPoint = this.toScreen({ x, y });
          ctx.beginPath(); ctx.arc(screenPoint.x, screenPoint.y, 2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    /**
     * Kleur van de zone van een sproeier, anders de kleur van zijn type.
     * @param {object} sprinkler de sproeier
     * @returns {string} kleur (#rrggbb)
     */
    _zoneColor(sprinkler) {
      const zone = sprinkler.zone && this.state.zones.find((candidate) => candidate.id === sprinkler.zone);
      return zone ? zone.color : Catalog.sprinklerTypes[sprinkler.type].color;
    }

    /**
     * Tekent het worpbereik van een sproeier (cirkel, sector of strook).
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} sprinkler de sproeier
     */
    _coverage(ctx, sprinkler) {
      const scale = this.view.scale;
      const center = this.toScreen(sprinkler);
      const color = this._zoneColor(sprinkler);
      ctx.fillStyle = this.layers.heatmap ? 'transparent' : color + '22';
      ctx.strokeStyle = color + (this.layers.heatmap ? '55' : '88');
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (sprinkler.type === 'strip') {
        const angle = Geo.rad(sprinkler.start);
        const direction = { x: Math.cos(angle), y: Math.sin(angle) }, normal = { x: -direction.y, y: direction.x };
        const ends = [Geo.add(sprinkler, Geo.mul(direction, -sprinkler.len / 2)), Geo.add(sprinkler, Geo.mul(direction, sprinkler.len / 2))];
        const corners = [ends[0], ends[1], Geo.add(ends[1], Geo.mul(normal, sprinkler.width)), Geo.add(ends[0], Geo.mul(normal, sprinkler.width))].map((point) => this.toScreen(point));
        corners.forEach((point, i) => (i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
        ctx.closePath();
      } else if (sprinkler.arc >= 359.9) {
        ctx.arc(center.x, center.y, sprinkler.r * scale, 0, Math.PI * 2);
      } else {
        ctx.moveTo(center.x, center.y);
        ctx.arc(center.x, center.y, sprinkler.r * scale, Geo.rad(sprinkler.start), Geo.rad(sprinkler.start + sprinkler.arc));
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    /**
     * Tekent een sproeierkop met richting en (ingezoomd) worp en hoek.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} sprinkler de sproeier
     */
    _head(ctx, sprinkler) {
      const center = this.toScreen(sprinkler);
      const selected = this.selection && this.selection.kind === 'sprinkler' && this.selection.id === sprinkler.id;
      const color = this._zoneColor(sprinkler);
      const dotRadius = 5;
      ctx.beginPath();
      ctx.arc(center.x, center.y, dotRadius + (selected ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.strokeStyle = selected ? '#ff6f00' : '#fff';
      ctx.stroke();
      // richtingsindicator
      if (sprinkler.type !== 'strip' && sprinkler.arc < 359.9) {
        const mid = Geo.rad(sprinkler.start + sprinkler.arc / 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(center.x + Math.cos(mid) * 12, center.y + Math.sin(mid) * 12); ctx.stroke();
      }
      if (this.layers.labels && this.view.scale > 30) {
        const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
        const text = sprinkler.type === 'strip' ? `${Geo.nlShort(sprinkler.width, 1)} × ${Geo.nlShort(sprinkler.len, 1)} m` : `${Geo.nlShort(sprinkler.r, 1)} m · ${sprinkler.arc}°`;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = '#263238';
        ctx.fillText(text, center.x + 7, center.y - 6);
        void sprinklerType;
      }
    }

    /**
     * Tekent de grepen van de geselecteerde sproeier en tijdens het slepen de instelling.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} sprinkler de sproeier
     */
    _sprinklerGrips(ctx, sprinkler) {
      const center = this.toScreen(sprinkler);
      const gripSize = this.touch ? 8 : 5;
      for (const handle of this.sprinklerHandles(sprinkler)) {
        const handlePoint = this.toScreen(handle);
        ctx.strokeStyle = '#ff6f00';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(handlePoint.x, handlePoint.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = handle.which === 'r' ? '#ff6f00' : '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(handlePoint.x, handlePoint.y, gripSize, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const drag = this.drag;
      if (drag && drag.mode === 'handle' && drag.id === sprinkler.id) {
        const text = Catalog.nozzleOf(sprinkler) ? Catalog.headSetting(sprinkler) : `${Geo.nl(sprinkler.r, 1)} m · ${sprinkler.arc}°`;
        this._label(ctx, text, center.x, center.y - 22, '#e65100', '#fff', this.touch ? 13 : 11);
      }
    }

    /**
     * Tekent een systeemelement (wateraansluiting, ventielkast, computer, tappunt).
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} element het element
     */
    _element(ctx, element) {
      const elementType = Catalog.elementTypes[element.kind];
      const center = this.toScreen(element);
      const selected = this.selection && this.selection.kind === 'element' && this.selection.id === element.id;
      const size = 11;
      ctx.fillStyle = elementType.color;
      ctx.strokeStyle = selected ? '#ff6f00' : '#fff';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      if (element.kind === 'valvebox') ctx.rect(center.x - size, center.y - size * 0.75, size * 2, size * 1.5);
      else if (element.kind === 'source') { ctx.moveTo(center.x, center.y - size); ctx.lineTo(center.x + size, center.y); ctx.lineTo(center.x, center.y + size); ctx.lineTo(center.x - size, center.y); ctx.closePath(); }
      else ctx.arc(center.x, center.y, size * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(elementType.short, center.x, center.y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    /**
     * Tekent de hoekpunten, middens en randmaten van het geselecteerde vlak.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} area het vlak
     */
    _areaHandles(ctx, area) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#ff6f00';
      ctx.lineWidth = 1.5;
      const gripSize = this.touch ? 7 : 4;
      const activeIndex = this.activeVertex && this.activeVertex.id === area.id ? this.activeVertex.index : -1;
      for (let i = 0; i < area.pts.length; i++) {
        const corner = this.toScreen(area.pts[i]);
        ctx.fillStyle = i === activeIndex ? '#ff6f00' : '#fff';
        ctx.fillRect(corner.x - gripSize, corner.y - gripSize, gripSize * 2, gripSize * 2);
        ctx.strokeRect(corner.x - gripSize, corner.y - gripSize, gripSize * 2, gripSize * 2);
        const next = area.pts[(i + 1) % area.pts.length];
        const mid = this.toScreen({ x: (area.pts[i].x + next.x) / 2, y: (area.pts[i].y + next.y) / 2 });
        ctx.beginPath(); ctx.arc(mid.x, mid.y, this.touch ? 6 : 3, 0, Math.PI * 2); ctx.fillStyle = '#ffcc80'; ctx.fill(); ctx.fillStyle = '#fff';
        if (this.layers.labels) this._label(ctx, `${Geo.nl(Geo.dist(area.pts[i], next), 2)} m`, mid.x, mid.y - 12, '#e65100', '#fff', 10);
      }
    }

    /**
     * Tekent een tekstlabel met achtergrond, gecentreerd op een punt.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {string} text de tekst
     * @param {number} x midden in schermpixels
     * @param {number} y midden in schermpixels
     * @param {string} textColor tekstkleur
     * @param {string} backgroundColor achtergrondkleur
     * @param {number} size lettergrootte in pixels
     */
    _label(ctx, text, x, y, textColor, backgroundColor, size = 10) {
      ctx.font = `${size}px system-ui, sans-serif`;
      const boxWidth = ctx.measureText(text).width + 6;
      ctx.fillStyle = backgroundColor;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x - boxWidth / 2, y - size / 2 - 3, boxWidth, size + 5);
      ctx.globalAlpha = 1;
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    /**
     * Tekent de schaalbalk linksonder.
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {number} width breedte in CSS-pixels
     * @param {number} height hoogte in CSS-pixels
     */
    _scaleBar(ctx, width, height) {
      const scale = this.view.scale;
      const candidates = [0.5, 1, 2, 5, 10, 20, 50];
      const length = candidates.find((candidate) => candidate * scale > 80) || 50;
      const x = 16, y = height - 18;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x - 6, y - 16, length * scale + 40, 26);
      ctx.strokeStyle = '#263238';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + length * scale, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.moveTo(x + length * scale, y - 5); ctx.lineTo(x + length * scale, y + 5); ctx.stroke();
      ctx.fillStyle = '#263238';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${Geo.nlShort(length, 1)} m`, x + length * scale + 6, y + 4);
    }

    /**
     * Legenda van wat er in het plan staat: vlaktypes (met oppervlak),
     * beregeningswijze in beplanting, zones en systeemelementen. Zonder
     * vlakken alle vlaktypes, als sleutel bij het tekenen.
     * @returns {Array<{title: string, items: object[]}>} de onderdelen van de legenda
     */
    legend() {
      const planState = this.state;
      /**
       * Getal met één decimaal in Nederlandse notatie.
       * @param {number} value het getal
       * @returns {string} de tekst
       */
      const formatNumber = (value) => Number(value).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const sections = [];
      const areas = planState.areas.filter((area) => area.pts.length >= 3 && Catalog.areaTypes[area.type]);
      const total = {};
      for (const area of areas) total[area.type] = (total[area.type] || 0) + Geo.area(area.pts);
      const types = Object.keys(Catalog.areaTypes).filter((typeKey) => !areas.length || total[typeKey] != null);
      sections.push({
        title: 'Vlakken',
        items: types.map((typeKey) => {
          const areaType = Catalog.areaTypes[typeKey];
          return { swatch: 'area', fill: areaType.fill, stroke: areaType.stroke, dashed: typeKey === 'wet', label: areaType.label, sub: total[typeKey] != null ? `${formatNumber(total[typeKey])} m²` : '' };
        }),
      });
      const methods = new Set(areas.map((area) => window.Hydraulics.methodOf(planState, area)));
      const irrigationItems = [];
      if (methods.has('dripline')) irrigationItems.push({ swatch: 'dripline', label: Catalog.methods.dripline.label });
      if (methods.has('drippers')) irrigationItems.push({ swatch: 'drippers', label: Catalog.methods.drippers.label });
      if (planState.sprinklers.length) irrigationItems.push({ swatch: 'sprinkler', color: '#455a64', label: 'Sproeier met bereik' });
      if (irrigationItems.length) sections.push({ title: 'Beregening', items: irrigationItems });
      const zones = planState.zones.filter((zone) => planState.sprinklers.some((sprinkler) => sprinkler.zone === zone.id) || planState.areas.some((area) => area.zone === zone.id));
      if (zones.length) {
        sections.push({
          title: 'Zones',
          items: zones.map((zone) => ({ swatch: 'zone', color: zone.color, label: zone.name, sub: Catalog.groups[zone.group] ? Catalog.groups[zone.group].label : '' })),
        });
      }
      const kinds = Object.keys(Catalog.elementTypes).filter((kind) => planState.elements.some((element) => element.kind === kind));
      if (kinds.length) {
        sections.push({
          title: 'Elementen',
          items: kinds.map((kind) => ({ swatch: 'element', kind: kind, color: Catalog.elementTypes[kind].color, short: Catalog.elementTypes[kind].short, label: Catalog.elementTypes[kind].label })),
        });
      }
      return sections;
    }

    /**
     * Tekent een legendasymbool (ook gebruikt door de export).
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {object} item regel uit de legenda
     * @param {number} x links in pixels
     * @param {number} y boven in pixels
     * @param {number} width breedte in pixels
     * @param {number} height hoogte in pixels
     */
    _legendSwatch(ctx, item, x, y, width, height) {
      ctx.save();
      if (item.swatch === 'area' || item.swatch === 'dripline' || item.swatch === 'drippers') {
        const style = item.swatch === 'area' ? item : Catalog.areaTypes.bed;
        ctx.fillStyle = '#fff'; ctx.fillRect(x, y, width, height);
        ctx.fillStyle = style.fill; ctx.fillRect(x, y, width, height);
        ctx.strokeStyle = style.stroke; ctx.lineWidth = 1.25;
        if (item.dashed) ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(62,39,35,0.55)'; ctx.fillStyle = 'rgba(62,39,35,0.7)';
        if (item.swatch === 'dripline') {
          ctx.setLineDash([2, 3]);
          for (const rowY of [y + height * 0.33, y + height * 0.67]) { ctx.beginPath(); ctx.moveTo(x + 2, rowY); ctx.lineTo(x + width - 2, rowY); ctx.stroke(); }
        } else if (item.swatch === 'drippers') {
          for (const dotX of [x + width * 0.25, x + width * 0.5, x + width * 0.75]) { ctx.beginPath(); ctx.arc(dotX, y + height / 2, 1.8, 0, Math.PI * 2); ctx.fill(); }
        }
      } else if (item.swatch === 'zone' || item.swatch === 'sprinkler') {
        const cx = x + width / 2, cy = y + height / 2;
        if (item.swatch === 'sprinkler') {
          ctx.strokeStyle = item.color; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
          ctx.beginPath(); ctx.arc(cx, cy, height / 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.fillStyle = item.swatch === 'zone' ? item.color : '#fff';
        ctx.strokeStyle = item.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, item.swatch === 'zone' ? height / 2 - 1 : 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else if (item.swatch === 'element') {
        ctx.translate(x + width / 2 - this.toScreen({ x: 0, y: 0 }).x, y + height / 2 - this.toScreen({ x: 0, y: 0 }).y);
        this._element(ctx, { kind: item.kind, x: 0, y: 0 });
      }
      ctx.restore();
    }

    /**
     * Legenda als vak rechts van de tekening (PNG/Excel-export).
     * @param {CanvasRenderingContext2D} ctx tekencontext
     * @param {number} x links in pixels
     * @param {number} y boven in pixels
     * @param {number} width breedte in pixels
     */
    _legendPanel(ctx, x, y, width) {
      const sections = this.legend();
      const pad = 14, row = 22;
      let height = pad + 20;
      for (const section of sections) height += 22 + section.items.length * row + 6;
      height += pad - 6;
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.strokeStyle = '#cfd8dc'; ctx.lineWidth = 1;
      ctx.fillRect(x, y, width, height); ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#172f5e';
      ctx.font = 'bold 15px system-ui, sans-serif';
      let cy = y + pad + 8;
      ctx.fillText('Legenda', x + pad, cy);
      cy += 20;
      for (const section of sections) {
        ctx.fillStyle = '#607d8b';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillText(section.title.toUpperCase(), x + pad, cy + 6);
        cy += 22;
        for (const item of section.items) {
          this._legendSwatch(ctx, item, x + pad, cy - 7, 26, 16);
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#263238';
          ctx.font = '13px system-ui, sans-serif';
          ctx.fillText(item.label, x + pad + 36, cy + 1, width - pad * 2 - 36 - (item.sub ? 70 : 0));
          if (item.sub) {
            ctx.fillStyle = '#607d8b';
            ctx.textAlign = 'end';
            ctx.fillText(item.sub, x + width - pad, cy + 1);
            ctx.textAlign = 'start';
          }
          cy += row;
        }
        cy += 6;
      }
      ctx.textBaseline = 'alphabetic';
    }

    /**
     * Exporteert het plan als PNG (dataURL), passend gezoomd, met legenda rechts.
     * @param {number} width breedte in pixels
     * @param {number} height hoogte in pixels
     * @returns {string} de afbeelding als data-URL
     */
    exportPng(width = 1500, height = 1000) {
      const saved = { ...this.view }, savedWidth = this.w, savedHeight = this.h, savedSelection = this.selection;
      const legendWidth = Math.round(Math.max(260, Math.min(360, width * 0.2)));
      this.w = width - legendWidth; this.h = height; this.selection = null;
      this.fit();
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      this.draw(ctx, width, height, 1, { noGrid: false });
      this._legendPanel(ctx, width - legendWidth + 8, 16, legendWidth - 24);
      this.view = saved; this.w = savedWidth; this.h = savedHeight; this.selection = savedSelection;
      this.render();
      return canvas.toDataURL('image/png');
    }
  }

  window.Editor = Editor;
})();
