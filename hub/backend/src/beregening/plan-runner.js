// Draait de plan-bouwer in een werkthread met een tijdslimiet, voor de AI-koppeling: de berekening kan seconden duren en mag de server niet vasthouden.
const path = require('path');
const { Worker } = require('worker_threads');

/** Hoelang een berekening hoogstens mag duren. */
const TIMEOUT_MS = 20000;
/**
 * Rijen met elk een eigen plafond: `main` voor de AI-koppeling, `lead` voor tekeningen van bezoekers zonder account.
 * Een aanval op het openbare formulier vult zo alleen de rij van de leads, nooit die van betaalde AI-plannen.
 * `concurrent` = hoeveel berekeningen tegelijk draaien (zo vult één account het geheugen niet), `waiting` = hoeveel er hoogstens wachten.
 */
const LANES = {
  main: { concurrent: 2, waiting: 20, running: 0, queue: [] },
  lead: { concurrent: 1, waiting: 5, running: 0, queue: [] },
};

/**
 * Voert een functie van plan-builder.js uit in een werkthread.
 * @param {'buildPlan'|'summarizePlan'|'quoteLinesFromPlan'} method De functie.
 * @param {Array} args De argumenten (gewone, kopieerbare waarden).
 * @param {'main'|'lead'} [laneName] De rij: `lead` voor openbare tekeningen, anders `main`.
 * @returns {Promise<object>} De uitkomst van de functie; bij te lang rekenen of een fout { problems }.
 */
function runPlanTask(method, args, laneName = 'main') {
  const lane = LANES[laneName] || LANES.main;
  return new Promise((resolve) => {
    if (lane.queue.length >= lane.waiting) return resolve({ problems: ['Er worden nu veel plannen berekend. Probeer het over een minuut opnieuw.'] });
    lane.queue.push(async () => {
      let outcome;
      try {
        outcome = await runNow(method, args);
      } catch {
        outcome = { problems: ['Het plan kon niet verwerkt worden: de gegevens in het plan kloppen niet.'] };
      }
      lane.running--;
      next(lane);
      resolve(outcome);
    });
    next(lane);
  });
}

/**
 * Start wachtende berekeningen van een rij zolang er plek is.
 * @param {object} lane De rij uit LANES.
 * @returns {void}
 */
function next(lane) {
  while (lane.running < lane.concurrent && lane.queue.length) {
    lane.running++;
    lane.queue.shift()();
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
