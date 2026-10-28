// Uren en materiaalverbruik op een werkorder: de ploeg boekt per dag de
// gewerkte uren (begin, eind en pauze, of direct een aantal uren) en het
// verbruikte of retour genomen materiaal (/api/workorders/:id/hours|materials).
// Met het recht planning boek je ook voor een collega en zie je de urenstaat
// van iedereen (knop Urenstaat in het overzicht, Excel).
//
// Op locatie is er niet altijd netwerk: een nieuwe regel die niet verstuurd
// kan worden, blijft in een wachtrij op dit toestel (localStorage) en gaat
// alsnog mee zodra er weer verbinding is. Elke regel heeft een clientId, dus
// opnieuw versturen boekt nooit dubbel. Met de service worker (shared/offline.js)
// gaat de regel in de algemene offline wachtrij (zelfde knopje rechtsonder,
// gewist bij uitloggen); localStorage blijft de terugval zonder service worker.
(function () {
  const WorkLogCore = window.WorkLogCore;
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Formatteert een getal in Nederlandse notatie.
   * @param {number} value het getal
   * @param {number} decimals maximaal aantal decimalen (standaard 2)
   * @returns {string} het getal als tekst
   */
  const nl = (value, decimals = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: decimals });
  /**
   * Formatteert een datum kort, met de dag van de week.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {string} bijv. 'di 3 nov', of leeg zonder datum
   */
  const shortDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
  /**
   * Geeft de datum van vandaag op dit toestel.
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const localToday = () => {
    const now = new Date();
    /**
     * Vult een getal aan tot twee cijfers.
     * @param {number} number het getal
     * @returns {string} bijv. '03'
     */
    const pad = (number) => String(number).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  /**
   * Maakt een willekeurige UUID (ook in browsers zonder crypto.randomUUID).
   * @returns {string} de UUID
   */
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (placeholder) => { const random = Math.random() * 16 | 0; return (placeholder === 'x' ? random : (random & 0x3) | 0x8).toString(16); }));
  /**
   * Geeft de localStorage-sleutel van de wachtrij (per omgeving).
   * @returns {string} de sleutel
   */
  const queueKey = () => `aquatech_worklog_queue${window.AquatechEnv ? window.AquatechEnv.storageSuffix() : ''}`;

  const state = {
    options: {}, workOrder: null, log: null, tab: 'hours', edit: null, flushing: false,
    // Regels in de wachtrij van de service worker: { woId, type, body, queueId }.
    swPending: [],
    owner: null, // wie er nu is ingelogd (currentOwner), voor de eigen wachtrij
  };
  /**
   * Geeft de algemene offline-functie als de service worker die ondersteunt.
   * @returns {object|null} window.AquatechOffline, of null
   */
  const offlineApi = () => (window.AquatechOffline && window.AquatechOffline.supported ? window.AquatechOffline : null);
  /**
   * Toont een melding via de werkorderpagina (als die een toast heeft meegegeven).
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding
   * @returns {*} wat de toast van de pagina teruggeeft
   */
  const toast = (message, isError) => (state.options.toast ? state.options.toast(message, isError) : null);

  // ---------- Server ----------
  class OfflineError extends Error {}
  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad van de API (zonder '../')
   * @param {object} request methode, inhoud (`body`), `offline` (label voor de offline wachtrij) en `owner` (eigenaar van een regel uit de wachtrij)
   * @returns {Promise<object>} het antwoord; gooit OfflineError zonder verbinding, of een fout met `code` en `status`
   */
  async function call(url, { method = 'GET', body, offline, owner } = {}) {
    let res;
    const extraHeaders = offline && offlineApi() ? offlineApi().headers(offline) : {};
    // Uit de wachtrij: van wie de regel is (de server weigert hem onder een ander account).
    if (owner) extraHeaders['X-Aquatech-Owner'] = owner;
    try {
      res = await fetch(`../${url}`, {
        method, cache: 'no-store',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new OfflineError('Geen verbinding met de server.');
    }
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(result.message || `HTTP ${res.status}`), { code: result.error, status: res.status });
    return result;
  }

  // ---------- Wachtrij (geen netwerk) ----------
  /**
   * Leest de wachtrij van dit toestel uit localStorage.
   * @returns {object[]} de wachtende regels (leeg als er niets of iets onleesbaars staat)
   */
  function readQueue() {
    try { const parsed = JSON.parse(localStorage.getItem(queueKey()) || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (error) { return []; }
  }
  /**
   * Schrijft de wachtrij naar localStorage.
   * @param {object[]} list de wachtende regels
   * @returns {boolean} true als het bewaren lukte
   */
  function writeQueue(list) {
    try { localStorage.setItem(queueKey(), JSON.stringify(list)); return true; } catch (error) { return false; }
  }
  /**
   * Geeft wie er nu is ingelogd, in de vorm van de offline wachtrij (shared/common.js ownerOf).
   * @returns {Promise<string|null>} de eigenaar, of null als dat niet bekend is
   */
  async function currentOwner() {
    const common = window.AquatechCommon;
    return common ? common.ownerOf(await common.getJson('api/me')) : null;
  }
  /**
   * Geeft de wachtende regels van wie nu is ingelogd (state.owner); regels van
   * een ander account op dit toestel blijven liggen en worden niet getoond.
   * @returns {object[]} de eigen regels uit de wachtrij
   */
  const ownQueue = () => readQueue().filter((item) => item.owner && item.owner === state.owner);
  /**
   * Geeft de eigen wachtende regels (toestel en service worker) van een werkorder.
   * @param {string} workOrderId id van de werkorder
   * @param {string} type 'hours' of 'materials'
   * @returns {object[]} de wachtende regels
   */
  const pendingFor = (workOrderId, type) => ownQueue().concat(state.swPending).filter((item) => item.woId === workOrderId && item.type === type);

  /**
   * Haalt de wachtende regels van deze werkorder uit de wachtrij van de service worker.
   * @param {object} workOrder de geopende werkorder
   * @returns {Promise<void>}
   */
  async function loadSwPending(workOrder) {
    if (!offlineApi()) return;
    const prefix = `api/workorders/${encodeURIComponent(workOrder.id)}/`;
    const items = await offlineApi().list({ prefix, method: 'POST' });
    if (state.workOrder !== workOrder) return;
    state.swPending = items.map((queued) => {
      const type = queued.url.slice(prefix.length);
      if (type !== 'hours' && type !== 'materials') return null;
      try { return { woId: workOrder.id, type, body: JSON.parse(queued.body), queueId: queued.id }; } catch (error) { return null; }
    }).filter(Boolean);
  }
  if (window.AquatechOffline) {
    window.AquatechOffline.on('synced', (message) => {
      const id = message.item ? message.item.id : message.id;
      if (state.workOrder && state.swPending.some((pending) => pending.queueId === id)) load();
    });
  }

  /**
   * Verstuurt de wachtende regels van dit toestel; stopt bij de eerste netwerkfout.
   * Alleen regels van wie nu is ingelogd; die van een ander account blijven
   * liggen tot die weer inlogt. Een regel zonder eigenaar (oude versie) wordt weggegooid.
   * @returns {Promise<void>}
   */
  async function flush() {
    if (state.flushing) return;
    const list = readQueue();
    if (!list.length) return;
    state.flushing = true;
    let sent = 0;
    try {
      const owner = await currentOwner();
      state.owner = owner;
      if (!owner) return;
      for (const item of list) {
        if (item.owner && item.owner !== owner) continue;
        try {
          if (!item.owner) throw new Error('van een eerdere versie zonder eigenaar');
          await call(`api/workorders/${encodeURIComponent(item.woId)}/${item.type}`, { method: 'POST', body: item.body, owner: item.owner });
          sent++;
        } catch (error) {
          // Geen verbinding, uitgelogd of intussen een ander account: de regel blijft liggen.
          if (error instanceof OfflineError || error.status === 401 || error.code === 'owner_mismatch') break;
          toast(`Regel van ${shortDate(item.body.workDate || item.body.usedOn)} niet geboekt: ${error.message}`, true);
        }
        writeQueue(readQueue().filter((queued) => queued.body.clientId !== item.body.clientId));
      }
    } finally {
      state.flushing = false;
    }
    if (sent) {
      toast(`${sent} bewaarde regel${sent === 1 ? '' : 's'} alsnog geboekt`);
      if (state.workOrder) load();
    } else if (state.workOrder) render();
  }
  window.addEventListener('online', flush);

  // ---------- Laden en tekenen ----------
  /**
   * Laadt de uren en het materiaal van de geopende werkorder en tekent ze;
   * zonder verbinding blijft het laatst geladen overzicht staan.
   * @returns {Promise<void>}
   */
  async function load() {
    const workOrder = state.workOrder;
    // Eerst de eigenaar: de service worker werkt zijn identiteit bij via api/me
    // en filtert de wachtrij daarop.
    await currentOwner().then((owner) => { state.owner = owner; }, () => {});
    await loadSwPending(workOrder).catch(() => {});
    try {
      const result = await call(`api/workorders/${encodeURIComponent(workOrder.id)}/worklog`);
      if (state.workOrder !== workOrder) return;
      state.log = result;
    } catch (error) {
      if (state.workOrder !== workOrder) return;
      if (!state.log) state.log = { hours: [], materials: [], kinds: WorkLogCore.KINDS, canManage: false, locked: false, me: null, offline: true };
      if (!(error instanceof OfflineError)) toast(`Uren en materiaal laden mislukt: ${error.message}`, true);
    }
    render();
  }

  /**
   * Maakt de keuzelijst met medewerkers (ik bovenaan).
   * @param {string} selectedId id van de gekozen medewerker
   * @returns {string} HTML met option-elementen
   */
  const staffOptions = (selectedId) => {
    const me = state.log.me || {};
    const list = [{ id: me.id, displayName: me.displayName ? `${me.displayName} (ik)` : 'Ik' },
      ...(state.options.staff ? state.options.staff() : []).filter((member) => member.id !== me.id)];
    return list.map((member) => `<option value="${esc(member.id)}"${member.id === selectedId ? ' selected' : ''}>${esc(member.displayName)}</option>`).join('');
  };
  /**
   * Maakt de keuzelijst met soorten uren.
   * @param {string} selectedKind de gekozen soort
   * @returns {string} HTML met option-elementen
   */
  const kindOptions = (selectedKind) => Object.entries(WorkLogCore.KINDS).map(([kind, label]) => `<option value="${kind}"${kind === selectedKind ? ' selected' : ''}>${esc(label)}</option>`).join('');

  /**
   * Maakt het formulier om uren te boeken of een urenregel te wijzigen.
   * @returns {string} HTML van het formulier
   */
  function hoursForm() {
    const editing = state.edit && state.edit.type === 'hours' ? state.edit.entry : null;
    const steps = (state.workOrder.data.steps || []).filter((step) => step.title);
    const values = editing || { workDate: localToday(), startTime: '', endTime: '', breakMinutes: '', minutes: 0, kind: 'werk', stepId: '', note: '' };
    const direct = editing && !editing.startTime ? nl(editing.minutes / 60) : '';
    return `<form class="wl-form" id="wl-hours-form" autocomplete="off">
      <div class="wl-grid">
        <label>Datum<input type="date" name="workDate" value="${esc(values.workDate)}" max="${esc((state.log && state.log.today) || '')}" required></label>
        ${state.log.canManage ? `<label>Medewerker<select name="userId">${staffOptions(editing ? editing.user.id : (state.log.me || {}).id)}</select></label>` : ''}
        <label>Soort<select name="kind">${kindOptions(values.kind)}</select></label>
        <label>Begin<input type="time" name="startTime" value="${esc(values.startTime)}"></label>
        <label>Eind<input type="time" name="endTime" value="${esc(values.endTime)}"></label>
        <label>Pauze (min)<input type="number" name="breakMinutes" min="0" max="600" step="5" inputmode="numeric" value="${esc(values.breakMinutes || '')}" placeholder="0"></label>
        <label>Of: uren<input type="text" name="hours" inputmode="decimal" value="${esc(direct)}" placeholder="bijv. 1,5"></label>
      </div>
      <div class="wl-grid two">
        <label>Werkstap (optioneel)<select name="stepId"><option value="">–</option>${steps.map((step) => `<option value="${esc(step.id)}"${step.id === values.stepId ? ' selected' : ''}>${esc(step.title)}</option>`).join('')}</select></label>
        <label>Opmerking<input name="note" maxlength="500" value="${esc(values.note)}" placeholder="Bijv. meerwerk op verzoek van de klant"></label>
      </div>
      <div class="wl-actions">
        <span class="wl-calc muted small"></span>
        ${editing ? '<button type="button" class="btn" data-cancel>Annuleren</button>' : ''}
        <button class="btn primary" type="submit">${editing ? 'Opslaan' : 'Uren boeken'}</button>
      </div>
    </form>`;
  }

  /**
   * Maakt het formulier om materiaal te boeken of een materiaalregel te wijzigen.
   * @returns {string} HTML van het formulier
   */
  function materialForm() {
    const editing = state.edit && state.edit.type === 'materials' ? state.edit.entry : null;
    const plannedMaterials = state.workOrder.data.materials || [];
    const values = editing || { usedOn: localToday(), code: '', description: '', unit: 'st', qty: '', materialId: '', note: '' };
    const planned = editing ? (editing.materialId && plannedMaterials.some((material) => material.id === editing.materialId) ? editing.materialId : '__other') : (plannedMaterials[0] ? plannedMaterials[0].id : '__other');
    return `<form class="wl-form" id="wl-mat-form" autocomplete="off">
      <div class="wl-grid">
        <label>Datum<input type="date" name="usedOn" value="${esc(values.usedOn)}" max="${esc((state.log && state.log.today) || '')}" required></label>
        ${state.log.canManage ? `<label>Medewerker<select name="userId">${staffOptions(editing ? editing.user.id : (state.log.me || {}).id)}</select></label>` : ''}
        <label class="wide">Materiaal<select name="materialId">${plannedMaterials.map((material) => `<option value="${esc(material.id)}"${material.id === planned ? ' selected' : ''}>${esc(material.description || material.code)}${material.code ? ` (${esc(material.code)})` : ''}</option>`).join('')}
          <option value="__other"${planned === '__other' ? ' selected' : ''}>Ander materiaal (niet op de werkorder)…</option></select></label>
      </div>
      <div class="wl-grid wl-other"${planned === '__other' ? '' : ' hidden'}>
        <label class="wide">Omschrijving<input name="description" maxlength="500" value="${esc(planned === '__other' ? values.description : '')}" placeholder="Bijv. koppelstuk 25 mm"></label>
        <label>Artikelcode<input name="code" maxlength="40" value="${esc(planned === '__other' ? values.code : '')}" placeholder="Optioneel"></label>
      </div>
      <div class="wl-grid">
        <label>Aantal<input type="text" name="qty" inputmode="decimal" value="${esc(editing ? nl(Math.abs(editing.qty), 3) : '')}" placeholder="0" required></label>
        <label>Eenheid<input name="unit" maxlength="12" value="${esc(values.unit)}"></label>
        <label class="chk"><input type="checkbox" name="retour"${editing && editing.qty < 0 ? ' checked' : ''}> Retour (niet gebruikt)</label>
      </div>
      <label>Opmerking<input name="note" maxlength="500" value="${esc(values.note)}" placeholder="Bijv. extra nodig door een omweg"></label>
      <div class="wl-actions">
        ${editing ? '<button type="button" class="btn" data-cancel>Annuleren</button>' : ''}
        <button class="btn primary" type="submit">${editing ? 'Opslaan' : 'Materiaal boeken'}</button>
      </div>
    </form>`;
  }

  /**
   * Zegt of de gebruiker een regel mag wijzigen (eigen regel of met beheerrecht).
   * @param {object} entry uren- of materiaalregel
   * @returns {boolean} true als wijzigen mag
   */
  const canEdit = (entry) => state.log.canManage || (state.log.me && (entry.user.id === state.log.me.id || entry.createdBy === state.log.me.id));
  /**
   * Maakt de knoppen Wijzigen en Verwijderen bij een regel (als dat mag).
   * @param {object} entry uren- of materiaalregel
   * @param {string} type 'hours' of 'materials'
   * @returns {string} HTML van de knoppen, of leeg
   */
  const rowActions = (entry, type) => (!state.log.locked && !state.log.offline && canEdit(entry)
    ? `<button class="btn ghost icon" data-edit="${type}:${esc(entry.id)}" title="Wijzigen">✎</button><button class="btn ghost icon" data-del="${type}:${esc(entry.id)}" title="Verwijderen">✕</button>` : '');
  const pendingBadge = '<span class="pill wl-pending" title="Wordt verstuurd zodra er weer verbinding is">Wacht op netwerk</span>';

  /**
   * Maakt de tabel met geboekte en wachtende uren.
   * @returns {string} HTML van de tabel
   */
  function hoursTable() {
    const rows = state.log.hours;
    const pending = pendingFor(state.workOrder.id, 'hours');
    if (!rows.length && !pending.length) return '<p class="muted small">Nog geen uren geboekt.</p>';
    /**
     * Geeft de titel van een werkstap.
     * @param {string} id id van de werkstap
     * @returns {string} de titel, of leeg
     */
    const stepTitle = (id) => ((state.workOrder.data.steps || []).find((step) => step.id === id) || {}).title || '';
    /**
     * Maakt één tabelregel voor een urenregel.
     * @param {object} entry de urenregel
     * @param {string} extra extra HTML achter de opmerking (bijv. het label "Wacht op netwerk")
     * @returns {string} HTML van de regel
     */
    const line = (entry, extra = '') => `<tr>
      <td>${esc(shortDate(entry.workDate))}</td>
      <td>${esc(entry.user ? entry.user.displayName : (state.log.me || {}).displayName || '')}</td>
      <td>${esc(WorkLogCore.KINDS[entry.kind] || entry.kind)}${entry.startTime ? `<span class="sub">${esc(entry.startTime)}–${esc(entry.endTime)}${entry.breakMinutes ? `, ${entry.breakMinutes} min pauze` : ''}</span>` : ''}</td>
      <td class="num"><b>${esc(WorkLogCore.hoursText(entry.minutes))}</b></td>
      <td class="wrap">${esc([stepTitle(entry.stepId), entry.note].filter(Boolean).join(' · '))}${extra}</td>
      <td class="c-act">${entry.id ? rowActions(entry, 'hours') : ''}</td>
    </tr>`;
    const queued = pending.map((queuedItem) => {
      const cleaned = WorkLogCore.cleanHours(queuedItem.body);
      return cleaned.entry ? line({ ...cleaned.entry, user: null }, ` ${pendingBadge}`) : '';
    });
    return `<div class="tablewrap"><table class="grid wl-table"><thead><tr><th>Datum</th><th>Medewerker</th><th>Soort</th><th class="num">Uren</th><th>Werkstap / opmerking</th><th></th></tr></thead>
      <tbody>${rows.map((entry) => line(entry)).join('')}${queued.join('')}</tbody></table></div>`;
  }

  /**
   * Maakt de vergelijking gepland/verbruikt en de tabel met geboekt materiaal.
   * @returns {string} HTML van beide tabellen
   */
  function materialsTables() {
    const rows = state.log.materials;
    const pending = pendingFor(state.workOrder.id, 'materials');
    const used = WorkLogCore.totals(state.workOrder.data, [], rows).materials;
    const compared = used.filter((material) => material.planned || material.used);
    const compare = compared.length ? `<div class="tablewrap"><table class="grid wl-table wl-compare"><thead><tr><th>Materiaal</th><th class="num">Gepland</th><th class="num">Verbruikt</th><th class="num">Verschil</th></tr></thead>
      <tbody>${compared.map((material) => `<tr class="${material.extra ? 'extra' : material.diff > 0 ? 'over' : ''}">
        <td>${esc(material.description || material.code)}${material.code ? `<span class="sub">${esc(material.code)}</span>` : ''}${material.extra ? ' <span class="pill wl-extra">Extra</span>' : ''}</td>
        <td class="num">${material.planned ? `${esc(nl(material.planned))} ${esc(material.unit)}` : '–'}</td>
        <td class="num">${material.used ? `${esc(nl(material.used))} ${esc(material.unit)}` : '–'}</td>
        <td class="num">${material.diff ? `${material.diff > 0 ? '+' : ''}${esc(nl(material.diff))}` : '0'}</td></tr>`).join('')}</tbody></table></div>` : '';
    if (!rows.length && !pending.length) return `${compare}<p class="muted small">Nog geen materiaal geboekt.</p>`;
    /**
     * Maakt één tabelregel voor een materiaalregel.
     * @param {object} entry de materiaalregel
     * @param {string} extra extra HTML achter de omschrijving
     * @returns {string} HTML van de regel
     */
    const line = (entry, extra = '') => `<tr>
      <td>${esc(shortDate(entry.usedOn))}</td>
      <td>${esc(entry.user ? entry.user.displayName : (state.log.me || {}).displayName || '')}</td>
      <td class="wrap">${esc(entry.description || entry.code)}${entry.code ? `<span class="sub">${esc(entry.code)}</span>` : ''}${entry.note ? `<span class="sub">${esc(entry.note)}</span>` : ''}${extra}</td>
      <td class="num${entry.qty < 0 ? ' neg' : ''}"><b>${esc(nl(entry.qty, 3))}</b> ${esc(entry.unit)}${entry.qty < 0 ? '<span class="sub">retour</span>' : ''}</td>
      <td class="c-act">${entry.id ? rowActions(entry, 'materials') : ''}</td>
    </tr>`;
    const queued = pending.map((queuedItem) => {
      const cleaned = WorkLogCore.cleanMaterial(queuedItem.body);
      return cleaned.entry ? line({ ...cleaned.entry, user: null }, ` ${pendingBadge}`) : '';
    });
    return `${compare}<h4 class="wl-sub">Geboekt</h4><div class="tablewrap"><table class="grid wl-table"><thead><tr><th>Datum</th><th>Medewerker</th><th>Materiaal</th><th class="num">Aantal</th><th></th></tr></thead>
      <tbody>${rows.map((entry) => line(entry)).join('')}${queued.join('')}</tbody></table></div>`;
  }

  /**
   * Berekent de totalen en maakt de tegels erboven.
   * @returns {{totals: object, html: string}} de totalen en de HTML van de tegels
   */
  function summary() {
    const totals = WorkLogCore.totals(state.workOrder.data, state.log.hours, state.log.materials);
    const kinds = Object.entries(totals.byKind).map(([kind, minutes]) => `${WorkLogCore.KINDS[kind] || kind} ${WorkLogCore.hoursText(minutes)}`).join(' · ');
    const users = Object.entries(totals.byUser).map(([name, minutes]) => `${name} ${WorkLogCore.hoursText(minutes)}`).join(' · ');
    return { totals, html: `<div class="wl-stats">
      <div class="stat"><b>${esc(WorkLogCore.hoursText(totals.minutes))}</b><span>uur geboekt${totals.plannedHours ? ` van ${esc(nl(totals.plannedHours))} gepland` : ''}</span></div>
      <div class="stat"><b>${esc(state.log.materials.length)}</b><span>materiaalregels${totals.extraMaterials ? `, ${totals.extraMaterials} extra artikel${totals.extraMaterials === 1 ? '' : 'en'}` : ''}</span></div>
    </div>${kinds ? `<p class="muted small">${esc(kinds)}${Object.keys(totals.byUser).length > 1 ? `<br>${esc(users)}` : ''}</p>` : ''}` };
  }

  /** Tekent het blok uren en materiaal: totalen, meldingen, tabbladen, formulier en tabel. */
  function render() {
    const card = $('#wl-card');
    if (!card || !state.workOrder || !state.log) return;
    // Wat in de wachtrij van de service worker staat, toont het knopje rechtsonder.
    const queue = ownQueue().filter((item) => item.woId === state.workOrder.id).length;
    const overview = summary();
    $('#wl-sum').textContent = overview.totals.minutes ? `${WorkLogCore.hoursText(overview.totals.minutes)} uur geboekt` : '';
    const body = $('#wl-body');
    const locked = state.log.locked;
    body.innerHTML = `${overview.html}
      ${queue ? `<div class="notice warn wl-note">${queue} regel${queue === 1 ? '' : 's'} op dit toestel wacht${queue === 1 ? '' : 'en'} op netwerk en ${queue === 1 ? 'wordt' : 'worden'} vanzelf verstuurd. <button class="btn small" data-flush>Nu versturen</button></div>` : ''}
      ${state.log.offline ? '<div class="notice warn wl-note">Geen verbinding: nieuwe regels worden op dit toestel bewaard en later verstuurd.</div>' : ''}
      ${locked ? '<div class="notice wl-note">Deze werkorder is afgerond. Vraag de planner of beheerder om nog uren of materiaal te boeken.</div>' : ''}
      <div class="wl-tabs" role="tablist">
        <button type="button" role="tab" class="${state.tab === 'hours' ? 'on' : ''}" data-tab="hours">Uren</button>
        <button type="button" role="tab" class="${state.tab === 'materials' ? 'on' : ''}" data-tab="materials">Materiaal</button>
      </div>
      ${state.tab === 'hours' ? `${locked ? '' : hoursForm()}${hoursTable()}` : `${locked ? '' : materialForm()}${materialsTables()}`}`;
    calc();
  }

  /** Toont onder het urenformulier hoeveel uren er worden geboekt. */
  function calc() {
    const formElement = $('#wl-hours-form');
    if (!formElement) return;
    const cleaned = WorkLogCore.cleanHours(formHours(formElement));
    $('.wl-calc', formElement).textContent = cleaned.entry ? `= ${WorkLogCore.hoursText(cleaned.entry.minutes)} uur` : '';
  }

  /**
   * Leest het urenformulier uit.
   * @param {HTMLFormElement} formElement het urenformulier
   * @returns {object} de urenregel zoals de API hem verwacht
   */
  function formHours(formElement) {
    const values = Object.fromEntries(new FormData(formElement));
    return {
      workDate: values.workDate, startTime: values.startTime, endTime: values.endTime, breakMinutes: values.breakMinutes,
      hours: values.startTime && values.endTime ? undefined : values.hours, kind: values.kind, stepId: values.stepId, note: values.note, userId: values.userId,
    };
  }

  /**
   * Leest het materiaalformulier uit (retour = negatief aantal).
   * @param {HTMLFormElement} formElement het materiaalformulier
   * @returns {object} de materiaalregel zoals de API hem verwacht
   */
  function formMaterial(formElement) {
    const values = Object.fromEntries(new FormData(formElement));
    const material = (state.workOrder.data.materials || []).find((candidate) => candidate.id === values.materialId);
    const qty = Math.abs(Number(String(values.qty || '').replace(',', '.')) || 0) * (values.retour ? -1 : 1);
    return {
      usedOn: values.usedOn, qty, unit: values.unit, note: values.note, userId: values.userId,
      ...(material ? { materialId: material.id, code: material.code, description: material.description } : { materialId: '', code: values.code, description: values.description }),
    };
  }

  /**
   * Boekt een nieuwe regel of slaat een gewijzigde op; zonder verbinding gaat
   * een nieuwe regel in de wachtrij.
   * @param {string} type 'hours' of 'materials'
   * @param {object} body de regel uit het formulier
   * @returns {Promise<void>}
   */
  async function submit(type, body) {
    const workOrder = state.workOrder;
    const editing = state.edit && state.edit.type === type ? state.edit.entry : null;
    const check = type === 'hours' ? WorkLogCore.cleanHours(body) : WorkLogCore.cleanMaterial(body);
    if (check.error) { toast(check.error, true); return; }
    if (state.log.canManage === false) delete body.userId;
    if (editing) {
      try {
        const saved = await call(`api/workorders/${encodeURIComponent(workOrder.id)}/${type}/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
        const list = state.log[type];
        list[list.findIndex((row) => row.id === editing.id)] = saved;
        state.edit = null;
        toast('Opgeslagen');
        render();
      } catch (error) {
        toast(error instanceof OfflineError ? 'Geen verbinding: wijzigen kan alleen online.' : `Opslaan mislukt: ${error.message}`, true);
      }
      return;
    }
    body.clientId = uuid();
    try {
      const result = await call(`api/workorders/${encodeURIComponent(workOrder.id)}/${type}`, {
        method: 'POST', body, offline: { label: `${type === 'hours' ? 'Uren' : 'Materiaal'} bij ${workOrder.number || 'werkorder'}` },
      });
      if (state.workOrder !== workOrder) return;
      if (result.queued) {
        state.swPending.push({ woId: workOrder.id, type, body, queueId: result.id });
        toast('Geen verbinding: op dit toestel bewaard, wordt later verstuurd.');
        render();
        return;
      }
      state.log[type].push(result);
      toast(type === 'hours' ? `${WorkLogCore.hoursText(result.minutes)} uur geboekt` : 'Materiaal geboekt');
      render();
    } catch (error) {
      if (!(error instanceof OfflineError)) { toast(`Boeken mislukt: ${error.message}`, true); return; }
      const owner = await currentOwner();
      state.owner = owner || state.owner;
      if (!owner || !writeQueue([...readQueue(), { woId: workOrder.id, type, body, owner, at: new Date().toISOString() }])) {
        toast('Geen verbinding en bewaren op dit toestel lukt niet.', true);
        return;
      }
      toast('Geen verbinding: op dit toestel bewaard, wordt later verstuurd.');
      render();
    }
  }

  /**
   * Verwijdert een regel na bevestiging.
   * @param {string} type 'hours' of 'materials'
   * @param {string} id id van de regel
   * @returns {Promise<void>}
   */
  async function remove(type, id) {
    const entry = state.log[type].find((row) => row.id === id);
    if (!entry || !confirm(type === 'hours' ? 'Deze urenregel verwijderen?' : 'Deze materiaalregel verwijderen?')) return;
    try {
      await call(`api/workorders/${encodeURIComponent(state.workOrder.id)}/${type}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.log[type] = state.log[type].filter((row) => row.id !== id);
      toast('Verwijderd');
      render();
    } catch (error) {
      toast(error instanceof OfflineError ? 'Geen verbinding: verwijderen kan alleen online.' : `Verwijderen mislukt: ${error.message}`, true);
    }
  }

  /** Vult eenmalig de kaart en koppelt de klikken, invoer en formulieren. */
  function bind() {
    if (bind.done) return;
    bind.done = true;
    const card = $('#wl-card');
    card.innerHTML = `<div class="lines-head"><h3>Uren en materiaalverbruik</h3><span id="wl-sum" class="muted small"></span></div>
      <p class="muted small">Boek per dag je gewerkte uren en het materiaal dat je hebt verbruikt of retour neemt. Zonder netwerk worden nieuwe regels op dit toestel bewaard en later verstuurd.</p>
      <div id="wl-body"><p class="muted small">Laden…</p></div>`;
    card.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; state.edit = null; render(); return; }
      if (event.target.closest('[data-flush]')) { flush(); return; }
      if (event.target.closest('[data-cancel]')) { state.edit = null; render(); return; }
      const editButton = event.target.closest('[data-edit]');
      if (editButton) {
        const [type, id] = editButton.dataset.edit.split(':');
        state.edit = { type, entry: state.log[type].find((row) => row.id === id) };
        render();
        $(type === 'hours' ? '#wl-hours-form' : '#wl-mat-form').scrollIntoView({ block: 'nearest' });
        return;
      }
      const deleteButton = event.target.closest('[data-del]');
      if (deleteButton) { const [type, id] = deleteButton.dataset.del.split(':'); remove(type, id); }
    });
    card.addEventListener('input', (event) => { if (event.target.closest('#wl-hours-form')) calc(); });
    card.addEventListener('change', (event) => {
      const formElement = event.target.closest('#wl-mat-form');
      if (formElement && event.target.name === 'materialId') {
        const material = (state.workOrder.data.materials || []).find((candidate) => candidate.id === event.target.value);
        $('.wl-other', formElement).hidden = Boolean(material);
        if (material) formElement.elements.unit.value = material.unit || formElement.elements.unit.value;
      }
    });
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      if (event.target.id === 'wl-hours-form') submit('hours', formHours(event.target));
      if (event.target.id === 'wl-mat-form') submit('materials', formMaterial(event.target));
    });
  }

  /**
   * Werkorder geopend: laadt de uren en het materiaal en verstuurt wat nog wacht.
   * @param {object} workOrder de geopende werkorder
   * @param {object} options { toast, staff: () => [{ id, displayName }] }
   */
  function open(workOrder, options = {}) {
    if (!$('#wl-card')) return;
    state.options = options;
    state.workOrder = workOrder;
    state.swPending = [];
    state.log = null;
    state.edit = null;
    bind();
    $('#wl-sum').textContent = '';
    $('#wl-body').innerHTML = '<p class="muted small">Laden…</p>';
    load().then(flush);
  }

  // ---------- Excel ----------
  /**
   * Maakt een Date van een datum (om 12:00, zodat de tijdzone de dag niet verschuift).
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {Date|null} de datum, of null zonder datum
   */
  const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);
  /**
   * Geeft de kolommen van het blad Uren.
   * @param {boolean} withWorkOrder true om werkorder en klant toe te voegen (urenstaat)
   * @returns {object[]} ExcelJS-kolommen
   */
  const hoursColumns = (withWorkOrder) => [
    { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Medewerker', key: 'user', width: 22 },
    ...(withWorkOrder ? [{ header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Klant', key: 'customer', width: 28 }] : []),
    { header: 'Soort', key: 'kind', width: 11 }, { header: 'Begin', key: 'start', width: 8 }, { header: 'Eind', key: 'end', width: 8 },
    { header: 'Pauze (min)', key: 'pause', width: 11 }, { header: 'Uren', key: 'hours', width: 9, style: { numFmt: '0.00' } },
    { header: 'Opmerking', key: 'note', width: 40 },
  ];
  /**
   * Maakt een Excel-regel van een urenregel.
   * @param {object} entry de urenregel
   * @returns {object} de waarden per kolom
   */
  const hoursRow = (entry) => ({
    date: asDate(entry.workDate), user: entry.user.displayName, wo: entry.workOrder ? entry.workOrder.number : '', customer: entry.workOrder ? entry.workOrder.customer : '',
    kind: WorkLogCore.KINDS[entry.kind] || entry.kind, start: entry.startTime, end: entry.endTime, pause: entry.breakMinutes || null, hours: Math.round(entry.minutes / 60 * 100) / 100, note: entry.note,
  });
  /**
   * Geeft de kolommen van het blad Materiaalverbruik.
   * @param {boolean} withWorkOrder true om werkorder en klant toe te voegen (urenstaat)
   * @returns {object[]} ExcelJS-kolommen
   */
  const matColumns = (withWorkOrder) => [
    { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Medewerker', key: 'user', width: 22 },
    ...(withWorkOrder ? [{ header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Klant', key: 'customer', width: 28 }] : []),
    { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'description', width: 44 },
    { header: 'Aantal', key: 'qty', width: 9 }, { header: 'Eenheid', key: 'unit', width: 9 }, { header: 'Opmerking', key: 'note', width: 36 },
  ];
  /**
   * Maakt een Excel-regel van een materiaalregel.
   * @param {object} entry de materiaalregel
   * @returns {object} de waarden per kolom
   */
  const matRow = (entry) => ({
    date: asDate(entry.usedOn), user: entry.user.displayName, wo: entry.workOrder ? entry.workOrder.number : '', customer: entry.workOrder ? entry.workOrder.customer : '',
    code: entry.code, description: entry.description, qty: entry.qty, unit: entry.unit, note: entry.qty < 0 ? `Retour${entry.note ? `: ${entry.note}` : ''}` : entry.note,
  });
  /**
   * Voegt een blad toe met kolommen, regels, opgemaakte kop en filter.
   * @param {object} workbook ExcelJS-werkmap
   * @param {string} name naam van het blad
   * @param {object[]} columns ExcelJS-kolommen
   * @param {object[]} rows de regels
   * @param {function(object): void} headStyle maakt de kopregel op
   * @returns {object} het nieuwe werkblad
   */
  function sheet(workbook, name, columns, rows, headStyle) {
    const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = columns;
    for (const row of rows) worksheet.addRow(row);
    headStyle(worksheet.getRow(1));
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return worksheet;
  }

  /**
   * Bladen Uren en Materiaalverbruik bij de Excel-export van één werkorder.
   * @param {object} workbook ExcelJS-werkmap
   * @param {{headStyle: function}} settings opmaak van de kopregel
   * @returns {Promise<void>}
   */
  async function addSheets(workbook, { headStyle }) {
    if (!state.workOrder || !state.log) return;
    sheet(workbook, 'Uren', hoursColumns(false), state.log.hours.map(hoursRow), headStyle);
    sheet(workbook, 'Materiaalverbruik', matColumns(false), state.log.materials.map(matRow), headStyle);
    const compared = WorkLogCore.totals(state.workOrder.data, [], state.log.materials).materials;
    sheet(workbook, 'Gepland vs verbruikt', [
      { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'description', width: 44 }, { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Gepland', key: 'planned', width: 10 }, { header: 'Verbruikt', key: 'used', width: 10 }, { header: 'Verschil', key: 'diff', width: 10 },
      { header: 'Extra', key: 'extra', width: 8 },
    ], compared.map((material) => ({ ...material, extra: material.extra ? 'ja' : '' })), headStyle);
  }

  /**
   * Urenstaat over een periode (alle werkorders): Excel met uren per regel, per medewerker en per dag, en materiaal.
   * @param {object} request { from, to, userId, headStyle, download, companyName }
   * @returns {Promise<{hours: number, materials: number}>} aantal uren- en materiaalregels
   */
  async function exportPeriod({ from, to, userId, headStyle, download, companyName }) {
    const query = new URLSearchParams({ from, to });
    if (userId) query.set('user', userId);
    const result = await call(`api/worklog?${query}`);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = companyName || 'AquaTech Service';
    workbook.created = new Date();
    sheet(workbook, 'Uren', hoursColumns(true), result.hours.map(hoursRow), headStyle);
    // Per medewerker en dag, uren per soort.
    const byUserAndDay = new Map();
    for (const entry of result.hours) {
      const key = `${entry.user.displayName}|${entry.workDate}`;
      const row = byUserAndDay.get(key) || { user: entry.user.displayName, date: asDate(entry.workDate), iso: entry.workDate, total: 0 };
      row[entry.kind] = (row[entry.kind] || 0) + entry.minutes / 60;
      row.total += entry.minutes / 60;
      byUserAndDay.set(key, row);
    }
    const days = [...byUserAndDay.values()].sort((left, right) => left.user.localeCompare(right.user, 'nl') || left.iso.localeCompare(right.iso));
    const perUserSheet = sheet(workbook, 'Per medewerker', [
      { header: 'Medewerker', key: 'user', width: 24 }, { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
      ...Object.entries(WorkLogCore.KINDS).map(([kind, label]) => ({ header: label, key: kind, width: 11, style: { numFmt: '0.00' } })),
      { header: 'Totaal', key: 'total', width: 11, style: { numFmt: '0.00' } },
    ], days, headStyle);
    if (days.length) {
      const lastRowNumber = perUserSheet.lastRow.number;
      const columnLetters = ['C', 'D', 'E', 'F'];
      const totalRow = perUserSheet.addRow(['Totaal', '', ...columnLetters.map((letter) => ({ formula: `SUBTOTAL(9,${letter}2:${letter}${lastRowNumber})` }))]);
      totalRow.font = { bold: true };
    }
    sheet(workbook, 'Materiaalverbruik', matColumns(true), result.materials.map(matRow), headStyle);
    const buffer = await workbook.xlsx.writeBuffer();
    download(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `urenstaat_${from}_${to}.xlsx`);
    return { hours: result.hours.length, materials: result.materials.length };
  }

  window.WorkLog = { open, addSheets, exportPeriod, flush, pending: () => ownQueue().length };
  // Bij het laden van de pagina: wat nog op dit toestel wacht alsnog versturen.
  if (navigator.onLine !== false) setTimeout(flush, 1500);
})();
