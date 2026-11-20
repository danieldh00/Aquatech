// Persoonlijke voorkeuren van een gebruiker (users.preferences) en de controles voor e-mail en telefoon.

// Persoonlijke voorkeuren staan als JSON in users.preferences; alleen deze
// sleutels (met hun standaardwaarde) worden bewaard.
// newsSeenAt/seenRelease: vorige bezoek aan Nieuws (zie news.js), niet in het profielformulier.
// seasonReminders: klant wil seizoensherinneringen per mail (season-reminders.js, uit te zetten in het portaal).
const PREFERENCES = { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '', seasonReminders: true };
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const PHONE = /^\+?[0-9 ()./-]{6,25}$/;

/**
 * Schoont voorkeuren op: alleen de sleutels uit PREFERENCES, met hun eigen controle.
 * @param {object} input De nieuwe voorkeuren.
 * @param {object} [base] De huidige voorkeuren (ontbrekende sleutels blijven zo).
 * @returns {object} De complete voorkeuren.
 */
function cleanPreferences(input, base = PREFERENCES) {
  const requested = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...PREFERENCES, ...base };
  if (requested.startPage !== undefined) out.startPage = /^[a-z0-9-]{0,40}$/.test(String(requested.startPage)) ? String(requested.startPage) : '';
  if (requested.mailCopy !== undefined) out.mailCopy = requested.mailCopy === true;
  if (requested.seasonReminders !== undefined) out.seasonReminders = requested.seasonReminders !== false;
  if (requested.newsSeenAt !== undefined) out.newsSeenAt = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(requested.newsSeenAt)) ? String(requested.newsSeenAt) : '';
  if (requested.seenRelease !== undefined) out.seenRelease = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(requested.seenRelease)) ? String(requested.seenRelease) : '';
  return out;
}

/**
 * De voorkeuren van een gebruiker, altijd compleet.
 * @param {object} user Rij uit users.
 * @returns {object} De voorkeuren.
 */
function preferencesOf(user) {
  let raw = {};
  try { raw = JSON.parse(user?.preferences || '{}'); } catch (error) { /* kapot: standaard */ }
  return cleanPreferences(raw);
}


module.exports = { PREFERENCES, EMAIL, PHONE, cleanPreferences, preferencesOf };
