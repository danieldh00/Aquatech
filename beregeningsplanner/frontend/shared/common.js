// Gedeelde hulpjes voor elke pagina, zodat de app vlot aanvoelt. Laden vóór
// sidebar.js en account.js (direct na env.js).
//
// - AquatechCommon.getJson('api/me'): één verzoek per pagina voor gegevens die
//   kopbalk, zijbalk en module allemaal nodig hebben (api/me, api/config).
// - AquatechCommon.ownerOf(me): van wie lokaal bewaarde gegevens zijn.
// - AquatechCommon.excel(): de Excel-bibliotheek (bijna 1 MB) pas laden bij de
//   eerste export in plaats van op elke pagina (null als dat niet lukt).
// - AquatechCommon.origin(): kwam je via een link uit een ander deel van de app
//   rechtstreeks op een item (planning, dossier, startscherm, portaal), dan
//   brengt de terugknop je daar terug in plaats van naar het overzicht.
// - Offline: registreert de service worker (../sw.js, zie shared/offline.js)
//   en het app-manifest, zodat de app op een telefoon te installeren is en
//   werkorders op locatie ook zonder verbinding werken.
//   AquatechCommon.offline(msg) stelt de service worker een vraag (null zonder).
// - Startpagina uit Mijn profiel: de server zet die op het dashboard in
//   <meta name="aquatech-start">; de eerste keer in een tabblad gaan we er
//   meteen heen, zonder eerst het dashboard op te bouwen.
(function (root) {
  const script = document.currentScript;
  const scriptUrl = script && script.src ? script.src : '';
  /**
   * Maakt van een pad vanaf de app-root een volledige URL (afgeleid van dit
   * script, shared/common.js).
   * @param {string} relativePath Pad vanaf de app-root, bijv. "api/me".
   * @returns {string} De URL (zonder scriptadres het pad zelf).
   */
  const fromApp = (relativePath) => (scriptUrl ? new URL(`../${relativePath}`, scriptUrl).href : relativePath);
  const version = scriptUrl ? new URL(scriptUrl).search : '';

  // ---------- Gedeelde verzoeken ----------
  const cache = {};
  /**
   * Haalt een gedeeld verzoek op als JSON (null bij een fout of offline). Iedere
   * aanroeper krijgt een eigen kopie; `fresh` haalt het opnieuw op (bijv. na opslaan).
   * @param {string} path Pad vanaf de app-root, bijv. "api/me".
   * @param {object} [options] { fresh } = opnieuw ophalen.
   * @returns {Promise<object|null>} Een kopie van het antwoord.
   */
  function getJson(path, { fresh = false } = {}) {
    if (location.protocol === 'file:') return Promise.resolve(null);
    if (fresh || !cache[path]) {
      cache[path] = fetch(fromApp(path), { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }
    return cache[path].then((data) => (data == null ? null : JSON.parse(JSON.stringify(data))));
  }

  /**
   * Van wie gegevens op dit toestel zijn: `<gebruiker>@<omgeving>` uit api/me
   * (zelfde vorm als de offline wachtrij en de server, kop X-Aquatech-Owner).
   * @param {object|null} me Antwoord van api/me.
   * @returns {string|null} De eigenaar, of null zonder gebruiker.
   */
  function ownerOf(me) {
    const user = me && me.user;
    if (!user || !user.id) return null;
    return `${user.id}@${(me.tenant && me.tenant.id) || user.tenantId || ''}`;
  }

  // ---------- Excel op aanvraag ----------
  let excelLoading = null;
  /**
   * Laadt de Excel-bibliotheek (ExcelJS) pas bij de eerste export.
   * @returns {Promise<object|null>} ExcelJS, of null als laden mislukt.
   */
  function excel() {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    if (!excelLoading) {
      excelLoading = new Promise((resolve) => {
        const scriptTag = document.createElement('script');
        scriptTag.src = fromApp(`beregening/vendor/exceljs.min.js${version}`);
        /**
         * Geeft ExcelJS door zodra het script geladen is.
         * @returns {void}
         */
        scriptTag.onload = () => resolve(root.ExcelJS || null);
        /** Laden mislukt: script weg, volgende keer opnieuw proberen. */
        scriptTag.onerror = () => { excelLoading = null; scriptTag.remove(); resolve(null); };
        document.head.appendChild(scriptTag);
      });
    }
    return excelLoading;
  }

  // ---------- Terug naar de herkomst ----------
  /**
   * Terugknop naar de herkomst: { href, label, go() } als de vorige pagina een
   * ander deel van de app was.
   * @returns {{href: string, label: string, go: Function}|null} De terugknop, of null.
   */
  function origin() {
    try {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      if (!referrer || referrer.origin !== location.origin || referrer.pathname === location.pathname) return null;
      const appRoot = new URL(fromApp('')).pathname;
      if (!referrer.pathname.startsWith(appRoot)) return null;
      const section = referrer.pathname.slice(appRoot.length).split('/')[0];
      if (section === 'login' || section === 'wachtwoord') return null;
      const module = (root.AquatechModules || []).find((candidate) => candidate.href === `${section}/`);
      const name = section === '' || section === 'index.html' ? 'Overzicht' : section === 'profiel' ? 'Mijn profiel' : module ? module.title : 'Terug';
      const entry = location.href;
      return {
        href: referrer.href,
        label: `← ${name}`,
        /**
         * Gaat terug: echt terug in hetzelfde tabblad als we nog op de binnenkomst staan
         * (de vorige pagina staat dan vaak nog klaar), anders gewoon naar de vorige pagina.
         */
        go() {
          if (location.href === entry && history.length > 1) history.back();
          else location.href = referrer.href;
        },
      };
    } catch (error) { return null; }
  }

  /**
   * Terug op een pagina uit de cache van de browser (knop Terug): `reload` laadt
   * de gegevens opnieuw, zodat bijv. een gewijzigde status meteen klopt.
   * @param {Function} reload Functie die de gegevens opnieuw laadt.
   */
  function onReturn(reload) {
    root.addEventListener('pageshow', (event) => { if (event.persisted) reload(); });
  }

  // ---------- Startpagina ----------
  // Na deze regel niets meer laden of tekenen als we doorgaan (`leaving`).
  const STARTED = 'aquatech_started';
  const start = document.querySelector('meta[name="aquatech-start"]');
  let leaving = false;
  if (start) {
    let first = false;
    try { first = !sessionStorage.getItem(STARTED); sessionStorage.setItem(STARTED, '1'); } catch (error) { /* geen opslag */ }
    const href = start.getAttribute('content');
    if (first && href && /^[a-z0-9-]+\/$/.test(href)) {
      leaving = true;
      location.replace(href);
    }
  }

  // ---------- Installeerbare app en offline ----------
  // Manifest en iconen voor "Zet op beginscherm" (in de kop, ook op pagina's
  // die ze niet zelf noemen).
  if (scriptUrl && location.protocol !== 'file:') {
    /**
     * Voegt een element met attributen toe aan de kop van de pagina.
     * @param {string} tag Tagnaam, bijv. "link".
     * @param {object} attributes Attributen als naam → waarde.
     */
    const add = (tag, attributes) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      document.head.appendChild(element);
    };
    if (!document.querySelector('link[rel="manifest"]')) add('link', { rel: 'manifest', href: fromApp('manifest.json') });
    add('link', { rel: 'apple-touch-icon', href: fromApp('shared/icons/apple-touch-icon.png') });
    add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'apple-mobile-web-app-title', content: 'AquaTech' });
    if ('serviceWorker' in navigator && root.isSecureContext) {
      navigator.serviceWorker.register(fromApp(`sw.js${version}`)).catch(() => { /* geen offline */ });
    }
  }

  /**
   * Stelt de service worker een vraag ({ type: 'status' } enz.).
   * @param {object} message De vraag.
   * @param {number} [timeout] Wachttijd in ms.
   * @returns {Promise<*>} Het antwoord, of null zonder service worker of na de wachttijd.
   */
  function offline(message, timeout = 4000) {
    const worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), timeout);
      /**
       * Antwoord van de service worker binnen.
       * @param {MessageEvent} event Het bericht.
       */
      channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
      worker.postMessage(message, [channel.port2]);
    });
  }

  root.AquatechCommon = { getJson, ownerOf, excel, origin, onReturn, leaving, offline };
})(window);
