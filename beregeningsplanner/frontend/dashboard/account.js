// Inlogstatus (wie ben ik, welke rol) voor het dashboard en de modules.
// AquatechAccount.load(base) haalt api/me op en vult #account; `base` is het
// relatieve pad naar de app-root ('' op het dashboard, '../' in een module).
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function load(base = '') {
    let me = { user: null, via: null, guest: true };
    if (location.protocol !== 'file:') {
      try {
        const res = await fetch(`${base}api/me`, { cache: 'no-store' });
        if (res.ok) me = await res.json();
      } catch (e) { /* offline: als gast tonen */ }
    }
    render(me, base);
    return me;
  }

  function render(me, base) {
    const el = document.getElementById('account');
    if (!el || location.protocol === 'file:') return;
    const u = me.user;
    if (u && u.kind !== 'gast') {
      const role = u.role === 'beheerder' ? 'beheerder' : 'gebruiker';
      // Via het Home Assistant-paneel is er niets om uit te loggen.
      const out = me.via === 'ingress' ? '' : '<button type="button" data-logout>Uitloggen</button>';
      el.innerHTML = `<span>${esc(u.displayName)} <span class="role">· ${role}</span></span>${out}`;
    } else {
      el.innerHTML = `<span class="role">Gast</span><a href="${esc(base)}login">Inloggen</a>`;
    }
    const btn = el.querySelector('[data-logout]');
    if (btn) {
      btn.onclick = async () => {
        try { await fetch(`${base}api/auth/logout`, { method: 'POST' }); } catch (e) { /* negeren */ }
        location.href = base || './';
      };
    }
  }

  root.AquatechAccount = { load };
})(window);
