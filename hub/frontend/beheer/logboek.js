// Beheer > Systeem > Logboek: zoeken en filteren in het centrale logboek (niveau, bron, periode, tekst, foutcode of
// verzoek-id), oudere regels laden en de gevonden regels (hoogstens 5000) naar Excel exporteren.
// API GET /api/admin/logs, zie backend/src/platform/app-log-routes.js.
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const byId = (id) => document.getElementById(id);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string|null} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "19 nov 2026 10:15:03", of – zonder tijdstip.
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'medium' }) : '–');

  const LEVEL_TEXT = { error: 'Fout', warn: 'Waarschuwing', info: 'Info' };
  const PAGE_SIZE = 50;
  const EXPORT_PAGE = 500;
  const EXPORT_MAX = 5000;

  let bound = false;
  let state = { items: [], next: null };

  /**
   * De gekozen filters als zoekopdracht voor de API.
   * @param {number} limit Aantal regels per bladzijde.
   * @param {string} [before] Cursor van de vorige bladzijde.
   * @returns {URLSearchParams} De parameters.
   */
  function queryOf(limit, before = '') {
    const query = new URLSearchParams({ limit: String(limit) });
    const filters = { level: 'log-level', source: 'log-source', from: 'log-from', to: 'log-to', q: 'log-q', tenant: 'log-env' };
    for (const [name, id] of Object.entries(filters)) {
      const value = byId(id).value.trim();
      if (value && !(name === 'tenant' && byId('log-env-wrap').hidden)) query.set(name, value);
    }
    if (before) query.set('before', before);
    return query;
  }

  /**
   * Roept de logboek-API aan.
   * @param {URLSearchParams} query De zoekopdracht.
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(query) {
    const response = await fetch(`api/admin/logs?${query}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
    return body;
  }

  /**
   * Eén regel van de tabel.
   * @param {object} item De logregel.
   * @returns {string} HTML.
   */
  const rowHtml = (item) => {
    const details = item.data && Object.keys(item.data).length ? `<details><summary>Details</summary><pre class="log-data">${esc(JSON.stringify(item.data, null, 2))}</pre></details>` : '';
    const ids = [item.errorCode ? `foutcode ${item.errorCode}` : '', item.requestId ? `verzoek ${item.requestId}` : ''].filter(Boolean).join(' · ');
    return `<tr>
      <td class="nowrap">${esc(when(item.at))}</td>
      <td><span class="mon-badge ${item.level === 'error' ? 'bad' : item.level === 'warn' ? 'warn' : 'info'}">${esc(LEVEL_TEXT[item.level] || item.level)}</span></td>
      <td>${esc(item.source)}${item.scope === 'platform' ? ' <span class="mon-tag">Platform</span>' : ''}</td>
      <td class="wrap">${esc(item.message)}${item.repeat > 1 ? ` <span class="muted small">(${esc(item.repeat)}×${item.firstAt ? `, eerste ${esc(when(item.firstAt))}` : ''})</span>` : ''}${ids ? `<br><span class="muted small">${esc(ids)}</span>` : ''}${details}</td>
      <td class="num">${item.durationMs ? esc(`${item.durationMs} ms`) : ''}</td>
    </tr>`;
  };

  /**
   * Zet de regels in de tabel.
   * @returns {void}
   */
  function render() {
    const head = '<thead><tr><th>Tijdstip</th><th>Niveau</th><th>Bron</th><th>Melding</th><th class="num">Duur</th></tr></thead>';
    byId('log-table').innerHTML = `${head}<tbody>${state.items.length ? state.items.map(rowHtml).join('') : '<tr><td colspan="5" class="muted">Geen regels gevonden.</td></tr>'}</tbody>`;
    byId('log-more').hidden = !state.next;
  }

  /**
   * Vult de keuzelijsten (bronnen en, voor een platformbeheerder, omgevingen) uit een antwoord.
   * @param {object} page Het antwoord van de API.
   * @returns {void}
   */
  function fillChoices(page) {
    const sourceSelect = byId('log-source');
    const chosen = sourceSelect.value;
    sourceSelect.innerHTML = `<option value="">Alle bronnen</option>${page.sources.map((source) => `<option value="${esc(source)}">${esc(source)}</option>`).join('')}`;
    sourceSelect.value = page.sources.includes(chosen) ? chosen : '';
    const environmentSelect = byId('log-env');
    byId('log-env-wrap').hidden = !page.environments.length;
    if (page.environments.length && environmentSelect.options.length !== page.environments.length) {
      environmentSelect.innerHTML = page.environments.map((id) => `<option value="${esc(id)}">${esc(id === page.tenantId ? `${id} (deze omgeving)` : id)}</option>`).join('');
      environmentSelect.value = page.tenantId;
    }
  }

  /**
   * Haalt een bladzijde regels op.
   * @param {boolean} more true = de volgende (oudere) bladzijde erbij, anders opnieuw vanaf de nieuwste.
   * @returns {Promise<void>}
   */
  async function search(more = false) {
    byId('log-err').textContent = '';
    try {
      const page = await api(queryOf(PAGE_SIZE, more && state.next ? state.next : ''));
      state = { items: more ? [...state.items, ...page.items] : page.items, next: page.next };
      fillChoices(page);
      render();
    } catch (error) {
      byId('log-err').textContent = error.message;
    }
  }

  /**
   * Exporteert de gevonden regels (met de gekozen filters, hoogstens 5000) naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = byId('log-export');
    byId('log-err').textContent = '';
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { byId('log-err').textContent = 'Excel-export niet beschikbaar.'; return; }
    button.disabled = true;
    try {
      const items = [];
      let before = '';
      while (items.length < EXPORT_MAX) {
        const page = await api(queryOf(EXPORT_PAGE, before));
        items.push(...page.items);
        if (!page.next) break;
        before = page.next;
      }
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Logboek');
      sheet.columns = [
        { header: 'Tijdstip (laatste)', key: 'at', width: 22 }, { header: 'Eerste keer', key: 'firstAt', width: 22 }, { header: 'Niveau', key: 'level', width: 14 }, { header: 'Bron', key: 'source', width: 14 },
        { header: 'Melding', key: 'message', width: 70 }, { header: 'Foutcode', key: 'errorCode', width: 12 }, { header: 'Verzoek-id', key: 'requestId', width: 16 },
        { header: 'Duur (ms)', key: 'durationMs', width: 11 }, { header: 'Aantal', key: 'repeat', width: 9 }, { header: 'Details', key: 'data', width: 60 },
      ];
      sheet.getRow(1).font = { bold: true };
      items.slice(0, EXPORT_MAX).forEach((item) => sheet.addRow({
        at: when(item.at), firstAt: item.firstAt ? when(item.firstAt) : '', level: LEVEL_TEXT[item.level] || item.level, source: item.source, message: item.message, errorCode: item.errorCode,
        requestId: item.requestId, durationMs: item.durationMs || '', repeat: item.repeat, data: item.data && Object.keys(item.data).length ? JSON.stringify(item.data) : '',
      }));
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `logboek_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    } catch (error) {
      byId('log-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Opent de sectie: knoppen koppelen (één keer) en de nieuwste regels laden.
   * @returns {void}
   */
  function load() {
    if (!bound) {
      bound = true;
      byId('log-search').addEventListener('click', () => search());
      byId('log-more').addEventListener('click', () => search(true));
      byId('log-export').addEventListener('click', exportExcel);
      byId('log-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
      for (const id of ['log-level', 'log-source', 'log-from', 'log-to', 'log-env']) byId(id).addEventListener('change', () => search());
    }
    search();
  }

  window.BeheerLogboek = { load };
})();
