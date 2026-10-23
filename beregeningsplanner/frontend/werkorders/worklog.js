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
  const L = window.WorkLogCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const shortDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
  const localToday = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
  const queueKey = () => `aquatech_worklog_queue${window.AquatechEnv ? window.AquatechEnv.storageSuffix() : ''}`;

  const state = {
    opts: {}, wo: null, log: null, tab: 'hours', edit: null, flushing: false,
    // Regels in de wachtrij van de service worker: { woId, type, body, queueId }.
    swPending: [],
    owner: null, // wie er nu is ingelogd (currentOwner), voor de eigen wachtrij
  };
  const Off = () => (window.AquatechOffline && window.AquatechOffline.supported ? window.AquatechOffline : null);
  const toast = (msg, err) => (state.opts.toast ? state.opts.toast(msg, err) : null);

  // ---------- Server ----------
  class Offline extends Error {}
  async function call(url, { method = 'GET', body, offline, owner } = {}) {
    let res;
    const extra = offline && Off() ? Off().headers(offline) : {};
    // Uit de wachtrij: van wie de regel is (de server weigert hem onder een ander account).
    if (owner) extra['X-Aquatech-Owner'] = owner;
    try {
      res = await fetch(`../${url}`, {
        method, cache: 'no-store',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Offline('Geen verbinding met de server.');
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error, status: res.status });
    return out;
  }

  // ---------- Wachtrij (geen netwerk) ----------
  function readQueue() {
    try { const v = JSON.parse(localStorage.getItem(queueKey()) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writeQueue(list) {
    try { localStorage.setItem(queueKey(), JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  /**
   * Wie er nu is ingelogd, in de vorm van de offline wachtrij (shared/common.js ownerOf).
   * @returns {Promise<string|null>} De eigenaar, of null als dat niet bekend is.
   */
  async function currentOwner() {
    const common = window.AquatechCommon;
    return common ? common.ownerOf(await common.getJson('api/me')) : null;
  }
  /**
   * De wachtende regels van wie nu is ingelogd (state.owner); regels van een
   * ander account op dit toestel blijven liggen en worden niet getoond.
   * @returns {object[]} De eigen regels uit de wachtrij.
   */
  const ownQueue = () => readQueue().filter((item) => item.owner && item.owner === state.owner);
  /**
   * De eigen wachtende regels (lokaal en in de service worker) van één werkorder en soort.
   * @param {string} woId Id van de werkorder.
   * @param {string} type 'hours' of 'materials'.
   * @returns {object[]} De wachtende regels.
   */
  const pendingFor = (woId, type) => ownQueue().concat(state.swPending).filter((x) => x.woId === woId && x.type === type);

  // Wachtende regels van deze werkorder uit de wachtrij van de service worker.
  async function loadSwPending(wo) {
    if (!Off()) return;
    const prefix = `api/workorders/${encodeURIComponent(wo.id)}/`;
    const items = await Off().list({ prefix, method: 'POST' });
    if (state.wo !== wo) return;
    state.swPending = items.map((q) => {
      const type = q.url.slice(prefix.length);
      if (type !== 'hours' && type !== 'materials') return null;
      try { return { woId: wo.id, type, body: JSON.parse(q.body), queueId: q.id }; } catch (e) { return null; }
    }).filter(Boolean);
  }
  if (window.AquatechOffline) {
    window.AquatechOffline.on('synced', (msg) => {
      const id = msg.item ? msg.item.id : msg.id;
      if (state.wo && state.swPending.some((p) => p.queueId === id)) load();
    });
  }

  /**
   * Wachtende regels versturen; stopt bij de eerste netwerkfout. Alleen regels
   * van wie nu is ingelogd; die van een ander account blijven liggen tot die
   * weer inlogt. Een regel zonder eigenaar (oude versie) wordt weggegooid.
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
        } catch (e) {
          if (e instanceof Offline || e.status === 401) break;
          if (e.code !== 'owner_mismatch') toast(`Regel van ${shortDate(item.body.workDate || item.body.usedOn)} niet geboekt: ${e.message}`, true);
        }
        writeQueue(readQueue().filter((x) => x.body.clientId !== item.body.clientId));
      }
    } finally {
      state.flushing = false;
    }
    if (sent) {
      toast(`${sent} bewaarde regel${sent === 1 ? '' : 's'} alsnog geboekt`);
      if (state.wo) load();
    } else if (state.wo) render();
  }
  window.addEventListener('online', flush);

  // ---------- Laden en tekenen ----------
  async function load() {
    const wo = state.wo;
    await Promise.all([
      loadSwPending(wo).catch(() => {}),
      currentOwner().then((owner) => { state.owner = owner; }, () => {}),
    ]);
    try {
      const out = await call(`api/workorders/${encodeURIComponent(wo.id)}/worklog`);
      if (state.wo !== wo) return;
      state.log = out;
    } catch (e) {
      if (state.wo !== wo) return;
      if (!state.log) state.log = { hours: [], materials: [], kinds: L.KINDS, canManage: false, locked: false, me: null, offline: true };
      if (!(e instanceof Offline)) toast(`Uren en materiaal laden mislukt: ${e.message}`, true);
    }
    render();
  }

  const staffOptions = (sel) => {
    const me = state.log.me || {};
    const list = [{ id: me.id, displayName: me.displayName ? `${me.displayName} (ik)` : 'Ik' },
      ...(state.opts.staff ? state.opts.staff() : []).filter((s) => s.id !== me.id)];
    return list.map((s) => `<option value="${esc(s.id)}"${s.id === sel ? ' selected' : ''}>${esc(s.displayName)}</option>`).join('');
  };
  const kindOptions = (sel) => Object.entries(L.KINDS).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

  function hoursForm() {
    const e = state.edit && state.edit.type === 'hours' ? state.edit.entry : null;
    const steps = (state.wo.data.steps || []).filter((s) => s.title);
    const v = e || { workDate: localToday(), startTime: '', endTime: '', breakMinutes: '', minutes: 0, kind: 'werk', stepId: '', note: '' };
    const direct = e && !e.startTime ? nl(e.minutes / 60) : '';
    return `<form class="wl-form" id="wl-hours-form" autocomplete="off">
      <div class="wl-grid">
        <label>Datum<input type="date" name="workDate" value="${esc(v.workDate)}" max="${esc((state.log && state.log.today) || '')}" required></label>
        ${state.log.canManage ? `<label>Medewerker<select name="userId">${staffOptions(e ? e.user.id : (state.log.me || {}).id)}</select></label>` : ''}
        <label>Soort<select name="kind">${kindOptions(v.kind)}</select></label>
        <label>Begin<input type="time" name="startTime" value="${esc(v.startTime)}"></label>
        <label>Eind<input type="time" name="endTime" value="${esc(v.endTime)}"></label>
        <label>Pauze (min)<input type="number" name="breakMinutes" min="0" max="600" step="5" inputmode="numeric" value="${esc(v.breakMinutes || '')}" placeholder="0"></label>
        <label>Of: uren<input type="text" name="hours" inputmode="decimal" value="${esc(direct)}" placeholder="bijv. 1,5"></label>
      </div>
      <div class="wl-grid two">
        <label>Werkstap (optioneel)<select name="stepId"><option value="">–</option>${steps.map((s) => `<option value="${esc(s.id)}"${s.id === v.stepId ? ' selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label>
        <label>Opmerking<input name="note" maxlength="500" value="${esc(v.note)}" placeholder="Bijv. meerwerk op verzoek van de klant"></label>
      </div>
      <div class="wl-actions">
        <span class="wl-calc muted small"></span>
        ${e ? '<button type="button" class="btn" data-cancel>Annuleren</button>' : ''}
        <button class="btn primary" type="submit">${e ? 'Opslaan' : 'Uren boeken'}</button>
      </div>
    </form>`;
  }

  function materialForm() {
    const e = state.edit && state.edit.type === 'materials' ? state.edit.entry : null;
    const mats = state.wo.data.materials || [];
    const v = e || { usedOn: localToday(), code: '', description: '', unit: 'st', qty: '', materialId: '', note: '' };
    const planned = e ? (e.materialId && mats.some((m) => m.id === e.materialId) ? e.materialId : '__other') : (mats[0] ? mats[0].id : '__other');
    return `<form class="wl-form" id="wl-mat-form" autocomplete="off">
      <div class="wl-grid">
        <label>Datum<input type="date" name="usedOn" value="${esc(v.usedOn)}" max="${esc((state.log && state.log.today) || '')}" required></label>
        ${state.log.canManage ? `<label>Medewerker<select name="userId">${staffOptions(e ? e.user.id : (state.log.me || {}).id)}</select></label>` : ''}
        <label class="wide">Materiaal<select name="materialId">${mats.map((m) => `<option value="${esc(m.id)}"${m.id === planned ? ' selected' : ''}>${esc(m.description || m.code)}${m.code ? ` (${esc(m.code)})` : ''}</option>`).join('')}
          <option value="__other"${planned === '__other' ? ' selected' : ''}>Ander materiaal (niet op de werkorder)…</option></select></label>
      </div>
      <div class="wl-grid wl-other"${planned === '__other' ? '' : ' hidden'}>
        <label class="wide">Omschrijving<input name="description" maxlength="500" value="${esc(planned === '__other' ? v.description : '')}" placeholder="Bijv. koppelstuk 25 mm"></label>
        <label>Artikelcode<input name="code" maxlength="40" value="${esc(planned === '__other' ? v.code : '')}" placeholder="Optioneel"></label>
      </div>
      <div class="wl-grid">
        <label>Aantal<input type="text" name="qty" inputmode="decimal" value="${esc(e ? nl(Math.abs(e.qty), 3) : '')}" placeholder="0" required></label>
        <label>Eenheid<input name="unit" maxlength="12" value="${esc(v.unit)}"></label>
        <label class="chk"><input type="checkbox" name="retour"${e && e.qty < 0 ? ' checked' : ''}> Retour (niet gebruikt)</label>
      </div>
      <label>Opmerking<input name="note" maxlength="500" value="${esc(v.note)}" placeholder="Bijv. extra nodig door een omweg"></label>
      <div class="wl-actions">
        ${e ? '<button type="button" class="btn" data-cancel>Annuleren</button>' : ''}
        <button class="btn primary" type="submit">${e ? 'Opslaan' : 'Materiaal boeken'}</button>
      </div>
    </form>`;
  }

  const canEdit = (entry) => state.log.canManage || (state.log.me && (entry.user.id === state.log.me.id || entry.createdBy === state.log.me.id));
  const rowActions = (entry, type) => (!state.log.locked && !state.log.offline && canEdit(entry)
    ? `<button class="btn ghost icon" data-edit="${type}:${esc(entry.id)}" title="Wijzigen">✎</button><button class="btn ghost icon" data-del="${type}:${esc(entry.id)}" title="Verwijderen">✕</button>` : '');
  const pendingBadge = '<span class="pill wl-pending" title="Wordt verstuurd zodra er weer verbinding is">Wacht op netwerk</span>';

  function hoursTable() {
    const rows = state.log.hours;
    const pending = pendingFor(state.wo.id, 'hours');
    if (!rows.length && !pending.length) return '<p class="muted small">Nog geen uren geboekt.</p>';
    const stepTitle = (id) => ((state.wo.data.steps || []).find((s) => s.id === id) || {}).title || '';
    const line = (h, extra = '') => `<tr>
      <td>${esc(shortDate(h.workDate))}</td>
      <td>${esc(h.user ? h.user.displayName : (state.log.me || {}).displayName || '')}</td>
      <td>${esc(L.KINDS[h.kind] || h.kind)}${h.startTime ? `<span class="sub">${esc(h.startTime)}–${esc(h.endTime)}${h.breakMinutes ? `, ${h.breakMinutes} min pauze` : ''}</span>` : ''}</td>
      <td class="num"><b>${esc(L.hoursText(h.minutes))}</b></td>
      <td class="wrap">${esc([stepTitle(h.stepId), h.note].filter(Boolean).join(' · '))}${extra}</td>
      <td class="c-act">${h.id ? rowActions(h, 'hours') : ''}</td>
    </tr>`;
    const queued = pending.map((p) => {
      const c = L.cleanHours(p.body);
      return c.entry ? line({ ...c.entry, user: null }, ` ${pendingBadge}`) : '';
    });
    return `<div class="tablewrap"><table class="grid wl-table"><thead><tr><th>Datum</th><th>Medewerker</th><th>Soort</th><th class="num">Uren</th><th>Werkstap / opmerking</th><th></th></tr></thead>
      <tbody>${rows.map((h) => line(h)).join('')}${queued.join('')}</tbody></table></div>`;
  }

  function materialsTables() {
    const rows = state.log.materials;
    const pending = pendingFor(state.wo.id, 'materials');
    const used = L.totals(state.wo.data, [], rows).materials;
    const cmp = used.filter((m) => m.planned || m.used);
    const compare = cmp.length ? `<div class="tablewrap"><table class="grid wl-table wl-compare"><thead><tr><th>Materiaal</th><th class="num">Gepland</th><th class="num">Verbruikt</th><th class="num">Verschil</th></tr></thead>
      <tbody>${cmp.map((m) => `<tr class="${m.extra ? 'extra' : m.diff > 0 ? 'over' : ''}">
        <td>${esc(m.description || m.code)}${m.code ? `<span class="sub">${esc(m.code)}</span>` : ''}${m.extra ? ' <span class="pill wl-extra">Extra</span>' : ''}</td>
        <td class="num">${m.planned ? `${esc(nl(m.planned))} ${esc(m.unit)}` : '–'}</td>
        <td class="num">${m.used ? `${esc(nl(m.used))} ${esc(m.unit)}` : '–'}</td>
        <td class="num">${m.diff ? `${m.diff > 0 ? '+' : ''}${esc(nl(m.diff))}` : '0'}</td></tr>`).join('')}</tbody></table></div>` : '';
    if (!rows.length && !pending.length) return `${compare}<p class="muted small">Nog geen materiaal geboekt.</p>`;
    const line = (m, extra = '') => `<tr>
      <td>${esc(shortDate(m.usedOn))}</td>
      <td>${esc(m.user ? m.user.displayName : (state.log.me || {}).displayName || '')}</td>
      <td class="wrap">${esc(m.description || m.code)}${m.code ? `<span class="sub">${esc(m.code)}</span>` : ''}${m.note ? `<span class="sub">${esc(m.note)}</span>` : ''}${extra}</td>
      <td class="num${m.qty < 0 ? ' neg' : ''}"><b>${esc(nl(m.qty, 3))}</b> ${esc(m.unit)}${m.qty < 0 ? '<span class="sub">retour</span>' : ''}</td>
      <td class="c-act">${m.id ? rowActions(m, 'materials') : ''}</td>
    </tr>`;
    const queued = pending.map((p) => {
      const c = L.cleanMaterial(p.body);
      return c.entry ? line({ ...c.entry, user: null }, ` ${pendingBadge}`) : '';
    });
    return `${compare}<h4 class="wl-sub">Geboekt</h4><div class="tablewrap"><table class="grid wl-table"><thead><tr><th>Datum</th><th>Medewerker</th><th>Materiaal</th><th class="num">Aantal</th><th></th></tr></thead>
      <tbody>${rows.map((m) => line(m)).join('')}${queued.join('')}</tbody></table></div>`;
  }

  function summary() {
    const t = L.totals(state.wo.data, state.log.hours, state.log.materials);
    const kinds = Object.entries(t.byKind).map(([k, m]) => `${L.KINDS[k] || k} ${L.hoursText(m)}`).join(' · ');
    const users = Object.entries(t.byUser).map(([n, m]) => `${n} ${L.hoursText(m)}`).join(' · ');
    return { t, html: `<div class="wl-stats">
      <div class="stat"><b>${esc(L.hoursText(t.minutes))}</b><span>uur geboekt${t.plannedHours ? ` van ${esc(nl(t.plannedHours))} gepland` : ''}</span></div>
      <div class="stat"><b>${esc(state.log.materials.length)}</b><span>materiaalregels${t.extraMaterials ? `, ${t.extraMaterials} extra artikel${t.extraMaterials === 1 ? '' : 'en'}` : ''}</span></div>
    </div>${kinds ? `<p class="muted small">${esc(kinds)}${Object.keys(t.byUser).length > 1 ? `<br>${esc(users)}` : ''}</p>` : ''}` };
  }

  function render() {
    const card = $('#wl-card');
    if (!card || !state.wo || !state.log) return;
    // Wat in de wachtrij van de service worker staat, toont het knopje rechtsonder.
    const queue = ownQueue().filter((x) => x.woId === state.wo.id).length;
    const s = summary();
    $('#wl-sum').textContent = s.t.minutes ? `${L.hoursText(s.t.minutes)} uur geboekt` : '';
    const body = $('#wl-body');
    const locked = state.log.locked;
    body.innerHTML = `${s.html}
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

  // Berekende uren onder het formulier tonen.
  function calc() {
    const f = $('#wl-hours-form');
    if (!f) return;
    const c = L.cleanHours(formHours(f));
    $('.wl-calc', f).textContent = c.entry ? `= ${L.hoursText(c.entry.minutes)} uur` : '';
  }

  function formHours(f) {
    const v = Object.fromEntries(new FormData(f));
    return {
      workDate: v.workDate, startTime: v.startTime, endTime: v.endTime, breakMinutes: v.breakMinutes,
      hours: v.startTime && v.endTime ? undefined : v.hours, kind: v.kind, stepId: v.stepId, note: v.note, userId: v.userId,
    };
  }

  function formMaterial(f) {
    const v = Object.fromEntries(new FormData(f));
    const m = (state.wo.data.materials || []).find((x) => x.id === v.materialId);
    const qty = Math.abs(Number(String(v.qty || '').replace(',', '.')) || 0) * (v.retour ? -1 : 1);
    return {
      usedOn: v.usedOn, qty, unit: v.unit, note: v.note, userId: v.userId,
      ...(m ? { materialId: m.id, code: m.code, description: m.description } : { materialId: '', code: v.code, description: v.description }),
    };
  }

  async function submit(type, body) {
    const wo = state.wo;
    const editing = state.edit && state.edit.type === type ? state.edit.entry : null;
    const check = type === 'hours' ? L.cleanHours(body) : L.cleanMaterial(body);
    if (check.error) { toast(check.error, true); return; }
    if (state.log.canManage === false) delete body.userId;
    if (editing) {
      try {
        const out = await call(`api/workorders/${encodeURIComponent(wo.id)}/${type}/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
        const list = state.log[type];
        list[list.findIndex((x) => x.id === editing.id)] = out;
        state.edit = null;
        toast('Opgeslagen');
        render();
      } catch (e) {
        toast(e instanceof Offline ? 'Geen verbinding: wijzigen kan alleen online.' : `Opslaan mislukt: ${e.message}`, true);
      }
      return;
    }
    body.clientId = uuid();
    try {
      const out = await call(`api/workorders/${encodeURIComponent(wo.id)}/${type}`, {
        method: 'POST', body, offline: { label: `${type === 'hours' ? 'Uren' : 'Materiaal'} bij ${wo.number || 'werkorder'}` },
      });
      if (state.wo !== wo) return;
      if (out.queued) {
        state.swPending.push({ woId: wo.id, type, body, queueId: out.id });
        toast('Geen verbinding: op dit toestel bewaard, wordt later verstuurd.');
        render();
        return;
      }
      state.log[type].push(out);
      toast(type === 'hours' ? `${L.hoursText(out.minutes)} uur geboekt` : 'Materiaal geboekt');
      render();
    } catch (e) {
      if (!(e instanceof Offline)) { toast(`Boeken mislukt: ${e.message}`, true); return; }
      const owner = await currentOwner();
      state.owner = owner || state.owner;
      if (!owner || !writeQueue([...readQueue(), { woId: wo.id, type, body, owner, at: new Date().toISOString() }])) {
        toast('Geen verbinding en bewaren op dit toestel lukt niet.', true);
        return;
      }
      toast('Geen verbinding: op dit toestel bewaard, wordt later verstuurd.');
      render();
    }
  }

  async function remove(type, id) {
    const entry = state.log[type].find((x) => x.id === id);
    if (!entry || !confirm(type === 'hours' ? 'Deze urenregel verwijderen?' : 'Deze materiaalregel verwijderen?')) return;
    try {
      await call(`api/workorders/${encodeURIComponent(state.wo.id)}/${type}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.log[type] = state.log[type].filter((x) => x.id !== id);
      toast('Verwijderd');
      render();
    } catch (e) {
      toast(e instanceof Offline ? 'Geen verbinding: verwijderen kan alleen online.' : `Verwijderen mislukt: ${e.message}`, true);
    }
  }

  function bind() {
    if (bind.done) return;
    bind.done = true;
    const card = $('#wl-card');
    card.innerHTML = `<div class="lines-head"><h3>Uren en materiaalverbruik</h3><span id="wl-sum" class="muted small"></span></div>
      <p class="muted small">Boek per dag je gewerkte uren en het materiaal dat je hebt verbruikt of retour neemt. Zonder netwerk worden nieuwe regels op dit toestel bewaard en later verstuurd.</p>
      <div id="wl-body"><p class="muted small">Laden…</p></div>`;
    card.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; state.edit = null; render(); return; }
      if (e.target.closest('[data-flush]')) { flush(); return; }
      if (e.target.closest('[data-cancel]')) { state.edit = null; render(); return; }
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        const [type, id] = ed.dataset.edit.split(':');
        state.edit = { type, entry: state.log[type].find((x) => x.id === id) };
        render();
        $(type === 'hours' ? '#wl-hours-form' : '#wl-mat-form').scrollIntoView({ block: 'nearest' });
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) { const [type, id] = del.dataset.del.split(':'); remove(type, id); }
    });
    card.addEventListener('input', (e) => { if (e.target.closest('#wl-hours-form')) calc(); });
    card.addEventListener('change', (e) => {
      const f = e.target.closest('#wl-mat-form');
      if (f && e.target.name === 'materialId') {
        const m = (state.wo.data.materials || []).find((x) => x.id === e.target.value);
        $('.wl-other', f).hidden = Boolean(m);
        if (m) f.elements.unit.value = m.unit || f.elements.unit.value;
      }
    });
    card.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.id === 'wl-hours-form') submit('hours', formHours(e.target));
      if (e.target.id === 'wl-mat-form') submit('materials', formMaterial(e.target));
    });
  }

  /** Werkorder geopend. opts: { toast, staff: () => [{ id, displayName }] } */
  function open(wo, opts = {}) {
    if (!$('#wl-card')) return;
    state.opts = opts;
    state.wo = wo;
    state.swPending = [];
    state.log = null;
    state.edit = null;
    bind();
    $('#wl-sum').textContent = '';
    $('#wl-body').innerHTML = '<p class="muted small">Laden…</p>';
    load().then(flush);
  }

  // ---------- Excel ----------
  const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);
  const hoursColumns = (withWo) => [
    { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Medewerker', key: 'user', width: 22 },
    ...(withWo ? [{ header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Klant', key: 'customer', width: 28 }] : []),
    { header: 'Soort', key: 'kind', width: 11 }, { header: 'Begin', key: 'start', width: 8 }, { header: 'Eind', key: 'end', width: 8 },
    { header: 'Pauze (min)', key: 'pause', width: 11 }, { header: 'Uren', key: 'hours', width: 9, style: { numFmt: '0.00' } },
    { header: 'Opmerking', key: 'note', width: 40 },
  ];
  const hoursRow = (h) => ({
    date: asDate(h.workDate), user: h.user.displayName, wo: h.workOrder ? h.workOrder.number : '', customer: h.workOrder ? h.workOrder.customer : '',
    kind: L.KINDS[h.kind] || h.kind, start: h.startTime, end: h.endTime, pause: h.breakMinutes || null, hours: Math.round(h.minutes / 60 * 100) / 100, note: h.note,
  });
  const matColumns = (withWo) => [
    { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Medewerker', key: 'user', width: 22 },
    ...(withWo ? [{ header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Klant', key: 'customer', width: 28 }] : []),
    { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'description', width: 44 },
    { header: 'Aantal', key: 'qty', width: 9 }, { header: 'Eenheid', key: 'unit', width: 9 }, { header: 'Opmerking', key: 'note', width: 36 },
  ];
  const matRow = (m) => ({
    date: asDate(m.usedOn), user: m.user.displayName, wo: m.workOrder ? m.workOrder.number : '', customer: m.workOrder ? m.workOrder.customer : '',
    code: m.code, description: m.description, qty: m.qty, unit: m.unit, note: m.qty < 0 ? `Retour${m.note ? `: ${m.note}` : ''}` : m.note,
  });
  function sheet(wb, name, columns, rows, headStyle) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    for (const r of rows) ws.addRow(r);
    headStyle(ws.getRow(1));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  }

  /** Bladen Uren en Materiaalverbruik bij de Excel-export van één werkorder. */
  async function addSheets(wb, { headStyle }) {
    if (!state.wo || !state.log) return;
    sheet(wb, 'Uren', hoursColumns(false), state.log.hours.map(hoursRow), headStyle);
    sheet(wb, 'Materiaalverbruik', matColumns(false), state.log.materials.map(matRow), headStyle);
    const cmp = L.totals(state.wo.data, [], state.log.materials).materials;
    sheet(wb, 'Gepland vs verbruikt', [
      { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'description', width: 44 }, { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Gepland', key: 'planned', width: 10 }, { header: 'Verbruikt', key: 'used', width: 10 }, { header: 'Verschil', key: 'diff', width: 10 },
      { header: 'Extra', key: 'extra', width: 8 },
    ], cmp.map((m) => ({ ...m, extra: m.extra ? 'ja' : '' })), headStyle);
  }

  /** Urenstaat over een periode (alle werkorders): Excel met uren per regel, per medewerker en per dag, en materiaal. */
  async function exportPeriod({ from, to, userId, headStyle, download, companyName }) {
    const qs = new URLSearchParams({ from, to });
    if (userId) qs.set('user', userId);
    const out = await call(`api/worklog?${qs}`);
    const wb = new ExcelJS.Workbook();
    wb.creator = companyName || 'AquaTech Service';
    wb.created = new Date();
    sheet(wb, 'Uren', hoursColumns(true), out.hours.map(hoursRow), headStyle);
    // Per medewerker en dag, uren per soort.
    const map = new Map();
    for (const h of out.hours) {
      const k = `${h.user.displayName}|${h.workDate}`;
      const r = map.get(k) || { user: h.user.displayName, date: asDate(h.workDate), iso: h.workDate, total: 0 };
      r[h.kind] = (r[h.kind] || 0) + h.minutes / 60;
      r.total += h.minutes / 60;
      map.set(k, r);
    }
    const days = [...map.values()].sort((a, b) => a.user.localeCompare(b.user, 'nl') || a.iso.localeCompare(b.iso));
    const ds = sheet(wb, 'Per medewerker', [
      { header: 'Medewerker', key: 'user', width: 24 }, { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
      ...Object.entries(L.KINDS).map(([k, v]) => ({ header: v, key: k, width: 11, style: { numFmt: '0.00' } })),
      { header: 'Totaal', key: 'total', width: 11, style: { numFmt: '0.00' } },
    ], days, headStyle);
    if (days.length) {
      const last = ds.lastRow.number;
      const cols = ['C', 'D', 'E', 'F'];
      const tot = ds.addRow(['Totaal', '', ...cols.map((c) => ({ formula: `SUBTOTAL(9,${c}2:${c}${last})` }))]);
      tot.font = { bold: true };
    }
    sheet(wb, 'Materiaalverbruik', matColumns(true), out.materials.map(matRow), headStyle);
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `urenstaat_${from}_${to}.xlsx`);
    return { hours: out.hours.length, materials: out.materials.length };
  }

  window.WorkLog = { open, addSheets, exportPeriod, flush, pending: () => ownQueue().length };
  // Bij het laden van de pagina: wat nog op dit toestel wacht alsnog versturen.
  if (navigator.onLine !== false) setTimeout(flush, 1500);
})();
