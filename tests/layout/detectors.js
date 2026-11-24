/**
 * Uitlijningsdetectoren die in de pagina draaien (via page.evaluate): horizontale overflow, elementen buiten hun
 * container, overlappende elementen, tabelcellen die niet met hun rij uitlijnen, afgekapte tekst en kaarten in een rij
 * met ongelijke hoogte. Geeft een lijst bevindingen terug; elke bevinding heeft een soort, een CSS-pad en een uitleg.
 */

/**
 * Zoekt alle uitlijnproblemen op de huidige pagina. Wordt als functie in de browser uitgevoerd.
 * @param {{ tolerance: number }} options tolerance: pixels speling voor afrondingen.
 * @returns {Array<{ kind: string, selector: string, detail: string }>} De bevindingen.
 */
function detectLayoutProblems({ tolerance }) {
  const findings = [];
  const seen = new Set();
  const viewportWidth = document.documentElement.clientWidth;

  /**
   * Korte beschrijving van een element, voldoende om het terug te vinden.
   * @param {Element} element Het element.
   * @returns {string} Pad zoals main > table#invoices > tr > td.actions.
   */
  const pathOf = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      else if (node.classList.length) part += `.${[...node.classList].slice(0, 2).join('.')}`;
      parts.unshift(part);
      if (node.id) break;
    }
    return parts.join(' > ');
  };

  /**
   * Voegt een bevinding toe (hetzelfde element met dezelfde soort maar één keer).
   * @param {string} kind Soort bevinding.
   * @param {Element} element Het element.
   * @param {string} detail Uitleg met getallen.
   * @returns {void}
   */
  const report = (kind, element, detail) => {
    const key = `${kind}|${pathOf(element)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    findings.push({ kind, selector: pathOf(element), detail: text ? `${detail} ("${text}")` : detail });
  };

  /**
   * Is het element zichtbaar en neemt het ruimte in?
   * @param {Element} element Het element.
   * @returns {boolean} Waar bij zichtbaar.
   */
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"], template, script, style, svg *, .sr-only, .visually-hidden')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /**
   * Zit het element in een eigen scrollgebied of is het uit de stroom gehaald (dan hoort het buiten zijn ouder te kunnen vallen)?
   * @param {Element} element Het element.
   * @returns {boolean} Waar bij een uitzondering.
   */
  const detached = (element) => {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      if (node !== element && /(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
    }
    return false;
  };

  // 1. Horizontale overflow van de hele pagina.
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  if (scrollWidth > viewportWidth + tolerance) {
    let culprit = document.body;
    let widest = 0;
    for (const element of document.body.querySelectorAll('*')) {
      if (!visible(element) || detached(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.right > widest) { widest = rect.right; culprit = element; }
    }
    report('horizontale-overflow', culprit, `pagina ${scrollWidth}px breed in een venster van ${viewportWidth}px; breedste element eindigt op ${Math.round(widest)}px`);
  }

  const all = [...document.body.querySelectorAll('*')].filter(visible);

  // 2. Element buiten zijn container (alleen containers met een eigen kader of achtergrond).
  for (const element of all) {
    const parent = element.parentElement;
    if (!parent || parent === document.body || detached(element)) continue;
    const style = getComputedStyle(element);
    if (style.position === 'absolute' || style.display === 'contents' || style.display === 'inline') continue;
    const parentStyle = getComputedStyle(parent);
    const boxed = parentStyle.borderTopWidth !== '0px' || parentStyle.borderLeftWidth !== '0px' || parentStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' || /table/.test(parentStyle.display);
    if (!boxed || parentStyle.display === 'contents' || parentStyle.display === 'inline') continue;
    const rect = element.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    const over = Math.max(rect.right - box.right, box.left - rect.left);
    if (over > tolerance + 1 && rect.width <= box.width + tolerance * 4) report('buiten-container', element, `steekt ${Math.round(over)}px buiten ${pathOf(parent)}`);
    else if (over > tolerance + 1 && rect.width > box.width + tolerance * 4) report('breder-dan-container', element, `${Math.round(rect.width)}px in een container van ${Math.round(box.width)}px (${pathOf(parent)})`);
  }

  // 3. Overlappende broers en zussen (alleen elementen in de stroom).
  const intersect = (left, right) => {
    const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
    const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    return { width, height };
  };
  const parents = new Set(all.map((element) => element.parentElement).filter(Boolean));
  for (const parent of parents) {
    const siblings = [...parent.children].filter((child) => visible(child) && !detached(child) && !['absolute', 'fixed'].includes(getComputedStyle(child).position) && !['contents', 'inline'].includes(getComputedStyle(child).display));
    if (siblings.length < 2 || siblings.length > 60) continue;
    for (let first = 0; first < siblings.length; first += 1) {
      for (let second = first + 1; second < siblings.length; second += 1) {
        const left = siblings[first];
        const right = siblings[second];
        const { width, height } = intersect(left.getBoundingClientRect(), right.getBoundingClientRect());
        if (width > tolerance + 2 && height > tolerance + 2) report('overlap', left, `overlapt ${pathOf(right)} (${Math.round(width)}×${Math.round(height)}px)`);
      }
    }
  }

  // 4. Tabellen: een cel moet een tabelcel blijven, met zijn rij meelopen, en de inhoud van de cellen in een rij moet
  // bij dezelfde verticale uitlijning horen (geen cel die bovenaan staat terwijl de rest in het midden staat) en
  // niet scheef in de cel zitten (bijvoorbeeld door een eigen marge).
  for (const row of document.querySelectorAll('tr')) {
    if (!visible(row)) continue;
    const rowRect = row.getBoundingClientRect();
    const middleCells = [];
    const aligns = new Set();
    for (const cell of row.children) {
      if (!/^T[DH]$/.test(cell.tagName) || !visible(cell)) continue;
      const style = getComputedStyle(cell);
      if (style.display !== 'table-cell') { report('cel-geen-tabelcel', cell, `display: ${style.display} haalt de cel uit de tabel`); continue; }
      const rect = cell.getBoundingClientRect();
      if (Math.abs(rect.top - rowRect.top) > tolerance || Math.abs(rect.bottom - rowRect.bottom) > tolerance) report('cel-valt-uit-rij', cell, `cel ${Math.round(rect.top)}–${Math.round(rect.bottom)}, rij ${Math.round(rowRect.top)}–${Math.round(rowRect.bottom)}`);
      if (!cell.textContent.trim() && !cell.querySelector('button, a, input, select, img')) continue;
      const range = document.createRange();
      range.selectNodeContents(cell);
      const content = range.getBoundingClientRect();
      if (content.height === 0) continue;
      aligns.add(style.verticalAlign);
      const paddingTop = parseFloat(style.paddingTop);
      const paddingBottom = parseFloat(style.paddingBottom);
      const innerTop = rect.top + paddingTop + parseFloat(style.borderTopWidth);
      const innerBottom = rect.bottom - paddingBottom - parseFloat(style.borderBottomWidth);
      if (style.verticalAlign === 'middle') {
        middleCells.push(cell);
        const offset = (content.top + content.bottom) / 2 - (innerTop + innerBottom) / 2;
        if (Math.abs(offset) > 3 && content.height < innerBottom - innerTop) report('cel-inhoud-scheef', cell, `inhoud staat ${Math.round(offset)}px uit het midden van de cel`);
      }
    }
    if (aligns.size > 1 && [...row.children].length > 1) report('cel-gemengde-uitlijning', row, `cellen in één rij met verschillende verticale uitlijning (${[...aligns].join(', ')})`);
  }

  // 5. Afgekapte tekst zonder weglatingsteken.
  for (const element of all) {
    const style = getComputedStyle(element);
    if (!/(hidden|clip)/.test(style.overflowX) || style.textOverflow === 'ellipsis' || element.tagName === 'IMG') continue;
    if (element.scrollWidth > element.clientWidth + tolerance + 1 && element.clientWidth > 0 && element.textContent.trim()) report('tekst-afgekapt', element, `inhoud ${element.scrollWidth}px in ${element.clientWidth}px`);
  }

  // 6. Kaarten in één rij met ongelijke hoogte.
  for (const parent of parents) {
    const parentStyle = getComputedStyle(parent);
    if (!/grid|flex/.test(parentStyle.display) || !['normal', 'stretch'].includes(parentStyle.alignItems)) continue;
    const cards = [...parent.children].filter((child) => visible(child) && /(^|[ -])(card|tile|kpi)/.test(child.className.toString()));
    if (cards.length < 2) continue;
    const rows = [];
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const row = rows.find((entry) => Math.abs(entry.top - rect.top) < 3);
      if (row) row.heights.push(rect.height); else rows.push({ top: rect.top, heights: [rect.height] });
    }
    for (const { heights } of rows) {
      if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > tolerance + 1) report('kaarten-ongelijke-hoogte', parent, `kaarten in één rij zijn ${Math.round(Math.min(...heights))}–${Math.round(Math.max(...heights))}px hoog`);
    }
  }

  /**
   * Strengere controles op stijl en inhoud: lettertype, te kleine tekst, foutmeldingen in de tekst, te kleine tikdoelen
   * (alleen op smalle schermen), kapotte afbeeldingen en knoppen in één rij met verschillende hoogte. Draait in de browser.
   * @param {{ narrow: boolean }} options narrow: waar bij een smal scherm (dan gelden tikdoelen).
   * @returns {Array<{ kind: string, selector: string, detail: string }>} De bevindingen.
   */
  function detectStyleProblems({ narrow }) {
    const out = [];
    const seen = new Set();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('[hidden]');
    };
    const pathOf = (element) => {
      let part = element.tagName.toLowerCase();
      if (element.id) part += `#${element.id}`;
      else if (element.classList.length) part += `.${[...element.classList].slice(0, 2).join('.')}`;
      return part;
    };
    const textOf = (element) => (element.textContent || element.value || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const add = (kind, element, detail) => {
      const key = kind + pathOf(element);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, selector: pathOf(element), detail: `${detail} ("${textOf(element)}")` });
    };
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (ownText) {
        if (!/montserrat|monospace|mono|courier|consolas/i.test(style.fontFamily) && !element.closest('svg, canvas, pre, code')) add('stijl-lettertype', element, style.fontFamily.slice(0, 40));
        if (parseFloat(style.fontSize) < 11) add('stijl-lettertje-klein', element, style.fontSize);
        if (element.children.length === 0 && /not defined|undefined|\bNaN\b|\[object|null\b|Cannot read|is not a function|Unexpected token/.test(element.textContent)) add('inhoud-foutmelding', element, element.textContent.trim().slice(0, 80));
      }
      if (narrow && element.matches('button, a.btn, .btn, input[type=submit]')) {
        const rect = element.getBoundingClientRect();
        if (rect.height < 36) add('tikdoel-klein', element, `${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
      if (element.matches('img') && element.loading !== 'lazy' && (!element.complete || element.naturalWidth === 0)) add('afbeelding-kapot', element, element.src.slice(-60));
    }
    for (const container of document.querySelectorAll('.actions, .form-actions, .row.actions, .toolbar, .btn-row, .buttons, header, .head')) {
      const controls = [...container.querySelectorAll(':scope > button, :scope > a.btn, :scope > .btn, :scope > select, :scope > input')].filter(visible);
      if (controls.length < 2) continue;
      const lines = new Map();
      for (const control of controls) {
        const rect = control.getBoundingClientRect();
        const line = Math.round(rect.top / 10);
        lines.set(line, [...(lines.get(line) || []), Math.round(rect.height)]);
      }
      for (const heights of lines.values()) {
        if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > 3) { add('stijl-knophoogte-verschil', container, heights.join('/')); break; }
      }
    }
    return out;
  }

  return findings.concat(detectStyleProblems({ narrow: viewportWidth < 600 }));
}

module.exports = { detectLayoutProblems };
