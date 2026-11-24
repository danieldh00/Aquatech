// Offertes: tekstsjablonen en het bedrijfsprofiel van de offertes.
// Het bestand zet een fabriek op window.Offertes; offertes.js geeft de gedeelde
// hulpfuncties en de stand (context) mee en gebruikt wat de fabriek teruggeeft.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Bouwt de functies voor tekstsjablonen en het bedrijfsprofiel van de offertes.
   * @param {object} context gedeelde hulpfuncties en stand uit offertes.js: QuoteCore, esc, state, toast, api, locked, renderLines, changed, save, $
   * @returns {object} de functies die offertes.js zelf nodig heeft: renderTemplates, applyTemplate, saveTemplate, deleteTemplate, openProfile, saveProfile
   */
  window.Offertes.createTemplates = function (context) {
    const { QuoteCore, esc, state, toast, api, locked, renderLines, changed, save, $ } = context;

    // ---------- Sjablonen ----------
    /**
     * Haalt de offertesjablonen één keer op (alleen voor medewerkers) en tekent daarna de sjabloonkaart opnieuw.
     * @returns {Promise<void>}
     */
    async function loadTemplates() {
      if (state.klant || state.templatesRequested) return;
      state.templatesRequested = true;
      // Offertesjablonen uit (Beheer > Modules): de kaart verdwijnt en er wordt niets opgehaald.
      state.templatesOff = !(await window.AquatechModuleTools.featureOn('offertesjablonen'));
      if (state.templatesOff) { if (state.quote) renderTemplates(); return; }
      try {
        state.templates = (await api('quote-templates')).templates || [];
      } catch (error) {
        state.templates = [];
      }
      if (state.quote) renderTemplates();
    }

    /** Toont de sjabloonkaart: keuzelijst en Toepassen voor medewerkers, bewaren en verwijderen voor de beheerder (niet bij een vergrendelde offerte). */
    function renderTemplates() {
      loadTemplates();
      const templates = state.templates || [];
      const open = Boolean(state.quote) && !locked() && !state.klant;
      $('#e-tpl').hidden = state.templatesOff || !open || (!templates.length && !state.admin);
      if ($('#e-tpl').hidden) return;
      const select = $('#e-tpl-select');
      const previous = select.value;
      select.innerHTML = templates.length
        ? templates.map((template) => `<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('')
        : '<option value="">Nog geen sjablonen</option>';
      if (templates.some((template) => template.id === previous)) select.value = previous;
      $('#e-tpl-apply').disabled = !templates.length;
      $('#e-tpl-delete').hidden = !state.admin || !templates.length;
      $('#e-tpl-save').hidden = !state.admin;
      $('#e-tpl-hint').hidden = !templates.length;
    }

    /** Zet het gekozen sjabloon op de offerte: teksten vervangen (met vraag als er andere tekst staat), regels onderaan toevoegen. */
    function applyTemplate() {
      const quote = state.quote;
      const template = (state.templates || []).find((entry) => entry.id === $('#e-tpl-select').value);
      if (!quote || locked() || !template) return;
      const data = quote.data;
      const replaced = [['intro', template.intro], ['terms', template.terms]].filter(([field, text]) => text && text.trim() && text !== data[field]);
      const overwrites = replaced.filter(([field]) => String(data[field] || '').trim());
      if (overwrites.length && !confirm(`De bestaande ${overwrites.map(([field]) => (field === 'intro' ? 'inleiding' : 'voorwaarden')).join(' en ')} van deze offerte wordt vervangen door die van het sjabloon. Doorgaan?`)) return;
      for (const [field, text] of replaced) data[field] = text;
      const stamp = Date.now().toString(36);
      const added = template.lines.map((line, index) => QuoteCore.sanitizeLine({ ...line, id: `t${stamp}${index}${Math.random().toString(36).slice(2, 5)}` }));
      data.lines = [...data.lines, ...added];
      document.querySelectorAll('#edit-view [data-f="intro"], #edit-view [data-f="terms"]').forEach((field) => { field.value = data[field.dataset.f] || ''; });
      renderLines();
      changed();
      toast(`Sjabloon "${template.name}" toegepast${added.length ? `: ${added.length} regel${added.length === 1 ? '' : 's'} toegevoegd` : ''}`);
    }

    /**
     * Bewaart de huidige offerte (inleiding, voorwaarden en regels) als sjabloon; dezelfde naam vervangt het bestaande.
     * @param {SubmitEvent} event het verzenden van het formulier
     * @returns {Promise<void>}
     */
    async function saveTemplate(event) {
      event.preventDefault();
      const quote = state.quote;
      const name = $('#e-tpl-name').value.trim();
      if (!quote || !name) return;
      const { intro, terms, lines } = quote.data;
      try {
        const result = await api('quote-templates', { method: 'PUT', body: { template: { name, intro, terms, lines } } });
        state.templates = result.templates;
        renderTemplates();
        $('#e-tpl-select').value = result.template.id;
        $('#e-tpl-name').value = '';
        toast(`Sjabloon "${result.template.name}" bewaard`);
      } catch (error) {
        toast(`Bewaren mislukt: ${error.message}`, true);
      }
    }

    /**
     * Verwijdert het gekozen sjabloon (bestaande offertes houden hun teksten en regels).
     * @returns {Promise<void>}
     */
    async function deleteTemplate() {
      const template = (state.templates || []).find((entry) => entry.id === $('#e-tpl-select').value);
      if (!template || !confirm(`Sjabloon "${template.name}" verwijderen? Offertes die het al gebruiken veranderen niet.`)) return;
      try {
        state.templates = (await api(`quote-templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' })).templates;
        renderTemplates();
        toast('Sjabloon verwijderd');
      } catch (error) {
        toast(`Verwijderen mislukt: ${error.message}`, true);
      }
    }

    // ---------- Bedrijfsgegevens ----------
    /** Opent het venster met de bedrijfsgegevens. */
    function openProfile() {
      const form = $('#pf');
      for (const field of form.elements) if (field.name) field.value = state.profile[field.name] ?? '';
      $('#profile').hidden = false;
    }

    /**
     * Slaat de bedrijfsgegevens op.
     * @param {SubmitEvent} event het verzenden van het formulier
     * @returns {Promise<void>}
     */
    async function saveProfile(event) {
      event.preventDefault();
      const form = $('#pf');
      const profile = {};
      for (const field of form.elements) {
        if (!field.name) continue;
        profile[field.name] = field.type === 'number' || field.name === 'vatRate' ? Number(field.value) : field.value;
      }
      try {
        state.profile = (await api('quote-profile', { method: 'PUT', body: { profile } })).profile;
        $('#profile').hidden = true;
        toast('Bedrijfsgegevens opgeslagen');
      } catch (error) {
        toast(`Opslaan mislukt: ${error.message}`, true);
      }
    }

    return { renderTemplates, applyTemplate, saveTemplate, deleteTemplate, openProfile, saveProfile };
  };
})();
