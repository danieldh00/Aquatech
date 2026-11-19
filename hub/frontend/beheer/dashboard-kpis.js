// Beheer > Modules > Dashboard: kengetallen. Toont alle vaste KPI's uit `api/admin/kpi-catalog` met een vinkje en
// omhoog/omlaag-knoppen; elke wijziging wordt meteen bewaard in de instelling `dashboardKpis` (geen aparte opslagknop).
(function () {
  const form = document.getElementById('s-kpis');
  if (!form) return;
  const list = document.getElementById('s-kpis-list');
  const periodSelect = form.elements.period;
  const errorBox = form.querySelector('.err');
  let state = null;

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De tekst met entiteiten.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Doet een verzoek aan de beheer-API en geeft de JSON terug.
   * @param {string} url Het adres.
   * @param {object} [body] Bij een PUT de inhoud.
   * @returns {Promise<object>} Het antwoord.
   */
  async function request(url, body) {
    const res = await fetch(url, {
      cache: 'no-store',
      method: body ? 'PUT' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.message || AquatechCommon.statusMessage(res.status));
    return answer;
  }

  /**
   * Tekent de lijst en de periodekeuze.
   * @returns {void}
   */
  function render() {
    list.innerHTML = state.items.map((item, index) => `
      <li class="kpi-setting${item.available ? '' : ' off'}" data-key="${esc(item.key)}">
        <label class="chk"><input type="checkbox" data-toggle ${item.enabled ? 'checked' : ''} ${item.available ? '' : 'disabled'}>
          <span><strong>${esc(item.title)}</strong>${item.periodic ? ' <span class="badge">periode</span>' : ''}${item.available ? '' : ' <span class="badge">module uit</span>'}
          <span class="muted small kpi-setting-text">${esc(item.description)}</span></span></label>
        <span class="kpi-setting-move">
          <button type="button" class="btn small" data-move="-1" aria-label="${esc(item.title)} omhoog" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn small" data-move="1" aria-label="${esc(item.title)} omlaag" ${index === state.items.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </li>`).join('');
    periodSelect.innerHTML = Object.entries(state.periods).map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
    periodSelect.value = state.period;
    document.getElementById('s-kpis-period-field').hidden = !state.items.some((item) => item.periodic);
  }

  /**
   * Bewaart de huidige keuze en tekent het antwoord van de server.
   * @returns {Promise<void>}
   */
  async function save() {
    errorBox.textContent = '';
    try {
      await request('../api/admin/settings', { dashboardKpis: { items: state.items.map((item) => ({ key: item.key, enabled: item.enabled })), period: state.period } });
      await load();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Haalt de catalogus op en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      state = await request('../api/admin/kpi-catalog');
      render();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  list.addEventListener('change', (event) => {
    const row = event.target.closest('[data-key]');
    if (!row || !event.target.matches('[data-toggle]')) return;
    state.items.find((item) => item.key === row.dataset.key).enabled = event.target.checked;
    save();
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-move]');
    const row = button && button.closest('[data-key]');
    if (!row) return;
    const index = state.items.findIndex((item) => item.key === row.dataset.key);
    const target = index + Number(button.dataset.move);
    if (target < 0 || target >= state.items.length) return;
    [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
    render();
    save();
  });
  periodSelect.addEventListener('change', () => { state.period = periodSelect.value; save(); });
  form.addEventListener('submit', (event) => event.preventDefault());
  window.addEventListener('focus', load);
  load();
})();
