// Snelbestellijst van de groothandel (/winkel/groothandel/): filtert de lijst op
// zoekterm en categorie, rondt een ingevuld aantal af op de verpakkingseenheid en
// minimale afname, en toont hoeveel regels en stuks er klaarstaan. Zonder dit
// script blijft de hele lijst zichtbaar en rondt de server de aantallen af.

/**
 * Rondt een aantal naar boven af op wat bestelbaar is (minimaal de minimale afname, anders een veelvoud van de verpakkingseenheid).
 * @param {number} qty Het ingevulde aantal.
 * @param {number} pack De verpakkingseenheid.
 * @param {number} minimum De minimale afname.
 * @returns {number} Het bestelbare aantal.
 */
function roundUpQuantity(qty, pack, minimum) {
  const wanted = Math.max(qty, minimum);
  return Math.ceil(wanted / pack) * pack;
}

/**
 * Toont alleen de regels die bij de zoekterm en de gekozen categorie passen.
 * @param {HTMLFormElement} form De snelbestellijst.
 * @returns {void}
 */
function filterRows(form) {
  const words = form.querySelector('[data-wholesale-search]').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const category = form.querySelector('[data-wholesale-category]').value;
  let shown = 0;
  for (const row of form.querySelectorAll('[data-wholesale-row]')) {
    const visible = (!category || row.dataset.category === category) && words.every((word) => row.dataset.search.includes(word));
    row.hidden = !visible;
    if (visible) shown += 1;
  }
  form.querySelector('[data-wholesale-empty]').hidden = shown > 0;
}

/**
 * Werkt de samenvatting onder de lijst bij: het aantal regels en het totaal aantal stuks.
 * @param {HTMLFormElement} form De snelbestellijst.
 * @returns {void}
 */
function updateSummary(form) {
  let lines = 0;
  let pieces = 0;
  for (const input of form.querySelectorAll('[data-wholesale-qty]')) {
    const qty = Math.floor(Number(input.value));
    if (qty >= 1) { lines += 1; pieces += qty; }
  }
  form.querySelector('[data-wholesale-summary]').textContent = lines ? `${lines} ${lines === 1 ? 'artikel' : 'artikelen'}, ${pieces} stuks klaar om te bestellen` : 'Vul bij de artikelen een aantal in.';
}

for (const form of document.querySelectorAll('[data-wholesale-form]')) {
  form.querySelector('[data-wholesale-search]').addEventListener('input', () => filterRows(form));
  form.querySelector('[data-wholesale-category]').addEventListener('change', () => filterRows(form));
  for (const input of form.querySelectorAll('[data-wholesale-qty]')) {
    input.addEventListener('change', () => {
      const qty = Math.floor(Number(input.value));
      if (qty >= 1) input.value = String(roundUpQuantity(qty, Number(input.dataset.pack) || 1, Number(input.dataset.minimum) || 1));
      else input.value = '';
      updateSummary(form);
    });
    input.addEventListener('input', () => updateSummary(form));
  }
  // Een ingetypte opdracht met Enter verstuurt niet per ongeluk de hele lijst vanuit het zoekveld.
  // Lege aantalvelden niet meesturen: bij een grote catalogus blijft het formulier zo binnen de parameterlimiet van de server.
  form.addEventListener('submit', () => {
    for (const input of form.querySelectorAll('[data-wholesale-qty]')) if (!(Math.floor(Number(input.value)) >= 1)) input.disabled = true;
  });
  // Terug naar de pagina (bfcache): de aantalvelden die bij het verzenden uitgeschakeld waren, weer bruikbaar maken.
  window.addEventListener('pageshow', () => {
    for (const input of form.querySelectorAll('[data-wholesale-qty]')) input.disabled = false;
  });
  form.querySelector('[data-wholesale-search]').addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
  updateSummary(form);
}
