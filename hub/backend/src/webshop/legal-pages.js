// Standaardteksten van de juridische pagina's van de eigen webshop: algemene
// voorwaarden, privacyverklaring en herroepingsrecht (met modelformulier).
// De shop toont deze teksten tot de beheerder in Beheer → Webshop-inhoud een
// eigen pagina met dezelfde naam in het adres publiceert; die gaat dan voor.
// De teksten zijn een gangbare basis voor een Nederlandse webshop en horen
// door de eigenaar gecontroleerd te worden.

/**
 * Maakt een tekst veilig voor in HTML.
 * @param {*} value De tekst.
 * @returns {string} De tekst met &, <, >, " en ' vervangen.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Namen in het adres van de juridische pagina's, in de volgorde van de voet. */
const LEGAL_SLUGS = ['algemene-voorwaarden', 'privacyverklaring', 'herroepingsrecht'];
/** Titel van elke juridische pagina (ook voor de links in de voet). */
const LEGAL_TITLES = { 'algemene-voorwaarden': 'Algemene voorwaarden', privacyverklaring: 'Privacyverklaring', herroepingsrecht: 'Herroepingsrecht' };
/** Termijn (dagen) waarbinnen een consument kan herroepen; gelijk aan de retourtermijn in web-returns.js. */
const WITHDRAWAL_DAYS = 14;

/**
 * De bedrijfsgegevens als HTML-regels voor in de teksten.
 * @param {{ phone?: string, email?: string, kvk?: string, address?: string }} contact Contactgegevens uit Beheer.
 * @returns {string} Regels gescheiden door een regeleinde.
 */
function companyLines(contact) {
  return ['Aquatechshop.nl (AquaTech Service)', contact.address, contact.kvk && `K.v.k.-nummer ${contact.kvk}`, contact.email, contact.phone]
    .filter(Boolean).map((line) => escapeHtml(line)).join('<br>');
}

/**
 * De algemene voorwaarden.
 * @param {object} contact Contactgegevens uit Beheer.
 * @returns {string} HTML van de pagina.
 */
function termsBody(contact) {
  return `<p>Deze voorwaarden gelden voor elk aanbod van en elke overeenkomst met Aquatechshop.nl. Door te bestellen ga je akkoord met deze voorwaarden.</p>
<h2>1. Wie zijn wij</h2><p>${companyLines(contact)}</p>
<h2>2. Aanbod en prijzen</h2><p>Alle aanbiedingen zijn vrijblijvend zolang het artikel op voorraad is. Typefouten en kennelijke vergissingen binden ons niet. De prijzen op de webshop zijn voor consumenten inclusief btw. Zakelijke klanten zien en betalen de prijzen exclusief btw, waarna de btw bij het afrekenen wordt opgeteld of, voor een levering aan een btw-plichtige in een ander EU-land, wordt verlegd. De verzendkosten staan bij het afrekenen vermeld voordat je bestelt.</p>
<h2>3. Overeenkomst</h2><p>De overeenkomst komt tot stand op het moment dat je de bestelling plaatst. Je ontvangt direct een bevestiging per e-mail. Wij mogen een bestelling weigeren, bijvoorbeeld als een artikel niet leverbaar blijkt. Dan laten we het je zo snel mogelijk weten.</p>
<h2>4. Levering</h2><p>Wij leveren aan het adres dat je bij het afrekenen opgeeft, via DPD, of je haalt de bestelling zelf op bij ons afhaaladres. Genoemde levertijden zijn indicatief. Bij overschrijding heb je recht op ontbinding nadat je ons schriftelijk een redelijke termijn hebt gegeven om alsnog te leveren. Het risico op beschadiging of verlies gaat over op jou zodra je de artikelen hebt ontvangen.</p>
<h2>5. Betaling</h2><p>Je bestelling gaat op rekening. Je ontvangt een factuur per e-mail en betaalt die binnen de termijn die op de factuur staat. Blijft betaling uit, dan mogen wij na een herinnering wettelijke rente en incassokosten in rekening brengen.</p>
<h2>6. Herroepingsrecht</h2><p>Een consument mag een bestelling binnen ${WITHDRAWAL_DAYS} dagen na ontvangst zonder opgave van reden herroepen. Alles hierover staat op de pagina <a href="../herroepingsrecht/">Herroepingsrecht</a>, met het modelformulier. Zakelijke klanten hebben geen herroepingsrecht.</p>
<h2>7. Conformiteit en garantie</h2><p>Wij staan ervoor in dat de artikelen aan de overeenkomst beantwoorden en geschikt zijn voor normaal gebruik. Gelden er fabrieksgaranties, dan lopen die via de fabrikant. Constateer je een gebrek, meld het ons dan binnen een redelijke termijn nadat je het hebt ontdekt, bij voorkeur met foto's.</p>
<h2>8. Aansprakelijkheid</h2><p>Onze aansprakelijkheid is beperkt tot de directe schade en tot ten hoogste het factuurbedrag van de betreffende bestelling, behalve bij opzet of grove nalatigheid van onze kant. Voor consumenten blijven de dwingende wettelijke rechten onverminderd gelden.</p>
<h2>9. Klachten</h2><p>Heb je een klacht? Mail of bel ons, dan reageren wij binnen 14 dagen inhoudelijk.</p>
<h2>10. Toepasselijk recht</h2><p>Op deze voorwaarden en alle overeenkomsten is Nederlands recht van toepassing. Geschillen worden voorgelegd aan de bevoegde rechter in Nederland, tenzij de wet voor een consument anders bepaalt.</p>`;
}

/**
 * De privacyverklaring.
 * @param {object} contact Contactgegevens uit Beheer.
 * @returns {string} HTML van de pagina.
 */
function privacyBody(contact) {
  return `<p>Aquatechshop.nl gaat zorgvuldig om met je persoonsgegevens. In deze verklaring lees je welke gegevens we gebruiken en waarom.</p>
<h2>Verwerkingsverantwoordelijke</h2><p>${companyLines(contact)}</p>
<h2>Welke gegevens en waarvoor</h2>
<ul><li><strong>Account en bestelling</strong>: naam, bedrijfsnaam, e-mailadres, telefoonnummer, afleveradres, btw-nummer (zakelijk) en wat je bestelt. Dit gebruiken we om je bestelling te leveren, te factureren en je te informeren over de levering. Grondslag: uitvoering van de overeenkomst.</li>
<li><strong>Facturen en boekhouding</strong>: factuurgegevens bewaren we zeven jaar, omdat de belastingwet dat verplicht.</li>
<li><strong>Retouren en klantcontact</strong>: gegevens die je ons stuurt bij een retour of vraag, om die af te handelen.</li>
<li><strong>Beveiliging</strong>: je IP-adres gebruiken we kortstondig om misbruik en overbelasting van de webshop tegen te gaan. Grondslag: gerechtvaardigd belang.</li></ul>
<h2>Met wie delen we gegevens</h2><p>Alleen met partijen die nodig zijn voor de bestelling: DPD (bezorging, met je naam, adres en eventueel telefoonnummer en e-mailadres), onze boekhoudsoftware en onze hosting- en e-mailleveranciers. Met hen hebben we afspraken over het beveiligen van je gegevens. We verkopen geen gegevens.</p>
<h2>Cookies</h2><p>We gebruiken alleen functionele cookies: voor je winkelwagen en om je ingelogd te houden. Voor deze cookies is geen toestemming nodig. We gebruiken geen tracking- of advertentiecookies.</p>
<h2>Je rechten</h2><p>Je kunt ons vragen om inzage in, correctie of verwijdering van je gegevens, om beperking van de verwerking, of om overdracht ervan. Verwijderen kan niet voor gegevens die we wettelijk moeten bewaren. Mail ons via ${escapeHtml(contact.email || 'het adres hierboven')}; we reageren binnen een maand. Ben je het niet eens met hoe we met je gegevens omgaan, dan kun je een klacht indienen bij de Autoriteit Persoonsgegevens (autoriteitpersoonsgegevens.nl).</p>`;
}

/**
 * Het herroepingsrecht met het modelformulier.
 * @param {object} contact Contactgegevens uit Beheer.
 * @returns {string} HTML van de pagina.
 */
function withdrawalBody(contact) {
  return `<p>Dit gaat over bestellingen van consumenten. Zakelijke klanten hebben geen herroepingsrecht.</p>
<h2>Bedenktijd van ${WITHDRAWAL_DAYS} dagen</h2><p>Je mag een bestelling binnen ${WITHDRAWAL_DAYS} dagen na ontvangst zonder opgave van reden herroepen. De termijn begint de dag nadat jij (of een door jou aangewezen derde) de artikelen hebt ontvangen. Bestelde je meerdere artikelen die apart worden bezorgd, dan begint de termijn bij het laatste artikel.</p>
<h2>Zo doe je dat</h2><p>Log in op je account, open de bestelling onder <em>Mijn bestellingen</em> en kies <em>Retour aanvragen</em>. Je kunt ook het modelformulier hieronder invullen en mailen naar ${escapeHtml(contact.email || 'ons e-mailadres')}. Na goedkeuring ontvang je van ons het retouradres. Stuur de artikelen binnen ${WITHDRAWAL_DAYS} dagen nadat je hebt herroepen terug, ongebruikt en het liefst in de originele verpakking.</p>
<h2>Kosten en terugbetaling</h2><p>De kosten van het terugsturen zijn voor jou. Wij betalen het aankoopbedrag, inclusief de standaard verzendkosten van de heenzending, binnen ${WITHDRAWAL_DAYS} dagen terug nadat wij je herroeping hebben ontvangen. We mogen wachten met terugbetalen tot we de artikelen terug hebben of je hebt aangetoond dat je ze hebt teruggestuurd. De terugbetaling verwerken we met een creditnota bij je factuur.</p>
<h2>Waardevermindering</h2><p>Is het artikel meer gebruikt dan nodig om de aard en werking vast te stellen, dan kunnen wij de waardevermindering op de terugbetaling in mindering brengen.</p>
<h2>Uitzonderingen</h2><p>Geen herroepingsrecht bestaat bij artikelen die wij voor jou op maat maken of naar jouw wens samenstellen, en bij artikelen die door hun aard niet kunnen worden teruggestuurd of snel kunnen bederven.</p>
<h2>Modelformulier voor herroeping</h2>
<p>(Vul dit formulier alleen in en stuur het terug als je de overeenkomst wilt herroepen.)</p>
<blockquote><p>Aan: ${companyLines(contact)}</p>
<p>Ik/Wij (*) deel(en) u hierbij mede dat ik/wij (*) onze overeenkomst betreffende de verkoop van de volgende producten herroep(en): ........................................</p>
<p>Besteld op (*) / ontvangen op (*): ........................</p>
<p>Bestelnummer: ........................</p>
<p>Naam consument(en): ........................</p>
<p>Adres consument(en): ........................</p>
<p>Handtekening van consument(en) (alleen wanneer dit formulier op papier wordt ingediend): ........................</p>
<p>Datum: ........................</p>
<p>(*) Doorhalen wat niet van toepassing is.</p></blockquote>`;
}

/**
 * De standaardpagina's, met de bedrijfsgegevens ingevuld.
 * @param {{ phone?: string, email?: string, kvk?: string, address?: string }} contact Contactgegevens uit Beheer.
 * @returns {Object<string, { slug: string, title: string, description: string, body: string }>} Per naam in het adres de pagina.
 */
function legalDefaults(contact) {
  return {
    'algemene-voorwaarden': { slug: 'algemene-voorwaarden', title: 'Algemene voorwaarden', description: 'De algemene voorwaarden van Aquatechshop.nl.', body: termsBody(contact) },
    privacyverklaring: { slug: 'privacyverklaring', title: 'Privacyverklaring', description: 'Hoe Aquatechshop.nl omgaat met je persoonsgegevens.', body: privacyBody(contact) },
    herroepingsrecht: { slug: 'herroepingsrecht', title: 'Herroepingsrecht', description: 'Je bedenktijd en het modelformulier voor herroeping bij Aquatechshop.nl.', body: withdrawalBody(contact) },
  };
}

module.exports = { LEGAL_SLUGS, LEGAL_TITLES, WITHDRAWAL_DAYS, legalDefaults };
