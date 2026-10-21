// Beheer > Webshop: koppeling met de webshop van de organisatie instellen en
// producten ophalen (API /api/admin/shop, zie backend/src/shop.js).
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  let toast = () => {};

  async function api(path, opts = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  function render(v) {
    const f = $('#w-form');
    const src = v.source || {};
    f.url.value = src.url || '';
    f.mode.value = src.mode || 'store';
    f.pricesIncludeTax.checked = src.pricesIncludeTax !== false;
    f.vatRate.value = String(src.vatRate ?? 21);
    f.mapping.value = Object.entries(src.mapping || {}).map(([k, s]) => `${k}=${s}`).join('\n');
    f.consumerKey.value = '';
    f.consumerSecret.value = '';
    f.push.checked = Boolean(src.push);
    f.pushStock.checked = src.pushStock !== false;
    const rest = () => { $('#w-keys').style.display = f.mode.value === 'rest' ? '' : 'none'; $('#w-push-box').style.display = f.mode.value === 'rest' ? '' : 'none'; f.pushStock.disabled = !f.push.checked; };
    rest();
    const keys = v.consumerKey && v.consumerKey.set && v.consumerSecret && v.consumerSecret.set;
    $('#w-key-state').textContent = keys ? `Ingesteld${v.consumerKey.hint ? ` (key eindigt op ${v.consumerKey.hint.replace('…', '')})` : ''}` : 'Nog niet ingesteld.';
    $('#w-key-state').className = `state ${keys ? 'ok' : 'off'}`;
    $('#w-sync').disabled = !src.url;
    $('#w-off').disabled = !src.url;
    const st = v.status;
    const el = $('#w-status');
    if (!src.url) { el.textContent = 'Geen webshop gekoppeld: de planner en offertes gebruiken de indicatieve standaardprijzen.'; return; }
    el.innerHTML = `
      ${st && st.syncedAt ? `<p>Laatst opgehaald: <b>${esc(when(st.syncedAt))}</b> · ${st.productCount} producten · <b>${v.matchedCount} van ${v.articleCount}</b> artikelen van de planner gekoppeld.</p>` : '<p>Nog geen producten opgehaald.</p>'}
      ${src.push ? '<p>Prijzen' + (src.pushStock !== false ? ' en voorraad' : '') + ' gaan vanuit Voorraadbeheer naar de webshop. Per artikel zie je de stand in <a href="../voorraad/">Voorraadbeheer</a>.</p>' : ''}
      ${v.stockSync && !v.stockSync.skipped ? `<p>Voorraadartikelen: ${v.stockSync.linked} nieuw gekoppeld, ${v.stockSync.updated} bijgewerkt in de webshop, ${v.stockSync.pricesFromShop} prijzen uit de webshop overgenomen, ${v.stockSync.soldInShop} verkocht via de webshop afgeboekt${v.stockSync.failed ? `, <b>${v.stockSync.failed} mislukt</b>` : ''}.</p>` : ''}
      ${st && st.lastError ? `<p class="err">Laatste poging (${esc(when(st.lastAttemptAt))}) mislukt: ${esc(st.lastError)}</p>` : ''}
      ${v.unmatched && v.unmatched.length && st && st.syncedAt ? `<details><summary>Nog niet gekoppeld (${v.unmatched.length})</summary><p class="small">${v.unmatched.map(esc).join(', ')}</p></details>` : ''}`;
  }

  async function load() {
    try { render(await api('shop')); } catch (e) { toast(`Kan de webshopkoppeling niet laden: ${e.message}`, true); }
  }

  async function sync() {
    const b = $('#w-sync');
    b.disabled = true;
    b.textContent = 'Bezig…';
    try {
      const v = await api('shop/sync', { method: 'POST' });
      render(v);
      toast(`${v.status.productCount} producten opgehaald, ${v.matchedCount} artikelen gekoppeld`);
    } catch (e) {
      $('.err', $('#w-form')).textContent = e.message;
      load();
    } finally {
      b.textContent = 'Opnieuw ophalen';
    }
  }

  function init(opts) {
    toast = opts.toast;
    const f = $('#w-form');
    const rest = () => { $('#w-keys').style.display = f.mode.value === 'rest' ? '' : 'none'; $('#w-push-box').style.display = f.mode.value === 'rest' ? '' : 'none'; f.pushStock.disabled = !f.push.checked; };
    f.mode.onchange = rest;
    f.push.onchange = rest;
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('.err', f);
      err.textContent = '';
      const mapping = {};
      for (const line of f.mapping.value.split('\n')) {
        const [code, sku] = line.split('=').map((x) => (x || '').trim());
        if (code && sku) mapping[code.toUpperCase()] = sku;
      }
      const body = { url: f.url.value.trim(), mode: f.mode.value, pricesIncludeTax: f.pricesIncludeTax.checked, vatRate: Number(f.vatRate.value), mapping, push: f.push.checked, pushStock: f.pushStock.checked };
      if (f.consumerKey.value.trim()) body.consumerKey = f.consumerKey.value.trim();
      if (f.consumerSecret.value.trim()) body.consumerSecret = f.consumerSecret.value.trim();
      try {
        render(await api('shop', { method: 'PUT', body }));
        if (body.url) await sync();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    $('#w-sync').onclick = sync;
    $('#w-off').onclick = async () => {
      if (!confirm('Webshopkoppeling verwijderen? De planner en offertes gebruiken daarna weer de standaardprijzen.')) return;
      try { render(await api('shop', { method: 'PUT', body: { url: '', clearKeys: true } })); toast('Koppeling verwijderd'); } catch (e) { toast(e.message, true); }
    };
  }

  window.BeheerWebshop = { init, load };
})();
