// Beheer > Systeem > Bewaking en meldingen: de stand van elke controle (groen/oranje/rood), openstaande problemen
// bovenaan, de knoppen Nu controleren en Testmelding versturen, het formulier voor ontvangers, webhook, herinneringen,
// herstelmelding en (alleen voor de platformbeheerder) heartbeat-adres en drempels, dempen per controle en de
// geschiedenis met Excel-export. API /api/admin/monitoring, zie backend/src/platform/monitoring-routes.js.
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
   * Leest een veld van een incident of controle, in camelCase of als kolomnaam.
   * @param {object} item Het incident of de controle.
   * @param {string} camel De naam in camelCase, bijv. lastAt.
   * @returns {*} De waarde, of een lege tekst.
   */
  const field = (item, camel) => {
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return item[camel] != null ? item[camel] : item[snake] != null ? item[snake] : '';
  };

  const THRESHOLD_KEYS = ['backupMaxHours', 'diskMinFreePct', 'diskMinFreeMb', 'errorsPerHour', 'dbSlowMs'];
  const SEVERITY_TEXT = { fout: 'Fout', waarschuwing: 'Waarschuwing' };
  const STATE_TEXT = { open: 'Openstaand', opgelost: 'Opgelost' };
  const REFRESH_MS = 60 * 1000;
  const PAGE_SIZE = 50;

  let current = null;
  let started = false;
  let bound = false;
  let refreshTimer = null;
  let history = { items: [], next: null };

  /**
   * Roept de bewakings-API aan.
   * @param {string} path Pad na api/admin/monitoring (bijv. '/config'), of leeg.
   * @param {{ method?: string, body?: object }} [options] Methode en inhoud (wordt JSON).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const response = await fetch(`api/admin/monitoring${path}`, {
      method, cache: 'no-store',
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
    return body;
  }

  /**
   * De kleur en tekst van een controle.
   * @param {object} check De controle (status, severity) uit checkStates.
   * @param {boolean} muted Of de controle gedempt is.
   * @returns {{ tone: string, text: string }} tone: ok, warn, bad of idle.
   */
  function toneOf(check, muted) {
    let result = { tone: 'idle', text: 'Nog niet gecontroleerd' };
    if (check.status === 'ok') result = { tone: 'ok', text: 'In orde' };
    else if (check.status === 'open') result = check.severity === 'fout' ? { tone: 'bad', text: 'Fout' } : { tone: 'warn', text: 'Waarschuwing' };
    else if (check.status === 'overgeslagen') result = { tone: 'idle', text: 'Niet ingesteld' };
    return muted ? { ...result, text: `${result.text} · gedempt` } : result;
  }

  /**
   * De samenvatting bovenaan: alles in orde of hoeveel problemen er openstaan, en wanneer er het laatst gecontroleerd is.
   * @param {object} view Het overzicht van de server.
   * @returns {void}
   */
  function renderSummary(view) {
    const open = view.open || { fout: 0, waarschuwing: 0 };
    const parts = [];
    if (open.fout) parts.push(`${open.fout} ${open.fout === 1 ? 'fout' : 'fouten'}`);
    if (open.waarschuwing) parts.push(`${open.waarschuwing} ${open.waarschuwing === 1 ? 'waarschuwing' : 'waarschuwingen'}`);
    const config = view.config || {};
    const tone = config.enabled === false ? 'idle' : open.fout ? 'bad' : open.waarschuwing ? 'warn' : 'ok';
    byId('mon-summary-dot').className = `mon-dot ${tone}`;
    byId('mon-summary-title').textContent = config.enabled === false ? 'Bewaking staat uit' : parts.length ? `${parts.join(' en ')} openstaand` : 'Alles in orde';
    const lastRun = (view.checks || []).map((check) => String(field(check, 'lastRunAt') || '')).filter(Boolean).sort().pop();
    const recipients = (config.recipients || []).length;
    byId('mon-summary-sub').textContent = `Laatste controle: ${when(lastRun)}. ${recipients ? `Meldingen gaan naar ${recipients} ${recipients === 1 ? 'adres' : 'adressen'}.` : 'Nog geen ontvangers ingesteld.'}`;
    byId('mon-nomail').hidden = view.mailConfigured !== false;
  }

  /**
   * De openstaande problemen als kaarten bovenaan (fouten eerst).
   * @param {object[]} incidents De incidenten uit het overzicht.
   * @returns {void}
   */
  function renderOpen(incidents) {
    const open = incidents.filter((incident) => incident.state === 'open')
      .sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'fout' ? -1 : 1));
    byId('mon-open').innerHTML = open.length ? `<div class="card-grid mon-open-grid">${open.map((incident) => `
      <article class="card mon-incident ${incident.severity === 'fout' ? 'bad' : 'warn'}">
        <h3>${esc(incident.title)}${incident.scope === 'platform' ? ' <span class="mon-tag">Platform</span>' : ''}</h3>
        <p class="mon-message">${esc(incident.message)}</p>
        <p class="muted small">Sinds ${esc(when(field(incident, 'firstAt')))} · laatst gezien ${esc(when(field(incident, 'lastAt')))}${Number(incident.occurrences) > 1 ? ` · ${esc(incident.occurrences)}×` : ''}</p>
        ${field(incident, 'notifyError') ? `<p class="small mon-notify-error">Melding versturen mislukt: ${esc(field(incident, 'notifyError'))}</p>` : ''}
      </article>`).join('')}</div>` : '';
  }

  /**
   * De lijst met controles, elk met een stip, de laatste uitkomst en een vinkje Dempen.
   * @param {object} view Het overzicht van de server.
   * @returns {void}
   */
  function renderChecks(view) {
    const muted = new Set((view.config && view.config.muted) || []);
    const checks = view.checks || [];
    byId('mon-checks').innerHTML = checks.length ? checks.map((check) => {
      const tone = toneOf(check, muted.has(check.key));
      return `<li class="mon-check">
        <span class="mon-dot ${tone.tone}" aria-hidden="true"></span>
        <div class="mon-check-body">
          <strong>${esc(check.title || check.key)}</strong>${check.scope === 'platform' ? ' <span class="mon-tag">Platform</span>' : ''}
          <span class="small mon-check-state">${esc(tone.text)}${field(check, 'lastRunAt') ? ` · ${esc(when(field(check, 'lastRunAt')))}` : ''}</span>
          ${check.message && check.status === 'open' ? `<span class="muted small">${esc(check.message)}</span>` : ''}
        </div>
        <label class="mon-mute small"><input type="checkbox" data-mute="${esc(check.key)}"${muted.has(check.key) ? ' checked' : ''}> Dempen</label>
      </li>`;
    }).join('') : '<li class="muted small">Nog geen controles. Ze starten een paar minuten na het opstarten van de server.</li>';
  }

  /**
   * Zet de instelling in het formulier; de platformvelden alleen voor wie ze mag zien.
   * @param {object} view Het overzicht van de server.
   * @returns {void}
   */
  function renderForm(view) {
    const config = view.config || {};
    byId('mon-enabled').checked = config.enabled !== false;
    byId('mon-recipients').value = (config.recipients || []).join(', ');
    byId('mon-webhook').value = config.webhookUrl || '';
    byId('mon-reminder').value = config.reminderHours == null ? 24 : config.reminderHours;
    byId('mon-recovery').checked = config.notifyRecovery !== false;
    byId('mon-platform').hidden = !view.canPlatform;
    if (view.canPlatform) {
      byId('mon-heartbeat').value = config.heartbeatUrl || '';
      const thresholds = config.thresholds || {};
      THRESHOLD_KEYS.forEach((key) => { byId(`mon-${key}`).value = thresholds[key] == null ? '' : thresholds[key]; });
    }
  }

  /**
   * Een tabelrij van de geschiedenis.
   * @param {object} incident Het incident.
   * @returns {string} HTML.
   */
  const historyRow = (incident) => `<tr>
    <td>${esc(when(field(incident, 'lastAt')))}</td>
    <td><span class="mon-badge ${incident.severity === 'fout' ? 'bad' : 'warn'}">${esc(SEVERITY_TEXT[incident.severity] || incident.severity)}</span></td>
    <td>${esc(STATE_TEXT[incident.state] || incident.state)}</td>
    <td class="wrap"><strong>${esc(incident.title)}</strong>${incident.scope === 'platform' ? ' <span class="mon-tag">Platform</span>' : ''}<br><span class="muted small">${esc(incident.message)}</span></td>
    <td>${esc(when(field(incident, 'firstAt')))}</td>
    <td>${esc(incident.state === 'opgelost' ? when(field(incident, 'resolvedAt')) : '–')}</td>
    <td class="num">${esc(incident.occurrences || 1)}</td>
  </tr>`;

  /**
   * Zet de geschiedenis in de tabel.
   * @returns {void}
   */
  function renderHistory() {
    const head = '<thead><tr><th>Laatst gezien</th><th>Ernst</th><th>Stand</th><th>Melding</th><th>Begonnen</th><th>Opgelost</th><th class="num">Aantal</th></tr></thead>';
    byId('mon-history').innerHTML = `${head}<tbody>${history.items.length ? history.items.map(historyRow).join('') : '<tr><td colspan="7" class="muted">Nog geen meldingen.</td></tr>'}</tbody>`;
    byId('mon-more').hidden = !history.next;
  }

  /**
   * Haalt een bladzijde van de geschiedenis op.
   * @param {boolean} more true = de volgende (oudere) bladzijde erbij, anders opnieuw vanaf de nieuwste.
   * @returns {Promise<void>}
   */
  async function loadHistory(more = false) {
    const state = byId('mon-state').value;
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (state) query.set('state', state);
    if (more && history.next) query.set('before', history.next);
    try {
      const page = await api(`/incidents?${query}`);
      history = { items: more ? [...history.items, ...page.incidents] : page.incidents, next: page.next };
      renderHistory();
    } catch (error) {
      byId('mon-err').textContent = error.message;
    }
  }

  /**
   * Zet het hele overzicht op het scherm.
   * @param {object} view Het overzicht van de server.
   * @param {{ keepForm?: boolean }} [options] keepForm = het formulier niet overschrijven (de gebruiker typt misschien).
   * @returns {void}
   */
  function render(view, { keepForm = false } = {}) {
    current = view;
    renderSummary(view);
    renderOpen(view.incidents || []);
    renderChecks(view);
    if (!keepForm) renderForm(view);
  }

  /**
   * Vraagt het overzicht op en plant de volgende keer zolang de sectie open staat.
   * @param {{ keepForm?: boolean }} [options] Zie render.
   * @returns {Promise<void>}
   */
  async function refresh(options = {}) {
    clearTimeout(refreshTimer);
    try {
      render(await api(''), options);
      byId('mon-err').textContent = '';
    } catch (error) {
      byId('mon-err').textContent = error.message;
    }
    if (started) refreshTimer = setTimeout(() => refresh({ keepForm: true }), REFRESH_MS);
  }

  /**
   * Leest het formulier uit als wijziging van de instelling.
   * @returns {object} De velden voor PUT /config.
   */
  function formValues() {
    const values = {
      enabled: byId('mon-enabled').checked,
      recipients: byId('mon-recipients').value.split(/[\s,;]+/).map((address) => address.trim()).filter(Boolean),
      webhookUrl: byId('mon-webhook').value.trim(),
      reminderHours: Number(byId('mon-reminder').value || 0),
      notifyRecovery: byId('mon-recovery').checked,
    };
    if (current && current.canPlatform) {
      values.heartbeatUrl = byId('mon-heartbeat').value.trim();
      values.thresholds = {};
      THRESHOLD_KEYS.forEach((key) => {
        const raw = byId(`mon-${key}`).value;
        if (raw !== '') values.thresholds[key] = Number(raw);
      });
    }
    return values;
  }

  /**
   * Slaat het formulier op.
   * @param {Event} event Het submit-event.
   * @returns {Promise<void>}
   */
  async function save(event) {
    event.preventDefault();
    const button = byId('mon-save');
    byId('mon-form-err').textContent = '';
    byId('mon-saved').textContent = '';
    button.disabled = true;
    try {
      render(await api('/config', { method: 'PUT', body: formValues() }));
      byId('mon-saved').textContent = 'Opgeslagen.';
    } catch (error) {
      byId('mon-form-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Dempt een controle of heft het dempen op, meteen opgeslagen.
   * @param {Event} event Het change-event van een vinkje Dempen.
   * @returns {Promise<void>}
   */
  async function toggleMute(event) {
    const box = event.target.closest('input[data-mute]');
    if (!box || !current) return;
    const muted = new Set((current.config && current.config.muted) || []);
    if (box.checked) muted.add(box.dataset.mute); else muted.delete(box.dataset.mute);
    box.disabled = true;
    try {
      render(await api('/config', { method: 'PUT', body: { muted: [...muted] } }), { keepForm: true });
    } catch (error) {
      box.checked = !box.checked;
      byId('mon-err').textContent = error.message;
    } finally {
      box.disabled = false;
    }
  }

  /**
   * Voert alle controles nu uit en toont de nieuwe stand.
   * @returns {Promise<void>}
   */
  async function runNow() {
    const button = byId('mon-run');
    byId('mon-err').textContent = '';
    byId('mon-feedback').textContent = 'Bezig met controleren…';
    button.disabled = true;
    try {
      const view = await api('/run', { method: 'POST' });
      render(view, { keepForm: true });
      byId('mon-feedback').textContent = `Gecontroleerd (${view.ran || 0} ${view.ran === 1 ? 'controle' : 'controles'}).`;
      loadHistory();
    } catch (error) {
      byId('mon-feedback').textContent = '';
      byId('mon-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Verstuurt een testmelding en laat per kanaal zien of het lukte.
   * @returns {Promise<void>}
   */
  async function sendTest() {
    const button = byId('mon-test');
    byId('mon-err').textContent = '';
    byId('mon-feedback').textContent = 'Testmelding versturen…';
    button.disabled = true;
    try {
      const result = await api('/test', { method: 'POST' });
      const labels = { mail: 'Mail', webhook: 'Webhook', heartbeat: 'Heartbeat' };
      byId('mon-feedback').textContent = Object.keys(labels).filter((key) => result[key])
        .map((key) => `${labels[key]}: ${result[key].ok ? 'gelukt' : 'niet gelukt'}${result[key].message ? ` (${result[key].message})` : ''}`).join(' · ') || 'Verstuurd.';
    } catch (error) {
      byId('mon-feedback').textContent = '';
      byId('mon-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Exporteert de geschiedenis (met het gekozen filter, hoogstens 5000 meldingen) naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = byId('mon-export');
    byId('mon-err').textContent = '';
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { byId('mon-err').textContent = 'Excel-export niet beschikbaar.'; return; }
    button.disabled = true;
    try {
      const state = byId('mon-state').value;
      const items = [];
      let before = '';
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({ limit: '500' });
        if (state) query.set('state', state);
        if (before) query.set('before', before);
        const result = await api(`/incidents?${query}`);
        items.push(...result.incidents);
        if (!result.next) break;
        before = result.next;
      }
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Bewaking');
      sheet.columns = [
        { header: 'Laatst gezien', key: 'lastAt', width: 20 }, { header: 'Begonnen', key: 'firstAt', width: 20 },
        { header: 'Opgelost', key: 'resolvedAt', width: 20 }, { header: 'Ernst', key: 'severity', width: 14 },
        { header: 'Stand', key: 'state', width: 12 }, { header: 'Soort', key: 'scope', width: 12 },
        { header: 'Controle', key: 'title', width: 30 }, { header: 'Melding', key: 'message', width: 60 },
        { header: 'Aantal', key: 'occurrences', width: 9 }, { header: 'Meldingsfout', key: 'notifyError', width: 40 },
      ];
      sheet.getRow(1).font = { bold: true };
      items.forEach((incident) => sheet.addRow({
        lastAt: when(field(incident, 'lastAt')), firstAt: when(field(incident, 'firstAt')),
        resolvedAt: incident.state === 'opgelost' ? when(field(incident, 'resolvedAt')) : '',
        severity: SEVERITY_TEXT[incident.severity] || incident.severity, state: STATE_TEXT[incident.state] || incident.state,
        scope: incident.scope === 'platform' ? 'Platform' : 'Omgeving', title: incident.title, message: incident.message,
        occurrences: Number(incident.occurrences || 1), notifyError: field(incident, 'notifyError'),
      }));
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `bewaking_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    } catch (error) {
      byId('mon-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Opent de sectie: knoppen koppelen (één keer), het overzicht en de geschiedenis laden en elke minuut verversen.
   * @returns {void}
   */
  function load() {
    if (!bound) {
      bound = true;
      byId('mon-form').addEventListener('submit', save);
      byId('mon-checks').addEventListener('change', toggleMute);
      byId('mon-run').addEventListener('click', runNow);
      byId('mon-test').addEventListener('click', sendTest);
      byId('mon-export').addEventListener('click', exportExcel);
      byId('mon-state').addEventListener('change', () => loadHistory());
      byId('mon-more').addEventListener('click', () => loadHistory(true));
    }
    started = true;
    refresh();
    loadHistory();
  }

  /**
   * Weg uit de sectie: niet meer verversen.
   * @returns {void}
   */
  function stop() {
    started = false;
    clearTimeout(refreshTimer);
  }

  window.BeheerBewaking = { load, stop };
})();
