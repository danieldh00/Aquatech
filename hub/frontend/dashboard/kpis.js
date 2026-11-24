// Startscherm "Cijfers" voor beheerders (api/kpis): openstaand bedrag, vervallen facturen, open offertes en de
// bezetting van deze week, elk als tegel met een link naar de module. Zonder tegels (geen recht) blijft het blok weg.
(function () {
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Maakt de waarde van een tegel leesbaar.
   * @param {{ value: number, unit: string }} kpi De tegel uit api/kpis.
   * @returns {string} Bedrag met euroteken of het aantal.
   */
  function formatValue(kpi) {
    if (kpi.unit !== 'euro') return String(kpi.value);
    return `€ ${kpi.value.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /**
   * Tekent het blok met de KPI's.
   * @param {HTMLElement} container Het element #kpis.
   * @param {{ key: string, title: string, value: number, unit: string, detail: string, href: string }[]} kpis De tegels uit api/kpis.
   * @returns {void}
   */
  function render(container, kpis) {
    container.innerHTML = `
      <h2>KPI's</h2>
      <div class="kpi-grid">${kpis.map((kpi) => `
        <a class="kpi" data-kpi="${esc(kpi.key)}" href="${esc(kpi.href)}">
          <span class="kpi-title">${esc(kpi.title)}</span>
          <span class="kpi-value">${esc(formatValue(kpi))}</span>
          <span class="kpi-detail">${esc(kpi.detail)}</span>
        </a>`).join('')}</div>`;
    container.hidden = false;
  }

  /**
   * Haalt de KPI's op en toont ze (alleen voor beheerders).
   * @param {object} me Antwoord van api/me.
   * @returns {Promise<void>}
   */
  async function start(me) {
    const container = document.getElementById('kpis');
    if (!container || !me || !me.user || location.protocol === 'file:') return;
    if (!Array.isArray(me.rights) || !me.rights.includes('beheer')) return;
    if (!(await window.AquatechModuleTools.featureOn('dashboard-cijfers'))) return;
    try {
      const res = await fetch('api/kpis', { cache: 'no-store' });
      if (!res.ok) return;
      const kpis = (await res.json()).kpis || [];
      if (kpis.length) render(container, kpis);
    } catch (error) { /* geen verbinding: het blok blijft weg */ }
  }

  window.AquatechKpis = { start };
})();
