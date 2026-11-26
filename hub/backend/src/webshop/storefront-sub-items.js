// Keuzelijsten van subartikelen op de productkaarten en de productpagina: bij een andere uitvoering wisselen
// artikelnummer, kenmerken, prijs, voorraad en links direct, zonder de pagina te
// verversen. Zonder dit script werkt de knop Kies (de pagina laadt opnieuw).

/**
 * Past één productkaart aan op de gekozen uitvoering.
 * @param {HTMLElement} row De kaart (data-sub-item-row).
 * @returns {void}
 */
function showChosenSubItem(row) {
  const select = row.querySelector('[data-sub-item-select]');
  const option = select.options[select.selectedIndex];
  row.querySelector('[data-sub-item-code]').textContent = option.dataset.code;
  row.querySelector('[data-sub-item-meta]').textContent = option.dataset.meta ? ` | ${option.dataset.meta}` : '';
  row.querySelector('[data-sub-item-price]').textContent = option.dataset.price;
  const inclusive = row.querySelector('[data-sub-item-incl]');
  if (inclusive) inclusive.textContent = `incl. btw ${option.dataset.priceIncl}`;
  const stock = row.querySelector('[data-sub-item-stock]');
  stock.className = `stock ${option.dataset.stock}`;
  stock.textContent = option.dataset.stock === 'in' ? 'Op voorraad' : 'Niet op voorraad';
  for (const link of row.querySelectorAll('[data-sub-item-link]')) link.setAttribute('href', option.dataset.href);
  const orderCode = row.querySelector('[data-order-code]');
  if (orderCode) {
    orderCode.value = option.dataset.code;
    const inStock = option.dataset.stock === 'in';
    for (const control of row.querySelectorAll('.card-order input[name="qty"], .card-order button:not(.qty-step)')) control.disabled = !inStock;
  }
}

document.documentElement.classList.add('js-on');
// Keuzelijsten op de productpagina (subartikel, verpakking): direct naar de gekozen uitvoering, zonder op Kies te drukken.
for (const select of document.querySelectorAll('select[data-autosubmit]')) select.addEventListener('change', () => select.form.submit());
for (const row of document.querySelectorAll('[data-sub-item-row]')) {
  row.querySelector('[data-sub-item-select]').addEventListener('change', () => showChosenSubItem(row));
}
