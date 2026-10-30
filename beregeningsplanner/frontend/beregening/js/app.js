/* Applicatielogica: status, stappen, panelen, opslaan/laden en export. */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;
  const Hydraulics = window.Hydraulics;
  const Sim = window.Simulation;
  const BOM = window.BOM;

  // Per omgeving (live/test) een eigen lokaal concept, zie shared/env.js.
  // Tekenen zonder account (beregening/?tekenen, knop op de inlogpagina): het
  // plan blijft in deze browser (eigen opslag) tot het wordt ingediend.
  const PARAMS = new URLSearchParams(location.search);
  const ANON = PARAMS.has('tekenen');
  const STORAGE_KEY = `aquatech-beregeningsplanner-v1${window.AquatechEnv ? window.AquatechEnv.storageSuffix() : ''}${ANON ? '-tekenen' : ''}`;
  const LEGEND_KEY = 'aquatech-legenda-open';
  const REVIEW_LABEL = { concept: 'Concept', ter_controle: 'Ter controle', goedgekeurd: 'Goedgekeurd' };
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarin gezocht wordt
   * @returns {Element|null} het element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor gebruik in HTML.
   * @param {*} value de tekst
   * @returns {string} de tekst met &, <, >, " en ' als entiteit
   */
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Getal in Nederlandse notatie, of een streepje als er geen getal is.
   * @param {number} value het getal
   * @param {number} decimals aantal decimalen
   * @returns {string} de tekst
   */
  const formatNumber = (value, decimals = 1) => (value == null || !isFinite(value) ? '–' : Number(value).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  /**
   * Bedrag in euro's met twee decimalen.
   * @param {number} value het bedrag
   * @returns {string} de tekst
   */
  const formatEuro = (value) => `€ ${formatNumber(value, 2)}`;

  const STEPS = [
    { id: 'project', title: 'Project & ondergrond' },
    { id: 'areas', title: 'Gebieden tekenen' },
    { id: 'system', title: 'Systeemelementen' },
    { id: 'sprinklers', title: 'Sproeiers' },
    { id: 'zones', title: 'Zones & leidingen' },
    { id: 'bom', title: 'Stuklijst & export' },
  ];

  const TYPE_PLURAL = { rotator: 'rotators', spray: 'sproeiers', rotor: 'turbines', strip: 'strooksproeiers' };

  /**
   * Een leeg plan met de standaardinstellingen.
   * @returns {object} de planstand
   */
  function emptyState() {
    return {
      version: 1,
      meta: { name: 'Nieuw beregeningsplan', customer: '', address: '' },
      settings: { pressure: 3.5, flow: 2.0, level: 'expert', targetMm: 20, sessions: 3, sprinklerType: 'auto', radius: null,
        methods: { bed: 'dripline', hedge: 'dripline', planter: 'drippers' }, bedSprinklerType: 'spray' },
      background: null,
      areas: [],
      elements: [],
      sprinklers: [],
      zones: [],
      calc: null,
      // Id van het plan in "Mijn plannen" op de server (null = nog niet bewaard).
      serverId: null,
    };
  }

  // Een plan komt ook uit een bestand, de server of een ingediende tekening:
  // nooit zomaar vertrouwen. Tekst blijft tekst, getallen zijn eindige getallen
  // binnen een redelijk bereik, en coördinaten liggen binnen een paar
  // kilometer (anders lopen raster en berekeningen vast).
  const MAX_COORDINATE_M = 5000;

  /**
   * Een eindig getal binnen [min, max], anders de standaardwaarde.
   * @param {*} value De invoer.
   * @param {number} min Ondergrens.
   * @param {number} max Bovengrens.
   * @param {*} fallback Waarde bij ongeldige invoer.
   * @returns {*} Het getal, of fallback.
   */
  function finiteIn(value, min, max, fallback) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
  }

  /**
   * Of een punt eindige coördinaten binnen het toegestane bereik heeft.
   * @param {*} point Het punt ({ x, y }).
   * @returns {boolean} true als het punt bruikbaar is.
   */
  const validPoint = (point) => Boolean(point) && finiteIn(point.x, -MAX_COORDINATE_M, MAX_COORDINATE_M, null) !== null
    && finiteIn(point.y, -MAX_COORDINATE_M, MAX_COORDINATE_M, null) !== null;

  /**
   * Schoont plangegevens op vóór gebruik: tekstvelden in meta als tekst,
   * getallen in de instellingen en de ondergrond binnen hun bereik, geen
   * onderdelen met ongeldige coördinaten en elke zone maar één keer.
   * @param {object} data De plangegevens (bestand, server of lokaal concept).
   * @returns {object} Een opgeschoonde kopie.
   */
  function sanitizePlan(data) {
    const base = emptyState();
    const source = data && typeof data === 'object' ? data : {};
    const meta = { ...base.meta };
    for (const [key, value] of Object.entries(source.meta && typeof source.meta === 'object' ? source.meta : {})) {
      if (typeof value === 'string') meta[key] = value.slice(0, 500);
      else if (typeof value === 'number' || typeof value === 'boolean') meta[key] = value;
    }
    const settings = { ...base.settings, ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) };
    settings.pressure = finiteIn(settings.pressure, 0.5, 15, base.settings.pressure);
    settings.flow = finiteIn(settings.flow, 0.1, 50, base.settings.flow);
    settings.targetMm = finiteIn(settings.targetMm, 1, 200, base.settings.targetMm);
    settings.sessions = finiteIn(settings.sessions, 1, 21, base.settings.sessions);
    settings.radius = finiteIn(settings.radius, 0.5, 40, null);
    if (settings.wandTol !== undefined) settings.wandTol = finiteIn(settings.wandTol, 0, 255, undefined);
    let background = source.background && typeof source.background === 'object' ? { ...source.background } : null;
    if (background) {
      background.x = finiteIn(background.x, -MAX_COORDINATE_M, MAX_COORDINATE_M, 0);
      background.y = finiteIn(background.y, -MAX_COORDINATE_M, MAX_COORDINATE_M, 0);
      background.scale = finiteIn(background.scale, 1e-6, 100, null);
      background.opacity = finiteIn(background.opacity, 0.1, 1, 0.6);
      if (typeof background.dataUrl !== 'string' || !background.scale) background = null;
    }
    /**
     * Alleen objecten uit een lijst; een naam die geen tekst is wordt leeg.
     * @param {*} value De lijst uit het plan.
     * @returns {object[]} De onderdelen.
     */
    const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object')
      .map((item) => (item.name === undefined || typeof item.name === 'string' ? item : { ...item, name: '' })) : []);
    const seenZones = new Set();
    return {
      ...source,
      meta,
      settings,
      background,
      areas: list(source.areas).filter((area) => Array.isArray(area.pts) && area.pts.every(validPoint)),
      elements: list(source.elements).filter(validPoint),
      sprinklers: list(source.sprinklers).filter(validPoint),
      zones: list(source.zones).filter((zone) => {
        if (seenZones.has(zone.id)) return false;
        seenZones.add(zone.id);
        return true;
      }),
    };
  }

  const App = {
    state: emptyState(),
    step: 0,
    undoStack: [],
    redoStack: [],
    editor: null,
    sim: null,

    /** Start de planner: editor, opgeslagen concept, knoppen, stappen, achtergrond, rechten en een plan uit de URL. */
    init() {
      this.editor = new window.Editor($('#canvas'), this);
      this._load();
      this._bindGlobal();
      this.renderSteps();
      this.showStep(this.step);
      this.recalc();
      this.refreshBackground().then(() => this.editor.fit());
      this.refreshAiStatus();
      // Zonder account geen AI-herkenning en geen webshopprijzen (lokale herkenning werkt wel).
      if (window.ShopCatalog && !ANON) {
        window.ShopCatalog.load().then((info) => {
          if (!info && !window.ShopCatalog.library) return;
          this.recalc();
          if (['bom', 'sprinklers'].includes(STEPS[this.step].id)) this.renderStepPanel();
        });
      }
      this._loadRights().then(() => { this._restoreOwnedDraft(); this._initReview(); });
      this._openFromUrl();
      window.addEventListener('beforeunload', () => this._flushSync());
    },

    // ---------- Status & undo ----------
    /**
     * Momentopname van het plan (zonder berekening en ondergrond) voor ongedaan maken.
     * @returns {string} het plan als JSON
     */
    snapshot() {
      const { areas, elements, sprinklers, zones, settings, meta } = this.state;
      return JSON.stringify({ areas, elements, sprinklers, zones, settings, meta });
    },
    /** Bewaart de huidige stand voor ongedaan maken (maximaal 80 stappen) en wist opnieuw doen. */
    checkpoint() {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
    },
    /**
     * Zet een momentopname terug.
     * @param {string} json momentopname uit snapshot()
     */
    _restore(json) {
      Object.assign(this.state, JSON.parse(json));
      this.editor.selection = null;
      this.commit(false);
    },
    /** Maakt de laatste wijziging ongedaan. */
    undo() {
      if (!this.undoStack.length) return;
      this.redoStack.push(this.snapshot());
      this._restore(this.undoStack.pop());
      this.toast('Ongedaan gemaakt');
    },
    /** Voert de laatst ongedaan gemaakte wijziging opnieuw uit. */
    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(this.snapshot());
      this._restore(this.redoStack.pop());
    },
    /** Markeert de berekening als verouderd (tijdens slepen). */
    invalidate() {
      this.state.calc = null;
    },
    /**
     * Na elke wijziging: herberekenen, opslaan en UI verversen.
     * @param {boolean} save ook opslaan (lokaal en op de server)
     */
    commit(save = true) {
      this.recalc();
      if (save) this._save();
      this.onSelectionChanged();
      this.renderStepPanel();
      this.editor.render();
    },
    /** Berekent zones en leidingen opnieuw, en de neerslagkaart als die aan staat. */
    recalc() {
      const planState = this.state;
      if (planState.zones.length) Hydraulics.calculate(planState); else planState.calc = null;
      if (this.editor.layers.heatmap) this.updateHeat();
      this.renderWarnings();
    },
    /** Berekent de neerslagkaart; de celgrootte volgt de oppervlakte van het gazon. */
    updateHeat() {
      const planState = this.state;
      const lawnArea = planState.areas.filter((area) => area.type === 'lawn').reduce((sum, area) => sum + Geo.area(area.pts), 0);
      const cell = Math.max(0.15, Math.min(0.5, Math.sqrt((lawnArea * 2 + 50) / 120000)));
      const sim = planState.sprinklers.length ? Sim.simulate(planState, cell) : null;
      this.sim = sim;
      this.editor.heat = sim ? { sim, canvas: Sim.toCanvas(sim) } : null;
    },

    /** Bewaart het plan lokaal en plant de opslag op de server in. */
    _save() {
      this._saveLocal();
      this._scheduleSync();
    },
    /**
     * Bewaart het concept in deze browser, met de eigenaar erbij (wie er was
     * ingelogd), zodat een volgende gebruiker van de browser het niet te zien krijgt.
     */
    _saveLocal() {
      if (this._pendingDraft) return; // eerst kijken of het bewaarde concept van deze gebruiker is
      const owner = this._owner || undefined;
      try {
        const data = { ...this.state, calc: null, step: this.step, owner };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (error) {
        // Opslag vol (bijv. grote achtergrond) of geblokkeerd: zonder achtergrond proberen
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.state, calc: null, background: null, step: this.step, owner }));
        } catch (retryError) { /* negeren */ }
      }
    },
    /**
     * Leest het concept uit deze browser. Op de server wacht het tot api/me
     * bekend is (_restoreOwnedDraft); een concept zonder eigenaar (oude
     * versie) wordt daar gewist. Alleen via file:// en bij ?tekenen meteen.
     */
    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && !ANON && location.protocol !== 'file:') {
          this._pendingDraft = data;
          return;
        }
        this._apply(data);
        this.step = Math.min(STEPS.length - 1, data.step || 0);
      } catch (error) { /* negeren */ }
    },
    /**
     * Na api/me: het bewaarde concept alleen tonen als het van deze gebruiker
     * (en omgeving) is; van iemand anders wordt het gewist.
     */
    _restoreOwnedDraft() {
      const draft = this._pendingDraft;
      // api/me niet gelukt (geen verbinding): niet tonen en niet overschrijven.
      if (!draft || !this.me) return;
      this._pendingDraft = null;
      if (!this._owner || draft.owner !== this._owner) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* geen opslag */ }
        return;
      }
      // Intussen een ander plan geopend (?plan=, kopie of bestand): dat gaat voor.
      const current = this.state;
      if (current.serverId || current.areas.length || current.sprinklers.length) return;
      this._apply(draft);
      this.step = Math.min(STEPS.length - 1, draft.step || 0);
      this.editor.selection = null;
      this.editor.bgImg = null;
      this.renderSteps();
      this.showStep(this.step);
      this.recalc();
      this.editor.render();
      this.refreshBackground().then(() => this.editor.fit());
    },
    /**
     * Neemt plangegevens over (opgeschoond, zonder berekening).
     * @param {object} data de plangegevens
     */
    _apply(data) {
      this.state = { ...emptyState(), ...sanitizePlan(data), calc: null };
    },

    // ---------- Mijn plannen (opslag op de server) ----------
    // Elk plan met inhoud wordt een paar seconden na de laatste wijziging op de
    // server bewaard. Alleen de eigenaar ziet het terug; de beheerder ziet het
    // in de historie van aanvragen. Via file:// is er geen server.
    /**
     * Is er een server om plannen op te bewaren (niet via file:// of zonder account)?
     * @returns {boolean} true als plannen op de server bewaard kunnen worden
     */
    _serverAvailable() {
      return location.protocol !== 'file:' && !ANON;
    },
    /**
     * Plangegevens voor de server (zonder berekening en server-id).
     * @returns {object} de plangegevens
     */
    _serverData() {
      const { calc, serverId, ...data } = this.state;
      return data;
    },
    /** Plant het bewaren op de server in, 4 seconden na de laatste wijziging. */
    _scheduleSync() {
      if (!this._serverAvailable()) return;
      const planState = this.state;
      if (!planState.areas.length && !planState.sprinklers.length && !planState.serverId) return;
      this._syncPending = true;
      clearTimeout(this._syncT);
      this._syncT = setTimeout(() => this._sync(), 4000);
    },
    /**
     * Bewaart het plan op de server (nieuw of bijwerken) en werkt de controlestatus bij.
     * @returns {Promise<void>} klaar na bewaren of mislukken
     */
    async _sync() {
      if (this._syncing) { this._scheduleSync(); return; }
      this._syncPending = false;
      this._syncing = true;
      const id = this.state.serverId;
      /**
       * Stuurt het plan naar de server.
       * @param {string} method POST of PUT
       * @param {string} url adres van de API
       * @returns {Promise<Response>} het antwoord
       */
      const send = (method, url) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: this._serverData() }) });
      try {
        let res = await send(id ? 'PUT' : 'POST', id ? `api/plans/${encodeURIComponent(id)}` : 'api/plans');
        // Plan niet (meer) van deze gebruiker: als nieuw plan bewaren.
        if (res.status === 404 && id) res = await send('POST', 'api/plans');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const plan = await res.json();
        if (this.state.serverId !== plan.id) {
          this.state.serverId = plan.id;
          this._saveLocal();
          this.review = { status: plan.reviewStatus || 'concept' };
          this._renderReview();
        } else if (plan.reviewStatus && this.review && plan.reviewStatus !== this.review.status) {
          // Een klant wijzigde een goedgekeurd plan: opnieuw ter controle.
          this.review = { ...this.review, status: plan.reviewStatus };
          this._renderReview();
        }
        this._syncFailed = false;
      } catch (error) {
        // Offline of geen toegang: het plan staat nog in de browser.
        if (!this._syncFailed) console.warn('Plan niet op de server bewaard:', error.message);
        this._syncFailed = true;
      } finally {
        this._syncing = false;
      }
    },
    /**
     * Rechten van de gebruiker (shared/roles.js): een klant maakt geen offertes.
     * @returns {Promise<void>} klaar als de rechten bekend zijn
     */
    async _loadRights() {
      if (location.protocol === 'file:') return;
      // Zelfde verzoek als de zijbalk (shared/common.js).
      if (window.AquatechCommon) {
        const me = await window.AquatechCommon.getJson('api/me');
        if (me) this.rights = me.rights || [];
        this.me = me;
        // Van wie het lokale concept is (gebruiker + omgeving).
        this._owner = window.AquatechCommon.ownerOf(me);
        // Ingelogd met ?tekenen: gewoon de planner met Mijn plannen.
        if (ANON && me && me.user) location.replace(location.pathname);
        return;
      }
      if (ANON) return;
      try {
        const res = await fetch('api/me', { cache: 'no-store' });
        if (res.ok) this.rights = (await res.json()).rights || [];
      } catch (error) { /* offline: alles tonen, de server beslist */ }
    },
    /**
     * Heeft de gebruiker dit recht (zonder bekende rechten: ja, de server beslist)?
     * @param {string} right het recht
     * @returns {boolean} true als het mag
     */
    _can(right) {
      return !this.rights || this.rights.includes(right);
    },
    /**
     * Naar de module Offertes: eerst het plan op de server bewaren.
     * @returns {Promise<void>} klaar na doorsturen of melding
     */
    async makeQuote() {
      clearTimeout(this._syncT);
      if (this._syncPending || !this.state.serverId) await this._sync();
      if (!this.state.serverId) {
        this.toast('Het plan kon niet op de server worden bewaard; probeer het zo opnieuw.');
        return;
      }
      location.href = `../offertes/?plan=${encodeURIComponent(this.state.serverId)}`;
    },
    /** Bewaart een openstaande wijziging nog snel bij het sluiten van de pagina (keepalive). */
    _flushSync() {
      if (!this._syncPending || !this.state.serverId) return;
      clearTimeout(this._syncT);
      const body = JSON.stringify({ data: this._serverData() });
      // keepalive mag maar 64 kB meesturen; grotere plannen (met achtergrond)
      // zijn bij de vorige automatische opslag al bewaard.
      if (body.length > 60000) return;
      try {
        fetch(`api/plans/${encodeURIComponent(this.state.serverId)}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body });
      } catch (error) { /* negeren */ }
    },
    /**
     * Opent een plan uit de URL: een kopie uit Beheer (?copy) of een eigen plan (?plan=).
     * @returns {Promise<void>} klaar na openen
     */
    async _openFromUrl() {
      const params = new URLSearchParams(location.search);
      // Kopie vanuit Beheer (historie of plan van een andere gebruiker): wordt
      // een nieuw, eigen plan; het origineel blijft onaangeroerd.
      if (params.get('copy')) {
        history.replaceState(null, '', location.pathname);
        let data = null;
        try { data = JSON.parse(sessionStorage.getItem('aquatech-open-copy') || 'null'); sessionStorage.removeItem('aquatech-open-copy'); } catch (error) { /* geen opslag */ }
        if (!data || !Array.isArray(data.areas)) return;
        this.checkpoint();
        this._apply(data);
        this.state.serverId = null;
        this.editor.selection = null;
        this.editor.bgImg = null;
        await this.refreshBackground();
        this.commit();
        this.editor.fit();
        this.toast('Kopie geopend als nieuw plan');
        return;
      }
      const id = params.get('plan');
      if (!id || !this._serverAvailable()) return;
      history.replaceState(null, '', location.pathname);
      await this.openServerPlan(id);
    },
    /**
     * Opent een plan van de server.
     * @param {string} id id van het plan
     * @returns {Promise<void>} klaar na openen of melding
     */
    async openServerPlan(id) {
      try {
        const res = await fetch(`api/plans/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status === 404 ? 'plan niet gevonden' : `HTTP ${res.status}`);
        const plan = await res.json();
        this.checkpoint();
        this._apply(plan.data);
        this.state.serverId = plan.id;
        this.review = plan.review || null;
        this._renderReview();
        this.editor.selection = null;
        this.editor.bgImg = null;
        await this.refreshBackground();
        this.commit(false);
        this._saveLocal();
        this.editor.fit();
        this.toast(`Plan "${plan.title}" geopend`);
      } catch (error) {
        this.toast(`Kan plan niet openen: ${error.message}`, true);
      }
    },
    /**
     * Toont de eigen plannen op de server, met openen en verwijderen.
     * @returns {Promise<void>} klaar na tonen
     */
    async showMyPlans() {
      const dialog = $('#myplans');
      const list = $('#myplans-list');
      dialog.classList.add('open');
      if (!this._serverAvailable()) {
        list.innerHTML = '<p class="hint">Mijn plannen werkt alleen via de server, niet vanuit een los bestand.</p>';
        return;
      }
      list.innerHTML = '<p class="hint">Laden…</p>';
      try {
        if (this._syncPending) { clearTimeout(this._syncT); await this._sync(); }
        const res = await fetch('api/plans', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { items } = await res.json();
        if (!items.length) {
          list.innerHTML = '<p class="hint">Nog geen plannen bewaard. Een plan wordt automatisch bewaard zodra je een vlak tekent.</p>';
          return;
        }
        /**
         * Datum en tijd in Nederlandse notatie.
         * @param {string} iso tijdstip (ISO)
         * @returns {string} de tekst
         */
        const when = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
        list.innerHTML = `<table class="list"><thead><tr><th>Plan</th><th>Gewijzigd</th><th></th></tr></thead><tbody>${items.map((plan) => `
          <tr${plan.id === this.state.serverId ? ' class="sel"' : ''}>
            <td><b>${escapeHtml(plan.title)}</b>${plan.customer || plan.address ? `<br><span class="hint">${escapeHtml([plan.customer, plan.address].filter(Boolean).join(' · '))}</span>` : ''}</td>
            <td>${escapeHtml(when(plan.updatedAt))}</td>
            <td class="myplans-act">
              ${plan.id === this.state.serverId ? '<span class="hint">Geopend</span>' : `<button class="btn" data-open="${escapeHtml(plan.id)}">Openen</button>`}
              <button class="btn ghost" data-del="${escapeHtml(plan.id)}" title="Verwijderen">🗑</button>
            </td>
          </tr>`).join('')}</tbody></table>`;
        list.querySelectorAll('[data-open]').forEach((button) => {
          /** Sluit de lijst en opent het gekozen plan. */
          button.onclick = async () =>{  { dialog.classList.remove('open'); await this.openServerPlan(button.dataset.open); }; };
        });
        list.querySelectorAll('[data-del]').forEach((button) => {
          /** Verwijdert het plan na bevestiging en ververst de lijst. */
          button.onclick = async () => {
            if (!confirm('Dit plan verwijderen uit Mijn plannen?')) return;
            const response = await fetch(`api/plans/${encodeURIComponent(button.dataset.del)}`, { method: 'DELETE' });
            if (!response.ok) { this.toast('Verwijderen mislukt', true); return; }
            if (button.dataset.del === this.state.serverId) { this.state.serverId = null; this._saveLocal(); }
            this.showMyPlans();
          };
        });
      } catch (error) {
        list.innerHTML = `<p class="hint">Kan de plannen niet laden (${escapeHtml(error.message)}).</p>`;
      }
    },

    // ---------- Controle en indienen ----------
    // Een plan van een klant is nooit meteen definitief: een installateur
    // (recht plannen.goedkeuren) keurt het goed. Zonder account dient de
    // bezoeker de tekening in met contactgegevens (api/public/drawing).
    /**
     * Haalt de controlestatus op (of bij tekenen zonder account de instellingen voor indienen) en toont de balk.
     * @returns {Promise<void>} klaar na tonen
     */
    async _initReview() {
      this._bindReview();
      if (ANON) {
        this.org = PARAMS.get('org') || '';
        try {
          const res = await fetch(`api/public/drawing?org=${encodeURIComponent(this.org)}`, { cache: 'no-store' });
          this.drawing = res.ok ? await res.json() : { enabled: false };
        } catch (error) {
          this.drawing = { enabled: false };
        }
        document.body.classList.add('anon');
      } else if (this.state.serverId && !this.review) {
        // Plan uit de browser dat al op de server staat: status ophalen.
        try {
          const res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}`, { cache: 'no-store' });
          if (res.ok) this.review = (await res.json()).review || null;
        } catch (error) { /* offline */ }
      }
      this._renderReview();
    },
    /**
     * Link naar de inlogpagina, met de organisatiecode als die bekend is.
     * @returns {string} het adres
     */
    _loginHref() {
      return `../login${this.org ? `?org=${encodeURIComponent(this.org)}` : ''}`;
    },
    /** Toont de balk met de controlestatus van het plan en de knoppen die bij de gebruiker passen. */
    _renderReview() {
      const bar = $('#review-bar');
      if (!bar) return;
      if (ANON) {
        const drawing = this.drawing;
        if (!drawing) { bar.hidden = true; return; }
        bar.hidden = false;
        bar.className = 'review-bar anon';
        bar.innerHTML = drawing.enabled
          ? `<div class="rv-text"><b>Tekenen zonder account</b><span>Teken je tuin en dien hem in: een installateur${drawing.company ? ` van ${escapeHtml(drawing.company)}` : ''} controleert hem. Tot dan blijft de tekening alleen in deze browser.</span></div>
             <div class="rv-act"><button id="rv-submit" class="btn primary">Tekening indienen</button><a class="rv-login" href="${escapeHtml(this._loginHref())}">Inloggen</a></div>`
          : `<div class="rv-text"><b>Tekenen zonder account</b><span>Bij deze organisatie kun je geen tekening indienen zonder account. Log in om je plan te bewaren.</span></div>
             <div class="rv-act"><a class="btn" href="${escapeHtml(this._loginHref())}">Inloggen</a></div>`;
        return;
      }
      const review = this.review;
      if (!this.state.serverId || !review || !this.rights) { bar.hidden = true; return; }
      const approver = this._can('plannen.goedkeuren');
      /**
       * Datum in Nederlandse notatie (dag en maand), of leeg.
       * @param {string} iso tijdstip (ISO)
       * @returns {string} de tekst
       */
      const when = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '');
      let info = '';
      let actions = '';
      if (review.status === 'goedgekeurd') {
        info = `Goedgekeurd${review.reviewedBy ? ` door ${escapeHtml(review.reviewedBy)}` : ''}${review.reviewedAt ? ` op ${when(review.reviewedAt)}` : ''}.${approver ? '' : ' Pas je iets aan, dan gaat het plan opnieuw ter controle.'}`;
        if (approver) actions = '<button id="rv-reopen" class="btn ghost">Goedkeuring intrekken</button>';
      } else if (review.status === 'ter_controle') {
        info = approver
          ? `${review.via === 'openbaar' ? 'Ingediend zonder account' : 'Aangeboden ter controle'}${review.requestedAt ? ` op ${when(review.requestedAt)}` : ''}.${review.question ? ` Vraag: “${escapeHtml(review.question)}”` : ''}`
          : 'Een installateur controleert dit plan. Je hoort het als het is goedgekeurd.';
        if (approver) actions = '<button id="rv-approve" class="btn primary">Goedkeuren</button>';
      } else {
        info = approver ? 'Nog niet goedgekeurd. Pas na goedkeuring is het plan definitief (en kan er een offerte van).' : 'Klaar met tekenen? Laat het plan controleren door een installateur.';
        actions = approver ? '<button id="rv-approve" class="btn primary">Goedkeuren</button>' : '<button id="rv-request" class="btn primary">Ter controle aanbieden</button>';
      }
      bar.hidden = false;
      bar.className = `review-bar st-${review.status}`;
      bar.innerHTML = `<div class="rv-text"><span class="rv-chip">${REVIEW_LABEL[review.status] || escapeHtml(review.status)}</span><span>${info}</span></div>${actions ? `<div class="rv-act">${actions}</div>` : ''}`;
    },
    /** Koppelt de knoppen van de controlebalk en het indienformulier. */
    _bindReview() {
      const bar = $('#review-bar');
      if (!bar) return;
      /**
       * Voert de gekozen knop van de controlebalk uit.
       * @param {Event} event de gebeurtenis
       */
      bar.onclick = (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.id === 'rv-submit' || button.id === 'rv-request') this.openSubmit();
        if (button.id === 'rv-approve') this.reviewPlan('approve');
        if (button.id === 'rv-reopen') this.reviewPlan('reopen');
      };
      const dialog = $('#submit-dlg');
      const form = $('#submit-form');
      /** Sluit het indienformulier. */
      $('#submit-close').onclick = () => { dialog.classList.remove('open'); };
      /**
       * Verstuurt het indienformulier.
       * @param {Event} event de gebeurtenis
       */
      form.onsubmit = (event) =>{  { event.preventDefault(); this.submitDrawing(); }; };
      /** Sluit het formulier en start een nieuw project. */
      $('#submit-new').onclick = () =>{  { dialog.classList.remove('open'); this.newProject(); }; };
      /** Sluit het formulier na indienen. */
      $('#submit-done').onclick = () => { dialog.classList.remove('open'); };
    },
    /** Opent het formulier om de tekening in te dienen of het plan ter controle aan te bieden. */
    openSubmit() {
      const planState = this.state;
      if (!planState.areas.length) { this.toast('Teken eerst minstens één vlak van je tuin (stap 2).', true); return; }
      const form = $('#submit-form');
      form.hidden = false;
      $('#submit-ok').hidden = true;
      // Zonder account: contactgegevens erbij; ingelogd alleen de vraag.
      form.querySelectorAll('[data-anon]').forEach((field) => { field.hidden = !ANON; });
      form.querySelectorAll('[data-anon] input').forEach((input) => { input.required = ANON && input.dataset.req === '1'; });
      if (ANON) {
        if (!form.address.value) form.address.value = planState.meta.address || '';
        if (!form.name.value) form.name.value = planState.meta.customer || '';
        $('#submit-company').textContent = (this.drawing && this.drawing.company) || 'het installatiebedrijf';
      }
      $('#submit-title').textContent = ANON ? 'Tekening indienen' : 'Ter controle aanbieden';
      $('.err', form).textContent = '';
      $('#submit-dlg').classList.add('open');
      (ANON ? form.name : form.question).focus();
    },
    /**
     * Dient de tekening in (zonder account) of biedt het plan ter controle aan.
     * @returns {Promise<void>} klaar na versturen of melding
     */
    async submitDrawing() {
      const form = $('#submit-form');
      const errorBox = $('.err', form);
      const button = $('button[type=submit]', form);
      if (!form.reportValidity()) return;
      errorBox.textContent = '';
      button.disabled = true;
      try {
        let res;
        if (ANON) {
          const { calc, serverId, ...data } = this.state;
          res = await fetch('api/public/drawing', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              org: this.org, name: form.name.value, email: form.email.value, phone: form.phone.value, address: form.address.value,
              question: form.question.value, consent: form.consent.checked, website: form.website.value, data,
            }),
          });
        } else {
          clearTimeout(this._syncT);
          if (this._syncPending || !this.state.serverId) await this._sync();
          if (!this.state.serverId) throw new Error('Het plan kon niet op de server worden bewaard; probeer het zo opnieuw.');
          res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}/review-request`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: form.question.value }),
          });
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `Indienen mislukt (HTTP ${res.status}).`);
        if (ANON) {
          form.hidden = true;
          $('#submit-ref').textContent = body.reference || '';
          $('#submit-ok').hidden = false;
        } else {
          this.review = body.review;
          this._renderReview();
          $('#submit-dlg').classList.remove('open');
          this.toast('Plan ter controle aangeboden');
        }
      } catch (error) {
        errorBox.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    },
    /**
     * Keurt het plan goed of trekt de goedkeuring in.
     * @param {string} action approve of reopen
     * @returns {Promise<void>} klaar na verwerken of melding
     */
    async reviewPlan(action) {
      clearTimeout(this._syncT);
      if (this._syncPending) await this._sync();
      try {
        const res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}/review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
        this.review = body.review;
        this._renderReview();
        if (STEPS[this.step].id === 'bom') this.renderStepPanel();
        this.toast(action === 'approve' ? 'Plan goedgekeurd' : 'Goedkeuring ingetrokken');
        if (action === 'approve') this._learnFromPlan();
      } catch (error) {
        this.toast(`Lukt niet: ${error.message}`, true);
      }
    },

    /**
     * Een goedgekeurd plan is door een mens gecontroleerd: de lokale herkenning leert van de vlakken op de
     * ondergrond. Alleen kleurtellingen gaan naar de server; zonder ondergrond of vlakken gebeurt niets.
     * @returns {Promise<void>} klaar na leren
     */
    async _learnFromPlan() {
      const planState = this.state, background = planState.background;
      if (!background || !background.dataUrl || !background.scale || !planState.areas.length || !planState.serverId) return;
      try {
        const analyzeImage = await window.PlanImport.analyzeImageFrom(background.dataUrl);
        // meters → pixels van de ondergrond → pixels van de analyse-afbeelding
        /**
         * Rekent een punt in meters om naar pixels van de analyse-afbeelding.
         * @param {{x: number, y: number}} point punt in meters
         * @returns {{x: number, y: number}} punt in pixels
         */
        const toPixels = (point) => ({ x: ((point.x - (background.x || 0)) / background.scale) * analyzeImage.factor, y: ((point.y - (background.y || 0)) / background.scale) * analyzeImage.factor });
        const areas = planState.areas.filter((area) => area.pts && area.pts.length >= 3).map((area) => ({ type: area.type, points: area.pts.map(toPixels) }));
        const samples = await window.LocalRecognizer.learn(analyzeImage, { areas });
        if (samples) await window.Concept.teach({ planId: planState.serverId, samples });
      } catch (error) {
        /* leren is een bijzaak */
      }
    },

    // ---------- Objecten ----------
    /**
     * Zoekt het object bij een treffer van de editor.
     * @param {object} hit treffer {kind, id}
     * @returns {object|null} het vlak, de sproeier of het element
     */
    findObject(hit) {
      if (!hit) return null;
      const planState = this.state;
      if (hit.kind === 'area' || hit.kind === 'vertex' || hit.kind === 'midpoint') return planState.areas.find((area) => area.id === hit.id);
      if (hit.kind === 'sprinkler') return planState.sprinklers.find((sprinkler) => sprinkler.id === hit.id);
      if (hit.kind === 'element') return planState.elements.find((element) => element.id === hit.id);
      return null;
    },
    /**
     * Voegt een getekend vlak toe en selecteert het.
     * @param {string} type vlaktype
     * @param {Array<{x: number, y: number}>} points hoekpunten in meters
     */
    addArea(type, points) {
      this.checkpoint();
      const count = this.state.areas.filter((area) => area.type === type).length + 1;
      const area = { id: Geo.uid('a'), type, name: `${Catalog.areaTypes[type].label} ${count}`, pts: points.map((point) => ({ x: +point.x.toFixed(3), y: +point.y.toFixed(3) })), zone: null };
      this.state.areas.push(area);
      this.editor.selection = { kind: 'area', id: area.id };
      this.commit();
      this.toast(`${Catalog.areaTypes[type].label} toegevoegd (${formatNumber(Geo.area(area.pts))} m²)`);
    },
    /**
     * Nieuwe vorm voor een bestaand vlak ('Opnieuw tekenen'); naam, type en zone blijven.
     * @param {string} id id van het vlak
     * @param {Array<{x: number, y: number}>} points nieuwe hoekpunten in meters
     */
    replaceAreaPoints(id, points) {
      const area = this.state.areas.find((candidate) => candidate.id === id);
      if (!area) return;
      this.checkpoint();
      area.pts = points.map((point) => ({ x: +point.x.toFixed(3), y: +point.y.toFixed(3) }));
      this.editor.selection = { kind: 'area', id };
      this.areaShapeChanged(id);
      this.toast(`${area.name} opnieuw getekend (${formatNumber(Geo.area(area.pts))} m²)`);
    },
    /**
     * Na een vormwijziging buiten het slepen om (punt weg, opnieuw tekenen).
     * @param {string} id id van het vlak
     */
    areaShapeChanged(id) {
      this.invalidate();
      this._applyMethods(id);
      this.commit();
    },
    /**
     * Plaatst een systeemelement (of verplaatst het als er maar één van mag zijn).
     * @param {string} kind soort element
     * @param {{x: number, y: number}} world plek in meters
     */
    placeElement(kind, world) {
      const elementType = Catalog.elementTypes[kind];
      this.checkpoint();
      let element = elementType.single ? this.state.elements.find((candidate) => candidate.kind === kind) : null;
      if (element) { element.x = world.x; element.y = world.y; } else {
        element = { id: Geo.uid('e'), kind, x: world.x, y: world.y };
        this.state.elements.push(element);
      }
      this.editor.selection = { kind: 'element', id: element.id };
      this.commit();
      if (elementType.single) this.editor.setTool('select');
    },
    /**
     * Plaatst een sproeier; op een hoek of rand van een gazon krijgt hij de passende richting en sproeihoek.
     * @param {string} type sproeiertype
     * @param {{x: number, y: number}} world plek in meters
     * @param {{body: string, model: string}} opts zelf gekozen behuizing en nozzle
     */
    placeSprinkler(type, world, opts = {}) {
      const sprinklerType = Catalog.sprinklerTypes[type];
      this.checkpoint();
      const sprinkler = { id: Geo.uid('s'), type, x: world.x, y: world.y, r: this.state.settings.radius || sprinklerType.rDefault, start: 0, arc: 360, zone: null };
      // zelf gekozen behuizing en nozzle (Zelf een kop plaatsen): worp = volle worp van de nozzle
      if (opts.body && Catalog.bodies[opts.body]) sprinkler.body = opts.body;
      if (opts.model && Catalog.nozzles[opts.model]) {
        sprinkler.model = opts.model;
        sprinkler.r = Catalog.headRange(sprinkler).rMax;
      }
      if (type === 'strip') { sprinkler.r = 0; sprinkler.arc = 0; sprinkler.width = 1.5; sprinkler.len = 4.6; }
      const best = this._boundaryFit(world, Math.max(0.5, 10 / this.editor.view.scale));
      if (best) {
        sprinkler.x = best.pt.x; sprinkler.y = best.pt.y;
        sprinkler.start = Math.round(best.start);
        if (type !== 'strip') sprinkler.arc = Math.round(best.arc);
      }
      Catalog.fitHead(sprinkler);
      this.state.sprinklers.push(sprinkler);
      // een zelf gekozen nozzle met zijn volle worp laten staan; alleen hoek en richting volgen de plek
      if (!sprinkler.model) this.tuneHeads([sprinkler.id]);
      this.editor.selection = { kind: 'sprinkler', id: sprinkler.id };
      this.commit();
    },
    /**
     * Hoekpunt of rand van een gazon binnen een tolerantie van een punt: plek, beginrichting en sproeihoek.
     * @param {{x: number, y: number}} world het punt in meters
     * @param {number} tolerance maximale afstand in meters
     * @returns {{pt: object, start: number, arc: number}|null} plek, richting en sproeihoek, of null
     */
    _boundaryFit(world, tolerance) {
      for (const area of this.state.areas.filter((candidate) => candidate.type === 'lawn' && candidate.pts.length >= 3)) {
        const points = Geo.orientCW(area.pts);
        for (let i = 0; i < points.length; i++) {
          if (Geo.dist(points[i], world) < tolerance) {
            const prev = points[(i - 1 + points.length) % points.length], next = points[(i + 1) % points.length];
            const start = Geo.angleOf(Geo.sub(next, points[i]));
            const interior = Geo.normDeg(Geo.angleOf(Geo.sub(prev, points[i])) - start) || 360;
            return { pt: points[i], start, arc: interior };
          }
        }
        const closest = Geo.closestOnPolygon(world, points);
        if (closest.d < tolerance) {
          const edgeStart = points[closest.edge], edgeEnd = points[(closest.edge + 1) % points.length];
          return { pt: closest.pt, start: Geo.angleOf(Geo.sub(edgeEnd, edgeStart)), arc: 180 };
        }
      }
      return null;
    },
    /**
     * Na verslepen: sproeihoek volgt de nieuwe plek (hoek, rand of binnenin), daarna afstellen.
     * @param {string} id id van de sproeier
     */
    afterSprinklerMoved(id) {
      const sprinkler = this.state.sprinklers.find((candidate) => candidate.id === id);
      if (!sprinkler || sprinkler.type === 'strip') return;
      const best = this._boundaryFit(sprinkler, 0.05);
      if (best) { sprinkler.start = Math.round(best.start); sprinkler.arc = Math.round(best.arc); }
      else if (this.state.areas.some((area) => area.type === 'lawn' && area.pts.length >= 3 && Geo.pointInPolygon(sprinkler, area.pts))) sprinkler.arc = 360;
      Catalog.fitRotator(sprinkler);
      this.tuneHeads([id]);
    },
    /**
     * Koppen optimaal afstellen (worp, sproeihoek, richting en kop) op de neerslagsimulatie
     * van hun vlak. Positie blijft gelijk.
     * @param {string[]|null} ids alleen deze koppen (de rest telt mee maar blijft staan), of null voor alle
     * @returns {number} aantal aangepaste koppen
     */
    tuneHeads(ids = null) {
      const planState = this.state;
      let changed = 0;
      for (const area of planState.areas) {
        if (area.pts.length < 3) continue;
        const own = area.type === 'lawn'
          ? planState.sprinklers.filter((sprinkler) => !sprinkler.areaId && (Geo.pointInPolygon(sprinkler, area.pts) || Geo.closestOnPolygon(sprinkler, area.pts).d < 0.1))
          : planState.sprinklers.filter((sprinkler) => sprinkler.areaId === area.id);
        if (!own.length || (ids && !own.some((sprinkler) => ids.includes(sprinkler.id)))) continue;
        const result = window.Planner.tune(area.pts, own, ids, this._surroundings());
        for (const head of result.heads) {
          const sprinkler = planState.sprinklers.find((candidate) => candidate.id === head.id);
          if (!sprinkler || (ids && !ids.includes(sprinkler.id))) continue;
          if (sprinkler.r !== head.r || sprinkler.arc !== head.arc || sprinkler.start !== head.start) changed++;
          Object.assign(sprinkler, { r: head.r, arc: head.arc, start: head.start });
        }
      }
      return changed;
    },
    /** Verwijdert het geselecteerde vlak (met zijn sproeiers), de sproeier of het element. */
    deleteSelection() {
      const selection = this.editor.selection;
      if (!selection) return;
      this.editor.activeVertex = null;
      this.checkpoint();
      const planState = this.state;
      if (selection.kind === 'area') {
        planState.areas = planState.areas.filter((area) => area.id !== selection.id);
        planState.sprinklers = planState.sprinklers.filter((sprinkler) => sprinkler.areaId !== selection.id);
      }
      if (selection.kind === 'sprinkler') planState.sprinklers = planState.sprinklers.filter((sprinkler) => sprinkler.id !== selection.id);
      if (selection.kind === 'element') planState.elements = planState.elements.filter((element) => element.id !== selection.id);
      this.editor.selection = null;
      this._pruneZones();
      this.commit();
    },
    /**
     * Vlak opnieuw tekenen: tekengereedschap met dit vlak als doel; Annuleren laat het vlak staan.
     * @param {string} id id van het vlak
     */
    redrawArea(id) {
      const area = this.state.areas.find((candidate) => candidate.id === id);
      if (!area) return;
      this.editor.setTool('polygon', { areaType: area.type, redrawId: id });
      this.toast(`Teken ${area.name} opnieuw; sluit af op het eerste punt. Annuleren laat het vlak zoals het was.`);
    },
    /** Verwijdert zones zonder sproeiers of vlakken. */
    _pruneZones() {
      const planState = this.state;
      const used = new Set([...planState.sprinklers.map((sprinkler) => sprinkler.zone), ...planState.areas.map((area) => area.zone)].filter(Boolean));
      planState.zones = planState.zones.filter((zone) => used.has(zone.id));
    },

    /**
     * Plaatst automatisch sproeiers in de gazons (en in beplanting met sproeiers).
     * @param {string[]} [areaIds] alleen deze gazons (leeg = alle)
     */
    autoPlace(areaIds) {
      const planState = this.state;
      const lawns = planState.areas.filter((area) => area.type === 'lawn' && area.pts.length >= 3 && (!areaIds || areaIds.includes(area.id)));
      if (!lawns.length) { this.toast('Teken eerst een gazonvlak (stap 2).', true); return; }
      // rekenen duurt op een telefoon enkele seconden: eerst de melding tonen, dan rekenen
      this.busy(planState.settings.sprinklerType === 'auto' ? 'Sproeiers plaatsen en het beste type per gazon kiezen…' : 'Sproeiers plaatsen…');
      setTimeout(() => {
        try {
          this.checkpoint();
          const chosen = [];
          let count = this._placeSprinklers(lawns, planState.settings.sprinklerType, chosen);
          if (!areaIds) count += this._syncBedSprinklers(true);
          this.commit();
          const why = chosen.length ? ` Gekozen: ${chosen.map((choice) => `${choice.area} ${choice.label}`).join(', ')}.` : '';
          this.toast(`${count} sproeiers geplaatst.${why} Controleer de neerslagkaart.`);
        } finally {
          this.busy(null);
        }
      }, 30);
    },
    /**
     * Sproeiers in beplanting/hagen in lijn brengen met de gekozen methode:
     * plaatsen waar 'sproeiers' gekozen is (of opnieuw bij `force`), weghalen waar niet.
     * @param {boolean} force ook opnieuw plaatsen waar al sproeiers staan
     * @param {string|null} onlyArea alleen dit vlak (id), of null voor alle
     * @returns {number} aantal geplaatste sproeiers
     */
    _syncBedSprinklers(force = false, onlyArea = null) {
      const planState = this.state;
      let placed = 0;
      for (const area of planState.areas) {
        if (onlyArea && area.id !== onlyArea) continue;
        if (area.type === 'lawn' || area.pts.length < 3) continue;
        const want = Hydraulics.methodOf(planState, area) === 'sprinklers';
        const has = planState.sprinklers.some((sprinkler) => sprinkler.areaId === area.id);
        if (want && has && !force) continue;
        planState.sprinklers = planState.sprinklers.filter((sprinkler) => sprinkler.areaId !== area.id);
        if (!want) continue;
        const bedType = Catalog.usableType(planState.settings.bedSprinklerType || 'spray', ['spray', 'rotator']);
        const heads = window.Planner.autoPlace(area.pts, bedType, { body: this._bodyFor(`bed-${bedType}`), ...this._surroundings() });
        heads.forEach((head) => { head.areaId = area.id; });
        planState.sprinklers.push(...heads);
        placed += heads.length;
      }
      // bestaande indeling klopt niet meer als er sproeiers bij- of afkomen
      planState.sprinklers.forEach((sprinkler) => { if (sprinkler.areaId && !planState.zones.some((zone) => zone.id === sprinkler.zone)) sprinkler.zone = null; });
      this._pruneZones();
      return placed;
    },
    /**
     * Na wijzigen van een methode: sproeiers bijwerken en zones opnieuw indelen als die er al waren.
     * @param {string|null} onlyArea alleen dit vlak (id), of null voor alle
     */
    _applyMethods(onlyArea = null) {
      const hadZones = this.state.zones.length > 0;
      this._syncBedSprinklers(false, onlyArea);
      if (hadZones && Hydraulics.hasIrrigation(this.state)) Hydraulics.autoZones(this.state);
    },
    /**
     * Gekozen behuizing voor automatisch plaatsen (sleutel `rotator`, `bed-spray`, …), als die (nog) bestaat.
     * @param {string} key sproeiertype, voor beplanting met `bed-` ervoor
     * @returns {string|null} sleutel van de behuizing, of null
     */
    _bodyFor(key) {
      const bodyKey = (this.state.settings.bodies || {})[key];
      const type = key.replace(/^bed-/, '');
      return bodyKey && Catalog.bodies[bodyKey] && Catalog.bodiesFor(type).some((body) => body.key === bodyKey) ? bodyKey : null;
    },
    /**
     * Vlakken rondom voor de beoordeling van overspray: droog te houden (huis, terras) en mag nat.
     * @returns {{dry: Array, wet: Array}} hoekpunten van de droge en natte vlakken
     */
    _surroundings() {
      /**
       * Hoekpunten van alle vlakken van een type.
       * @param {string} type vlaktype
       * @returns {Array<Array<{x: number, y: number}>>} de hoekpunten per vlak
       */
      const areasOfType = (type) => this.state.areas.filter((candidate) => candidate.type === type && candidate.pts.length >= 3).map((candidate) => candidate.pts);
      return { dry: areasOfType('dry'), wet: areasOfType('wet') };
    },
    /**
     * Sproeiers op gazons plaatsen. Type `auto`: per gazon het beste type (rotators, sproeiers of
     * turbines, binnen het assortiment en de druk); `chosen` krijgt dan per gazon de keuze.
     * @param {object[]} lawns de gazons
     * @param {string} wanted sproeiertype of `auto`
     * @param {object[]} chosen lijst die per gazon de keuze krijgt (bij `auto`)
     * @returns {number} aantal geplaatste sproeiers
     */
    _placeSprinklers(lawns, wanted, chosen = []) {
      const planState = this.state;
      const auto = wanted === 'auto';
      const type = auto ? null : Catalog.usableType(wanted);
      const around = this._surroundings();
      let count = 0;
      for (const area of lawns) {
        // verwijder bestaande sproeiers binnen of op de rand van dit vlak
        planState.sprinklers = planState.sprinklers.filter((sprinkler) => sprinkler.areaId || !(Geo.pointInPolygon(sprinkler, area.pts) || Geo.closestOnPolygon(sprinkler, area.pts).d < 0.05));
        let heads;
        if (auto) {
          const types = ['rotator', 'spray', 'rotor'].filter((typeKey) => Catalog.typeAvailable(typeKey));
          const bodies = Object.fromEntries(types.map((typeKey) => [typeKey, this._bodyFor(typeKey)]));
          const result = window.Planner.bestPlace(area.pts, { types, bodies, pressure: planState.settings.pressure, ...around });
          heads = result.heads;
          if (result.type) chosen.push({ area: area.name || 'gazon', type: result.type, label: TYPE_PLURAL[result.type] || result.type });
        } else heads = window.Planner.autoPlace(area.pts, type, { r: planState.settings.radius || null, body: this._bodyFor(type), ...around });
        planState.sprinklers.push(...heads);
        count += heads.length;
      }
      this._pruneZones();
      planState.zones = [];
      planState.sprinklers.forEach((sprinkler) => { sprinkler.zone = null; });
      this.editor.layers.heatmap = true;
      $('#layer-heatmap').checked = true;
      return count;
    },
    /** Deelt de sproeiers en beplanting automatisch in zones in. */
    autoZones() {
      if (!Hydraulics.hasIrrigation(this.state)) {
        this.toast('Plaats eerst sproeiers of teken beplanting.', true);
        return;
      }
      this.checkpoint();
      Hydraulics.autoZones(this.state);
      this.commit();
      this.toast(`${this.state.zones.length} zones ingedeeld`);
    },

    /**
     * Kalibreert de schaal met een gemeten lijn: vraagt de werkelijke lengte en schaalt ondergrond (en eventueel het ontwerp).
     * @param {number} measured gemeten lengte in de huidige eenheid
     */
    calibrate(measured) {
      const real = parseFloat(String(prompt(`Gemeten lijn: ${measured.toFixed(2)} (huidige eenheid).\nWat is de werkelijke lengte in meters?`, '') || '').replace(',', '.'));
      this.editor.setTool('select');
      if (!real || real <= 0) return;
      const factor = real / measured;
      const planState = this.state;
      this.checkpoint();
      if (planState.background) {
        planState.background.scale *= factor;
        planState.background.x *= factor;
        planState.background.y *= factor;
      }
      const hasGeometry = planState.areas.length || planState.sprinklers.length || planState.elements.length;
      if (hasGeometry && confirm('Ook de reeds getekende vlakken en elementen meeschalen?')) {
        planState.areas.forEach((area) => { area.pts = area.pts.map((point) => ({ x: point.x * factor, y: point.y * factor })); });
        planState.elements.forEach((element) => { element.x *= factor; element.y *= factor; });
        planState.sprinklers.forEach((sprinkler) => { sprinkler.x *= factor; sprinkler.y *= factor; });
      }
      this.editor.view.scale /= factor;
      this.editor.view.x *= factor;
      this.editor.view.y *= factor;
      this.commit();
      this.toast(`Schaal ingesteld (factor ${factor.toFixed(3)})`);
    },

    /**
     * Laadt de afbeelding van de ondergrond (opnieuw) in de editor.
     * @returns {Promise<void>} klaar na laden
     */
    refreshBackground() {
      const background = this.state.background;
      if (!background || !background.dataUrl) { this.editor.bgImg = null; this.editor.render(); return Promise.resolve(); }
      return new Promise((resolve) => {
        const image = new Image();
        /** Toont de geladen ondergrond. */
        image.onload = () =>{  { this.editor.bgImg = image; this.editor.render(); resolve(); }; };
        /** Gaat door zonder ondergrond als het laden mislukt. */
        image.onerror = () => { resolve(); };
        image.src = background.dataUrl;
      });
    },
    /**
     * Laadt een plan (JPG/PNG/PDF) als ondergrond; met `concept` meteen automatisch herkennen.
     * @param {File} file het bestand
     * @param {{concept: boolean}} options meteen een concept maken
     * @returns {Promise<void>} klaar na laden
     */
    async loadBackground(file, { concept = false } = {}) {
      this.busy('Plan wordt geladen…');
      let loaded;
      try {
        loaded = await window.PlanImport.load(file);
      } catch (error) {
        this.busy(null);
        this.toast(`Kan plan niet laden: ${error.message}`, true);
        return;
      }
      const loadedBackground = loaded.background;
      // voorlopige schaal: plan ca. 30 m breed; daarna herkennen of kalibreren
      this.state.background = { dataUrl: loadedBackground.dataUrl, width: loadedBackground.width, height: loadedBackground.height, paper: loadedBackground.paper || null, x: 0, y: 0, scale: window.Concept.FALLBACK_WIDTH_M / loadedBackground.width, opacity: 0.6 };
      this._analyzeImage = loaded.analyze;
      this.lastRecognition = null;
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

    /**
     * Plan laten herkennen en er een volledig, bewerkbaar concept van maken.
     * @param {{fresh: boolean}} options met `fresh` opnieuw door de AI laten herkennen
     * @returns {Promise<void>} klaar na het concept of een melding
     */
    async makeConcept({ fresh = false } = {}) {
      const planState = this.state;
      if (!planState.background || !planState.background.dataUrl) { this.toast('Laad eerst een plan.', true); return; }
      if ((planState.areas.length || planState.sprinklers.length) && !confirm('Het huidige ontwerp wordt vervangen door een nieuw concept. Doorgaan?')) return;
      const useAi = this.aiStatus && this.aiStatus.available && planState.settings.recognizer === 'ai';
      let result;
      const extraWarnings = [];
      try {
        const analyzeImage = this._analyzeImage || await window.PlanImport.analyzeImageFrom(planState.background.dataUrl);
        if (!analyzeImage.paper && planState.background.paper) analyzeImage.paper = planState.background.paper;
        this._analyzeImage = analyzeImage;
        let raw = null;
        if (useAi) {
          this.busy('Plan wordt gelezen met AI: schaal, gazon, borders en bebouwing herkennen… Dit duurt meestal 1 à 2 minuten.');
          try {
            raw = await window.Concept.analyze(analyzeImage, { fresh });
            const recognition = raw.recognition;
            this.lastRecognition = recognition || null;
            if (recognition && recognition.cached) extraWarnings.push('Deze tekening is eerder met AI herkend: hetzelfde resultaat is opnieuw gebruikt (zonder kosten). Een nieuwe herkenning kan met "Opnieuw herkennen met AI" in stap 1.');
            // de lokale herkenning leert van deze uitkomst (alleen kleurtellingen naar de server)
            if (recognition && recognition.id && !recognition.learned) {
              const answer = raw;
              window.LocalRecognizer.learn(analyzeImage, answer)
                .then((samples) => samples && window.Concept.teach({ recognitionId: recognition.id, samples }))
                .catch(() => {});
            }
          } catch (error) {
            extraWarnings.push(`AI-herkenning niet gelukt (${error.message}); lokaal herkend.`);
          }
        }
        if (!raw) {
          this.busy('Plan wordt lokaal gelezen (zonder AI)…');
          const learned = ANON ? null : await window.Concept.learned();
          raw = await window.LocalRecognizer.analyze(analyzeImage, (msg) => this.busy(`Plan wordt lokaal gelezen: ${msg}`), { learned });
        }
        result = window.Concept.build(raw, analyzeImage);
        if (result.scaleInfo.estimated && result.gardenWidthPx) {
          // geen maat op het plan: liever de gebruiker vragen dan sproeiers op een verkeerde schaal plaatsen
          this.busy(null);
          const answer = prompt(`Er staat geen leesbare maat op het plan.\nHoe breed is de tuin ongeveer (de herkende vlakken, van links naar rechts) in meters?\n\nLeeg laten = aanname ${window.Concept.FALLBACK_GARDEN_M} m; kalibreren kan later altijd in stap 1.`, '');
          const widthM = parseFloat(String(answer || '').replace(',', '.'));
          if (widthM > 0 && widthM < 1000) result = window.Concept.build(raw, analyzeImage, { gardenWidthM: widthM });
        }
        result.warnings.unshift(...extraWarnings);
        result.local = Boolean(raw.local);
      } catch (error) {
        this.busy(null);
        this.toast(error.message, true);
        this.conceptWarnings = [error.message];
        this.renderWarnings();
        this.refreshAiStatus();
        return;
      }
      this.checkpoint();
      Object.assign(planState.background, { x: 0, y: 0, scale: result.backgroundScale });
      planState.areas = result.areas;
      planState.elements = result.elements;
      planState.sprinklers = [];
      planState.zones = [];
      this.editor.selection = null;
      const lawns = planState.areas.filter((area) => area.type === 'lawn');
      let count = lawns.length ? this._placeSprinklers(lawns, planState.settings.sprinklerType) : 0;
      count += this._syncBedSprinklers(true);
      if (Hydraulics.hasIrrigation(planState)) Hydraulics.autoZones(planState);
      this.conceptWarnings = result.warnings;
      this.busy(null);
      this.commit();
      this.editor.fit();
      this.showStep(3);
      const scaleInfo = result.scaleInfo;
      const scaleText = scaleInfo.estimated ? 'schaal niet gevonden' : `schaal via ${scaleInfo.method}${scaleInfo.confidence ? ` (${scaleInfo.confidence})` : ''}`;
      this.toast(`Concept gemaakt${result.local ? ' (lokaal)' : ' (AI)'}: ${planState.areas.length} vlakken, ${count} sproeiers, ${planState.zones.length} zones; ${scaleText}. Pas aan waar nodig.`);
      this.refreshAiStatus();
    },

    /**
     * Haalt op of AI-herkenning beschikbaar is en ververst stap 1.
     * @returns {Promise<void>} klaar na ophalen
     */
    async refreshAiStatus() {
      this.aiStatus = ANON ? { available: false } : await window.Concept.status();
      if (STEPS[this.step].id === 'project') this.renderStepPanel();
    },

    /**
     * Toverstaf: vlak met dezelfde kleur rond het aangeklikte punt uittrekken.
     * @param {{x: number, y: number}} world aangeklikt punt in meters
     * @param {string} areaType vlaktype van het nieuwe vlak
     */
    wandAt(world, areaType) {
      const background = this.state.background;
      if (!background || !this.editor.bgImg) { this.toast('De toverstaf werkt op een geladen plan (stap 1).', true); return; }
      const imageX = (world.x - background.x) / background.scale, imageY = (world.y - background.y) / background.scale;
      const traced = window.AutoTrace.wand(this.editor.bgImg, imageX, imageY, this.state.settings.wandTol || 40);
      if (traced.error) { this.toast(traced.error, true); return; }
      const points = traced.points.map((point) => ({ x: background.x + point.x * background.scale, y: background.y + point.y * background.scale }));
      this.addArea(areaType, points);
    },

    /**
     * Toont of verbergt de melding dat de planner bezig is.
     * @param {string|null} text de melding, of null om te verbergen
     */
    busy(text) {
      const busyBox = $('#busy');
      if (!busyBox) return;
      busyBox.classList.toggle('open', Boolean(text));
      if (text) $('#busy-text').textContent = text;
    },

    // ---------- Bestanden ----------
    /**
     * Biedt een bestand aan als download.
     * @param {Blob} blob de inhoud
     * @param {string} filename bestandsnaam
     */
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    /** Bewaart het project als bestand (.aquaplan.json). */
    saveProject() {
      const data = this._serverData();
      const name = (this.state.meta.name || 'beregeningsplan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'beregeningsplan';
      this.download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${name}.aquaplan.json`);
    },
    /**
     * Opent een projectbestand als nieuw plan.
     * @param {File} file het bestand
     */
    openProject(file) {
      const reader = new FileReader();
      /** Neemt het gelezen projectbestand over als nieuw plan. */
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || !Array.isArray(data.areas)) throw new Error('Ongeldig bestand');
          this.checkpoint();
          this._apply(data);
          // Een geopend bestand wordt een nieuw plan in Mijn plannen.
          this.state.serverId = null;
          this.editor.selection = null;
          this.refreshBackground().then(() => this.editor.fit());
          this.commit();
          this.toast('Project geopend');
        } catch (error) {
          this.toast(`Kan bestand niet openen: ${error.message}`, true);
        }
      };
      reader.readAsText(file);
    },
    /** Start een nieuw, leeg project (met een vraag als er iets verloren kan gaan). */
    newProject() {
      // Alleen vragen als er echt iets verloren kan gaan: een leeg plan of een
      // plan dat al in Mijn plannen staat (en terug te halen is) niet.
      const planState = this.state;
      const content = planState.areas.length || planState.elements.length || planState.sprinklers.length || planState.background;
      const saved = planState.serverId && !this._syncPending && !this._syncing;
      if (content && !saved && !confirm('Nieuw project starten? Niet-opgeslagen wijzigingen gaan verloren.')) return;
      this.checkpoint();
      this.state = emptyState();
      this.review = null;
      this._renderReview();
      this.conceptWarnings = [];
      this._analyzeImage = null;
      this.lastRecognition = null;
      this.editor.selection = null;
      this.editor.bgImg = null;
      this.editor.heat = null;
      this.showStep(0);
      this.commit();
      this.editor.fit();
    },
    /**
     * Exporteert stuklijst, zones en tekening naar Excel.
     * @returns {Promise<void>} klaar na downloaden of melding
     */
    async exportExcel() {
      const button = $('#btn-export-xlsx');
      try {
        if (button) { button.disabled = true; button.textContent = 'Bezig…'; }
        if (!this.state.zones.length) Hydraulics.autoZones(this.state);
        Hydraulics.calculate(this.state);
        const png = this.editor.exportPng(1500, 1000);
        const { blob, filename } = await BOM.exportXlsx(this.state, png);
        this.download(blob, filename);
        this.commit();
        this.toast('Excel-bestand gedownload');
      } catch (error) {
        console.error(error);
        this.toast(`Export mislukt: ${error.message}`, true);
      } finally {
        if (button) { button.disabled = false; button.textContent = 'Exporteer naar Excel'; }
      }
    },
    /** Exporteert de tekening als PNG. */
    exportPlanPng() {
      const url = this.editor.exportPng(2400, 1600);
      fetch(url).then((response) => response.blob()).then((blob) => this.download(blob, 'beregeningsplan.png'));
    },

    // ---------- UI ----------
    /** Koppelt de knoppen, lagen, legenda en tekenbalk van de planner. */
    _bindGlobal() {
      /** Start een nieuw project. */
      $('#btn-new').onclick = () => { this.newProject(); };
      /** Opent de bestandskeuze voor een projectbestand. */
      $('#btn-open').onclick = () => { $('#file-open').click(); };
      /**
       * Opent het gekozen projectbestand.
       * @param {Event} event de gebeurtenis
       */
      $('#file-open').onchange = (event) =>{  { if (event.target.files[0]) this.openProject(event.target.files[0]); event.target.value = ''; }; };
      /** Bewaart het project als bestand. */
      $('#btn-save').onclick = () => { this.saveProject(); };
      /** Toont Mijn plannen. */
      $('#btn-myplans').onclick = () => { this.showMyPlans(); };
      /** Sluit Mijn plannen. */
      $('#myplans-close').onclick = () => { $('#myplans').classList.remove('open'); };
      /** Sluit Mijn plannen en start een nieuw project. */
      $('#myplans-new').onclick = () =>{  { $('#myplans').classList.remove('open'); this.newProject(); }; };
      /** Maakt de laatste wijziging ongedaan. */
      $('#btn-undo').onclick = () => { this.undo(); };
      /** Voert de wijziging opnieuw uit. */
      $('#btn-redo').onclick = () => { this.redo(); };
      /** Toont of verbergt de hulp. */
      $('#btn-help').onclick = () => { $('#help').classList.toggle('open'); };
      /** Sluit de hulp. */
      $('#help-close').onclick = () => { $('#help').classList.remove('open'); };
      /** Kiest het selectiegereedschap. */
      $('#tool-select').onclick = () => { this.editor.setTool('select'); };
      /** Schakelt verschuiven aan of uit. */
      $('#tool-pan').onclick = () => { this.editor.togglePan(); };
      /** Kiest het meetgereedschap. */
      $('#tool-measure').onclick = () => { this.editor.setTool('measure'); };
      /** Zoomt zodat het hele plan in beeld is. */
      $('#tool-fit').onclick = () => { this.editor.fit(); };
      /** Zoomt in. */
      $('#tool-zoomin').onclick = () => { this.editor.zoomAt(this.editor.w / 2, this.editor.h / 2, 1.25); };
      /** Zoomt uit. */
      $('#tool-zoomout').onclick = () => { this.editor.zoomAt(this.editor.w / 2, this.editor.h / 2, 0.8); };
      /** Gaat naar de vorige stap. */
      $('#btn-prev').onclick = () => { this.showStep(this.step - 1); };
      /** Gaat naar de volgende stap. */
      $('#btn-next').onclick = () => { this.showStep(this.step + 1); };
      for (const key of ['background', 'coverage', 'heatmap', 'pipes', 'labels']) {
        const checkbox = $(`#layer-${key}`);
        checkbox.checked = this.editor.layers[key];
        /** Zet de laag aan of uit. */
        checkbox.onchange = () => {
          this.editor.layers[key] = checkbox.checked;
          if (key === 'heatmap' && checkbox.checked) this.updateHeat();
          this.renderStepPanel();
          this.editor.render();
        };
      }
      $('#snap').checked = this.editor.snap;
      /**
       * Zet uitlijnen op het raster aan of uit.
       * @param {Event} event de gebeurtenis
       */
      $('#snap').onchange = (event) =>{  { this.editor.snap = event.target.checked; }; };
      // Legenda over de tekening: open/dicht onthouden per browser (op een
      // smal scherm standaard dicht, daar is de tekening klein)
      const legend = $('#plan-legend');
      if (legend) {
        let open = null;
        try { open = localStorage.getItem(LEGEND_KEY); } catch (error) { /* geen opslag */ }
        legend.open = open != null ? open === '1' : !window.matchMedia('(max-width: 760px)').matches;
        /** Onthoudt of de legenda open is. */
        legend.ontoggle = () =>{  { try { localStorage.setItem(LEGEND_KEY, legend.open ? '1' : '0'); } catch (error) { /* geen opslag */ } }; };
      }
      // Tekenbalk (touch heeft geen Enter/Backspace/Esc)
      document.querySelectorAll('#drawbar [data-db]').forEach((button) => {
        /** Voert de knop van de tekenbalk uit. */
        button.onclick = () => {
          if (button.dataset.db === 'undo') this.editor.undoPoint();
          else if (button.dataset.db === 'pan') this.editor.togglePan();
          else if (button.dataset.db === 'finish') this.editor.finishPolygon();
          else this.editor.cancelDraw();
        };
      });
      // Mobiel: projectmenu (hamburger) en uitklapmenu voor raster en lagen
      /** Opent of sluit het projectmenu. */
      $('#btn-menu').onclick = () => { this._setMenu(!document.body.classList.contains('menu-open')); };
      /** Sluit het projectmenu. */
      $('#menu-close').onclick = () => { this._setMenu(false); };
      /** Sluit het projectmenu. */
      $('#menu-backdrop').onclick = () => { this._setMenu(false); };
      $('#menu').addEventListener('click', (event) => { if (event.target.closest('button')) this._setMenu(false); });
      /**
       * Opent of sluit het menu met raster en lagen.
       * @param {Event} event de gebeurtenis
       */
      $('#btn-layers').onclick = (event) =>{  { event.stopPropagation(); this._setLayers(!document.body.classList.contains('layers-open')); }; };
      document.addEventListener('pointerdown', (event) => {
        if (document.body.classList.contains('layers-open') && !event.target.closest('#view-opts, #btn-layers')) this._setLayers(false);
      });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { this._setMenu(false); this._setLayers(false); }
      });
      /** Klapt het stappenpaneel in of uit. */
      $('#btn-sheet').onclick = () => { this._setSheet(document.body.classList.contains('sheet-collapsed')); };
      /** Sluit het eigenschappenpaneel (selectie opheffen). */
      $('#props-close').onclick = () =>{  { this.editor.selection = null; this.onSelectionChanged(); this.renderStepPanel(); this.editor.render(); }; };
    },

    /**
     * Mobiel: projectmenu (lade van rechts) openen of sluiten.
     * @param {boolean} open true = openen
     */
    _setMenu(open) {
      document.body.classList.toggle('menu-open', open);
      $('#btn-menu').setAttribute('aria-expanded', String(open));
    },
    /**
     * Mobiel: uitklapmenu met raster en lagen openen of sluiten.
     * @param {boolean} open true = openen
     */
    _setLayers(open) {
      document.body.classList.toggle('layers-open', open);
      $('#btn-layers').setAttribute('aria-expanded', String(open));
    },

    /**
     * Mobiel: stappenpaneel in- of uitklappen voor meer tekenruimte.
     * @param {boolean} open true = uitklappen
     */
    _setSheet(open) {
      document.body.classList.toggle('sheet-collapsed', !open);
      const button = $('#btn-sheet');
      button.textContent = open ? '▾ Paneel' : '▴ Paneel';
      button.setAttribute('aria-expanded', String(open));
    },
    /**
     * Is het scherm smal (mobiele weergave)?
     * @returns {boolean} true op een smal scherm
     */
    _isMobile() { return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); },

    /** Legenda over het canvas; alleen opnieuw opbouwen als de inhoud wijzigt. */
    updateLegend() {
      const body = $('#plan-legend-body');
      if (!body || !this.editor) return;
      const sections = this.editor.legend();
      const key = JSON.stringify(sections);
      if (key === this._legendKey) return;
      this._legendKey = key;
      body.innerHTML = sections.map((section) => `
        <div class="lg-sec">
          <div class="lg-title">${escapeHtml(section.title)}</div>
          ${section.items.map((item, i) => `<div class="lg-item"><canvas class="lg-sw" data-i="${i}" width="26" height="16"></canvas><span class="lg-lbl">${escapeHtml(item.label)}</span>${item.sub ? `<span class="lg-sub">${escapeHtml(item.sub)}</span>` : ''}</div>`).join('')}
        </div>`).join('');
      const dpr = window.devicePixelRatio || 1;
      body.querySelectorAll('.lg-sec').forEach((sectionElement, sectionIndex) => {
        sectionElement.querySelectorAll('canvas.lg-sw').forEach((canvas) => {
          canvas.width = 26 * dpr; canvas.height = 16 * dpr;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          this.editor._legendSwatch(ctx, sections[sectionIndex].items[+canvas.dataset.i], 0, 0, 26, 16);
        });
      });
    },

    /** Toont de tekenbalk zolang er een teken- of plaatsgereedschap actief is. */
    updateDrawBar() {
      const bar = $('#drawbar');
      if (!bar || !this.editor) return;
      const editor = this.editor;
      const tool = editor.tool;
      const show = tool !== 'select' && tool !== 'pan' && (editor.touch || tool === 'polygon');
      bar.hidden = !show;
      if (!show) return;
      const pointCount = editor.draft ? editor.draft.length : 0;
      bar.querySelector('[data-db="undo"]').hidden = tool !== 'polygon';
      bar.querySelector('[data-db="undo"]').disabled = !pointCount;
      bar.querySelector('[data-db="finish"]').hidden = tool !== 'polygon';
      bar.querySelector('[data-db="finish"]').disabled = pointCount < 3;
      const pan = bar.querySelector('[data-db="pan"]');
      pan.classList.toggle('active', !!editor.panHold);
      pan.setAttribute('aria-pressed', editor.panHold ? 'true' : 'false');
      bar.querySelector('[data-db="cancel"] span').textContent = pointCount ? 'Annuleren' : 'Stoppen';
      const options = editor.toolOpts || {};
      const name = options.areaType ? Catalog.areaTypes[options.areaType].label : options.kind ? Catalog.elementTypes[options.kind].label : options.type ? Catalog.sprinklerTypes[options.type].label : '';
      $('#drawbar-label').textContent = editor.panHold ? 'Schuiven: sleep het plan, tik ✋ om verder te tekenen'
        : tool === 'polygon' ? `${options.redrawId ? 'Opnieuw tekenen' : name}: ${pointCount} punt${pointCount === 1 ? '' : 'en'}` : name;
    },

    /** Toont de knoppen van de stappen. */
    renderSteps() {
      $('#steps').innerHTML = STEPS.map((stepInfo, i) => `<button class="step" data-i="${i}"><span class="num">${i + 1}</span><span>${escapeHtml(stepInfo.title)}</span></button>`).join('');
      $('#steps').querySelectorAll('.step').forEach((button) => {
        /** Gaat naar de gekozen stap. */
        button.onclick = () => { this.showStep(+button.dataset.i); };
      });
    },
    /**
     * Gaat naar een stap: knoppen, gereedschap, zones (bij stap 5) en paneel bijwerken.
     * @param {number} index nummer van de stap (vanaf 0)
     */
    showStep(index) {
      this.step = Math.max(0, Math.min(STEPS.length - 1, index));
      document.querySelectorAll('#steps .step').forEach((button, position) => {
        button.classList.toggle('active', position === this.step);
        button.classList.toggle('done', position < this.step);
      });
      $('#btn-prev').disabled = this.step === 0;
      $('#btn-next').disabled = this.step === STEPS.length - 1;
      if (this.editor.tool !== 'select') this.editor.setTool('select');
      // passende lagen per stap
      if (STEPS[this.step].id === 'zones' && !this.state.zones.length && Hydraulics.hasIrrigation(this.state)) {
        Hydraulics.autoZones(this.state);
        this.recalc();
      }
      this.renderStepPanel();
      this._save();
      this.editor.render();
    },

    /** Bouwt het paneel van de huidige stap op en koppelt de knoppen. */
    renderStepPanel() {
      const id = STEPS[this.step].id;
      const panel = $('#step-panel');
      panel.innerHTML = `<h2>${this.step + 1}. ${escapeHtml(STEPS[this.step].title)}</h2>` + this[`_panel_${id}`]();
      const bind = this[`_bind_${id}`];
      if (bind) bind.call(this, panel);
    },

    // --- Stap 1
    /**
     * Paneel van stap 1: project, beregeningsmethode, plan laden en schaal.
     * @returns {string} HTML van het paneel
     */
    _panel_project() {
      const meta = this.state.meta;
      const background = this.state.background;
      const ai = this.aiStatus ? { ...this.aiStatus, checked: true } : { available: false, checked: false };
      const settings = this.state.settings;
      return `
        <label>Projectnaam<input id="m-name" value="${escapeHtml(meta.name)}"></label>
        <label>Klant<input id="m-customer" value="${escapeHtml(meta.customer)}"></label>
        <label>Adres<input id="m-address" value="${escapeHtml(meta.address)}"></label>
        <h3>Beregeningsmethode</h3>
        <p class="hint small">Kies per soort vlak hoe het water krijgt. Per vlak kun je hier later van afwijken (eigenschappenpaneel).</p>
        <label>Gazon<select id="mth-lawn"><option value="auto" ${settings.sprinklerType === 'auto' ? 'selected' : ''}>Automatisch: beste type per gazon</option>${['rotator', 'spray', 'rotor'].map((typeKey) => `<option value="${escapeHtml(typeKey)}" ${settings.sprinklerType === typeKey ? 'selected' : ''}${Catalog.typeAvailable(typeKey) ? '' : ' disabled'}>${escapeHtml(Catalog.sprinklerTypes[typeKey].label)}${Catalog.typeAvailable(typeKey) ? '' : ' (niet in assortiment)'}</option>`).join('')}</select></label>
        ${['bed', 'hedge', 'planter'].map((type) => {
          const areaType = Catalog.areaTypes[type];
          const current = (settings.methods && settings.methods[type]) || areaType.defaultMethod;
          return `<label>${escapeHtml(areaType.label)}<select data-mth="${type}">${areaType.methods.map((methodKey) => `<option value="${escapeHtml(methodKey)}" ${current === methodKey ? 'selected' : ''}>${escapeHtml(Catalog.methods[methodKey].label)}</option>`).join('')}</select></label>`;
        }).join('')}
        <h3>Plan</h3>
        <p class="hint">Laad een tuinontwerp, plattegrond, schets of luchtfoto (JPG, PNG of PDF). De planner leest de schaal en de vlakken en maakt een concept met sproeiers, zones en leidingen dat je daarna aanpast.</p>
        ${ai.available ? `<label>Herkennen met<select id="recognizer">
            <option value="local" ${settings.recognizer !== 'ai' ? 'selected' : ''}>Lokaal (zonder AI, gratis)</option>
            <option value="ai" ${settings.recognizer === 'ai' ? 'selected' : ''}>AI (nauwkeuriger, API-tegoed; nog ${ai.remainingToday} vandaag)</option>
          </select></label>` : ''}
        <button id="plan-concept" class="btn primary">Plan laden en concept maken…</button>
        ${background ? '<button id="bg-concept" class="btn">Concept maken van deze ondergrond</button>' : ''}
        ${background && ai.available && settings.recognizer === 'ai' && this.lastRecognition && this.lastRecognition.cached
          ? '<button id="bg-fresh" class="btn">Opnieuw herkennen met AI</button><p class="hint small">Dezelfde tekening geeft altijd hetzelfde AI-resultaat. Alleen als dat niet goed is: opnieuw laten herkennen (kost API-tegoed); de nieuwe uitkomst geldt daarna.</p>'
          : ''}
        <p class="hint small">${settings.recognizer === 'ai' && ai.available
          ? 'De AI leest ook lijntekeningen en schetsen.'
          : 'Lokaal herkennen werkt het best op <b>gekleurde</b> tuinontwerpen: groen = gazon, donkergroen = haag, bruin/roze = beplanting, grijs/beige = bebouwing en verharding, blauw = water. De schaal wordt gelezen uit een maat met maatlijn (bijv. "12,00 m" of "1250").'}</p>
        <button id="bg-load" class="btn">${background ? 'Ander plan als ondergrond laden…' : 'Alleen als ondergrond laden…'}</button>
        <input type="file" id="bg-file" accept="image/*,application/pdf,.pdf" hidden>
        ${background ? `
          <h3>Schaal</h3>
          <p class="hint small">Huidige schaal: plan is ${formatNumber((background.width || (this.editor.bgImg && this.editor.bgImg.naturalWidth) || 0) * background.scale)} m breed.</p>
          <button id="bg-cal" class="btn">Schaal kalibreren</button>
          <p class="hint">Trek een lijn over een bekende maat (bijv. gevel of tegelpad) en voer de lengte in.</p>
          <label>Transparantie <input id="bg-op" type="range" min="0.1" max="1" step="0.05" value="${escapeHtml(background.opacity)}"></label>
          <button id="bg-del" class="btn danger">Ondergrond verwijderen</button>` : ''}
      `;
    },
    /**
     * Koppelt de velden en knoppen van stap 1.
     * @param {HTMLElement} panel het paneel
     */
    _bind_project(panel) {
      const meta = this.state.meta;
      ['name', 'customer', 'address'].forEach((field) => {
        /**
         * Bewaart het gewijzigde projectveld.
         * @param {Event} event de gebeurtenis
         */
        $(`#m-${field}`, panel).oninput = (event) =>{  { meta[field] = event.target.value; this._save(); if (field === 'name') $('#project-title').textContent = meta.name; }; };
      });
      $('#project-title').textContent = meta.name;
      if ($('#recognizer', panel)) {
        /**
         * Kiest lokale of AI-herkenning.
         * @param {Event} event de gebeurtenis
         */
        $('#recognizer', panel).onchange = (event) =>{  { this.state.settings.recognizer = event.target.value; this._save(); this.renderStepPanel(); }; };
      }
      /**
       * Kiest het sproeiertype voor gazons.
       * @param {Event} event de gebeurtenis
       */
      $('#mth-lawn', panel).onchange = (event) =>{  { this.state.settings.sprinklerType = event.target.value; this.state.settings.radius = null; this._save(); }; };
      panel.querySelectorAll('[data-mth]').forEach((select) => {
        /** Kiest de beregeningsmethode voor dit vlaktype. */
        select.onchange = () => {
          this.checkpoint();
          this.state.settings.methods = { ...(this.state.settings.methods || {}), [select.dataset.mth]: select.value };
          this._applyMethods();
          this.commit();
          this.toast(`${Catalog.areaTypes[select.dataset.mth].label}: ${Catalog.methods[select.value].label}`);
        };
      });
      let concept = false;
      /** Kiest een plan om alleen als ondergrond te laden. */
      $('#bg-load', panel).onclick = () =>{  { concept = false; $('#bg-file', panel).click(); }; };
      if ($('#plan-concept', panel)) {
        /** Kiest een plan om te laden en er een concept van te maken. */
        $('#plan-concept', panel).onclick = () =>{  { concept = true; $('#bg-file', panel).click(); }; };
      }
      if ($('#bg-concept', panel)) {
        /** Maakt een concept van de geladen ondergrond. */
        $('#bg-concept', panel).onclick = () => { this.makeConcept(); };
      }
      if ($('#bg-fresh', panel)) {
        /** Laat de ondergrond opnieuw door de AI herkennen. */
        $('#bg-fresh', panel).onclick = () => { this.makeConcept({ fresh: true }); };
      }
      /**
       * Laadt het gekozen plan.
       * @param {Event} event de gebeurtenis
       */
      $('#bg-file', panel).onchange = (event) =>{  { const file = event.target.files[0]; event.target.value = ''; if (file) this.loadBackground(file, { concept }); }; };
      if ($('#bg-cal', panel)) {
        /** Start het kalibreren van de schaal. */
        $('#bg-cal', panel).onclick = () =>{  { this.editor.setTool('calibrate'); this.toast('Trek een lijn over een bekende maat.'); }; };
        /**
         * Past de transparantie van de ondergrond aan.
         * @param {Event} event de gebeurtenis
         */
        $('#bg-op', panel).oninput = (event) =>{  { this.state.background.opacity = +event.target.value; this.editor.render(); }; };
        /** Bewaart de transparantie. */
        $('#bg-op', panel).onchange = () => { this._save(); };
        /** Verwijdert de ondergrond. */
        $('#bg-del', panel).onclick = () =>{  { this.state.background = null; this.editor.bgImg = null; this._save(); this.renderStepPanel(); this.editor.render(); }; };
      }
    },

    // --- Stap 2
    /**
     * Paneel van stap 2: tekengereedschap per vlaktype en de lijst met vlakken.
     * @returns {string} HTML van het paneel
     */
    _panel_areas() {
      const rows = this.state.areas.map((area) => `
        <tr data-id="${area.id}" class="${this.editor.selection && this.editor.selection.id === area.id ? 'sel' : ''}">
          <td><span class="swatch" style="background:${Catalog.areaTypes[area.type].stroke}"></span>${escapeHtml(area.name)}</td>
          <td class="num">${formatNumber(Geo.area(area.pts))} m²</td>
        </tr>`).join('');
      const btns = Object.entries(Catalog.areaTypes).map(([typeKey, areaType]) => `
        <div class="area-tool">
          <span class="swatch" style="background:${areaType.stroke}"></span><span class="lbl">${escapeHtml(areaType.label)}</span>
          ${this.state.background ? `<button class="btn sm" data-tool="wand" data-type="${typeKey}" title="Klik in het plan om het vlak automatisch uit te trekken">Toverstaf</button>` : ''}
          <button class="btn sm" data-tool="polygon" data-type="${typeKey}" title="Vrije vorm">Vrije vorm</button>
          <button class="btn sm" data-tool="rect" data-type="${typeKey}" title="Rechthoek">Rechthoek</button>
        </div>`).join('');
      return `
        <p class="hint">Teken eerst het gazon, daarna beplanting en hagen (druppelirrigatie) en vlakken die nat mogen worden of droog moeten blijven.</p>
        ${btns}
        ${this.state.background ? `<label>Gevoeligheid toverstaf <input id="wand-tol" type="range" min="10" max="120" step="5" value="${escapeHtml(this.state.settings.wandTol || 40)}"></label>
        <p class="hint small"><b>Toverstaf:</b> klik midden in een vlak op het plan; de planner trekt de rand met dezelfde kleur uit. Te veel? Verlaag de gevoeligheid. Te weinig? Verhoog hem.</p>` : ''}
        <p class="hint small"><b>Vrije vorm:</b> klik punten, sluit door op het eerste punt te klikken, dubbel te klikken of Enter. Backspace = laatste punt weg, Shift = hoeken van 45°, Alt = niet op het raster uitlijnen.<br>
        <b>Bewerken:</b> selecteer een vlak; sleep hoekpunten of de middenpunten van randen (nieuw hoekpunt).</p>
        <h3>Vlakken</h3>
        ${rows ? `<table class="list">${rows}</table>` : '<p class="hint">Nog geen vlakken.</p>'}
      `;
    },
    /**
     * Koppelt de knoppen en de vlakkenlijst van stap 2.
     * @param {HTMLElement} panel het paneel
     */
    _bind_areas(panel) {
      if ($('#wand-tol', panel)) {
        /**
         * Bewaart de gevoeligheid van de toverstaf.
         * @param {Event} event de gebeurtenis
         */
        $('#wand-tol', panel).onchange = (event) =>{  { this.state.settings.wandTol = +event.target.value; this._save(); }; };
      }
      panel.querySelectorAll('[data-tool]').forEach((button) => {
        /** Kiest het tekengereedschap voor dit vlaktype. */
        button.onclick = () => { this.editor.setTool(button.dataset.tool, { areaType: button.dataset.type }); };
      });
      panel.querySelectorAll('tr[data-id]').forEach((row) => {
        /** Selecteert het vlak uit de lijst. */
        row.onclick = () =>{  { this.editor.selection = { kind: 'area', id: row.dataset.id }; this.onSelectionChanged(); this.renderStepPanel(); this.editor.render(); }; };
      });
    },

    // --- Stap 3
    /**
     * Paneel van stap 3: systeemelementen en de wateraansluiting.
     * @returns {string} HTML van het paneel
     */
    _panel_system() {
      const settings = this.state.settings;
      const btns = Object.entries(Catalog.elementTypes).map(([kind, elementType]) => {
        const placed = this.state.elements.filter((element) => element.kind === kind).length;
        return `<button class="btn elem" data-kind="${kind}"><span class="badge" style="background:${elementType.color}">${elementType.short}</span>${escapeHtml(elementType.label)}${placed ? ` <span class="ok">✓${placed > 1 ? ' ' + placed : ''}</span>` : ''}</button>`;
      }).join('');
      return `
        <p class="hint">Plaats de wateraansluiting, de beregeningscomputer en de ventielkast. Waterpunten (tappunten) worden op de hoofdleiding aangesloten.</p>
        ${btns}
        <h3>Wateraansluiting</h3>
        <label>Dynamische waterdruk (bar)<input id="s-pressure" type="number" step="0.1" min="1" max="10" value="${escapeHtml(settings.pressure)}"></label>
        <label>Beschikbaar debiet (m³/u)<input id="s-flow" type="number" step="0.1" min="0.3" max="20" value="${escapeHtml(settings.flow)}"></label>
        <p class="hint small"><b>Emmertest:</b> vul een emmer van 10 liter bij volledig geopende kraan en meet de tijd t (s). Debiet = 36 / t m³/u (bijv. 18 s → 2,0 m³/u). Meet de druk met een manometer terwijl de kraan open staat.</p>
        <p class="hint small">Max. debiet per zone: <b>${formatNumber(Hydraulics.maxZoneLph(this.state) / 1000, 2)} m³/u</b> (${Math.round(Catalog.hydraulics.zoneFlowFactor * 100)}% van het beschikbare debiet).</p>
      `;
    },
    /**
     * Koppelt de knoppen en velden van stap 3.
     * @param {HTMLElement} panel het paneel
     */
    _bind_system(panel) {
      panel.querySelectorAll('[data-kind]').forEach((button) => {
        /** Kiest het gereedschap om dit element te plaatsen. */
        button.onclick = () => { this.editor.setTool('element', { kind: button.dataset.kind }); };
      });
      /**
       * Past de waterdruk aan.
       * @param {Event} event de gebeurtenis
       */
      $('#s-pressure', panel).onchange = (event) =>{  { this.checkpoint(); this.state.settings.pressure = +event.target.value || 3.5; this.commit(); }; };
      /**
       * Past het beschikbare debiet aan.
       * @param {Event} event de gebeurtenis
       */
      $('#s-flow', panel).onchange = (event) =>{  { this.checkpoint(); this.state.settings.flow = +event.target.value || 2; this.commit(); }; };
    },

    // --- Stap 4
    /**
     * Paneel van stap 4: sproeiertype, behuizingen, plaatsen en de neerslagsimulatie.
     * @returns {string} HTML van het paneel
     */
    _panel_sprinklers() {
      const settings = this.state.settings;
      const auto = settings.sprinklerType === 'auto';
      const types = `<label class="radio"><input type="radio" name="stype" value="auto" ${auto ? 'checked' : ''}>
          <span><b>Automatisch: beste type per gazon</b><br><span class="small">Rekent rotators, sproeiers en turbines door en kiest per gazon de indeling met de minste koppen, het minste water buiten het gazon en de minste droge/gele plekken, binnen je assortiment en de waterdruk.</span></span></label>` + ['rotator', 'spray', 'rotor'].map((typeKey) => {
        const sprinklerType = Catalog.sprinklerTypes[typeKey];
        const ok = Catalog.typeAvailable(typeKey);
        return `<label class="radio${ok ? '' : ' off'}"><input type="radio" name="stype" value="${escapeHtml(typeKey)}" ${!auto && Catalog.usableType(settings.sprinklerType) === typeKey ? 'checked' : ''}${ok ? '' : ' disabled'}>
          <span><b>${escapeHtml(sprinklerType.label)}</b>${ok ? '' : ' <span class="small">(niet in je assortiment)</span>'}<br><span class="small">${Geo.nlShort(sprinklerType.rMin, 1)}–${Geo.nlShort(sprinklerType.rMax, 1)} m · ${sprinklerType.pr} mm/u · min. ${Geo.nlShort(sprinklerType.minBar, 1)} bar. ${escapeHtml(sprinklerType.note)}</span></span></label>`;
      }).join('');
      const sim = this.editor.layers.heatmap ? this.sim : null;
      const stats = sim && sim.stats;
      const counts = {};
      this.state.sprinklers.forEach((sprinkler) => { counts[sprinkler.type] = (counts[sprinkler.type] || 0) + 1; });
      const countTxt = Object.entries(counts).map(([typeKey, count]) => `${count}× ${Catalog.sprinklerTypes[typeKey].short}`).join(', ') || 'geen';
      return `
        <h3>Sproeiertype</h3>
        ${types}
        ${auto
          ? ['rotator', 'spray', 'rotor'].filter((typeKey) => Catalog.typeAvailable(typeKey)).map((typeKey) => this._bodySelect(`body-lawn-${typeKey}`, `Behuizing gazon (${Catalog.sprinklerTypes[typeKey].short.toLowerCase()})`, typeKey)).join('')
          : this._bodySelect('body-lawn', 'Behuizing gazon', Catalog.usableType(settings.sprinklerType))}
        ${this._bodySelect('body-bed', 'Behuizing beplanting', `bed-${settings.bedSprinklerType || 'spray'}`)}
        ${auto ? '' : `<label class="inline"><input type="checkbox" id="r-auto" ${settings.radius ? '' : 'checked'}> Worpwijdte automatisch</label>
        ${settings.radius ? `<label>Worpwijdte (m)<input id="r-val" type="number" step="0.1" value="${escapeHtml(settings.radius)}"></label>` : ''}`}
        <button id="auto-place" class="btn primary">Automatisch plaatsen</button>
        <p class="hint small">Plaatst sproeiers op alle gazons en in beplanting waarvoor <b>Sproeiers</b> als methode gekozen is (stap 1). Kop (MP-model), worp, sproeihoek en richting worden daarbij automatisch optimaal afgesteld, ook bij handmatig plaatsen en verslepen.</p>
        <button id="tune-spr" class="btn">Alle koppen opnieuw afstellen</button>
        <h3>Zelf een kop plaatsen</h3>
        ${this._manualPick()}
        <div class="row">
          <button class="btn" id="manual-place">Plaatsen</button>
          <button class="btn" id="manual-strip">Strooksproeier</button>
        </div>
        <button class="btn danger" id="clear-spr">Alle sproeiers verwijderen</button>
        <p class="hint small">Smalle stroken (&lt; ${window.Planner.NARROW_WIDTH} m) krijgen automatisch strooksproeiers. Bij handmatig plaatsen op een rand of hoek wordt de sproeihoek automatisch ingesteld. Sleep een sproeier om te verplaatsen; pas sproeihoek en worpwijdte aan in het eigenschappenpaneel.</p>
        <h3>Neerslagsimulatie</h3>
        <p class="small">Sproeiers: ${countTxt}</p>
        ${stats ? `
          <table class="kv">
            <tr><td>Gem. neerslag gazon</td><td>${formatNumber(stats.mean)} mm/u</td></tr>
            <tr><td>Gelijkmatigheid (DU)</td><td class="${stats.du >= 0.7 ? 'good' : stats.du >= 0.55 ? 'warn' : 'bad'}">${formatNumber(stats.du * 100, 0)}%</td></tr>
            <tr><td>Droge plekken</td><td class="${stats.dryPct < 2 ? 'good' : stats.dryPct < 6 ? 'warn' : 'bad'}">${formatNumber(stats.dryPct)}%</td></tr>
            <tr><td>Water op droog te houden vlakken</td><td class="${sim.overspray < 0.5 ? 'good' : 'warn'}">${formatNumber(sim.overspray)} m²</td></tr>
          </table>
          <div class="legend"><span style="background:#d32f2f"></span>droog <span style="background:#ffc107"></span>weinig <span style="background:#388e3c"></span>goed <span style="background:#1e88e5"></span>veel</div>
          <p class="hint small">Streefwaarde gelijkmatigheid ≥ 70% (goed), ≥ 55% (acceptabel).</p>`
        : '<p class="hint">Zet de laag <b>Neerslagkaart</b> aan om de verdeling te zien.</p>'}
      `;
    },
    /**
     * Koppelt de keuzes en knoppen van stap 4.
     * @param {HTMLElement} panel het paneel
     */
    _bind_sprinklers(panel) {
      const settings = this.state.settings;
      panel.querySelectorAll('input[name=stype]').forEach((radio) => {
        /** Kiest het sproeiertype. */
        radio.onchange = () =>{  { settings.sprinklerType = radio.value; settings.radius = null; this._save(); this.renderStepPanel(); }; };
      });
      if ($('#r-auto', panel)) {
        /**
         * Zet de automatische worpwijdte aan of uit.
         * @param {Event} event de gebeurtenis
         */
        $('#r-auto', panel).onchange = (event) =>{  { settings.radius = event.target.checked ? null : Catalog.sprinklerTypes[Catalog.usableType(settings.sprinklerType)].rDefault; this._save(); this.renderStepPanel(); }; };
      }
      if ($('#r-val', panel)) {
        /**
         * Past de vaste worpwijdte aan (binnen het bereik van het type).
         * @param {Event} event de gebeurtenis
         */
        $('#r-val', panel).onchange = (event) =>{  { const sprinklerType = Catalog.sprinklerTypes[Catalog.usableType(settings.sprinklerType)]; settings.radius = Math.max(sprinklerType.rMin, Math.min(sprinklerType.rMax, +event.target.value || sprinklerType.rDefault)); this._save(); this.renderStepPanel(); }; };
      }
      /** Plaatst de sproeiers automatisch. */
      $('#auto-place', panel).onclick = () => { this.autoPlace(); };
      /** Stelt alle koppen opnieuw af. */
      $('#tune-spr', panel).onclick = () => {
        if (!this.state.sprinklers.length) { this.toast('Plaats eerst sproeiers.', true); return; }
        this.checkpoint();
        const count = this.tuneHeads();
        this.commit();
        this.toast(count ? `${count} kop${count === 1 ? '' : 'pen'} bijgesteld. Controleer de neerslagkaart.` : 'Alle koppen staan al optimaal afgesteld.');
      };
      /** Kiest het gereedschap om de gekozen kop te plaatsen. */
      $('#manual-place', panel).onclick = () => {
        const choice = this._manualChoice();
        this.editor.setTool('sprinkler', { type: choice.type, body: choice.body, model: choice.model });
      };
      ['body-lawn', 'body-lawn-rotator', 'body-lawn-spray', 'body-lawn-rotor', 'body-bed'].forEach((id) => {
        const select = $(`#${id}`, panel);
        if (!select) return;
        /** Bewaart de gekozen behuizing voor automatisch plaatsen. */
        select.onchange = () => {
          settings.bodies = { ...(settings.bodies || {}) };
          if (select.value) settings.bodies[select.dataset.key] = select.value; else delete settings.bodies[select.dataset.key];
          this._save();
        };
      });
      const bodySelect = $('#m-body', panel), nozzleSelect = $('#m-noz', panel);
      if (bodySelect) {
        /** Kiest de behuizing voor Zelf een kop plaatsen. */
        bodySelect.onchange = () =>{  { this.manual = { body: bodySelect.value || null, model: null }; this.renderStepPanel(); }; };
      }
      if (nozzleSelect) {
        /** Kiest de nozzle voor Zelf een kop plaatsen. */
        nozzleSelect.onchange = () =>{  { this.manual = { ...(this.manual || {}), model: nozzleSelect.value || null }; this.renderStepPanel(); }; };
      }
      /** Kiest het gereedschap voor een strooksproeier. */
      $('#manual-strip', panel).onclick = () => { this.editor.setTool('sprinkler', { type: 'strip' }); };
      /** Verwijdert alle sproeiers na bevestiging. */
      $('#clear-spr', panel).onclick = () => {
        if (!this.state.sprinklers.length || !confirm('Alle sproeiers verwijderen?')) return;
        this.checkpoint();
        this.state.sprinklers = [];
        this._pruneZones();
        this.commit();
      };
    },

    // --- Stap 5
    /**
     * Paneel van stap 5: zones met debiet en druk, en de leidinglengtes.
     * @returns {string} HTML van het paneel
     */
    _panel_zones() {
      const calc = this.state.calc;
      const zoneResults = calc ? calc.zones.filter((zoneResult) => !zoneResult.empty) : [];
      const rows = zoneResults.map((zoneResult) => `
        <tr>
          <td><span class="swatch" style="background:${zoneResult.zone.color}"></span>${escapeHtml(zoneResult.zone.name)}</td>
          <td>${escapeHtml(Catalog.groups[zoneResult.zone.group].label)}</td>
          <td class="num">${zoneResult.members.length}</td>
          <td class="num">${formatNumber(zoneResult.q / 1000, 2)}</td>
          <td class="num ${zoneResult.ok ? 'good' : 'bad'}">${formatNumber(zoneResult.critical, 2)}</td>
        </tr>`).join('');
      const pipeTot = {};
      if (calc) calc.pipes.forEach((pipe) => { pipeTot[pipe.dn] = (pipeTot[pipe.dn] || 0) + pipe.len; });
      return `
        <p class="hint">Sproeiers worden per type gegroepeerd in zones die binnen het beschikbare debiet (${formatNumber(Hydraulics.maxZoneLph(this.state) / 1000, 2)} m³/u) blijven. Leidingen worden als kortste boomstructuur vanaf de ventielkast berekend, inclusief drukverlies (Hazen-Williams).</p>
        <button id="auto-zones" class="btn primary">Zones automatisch indelen</button>
        <p class="hint small">Een sproeier handmatig naar een andere zone verplaatsen? Selecteer de sproeier en kies de zone in het eigenschappenpaneel.</p>
        ${rows ? `
          <table class="list zones">
            <tr><th>Zone</th><th>Type</th><th>Aantal</th><th>m³/u</th><th>bar*</th></tr>
            ${rows}
          </table>
          <p class="hint small">* druk bij de laatste sproeier, na aftrek van de verliezen in hoofdleiding, ventiel en leidingen.</p>
          <h3>Leidingen</h3>
          <table class="kv">${Object.keys(pipeTot).sort((left, right) => left - right).map((dn) => `<tr><td>PE ${dn} mm</td><td>${formatNumber(pipeTot[dn])} m</td></tr>`).join('')}</table>`
        : '<p class="hint">Nog geen zones.</p>'}
      `;
    },
    /**
     * Koppelt de knop van stap 5.
     * @param {HTMLElement} panel het paneel
     */
    _bind_zones(panel) {
      /** Deelt de zones automatisch in. */
      $('#auto-zones', panel).onclick = () => { this.autoZones(); };
    },

    // --- Stap 6
    /**
     * Paneel van stap 6: stuklijst, controle en export.
     * @returns {string} HTML van het paneel
     */
    _panel_bom() {
      const settings = this.state.settings;
      if (!this.state.zones.length && Hydraulics.hasIrrigation(this.state)) {
        Hydraulics.autoZones(this.state);
        Hydraulics.calculate(this.state);
      }
      let rows = [];
      try { rows = this.state.calc ? BOM.build(this.state) : []; } catch (error) { console.error(error); }
      const missing = rows.missing || [];
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      const schedule = this.state.calc ? BOM.schedule(this.state) : [];
      const levels = Object.entries(Catalog.levels).map(([levelKey, level]) => `
        <label class="radio"><input type="radio" name="level" value="${escapeHtml(levelKey)}" ${settings.level === levelKey ? 'checked' : ''}><span><b>${level.label}</b> – <span class="small">${escapeHtml(level.desc)}</span></span></label>`).join('');
      return `
        <h3>Uitvoeringsniveau</h3>
        ${levels}
        <button id="btn-export-xlsx" class="btn primary">Exporteer naar Excel</button>
        <div class="row">
          <button id="btn-export-png" class="btn">Plan als PNG</button>
          <button id="btn-print" class="btn">Afdrukken</button>
        </div>
        ${this._serverAvailable() && this._can('offertes') ? (this.review && this.review.status !== 'goedgekeurd'
          ? '<button id="btn-quote" class="btn" disabled>Offerte maken van dit plan</button><p class="hint small">Een offerte kan pas als het plan is goedgekeurd (knop bovenaan het paneel).</p>'
          : '<button id="btn-quote" class="btn">Offerte maken van dit plan</button>') : ''}
        <h3>Beregeningsschema</h3>
        <div class="row">
          <label>Weekgift (mm)<input id="t-mm" type="number" min="5" max="50" value="${escapeHtml(settings.targetMm)}"></label>
          <label>Beurten/week<input id="t-ses" type="number" min="1" max="7" value="${escapeHtml(settings.sessions)}"></label>
        </div>
        ${schedule.length ? `<table class="list"><tr><th>Zone</th><th>mm/u</th><th>min/beurt</th></tr>
          ${schedule.map((entry) => `<tr><td><span class="swatch" style="background:${entry.zone.color}"></span>${escapeHtml(entry.zone.name)}</td><td class="num">${formatNumber(entry.pr, 0)}</td><td class="num">${Math.round(entry.minutesSession)}</td></tr>`).join('')}</table>` : ''}
        <h3>Stuklijst (${rows.length} regels)</h3>
        ${rows.length ? `<table class="list bom">
          <tr><th>Omschrijving</th><th>Aantal</th><th>Totaal</th></tr>
          ${rows.map((row) => `<tr title="${escapeHtml(row.code)}${row.sku ? ' / ' + escapeHtml(row.sku) : ''}${row.notes ? ' – ' + escapeHtml(row.notes) : ''}"><td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">${escapeHtml(row.name)}</a>` : escapeHtml(row.name)}</td><td class="num">${row.qty} ${escapeHtml(row.unit)}</td><td class="num">${formatEuro(row.total)}</td></tr>`).join('')}
          <tr class="total"><td>Totaal excl. btw${rows.every((row) => row.url) ? '' : ' (indicatief)'}</td><td></td><td class="num">${formatEuro(total)}</td></tr>
        </table>` : '<p class="hint">Nog geen onderdelen – plaats sproeiers en deel zones in.</p>'}
        ${missing.length && (this._can('offertes') || this._can('voorraad')) ? `<h3>Niet in je assortiment (${missing.length})</h3>
          <p class="hint small">Deze onderdelen zijn nodig, maar staan niet als artikel in Artikelen of de webshop. Ze tellen niet mee in de stuklijst en de offerte.${this._can('voorraad') ? ' <a href="../artikelen/">Artikel toevoegen</a>' : ''}</p>
          <table class="list bom missing">${missing.map((row) => `<tr title="${escapeHtml(row.code)}"><td>${escapeHtml(row.name)} <span class="small">(${escapeHtml(row.code)})</span></td><td class="num">${row.qty} ${escapeHtml(row.unit)}</td></tr>`).join('')}</table>` : ''}
        ${this._shopStatus(rows)}
      `;
    },
    /**
     * Regel onder de stuklijst over het eigen assortiment en de webshopprijzen.
     * @param {object[]} rows regels van de stuklijst
     * @returns {string} HTML van de regel
     */
    _shopStatus(rows) {
      const info = window.ShopCatalog && window.ShopCatalog.info;
      const admin = this._can('beheer') ? ' <a href="../beheer/#webshop">Webshop koppelen</a>' : '';
      const own = window.ShopCatalog && window.ShopCatalog.assortment && (this._can('offertes') || this._can('voorraad'));
      const ownText = own ? `<p class="hint small">De planner gebruikt alleen de ${window.ShopCatalog.assortment.length} artikelen uit je eigen assortiment (Artikelen en webshop).${window.ShopCatalog.unknownCodes ? ` ${window.ShopCatalog.unknownCodes} artikelen hebben een code die de planner niet kent en worden niet gebruikt.` : ''}</p>` : '';
      if (!info) return ownText || (this._serverAvailable() ? `<p class="hint small">Prijzen zijn indicatief.${admin}</p>` : '');
      const linked = rows.filter((row) => row.url).length;
      return `${ownText}<p class="hint small">Prijzen uit de webshop (${escapeHtml(info.shop.replace(/^https?:\/\//, ''))}), bijgewerkt ${new Date(info.syncedAt).toLocaleDateString('nl-NL')}: ${linked} van ${rows.length} regels gekoppeld.${admin.replace('Webshop koppelen', 'Koppeling beheren')}</p>`;
    },
    /**
     * Koppelt de keuzes en knoppen van stap 6.
     * @param {HTMLElement} panel het paneel
     */
    _bind_bom(panel) {
      const settings = this.state.settings;
      panel.querySelectorAll('input[name=level]').forEach((radio) => {
        /** Kiest het uitvoeringsniveau. */
        radio.onchange = () =>{  { settings.level = radio.value; this._save(); this.renderStepPanel(); }; };
      });
      /** Exporteert naar Excel. */
      $('#btn-export-xlsx', panel).onclick = () => { this.exportExcel(); };
      /** Exporteert de tekening als PNG. */
      $('#btn-export-png', panel).onclick = () => { this.exportPlanPng(); };
      /** Drukt de pagina af. */
      $('#btn-print', panel).onclick = () => { window.print(); };
      const quote = $('#btn-quote', panel);
      if (quote) {
        /** Gaat naar Offertes met dit plan. */
        quote.onclick = () => { this.makeQuote(); };
      }
      /**
       * Past de weekgift aan.
       * @param {Event} event de gebeurtenis
       */
      $('#t-mm', panel).onchange = (event) =>{  { settings.targetMm = Math.max(1, +event.target.value || 20); this._save(); this.renderStepPanel(); }; };
      /**
       * Past het aantal beurten per week aan.
       * @param {Event} event de gebeurtenis
       */
      $('#t-ses', panel).onchange = (event) =>{  { settings.sessions = Math.max(1, Math.min(7, +event.target.value || 3)); this._save(); this.renderStepPanel(); }; };
    },

    // --- Eigenschappenpaneel
    /** Toont het eigenschappenpaneel van het geselecteerde vlak, de sproeier of het element. */
    onSelectionChanged() {
      const propsPanel = $('#props');
      const selection = this.editor.selection;
      const obj = this.findObject(selection);
      document.body.classList.toggle('has-sel', !!obj);
      if (!obj) {
        propsPanel.innerHTML = '<p class="hint">Selecteer een vlak, sproeier of element om de eigenschappen te bewerken.</p>';
        return;
      }
      const activeVertex = this.editor.activeVertex;
      if (activeVertex && !(selection.kind === 'area' && activeVertex.id === obj.id && obj.pts[activeVertex.index])) this.editor.activeVertex = null;
      if (selection.kind === 'area') propsPanel.innerHTML = this._propsArea(obj);
      else if (selection.kind === 'sprinkler') propsPanel.innerHTML = this._propsSprinkler(obj);
      else propsPanel.innerHTML = this._propsElement(obj);
      this._bindProps(propsPanel, selection, obj);
    },
    /**
     * Eigenschappen van een vlak: naam, type, maten, vorm aanpassen en de beregening.
     * @param {object} area het vlak
     * @returns {string} HTML van het paneel
     */
    _propsArea(area) {
      const activeVertex = this.editor.activeVertex && this.editor.activeVertex.id === area.id ? this.editor.activeVertex : null;
      const opts = Object.entries(Catalog.areaTypes).map(([typeKey, typeInfo]) => `<option value="${escapeHtml(typeKey)}" ${area.type === typeKey ? 'selected' : ''}>${escapeHtml(typeInfo.label)}</option>`).join('');
      let extra = '';
      const areaType = Catalog.areaTypes[area.type];
      if (areaType.methods && area.pts.length >= 3) {
        const method = Hydraulics.methodOf(this.state, area);
        const defaultMethod = (this.state.settings.methods && this.state.settings.methods[area.type]) || areaType.defaultMethod;
        const methodOptions = `<option value="">Standaard (${escapeHtml(Catalog.methods[defaultMethod].label)})</option>` + areaType.methods.map((methodKey) => `<option value="${escapeHtml(methodKey)}" ${area.method === methodKey ? 'selected' : ''}>${escapeHtml(Catalog.methods[methodKey].label)}</option>`).join('');
        extra = `<label>Beregening<select data-f="method">${methodOptions}</select></label><p class="hint small">${escapeHtml(Catalog.methods[method].desc)}</p>`;
        if (method === 'dripline') {
          const dripInfo = Hydraulics.dripInfo(area, method);
          extra += `<table class="kv"><tr><td>Druppelslang</td><td>${dripInfo.lengthM} m</td></tr><tr><td>Rijafstand</td><td>${formatNumber(dripInfo.spacing * 100, 0)} cm</td></tr><tr><td>Debiet</td><td>${formatNumber(dripInfo.lph / 60)} l/min</td></tr><tr><td>Gift</td><td>${formatNumber(dripInfo.mmh)} mm/u</td></tr></table>`;
        } else if (method === 'drippers') {
          const dripInfo = Hydraulics.dripInfo(area, method);
          extra += `<table class="kv"><tr><td>Druppelaars</td><td>${dripInfo.count} × ${formatNumber(Catalog.drippers.lph, 0)} l/u</td></tr><tr><td>Aanvoerbuis 16 mm</td><td>${dripInfo.supplyM} m</td></tr><tr><td>Microbuis</td><td>${dripInfo.microM} m</td></tr><tr><td>Debiet</td><td>${formatNumber(dripInfo.lph / 60)} l/min</td></tr><tr><td>Gift</td><td>${formatNumber(dripInfo.mmh)} mm/u</td></tr></table>`;
        } else if (method === 'sprinklers') {
          const count = this.state.sprinklers.filter((sprinkler) => sprinkler.areaId === area.id).length;
          extra += `<table class="kv"><tr><td>Sproeiers</td><td>${count}</td></tr></table><button class="btn" data-act="bedplace">Sproeiers opnieuw plaatsen</button>`;
        }
      }
      if (area.type === 'lawn') {
        const rect = Geo.minWidthRect(area.pts);
        extra = `<table class="kv"><tr><td>Min. breedte</td><td>${formatNumber(rect.width, 2)} m</td></tr></table><button class="btn primary" data-act="autoplace">Sproeiers plaatsen in dit vlak</button>`;
      }
      return `
        <h3>Vlak</h3>
        <label>Naam<input data-f="name" value="${escapeHtml(area.name)}"></label>
        <label>Type<select data-f="type">${opts}</select></label>
        <table class="kv"><tr><td>Oppervlak</td><td>${formatNumber(Geo.area(area.pts))} m²</td></tr><tr><td>Omtrek</td><td>${formatNumber(Geo.perimeter(area.pts))} m</td></tr><tr><td>Hoekpunten</td><td>${area.pts.length}</td></tr></table>
        <div class="shape-edit">
          <p class="hint small">Vorm aanpassen: sleep een hoekpunt (□), sleep een middenstip (●) voor een extra punt, tik een hoekpunt aan en kies <b>Punt verwijderen</b>${this.editor.touch ? '' : ' (of Delete / dubbelklik)'}.</p>
          ${activeVertex ? `<button class="btn" data-act="vertexdel" ${area.pts.length <= 3 ? 'disabled' : ''}>Punt ${activeVertex.index + 1} verwijderen</button>` : ''}
          <button class="btn" data-act="redraw">Opnieuw tekenen</button>
        </div>
        ${extra}
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    /**
     * Eigenschappen van een sproeier: type, worp en hoek (of strookmaat), richting, zone en druk.
     * @param {object} sprinkler de sproeier
     * @returns {string} HTML van het paneel
     */
    _propsSprinkler(sprinkler) {
      const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
      const typeOpts = Object.entries(Catalog.sprinklerTypes).map(([typeKey, typeInfo]) => `<option value="${escapeHtml(typeKey)}" ${sprinkler.type === typeKey ? 'selected' : ''}${Catalog.typeAvailable(typeKey) || sprinkler.type === typeKey ? '' : ' disabled'}>${escapeHtml(typeInfo.label)}${Catalog.typeAvailable(typeKey) ? '' : ' (niet in assortiment)'}</option>`).join('');
      const zoneOpts = `<option value="">– geen –</option>` + this.state.zones.map((zone) => `<option value="${escapeHtml(zone.id)}" ${sprinkler.zone === zone.id ? 'selected' : ''}>${escapeHtml(zone.name)} (${escapeHtml(Catalog.groups[zone.group].label)})</option>`).join('');
      let pressure = null;
      if (this.state.calc) this.state.calc.zones.forEach((zoneResult) => (zoneResult.members || []).forEach((member) => { if (member.ref === sprinkler) pressure = member.pressure; }));
      const geometry = sprinkler.type === 'strip'
        ? `<label>Breedte (m)<input data-f="width" type="number" step="0.1" min="${sprinklerType.wMin}" max="${sprinklerType.wMax}" value="${escapeHtml(sprinkler.width)}"></label>
           <label>Lengte (m)<input data-f="len" type="number" step="0.1" min="${sprinklerType.lMin}" max="${sprinklerType.lMax}" value="${escapeHtml(sprinkler.len)}"></label>`
        : this._propsHead(sprinkler);
      const minBar = Catalog.headMinBar(sprinkler);
      return `
        <h3>Sproeier</h3>
        <label>Type<select data-f="type">${typeOpts}</select></label>
        ${geometry}
        <label>Richting (°)<input data-f="start" type="number" step="5" value="${escapeHtml(sprinkler.start)}"></label>
        <div class="row"><button class="btn sm" data-rot="-15">⟲ 15°</button><button class="btn sm" data-rot="15">⟳ 15°</button><button class="btn sm" data-rot="90">⟳ 90°</button></div>
        <label>Zone<select data-f="zone">${zoneOpts}</select></label>
        <table class="kv">
          <tr><td>Debiet</td><td>${formatNumber(Catalog.sprinklerFlowLph(sprinkler) / 60, 2)} l/min</td></tr>
          <tr><td>Neerslag</td><td>${formatNumber(Catalog.headPr(sprinkler), 1)} mm/u</td></tr>
          <tr><td>Min. druk</td><td>${Geo.nlShort(minBar, 1)} bar</td></tr>
          ${pressure != null ? `<tr><td>Berekende druk</td><td class="${pressure >= minBar ? 'good' : 'bad'}">${formatNumber(pressure, 2)} bar</td></tr>` : ''}
        </table>
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    /**
     * Keuzelijst met behuizingen voor automatisch plaatsen (`key` = sproeiertype of bed-<type>).
     * @param {string} id id van de keuzelijst
     * @param {string} label tekst ervoor
     * @param {string} key sproeiertype, voor beplanting met `bed-` ervoor
     * @returns {string} HTML van de keuzelijst (leeg zonder behuizingen)
     */
    _bodySelect(id, label, key) {
      const type = key.replace(/^bed-/, '');
      const list = Catalog.bodiesFor(type);
      if (!list.length) return '';
      const cur = this._bodyFor(key);
      return `<label>${escapeHtml(label)}<select id="${id}" data-key="${escapeHtml(key)}"><option value="">Generiek (stuklijst)</option>${list.map((body) =>
        `<option value="${escapeHtml(body.key)}" ${cur === body.key ? 'selected' : ''}>${escapeHtml(`${body.brand} ${body.name}`.trim())}</option>`).join('')}</select></label>`;
    },
    /**
     * Keuze voor Zelf een kop plaatsen: behuizing, nozzle en daaruit het sproeiertype.
     * @returns {{body: string|null, model: string|null, type: string, nozzles: object[]}} de keuze en de passende nozzles
     */
    _manualChoice() {
      const manual = this.manual || {};
      const body = manual.body && Catalog.bodies[manual.body] && Catalog.available(Catalog.bodies[manual.body].code) ? Catalog.bodies[manual.body] : null;
      const nozzles = Object.values(Catalog.nozzles).filter((candidate) => (!body || candidate.mount === body.mount) && Catalog.available(candidate.code));
      const chosenNozzle = manual.model && nozzles.find((candidate) => candidate.key === manual.model);
      const groups = [...new Set(nozzles.map((candidate) => candidate.group))];
      const lawnType = Catalog.usableType(this.state.settings.sprinklerType);
      const type = chosenNozzle ? chosenNozzle.group : !body || groups.includes(lawnType) ? lawnType : groups[0] || lawnType;
      return { body: body ? body.key : null, model: chosenNozzle ? chosenNozzle.key : null, type, nozzles };
    },
    /**
     * Keuzelijsten voor Zelf een kop plaatsen: behuizing en nozzle (per sproeiergroep).
     * @returns {string} HTML van de keuzelijsten
     */
    _manualPick() {
      const choice = this._manualChoice();
      const bodyOpts = Object.values(Catalog.bodies).filter((body) => Catalog.available(body.code)).map((body) => `<option value="${escapeHtml(body.key)}" ${choice.body === body.key ? 'selected' : ''}>${escapeHtml(`${body.brand} ${body.name}`.trim())}</option>`).join('');
      /**
       * Sector als tekst, bijv. "90–210°".
       * @param {number} low begin in graden
       * @param {number} high einde in graden
       * @returns {string} de tekst
       */
      const range = (low, high) => (low === high ? `${low}°` : `${low}–${high}°`);
      const byGroup = {};
      choice.nozzles.forEach((nozzle) => { (byGroup[nozzle.group] = byGroup[nozzle.group] || []).push(nozzle); });
      const nozOpts = Object.entries(byGroup).map(([group, list]) => `<optgroup label="${escapeHtml(Catalog.sprinklerTypes[group] ? Catalog.sprinklerTypes[group].short : group)}">${list.map((nozzle) => {
        const radiusRange = Catalog.nozzleRange(nozzle, { body: choice.body });
        return `<option value="${escapeHtml(nozzle.key)}" ${choice.model === nozzle.key ? 'selected' : ''}>${escapeHtml(nozzle.name)} · ${Geo.nlShort(radiusRange.rMin, 1)}–${Geo.nlShort(radiusRange.rMax, 1)} m · ${nozzle.arcs.map((arc) => range(arc[0], arc[1])).join(' / ')}</option>`;
      }).join('')}</optgroup>`).join('');
      return `<label>Behuizing<select id="m-body"><option value="">Generiek (${escapeHtml(Catalog.sprinklerTypes[choice.type].short)})</option>${bodyOpts}</select></label>
        <label>Nozzle<select id="m-noz"><option value="">Automatisch (past zich aan de plek aan)</option>${nozOpts}</select></label>
        <p class="hint small">Kies een behuizing (pop-uphoogte) en nozzle en tik op <b>Plaatsen</b>: op een hoek of rand stelt de sproeihoek zich in, de worp staat op de volle worp van de nozzle. Daarna in te stellen in het eigenschappenpaneel of met de grepen in de tekening.</p>`;
    },
    /**
     * Kop met nozzle uit de bibliotheek: behuizing, nozzle en het instelbereik voor worp en sproeihoek.
     * @param {object} sprinkler de sproeier
     * @returns {string} HTML van de velden
     */
    _propsHead(sprinkler) {
      /**
       * Sector als tekst, bijv. "90–210°".
       * @param {number} low begin in graden
       * @param {number} high einde in graden
       * @returns {string} de tekst
       */
      const range = (low, high) => (low === high ? `${low}°` : `${low}–${high}°`);
      const bodies = Catalog.bodiesFor(sprinkler.type);
      const body = Catalog.bodyOf(sprinkler);
      const headRange = Catalog.headRange(sprinkler);
      const nozzle = headRange.nozzle;
      const bodyOpts = `<option value="">Generiek</option>` + bodies.map((bodyOption) => `<option value="${escapeHtml(bodyOption.key)}" ${sprinkler.body === bodyOption.key ? 'selected' : ''}>${escapeHtml(`${bodyOption.brand} ${bodyOption.name}`.trim())}</option>`).join('');
      const auto = Catalog.autoNozzle(sprinkler.type, sprinkler.r, sprinkler.arc, body ? body.key : null);
      const nozOpts = (sprinkler.type === 'rotator' || body ? `<option value="">Automatisch${auto ? ` (${escapeHtml(auto.name)})` : ''}</option>` : '<option value="">Generiek</option>')
        + Catalog.nozzlesFor(sprinkler.type, body ? body.key : null).map((candidate) => {
          const radiusRange = Catalog.nozzleRange(candidate, sprinkler);
          return `<option value="${escapeHtml(candidate.key)}" ${sprinkler.model === candidate.key ? 'selected' : ''}>${escapeHtml(candidate.name)} · ${Geo.nlShort(radiusRange.rMin, 1)}–${Geo.nlShort(radiusRange.rMax, 1)} m · ${candidate.arcs.map((arc) => range(arc[0], arc[1])).join(' / ')}</option>`;
        }).join('');
      const set = nozzle ? Catalog.rotatorArcSet(nozzle.key, sprinkler.arc) : [10, 360];
      const presets = nozzle ? [...new Set(nozzle.arcs.flatMap((arc) => [Math.max(10, arc[0]), arc[1]]))] : [90, 180, 270, 360];
      return `${bodies.length ? `<label>Behuizing<select data-f="body">${bodyOpts}</select></label>` : ''}
           <label>Nozzle<select data-f="model">${nozOpts}</select></label>
           <label>Worpwijdte (m) <span class="small">${Geo.nlShort(headRange.rMin, 1)}–${Geo.nlShort(headRange.rMax, 1)}${nozzle ? ' (stelschroef)' : ''}</span><input data-f="r" type="number" step="0.1" min="${headRange.rMin}" max="${headRange.rMax}" value="${escapeHtml(sprinkler.r)}"></label>
           <label>Sproeihoek (°)${nozzle ? ` <span class="small">sector ${range(set[0], set[1])}</span>` : ''}<input data-f="arc" type="number" step="5" min="${nozzle ? Math.max(10, nozzle.arcs[0][0]) : 10}" max="${nozzle ? nozzle.arcs[nozzle.arcs.length - 1][1] : 360}" value="${escapeHtml(sprinkler.arc)}"></label>
           <div class="row">${presets.map((arc) => `<button class="btn sm" data-arc="${arc}">${arc}°</button>`).join('')}</div>
           <p class="hint small">${nozzle ? `Instelling: ${escapeHtml(Catalog.headSetting(sprinkler))}${body ? ` op ${escapeHtml(body.name)}` : ''}. ` : ''}Sleep in de tekening aan de grepen om worp en sproeihoek${nozzle ? ' binnen dit bereik' : ''} in te regelen.</p>`;
    },
    /**
     * Naam van de gekozen kop voor de hint bij het plaatsen.
     * @param {{type: string, body: string, model: string}} opts gekozen type, behuizing en nozzle
     * @returns {string} de naam
     */
    _toolLabel(opts) {
      const nozzle = opts.model && Catalog.nozzles[opts.model];
      const body = opts.body && Catalog.bodies[opts.body];
      if (nozzle || body) return [body && body.name, nozzle && nozzle.name].filter(Boolean).join(' + ');
      return opts.type ? Catalog.sprinklerTypes[opts.type].label : '';
    },
    /**
     * Eigenschappen van een systeemelement (bij de wateraansluiting ook druk en debiet).
     * @param {object} element het element
     * @returns {string} HTML van het paneel
     */
    _propsElement(element) {
      const elementType = Catalog.elementTypes[element.kind];
      const settings = this.state.settings;
      return `
        <h3>${escapeHtml(elementType.label)}</h3>
        ${element.kind === 'source' ? `
          <label>Waterdruk (bar)<input data-s="pressure" type="number" step="0.1" value="${escapeHtml(settings.pressure)}"></label>
          <label>Debiet (m³/u)<input data-s="flow" type="number" step="0.1" value="${escapeHtml(settings.flow)}"></label>` : ''}
        <table class="kv"><tr><td>Positie</td><td>${formatNumber(element.x, 2)}, ${formatNumber(element.y, 2)} m</td></tr></table>
        <button class="btn danger" data-act="delete">Verwijderen</button>`;
    },
    /**
     * Koppelt de velden en knoppen van het eigenschappenpaneel.
     * @param {HTMLElement} panel het paneel
     * @param {object} selection de selectie {kind, id}
     * @param {object} obj het geselecteerde vlak, de sproeier of het element
     */
    _bindProps(panel, selection, obj) {
      panel.querySelectorAll('[data-f]').forEach((input) => {
        /** Verwerkt een gewijzigd veld van het eigenschappenpaneel. */
        input.onchange = () => {
          this.checkpoint();
          const field = input.dataset.f;
          let value = input.value;
          if (input.type === 'number') value = parseFloat(value);
          if (field === 'zone') value = value || null;
          if (selection.kind === 'sprinkler') {
            const oldType = Catalog.sprinklerTypes[obj.type];
            if (field === 'type') {
              const newType = Catalog.sprinklerTypes[value];
              obj.type = value;
              if (value === 'strip') { obj.width = obj.width || 1.5; obj.len = obj.len || 4.6; }
              else obj.r = Math.max(newType.rMin, Math.min(newType.rMax, obj.r || newType.rDefault));
              if (value !== 'strip' && !obj.arc) obj.arc = 180;
              delete obj.model;
              if (obj.body && !Catalog.bodiesFor(value).some((body) => body.key === obj.body)) delete obj.body;
              const zone = this.state.zones.find((candidate) => candidate.id === obj.zone);
              if (zone && zone.group !== newType.group) obj.zone = null;
            } else if (field === 'r') { const headRange = Catalog.headRange(obj); obj.r = Math.max(headRange.rMin, Math.min(headRange.rMax, value || oldType.rDefault)); }
            else if (field === 'arc') obj.arc = Math.max(10, Math.min(360, value || 180));
            else if (field === 'model') {
              if (value) { obj.model = value; obj.r = Catalog.headRange(obj).rMax; } else delete obj.model;
            } else if (field === 'body') {
              if (value) obj.body = value; else delete obj.body;
              const nozzle = obj.model && Catalog.nozzles[obj.model];
              if (nozzle && Catalog.bodyOf(obj) && nozzle.mount !== Catalog.bodyOf(obj).mount) delete obj.model;
            }
            else if (field === 'start') obj.start = Geo.normDeg(value || 0);
            else if (field === 'width') obj.width = Math.max(oldType.wMin, Math.min(oldType.wMax, value || 1.5));
            else if (field === 'len') obj.len = Math.max(oldType.lMin, Math.min(oldType.lMax, value || 4.6));
            else obj[field] = value;
            Catalog.fitHead(obj);
          } else if (selection.kind === 'area') {
            if (field === 'method') obj.method = value || null;
            else obj[field] = value;
            if (field === 'type') { obj.zone = null; obj.method = null; }
            if (field === 'type' || field === 'method') this._applyMethods(obj.id);
          }
          this._pruneZones();
          this.commit();
        };
      });
      panel.querySelectorAll('[data-s]').forEach((input) => {
        /** Past druk of debiet van de wateraansluiting aan. */
        input.onchange = () =>{  { this.checkpoint(); this.state.settings[input.dataset.s] = parseFloat(input.value) || this.state.settings[input.dataset.s]; this.commit(); }; };
      });
      panel.querySelectorAll('[data-arc]').forEach((button) => {
        /** Zet de sproeihoek op de gekozen waarde. */
        button.onclick = () =>{  { this.checkpoint(); obj.arc = +button.dataset.arc; Catalog.fitRotator(obj); this.commit(); }; };
      });
      panel.querySelectorAll('[data-rot]').forEach((button) => {
        /** Draait de sproeier. */
        button.onclick = () =>{  { this.checkpoint(); obj.start = Geo.normDeg(obj.start + +button.dataset.rot); this.commit(); }; };
      });
      panel.querySelectorAll('[data-act]').forEach((button) => {
        /** Voert de gekozen actie uit (verwijderen, punt weg, opnieuw tekenen, plaatsen). */
        button.onclick = () => {
          if (button.dataset.act === 'delete') this.deleteSelection();
          if (button.dataset.act === 'vertexdel') this.editor.removeVertex();
          if (button.dataset.act === 'redraw') this.redrawArea(obj.id);
          if (button.dataset.act === 'autoplace') this.autoPlace([obj.id]);
          if (button.dataset.act === 'bedplace') { this.checkpoint(); this._syncBedSprinklers(true, obj.id); if (this.state.zones.length) Hydraulics.autoZones(this.state); this.commit(); }
        };
      });
    },

    /** Toont de aandachtspunten van het concept, de berekening en de neerslagsimulatie. */
    renderWarnings() {
      const warningsBox = $('#warnings');
      if (!warningsBox) return;
      const calc = this.state.calc;
      const list = (this.conceptWarnings || []).concat(calc ? calc.warnings : []);
      if (this.sim && this.editor.layers.heatmap && this.sim.stats && this.sim.stats.dryPct > 6) list.push(`Droge plekken: ${formatNumber(this.sim.stats.dryPct)}% van het gazon krijgt te weinig water.`);
      if (this.sim && this.editor.layers.heatmap && this.sim.overspray > 0.5) list.push(`Er valt water op ${formatNumber(this.sim.overspray)} m² die droog moet blijven.`);
      document.body.classList.toggle('has-warnings', list.length > 0);
      warningsBox.innerHTML = list.length ? `<h3>Aandachtspunten</h3><ul>${list.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : '';
    },

    /**
     * Toont de hint bij het gereedschap en markeert de actieve knop; op mobiel klapt het paneel in bij tekenen.
     * @param {string} tool het gereedschap
     * @param {object} opts opties van het gereedschap
     */
    onToolChanged(tool, opts) {
      const touch = this.editor && this.editor.touch;
      const touchHints = {
        select: 'Tik om te selecteren · sleep om te verplaatsen · één vinger op een lege plek = verschuiven · knijpen = zoomen',
        pan: 'Sleep om het plan te verschuiven · knijpen = zoomen',
        polygon: `Tekenen: ${opts.areaType ? Catalog.areaTypes[opts.areaType].label : ''} – tik de hoekpunten aan; tik op het eerste punt of op Vorm sluiten · slepen of ✋ = verschuiven · knijpen = zoomen`,
        element: `Plaats: ${opts.kind ? Catalog.elementTypes[opts.kind].label : ''} – tik op het plan`,
        sprinkler: `Plaats: ${this._toolLabel(opts)} – tik in of op de rand van het gazon`,
        wand: `Toverstaf: ${opts.areaType ? Catalog.areaTypes[opts.areaType].label : ''} – tik midden in het vlak op het plan`,
      };
      const hints = {
        select: 'Klik om te selecteren · sleep om te verplaatsen · scrollen = verschuiven · Ctrl + scrollen = zoomen · spatie of rechtermuisknop + slepen = verschuiven',
        pan: 'Sleep om het plan te verschuiven',
        polygon: `Tekenen: ${opts.areaType ? Catalog.areaTypes[opts.areaType].label : ''} – klik de hoekpunten aan, sluit af op het eerste punt of met Enter · scrollen, spatie + slepen of ✋ = verschuiven · Ctrl + scrollen = zoomen · Esc = annuleren`,
        rect: `Rechthoek: ${opts.areaType ? Catalog.areaTypes[opts.areaType].label : ''} – sleep van hoek naar hoek`,
        element: `Plaats: ${opts.kind ? Catalog.elementTypes[opts.kind].label : ''} – klik op het plan`,
        sprinkler: `Plaats: ${this._toolLabel(opts)} – klik in of op de rand van het gazon · Esc = stoppen`,
        calibrate: 'Kalibreren: sleep een lijn over een bekende maat',
        wand: `Toverstaf: ${opts.areaType ? Catalog.areaTypes[opts.areaType].label : ''} – klik midden in het vlak op het plan · Esc = stoppen`,
        measure: 'Meten: sleep een lijn',
      };
      const panHint = touch ? 'Schuiven: sleep het plan · knijpen = zoomen · tik ✋ om verder te tekenen' : 'Schuiven: sleep het plan · klik ✋ om verder te tekenen';
      $('#hint').textContent = this.editor && this.editor.panHold ? panHint : (touch && touchHints[tool]) || hints[tool] || '';
      // mobiel: bij tekenen het paneel inklappen voor meer ruimte, bij selecteren weer openen
      if (this._isMobile() && tool !== 'pan' && tool !== this._lastTool) this._setSheet(tool === 'select');
      this._lastTool = tool;
      const hold = !!(this.editor && this.editor.panHold);
      document.querySelectorAll('.toolbar [data-t]').forEach((button) => button.classList.toggle('active', hold ? button.dataset.t === 'pan' : button.dataset.t === tool));
    },
    /**
     * Toont de muispositie in meters.
     * @param {{x: number, y: number}} world de positie
     */
    onMouseMove(world) {
      $('#coords').textContent = `x ${formatNumber(world.x, 2)} m · y ${formatNumber(world.y, 2)} m`;
    },

    /**
     * Toont een korte melding.
     * @param {string} message de melding
     * @param {boolean} isError als foutmelding tonen
     */
    toast(message, isError = false) {
      const toastBox = $('#toast');
      toastBox.textContent = message;
      toastBox.className = `toast show${isError ? ' err' : ''}`;
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { toastBox.className = 'toast'; }, 3500);
    },

    /** Voorbeeldproject om de werking te tonen. */
    loadDemo() {
      this.checkpoint();
      const demoState = emptyState();
      demoState.meta.name = 'Voorbeeldtuin';
      demoState.areas = [
        { id: Geo.uid('a'), type: 'dry', name: 'Woning', pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 4 }, { x: 0, y: 4 }] },
        { id: Geo.uid('a'), type: 'dry', name: 'Terras', pts: [{ x: 2, y: 4 }, { x: 9, y: 4 }, { x: 9, y: 8 }, { x: 2, y: 8 }] },
        { id: Geo.uid('a'), type: 'lawn', name: 'Gazon achter', pts: [{ x: 0, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 20 }, { x: 0, y: 20 }] },
        { id: Geo.uid('a'), type: 'lawn', name: 'Gazonstrook', pts: [{ x: 13.5, y: 0 }, { x: 15.5, y: 0 }, { x: 15.5, y: 20 }, { x: 13.5, y: 20 }] },
        { id: Geo.uid('a'), type: 'bed', name: 'Border', pts: [{ x: 0, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 21.5 }, { x: 0, y: 21.5 }] },
        { id: Geo.uid('a'), type: 'hedge', name: 'Haag', pts: [{ x: 0, y: 21.5 }, { x: 15.5, y: 21.5 }, { x: 15.5, y: 22.3 }, { x: 0, y: 22.3 }] },
      ];
      demoState.elements = [
        { id: Geo.uid('e'), kind: 'source', x: 11.5, y: 3.5 },
        { id: Geo.uid('e'), kind: 'controller', x: 11.5, y: 1 },
        { id: Geo.uid('e'), kind: 'valvebox', x: 12.8, y: 6 },
        { id: Geo.uid('e'), kind: 'outlet', x: 9.5, y: 7.5 },
      ];
      this.state = demoState;
      this.editor.selection = null;
      this.editor.bgImg = null;
      this.commit();
      this.autoPlace();
      Hydraulics.autoZones(this.state);
      this.commit();
      this.editor.fit();
      this.showStep(3);
    },
  };

  window.App = App;
  window.addEventListener('DOMContentLoaded', () => {
    App.init();
    const demo = document.getElementById('btn-demo');
    if (demo) {
      /** Laadt het voorbeeldproject. */
      demo.onclick = () => { App.loadDemo(); };
    }
  });
})();
