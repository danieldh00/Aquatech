// Vult een lege testdatabase: eerste beheerder (baas) en 57 klanten via de echte API, en schrijft hun id's naar /tmp/ids.json.
// Gebruik: backend starten met SETUP_CODE=setup123 CAPTCHA_DISABLED=1, daarna `node e2e/seed.mjs`.
const base = 'http://127.0.0.1:3300/app/api';
const PASSWORD = 'Tuin-Plan-2026!';
async function call(path, method, body, cookie) {
  const res = await fetch(`${base}/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { res, json, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') };
}
(async () => {
  let out = await call('setup', 'POST', { code: 'setup123', username: 'baas', displayName: 'Baas', password: PASSWORD });
  console.log('setup', out.res.status, out.json.message || '');
  out = await call('auth/login', 'POST', { username: 'baas', password: PASSWORD });
  console.log('login', out.res.status, JSON.stringify(out.json).slice(0, 120));
  const cookie = out.cookie;
  const made = [];
  for (let n = 1; n <= 57; n += 1) {
    const zakelijk = n % 5 === 0;
    const body = { displayName: `Klant ${String(n).padStart(2, '0')}`, email: `klant${n}@example.nl`, phone: `0612345${String(n).padStart(3, '0')}`, customerGroup: zakelijk ? 'zakelijk' : '', ...(zakelijk ? { companyName: `Bedrijf ${n} BV`, kvkNumber: '12345678' } : {}) };
    const r = await call('customers', 'POST', body, cookie);
    if (r.res.status !== 201 && r.res.status !== 200) console.log('klant', n, r.res.status, r.json.message);
    else made.push(r.json.customer.id);
  }
  console.log('klanten gemaakt', made.length);
  (await import('node:fs')).writeFileSync('/tmp/ids.json', JSON.stringify(made));
})();
