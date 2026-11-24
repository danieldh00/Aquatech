// Offertes: marge in de editor (alleen intern). Haalt de inkoopprijzen op voor de artikelcodes op de regels en toont per regel
// en in een kaart onder de totalen de marge, met een waarschuwing onder de minimummarge uit de bedrijfsgegevens.
// Alleen voor wie de nacalculatie mag zien; nooit op het klantdocument, de PDF of de openbare link.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Maakt de margeonderdelen van de editor.
   * @param {object} context QuoteCore, esc, state, api en $ (de hulpfuncties van offertes.js).
   * @returns {{ updateMargin: Function }} updateMargin tekent de marge per regel en de kaart opnieuw.
   */
  window.Offertes.createMargin = function (context) {
    const { QuoteCore, esc, state, api, $ } = context;
    /**
     * Bedrag in euro's met twee decimalen (zonder teken).
     * @param {number} amount Het bedrag.
     * @returns {string} Bijvoorbeeld "€ 1.334,75".
     */
    const euro = (amount) => `€ ${Math.abs(amount).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    /**
     * Percentage op één decimaal.
     * @param {number} value Het percentage.
     * @returns {string} Bijvoorbeeld "25,2%".
     */
    const percent = (value) => `${(Math.round(value * 10) / 10).toLocaleString('nl-NL')}%`;

    /**
     * Mag deze gebruiker de marge zien? Alleen als de server de interne kostprijs per uur meestuurt en het onderdeel niet is uitgezet.
     * @returns {boolean} true als de marge getoond mag worden.
     */
    const allowed = () => !state.klant && !state.marginOff && Boolean(state.profile) && state.profile.hourlyCost !== undefined;

    /**
     * Haalt de inkoopprijzen op van codes die nog niet bekend zijn en tekent daarna opnieuw.
     * @param {string[]} codes De artikelcodes op de regels (hoofdletters).
     * @returns {Promise<void>}
     */
    async function loadCosts(codes) {
      const missing = codes.filter((code) => !(code in state.costs) && !state.costsPending.has(code));
      if (!missing.length) return;
      for (const code of missing) state.costsPending.add(code);
      try {
        const result = await api(`quote-costs?codes=${encodeURIComponent(missing.join(','))}`);
        Object.assign(state.costs, result.costs || {});
      } catch (error) {
        // Geen recht of onderdeel uit: de marge blijft weg.
        if (error.status === 403 || error.status === 409) state.marginOff = true;
      }
      for (const code of missing) state.costsPending.delete(code);
      if (state.quote) updateMargin();
    }

    /** Tekent de marge per regel en de margekaart onder de totalen (of verbergt ze). */
    function updateMargin() {
      const card = $('#e-margin');
      if (!card) return;
      for (const element of document.querySelectorAll('[data-lm]')) element.textContent = '';
      if (!state.quote || !allowed()) { card.hidden = true; return; }
      const data = state.quote.data;
      const codes = [...new Set(data.lines.map((line) => String(line.code || '').toUpperCase()).filter(Boolean))];
      loadCosts(codes);
      const result = QuoteCore.margin(data, state.costs, state.profile.hourlyCost);
      const minimum = Number(state.profile.minMarginPct) || 0;
      for (const line of data.lines) {
        const row = document.querySelector(`[data-line="${CSS.escape(line.id)}"] [data-lm]`);
        if (!row) continue;
        const entry = result.lines[line.id];
        const total = QuoteCore.lineTotal(line);
        if (!entry) { row.textContent = total > 0 && QuoteCore.included(line) ? 'geen kostprijs' : ''; row.className = 'line-margin unknown'; continue; }
        const low = minimum > 0 && entry.pct !== null && entry.pct < minimum;
        row.textContent = entry.pct === null ? '' : `marge ${percent(entry.pct)}`;
        row.className = `line-margin${low ? ' low' : ''}`;
      }
      const known = Object.keys(result.lines).length;
      if (!known) { card.hidden = true; return; }
      const low = minimum > 0 && result.pct !== null && result.pct < minimum;
      const scaleMax = Math.max(50, Math.ceil(Math.max(minimum, result.pct || 0) / 10) * 10 + 10);
      const fill = Math.max(0, Math.min(100, ((result.pct || 0) / scaleMax) * 100));
      const notes = [];
      if (low) notes.push(`De marge ligt onder het minimum van ${percent(minimum)}.`);
      if (result.unknown.length) notes.push(`Geen kostprijs bekend voor ${result.unknown.map(esc).join(', ')}: die regels tellen niet mee.`);
      card.hidden = false;
      card.innerHTML = `<div class="margin-head"><h3>Marge</h3><span class="margin-tag">Alleen intern</span></div>
        <div class="margin-tiles">
          <div class="margin-tile"><span class="k">Opbrengst excl. btw</span><span class="v">${euro(result.revenue)}</span></div>
          <div class="margin-tile"><span class="k">Kosten</span><span class="v">${euro(result.cost)}</span></div>
          <div class="margin-tile${low ? ' low' : ''}"><span class="k">Marge</span><span class="v">${result.margin < 0 ? '− ' : ''}${euro(result.margin)}${result.pct === null ? '' : ` · ${percent(result.pct)}`}</span></div>
        </div>
        ${minimum > 0 ? `<div class="margin-scale" role="img" aria-label="Marge ${result.pct === null ? '' : percent(result.pct)}, minimum ${percent(minimum)}"><i class="${low ? 'low' : ''}" style="width:${fill}%"></i><b style="left:${(minimum / scaleMax) * 100}%"></b></div>
          <div class="margin-scale-labels"><span>0%</span><span>Minimum ${percent(minimum)}</span><span>${scaleMax}%</span></div>` : ''}
        ${notes.map((note) => `<p class="margin-note">${note}</p>`).join('')}`;
    }

    return { updateMargin };
  };
})();
