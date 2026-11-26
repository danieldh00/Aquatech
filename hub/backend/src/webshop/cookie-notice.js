// De cookieverklaring van de eigen webshop: per dienst en per cookie wat er wordt gebruikt (aanbieder, doel, cookienamen,
// bewaartermijn, doorgifte buiten de EU, privacybeleid van de aanbieder). De tekst wordt afgeleid van wat er in de shop
// aan staat: Google Analytics en Microsoft Clarity alleen als ze zijn ingesteld, het bestellen als gast en de onzichtbare
// captcha alleen als ze actief zijn. Er staat dus nooit een dienst in die de shop niet laadt.

/**
 * Maakt een tekst veilig voor in HTML.
 * @param {*} value De tekst.
 * @returns {string} De tekst met &, <, >, " en ' vervangen.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wat de shop gebruikt als alles aan staat; de standaardtekst in Beheer > Webshop-inhoud begint hiermee. */
const ALL_SERVICES = { analytics: true, clarity: true, captcha: true, guestOrders: true, onlinePayment: true };

/**
 * Een kaart met de gegevens van één dienst of cookie, als kop met een lijst eronder.
 * @param {string} title Naam van de dienst of cookie.
 * @param {Array<[string, string]>} facts Paren van label en HTML-tekst (de tekst is al veilig).
 * @returns {string} HTML.
 */
function factsBlock(title, facts) {
  return `<h3>${escapeHtml(title)}</h3><ul>${facts.map(([label, text]) => `<li><strong>${escapeHtml(label)}:</strong> ${text}</li>`).join('')}</ul>`;
}

/**
 * De noodzakelijke cookies en opslag in de browser van de shop zelf.
 * @param {{ analytics?: boolean, clarity?: boolean, guestOrders?: boolean }} services Wat de shop gebruikt.
 * @returns {string} HTML.
 */
function necessarySection(services) {
  const blocks = [
    factsBlock('aquatech_winkelwagen (cookie)', [['Doel', 'Onthoudt de artikelen en aantallen in je winkelwagen.'], ['Bewaartermijn', '30 dagen.'], ['Aanbieder', 'AquaTech Shop zelf (eerste partij).']]),
    factsBlock('aquatech_laatste_lijst (cookie)', [['Doel', 'Onthoudt de laatst bekeken categorie of productgroep, zodat <em>Verder winkelen</em> daarheen terugkeert. Er worden geen zoektermen in bewaard.'], ['Bewaartermijn', 'Tot je de browser sluit.'], ['Aanbieder', 'AquaTech Shop zelf.']]),
    factsBlock('aquatech_session (cookie)', [['Doel', 'Houdt je ingelogd in je account. Via een beveiligde verbinding heet de cookie __Host-aquatech_session. Alleen aanwezig als je inlogt.'], ['Bewaartermijn', 'Hoogstens 30 dagen, korter als je een tijd niet actief bent.'], ['Aanbieder', 'AquaTech Shop zelf.']]),
  ];
  if (services.guestOrders) blocks.push(factsBlock('aquatech_gastbestelling (cookie)', [['Doel', 'Geeft je als gast toegang tot je eigen bestelling na het afrekenen. Via een beveiligde verbinding heet de cookie __Host-aquatech_gastbestelling. Alleen aanwezig als je als gast bestelt.'], ['Bewaartermijn', '180 dagen.'], ['Aanbieder', 'AquaTech Shop zelf.']]));
  if (services.analytics || services.clarity) blocks.push(factsBlock('aquatech_shop_consent (opslag in je browser)', [['Doel', 'Bewaart je cookiekeuze, met de datum en de versie van deze tekst, zodat we je niet bij elk bezoek opnieuw vragen.'], ['Bewaartermijn', 'Tot je je keuze wijzigt of je browsergegevens wist.'], ['Aanbieder', 'AquaTech Shop zelf.']]));
  return `<h2>Noodzakelijke cookies (functioneel)</h2><p>Deze cookies zijn nodig om de webshop te laten werken. Ze volgen je niet, delen niets met andere partijen en hebben geen toestemming nodig.</p>${blocks.join('')}`;
}

/**
 * De analytische diensten, alleen als ze aan staan.
 * @param {{ analytics?: boolean, clarity?: boolean }} services Wat de shop gebruikt.
 * @returns {string} HTML.
 */
function analyticsSection(services) {
  if (!services.analytics && !services.clarity) return '<h2>Analytische cookies</h2><p>Op dit moment gebruiken we geen analytische diensten en plaatsen we dus ook geen analytische cookies.</p>';
  const blocks = [];
  if (services.analytics) {
    blocks.push(factsBlock('Google Analytics 4', [
      ['Aanbieder', 'Google Ireland Limited (Google LLC in de Verenigde Staten).'],
      ['Doel', 'Anoniem meten hoe de webshop wordt gebruikt: welke pagina\'s en artikelen worden bekeken, wat er in de winkelwagen gaat en waar bezoekers afhaken, om de webshop te verbeteren. We meten nooit je naam, e-mailadres of adres. Je bestelling telt mee als aankoop (het bestelnummer en het bedrag), zonder gegevens over jou.'],
      ['Cookies', '_ga en _ga_ gevolgd door het meet-ID. De opslag aquatech_shop_purchased in je browser onthoudt welke bestellingen al zijn doorgegeven, zodat een aankoop niet dubbel telt.'],
      ['Bewaartermijn', 'De cookies 2 jaar. De gegevens in Google Analytics zelf hoogstens 14 maanden (de termijn die wij daar hebben ingesteld).'],
      ['Instellingen', 'Alleen analytische opslag. Advertentieopslag staat uit, er worden geen advertentiegegevens gebruikt en Google Signals staat uit.'],
      ['Buiten de EU', 'Google kan gegevens in de Verenigde Staten verwerken, onder het EU-VS Data Privacy Framework en standaardcontractbepalingen.'],
      ['Privacybeleid', '<a href="https://policies.google.com/privacy" rel="noopener noreferrer">policies.google.com/privacy</a>'],
      ['Categorie', 'Analytisch, alleen met jouw toestemming.'],
    ]));
  }
  if (services.clarity) {
    blocks.push(factsBlock('Microsoft Clarity', [
      ['Aanbieder', 'Microsoft Corporation (Microsoft Ireland Operations Limited in Europa).'],
      ['Doel', 'Schermopnames en heatmaps van het gebruik van de webshop, om te zien waar bezoekers vastlopen. Alles wat je in een invoerveld typt wordt gemaskeerd en dus niet opgenomen; ook pagina\'s waar persoonlijke gegevens kunnen staan worden gemaskeerd. Medewerkers van de webshop worden niet opgenomen.'],
      ['Cookies', '_clck (ongeveer 1 jaar), _clsk (1 dag), CLID (1 jaar), MUID (ongeveer 1 jaar), ANONCHK (10 minuten), MR (7 dagen) en SM (tot je de browser sluit).'],
      ['Bewaartermijn', 'Opnames 30 dagen, heatmaps tot 13 maanden, daarna verwijdert Microsoft ze.'],
      ['Instellingen', 'Alleen analytische opslag. Advertentieopslag staat uit.'],
      ['Buiten de EU', 'Microsoft kan gegevens in de Verenigde Staten verwerken, onder het EU-VS Data Privacy Framework en standaardcontractbepalingen.'],
      ['Privacybeleid', '<a href="https://privacy.microsoft.com/nl-nl/privacystatement" rel="noopener noreferrer">privacy.microsoft.com/nl-nl/privacystatement</a>'],
      ['Categorie', 'Analytisch, alleen met jouw toestemming.'],
    ]));
  }
  return `<h2>Analytische cookies (alleen met toestemming)</h2><p>Deze diensten laden we pas nadat je op <em>Accepteren</em> hebt gedrukt. Zonder toestemming wordt er niets van deze partijen geladen en worden hun cookies niet geplaatst. Trek je je toestemming in, dan stoppen ze direct en verwijderen we hun cookies van deze site.</p>${blocks.join('')}`;
}

/**
 * Diensten van anderen die zonder cookie van ons werken, alleen als de shop ze gebruikt.
 * @param {{ captcha?: boolean, onlinePayment?: boolean }} services Wat de shop gebruikt.
 * @returns {string} HTML, leeg als de shop geen van deze diensten gebruikt.
 */
function thirdPartySection(services) {
  const blocks = [];
  if (services.captcha) {
    blocks.push(factsBlock('Google reCAPTCHA', [
      ['Aanbieder', 'Google Ireland Limited (Google LLC in de Verenigde Staten).'],
      ['Doel', 'Beveiliging: onzichtbaar controleren of een formulier (zoals inloggen of bestellen) door een mens wordt ingevuld en niet door een robot. Het script wordt geladen zodra je een formulier gebruikt en stuurt dan gegevens over je browser en gedrag op de pagina, en je IP-adres, naar Google. Google kan daarbij een cookie (_GRECAPTCHA, ongeveer 6 maanden) plaatsen.'],
      ['Buiten de EU', 'Google kan gegevens in de Verenigde Staten verwerken, onder het EU-VS Data Privacy Framework en standaardcontractbepalingen.'],
      ['Privacybeleid', '<a href="https://policies.google.com/privacy" rel="noopener noreferrer">policies.google.com/privacy</a>'],
      ['Categorie', 'Noodzakelijk voor de beveiliging van de formulieren.'],
    ]));
  }
  if (services.onlinePayment) {
    blocks.push(factsBlock('Mollie (online betalen)', [
      ['Aanbieder', 'Mollie B.V., Amsterdam.'],
      ['Doel', 'Veilig betalen. Kies je online betalen, dan ga je door naar de betaalpagina van Mollie. Op onze site plaatst Mollie niets; op de betaalpagina gelden de cookies en het privacybeleid van Mollie.'],
      ['Buiten de EU', 'Mollie is gevestigd in de EU.'],
      ['Privacybeleid', '<a href="https://www.mollie.com/nl/privacy" rel="noopener noreferrer">mollie.com/nl/privacy</a>'],
      ['Categorie', 'Noodzakelijk om te kunnen betalen.'],
    ]));
  }
  return blocks.length ? `<h2>Diensten van anderen</h2><p>Bij deze diensten komt je browser in contact met een andere partij. We noemen ze hier ook als ze geen cookie op deze site plaatsen.</p>${blocks.join('')}` : '';
}

/**
 * De volledige cookieverklaring.
 * @param {{ phone?: string, email?: string }} contact Contactgegevens uit Beheer.
 * @param {{ analytics?: boolean, clarity?: boolean, captcha?: boolean, guestOrders?: boolean, onlinePayment?: boolean }} [services] Welke diensten de shop gebruikt (standaard geen: alleen de noodzakelijke cookies).
 * @returns {string} HTML van de pagina.
 */
function cookieBody(contact, services = {}) {
  const measuring = Boolean(services.analytics || services.clarity);
  return `<p>Aquatechshop.nl gebruikt cookies en vergelijkbare technieken (zoals opslag in je browser). Hieronder staat per dienst en per cookie wat we gebruiken, waarvoor, hoe lang en bij wie.</p>
${necessarySection(services)}
${analyticsSection(services)}
${thirdPartySection(services)}
<h2>Marketing en advertenties</h2><p>We gebruiken geen marketing- of advertentiecookies en volgen je niet voor advertenties.</p>
<h2>Je keuze wijzigen</h2><p>${measuring ? 'Je kunt je keuze altijd wijzigen of intrekken via <em>Cookie-instellingen</em> onderaan elke pagina. Weigeren is net zo makkelijk als accepteren.' : 'Er is niets om toestemming voor te geven, dus er is ook geen cookiekeuze. Zodra we een analytische dienst gebruiken, vragen we eerst je toestemming.'} Cookies verwijderen kan ook in de instellingen van je browser. Noodzakelijke cookies verwijderen betekent dat je winkelwagen leeg is en dat je opnieuw moet inloggen.</p>
<h2>Meer informatie</h2><p>Hoe we met persoonsgegevens omgaan staat in onze <a href="../privacyverklaring/">privacyverklaring</a>. Vragen over cookies? Mail ons via ${escapeHtml(contact.email || 'het adres in de privacyverklaring')}${contact.phone ? ` of bel ${escapeHtml(contact.phone)}` : ''}.</p>`;
}

module.exports = { cookieBody, ALL_SERVICES };
