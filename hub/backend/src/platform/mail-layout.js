// Opmaak en teksten van de e-mails van een organisatie: één instelling `mailLayout` (Beheer > Mail-opmaak) met logo,
// kop, kleuren, voet en per mailtype een eigen onderwerp en tekst met invulvelden. Hier staan de standaardteksten
// (precies de teksten die de mails altijd hadden), het schoonmaken van de instelling, het invullen van een tekst
// (`composeMail`), de e-mailveilige HTML (`renderMail`, tabellen en inline styles) en de routes van het beheerscherm.
// Alle systeemmails gaan via `renderMail`; `mailBody` in verkoop/quotes.js is daar een dunne laag omheen.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { sanitizeDocumentLayout, logoOf } = require('../verkoop/document-layout');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');
const { validEmail, mailFailure } = require('./mailer');

const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));

/** Standaardkleuren van de huisstijl als er niets is ingesteld en geen thema bekend is. */
const FALLBACK_COLORS = { navy: '#172f5e', green: '#19924f', teal: '#2cb0c0' };
/** Minimaal contrast met witte tekst: 4,5 voor de kop; 3 voor de knop (grote, vette tekst, zoals de huisstijlgroen). */
const MIN_CONTRAST = { headerColor: 4.5, buttonColor: 3 };
const MAX_FOOTER = 300;
const MAX_SUBJECT = 200;
const MAX_BODY = 4000;
const LOGO_POSITIONS = ['left', 'center'];
const HEADER_STYLES = ['band', 'plain'];
const LOGO_MODES = ['document', 'custom', 'none'];

/** De standaardinstelling: de opmaak die de mails altijd hadden, maar met het logo van Documentopmaak. */
const DEFAULTS = {
  logoMode: 'document', logo: '', logoPosition: 'left', logoHeight: 40, headerStyle: 'band',
  headerColor: '', buttonColor: '', accentColor: '', showCompanyInFooter: true, footerText: '', templates: {},
};

/** Invulvelden: naam → uitleg voor het scherm en een voorbeeldwaarde voor het voorbeeld. */
const FIELDS = {
  klant: { hint: 'naam van de klant', sample: 'Jan Jansen' },
  nummer: { hint: 'bestel-, retour- of ordernummer', sample: 'W2026-0042' },
  bedrag: { hint: 'totaalbedrag', sample: '€ 125,00' },
  bedrijf: { hint: 'naam van je bedrijf', sample: 'AquaTech Service' },
  bestelling: { hint: 'de regels van de bestelling met totalen (wordt automatisch ingevuld)', sample: 'Bestelling W2026-0042\n\n2 × Druppelslang 16 mm (DS-16)\n1 × Sproeier (SP-01)\n\nTotaal € 125,00' },
  levertijd: { hint: 'zin met de verwachte levertijd als indicatie (leeg bij afhalen of zonder levertijd)', sample: 'Verwachte levertijd: ca. 1-2 dagen. Dit is een indicatie en geen toezegging: we zijn afhankelijk van externe partijen.' },
  statuslink: { hint: 'zin met de persoonlijke link naar de bestelling (alleen voor gasten, anders leeg)', sample: 'Bekijk de status van je bestelling via deze persoonlijke link:\nhttps://voorbeeld.nl/bestelling/123/' },
  volgcode: { hint: 'volgcode van het pakket', sample: 'DPD123456' },
  volglink: { hint: 'link om het pakket te volgen', sample: 'https://tracking.voorbeeld.nl/DPD123456' },
  ophaaladres: { hint: 'ophaaladres uit je bedrijfsprofiel (leeg als dat ontbreekt)', sample: 'Voorbeeldstraat 1\n1234 AB Nunspeet' },
  bestellink: { hint: 'regel met de link naar de bestelling (alleen voor gasten)', sample: 'Je bestelling bekijken: https://voorbeeld.nl/bestelling/123/' },
  backorder: { hint: 'de nog niet geleverde artikelen (leeg als alles is geleverd)', sample: '' },
  reservering: { hint: 'zin over tot wanneer de artikelen gereserveerd blijven', sample: 'We houden de artikelen voor je gereserveerd tot 20 november 2026 om 12:00. ' },
  link: { hint: 'de link waar de klant op moet klikken', sample: 'https://voorbeeld.nl/actie/#t=abc123' },
  artikel: { hint: 'naam van het artikel', sample: 'Druppelslang 16 mm' },
  code: { hint: 'artikelnummer', sample: 'DS-16' },
  artikellink: { hint: 'regel met een link naar het artikel (leeg zonder webadres)', sample: '\n\nBekijk het artikel: https://voorbeeld.nl/zoeken/?q=DS-16' },
  instructie: { hint: 'wat de klant moet doen met de retour (retouradres, opmerking)', sample: 'Stuur de artikelen terug naar:\nVoorbeeldstraat 1\n1234 AB Nunspeet\n\nVermeld retournummer R2026-0007 in het pakket.' },
  reden: { hint: 'reden van de afwijzing', sample: 'De artikelen zijn gebruikt.' },
  specificatie: { hint: 'de retour met regels en reden (wordt automatisch ingevuld)', sample: 'Retour R2026-0007 bij bestelling W2026-0042\n\n1 × Sproeier (SP-01)\n\nReden: Past niet' },
  afhandeling: { hint: 'zin over de creditnota', sample: 'We hebben de artikelen van je retour ontvangen. Je ontvangt de creditnota van ons.' },
  contact: { hint: 'contactpersoon van de leverancier', sample: 'heer/mevrouw' },
  referentie: { hint: 'verwijzing naar hun referentie (leeg als die ontbreekt)', sample: ' (uw referentie OB-77)' },
};

/**
 * De mailtypes met een instelbare tekst. `body` bestaat uit alinea's gescheiden door een lege regel; een alinea waarvan
 * alle invulvelden leeg zijn, vervalt. `required` zijn velden zonder welke de mail zijn doel mist (de link).
 */
const TYPES = [
  { key: 'order_betaald', group: 'Bestellingen', label: 'Orderbevestiging (online betaald)', subject: 'Bevestiging van je bestelling {nummer}',
    body: 'Beste {klant},\n\nBedankt voor je bestelling en je betaling. We hebben beide ontvangen en reserveren de artikelen voor je.\n\n{bestelling}\n\n{levertijd}\n\nJe hebt {bedrag} online betaald. Je ontvangt de factuur van ons. Zodra je bestelling onderweg is of klaarstaat, laten we het je weten.\n\n{statuslink}',
    fields: ['klant', 'nummer', 'bedrag', 'bestelling', 'levertijd', 'statuslink'], note: 'De tekst over het herroepingsrecht wordt altijd automatisch onderaan toegevoegd.' },
  { key: 'order_rekening', group: 'Bestellingen', label: 'Orderbevestiging (op rekening)', subject: 'Bevestiging van je bestelling {nummer}',
    body: 'Beste {klant},\n\nBedankt voor je bestelling. We hebben hem ontvangen en reserveren de artikelen voor je.\n\n{bestelling}\n\n{levertijd}\n\nJe bestelling gaat op rekening: je ontvangt de factuur van ons. Zodra je bestelling onderweg is of klaarstaat, laten we het je weten.\n\n{statuslink}',
    fields: ['klant', 'nummer', 'bestelling', 'levertijd', 'statuslink'], note: 'De tekst over het herroepingsrecht wordt altijd automatisch onderaan toegevoegd.' },
  { key: 'verzonden_volgcode', group: 'Bestellingen', label: 'Verzonden met volgcode', subject: 'Je bestelling {nummer} is onderweg (volgcode {volgcode})',
    body: 'Beste {klant},\n\nJe bestelling {nummer} is onderweg. Volg je pakket met de code {volgcode}: {volglink}\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'volgcode', 'volglink', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'verzonden', group: 'Bestellingen', label: 'Verzonden zonder volgcode', subject: 'Je bestelling {nummer} is onderweg',
    body: 'Beste {klant},\n\nJe bestelling {nummer} is onderweg met DPD. Zodra we de volgcode hebben, sturen we hem je toe.\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'klaar_ophalen', group: 'Bestellingen', label: 'Klaar om op te halen', subject: 'Je bestelling {nummer} staat klaar',
    body: 'Beste {klant},\n\nJe bestelling {nummer} staat klaar om op te halen.\n\nOphaaladres:\n{ophaaladres}\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'ophaaladres', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'deel_verzonden_volgcode', group: 'Bestellingen', label: 'Deellevering onderweg met volgcode', subject: 'Een deel van je bestelling {nummer} is onderweg',
    body: 'Beste {klant},\n\nEen deel van je bestelling {nummer} is onderweg. Volg het pakket met de code {volgcode}: {volglink}\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'volgcode', 'volglink', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'deel_verzonden', group: 'Bestellingen', label: 'Deellevering onderweg zonder volgcode', subject: 'Een deel van je bestelling {nummer} is onderweg',
    body: 'Beste {klant},\n\nEen deel van je bestelling {nummer} is onderweg met DPD.\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'deel_klaar_ophalen', group: 'Bestellingen', label: 'Deellevering klaar om op te halen', subject: 'Een deel van je bestelling {nummer} is klaar',
    body: 'Beste {klant},\n\nEen deel van je bestelling {nummer} staat klaar om op te halen.\n\nOphaaladres:\n{ophaaladres}\n\n{bestelling}\n\n{bestellink}\n\n{backorder}',
    fields: ['klant', 'nummer', 'ophaaladres', 'bestelling', 'bestellink', 'backorder'] },
  { key: 'betalingsherinnering', group: 'Bestellingen', label: 'Betalingsherinnering (nog niet betaald)', subject: 'Je bestelling {nummer} wacht nog op betaling',
    body: 'Beste {klant},\n\nJe hebt bestelling {nummer} geplaatst, maar de betaling is nog niet afgerond, dus we hebben hem nog niet kunnen verwerken.\n\n{reservering}Reken je bestelling af ({bedrag}) via deze link:\n{link}\n\nHeb je al betaald, of wil je de bestelling niet meer? Dan hoef je niets te doen: een niet betaalde bestelling vervalt vanzelf. Antwoord op deze mail als je hulp nodig hebt. Je krijgt deze herinnering één keer.',
    fields: ['klant', 'nummer', 'bedrag', 'reservering', 'link'], required: ['link'] },
  { key: 'betalingsherinnering_mislukt', group: 'Bestellingen', label: 'Betalingsherinnering (betaling mislukt)', subject: 'Je bestelling {nummer} wacht nog op betaling',
    body: 'Beste {klant},\n\nDe betaling van je bestelling {nummer} is niet gelukt, dus we hebben hem nog niet kunnen verwerken.\n\n{reservering}Reken je bestelling af ({bedrag}) via deze link:\n{link}\n\nHeb je al betaald, of wil je de bestelling niet meer? Dan hoef je niets te doen: een niet betaalde bestelling vervalt vanzelf. Antwoord op deze mail als je hulp nodig hebt. Je krijgt deze herinnering één keer.',
    fields: ['klant', 'nummer', 'bedrag', 'reservering', 'link'], required: ['link'] },
  { key: 'weer_op_voorraad', group: 'Bestellingen', label: 'Artikel weer op voorraad', subject: '{artikel} is weer op voorraad',
    body: 'Goed nieuws,\n\n{artikel} (artikelnummer {code}) is weer te bestellen.{artikellink}\n\nJe krijgt deze mail eenmalig, omdat je bij dit artikel een voorraadmelding hebt aangevraagd. We hebben je e-mailadres daarna gewist.',
    fields: ['artikel', 'code', 'artikellink'] },
  { key: 'retour_ontvangen', group: 'Retouren', label: 'Retouraanvraag ontvangen', subject: 'We hebben je retour {nummer} ontvangen',
    body: 'Beste {klant},\n\nWe hebben je retouraanvraag ontvangen. We beoordelen hem zo snel mogelijk en laten je weten hoe je de artikelen kunt terugsturen.\n\n{specificatie}',
    fields: ['klant', 'nummer', 'specificatie'] },
  { key: 'retour_goedgekeurd', group: 'Retouren', label: 'Retour goedgekeurd', subject: 'Je retour {nummer} is goedgekeurd',
    body: 'Beste {klant},\n\nJe retour is goedgekeurd. {instructie}\n\n{specificatie}\n\nZodra we de artikelen hebben ontvangen, ontvang je de creditnota.',
    fields: ['klant', 'nummer', 'instructie', 'specificatie'] },
  { key: 'retour_afgewezen', group: 'Retouren', label: 'Retour afgewezen', subject: 'Je retour {nummer} is afgewezen',
    body: 'Beste {klant},\n\nHelaas kunnen we je retour niet accepteren.\n\nReden: {reden}\n\n{specificatie}\n\nHeb je vragen? Antwoord dan op deze mail.',
    fields: ['klant', 'nummer', 'reden', 'specificatie'] },
  { key: 'retour_afgehandeld', group: 'Retouren', label: 'Retour ontvangen en afgehandeld', subject: 'Je retour {nummer} is ontvangen en afgehandeld',
    body: 'Beste {klant},\n\n{afhandeling}\n\n{specificatie}',
    fields: ['klant', 'nummer', 'afhandeling', 'specificatie'] },
  { key: 'account_uitnodiging', group: 'Account', label: 'Klantaccount staat klaar', subject: 'Je klantaccount staat klaar',
    body: 'Beste {klant},\n\nWij hebben namens {bedrijf} een klantaccount voor je klaargezet. Kies een wachtwoord via deze link (hij werkt zeven dagen en één keer); daarna kun je inloggen in de webshop en het klantportaal:\n\n{link}\n\nVerwacht je deze mail niet? Dan kun je hem negeren.',
    fields: ['klant', 'bedrijf', 'link'], required: ['link'] },
  { key: 'account_wachtwoord', group: 'Account', label: 'Nieuw wachtwoord kiezen', subject: 'Nieuw wachtwoord kiezen',
    body: 'Beste {klant},\n\nJe hebt gevraagd om een nieuw wachtwoord voor je account bij de webshop. Kies een nieuw wachtwoord via deze link (hij werkt één uur en één keer):\n\n{link}\n\nHeb je dit niet zelf gevraagd? Dan kun je deze mail negeren; je wachtwoord blijft zoals het is.',
    fields: ['klant', 'link'], required: ['link'] },
  { key: 'account_bevestigen', group: 'Account', label: 'E-mailadres bevestigen', subject: 'Bevestig je e-mailadres',
    body: 'Beste {klant},\n\nBevestig je e-mailadres voor je account bij de webshop via deze link (hij werkt zeven dagen):\n\n{link}\n\nHeb je geen account aangemaakt? Dan kun je deze mail negeren.',
    fields: ['klant', 'link'], required: ['link'] },
  { key: 'inkooporder', group: 'Inkoop', label: 'Inkooporder naar leverancier', subject: 'Inkooporder {nummer} van {bedrijf}',
    body: 'Beste {contact},\n\nHierbij ontvangt u onze inkooporder {nummer}{referentie}. De order staat als PDF in de bijlage.\n\nWilt u de order bevestigen met de verwachte levertijd? Bij vragen kunt u op deze mail antwoorden.\n\nMet vriendelijke groet,',
    fields: ['nummer', 'bedrijf', 'contact', 'referentie'] },
];
const TYPE_BY_KEY = new Map(TYPES.map((type) => [type.key, type]));

/**
 * De lijst van mailtypes met hun velden voor het beheerscherm.
 * @returns {object[]} Per type: key, group, label, subject, body, note, required en fields ({ name, hint }).
 */
const typeList = () => TYPES.map((type) => ({
  key: type.key, group: type.group, label: type.label, subject: type.subject, body: type.body, note: type.note || '',
  required: type.required || [], fields: type.fields.map((name) => ({ name, hint: FIELDS[name].hint })),
}));

/**
 * Haalt de stuurtekens weg (geen kopregel-injectie) en kort de tekst in.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @param {boolean} multiline Of regeleinden mogen blijven (alinea's).
 * @returns {string} De schone tekst.
 */
function cleanText(value, maxLength, multiline) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
  const stripped = multiline ? text.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '') : text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return (multiline ? stripped.replace(/\n{3,}/g, '\n\n') : stripped.replace(/\s+/g, ' ')).trim().slice(0, maxLength);
}

/**
 * De velden die in een tekst staan.
 * @param {string} text De tekst met {velden}.
 * @returns {string[]} De namen, zonder dubbelen.
 */
const fieldsIn = (text) => [...new Set([...String(text).matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]))];

/**
 * Controleert een eigen tekst voor een type: alleen bekende velden van dat type, de verplichte velden aanwezig.
 * @param {object} type Het type uit TYPES.
 * @param {{ subject?: string, body?: string }} template De ingevoerde tekst.
 * @returns {string} De eerste fout als leesbare tekst, of een lege tekst.
 */
function templateProblem(type, template) {
  const subject = cleanText(template.subject, MAX_SUBJECT * 2, false);
  const body = cleanText(template.body, MAX_BODY * 2, true);
  if (subject.length > MAX_SUBJECT) return `${type.label}: het onderwerp is te lang (hoogstens ${MAX_SUBJECT} tekens).`;
  if (body.length > MAX_BODY) return `${type.label}: de tekst is te lang (hoogstens ${MAX_BODY} tekens).`;
  for (const [what, text] of [['onderwerp', subject], ['tekst', body]]) {
    const unknown = fieldsIn(text).filter((name) => !type.fields.includes(name));
    if (unknown.length) return `${type.label}: onbekend invulveld ${unknown.map((name) => `{${name}}`).join(', ')} in het ${what}. Beschikbaar: ${type.fields.map((name) => `{${name}}`).join(', ')}.`;
  }
  const missing = (type.required || []).filter((name) => !fieldsIn(body).includes(name));
  if (missing.length) return `${type.label}: de tekst moet ${missing.map((name) => `{${name}}`).join(', ')} bevatten, anders kan de klant niets doen met deze mail.`;
  return '';
}

/**
 * Maakt de eigen teksten schoon: alleen bekende types, een tekst die niet klopt vervalt (de standaard geldt dan).
 * @param {*} raw De ingevoerde teksten (type → { subject, body }).
 * @returns {object} Type → { subject, body } met alleen de afwijkingen van de standaard.
 */
function sanitizeTemplates(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  for (const type of TYPES) {
    const entry = raw[type.key];
    if (!entry || typeof entry !== 'object') continue;
    const subject = cleanText(entry.subject, MAX_SUBJECT, false);
    const body = cleanText(entry.body, MAX_BODY, true);
    if (templateProblem(type, { subject, body })) continue;
    const override = {};
    if (subject && subject !== type.subject) override.subject = subject;
    if (body && body !== type.body) override.body = body;
    if (Object.keys(override).length) clean[type.key] = override;
  }
  return clean;
}

/**
 * Maakt de mailopmaak schoon: onbekende velden vallen weg, ongeldige waarden worden de standaard.
 * @param {*} raw De ingevoerde of opgeslagen waarde.
 * @returns {object} De schone instelling met alle velden van DEFAULTS.
 */
function sanitizeMailLayout(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const logo = sanitizeDocumentLayout({ logoMode: 'custom', logo: source.logo }).logo;
  const mode = LOGO_MODES.includes(source.logoMode) ? source.logoMode : DEFAULTS.logoMode;
  const height = Number(source.logoHeight);
  /**
   * Leest een kleur en laat hem vallen als het contrast met wit te laag is.
   * @param {*} value De ingevoerde kleur.
   * @param {number} minContrast Minimaal contrast met wit (0 = geen eis).
   * @returns {string} De kleur als #rrggbb, of leeg.
   */
  const color = (value, minContrast) => {
    const hex = Theme.hex(value) || '';
    return hex && minContrast && Theme.contrast(hex, '#ffffff') < minContrast ? '' : hex;
  };
  return {
    logoMode: mode === 'custom' && !logo ? 'document' : mode,
    logo,
    logoPosition: LOGO_POSITIONS.includes(source.logoPosition) ? source.logoPosition : DEFAULTS.logoPosition,
    logoHeight: Number.isFinite(height) ? Math.min(80, Math.max(20, Math.round(height))) : DEFAULTS.logoHeight,
    headerStyle: HEADER_STYLES.includes(source.headerStyle) ? source.headerStyle : DEFAULTS.headerStyle,
    headerColor: color(source.headerColor, MIN_CONTRAST.headerColor),
    buttonColor: color(source.buttonColor, MIN_CONTRAST.buttonColor),
    accentColor: color(source.accentColor, 0),
    showCompanyInFooter: typeof source.showCompanyInFooter === 'boolean' ? source.showCompanyInFooter : DEFAULTS.showCompanyInFooter,
    footerText: cleanText(source.footerText, MAX_FOOTER, false),
    templates: sanitizeTemplates(source.templates),
  };
}

/**
 * Controleert wat `sanitizeMailLayout` stilletjes herstelt, zodat het scherm een duidelijke melding kan geven.
 * @param {*} raw De ingevoerde instelling.
 * @returns {string} De eerste fout als leesbare tekst, of een lege tekst.
 */
function layoutProblem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Ongeldige opmaak.';
  if ((raw.logoMode === 'custom' || raw.logo) && !sanitizeDocumentLayout({ logoMode: 'custom', logo: raw.logo }).logo) {
    return 'Het logo moet een PNG zijn van hoogstens 300 kB en 2400 pixels per zijde.';
  }
  for (const [field, label] of [['headerColor', 'Kopkleur'], ['buttonColor', 'Knopkleur'], ['accentColor', 'Accentkleur']]) {
    if (!raw[field]) continue;
    if (!Theme.hex(raw[field])) return `${label}: geef een kleur als #rrggbb.`;
    if (MIN_CONTRAST[field] && Theme.contrast(Theme.hex(raw[field]), '#ffffff') < MIN_CONTRAST[field]) return `${label} is te licht: witte tekst moet er goed op leesbaar blijven.`;
  }
  if (typeof raw.footerText === 'string' && raw.footerText.length > MAX_FOOTER) return `De voettekst is te lang (hoogstens ${MAX_FOOTER} tekens).`;
  if (raw.templates && typeof raw.templates === 'object') {
    for (const type of TYPES) {
      const entry = raw.templates[type.key];
      if (!entry || typeof entry !== 'object') continue;
      const problem = templateProblem(type, { subject: entry.subject, body: entry.body && String(entry.body).trim() ? entry.body : type.body });
      if (problem) return problem;
    }
  }
  return '';
}

/**
 * Vult een tekst in. Een alinea waarvan alle velden leeg zijn vervalt (bijvoorbeeld het ophaaladres zonder adres).
 * @param {string} template De tekst met {velden}.
 * @param {object} values Veldnaam → tekst.
 * @returns {string[]} De ingevulde alinea's.
 */
function fillParagraphs(template, values) {
  const result = [];
  for (const paragraph of String(template).split(/\n{2,}/)) {
    const names = fieldsIn(paragraph);
    if (names.length && names.every((name) => !String(values[name] == null ? '' : values[name]).trim())) continue;
    const filled = paragraph.replace(/\{([a-z_]+)\}/g, (_match, name) => (values[name] == null ? '' : String(values[name])));
    result.push(...filled.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean));
  }
  return result;
}

/**
 * Stelt onderwerp en alinea's van een mailtype samen uit de eigen tekst van de organisatie (of de standaard).
 * @param {object} layout De schone mailopmaak (sanitizeMailLayout), of de ruwe instelling.
 * @param {string} key Het mailtype.
 * @param {object} values Veldnaam → tekst; ontbrekende velden worden leeg.
 * @returns {{ subject: string, paragraphs: string[] }} Het onderwerp (op één regel) en de alinea's.
 */
function composeMail(layout, key, values = {}) {
  const type = TYPE_BY_KEY.get(key);
  if (!type) throw new Error(`Onbekend mailtype ${key}`);
  const override = (sanitizeTemplates({ [key]: layout && layout.templates && layout.templates[key] })[key]) || {};
  const subject = cleanText(fillParagraphs((override.subject || type.subject).replace(/\n/g, ' '), values).join(' '), MAX_SUBJECT, false)
    || cleanText(fillParagraphs(type.subject, values).join(' '), MAX_SUBJECT, false);
  return { subject, paragraphs: fillParagraphs(override.body || type.body, values) };
}

/**
 * Stelt een mailtype samen met de instellingen van een omgeving.
 * @param {{ get: Function }} settings De instellingen van de omgeving.
 * @param {string} key Het mailtype.
 * @param {object} values Veldnaam → tekst.
 * @returns {{ subject: string, paragraphs: string[] }} Onderwerp en alinea's.
 */
const composeFor = (settings, key, values) => composeMail(sanitizeMailLayout(settings.get('mailLayout')), key, values);

/**
 * Levert de kleuren van het thema van een omgeving; door server.js ingesteld (`configure`).
 * @returns {object} De kleuren (navy, green, teal), of een leeg object.
 */
let themeColorsOf = () => ({});

/**
 * Stelt in hoe de kleuren van het thema van een omgeving worden opgehaald.
 * @param {{ colorsOf?: Function }} options colorsOf(tenantId) → { navy, green, teal }.
 * @returns {void}
 */
function configure({ colorsOf } = {}) {
  if (typeof colorsOf === 'function') themeColorsOf = colorsOf;
}

/**
 * De opmaak waarmee een mail getekend wordt: kleuren (eigen, anders die van Documentopmaak, anders het thema), logo en voet.
 * @param {{ get: Function, tenantId?: string }} settings De instellingen van de omgeving.
 * @param {object} [draft] Een nog niet opgeslagen mailopmaak (voor het voorbeeld); anders de opgeslagen.
 * @returns {object} De stijl voor `renderMail`.
 */
function mailStyleOf(settings, draft) {
  const layout = sanitizeMailLayout(draft || settings.get('mailLayout'));
  const documentLayout = sanitizeDocumentLayout(settings.get('documentLayout'));
  let theme = {};
  try { theme = (settings.tenantId && themeColorsOf(settings.tenantId)) || {}; } catch { theme = {}; }
  let logo = null;
  if (layout.logoMode === 'custom') logo = logoOf({ logoMode: 'custom', logo: layout.logo, headerStyle: 'band' });
  else if (layout.logoMode === 'document') logo = logoOf({ ...documentLayout, headerStyle: layout.headerStyle });
  return {
    headerStyle: layout.headerStyle,
    headerColor: layout.headerColor || documentLayout.headerColor || theme.navy || FALLBACK_COLORS.navy,
    buttonColor: layout.buttonColor || theme.green || FALLBACK_COLORS.green,
    accentColor: layout.accentColor || documentLayout.accentColor || theme.teal || FALLBACK_COLORS.teal,
    logo: logo ? { dataUri: `data:image/png;base64,${logo.bytes.toString('base64')}`, height: layout.logoHeight, width: Math.round(layout.logoHeight * logo.ratio) } : null,
    logoPosition: layout.logoPosition,
    showCompanyInFooter: layout.showCompanyInFooter,
    footerText: layout.footerText,
  };
}

/** De stijl die de mails altijd hadden (geen logo, vaste kleuren). */
const PLAIN_STYLE = {
  headerStyle: 'band', headerColor: FALLBACK_COLORS.navy, buttonColor: FALLBACK_COLORS.green, accentColor: FALLBACK_COLORS.teal,
  logo: null, logoPosition: 'left', showCompanyInFooter: true, footerText: '',
};

/**
 * Maakt tekst veilig voor in HTML.
 * @param {*} value De tekst.
 * @returns {string} De tekst met &, <, >, " en ' vervangen.
 */
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/**
 * Stelt een e-mail in huisstijl op: platte tekst en e-mailveilige HTML (tabellen, inline styles) met kop (logo of bedrijfsnaam),
 * alinea's, optioneel een knop en een voet met de bedrijfsgegevens.
 * @param {object} profile Het bedrijfsprofiel (companyName, phone, email, website).
 * @param {string[]} paragraphs De alinea's (lege vallen weg).
 * @param {{ label: string, href: string }|null} [button] De knop, of null.
 * @param {object} [style] De stijl uit `mailStyleOf`; zonder stijl de vaste standaard.
 * @returns {{ text: string, html: string }} De twee versies van het bericht.
 */
function renderMail(profile, paragraphs, button, style = PLAIN_STYLE) {
  const look = { ...PLAIN_STYLE, ...style };
  const company = (profile && profile.companyName) || '';
  const paras = paragraphs.map((paragraph) => String(paragraph || '').trim()).filter(Boolean);
  const sign = look.showCompanyInFooter ? [company, profile && profile.phone, profile && profile.email, profile && profile.website].filter(Boolean) : [];
  const href = button && /^https?:\/\//.test(button.href) ? button.href : null;
  const text = [...paras, button ? `${button.label}: ${button.href}` : '', '', ...sign, look.footerText].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n\n');
  const band = look.headerStyle === 'band';
  const align = look.logoPosition === 'center' ? 'center' : 'left';
  const headerInk = band ? '#ffffff' : look.headerColor;
  const brand = look.logo
    ? `<img src="${look.logo.dataUri}" width="${look.logo.width}" height="${look.logo.height}" alt="${escapeHtml(company)}" style="display:block;border:0;height:${look.logo.height}px;width:${look.logo.width}px;max-width:100%${align === 'center' ? ';margin:0 auto' : ''}">`
    : `<span style="font-size:18px;font-weight:700;color:${headerInk}">${escapeHtml(company)}</span>`;
  const footerLines = [sign.length ? escapeHtml(sign.join(' · ')) : '', look.footerText ? escapeHtml(look.footerText).replace(/\n/g, '<br>') : ''].filter(Boolean).join('<br>');
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(company)}</title></head>
<body style="margin:0;background:#f4f6f9;font-family:Montserrat,Arial,sans-serif;color:#1d2733">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td align="${align}" ${band ? `bgcolor="${look.headerColor}"` : 'bgcolor="#ffffff"'} style="background:${band ? look.headerColor : '#ffffff'};padding:18px 24px;${band ? '' : `border-bottom:3px solid ${look.accentColor};`}color:${headerInk}">${brand}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">
${paras.map((paragraph) => `<p style="margin:0 0 14px">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')}
${href ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td bgcolor="${look.buttonColor}" style="background:${look.buttonColor};border-radius:6px"><a href="${escapeHtml(href)}" style="color:#ffffff;text-decoration:none;padding:12px 20px;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a></td></tr></table>` : ''}
</td></tr>
${footerLines ? `<tr><td style="padding:14px 24px;border-top:3px solid ${look.accentColor};font-size:12px;line-height:1.5;color:#6b7785">${footerLines}</td></tr>` : `<tr><td style="font-size:0;line-height:0;border-top:3px solid ${look.accentColor}">&nbsp;</td></tr>`}
</table></td></tr></table></body></html>`;
  return { text, html };
}

/**
 * De voorbeeldwaarden van een type (voor het voorbeeld en de testmail).
 * @param {object} type Het type uit TYPES.
 * @returns {object} Veldnaam → voorbeeldtekst.
 */
const sampleValues = (type) => Object.fromEntries(type.fields.map((name) => [name, FIELDS[name].sample]));

/**
 * Het voorbeeld van een mail met een (nog niet opgeslagen) opmaak, voor het scherm en de testmail.
 * @param {{ get: Function, tenantId?: string }} settings De instellingen van de omgeving.
 * @param {object} rawLayout De opmaak uit het formulier.
 * @param {string} key Het mailtype.
 * @returns {{ subject: string, text: string, html: string }} Het voorbeeld.
 */
function previewOf(settings, rawLayout, key) {
  const type = TYPE_BY_KEY.get(key);
  const layout = sanitizeMailLayout(rawLayout);
  const mail = composeMail(layout, key, sampleValues(type));
  const profile = settings.get('quoteProfile') || {};
  const rendered = renderMail(profile, mail.paragraphs, null, mailStyleOf(settings, layout));
  return { subject: mail.subject, ...rendered };
}

/**
 * Registreert de routes van het beheerscherm Mail-opmaak (recht beheer, via /api/admin).
 * @param {object} app De Express-app.
 * @param {{ settingsOf: Function, mailerFor: Function, audit: Function, requireJson: Function }} deps settingsOf(req) = instellingen van de omgeving,
 *   mailerFor(settings) = de mailer, audit(req, actie, detail), requireJson = middleware voor JSON-bodies.
 * @returns {void}
 */
function registerMailLayoutRoutes(app, { settingsOf, mailerFor, audit, requireJson }) {
  const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyFn: (req) => `mailopmaak:${req.tenantId}|${req.user ? req.user.id : clientKey(req)}` });
  const testLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `mailopmaak-test:${req.tenantId}|${req.user ? req.user.id : clientKey(req)}` });
  /**
   * Het antwoord voor het beheerscherm.
   * @param {object} req Het verzoek.
   * @returns {object} De opmaak, de standaard, de types met velden, de grenzen en de kleuren die nu gelden.
   */
  const viewOf = (req) => {
    const settings = settingsOf(req);
    const style = mailStyleOf(settings);
    return {
      layout: sanitizeMailLayout(settings.get('mailLayout')), defaults: DEFAULTS, types: typeList(),
      effective: { headerColor: style.headerColor, buttonColor: style.buttonColor, accentColor: style.accentColor, hasLogo: Boolean(style.logo) },
      limits: { footer: MAX_FOOTER, subject: MAX_SUBJECT, body: MAX_BODY },
    };
  };
  /**
   * Controleert de opmaak en het type uit een verzoek.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord (krijgt bij een fout al de 400).
   * @returns {boolean} true als alles klopt.
   */
  const valid = (req, res) => {
    const problem = layoutProblem(req.body && req.body.layout);
    if (problem) { res.status(400).json({ error: 'invalid_layout', message: problem }); return false; }
    if (req.body.type !== undefined && !TYPE_BY_KEY.has(req.body.type)) { res.status(400).json({ error: 'invalid_type', message: 'Onbekend mailtype.' }); return false; }
    return true;
  };

  app.get('/api/admin/mail-layout', (req, res) => { res.set('Cache-Control', 'no-store').json(viewOf(req)); });

  app.put('/api/admin/mail-layout', requireJson, limiter, (req, res) => {
    if (!valid(req, res)) return;
    const clean = sanitizeMailLayout(req.body.layout);
    settingsOf(req).update({ mailLayout: clean }, req.user.id);
    audit(req, 'mailopmaak_gewijzigd', { logo: clean.logoMode, kop: clean.headerStyle, teksten: Object.keys(clean.templates).length });
    res.set('Cache-Control', 'no-store').json(viewOf(req));
  });

  // Voorbeeld van één mail met de opmaak uit het formulier (nog niet opgeslagen); schrijft niets.
  app.post('/api/admin/mail-layout/preview', requireJson, limiter, (req, res) => {
    if (!valid(req, res)) return;
    res.set('Cache-Control', 'no-store').json(previewOf(settingsOf(req), req.body.layout, req.body.type || TYPES[0].key));
  });

  // Testmail naar het eigen adres van de beheerder, met de opmaak uit het formulier.
  app.post('/api/admin/mail-layout/test', requireJson, testLimiter, async (req, res) => {
    if (!valid(req, res)) return;
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Er is geen mailserver ingesteld (Beheer → Integraties → E-mail).' });
    const address = req.user && req.user.email;
    if (!validEmail(address)) return res.status(409).json({ error: 'no_email', message: 'Vul eerst je e-mailadres in bij Mijn profiel; de testmail gaat naar dat adres.' });
    const preview = previewOf(settings, req.body.layout, req.body.type || TYPES[0].key);
    try {
      await mailer.send({ to: address, subject: `Test: ${preview.subject}`, text: preview.text, html: preview.html });
    } catch (error) {
      return res.status(502).json({ error: 'send_failed', message: mailFailure(error) });
    }
    audit(req, 'mailopmaak_testmail', { type: req.body.type || TYPES[0].key });
    res.json({ sent: true, to: address });
  });
}

module.exports = {
  DEFAULTS, FIELDS, TYPES, typeList, sanitizeMailLayout, layoutProblem, templateProblem, composeMail, composeFor, fillParagraphs,
  mailStyleOf, renderMail, configure, previewOf, registerMailLayoutRoutes, PLAIN_STYLE,
};
