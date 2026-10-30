// Keuzelijsten van varianten in de shoplijst: bij een andere uitvoering wisselen
// artikelnummer, kenmerken, prijs, voorraad en links direct, zonder de pagina te
// verversen. Zonder dit script werkt de knop Kies (de pagina laadt opnieuw).

/**
 * Past één variantregel aan op de gekozen uitvoering.
 * @param {HTMLElement} row De regel (data-variant-row).
 * @returns {void}
 */
function showChosenVariant(row) {
  const select = row.querySelector('[data-variant-select]');
  const option = select.options[select.selectedIndex];
  row.querySelector('[data-variant-code]').textContent = option.dataset.code;
  row.querySelector('[data-variant-meta]').textContent = option.dataset.meta ? ` | ${option.dataset.meta}` : '';
  row.querySelector('[data-variant-price]').textContent = option.dataset.price;
  const stock = row.querySelector('[data-variant-stock]');
  stock.className = `stock ${option.dataset.stock}`;
  stock.textContent = option.dataset.stock === 'in' ? 'Op voorraad' : 'Niet op voorraad';
  for (const link of row.querySelectorAll('[data-variant-link]')) link.setAttribute('href', option.dataset.href);
}

document.documentElement.classList.add('js-on');
for (const row of document.querySelectorAll('[data-variant-row]')) {
  row.querySelector('[data-variant-select]').addEventListener('change', () => showChosenVariant(row));
}
