// Actieve omgeving (live of test) voor alle pagina's. De server zet bij een
// testomgeving de leesbare cookie `aquatech_env_hint` (`<code>|<naam>`); die
// beveiligt niets, maar toont een testlabel in de kopbalk en scheidt het lokale
// concept van de planner per omgeving, zodat live en test niet door elkaar lopen.
(function (root) {
  function read() {
    const m = /(?:^|;\s*)aquatech_env_hint=([^;]*)/.exec(document.cookie || '');
    if (!m) return null;
    let raw = '';
    try { raw = decodeURIComponent(m[1]); } catch (e) { return null; }
    const idx = raw.indexOf('|');
    if (idx < 1) return null;
    return { slug: raw.slice(0, idx), name: raw.slice(idx + 1) || 'Test' };
  }

  const env = read();

  function mark() {
    if (!env) return;
    document.documentElement.classList.add('env-test');
    if (!/^\[TEST\]/.test(document.title)) document.title = `[TEST] ${document.title}`;
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('.env-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'env-badge';
    badge.title = 'Je werkt in een testomgeving: plannen, historie en instellingen staan los van live.';
    badge.textContent = /^test$/i.test(env.name) ? 'Test' : `Test · ${env.name}`;
    const brand = bar.querySelector('.brand');
    if (brand && brand.nextSibling) bar.insertBefore(badge, brand.nextSibling);
    else bar.appendChild(badge);
  }

  // Impersonatie: een hoofdbeheerder werkt als een andere gebruiker. De server
  // zet dan de leesbare cookie `aquatech_imp_hint` (`<naam>|<verloopt>|live|test`).
  // Op elke pagina staat zolang een balk met de knop terug naar het eigen account.
  const script = document.currentScript;
  const fromApp = (rel) => (script && script.src ? new URL(rel, script.src).href : rel);

  function readImpersonation() {
    const m = /(?:^|;\s*)aquatech_imp_hint=([^;]*)/.exec(document.cookie || '');
    if (!m) return null;
    let raw = '';
    try { raw = decodeURIComponent(m[1]); } catch (e) { return null; }
    const parts = raw.split('|');
    if (parts.length < 3) return null;
    const live = parts.pop() === 'live';
    const expiresAt = parts.pop();
    return { name: parts.join('|'), expiresAt, live };
  }

  const imp = readImpersonation();

  async function stopImpersonation(btn) {
    if (btn) btn.disabled = true;
    try {
      await fetch(fromApp('../api/impersonation/stop'), { method: 'POST' });
    } catch (e) { /* toch terug: de server ruimt een verlopen impersonatie zelf op */ }
    location.href = fromApp('../hoofdbeheer/');
  }

  function markImpersonation() {
    if (!imp || document.querySelector('.imp-bar')) return;
    document.documentElement.classList.add('impersonating');
    const until = new Date(imp.expiresAt);
    const time = isNaN(until) ? '' : until.toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const bar = document.createElement('div');
    bar.className = 'imp-bar';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'imp-text';
    const who = document.createElement('b');
    who.textContent = imp.name;
    text.append('Je werkt als ', who, ` · ${imp.live ? 'live, met toestemming' : 'testomgeving'}${time ? ` · tot ${time}` : ''}`);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Terug naar eigen account';
    btn.onclick = () => stopImpersonation(btn);
    bar.append(text, btn);
    document.body.appendChild(bar);
  }

  root.AquatechEnv = {
    current: env,
    isTest: Boolean(env),
    // Achtervoegsel voor localStorage-sleutels: leeg in live. Tijdens een
    // impersonatie apart, zodat het lokale concept van de hoofdbeheerder en dat
    // van de gebruiker niet door elkaar lopen.
    storageSuffix: () => (env ? `@${env.slug}` : '') + (imp ? `#als:${imp.name}` : ''),
    impersonation: imp,
    stopImpersonation,
  };

  // Kleur van de browserbalk (mobiel) volgt het kleurthema (shared/theme.css).
  function themeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const navy = getComputedStyle(document.documentElement).getPropertyValue('--at-navy').trim();
    if (meta && /^#[0-9a-f]{6}$/i.test(navy)) meta.setAttribute('content', navy);
  }

  const ready = () => { mark(); markImpersonation(); themeColor(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})(window);
