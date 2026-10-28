// Klantdossiers: per klant alle installaties (werkorders) met de oplevering,
// het ontwerp, de zones, de geplaatste materialen en de foto's. Overzicht als
// tabel (Excel-export), een dossier af te drukken als opleverrapport (PDF via
// de browser). Gegevens uit /api/dossiers; alleen beheerders en installateurs.
// Tweede weergave: het installatiedossier per locatie (adres) met ook de
// meldingen, offertes, plannen en het verbruikte materiaal (/api/locations).
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  const KINDS = window.WorkOrderPhotos.KINDS;
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
   * Datum voluit in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "22 oktober 2026" (leeg zonder datum).
   */
  const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /**
   * Datum kort in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "22-10-2026" (leeg zonder datum).
   */
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const QUOTE_STATUS = { concept: 'Concept', verzonden: 'Verzonden', akkoord: 'Akkoord', afgewezen: 'Afgewezen', verlopen: 'Verlopen' };

  // view: 'klanten' of 'locaties'; dossier = open klantdossier, location = open installatiedossier.
  const state = { me: null, profile: null, view: 'klanten', items: [], locations: [], sort: { key: 'lastActivity', dir: -1 }, dossier: null, location: null };
  // Telt elke navigatie; een lader die terugkomt na een nieuwere navigatie doet niets.
  let routeVersion = 0;

  /**
   * Toont een melding onderin beeld (3,5 s).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast no-print show${isError ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { element.className = 'toast no-print'; }, 3500);
  }

  /**
   * Haalt gegevens op bij de API (relatief vanaf klantdossier/).
   * @param {string} path Pad onder api/.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path) {
    const res = await fetch(`../api/${path}`, { cache: 'no-store' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
    return out;
  }

  /**
   * De zoekparameters van de huidige pagina.
   * @returns {URLSearchParams} De parameters.
   */
  const searchParams = () => new URLSearchParams(location.search);
  /**
   * Gaat naar een andere weergave (lijst of dossier) zonder de pagina te herladen.
   * @param {string} query Zoekparameters, bijv. "klant=a-…" (leeg = lijst).
   */
  function navigate(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Overzicht ----------
  const CUSTOMER_COLUMNS = [
    { key: 'name', label: 'Klant', value: (dossier) => dossier.name.toLowerCase(), html: (dossier) => `<b>${esc(dossier.name)}</b>${dossier.account ? '<span class="badge-acc" title="Heeft een klantaccount (portaal)">account</span>' : ''}` },
    { key: 'address', label: 'Adres', value: (dossier) => dossier.addresses[0] || '', html: (dossier) => esc(dossier.addresses.join(' · ') || '–'), cls: 'wrap' },
    { key: 'installations', label: 'Installaties', value: (dossier) => dossier.installations, html: (dossier) => `${dossier.completed} van ${dossier.installations} opgeleverd`, cls: 'num' },
    { key: 'photos', label: "Foto's", value: (dossier) => dossier.photos, html: (dossier) => (dossier.photos ? String(dossier.photos) : '–'), cls: 'num' },
    { key: 'lastCompletedOn', label: 'Laatst opgeleverd', value: (dossier) => dossier.lastCompletedOn || '', html: (dossier) => esc(shortDate(dossier.lastCompletedOn) || '–') },
    { key: 'lastActivity', label: 'Laatste activiteit', value: (dossier) => dossier.lastActivity, html: (dossier) => esc(when(dossier.lastActivity)) },
  ];
  const LOCATION_COLUMNS = [
    { key: 'address', label: 'Adres', value: (location) => location.address.toLowerCase(), html: (location) => `<a href="?locatie=${encodeURIComponent(location.key)}"><b>${esc(location.address)}</b></a>`, cls: 'wrap' },
    { key: 'customers', label: 'Klant', value: (location) => (location.customers[0] || '').toLowerCase(), html: (location) => esc(location.customers.join(' · ') || '–'), cls: 'wrap' },
    { key: 'installations', label: 'Installaties', value: (location) => location.installations, html: (location) => (location.installations ? `${location.completed} van ${location.installations} opgeleverd` : '–'), cls: 'num' },
    { key: 'requests', label: 'Meldingen', value: (location) => location.openRequests * 1000 + location.requests, html: (location) => (location.requests ? `${location.openRequests} open van ${location.requests}` : '–'), cls: 'num' },
    { key: 'photos', label: "Foto's", value: (location) => location.photos, html: (location) => (location.photos ? String(location.photos) : '–'), cls: 'num' },
    { key: 'lastCompletedOn', label: 'Laatst opgeleverd', value: (location) => location.lastCompletedOn || '', html: (location) => esc(shortDate(location.lastCompletedOn) || '–') },
    { key: 'lastActivity', label: 'Laatste activiteit', value: (location) => location.lastActivity, html: (location) => esc(when(location.lastActivity)) },
  ];
  /**
   * De kolommen van de gekozen weergave.
   * @returns {object[]} De kolommen.
   */
  const columnsOfView = () => (state.view === 'locaties' ? LOCATION_COLUMNS : CUSTOMER_COLUMNS);
  /**
   * Alle regels van de gekozen weergave (klanten of locaties).
   * @returns {object[]} De regels.
   */
  const itemsOfView = () => (state.view === 'locaties' ? state.locations : state.items);
  /**
   * De doorzoekbare tekst van een regel.
   * @param {object} item Een klant of locatie.
   * @returns {string} De tekst in kleine letters.
   */
  const searchTextOf = (item) => (state.view === 'locaties'
    ? [item.address, ...item.customers]
    : [item.name, ...item.addresses, item.account ? item.account.displayName : '']).join(' ').toLowerCase();

  /**
   * De dossiers die bij zoekterm en filter passen, gesorteerd op de gekozen kolom.
   * @returns {object[]} De dossiers.
   */
  function visible() {
    const term = $('#l-search').value.trim().toLowerCase();
    const onlyCompleted = $('#l-done').checked;
    const columns = columnsOfView();
    const column = columns.find((candidate) => candidate.key === state.sort.key) || columns[0];
    return itemsOfView()
      .filter((dossier) => !onlyCompleted || dossier.completed > 0)
      .filter((dossier) => !term || searchTextOf(dossier).includes(term))
      .sort((left, right) => {
        const leftValue = column.value(left), rightValue = column.value(right);
        return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * state.sort.dir;
      });
  }

  /** Tekent de tabel met dossiers en de kerncijfers. */
  function renderList() {
    const items = visible();
    const all = itemsOfView();
    const byLocation = state.view === 'locaties';
    const COLUMNS = columnsOfView();
    document.querySelectorAll('.tabs .tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === state.view);
      tab.setAttribute('aria-pressed', String(tab.dataset.view === state.view));
    });
    const head = `<thead><tr>${COLUMNS.map((column) => `<th data-sort="${column.key}" class="${column.cls === 'num' ? 'num ' : ''}${state.sort.key === column.key ? (state.sort.dir > 0 ? 'asc' : 'desc') : ''}">${esc(column.label)}</th>`).join('')}</tr></thead>`;
    const body = items.length
      ? items.map((dossier) => `<tr data-id="${esc(dossier.key)}">${COLUMNS.map((column) => `<td class="${column.cls || ''}">${column.html(dossier)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${COLUMNS.length}">${all.length ? `Geen ${byLocation ? 'locaties' : 'klanten'} gevonden met dit filter.`
        : byLocation ? 'Nog geen locaties. Een locatie ontstaat zodra een werkorder of melding een adres heeft.' : 'Nog geen dossiers. Een dossier ontstaat zodra er voor een klant een werkorder is.'}</td></tr>`;
    $('#l-table').innerHTML = head + `<tbody>${body}</tbody>`;
    $('#l-count').textContent = `${items.length} van ${all.length} ${byLocation ? 'locaties' : 'klanten'}`;
    const totals = all.reduce((sum, dossier) => ({ installations: sum.installations + dossier.installations, completed: sum.completed + dossier.completed, photos: sum.photos + dossier.photos, openRequests: sum.openRequests + (dossier.openRequests || 0) }),
      { installations: 0, completed: 0, photos: 0, openRequests: 0 });
    $('#l-stats').hidden = !all.length;
    $('#l-stats').innerHTML = `<div class="stat"><b>${all.length}</b><span>${byLocation ? 'locaties' : 'klanten'}</span></div>
      <div class="stat"><b>${totals.completed}</b><span>installaties opgeleverd</span></div>
      <div class="stat"><b>${totals.installations - totals.completed}</b><span>in uitvoering of gepland</span></div>
      ${byLocation ? `<div class="stat"><b>${totals.openRequests}</b><span>open meldingen</span></div>` : ''}
      <div class="stat"><b>${totals.photos}</b><span>foto's</span></div>`;
  }

  /**
   * Haalt de dossiers op en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function loadList() {
    const version = routeVersion;
    const byLocation = state.view === 'locaties';
    try {
      const items = (await api(byLocation ? 'locations' : 'dossiers')).items || [];
      if (version !== routeVersion) return;
      if (byLocation) state.locations = items; else state.items = items;
    } catch (error) {
      if (version !== routeVersion) return;
      if (byLocation) state.locations = []; else state.items = [];
      toast(`Dossiers laden mislukt: ${error.message}`, true);
    }
    renderList();
  }

  /**
   * Exporteert de getoonde dossiers naar Excel.
   * @returns {Promise<void>}
   */
  async function exportXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    if (state.view === 'locaties') return exportLocations(items);
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet('Klantdossiers', { views: [{ state: 'frozen', ySplit: 1 }] });
      worksheet.columns = [
        { header: 'Klant', key: 'name', width: 30 },
        { header: 'Klantaccount', key: 'account', width: 22 },
        { header: 'Adres(sen)', key: 'address', width: 44 },
        { header: 'Installaties', key: 'installations', width: 12 },
        { header: 'Opgeleverd', key: 'completed', width: 12 },
        { header: "Foto's", key: 'photos', width: 9 },
        { header: 'Laatst opgeleverd', key: 'lastCompletedOn', width: 18 },
        { header: 'Laatste activiteit', key: 'lastActivity', width: 20 },
      ];
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      for (const dossier of items) {
        worksheet.addRow({
          name: dossier.name, account: dossier.account ? dossier.account.displayName : '', address: dossier.addresses.join('; '),
          installations: dossier.installations, completed: dossier.completed, photos: dossier.photos,
          lastCompletedOn: dossier.lastCompletedOn ? new Date(`${dossier.lastCompletedOn}T12:00:00`) : null,
          lastActivity: dossier.lastActivity ? new Date(dossier.lastActivity) : null,
        });
      }
      worksheet.getColumn('lastCompletedOn').numFmt = 'dd-mm-yyyy';
      worksheet.getColumn('lastActivity').numFmt = 'dd-mm-yyyy hh:mm';
      worksheet.autoFilter = { from: 'A1', to: 'H1' };
      const blob = new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `klantdossiers_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      toast(`${items.length} klanten geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  /**
   * Exporteert de getoonde locaties naar Excel.
   * @param {object[]} items De locaties.
   * @returns {Promise<void>}
   */
  async function exportLocations(items) {
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet('Locaties', { views: [{ state: 'frozen', ySplit: 1 }] });
      worksheet.columns = [
        { header: 'Adres', key: 'address', width: 44 },
        { header: 'Klant(en)', key: 'customers', width: 30 },
        { header: 'Installaties', key: 'installations', width: 12 },
        { header: 'Opgeleverd', key: 'completed', width: 12 },
        { header: 'Meldingen', key: 'requests', width: 11 },
        { header: 'Open meldingen', key: 'openRequests', width: 15 },
        { header: "Foto's", key: 'photos', width: 9 },
        { header: 'Laatst opgeleverd', key: 'lastCompletedOn', width: 18 },
        { header: 'Laatste activiteit', key: 'lastActivity', width: 20 },
      ];
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      for (const location of items) {
        worksheet.addRow({
          address: location.address, customers: location.customers.join('; '), installations: location.installations, completed: location.completed,
          requests: location.requests, openRequests: location.openRequests, photos: location.photos,
          lastCompletedOn: location.lastCompletedOn ? new Date(`${location.lastCompletedOn}T12:00:00`) : null,
          lastActivity: location.lastActivity ? new Date(location.lastActivity) : null,
        });
      }
      worksheet.getColumn('lastCompletedOn').numFmt = 'dd-mm-yyyy';
      worksheet.getColumn('lastActivity').numFmt = 'dd-mm-yyyy hh:mm';
      worksheet.autoFilter = { from: 'A1', to: 'I1' };
      const blob = new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `installatiedossiers_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      toast(`${items.length} locaties geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  // ---------- Dossier ----------
  /**
   * Veld met een label (leeg als er geen waarde is).
   * @param {string} label Het label.
   * @param {string} value De waarde als HTML.
   * @returns {string} HTML.
   */
  const field = (label, value) => (value ? `<div><span class="lbl">${esc(label)}</span>${value}</div>` : '');

  /**
   * Het ontwerp in één regel (gazon, sproeiers, zones, druk, debiet, hoofdleiding).
   * @param {object|null} design Ontwerpgegevens van de werkorder.
   * @returns {string} De regel (leeg zonder ontwerp).
   */
  function designLine(design) {
    if (!design) return '';
    return [design.lawnM2 ? `${formatNumber(design.lawnM2, 0)} m² gazon` : '', design.sprinklers ? `${design.sprinklers} sproeiers` : '', design.zones ? `${design.zones} zones` : '',
      design.pressureBar ? `${formatNumber(design.pressureBar, 1)} bar` : '', design.flowM3h ? `${formatNumber(design.flowM3h, 1)} m³/u` : '', design.mainPipe ? `hoofdleiding ${design.mainPipe}` : '']
      .filter(Boolean).join(' · ');
  }

  /**
   * Foto's van een installatie per fase.
   * @param {object} installationRecord De installatie.
   * @param {boolean} internal true = ook foto's die alleen intern zijn.
   * @returns {string} HTML.
   */
  function photoTiles(installationRecord, internal) {
    const list = installationRecord.photos.filter((photo) => internal || photo.customerVisible);
    if (!list.length) return '<p class="ph-empty">Geen foto\'s bij deze installatie.</p>';
    return Object.entries(KINDS).map(([kind, label]) => {
      const group = list.filter((photo) => photo.kind === kind);
      if (!group.length) return '';
      return `<div class="ph-group">${label} (${group.length})</div><div class="ph-grid">${group.map((photo) => `
        <div class="ph-tile${photo.customerVisible ? '' : ' hidden-for-customer'}" data-photo="${esc(photo.id)}" data-inst="${esc(installationRecord.id)}">
          ${photo.customerVisible ? '' : '<span class="ph-badge off">Alleen intern</span>'}
          <button class="ph-img" type="button" title="Vergroten"><img loading="lazy" src="../${esc(photo.thumbUrl)}" alt="${esc(photo.caption || label)}"></button>
          <div class="ph-meta"><span class="ph-cap">${esc(photo.caption || label)}</span><span>${esc(when(photo.takenAt || photo.createdAt))}</span></div>
        </div>`).join('')}</div>`;
    }).join('');
  }

  /**
   * Kaart van één installatie: gegevens, oplevering, foto's, zones en materialen.
   * @param {object} installationRecord De installatie.
   * @param {boolean} internal true = ook interne foto's tonen.
   * @returns {string} HTML.
   */
  function installation(installationRecord, internal) {
    const report = installationRecord.report;
    const zones = installationRecord.zones.length ? `<details open><summary>Zone-indeling (${installationRecord.zones.length})</summary>
      <table class="mini"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th><th class="num">l/u</th><th class="num">Leiding</th><th class="num">Druk</th></tr></thead><tbody>
      ${installationRecord.zones.map((zone) => `<tr class="${zone.ok ? '' : 'bad'}"><td>${esc(zone.name)}</td><td>${esc(zone.kind)}</td><td>${esc(zone.parts)}</td><td class="num">${formatNumber(zone.flowLph, 0)}</td><td class="num">${zone.pipeM ? `${formatNumber(zone.pipeM, 1)} m` : ''}</td><td class="num">${zone.pressureBar ? `${formatNumber(zone.pressureBar, 1)} bar` : ''}</td></tr>`).join('')}
      </tbody></table></details>` : '';
    const materials = installationRecord.materials.length ? `<details><summary>Geplaatste materialen (${installationRecord.materials.length})</summary>
      <table class="mini"><thead><tr><th>Code</th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th></tr></thead><tbody>
      ${installationRecord.materials.map((material) => `<tr><td>${esc(material.code)}</td><td>${esc(material.description)}</td><td class="num">${formatNumber(material.qty)}</td><td>${esc(material.unit)}</td></tr>`).join('')}
      </tbody></table></details>` : '';
    const designText = designLine(installationRecord.design);
    return `<section class="card-form inst st-${esc(installationRecord.status)}">
      <div class="inst-head">
        <h2>${esc(installationRecord.title || 'Installatie')}</h2>
        <span class="pill wo-${esc(installationRecord.status)}">${esc(WorkOrderCore.STATUSES[installationRecord.status] || installationRecord.status)}</span>
        <span class="spacer"></span>
        <a class="no-print small" href="../werkorders/?id=${encodeURIComponent(installationRecord.id)}">Werkorder ${esc(installationRecord.number)} openen</a>
      </div>
      <div class="inst-info">
        ${field('Adres', installationRecord.location ? `<a href="?locatie=${encodeURIComponent(installationRecord.location)}" title="Installatiedossier van deze locatie">${esc(installationRecord.address)}</a>` : esc(installationRecord.address))}
        ${field('Opgeleverd op', esc(day(installationRecord.completedOn)) || (installationRecord.status === 'gereed' ? '' : '<span class="muted">Nog niet opgeleverd</span>'))}
        ${field('Afgetekend door (klant)', esc(report.signedBy))}
        ${field('Uitgevoerd door', esc([...new Set([installationRecord.assignee, installationRecord.crew].filter(Boolean))].join(', ')))}
        ${field('Gepland', esc(installationRecord.plannedDate && installationRecord.status !== 'gereed' ? day(installationRecord.plannedDate) : ''))}
        ${field('Werkorder', esc(installationRecord.number))}
        ${field('Offerte', installationRecord.quoteId ? `<a href="../offertes/?id=${encodeURIComponent(installationRecord.quoteId)}">${esc(installationRecord.quoteNumber || 'offerte')}</a>` : '')}
        ${field('Ontwerp', installationRecord.planId ? `<a href="../beregening/?plan=${encodeURIComponent(installationRecord.planId)}">${esc(installationRecord.planTitle || 'beregeningsplan')}</a>` : '')}
      </div>
      ${designText ? `<div class="design-line"><b>Ontwerp:</b> ${esc(designText)}</div>` : ''}
      ${report.notes ? `<h3>Opmerkingen bij de oplevering</h3><div class="notes">${esc(report.notes)}</div>` : ''}
      <h3>Foto's</h3>
      ${photoTiles(installationRecord, internal)}
      ${zones}${materials}
    </section>`;
  }

  /**
   * De adressen van een klantdossier, elk met een link naar het installatiedossier van die locatie.
   * @param {object} dossier Het klantdossier.
   * @returns {string} HTML.
   */
  function addressLinks(dossier) {
    return `<span class="loc-links">${dossier.addresses.map((address) => {
      const match = dossier.installations.find((installationRecord) => installationRecord.address === address && installationRecord.location);
      return match ? `<a href="?locatie=${encodeURIComponent(match.location)}" title="Installatiedossier van deze locatie">${esc(address)}</a>` : `<span>${esc(address)}</span>`;
    }).join('')}</span>`;
  }

  /** Tekent het installatiedossier van de gekozen locatie (ook de afdrukversie). */
  function renderLocation() {
    const dossier = state.location;
    const internal = $('#d-internal').checked;
    const profile = state.profile || {};
    const company = [profile.companyName, profile.address, [profile.phone, profile.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const done = dossier.installations.filter((installationRecord) => installationRecord.status === 'gereed').length;
    const photoCount = dossier.installations.reduce((sum, installationRecord) => sum + installationRecord.photos.filter((photo) => internal || photo.customerVisible).length, 0);
    document.title = `Installatiedossier ${dossier.address} – AquaTech Service`;
    const customers = dossier.customers.map((customer) => (customer.dossierKey
      ? `<a href="?klant=${encodeURIComponent(customer.dossierKey)}">${esc(customer.name)}</a>`
      : esc(customer.name))).join('<br>');
    const plans = dossier.plans.map((plan) => `<a href="../beregening/?plan=${encodeURIComponent(plan.id)}">${esc(plan.title)}</a>`).join('<br>');
    const materials = dossier.materials.length ? `<section class="card-form inst"><h3>Materialen op deze locatie</h3>
      <table class="mini"><thead><tr><th>Code</th><th>Omschrijving</th><th class="num">Geplaatst (werkorder)</th><th class="num">Verbruikt (geboekt)</th><th>Eenh.</th></tr></thead><tbody>
      ${dossier.materials.map((material) => `<tr><td>${esc(material.code)}</td><td>${esc(material.description)}</td><td class="num">${material.placed ? formatNumber(material.placed) : '–'}</td><td class="num">${material.used ? formatNumber(material.used) : '–'}</td><td>${esc(material.unit)}</td></tr>`).join('')}
      </tbody></table></section>` : '';
    const requests = dossier.requests.length ? `<section class="card-form inst"><h3>Meldingen</h3>
      <table class="mini"><thead><tr><th>Nummer</th><th>Soort</th><th>Onderwerp</th><th>Status</th><th>Gemeld</th></tr></thead><tbody>
      ${dossier.requests.map((request) => `<tr><td><a href="../meldingen/?id=${encodeURIComponent(request.id)}">${esc(request.number)}</a></td><td>${esc(request.kindLabel)}${request.urgent ? ' (spoed)' : ''}</td><td>${esc(request.subject)}</td><td>${esc(request.statusLabel)}</td><td>${esc(shortDate(request.createdAt))}</td></tr>`).join('')}
      </tbody></table></section>` : '';
    $('#d-body').innerHTML = `
      <header class="d-head">
        <img src="../shared/logo-white.png" alt="${esc(profile.companyName || 'AquaTech Service')}">
        <div class="d-title"><h1 tabindex="-1">Installatiedossier ${esc(dossier.address)}</h1><span class="sub">${done} van ${dossier.installations.length} installaties opgeleverd · ${dossier.requests.length} meldingen · ${photoCount} foto's · bijgewerkt ${esc(day(new Date().toISOString()))}</span></div>
        <div class="d-company">${esc(company)}</div>
      </header>
      <section class="card-form">
        <h3>Locatie</h3>
        <div class="d-cust">
          ${field('Adres', esc(dossier.address))}
          ${field('Klant(en)', customers)}
          ${field('Tekening / plan', plans)}
        </div>
      </section>
      ${dossier.installations.map((installationRecord) => installation(installationRecord, internal)).join('')}
      ${requests}${materials}
      ${dossier.quotes.length ? `<section class="card-form no-print"><h3>Offertes</h3><table class="mini grid"><thead><tr><th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Totaal incl. btw</th><th>Datum</th></tr></thead><tbody>
        ${dossier.quotes.map((quote) => `<tr><td><a href="../offertes/?id=${encodeURIComponent(quote.id)}">${esc(quote.number)}</a></td><td>${esc(quote.title)}</td><td>${esc(QUOTE_STATUS[quote.status] || quote.status)}</td><td class="num">${esc(eur(quote.totalIncl))}</td><td>${esc(shortDate(quote.createdAt))}</td></tr>`).join('')}
        </tbody></table></section>` : ''}
      <p class="d-foot">${esc([profile.companyName, profile.website].filter(Boolean).join(' · '))}</p>`;
  }

  /**
   * Haalt een installatiedossier op en toont het.
   * @param {string} key Sleutel van de locatie (l-<hash>).
   * @returns {Promise<void>}
   */
  async function loadLocation(key) {
    const version = routeVersion;
    state.dossier = null;
    $('#list-view').hidden = true;
    $('#detail-view').hidden = false;
    $('#d-body').innerHTML = '<p class="muted">Installatiedossier laden…</p>';
    try {
      const location = await api(`locations/${encodeURIComponent(key)}`);
      // Intussen naar een andere weergave gegaan: dit antwoord is verouderd.
      if (version !== routeVersion) return;
      state.location = location;
      renderLocation();
      window.scrollTo(0, 0);
      // Focus naar de kop, zodat toetsenbord en schermlezer bij het geopende dossier staan.
      $('#d-body h1').focus();
    } catch (error) {
      if (version !== routeVersion) return;
      toast(`Kan het installatiedossier niet openen: ${error.message}`, true);
      navigate('weergave=locaties');
    }
  }

  /** Tekent het open dossier opnieuw (klant of locatie). */
  function renderOpen() {
    if (state.location) renderLocation();
    else if (state.dossier) renderDossier();
  }

  /** Tekent het dossier van de gekozen klant (ook de afdrukversie). */
  function renderDossier() {
    const dossier = state.dossier;
    const internal = $('#d-internal').checked;
    const customer = dossier.customer;
    const profile = state.profile || {};
    const company = [profile.companyName, profile.address, [profile.phone, profile.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const done = dossier.installations.filter((installationRecord) => installationRecord.status === 'gereed').length;
    const photoCount = dossier.installations.reduce((sum, installationRecord) => sum + installationRecord.photos.filter((photo) => internal || photo.customerVisible).length, 0);
    document.title = `Klantdossier ${customer.name || ''} – AquaTech Service`;
    $('#d-body').innerHTML = `
      <header class="d-head">
        <img src="../shared/logo-white.png" alt="${esc(profile.companyName || 'AquaTech Service')}">
        <div class="d-title"><h1>Klantdossier ${esc(customer.name)}</h1><span class="sub">${done} van ${dossier.installations.length} installaties opgeleverd · ${photoCount} foto's · bijgewerkt ${esc(day(new Date().toISOString()))}</span></div>
        <div class="d-company">${esc(company)}</div>
      </header>
      <section class="card-form">
        <h3>Klant</h3>
        <div class="d-cust">
          ${field('Naam', esc(customer.name))}
          ${field('Contactpersoon', esc(customer.contact))}
          ${field('Telefoon', customer.phone ? `<a href="tel:${esc(customer.phone.replace(/[^\d+]/g, ''))}">${esc(customer.phone)}</a>` : '')}
          ${field('E-mail', customer.email ? `<a href="mailto:${esc(customer.email)}">${esc(customer.email)}</a>` : '')}
          ${field('Adres(sen)', addressLinks(dossier))}
          ${field('Klantportaal', dossier.account ? `account ${esc(dossier.account.displayName)}` : '<span class="muted">geen klantaccount</span>')}
        </div>
      </section>
      ${dossier.installations.map((installationRecord) => installation(installationRecord, internal)).join('')}
      ${dossier.quotes.length ? `<section class="card-form no-print"><h3>Offertes</h3><table class="mini grid"><thead><tr><th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Totaal incl. btw</th><th>Datum</th></tr></thead><tbody>
        ${dossier.quotes.map((quote) => `<tr><td><a href="../offertes/?id=${encodeURIComponent(quote.id)}">${esc(quote.number)}</a></td><td>${esc(quote.title)}</td><td>${esc(QUOTE_STATUS[quote.status] || quote.status)}</td><td class="num">${esc(eur(quote.totalIncl))}</td><td>${esc(shortDate(quote.createdAt))}</td></tr>`).join('')}
        </tbody></table></section>` : ''}
      <p class="d-foot">${esc([profile.companyName, profile.website].filter(Boolean).join(' · '))}</p>`;
  }

  /**
   * Haalt een dossier op en toont het.
   * @param {string} key Sleutel van de klant (a-<id> of n-<hash>).
   * @returns {Promise<void>}
   */
  async function loadDossier(key) {
    const version = routeVersion;
    state.location = null;
    $('#list-view').hidden = true;
    $('#detail-view').hidden = false;
    $('#d-body').innerHTML = '<p class="muted">Dossier laden…</p>';
    try {
      const dossier = await api(`dossiers/${encodeURIComponent(key)}`);
      if (version !== routeVersion) return;
      state.dossier = dossier;
      renderDossier();
      window.scrollTo(0, 0);
    } catch (error) {
      if (version !== routeVersion) return;
      toast(`Kan het dossier niet openen: ${error.message}`, true);
      navigate('');
    }
  }

  /**
   * Drukt het dossier af als opleverrapport: eerst alle foto's laden en ingeklapte onderdelen openen.
   * @returns {Promise<void>}
   */
  async function printDossier() {
    // Wachten tot alle foto's geladen zijn (lazy loading staat uit bij afdrukken).
    const images = [...document.querySelectorAll('#d-body img')];
    images.forEach((image) => { image.loading = 'eager'; });
    await Promise.all(images.map((image) => (image.complete ? null : new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; }))));
    // Ingeklapte onderdelen (materialen) komen wel op papier.
    const collapsed = [...document.querySelectorAll('#d-body details:not([open])')];
    collapsed.forEach((details) => { details.open = true; });
    window.addEventListener('afterprint', () => collapsed.forEach((details) => { details.open = false; }), { once: true });
    const previousTitle = document.title;
    document.title = `Opleverrapport ${state.location ? state.location.address : state.dossier.customer.name || ''}`.trim();
    window.print();
    setTimeout(() => { document.title = previousTitle; }, 500);
  }

  /** Toont de lijst met dossiers. */
  function showList() {
    state.dossier = null;
    state.location = null;
    document.title = 'Klantdossiers – AquaTech Service';
    $('#detail-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  /**
   * Toont het dossier uit ?klant= of ?locatie=, of anders de lijst (?weergave=locaties: per locatie).
   * @returns {Promise<void>|undefined}
   */
  function route() {
    routeVersion++;
    const params = searchParams();
    if (params.get('klant')) return loadDossier(params.get('klant'));
    if (params.get('locatie')) return loadLocation(params.get('locatie'));
    const view = params.get('weergave') === 'locaties' ? 'locaties' : 'klanten';
    if (view !== state.view) state.sort = { key: 'lastActivity', dir: -1 };
    state.view = view;
    showList();
  }

  /**
   * Controleert het recht, laadt het bedrijfsprofiel op de achtergrond en koppelt alle knoppen.
   * @returns {Promise<void>}
   */
  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    if (!state.me.user || !rights.includes('werkorders')) {
      $('#l-export').hidden = true;
      $('#l-table').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<tr><td class="empty">Klantdossiers zijn alleen voor beheerders en installateurs. <a href="../">Terug naar het overzicht</a></td></tr>'
        : '<tr><td class="empty">Log eerst in om de klantdossiers te bekijken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    // Bedrijfsprofiel (alleen voor de afdrukversie) op de achtergrond.
    state.profile = { companyName: 'AquaTech Service' };
    api('quote-profile').then((response) => {
      if (!response || !response.profile) return;
      state.profile = response.profile;
      renderOpen();
    }).catch(() => {});
    let searchTimer;
    /** Zoekt na een korte pauze in het typen. */
    $('#l-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); };
    $('#l-done').onchange = renderList;
    $('#l-export').onclick = exportXlsx;
    /**
     * Sorteert op een kolom of opent een dossier.
     * @param {MouseEvent} event De klik.
     * @returns {void}
     */
    $('#l-table').onclick = (event) => {
      const header = event.target.closest('th[data-sort]');
      if (header) {
        state.sort = { key: header.dataset.sort, dir: state.sort.key === header.dataset.sort ? -state.sort.dir : 1 };
        return renderList();
      }
      const link = event.target.closest('a[href^="?locatie="]');
      // Ctrl/Cmd/Shift-klik: de browser opent de link zelf (nieuw tabblad of venster).
      if (link && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
      if (link) { event.preventDefault(); return navigate(link.getAttribute('href').slice(1)); }
      const row = event.target.closest('tr[data-id]');
      if (row) navigate(`${state.view === 'locaties' ? 'locatie' : 'klant'}=${encodeURIComponent(row.dataset.id)}`);
    };
    document.querySelectorAll('.tabs .tab').forEach((tab) => {
      /** Wisselt tussen per klant en per locatie. */
      tab.onclick = () => { navigate(tab.dataset.view === 'locaties' ? 'weergave=locaties' : ''); };
    });
    /**
     * Terug naar de lijst.
     * @returns {void}
     */
    $('#d-back').onclick = () => navigate(state.location ? 'weergave=locaties' : '');
    $('#d-print').onclick = printDossier;
    /** Toont of verbergt de interne foto's. */
    $('#d-internal').onchange = renderOpen;
    $('#d-body').addEventListener('click', (event) => {
      const tile = event.target.closest('.ph-tile');
      if (!tile || !event.target.closest('.ph-img')) return;
      const internal = $('#d-internal').checked;
      const installationRecord = (state.location || state.dossier).installations.find((candidate) => candidate.id === tile.dataset.inst);
      const list = Object.keys(KINDS).flatMap((kind) => installationRecord.photos.filter((photo) => photo.kind === kind && (internal || photo.customerVisible)));
      window.PhotoViewer.show(list.map((photo) => ({ src: `../${photo.url}`, caption: photo.caption || KINDS[photo.kind], sub: [KINDS[photo.kind], when(photo.takenAt || photo.createdAt), installationRecord.number].join(' · ') })),
        list.findIndex((photo) => photo.id === tile.dataset.photo));
    });
    window.addEventListener('popstate', route);
    // Terug via de knop Terug van de browser (bijv. uit een werkorder): opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(route);
    route();
  }

  init();
})();
