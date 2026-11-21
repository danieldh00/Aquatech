// Het hostscript van de app-controle van de Drive-hersteltest (deploy/apps01/restore-test-drive.sh) met een nagebootste docker:
// geslaagd, mislukt terugzetten, mislukte app, ongeldige aanvragen, opruimen en dat de app de uitslag kan lezen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createDriveAppCheck } = require('../src/platform/drive-restore-app-check');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'restore-test-drive.sh');
const ID = '3f1c6b0e-5a3d-4c1b-9a77-0d2f6a1b2c3d';

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/calls.log"
case "$1" in
  inspect) echo "ghcr.io/danieldh00/aquatech:1.0.0"; exit 0 ;;
  network) exit 0 ;;
  run)
    if [[ "$*" == *driveimport* ]]; then
      [[ "$*" == *AQUATECH_RESTORE_TEST=1* && "$*" == *"restore-into /in/backup.db.enc"* ]] || exit 9
      [[ "$*" == *"--network aquatech-drivenet-"* ]] || exit 9
      [[ -n "\${FAKE_IMPORT_FAIL:-}" ]] && { echo "Terugzetten mislukt: kapot" >&2; exit 1; }
      exit 0
    fi
    if [[ "$*" == *driveapp* ]]; then exit \${FAKE_APP_RUN_EXIT:-0}; fi
    exit 0 ;;
  rm) exit 0 ;;
  exec)
    shift
    while [[ "$1" == -* ]]; do shift; done
    shift
    case "$1" in
      pg_isready) exit 0 ;;
      node)
        if [[ "$2" == "-e" ]]; then exit 0; fi
        cat >/dev/null
        echo "ok|App leest de teruggezette gegevens (geen eerste start)"
        echo "\${FAKE_APP_LOGIN:-ok}|Inloggen als beheerder op de teruggezette gegevens"
        echo "ok|Gebruikers ophalen"
        exit 0 ;;
    esac ;;
esac
exit 0
`;

/**
 * Maakt een nep-installatie met een aanvraag van de app.
 * @param {object} [options] request (false = geen aanvraag), backup (false = geen bestand) en id.
 * @returns {object} appDir, statusDir, handover, state en run().
 */
function install({ request = true, backup = true, id = ID } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-drive-'));
  const appDir = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const statusDir = path.join(appDir, 'update', 'status');
  const handover = path.join(appDir, 'update', 'request', 'drive-restore');
  for (const dir of [bin, state, statusDir, handover, path.join(appDir, 'secrets')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'secrets', 'master-key'), 'k'.repeat(64));
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  if (backup) fs.writeFileSync(path.join(handover, 'backup.db.enc'), 'versleuteld');
  if (request) fs.writeFileSync(path.join(handover, 'request.json'), JSON.stringify({ id, name: 'aquatech-20261120-040000.db.enc' }));
  /**
   * Draait het script met de nep-docker.
   * @param {object} [extraEnv] Extra omgevingsvariabelen.
   * @returns {object} Het resultaat van spawnSync.
   */
  const run = (extraEnv = {}) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, APP_DIR: appDir, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, ...extraEnv },
  });
  return { appDir, statusDir, handover, state, run };
}

/**
 * Leest de uitslag van het script.
 * @param {string} statusDir De statusmap.
 * @returns {object} De inhoud.
 */
const readStatus = (statusDir) => JSON.parse(fs.readFileSync(path.join(statusDir, 'drive-restore-app.json'), 'utf8'));

test('geslaagd: terugzetten in een wegwerpdatabase, wegwerp-app, opruimen en door de app te lezen', async () => {
  const env = install();
  const result = env.run();
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const status = readStatus(env.statusDir);
  assert.strictEqual(status.id, ID);
  assert.strictEqual(status.state, 'klaar', status.message);
  assert.ok(status.sanity.every((item) => item.ok));
  assert.ok(status.sanity.some((item) => /Drive-back-up teruggezet/.test(item.name)));
  assert.ok(status.sanity.some((item) => /Inloggen als beheerder/.test(item.name)));
  const calls = fs.readFileSync(path.join(env.state, 'calls.log'), 'utf8');
  assert.match(calls, /network create --internal aquatech-drivenet-\d+/);
  assert.match(calls, /run --rm --name aquatech-driveimport-\d+ --memory 512m/);
  assert.match(calls, /run -d --name aquatech-driveapp-\d+ --memory 512m/);
  assert.match(calls, /network rm aquatech-drivenet-\d+/);
  assert.deepStrictEqual(fs.readdirSync(env.handover), [], 'back-up en aanvraag weggehaald');
  // De app kan de uitslag lezen (zelfde id).
  const check = createDriveAppCheck({ statusDir: env.statusDir, requestDir: path.join(env.appDir, 'update', 'request'), pollMs: 1, sleep: async () => {} });
  assert.ok(check.available);
});

test('mislukt: de back-up laat zich niet terugzetten', () => {
  const env = install();
  assert.strictEqual(env.run({ FAKE_IMPORT_FAIL: '1' }).status, 1);
  const status = readStatus(env.statusDir);
  assert.strictEqual(status.state, 'mislukt');
  assert.match(status.message, /kapot/);
  assert.deepStrictEqual(fs.readdirSync(env.handover), []);
});

test('mislukt: de app kan niet inloggen op de teruggezette gegevens of start niet', () => {
  let env = install();
  assert.strictEqual(env.run({ FAKE_APP_LOGIN: 'fail' }).status, 1);
  assert.strictEqual(readStatus(env.statusDir).state, 'mislukt');
  env = install();
  assert.strictEqual(env.run({ FAKE_APP_RUN_EXIT: '1' }).status, 1);
  assert.ok(readStatus(env.statusDir).sanity.some((item) => !item.ok));
});

test('geen aanvraag, ongeldig id, symlink of ontbrekende back-up: niets gedraaid of netjes mislukt', () => {
  let env = install({ request: false });
  assert.strictEqual(env.run().status, 0);
  assert.ok(!fs.existsSync(path.join(env.statusDir, 'drive-restore-app.json')));
  env = install({ id: 'geen-uuid' });
  assert.strictEqual(env.run().status, 0);
  assert.ok(!fs.existsSync(path.join(env.statusDir, 'drive-restore-app.json')));
  env = install({ backup: false });
  assert.strictEqual(env.run().status, 1);
  assert.strictEqual(readStatus(env.statusDir).state, 'mislukt');
  env = install({ backup: false });
  fs.symlinkSync('/etc/hostname', path.join(env.handover, 'backup.db.enc'));
  assert.strictEqual(env.run().status, 1);
  assert.match(readStatus(env.statusDir).message, /geen gewoon bestand/);
  assert.ok(!/run --rm/.test(fs.existsSync(path.join(env.state, 'calls.log')) ? fs.readFileSync(path.join(env.state, 'calls.log'), 'utf8') : ''), 'een symlink wordt nooit gebruikt');
});
