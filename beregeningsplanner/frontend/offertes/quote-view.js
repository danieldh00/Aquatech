// Het offertedocument en het akkoordformulier, gedeeld door de module
// Offertes (afdrukversie, klantaccount) en de openbare offertepagina
// (openbaar/offerte.html). Gewoon script, geen module; vraagt QuoteCore.
(function (root) {
  const QuoteCore = root.QuoteCore;
  const DocText = root.DocText;
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @param {string} [language] Documenttaal ('nl' of 'en'; standaard Nederlands).
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const eur = (value, language) => (Number(value) || 0).toLocaleString(DocText.localeOf(language), { style: 'currency', currency: 'EUR' });
  /**
   * Getal in Nederlandse notatie.
   * @param {*} value Het getal.
   * @param {number} [decimals] Maximaal aantal decimalen.
   * @param {string} [language] Documenttaal.
   * @returns {string} Bijv. "2,5".
   */
  const formatNumber = (value, decimals = 2, language) => (Number(value) || 0).toLocaleString(DocText.localeOf(language), { maximumFractionDigits: decimals });
  /**
   * Datum in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @param {string} [language] Documenttaal.
   * @returns {string} Bijv. "22 oktober 2026" (– zonder datum).
   */
  const date = (iso, language) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(DocText.localeOf(language), { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  /**
   * Datum en tijd voluit.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @param {string} [language] Documenttaal.
   * @returns {string} Bijv. "22 oktober 2026 om 10:15" (– zonder tijdstip).
   */
  const dateTime = (iso, language) => (iso ? new Date(iso).toLocaleString(DocText.localeOf(language), { dateStyle: 'long', timeStyle: 'short' }) : '–');

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
    return QuoteCore.totals({ discountPct: data.discountPct, vatShift: data.vatShift, lines });
  }

  /**
   * HTML van het offertedocument, in de documenttaal van de offerte (data.language).
   * @param {object} quote De offerte (number, data, acceptance, fixed).
   * @param {object} profile Bedrijfsprofiel (naam, adres, KvK, enz.).
   * @param {object} [options] { interactive: opties zijn aan te vinken (data-opt="<regel-id>"), logo: pad naar het witte logo }.
   * @returns {string} De HTML.
   */
  function documentHtml(quote, profile, options = {}) {
    const data = quote.data;
    const lang = DocText.clean(data.language);
    /**
     * Een vaste tekst in de taal van het document.
     * @param {string} key Sleutel uit DocText.
     * @param {object} [values] Waarden voor {naam}.
     * @returns {string} De tekst.
     */
    const translate = (key, values) => DocText.text(lang, key, values);
    /**
     * Bedrag in de notatie van de documenttaal.
     * @param {*} value Het bedrag.
     * @returns {string} Het bedrag als tekst.
     */
    const money = (value) => eur(value, lang);
    /**
     * Getal in de notatie van de documenttaal.
     * @param {*} value Het getal.
     * @param {number} [decimals] Maximaal aantal decimalen.
     * @returns {string} Het getal als tekst.
     */
    const number = (value, decimals) => formatNumber(value, decimals, lang);
    const companyProfile = profile || {};
    const totals = totalsOf(quote);
    const customer = data.customer || {};
    const logo = options.logo || '../shared/logo-white.png';
    const companyLines = [companyProfile.address, [companyProfile.phone, companyProfile.email].filter(Boolean).join(' · '), companyProfile.website].filter(Boolean).join('\n');
    const recipient = [customer.name, customer.contact ? `${translate('quote.attn')} ${customer.contact}` : '', customer.address].filter(Boolean).join('\n');
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
    const sections = Object.keys(QuoteCore.SECTIONS).map((key) => {
      const label = translate(`section.${key}`);
      const lines = data.lines.filter((line) => line.section === key);
      if (!lines.length) return '';
      const rows = lines.map((line) => {
        if (line.optional) hasOptions = true;
        if (showPrices) {
          return `<tr${optionClass(line)}><td>${description(line)}</td><td class="num">${number(line.qty)}</td><td>${esc(line.unit)}</td><td class="num">${money(line.price)}</td><td class="num">${totals.shifted ? translate('quote.shifted') : `${line.vat}%`}</td><td class="num">${money(QuoteCore.lineTotal(line))}</td></tr>`;
        }
        // Totaal per onderdeel: geen regelprijzen, behalve bij een optie.
        return `<tr${optionClass(line)}><td colspan="4">${description(line)}</td><td class="num">${number(line.qty)} ${esc(line.unit)}</td><td class="num">${line.optional ? money(QuoteCore.lineTotal(line)) : ''}</td></tr>`;
      }).join('');
      return `<tr class="p-section"><td colspan="6">${esc(label)}</td></tr>${rows}
        <tr class="p-sum"><td colspan="5">${esc(translate('quote.sectionTotal', { section: label.toLowerCase() }))}</td><td class="num">${money(totals.bySection[key] || 0)}</td></tr>`;
    }).join('');
    const summary = data.planSummary;
    const design = summary ? [summary.lawnM2 ? `${number(summary.lawnM2, 0)} ${translate('quote.lawn')}` : '', summary.sprinklers ? `${summary.sprinklers} ${translate('quote.sprinklers')}` : '', summary.zones ? `${summary.zones} ${translate('quote.zones')}` : '', summary.level ? `${translate('quote.level')} ${summary.level}` : ''].filter(Boolean).join(' · ') : '';
    const foot = [companyProfile.companyName, companyProfile.kvk ? `KvK ${companyProfile.kvk}` : '', companyProfile.vatNumber ? `${translate('quote.vat')} ${companyProfile.vatNumber}` : '', companyProfile.iban ? `IBAN ${companyProfile.iban}` : ''].filter(Boolean).join(' · ');
    const acceptance = quote.acceptance;
    let closing;
    if (acceptance && acceptance.answer === 'akkoord') {
      const accepted = translate('quote.acceptedBy', { name: `<b>${esc(acceptance.name)}</b>`, when: esc(dateTime(acceptance.at, lang)), amount: money(acceptance.totalIncl != null ? acceptance.totalIncl : totals.total), vat: totals.shifted ? translate('quote.vatShifted') : translate('quote.inclVat') });
      closing = `<div class="p-accepted">
        <h2>${esc(translate('quote.accepted'))}</h2>
        <div>${accepted}</div>
        ${acceptance.signature ? `<img src="${esc(acceptance.signature)}" alt="${esc(translate('quote.signatureOf', { name: acceptance.name }))}">` : ''}
        <div class="p-proof">${acceptance.via === 'account' ? esc(translate('quote.viaAccount')) : esc(translate('quote.viaLink'))}${acceptance.ip ? ` · IP ${esc(acceptance.ip)}${acceptance.forwardedFor ? ` (${esc(translate('quote.reported'))} ${esc(acceptance.forwardedFor)})` : ''}` : ''}${acceptance.contentHash ? ` · ${esc(translate('quote.ref'))} ${esc(acceptance.contentHash.slice(0, 16))}` : ''}</div>
      </div>`;
    } else if (acceptance && acceptance.answer === 'afgewezen') {
      closing = `<div class="p-accepted rejected"><h2>${esc(translate('quote.rejected'))}</h2><div>${esc(translate('quote.rejectedBy', { name: acceptance.name || translate('quote.theCustomer'), when: dateTime(acceptance.at, lang) }))}${acceptance.reason ? ` ${esc(translate('quote.reason'))}: ${esc(acceptance.reason)}` : ''}</div></div>`;
    } else {
      closing = `<h2>${esc(translate('quote.forApproval'))}</h2><div class="p-sign"><div>${esc(translate('quote.nameDate'))}</div><div>${esc(translate('quote.signature'))}</div></div>`;
    }
    const head = showPrices
      ? `<th>${esc(translate('col.description'))}</th><th class="num">${esc(translate('col.qty'))}</th><th>${esc(translate('col.unit'))}</th><th class="num">${esc(translate('col.price'))}</th><th class="num">${esc(translate('col.vat'))}</th><th class="num">${esc(translate('col.total'))}</th>`
      : `<th colspan="4">${esc(translate('col.description'))}</th><th class="num">${esc(translate('col.qty'))}</th><th class="num"></th>`;
    return `
      <header class="p-head">
        <img src="${esc(logo)}" alt="${esc(companyProfile.companyName)}">
        <div class="p-company"><b>${esc(companyProfile.companyName)}</b>\n${esc(companyLines)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">${esc(translate('quote.for'))}</div>${esc(recipient || translate('quote.noRecipient'))}</div>
        <div class="p-info"><table>
          <tr><td>${esc(translate('quote.number'))}</td><td><b>${esc(quote.number)}</b></td></tr>
          <tr><td>${esc(translate('quote.date'))}</td><td>${esc(date(data.date, lang))}</td></tr>
          <tr><td>${esc(translate('quote.validUntil'))}</td><td>${esc(date(data.validUntil, lang))}</td></tr>
          ${data.paymentDays != null ? `<tr><td>${esc(translate('quote.paymentTerm'))}</td><td>${esc(data.paymentDays)} ${esc(translate('quote.days'))}</td></tr>` : ''}
          ${data.reference ? `<tr><td>${esc(translate('quote.reference'))}</td><td>${esc(data.reference)}</td></tr>` : ''}
        </table></div>
      </div>
      <h1>${esc(translate('quote.title'))}</h1>
      <div class="p-sub">${esc(data.title)}</div>
      ${data.intro ? `<p class="p-text">${esc(data.intro)}</p>` : ''}
      ${design ? `<div class="p-design"><b>${esc(translate('quote.design'))}${data.planTitle ? ` ${esc(data.planTitle)}` : ''}:</b> ${esc(design)}</div>` : ''}
      <table class="p-lines">
        <thead><tr>${head}</tr></thead>
        <tbody>${sections || `<tr><td colspan="6">${esc(translate('quote.noLines'))}</td></tr>`}</tbody>
      </table>
      ${hasOptions ? `<p class="p-optnote">${interactive ? translate('quote.optionsInteractive') : translate('quote.optionsStatic')}</p>` : ''}
      <table class="p-totals">
        <tr><td>${esc(translate('quote.subtotal'))}</td><td class="num">${money(totals.subtotal)}</td></tr>
        ${totals.discount ? `<tr><td>${esc(translate('quote.discount'))} ${number(totals.discountPct)}%</td><td class="num">− ${money(totals.discount)}</td></tr><tr><td>${esc(translate('quote.netTotal'))}</td><td class="num">${money(totals.net)}</td></tr>` : ''}
        ${totals.shifted ? '' : totals.vat.filter((vat) => vat.base).map((vat) => `<tr><td>${esc(translate('quote.vat'))} ${vat.rate}%</td><td class="num">${money(vat.amount)}</td></tr>`).join('')}
        <tr class="grand"><td>${esc(totals.shifted ? translate('quote.totalShifted') : translate('quote.totalIncl'))}</td><td class="num">${money(totals.total)}</td></tr>
      </table>
      ${totals.shifted ? `<p class="p-text">${esc(translate('quote.shiftNote', { number: data.vatShift.number ? ` (${translate('quote.vatNumber')} ${data.vatShift.number})` : '' }))}</p>` : ''}
      ${data.terms ? `<h2 id="p-terms">${esc(translate('quote.terms'))}</h2><p class="p-text">${esc(data.terms)}</p>` : ''}
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
   * @param {object} options { termsLink, total, onRespond, language }.
   * @returns {{update: Function}} update() ververst het getoonde totaal.
   */
  function signForm(container, options) {
    const lang = DocText.clean(options.language);
    /**
     * Een vaste tekst in de taal van het document.
     * @param {string} key Sleutel uit DocText.
     * @returns {string} De tekst.
     */
    const translate = (key) => DocText.text(lang, key);
    container.innerHTML = `
      <div class="sign-form">
        <h2>${esc(translate('sign.heading'))}</h2>
        <p class="sum">${esc(translate('sign.totalPre'))} <b data-total></b> ${esc(translate('sign.totalPost'))}</p>
        <label class="f">${esc(translate('sign.nameLabel'))}<input type="text" data-name maxlength="120" autocomplete="name" placeholder="${esc(translate('sign.namePlaceholder'))}"></label>
        <div class="f-label">${esc(translate('sign.signatureLabel'))}</div>
        <div class="pad-wrap"><canvas data-pad aria-label="${esc(translate('sign.padLabel'))}"></canvas>
          <span class="pad-hint" data-hint>${esc(translate('sign.padHint'))}</span>
          <button type="button" class="btn small pad-clear" data-clear>${esc(translate('sign.clear'))}</button></div>
        <label class="terms"><input type="checkbox" data-terms> <span>${esc(translate('sign.terms'))}${options.termsLink ? ` (<a href="#p-terms">${esc(translate('sign.read'))}</a>)` : ''}.</span></label>
        <div class="row">
          <button type="button" class="btn primary" data-accept>${esc(translate('sign.accept'))}</button>
          <button type="button" class="btn" data-reject-open>${esc(translate('sign.rejectOpen'))}</button>
        </div>
        <p class="err" data-err></p>
        <div class="reject-box" data-reject-box hidden>
          <label class="f">${esc(translate('sign.whyLabel'))}<textarea data-reason rows="3" maxlength="1000"></textarea></label>
          <div class="row"><button type="button" class="btn" data-reject>${esc(translate('sign.reject'))}</button></div>
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
    const update = () => { $('[data-total]').textContent = eur(options.total(), lang); };
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
      if (name.length < 2) return showError(translate('sign.enterName'));
      if (!pad.hasInk()) return showError(translate('sign.needSignature'));
      if (!$('[data-terms]').checked) return showError(translate('sign.needTerms'));
      send({ answer: 'akkoord', name, signature: pad.toDataURL(), terms: true });
    };
    /** Toont of verbergt het vak om af te wijzen. */
    $('[data-reject-open]').onclick = () => { $('[data-reject-box]').hidden = !$('[data-reject-box]').hidden; };
    /** Wijst de offerte af na bevestiging. */
    $('[data-reject]').onclick = () => {
      if (!confirm(translate('sign.confirmReject'))) return;
      send({ answer: 'afgewezen', name: $('[data-name]').value.trim(), reason: $('[data-reason]').value.trim() });
    };
    return { update };
  }

  root.QuoteView = { documentHtml, totalsOf, selectedOptions, signForm, signaturePad, esc, eur, date, dateTime };
})(window);
