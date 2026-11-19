// Beheer: lange lijsten standaard tot de nieuwste paar regels inklappen, met een knop "Toon alle (n)" / "Toon minder".
(function () {
  const DEFAULT_LIMIT = 5;

  /**
   * Maakt een lijst van `<li>`-regels die alleen de eerste paar toont; de rest zit verborgen achter een knop.
   * @param {string[]} itemsHtml De regels als HTML (al veilig gemaakt), nieuwste eerst.
   * @param {number} [limit] Aantal regels dat zichtbaar blijft.
   * @returns {string} HTML met de lijst en, bij meer regels dan de limiet, de knop.
   */
  function render(itemsHtml, limit = DEFAULT_LIMIT) {
    const items = itemsHtml.map((html, index) => (index < limit ? html : html.replace('<li', '<li data-collapsed hidden')));
    const toggle = itemsHtml.length > limit
      ? `<p><button type="button" class="btn small" data-collapse-toggle data-total="${itemsHtml.length}" aria-expanded="false">Toon alle (${itemsHtml.length})</button></p>`
      : '';
    return `<ul class="timeline">${items.join('')}</ul>${toggle}`;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-collapse-toggle]');
    if (!button) return;
    const open = button.getAttribute('aria-expanded') !== 'true';
    const list = button.parentElement.previousElementSibling;
    list.querySelectorAll('[data-collapsed]').forEach((row) => { row.hidden = !open; });
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Toon minder' : `Toon alle (${button.dataset.total})`;
  });

  window.BeheerCollapse = { render };
})();
