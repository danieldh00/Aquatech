// Debugpaneel: toont de details van een foutantwoord (blok `debug`, zie backend platform/error-report.js)
// voor beheerders met de debugmodus aan. Wordt pas geladen bij de eerste fout met details (shared/common.js).
// Alles gaat via textContent: tekst uit de server komt nooit als HTML op de pagina.
(function (root) {
  const MAX_CARDS = 5;
  let panel = null;

  /**
   * Het paneel rechtsonder (één keer aangemaakt).
   * @returns {HTMLElement} Het paneel.
   */
  function panelElement() {
    if (!panel || !panel.isConnected) {
      panel = document.createElement('div');
      panel.className = 'debug-panel';
      panel.setAttribute('role', 'alert');
      panel.setAttribute('aria-live', 'assertive');
      document.body.appendChild(panel);
    }
    return panel;
  }

  /**
   * De regels (label, waarde) die bij een fout horen; lege waarden vallen weg.
   * @param {object} body Het foutantwoord met `debug`.
   * @returns {Array<[string, string]>} De regels.
   */
  function detailRows(body) {
    const debug = body.debug || {};
    const cause = debug.cause || {};
    const rows = [
      ['Verzoek', `${debug.method || ''} ${debug.path || ''}`.trim()],
      ['Status', debug.status != null ? String(debug.status) : ''],
      ['Foutsoort', debug.error || body.error || ''],
      ['Veld', body.field || ''],
      ['Foutcode', debug.errorId || ''],
      ['Oorzaak', cause.name || cause.message ? `${cause.name || 'Fout'}: ${cause.message || ''}` : ''],
      ['Databasecode', cause.code || ''],
      ['Detail', cause.detail || cause.errstr || ''],
      ['Regel/index', cause.constraint || ''],
      ['Tabel', cause.table || ''],
      ['Onderliggend', cause.cause ? `${cause.cause.name}: ${cause.cause.message}` : ''],
      ['Waar', cause.where || ''],
      ['Tijd', debug.time ? new Date(debug.time).toLocaleString('nl-NL') : ''],
    ];
    return rows.filter(([, value]) => value);
  }

  /**
   * De fout als platte tekst, om te kopiëren en door te sturen.
   * @param {object} body Het foutantwoord met `debug`.
   * @returns {string} De tekst.
   */
  function asText(body) {
    const lines = [`Melding: ${body.message || '(geen melding)'}`, ...detailRows(body).map(([label, value]) => `${label}: ${value}`)];
    const stack = (body.debug && body.debug.cause && body.debug.cause.stack) || [];
    if (stack.length) lines.push('Aanroepketen:', ...stack.map((frame) => `  ${frame}`));
    lines.push(`Pagina: ${location.pathname}`);
    return lines.join('\n');
  }

  /**
   * Maakt een element met tekst.
   * @param {string} tag De HTML-tag.
   * @param {string} [text] De tekst.
   * @param {string} [className] De klasse.
   * @returns {HTMLElement} Het element.
   */
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /**
   * Toont één fout als kaart in het paneel (de nieuwste bovenaan, hoogstens vijf).
   * @param {object} body Het foutantwoord met `debug`.
   * @returns {void}
   */
  function show(body) {
    if (!body || !body.debug) return;
    const card = element('section', undefined, 'debug-card');
    card.appendChild(element('h4', `Debugmodus · fout ${body.debug.status || ''}`.trim()));
    card.appendChild(element('p', body.message || '(geen melding)', 'debug-message'));
    const list = element('dl');
    for (const [label, value] of detailRows(body)) {
      list.appendChild(element('dt', label));
      list.appendChild(element('dd', value));
    }
    card.appendChild(list);
    const stack = (body.debug.cause && body.debug.cause.stack) || [];
    if (stack.length) {
      const details = element('details');
      details.appendChild(element('summary', 'Aanroepketen'));
      details.appendChild(element('pre', stack.join('\n')));
      card.appendChild(details);
    }
    const actions = element('div', undefined, 'debug-actions');
    const copyButton = element('button', 'Kopiëren', 'primary');
    copyButton.type = 'button';
    copyButton.addEventListener('click', () => {
      /** Laat zien dat het kopiëren gelukt is. */
      const done = () => { copyButton.textContent = 'Gekopieerd'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(asText(body)).then(done, () => { copyButton.textContent = 'Kopiëren lukt niet'; });
    });
    const closeButton = element('button', 'Sluiten');
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => {
      card.remove();
      if (panel && !panel.children.length) panel.remove();
    });
    actions.append(copyButton, closeButton);
    card.appendChild(actions);
    const container = panelElement();
    container.prepend(card);
    while (container.children.length > MAX_CARDS) container.lastElementChild.remove();
  }

  root.AquatechDebug = { show, asText, detailRows };
})(window);
