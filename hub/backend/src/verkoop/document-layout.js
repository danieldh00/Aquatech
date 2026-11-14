// Opmaak van de documenten die de server als PDF maakt (factuur, pakbon): één instelling per organisatie
// (`documentLayout`, Beheer > Documentopmaak) met logo, kopstijl, kleuren, lettertype en voettekst. De kop en de
// voet worden hier getekend, zodat alle documenten er hetzelfde uitzien; invoice-pdf.js en packing-slips.js
// roepen alleen `drawHeader` en `drawFooter` aan. Ook de voorbeeld-PDF voor het beheerscherm en de routes staan hier.
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { pngImage } = require('./pdf');

const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));
const InvoiceCore = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

/** Marges van de pagina in punten; de onderrand begint waar de voettekst ophoudt. */
const MARGIN = 42;
/** Grootste logo (na ontsleutelen) in bytes en in pixels per zijde. */
const MAX_LOGO_BYTES = 300 * 1024;
const MAX_LOGO_PIXELS = 2400;
/** Verhouding (breedte/hoogte) van het standaardlogo. */
const DEFAULT_LOGO_RATIO = 321 / 66;

/** De standaardinstelling: precies de opmaak die de documenten altijd hadden (AquaTech-logo in een gekleurde balk). */
const DEFAULTS = {
  logoMode: 'default',
  logo: '',
  logoPosition: 'left',
  logoHeight: 40,
  headerStyle: 'band',
  headerColor: '',
  accentColor: '',
  font: 'sans',
  showCompanyInHeader: true,
  footerCompanyInfo: true,
  footerText: '',
  pageNumbers: true,
};

const LOGO_MODES = ['default', 'custom', 'none'];
const LOGO_POSITIONS = ['left', 'right'];
const HEADER_STYLES = ['band', 'plain'];
const FONT_CHOICES = ['sans', 'serif'];

/**
 * Leest de afmetingen van een PNG uit de kop (zonder te decomprimeren).
 * @param {Buffer} buffer Het PNG-bestand.
 * @returns {{ width: number, height: number }|null} Breedte en hoogte in pixels, of null als het geen PNG is.
 */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Haalt de PNG uit een data-adres.
 * @param {*} value Tekst als `data:image/png;base64,...`.
 * @returns {Buffer|null} De bytes, of null bij een ander formaat of een te groot bestand.
 */
function logoBytes(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof value === 'string' ? value : '');
  if (!match || match[1].length > Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 4) return null;
  const bytes = Buffer.from(match[1], 'base64');
  const size = pngSize(bytes);
  if (!size || bytes.length > MAX_LOGO_BYTES || !size.width || !size.height || size.width > MAX_LOGO_PIXELS || size.height > MAX_LOGO_PIXELS) return null;
  return bytes;
}

/**
 * Maakt de documentopmaak schoon: onbekende velden vallen weg, ongeldige waarden worden de standaard.
 * Kiest de gebruiker een eigen logo maar ontbreekt dat (of deugt het niet), dan geldt het standaardlogo.
 * @param {*} raw De ingevoerde of opgeslagen waarde.
 * @returns {object} De schone opmaak met alle velden van DEFAULTS.
 */
function sanitizeDocumentLayout(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /**
   * Kiest een waarde uit een vaste lijst.
   * @param {*} value De ingevoerde waarde.
   * @param {string[]} allowed De toegestane waarden.
   * @param {string} fallback De waarde als de invoer niet in de lijst staat.
   * @returns {string} De gekozen waarde.
   */
  const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  /**
   * Neemt een ja/nee-waarde over, anders de standaard.
   * @param {*} value De ingevoerde waarde.
   * @param {boolean} fallback De standaard.
   * @returns {boolean} De waarde.
   */
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const logo = logoBytes(source.logo) ? source.logo : '';
  const height = Number(source.logoHeight);
  const mode = choice(source.logoMode, LOGO_MODES, DEFAULTS.logoMode);
  return {
    logoMode: mode === 'custom' && !logo ? 'default' : mode,
    logo,
    logoPosition: choice(source.logoPosition, LOGO_POSITIONS, DEFAULTS.logoPosition),
    logoHeight: Number.isFinite(height) ? Math.min(80, Math.max(20, Math.round(height))) : DEFAULTS.logoHeight,
    headerStyle: choice(source.headerStyle, HEADER_STYLES, DEFAULTS.headerStyle),
    headerColor: Theme.hex(source.headerColor) || '',
    accentColor: Theme.hex(source.accentColor) || '',
    font: choice(source.font, FONT_CHOICES, DEFAULTS.font),
    showCompanyInHeader: flag(source.showCompanyInHeader, DEFAULTS.showCompanyInHeader),
    footerCompanyInfo: flag(source.footerCompanyInfo, DEFAULTS.footerCompanyInfo),
    footerText: typeof source.footerText === 'string' ? source.footerText.replace(/\r/g, '').trim().slice(0, 200) : '',
    pageNumbers: flag(source.pageNumbers, DEFAULTS.pageNumbers),
  };
}

/**
 * Controleert wat `sanitizeDocumentLayout` stilletjes herstelt, zodat het beheerscherm een duidelijke melding kan geven.
 * @param {*} raw De ingevoerde opmaak.
 * @returns {string} De eerste fout als leesbare tekst, of een lege tekst.
 */
function layoutProblem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Ongeldige opmaak.';
  if (raw.logoMode === 'custom' || raw.logo) {
    const bytes = logoBytes(raw.logo);
    if (!bytes) return `Het logo moet een PNG zijn van hoogstens ${MAX_LOGO_BYTES / 1024} kB en ${MAX_LOGO_PIXELS} pixels per zijde.`;
    if (!pngImage(bytes)) return 'Dit logo kan niet in een PDF worden gezet. Kies een gewone PNG- of JPG-afbeelding.';
  }
  for (const [field, label] of [['headerColor', 'Kopkleur'], ['accentColor', 'Accentkleur']]) {
    if (raw[field] && !Theme.hex(raw[field])) return `${label}: geef een kleur als #rrggbb.`;
  }
  if (raw.headerColor && Theme.contrast(raw.headerColor, '#ffffff') < 4.5) return 'De kopkleur is te licht: witte tekst moet er goed op leesbaar blijven.';
  return '';
}

let defaultLogoCache = null;
/**
 * Het standaardlogo (wit, voor op een gekleurde balk), één keer van schijf gelezen.
 * @returns {Buffer} De PNG, of een lege buffer als het bestand ontbreekt.
 */
function defaultLogo() {
  if (!defaultLogoCache) {
    try { defaultLogoCache = fs.readFileSync(path.join(FRONTEND_DIR, 'shared', 'logo-white.png')); } catch { defaultLogoCache = Buffer.alloc(0); }
  }
  return defaultLogoCache;
}

/**
 * Het logo dat bij deze opmaak hoort. Het standaardlogo is wit en past alleen op een gekleurde balk; bij een witte kop
 * zonder eigen logo staat de bedrijfsnaam als tekst.
 * @param {object} layout De schone opmaak.
 * @returns {{ bytes: Buffer, ratio: number }|null} Het logo met zijn verhouding breedte/hoogte, of null.
 */
function logoOf(layout) {
  if (layout.logoMode === 'none') return null;
  if (layout.logoMode === 'custom') {
    const bytes = logoBytes(layout.logo);
    const size = bytes && pngSize(bytes);
    if (size) return { bytes, ratio: size.width / size.height };
  }
  if (layout.headerStyle !== 'band') return null;
  const bytes = defaultLogo();
  return bytes.length ? { bytes, ratio: DEFAULT_LOGO_RATIO } : null;
}

/**
 * De kleuren van een document: die van het thema, met de kopkleur en accentkleur van de opmaak erover.
 * @param {object} layout De schone opmaak.
 * @param {object} [colors] Kleuren van het thema (navy, green, greenSoft, teal).
 * @returns {object} navy (kop en titels), green, greenSoft, teal (accentlijn), text, muted en line.
 */
function paletteOf(layout, colors = {}) {
  const palette = { navy: '#172f5e', green: '#19924f', greenSoft: '#e6f4ec', teal: '#2cb0c0', text: '#1d2733', muted: '#6b7785', line: '#d0d6de', ...colors };
  if (layout.headerColor) palette.navy = layout.headerColor;
  if (layout.accentColor) palette.teal = layout.accentColor;
  return palette;
}

/**
 * Tekent de kop van een pagina (de pagina moet al zijn toegevoegd): het logo aan de gekozen kant en op de eerste
 * pagina de bedrijfsgegevens aan de andere kant, op de vervolgpagina's een korte titel.
 * @param {object} pdf Het document (createPdf).
 * @param {object} layout De schone opmaak.
 * @param {{ palette: object, company: object, first: boolean, continuedTitle?: string }} options De kleuren (paletteOf), het bedrijfsprofiel, of het de eerste pagina is en de titel voor een vervolgpagina.
 * @returns {number} De hoogte van de kop in punten; de inhoud begint daaronder.
 */
function drawHeader(pdf, layout, { palette, company, first, continuedTitle = '' }) {
  const pageWidth = pdf.size.width;
  const rightEdge = pageWidth - MARGIN;
  const band = layout.headerStyle === 'band';
  const logoHeight = first ? layout.logoHeight : Math.max(16, Math.round(layout.logoHeight * 0.65));
  const headerHeight = logoHeight + (first ? 52 : 26);
  const ink = band ? '#ffffff' : palette.text;
  const softInk = band ? '#ffffff' : palette.muted;
  const logoOnLeft = layout.logoPosition === 'left';
  if (band) pdf.rect(0, 0, pageWidth, headerHeight, { fill: palette.navy });
  else pdf.line(MARGIN, headerHeight, rightEdge, headerHeight, { color: palette.navy, width: 1.6 });

  // Het logo, hoogstens 45% van de breedte; is het logo zo breed, dan wordt het lager.
  const logo = logoOf(layout);
  let logoDrawn = false;
  if (logo) {
    const width = Math.min(logoHeight * logo.ratio, (rightEdge - MARGIN) * 0.45);
    const height = width / logo.ratio;
    logoDrawn = pdf.image(logo.bytes, logoOnLeft ? MARGIN : rightEdge - width, (headerHeight - height) / 2, width, height);
  }
  if (!logoDrawn) {
    pdf.text(company.companyName, logoOnLeft ? MARGIN : rightEdge, headerHeight / 2 - 8, { size: 16, bold: true, color: ink, align: logoOnLeft ? 'left' : 'right' });
  }

  // Aan de andere kant: de bedrijfsgegevens (eerste pagina) of de titel van het vervolg.
  const detailsX = logoOnLeft ? rightEdge : MARGIN;
  const detailsAlign = logoOnLeft ? 'right' : 'left';
  if (first && layout.showCompanyInHeader) {
    const lines = [...String(company.address || '').split(/\r?\n/), [company.phone, company.email].filter(Boolean).join(' · '), company.website]
      .map((entry) => String(entry || '').trim()).filter(Boolean);
    let lineTop = 16;
    if (logoDrawn) pdf.text(company.companyName, detailsX, lineTop, { size: 10, bold: true, color: ink, align: detailsAlign });
    else lineTop = 4;
    for (const addressLine of lines.slice(0, 5)) {
      lineTop += 12.5;
      pdf.text(addressLine, detailsX, lineTop, { size: 8.5, color: softInk, align: detailsAlign });
    }
  } else if (!first && continuedTitle) {
    pdf.text(continuedTitle, detailsX, 20, { size: 10, bold: true, color: ink, align: detailsAlign });
  }
  return headerHeight;
}

/**
 * Tekent de voet van de pagina waar het document nu op staat: een accentlijn, de eigen voettekst, de bedrijfsregel
 * (KvK, btw, IBAN) en rechts het paginanummer.
 * @param {object} pdf Het document (createPdf), al op de juiste pagina gezet.
 * @param {object} layout De schone opmaak.
 * @param {{ palette: object, companyLine?: string, pageLabel?: string }} options De kleuren, de bedrijfsregel (alleen getoond als de opmaak dat wil) en het paginanummer als tekst (leeg bij één pagina).
 * @returns {void}
 */
function drawFooter(pdf, layout, { palette, companyLine = '', pageLabel = '' }) {
  const pageHeight = pdf.size.height;
  const rightEdge = pdf.size.width - MARGIN;
  pdf.line(MARGIN, pageHeight - 46, rightEdge, pageHeight - 46, { color: palette.teal, width: 1.2 });
  const lines = [
    ...(layout.footerText ? pdf.wrap(layout.footerText, rightEdge - MARGIN - 70, 7.5).slice(0, 2) : []),
    ...(layout.footerCompanyInfo && companyLine ? [companyLine] : []),
  ];
  lines.forEach((footerLine, index) => pdf.text(footerLine, MARGIN, pageHeight - 40 + index * 9.5, { size: 7.5, color: palette.muted }));
  if (layout.pageNumbers && pageLabel) pdf.text(pageLabel, rightEdge, pageHeight - 40, { size: 7.5, color: palette.muted, align: 'right' });
}

/**
 * Een voorbeeldfactuur voor het beheerscherm, met de gegevens van de organisatie zelf.
 * @returns {object} Een factuur zoals invoices.get() hem geeft.
 */
function sampleInvoice() {
  const data = InvoiceCore.sanitize({
    date: '2026-01-15',
    customer: { name: 'Familie De Vries', contact: 'Mevrouw De Vries', address: 'Voorbeeldstraat 12\n8071 AB Nunspeet', vatNumber: '' },
    reference: 'Beregening achtertuin',
    intro: 'Hartelijk dank voor uw opdracht. Hieronder vindt u de specificatie.',
    lines: [
      { description: 'Rotatorsproeier, inclusief montage', code: 'SPR-100', qty: 6, unit: 'st', price: 18.5, vat: 21 },
      { description: 'PE-buis 25 mm', code: 'BUIS-25', qty: 50, unit: 'm', price: 1.35, vat: 21 },
      { description: 'Arbeid installatie', qty: 6, unit: 'uur', price: 55, vat: 21 },
    ],
    notes: 'Dit is een voorbeeld; er is geen factuur gemaakt.',
  });
  return { id: 'voorbeeld', number: 'F2026-0001', kind: 'invoice', status: 'definitief', debtorNumber: 10001, paidAt: '', data };
}

/**
 * Een voorbeeldbestelling voor de pakbon in het beheerscherm.
 * @returns {object} Een bestelling zoals shapeFull van web-orders.js hem geeft.
 */
function sampleOrder() {
  return {
    id: 'voorbeeld', number: 'WEB-2026-0001', createdAt: '2026-01-15T10:00:00.000Z', language: 'nl', note: 'Graag bellen bij aflevering.',
    customer: { name: 'Piet de Vries', company: '', phone: '0612345678' },
    address: { street: 'Voorbeeldstraat 12', postcode: '8071 AB', city: 'Nunspeet', country: 'NL' },
    shipping: { method: 'dpd', label: 'DPD' },
    lines: [
      { name: 'Rotatorsproeier', code: 'SPR-100', qty: 6, unit: 'st' },
      { name: 'PE-buis 25 mm', code: 'BUIS-25', qty: 50, unit: 'm' },
    ],
  };
}

/**
 * Registreert de routes van het beheerscherm Documentopmaak (recht beheer, via /api/admin).
 * @param {object} app De Express-app.
 * @param {{ settingsOf: Function, colorsOf: Function, invoicePdf: Function, packingSlipsPdf: Function, audit: Function, requireJson: Function }} deps
 *   settingsOf(req) = de instellingen van de omgeving, colorsOf(tenantId) = kleuren van het thema, de twee PDF-makers, audit(req, actie, detail),
 *   requireJson = middleware voor JSON-bodies (de bodygrens voor het logo staat in server.js).
 * @returns {void}
 */
function registerDocumentLayoutRoutes(app, { settingsOf, colorsOf, invoicePdf, packingSlipsPdf, audit, requireJson }) {
  /**
   * Het antwoord voor het beheerscherm.
   * @param {object} req Het verzoek.
   * @returns {{ layout: object, defaults: object, limits: object }} De opmaak van deze organisatie, de standaard en de grenzen voor het logo.
   */
  const viewOf = (req) => ({
    layout: sanitizeDocumentLayout(settingsOf(req).get('documentLayout')),
    defaults: DEFAULTS,
    limits: { logoBytes: MAX_LOGO_BYTES, logoPixels: MAX_LOGO_PIXELS },
  });

  app.get('/api/admin/document-layout', (req, res) => { res.json(viewOf(req)); });

  app.put('/api/admin/document-layout', requireJson, (req, res) => {
    const problem = layoutProblem(req.body && req.body.layout);
    if (problem) return res.status(400).json({ error: 'invalid_layout', message: problem });
    const clean = sanitizeDocumentLayout(req.body.layout);
    settingsOf(req).update({ documentLayout: clean }, req.user.id);
    audit(req, 'documentopmaak_gewijzigd', { logo: clean.logoMode, kop: clean.headerStyle, lettertype: clean.font });
    res.json(viewOf(req));
  });

  // Voorbeeld-PDF met de opmaak uit het formulier (nog niet opgeslagen); schrijft niets.
  app.post('/api/admin/document-layout/preview', requireJson, (req, res) => {
    const problem = layoutProblem(req.body && req.body.layout);
    if (problem) return res.status(400).json({ error: 'invalid_layout', message: problem });
    const layout = sanitizeDocumentLayout(req.body.layout);
    const settings = settingsOf(req);
    const profile = settings.get('quoteProfile');
    const colors = colorsOf(req.tenantId);
    const buffer = req.body.kind === 'packing'
      ? packingSlipsPdf([sampleOrder()], { profile, colors, layout })
      : invoicePdf(sampleInvoice(), { profile, settings: settings.get('invoicing'), colors, layout });
    res.set('Cache-Control', 'no-store').type('application/pdf').send(buffer);
  });
}

module.exports = {
  DEFAULTS, MARGIN, sanitizeDocumentLayout, layoutProblem, paletteOf, drawHeader, drawFooter, logoOf, sampleInvoice, sampleOrder,
  registerDocumentLayoutRoutes,
};
