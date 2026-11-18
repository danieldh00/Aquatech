/**
 * Wacht tot de live omgeving de verwachte versie draait (de server rolt een nieuw image binnen ~15 minuten uit)
 * en niet in onderhoudsmodus staat. Stopt met een foutcode als dat niet lukt binnen de wachttijd.
 * Gebruik: SMOKE_BASE_URL=https://… EXPECTED_VERSION=1.17.3 node wait-for-version.js
 */
const baseUrl = (process.env.SMOKE_BASE_URL || 'https://aquatech.den-hollander.com').replace(/\/+$/, '');
const expectedVersion = process.env.EXPECTED_VERSION || '';
const timeoutMinutes = Number(process.env.WAIT_TIMEOUT_MINUTES || 30);
const intervalSeconds = 20;

/**
 * Pauzeert een aantal milliseconden.
 * @param {number} milliseconds Duur van de pauze.
 * @returns {Promise<void>} Klaar na de pauze.
 */
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Vraagt de gezondheidscontrole op en geeft de uitkomst terug (nooit een uitzondering).
 * @returns {Promise<{version: string, maintenance: boolean, error: string}>} Versie, onderhoudsstand en eventuele fout.
 */
async function readHealth() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { version: '', maintenance: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    return { version: String(body.version || ''), maintenance: Boolean(body.maintenance), error: '' };
  } catch (error) {
    return { version: '', maintenance: false, error: String(error.message || error) };
  }
}

/**
 * Wacht in een lus tot de verwachte versie draait.
 * @returns {Promise<void>} Klaar zodra de versie gelijk is.
 */
async function main() {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let last = { version: '', maintenance: false, error: 'nog niet gevraagd' };
  while (Date.now() < deadline) {
    last = await readHealth();
    const versionOk = !expectedVersion || last.version === expectedVersion;
    if (!last.error && versionOk && !last.maintenance) {
      console.log(`Live draait versie ${last.version}.`);
      return;
    }
    console.log(`Wachten: live=${last.version || '?'} (verwacht ${expectedVersion || 'elke'}), onderhoud=${last.maintenance}${last.error ? `, fout=${last.error}` : ''}`);
    await sleep(intervalSeconds * 1000);
  }
  console.error(`Na ${timeoutMinutes} minuten draait live nog niet de verwachte versie ${expectedVersion} (laatst: ${last.version || '?'}${last.error ? `, ${last.error}` : ''}). Is de uitrol mislukt of teruggedraaid?`);
  process.exit(1);
}

main();
