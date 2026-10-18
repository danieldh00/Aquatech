// Eenvoudige in-memory rate limiter (vast venster per sleutel). `max` mag een
// functie zijn, zodat een gewijzigde instelling meteen geldt. Genoeg voor
// één Raspberry Pi met een handvol toestellen; geen externe afhankelijkheid.
function createRateLimiter({ windowMs, max, keyFn }) {
  const hits = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > (typeof max === 'function' ? max() : max)) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'rate_limited', message: 'Te veel verzoeken, probeer het zo opnieuw.' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
