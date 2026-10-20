// Openbare offertepagina (digitale offerte): de klant opent de link uit de
// e-mail, bekijkt de offerte, kiest eventuele opties en geeft akkoord met naam,
// handtekening en akkoord op de voorwaarden, of wijst af. Geen account nodig.
// Het token staat in het fragment (#t=...) en gaat alleen in een kop naar de
// server, zodat het niet in logboeken of de Referer terechtkomt.
(function () {
  const V = window.QuoteView;
  const $ = (s) => document.querySelector(s);
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const preview = new URLSearchParams(location.hash.slice(1)).get('voorbeeld') === '1';
  const state = { quote: null, profile: null, form: null };

  async function api(path, body) {
    const res = await fetch(`../api/public/${path}${preview && !body ? '?preview=1' : ''}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      headers: { 'X-Offerte-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `Er ging iets mis (${res.status}).`), { status: res.status });
    return out;
  }

  function message(text) {
    $('#o-message').textContent = text;
  }

  function status(text, cls) {
    const el = $('#o-status');
    el.textContent = text || '';
    el.className = `o-status screen${cls ? ` ${cls}` : ''}`;
    el.hidden = !text;
  }

  const expired = (q) => q.data.validUntil && q.data.validUntil < window.QuoteCore.today();

  function render() {
    const q = state.quote;
    const p = state.profile || {};
    const open = q.status === 'verzonden' && !q.acceptance && !expired(q);
    document.title = `Offerte ${q.number}${p.companyName ? ` – ${p.companyName}` : ''}`;
    $('#o-company').textContent = p.companyName || 'Offerte';
    $('#print').innerHTML = V.documentHtml(q, p, { interactive: open });
    $('#print').hidden = false;
    $('#o-print').hidden = false;
    message('');
    const a = q.acceptance;
    if (a && a.answer === 'akkoord') status(`U heeft deze offerte geaccordeerd op ${V.dateTime(a.at)}. Bedankt! U kunt hem hieronder als PDF opslaan.`, 'ok');
    else if (a && a.answer === 'afgewezen') status(`Deze offerte is afgewezen op ${V.dateTime(a.at)}. Neem gerust contact op als u een aangepaste offerte wilt.`, 'bad');
    else if (q.status !== 'verzonden') status('Deze offerte is al beantwoord.', 'warn');
    else if (expired(q)) status(`Deze offerte was geldig tot ${V.date(q.data.validUntil)}. Neem contact op voor een nieuwe offerte.`, 'warn');
    else status(`Bekijk de offerte en geef onderaan uw akkoord. Geldig tot ${V.date(q.data.validUntil)}.${preview ? ' (Voorbeeld: het openen telt niet als bekeken.)' : ''}`);
    $('#o-sign').hidden = !open;
    if (!open) return;
    // Opties aan- en uitvinken: het totaal rekent mee.
    $("#print").onchange = (e) => {
      const id = e.target.dataset && e.target.dataset.opt;
      if (!id) return;
      const line = q.data.lines.find((l) => l.id === id);
      if (line) line.selected = e.target.checked;
      const pos = window.scrollY;
      $('#print').innerHTML = V.documentHtml(q, p, { interactive: true });
      window.scrollTo(0, pos);
      state.form.update();
    };
    state.form = V.signForm($('#o-sign'), {
      termsLink: Boolean(q.data.terms),
      total: () => V.totalsOf(q).total,
      async onRespond(payload) {
        const out = await api('quote/respond', { ...payload, options: V.selectedOptions(q) });
        state.quote = out.quote;
        render();
        window.scrollTo(0, 0);
      },
    });
  }

  async function init() {
    $('#o-print').onclick = () => window.print();
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      message('Deze link is niet compleet. Open de link uit de e-mail opnieuw, of neem contact op met de afzender.');
      return;
    }
    try {
      const out = await api('quote');
      state.quote = out.quote;
      state.profile = out.profile;
      if (window.AquatechTheme) window.AquatechTheme.apply(out.theme);
      render();
    } catch (e) {
      message(e.status === 429 ? 'Te veel verzoeken. Probeer het later opnieuw.' : e.message);
    }
  }

  init();
})();
