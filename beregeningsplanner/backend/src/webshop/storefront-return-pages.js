// Het blok Retourneren op de bestelpagina van de eigen webshop: de eerdere
// retouren van de bestelling (met intrekken zolang ze zijn aangevraagd) en het
// formulier om een nieuwe retour aan te vragen.
const { escapeHtml } = require('./storefront-pages');
const { REASONS, RETURN_DAYS } = require('./web-returns');

/**
 * Een datum als dag-maand-jaar in het Nederlands.
 * @param {string} iso Tijdstip als ISO-tekst.
 * @returns {string} Bijvoorbeeld "30-10-2026".
 */
const formatDate = (iso) => new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Amsterdam' });

/**
 * Eén eerdere retour: nummer, status, regels, het besluit en zo nodig de knop om hem in te trekken.
 * @param {object} record De retour (web-returns.js).
 * @returns {string} HTML van het blokje.
 */
function returnItem(record) {
  const lines = record.lines.map((line) => `${line.qty} × ${escapeHtml(line.name)}`).join(', ');
  const decision = record.decisionNote ? `<br><small>${escapeHtml(record.decisionNote)}</small>` : '';
  const credit = record.credit ? `<br><small>Creditnota ${escapeHtml(record.credit.number)}</small>` : '';
  const withdraw = record.status === 'aangevraagd'
    ? `<form class="inline" method="post" action="retour/${escapeHtml(record.id)}/intrekken"><button class="button secondary" type="submit">Retour intrekken</button></form>` : '';
  return `<li><strong>${escapeHtml(record.number)}</strong> · ${escapeHtml(record.statusLabel)} (${escapeHtml(formatDate(record.createdAt))})<br>${lines}${decision}${credit} ${withdraw}</li>`;
}

/**
 * Het formulier om artikelen van de bestelling terug te sturen.
 * @param {object[]} lines Wat er nog terug kan (code, naam, qty = maximum).
 * @param {{ values?: object, error?: string, until: string }} options De eerder ingevulde waarden, een foutmelding en het laatste moment.
 * @returns {string} HTML van het formulier.
 */
function returnForm(lines, { values = {}, error = '', until }) {
  const rows = lines.map((line) => `<tr><td>${escapeHtml(line.name)}<br><small>Artikelnr.: ${escapeHtml(line.code)}</small></td><td class="num">${line.qty}</td><td class="num"><input name="qty:${escapeHtml(line.code)}" type="number" min="0" max="${line.qty}" value="${escapeHtml(values[`qty:${line.code}`] || '0')}" aria-label="Aantal terug van ${escapeHtml(line.name)}"></td></tr>`).join('');
  const reasons = Object.entries(REASONS).map(([key, label]) => `<option value="${key}"${values.reason === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="retour">
<div class="tablewrap"><table class="cart-table"><thead><tr><th>Artikel</th><th class="num">Besteld</th><th class="num">Terug</th></tr></thead><tbody>${rows}</tbody></table></div>
<label class="form-field"><span>Reden</span><select name="reason" required><option value="">Kies een reden</option>${reasons}</select></label>
<label class="form-field"><span>Toelichting (optioneel)</span><textarea name="note" rows="3" maxlength="1000">${escapeHtml(values.note || '')}</textarea></label>
<p class="note">Je kunt tot en met ${escapeHtml(formatDate(until))} een retour aanvragen. Na goedkeuring sturen we je het retouradres.</p>
<button class="button" type="submit">Retour aanvragen</button>
</form>`;
}

/**
 * Het blok Retourneren onder de bestelling.
 * @param {{ items: object[], eligibility: { shipped: boolean, open: boolean, until: ?string, lines: object[] }, values?: object, error?: string }} view De eerdere retouren, of en wat er terug kan, en bij een fout de ingevulde waarden en de melding.
 * @returns {string} HTML van het blok, of leeg als er niets te tonen is.
 */
function returnsBlock({ items, eligibility, values = {}, error = '' }) {
  if (!items.length && !eligibility.shipped && !error) return '';
  const earlier = items.length ? `<ul class="return-list">${items.map(returnItem).join('')}</ul>` : '';
  let request = '';
  if (eligibility.lines.length) request = returnForm(eligibility.lines, { values, error, until: eligibility.until });
  else if (!eligibility.open) request = `<p class="note">De termijn van ${RETURN_DAYS} dagen om een retour aan te vragen is verstreken.</p>`;
  else if (!items.length) request = '<p class="note">Er is niets meer om terug te sturen.</p>';
  const failure = error && !eligibility.lines.length ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : '';
  return `<h2>Retourneren</h2>${failure}${earlier}${request}`;
}

module.exports = { returnsBlock };
