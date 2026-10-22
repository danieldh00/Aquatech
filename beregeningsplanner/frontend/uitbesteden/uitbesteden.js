// Uitbesteden: werkorders aanbieden aan andere organisaties op het platform
// en opdrachten van anderen aannemen of afwijzen. Gegevens uit /api/outsourcing;
// alleen voor beheerders (recht 'uitbesteden'), en alleen als versturen of
// ontvangen in Beheer > Instellingen aan staat. Een nieuwe uitbesteding begint
// vanuit een werkorder (?wo=<id>).
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Getal in Nederlandse notatie.
   * @param {*} value Het getal.
   * @param {number} [decimals] Maximaal aantal decimalen.
   * @returns {string} Bijv. "2,5".
   */
  const formatNumber = (value, decimals = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: decimals });
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Datum met weekdag in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "di 13 april 2027" (leeg zonder datum).
   */
  const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const STATUS = { aangeboden: 'Aangeboden', geaccepteerd: 'Aangenomen', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken' };

  const state = { data: null, workOrder: null, tab: 'incoming' };

  /**
   * Toont een melding onderin beeld (3,5 s).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Roept de API aan (relatief vanaf uitbesteden/).
   * @param {string} path Pad onder api/.
   * @param {object} [options] { method, body }; body gaat als JSON.
   * @returns {Promise<object>} Het antwoord (fout = Error met `code`).
   */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error });
    return out;
  }

  /**
   * Planning in woorden: "di 13 april 2027, 08:00–12:00 uur (2 werkdagen)".
   * @param {object} plan { plannedDate, startTime, endTime, days }.
   * @returns {string} De planning als tekst.
   */
  function planning(plan) {
    if (!plan.plannedDate) return 'Nog geen datum: in overleg';
    const time = plan.startTime ? `, ${plan.startTime}${plan.endTime ? `–${plan.endTime}` : ''} uur` : '';
    return `${day(plan.plannedDate)}${time}${plan.days > 1 ? ` (${plan.days} werkdagen)` : ''}`;
  }

  /**
   * Statuslabel van een aanbod.
   * @param {string} status De status.
   * @param {string} [label] Eigen tekst (standaard die van de status).
   * @returns {string} HTML van het label.
   */
  const pill = (status, label) => `<span class="pill of-${esc(status)}">${esc(label || STATUS[status] || status)}</span>`;

  // ---------- Aangeboden aan ons ----------
  /**
   * Ontwerp, werkstappen en materialen van een aanbod (inklapbaar).
   * @param {object} preview De voorvertoning van het aanbod.
   * @returns {string} HTML.
   */
  function detailsOf(preview) {
    const designInfo = preview.design;
    const design = designInfo ? [designInfo.zones ? `${designInfo.zones} zones` : '', designInfo.sprinklers ? `${designInfo.sprinklers} sproeiers` : '', designInfo.lawnM2 ? `${formatNumber(designInfo.lawnM2, 0)} m² gazon` : '', designInfo.mainPipe || '']
      .filter(Boolean).join(' · ') : '';
    const steps = (preview.steps || []).map((step) => `<tr><td>${esc(WorkOrderCore.PHASES[step.phase] || step.phase)}</td><td>${esc(step.title)}</td><td class="num">${step.hours ? `${formatNumber(step.hours)} u` : ''}</td></tr>`).join('');
    const materialRows = (preview.materials || []).map((material) => `<tr><td>${esc(material.code)}</td><td>${esc(material.description)}</td><td class="num">${formatNumber(material.qty)} ${esc(material.unit)}</td></tr>`).join('');
    return `${design ? `<p class="small">${esc(design)}</p>` : ''}
      <details><summary>Werkstappen (${(preview.steps || []).length})</summary><table class="mini"><tbody>${steps || '<tr><td class="muted">Geen</td></tr>'}</tbody></table></details>
      <details><summary>Materialen (${(preview.materials || []).length})</summary><table class="mini"><tbody>${materialRows || '<tr><td class="muted">Geen</td></tr>'}</tbody></table></details>`;
  }

  /** Tekent de opdrachten die aan ons zijn aangeboden. */
  function renderIncoming() {
    const showAll = $('#i-all').checked;
    const items = (state.data.incoming || []).filter((offer) => showAll || offer.myStatus === 'aangeboden');
    const openCount = (state.data.incoming || []).filter((offer) => offer.myStatus === 'aangeboden').length;
    $('#t-incoming').textContent = openCount ? String(openCount) : '';
    const list = $('#i-list');
    if (!state.data.settings.receive) {
      list.innerHTML = '<p class="notice">Opdrachten ontvangen staat uit. Een beheerder zet het aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.</p>';
      return;
    }
    if (!items.length) {
      list.innerHTML = `<p class="notice muted">${showAll ? 'Nog geen opdrachten aangeboden.' : 'Er staan geen opdrachten voor je klaar.'}</p>`;
      return;
    }
    list.innerHTML = items.map((offer) => {
      const preview = offer.preview || {};
      const actions = offer.myStatus === 'aangeboden'
        ? `<button class="btn primary" data-accept="${esc(offer.id)}">Aannemen</button><button class="btn" data-decline="${esc(offer.id)}">Afwijzen</button>`
        : offer.receivedWorkOrderId ? `<a class="btn" href="../werkorders/?id=${encodeURIComponent(offer.receivedWorkOrderId)}">Naar onze werkorder</a>` : '';
      return `<article class="card-form offer st-${esc(offer.myStatus)}">
        <div class="offer-head">
          <h2>${esc(preview.title || 'Werkorder')}${preview.place ? ` <span class="muted">· ${esc(preview.place)}</span>` : ''}</h2>
          <span class="spacer"></span>
          ${pill(offer.myStatus)}
        </div>
        <div class="offer-info">
          <div><span class="lbl">Van</span>${esc(offer.fromName)}${offer.createdBy ? ` <span class="muted small">(${esc(offer.createdBy)})</span>` : ''}</div>
          <div><span class="lbl">Gewenste planning</span>${esc(planning(preview))}</div>
          <div><span class="lbl">Geschat werk</span>${preview.hours ? `${formatNumber(preview.hours)} uur` : '–'}${preview.zones ? ` · ${preview.zones} zones` : ''}</div>
          <div><span class="lbl">Vergoeding</span>${offer.fee != null ? `${esc(eur(offer.fee))} excl. btw` : 'In overleg'}</div>
          <div><span class="lbl">Aangeboden</span>${esc(when(offer.createdAt))}${offer.direct ? ' · alleen aan jullie' : ' · aan meerdere organisaties'}</div>
        </div>
        ${offer.message ? `<p class="offer-msg">${esc(offer.message)}</p>` : ''}
        ${preview.summary ? `<p class="small muted">${esc(preview.summary)}</p>` : ''}
        ${detailsOf(preview)}
        ${actions ? `<div class="row offer-actions">${actions}</div>` : ''}
      </article>`;
    }).join('');
    list.querySelectorAll('[data-accept]').forEach((button) => {
      /**
       * Neemt de opdracht aan.
       * @returns {Promise<void>}
       */
      button.onclick = () => accept(button.dataset.accept);
    });
    list.querySelectorAll('[data-decline]').forEach((button) => {
      /**
       * Wijst de opdracht af.
       * @returns {Promise<void>}
       */
      button.onclick = () => decline(button.dataset.decline);
    });
  }

  /**
   * Neemt een opdracht aan na bevestiging en gaat naar de nieuwe werkorder.
   * @param {string} id Id van het aanbod.
   * @returns {Promise<void>}
   */
  async function accept(id) {
    const offer = state.data.incoming.find((candidate) => candidate.id === id);
    if (!confirm(`Opdracht "${offer.preview.title}" van ${offer.fromName} aannemen?\n\nJullie krijgen een eigen werkorder met de klantgegevens; ${offer.fromName} ziet daarna de voortgang (status, planning en afgevinkte stappen).`)) return;
    try {
      const out = await api(`outsourcing/offers/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {} });
      toast(`Aangenomen: werkorder ${out.workOrder.number}`);
      location.href = `../werkorders/?id=${encodeURIComponent(out.workOrder.id)}`;
    } catch (error) {
      toast(error.message, true);
      load();
    }
  }

  /**
   * Wijst een opdracht af, met een optionele toelichting.
   * @param {string} id Id van het aanbod.
   * @returns {Promise<void>}
   */
  async function decline(id) {
    const reason = prompt('Opdracht afwijzen. Toelichting voor de aanbieder (optioneel):', '');
    if (reason === null) return;
    try {
      await api(`outsourcing/offers/${encodeURIComponent(id)}/decline`, { method: 'POST', body: { reason } });
      toast('Afgewezen');
    } catch (error) {
      toast(error.message, true);
    }
    load();
  }

  // ---------- Door ons uitbesteed ----------
  /**
   * Stand van de uitvoering bij de ontvanger (status, planning, stappen).
   * @param {object} offer Het aanbod.
   * @returns {string} HTML.
   */
  function execution(offer) {
    const execution = offer.execution;
    if (!execution) return '<span class="muted">–</span>';
    if (execution.removed) return '<span class="muted">Werkorder bij de ontvanger verwijderd</span>';
    return `<span class="pill wo-${esc(execution.status)}">${esc(WorkOrderCore.STATUSES[execution.status] || execution.status)}</span><span class="sub">${execution.plannedDate ? esc(planning(execution)) : 'Nog niet gepland'}</span>
      <span class="sub">${execution.progress.done}/${execution.progress.steps} stappen${execution.completedOn ? ` · opgeleverd ${esc(day(execution.completedOn))}` : ''}</span>`;
  }

  /** Tekent de tabel met wat wij hebben uitbesteed. */
  function renderOutgoing() {
    const items = state.data.outgoing || [];
    $('#t-outgoing').textContent = items.filter((offer) => offer.status === 'aangeboden' || offer.status === 'geaccepteerd').length || '';
    const table = $('#o-table');
    if (!items.length) {
      table.innerHTML = `<tbody><tr><td class="empty">${state.data.settings.send ? 'Nog niets uitbesteed. Open een werkorder en kies in het menu ⋯ “Uitbesteden”.' : 'Uitbesteden staat uit. Een beheerder zet het aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.'}</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `<thead><tr><th>Werkorder</th><th>Aan</th><th>Status</th><th>Uitvoering</th><th>Aangeboden</th><th></th></tr></thead><tbody>${items.map((offer) => `<tr>
      <td class="wrap"><a href="../werkorders/?id=${encodeURIComponent(offer.workOrderId)}"><b>${esc(offer.preview.title || 'Werkorder')}</b></a><span class="sub">${esc(offer.preview.place || '')}${offer.fee != null ? ` · ${esc(eur(offer.fee))}` : ''}</span></td>
      <td>${offer.receiverName ? esc(offer.receiverName) : '<span class="muted">Alle organisaties</span>'}${!offer.direct && offer.status === 'aangeboden' && offer.declinedCount ? `<span class="sub">${offer.declinedCount}× afgewezen</span>` : ''}</td>
      <td>${pill(offer.status)}${offer.respondedAt ? `<span class="sub">${esc(when(offer.respondedAt))}${offer.respondedBy ? ` · ${esc(offer.respondedBy)}` : ''}</span>` : ''}${offer.reason ? `<span class="sub">“${esc(offer.reason)}”</span>` : ''}</td>
      <td>${execution(offer)}</td>
      <td>${esc(when(offer.createdAt))}<span class="sub">${esc(offer.createdBy)}</span></td>
      <td>${offer.status === 'aangeboden' ? `<button class="btn small danger" data-withdraw="${esc(offer.id)}">Intrekken</button>` : ''}</td>
    </tr>`).join('')}</tbody>`;
    table.querySelectorAll('[data-withdraw]').forEach((button) => {
      /**
       * Trekt het aanbod na bevestiging in.
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (!confirm('Aanbod intrekken? Andere organisaties kunnen het dan niet meer aannemen.')) return;
        try { await api(`outsourcing/offers/${encodeURIComponent(button.dataset.withdraw)}`, { method: 'DELETE' }); toast('Ingetrokken'); } catch (error) { toast(error.message, true); }
        load();
      };
    });
  }

  /**
   * Toont een tabblad (aangeboden aan ons of door ons uitbesteed) en zet het in de adresbalk.
   * @param {string} name "incoming" of "outgoing".
   */
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    $('#tab-incoming').hidden = name !== 'incoming';
    $('#tab-outgoing').hidden = name !== 'outgoing';
    try { history.replaceState(null, '', `${location.search}#${name}`); } catch { /* file:// */ }
  }

  // ---------- Nieuwe uitbesteding ----------
  /**
   * Opent het formulier om een werkorder uit te besteden (vanaf ?wo=<id>).
   * @param {string} id Id van de werkorder.
   * @returns {Promise<void>}
   */
  async function openNew(id) {
    const form = $('#u-new');
    const errorBox = $('.err', form);
    let workOrder;
    try {
      workOrder = await api(`workorders/${encodeURIComponent(id)}`);
    } catch (error) {
      toast(`Kan de werkorder niet openen: ${error.message}`, true);
      return;
    }
    state.workOrder = workOrder;
    form.hidden = false;
    $('#n-cancel').href = `../werkorders/?id=${encodeURIComponent(workOrder.id)}`;
    $('#n-heading').textContent = `Werkorder ${workOrder.number} uitbesteden`;
    $('#n-wo').innerHTML = `<b>${esc(workOrder.title)}</b> · ${esc(workOrder.customer || '–')} · ${esc(workOrder.address || '')}
      <span class="sub">${esc(planning(workOrder.data))} · ${formatNumber(workOrder.progress.hours)} uur · ${workOrder.data.steps.length} stappen · ${workOrder.data.materials.length} materialen</span>`;
    const partners = state.data.partners || [];
    form.to.innerHTML = `<option value="">Alle organisaties die opdrachten ontvangen (${partners.length})</option>${partners
      .map((partner) => `<option value="${esc(partner.id)}">${esc(partner.name)}${partner.region ? ` – ${esc(partner.region)}` : ''}</option>`).join('')}`;
    const blocked = !state.data.settings.send ? 'Uitbesteden staat uit voor je organisatie. Een beheerder zet het aan in Beheer → Instellingen → Uitbesteden.'
      : workOrder.outsourcing && workOrder.outsourcing.role === 'uitbesteed' ? `Deze werkorder is al ${workOrder.outsourcing.status === 'geaccepteerd' ? `uitbesteed aan ${workOrder.outsourcing.partner}` : 'aangeboden'}.`
        : workOrder.outsourcing && workOrder.outsourcing.role === 'aangenomen' ? `Deze werkorder hebben jullie aangenomen van ${workOrder.outsourcing.partner}; die kun je niet verder uitbesteden.`
          : !['open', 'gepland'].includes(workOrder.status) ? 'Alleen een werkorder met status Nieuw of Gepland kan worden uitbesteed.'
            : !partners.length ? 'Er zijn nog geen andere organisaties die opdrachten ontvangen.' : '';
    errorBox.textContent = blocked;
    form.querySelectorAll('select, input, textarea, button[type=submit]').forEach((field) => { field.disabled = Boolean(blocked); });
    /**
     * Biedt de werkorder aan na bevestiging.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {Promise<void>}
     */
    form.onsubmit = async (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      const fee = form.fee.value.trim() === '' ? null : Number(form.fee.value.replace(',', '.'));
      if (fee !== null && !(fee >= 0)) { errorBox.textContent = 'Vul een geldig bedrag in, of laat de vergoeding leeg.'; return; }
      const target = partners.find((partner) => partner.id === form.to.value);
      if (!confirm(`Werkorder ${workOrder.number} aanbieden aan ${target ? target.name : `alle ${partners.length} organisaties die opdrachten ontvangen`}?`)) return;
      try {
        await api('outsourcing/offers', { method: 'POST', body: { workOrderId: workOrder.id, toTenantId: form.to.value || null, fee, message: form.message.value } });
        toast(`Werkorder ${workOrder.number} aangeboden`);
        history.replaceState(null, '', './#outgoing');
        form.hidden = true;
        await load();
        showTab('outgoing');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  /**
   * Laadt aanbiedingen en instellingen en tekent beide tabbladen.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      state.data = await api('outsourcing');
    } catch (error) {
      $('#u-denied').hidden = false;
      $('#u-denied').textContent = `Kan Uitbesteden niet laden: ${error.message}`;
      return;
    }
    const settings = state.data.settings;
    const offNotice = $('#u-off');
    offNotice.hidden = settings.send || settings.receive;
    offNotice.innerHTML = 'Uitbesteden staat uit voor je organisatie. Zet versturen en/of ontvangen aan in <a href="../beheer/#settings">Beheer → Instellingen → Uitbesteden</a>.'
      + (state.data.environment === 'test' ? ' Dit is een testomgeving: die werkt alleen met andere testomgevingen.' : '');
    $('#u-app').hidden = false;
    renderIncoming();
    renderOutgoing();
  }

  /**
   * Controleert het recht, koppelt de tabbladen, laadt en opent zo nodig een nieuwe uitbesteding.
   * @returns {Promise<void>}
   */
  async function init() {
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('uitbesteden')) {
      const denied = $('#u-denied');
      denied.hidden = false;
      denied.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Uitbesteden is alleen voor beheerders. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    document.querySelectorAll('.tab').forEach((tab) => {
      /**
       * Toont dit tabblad.
       * @returns {void}
       */
      tab.onclick = () => showTab(tab.dataset.tab);
    });
    $('#i-all').onchange = renderIncoming;
    await load();
    const hash = location.hash.slice(1);
    if (hash === 'outgoing' || hash === 'incoming') showTab(hash);
    else if (state.data && !(state.data.incoming || []).some((offer) => offer.myStatus === 'aangeboden') && (state.data.outgoing || []).length) showTab('outgoing');
    const workOrderId = new URLSearchParams(location.search).get('wo');
    if (workOrderId && state.data) openNew(workOrderId);
    if (window.AquatechCommon) window.AquatechCommon.onReturn(load);
  }

  init();
})();
