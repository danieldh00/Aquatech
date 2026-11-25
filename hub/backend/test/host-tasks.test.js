// Servertaken: de lijst in de app (platform/host-tasks.js) en het hostscript (deploy/apps01/pve/servertaken.sh, `openstaand`)
// blijven gelijk, het script legt gedane taken vast, de app vinkt ze af (ook met de hand) en alleen de beheerder van de
// hoofdtenant ziet ze (API en dashboard).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createHostTasks, sanitizeHostTasks, HOST_TASKS, HOST_COMMAND } = require('../src/platform/host-tasks');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'pve', 'servertaken.sh');
const SETUP_SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'setup-app-update.sh');
const PW = 'Tuin-Plan-2026!';
const REF = 'a'.repeat(40);
const FIRST = HOST_TASKS[0].id;

/**
 * Maakt een tijdelijke map.
 * @returns {string} Het pad.
 */
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-hosttasks-'));

/**
 * Nepinstellingen in het geheugen (get/update zoals de echte).
 * @returns {{ get: Function, update: Function }} De instellingen.
 */
function memorySettings() {
  const values = {};
  return { get: (key) => values[key], update: (patch) => Object.assign(values, patch) };
}

/**
 * Zet een nep-installatie klaar voor het hostscript: APP_DIR, een nepdocker en een "repo" met een nep-setupscript.
 * @param {string} setupBody Inhoud van het nepscript dat taak 001 ophaalt (bijv. `exit 0`).
 * @returns {{ appDir: string, run: Function }} De map en een functie die het script draait.
 */
function install(setupBody) {
  const root = tempDir();
  const appDir = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo', REF, 'deploy', 'apps01');
  fs.mkdirSync(path.join(appDir, 'update', 'status'), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(repo, { recursive: true });
  // De nepdocker kent het netwerk van de app (taak 008 leest daar het subnet uit).
  fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\ncase "$1 $2" in\n  "inspect aquatech") echo "aquatech_default ";;\n  "network inspect") echo "172.18.0.0/16 ";;\nesac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "$*" >> "$FAKE_SYSTEMCTL_LOG"\n[[ "$1" == "is-active" ]] && echo active\nexit 0\n', { mode: 0o755 });
  const systemdDir = path.join(root, 'systemd');
  fs.mkdirSync(systemdDir);
  fs.mkdirSync(path.join(repo, 'systemd'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'localdb'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'localdb', 'pg-backup.sh'), '#!/usr/bin/env bash\necho "back-up gemaakt" > "$APP_DIR/backup-gedraaid"\n', { mode: 0o755 });
  for (const script of ['restore-test.sh', 'restore-app-check.sh', 'restore-test-drive.sh']) fs.writeFileSync(path.join(repo, script), '#!/usr/bin/env bash\necho hersteltest\n', { mode: 0o755 });
  for (const unit of ['aquatech-restore-test.service', 'aquatech-restore-test.timer', 'aquatech-restore-test.path', 'aquatech-restore-test-drive.service', 'aquatech-restore-test-drive.path']) fs.writeFileSync(path.join(repo, 'systemd', unit), `[Unit]\nDescription=${unit}\n`);
  fs.mkdirSync(path.join(appDir, 'update', 'request'), { recursive: true });
  // Taak 012 haalt install-staging.sh op de vaste commit op en draait hem zonder invoer.
  fs.mkdirSync(path.join(repo, '..', 'staging'), { recursive: true });
  fs.writeFileSync(path.join(repo, '..', 'staging', 'install-staging.sh'), `#!/usr/bin/env bash\necho "staging ingericht" > "${path.join(root, 'staging-gedaan')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'grow-disk.sh'), `#!/usr/bin/env bash\necho "schijf vergroot" > "${path.join(root, 'schijf-gedaan')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'setup-app-update.sh'), `#!/usr/bin/env bash\necho "setup met \$SETUP_REF"\n${setupBody}\n`, { mode: 0o755 });
  // Een nep-cosign: de installatietaak haalt hem van een bestand en controleert de SHA-256 zoals bij het echte bestand.
  const cosignSource = path.join(root, 'cosign-download');
  fs.writeFileSync(cosignSource, '#!/usr/bin/env bash\necho cosign nep\n');
  const cosignEnv = { COSIGN_URL: `file://${cosignSource}`, COSIGN_SHA256: crypto.createHash('sha256').update(fs.readFileSync(cosignSource)).digest('hex'), COSIGN_BIN: path.join(root, 'cosign-geinstalleerd') };
  /**
   * Draait een opdracht van het script op de "server".
   * @param {string} command Bijv. openstaand-check.
   * @param {object} [extraEnv] Extra omgevingsvariabelen.
   * @returns {{ status: number, stdout: string, stderr: string }} De uitkomst.
   */
  const run = (command, extraEnv = {}) => {
    const out = spawnSync('bash', [SCRIPT, command], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, SERVERTAKEN_REMOTE: '1', APP_DIR: appDir, TASKS_BASE: `file://${path.join(root, 'repo')}`, SYSTEMD_DIR: systemdDir, FAKE_SYSTEMCTL_LOG: path.join(root, 'systemctl.log'), ...cosignEnv, ...extraEnv },
    });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  return { appDir, systemdDir, root, run, cosignEnv };
}

test('de lijst in de app en in het hostscript zijn gelijk, met unieke id\'s in het vaste formaat', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const block = /HOST_TASK_IDS=\(([^)]*)\)/.exec(script);
  assert.ok(block, 'HOST_TASK_IDS ontbreekt in servertaken.sh');
  const scriptIds = block[1].split(/\s+/).filter(Boolean);
  assert.deepStrictEqual(scriptIds, HOST_TASKS.map((task) => task.id));
  assert.strictEqual(new Set(scriptIds).size, scriptIds.length);
  for (const task of HOST_TASKS) {
    assert.match(task.id, /^[0-9]{3}-[a-z0-9-]+$/);
    assert.ok(task.title && task.description && /^\d{4}-\d{2}-\d{2}$/.test(task.addedAt), `taak ${task.id} is onvolledig`);
    assert.ok(script.includes(`hosttask_${task.id.replace(/-/g, '_')}() {`), `functie voor ${task.id} ontbreekt`);
  }
  assert.match(HOST_COMMAND, /servertaken\.sh/);
  assert.match(HOST_COMMAND, /bash "\$T" openstaand/);
  assert.match(HOST_COMMAND, /T=\$\(mktemp\)/, 'een eigen tijdelijk bestand, geen voorspelbaar pad in /tmp');
  assert.doesNotMatch(HOST_COMMAND, /\/tmp\//);
  assert.match(HOST_COMMAND, /APPS01_SSH=daniel@apps01/, 'het commando draait vanaf de Proxmox-host via daniel@apps01 + sudo');
  assert.ok(fs.readFileSync(SETUP_SCRIPT, 'utf8').includes('SETUP_REF'));
});

test('hostscript: openstaand voert de taak uit, legt hem vast en doet daarna niets meer', () => {
  const { appDir, systemdDir, root, run } = install('exit 0');
  assert.strictEqual(run('openstaand-check').status, 2, 'zonder TASKS_REF weigert het script');
  const check = run('openstaand-check', { TASKS_REF: REF });
  assert.strictEqual(check.status, 10, check.stderr);
  assert.ok(check.stdout.includes(FIRST));
  const done = run('openstaand-run', { TASKS_REF: REF });
  assert.strictEqual(done.status, 0, done.stderr + done.stdout);
  assert.ok(done.stdout.includes(`setup met ${REF}`), 'het script draait op de vaste commit');
  const ledger = JSON.parse(fs.readFileSync(path.join(appDir, 'update', 'status', 'host-tasks.json'), 'utf8'));
  for (const task of HOST_TASKS) assert.ok(Date.parse(ledger.done[task.id]) > 0, `${task.id} is vastgelegd`);
  assert.ok(fs.existsSync(path.join(appDir, 'restore-test.sh')), 'taak 002 installeert restore-test.sh');
  assert.ok(fs.existsSync(path.join(appDir, 'restore-test-drive.sh')) && fs.existsSync(path.join(appDir, 'restore-app-check.sh')), 'taak 007 installeert de Drive-app-controle');
  assert.ok(fs.readFileSync(path.join(appDir, '.env'), 'utf8').split('\n').includes('TRUSTED_PROXIES=172.18.0.0/16'), 'taak 008 zet het subnet van het compose-netwerk in .env');
  assert.ok(fs.existsSync(path.join(appDir, 'pg-backup.sh')), 'taak 004 installeert pg-backup.sh');
  assert.ok(fs.existsSync(path.join(appDir, 'backup-gedraaid')), 'taak 004 maakt direct een back-up');
  assert.deepStrictEqual(fs.readdirSync(systemdDir).sort(), ['aquatech-restore-test-drive.path', 'aquatech-restore-test-drive.service', 'aquatech-restore-test.path', 'aquatech-restore-test.service', 'aquatech-restore-test.timer']);
  assert.match(fs.readFileSync(path.join(root, 'systemctl.log'), 'utf8'), /enable --now aquatech-restore-test\.timer aquatech-restore-test\.path aquatech-restore-test-drive\.path/);
  assert.ok(fs.existsSync(path.join(root, 'cosign-geinstalleerd')), 'taak 011 installeert cosign');
  assert.ok(fs.existsSync(path.join(root, 'staging-gedaan')), 'taak 012 draait install-staging.sh van de vaste commit');
  assert.ok(fs.existsSync(path.join(root, 'schijf-gedaan')), 'taak 013 draait grow-disk.sh van de vaste commit');
  assert.ok(Date.parse(ledger.checkedAt) > 0);
  const again = run('openstaand-check', { TASKS_REF: REF });
  assert.strictEqual(again.status, 0);
  assert.ok(again.stdout.includes('Niets te doen'));
});

test('hostscript: een mislukte taak blijft open en wordt niet vastgelegd', () => {
  const { appDir, run } = install('exit 3');
  const out = run('openstaand-run', { TASKS_REF: REF });
  assert.notStrictEqual(out.status, 0);
  assert.ok(!fs.existsSync(path.join(appDir, 'update', 'status', 'host-tasks.json')), 'niets vastgelegd');
  assert.strictEqual(run('openstaand-check', { TASKS_REF: REF }).status, 10);
});

test('opslag: de host meldt gedaan, met de hand afvinken en weer openzetten, onzin wordt genegeerd', () => {
  const statusDir = tempDir();
  const settings = memorySettings();
  const tasks = createHostTasks({ statusDir, settings });
  assert.strictEqual(tasks.view().pending, HOST_TASKS.length);
  assert.strictEqual(tasks.setChecked('999-bestaat-niet', true, 'Bert'), false);
  assert.strictEqual(tasks.setChecked(FIRST, true, 'Bert'), true);
  let entry = tasks.view().tasks[0];
  assert.deepStrictEqual([entry.done, entry.doneBy, entry.doneByName], [true, 'handmatig', 'Bert']);
  tasks.setChecked(FIRST, false, 'Bert');
  assert.strictEqual(tasks.view().tasks[0].done, false);
  fs.writeFileSync(path.join(statusDir, 'host-tasks.json'), JSON.stringify({ done: { [FIRST]: '2026-11-19T10:00:00Z', '777-onbekend': '2026-11-19T10:00:00Z' }, checkedAt: '2026-11-19T10:05:00Z' }));
  entry = tasks.view().tasks[0];
  assert.deepStrictEqual([entry.done, entry.doneBy], [true, 'server']);
  assert.strictEqual(tasks.view().pending, HOST_TASKS.length - 1);
  fs.writeFileSync(path.join(statusDir, 'host-tasks.json'), '{kapot');
  assert.strictEqual(tasks.view().pending, HOST_TASKS.length, 'een kapot bestand telt als niets gedaan');
  assert.deepStrictEqual(sanitizeHostTasks({ checked: { 'x': { at: 'nu' }, [FIRST]: { at: '2026-11-19T10:00:00Z', byName: 'Bert' } } }), { checked: { [FIRST]: { at: '2026-11-19T10:00:00.000Z', byName: 'Bert' } } });
});

/**
 * Testserver met een statusmap: beheerder 'bert' en installateur 'kees' in de hoofdtenant, en een tweede organisatie met 'gerda'.
 * @returns {Promise<object>} server, base, as en statusDir.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'bert', displayName: 'Bert', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const root = tempDir();
  const statusDir = path.join(root, 'status');
  const requestDir = path.join(root, 'request');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(requestDir);
  const app = createApp({ secret: 'h'.repeat(64), db, env: { UPDATE_STATUS_DIR: statusDir, UPDATE_REQUEST_DIR: requestDir }, loginDelayMs: 0 });
  const { server, base } = await listen(app);
  return { server, base, as: createLogin(base, { password: PW }), statusDir, store, main };
}

test('API en dashboard: alleen de beheerder van de hoofdtenant, afvinken met auditlog, host-melding haalt het blok weg', async () => {
  const { server, base, as, statusDir, store, main } = await setup();
  try {
    const bert = await as('bert');
    const kees = await as('kees');
    assert.strictEqual((await createClient(base).get('/app/api/admin/host-tasks')).status, 401);
    assert.strictEqual((await kees.get('/app/api/admin/host-tasks')).status, 403);
    assert.strictEqual((await kees.put(`/app/api/admin/host-tasks/${FIRST}`, { done: true })).status, 403);

    const list = await bert.get('/app/api/admin/host-tasks');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.pending, HOST_TASKS.length);
    assert.strictEqual(list.body.command, HOST_COMMAND);

    const dashboard = (await bert.get('/app/api/tasks')).body.tasks.find((task) => task.key === 'servertaken');
    assert.ok(dashboard, 'het dashboard toont de servertaken');
    assert.strictEqual(dashboard.command, HOST_COMMAND);
    assert.strictEqual(dashboard.count, HOST_TASKS.length);
    assert.ok(!(await kees.get('/app/api/tasks')).body.tasks.some((task) => task.key === 'servertaken'), 'een installateur ziet ze niet');

    assert.strictEqual((await bert.put(`/app/api/admin/host-tasks/${FIRST}`, { done: 'ja' })).status, 400);
    assert.strictEqual((await bert.put('/app/api/admin/host-tasks/999-niet', { done: true })).status, 404);
    const ticked = await bert.put(`/app/api/admin/host-tasks/${FIRST}`, { done: true });
    assert.strictEqual(ticked.status, 200);
    assert.strictEqual(ticked.body.pending, HOST_TASKS.length - 1);
    for (const task of HOST_TASKS.slice(1)) await bert.put(`/app/api/admin/host-tasks/${task.id}`, { done: true });
    assert.strictEqual((await bert.get('/app/api/admin/host-tasks')).body.pending, 0);
    assert.ok(!(await bert.get('/app/api/tasks')).body.tasks.some((task) => task.key === 'servertaken'), 'afgevinkt = blok weg');
    await bert.put(`/app/api/admin/host-tasks/${FIRST}`, { done: false });
    assert.strictEqual((await bert.get('/app/api/admin/host-tasks')).body.pending, 1);

    fs.writeFileSync(path.join(statusDir, 'host-tasks.json'), JSON.stringify({ done: { [FIRST]: new Date().toISOString() } }));
    assert.strictEqual((await bert.get('/app/api/admin/host-tasks')).body.tasks[0].doneBy, 'server');
    const actions = store.listAudit(main, { limit: 20 }).items.map((row) => row.action);
    assert.ok(actions.includes('servertaak_afgevinkt') && actions.includes('servertaak_heropend'));
  } finally {
    server.close();
  }
});

test('hostscript: taak 011 installeert cosign niet als de SHA-256 niet klopt', () => {
  const { root, run } = install('exit 0');
  const out = run('openstaand-run', { TASKS_REF: REF, COSIGN_SHA256: '0'.repeat(64) });
  assert.notStrictEqual(out.status, 0);
  assert.match(out.stderr, /SHA-256 van cosign klopt niet/);
  assert.ok(!fs.existsSync(path.join(root, 'cosign-geinstalleerd')), 'niets geïnstalleerd');
});

test('grow-disk.sh: gewone ext4-partitie wordt vergroot, daarna is een herhaling onschadelijk', () => {
  const root = tempDir();
  const bin = path.join(root, 'bin');
  const sys = path.join(root, 'sys', 'sda1');
  fs.mkdirSync(bin);
  fs.mkdirSync(sys, { recursive: true });
  fs.writeFileSync(path.join(sys, 'partition'), '1\n');
  const log = path.join(root, 'calls.log');
  const fake = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  fake('id', 'echo 0');
  fake('findmnt', 'case "$*" in *SOURCE*) echo /dev/sda1;; *) echo ext4;; esac');
  fake('lsblk', 'case "$*" in *PKNAME*) echo sda;; *) echo part;; esac');
  fake('readlink', 'echo /dev/sda1');
  fake('df', 'echo "/dev/sda1 30G 10G 20G 33% /"');
  fake('growpart', `echo "growpart $*" >> "${log}"; [[ -e "${root}/gegroeid" ]] && { echo "NOCHANGE: partition 1 is size 1 it cannot be grown"; exit 1; }; touch "${root}/gegroeid"; echo CHANGED`);
  fake('resize2fs', `echo "resize2fs $*" >> "${log}"`);
  const run = () => spawnSync('bash', [path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'grow-disk.sh')], {
    encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, SYS_BLOCK: path.join(root, 'sys') },
  });
  const first = run();
  assert.strictEqual(first.status, 0, first.stderr + first.stdout);
  const second = run();
  assert.strictEqual(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /al zo groot als kan/);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /growpart \/dev\/sda 1/);
  assert.match(calls, /resize2fs \/dev\/sda1/);
});
