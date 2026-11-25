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

/** Eén vast commando voor de Proxmox-host (als root): haalt de nieuwste lijst van master op en pint hem op de exacte commit; het script gaat naar een eigen tijdelijk bestand (mktemp, geen voorspelbaar pad in /tmp) dat daarna wordt opgeruimd. */
const HOST_COMMAND = [
  "REF=$(curl -fsSL -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/danieldh00/Aquatech/commits/master)",
  '&& T=$(mktemp) && trap \'rm -f "$T"\' EXIT',
  '&& curl -fsSL "https://raw.githubusercontent.com/danieldh00/Aquatech/$REF/deploy/apps01/pve/servertaken.sh" -o "$T"',
  '&& APPS01_SSH=daniel@apps01 TASKS_REF="$REF" bash "$T" openstaand',
].join(' ');

/**
 * Alle servertaken in de volgorde waarin het hostscript ze uitvoert (meestal oudste eerst; taak 013 staat voor 012, omdat de
 * stagingomgeving veel vrije schijfruimte vraagt en 013 de schijf vergroot). Een nieuwe taak komt onderaan met een nieuwe id; een bestaande id verandert nooit
 * (de id is wat het hostscript als gedaan onthoudt).
 */
const HOST_TASKS = [
  {
    id: '001-app-update-opnieuw-inrichten',
    title: 'Updaten vanuit de app opnieuw inrichten',
    description: 'Haalt update.sh, compose.yml en de systemd-units opnieuw op en maakt de container opnieuw (ca. 1 minuut niet beschikbaar). Nodig na de wijziging in PR #300.',
    addedAt: '2026-11-19',
  },
  {
    id: '002-hersteltest-back-up-inrichten',
    title: 'Wekelijkse hersteltest van de back-up inrichten',
    description: 'Installeert restore-test.sh met een timer en een path-unit op apps01. Daarna zet de server elke week de nieuwste back-up terug in een wegwerpcontainer (768 MB, zonder netwerk) en toont Beheer > Systeem > Hersteltest de uitslag.',
    addedAt: '2026-11-20',
  },
  {
    id: '003-hersteltest-script-bijwerken',
    title: 'Hersteltest-script bijwerken',
    description: 'Installeert de nieuwste restore-test.sh op apps01 (maakt zelf een back-up als backups/postgres leeg is en meldt precies wat er mis is). Een app-update vernieuwt dit hostscript niet; zonder deze taak blijft de oude melding "Er is geen back-up gevonden" komen.',
    addedAt: '2026-11-20',
  },
  {
    id: '004-pg-back-up-script-herstellen',
    title: 'Dagelijkse database-back-up herstellen',
    description: 'Installeert de herstelde pg-backup.sh en restore-test.sh op apps01 en maakt meteen een back-up. De oude controle keurde elke back-up groter dan een paar tientallen kB af ("error writing output file"), waardoor er geen enkele bewaard bleef. Daarna werkt ook de lokale hersteltest.',
    addedAt: '2026-11-20',
  },
  {
    id: '005-hersteltest-app-controle',
    title: 'Hersteltest met app-controle bijwerken',
    description: 'Installeert de nieuwste restore-test.sh op apps01. De hersteltest start daarna ook een wegwerp-app (hoogstens 512 MB, intern netwerk zonder uitgang, geen mail of koppelingen) op de teruggezette database en controleert dat die inlogt en gegevens ophaalt.',
    addedAt: '2026-11-20',
  },
  {
    id: '006-database-grootte-en-indexgebruik',
    title: 'Database: tabelgroottes en indexgebruik opvragen (alleen lezen)',
    description: 'Toont de 25 grootste tabellen en de ongebruikte indexen van de productiedatabase en bewaart dat in update/status/db-stats.txt. Er wordt niets gewijzigd en er verschijnen geen gegevens, alleen namen en groottes. Plak de uitvoer in de thread: hij bepaalt of de zware kolomomzettingen (tijdstippen) veilig zijn.',
    addedAt: '2026-11-20',
  },
  {
    id: '007-hersteltest-drive-app-controle',
    title: 'Hersteltest Google Drive met app-controle inrichten',
    description: 'Installeert restore-test-drive.sh, restore-app-check.sh en een path-unit op apps01 (en vernieuwt de lokale hersteltest). De hersteltest van de Google Drive-back-up zet de gedownloade back-up daarna ook terug in een wegwerpdatabase en start er een wegwerp-app op (hoogstens 512 MB, intern netwerk zonder uitgang, geen mail of koppelingen) die inlogt en gegevens ophaalt.',
    addedAt: '2026-11-20',
  },
  {
    id: '008-vertrouwde-proxy-instellen',
    title: 'Vertrouwde proxy van de app instellen',
    description: 'Zet in .env het subnet van het compose-netwerk als TRUSTED_PROXIES en vernieuwt compose.yml (ca. 1 minuut niet beschikbaar). Daarna gelooft de app het bezoeker-IP uit CF-Connecting-IP alleen van het compose-netwerk en niet meer van elk ander privé-adres. Beperking: een verbinding via de gepubliceerde poort 3300 (Tailscale) komt via de Docker-gateway binnen en blijft dus vertrouwd.',
    addedAt: '2026-11-23',
  },
  {
    id: '009-update-script-stopt-bij-mislukte-back-up',
    title: 'Updatescript bijwerken: stoppen als de back-up mislukt',
    description: 'Installeert de nieuwste update.sh op apps01 (zelfde stappen als taak 001, ca. 1 minuut niet beschikbaar). Daarna gaat een update niet meer door en migreert niet meer als de back-up vooraf mislukt (schijf vol, sleutel, time-out); de huidige versie blijft dan draaien.',
    addedAt: '2026-11-23',
  },
  {
    id: '010-back-up-integriteitscontrole',
    title: 'Back-ups met integriteitscontrole (HMAC)',
    description: 'Vernieuwt pg-backup.sh en restore-test.sh op apps01 en maakt direct een back-up. Elke dump krijgt daarna een .hmac-bestand ernaast; terugzetten en de hersteltest weigeren een dump waarvan de controle niet klopt. Oude back-ups zonder .hmac blijven werken (met een opmerking).',
    addedAt: '2026-11-23',
  },
  {
    id: '011-image-handtekening-controleren',
    title: 'Handtekening van het image controleren (cosign)',
    description: 'Vernieuwt update.sh (zelfde stappen als taak 001, ca. 1 minuut niet beschikbaar) en installeert cosign op apps01 (vaste versie, SHA-256 gecontroleerd). Daarna rolt update.sh alleen een image uit waarvan de handtekening van release.yml klopt. Pas uitvoeren nadat de PR met het ondertekenen is samengevoegd en een nieuwe versie is gebouwd: een eerdere, niet-ondertekende versie wordt dan geweigerd. Zet IMAGE_SIGNATURE=required in .env om cosign verplicht te stellen, of off om de controle uit te zetten.',
    addedAt: '2026-11-23',
  },
  {
    id: '013-schijf-apps01-vergroten',
    title: 'Schijf van apps01 vergroten (na vergroten in Proxmox)',
    description: 'De virtuele schijf is in Proxmox groter gemaakt, maar de VM gebruikt nog de oude grootte. Deze taak laat de VM de nieuwe grootte inlezen en vergroot de partitie, eventueel de LVM-volume en het bestandssysteem tot de hele schijf (ext4, xfs of btrfs worden herkend). Zonder herstart en zonder stilstand van de app; is alles al vergroot, dan verandert er niets. De bewakingscontrole Vrije schijfruimte gebruikt de nieuwe grootte daarna vanzelf.',
    addedAt: '2026-11-25',
  },
  {
    id: '012-staging-op-apps01-inrichten',
    title: 'Stagingomgeving op apps01 inrichten (Vue-migratie)',
    description: 'Richt een tweede, aparte opstelling in naast de testomgeving (eigen map, database, geheimen en image; alleen de server en de bestaande tunnel worden gedeeld) die de branch develop volgt en zichzelf elke 15 minuten bijwerkt. Het image wordt op de server gebouwd; de database wordt gevuld met verzonnen testdata; er zijn geen koppelingen of mail. Daarna moet je zelf in de bestaande Cloudflare-tunnel de hostnaam aquatech-staging.den-hollander.com naar http://aquatech-staging:3300 laten wijzen en een Access-toepassing maken die alleen jou toelaat; het script drukt dat aan het eind af. De testomgeving blijft gewoon draaien.',
    addedAt: '2026-11-25',
  },
  {
    id: '014-staging-alias-botsing-herstellen',
    title: 'Staging herstellen: naamsbotsing met de testomgeving oplossen',
    description: 'De stagingcontainer droeg in het gedeelde tunnelnetwerk ook de naam aquatech, waardoor een deel van het verkeer naar de testomgeving bij staging uitkwam (stagingbalk, opnieuw inloggen). Deze taak ruimt de oude stagingcontainers op en maakt ze opnieuw aan onder eigen servicenamen (aquatech-staging-app en aquatech-staging-db). De gegevens van staging blijven staan; de testomgeving wordt niet aangeraakt. Draai dit zo snel mogelijk.',
    addedAt: '2026-11-25',
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
   * @param {object|null} ledger Het gelezen host-tasks.json (of null).
   * @returns {Object<string, string>} Alleen bekende taken met een geldig tijdstip.
   */
  const doneOnHost = (ledger) => {
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
    const ledger = statusDir ? readLedger(statusDir, 'host-tasks.json') : null;
    const host = doneOnHost(ledger);
    const manual = sanitizeHostTasks(settings.get('hostTasks')).checked;
    const list = tasks.map((task) => {
      const doneAt = host[task.id] || (manual[task.id] && manual[task.id].at) || null;
      return {
        id: task.id, title: task.title, description: task.description, addedAt: task.addedAt,
        done: Boolean(doneAt), doneAt, doneBy: host[task.id] ? 'server' : manual[task.id] ? 'handmatig' : null,
        doneByName: !host[task.id] && manual[task.id] ? manual[task.id].byName : '',
      };
    });
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
