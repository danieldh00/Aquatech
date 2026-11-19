// Servertaken: dingen die op de Proxmox-host of op apps01 moeten gebeuren en die de app zelf niet kan doen (bijvoorbeeld
// een serverscript opnieuw draaien na een wijziging). De lijst staat hier in de repo (`HOST_TASKS`), zodat elke PR die
// een hosttaak vereist er één regel aan toevoegt; de uitvoering staat in deploy/apps01/pve/servertaken.sh
// (`openstaand`, elke taak heeft daar een functie met dezelfde id). Een test bewaakt dat beide lijsten gelijk blijven.
//
// Afvinken kan op twee manieren:
// - automatisch: het hostscript zet na elke uitgevoerde taak de id in `host-tasks.json` in de statusmap
//   (UPDATE_STATUS_DIR, in de container alleen-lezen; de app saneert wat ze leest);
// - met de hand: de beheerder vinkt de taak af in Beheer > Systeem > Updates (bewaard in de instelling `hostTasks`).
// Alles is bedoeld voor de beheerder van de hoofdtenant (zie canUpdate in server.js).
const fs = require('fs');
const path = require('path');

/** Eén vast commando voor de Proxmox-host (als root): haalt de nieuwste lijst van master op en pint hem op de exacte commit. */
const HOST_COMMAND = [
  "REF=$(curl -fsSL -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/danieldh00/Aquatech/commits/master)",
  '&& curl -fsSL "https://raw.githubusercontent.com/danieldh00/Aquatech/$REF/deploy/apps01/pve/servertaken.sh" -o /tmp/servertaken.sh',
  '&& APPS01_SSH=daniel@apps01 TASKS_REF="$REF" bash /tmp/servertaken.sh openstaand',
].join(' ');

/**
 * Alle servertaken, oudste eerst. Een nieuwe taak komt onderaan met een nieuwe id; een bestaande id verandert nooit
 * (de id is wat het hostscript als gedaan onthoudt).
 */
const HOST_TASKS = [
  {
    id: '001-app-update-opnieuw-inrichten',
    title: 'Updaten vanuit de app opnieuw inrichten',
    description: 'Haalt update.sh, compose.yml en de systemd-units opnieuw op en maakt de container opnieuw (ca. 1 minuut niet beschikbaar). Nodig na de wijziging in PR #300.',
    addedAt: '2026-11-19',
  },
];

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CHECKED = 200;
const TASK_ID = /^[0-9]{3}-[a-z0-9-]{1,80}$/;

/**
 * Leest een JSON-bestand uit de statusmap (alleen een gewoon bestand, klein, geen symlink).
 * @param {string} dir De statusmap.
 * @param {string} name De bestandsnaam.
 * @returns {object|null} De inhoud of null.
 */
function readLedger(dir, name) {
  try {
    const file = path.join(dir, name);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

/**
 * Een tijdstip als ISO-tekst als het geldig is, anders null.
 * @param {*} value Invoer.
 * @returns {string|null} Tijdstip.
 */
function cleanTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Maakt de instelling `hostTasks` schoon: alleen bekende id's met tijdstip en naam van wie afvinkte.
 * @param {*} raw De opgeslagen of ingevoerde waarde.
 * @returns {{ checked: Object<string, { at: string, byName: string }> }} De schone instelling.
 */
function sanitizeHostTasks(raw) {
  const checked = {};
  const source = raw && typeof raw === 'object' && raw.checked && typeof raw.checked === 'object' ? raw.checked : {};
  for (const id of Object.keys(source).slice(0, MAX_CHECKED)) {
    const entry = source[id];
    const at = entry && typeof entry === 'object' ? cleanTime(entry.at) : null;
    if (!TASK_ID.test(id) || !at) continue;
    checked[id] = { at, byName: String(entry.byName || '').slice(0, 80) };
  }
  return { checked };
}

/**
 * Maakt de servertaken-opslag.
 * @param {{ statusDir?: string, settings: { get: Function, update: Function }, tasks?: object[], now?: Function }} options
 *   statusDir (leeg = niet ingericht: dan kan de host niets afvinken), settings van de hoofdtenant, de lijst (voor tests) en de klok.
 * @returns {{ view: Function, setChecked: Function, pendingCount: Function, command: string }} De opslag.
 */
function createHostTasks({ statusDir = '', settings, tasks = HOST_TASKS, now = () => Date.now() }) {
  /**
   * Wat de host als gedaan heeft gemeld (id → tijdstip).
   * @returns {Object<string, string>} Alleen bekende taken met een geldig tijdstip.
   */
  const doneOnHost = () => {
    const ledger = statusDir ? readLedger(statusDir, 'host-tasks.json') : null;
    const done = {};
    const source = ledger && ledger.done && typeof ledger.done === 'object' ? ledger.done : {};
    for (const task of tasks) {
      const at = cleanTime(source[task.id]);
      if (at) done[task.id] = at;
    }
    return done;
  };

  /**
   * De lijst met taken en hun stand.
   * @returns {{ command: string, checkedAt: string|null, pending: number, tasks: object[] }} De weergave.
   */
  function view() {
    const host = doneOnHost();
    const manual = sanitizeHostTasks(settings.get('hostTasks')).checked;
    const list = tasks.map((task) => {
      const doneAt = host[task.id] || (manual[task.id] && manual[task.id].at) || null;
      return {
        id: task.id, title: task.title, description: task.description, addedAt: task.addedAt,
        done: Boolean(doneAt), doneAt, doneBy: host[task.id] ? 'server' : manual[task.id] ? 'handmatig' : null,
        doneByName: !host[task.id] && manual[task.id] ? manual[task.id].byName : '',
      };
    });
    const ledger = statusDir ? readLedger(statusDir, 'host-tasks.json') : null;
    return { command: HOST_COMMAND, checkedAt: ledger ? cleanTime(ledger.checkedAt) : null, pending: list.filter((task) => !task.done).length, tasks: list };
  }

  /**
   * Vinkt een taak met de hand af of weer uit (een taak die de host als gedaan meldt blijft gedaan).
   * @param {string} id De id van de taak.
   * @param {boolean} done true = afvinken, false = weer openzetten.
   * @param {string} byName Naam van wie het doet.
   * @returns {boolean} false als de taak niet bestaat.
   */
  function setChecked(id, done, byName) {
    if (!tasks.some((task) => task.id === id)) return false;
    const current = sanitizeHostTasks(settings.get('hostTasks')).checked;
    if (done) current[id] = { at: new Date(now()).toISOString(), byName: String(byName || '').slice(0, 80) };
    else delete current[id];
    settings.update({ hostTasks: { checked: current } });
    return true;
  }

  return { view, setChecked, pendingCount: () => view().pending, command: HOST_COMMAND };
}

module.exports = { createHostTasks, sanitizeHostTasks, HOST_TASKS, HOST_COMMAND };
