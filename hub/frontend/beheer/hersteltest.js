// Beheer > Systeem > Hersteltest van de back-up (lokaal, API /api/admin/restore-test, backend/src/platform/restore-test.js) en
// Hersteltest van de Google Drive-back-up (API /api/admin/restore-test-drive, backend/src/platform/drive-restore-test.js):
// laatste uitslag, planning (aan/uit, dag, tijd), "Nu testen" en de historie met Excel-export. Beide schermen gebruiken
// dezelfde code (`createPanel`, ids met voorvoegsel `rt-` of `rtd-`). Zolang er een test loopt of aangevraagd is, vraagt de
// pagina elke paar seconden de stand op.
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
   * @returns {string} Bijv. "13 nov 2026 10:15", of – zonder tijdstip.
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /**
   * Een duur in seconden als leesbare tekst.
   * @param {number} seconds Aantal seconden.
   * @returns {string} Bijv. "2 min 5 s".
   */
  const duration = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`);
  /**
   * Een bestandsgrootte als leesbare tekst.
   * @param {number} bytes Aantal bytes.
   * @returns {string} Bijv. "12,3 MB".
   */
  const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);

  const STATE_TEXT = { bezig: 'Bezig', geslaagd: 'Geslaagd', waarschuwing: 'Met opmerkingen', mislukt: 'Mislukt' };
  const STATE_CLASS = { bezig: 'info', geslaagd: 'ok', waarschuwing: '', mislukt: 'bad' };
  const POLL_MS = 4000;
  const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

  /**
   * Bouwt één scherm voor een hersteltest.
   * @param {{ prefix: string, url: string, fileName: string }} config Voorvoegsel van de ids (rt of rtd), API-adres en begin van de bestandsnaam van de Excel-export.
   * @returns {{ load: Function, stop: Function }} Openen en stoppen van het scherm.
   */
  function createPanel({ prefix, url, fileName }) {
    let bound = false;
    let pollTimer = null;
    let current = null;
    let formDirty = false;

    /**
     * Roept de API aan.
     * @param {string} method HTTP-methode.
     * @param {string} url Adres (relatief).
     * @param {object} [body] JSON-inhoud.
     * @returns {Promise<object>} Het antwoord.
     */
    async function call(method, url, body) {
      const response = await fetch(url, {
        method, cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || window.AquatechCommon.statusMessage(response.status));
      return data;
    }

    /**
     * Zet de uitslag van de laatste (of lopende) run op het scherm.
     * @param {object|null} run De run, of null.
     * @returns {void}
     */
    function renderLast(run) {
      const badge = byId(`${prefix}-badge`);
      if (!run) {
        badge.textContent = 'Nog niet getest';
        badge.className = 'mon-badge info';
        byId(`${prefix}-last-text`).textContent = '';
        for (const name of ['backup', 'tables', 'version', 'rows', 'duration']) byId(`${prefix}-${name}`).textContent = '–';
        byId(`${prefix}-details`).innerHTML = '';
        return;
      }
      badge.textContent = STATE_TEXT[run.state] || run.state;
      badge.className = `mon-badge ${STATE_CLASS[run.state] || ''}`.trim();
      byId(`${prefix}-last-text`).textContent = `${when(run.finishedAt || run.startedAt)}${run.trigger === 'handmatig' ? ' · handmatig gestart' : ''}`;
      byId(`${prefix}-backup`).textContent = run.backup.name ? `${run.backup.name} (${size(run.backup.bytes)}, ${when(run.backup.createdAt)})` : '–';
      byId(`${prefix}-tables`).textContent = run.tables.backup ? `${run.tables.backup} teruggezet, ${run.tables.production} in productie` : '–';
      byId(`${prefix}-version`).textContent = run.schemaVersion.backup ? `${run.schemaVersion.backup} (productie ${run.schemaVersion.production})` : '–';
      byId(`${prefix}-rows`).textContent = run.rows.checked ? `${run.rows.checked} tabellen vergeleken, ${run.rows.deviating.length} afwijkend` : '–';
      byId(`${prefix}-duration`).textContent = run.state === 'bezig' ? '…' : duration(run.durationSec);
      const parts = [];
      if (run.message) parts.push(`<p class="small">${esc(run.message)}</p>`);
      if (run.rows.deviating.length) parts.push(`<p class="small">Afwijkende tabellen: ${run.rows.deviating.map((item) => `${esc(item.table)} (back-up ${item.backup}, productie ${item.production})`).join(', ')}.</p>`);
      if (run.tables.missing.length) parts.push(`<p class="small">Niet in de back-up: ${run.tables.missing.map(esc).join(', ')}.</p>`);
      if (run.sanity.length) parts.push(`<ul class="small">${run.sanity.map((item) => `<li>${item.ok ? '✓' : '✗'} ${esc(item.name)}${item.ok ? '' : ' (niet in orde)'}</li>`).join('')}</ul>`);
      byId(`${prefix}-details`).innerHTML = parts.join('');
    }

    /**
     * Zet de stand op het scherm.
     * @param {object} view De stand (zie restore-test.js view()).
     * @returns {void}
     */
    function render(view) {
      current = view;
      byId(`${prefix}-none`).hidden = view.configured !== false;
      byId(`${prefix}-main`).hidden = view.configured === false;
      if (view.configured === false) return;
      renderLast(view.running || view.latest);
      const running = Boolean(view.running);
      byId(`${prefix}-run`).disabled = running || view.requested;
      byId(`${prefix}-state`).textContent = running ? 'De hersteltest loopt…' : view.requested ? 'De hersteltest is aangevraagd; de server begint zo.' : '';
      if (!formDirty) {
        byId(`${prefix}-enabled`).checked = view.policy.enabled;
        byId(`${prefix}-day`).value = String(view.policy.day);
        byId(`${prefix}-time`).value = view.policy.time;
      }
      byId(`${prefix}-next`).textContent = view.nextRunAt ? `Volgende test: ${when(view.nextRunAt)} (${DAYS[new Date(view.nextRunAt).getDay()]}).` : 'De wekelijkse hersteltest staat uit.';
      byId(`${prefix}-history`).innerHTML = view.runs.length
        ? view.runs.map((run) => `<tr><td>${esc(when(run.startedAt))}</td><td><span class="mon-badge ${STATE_CLASS[run.state] || ''}">${esc(STATE_TEXT[run.state] || run.state)}</span></td>`
          + `<td>${run.trigger === 'handmatig' ? 'Handmatig' : 'Schema'}</td><td>${esc(run.backup.name || '–')}</td><td>${esc(duration(run.durationSec))}</td><td>${esc(run.message || '')}</td></tr>`).join('')
        : '<tr><td colspan="6" class="muted">Nog geen hersteltest gedraaid.</td></tr>';
    }

    /**
     * Vraagt de stand op en plant de volgende vraag zolang er een test loopt of aangevraagd is.
     * @returns {Promise<void>}
     */
    async function refresh() {
      clearTimeout(pollTimer);
      try {
        const view = await call('GET', url);
        byId(`${prefix}-err`).textContent = '';
        render(view);
        if (bound && (view.running || view.requested)) pollTimer = setTimeout(refresh, POLL_MS);
      } catch (error) {
        byId(`${prefix}-err`).textContent = error.message;
      }
    }

    /**
     * Slaat de planning op.
     * @param {Event} event Het submit-event.
     * @returns {Promise<void>}
     */
    async function save(event) {
      event.preventDefault();
      byId(`${prefix}-err`).textContent = '';
      try {
        const view = await call('PUT', url, { enabled: byId(`${prefix}-enabled`).checked, day: Number(byId(`${prefix}-day`).value), time: byId(`${prefix}-time`).value });
        formDirty = false;
        render(view);
      } catch (error) {
        byId(`${prefix}-err`).textContent = error.message;
      }
    }

    /**
     * Vraagt een hersteltest aan en volgt de voortgang.
     * @returns {Promise<void>}
     */
    async function runNow() {
      byId(`${prefix}-err`).textContent = '';
      byId(`${prefix}-run`).disabled = true;
      try {
        render(await call('POST', `${url}/run`, {}));
        refresh();
      } catch (error) {
        byId(`${prefix}-err`).textContent = error.message;
        byId(`${prefix}-run`).disabled = false;
      }
    }

    /**
     * Exporteert de historie naar Excel.
     * @returns {Promise<void>}
     */
    async function exportExcel() {
      byId(`${prefix}-err`).textContent = '';
      if (!current || !current.runs.length) { byId(`${prefix}-err`).textContent = 'Er is nog niets om te exporteren.'; return; }
      if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { byId(`${prefix}-err`).textContent = 'Excel-export niet beschikbaar.'; return; }
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Hersteltesten');
      sheet.columns = [
        { header: 'Gestart', key: 'startedAt', width: 22 }, { header: 'Afgerond', key: 'finishedAt', width: 22 }, { header: 'Uitslag', key: 'state', width: 16 }, { header: 'Start', key: 'trigger', width: 12 },
        { header: 'Back-up', key: 'backup', width: 40 }, { header: 'Grootte (bytes)', key: 'bytes', width: 16 }, { header: 'Tabellen teruggezet', key: 'tables', width: 18 }, { header: 'Tabellen productie', key: 'tablesProd', width: 18 },
        { header: 'Schemaversie back-up', key: 'versionBackup', width: 20 }, { header: 'Schemaversie productie', key: 'versionProd', width: 22 }, { header: 'Tabellen vergeleken', key: 'checked', width: 18 },
        { header: 'Afwijkende tabellen', key: 'deviating', width: 40 }, { header: 'Duur (s)', key: 'duration', width: 10 }, { header: 'Opmerking', key: 'message', width: 70 },
      ];
      sheet.getRow(1).font = { bold: true };
      current.runs.forEach((run) => sheet.addRow({
        startedAt: when(run.startedAt), finishedAt: when(run.finishedAt), state: STATE_TEXT[run.state] || run.state, trigger: run.trigger === 'handmatig' ? 'Handmatig' : 'Schema',
        backup: run.backup.name, bytes: run.backup.bytes, tables: run.tables.backup, tablesProd: run.tables.production, versionBackup: run.schemaVersion.backup, versionProd: run.schemaVersion.production,
        checked: run.rows.checked, deviating: run.rows.deviating.map((item) => `${item.table} (${item.backup}/${item.production})`).join(', '), duration: run.durationSec, message: run.message,
      }));
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    }

    /**
     * Opent de sectie: knoppen koppelen (één keer) en de stand laden.
     * @returns {void}
     */
    function load() {
      if (!bound) {
        bound = true;
        byId(`${prefix}-form`).addEventListener('submit', save);
        byId(`${prefix}-form`).addEventListener('input', () => { formDirty = true; });
        byId(`${prefix}-run`).addEventListener('click', runNow);
        byId(`${prefix}-export`).addEventListener('click', exportExcel);
      }
      formDirty = false;
      refresh();
    }

    /**
     * Stopt het volgen van de stand (bij het verlaten van de sectie).
     * @returns {void}
     */
    function stop() {
      clearTimeout(pollTimer);
    }

    return { load, stop };
  }

  window.BeheerHersteltest = createPanel({ prefix: 'rt', url: 'api/admin/restore-test', fileName: 'hersteltesten' });
  window.BeheerHersteltestDrive = createPanel({ prefix: 'rtd', url: 'api/admin/restore-test-drive', fileName: 'hersteltesten-google-drive' });
})();
