/*
 * Productcatalogus en technische uitgangspunten.
 * Prijzen zijn INDICATIEF (EUR excl. btw) en bedoeld als startpunt: pas ze aan
 * naar je eigen leveranciers/inkoopprijzen.
 */
(function () {
  'use strict';

  const Catalog = {};

  /*
   * Sproeiertypes. Debiet wordt bepaald via de neerslag bij vierkantsverband (kop-tot-kop):
   *   Q [l/u] = PR [mm/u] * r² [m²] * sproeihoek / 360
   * Voor strooksproeiers: Q = PR * lengte * breedte.
   */
  Catalog.sprinklerTypes = {
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
  Catalog.groups = {
    spray: { label: 'Sproeiers', pr: 40 },
    rotator: { label: 'Rotators', pr: 10 },
    rotor: { label: 'Turbinesproeiers', pr: 13 },
    'bed-spray': { label: 'Sproeiers beplanting', pr: 40 },
    'bed-rotator': { label: 'Rotators beplanting', pr: 10 },
    drip: { label: 'Druppelslang', pr: null },
    drippers: { label: 'Druppelaars', pr: null },
  };

  /** Beregeningsmethodes voor beplanting, hagen en plantenbakken. */
  Catalog.methods = {
    dripline: { label: 'Druppelslang', desc: 'Slang met ingebouwde druppelaars in rijen; ideaal voor borders en hagen.' },
    drippers: { label: 'Druppelaars', desc: 'Losse druppelaar per plant of pot via microbuis; ideaal voor plantenbakken en solitaire planten.' },
    sprinklers: { label: 'Sproeiers', desc: 'Pop-up sproeiers (30 cm) boven de beplanting; voor dichte, lage beplanting.' },
    none: { label: 'Geen beregening', desc: 'Dit vlak krijgt geen beregening.' },
  };

  /** Druppelslang. */
  Catalog.drip = {
    emitterLph: 2.2,
    emitterSpacing: 0.33,
    rowSpacingBed: 0.4,
    rowSpacingHedge: 0.5,
    minBar: 1.0,
    regBar: 1.5,
    maxRunM: 100,
  };
  Catalog.drip.lphPerM = Catalog.drip.emitterLph / Catalog.drip.emitterSpacing;
  Catalog.drip.rowSpacingPlanter = 0.3;

  /** Losse druppelaars (drukgecompenseerd) op microbuis 4/6 mm. */
  Catalog.drippers = {
    lph: 2,
    perM2Bed: 2.5, // ca. één plant per 0,4 m²
    spacingHedge: 0.5, // m langs de haag
    perM2Planter: 4, // plantenbak: dichter beplant
    minPerPlanter: 2,
    microTubeM: 0.6, // m microbuis per druppelaar
    supplyRowSpacing: 1.0, // m tussen 16 mm-aanvoerleidingen in een border
  };

  /** PE-buis (PN6). Binnendiameters in mm. */
  Catalog.pipes = [
    { dn: 25, id: 21.0, label: 'PE-buis 25 mm' },
    { dn: 32, id: 27.2, label: 'PE-buis 32 mm' },
    { dn: 40, id: 34.0, label: 'PE-buis 40 mm' },
    { dn: 50, id: 42.6, label: 'PE-buis 50 mm' },
  ];
  Catalog.hydraulics = {
    hazenC: 140,
    maxVelocity: 1.5, // m/s
    minorLossFactor: 1.1, // +10% voor hulpstukken
    valveLossBar: 0.2,
    headerLossBar: 0.3, // filter + terugstroombeveiliging + hoofdkraan
    zoneFlowFactor: 0.9, // max. benutting van beschikbaar debiet per zone
  };

  /** Gebiedstypes. */
  Catalog.areaTypes = {
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
  Catalog.elementTypes = {
    source: { label: 'Wateraansluiting', short: 'W', color: '#0277bd', single: true },
    controller: { label: 'Beregeningscomputer', short: 'B', color: '#455a64', single: true },
    valvebox: { label: 'Ventielkast', short: 'V', color: '#ef6c00', single: true },
    outlet: { label: 'Waterpunt / tappunt', short: 'T', color: '#00838f', single: false },
  };

  /** Uitvoeringsniveaus voor de stuklijst. */
  Catalog.levels = {
    eco: { label: 'Basis', desc: 'Functioneel en voordelig' },
    expert: { label: 'Standaard', desc: 'Aanbevolen: beregeningscomputer met wifi, flexibele aansluitingen' },
    premium: { label: 'Premium', desc: 'Topkwaliteit met sensoren en extra comfort' },
  };

  /** Artikelen: code -> {omschrijving, eenheid, prijs}. */
  Catalog.articles = {
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
  Catalog.Lib = Lib;
  Catalog.bodies = {};
  Catalog.nozzles = {};
  Catalog.rotatorModels = {};
  const BASE_RANGE = Object.fromEntries(Object.entries(Catalog.sprinklerTypes).map(([typeKey, sprinklerType]) => [typeKey, { rMin: sprinklerType.rMin, rMax: sprinklerType.rMax }]));

  /**
   * Bibliotheek instellen (eigen = { bodies, nozzles } van de organisatie, of leeg voor de standaard).
   * @param {object|null} own eigen regels { bodies, nozzles } van de organisatie, of null voor de standaard
   * @returns {object} de samengevoegde bibliotheek
   */
  Catalog.setLibrary = (own) => {
    const mergedLibrary = Lib ? Lib.merge(own && Lib.sanitize(own)) : { bodies: [], nozzles: [] };
    Catalog.library = mergedLibrary;
    autoCache.clear();
    Catalog.bodies = Object.fromEntries(mergedLibrary.bodies.map((body) => [body.key, body]));
    Catalog.nozzles = {};
    for (const nozzle of mergedLibrary.nozzles) {
      const range = Lib.radiusRange(nozzle, nozzle.bar);
      Catalog.nozzles[nozzle.key] = { ...nozzle, rMin: range.rMin, rMax: range.rMax, label: nozzle.name };
    }
    // MP-rotators (en andere rotatornozzles voor een sproeierhuis): bereik bij de werkdruk
    Catalog.rotatorModels = {};
    for (const nozzle of Object.values(Catalog.nozzles)) {
      if (nozzle.group === 'rotator') Catalog.rotatorModels[nozzle.key] = { code: nozzle.code, label: nozzle.name, rMin: nozzle.rMin, rMax: nozzle.rMax, arcs: nozzle.arcs };
    }
    // bereik per sproeiertype volgt de bibliotheek (automatisch plaatsen kiest daarbinnen)
    for (const [type, baseRange] of Object.entries(BASE_RANGE)) {
      const sprinklerType = Catalog.sprinklerTypes[type];
      const typeNozzles = Object.values(Catalog.nozzles).filter((nozzle) => nozzle.group === type);
      if (type === 'strip' || !typeNozzles.length) { Object.assign(sprinklerType, baseRange); continue; }
      sprinklerType.rMin = Math.min(...typeNozzles.map((nozzle) => nozzle.rMin));
      sprinklerType.rMax = Math.max(...typeNozzles.map((nozzle) => nozzle.rMax));
      sprinklerType.rDefault = Math.max(sprinklerType.rMin, Math.min(sprinklerType.rMax, sprinklerType.rDefault));
    }
    Catalog.libraryArticles();
    return mergedLibrary;
  };

  /**
   * Artikelen van de bibliotheek in de catalogus: codes die de catalogus nog niet kent,
   * en een eigen prijs uit de bibliotheek van de organisatie.
   * @returns {void}
   */
  Catalog.libraryArticles = () => {
    for (const part of [...(Catalog.library ? Catalog.library.bodies : []), ...(Catalog.library ? Catalog.library.nozzles : [])]) {
      if (!part.code) continue;
      const existing = Catalog.articles[part.code];
      if (existing && !existing.library) { if (part.source === 'eigen' && part.price != null) existing.price = part.price; continue; }
      Catalog.articles[part.code] = { name: `${part.brand ? `${part.brand} ` : ''}${part.name}`, unit: 'st', price: part.price || 0, library: true };
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
  Catalog.assortment = null;
  const ALL_PIPES = Catalog.pipes.slice();

  /**
   * Staat dit artikel in het assortiment (of is er geen assortiment)?
   * @param {string} code artikelcode
   * @returns {boolean} true als het artikel gekozen mag worden
   */
  Catalog.available = (code) => !Catalog.assortment || !code || Catalog.assortment.has(code);

  /**
   * Eerste artikel uit de lijst dat beschikbaar is (anders het eerste).
   * @param {...string} codes artikelcodes in volgorde van voorkeur
   * @returns {string} de gekozen artikelcode
   */
  Catalog.pick = (...codes) => codes.find((code) => Catalog.available(code)) || codes[0];

  /**
   * Assortiment instellen (lijst met codes) of wissen (null/leeg).
   * @param {string[]|null} codes artikelcodes van het assortiment
   */
  Catalog.setAssortment = (codes) => {
    const list = Array.isArray(codes) ? codes.map((code) => String(code).trim().toUpperCase()).filter((code) => Catalog.articles[code]) : [];
    Catalog.assortment = list.length ? new Set(list) : null;
    autoCache.clear();
    // Alleen buisdiameters die er zijn; zonder enige PE-buis de hele reeks
    // (dan meldt de stuklijst de buis als ontbrekend).
    const pipes = ALL_PIPES.filter((pipe) => Catalog.available(`PE-${pipe.dn}`));
    Catalog.pipes.splice(0, Catalog.pipes.length, ...(pipes.length ? pipes : ALL_PIPES));
  };

  /**
   * Sproeiertype bruikbaar: het kenmerkende artikel (kop) is er.
   * @param {string} type sproeiertype (spray, rotator, rotor, strip)
   * @returns {boolean} true als het type gekozen mag worden
   */
  Catalog.typeAvailable = (type) => {
    if (!Catalog.assortment) return true;
    if (type === 'spray') return Catalog.available('SPR-VAN') || Catalog.nozzlesFor('spray').some((nozzle) => nozzle.code);
    if (type === 'rotator') return Object.values(Catalog.rotatorModels).some((model) => Catalog.available(model.code));
    if (type === 'rotor') return Catalog.available('TURB-10') || Catalog.available('TURB-10-PRO') || Catalog.bodiesFor('rotor').some((body) => body.code);
    if (type === 'strip') return Catalog.available('ROT-STRIP');
    return true;
  };

  /**
   * Het gewenste type als dat bruikbaar is, anders het eerste bruikbare gazontype.
   * @param {string} type gewenst sproeiertype
   * @param {string[]} order terugvalvolgorde van gazontypes
   * @returns {string} het bruikbare sproeiertype
   */
  Catalog.usableType = (type, order = ['rotator', 'spray', 'rotor']) => (Catalog.sprinklerTypes[type] && Catalog.typeAvailable(type) ? type : order.find((candidate) => Catalog.typeAvailable(candidate)) || order[0]);

  /**
   * Rotatorkoppen die de planner mag kiezen.
   * @returns {object} rotatormodellen per sleutel
   */
  Catalog.rotatorModelsAvailable = () => Object.fromEntries(Object.entries(Catalog.rotatorModels).filter(([, model]) => Catalog.available(model.code)));

  /**
   * Nozzles van een sproeiergroep die op een behuizing (aansluiting) passen en in het assortiment staan.
   * @param {string} group sproeiergroep
   * @param {string} [bodyKey] sleutel van de behuizing (leeg = alle)
   * @returns {object[]} passende nozzles
   */
  Catalog.nozzlesFor = (group, bodyKey) => {
    const body = bodyKey && Catalog.bodies[bodyKey];
    return Object.values(Catalog.nozzles).filter((nozzle) => nozzle.group === group && (!body || nozzle.mount === body.mount) && Catalog.available(nozzle.code));
  };

  /**
   * Behuizingen (in het assortiment) waar nozzles van deze groep op passen.
   * @param {string} group sproeiergroep
   * @returns {object[]} passende behuizingen
   */
  Catalog.bodiesFor = (group) => {
    const mounts = new Set(Object.values(Catalog.nozzles).filter((nozzle) => nozzle.group === group).map((nozzle) => nozzle.mount));
    return Object.values(Catalog.bodies).filter((body) => mounts.has(body.mount) && Catalog.available(body.code));
  };

  /**
   * Gekozen behuizing van een sproeier (of null).
   * @param {object} sprinkler de sproeier
   * @returns {object|null} de behuizing
   */
  Catalog.bodyOf = (sprinkler) => (sprinkler && sprinkler.body && Catalog.bodies[sprinkler.body]) || null;

  /**
   * Werkdruk van een kop: de drukregeling van het huis, anders de werkdruk van de nozzle.
   * @param {object} sprinkler de sproeier
   * @param {object} [nozzle] de nozzle (standaard die van de sproeier)
   * @returns {number|null} werkdruk in bar
   */
  Catalog.headBar = (sprinkler, nozzle = Catalog.nozzleOf(sprinkler)) => {
    const body = Catalog.bodyOf(sprinkler);
    if (body && body.regBar) return body.regBar;
    return nozzle ? nozzle.bar : null;
  };

  /**
   * Sector [van, tot] van een nozzle waarin de sproeihoek valt (of de dichtstbijzijnde).
   * @param {number[][]} arcs sectoren [van, tot] van de nozzle
   * @param {number} arc sproeihoek in graden
   * @returns {number[]} de best passende sector
   */
  const arcSetOf = (arcs, arc) => {
    let best = arcs[0], bestDistance = Infinity;
    for (const set of arcs) {
      const distance = arc < set[0] ? set[0] - arc : arc > set[1] ? arc - set[1] : 0;
      if (distance < bestDistance) { best = set; bestDistance = distance; }
    }
    return best;
  };

  /**
   * Afstand in graden tussen de sproeihoek en de best passende sector (0 = past erin).
   * @param {number[][]} arcs sectoren [van, tot] van de nozzle
   * @param {number} arc sproeihoek in graden
   * @returns {number} afwijking in graden
   */
  const arcDist = (arcs, arc) => { const set = arcSetOf(arcs, arc); return arc < set[0] ? set[0] - arc : arc > set[1] ? arc - set[1] : 0; };

  /**
   * Worpbereik van een nozzle op een kop (bij de werkdruk van die kop).
   * @param {object} nozzle de nozzle
   * @param {object} sprinkler de kop (voor de behuizing)
   * @returns {{rMin: number, rMax: number}} worpbereik in meter
   */
  Catalog.nozzleRange = (nozzle, sprinkler) => {
    const bar = Catalog.headBar(sprinkler, nozzle);
    return Lib.radiusRange(nozzle, bar);
  };

  // Onthouden automatische nozzles per type, worp, hoek en behuizing.
  const autoCache = new Map();

  /**
   * Nozzle die automatisch bij een kop hoort: de sector moet de sproeihoek bevatten, de worp
   * binnen het bereik vallen; daarna de kleinste die de worp haalt. Rotornozzles (debiet per
   * nozzle) zo kiezen dat de neerslag het dichtst bij die van het sproeiertype ligt.
   * Het resultaat wordt onthouden per type, worp, hoek en behuizing.
   * @param {string} type sproeiertype
   * @param {number} radius worpwijdte in meter
   * @param {number} arc sproeihoek in graden
   * @param {string|null} bodyKey sleutel van de behuizing
   * @returns {object|null} de nozzle
   */
  Catalog.autoNozzle = (type, radius, arc = 360, bodyKey = null) => {
    const cacheKey = `${type}|${radius}|${arc}|${bodyKey || ''}`;
    if (autoCache.has(cacheKey)) return autoCache.get(cacheKey);
    if (autoCache.size > 5000) autoCache.clear();
    const best = pickNozzle(type, radius, arc, bodyKey);
    autoCache.set(cacheKey, best);
    return best;
  };

  /**
   * Kiest de best passende nozzle (zie autoNozzle) zonder cache.
   * @param {string} type sproeiertype
   * @param {number} radius worpwijdte in meter
   * @param {number} arc sproeihoek in graden
   * @param {string|null} bodyKey sleutel van de behuizing
   * @returns {object|null} de nozzle met de laagste afwijkingsscore
   */
  function pickNozzle(type, radius, arc, bodyKey) {
    const list = Catalog.nozzlesFor(type, bodyKey);
    if (!list.length) return null;
    const sprinklerType = Catalog.sprinklerTypes[type];
    let best = null, bestScore = Infinity;
    for (const nozzle of list) {
      const range = Catalog.nozzleRange(nozzle, { body: bodyKey });
      const outOfRange = radius < range.rMin ? range.rMin - radius : radius > range.rMax ? radius - range.rMax : 0;
      let score = arcDist(nozzle.arcs, arc) * 10 + outOfRange * 100 + (outOfRange ? 0 : range.rMax - radius);
      if (!nozzle.matched && radius > 0 && arc > 0) {
        const flow = Lib.flowLph(nozzle, radius, arc, Catalog.headBar({ body: bodyKey }, nozzle));
        score += Math.abs(flow / (radius * radius * (arc / 360)) - sprinklerType.pr) * 2;
      }
      if (score < bestScore - 1e-9) { best = nozzle; bestScore = score; }
    }
    return best;
  }

  /**
   * Nozzle van een kop: de gekozen (als die bij het type past) of de automatische.
   * @param {object} sprinkler de sproeier
   * @returns {object|null} de nozzle (null = generiek type)
   */
  Catalog.nozzleOf = (sprinkler) => {
    if (!sprinkler || sprinkler.type === 'strip') return null;
    const own = sprinkler.model && Catalog.nozzles[sprinkler.model];
    if (own && own.group === sprinkler.type && Catalog.available(own.code)) return own;
    // met een gekozen behuizing altijd een nozzle uit de bibliotheek; zonder behuizing alleen
    // rotators (MP), sproeiers en rotors blijven dan generiek
    const body = sprinkler.body && Catalog.bodies[sprinkler.body] ? sprinkler.body : null;
    if (sprinkler.type !== 'rotator' && !body) return null;
    return Catalog.autoNozzle(sprinkler.type, sprinkler.r, sprinkler.arc, body);
  };

  /**
   * Rotatorkop die automatisch bij worpwijdte en sproeihoek hoort (sleutel).
   * @param {number} radius worpwijdte in meter
   * @param {number} arc sproeihoek in graden
   * @returns {string|null} sleutel van de rotatorkop
   */
  Catalog.autoRotatorModel = (radius, arc = 360) => {
    const nozzle = Catalog.autoNozzle('rotator', radius, arc);
    if (nozzle) return nozzle.key;
    // geen enkele rotatorkop in het assortiment: de passende kop (de stuklijst meldt hem als ontbrekend)
    const all = Object.values(Catalog.nozzles).filter((candidate) => candidate.group === 'rotator').sort((left, right) => left.rMax - right.rMax);
    const fit = all.find((candidate) => radius <= candidate.rMax + 1e-9) || all[all.length - 1];
    return fit ? fit.key : null;
  };

  /**
   * Gekozen (of automatische) rotatorkop van een sproeier (sleutel).
   * @param {object} sprinkler de sproeier
   * @returns {string|null} sleutel van de rotatorkop
   */
  Catalog.rotatorModelOf = (sprinkler) => (sprinkler.model && Catalog.rotatorModels[sprinkler.model] && Catalog.available(Catalog.rotatorModels[sprinkler.model].code) ? sprinkler.model : Catalog.autoRotatorModel(sprinkler.r, sprinkler.arc));

  /**
   * Sector [van, tot] van de kop waarin de sproeihoek valt (of de dichtstbijzijnde).
   * @param {string} model sleutel van de kop
   * @param {number} arc sproeihoek in graden
   * @returns {number[]} de sector [van, tot]
   */
  Catalog.rotatorArcSet = (model, arc) => arcSetOf((Catalog.nozzles[model] || Catalog.rotatorModels[model]).arcs, arc);

  /**
   * Instelbereik van een kop: worp, sectoren en de nozzle (null = generiek type).
   * @param {object} sprinkler de sproeier
   * @returns {{rMin: number, rMax: number, arcs: number[][], nozzle: object|null}} het instelbereik
   */
  Catalog.headRange = (sprinkler) => {
    const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
    const nozzle = Catalog.nozzleOf(sprinkler);
    if (!nozzle) return { rMin: sprinklerType.rMin, rMax: sprinklerType.rMax, arcs: [[10, 360]], nozzle: null };
    const range = Catalog.nozzleRange(nozzle, sprinkler);
    return { rMin: range.rMin, rMax: range.rMax, arcs: nozzle.arcs, nozzle: nozzle };
  };

  /**
   * Zet worpwijdte en sproeihoek van een kop binnen het bereik van zijn nozzle (zonder
   * gekozen nozzle bij een rotator: de nozzle die erbij past). Generieke sproeiers blijven gelijk.
   * @param {object} sprinkler de sproeier (wordt aangepast)
   * @returns {object} de sproeier (aangepast)
   */
  Catalog.fitHead = (sprinkler) => {
    if (!sprinkler || sprinkler.type === 'strip') return sprinkler;
    const nozzle = Catalog.nozzleOf(sprinkler);
    if (!nozzle) return sprinkler;
    const range = Catalog.nozzleRange(nozzle, sprinkler);
    sprinkler.r = Math.round(Math.max(range.rMin, Math.min(range.rMax, sprinkler.r || range.rMax)) * 10) / 10;
    const set = arcSetOf(nozzle.arcs, sprinkler.arc);
    sprinkler.arc = Math.round(Math.max(Math.max(10, set[0]), Math.min(set[1], sprinkler.arc)));
    return sprinkler;
  };
  Catalog.fitRotator = Catalog.fitHead;

  /**
   * Omschrijving van de instelling, bijv. "MP2000 (90–210°) op 135° en 5,2 m".
   * @param {object} sprinkler de sproeier
   * @returns {string} de omschrijving
   */
  Catalog.headSetting = (sprinkler) => {
    const nozzle = Catalog.nozzleOf(sprinkler);
    const radiusText = String(sprinkler.r).replace('.', ',');
    if (!nozzle) return `${radiusText} m · ${sprinkler.arc}°`;
    const set = arcSetOf(nozzle.arcs, sprinkler.arc);
    const sector = set[0] === set[1] ? `${set[0]}°` : `${set[0]}–${set[1]}°`;
    return `${nozzle.name} (${sector}) op ${sprinkler.arc}° en ${radiusText} m`;
  };
  Catalog.rotatorSetting = Catalog.headSetting;

  /**
   * Rotator-kop (artikel) op basis van worpwijdte (en sproeihoek).
   * @param {number} radius worpwijdte in meter
   * @param {number} arc sproeihoek in graden
   * @returns {string} artikelcode van de rotatorkop
   */
  Catalog.rotatorNozzle = (radius, arc = 360) => Catalog.rotatorModels[Catalog.autoRotatorModel(radius, arc)].code;

  /**
   * Debiet van een sproeier in l/u (met nozzle: uit de prestatietabel bij de werkdruk).
   * @param {object} sprinkler de sproeier
   * @returns {number} debiet in l/u
   */
  Catalog.sprinklerFlowLph = (sprinkler) => {
    const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
    if (!sprinklerType) return 0;
    if (sprinkler.type === 'strip') return sprinklerType.pr * sprinkler.len * sprinkler.width;
    const nozzle = Catalog.nozzleOf(sprinkler);
    if (nozzle) return Lib.flowLph(nozzle, sprinkler.r, sprinkler.arc, Catalog.headBar(sprinkler, nozzle));
    return sprinklerType.pr * sprinkler.r * sprinkler.r * (sprinkler.arc / 360);
  };

  /**
   * Neerslag (mm/u) bij kop-tot-kop: debiet gedeeld door r² × hoek/360.
   * @param {object} sprinkler de sproeier
   * @returns {number} neerslag in mm/u
   */
  Catalog.headPr = (sprinkler) => {
    const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
    if (!sprinklerType) return 0;
    if (sprinkler.type === 'strip' || !(sprinkler.r > 0) || !(sprinkler.arc > 0)) return sprinklerType.pr;
    if (!Catalog.nozzleOf(sprinkler)) return sprinklerType.pr;
    return Catalog.sprinklerFlowLph(sprinkler) / (sprinkler.r * sprinkler.r * (sprinkler.arc / 360));
  };

  /**
   * Minimaal benodigde druk aan de kop (bar).
   * @param {object} sprinkler de sproeier
   * @returns {number} druk in bar
   */
  Catalog.headMinBar = (sprinkler) => {
    const sprinklerType = Catalog.sprinklerTypes[sprinkler.type];
    const body = Catalog.bodyOf(sprinkler);
    if (body && body.regBar) return body.regBar;
    if (sprinkler.model && Catalog.nozzles[sprinkler.model]) return Catalog.nozzles[sprinkler.model].bar;
    return sprinklerType ? sprinklerType.minBar : 0;
  };

  Catalog.setLibrary(null);

  window.Catalog = Catalog;
})();
