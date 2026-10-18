// Het offertedocument en het akkoordformulier, gedeeld door de module
// Offertes (afdrukversie, klantaccount) en de openbare offertepagina
// (openbaar/offerte.html). Gewoon script, geen module; vraagt QuoteCore.
(function (root) {
  const Q = root.QuoteCore;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (v) => (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' }) : '–');

  /**
   * Totalen zoals de klant ze ziet. Bij de opmaak "totaal per onderdeel"
   * stuurt de server geen regelprijzen maar per onderdeel en btw-tarief een
   * bedrag (`fixed`); de opties tellen mee zoals ze gekozen zijn.
   */
  function totalsOf(quote) {
    const d = quote.data;
    if (!Array.isArray(quote.fixed)) return Q.totals(d);
    const lines = quote.fixed.map((f) => ({ section: f.section, qty: 1, price: f.amount, vat: f.vat }))
      .concat(d.lines.filter((l) => l.optional));
    return Q.totals({ discountPct: d.discountPct, lines });
  }

  /**
   * HTML van het document. opts.interactive: opties zijn aan te vinken
   * (data-opt="<regel-id>"). opts.logo: pad naar het witte logo.
   */
  function documentHtml(quote, profile, opts = {}) {
    const d = quote.data;
    const p = profile || {};
    const t = totalsOf(quote);
    const c = d.customer || {};
    const logo = opts.logo || '../shared/logo-white.png';
    const company = [p.address, [p.phone, p.email].filter(Boolean).join(' · '), p.website].filter(Boolean).join('\n');
    const to = [c.name, c.contact ? `T.a.v. ${c.contact}` : '', c.address].filter(Boolean).join('\n');
    const detail = d.layout !== 'totaal';
    const open = opts.interactive;
    const desc = (l) => (l.optional && open
      ? `<label class="p-pick"><input type="checkbox" data-opt="${esc(l.id)}"${l.selected ? ' checked' : ''}> ${esc(l.description)}</label>`
      : esc(l.description));
    const optCls = (l) => (l.optional ? ` class="p-opt${l.selected ? '' : ' off'}"` : '');
    let anyOpt = false;
    const sections = Object.entries(Q.SECTIONS).map(([key, label]) => {
      const lines = d.lines.filter((l) => l.section === key);
      if (!lines.length) return '';
      const rows = lines.map((l) => {
        if (l.optional) anyOpt = true;
        if (detail) {
          return `<tr${optCls(l)}><td>${desc(l)}</td><td class="num">${nl(l.qty)}</td><td>${esc(l.unit)}</td><td class="num">${eur(l.price)}</td><td class="num">${l.vat}%</td><td class="num">${eur(Q.lineTotal(l))}</td></tr>`;
        }
        // Totaal per onderdeel: geen regelprijzen, behalve bij een optie.
        return `<tr${optCls(l)}><td colspan="4">${desc(l)}</td><td class="num">${nl(l.qty)} ${esc(l.unit)}</td><td class="num">${l.optional ? eur(Q.lineTotal(l)) : ''}</td></tr>`;
      }).join('');
      return `<tr class="p-section"><td colspan="6">${esc(label)}</td></tr>${rows}
        <tr class="p-sum"><td colspan="5">Totaal ${esc(label.toLowerCase())}</td><td class="num">${eur(t.bySection[key] || 0)}</td></tr>`;
    }).join('');
    const s = d.planSummary;
    const design = s ? [s.lawnM2 ? `${nl(s.lawnM2, 0)} m² gazon` : '', s.sprinklers ? `${s.sprinklers} sproeiers` : '', s.zones ? `${s.zones} zones` : '', s.level ? `uitvoering ${s.level}` : ''].filter(Boolean).join(' · ') : '';
    const foot = [p.companyName, p.kvk ? `KvK ${p.kvk}` : '', p.vatNumber ? `Btw ${p.vatNumber}` : '', p.iban ? `IBAN ${p.iban}` : ''].filter(Boolean).join(' · ');
    const a = quote.acceptance;
    let end;
    if (a && a.answer === 'akkoord') {
      end = `<div class="p-accepted">
        <h2>Digitaal geaccordeerd</h2>
        <div>Door <b>${esc(a.name)}</b> op ${esc(dateTime(a.at))}, voor ${eur(a.totalIncl != null ? a.totalIncl : t.total)} incl. btw, met akkoord op de voorwaarden.</div>
        ${a.signature ? `<img src="${esc(a.signature)}" alt="Handtekening van ${esc(a.name)}">` : ''}
        <div class="p-proof">${a.via === 'account' ? 'Via het klantaccount' : 'Via de offertelink'}${a.ip ? ` · IP ${esc(a.ip)}${a.forwardedFor ? ` (opgegeven ${esc(a.forwardedFor)})` : ''}` : ''}${a.contentHash ? ` · kenmerk ${esc(a.contentHash.slice(0, 16))}` : ''}</div>
      </div>`;
    } else if (a && a.answer === 'afgewezen') {
      end = `<div class="p-accepted rejected"><h2>Afgewezen</h2><div>Door ${esc(a.name || 'de klant')} op ${esc(dateTime(a.at))}.${a.reason ? ` Reden: ${esc(a.reason)}` : ''}</div></div>`;
    } else {
      end = '<h2>Voor akkoord</h2><div class="p-sign"><div>Naam en datum</div><div>Handtekening</div></div>';
    }
    return `
      <header class="p-head">
        <img src="${esc(logo)}" alt="${esc(p.companyName)}">
        <div class="p-company"><b>${esc(p.companyName)}</b>\n${esc(company)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">Offerte voor</div>${esc(to || '–')}</div>
        <div class="p-info"><table>
          <tr><td>Offertenummer</td><td><b>${esc(quote.number)}</b></td></tr>
          <tr><td>Datum</td><td>${esc(date(d.date))}</td></tr>
          <tr><td>Geldig tot</td><td>${esc(date(d.validUntil))}</td></tr>
          ${d.reference ? `<tr><td>Uw referentie</td><td>${esc(d.reference)}</td></tr>` : ''}
        </table></div>
      </div>
      <h1>Offerte</h1>
      <div class="p-sub">${esc(d.title)}</div>
      ${d.intro ? `<p class="p-text">${esc(d.intro)}</p>` : ''}
      ${design ? `<div class="p-design"><b>Ontwerp${d.planTitle ? ` ${esc(d.planTitle)}` : ''}:</b> ${esc(design)}</div>` : ''}
      <table class="p-lines">
        <thead><tr>${detail ? '<th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th class="num">Btw</th><th class="num">Totaal</th>' : '<th colspan="4">Omschrijving</th><th class="num">Aantal</th><th class="num"></th>'}</tr></thead>
        <tbody>${sections || '<tr><td colspan="6">Geen regels.</td></tr>'}</tbody>
      </table>
      ${anyOpt ? `<p class="p-optnote">${open ? 'Regels met <b>Optie</b> kiest u zelf: vink ze aan om ze mee te nemen; het totaal past zich aan.' : 'Regels met <b>Optie</b> tellen alleen mee als ze gekozen zijn.'}</p>` : ''}
      <table class="p-totals">
        <tr><td>Subtotaal</td><td class="num">${eur(t.subtotal)}</td></tr>
        ${t.discount ? `<tr><td>Korting ${nl(t.discountPct)}%</td><td class="num">− ${eur(t.discount)}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${eur(t.net)}</td></tr>` : ''}
        ${t.vat.filter((v) => v.base).map((v) => `<tr><td>Btw ${v.rate}%</td><td class="num">${eur(v.amount)}</td></tr>`).join('')}
        <tr class="grand"><td>Totaal incl. btw</td><td class="num">${eur(t.total)}</td></tr>
      </table>
      ${d.terms ? `<h2 id="p-terms">Voorwaarden</h2><p class="p-text">${esc(d.terms)}</p>` : ''}
      <div class="p-end">
        ${end}
        <footer class="p-foot">${esc(foot)}</footer>
      </div>`;
  }

  /** Opties aan- of uitzetten in de offerte (in de browser, voor het akkoord). */
  function selectedOptions(quote) {
    return quote.data.lines.filter((l) => l.optional && l.selected).map((l) => l.id);
  }

  // Tekenvak: tekenen met muis, vinger of pen; levert een PNG.
  function signaturePad(canvas, onChange) {
    const ctx = canvas.getContext('2d');
    let drawing = false, last = null, ink = false;
    function fit() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#172f5e';
      ink = false;
      onChange(false);
    }
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      last = pos(e);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = '#172f5e';
      ctx.fill();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      if (!ink) { ink = true; onChange(true); }
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    fit();
    let w = canvas.getBoundingClientRect().width;
    window.addEventListener('resize', () => {
      const nw = canvas.getBoundingClientRect().width;
      if (Math.abs(nw - w) > 2) { w = nw; fit(); }
    });
    return {
      clear: fit,
      hasInk: () => ink,
      // Verkleind tot max. 600 px breed op wit, zodat de PNG klein blijft.
      toDataURL() {
        const scale = Math.min(1, 600 / canvas.width);
        const out = document.createElement('canvas');
        out.width = Math.round(canvas.width * scale);
        out.height = Math.round(canvas.height * scale);
        const o = out.getContext('2d');
        o.fillStyle = '#fff';
        o.fillRect(0, 0, out.width, out.height);
        o.drawImage(canvas, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      },
    };
  }

  /**
   * Akkoordformulier onder het document. opts: { total() → bedrag incl. btw,
   * onRespond(payload) → Promise (payload: { answer, name, signature, terms,
   * reason }) }. Geeft { update() } om het getoonde totaal te verversen.
   */
  function signForm(container, opts) {
    container.innerHTML = `
      <div class="sign-form">
        <h2>Akkoord geven</h2>
        <p class="sum">Totaal: <b data-total></b> incl. btw</p>
        <label class="f">Uw naam<input type="text" data-name maxlength="120" autocomplete="name" placeholder="Voor- en achternaam"></label>
        <div class="f-label">Uw handtekening</div>
        <div class="pad-wrap"><canvas data-pad aria-label="Tekenvak voor uw handtekening"></canvas>
          <span class="pad-hint" data-hint>Teken hier met muis of vinger</span>
          <button type="button" class="btn small pad-clear" data-clear>Wissen</button></div>
        <label class="terms"><input type="checkbox" data-terms> <span>Ik ga akkoord met deze offerte en de voorwaarden${opts.termsLink ? ' (<a href="#p-terms">lezen</a>)' : ''}.</span></label>
        <div class="row">
          <button type="button" class="btn primary" data-accept>Akkoord geven</button>
          <button type="button" class="btn" data-reject-open>Afwijzen</button>
        </div>
        <p class="err" data-err></p>
        <div class="reject-box" data-reject-box hidden>
          <label class="f">Wilt u laten weten waarom? (niet verplicht)<textarea data-reason rows="3" maxlength="1000"></textarea></label>
          <div class="row"><button type="button" class="btn" data-reject>Offerte afwijzen</button></div>
        </div>
      </div>`;
    const $ = (s) => container.querySelector(s);
    const pad = signaturePad($('[data-pad]'), (ink) => { $('[data-hint]').hidden = ink; });
    $('[data-clear]').onclick = () => pad.clear();
    const update = () => { $('[data-total]').textContent = eur(opts.total()); };
    update();
    const err = (m) => { $('[data-err]').textContent = m || ''; };
    const busy = (b) => container.querySelectorAll('button').forEach((x) => { x.disabled = b; });
    async function send(payload) {
      busy(true);
      err('');
      try { await opts.onRespond(payload); } catch (e) { err(e.message); } finally { busy(false); }
    }
    $('[data-accept]').onclick = () => {
      const name = $('[data-name]').value.trim();
      if (name.length < 2) return err('Vul uw naam in.');
      if (!pad.hasInk()) return err('Zet uw handtekening in het tekenvak.');
      if (!$('[data-terms]').checked) return err('Vink aan dat u akkoord gaat met de offerte en de voorwaarden.');
      send({ answer: 'akkoord', name, signature: pad.toDataURL(), terms: true });
    };
    $('[data-reject-open]').onclick = () => { $('[data-reject-box]').hidden = !$('[data-reject-box]').hidden; };
    $('[data-reject]').onclick = () => {
      if (!confirm('Weet u zeker dat u deze offerte wilt afwijzen?')) return;
      send({ answer: 'afgewezen', name: $('[data-name]').value.trim(), reason: $('[data-reason]').value.trim() });
    };
    return { update };
  }

  root.QuoteView = { documentHtml, totalsOf, selectedOptions, signForm, signaturePad, esc, eur, date, dateTime };
})(window);
