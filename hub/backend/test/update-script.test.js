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
    if [[ "$2" == "inspect" && "$*" == *RepoDigests* ]]; then echo "ghcr.io/danieldh00/aquatech@sha256:$(printf 'a%.0s' $(seq 64))";
    elif [[ "$2" == "inspect" ]]; then echo "$FAKE_LATEST"; fi
    if [[ "$2" == "ls" ]]; then for tag in $FAKE_TAGS; do echo "$tag"; done; fi
    exit 0 ;;
  run) echo '{"version":"'"$FAKE_LATEST"'","releases":[{"version":"'"$FAKE_LATEST"'","date":"2026-11-13","title":"Nieuw","items":[{"text":"Punt"}]}]}'; exit 0 ;;
  inspect)
    if [[ "$(running)" == "$FAKE_BAD" ]]; then echo starting; else echo healthy; fi; exit 0 ;;
  exec)
    want="\${@: -1}"
    [[ "$(running)" == "$want" && "$want" != "$FAKE_BAD" ]] && exit 0 || exit 1 ;;
  compose)
    case "$2" in
      stop) [[ -f "$APP_DIR/update/status/maintenance.json" ]] && echo yes > "$state/maintenance-at-stop" || echo no > "$state/maintenance-at-stop"; exit 0 ;;
      exec) if [[ "$*" == *"backup.js create"* ]]; then exit "\${FAKE_BACKUP_EXIT:-0}"; fi; exit 0 ;;
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
  /**
   * Zet een nep-cosign klaar die zijn aanroep logt en met de gegeven exitcode stopt.
   * @param {number} exitCode Exitcode van `cosign verify`.
   * @param {string} [message] Melding die cosign op stderr schrijft.
   * @returns {void}
   */
  const installCosign = (exitCode, message = '') => fs.writeFileSync(path.join(bin, 'cosign'), `#!/usr/bin/env bash\necho "$*" >> "${state}/cosign.log"\n${message ? `echo '${message}' >&2\n` : ''}exit ${exitCode}\n`, { mode: 0o755 });
  const statusDir = path.join(appDir, 'update', 'status');
  const requestDir = path.join(appDir, 'update', 'request');
  /**
   * Draait update.sh met de nep-docker.
   * @param {object} env FAKE_LATEST en eventueel FAKE_BAD.
   * @returns {object} status (exitcode), output en tag (versie in .env daarna).
   */
  const run = (env) => {
    const result = spawnSync('bash', [SCRIPT], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_DIR: appDir, FAKE_STATE: state, DRAIN_SECONDS: '0', HEALTH_TRIES: '1', VERIFY_RETRY_SECONDS: '0', FAKE_BAD: '', ...env },
      encoding: 'utf8', timeout: 60000,
    });
    const tag = /AQUATECH_TAG=(.*)/.exec(fs.readFileSync(path.join(appDir, '.env'), 'utf8'))[1];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, tag };
  };
  return { root, appDir, statusDir, requestDir, state, run, installCosign };
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

/**
 * De versies waarvan de nep-docker een `rmi` (image verwijderen) kreeg.
 * @param {string} state De logmap van de nep-docker.
 * @returns {string[]} De verwijderde tags, gesorteerd.
 */
const removedTags = (state) => fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n')
  .map((line) => /^rmi ghcr\.io\/danieldh00\/aquatech:(.+)$/.exec(line)).filter(Boolean).map((match) => match[1]).sort();

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

test('update.sh: na een geslaagde update blijven alleen de nieuwe en de vorige versie van het image staan', { skip: !bashAvailable }, () => {
  const setup = install({ current: '1.14.1' });
  const out = setup.run({ FAKE_LATEST: '1.14.2', FAKE_TAGS: '1.14.2 1.14.1 1.14.0 1.13.9 latest' });
  assert.strictEqual(out.status, 0, out.output);
  assert.deepStrictEqual(removedTags(setup.state), ['1.13.9', '1.14.0'], 'alleen de oudere versies, niet de nieuwe, de vorige en latest');
});

test('update.sh: een mislukte update ruimt geen images op (de terugval heeft ze nodig)', { skip: !bashAvailable }, () => {
  const setup = install({ current: '1.14.1' });
  const out = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BAD: '1.14.2', FAKE_TAGS: '1.14.2 1.14.1 1.14.0' });
  assert.strictEqual(out.status, 1, out.output);
  assert.deepStrictEqual(removedTags(setup.state), []);
});

test('servertaken.sh schijf: de draaiende en de twee nieuwste versies blijven, de rest wordt opgeruimd', { skip: !bashAvailable }, () => {
  const setup = install({ current: '1.14.1' });
  const servertaken = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'pve', 'servertaken.sh');
  // update.sh komt uit een lokale kopie van de GitHub-indeling (file://), nooit van het echte netwerk.
  const ref = 'a'.repeat(40);
  fs.mkdirSync(path.join(setup.root, 'raw', ref, 'deploy', 'apps01'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(setup.root, 'raw', ref, 'deploy', 'apps01', 'update.sh'));
  fs.writeFileSync(path.join(setup.appDir, 'update.sh'), '#!/usr/bin/env bash\n# oude versie\n');
  const env = { ...process.env, UPDATE_SH_BASE: `file://${path.join(setup.root, 'raw')}`, UPDATE_SH_REF: ref, PATH: `${path.join(setup.root, 'bin')}:${process.env.PATH}`, SERVERTAKEN_REMOTE: '1', APP_DIR: setup.appDir, FAKE_STATE: setup.state, FAKE_TAGS: '1.14.5 1.14.4 1.14.3 1.14.2 1.14.1 1.14.0 latest' };
  // De opruimstappen buiten docker mogen het systeem van wie de test draait nooit raken: stubs die alleen loggen.
  for (const name of ['journalctl', 'apt-get']) fs.writeFileSync(path.join(setup.root, 'bin', name), `#!/usr/bin/env bash\necho "${name} $*" >> "$FAKE_STATE/system-calls.log"\n`, { mode: 0o755 });
  const check = spawnSync('bash', [servertaken, 'schijf-check'], { env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(check.status, 10, check.stdout + check.stderr);
  assert.match(check.stdout, /3 oude versie\(s\)/, 'draaiend (1.14.1) en twee nieuwste (1.14.5, 1.14.4) blijven: 1.14.3, 1.14.2 en 1.14.0 zijn op te ruimen');
  const run = spawnSync('bash', [servertaken, 'schijf-run'], { env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.deepStrictEqual(removedTags(setup.state), ['1.14.0', '1.14.2', '1.14.3']);
  const systemCalls = fs.readFileSync(path.join(setup.state, 'system-calls.log'), 'utf8');
  assert.match(systemCalls, /journalctl --vacuum-size=200M/);
  assert.match(systemCalls, /apt-get clean/);
  assert.strictEqual(fs.readFileSync(path.join(setup.appDir, 'update.sh'), 'utf8'), fs.readFileSync(SCRIPT, 'utf8'), 'update.sh op de server is bijgewerkt');
  assert.ok(fs.readdirSync(setup.appDir).some((name) => name.startsWith('update.sh.bak-')), 'de oude blijft als back-up staan');
  assert.match(run.stdout, /update\.sh bijgewerkt/);
  assert.strictEqual(run.status, 0, 'ook zonder eerdere update.sh.bak-bestanden gaat het opruimen door');
  const again = spawnSync('bash', [servertaken, 'schijf-run'], { env, encoding: 'utf8', timeout: 30000 });
  assert.match(again.stdout, /al de nieuwste/);
  // Zonder bestaande update.sh (en dus zonder back-up) mag het opruimen niet stoppen: de glob van de back-ups is dan leeg.
  fs.rmSync(path.join(setup.appDir, 'update.sh'));
  for (const name of fs.readdirSync(setup.appDir).filter((entry) => entry.startsWith('update.sh.bak-'))) fs.rmSync(path.join(setup.appDir, name));
  fs.rmSync(path.join(setup.state, 'system-calls.log'));
  const fresh = spawnSync('bash', [servertaken, 'schijf-run'], { env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /update\.sh bijgewerkt/);
  assert.match(fs.readFileSync(path.join(setup.state, 'system-calls.log'), 'utf8'), /journalctl/, 'de stappen na update.sh gebeuren nog steeds');
  const unpinned = spawnSync('bash', [servertaken, 'schijf-run'], { env: { ...env, UPDATE_SH_REF: '' }, encoding: 'utf8', timeout: 30000 });
  assert.match(unpinned.stdout, /geef UPDATE_SH_REF/, 'zonder vaste commit gebeurt er niets (geen master)');
  const onMaster = spawnSync('bash', [servertaken, 'schijf-run'], { env: { ...env, UPDATE_SH_REF: 'master' }, encoding: 'utf8', timeout: 30000 });
  assert.match(onMaster.stdout, /ongeldige verwijzing/, 'ook master wordt geweigerd');
  const broken = spawnSync('bash', [servertaken, 'schijf-run'], { env: { ...env, UPDATE_SH_REF: 'niet-een-commit' }, encoding: 'utf8', timeout: 30000 });
  assert.match(broken.stdout, /ongeldige verwijzing/, 'een ongeldige verwijzing wordt geweigerd en het opruimen gaat door');
  assert.strictEqual(broken.status, 0);
  const few = spawnSync('bash', [servertaken, 'schijf-check'], { env: { ...env, FAKE_TAGS: '1.14.1 1.14.0' }, encoding: 'utf8', timeout: 30000 });
  assert.match(few.stdout, /0 oude versie\(s\)/, 'met een oude naast de draaiende gebeurt niets (die is de tweede van de twee nieuwste)');
});

test('update.sh: een check-aanvraag werkt alleen de status bij en installeert niets, ook met automatisch aan', { skip: !bashAvailable }, () => {
  const setup = install();
  fs.writeFileSync(path.join(setup.requestDir, 'request.json'), `{"id":"${REQUEST_ID}","check":true}`);
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.1', 'niets geïnstalleerd');
  assert.ok(!fs.existsSync(path.join(setup.requestDir, 'request.json')), 'aanvraag is weggehaald');
  assert.strictEqual(readStatus(setup.statusDir, 'status.json').available, '1.14.2');
  assert.strictEqual(readStatus(setup.statusDir, 'run.json'), null, 'de stand van de laatste uitrol blijft ongemoeid');
});

test('update.sh: een mislukte back-up vooraf stopt de update vóór het vervangen van de container', { skip: !bashAvailable }, () => {
  const setup = install();
  const out = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BACKUP_EXIT: '1' });
  assert.strictEqual(out.status, 1, out.output);
  assert.strictEqual(out.tag, '1.14.1', 'versie blijft ongewijzigd');
  const calls = fs.readFileSync(path.join(setup.state, 'calls.log'), 'utf8');
  assert.ok(!/compose stop/.test(calls), 'container niet gestopt');
  assert.strictEqual(readStatus(setup.statusDir, 'run.json').state, 'mislukt');
  assert.ok(!fs.existsSync(path.join(setup.statusDir, 'maintenance.json')), 'onderhoudsmodus weer uit');
  // Automatisch: het volgende uur niet opnieuw proberen (geen onderhoudsmodus om de 15 minuten); de aanvraag uit de app wel.
  const again = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BACKUP_EXIT: '1' });
  assert.strictEqual(again.status, 0, again.output);
  assert.match(again.output, /wacht/);
  putRequest(setup.requestDir, '1.14.2');
  const manual = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(manual.tag, '1.14.2', manual.output);
});

test('update.sh: een oude versie die backup.js create niet kent (exitcode 2) mag door met een waarschuwing', { skip: !bashAvailable }, () => {
  const setup = install();
  const out = setup.run({ FAKE_LATEST: '1.14.2', FAKE_BACKUP_EXIT: '2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.2');
  assert.match(out.output, /kent 'backup\.js create' nog niet/);
});

// Hostgereedschap kan op de testmachine staan; de nep-PATH zet alleen een eigen cosign vooraan.
const hostHasCosign = spawnSync('bash', ['-c', 'command -v cosign']).status === 0;

test('update.sh: met cosign wordt de handtekening op digest gecontroleerd tegen de identiteit van release.yml', { skip: !bashAvailable }, () => {
  const setup = install();
  setup.installCosign(0);
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(out.tag, '1.14.2');
  assert.match(out.output, /Handtekening van ghcr\.io\/danieldh00\/aquatech@sha256:a{64} gecontroleerd/);
  const call = fs.readFileSync(path.join(setup.state, 'cosign.log'), 'utf8');
  assert.match(call, /verify --certificate-identity-regexp \^https:\/\/github\\\.com\/danieldh00\/\[Aa\]quatech\/\\\.github\/workflows\/release\\\.yml@refs\/heads\/master\$ --certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com ghcr\.io\/danieldh00\/aquatech@sha256:a{64}/);
});

test('update.sh: een ontbrekende of ongeldige handtekening stopt de update vóór de onderhoudsmodus', { skip: !bashAvailable }, () => {
  const setup = install();
  setup.installCosign(1);
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 1, out.output);
  assert.strictEqual(out.tag, '1.14.1', 'versie blijft ongewijzigd');
  const calls = fs.readFileSync(path.join(setup.state, 'calls.log'), 'utf8');
  assert.ok(!/compose stop/.test(calls), 'container niet gestopt');
  assert.strictEqual(readStatus(setup.statusDir, 'run.json').state, 'mislukt');
  assert.match(readStatus(setup.statusDir, 'run.json').message, /handtekening/);
  assert.strictEqual(fs.readFileSync(path.join(setup.appDir, '.failed-version'), 'utf8').trim(), '1.14.2', 'versie wordt overgeslagen');
  assert.ok(!fs.existsSync(path.join(setup.statusDir, 'maintenance.json')));
});

test('update.sh: IMAGE_SIGNATURE=off slaat de controle over en =required eist cosign', { skip: !bashAvailable || hostHasCosign }, () => {
  const off = install();
  off.installCosign(1);
  fs.appendFileSync(path.join(off.appDir, '.env'), 'IMAGE_SIGNATURE=off\n');
  assert.strictEqual(off.run({ FAKE_LATEST: '1.14.2' }).tag, '1.14.2');
  assert.ok(!fs.existsSync(path.join(off.state, 'cosign.log')), 'cosign niet aangeroepen');

  const warn = install();
  const auto = warn.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(auto.tag, '1.14.2', auto.output);
  assert.match(auto.output, /cosign ontbreekt/);

  const required = install();
  fs.appendFileSync(path.join(required.appDir, '.env'), 'IMAGE_SIGNATURE=required\n');
  const blocked = required.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(blocked.status, 1, blocked.output);
  assert.strictEqual(blocked.tag, '1.14.1');
  assert.match(readStatus(required.statusDir, 'run.json').message, /servertaak 011/);
});

test('update.sh: een netwerkstoring bij de handtekeningcontrole slaat de versie niet over en wordt opnieuw geprobeerd', { skip: !bashAvailable }, () => {
  const setup = install();
  setup.installCosign(1, 'Error: dial tcp: lookup tuf-repo-cdn.sigstore.dev: no such host');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 1, out.output);
  assert.strictEqual(out.tag, '1.14.1');
  assert.ok(!fs.existsSync(path.join(setup.appDir, '.failed-version')), 'versie niet overgeslagen');
  assert.match(out.output, /no such host/, 'de cosign-melding staat in het log');
  assert.strictEqual(fs.readFileSync(path.join(setup.state, 'cosign.log'), 'utf8').trim().split('\n').length, 2, 'één keer opnieuw geprobeerd');
  setup.installCosign(0);
  assert.strictEqual(setup.run({ FAKE_LATEST: '1.14.2' }).tag, '1.14.2', 'de volgende ronde slaagt');
});

test('update.sh: een ongeldige handtekening waarvan de melding een digest bevat telt niet als netwerkstoring', { skip: !bashAvailable }, () => {
  const setup = install();
  setup.installCosign(1, 'Error: no matching signatures for sha256:5e50c0eeffb0504aa5e50f0eef5009e50e50e50e50e50e50e50e50e50e50e50');
  const out = setup.run({ FAKE_LATEST: '1.14.2' });
  assert.strictEqual(out.status, 1, out.output);
  assert.strictEqual(fs.readFileSync(path.join(setup.appDir, '.failed-version'), 'utf8').trim(), '1.14.2', 'versie wordt overgeslagen');
});
