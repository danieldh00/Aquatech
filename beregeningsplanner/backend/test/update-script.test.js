// Het updatescript van de server (deploy/apps01/update.sh) met een nagebootste docker: aanvraag uit de app
// controleren, onderhoudsmodus tijdens het wisselen, terugzetten bij een mislukte health check, automatisch
// bijwerken aan/uit, en geen vertrouwen in de aanvraagmap (symlinks, verkeerde versie).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'update.sh');
const REQUEST_ID = '0b7c2a4e-1d2f-4a6b-9c8d-123456789abc';

// Nagebootste docker: houdt in state/ bij welke versie draait en logt elke aanroep. Bij `compose stop` legt hij vast of
// de onderhoudsmodus aan stond. FAKE_LATEST = versie op :latest, FAKE_BAD = versie die niet healthy wordt.
const FAKE_DOCKER = `#!/usr/bin/env bash
state="$FAKE_STATE"
echo "$*" >> "$state/calls.log"
running() { sed -n 's/^AQUATECH_TAG=//p' "$APP_DIR/.env" | tail -n1; }
case "$1" in
  pull) exit 0 ;;
  image)
    if [[ "$2" == "inspect" ]]; then echo "$FAKE_LATEST"; fi; exit 0 ;;
  run) echo '{"version":"'"$FAKE_LATEST"'","releases":[{"version":"'"$FAKE_LATEST"'","date":"2026-11-13","title":"Nieuw","items":[{"text":"Punt"}]}]}'; exit 0 ;;
  inspect)
    if [[ "$(running)" == "$FAKE_BAD" ]]; then echo starting; else echo healthy; fi; exit 0 ;;
  exec)
    want="\${@: -1}"
    [[ "$(running)" == "$want" && "$want" != "$FAKE_BAD" ]] && exit 0 || exit 1 ;;
  compose)
    case "$2" in
      stop) [[ -f "$APP_DIR/update/status/maintenance.json" ]] && echo yes > "$state/maintenance-at-stop" || echo no > "$state/maintenance-at-stop"; exit 0 ;;
      up) running >> "$state/started.log"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
`;

/**
 * Maakt een nep-installatie (APP_DIR) met .env, hoofdsleutel, compose.yml en de updatemappen, plus een map met de nep-docker.
 * @param {object} [options] current (draaiende versie), failed (inhoud van .failed-version).
 * @returns {object} appDir, statusDir, requestDir, state (logmap) en run (script draaien).
 */
function install({ current = '1.14.1', failed = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-update-'));
  const appDir = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const dir of [appDir, bin, state, path.join(appDir, 'secrets'), path.join(appDir, 'update', 'status'), path.join(appDir, 'update', 'request')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), `AQUATECH_TAG=${current}\nTZ=Europe/Amsterdam\n`);
  fs.writeFileSync(path.join(appDir, 'secrets', 'master-key'), 'x'.repeat(64));
  fs.writeFileSync(path.join(appDir, 'compose.yml'), 'services:\n  aquatech:\n    environment:\n      - DATABASE_URL_FILE=/run/secrets/database-url\n');
  if (failed) fs.writeFileSync(path.join(appDir, '.failed-version'), `${failed}\n`);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const statusDir = path.join(appDir, 'update', 'status');
  const requestDir = path.join(appDir, 'update', 'request');
  /**
   * Draait update.sh met de nep-docker.
   * @param {object} env FAKE_LATEST en eventueel FAKE_BAD.
   * @returns {object} status (exitcode), output en tag (versie in .env daarna).
   */
  const run = (env) => {
    const result = spawnSync('bash', [SCRIPT], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_DIR: appDir, FAKE_STATE: state, DRAIN_SECONDS: '0', HEALTH_TRIES: '1', FAKE_BAD: '', ...env },
      encoding: 'utf8', timeout: 60000,
    });
    const tag = /AQUATECH_TAG=(.*)/.exec(fs.readFileSync(path.join(appDir, '.env'), 'utf8'))[1];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, tag };
  };
  return { root, appDir, statusDir, requestDir, state, run };
}

/**
 * Leest een JSON-bestand uit de statusmap.
 * @param {string} dir De statusmap.
 * @param {string} name Bestandsnaam.
 * @returns {object|null} De inhoud, of null als het bestand er niet is.
 */
const readStatus = (dir, name) => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : null);

/**
 * Zet een aanvraag van de app neer.
 * @param {string} requestDir De aanvraagmap.
 * @param {string} version De gevraagde versie.
 * @returns {void}
 */
const putRequest = (requestDir, version) => fs.writeFileSync(path.join(requestDir, 'request.json'), JSON.stringify({ id: REQUEST_ID, version, requestedAt: new Date().toISOString(), by: 'u1', byName: 'Baas' }));

const bashAvailable = spawnSync('bash', ['-c', 'command -v flock']).status === 0;

test('update.sh: automatisch bijwerken installeert een nieuwere versie met onderhoudsmodus en schrijft de status', { skip: !bashAvailable }, () => {
  const setup = install();
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.2');
  assert.strictEqual(fs.readFileSync(path.join(setup.state, 'maintenance-at-stop'), 'utf8').trim(), 'yes', 'onderhoudsmodus aan tijdens het wisselen');
  assert.ok(!fs.existsSync(path.join(setup.statusDir, 'maintenance.json')), 'onderhoudsmodus daarna uit');
  const run = readStatus(setup.statusDir, 'run.json');
  assert.strictEqual(run.state, 'geslaagd');
  assert.strictEqual(run.automatic, true);
  assert.strictEqual(run.version, '1.14.2');
  assert.deepStrictEqual(readStatus(setup.statusDir, 'status.json').current, '1.14.2');
  assert.strictEqual(readStatus(setup.statusDir, 'releases.json').releases[0].title, 'Nieuw');
  assert.ok(fs.readFileSync(path.join(setup.state, 'calls.log'), 'utf8').includes('node src/backup.js create'), 'eerst een back-up');
});

test('update.sh: automatisch uit installeert niets, maar meldt wel de beschikbare versie', { skip: !bashAvailable }, () => {
  const setup = install();
  fs.writeFileSync(path.join(setup.requestDir, 'policy.json'), '{"auto":false}');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.1');
  const status = readStatus(setup.statusDir, 'status.json');
  assert.strictEqual(status.available, '1.14.2');
  assert.strictEqual(status.auto, false);
  assert.strictEqual(readStatus(setup.statusDir, 'run.json'), null);
});

test('update.sh: aanvraag uit de app installeert, ook met automatisch uit, en ook een eerder mislukte versie', { skip: !bashAvailable }, () => {
  const setup = install({ failed: '1.14.2' });
  fs.writeFileSync(path.join(setup.requestDir, 'policy.json'), '{"auto":false}');
  putRequest(setup.requestDir, '1.14.2');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.2');
  assert.ok(!fs.existsSync(path.join(setup.requestDir, 'request.json')), 'aanvraag is weggehaald');
  const run = readStatus(setup.statusDir, 'run.json');
  assert.strictEqual(run.state, 'geslaagd');
  assert.strictEqual(run.requestId, REQUEST_ID);
  assert.strictEqual(run.automatic, false);
  assert.ok(!fs.existsSync(path.join(setup.appDir, '.failed-version')));
});

test('update.sh: aanvraag voor een andere versie dan op GHCR staat wordt geweigerd', { skip: !bashAvailable }, () => {
  const setup = install();
  putRequest(setup.requestDir, '9.9.9');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.1');
  const run = readStatus(setup.statusDir, 'run.json');
  assert.strictEqual(run.state, 'geweigerd');
  assert.match(run.message, /9\.9\.9/);
  assert.ok(!fs.existsSync(path.join(setup.requestDir, 'request.json')));
  assert.ok(!fs.existsSync(path.join(setup.state, 'started.log')), 'niets herstart');
});

test('update.sh: onleesbare of gesymlinkte aanvraag installeert niets en wordt weggehaald', { skip: !bashAvailable }, () => {
  const setup = install();
  const secret = path.join(setup.root, 'geheim.json');
  fs.writeFileSync(secret, JSON.stringify({ id: REQUEST_ID, version: '1.14.2' }));
  fs.symlinkSync(secret, path.join(setup.requestDir, 'request.json'));
  fs.writeFileSync(path.join(setup.requestDir, 'policy.json'), '{"auto":false}');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.1', 'een symlink telt niet als aanvraag');
  assert.strictEqual(readStatus(setup.statusDir, 'run.json').state, 'geweigerd');
  assert.ok(!fs.existsSync(path.join(setup.requestDir, 'request.json')), 'de symlink is weg');
  assert.ok(fs.existsSync(secret), 'het doel van de symlink is niet aangeraakt');
});

test('update.sh: health check faalt → terug naar de vorige versie, versie overgeslagen, onderhoudsmodus uit', { skip: !bashAvailable }, () => {
  const setup = install();
  const out = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BAD: '1.14.2' });
  assert.strictEqual(out.status, 1, out.output);
  assert.strictEqual(out.tag, '1.14.1');
  assert.strictEqual(fs.readFileSync(path.join(setup.appDir, '.failed-version'), 'utf8').trim(), '1.14.2');
  assert.ok(!fs.existsSync(path.join(setup.statusDir, 'maintenance.json')));
  const run = readStatus(setup.statusDir, 'run.json');
  assert.strictEqual(run.state, 'mislukt');
  assert.match(run.message, /1\.14\.1 draait weer/);
  assert.deepStrictEqual(fs.readFileSync(path.join(setup.state, 'started.log'), 'utf8').trim().split('\n'), ['1.14.2', '1.14.1']);
  // De volgende automatische ronde slaat die versie over.
  const again = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BAD: '1.14.2' });
  assert.strictEqual(again.status, 0, again.output);
  assert.match(again.output, /faalde eerder/);
});

test('update.sh: zelfde of oudere versie op GHCR doet niets', { skip: !bashAvailable }, () => {
  const setup = install({ current: '1.14.2' });
  assert.strictEqual(setup.run({ FAKE_LATEST: '1.14.2' }).tag, '1.14.2');
  assert.strictEqual(setup.run({ FAKE_LATEST: '1.14.0' }).tag, '1.14.2');
  putRequest(setup.requestDir, '1.14.0');
  setup.run({ FAKE_LATEST: '1.14.0' });
  assert.strictEqual(readStatus(setup.statusDir, 'run.json').state, 'geweigerd');
});
