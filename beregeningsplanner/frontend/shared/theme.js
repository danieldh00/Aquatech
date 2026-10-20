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

  function hex(value) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return `#${h.toLowerCase()}`;
  }

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

  function luminance(h) {
    const [r, g, b] = rgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Contrastverhouding (1 tot 21) tussen twee kleuren. */
  function contrast(a, b) {
    const [l1, l2] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }

  // t = 0 geeft a, t = 1 geeft b.
  const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

  /** Alleen geldige kleuren van de bekende velden, als #rrggbb. */
  function sanitize(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of Object.keys(FIELDS)) {
      const v = hex(raw[key]);
      if (v) out[key] = v;
    }
    return out;
  }

  /** Volledige set kleuren: wat gekozen is, aangevuld met de standaard. */
  function resolve(colors) {
    return { ...DEFAULTS, ...sanitize(colors) };
  }

  // Donker groen: minstens 15% donkerder en leesbaar als tekst op wit en op
  // licht groen (4,5:1). Licht groen: 10% van de kleur op wit. Helder groen
  // (actief icoon in de zijbalk): de kleur opgehelderd tot hij op de hoofdkleur
  // opvalt.
  function derive(green, navy) {
    const g = hex(green) || DEFAULTS.green;
    const n = hex(navy) || DEFAULTS.navy;
    if (g === DEFAULTS.green && n === DEFAULTS.navy) return { ...DEFAULT_DERIVED };
    let greenLight = mix(g, WHITE, 0.3);
    for (let t = 0.35; t <= 1 && contrast(greenLight, n) < 4.5; t += 0.05) greenLight = mix(g, WHITE, t);
    if (g === DEFAULTS.green) return { ...DEFAULT_DERIVED, greenLight: contrast(DEFAULT_DERIVED.greenLight, n) >= 4.5 ? DEFAULT_DERIVED.greenLight : greenLight };
    const greenSoft = mix(g, WHITE, 0.9);
    let greenDark = mix(g, '#000000', 0.15);
    for (let t = 0.2; t <= 1 && contrast(greenDark, greenSoft) < 4.5; t += 0.05) greenDark = mix(g, '#000000', t);
    return { greenDark, greenSoft, greenLight };
  }

  /** Bezwaren tegen een keuze: [{ field, ratio, min, message }]. */
  function problems(colors) {
    const c = resolve(colors);
    const out = [];
    for (const [key, def] of Object.entries(FIELDS)) {
      const ratio = contrast(c[key], WHITE);
      if (def.min && ratio < def.min) {
        out.push({ field: key, ratio, min: def.min, message: `${def.label}: te licht voor witte tekst (contrast ${ratio.toFixed(1).replace('.', ',')}:1, minimaal ${String(def.min).replace('.', ',')}:1). Kies een donkerdere kleur.` });
      }
    }
    return out;
  }

  /** CSS-variabelen voor een keuze ({} = standaard). */
  function vars(colors) {
    const c = resolve(colors);
    const d = derive(c.green, c.navy);
    return {
      '--at-navy': c.navy,
      '--at-green': c.green,
      '--at-green-dark': d.greenDark,
      '--at-green-soft': d.greenSoft,
      '--at-green-light': d.greenLight,
      '--at-teal': c.teal,
    };
  }

  const isDefault = (colors) => Object.entries(resolve(colors)).every(([k, v]) => DEFAULTS[k] === v);

  /** Stylesheet met de variabelen; leeg bij het standaardthema. */
  function css(colors) {
    if (isDefault(colors)) return '';
    return `:root {\n${Object.entries(vars(colors)).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`;
  }

  /** Variabelen op de pagina zetten (openbare pagina's, voorbeeld). */
  function apply(v, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !v) return;
    for (const [k, val] of Object.entries(v)) if (/^--at-[a-z-]+$/.test(k) && hex(val)) d.documentElement.style.setProperty(k, hex(val));
    const meta = d.querySelector('meta[name="theme-color"]');
    if (meta && hex(v['--at-navy'])) meta.setAttribute('content', hex(v['--at-navy']));
  }

  const api = { DEFAULTS, FIELDS, hex, contrast, mix, sanitize, resolve, derive, problems, vars, css, isDefault, apply };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AquatechTheme = api;
})(typeof self !== 'undefined' ? self : this);
