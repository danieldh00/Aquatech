// Gedeelde hulpjes voor elke pagina, zodat de app vlot aanvoelt. Laden vóór
// sidebar.js en account.js (direct na env.js).
//
// - AquatechCommon.getJson('api/me'): één verzoek per pagina voor gegevens die
//   kopbalk, zijbalk en module allemaal nodig hebben (api/me, api/config).
// - AquatechCommon.excel(): de Excel-bibliotheek (bijna 1 MB) pas laden bij de
//   eerste export in plaats van op elke pagina (null als dat niet lukt).
// - AquatechCommon.origin(): kwam je via een link uit een ander deel van de app
//   rechtstreeks op een item (planning, dossier, startscherm, portaal), dan
//   brengt de terugknop je daar terug in plaats van naar het overzicht.
// - Startpagina uit Mijn profiel: de server zet die op het dashboard in
//   <meta name="aquatech-start">; de eerste keer in een tabblad gaan we er
//   meteen heen, zonder eerst het dashboard op te bouwen.
(function (root) {
  const script = document.currentScript;
  const src = script && script.src ? script.src : '';
  // Pad naar de app-root, afgeleid van dit script (shared/common.js).
  const fromApp = (rel) => (src ? new URL(`../${rel}`, src).href : rel);
  const version = src ? new URL(src).search : '';

  // ---------- Gedeelde verzoeken ----------
  const cache = {};
  // Antwoord als JSON (null bij een fout of offline). Iedere aanroeper krijgt
  // een eigen kopie; `fresh` haalt het opnieuw op (bijv. na opslaan).
  function getJson(path, { fresh = false } = {}) {
    if (location.protocol === 'file:') return Promise.resolve(null);
    if (fresh || !cache[path]) {
      cache[path] = fetch(fromApp(path), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return cache[path].then((v) => (v == null ? null : JSON.parse(JSON.stringify(v))));
  }

  // ---------- Excel op aanvraag ----------
  let excelLoading = null;
  function excel() {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    if (!excelLoading) {
      excelLoading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = fromApp(`beregening/vendor/exceljs.min.js${version}`);
        s.onload = () => resolve(root.ExcelJS || null);
        s.onerror = () => { excelLoading = null; s.remove(); resolve(null); };
        document.head.appendChild(s);
      });
    }
    return excelLoading;
  }

  // ---------- Terug naar de herkomst ----------
  // { href, label, go() } als de vorige pagina een ander deel van de app was.
  function origin() {
    try {
      const ref = document.referrer ? new URL(document.referrer) : null;
      if (!ref || ref.origin !== location.origin || ref.pathname === location.pathname) return null;
      const appRoot = new URL(fromApp('')).pathname;
      if (!ref.pathname.startsWith(appRoot)) return null;
      const seg = ref.pathname.slice(appRoot.length).split('/')[0];
      if (seg === 'login' || seg === 'wachtwoord') return null;
      const mod = (root.AquatechModules || []).find((m) => m.href === `${seg}/`);
      const name = seg === '' || seg === 'index.html' ? 'Overzicht' : seg === 'profiel' ? 'Mijn profiel' : mod ? mod.title : 'Terug';
      const entry = location.href;
      return {
        href: ref.href,
        label: `← ${name}`,
        // Zelfde tabblad, nog op de binnenkomst: echt terug (de vorige pagina
        // staat dan vaak nog klaar). Anders gewoon erheen.
        go() {
          if (location.href === entry && history.length > 1) history.back();
          else location.href = ref.href;
        },
      };
    } catch (e) { return null; }
  }

  // Terug op een pagina uit de cache van de browser (knop Terug): `fn` laadt
  // de gegevens opnieuw, zodat bijv. een gewijzigde status meteen klopt.
  function onReturn(fn) {
    root.addEventListener('pageshow', (e) => { if (e.persisted) fn(); });
  }

  // ---------- Startpagina ----------
  // Na deze regel niets meer laden of tekenen als we doorgaan (`leaving`).
  const STARTED = 'aquatech_started';
  const start = document.querySelector('meta[name="aquatech-start"]');
  let leaving = false;
  if (start) {
    let first = false;
    try { first = !sessionStorage.getItem(STARTED); sessionStorage.setItem(STARTED, '1'); } catch (e) { /* geen opslag */ }
    const href = start.getAttribute('content');
    if (first && href && /^[a-z0-9-]+\/$/.test(href)) {
      leaving = true;
      location.replace(href);
    }
  }

  root.AquatechCommon = { getJson, excel, origin, onReturn, leaving };
})(window);
