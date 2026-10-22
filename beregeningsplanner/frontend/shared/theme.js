// Kleurthema van de app, gedeeld door de server (require) en de browser
// (window.AquatechTheme). Een hoofdbeheerder kiest drie kleuren in Hoofdbeheer;
// de rest (donker groen voor hover/tekst, licht groen voor vlakken) wordt
// daaruit afgeleid. Zonder keuze geldt de huisstijl van AquaTech Service.
//
// De server levert het actieve thema als shared/theme.css (CSS-variabelen
// --at-*, zie brand.css). Openbare pagina's (offerte, afspraak) krijgen het
// thema van de tenant in hun API-antwoord en zetten het met apply().
(function (root) {
  const DEFAULTS = { navy: '#172f5e', green: '#19924f', teal: '#2cb0c0' };
  // Afgeleide kleuren van het standaardthema, precies zoals in brand.css.
  const DEFAULT_DERIVED = { greenDark: '#137a41', greenSoft: '#e7f5ed', greenLight: '#5fd08f' };

  // min = minimale contrastverhouding met wit (WCAG 2.1). Op navy en groen
  // staat witte tekst: navy draagt kopteksten en balken (AA, 4,5:1), groen de
  // vette tekst op knoppen (AA voor grote/vette tekst en bedieningselementen,
  // 3:1). Teal is alleen een accent (randen, focusrand) zonder eis.
  const FIELDS = {
    navy: { label: 'Hoofdkleur', help: 'Kopbalk, zijbalk en koppen; witte tekst erop.', min: 4.5 },
    green: { label: 'Actiekleur', help: 'Knoppen en voortgang; witte tekst erop.', min: 3 },
    teal: { label: 'Accentkleur', help: 'Randen, focusrand en kleine accenten.', min: 0 },
  };
  const WHITE = '#ffffff';

  /**
   * Maakt van een kleur een nette #rrggbb (ook #rgb en zonder #).
   * @param {*} value De kleur als tekst.
   * @returns {string|null} De kleur als #rrggbb, of null als het geen kleur is.
   */
  function hex(value) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value == null ? '' : value).trim());
    if (!match) return null;
    const digits = match[1].length === 3 ? match[1].replace(/./g, (character) => character + character) : match[1];
    return `#${digits.toLowerCase()}`;
  }

  /**
   * Zet een #rrggbb-kleur om naar rood, groen en blauw.
   * @param {string} color Kleur als #rrggbb.
   * @returns {number[]} [rood, groen, blauw], elk 0–255.
   */
  const rgb = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  /**
   * Zet rood, groen en blauw om naar #rrggbb (afgerond en begrensd op 0–255).
   * @param {number[]} channels [rood, groen, blauw].
   * @returns {string} De kleur als #rrggbb.
   */
  const toHex = (channels) => `#${channels.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;

  /**
   * Relatieve helderheid volgens WCAG 2.1.
   * @param {string} color Kleur als #rrggbb.
   * @returns {number} Helderheid van 0 (zwart) tot 1 (wit).
   */
  function luminance(color) {
    const [red, green, blue] = rgb(color).map((channel) => channel / 255).map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  /**
   * Contrastverhouding tussen twee kleuren.
   * @param {string} firstColor Eerste kleur.
   * @param {string} secondColor Tweede kleur.
   * @returns {number} Verhouding van 1 tot 21.
   */
  function contrast(firstColor, secondColor) {
    const [lighter, darker] = [luminance(hex(firstColor)), luminance(hex(secondColor))].sort((left, right) => right - left);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Mengt twee kleuren: fraction 0 geeft fromColor, 1 geeft toColor.
   * @param {string} fromColor Beginkleur als #rrggbb.
   * @param {string} toColor Eindkleur als #rrggbb.
   * @param {number} fraction Aandeel van toColor (0–1).
   * @returns {string} De gemengde kleur als #rrggbb.
   */
  const mix = (fromColor, toColor, fraction) => toHex(rgb(fromColor).map((channel, i) => channel + (rgb(toColor)[i] - channel) * fraction));

  /**
   * Houdt alleen geldige kleuren van de bekende velden over, als #rrggbb.
   * @param {object} raw Invoer, bijv. { navy, green, teal }.
   * @returns {object} De geldige kleuren.
   */
  function sanitize(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of Object.keys(FIELDS)) {
      const color = hex(raw[key]);
      if (color) out[key] = color;
    }
    return out;
  }

  /**
   * Volledige set kleuren: wat gekozen is, aangevuld met de standaard.
   * @param {object} colors De keuze.
   * @returns {{navy: string, green: string, teal: string}} Alle drie de kleuren.
   */
  function resolve(colors) {
    return { ...DEFAULTS, ...sanitize(colors) };
  }

  /**
   * Leidt de extra groentinten af uit actiekleur en hoofdkleur. Donker groen:
   * minstens 15% donkerder en leesbaar als tekst op wit en op licht groen
   * (4,5:1). Licht groen: 10% van de kleur op wit. Helder groen (actief icoon in
   * de zijbalk): de kleur opgehelderd tot hij op de hoofdkleur opvalt.
   * @param {string} green Actiekleur.
   * @param {string} navy Hoofdkleur.
   * @returns {{greenDark: string, greenSoft: string, greenLight: string}} De afgeleide kleuren.
   */
  function derive(green, navy) {
    const greenHex = hex(green) || DEFAULTS.green;
    const navyHex = hex(navy) || DEFAULTS.navy;
    if (greenHex === DEFAULTS.green && navyHex === DEFAULTS.navy) return { ...DEFAULT_DERIVED };
    let greenLight = mix(greenHex, WHITE, 0.3);
    for (let fraction = 0.35; fraction <= 1 && contrast(greenLight, navyHex) < 4.5; fraction += 0.05) greenLight = mix(greenHex, WHITE, fraction);
    if (greenHex === DEFAULTS.green) return { ...DEFAULT_DERIVED, greenLight: contrast(DEFAULT_DERIVED.greenLight, navyHex) >= 4.5 ? DEFAULT_DERIVED.greenLight : greenLight };
    const greenSoft = mix(greenHex, WHITE, 0.9);
    let greenDark = mix(greenHex, '#000000', 0.15);
    for (let fraction = 0.2; fraction <= 1 && contrast(greenDark, greenSoft) < 4.5; fraction += 0.05) greenDark = mix(greenHex, '#000000', fraction);
    return { greenDark, greenSoft, greenLight };
  }

  /**
   * Bezwaren tegen een keuze (te weinig contrast met witte tekst).
   * @param {object} colors De keuze.
   * @returns {Array<{field: string, ratio: number, min: number, message: string}>} Leeg als alles goed is.
   */
  function problems(colors) {
    const resolved = resolve(colors);
    const out = [];
    for (const [key, field] of Object.entries(FIELDS)) {
      const ratio = contrast(resolved[key], WHITE);
      if (field.min && ratio < field.min) {
        out.push({ field: key, ratio, min: field.min, message: `${field.label}: te licht voor witte tekst (contrast ${ratio.toFixed(1).replace('.', ',')}:1, minimaal ${String(field.min).replace('.', ',')}:1). Kies een donkerdere kleur.` });
      }
    }
    return out;
  }

  /**
   * CSS-variabelen voor een keuze ({} = standaard).
   * @param {object} colors De keuze.
   * @returns {object} Variabelen --at-* met hun kleur.
   */
  function vars(colors) {
    const resolved = resolve(colors);
    const derived = derive(resolved.green, resolved.navy);
    return {
      '--at-navy': resolved.navy,
      '--at-green': resolved.green,
      '--at-green-dark': derived.greenDark,
      '--at-green-soft': derived.greenSoft,
      '--at-green-light': derived.greenLight,
      '--at-teal': resolved.teal,
    };
  }

  /**
   * Geeft aan of de keuze gelijk is aan het standaardthema.
   * @param {object} colors De keuze.
   * @returns {boolean} true bij het standaardthema.
   */
  const isDefault = (colors) => Object.entries(resolve(colors)).every(([key, value]) => DEFAULTS[key] === value);

  /**
   * Stylesheet met de variabelen; leeg bij het standaardthema.
   * @param {object} colors De keuze.
   * @returns {string} CSS met een :root-blok.
   */
  function css(colors) {
    if (isDefault(colors)) return '';
    return `:root {\n${Object.entries(vars(colors)).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;
  }

  /**
   * Zet de variabelen op de pagina (openbare pagina's, voorbeeld).
   * @param {object} variables Variabelen --at-* met hun kleur.
   * @param {Document} [targetDocument] De pagina (standaard het huidige document).
   */
  function apply(variables, targetDocument) {
    const page = targetDocument || (typeof document !== 'undefined' ? document : null);
    if (!page || !variables) return;
    for (const [name, value] of Object.entries(variables)) if (/^--at-[a-z-]+$/.test(name) && hex(value)) page.documentElement.style.setProperty(name, hex(value));
    const meta = page.querySelector('meta[name="theme-color"]');
    if (meta && hex(variables['--at-navy'])) meta.setAttribute('content', hex(variables['--at-navy']));
  }

  const api = { DEFAULTS, FIELDS, hex, contrast, mix, sanitize, resolve, derive, problems, vars, css, isDefault, apply };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AquatechTheme = api;
})(typeof self !== 'undefined' ? self : this);
