// Test van deploy/apps01/remove-staging.sh (servertaak 016) met een nagebootste docker en systemctl: alles van staging
// verdwijnt, de testomgeving en vreemde containers blijven staan, een tweede run doet niets meer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01', 'remove-staging.sh');
const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
case "$1" in
  inspect)
    if [[ "$2" == "-f" ]]; then
      name="$4"; [[ -f "$FAKE/project-$name" ]] && cat "$FAKE/project-$name"; [[ -f "$FAKE/project-$name" ]] || exit 1
    else [[ -f "$FAKE/network" ]] || exit 1; fi ;;
  network) if [[ "$2" == "rm" ]]; then rm -f "$FAKE/network"; fi ;;
  image)
    if [[ "$2" == "ls" ]]; then cat "$FAKE/images" 2>/dev/null; fi ;;
esac
exit 0
`;

/**
 * Bouwt een nagebootste server: nep-docker/systemctl, een stagingmap en units.
 * @returns {object} Hulpfuncties en paden van de testwereld.
 */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-staging-'));
  const bin = path.join(root, 'bin');
  const fake = path.join(root, 'fake');
  const stagingDir = path.join(root, 'opt', 'aquatech-staging');
  const systemdDir = path.join(root, 'systemd');
  for (const dir of [bin, fake, path.join(stagingDir, 'repo'), systemdDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "$FAKE/calls"\n', { mode: 0o755 });
  // De CI draait niet als root: de nep-id doet alsof het script al root is.
  fs.writeFileSync(path.join(bin, 'id'), '#!/usr/bin/env bash\n[[ "$1" == "-u" ]] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stagingDir, '.env'), 'STAGING_COMMIT=abc\n');
  fs.writeFileSync(path.join(systemdDir, 'aquatech-staging-update.timer'), '[Timer]\n');
  fs.writeFileSync(path.join(systemdDir, 'aquatech-staging-update.service'), '[Service]\n');
  fs.writeFileSync(path.join(systemdDir, 'aquatech-update.timer'), '[Timer]\n');
  fs.writeFileSync(path.join(fake, 'project-aquatech-staging'), 'aquatech-staging\n');
  fs.writeFileSync(path.join(fake, 'project-aquatech-staging-postgres'), 'aquatech-staging\n');
  fs.writeFileSync(path.join(fake, 'project-aquatech'), 'aquatech\n');
  fs.writeFileSync(path.join(fake, 'network'), '');
  fs.writeFileSync(path.join(fake, 'images'), 'aquatech-staging:abc\naquatech-staging:def\nghcr.io/danieldh00/aquatech:latest\n');
  /**
   * Draait het script met de nagebootste omgeving.
   * @returns {object} Resultaat van spawnSync.
   */
  const run = () => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, STAGING_DIR: stagingDir, SYSTEMD_DIR: systemdDir },
  });
  /**
   * Alle opgenomen docker/systemctl-aanroepen.
   * @returns {string} De aanroepen, één per regel.
   */
  const calls = () => fs.readFileSync(path.join(fake, 'calls'), 'utf8');
  return { root, stagingDir, systemdDir, fake, run, calls };
}

test('staging wordt volledig verwijderd; de testomgeving blijft staan', { skip: !bashAvailable }, () => {
  const site = world();
  const out = site.run();
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.ok(!fs.existsSync(site.stagingDir), 'de stagingmap is weg');
  assert.deepStrictEqual(fs.readdirSync(site.systemdDir), ['aquatech-update.timer'], 'alleen de staging-units zijn weg');
  const calls = site.calls();
  assert.match(calls, /systemctl disable --now aquatech-staging-update\.timer/);
  assert.match(calls, /docker rm -f aquatech-staging\n/);
  assert.match(calls, /docker rm -f aquatech-staging-postgres\n/);
  assert.match(calls, /docker network rm aquatech-staging_default/);
  assert.match(calls, /docker image rm aquatech-staging:abc/);
  assert.match(calls, /docker image rm aquatech-staging:def/);
  assert.ok(!/image rm ghcr/.test(calls), 'het productie-image blijft');
  assert.ok(!/aquatech-cloudflared|aquatech-postgres|rm -f aquatech\n|network rm \S*tunnel/.test(calls), 'de testomgeving en de tunnel worden niet aangeraakt');
});

test('een container met dezelfde naam uit een ander project blijft staan', { skip: !bashAvailable }, () => {
  const site = world();
  fs.writeFileSync(path.join(site.fake, 'project-aquatech-staging'), 'iets-anders\n');
  const out = site.run();
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.ok(!/docker rm -f aquatech-staging\n/.test(site.calls()), 'niet-staging-container niet verwijderd');
  assert.match(out.stdout, /niet aangeraakt/);
});

test('een tweede run en een andere map: niets te doen, geen onzin verwijderen', { skip: !bashAvailable }, () => {
  const site = world();
  assert.strictEqual(site.run().status, 0);
  for (const name of ['project-aquatech-staging', 'project-aquatech-staging-postgres', 'network']) fs.rmSync(path.join(site.fake, name), { force: true });
  const again = site.run();
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /Staging is verwijderd/);
  // Een map met een andere naam of zonder stagingbestanden wordt geweigerd.
  const other = path.join(site.root, 'opt', 'iets-anders');
  fs.mkdirSync(other, { recursive: true });
  const refused = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(site.root, 'bin')}:${process.env.PATH}`, FAKE: site.fake, STAGING_DIR: other, SYSTEMD_DIR: site.systemdDir } });
  assert.notStrictEqual(refused.status, 0);
  assert.ok(fs.existsSync(other), 'een vreemde map blijft staan');
});
