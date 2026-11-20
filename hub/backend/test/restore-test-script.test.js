// Het hersteltestscript van de server (deploy/apps01/restore-test.sh) met een nagebootste docker: geslaagd, met
// opmerkingen, mislukt (terugzetten, sanity), planning (uit, nog niet aan de beurt, handmatig), opruimen van de
// wegwerpcontainer en dat de uitkomst door de app (platform/restore-test.js) te lezen is.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRestoreTest } = require('../src/platform/restore-test');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'restore-test.sh');

// Nagebootste docker. Productie = container aquatech-postgres, de test = aquatech-restoretest-*. Tellingen en versies
// komen uit bestanden/omgevingsvariabelen die de test neerzet.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/calls.log"
case "$1" in
  inspect)
    if [[ "$*" == *Health* ]]; then echo "\${FAKE_PROD_HEALTH:-healthy}"; else echo "postgres:17"; fi
    exit 0 ;;
  run) exit \${FAKE_RUN_EXIT:-0} ;;
  rm) exit 0 ;;
  exec)
    shift
    while [[ "$1" == -* ]]; do shift; done
    container="$1"; shift
    side=test; [[ "$container" == "aquatech-postgres" ]] && side=prod
    case "$1" in
      pg_isready) exit 0 ;;
      pg_restore)
        if [[ -n "\${FAKE_LIST_EARLY:-}" && "$*" == *" -l"* ]]; then
          head -c 1 >/dev/null
          echo "; 1; 1259 TABLE aquatech users x"
          exit 0
        fi
        input="$(cat)"
        if [[ "$*" == *" -l"* || "$2" == "-l" ]]; then
          [[ -n "$input" ]] && echo "; 1; 1259 TABLE aquatech users x"
          exit 0
        fi
        [[ -n "\${FAKE_RESTORE_ERROR:-}" ]] && echo "pg_restore: error: \${FAKE_RESTORE_ERROR}" >&2
        exit 0 ;;
      psql)
        query="\${@: -1}"
        counts="$FAKE_STATE/counts.$side"
        if [[ "$query" == *CREATE\\ ROLE* ]]; then exit 0; fi
        if [[ "$query" == *query_to_xml* ]]; then cat "$counts"; exit 0; fi
        if [[ "$query" == *information_schema.tables* ]]; then cut -d'|' -f1 "$counts"; exit 0; fi
        if [[ "$query" == *"SELECT version"* ]]; then
          if [[ "$side" == prod ]]; then echo "\${FAKE_VERSION_PROD:-90}"; else echo "\${FAKE_VERSION_TEST:-90}"; fi
          exit 0
        fi
        if [[ "$query" == *aquatech.tenants* ]]; then echo "\${FAKE_TENANTS:-2}"; exit 0; fi
        if [[ "$query" == *aquatech.users* ]]; then echo "\${FAKE_ADMINS:-3}"; exit 0; fi
        if [[ "$query" == *aquatech.schema_version* ]]; then echo 1; exit 0; fi
        exit 0 ;;
    esac ;;
esac
exit 0
`;

/**
 * Maakt een nep-installatie met een echt versleutelde dump, de nep-docker en de updatemappen.
 * @param {object} [options] policy (inhoud restore-test.json), prodCounts en testCounts (tekst "tabel|aantal" per regel), lastRun (epoch voor .restore-test-last), plainBytes (grootte van de nep-dump).
 * @returns {object} appDir, statusDir, requestDir, state en run (script draaien).
 */
function install({ policy = null, prodCounts = 'users|50\nquotes|200\nwork_orders|100', testCounts = 'users|50\nquotes|190\nwork_orders|100', lastRun = null, plainBytes = 11 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-rtest-'));
  const appDir = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const backupDir = path.join(appDir, 'backups', 'postgres');
  const statusDir = path.join(appDir, 'update', 'status');
  const requestDir = path.join(appDir, 'update', 'request');
  for (const dir of [bin, state, backupDir, statusDir, requestDir, path.join(appDir, 'secrets')]) fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(appDir, 'secrets', 'master-key');
  fs.writeFileSync(keyFile, 'k'.repeat(64));
  const plain = path.join(root, 'plain');
  fs.writeFileSync(plain, plainBytes === 11 ? 'dump-inhoud' : 'x'.repeat(plainBytes));
  const encrypted = spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-pass', `file:${keyFile}`, '-in', plain, '-out', path.join(backupDir, 'aquatech-20261120-023000.dump.enc')]);
  assert.strictEqual(encrypted.status, 0, String(encrypted.stderr));
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'counts.prod'), `${prodCounts}\n`);
  fs.writeFileSync(path.join(state, 'counts.test'), `${testCounts}\n`);
  if (policy) fs.writeFileSync(path.join(requestDir, 'restore-test.json'), JSON.stringify(policy));
  if (lastRun !== null) fs.writeFileSync(path.join(statusDir, '.restore-test-last'), `${lastRun}\n`);
  /**
   * Draait het script met de nep-docker.
   * @param {object} [extraEnv] Extra omgevingsvariabelen voor de nep-docker.
   * @returns {object} Het resultaat van spawnSync.
   */
  const run = (extraEnv = {}) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, APP_DIR: appDir, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, ...extraEnv },
  });
  return { appDir, statusDir, requestDir, state, run };
}

/**
 * Leest restore-test.json van het script.
 * @param {string} statusDir De statusmap.
 * @returns {object} De inhoud.
 */
const readStatus = (statusDir) => JSON.parse(fs.readFileSync(path.join(statusDir, 'restore-test.json'), 'utf8'));

/**
 * Een planning die nu aan de beurt is (vandaag, 00:00).
 * @returns {object} Inhoud voor restore-test.json.
 */
const dueNow = () => ({ enabled: true, day: new Date().getDay(), time: '00:00' });

test('geslaagd: terugzetten, controles, opruimen en door de app te lezen', () => {
  const env = install({ policy: dueNow() });
  const result = env.run();
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const status = readStatus(env.statusDir);
  assert.strictEqual(status.running, null);
  const [latest] = status.runs;
  assert.strictEqual(latest.state, 'geslaagd', latest.message);
  assert.strictEqual(latest.trigger, 'schema');
  assert.strictEqual(latest.backup.name, 'aquatech-20261120-023000.dump.enc');
  assert.strictEqual(latest.tables.backup, 3);
  assert.strictEqual(latest.rows.checked, 3);
  assert.deepStrictEqual(latest.rows.deviating, []);
  assert.strictEqual(latest.sanity.length, 3);
  assert.ok(latest.sanity.every((item) => item.ok));
  const calls = fs.readFileSync(path.join(env.state, 'calls.log'), 'utf8');
  assert.match(calls, /run -d --name aquatech-restoretest-\d+ --memory 768m --memory-swap 768m --network none/);
  assert.match(calls, /rm -f -v aquatech-restoretest-\d+/, 'wegwerpcontainer wordt opgeruimd');
  // De app leest dezelfde uitkomst.
  const view = createRestoreTest({ statusDir: env.statusDir, requestDir: env.requestDir }).view();
  assert.strictEqual(view.latest.state, 'geslaagd');
  assert.strictEqual(view.runs.length, 1);
  // Tweede aanroep direct erna: niets meer aan de beurt.
  env.run();
  assert.strictEqual(readStatus(env.statusDir).runs.length, 1);
});

/** Een grote dump terwijl pg_restore -l na de inhoudsopgave stopt (zoals echt): dat is geen fout (openssl krijgt een gesloten pijp). */
test('een grote back-up waarbij pg_restore -l eerder stopt is geen fout', () => {
  const env = install({ policy: dueNow(), plainBytes: 3 * 1024 * 1024 });
  const result = env.run({ FAKE_LIST_EARLY: '1' });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.strictEqual(readStatus(env.statusDir).runs[0].state, 'geslaagd');
});

test('waarschuwing: oudere schemaversie en een tabel met een afwijkend aantal rijen', () => {
  const env = install({ policy: dueNow(), prodCounts: 'users|50\nquotes|1000', testCounts: 'users|50\nquotes|300' });
  const result = env.run({ FAKE_VERSION_PROD: '92', FAKE_VERSION_TEST: '90' });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const [latest] = readStatus(env.statusDir).runs;
  assert.strictEqual(latest.state, 'waarschuwing');
  assert.deepStrictEqual(latest.rows.deviating, [{ table: 'quotes', backup: 300, production: 1000 }]);
  assert.strictEqual(latest.schemaVersion.backup, 90);
  assert.strictEqual(latest.schemaVersion.production, 92);
});

test('mislukt: fouten bij het terugzetten, een lege sanity-query en een nieuwere schemaversie', () => {
  let env = install({ policy: dueNow() });
  assert.strictEqual(env.run({ FAKE_RESTORE_ERROR: 'could not execute query' }).status, 1);
  assert.match(readStatus(env.statusDir).runs[0].message, /Terugzetten gaf 1 fout/);
  assert.ok(fs.existsSync(path.join(env.statusDir, '.restore-test-last')), 'een run die tot het terugzetten kwam telt als gedaan');
  assert.match(fs.readFileSync(path.join(env.state, 'calls.log'), 'utf8'), /rm -f -v aquatech-restoretest-/);

  env = install({ policy: dueNow() });
  assert.strictEqual(env.run({ FAKE_ADMINS: '0' }).status, 1);
  const failed = readStatus(env.statusDir).runs[0];
  assert.strictEqual(failed.state, 'mislukt');
  assert.ok(failed.sanity.some((item) => !item.ok));

  env = install({ policy: dueNow() });
  assert.strictEqual(env.run({ FAKE_VERSION_TEST: '95', FAKE_VERSION_PROD: '90' }).status, 1);
  assert.match(readStatus(env.statusDir).runs[0].message, /nieuwere schemaversie/);

  env = install({ policy: dueNow() });
  assert.strictEqual(env.run({ FAKE_PROD_HEALTH: 'unhealthy' }).status, 1);
  assert.match(readStatus(env.statusDir).runs[0].message, /productie-database draait niet/);
});

test('planning: uit, nog niet aan de beurt en handmatig starten', () => {
  let env = install({ policy: { enabled: false, day: new Date().getDay(), time: '00:00' } });
  assert.strictEqual(env.run().status, 0);
  assert.ok(!fs.existsSync(path.join(env.statusDir, 'restore-test.json')), 'uit = niets doen');

  // Net getest: de planning van deze week is al gedraaid.
  env = install({ policy: dueNow(), lastRun: Math.floor(Date.now() / 1000) });
  assert.strictEqual(env.run().status, 0);
  assert.ok(!fs.existsSync(path.join(env.statusDir, 'restore-test.json')));

  // Handmatig: ook als de test uit staat, en het aanvraagbestand is daarna weg.
  env = install({ policy: { enabled: false, day: 0, time: '03:30' } });
  fs.writeFileSync(path.join(env.requestDir, 'restore-test-now.json'), '{"id":"x"}');
  assert.strictEqual(env.run().status, 0);
  assert.ok(!fs.existsSync(path.join(env.requestDir, 'restore-test-now.json')));
  assert.strictEqual(readStatus(env.statusDir).runs[0].trigger, 'handmatig');
});

/** Een ontbrekende dump die pg-backup.sh wél maakt: de hersteltest gaat door naar het terugzetten. */
test('zonder dump maakt pg-backup.sh er een en gaat de test door', () => {
  const env = install({ policy: dueNow() });
  const backupDir = path.join(env.appDir, 'backups', 'postgres');
  const dump = path.join(backupDir, 'aquatech-20261120-023000.dump.enc');
  const kept = path.join(env.appDir, 'bewaard.enc');
  fs.renameSync(dump, kept);
  fs.writeFileSync(path.join(env.appDir, 'pg-backup.sh'), `cp "${kept}" "${dump}"\n`);
  assert.strictEqual(env.run().status, 0);
  assert.strictEqual(readStatus(env.statusDir).runs[0].state, 'geslaagd');
});

/** Een ontbrekende dump: pg-backup.sh wordt aangeroepen en de melding noemt de oorzaak als dat niets oplevert. */
test('zonder dump probeert het script er een te laten maken', () => {
  const env = install({ policy: dueNow() });
  fs.rmSync(path.join(env.appDir, 'backups', 'postgres', 'aquatech-20261120-023000.dump.enc'));
  fs.writeFileSync(path.join(env.appDir, 'pg-backup.sh'), 'echo "FOUT: container draait niet" >&2\nexit 1\n');
  assert.strictEqual(env.run().status, 1);
  assert.match(readStatus(env.statusDir).runs[0].message, /pg-backup\.sh kon er geen maken.*container draait niet/);
});

test('zonder back-up: veilig falen en later opnieuw proberen', () => {
  const env = install({ policy: dueNow() });
  fs.rmSync(path.join(env.appDir, 'backups', 'postgres', 'aquatech-20261120-023000.dump.enc'));
  assert.strictEqual(env.run().status, 1);
  assert.match(readStatus(env.statusDir).runs[0].message, /geen aquatech-\*\.dump\.enc/);
  assert.ok(fs.existsSync(path.join(env.statusDir, '.restore-test-retry')), 'mislukte voorbereiding: later opnieuw');
  assert.ok(!fs.existsSync(path.join(env.statusDir, '.restore-test-last')), 'telt niet als gedaan');
  env.run();
  assert.strictEqual(readStatus(env.statusDir).runs.length, 1, 'binnen drie uur geen nieuwe poging');
  fs.writeFileSync(path.join(env.statusDir, '.restore-test-retry'), `${Math.floor(Date.now() / 1000) - 4 * 3600}\n`);
  env.run();
  assert.strictEqual(readStatus(env.statusDir).runs.length, 2, 'na drie uur opnieuw geprobeerd');

  // Een symlink als instelling wordt niet gelezen (standaard: zondag 03:30, wel aan).
  const linked = install({});
  fs.symlinkSync('/etc/passwd', path.join(linked.requestDir, 'restore-test.json'));
  assert.deepStrictEqual(createRestoreTest({ statusDir: linked.statusDir, requestDir: linked.requestDir }).policy(), { enabled: true, day: 0, time: '03:30' }, 'de app negeert een symlink');
  fs.writeFileSync(path.join(linked.requestDir, 'restore-test-now.json'), '{}');
  fs.rmSync(path.join(linked.requestDir, 'restore-test.json'));
  fs.symlinkSync('/etc/passwd', path.join(linked.requestDir, 'restore-test.json'));
  assert.strictEqual(linked.run().status, 0, 'het script negeert een symlink als instelling en gebruikt de standaard');
});

test('restore-test.js: saneert de uitkomst van de host en bewaart de planning', () => {
  const dirs = { statusDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-rt-s-')), requestDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-rt-r-')) };
  const restoreTest = createRestoreTest(dirs);
  assert.strictEqual(createRestoreTest({}).view().configured, false);
  assert.strictEqual(restoreTest.view().latest, null);
  assert.deepStrictEqual(restoreTest.view().policy, { enabled: true, day: 0, time: '03:30' });
  fs.writeFileSync(path.join(dirs.statusDir, 'restore-test.json'), JSON.stringify({
    running: null,
    runs: [{ state: 'geslaagd', startedAt: '2026-11-15T03:30:00Z', finishedAt: '2026-11-15T03:33:00Z', durationSec: 180, trigger: 'raar', backup: { name: 'a<b>.enc', bytes: 10 },
      tables: { backup: 5, production: 5, missing: ['ok_tabel', '../kwaad'] }, rows: { checked: 5, deviating: [{ table: 'x;drop', backup: 1, production: 2 }] }, sanity: [{ name: 'Test', value: 3, ok: true }], message: 'x'.repeat(500) },
    { state: 'onzin', startedAt: 'niet' }],
  }));
  const view = restoreTest.view();
  assert.strictEqual(view.runs.length, 1);
  assert.strictEqual(view.latest.trigger, 'schema');
  assert.deepStrictEqual(view.latest.tables.missing, ['ok_tabel']);
  assert.deepStrictEqual(view.latest.rows.deviating, []);
  assert.strictEqual(view.latest.message.length, 300);

  assert.strictEqual(restoreTest.setPolicy({ enabled: true, day: 7, time: '03:30' }).status, 400);
  assert.strictEqual(restoreTest.setPolicy({ enabled: true, day: 3, time: '25:00' }).status, 400);
  assert.strictEqual(restoreTest.setPolicy({ enabled: 'ja', day: 3, time: '03:30' }).status, 400);
  assert.deepStrictEqual(restoreTest.setPolicy({ enabled: false, day: 3, time: '04:15' }).policy, { enabled: false, day: 3, time: '04:15' });
  assert.strictEqual(restoreTest.view().nextRunAt, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dirs.requestDir, 'restore-test.json'), 'utf8')), { enabled: false, day: 3, time: '04:15' });

  // Een run die al een uur "bezig" is telt als onderbroken.
  fs.writeFileSync(path.join(dirs.statusDir, 'restore-test.json'), JSON.stringify({ running: { state: 'bezig', startedAt: '2026-11-15T03:30:00Z' }, runs: [] }));
  const stuck = createRestoreTest({ ...dirs, now: () => Date.parse('2026-11-15T06:00:00Z') }).view();
  assert.strictEqual(stuck.running, null);
  assert.strictEqual(stuck.latest.state, 'mislukt');

  // Aanvragen: één tegelijk.
  assert.strictEqual(restoreTest.requestRun({ userId: 'u1', byName: 'Bert' }).requested, true);
  assert.strictEqual(restoreTest.requestRun({ userId: 'u1' }).status, 409);
  assert.strictEqual(restoreTest.view().requested, true);
});
