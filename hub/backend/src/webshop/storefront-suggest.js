// Zoeksuggesties in de webshop: onder het zoekveld in de kop verschijnen na twee tekens een paar passende producten (naam en
// artikelnummer). Pijltjestoetsen kiezen, Enter opent, Escape sluit; zonder dit script werkt zoeken gewoon via het formulier.
(function () {
  const input = document.querySelector('input[data-suggest]');
  if (!input) return;
  const endpoint = input.getAttribute('data-suggest');
  /** Minimaal aantal tekens voordat er gezocht wordt. */
  const MIN_LENGTH = 2;
  /** Wachttijd na de laatste toetsaanslag (ms), zodat niet elke letter een verzoek is. */
  const DELAY = 220;
  const list = document.createElement('ul');
  list.className = 'search-suggest';
  list.id = 'search-suggest';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.form.appendChild(list);
  let timer = null;
  let sequence = 0;
  let active = -1;

  /**
   * Sluit de lijst.
   * @returns {void}
   */
  function close() {
    list.hidden = true;
    list.textContent = '';
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  /**
   * Markeert één suggestie als gekozen (met de pijltjestoetsen).
   * @param {number} index Positie in de lijst, of -1 voor geen.
   * @returns {void}
   */
  function highlight(index) {
    const items = list.children;
    active = index;
    for (let position = 0; position < items.length; position += 1) items[position].setAttribute('aria-selected', String(position === index));
    if (index >= 0) input.setAttribute('aria-activedescendant', items[index].id);
    else input.removeAttribute('aria-activedescendant');
  }

  /**
   * Tekent de suggesties (tekst via textContent, nooit als HTML).
   * @param {{ name: string, code: string, category: string, url: string }[]} items De producten.
   * @returns {void}
   */
  function render(items) {
    list.textContent = '';
    active = -1;
    if (!items.length) { close(); return; }
    items.forEach((item, position) => {
      const entry = document.createElement('li');
      entry.id = `search-suggest-${position}`;
      entry.setAttribute('role', 'option');
      entry.setAttribute('aria-selected', 'false');
      const link = document.createElement('a');
      link.href = input.getAttribute('data-suggest').replace(/zoeken\/suggesties\/$/, '') + item.url;
      const name = document.createElement('span');
      name.className = 'search-suggest-name';
      name.textContent = item.name;
      const meta = document.createElement('small');
      meta.textContent = [item.code, item.category].filter(Boolean).join(' · ');
      link.append(name, meta);
      entry.appendChild(link);
      list.appendChild(entry);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  /**
   * Vraagt de suggesties voor de ingetypte tekst; een oud antwoord dat te laat komt wordt genegeerd.
   * @returns {Promise<void>}
   */
  async function ask() {
    const text = input.value.trim();
    if (text.length < MIN_LENGTH) { close(); return; }
    sequence += 1;
    const mine = sequence;
    try {
      const response = await fetch(`${endpoint}?q=${encodeURIComponent(text)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!response.ok || mine !== sequence) return;
      const body = await response.json();
      if (mine === sequence) render(Array.isArray(body.items) ? body.items : []);
    } catch (error) {
      close();
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(ask, DELAY);
  });
  input.addEventListener('keydown', (event) => {
    const count = list.children.length;
    if (event.key === 'Escape') { close(); return; }
    if (list.hidden || !count) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight((active + 1) % count); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(active <= 0 ? count - 1 : active - 1); }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); list.children[active].querySelector('a').click(); }
  });
  document.addEventListener('click', (event) => { if (!input.form.contains(event.target)) close(); });
  input.form.addEventListener('focusout', () => setTimeout(() => { if (!input.form.contains(document.activeElement)) close(); }, 100));
})();
