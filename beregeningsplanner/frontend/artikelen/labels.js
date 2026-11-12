// Etiketten afdrukken vanuit een artikel (module Artikelen): sjablonen ophalen, een voorbeeld van de streepjescode
// tonen en de etiketten-PDF op labelformaat openen. De PDF gaat via het afdrukvenster naar de labelprinter (geen ZPL).
// Praat met /api/stock/label-templates en /api/stock/labels (recht 'voorraad').
(function () {
  let templatesPromise = null;

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} text De tekst.
   * @returns {string} De tekst met &, <, > en " als entiteit.
   */
  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

  /**
   * Haalt de etiketsjablonen één keer per pagina op.
   * @returns {Promise<{ templates: object[], defaultKey: string }>} De sjablonen en het standaardsjabloon.
   */
  function templates() {
    if (!templatesPromise) {
      templatesPromise = fetch('../api/stock/label-templates', { cache: 'no-store' }).then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || AquatechCommon.statusMessage(response.status));
        return result;
      });
      templatesPromise.catch(() => { templatesPromise = null; });
    }
    return templatesPromise;
  }

  /**
   * Tekent een streepjescode als SVG (zwarte balken op wit, met witruimte eromheen).
   * @param {string} modules De modules (1 = zwart).
   * @returns {string} De SVG als tekst.
   */
  function barcodeSvg(modules) {
    const quiet = 10;
    const width = modules.length + quiet * 2;
    const rects = window.Barcode.bars(modules).map((bar) => `<rect x="${bar.start + quiet}" y="0" width="${bar.width}" height="40"/>`).join('');
    return `<svg viewBox="0 0 ${width} 40" preserveAspectRatio="none" role="img" aria-label="Streepjescode"><rect width="${width}" height="40" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }

  /**
   * Toont welke streepjescode het etiket krijgt met het gekozen sjabloon.
   * @param {HTMLElement} target Het vak voor het voorbeeld.
   * @param {object} item Het artikel (code, ean).
   * @param {object|undefined} template Het gekozen sjabloon.
   * @returns {void}
   */
  function renderPreview(target, item, template) {
    const code = window.Barcode.forItem(item, template ? template.barcode : 'auto');
    if (!code) {
      target.innerHTML = `<p class="muted small">${template && template.barcode === 'ean' ? 'Dit sjabloon drukt alleen een EAN af en dit artikel heeft geen geldige EAN.' : 'Deze artikelcode past niet in een streepjescode.'}</p>`;
      return;
    }
    const kind = { ean13: 'EAN-13', ean8: 'EAN-8', code128: 'Code 128 (artikelcode)' }[code.type];
    target.innerHTML = `<div class="label-code">${barcodeSvg(code.modules)}</div><p class="muted small">${escapeHtml(kind)}: ${escapeHtml(code.text)}</p>`;
  }

  /**
   * Vraagt de etiketten-PDF aan en opent hem in een nieuw tabblad (of downloadt hem als dat geblokkeerd is).
   * @param {{ id: string, qty: number }[]} items De artikelen met het aantal etiketten.
   * @param {string} templateKey Het sjabloon.
   * @returns {Promise<void>}
   */
  async function print(items, templateKey) {
    const opened = window.open('', '_blank');
    try {
      const response = await fetch('../api/stock/labels', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: templateKey, items }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message || AquatechCommon.statusMessage(response.status));
      }
      const url = URL.createObjectURL(await response.blob());
      if (opened) opened.location.href = url;
      else {
        const link = Object.assign(document.createElement('a'), { href: url, download: 'etiketten.pdf' });
        document.body.append(link);
        link.click();
        link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (opened) opened.close();
      throw error;
    }
  }

  /**
   * Koppelt het etiketformulier aan het geopende artikel.
   * @param {HTMLFormElement} form Het formulier (sjabloon, aantal).
   * @param {HTMLElement} preview Het vak voor het voorbeeld.
   * @param {HTMLElement} errorBox Het vak voor een foutmelding.
   * @param {() => object} currentItem Geeft het geopende artikel.
   * @returns {Promise<void>}
   */
  async function attach(form, preview, errorBox, currentItem) {
    errorBox.textContent = '';
    let config;
    try { config = await templates(); } catch (error) { errorBox.textContent = error.message; return; }
    const chosen = form.template.value || config.defaultKey;
    form.template.innerHTML = config.templates.map((template) => `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)} (${template.widthMm} × ${template.heightMm} mm)</option>`).join('');
    form.template.value = config.templates.some((template) => template.key === chosen) ? chosen : config.defaultKey;
    /**
     * Het gekozen sjabloon.
     * @returns {object|undefined} Het sjabloon.
     */
    const selected = () => config.templates.find((template) => template.key === form.template.value);
    renderPreview(preview, currentItem(), selected());
    /**
     * Werkt het voorbeeld bij na een andere sjabloonkeuze.
     * @returns {void}
     */
    form.template.onchange = () => renderPreview(preview, currentItem(), selected());
    /**
     * Maakt de etiketten voor het geopende artikel.
     * @param {SubmitEvent} event Het verzendmoment.
     * @returns {Promise<void>}
     */
    form.onsubmit = async (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      const qty = Math.floor(Number(form.qty.value));
      if (!(qty >= 1 && qty <= 500)) { errorBox.textContent = 'Kies een aantal van 1 tot 500.'; form.qty.focus(); return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try { await print([{ id: currentItem().id, qty }], form.template.value); } catch (error) { errorBox.textContent = error.message; } finally { button.disabled = false; }
    };
  }

  window.ItemLabels = { templates, attach, print, renderPreview };
}());
