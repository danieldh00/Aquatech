// Het offertedocument en het akkoordformulier, gedeeld door de module
// Offertes (afdrukversie, klantaccount) en de openbare offertepagina
// (openbaar/offerte.html). Gewoon script, geen module; vraagt QuoteCore.
(function (root) {
  const QuoteCore = root.QuoteCore;
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Getal in Nederlandse notatie.
   * @param {*} value Het getal.
   * @param {number} [decimals] Maximaal aantal decimalen.
   * @returns {string} Bijv. "2,5".
   */
  const formatNumber = (value, decimals = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: decimals });
  /**
   * Datum in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "22 oktober 2026" (– zonder datum).
   */
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  /**
   * Datum en tijd voluit.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 oktober 2026 om 10:15" (– zonder tijdstip).
   */
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' }) : '–');

  /**
   * Totalen zoals de klant ze ziet. Bij de opmaak "totaal per onderdeel"
   * stuurt de server geen regelprijzen maar per onderdeel en btw-tarief een
   * bedrag (`fixed`); de opties tellen mee zoals ze gekozen zijn.
   * @param {object} quote Offerte zoals de server hem geeft (data, eventueel fixed).
   * @returns {object} Totalen uit QuoteCore.totals.
   */
  function totalsOf(quote) {
    const data = quote.data;
    if (!Array.isArray(quote.fixed)) return QuoteCore.totals(data);
    const lines = quote.fixed.map((fixed) => ({ section: fixed.section, qty: 1, price: fixed.amount, vat: fixed.vat }))
      .concat(data.lines.filter((line) => line.optional));
    return QuoteCore.totals({ discountPct: data.discountPct, lines });
  }

  /**
   * HTML van het offertedocument.
   * @param {object} quote De offerte (number, data, acceptance, fixed).
   * @param {object} profile Bedrijfsprofiel (naam, adres, KvK, enz.).
   * @param {object} [options] { interactive: opties zijn aan te vinken (data-opt="<regel-id>"), logo: pad naar het witte logo }.
   * @returns {string} De HTML.
   */
  function documentHtml(quote, profile, options = {}) {
    const data = quote.data;
    const companyProfile = profile || {};
    const totals = totalsOf(quote);
    const customer = data.customer || {};
    const logo = options.logo || '../shared/logo-white.png';
    const companyLines = [companyProfile.address, [companyProfile.phone, companyProfile.email].filter(Boolean).join(' · '), companyProfile.website].filter(Boolean).join('\n');
    const recipient = [customer.name, customer.contact ? `T.a.v. ${customer.contact}` : '', customer.address].filter(Boolean).join('\n');
    const showPrices = data.layout !== 'totaal';
    const interactive = options.interactive;
    /**
     * Omschrijving van een regel; een optie krijgt een vinkje als het document interactief is.
     * @param {object} line De regel.
     * @returns {string} HTML.
     */
    const description = (line) => (line.optional && interactive
      ? `<label class="p-pick"><input type="checkbox" data-opt="${esc(line.id)}"${line.selected ? ' checked' : ''}> ${esc(line.description)}</label>`
      : esc(line.description));
    /**
     * Klasse-attribuut voor een optieregel (doorgestreept als hij niet gekozen is).
     * @param {object} line De regel.
     * @returns {string} Het attribuut, of leeg.
     */
    const optionClass = (line) => (line.optional ? ` class="p-opt${line.selected ? '' : ' off'}"` : '');
    let hasOptions = false;
    const sections = Object.entries(QuoteCore.SECTIONS).map(([key, label]) => {
      const lines = data.lines.filter((line) => line.section === key);
      if (!lines.length) return '';
      const rows = lines.map((line) => {
        if (line.optional) hasOptions = true;
        if (showPrices) {
          return `<tr${optionClass(line)}><td>${description(line)}</td><td class="num">${formatNumber(line.qty)}</td><td>${esc(line.unit)}</td><td class="num">${eur(line.price)}</td><td class="num">${line.vat}%</td><td class="num">${eur(QuoteCore.lineTotal(line))}</td></tr>`;
        }
        // Totaal per onderdeel: geen regelprijzen, behalve bij een optie.
        return `<tr${optionClass(line)}><td colspan="4">${description(line)}</td><td class="num">${formatNumber(line.qty)} ${esc(line.unit)}</td><td class="num">${line.optional ? eur(QuoteCore.lineTotal(line)) : ''}</td></tr>`;
      }).join('');
      return `<tr class="p-section"><td colspan="6">${esc(label)}</td></tr>${rows}
        <tr class="p-sum"><td colspan="5">Totaal ${esc(label.toLowerCase())}</td><td class="num">${eur(totals.bySection[key] || 0)}</td></tr>`;
    }).join('');
    const summary = data.planSummary;
    const design = summary ? [summary.lawnM2 ? `${formatNumber(summary.lawnM2, 0)} m² gazon` : '', summary.sprinklers ? `${summary.sprinklers} sproeiers` : '', summary.zones ? `${summary.zones} zones` : '', summary.level ? `uitvoering ${summary.level}` : ''].filter(Boolean).join(' · ') : '';
    const foot = [companyProfile.companyName, companyProfile.kvk ? `KvK ${companyProfile.kvk}` : '', companyProfile.vatNumber ? `Btw ${companyProfile.vatNumber}` : '', companyProfile.iban ? `IBAN ${companyProfile.iban}` : ''].filter(Boolean).join(' · ');
    const acceptance = quote.acceptance;
    let closing;
    if (acceptance && acceptance.answer === 'akkoord') {
      closing = `<div class="p-accepted">
        <h2>Digitaal geaccordeerd</h2>
        <div>Door <b>${esc(acceptance.name)}</b> op ${esc(dateTime(acceptance.at))}, voor ${eur(acceptance.totalIncl != null ? acceptance.totalIncl : totals.total)} incl. btw, met akkoord op de voorwaarden.</div>
        ${acceptance.signature ? `<img src="${esc(acceptance.signature)}" alt="Handtekening van ${esc(acceptance.name)}">` : ''}
        <div class="p-proof">${acceptance.via === 'account' ? 'Via het klantaccount' : 'Via de offertelink'}${acceptance.ip ? ` · IP ${esc(acceptance.ip)}${acceptance.forwardedFor ? ` (opgegeven ${esc(acceptance.forwardedFor)})` : ''}` : ''}${acceptance.contentHash ? ` · kenmerk ${esc(acceptance.contentHash.slice(0, 16))}` : ''}</div>
      </div>`;
    } else if (acceptance && acceptance.answer === 'afgewezen') {
      closing = `<div class="p-accepted rejected"><h2>Afgewezen</h2><div>Door ${esc(acceptance.name || 'de klant')} op ${esc(dateTime(acceptance.at))}.${acceptance.reason ? ` Reden: ${esc(acceptance.reason)}` : ''}</div></div>`;
    } else {
      closing = '<h2>Voor akkoord</h2><div class="p-sign"><div>Naam en datum</div><div>Handtekening</div></div>';
    }
    return `
      <header class="p-head">
        <img src="${esc(logo)}" alt="${esc(companyProfile.companyName)}">
        <div class="p-company"><b>${esc(companyProfile.companyName)}</b>\n${esc(companyLines)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">Offerte voor</div>${esc(recipient || '–')}</div>
        <div class="p-info"><table>
          <tr><td>Offertenummer</td><td><b>${esc(quote.number)}</b></td></tr>
          <tr><td>Datum</td><td>${esc(date(data.date))}</td></tr>
          <tr><td>Geldig tot</td><td>${esc(date(data.validUntil))}</td></tr>
          ${data.reference ? `<tr><td>Uw referentie</td><td>${esc(data.reference)}</td></tr>` : ''}
        </table></div>
      </div>
      <h1>Offerte</h1>
      <div class="p-sub">${esc(data.title)}</div>
      ${data.intro ? `<p class="p-text">${esc(data.intro)}</p>` : ''}
      ${design ? `<div class="p-design"><b>Ontwerp${data.planTitle ? ` ${esc(data.planTitle)}` : ''}:</b> ${esc(design)}</div>` : ''}
      <table class="p-lines">
        <thead><tr>${showPrices ? '<th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th class="num">Btw</th><th class="num">Totaal</th>' : '<th colspan="4">Omschrijving</th><th class="num">Aantal</th><th class="num"></th>'}</tr></thead>
        <tbody>${sections || '<tr><td colspan="6">Geen regels.</td></tr>'}</tbody>
      </table>
      ${hasOptions ? `<p class="p-optnote">${interactive ? 'Regels met <b>Optie</b> kiest u zelf: vink ze aan om ze mee te nemen; het totaal past zich aan.' : 'Regels met <b>Optie</b> tellen alleen mee als ze gekozen zijn.'}</p>` : ''}
      <table class="p-totals">
        <tr><td>Subtotaal</td><td class="num">${eur(totals.subtotal)}</td></tr>
        ${totals.discount ? `<tr><td>Korting ${formatNumber(totals.discountPct)}%</td><td class="num">− ${eur(totals.discount)}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${eur(totals.net)}</td></tr>` : ''}
        ${totals.vat.filter((vat) => vat.base).map((vat) => `<tr><td>Btw ${vat.rate}%</td><td class="num">${eur(vat.amount)}</td></tr>`).join('')}
        <tr class="grand"><td>Totaal incl. btw</td><td class="num">${eur(totals.total)}</td></tr>
      </table>
      ${data.terms ? `<h2 id="p-terms">Voorwaarden</h2><p class="p-text">${esc(data.terms)}</p>` : ''}
      <div class="p-end">
        ${closing}
        <footer class="p-foot">${esc(foot)}</footer>
      </div>`;
  }

  /**
   * Id's van de gekozen opties (voor het akkoord).
   * @param {object} quote De offerte.
   * @returns {string[]} Id's van de aangevinkte optieregels.
   */
  function selectedOptions(quote) {
    return quote.data.lines.filter((line) => line.optional && line.selected).map((line) => line.id);
  }

  /**
   * Tekenvak: tekenen met muis, vinger of pen; levert een PNG.
   * @param {HTMLCanvasElement} canvas Het tekenvak.
   * @param {Function} onChange Krijgt true zodra er getekend is, false na wissen.
   * @returns {{clear: Function, hasInk: Function, toDataURL: Function}} Bediening van het tekenvak.
   */
  function signaturePad(canvas, onChange) {
    const context = canvas.getContext('2d');
    let drawing = false, lastPoint = null, hasDrawn = false;
    /** Past het tekenvak aan de getoonde grootte aan (scherp op retina) en wist het. */
    function fit() {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.lineWidth = 2.2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#172f5e';
      hasDrawn = false;
      onChange(false);
    }
    /**
     * Plek van de aanwijzer binnen het tekenvak.
     * @param {PointerEvent} event De aanwijzer.
     * @returns {{x: number, y: number}} De plek in pixels.
     */
    const pointOf = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drawing = true;
      lastPoint = pointOf(event);
      context.beginPath();
      context.arc(lastPoint.x, lastPoint.y, 1, 0, Math.PI * 2);
      context.fillStyle = '#172f5e';
      context.fill();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      const point = pointOf(event);
      context.beginPath();
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      lastPoint = point;
      if (!hasDrawn) { hasDrawn = true; onChange(true); }
    });
    /** Stopt met tekenen. */
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    fit();
    let width = canvas.getBoundingClientRect().width;
    window.addEventListener('resize', () => {
      const newWidth = canvas.getBoundingClientRect().width;
      if (Math.abs(newWidth - width) > 2) { width = newWidth; fit(); }
    });
    return {
      clear: fit,
      /**
       * Geeft aan of er iets getekend is.
       * @returns {boolean} true als er getekend is.
       */
      hasInk: () => hasDrawn,
      /**
       * De handtekening als PNG, verkleind tot max. 600 px breed op wit, zodat hij klein blijft.
       * @returns {string} Data-URL van de PNG.
       */
      toDataURL() {
        const scale = Math.min(1, 600 / canvas.width);
        const small = document.createElement('canvas');
        small.width = Math.round(canvas.width * scale);
        small.height = Math.round(canvas.height * scale);
        const smallContext = small.getContext('2d');
        smallContext.fillStyle = '#fff';
        smallContext.fillRect(0, 0, small.width, small.height);
        smallContext.drawImage(canvas, 0, 0, small.width, small.height);
        return small.toDataURL('image/png');
      },
    };
  }

  /**
   * Akkoordformulier onder het document. opts: { total() → bedrag incl. btw,
   * onRespond(payload) → Promise (payload: { answer, name, signature, terms,
   * reason }) }. Geeft { update() } om het getoonde totaal te verversen.
   * @param {HTMLElement} container Waar het formulier in komt.
   * @param {object} options { termsLink, total, onRespond }.
   * @returns {{update: Function}} update() ververst het getoonde totaal.
   */
  function signForm(container, options) {
    container.innerHTML = `
      <div class="sign-form">
        <h2>Akkoord geven</h2>
        <p class="sum">Totaal: <b data-total></b> incl. btw</p>
        <label class="f">Uw naam<input type="text" data-name maxlength="120" autocomplete="name" placeholder="Voor- en achternaam"></label>
        <div class="f-label">Uw handtekening</div>
        <div class="pad-wrap"><canvas data-pad aria-label="Tekenvak voor uw handtekening"></canvas>
          <span class="pad-hint" data-hint>Teken hier met muis of vinger</span>
          <button type="button" class="btn small pad-clear" data-clear>Wissen</button></div>
        <label class="terms"><input type="checkbox" data-terms> <span>Ik ga akkoord met deze offerte en de voorwaarden${options.termsLink ? ' (<a href="#p-terms">lezen</a>)' : ''}.</span></label>
        <div class="row">
          <button type="button" class="btn primary" data-accept>Akkoord geven</button>
          <button type="button" class="btn" data-reject-open>Afwijzen</button>
        </div>
        <p class="err" data-err></p>
        <div class="reject-box" data-reject-box hidden>
          <label class="f">Wilt u laten weten waarom? (niet verplicht)<textarea data-reason rows="3" maxlength="1000"></textarea></label>
          <div class="row"><button type="button" class="btn" data-reject>Offerte afwijzen</button></div>
        </div>
      </div>`;
    /**
     * Zoekt een element binnen het formulier.
     * @param {string} selector CSS-selector.
     * @returns {Element|null} Het element.
     */
    const $ = (selector) => container.querySelector(selector);
    const pad = signaturePad($('[data-pad]'), (drawn) => { $('[data-hint]').hidden = drawn; });
    /**
     * Wist de handtekening.
     * @returns {void}
     */
    $('[data-clear]').onclick = () => pad.clear();
    /** Toont het totaal incl. btw. */
    const update = () => { $('[data-total]').textContent = eur(options.total()); };
    update();
    /**
     * Toont een foutmelding (leeg = weg).
     * @param {string} text De melding.
     * @returns {void}
     */
    const showError = (text) => { $('[data-err]').textContent = text || ''; };
    /**
     * Zet alle knoppen uit of weer aan.
     * @param {boolean} disabled true = uit.
     * @returns {void}
     */
    const busy = (disabled) => container.querySelectorAll('button').forEach((button) => { button.disabled = disabled; });
    /**
     * Verstuurt de reactie met de knoppen uitgeschakeld; een fout komt in het formulier.
     * @param {object} payload { answer, name, signature, terms, reason }.
     * @returns {Promise<void>}
     */
    async function send(payload) {
      busy(true);
      showError('');
      try { await options.onRespond(payload); } catch (error) { showError(error.message); } finally { busy(false); }
    }
    /**
     * Geeft akkoord na controle van naam, handtekening en voorwaarden.
     * @returns {void}
     */
    $('[data-accept]').onclick = () => {
      const name = $('[data-name]').value.trim();
      if (name.length < 2) return showError('Vul uw naam in.');
      if (!pad.hasInk()) return showError('Zet uw handtekening in het tekenvak.');
      if (!$('[data-terms]').checked) return showError('Vink aan dat u akkoord gaat met de offerte en de voorwaarden.');
      send({ answer: 'akkoord', name, signature: pad.toDataURL(), terms: true });
    };
    /** Toont of verbergt het vak om af te wijzen. */
    $('[data-reject-open]').onclick = () => { $('[data-reject-box]').hidden = !$('[data-reject-box]').hidden; };
    /** Wijst de offerte af na bevestiging. */
    $('[data-reject]').onclick = () => {
      if (!confirm('Weet u zeker dat u deze offerte wilt afwijzen?')) return;
      send({ answer: 'afgewezen', name: $('[data-name]').value.trim(), reason: $('[data-reason]').value.trim() });
    };
    return { update };
  }

  root.QuoteView = { documentHtml, totalsOf, selectedOptions, signForm, signaturePad, esc, eur, date, dateTime };
})(window);
