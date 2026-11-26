// Archief in de overzichten: filter (verbergen / ook tonen / alleen archief) en de acties Archiveren en Terughalen, alleen voor wie het
// recht beheer heeft. Eén gedeeld onderdeel voor offertes, werkorders, facturen, webshopbestellingen en plannen; de server doet de
// controle (welke stukken in het archief mogen) en de pagina laadt de lijst opnieuw via de callback onChange.
(function (root) {
  /** Hoeveel stukken de server per verzoek aanneemt. */
  const MAX_PER_REQUEST = 500;

  /** De keuzes van het archieffilter: waarde voor ?archief= (leeg = standaard) en het label. */
  const MODES = [['', 'Archief verbergen'], ['toon', 'Archief ook tonen'], ['alleen', 'Alleen archief']];

  /**
   * Maakt een element met tekst of HTML-vrije inhoud.
   * @param {string} tag Naam van het element.
   * @param {object} [attributes] Eigenschappen (className, textContent, type, hidden, title).
   * @returns {HTMLElement} Het nieuwe element.
   */
  function element(tag, attributes = {}) {
    return Object.assign(document.createElement(tag), attributes);
  }

  /**
   * Stuurt een lijst id's in porties naar de archiefroute van de server.
   * @param {string} action 'archive' of 'restore'.
   * @param {string} kind Soortsleutel (offertes, werkorders, facturen, bestellingen, plannen).
   * @param {string[]} ids De id's.
   * @returns {Promise<{ changed: number, skipped: number }>} Totaal gewijzigd en overgeslagen.
   */
  async function send(action, kind, ids) {
    let changed = 0;
    let skipped = 0;
    for (let start = 0; start < ids.length; start += MAX_PER_REQUEST) {
      const response = await fetch(`../api/admin/archive/${action}`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ids: ids.slice(start, start + MAX_PER_REQUEST) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || root.AquatechCommon.statusMessage(response.status));
      changed += action === 'archive' ? Number((result.archived || {})[kind] || 0) : Number((result.restored || {})[kind] || 0);
      skipped += Number((result.skipped || {})[kind] || 0);
    }
    return { changed, skipped };
  }

  /**
   * Zet het archieffilter en de acties bij een overzicht. Zonder het recht beheer gebeurt er niets en blijft `param()` leeg.
   * @param {object} options kind (soortsleutel), filters (element met de filters van het overzicht), table (de tabel), onChange (laadt de lijst opnieuw),
   *   optioneel selected (de selectie van de pagina zelf, een Set met id's; dan komt er geen eigen kolom) en bar (de bestaande balk met bulkacties waar de knoppen in komen).
   * @returns {{ param: function(): string, withParam: function(string): string }} param geeft `archief=…` of leeg; withParam plakt dat aan een adres.
   */
  function attach({ kind, filters, table, onChange, selected = null, bar = null }) {
    const state = { mode: '', own: new Set(), enabled: false };
    const selection = selected || state.own;
    let archiveButton;
    let restoreButton;
    let countLabel;
    let messageLabel;
    let ownBar;

    /**
     * Geeft het deel van de query voor de gekozen archiefstand.
     * @returns {string} `archief=toon`, `archief=alleen` of een lege tekst.
     */
    const param = () => (state.mode ? `archief=${state.mode}` : '');

    /**
     * Voegt de archiefkeuze toe aan een adres.
     * @param {string} url Het adres, met of zonder query.
     * @returns {string} Het adres met `archief=…` erachter als er een keuze is.
     */
    const withParam = (url) => (param() ? `${url}${url.includes('?') ? '&' : '?'}${param()}` : url);

    /** Werkt de knoppen, de teller en de zichtbaarheid van de balk bij. */
    function refresh() {
      if (!state.enabled) return;
      archiveButton.hidden = state.mode === 'alleen';
      restoreButton.hidden = state.mode === '';
      if (ownBar) {
        ownBar.hidden = !selection.size;
        countLabel.textContent = `${selection.size} geselecteerd`;
      }
    }

    /**
     * Archiveert of haalt de geselecteerde stukken terug en laadt de lijst opnieuw.
     * @param {string} action 'archive' of 'restore'.
     * @returns {Promise<void>}
     */
    async function run(action) {
      const ids = [...selection];
      if (!ids.length) return;
      archiveButton.disabled = true;
      restoreButton.disabled = true;
      try {
        const { changed, skipped } = await send(action, kind, ids);
        const word = action === 'archive' ? 'gearchiveerd' : 'teruggehaald';
        messageLabel.textContent = `${changed} ${word}${skipped ? `, ${skipped} overgeslagen omdat ze nog niet afgerond zijn` : ''}.`;
        messageLabel.classList.toggle('error', false);
        selection.clear();
        state.own.clear();
        await onChange();
      } catch (error) {
        messageLabel.textContent = error.message;
        messageLabel.classList.toggle('error', true);
        // Bij meer dan één portie kan een deel al verwerkt zijn: lijst opnieuw laden en selectie wissen, zodat niets dubbel wordt verstuurd.
        selection.clear();
        state.own.clear();
        try { await onChange(); } catch (reloadError) { /* de melding van de eerste fout blijft staan */ }
      }
      archiveButton.disabled = false;
      restoreButton.disabled = false;
      refresh();
    }

    /** Zet een kolom met vinkjes achter elke rij van de tabel (alleen als de pagina geen eigen selectie heeft). */
    function decorate() {
      if (!state.enabled || selected) return;
      const rows = [...table.querySelectorAll('tbody tr[data-id]')];
      const present = new Set(rows.map((row) => row.dataset.id));
      for (const id of [...state.own]) if (!present.has(id)) state.own.delete(id);
      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('th.c-archive')) {
        const head = element('th', { className: 'c-archive' });
        const all = element('input', { type: 'checkbox', title: 'Alles selecteren' });
        all.setAttribute('aria-label', 'Alle zichtbare regels selecteren voor het archief');
        all.addEventListener('change', () => {
          for (const row of rows) { if (all.checked) state.own.add(row.dataset.id); else state.own.delete(row.dataset.id); }
          decorate();
          refresh();
        });
        head.append(all);
        headRow.append(head);
      }
      for (const row of rows) {
        let cell = row.querySelector('td.c-archive');
        if (!cell) {
          cell = element('td', { className: 'c-archive' });
          const box = element('input', { type: 'checkbox' });
          box.setAttribute('aria-label', 'Selecteren voor het archief');
          cell.append(box);
          // Een klik op het vinkje mag de rij niet openen.
          cell.addEventListener('click', (event) => event.stopPropagation());
          box.addEventListener('change', () => {
            if (box.checked) state.own.add(row.dataset.id); else state.own.delete(row.dataset.id);
            decorate();
            refresh();
          });
          row.append(cell);
        }
        cell.querySelector('input').checked = state.own.has(row.dataset.id);
      }
      const all = table.querySelector('th.c-archive input');
      if (all) all.checked = rows.length > 0 && rows.every((row) => state.own.has(row.dataset.id));
    }

    /** Bouwt het filter en de knoppen op zodra bekend is dat de gebruiker beheerder is. */
    function build() {
      state.enabled = true;
      const label = element('label', { className: 'archive-filter' });
      label.append('Archief ');
      const select = element('select');
      select.setAttribute('aria-label', 'Archief');
      for (const [value, text] of MODES) select.append(element('option', { value, textContent: text }));
      select.addEventListener('change', () => {
        state.mode = select.value;
        selection.clear();
        state.own.clear();
        refresh();
        Promise.resolve(onChange()).catch(() => {});
      });
      label.append(select);
      messageLabel = element('span', { className: 'archive-message muted small', role: 'status' });
      filters.append(label, messageLabel);
      archiveButton = element('button', { className: 'btn', type: 'button', textContent: 'Archiveren', title: 'Haalt de geselecteerde afgeronde stukken uit de lijsten; terughalen kan altijd' });
      restoreButton = element('button', { className: 'btn', type: 'button', textContent: 'Terughalen', hidden: true });
      archiveButton.addEventListener('click', () => run('archive'));
      restoreButton.addEventListener('click', () => run('restore'));
      if (bar) {
        bar.append(archiveButton, restoreButton);
      } else {
        ownBar = element('div', { className: 'archive-bar', hidden: true });
        countLabel = element('span', { className: 'muted small' });
        const clear = element('button', { className: 'btn', type: 'button', textContent: 'Selectie wissen' });
        clear.addEventListener('click', () => { state.own.clear(); decorate(); refresh(); });
        ownBar.append(countLabel, archiveButton, restoreButton, clear);
        filters.insertAdjacentElement('afterend', ownBar);
        new MutationObserver(decorate).observe(table, { childList: true });
        decorate();
      }
      refresh();
    }

    const meRequest = root.AquatechCommon.getJson('api/me');
    Promise.resolve(meRequest).then((me) => {
      const rights = (me && me.rights) || [];
      if (rights.includes('beheer') || (me && me.user && me.user.platform_admin)) build();
    }).catch(() => {});
    return { param, withParam };
  }

  root.AquatechArchive = { attach };
})(typeof window !== 'undefined' ? window : globalThis);
