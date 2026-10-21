/* Canvas-editor: weergave, zoom/pan, tekenen, selecteren en verslepen. */
(function () {
  'use strict';

  const G = window.Geo;
  const C = window.Catalog;

  class Editor {
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
      // Touch: actieve vingers, pinch-gebaar en grotere tolerantie voor vingers
      this.pointers = new Map();
      this.pinch = null;
      this.gestureLock = false;
      this.touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      this._bind();
      this.resize();
    }

    get state() { return this.app.state; }

    // ---------- Transformaties ----------
    toScreen(p) { return { x: (p.x - this.view.x) * this.view.scale, y: (p.y - this.view.y) * this.view.scale }; }
    toWorld(sx, sy) { return { x: sx / this.view.scale + this.view.x, y: sy / this.view.scale + this.view.y }; }

    resize() {
      const r = this.cv.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.cv.width = Math.max(1, Math.floor(r.width * dpr));
      this.cv.height = Math.max(1, Math.floor(r.height * dpr));
      this.cv.style.width = `${r.width}px`;
      this.cv.style.height = `${r.height}px`;
      this.dpr = dpr;
      this.w = r.width;
      this.h = r.height;
      this.render();
    }

    zoomAt(sx, sy, factor) {
      const before = this.toWorld(sx, sy);
      this.view.scale = Math.max(2, Math.min(400, this.view.scale * factor));
      const after = this.toWorld(sx, sy);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
      this.render();
    }

    fit() {
      const pts = [];
      this.state.areas.forEach((a) => pts.push(...a.pts));
      this.state.sprinklers.forEach((s) => pts.push(s));
      this.state.elements.forEach((e) => pts.push(e));
      const bg = this.state.background;
      if (bg && bg.dataUrl && this.bgImg) {
        pts.push({ x: bg.x, y: bg.y }, { x: bg.x + this.bgImg.width * bg.scale, y: bg.y + this.bgImg.height * bg.scale });
      }
      if (!pts.length) { this.view = { x: -2, y: -2, scale: 40 }; this.render(); return; }
      const bb = G.bbox(pts);
      const pad = 1.5;
      const sx = this.w / (bb.w + 2 * pad || 10);
      const sy = this.h / (bb.h + 2 * pad || 10);
      this.view.scale = Math.max(2, Math.min(200, Math.min(sx, sy)));
      this.view.x = bb.minX - pad - (this.w / this.view.scale - bb.w - 2 * pad) / 2;
      this.view.y = bb.minY - pad - (this.h / this.view.scale - bb.h - 2 * pad) / 2;
      this.render();
    }

    setTool(tool, opts = {}) {
      this.tool = tool;
      this.toolOpts = opts;
      this.draft = null;
      this.cv.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
      this.app.onToolChanged(tool, opts);
      this.render();
    }

    /** Tolerantie in schermpixels; ruimer bij bediening met de vinger. */
    _tol(px) { return this.touch ? Math.round(px * 2.2) : px; }

    snapPoint(p, ev) {
      let q = { x: p.x, y: p.y };
      // Snap naar bestaande hoekpunten
      const tol = this._tol(8) / this.view.scale;
      for (const a of this.state.areas) {
        for (const v of a.pts) if (G.dist(v, p) < tol) return { x: v.x, y: v.y, snapped: true };
      }
      if (this.draft && this.draft.length) {
        for (const v of this.draft) if (G.dist(v, p) < tol) return { x: v.x, y: v.y, snapped: true };
        if (ev && ev.shiftKey) {
          const last = this.draft[this.draft.length - 1];
          const d = G.sub(p, last);
          const ang = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
          const l = G.len(d);
          q = { x: last.x + Math.cos(ang) * l, y: last.y + Math.sin(ang) * l };
        }
      }
      if (this.snap && !(ev && ev.altKey)) {
        const s = this.gridStep;
        q = { x: Math.round(q.x / s) * s, y: Math.round(q.y / s) * s };
      }
      return q;
    }

    // ---------- Hit-testing ----------
    hitTest(w) {
      const tol = this._tol(7) / this.view.scale;
      for (const e of [...this.state.elements].reverse()) {
        if (G.dist(e, w) < Math.max(tol * 1.5, 0.35)) return { kind: 'element', id: e.id };
      }
      // grepen van de geselecteerde sproeier (worp en sproeihoek)
      if (this.selection && this.selection.kind === 'sprinkler') {
        const s = this.state.sprinklers.find((x) => x.id === this.selection.id);
        if (s) for (const h of this.sprinklerHandles(s)) if (G.dist(h, w) < tol * 1.4) return { kind: 'handle', id: s.id, which: h.which };
      }
      for (const s of [...this.state.sprinklers].reverse()) {
        if (G.dist(s, w) < Math.max(tol, 0.25)) return { kind: 'sprinkler', id: s.id };
      }
      // hoekpunt van geselecteerd vlak
      if (this.selection && this.selection.kind === 'area') {
        const a = this.state.areas.find((x) => x.id === this.selection.id);
        if (a) {
          for (let i = 0; i < a.pts.length; i++) if (G.dist(a.pts[i], w) < tol) return { kind: 'vertex', id: a.id, index: i };
          for (let i = 0; i < a.pts.length; i++) {
            const b = a.pts[(i + 1) % a.pts.length];
            const mid = { x: (a.pts[i].x + b.x) / 2, y: (a.pts[i].y + b.y) / 2 };
            if (G.dist(mid, w) < tol) return { kind: 'midpoint', id: a.id, index: i };
          }
        }
      }
      // kleinste vlak eerst (zodat bedden binnen een gazon selecteerbaar zijn)
      const hits = this.state.areas.filter((a) => a.pts.length >= 3 && G.pointInPolygon(w, a.pts));
      hits.sort((a, b) => G.area(a.pts) - G.area(b.pts));
      if (hits.length) return { kind: 'area', id: hits[0].id };
      return null;
    }

    /** Grepen van een sproeier: worp (midden van de boog) en begin/einde van de sproeihoek. */
    sprinklerHandles(s) {
      if (s.type === 'strip' || !(s.r > 0)) return [];
      const at = (deg, which) => ({ x: s.x + Math.cos(G.rad(deg)) * s.r, y: s.y + Math.sin(G.rad(deg)) * s.r, which });
      if (s.arc >= 359.9) return [at(s.start, 'r')];
      return [at(s.start + s.arc / 2, 'r'), at(s.start, 'a0'), at(s.start + s.arc, 'a1')];
    }

    /** Slepen aan een greep: worp of sproeihoek aanpassen (rotators binnen het bereik van hun kop). */
    _dragHandle(s, which, w, free) {
      const t = C.sprinklerTypes[s.type];
      const snapDeg = (a) => (free ? Math.round(a) : Math.round(a / 5) * 5);
      if (which === 'r') {
        const r = G.dist(s, w);
        s.r = Math.max(t.rMin, Math.min(t.rMax, free ? Math.round(r * 100) / 100 : Math.round(r * 10) / 10));
        C.fitRotator(s);
        return;
      }
      const ang = snapDeg(G.angleOf(G.sub(w, s)));
      if (which === 'a1') {
        s.arc = Math.max(10, G.normDeg(ang - s.start) || 360);
        C.fitRotator(s);
      } else {
        const end = s.start + s.arc;
        s.start = G.normDeg(ang);
        s.arc = Math.max(10, G.normDeg(end - s.start) || 360);
        C.fitRotator(s);
        s.start = Math.round(G.normDeg(end - s.arc)); // einde blijft staan, ook als de sector de hoek begrenst
      }
    }

    // ---------- Events ----------
    _bind() {
      const cv = this.cv;
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });

      cv.addEventListener('pointerdown', (e) => this._down(e));
      cv.addEventListener('pointermove', (e) => this._move(e));
      cv.addEventListener('pointerup', (e) => this._up(e));
      cv.addEventListener('pointercancel', (e) => this._cancel(e));
      // Geen 'ghost click' na een tik: anders landt de klik op het paneel dat net onder de vinger verschijnt
      cv.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
      cv.addEventListener('dblclick', (e) => this._dbl(e));
      window.addEventListener('resize', () => this.resize());
      // Paneel in- of uitklappen (mobiel) verandert de canvasmaat zonder window-resize
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(cv.parentElement);
      window.addEventListener('keydown', (e) => {
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.code === 'Space') { this.spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); }
        if (e.key === 'Escape') {
          if (this.draft) { this.draft = null; this.render(); } else this.setTool('select');
        }
        if (e.key === 'Enter' && this.draft) this._finishPolygon();
        if (e.key === 'Backspace' && this.draft && this.draft.length) { this.undoPoint(); e.preventDefault(); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.draft && this.selection) { this.app.deleteSelection(); e.preventDefault(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.app.redo() : this.app.undo(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.app.redo(); }
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') { this.spaceDown = false; this.setTool(this.tool, this.toolOpts); }
      });
    }

    _evPos(e) {
      const r = this.cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const w = this.toWorld(sx, sy);
      return { sx, sy, w };
    }

    _down(e) {
      const { sx, sy, w } = this._evPos(e);
      this.cv.setPointerCapture(e.pointerId);
      const touch = e.pointerType === 'touch';
      if (touch !== this.touch) { this.touch = touch; this.app.onToolChanged(this.tool, this.toolOpts); }
      this.pointers.set(e.pointerId, { x: sx, y: sy });
      if (this.pointers.size >= 2) { this._startPinch(); return; }
      if (this.gestureLock) return;
      this.mouse = { x: sx, y: sy, wx: w.x, wy: w.y };
      if (e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceDown) {
        this.drag = { mode: 'pan', sx, sy, vx: this.view.x, vy: this.view.y };
        this.cv.style.cursor = 'grabbing';
        return;
      }
      const t = this.tool;
      // Vinger: tikken plaatst een punt of element (bij loslaten), slepen verschuift het plan.
      // Zo zet een tweevinger-pinch nooit per ongeluk een punt neer.
      if (touch && (t === 'polygon' || t === 'element' || t === 'wand' || t === 'sprinkler')) {
        this.drag = { mode: 'tap', sx, sy, vx: this.view.x, vy: this.view.y, w: t === 'polygon' ? this.snapPoint(w, e) : w };
        this.mouse = { x: sx, y: sy, wx: this.drag.w.x, wy: this.drag.w.y };
        this.render();
        return;
      }
      if (t === 'polygon') {
        const p = this.snapPoint(w, e);
        if (!this.draft) this.draft = [p];
        else if (this.draft.length >= 3 && G.dist(p, this.draft[0]) < this._tol(10) / this.view.scale) this._finishPolygon();
        else this.draft.push(p);
        this.render();
        return;
      }
      if (t === 'rect' || t === 'calibrate' || t === 'measure') {
        const p = t === 'rect' ? this.snapPoint(w, e) : w;
        this.drag = { mode: t, start: p, end: p };
        return;
      }
      if (t === 'element') {
        this.app.placeElement(this.toolOpts.kind, w);
        return;
      }
      if (t === 'wand') {
        this.app.wandAt(w, this.toolOpts.areaType);
        return;
      }
      if (t === 'sprinkler') {
        this.app.placeSprinkler(this.toolOpts.type, w);
        return;
      }
      // select
      const hit = this.hitTest(w);
      if (hit && hit.kind === 'handle') {
        this.drag = { mode: 'handle', id: hit.id, which: hit.which, moved: false, sx, sy };
        return;
      }
      if (hit && hit.kind === 'vertex') {
        this.drag = { mode: 'vertex', id: hit.id, index: hit.index, moved: false, sx, sy };
        return;
      }
      if (hit && hit.kind === 'midpoint') {
        const a = this.state.areas.find((x) => x.id === hit.id);
        this.app.checkpoint();
        a.pts.splice(hit.index + 1, 0, this.snapPoint(w, e));
        this.drag = { mode: 'vertex', id: hit.id, index: hit.index + 1, moved: true, noCheckpoint: true };
        this.render();
        return;
      }
      this.selection = hit;
      this.app.onSelectionChanged();
      if (hit) {
        const obj = this.app.findObject(hit);
        const orig = hit.kind === 'area' ? obj.pts.map((p) => ({ ...p })) : { x: obj.x, y: obj.y };
        this.drag = { mode: 'move', hit, start: w, orig, moved: false, withHeads: hit.kind === 'area' && e.altKey };
      } else if (touch) {
        // vinger op een lege plek: slepen verschuift het plan
        this.drag = { mode: 'pan', sx, sy, vx: this.view.x, vy: this.view.y };
      }
      this.render();
    }

    _move(e) {
      const { sx, sy, w } = this._evPos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: sx, y: sy });
      if (this.pinch) { this._updatePinch(); return; }
      if (this.gestureLock) return;
      this.mouse = { x: sx, y: sy, wx: w.x, wy: w.y };
      this.app.onMouseMove(w);
      const d = this.drag;
      if (d) {
        if (d.mode === 'pan') {
          this.view.x = d.vx - (sx - d.sx) / this.view.scale;
          this.view.y = d.vy - (sy - d.sy) / this.view.scale;
        } else if (d.mode === 'tap') {
          if (!d.panning && Math.hypot(sx - d.sx, sy - d.sy) > 10) d.panning = true;
          if (d.panning) {
            this.view.x = d.vx - (sx - d.sx) / this.view.scale;
            this.view.y = d.vy - (sy - d.sy) / this.view.scale;
          }
          // voorbeeldlijn blijft naar het getikte punt wijzen
          const ps = this.toScreen(d.w);
          this.mouse = { x: ps.x, y: ps.y, wx: d.w.x, wy: d.w.y };
        } else if (d.mode === 'rect') {
          d.end = this.snapPoint(w, e);
        } else if (d.mode === 'calibrate' || d.mode === 'measure') {
          d.end = w;
        } else if (d.mode === 'vertex') {
          if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < (this.touch ? 6 : 1)) return;
          if (!d.moved && !d.noCheckpoint) this.app.checkpoint();
          d.moved = true;
          const a = this.state.areas.find((x) => x.id === d.id);
          a.pts[d.index] = this.snapPoint(w, e);
          this.app.invalidate();
        } else if (d.mode === 'handle') {
          if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < (this.touch ? 6 : 1)) return;
          if (!d.moved) this.app.checkpoint();
          d.moved = true;
          const s = this.state.sprinklers.find((x) => x.id === d.id);
          if (s) this._dragHandle(s, d.which, w, e.altKey);
          this.app.invalidate();
        } else if (d.mode === 'move') {
          const dx = w.x - d.start.x, dy = w.y - d.start.y;
          if (!d.moved && Math.hypot(dx, dy) * this.view.scale < this._tol(3)) return;
          if (!d.moved) this.app.checkpoint();
          d.moved = true;
          const obj = this.app.findObject(d.hit);
          if (d.hit.kind === 'area') {
            let ox = dx, oy = dy;
            if (this.snap && !e.altKey) { ox = Math.round(dx / this.gridStep) * this.gridStep; oy = Math.round(dy / this.gridStep) * this.gridStep; }
            obj.pts = d.orig.map((p) => ({ x: p.x + ox, y: p.y + oy }));
          } else {
            obj.x = d.orig.x + dx;
            obj.y = d.orig.y + dy;
            if (this.snap && !e.altKey && d.hit.kind === 'sprinkler') {
              // snap sproeier op dichtstbijzijnde vlakrand als dichtbij
              const tol = this._tol(8) / this.view.scale;
              for (const a of this.state.areas) {
                const c = G.closestOnPolygon(obj, a.pts);
                if (c.d < tol) { obj.x = c.pt.x; obj.y = c.pt.y; break; }
              }
            }
          }
          this.app.invalidate();
        }
        this.render();
        return;
      }
      if (e.pointerType === 'touch') return;
      if (this.draft || this.tool !== 'select') { this.render(); return; }
      const hov = this.hitTest(w);
      const changed = JSON.stringify(hov) !== JSON.stringify(this.hover);
      this.hover = hov;
      this.cv.style.cursor = hov ? (hov.kind === 'vertex' || hov.kind === 'midpoint' ? 'pointer' : hov.kind === 'handle' ? 'crosshair' : 'move') : 'default';
      if (changed) this.render();
    }

    _up(e) {
      this.pointers.delete(e.pointerId);
      if (this.pinch || this.gestureLock) {
        if (this.pointers.size < 2) this.pinch = null;
        if (!this.pointers.size) this.gestureLock = false;
        this.render();
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.mode === 'pan') { this.setTool(this.tool, this.toolOpts); return; }
      if (d.mode === 'tap') {
        if (!d.panning) this._tap(d.w);
        this.render();
        return;
      }
      if (d.mode === 'rect') {
        const a = d.start, b = d.end;
        if (Math.abs(a.x - b.x) > 0.2 && Math.abs(a.y - b.y) > 0.2) {
          this.app.addArea(this.toolOpts.areaType, [
            { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
          ]);
        }
        this.render();
        return;
      }
      if (d.mode === 'calibrate') {
        const len = G.dist(d.start, d.end);
        if (len > 0.01) this.app.calibrate(len);
        this.render();
        return;
      }
      if (d.mode === 'measure') {
        this.lastMeasure = { a: d.start, b: d.end };
        this.render();
        return;
      }
      if ((d.mode === 'move' || d.mode === 'vertex' || d.mode === 'handle') && d.moved) {
        if (d.mode === 'move' && d.hit.kind === 'sprinkler') this.app.afterSprinklerMoved(d.hit.id);
        this.app.commit();
      }
    }

    _cancel(e) {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!this.pointers.size) this.gestureLock = false;
      this._abortDrag();
      this.render();
    }

    /** Breekt een lopende sleepactie af (tweede vinger of geannuleerd gebaar). */
    _abortDrag() {
      const d = this.drag;
      this.drag = null;
      if (d && (d.mode === 'move' || d.mode === 'vertex' || d.mode === 'handle') && d.moved) this.app.commit();
    }

    /** Tik met de vinger in een teken- of plaatsgereedschap. */
    _tap(w) {
      const t = this.tool;
      if (t === 'polygon') {
        if (!this.draft) this.draft = [w];
        else if (this.draft.length >= 3 && G.dist(w, this.draft[0]) < this._tol(10) / this.view.scale) this._finishPolygon();
        else this.draft.push(w);
      } else if (t === 'element') this.app.placeElement(this.toolOpts.kind, w);
      else if (t === 'wand') this.app.wandAt(w, this.toolOpts.areaType);
      else if (t === 'sprinkler') this.app.placeSprinkler(this.toolOpts.type, w);
    }

    // ---------- Pinch (twee vingers: zoomen en verschuiven) ----------
    _pinchInfo() {
      const [a, b] = [...this.pointers.values()];
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }

    _startPinch() {
      this._abortDrag();
      this.gestureLock = true;
      const p = this._pinchInfo();
      this.pinch = { dist: p.dist, anchor: this.toWorld(p.mid.x, p.mid.y), scale: this.view.scale };
      this.render();
    }

    _updatePinch() {
      if (this.pointers.size < 2) return;
      const p = this._pinchInfo();
      const pc = this.pinch;
      // het wereldpunt onder het beginmidden blijft onder het huidige midden van de vingers
      this.view.scale = Math.max(2, Math.min(400, pc.scale * (p.dist / pc.dist)));
      this.view.x = pc.anchor.x - p.mid.x / this.view.scale;
      this.view.y = pc.anchor.y - p.mid.y / this.view.scale;
      this.render();
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
      if (this.draft) { this.draft = null; this.render(); } else this.setTool('select');
    }

    _dbl() {
      if (this.touch) return; // dubbeltik op touch: niet als 'sluiten' opvatten
      if (this.tool === 'polygon' && this.draft) {
        // dubbelklik voegt een extra punt toe bij mousedown; verwijder duplicaat
        if (this.draft.length >= 2) {
          const n = this.draft.length;
          if (G.dist(this.draft[n - 1], this.draft[n - 2]) < 1e-6) this.draft.pop();
        }
        this._finishPolygon();
      }
    }

    _finishPolygon() {
      const pts = this.draft || [];
      this.draft = null;
      const clean = pts.filter((p, i) => i === 0 || G.dist(p, pts[i - 1]) > 1e-6);
      if (clean.length >= 3) this.app.addArea(this.toolOpts.areaType, clean);
      this.render();
    }

    // ---------- Rendering ----------
    render() {
      if (this.app.updateDrawBar) this.app.updateDrawBar();
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(this.ctx, this.w, this.h, this.dpr); });
    }

    /** Tekent de volledige scène; herbruikbaar voor export naar PNG. */
    draw(ctx, w, h, dpr = 1, opts = {}) {
      const st = this.state;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, 0, w, h);
      const S = this.view.scale;
      const T = (p) => this.toScreen(p);

      // Achtergrond
      if (this.layers.background && st.background && st.background.dataUrl && this.bgImg && this.bgImg.complete) {
        const bg = st.background;
        const p = T({ x: bg.x, y: bg.y });
        ctx.globalAlpha = bg.opacity != null ? bg.opacity : 0.6;
        ctx.drawImage(this.bgImg, p.x, p.y, this.bgImg.width * bg.scale * S, this.bgImg.height * bg.scale * S);
        ctx.globalAlpha = 1;
      }

      if (!opts.noGrid) this._grid(ctx, w, h);

      // Vlakken
      for (const a of st.areas) {
        if (a.pts.length < 2) continue;
        const at = C.areaTypes[a.type] || C.areaTypes.lawn;
        ctx.beginPath();
        a.pts.forEach((p, i) => { const s = T(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        ctx.closePath();
        ctx.fillStyle = at.fill;
        ctx.fill();
        const sel = this.selection && this.selection.kind === 'area' && this.selection.id === a.id;
        const hov = this.hover && this.hover.kind === 'area' && this.hover.id === a.id;
        ctx.strokeStyle = sel ? '#ff6f00' : at.stroke;
        ctx.lineWidth = sel ? 2.5 : hov ? 2 : 1.25;
        if (a.type === 'wet') ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const method = window.Hydraulics.methodOf(st, a);
        if (method === 'dripline') this._dripHatch(ctx, a);
        else if (method === 'drippers') this._drippersDots(ctx, a);
        if (a.zone && window.Hydraulics.isDripMethod(method)) {
          const z = st.zones.find((zz) => zz.id === a.zone);
          if (z) { ctx.strokeStyle = z.color; ctx.lineWidth = 3; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]); }
        }
      }

      // Neerslagkaart
      if (this.layers.heatmap && this.heat) {
        const sim = this.heat.sim;
        const p = T({ x: sim.minX - sim.cellX / 2, y: sim.minY - sim.cellY / 2 });
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.heat.canvas, p.x, p.y, sim.nx * sim.cellX * S, sim.ny * sim.cellY * S);
      }

      // Leidingen
      if (this.layers.pipes && st.calc) {
        for (const pp of st.calc.pipes) {
          const a = T(pp.a), b = T(pp.b);
          const z = st.zones.find((zz) => zz.id === pp.zone);
          ctx.strokeStyle = pp.main ? '#01579b' : pp.outlet ? '#00838f' : z ? z.color : '#555';
          ctx.lineWidth = Math.max(1.5, (pp.dn / 25) * 2.2);
          if (pp.outlet) ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]);
          if (this.layers.labels && S > 25 && pp.len > 1.5) {
            const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            this._label(ctx, `${pp.dn}`, m.x, m.y, '#fff', ctx.strokeStyle, 9);
          }
        }
      }

      // Worpbereik van sproeiers
      if (this.layers.coverage) {
        for (const s of st.sprinklers) this._coverage(ctx, s);
      }

      // Sproeierkoppen
      for (const s of st.sprinklers) this._head(ctx, s);

      // Grepen van de geselecteerde sproeier
      if (this.selection && this.selection.kind === 'sprinkler') {
        const s = st.sprinklers.find((x) => x.id === this.selection.id);
        if (s) this._sprinklerGrips(ctx, s);
      }

      // Systeemelementen
      for (const e of st.elements) this._element(ctx, e);

      // Geselecteerd vlak: hoekpunten + randmaten
      if (this.selection && this.selection.kind === 'area') {
        const a = st.areas.find((x) => x.id === this.selection.id);
        if (a) this._areaHandles(ctx, a);
      }

      // Concept-polygoon. Op touch alleen een voorbeeldlijn zolang de vinger een nieuw punt vasthoudt.
      const dr = this.drag;
      const tapPt = dr && dr.mode === 'tap' && !dr.panning && this.tool === 'polygon' ? dr.w : null;
      if (this.draft && this.draft.length) {
        const live = !this.touch || tapPt;
        const m = tapPt || this.snapPoint({ x: this.mouse.wx, y: this.mouse.wy });
        ctx.strokeStyle = '#ff6f00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        this.draft.forEach((p, i) => { const s = T(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        const ms = T(m);
        if (live) ctx.lineTo(ms.x, ms.y);
        ctx.stroke();
        ctx.setLineDash([]);
        this.draft.forEach((p) => { const s = T(p); ctx.fillStyle = '#ff6f00'; ctx.fillRect(s.x - 3, s.y - 3, 6, 6); });
        const last = this.draft[this.draft.length - 1];
        const off = this.touch ? 34 : 12; // label niet onder de vinger
        if (live) this._label(ctx, `${G.nl(G.dist(last, m), 2)} m`, ms.x + off, ms.y - off, '#ff6f00', '#fff', this.touch ? 13 : 11);
        if (this.touch && this.draft.length >= 3) {
          // vangzone van het eerste punt: hier tikken sluit de vorm
          const f = T(this.draft[0]);
          ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(f.x, f.y, this._tol(10), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,111,0,0.15)'; ctx.fill(); ctx.stroke();
        }
      }
      if (tapPt) {
        const ms = T(tapPt);
        ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ms.x, ms.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ms.x - 14, ms.y); ctx.lineTo(ms.x + 14, ms.y); ctx.moveTo(ms.x, ms.y - 14); ctx.lineTo(ms.x, ms.y + 14); ctx.stroke();
      }

      const d = this.drag;
      if (d && (d.mode === 'rect')) {
        const a = T(d.start), b = T(d.end);
        ctx.strokeStyle = '#ff6f00'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        ctx.setLineDash([]);
        this._label(ctx, `${G.nl(Math.abs(d.end.x - d.start.x), 2)} × ${G.nl(Math.abs(d.end.y - d.start.y), 2)} m`, b.x + 12, b.y - 12, '#ff6f00', '#fff', 11);
      }
      const ml = d && (d.mode === 'calibrate' || d.mode === 'measure') ? { a: d.start, b: d.end } : this.tool === 'measure' ? this.lastMeasure : null;
      if (ml) {
        const a = T(ml.a), b = T(ml.b);
        ctx.strokeStyle = d && d.mode === 'calibrate' ? '#d81b60' : '#6a1b9a';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        this._label(ctx, `${G.nl(G.dist(ml.a, ml.b), 2)} m`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, ctx.strokeStyle, '#fff', 11);
      }

      if (!opts.noScale) this._scaleBar(ctx, w, h);
    }

    _grid(ctx, w, h) {
      const S = this.view.scale;
      let step = 1;
      if (S < 8) step = 10; else if (S < 20) step = 5; else if (S > 120) step = 0.5;
      const tl = this.toWorld(0, 0), br = this.toWorld(w, h);
      ctx.lineWidth = 1;
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round((x - this.view.x) * S) + 0.5;
        ctx.strokeStyle = Math.abs(x % (step * 5)) < 1e-6 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.05)';
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
      }
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        const sy = Math.round((y - this.view.y) * S) + 0.5;
        ctx.strokeStyle = Math.abs(y % (step * 5)) < 1e-6 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.05)';
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
      }
    }

    _dripHatch(ctx, a) {
      const spacing = a.type === 'hedge' ? C.drip.rowSpacingHedge : a.type === 'planter' ? C.drip.rowSpacingPlanter : C.drip.rowSpacingBed;
      const S = this.view.scale;
      if (spacing * S < 4) return;
      const rect = G.minWidthRect(a.pts);
      ctx.save();
      ctx.beginPath();
      a.pts.forEach((p, i) => { const s = this.toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(62,39,35,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      for (let v = rect.minV + spacing / 2; v < rect.maxV; v += spacing) {
        const p1 = this.toScreen(G.add(G.mul(rect.u, rect.minU), G.mul(rect.v, v)));
        const p2 = this.toScreen(G.add(G.mul(rect.u, rect.maxU), G.mul(rect.v, v)));
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      ctx.restore();
    }

    /** Druppelaars: stippen op de plantafstand. */
    _drippersDots(ctx, a) {
      const S = this.view.scale;
      const per = a.type === 'planter' ? C.drippers.perM2Planter : C.drippers.perM2Bed;
      const step = 1 / Math.sqrt(per);
      if (step * S < 6) return;
      const bb = G.bbox(a.pts);
      ctx.fillStyle = 'rgba(62,39,35,0.7)';
      for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
        for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
          if (!G.pointInPolygon({ x, y }, a.pts)) continue;
          const p = this.toScreen({ x, y });
          ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    _zoneColor(s) {
      const z = s.zone && this.state.zones.find((zz) => zz.id === s.zone);
      return z ? z.color : C.sprinklerTypes[s.type].color;
    }

    _coverage(ctx, s) {
      const S = this.view.scale;
      const p = this.toScreen(s);
      const col = this._zoneColor(s);
      ctx.fillStyle = this.layers.heatmap ? 'transparent' : col + '22';
      ctx.strokeStyle = col + (this.layers.heatmap ? '55' : '88');
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (s.type === 'strip') {
        const a = G.rad(s.start);
        const u = { x: Math.cos(a), y: Math.sin(a) }, n = { x: -u.y, y: u.x };
        const c = [G.add(s, G.mul(u, -s.len / 2)), G.add(s, G.mul(u, s.len / 2))];
        const pts = [c[0], c[1], G.add(c[1], G.mul(n, s.width)), G.add(c[0], G.mul(n, s.width))].map((q) => this.toScreen(q));
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
      } else if (s.arc >= 359.9) {
        ctx.arc(p.x, p.y, s.r * S, 0, Math.PI * 2);
      } else {
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, s.r * S, G.rad(s.start), G.rad(s.start + s.arc));
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    _head(ctx, s) {
      const p = this.toScreen(s);
      const sel = this.selection && this.selection.kind === 'sprinkler' && this.selection.id === s.id;
      const col = this._zoneColor(s);
      const rad = 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad + (sel ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.strokeStyle = sel ? '#ff6f00' : '#fff';
      ctx.stroke();
      // richtingsindicator
      if (s.type !== 'strip' && s.arc < 359.9) {
        const mid = G.rad(s.start + s.arc / 2);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(mid) * 12, p.y + Math.sin(mid) * 12); ctx.stroke();
      }
      if (this.layers.labels && this.view.scale > 30) {
        const t = C.sprinklerTypes[s.type];
        const txt = s.type === 'strip' ? `${G.nlShort(s.width, 1)} × ${G.nlShort(s.len, 1)} m` : `${G.nlShort(s.r, 1)} m · ${s.arc}°`;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillStyle = '#263238';
        ctx.fillText(txt, p.x + 7, p.y - 6);
        void t;
      }
    }

    _sprinklerGrips(ctx, s) {
      const p = this.toScreen(s);
      const hs = this.touch ? 8 : 5;
      for (const h of this.sprinklerHandles(s)) {
        const q = this.toScreen(h);
        ctx.strokeStyle = '#ff6f00';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = h.which === 'r' ? '#ff6f00' : '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(q.x, q.y, hs, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const d = this.drag;
      if (d && d.mode === 'handle' && d.id === s.id) {
        const txt = s.type === 'rotator' ? C.rotatorSetting(s) : `${G.nl(s.r, 1)} m · ${s.arc}°`;
        this._label(ctx, txt, p.x, p.y - 22, '#e65100', '#fff', this.touch ? 13 : 11);
      }
    }

    _element(ctx, e) {
      const et = C.elementTypes[e.kind];
      const p = this.toScreen(e);
      const sel = this.selection && this.selection.kind === 'element' && this.selection.id === e.id;
      const sz = 11;
      ctx.fillStyle = et.color;
      ctx.strokeStyle = sel ? '#ff6f00' : '#fff';
      ctx.lineWidth = sel ? 3 : 2;
      ctx.beginPath();
      if (e.kind === 'valvebox') ctx.rect(p.x - sz, p.y - sz * 0.75, sz * 2, sz * 1.5);
      else if (e.kind === 'source') { ctx.moveTo(p.x, p.y - sz); ctx.lineTo(p.x + sz, p.y); ctx.lineTo(p.x, p.y + sz); ctx.lineTo(p.x - sz, p.y); ctx.closePath(); }
      else ctx.arc(p.x, p.y, sz * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(et.short, p.x, p.y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    _areaHandles(ctx, a) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#ff6f00';
      ctx.lineWidth = 1.5;
      const hs = this.touch ? 7 : 4;
      for (let i = 0; i < a.pts.length; i++) {
        const p = this.toScreen(a.pts[i]);
        ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        const b = a.pts[(i + 1) % a.pts.length];
        const mid = this.toScreen({ x: (a.pts[i].x + b.x) / 2, y: (a.pts[i].y + b.y) / 2 });
        ctx.beginPath(); ctx.arc(mid.x, mid.y, this.touch ? 6 : 3, 0, Math.PI * 2); ctx.fillStyle = '#ffcc80'; ctx.fill(); ctx.fillStyle = '#fff';
        if (this.layers.labels) this._label(ctx, `${G.nl(G.dist(a.pts[i], b), 2)} m`, mid.x, mid.y - 12, '#e65100', '#fff', 10);
      }
    }

    _label(ctx, text, x, y, fg, bg, size = 10) {
      ctx.font = `${size}px system-ui, sans-serif`;
      const w = ctx.measureText(text).width + 6;
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x - w / 2, y - size / 2 - 3, w, size + 5);
      ctx.globalAlpha = 1;
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    _scaleBar(ctx, w, h) {
      const S = this.view.scale;
      const candidates = [0.5, 1, 2, 5, 10, 20, 50];
      const len = candidates.find((c) => c * S > 80) || 50;
      const x = 16, y = h - 18;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x - 6, y - 16, len * S + 40, 26);
      ctx.strokeStyle = '#263238';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len * S, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.moveTo(x + len * S, y - 5); ctx.lineTo(x + len * S, y + 5); ctx.stroke();
      ctx.fillStyle = '#263238';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${G.nlShort(len, 1)} m`, x + len * S + 6, y + 4);
    }

    /** Exporteert het plan als PNG (dataURL), passend gezoomd. */
    exportPng(width = 1500, height = 1000) {
      const saved = { ...this.view }, sw = this.w, sh = this.h, sel = this.selection;
      this.w = width; this.h = height; this.selection = null;
      this.fit();
      const cv = document.createElement('canvas');
      cv.width = width; cv.height = height;
      this.draw(cv.getContext('2d'), width, height, 1, { noGrid: false });
      this.view = saved; this.w = sw; this.h = sh; this.selection = sel;
      this.render();
      return cv.toDataURL('image/png');
    }
  }

  window.Editor = Editor;
})();
