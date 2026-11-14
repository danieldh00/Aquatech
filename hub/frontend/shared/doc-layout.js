// Opmaak van de documenten die in de browser worden afgedrukt (offerte, werkbon, opleverrapport): de instelling
// Beheer > Documentopmaak (zie backend/src/verkoop/document-layout.js) wordt een wikkel met CSS-variabelen en
// klassen om het document, het logo en de voettekst. De server geeft de opmaak mee bij het bedrijfsprofiel
// (`documentLayout`); zonder opmaak blijft het document zoals het was.
(function () {
  'use strict';

  /** Lettertypen: sans = het lettertype van de app, serif = een lettertype met schreef. */
  const FONTS = { serif: 'Georgia, "Times New Roman", Times, serif' };

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Controleert een kleur.
   * @param {*} value De kleur.
   * @returns {string} De kleur als #rrggbb, of leeg als hij niet geldig is.
   */
  const colorOf = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '');

  /**
   * Zet een document in de opmaak: een wikkel met klassen (witte kop, logo rechts, zonder bedrijfsgegevens) en
   * CSS-variabelen (kop- en accentkleur, lettertype, logohoogte) die de afdruk-CSS gebruikt.
   * @param {string} html Het document.
   * @param {object|null} layout De opmaak (documentLayout), of null voor de standaard.
   * @returns {string} Het document in een wikkel, of ongewijzigd zonder opmaak.
   */
  function wrap(html, layout) {
    if (!layout) return html;
    const classes = ['doc-layout', layout.headerStyle === 'plain' ? 'doc-plain' : '', layout.logoPosition === 'right' ? 'doc-logo-right' : '',
      layout.showCompanyInHeader === false ? 'doc-no-company' : ''].filter(Boolean).join(' ');
    const variables = [
      colorOf(layout.headerColor) ? `--doc-primary:${colorOf(layout.headerColor)}` : '',
      colorOf(layout.accentColor) ? `--doc-accent:${colorOf(layout.accentColor)}` : '',
      FONTS[layout.font] ? `--doc-font:${FONTS[layout.font]}` : '',
      Number.isFinite(Number(layout.logoHeight)) ? `--doc-logo-height:${Math.round(Number(layout.logoHeight) * 1.05)}px` : '',
    ].filter(Boolean).join(';');
    return `<div class="${classes}"${variables ? ` style="${escapeHtml(variables)}"` : ''}>${html}</div>`;
  }

  /**
   * Het logo in de kop: het eigen logo, het standaardlogo (alleen op een gekleurde balk) of de bedrijfsnaam als tekst.
   * @param {object|null} layout De opmaak.
   * @param {{ defaultSrc: string, name: string }} options Het adres van het standaardlogo en de bedrijfsnaam.
   * @returns {string} HTML met een afbeelding of de naam.
   */
  function logoHtml(layout, { defaultSrc, name }) {
    const alt = escapeHtml(name);
    if (!layout) return `<img src="${escapeHtml(defaultSrc)}" alt="${alt}">`;
    if (layout.logoMode === 'custom' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(layout.logo || '')) return `<img src="${layout.logo}" alt="${alt}">`;
    if (layout.logoMode !== 'none' && layout.headerStyle !== 'plain') return `<img src="${escapeHtml(defaultSrc)}" alt="${alt}">`;
    return `<span class="p-name">${alt}</span>`;
  }

  /**
   * De voet van een document: de eigen voettekst en de bedrijfsregel (KvK, btw, IBAN), elk op een eigen regel.
   * @param {object|null} layout De opmaak.
   * @param {string} companyLine De bedrijfsregel.
   * @returns {string} HTML (tekst al veilig gemaakt), regels gescheiden met <br>.
   */
  function footerHtml(layout, companyLine) {
    const lines = [];
    if (layout && layout.footerText) lines.push(...String(layout.footerText).split(/\r?\n/).slice(0, 2));
    if (!layout || layout.footerCompanyInfo !== false) lines.push(companyLine);
    return lines.filter(Boolean).map(escapeHtml).join('<br>');
  }

  window.AquatechDocLayout = { wrap, logoHtml, footerHtml };
})();
