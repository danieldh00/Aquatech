// Draait de plan-bouwer in een werkthread met een tijdslimiet, voor de AI-koppeling: de berekening kan seconden duren en mag de server niet vasthouden.
const path = require('path');
const { Worker } = require('worker_threads');

/** Hoelang een berekening hoogstens mag duren. */
const TIMEOUT_MS = 20000;
/** Hoeveel berekeningen tegelijk draaien; de rest wacht (zo kan één account het geheugen niet vullen). */
const MAX_CONCURRENT = 2;
/** Hoeveel berekeningen er hoogstens wachten; daarboven meldt de koppeling dat het druk is. */
const MAX_WAITING = 20;
let running = 0;
/** @type {Function[]} */
const waiting = [];

/**
 * Voert een functie van plan-builder.js uit in een werkthread.
 * @param {'buildPlan'|'summarizePlan'|'quoteLinesFromPlan'} method De functie.
 * @param {Array} args De argumenten (gewone, kopieerbare waarden).
 * @returns {Promise<object>} De uitkomst van de functie; bij te lang rekenen of een fout { problems }.
 */
function runPlanTask(method, args) {
  return new Promise((resolve) => {
    if (waiting.length >= MAX_WAITING) return resolve({ problems: ['Er worden nu veel plannen berekend. Probeer het over een minuut opnieuw.'] });
    waiting.push(async () => {
      let outcome;
      try {
        outcome = await runNow(method, args);
      } catch {
        outcome = { problems: ['Het plan kon niet verwerkt worden: de gegevens in het plan kloppen niet.'] };
      }
      running--;
      next();
      resolve(outcome);
    });
    next();
  });
}

/**
 * Start wachtende berekeningen zolang er plek is.
 * @returns {void}
 */
function next() {
  while (running < MAX_CONCURRENT && waiting.length) {
    running++;
    waiting.shift()();
  }
}

/**
 * Draait één berekening in een werkthread.
 * @param {string} method De functie.
 * @param {Array} args De argumenten.
 * @returns {Promise<object>} De uitkomst of een melding.
 */
function runNow(method, args) {
  return new Promise((resolve) => {
    const tooLong = { problems: ['Het plan kon niet berekend worden: te groot of te veel rekentijd. Maak de vlakken kleiner of splits het plan.'] };
    const failed = { problems: ['Het plan kon niet verwerkt worden: de gegevens in het plan kloppen niet.'] };
    const worker = new Worker(path.join(__dirname, 'plan-worker.js'), { workerData: { method, args }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { worker.terminate(); resolve(tooLong); }, TIMEOUT_MS);
    worker.once('message', (message) => { clearTimeout(timer); resolve(message && !message.failed ? message.result : failed); });
    worker.once('error', () => { clearTimeout(timer); resolve(failed); });
  });
}

module.exports = { runPlanTask, TIMEOUT_MS };
