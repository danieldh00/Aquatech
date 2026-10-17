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
   *   Q [l/h] = PR [mm/h] * r² [m²] * boog / 360
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
      label: 'Multistream rotator (MP-type)',
      short: 'Rotator',
      group: 'rotator',
      rMin: 2.5, rMax: 10.7, rDefault: 6.0,
      pr: 10, minBar: 2.8, optBar: 2.8,
      color: '#2ca02c',
      note: 'Lage, gelijke neerslag; minder afspoeling. Huis met drukregeling 2,8 bar.',
    },
    rotor: {
      label: 'Turbineregner (getrieberegner)',
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
    rotor: { label: 'Turbineregners', pr: 13 },
    drip: { label: 'Druppelirrigatie', pr: null },
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
    bed: { label: 'Beplanting / border', fill: 'rgba(141,110,99,0.35)', stroke: '#6d4c41', irrigate: 'drip' },
    hedge: { label: 'Haag', fill: 'rgba(27,94,32,0.45)', stroke: '#1b5e20', irrigate: 'drip' },
    wet: { label: 'Mag nat worden', fill: 'rgba(144,202,249,0.30)', stroke: '#64b5f6', irrigate: null },
    dry: { label: 'Moet droog blijven (huis, terras)', fill: 'rgba(158,158,158,0.45)', stroke: '#616161', irrigate: null },
  };

  /** Systeemelementen. */
  C.elementTypes = {
    source: { label: 'Wateraansluiting', short: 'W', color: '#0277bd', single: true },
    controller: { label: 'Besturing (computer)', short: 'B', color: '#455a64', single: true },
    valvebox: { label: 'Ventielkast', short: 'V', color: '#ef6c00', single: true },
    outlet: { label: 'Waterpunt / tappunt', short: 'T', color: '#00838f', single: false },
  };

  /** Uitvoeringsniveaus voor de stuklijst. */
  C.levels = {
    eco: { label: 'Eco', desc: 'Functioneel en voordelig' },
    expert: { label: 'Expert', desc: 'Aanbevolen: wifi-besturing, flexibele aansluitingen' },
    premium: { label: 'Premium', desc: 'Topkwaliteit met sensoren en extra comfort' },
  };

  /** Artikelen: code -> {omschrijving, eenheid, prijs}. */
  C.articles = {
    'SPR-POP10': { name: 'Pop-up sproeierhuis 10 cm', unit: 'st', price: 4.5 },
    'SPR-POP10-PRS': { name: 'Pop-up sproeierhuis 10 cm met drukregeling (2,1 bar)', unit: 'st', price: 7.9 },
    'SPR-VAN': { name: 'Verstelbare sproeikop (boog 0–360°)', unit: 'st', price: 3.2 },
    'ROT-POP10-PRS': { name: 'Pop-up huis 10 cm met drukregeling 2,8 bar (rotator)', unit: 'st', price: 8.9 },
    'ROT-MP1000': { name: 'Rotator kop 2,5–4,5 m', unit: 'st', price: 9.5 },
    'ROT-MP2000': { name: 'Rotator kop 4,0–6,4 m', unit: 'st', price: 9.5 },
    'ROT-MP3000': { name: 'Rotator kop 6,7–9,1 m', unit: 'st', price: 9.5 },
    'ROT-MP3500': { name: 'Rotator kop 9,4–10,7 m', unit: 'st', price: 10.5 },
    'ROT-STRIP': { name: 'Rotator strookkop (zijstrook)', unit: 'st', price: 9.5 },
    'TURB-10': { name: 'Turbineregner pop-up 10 cm, 7–14 m', unit: 'st', price: 17.5 },
    'TURB-10-PRO': { name: 'Turbineregner pop-up 10 cm, RVS-stijgbuis, 7–14 m', unit: 'st', price: 27.5 },
    'CON-ECO': { name: 'Sproeieraansluiting: zadel/T-stuk met ½" buitendraad', unit: 'st', price: 1.9 },
    'CON-FLEX': { name: 'Flexibele aansluitset (swing pipe 0,5 m + 2 koppelingen)', unit: 'set', price: 3.6 },
    'CON-FLEX-TURB': { name: 'Flexibele aansluitset ¾" turbineregner', unit: 'set', price: 4.6 },
    'PE-25': { name: 'PE-buis 25 mm PN6', unit: 'm', price: 0.85 },
    'PE-32': { name: 'PE-buis 32 mm PN6', unit: 'm', price: 1.25 },
    'PE-40': { name: 'PE-buis 40 mm PN6', unit: 'm', price: 1.95 },
    'PE-50': { name: 'PE-buis 50 mm PN6', unit: 'm', price: 2.95 },
    'FIT-T-25': { name: 'Knel T-stuk 25 mm', unit: 'st', price: 2.4 },
    'FIT-T-32': { name: 'Knel T-stuk 32 mm', unit: 'st', price: 3.4 },
    'FIT-T-40': { name: 'Knel T-stuk 40 mm', unit: 'st', price: 5.2 },
    'FIT-T-50': { name: 'Knel T-stuk 50 mm', unit: 'st', price: 7.9 },
    'FIT-RED': { name: 'Knel verloopkoppeling (reductie)', unit: 'st', price: 2.9 },
    'FIT-L-25': { name: 'Knel knie 90° 25 mm', unit: 'st', price: 2.0 },
    'FIT-L-32': { name: 'Knel knie 90° 32 mm', unit: 'st', price: 2.9 },
    'FIT-END-25': { name: 'Knel eindkap 25 mm', unit: 'st', price: 1.4 },
    'FIT-END-32': { name: 'Knel eindkap 32 mm', unit: 'st', price: 1.9 },
    'FIT-ADAPT': { name: 'Knel koppeling met buitendraad (ventielaansluiting)', unit: 'st', price: 1.9 },
    'VAL-24V': { name: 'Magneetventiel 1" 24 VAC', unit: 'st', price: 24.5 },
    'VAL-24V-FC': { name: 'Magneetventiel 1" 24 VAC met debietregeling', unit: 'st', price: 34.5 },
    'VAL-MANIFOLD': { name: 'Ventielverdeler (koppelstuk per ventiel)', unit: 'st', price: 4.5 },
    'BOX-STD': { name: 'Ventielkast standaard (max. 3 ventielen)', unit: 'st', price: 22.0 },
    'BOX-JUMBO': { name: 'Ventielkast jumbo (max. 6 ventielen)', unit: 'st', price: 39.0 },
    'CTRL-ECO': { name: 'Beregeningscomputer binnenmodel', unit: 'st', price: 69.0 },
    'CTRL-WIFI': { name: 'Beregeningscomputer wifi (app-bediening, weerdata)', unit: 'st', price: 179.0 },
    'SEN-RAIN': { name: 'Regensensor', unit: 'st', price: 29.0 },
    'SEN-SOIL': { name: 'Bodemvochtsensor', unit: 'st', price: 89.0 },
    'CAB-7': { name: 'Stuurkabel 7-aderig (ondergronds)', unit: 'm', price: 0.95 },
    'CAB-13': { name: 'Stuurkabel 13-aderig (ondergronds)', unit: 'm', price: 1.65 },
    'CAB-CON': { name: 'Waterdichte kabelverbinder', unit: 'st', price: 0.9 },
    'MAIN-VALVE': { name: 'Hoofdafsluiter met aftapkraan (vorstvrij aftappen)', unit: 'st', price: 14.5 },
    'BACKFLOW': { name: 'Terugstroombeveiliging (klasse volgens NEN-EN 1717 / Waterwerkblad)', unit: 'st', price: 39.0 },
    'FILTER': { name: 'Hoofdfilter 1" 130 µm', unit: 'st', price: 19.5 },
    'OUTLET': { name: 'Waterpunt in grondkastje met snelkoppeling', unit: 'st', price: 29.0 },
    'DRIP-16': { name: 'Druppelslang 16 mm, 2,2 l/h, 33 cm', unit: 'm', price: 0.55 },
    'DRIP-PRV': { name: 'Drukregelaar 1,5 bar + filter (druppelzone)', unit: 'st', price: 16.5 },
    'DRIP-T': { name: 'T-stuk 16 mm druppelslang', unit: 'st', price: 0.6 },
    'DRIP-END': { name: 'Eindstop 16 mm', unit: 'st', price: 0.35 },
    'DRIP-ADAPT': { name: 'Overgang PE 25 mm naar 16 mm', unit: 'st', price: 1.5 },
    'DRIP-PIN': { name: 'Grondpen voor druppelslang', unit: 'st', price: 0.12 },
    'DRIP-FLUSH': { name: 'Spoelventiel 16 mm (automatisch)', unit: 'st', price: 2.5 },
    'TAPE': { name: 'Teflontape', unit: 'rol', price: 1.2 },
  };

  /** Rotator-kop op basis van worpwijdte. */
  C.rotatorNozzle = (r) => {
    if (r <= 4.5) return 'ROT-MP1000';
    if (r <= 6.5) return 'ROT-MP2000';
    if (r <= 9.2) return 'ROT-MP3000';
    return 'ROT-MP3500';
  };

  /** Debiet van een sproeier in l/h. */
  C.sprinklerFlowLph = (s) => {
    const t = C.sprinklerTypes[s.type];
    if (!t) return 0;
    if (s.type === 'strip') return t.pr * s.len * s.width;
    return t.pr * s.r * s.r * (s.arc / 360);
  };

  window.Catalog = C;
})();
