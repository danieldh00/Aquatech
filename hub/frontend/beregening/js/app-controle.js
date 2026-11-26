/* Beregeningsplanner: controle, indienen en leren van een plan (methoden die op App worden gezet). */
(function () {
  'use strict';

  const App = window.App;
  const { $, escapeHtml, ANON, PARAMS, REVIEW_LABEL, STEPS } = App.helpers;

  Object.assign(App, {
    // ---------- Controle en indienen ----------
    // Een plan van een klant is nooit meteen definitief: een installateur
    // (recht plannen.goedkeuren) keurt het goed. Zonder account dient de
    // bezoeker de tekening in met contactgegevens (api/public/drawing).
    /**
     * Haalt de controlestatus op (of bij tekenen zonder account de instellingen voor indienen) en toont de balk.
     * @returns {Promise<void>} klaar na tonen
     */
    async _initReview() {
      this._bindReview();
      if (ANON) {
        this.org = PARAMS.get('org') || '';
        try {
          const res = await fetch(`api/public/drawing?org=${encodeURIComponent(this.org)}`, { cache: 'no-store' });
          this.drawing = res.ok ? await res.json() : { enabled: false };
        } catch (error) {
          this.drawing = { enabled: false };
        }
        document.body.classList.add('anon');
      } else if (this.state.serverId && !this.review) {
        // Plan uit de browser dat al op de server staat: status ophalen.
        try {
          const res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}`, { cache: 'no-store' });
          if (res.ok) this.review = (await res.json()).review || null;
        } catch (error) { /* offline */ }
      }
      this._renderReview();
    },
    /**
     * Link naar de inlogpagina, met de organisatiecode als die bekend is.
     * @returns {string} het adres
     */
    _loginHref() {
      return `../login${this.org ? `?org=${encodeURIComponent(this.org)}` : ''}`;
    },
    /**
     * Link om het ontwerp te bewaren met een account: registreren in de webshop met doorsturen naar de planner, die het lokale ontwerp overneemt.
     * @returns {string} het adres
     */
    _saveWithAccountHref() {
      return '../../registreren/?volgende=planner';
    },
    /** Toont de balk met de controlestatus van het plan en de knoppen die bij de gebruiker passen. */
    _renderReview() {
      const bar = $('#review-bar');
      if (!bar) return;
      if (ANON) {
        const drawing = this.drawing;
        if (!drawing) { bar.hidden = true; return; }
        bar.hidden = false;
        bar.className = 'review-bar anon';
        /**
         * Maakt een klein lijnicoon voor een knop.
         * @param {string} paths De svg-paden van het icoon.
         * @returns {string} De svg als HTML.
         */
        const icon = (paths) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
        const saveIcon = icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>');
        const loginIcon = icon('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>');
        const sendIcon = icon('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>');
        const save = `<a class="btn line" href="${escapeHtml(this._saveWithAccountHref())}" title="Ontwerp bewaren met een account">${saveIcon}Bewaren</a>`;
        const login = `<a class="btn line" href="${escapeHtml(this._loginHref())}">${loginIcon}Inloggen</a>`;
        bar.innerHTML = drawing.enabled
          ? `<div class="rv-text"><b>Tekenen zonder account</b><span>Teken je tuin en dien hem in: een installateur${drawing.company ? ` van ${escapeHtml(drawing.company)}` : ''} controleert hem. Tot dan blijft de tekening alleen in deze browser. <a href="#" class="rv-tour" id="rv-tour">Hoe werkt het?</a></span></div>
             <div class="rv-act"><button id="rv-submit" class="btn primary">${sendIcon}Tekening indienen</button><div class="rv-sub">${save}${login}</div></div>`
          : `<div class="rv-text"><b>Tekenen zonder account</b><span>Bij deze organisatie kun je geen tekening indienen zonder account. Maak een account om je plan te bewaren.</span></div>
             <div class="rv-act"><a class="btn primary" href="${escapeHtml(this._saveWithAccountHref())}">${saveIcon}Bewaren met account</a><div class="rv-sub">${login}</div></div>`;
        const tour = $('#rv-tour', bar);
        if (tour) tour.addEventListener('click', (event) => { event.preventDefault(); if (window.PlannerTour) window.PlannerTour.open(); });
        if (window.PlannerTour && !window.PlannerTour.seen() && !this._tourShown) { this._tourShown = true; window.PlannerTour.open(); }
        return;
      }
      const review = this.review;
      if (!this.state.serverId || !review || !this.rights) { bar.hidden = true; return; }
      const approver = this._can('plannen.goedkeuren');
      /**
       * Datum in Nederlandse notatie (dag en maand), of leeg.
       * @param {string} iso tijdstip (ISO)
       * @returns {string} de tekst
       */
      const when = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '');
      let info = '';
      let actions = '';
      if (review.status === 'goedgekeurd') {
        info = `Goedgekeurd${review.reviewedBy ? ` door ${escapeHtml(review.reviewedBy)}` : ''}${review.reviewedAt ? ` op ${when(review.reviewedAt)}` : ''}.${approver ? '' : ' Pas je iets aan, dan gaat het plan opnieuw ter controle.'}`;
        if (approver) actions = '<button id="rv-reopen" class="btn ghost">Goedkeuring intrekken</button>';
      } else if (review.status === 'ter_controle') {
        info = approver
          ? `${review.via === 'openbaar' ? 'Ingediend zonder account' : 'Aangeboden ter controle'}${review.requestedAt ? ` op ${when(review.requestedAt)}` : ''}.${review.question ? ` Vraag: “${escapeHtml(review.question)}”` : ''}`
          : 'Een installateur controleert dit plan. Je hoort het als het is goedgekeurd.';
        if (approver) actions = '<button id="rv-approve" class="btn primary">Goedkeuren</button>';
      } else {
        info = approver ? 'Nog niet goedgekeurd. Pas na goedkeuring is het plan definitief (en kan er een offerte van).' : 'Klaar met tekenen? Laat het plan controleren door een installateur.';
        actions = approver ? '<button id="rv-approve" class="btn primary">Goedkeuren</button>' : '<button id="rv-request" class="btn primary">Ter controle aanbieden</button>';
      }
      bar.hidden = false;
      bar.className = `review-bar st-${review.status}`;
      bar.innerHTML = `<div class="rv-text"><span class="rv-chip">${REVIEW_LABEL[review.status] || escapeHtml(review.status)}</span><span>${info}</span></div>${actions ? `<div class="rv-act">${actions}</div>` : ''}`;
    },
    /** Koppelt de knoppen van de controlebalk en het indienformulier. */
    _bindReview() {
      const bar = $('#review-bar');
      if (!bar) return;
      /**
       * Voert de gekozen knop van de controlebalk uit.
       * @param {Event} event de gebeurtenis
       */
      bar.onclick = (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.id === 'rv-submit' || button.id === 'rv-request') this.openSubmit();
        if (button.id === 'rv-approve') this.reviewPlan('approve');
        if (button.id === 'rv-reopen') this.reviewPlan('reopen');
      };
      const dialog = $('#submit-dlg');
      const form = $('#submit-form');
      /** Sluit het indienformulier. */
      $('#submit-close').onclick = () => { dialog.classList.remove('open'); };
      /**
       * Verstuurt het indienformulier.
       * @param {Event} event de gebeurtenis
       */
      form.onsubmit = (event) =>{  { event.preventDefault(); this.submitDrawing(); }; };
      /** Sluit het formulier en start een nieuw project. */
      $('#submit-new').onclick = () =>{  { dialog.classList.remove('open'); this.newProject(); }; };
      /** Sluit het formulier na indienen. */
      $('#submit-done').onclick = () => { dialog.classList.remove('open'); };
    },
    /** Opent het formulier om de tekening in te dienen of het plan ter controle aan te bieden. */
    openSubmit() {
      const planState = this.state;
      if (!planState.areas.length) { this.toast('Teken eerst minstens één vlak van je tuin (stap 2).', true); return; }
      const form = $('#submit-form');
      form.hidden = false;
      $('#submit-ok').hidden = true;
      // Zonder account: contactgegevens erbij; ingelogd alleen de vraag.
      form.querySelectorAll('[data-anon]').forEach((field) => { field.hidden = !ANON; });
      form.querySelectorAll('[data-anon] input').forEach((input) => { input.required = ANON && input.dataset.req === '1'; });
      if (ANON) {
        if (!form.address.value) form.address.value = planState.meta.address || '';
        if (!form.name.value) form.name.value = planState.meta.customer || '';
        $('#submit-company').textContent = (this.drawing && this.drawing.company) || 'het installatiebedrijf';
      }
      $('#submit-title').textContent = ANON ? 'Tekening indienen' : 'Ter controle aanbieden';
      $('.err', form).textContent = '';
      $('#submit-dlg').classList.add('open');
      (ANON ? form.name : form.question).focus();
    },
    /**
     * Verkleint de achtergrond vóór het openbaar indienen: de server neemt
     * hooguit 2 MB per tekening aan. Een grote foto of PDF-pagina wordt een
     * JPEG van maximaal 1600 pixels breed; de schaal (meter per pixel) gaat mee,
     * zodat de tekening op dezelfde plek blijft liggen.
     * @param {object|null} background De achtergrond van het plan.
     * @returns {Promise<object|null>} De (eventueel verkleinde) achtergrond.
     */
    async _compactBackground(background) {
      if (!background || !background.dataUrl || background.dataUrl.length < 900 * 1024) return background;
      try {
        const image = await new Promise((resolve, reject) => {
          const element = new Image();
          element.addEventListener('load', () => resolve(element));
          element.addEventListener('error', () => reject(new Error('Achtergrond niet te lezen.')));
          element.src = background.dataUrl;
        });
        let maxWidth = 1600;
        let dataUrl = background.dataUrl;
        let factor = 1;
        // Kleiner en zachter tot hij past; een heel grote achtergrond valt anders weg.
        for (let attempt = 0; attempt < 4 && dataUrl.length >= 900 * 1024; attempt++) {
          factor = Math.min(1, maxWidth / image.naturalWidth);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          maxWidth = Math.round(maxWidth * 0.75);
        }
        if (dataUrl.length >= 1.5 * 1024 * 1024) return null;
        return { ...background, dataUrl, scale: background.scale / factor };
      } catch (error) {
        return null;
      }
    },
    /**
     * Dient de tekening in (zonder account) of biedt het plan ter controle aan.
     * @returns {Promise<void>} klaar na versturen of melding
     */
    async submitDrawing() {
      const form = $('#submit-form');
      const errorBox = $('.err', form);
      const button = $('button[type=submit]', form);
      if (!form.reportValidity()) return;
      errorBox.textContent = '';
      button.disabled = true;
      try {
        let res;
        if (ANON) {
          const { calc, serverId, ...data } = this.state;
          const original = data.background;
          data.background = await this._compactBackground(original);
          if (original && !data.background) {
            this.toast('De achtergrond is te groot en wordt niet meegestuurd.', true);
          }
          // Onzichtbare captcha van de organisatie (alleen als die aan staat): een vers token vlak voor het indienen.
          let captchaToken = '';
          const captchaKey = this.drawing && this.drawing.captcha ? this.drawing.captcha.siteKey : '';
          if (captchaKey && window.AquatechCaptcha) {
            try { captchaToken = await window.AquatechCaptcha.token(captchaKey, 'drawing_submit'); } catch (error) { captchaToken = ''; }
          }
          res = await fetch('api/public/drawing', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              org: this.org, captchaToken, name: form.name.value, email: form.email.value, phone: form.phone.value, address: form.address.value,
              question: form.question.value, consent: form.consent.checked, website: form.website.value, data,
            }),
          });
        } else {
          clearTimeout(this._syncT);
          if (this._syncPending || !this.state.serverId) await this._sync();
          if (!this.state.serverId) throw new Error('Het plan kon niet op de server worden bewaard; probeer het zo opnieuw.');
          res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}/review-request`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: form.question.value }),
          });
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `Indienen mislukt: ${AquatechCommon.statusMessage(res.status)}`);
        if (ANON) {
          form.hidden = true;
          $('#submit-ref').textContent = body.reference || '';
          $('#submit-ok').hidden = false;
        } else {
          this.review = body.review;
          this._renderReview();
          $('#submit-dlg').classList.remove('open');
          this.toast('Plan ter controle aangeboden');
        }
      } catch (error) {
        errorBox.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    },
    /**
     * Keurt het plan goed of trekt de goedkeuring in.
     * @param {string} action approve of reopen
     * @returns {Promise<void>} klaar na verwerken of melding
     */
    async reviewPlan(action) {
      clearTimeout(this._syncT);
      if (this._syncPending) await this._sync();
      try {
        const res = await fetch(`api/plans/${encodeURIComponent(this.state.serverId)}/review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
        this.review = body.review;
        this._renderReview();
        if (STEPS[this.step].id === 'bom') this.renderStepPanel();
        this.toast(action === 'approve' ? 'Plan goedgekeurd' : 'Goedkeuring ingetrokken');
        if (action === 'approve') this._learnFromPlan();
      } catch (error) {
        this.toast(`Lukt niet: ${error.message}`, true);
      }
    },

    /**
     * Een goedgekeurd plan is door een mens gecontroleerd: de lokale herkenning leert van de vlakken op de
     * ondergrond. Alleen kleurtellingen gaan naar de server (en, als de organisatie het meetcorpus aanzet, de tekening en het eindplan); zonder ondergrond of vlakken gebeurt niets.
     * @returns {Promise<void>} klaar na leren
     */
    async _learnFromPlan() {
      const planState = this.state, background = planState.background;
      if (!background || !background.dataUrl || !background.scale || !planState.areas.length || !planState.serverId) return;
      try {
        const analyzeImage = await window.PlanImport.analyzeImageFrom(background.dataUrl);
        // meters → pixels van de ondergrond → pixels van de analyse-afbeelding
        /**
         * Rekent een punt in meters om naar pixels van de analyse-afbeelding.
         * @param {{x: number, y: number}} point punt in meters
         * @returns {{x: number, y: number}} punt in pixels
         */
        const toPixels = (point) => ({ x: ((point.x - (background.x || 0)) / background.scale) * analyzeImage.factor, y: ((point.y - (background.y || 0)) / background.scale) * analyzeImage.factor });
        const areas = planState.areas.filter((area) => area.pts && area.pts.length >= 3).map((area) => ({ type: area.type, points: area.pts.map(toPixels) }));
        const samples = await window.LocalRecognizer.learn(analyzeImage, { areas });
        if (samples) await window.Concept.teach({ planId: planState.serverId, samples });
        const config = await window.AquatechCommon.getJson('api/config');
        if (config && config.planCorpus) {
          // meetcorpus (alleen als de organisatie dat aanzet): de tekening als PNG en het eindplan in pixels van die tekening
          const corpusImage = await window.PlanImport.analyzeImageFrom(background.dataUrl, { png: true });
          const elements = planState.elements.map((element) => ({ kind: element.kind, ...toPixels(element) }));
          await window.Concept.saveCorpus({ planId: planState.serverId, image: corpusImage.dataUrl,
            final: { areas, elements, metersPerPixel: background.scale / analyzeImage.factor } });
        }
      } catch (error) {
        /* leren is een bijzaak */
      }
    },
  });
})();
