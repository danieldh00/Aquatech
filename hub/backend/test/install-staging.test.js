// Stagingscript (deploy/staging/install-staging.sh) met een echte git-repo en nagebootste docker, curl, systemctl en df:
// eerste installatie met eigen geheimen, niets doen bij dezelfde commit, overstappen naar develop, terugval bij een commit
// die niet bouwt of niet gezond start, ander tunnel-IP, geen tunnel-IP, te weinig schijfruimte en ontbrekende tunnelgegevens.
// Ook: het compose-bestand heeft alleen images van derden op een vaste digest en deelt niets met de testomgeving.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEPLOY_DIR = path.join(__dirname, '..', '..', '..', 'deploy', 'staging');
const SCRIPT = path.join(DEPLOY_DIR, 'install-staging.sh');
const bashAvailable = spawnSync('bash', ['-c', 'command -v flock && command -v git'], { encoding: 'utf8' }).status === 0;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
all="$*"
case "$1" in
  info) echo /var/lib/docker ;;
  inspect)
    if [[ "$2" != "-f" ]]; then [[ -f "$FAKE/no-tunnel" ]] && exit 1; exit 0; fi
    case "$3" in
      *Networks\\}\\}\\{\\{\\$name*) echo "tunnelnet " ;;
      *compose.service*) cat "$FAKE/old-service" 2>/dev/null ;;
      *IPAddress*) cat "$FAKE/tunnel-ip" 2>/dev/null ;;
      *Health.Status*)
        if [[ "$4" == "aquatech-staging-postgres" ]]; then echo healthy
        elif [[ -s "$FAKE/running" ]] && ! grep -qx "$(cat "$FAKE/running")" "$FAKE/bad" 2>/dev/null; then echo healthy
        elif [[ -s "$FAKE/running" ]]; then echo unhealthy; fi ;;
    esac ;;
  compose)
    case "$all" in
      *" build "*) grep -qx "$STAGING_COMMIT" "$FAKE/nobuild" 2>/dev/null && exit 1; echo "$STAGING_COMMIT" >> "$FAKE/images" ;;
      *" up "*" aquatech-staging-app"*) echo "$STAGING_COMMIT" > "$FAKE/running" ;;
      *" stop "*) : > "$FAKE/running" ;;
    esac ;;
  exec) cat > "$FAKE/psql-input" ;;
  image)
    if [[ "$2" == "ls" ]]; then sed 's/^/aquatech-staging:/' "$FAKE/images"; fi ;;
esac
exit 0
`;
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls"
url="" out="" write=""
args=("$@")
for ((index = 0; index < \${#args[@]}; index++)); do
  case "\${args[index]}" in
    -o) out="\${args[index + 1]}" ;;
    -w) write="\${args[index + 1]}" ;;
  esac
  url="\${args[index]}"
done
case "$url" in
  */app/api/setup)
    if [[ "$*" == *--data-binary* ]]; then cat > /dev/null; touch "$FAKE/admin-made"; echo '{"ok":true}'
    elif [[ -f "$FAKE/admin-made" ]]; then echo '{"required":false}'
    else echo '{"required":true}'; fi ;;
  */platform/tenants) echo '{"items":[],"mainTenantId":"3bce8b5b-ab85-4070-bc41-72b06dcbf88a"}' ;;
  */environments) echo '{"tenant":{"id":"c6a25800-f5d9-40dc-80b4-10f22f587c3a","slug":"x"}}' ;;
  */testdata) echo '{"password":"Testwachtwoord-1234","counts":{}}' > "$out"; printf '201' ;;
esac
exit 0
`;

/**
 * Maakt een tijdelijke map.
 * @returns {string} Het pad.
 */
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-staging-'));

/**
 * Voert een git-opdracht uit en geeft de uitvoer terug.
 * @param {string} cwd De map.
 * @param {...string} args Argumenten van git.
 * @returns {string} De uitvoer zonder slotregeleinde.
 */
function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  return out.stdout.trim();
}

/**
 * Zet een nepserver klaar: een "origin"-repo met master, nepcommando's en een lege stagingmap.
 * @returns {object} De hulpmiddelen: run, commit, calls en meer.
 */
function world() {
  const root = tempDir();
  const origin = path.join(root, 'origin');
  const bin = path.join(root, 'bin');
  const fake = path.join(root, 'fake');
  const stagingDir = path.join(root, 'staging');
  const systemdDir = path.join(root, 'systemd');
  for (const dir of [origin, bin, fake, systemdDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "$FAKE/calls"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/usr/bin/env bash\n[[ "$1" == "-E" ]] && shift\nexec "$@"\n', { mode: 0o755 });
  // De CI draait niet als root: de nep-id doet alsof het script al root is (anders start sudo zichzelf eindeloos opnieuw).
  fs.writeFileSync(path.join(bin, 'id'), '#!/usr/bin/env bash\n[[ "$1" == "-u" ]] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'df'), '#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 100 1 ${FAKE_FREE_KB:-20000000} 1% /"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'tunnel-ip'), '172.18.0.5\n');
  for (const name of ['calls', 'images', 'bad', 'nobuild']) fs.writeFileSync(path.join(fake, name), '');

  git(origin, 'init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(origin, 'deploy', 'staging'), { recursive: true });
  fs.copyFileSync(path.join(DEPLOY_DIR, 'compose.yml'), path.join(origin, 'deploy', 'staging', 'compose.yml'));
  let counter = 0;
  /**
   * Maakt een commit op de gekozen branch van de nep-origin.
   * @param {string} branch Branch (master of develop).
   * @returns {string} De volledige commit.
   */
  const commit = (branch) => {
    const exists = spawnSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: origin }).status === 0;
    if (!exists) git(origin, 'checkout', '-q', '-b', branch); else git(origin, 'checkout', '-q', branch);
    counter += 1;
    fs.writeFileSync(path.join(origin, 'wijziging.txt'), `${counter}\n`);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', `wijziging ${counter}`);
    return git(origin, 'rev-parse', 'HEAD');
  };

  /**
   * Draait het script met de nepcommando's.
   * @param {string[]} args Opties (bijv. --timer).
   * @param {object} extraEnv Extra omgevingsvariabelen.
   * @returns {{ status: number, stdout: string, stderr: string, output: string }} De uitkomst.
   */
  const run = (args = [], extraEnv = {}) => {
    const out = spawnSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, STAGING_DIR: stagingDir, STAGING_REPO_URL: origin, SYSTEMD_DIR: systemdDir, STAGING_HEALTH_WAIT: '3', ...extraEnv },
      encoding: 'utf8', timeout: 60000,
    });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, output: `${out.stdout}${out.stderr}` };
  };
  /**
   * Leest een tekstbestand.
   * @param {string} file Het pad.
   * @returns {string} De inhoud.
   */
  const read = (file) => fs.readFileSync(file, 'utf8');
  /**
   * Leest een bestand in de staat-map van het script (leeg als het niet bestaat).
   * @param {string} name De bestandsnaam in state/.
   * @returns {string} De inhoud.
   */
  const state = (name) => { try { return read(path.join(stagingDir, 'state', name)); } catch { return ''; } };
  /**
   * Zet een stuurbestand van de nepcommando's.
   * @param {string} name Bestandsnaam in de nepmap.
   * @param {string} value De inhoud.
   * @returns {void}
   */
  const setFake = (name, value) => fs.writeFileSync(path.join(fake, name), value);
  /**
   * Alle aanroepen van de nepcommando's tot nu toe.
   * @returns {string} Het logboek.
   */
  const calls = () => read(path.join(fake, 'calls'));
  /**
   * De .env van de stagingmap.
   * @returns {string} De inhoud.
   */
  const env = () => read(path.join(stagingDir, '.env'));
  return {
    run, commit, root, fake, stagingDir, systemdDir, origin, state, setFake,
    calls,
    env,
  };
}

test('eerste installatie: eigen geheimen en .env, build, testdata, timer en wat nog met de hand moet', { skip: !bashAvailable }, () => {
  const site = world();
  const first = site.commit('master');
  const out = site.run();
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(site.state('deployed'), first, 'zonder develop volgt het master');
  const env = site.env();
  assert.match(env, /^STAGING_COMMIT=[0-9a-f]{12}$/m);
  assert.match(env, /^TRUSTED_PROXIES=172\.18\.0\.5\/32$/m);
  assert.match(env, /^TUNNEL_NETWORK=tunnelnet$/m);
  assert.match(env, /^TUNNEL_CONTAINER=aquatech-cloudflared$/m);
  assert.match(env, /^SETUP_CODE=[0-9A-F]{12}$/m);
  assert.strictEqual(fs.statSync(path.join(site.stagingDir, '.env')).mode & 0o777, 0o600);
  const secrets = ['master-key', 'postgres-password', 'app-db-password', 'admin-password', 'database-url'].map((name) => fs.readFileSync(path.join(site.stagingDir, 'secrets', name), 'utf8'));
  assert.strictEqual(new Set(secrets).size, secrets.length, 'elk geheim is anders');
  assert.match(secrets[0], /^[0-9a-f]{64}$/);
  assert.match(secrets[4], /^postgresql:\/\/aquatech:[0-9a-f]{64}@aquatech-staging-postgres:5432\/aquatech\?sslmode=disable$/, 'unieke databasehost, nooit `postgres` (naam van de database van de testomgeving in het tunnelnetwerk)');
  assert.ok(!secrets[4].includes('@postgres:'));
  const appPassword = secrets[2];
  const psqlInput = fs.readFileSync(path.join(site.fake, 'psql-input'), 'utf8');
  assert.ok(psqlInput.includes(`PASSWORD '${appPassword}'`), 'het wachtwoord gaat via stdin naar psql');
  for (const secret of secrets.slice(0, 4)) {
    assert.ok(!out.output.includes(secret), 'geheimen staan niet in de uitvoer');
    assert.ok(!site.calls().includes(secret), 'geheimen staan niet in een opdrachtregel');
  }
  assert.ok(fs.existsSync(path.join(site.stagingDir, 'state', 'seeded')), 'testdata gevuld');
  assert.strictEqual(fs.readFileSync(path.join(site.stagingDir, 'secrets', 'testdata-password'), 'utf8').trim(), 'Testwachtwoord-1234');
  assert.ok(!out.output.includes('Testwachtwoord-1234'));
  assert.ok(fs.existsSync(path.join(site.systemdDir, 'aquatech-staging-update.timer')));
  assert.match(fs.readFileSync(path.join(site.systemdDir, 'aquatech-staging-update.timer'), 'utf8'), /OnUnitActiveSec=15min/);
  assert.match(fs.readFileSync(path.join(site.systemdDir, 'aquatech-staging-update.service'), 'utf8'), /install-staging\.sh --timer/);
  assert.match(site.calls(), /systemctl enable --now aquatech-staging-update\.timer/);
  assert.match(out.stdout, /aquatech-staging\.den-hollander\.com/);
  assert.match(out.stdout, /http:\/\/aquatech-staging:3300/);
  assert.ok(!site.calls().includes('aquatech-postgres') && !site.calls().includes('/opt/apps/aquatech '), 'de testomgeving wordt niet aangeraakt');
});

test('--timer doet niets bij dezelfde commit, een gezonde app en hetzelfde tunnel-IP', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  assert.strictEqual(site.run().status, 0);
  const before = site.calls();
  const out = site.run(['--timer']);
  assert.strictEqual(out.status, 0, out.output);
  const after = site.calls().slice(before.length);
  assert.ok(!/compose .* (build|up)/.test(after), `er is niet gebouwd of gestart: ${after}`);
  assert.strictEqual(out.stdout.trim(), '', 'stil in timermodus');
});

test('overstappen naar develop zodra die branch bestaat', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  assert.strictEqual(site.run().status, 0);
  const develop = site.commit('develop');
  const out = site.run(['--timer']);
  assert.strictEqual(out.status, 0, out.output);
  assert.strictEqual(site.state('deployed'), develop);
  assert.match(site.env(), new RegExp(`^STAGING_COMMIT=${develop.slice(0, 12)}$`, 'm'));
  assert.ok(fs.existsSync(path.join(site.stagingDir, 'state', 'seeded')));
  assert.strictEqual(site.calls().split('\n').filter((line) => /curl .*\/setup/.test(line) && /--data-binary/.test(line)).length, 1, 'testdata en beheerder maar één keer');
});

test('een commit die niet bouwt: de draaiende staging blijft, de commit wordt overgeslagen tot een nieuwere komt', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  const good = site.commit('develop');
  assert.strictEqual(site.run().status, 0);
  const broken = site.commit('develop');
  site.setFake('nobuild', `${broken.slice(0, 12)}\n`);
  const failed = site.run(['--timer']);
  assert.strictEqual(failed.status, 1);
  assert.match(failed.stderr, /bouwde niet/);
  assert.strictEqual(site.state('deployed'), good);
  assert.strictEqual(site.state('skipped'), broken);
  assert.match(site.env(), new RegExp(`^STAGING_COMMIT=${good.slice(0, 12)}$`, 'm'));
  const before = site.calls();
  const again = site.run(['--timer']);
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /wordt overgeslagen/);
  assert.ok(!/compose .* build/.test(site.calls().slice(before.length)), 'geen nieuwe bouwpoging');
  site.setFake('nobuild', '');
  assert.strictEqual(site.run().status, 0, 'een handmatige run probeert een overgeslagen commit opnieuw');
  assert.strictEqual(site.state('deployed'), broken);
  const fixed = site.commit('develop');
  assert.strictEqual(site.run(['--timer']).status, 0);
  assert.strictEqual(site.state('deployed'), fixed);
  assert.strictEqual(site.state('skipped'), '', 'de markering is weg na een geslaagde commit');
});

test('een commit die niet gezond start: terug naar de vorige en overslaan', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  const good = site.commit('develop');
  assert.strictEqual(site.run().status, 0);
  const sick = site.commit('develop');
  site.setFake('bad', `${sick.slice(0, 12)}\n`);
  const out = site.run(['--timer']);
  assert.strictEqual(out.status, 1);
  assert.match(out.output, /startte niet gezond/);
  assert.match(out.stdout, /Terug naar de vorige commit/);
  assert.strictEqual(fs.readFileSync(path.join(site.fake, 'running'), 'utf8').trim(), good.slice(0, 12), 'de vorige commit draait weer');
  assert.strictEqual(site.state('deployed'), good);
  assert.strictEqual(site.state('skipped'), sick);
  assert.match(site.env(), new RegExp(`^STAGING_COMMIT=${good.slice(0, 12)}$`, 'm'));
  assert.strictEqual(site.run(['--timer']).status, 0, 'daarna overgeslagen, geen fout');
});

test('een ander tunnel-IP: de opstelling gaat opnieuw omhoog met de nieuwe vertrouwde proxy', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  assert.strictEqual(site.run().status, 0);
  site.setFake('tunnel-ip', '172.18.0.9\n');
  const before = site.calls();
  const out = site.run(['--timer']);
  assert.strictEqual(out.status, 0, out.output);
  assert.match(site.env(), /^TRUSTED_PROXIES=172\.18\.0\.9\/32$/m);
  assert.match(site.calls().slice(before.length), /compose .* up -d --force-recreate --remove-orphans aquatech-staging-app/);
});

test('geen tunnel-IP: gezond op de juiste commit = melden en code 0; anders een fout; een onzin-IP telt als geen', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  assert.strictEqual(site.run().status, 0);
  site.setFake('tunnel-ip', '\n');
  const quiet = site.run(['--timer']);
  assert.strictEqual(quiet.status, 0, quiet.output);
  assert.match(quiet.stdout, /Geen \(geldig\) IP/);
  site.setFake('tunnel-ip', '999.1.1.1\n');
  assert.strictEqual(site.run(['--timer']).status, 0);
  site.commit('master');
  const needs = site.run(['--timer']);
  assert.strictEqual(needs.status, 1, 'er moet iets uitgerold worden maar er is geen vertrouwde proxy');
  assert.match(needs.stderr, /Geen geldig IP-adres/);
  assert.match(site.env(), /^TRUSTED_PROXIES=172\.18\.0\.5\/32$/m, 'het oude adres blijft; er is niets gestart');
});

test('te weinig schijfruimte weigert de eerste installatie en verwijst naar de opruimtaak', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  const out = site.run([], { FAKE_FREE_KB: String(2 * 1024 * 1024) });
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /Te weinig vrije ruimte/);
  assert.match(out.stderr, /servertaken\.sh schijf/);
  assert.ok(!fs.existsSync(path.join(site.stagingDir, '.env')), 'er is niets ingericht');
  assert.ok(!/compose/.test(site.calls()));
});

test('ontbrekende tunnelgegevens: de eerste installatie stopt met een duidelijke melding', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  fs.writeFileSync(path.join(site.fake, 'no-tunnel'), '');
  const out = site.run();
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /Tunnelcontainer aquatech-cloudflared niet gevonden/);
  assert.ok(!/compose/.test(site.calls()));
});

test('een container onder de oude servicenaam (aquatech, postgres) wordt opgeruimd en opnieuw aangemaakt', { skip: !bashAvailable }, () => {
  const site = world();
  site.commit('master');
  assert.strictEqual(site.run().status, 0);
  site.setFake('old-service', 'aquatech\n');
  site.setFake('tunnel-ip', '172.18.0.5\n');
  const before = site.calls();
  const out = site.run();
  assert.strictEqual(out.status, 0, out.output);
  const calls = site.calls().slice(before.length);
  assert.match(calls, /docker rm -f aquatech-staging\n/);
  assert.match(calls, /docker rm -f aquatech-staging-postgres\n/);
  assert.match(calls, /up -d --remove-orphans aquatech-staging-db/);
});

test('compose: eigen projectnaam en image, derde partijen op digest, alleen op 127.0.0.1, niets van de testomgeving', () => {
  const compose = fs.readFileSync(path.join(DEPLOY_DIR, 'compose.yml'), 'utf8');
  assert.match(compose, /^name: aquatech-staging$/m);
  const images = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(images.length >= 2);
  for (const image of images) {
    if (image.startsWith('aquatech-staging:')) continue;
    assert.match(image, /@sha256:[0-9a-f]{64}$/, `${image} staat niet op een vaste digest`);
  }
  assert.match(compose, /pull_policy: never/, 'het app-image wordt lokaal gebouwd, nooit uit een registry gehaald');
  assert.match(compose, /nl\.aquatech\.staging: "1"/);
  assert.match(compose, /- "127\.0\.0\.1:\$\{STAGING_PORT:-3310\}:3300"/);
  assert.match(compose, /- aquatech-staging$/m);
  // De servicenaam is ook een netwerkalias in het gedeelde tunnelnetwerk: `aquatech` of `postgres` zou verkeer van de
  // testomgeving naar staging sturen (zo ging het mis). Elke servicenaam moet dus uniek en met aquatech-staging beginnen.
  const services = [...compose.split(/^services:\n/m)[1].split(/^networks:/m)[0].matchAll(/^  ([a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
  assert.ok(services.length >= 2);
  for (const service of services) assert.match(service, /^aquatech-staging-/, `servicenaam ${service} botst mogelijk met de testomgeving`);
  assert.match(compose, /AQUATECH_STAGING=1/);
  assert.doesNotMatch(compose, /update\/(status|request)|\/var\/run\/docker\.sock/, 'geen koppeling met het updatemechanisme of de docker-socket');
  assert.doesNotMatch(compose, /container_name: aquatech(-postgres|-cloudflared)?$/m, 'geen containernaam van de testomgeving');
  assert.doesNotMatch(compose, /ghcr\.io/);
  assert.doesNotMatch(compose, /cloudflared:/, 'staging draait geen eigen tunnel');
  const example = fs.readFileSync(path.join(DEPLOY_DIR, '.env.example'), 'utf8');
  for (const key of ['STAGING_COMMIT', 'TRUSTED_PROXIES', 'TUNNEL_CONTAINER', 'TUNNEL_NETWORK', 'SETUP_CODE', 'ANTHROPIC_API_KEY']) assert.match(example, new RegExp(`^${key}=`, 'm'));
  assert.doesNotMatch(example, /^(MOLLIE|SMTP|MAIL|VISMA|DRIVE)[A-Z_]*=\S/m, 'koppelingen staan leeg');
});
