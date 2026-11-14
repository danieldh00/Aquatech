// Draait de plan-bouwer in een werkthread met een tijdslimiet, voor de AI-koppeling: de berekening kan seconden duren en mag de server niet vasthouden.
const path = require('path');
const { Worker } = require('worker_threads');

/** Hoelang een berekening hoogstens mag duren. */
const TIMEOUT_MS = 20000;

/**
 * Voert een functie van plan-builder.js uit in een werkthread.
 * @param {'buildPlan'|'summarizePlan'} method De functie.
 * @param {Array} args De argumenten (gewone, kopieerbare waarden).
 * @returns {Promise<object>} De uitkomst van de functie; bij te lang rekenen of een fout { problems }.
 */
function runPlanTask(method, args) {
  return new Promise((resolve) => {
    const failed = { problems: ['Het plan kon niet berekend worden (te groot of te veel rekentijd). Maak de vlakken kleiner of splits het plan.'] };
    const worker = new Worker(path.join(__dirname, 'plan-worker.js'), { workerData: { method, args }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { worker.terminate(); resolve(failed); }, TIMEOUT_MS);
    worker.once('message', (message) => { clearTimeout(timer); resolve(message && !message.failed ? message.result : failed); });
    worker.once('error', () => { clearTimeout(timer); resolve(failed); });
  });
}

module.exports = { runPlanTask, TIMEOUT_MS };
