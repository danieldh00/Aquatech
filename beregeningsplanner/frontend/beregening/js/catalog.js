/*
 * Productcatalogus en technische uitgangspunten.
 * Prijzen zijn INDICATIEF (EUR excl. btw) en bedoeld als startpunt: pas ze aan
 * naar je eigen leveranciers/inkoopprijzen.
 */
(function () {
  'use strict';

  const C = {};

  /*
   * Sproeiertypes. Debiet wordt bepaald via de neerslag bij vierkantsverband (kop-tot-kop):
   *   Q [l/u] = PR [mm/u] * r² [m²] * sproeihoek / 360
   * Voor strooksproeiers: Q = PR * lengte * breedte.
   */
  C.sprinklerTypes = {
    spray: {
      label: 'Pop-up sproeier (vaste sproeikop)',
      short: 'Sproeier',
      group: 'spray',
      rMin: 1.8, rMax: 5.2, rDefault: 4.0,
      pr: 40, minBar: 2.0, optBar: 2.1,
      color: '#1f77b4',
      note: 'Hoge neerslag; geschikt voor kleine/onregelmatige vlakken.',
    },
    rotator: {
      label: 'Meerstraalsrotator (MP-type)',
      short: 'Rotator',
      group: 'rotator',
      rMin: 2.5, rMax: 10.7, rDefault: 6.0,
      pr: 10, minBar: 2.8, optBar: 2.8,
      color: '#2ca02c',
      note: 'Lage, gelijkmatige neerslag; minder afspoeling. Sproeierhuis met drukregeling 2,8 bar.',
    },
    rotor: {
      label: 'Turbinesproeier (tandwielaandrijving)',
      short: 'Turbine',
      group: 'rotor',
      rMin: 7.0, rMax: 14.0, rDefault: 10.0,
      pr: 13, minBar: 2.5, optBar: 3.0,
      color: '#d62728',
      note: 'Grote vlakken; minder koppen nodig, hogere druk vereist.',
    },
    strip: {
      label: 'Strooksproeier (rotator, smalle stroken)',
      short: 'Strook',
      group: 'rotator',
      rMin: 0, rMax: 0, rDefault: 0,
      wMin: 1.0, wMax: 3.0, lMin: 2.0, lMax: 9.1,
      pr: 12, minBar: 2.8, optBar: 2.8,
      color: '#9467bd',
      note: 'Voor stroken smaller dan ca. 3 m.',
    },
  };

  /** Groepen die niet in één zone gemengd mogen worden (verschillende neerslag). */
  C.groups = {
    spray: { label: 'Sproeiers', pr: 40 },
    rotator: { label: 'Rotators', pr: 10 },
    rotor: { label: 'Turbinesproeiers', pr: 13 },
    'bed-spray': { label: 'Sproeiers beplanting', pr: 40 },
    'bed-rotator': { label: 'Rotators beplanting', pr: 10 },
    drip: { label: 'Druppelslang', pr: null },
    drippers: { label: 'Druppelaars', pr: null },
  };

  /** Beregeningsmethodes voor beplanting, hagen en plantenbakken. */
  C.methods = {
    dripline: { label: 'Druppelslang', desc: 'Slang met ingebouwde druppelaars in rijen; ideaal voor borders en hagen.' },
    drippers: { label: 'Druppelaars', desc: 'Losse druppelaar per plant of pot via microbuis; ideaal voor plantenbakken en solitaire planten.' },
    sprinklers: { label: 'Sproeiers', desc: 'Pop-up sproeiers (30 cm) boven de beplanting; voor dichte, lage beplanting.' },
    none: { label: 'Geen beregening', desc: 'Dit vlak krijgt geen beregening.' },
  };

  /** Druppelslang. */
  C.drip = {
    emitterLph: 2.2,
    emitterSpacing: 0.33,
    rowSpacingBed: 0.4,
    rowSpacingHedge: 0.5,
    minBar: 1.0,
    regBar: 1.5,
    maxRunM: 100,
  };
  C.drip.lphPerM = C.drip.emitterLph / C.drip.emitterSpacing;
  C.drip.rowSpacingPlanter = 0.3;

  /** Losse druppelaars (drukgecompenseerd) op microbuis 4/6 mm. */
  C.drippers = {
    lph: 2,
    perM2Bed: 2.5, // ca. één plant per 0,4 m²
    spacingHedge: 0.5, // m langs de haag
    perM2Planter: 4, // plantenbak: dichter beplant
    minPerPlanter: 2,
    microTubeM: 0.6, // m microbuis per druppelaar
    supplyRowSpacing: 1.0, // m tussen 16 mm-aanvoerleidingen in een border
  };

  /** PE-buis (PN6). Binnendiameters in mm. */
  C.pipes = [
    { dn: 25, id: 21.0, label: 'PE-buis 25 mm' },
    { dn: 32, id: 27.2, label: 'PE-buis 32 mm' },
    { dn: 40, id: 34.0, label: 'PE-buis 40 mm' },
    { dn: 50, id: 42.6, label: 'PE-buis 50 mm' },
  ];
  C.hydraulics = {
    hazenC: 140,
    maxVelocity: 1.5, // m/s
    minorLossFactor: 1.1, // +10% voor hulpstukken
    valveLossBar: 0.2,
    headerLossBar: 0.3, // filter + terugstroombeveiliging + hoofdkraan
    zoneFlowFactor: 0.9, // max. benutting van beschikbaar debiet per zone
  };

  /** Gebiedstypes. */
  C.areaTypes = {
    lawn: { label: 'Gazon', fill: 'rgba(76,175,80,0.35)', stroke: '#2e7d32', irrigate: 'sprinkler' },
    bed: { label: 'Beplanting / border', fill: 'rgba(141,110,99,0.35)', stroke: '#6d4c41', irrigate: 'drip',
      methods: ['dripline', 'drippers', 'sprinklers', 'none'], defaultMethod: 'dripline' },
    hedge: { label: 'Haag', fill: 'rgba(27,94,32,0.45)', stroke: '#1b5e20', irrigate: 'drip',
      methods: ['dripline', 'drippers', 'sprinklers', 'none'], defaultMethod: 'dripline' },
    planter: { label: 'Plantenbak', fill: 'rgba(255,167,38,0.35)', stroke: '#e65100', irrigate: 'drip',
      methods: ['drippers', 'dripline', 'none'], defaultMethod: 'drippers' },
    wet: { label: 'Mag nat worden', fill: 'rgba(144,202,249,0.30)', stroke: '#64b5f6', irrigate: null },
    dry: { label: 'Moet droog blijven (huis, terras)', fill: 'rgba(158,158,158,0.45)', stroke: '#616161', irrigate: null },
  };

  /** Systeemelementen. */
  C.elementTypes = {
    source: { label: 'Wateraansluiting', short: 'W', color: '#0277bd', single: true },
    controller: { label: 'Beregeningscomputer', short: 'B', color: '#455a64', single: true },
    valvebox: { label: 'Ventielkast', short: 'V', color: '#ef6c00', single: true },
    outlet: { label: 'Waterpunt / tappunt', short: 'T', color: '#00838f', single: false },
  };

  /** Uitvoeringsniveaus voor de stuklijst. */
  C.levels = {
    eco: { label: 'Basis', desc: 'Functioneel en voordelig' },
    expert: { label: 'Standaard', desc: 'Aanbevolen: beregeningscomputer met wifi, flexibele aansluitingen' },
    premium: { label: 'Premium', desc: 'Topkwaliteit met sensoren en extra comfort' },
  };

  /** Artikelen: code -> {omschrijving, eenheid, prijs}. */
  C.articles = {
    'SPR-POP10': { name: 'Pop-up sproeierhuis 10 cm', unit: 'st', price: 4.5 },
    'SPR-POP10-PRS': { name: 'Pop-up sproeierhuis 10 cm met drukregeling (2,1 bar)', unit: 'st', price: 7.9 },
    'SPR-VAN': { name: 'Verstelbare sproeikop (boog 0–360°)', unit: 'st', price: 3.2 },
    'SPR-POP30-PRS': { name: 'Pop-up sproeierhuis 30 cm met drukregeling (beplanting)', unit: 'st', price: 11.5 },
    'ROT-POP30-PRS': { name: 'Pop-up sproeierhuis 30 cm met drukregeling 2,8 bar (rotator, beplanting)', unit: 'st', price: 13.9 },
    'ROT-POP10-PRS': { name: 'Pop-up sproeierhuis 10 cm met drukregeling 2,8 bar (voor rotator)', unit: 'st', price: 8.9 },
    'ROT-MP1000': { name: 'Rotatorsproeikop 2,5–4,5 m', unit: 'st', price: 9.5 },
    'ROT-MP2000': { name: 'Rotatorsproeikop 4,0–6,4 m', unit: 'st', price: 9.5 },
    'ROT-MP3000': { name: 'Rotatorsproeikop 6,7–9,1 m', unit: 'st', price: 9.5 },
    'ROT-MP3500': { name: 'Rotatorsproeikop 9,4–10,7 m', unit: 'st', price: 10.5 },
    'ROT-MPCORNER': { name: 'Rotatorsproeikop hoek 45–105°, 2,5–4,5 m', unit: 'st', price: 9.5 },
    'ROT-STRIP': { name: 'Rotatorsproeikop voor stroken (zijstrook)', unit: 'st', price: 9.5 },
    'TURB-10': { name: 'Pop-up turbinesproeier 10 cm, 7–14 m', unit: 'st', price: 17.5 },
    'TURB-10-PRO': { name: 'Pop-up turbinesproeier 10 cm met rvs-stijgbuis, 7–14 m', unit: 'st', price: 27.5 },
    'CON-ECO': { name: 'Sproeieraansluiting: zadel/T-stuk met ½" buitendraad', unit: 'st', price: 1.9 },
    'CON-FLEX': { name: 'Flexibele aansluitset (aansluitslang 0,5 m + 2 koppelingen)', unit: 'set', price: 3.6 },
    'CON-FLEX-TURB': { name: 'Flexibele aansluitset ¾" voor turbinesproeier', unit: 'set', price: 4.6 },
    'PE-25': { name: 'PE-buis 25 mm PN6', unit: 'm', price: 0.85 },
    'PE-32': { name: 'PE-buis 32 mm PN6', unit: 'm', price: 1.25 },
    'PE-40': { name: 'PE-buis 40 mm PN6', unit: 'm', price: 1.95 },
    'PE-50': { name: 'PE-buis 50 mm PN6', unit: 'm', price: 2.95 },
    'FIT-T-25': { name: 'Knelkoppeling T-stuk 25 mm', unit: 'st', price: 2.4 },
    'FIT-T-32': { name: 'Knelkoppeling T-stuk 32 mm', unit: 'st', price: 3.4 },
    'FIT-T-40': { name: 'Knelkoppeling T-stuk 40 mm', unit: 'st', price: 5.2 },
    'FIT-T-50': { name: 'Knelkoppeling T-stuk 50 mm', unit: 'st', price: 7.9 },
    'FIT-RED': { name: 'Knelkoppeling verloopstuk (reductie)', unit: 'st', price: 2.9 },
    'FIT-L-25': { name: 'Knelkoppeling knie 90° 25 mm', unit: 'st', price: 2.0 },
    'FIT-L-32': { name: 'Knelkoppeling knie 90° 32 mm', unit: 'st', price: 2.9 },
    'FIT-END-25': { name: 'Knelkoppeling eindkap 25 mm', unit: 'st', price: 1.4 },
    'FIT-END-32': { name: 'Knelkoppeling eindkap 32 mm', unit: 'st', price: 1.9 },
    'FIT-ADAPT': { name: 'Knelkoppeling met buitendraad (ventielaansluiting)', unit: 'st', price: 1.9 },
    'VAL-24V': { name: 'Magneetventiel 1" 24 VAC', unit: 'st', price: 24.5 },
    'VAL-24V-FC': { name: 'Magneetventiel 1" 24 VAC met debietregeling', unit: 'st', price: 34.5 },
    'VAL-MANIFOLD': { name: 'Ventielverdeler (koppelstuk per ventiel)', unit: 'st', price: 4.5 },
    'BOX-STD': { name: 'Ventielkast standaard (max. 3 ventielen)', unit: 'st', price: 22.0 },
    'BOX-JUMBO': { name: 'Ventielkast jumbo (max. 6 ventielen)', unit: 'st', price: 39.0 },
    'CTRL-ECO': { name: 'Beregeningscomputer binnenmodel', unit: 'st', price: 69.0 },
    'CTRL-WIFI': { name: 'Beregeningscomputer met wifi (bediening via app, weergegevens)', unit: 'st', price: 179.0 },
    'SEN-RAIN': { name: 'Regensensor', unit: 'st', price: 29.0 },
    'SEN-SOIL': { name: 'Bodemvochtsensor', unit: 'st', price: 89.0 },
    'CAB-7': { name: 'Stuurkabel 7-aderig (ondergronds)', unit: 'm', price: 0.95 },
    'CAB-13': { name: 'Stuurkabel 13-aderig (ondergronds)', unit: 'm', price: 1.65 },
    'CAB-CON': { name: 'Waterdichte kabelverbinder', unit: 'st', price: 0.9 },
    'MAIN-VALVE': { name: 'Hoofdafsluiter met aftapkraan (vorstvrij aftappen)', unit: 'st', price: 14.5 },
    'BACKFLOW': { name: 'Terugstroombeveiliging (klasse volgens NEN-EN 1717 / Waterwerkblad)', unit: 'st', price: 39.0 },
    'FILTER': { name: 'Hoofdfilter 1" 130 µm', unit: 'st', price: 19.5 },
    'OUTLET': { name: 'Waterpunt in grondkastje met snelkoppeling', unit: 'st', price: 29.0 },
    'DRIP-16': { name: 'Druppelslang 16 mm, 2,2 l/u, druppelafstand 33 cm', unit: 'm', price: 0.55 },
    'DRIP-PRV': { name: 'Drukregelaar 1,5 bar + filter (druppelzone)', unit: 'st', price: 16.5 },
    'DRIP-T': { name: 'T-stuk 16 mm druppelslang', unit: 'st', price: 0.6 },
    'DRIP-END': { name: 'Eindstop 16 mm', unit: 'st', price: 0.35 },
    'DRIP-ADAPT': { name: 'Overgang PE 25 mm naar 16 mm', unit: 'st', price: 1.5 },
    'DRIP-PIN': { name: 'Grondpen voor druppelslang', unit: 'st', price: 0.12 },
    'DRIP-FLUSH': { name: 'Spoelventiel 16 mm (automatisch)', unit: 'st', price: 2.5 },
    'DRIP-PE16': { name: 'Aanvoerbuis 16 mm (zonder druppelaars)', unit: 'm', price: 0.35 },
    'DRIPPER-2': { name: 'Druppelaar drukgecompenseerd 2 l/u', unit: 'st', price: 0.35 },
    'MICRO-46': { name: 'Microbuis 4/6 mm', unit: 'm', price: 0.25 },
    'MICRO-CON': { name: 'Insteekkoppeling microbuis 4 mm', unit: 'st', price: 0.12 },
    'MICRO-PIN': { name: 'Druppelpen voor microbuis', unit: 'st', price: 0.15 },
    'PUNCH': { name: 'Ponstang voor druppelaars', unit: 'st', price: 6.5 },
    'TAPE': { name: 'Teflontape', unit: 'rol', price: 1.2 },
  };

  /*
   * Sproeierbibliotheek (sprinklerlib.js): behuizingen en nozzles met hun prestaties.
   * C.setLibrary(eigen) zet de bibliotheek van de organisatie (standaard + eigen regels);
   * daaruit volgen de nozzles per sproeiergroep, de MP-rotatormodellen en de artikelen.
   */
  const Lib = window.SprinklerLib;
  C.Lib = Lib;
  C.bodies = {};
  C.nozzles = {};
  C.rotatorModels = {};
  const BASE_RANGE = Object.fromEntries(Object.entries(C.sprinklerTypes).map(([k, t]) => [k, { rMin: t.rMin, rMax: t.rMax }]));

  /** Bibliotheek instellen (eigen = { bodies, nozzles } van de organisatie, of leeg voor de standaard). */
  C.setLibrary = (own) => {
    const lib = Lib ? Lib.merge(own && Lib.sanitize(own)) : { bodies: [], nozzles: [] };
    C.library = lib;
    autoCache.clear();
    C.bodies = Object.fromEntries(lib.bodies.map((b) => [b.key, b]));
    C.nozzles = {};
    for (const n of lib.nozzles) {
      const range = Lib.radiusRange(n, n.bar);
      C.nozzles[n.key] = { ...n, rMin: range.rMin, rMax: range.rMax, label: n.name };
    }
    // MP-rotators (en andere rotatornozzles voor een sproeierhuis): bereik bij de werkdruk
    C.rotatorModels = {};
    for (const n of Object.values(C.nozzles)) {
      if (n.group === 'rotator') C.rotatorModels[n.key] = { code: n.code, label: n.name, rMin: n.rMin, rMax: n.rMax, arcs: n.arcs };
    }
    // bereik per sproeiertype volgt de bibliotheek (automatisch plaatsen kiest daarbinnen)
    for (const [type, base] of Object.entries(BASE_RANGE)) {
      const t = C.sprinklerTypes[type];
      const list = Object.values(C.nozzles).filter((n) => n.group === type);
      if (type === 'strip' || !list.length) { Object.assign(t, base); continue; }
      t.rMin = Math.min(...list.map((n) => n.rMin));
      t.rMax = Math.max(...list.map((n) => n.rMax));
      t.rDefault = Math.max(t.rMin, Math.min(t.rMax, t.rDefault));
    }
    C.libraryArticles();
    return lib;
  };

  /**
   * Artikelen van de bibliotheek in de catalogus: codes die de catalogus nog niet kent,
   * en een eigen prijs uit de bibliotheek van de organisatie.
   */
  C.libraryArticles = () => {
    for (const x of [...(C.library ? C.library.bodies : []), ...(C.library ? C.library.nozzles : [])]) {
      if (!x.code) continue;
      const cur = C.articles[x.code];
      if (cur && !cur.library) { if (x.source === 'eigen' && x.price != null) cur.price = x.price; continue; }
      C.articles[x.code] = { name: `${x.brand ? `${x.brand} ` : ''}${x.name}`, unit: 'st', price: x.price || 0, library: true };
    }
  };

  /*
   * Eigen assortiment van de organisatie (voorraadartikelen en gekoppelde
   * webshopproducten, via shopcatalog.js). Zolang er geen is (null) gebruikt de
   * planner de hele standaardcatalogus. Met een assortiment kiest hij alleen
   * artikelen die erin staan: sproeiertypes, behuizingen, nozzles en buisdiameters
   * zonder artikel vallen af, en de stuklijst neemt een alternatief of meldt
   * het artikel als ontbrekend. Een nozzle zonder artikelcode (rotornozzle, zit
   * bij de rotor) telt als beschikbaar.
   */
  C.assortment = null;
  const ALL_PIPES = C.pipes.slice();

  /** Staat dit artikel in het assortiment (of is er geen assortiment)? */
  C.available = (code) => !C.assortment || !code || C.assortment.has(code);

  /** Eerste artikel uit de lijst dat beschikbaar is (anders het eerste). */
  C.pick = (...codes) => codes.find((c) => C.available(c)) || codes[0];

  /** Assortiment instellen (lijst met codes) of wissen (null/leeg). */
  C.setAssortment = (codes) => {
    const list = Array.isArray(codes) ? codes.map((c) => String(c).trim().toUpperCase()).filter((c) => C.articles[c]) : [];
    C.assortment = list.length ? new Set(list) : null;
    autoCache.clear();
    // Alleen buisdiameters die er zijn; zonder enige PE-buis de hele reeks
    // (dan meldt de stuklijst de buis als ontbrekend).
    const pipes = ALL_PIPES.filter((p) => C.available(`PE-${p.dn}`));
    C.pipes.splice(0, C.pipes.length, ...(pipes.length ? pipes : ALL_PIPES));
  };

  /** Sproeiertype bruikbaar: het kenmerkende artikel (kop) is er. */
  C.typeAvailable = (type) => {
    if (!C.assortment) return true;
    if (type === 'spray') return C.available('SPR-VAN') || C.nozzlesFor('spray').some((n) => n.code);
    if (type === 'rotator') return Object.values(C.rotatorModels).some((m) => C.available(m.code));
    if (type === 'rotor') return C.available('TURB-10') || C.available('TURB-10-PRO') || C.bodiesFor('rotor').some((b) => b.code);
    if (type === 'strip') return C.available('ROT-STRIP');
    return true;
  };

  /** Het gewenste type als dat bruikbaar is, anders het eerste bruikbare gazontype. */
  C.usableType = (type, order = ['rotator', 'spray', 'rotor']) => (C.sprinklerTypes[type] && C.typeAvailable(type) ? type : order.find((t) => C.typeAvailable(t)) || order[0]);

  /** Rotatorkoppen die de planner mag kiezen. */
  C.rotatorModelsAvailable = () => Object.fromEntries(Object.entries(C.rotatorModels).filter(([, m]) => C.available(m.code)));

  /** Nozzles van een sproeiergroep die op een behuizing (aansluiting) passen en in het assortiment staan. */
  C.nozzlesFor = (group, bodyKey) => {
    const b = bodyKey && C.bodies[bodyKey];
    return Object.values(C.nozzles).filter((n) => n.group === group && (!b || n.mount === b.mount) && C.available(n.code));
  };

  /** Behuizingen (in het assortiment) waar nozzles van deze groep op passen. */
  C.bodiesFor = (group) => {
    const mounts = new Set(Object.values(C.nozzles).filter((n) => n.group === group).map((n) => n.mount));
    return Object.values(C.bodies).filter((b) => mounts.has(b.mount) && C.available(b.code));
  };

  /** Gekozen behuizing van een sproeier (of null). */
  C.bodyOf = (s) => (s && s.body && C.bodies[s.body]) || null;

  /** Werkdruk van een kop: de drukregeling van het huis, anders de werkdruk van de nozzle. */
  C.headBar = (s, n = C.nozzleOf(s)) => {
    const b = C.bodyOf(s);
    if (b && b.regBar) return b.regBar;
    return n ? n.bar : null;
  };

  /** Sector [van, tot] van een nozzle waarin de sproeihoek valt (of de dichtstbijzijnde). */
  const arcSetOf = (arcs, arc) => {
    let best = arcs[0], bestD = Infinity;
    for (const set of arcs) {
      const d = arc < set[0] ? set[0] - arc : arc > set[1] ? arc - set[1] : 0;
      if (d < bestD) { best = set; bestD = d; }
    }
    return best;
  };
  const arcDist = (arcs, arc) => { const set = arcSetOf(arcs, arc); return arc < set[0] ? set[0] - arc : arc > set[1] ? arc - set[1] : 0; };

  /** Worpbereik van een nozzle op een kop (bij de werkdruk van die kop). */
  C.nozzleRange = (n, s) => {
    const bar = C.headBar(s, n);
    return Lib.radiusRange(n, bar);
  };

  /**
   * Nozzle die automatisch bij een kop hoort: de sector moet de sproeihoek bevatten, de worp
   * binnen het bereik vallen; daarna de kleinste die de worp haalt. Rotornozzles (debiet per
   * nozzle) zo kiezen dat de neerslag het dichtst bij die van het sproeiertype ligt.
   */
  const autoCache = new Map();
  C.autoNozzle = (type, r, arc = 360, bodyKey = null) => {
    const ck = `${type}|${r}|${arc}|${bodyKey || ''}`;
    if (autoCache.has(ck)) return autoCache.get(ck);
    if (autoCache.size > 5000) autoCache.clear();
    const best = pickNozzle(type, r, arc, bodyKey);
    autoCache.set(ck, best);
    return best;
  };
  function pickNozzle(type, r, arc, bodyKey) {
    const list = C.nozzlesFor(type, bodyKey);
    if (!list.length) return null;
    const t = C.sprinklerTypes[type];
    let best = null, bestScore = Infinity;
    for (const n of list) {
      const range = C.nozzleRange(n, { body: bodyKey });
      const out = r < range.rMin ? range.rMin - r : r > range.rMax ? r - range.rMax : 0;
      let score = arcDist(n.arcs, arc) * 10 + out * 100 + (out ? 0 : range.rMax - r);
      if (!n.matched && r > 0 && arc > 0) {
        const q = Lib.flowLph(n, r, arc, C.headBar({ body: bodyKey }, n));
        score += Math.abs(q / (r * r * (arc / 360)) - t.pr) * 2;
      }
      if (score < bestScore - 1e-9) { best = n; bestScore = score; }
    }
    return best;
  }

  /** Nozzle van een kop: de gekozen (als die bij het type past) of de automatische. */
  C.nozzleOf = (s) => {
    if (!s || s.type === 'strip') return null;
    const own = s.model && C.nozzles[s.model];
    if (own && own.group === s.type && C.available(own.code)) return own;
    // met een gekozen behuizing altijd een nozzle uit de bibliotheek; zonder behuizing alleen
    // rotators (MP), sproeiers en rotors blijven dan generiek
    const body = s.body && C.bodies[s.body] ? s.body : null;
    if (s.type !== 'rotator' && !body) return null;
    return C.autoNozzle(s.type, s.r, s.arc, body);
  };

  /** Rotatorkop die automatisch bij worpwijdte en sproeihoek hoort (sleutel). */
  C.autoRotatorModel = (r, arc = 360) => {
    const n = C.autoNozzle('rotator', r, arc);
    if (n) return n.key;
    // geen enkele rotatorkop in het assortiment: de passende kop (de stuklijst meldt hem als ontbrekend)
    const all = Object.values(C.nozzles).filter((x) => x.group === 'rotator').sort((a, b) => a.rMax - b.rMax);
    const fit = all.find((x) => r <= x.rMax + 1e-9) || all[all.length - 1];
    return fit ? fit.key : null;
  };

  /** Gekozen (of automatische) rotatorkop van een sproeier (sleutel). */
  C.rotatorModelOf = (s) => (s.model && C.rotatorModels[s.model] && C.available(C.rotatorModels[s.model].code) ? s.model : C.autoRotatorModel(s.r, s.arc));

  /** Sector [van, tot] van de kop waarin de sproeihoek valt (of de dichtstbijzijnde). */
  C.rotatorArcSet = (model, arc) => arcSetOf((C.nozzles[model] || C.rotatorModels[model]).arcs, arc);

  /** Instelbereik van een kop: worp, sectoren en de nozzle (null = generiek type). */
  C.headRange = (s) => {
    const t = C.sprinklerTypes[s.type];
    const n = C.nozzleOf(s);
    if (!n) return { rMin: t.rMin, rMax: t.rMax, arcs: [[10, 360]], nozzle: null };
    const range = C.nozzleRange(n, s);
    return { rMin: range.rMin, rMax: range.rMax, arcs: n.arcs, nozzle: n };
  };

  /**
   * Zet worpwijdte en sproeihoek van een kop binnen het bereik van zijn nozzle (zonder
   * gekozen nozzle bij een rotator: de nozzle die erbij past). Generieke sproeiers blijven gelijk.
   * @returns de sproeier (aangepast)
   */
  C.fitHead = (s) => {
    if (!s || s.type === 'strip') return s;
    const n = C.nozzleOf(s);
    if (!n) return s;
    const range = C.nozzleRange(n, s);
    s.r = Math.round(Math.max(range.rMin, Math.min(range.rMax, s.r || range.rMax)) * 10) / 10;
    const set = arcSetOf(n.arcs, s.arc);
    s.arc = Math.round(Math.max(Math.max(10, set[0]), Math.min(set[1], s.arc)));
    return s;
  };
  C.fitRotator = C.fitHead;

  /** Omschrijving van de instelling, bijv. "MP2000 (90–210°) op 135° en 5,2 m". */
  C.headSetting = (s) => {
    const n = C.nozzleOf(s);
    const r = String(s.r).replace('.', ',');
    if (!n) return `${r} m · ${s.arc}°`;
    const set = arcSetOf(n.arcs, s.arc);
    const sector = set[0] === set[1] ? `${set[0]}°` : `${set[0]}–${set[1]}°`;
    return `${n.name} (${sector}) op ${s.arc}° en ${r} m`;
  };
  C.rotatorSetting = C.headSetting;

  /** Rotator-kop (artikel) op basis van worpwijdte (en sproeihoek). */
  C.rotatorNozzle = (r, arc = 360) => C.rotatorModels[C.autoRotatorModel(r, arc)].code;

  /** Debiet van een sproeier in l/u (met nozzle: uit de prestatietabel bij de werkdruk). */
  C.sprinklerFlowLph = (s) => {
    const t = C.sprinklerTypes[s.type];
    if (!t) return 0;
    if (s.type === 'strip') return t.pr * s.len * s.width;
    const n = C.nozzleOf(s);
    if (n) return Lib.flowLph(n, s.r, s.arc, C.headBar(s, n));
    return t.pr * s.r * s.r * (s.arc / 360);
  };

  /** Neerslag (mm/u) bij kop-tot-kop: debiet gedeeld door r² × hoek/360. */
  C.headPr = (s) => {
    const t = C.sprinklerTypes[s.type];
    if (!t) return 0;
    if (s.type === 'strip' || !(s.r > 0) || !(s.arc > 0)) return t.pr;
    if (!C.nozzleOf(s)) return t.pr;
    return C.sprinklerFlowLph(s) / (s.r * s.r * (s.arc / 360));
  };

  /** Minimaal benodigde druk aan de kop (bar). */
  C.headMinBar = (s) => {
    const t = C.sprinklerTypes[s.type];
    const b = C.bodyOf(s);
    if (b && b.regBar) return b.regBar;
    if (s.model && C.nozzles[s.model]) return C.nozzles[s.model].bar;
    return t ? t.minBar : 0;
  };

  C.setLibrary(null);

  window.Catalog = C;
})();
