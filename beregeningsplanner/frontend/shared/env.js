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

  root.AquatechEnv = {
    current: env,
    isTest: Boolean(env),
    // Achtervoegsel voor localStorage-sleutels: leeg in live.
    storageSuffix: () => (env ? `@${env.slug}` : ''),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark);
  else mark();
})(window);
