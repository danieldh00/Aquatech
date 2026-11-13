// Keuzelijsten van varianten op de productkaarten en de productpagina: bij een andere uitvoering wisselen
// artikelnummer, kenmerken, prijs, voorraad en links direct, zonder de pagina te
// verversen. Zonder dit script werkt de knop Kies (de pagina laadt opnieuw).

/**
 * Past één productkaart aan op de gekozen uitvoering.
 * @param {HTMLElement} row De kaart (data-variant-row).
 * @returns {void}
 */
function showChosenVariant(row) {
  const select = row.querySelector('[data-variant-select]');
  const option = select.options[select.selectedIndex];
  row.querySelector('[data-variant-code]').textContent = option.dataset.code;
  row.querySelector('[data-variant-meta]').textContent = option.dataset.meta ? ` | ${option.dataset.meta}` : '';
  row.querySelector('[data-variant-price]').textContent = option.dataset.price;
  const inclusive = row.querySelector('[data-variant-incl]');
  if (inclusive) inclusive.textContent = `incl. btw ${option.dataset.priceIncl}`;
  const stock = row.querySelector('[data-variant-stock]');
  stock.className = `stock ${option.dataset.stock}`;
  stock.textContent = option.dataset.stock === 'in' ? 'Op voorraad' : 'Niet op voorraad';
  for (const link of row.querySelectorAll('[data-variant-link]')) link.setAttribute('href', option.dataset.href);
  const orderCode = row.querySelector('[data-order-code]');
  if (orderCode) {
    orderCode.value = option.dataset.code;
    const inStock = option.dataset.stock === 'in';
    for (const control of row.querySelectorAll('.card-order input[name="qty"], .card-order button')) control.disabled = !inStock;
  }
}

document.documentElement.classList.add('js-on');
// Keuzelijsten op de productpagina (variant, verpakking): direct naar de gekozen uitvoering, zonder op Kies te drukken.
for (const select of document.querySelectorAll('select[data-autosubmit]')) select.addEventListener('change', () => select.form.submit());
for (const row of document.querySelectorAll('[data-variant-row]')) {
  row.querySelector('[data-variant-select]').addEventListener('change', () => showChosenVariant(row));
}
