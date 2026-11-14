// Werkthread voor de plan-bouwer (plan-runner.js): voert buildPlan of summarizePlan uit in een eigen thread, zodat een zware berekening
// de server niet blokkeert.
const { parentPort, workerData } = require('worker_threads');
const builder = require('./plan-builder');

try {
  parentPort.postMessage({ result: builder[workerData.method](...workerData.args) });
} catch (error) {
  parentPort.postMessage({ failed: true, message: String(error && error.message || error).slice(0, 200) });
}
