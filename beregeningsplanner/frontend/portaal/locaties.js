// Klantportaal: installatiedossier per locatie. Groepeert de werkorders en
// meldingen van de klant per adres (sleutel `location` uit /api/portal) en
// toont per adres het dossier uit /api/portal/locations/:key: installaties met
// oplevering en foto's, plannen, offertes (zonder bedragen), meldingen en de
// geplaatste materialen. portaal.js roept render aan na elke keer laden.
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum voluit in het Nederlands.
   * @param {string} iso Datum (JJJJ-MM-DD) of tijdstip.
   * @returns {string} Bijv. "22 oktober 2026" (leeg zonder datum).
   */
  const day = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const QUOTE_STATUS = { verzonden: 'Wacht op uw reactie', akkoord: 'Akkoord', afgewezen: 'Afgewezen', verlopen: 'Verlopen' };
  const PHOTO_KIND = { voor: 'Voor de aanleg', tijdens: 'Tijdens de aanleg', oplevering: 'Bij oplevering' };

  // latestRequest telt elke klik; een ouder antwoord dan de laatste klik wordt genegeerd.
  const state = { dossier: null, latestRequest: 0 };

  /**
   * De locaties van de klant uit het portaaloverzicht: één per adres.
   * @param {object} data Het antwoord van /api/portal.
   * @returns {object[]} Per locatie key, adres, aantal installaties, opgeleverd en meldingen.
   */
  function locationsOf(data) {
    const byKey = new Map();
    /**
     * De locatie bij een sleutel (nieuw als hij er nog niet is).
     * @param {string} key De locatiesleutel.
     * @param {string} address Het adres.
     * @returns {object} De locatie.
     */
    const locationFor = (key, address) => {
      if (!byKey.has(key)) byKey.set(key, { key, address, installations: 0, completed: 0, requests: 0 });
      return byKey.get(key);
    };
    for (const workOrder of data.workorders || []) {
      // Een geannuleerde werkorder hoort niet in het dossier (de server laat hem ook weg).
      if (!workOrder.location || workOrder.status === 'geannuleerd') continue;
      const location = locationFor(workOrder.location, workOrder.address);
      location.installations++;
      if (workOrder.status === 'gereed') location.completed++;
    }
    for (const request of data.requests || []) {
      if (request.location) locationFor(request.location, request.address).requests++;
    }
    return [...byKey.values()];
  }

  /**
   * Tekent het blok "Mijn installaties per adres" (verborgen zonder locaties).
   * @param {object} data Het antwoord van /api/portal.
   */
  function render(data) {
    const section = $('#s-locations');
    if (!section) return;
    const locations = locationsOf(data);
    section.hidden = !locations.length;
    $('#locations').innerHTML = locations.map((location) => `
      <div class="card">
        <h3>${esc(location.address)}</h3>
        <div class="meta">${location.installations ? `${location.completed} van ${location.installations} installaties opgeleverd` : 'Nog geen installatie'}${location.requests ? ` · ${location.requests} melding${location.requests === 1 ? '' : 'en'}` : ''}</div>
        <div class="actions"><button class="btn" type="button" data-location="${esc(location.key)}">Installatiedossier</button></div>
      </div>`).join('');
  }

  /**
   * Toont een foto groot (zelfde venster als de rest van het portaal).
   * @param {object} photo De foto.
   */
  function showPhoto(photo) {
    $('#photo-img').src = `../${photo.url}`;
    $('#photo-img').alt = photo.caption || 'Foto';
    $('#photo-cap').textContent = photo.caption || PHOTO_KIND[photo.kind] || '';
    $('#photo').hidden = false;
  }

  /**
   * Eén installatie in het dossier: gegevens, ontwerp, oplevering en foto's.
   * @param {object} installation De installatie.
   * @param {number} index Volgnummer (voor de foto-knoppen).
   * @returns {string} HTML.
   */
  function installationHtml(installation, index) {
    const design = installation.design;
    const designText = design ? [design.lawnM2 ? `${Math.round(design.lawnM2)} m² gazon` : '', design.zones ? `${design.zones} zones` : '',
      design.sprinklers ? `${design.sprinklers} sproeiers` : '', design.pressureBar ? `${design.pressureBar} bar` : '', design.mainPipe ? `hoofdleiding ${design.mainPipe}` : ''].filter(Boolean).join(' · ') : '';
    return `<h3>${esc(installation.title || 'Installatie')} <span class="pill ${esc(installation.status)}">${esc(installation.statusLabel)}</span></h3>
      <dl class="kv">
        <dt>Werkorder</dt><dd>${esc(installation.number)}</dd>
        ${installation.quoteNumber ? `<dt>Offerte</dt><dd>${esc(installation.quoteNumber)}</dd>` : ''}
        ${installation.planTitle ? `<dt>Ontwerp</dt><dd>${esc(installation.planTitle)}</dd>` : ''}
        ${installation.completedOn ? `<dt>Opgeleverd</dt><dd>${esc(day(installation.completedOn))}</dd>` : installation.plannedDate ? `<dt>Gepland</dt><dd>${esc(day(installation.plannedDate))}</dd>` : ''}
        ${installation.installer ? `<dt>Monteur</dt><dd>${esc(installation.installer)}</dd>` : ''}
        ${installation.report.signedBy ? `<dt>Getekend door</dt><dd>${esc(installation.report.signedBy)}</dd>` : ''}
        ${designText ? `<dt>Installatie</dt><dd>${esc(designText)}</dd>` : ''}
      </dl>
      ${installation.report.notes ? `<div class="notes">${esc(installation.report.notes)}</div>` : ''}
      ${installation.zones.length ? `<div class="tablewrap"><table class="grid"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th></tr></thead><tbody>
        ${installation.zones.map((zone) => `<tr><td>${esc(zone.name)}</td><td>${esc(zone.kind)}</td><td class="wrap">${esc(zone.parts)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${installation.photos.length ? `<div class="photos">${installation.photos.map((photo, photoIndex) => `
        <figure><button type="button" data-location-photo="${index}:${photoIndex}" title="Vergroten"><img src="../${esc(photo.thumbUrl || photo.url)}" alt="${esc(photo.caption || PHOTO_KIND[photo.kind] || 'Foto')}" loading="lazy"></button>
          <figcaption>${esc(photo.caption || PHOTO_KIND[photo.kind] || '')}</figcaption></figure>`).join('')}</div>` : ''}`;
  }

  /** Tekent het geopende installatiedossier in het detailvenster. */
  function renderDossier() {
    const dossier = state.dossier;
    $('#detail-body').innerHTML = `
      <div class="dossier">
        <h2>Installatiedossier ${esc(dossier.address)}</h2>
        ${dossier.plans.length ? `<p class="muted">Ontwerp: ${dossier.plans.map((plan) => esc(plan.title)).join(', ')}</p>` : ''}
        ${dossier.installations.map(installationHtml).join('')}
        ${dossier.requests.length ? `<h3>Meldingen</h3><ul class="steps">${dossier.requests.map((request) => `
          <li><span>${esc(request.number)}</span><span>${esc(request.kindLabel)}: ${esc(request.subject)}</span><span class="phase">${esc(request.statusLabel)} · ${esc(day(request.createdAt))}</span></li>`).join('')}</ul>` : ''}
        ${dossier.quotes.length ? `<h3>Offertes</h3><ul class="steps">${dossier.quotes.map((quote) => `
          <li><span><a href="../offertes/?id=${encodeURIComponent(quote.id)}">${esc(quote.number)}</a></span><span>${esc(quote.title || '')}</span><span class="phase">${esc(QUOTE_STATUS[quote.status] || quote.status)}</span></li>`).join('')}</ul>` : ''}
        ${dossier.materials.length ? `<h3>Geplaatste materialen</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenheid</th></tr></thead><tbody>
          ${dossier.materials.map((material) => `<tr><td class="wrap">${esc(material.description || material.code)}</td><td class="num">${Number(material.placed).toLocaleString('nl-NL')}</td><td>${esc(material.unit)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="actions no-print" style="margin-top:16px"><button class="btn" type="button" id="location-print">Afdrukken of opslaan als PDF</button></div>
      </div>`;
    /** Drukt het dossier af (of slaat het op als PDF). */
    $('#location-print').onclick = () => { window.print(); };
    document.querySelectorAll('#detail-body [data-location-photo]').forEach((button) => {
      /** Toont de aangeklikte foto groot. */
      button.onclick = () => {
        const [installationIndex, photoIndex] = button.dataset.locationPhoto.split(':').map(Number);
        showPhoto(dossier.installations[installationIndex].photos[photoIndex]);
      };
    });
  }

  /**
   * Haalt het installatiedossier van een locatie op en toont het.
   * @param {string} key De locatiesleutel.
   * @returns {Promise<void>}
   */
  async function open(key) {
    const requestNumber = ++state.latestRequest;
    /**
     * Toont een foutmelding onderin beeld (3,5 s).
     * @param {string} reason Wat er misging.
     */
    const showError = (reason) => {
      const toast = $('#toast');
      toast.textContent = `Kan het installatiedossier niet openen: ${reason}`;
      toast.className = 'toast show err';
      setTimeout(() => { toast.className = 'toast'; }, 3500);
    };
    let res;
    try {
      res = await fetch(`../api/portal/locations/${encodeURIComponent(key)}`, { cache: 'no-store' });
    } catch (error) {
      if (requestNumber !== state.latestRequest) return;
      showError('geen verbinding');
      return;
    }
    const body = await res.json().catch(() => null);
    if (requestNumber !== state.latestRequest) return;
    if (!res.ok) {
      showError((body && body.message) || `HTTP ${res.status}`);
      return;
    }
    if (!body) {
      showError('het antwoord van de server is onleesbaar');
      return;
    }
    state.dossier = body;
    renderDossier();
    $('#detail').hidden = false;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('main [data-location]');
    if (button) open(button.dataset.location);
  });

  window.PortalLocations = { render, open, locationsOf };
})();
