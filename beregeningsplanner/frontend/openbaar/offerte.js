// Openbare offertepagina (digitale offerte): de klant opent de link uit de
// e-mail, bekijkt de offerte, kiest eventuele opties en geeft akkoord met naam,
// handtekening en akkoord op de voorwaarden, of wijst af. Geen account nodig.
// Het token staat in het fragment (#t=...) en gaat alleen in een kop naar de
// server, zodat het niet in logboeken of de Referer terechtkomt.
(function () {
  const QuoteView = window.QuoteView;
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const preview = new URLSearchParams(location.hash.slice(1)).get('voorbeeld') === '1';
  const state = { quote: null, profile: null, form: null };

  /**
   * Roept de openbare offerte-API aan met het token als kop.
   * @param {string} path Pad onder api/public/, bijv. "quote".
   * @param {object} [body] JSON-body; met body een POST, anders een GET.
   * @returns {Promise<object>} Het antwoord (fout = Error met status).
   */
  async function api(path, body) {
    const res = await fetch(`../api/public/${path}${preview && !body ? '?preview=1' : ''}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      headers: { 'X-Offerte-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `Er ging iets mis (${res.status}).`), { status: res.status });
    return out;
  }

  /**
   * Toont een melding in plaats van de offerte.
   * @param {string} text De melding (leeg = weg).
   */
  function message(text) {
    $('#o-message').textContent = text;
  }

  /**
   * Toont of verbergt de statusbalk boven de offerte.
   * @param {string} text De tekst (leeg = verbergen).
   * @param {string} [kind] Extra klasse: ok, bad of warn.
   */
  function status(text, kind) {
    const banner = $('#o-status');
    banner.textContent = text || '';
    banner.className = `o-status screen${kind ? ` ${kind}` : ''}`;
    banner.hidden = !text;
  }

  /**
   * Geeft aan of de geldigheidsdatum van de offerte voorbij is.
   * @param {object} quote De offerte.
   * @returns {boolean} true als de offerte verlopen is.
   */
  const expired = (quote) => quote.data.validUntil && quote.data.validUntil < window.QuoteCore.today();

  /** Tekent de offerte, de statusbalk en (als de offerte nog open is) het akkoordformulier. */
  function render() {
    const quote = state.quote;
    const profile = state.profile || {};
    const open = quote.status === 'verzonden' && !quote.acceptance && !expired(quote);
    document.title = `Offerte ${quote.number}${profile.companyName ? ` – ${profile.companyName}` : ''}`;
    $('#o-company').textContent = profile.companyName || 'Offerte';
    $('#print').innerHTML = QuoteView.documentHtml(quote, profile, { interactive: open });
    $('#print').hidden = false;
    $('#o-print').hidden = false;
    message('');
    const acceptance = quote.acceptance;
    if (acceptance && acceptance.answer === 'akkoord') status(`U heeft deze offerte geaccordeerd op ${QuoteView.dateTime(acceptance.at)}. Bedankt! U kunt hem hieronder als PDF opslaan.`, 'ok');
    else if (acceptance && acceptance.answer === 'afgewezen') status(`Deze offerte is afgewezen op ${QuoteView.dateTime(acceptance.at)}. Neem gerust contact op als u een aangepaste offerte wilt.`, 'bad');
    else if (quote.status !== 'verzonden') status('Deze offerte is al beantwoord.', 'warn');
    else if (expired(quote)) status(`Deze offerte was geldig tot ${QuoteView.date(quote.data.validUntil)}. Neem contact op voor een nieuwe offerte.`, 'warn');
    else status(`Bekijk de offerte en geef onderaan uw akkoord. Geldig tot ${QuoteView.date(quote.data.validUntil)}.${preview ? ' (Voorbeeld: het openen telt niet als bekeken.)' : ''}`);
    $('#o-sign').hidden = !open;
    if (!open) return;
    /**
     * Vinkt een optie aan of uit en tekent de offerte opnieuw met het nieuwe totaal.
     * @param {Event} event De wijziging.
     */
    $("#print").onchange = (event) => {
      const id = event.target.dataset && event.target.dataset.opt;
      if (!id) return;
      const line = quote.data.lines.find((candidate) => candidate.id === id);
      if (line) line.selected = event.target.checked;
      const scrollPosition = window.scrollY;
      $('#print').innerHTML = QuoteView.documentHtml(quote, profile, { interactive: true });
      window.scrollTo(0, scrollPosition);
      state.form.update();
    };
    state.form = QuoteView.signForm($('#o-sign'), {
      termsLink: Boolean(quote.data.terms),
      total: () => QuoteView.totalsOf(quote).total,
      async onRespond(payload) {
        const out = await api('quote/respond', { ...payload, options: QuoteView.selectedOptions(quote) });
        state.quote = out.quote;
        render();
        window.scrollTo(0, 0);
      },
    });
  }

  /**
   * Haalt de offerte op bij het token en tekent hem.
   * @returns {Promise<void>}
   */
  async function init() {
    /**
     * Opent het afdrukvenster (PDF opslaan).
     * @returns {void}
     */
    $('#o-print').onclick = () => window.print();
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      message('Deze link is niet compleet. Open de link uit de e-mail opnieuw, of neem contact op met de afzender.');
      return;
    }
    try {
      const out = await api('quote');
      state.quote = out.quote;
      state.profile = out.profile;
      if (window.AquatechTheme) window.AquatechTheme.apply(out.theme);
      render();
    } catch (error) {
      message(error.status === 429 ? 'Te veel verzoeken. Probeer het later opnieuw.' : error.message);
    }
  }

  init();
})();
