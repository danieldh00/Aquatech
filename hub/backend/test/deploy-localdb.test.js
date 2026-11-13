// De scripts en het compose-bestand voor de eigen PostgreSQL naast de app (deploy/apps01): syntaxis, geen geheimen of
// gepubliceerde poorten, de Supabase-URL blijft de terugvaloptie, en de bediening vanaf de Proxmox-host weigert onbekende opdrachten.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEPLOY_DIR = path.join(__dirname, '..', '..', '..', 'deploy', 'apps01');
const SCRIPTS = ['localdb/local-db.sh', 'localdb/pg-backup.sh', 'pve/db-local.sh'];

/**
 * Leest een bestand uit deploy/apps01.
 * @param {string} relativePath Pad binnen deploy/apps01.
 * @returns {string} De inhoud.
 */
const read = (relativePath) => fs.readFileSync(path.join(DEPLOY_DIR, relativePath), 'utf8');

test('de scripts hebben geen syntaxfouten en zijn uitvoerbaar', () => {
  for (const script of SCRIPTS) {
    const file = path.join(DEPLOY_DIR, script);
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${script}: ${result.stderr}`);
    assert.ok(fs.statSync(file).mode & 0o100, `${script} is niet uitvoerbaar`);
  }
});

test('compose.localdb.yml: geen gepubliceerde poort, app wacht op de database, URL en wachtwoord uit secrets', () => {
  const compose = read('compose.localdb.yml');
  assert.ok(!/^\s*ports:/m.test(compose), 'de database mag geen poort publiceren');
  assert.match(compose, /image: postgres:\$\{POSTGRES_TAG:-17\}/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE=\/run\/secrets\/postgres-password/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD=/, 'geen wachtwoord in een omgevingsvariabele');
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /file: \.\/secrets\/database-url-local/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /\.\/pgdata:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /no-new-privileges:true/);
});

test('de basis compose.yml blijft op Supabase (terugvaloptie) en update.sh herkent de database nog', () => {
  const compose = read('compose.yml');
  assert.match(compose, /file: \.\/secrets\/database-url\s*$/m);
  assert.match(compose, /^\s*- DATABASE_URL_FILE=/m);
  assert.doesNotMatch(compose, /localdb/);
});

test('migrate: eerst controleren, dan pas omzetten, en terugdraaien bij een fout', () => {
  const script = read('localdb/local-db.sh');
  const order = ['pg_dump -Fc -n aquatech', 'pg_restore -U aquatech', 'fingerprint bron', 'env_set COMPOSE_FILE'].map((needle) => script.indexOf(needle));
  assert.ok(order.every((position) => position > 0), 'een stap ontbreekt');
  assert.deepStrictEqual([...order].sort((left, right) => left - right), order, 'volgorde: dump, restore, controle, omzetten');
  assert.match(script, /--single-transaction --exit-on-error/);
  assert.match(script, /trap on_migrate_exit EXIT/);
  assert.match(script, /--env-file "\$ENV_FILE"/, 'het Supabase-wachtwoord gaat via een env-file, niet via een argument');
  assert.doesNotMatch(script, /PGPASSWORD=\$/, 'geen wachtwoord op een opdrachtregel');
});

test('pg-backup.sh versleutelt, controleert en ruimt op', () => {
  const script = read('localdb/pg-backup.sh');
  assert.match(script, /openssl enc -aes-256-cbc -pbkdf2/);
  assert.match(script, /pg_restore -l/);
  assert.match(script, /KEEP_DAILY_DAYS:-14/);
  assert.match(script, /umask 077/);
});

test('de timer draait elke nacht en haalt een gemiste back-up in', () => {
  const timer = read('systemd/aquatech-pg-backup.timer');
  assert.match(timer, /OnCalendar=\*-\*-\* 02:30:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(read('systemd/aquatech-pg-backup.service'), /ExecStart=\/bin\/bash \/opt\/apps\/aquatech\/pg-backup\.sh/);
});

test('pve/db-local.sh weigert een onbekende opdracht (exitcode 2) en ondersteunt LXC en VM', () => {
  const file = path.join(DEPLOY_DIR, 'pve', 'db-local.sh');
  if (process.getuid && process.getuid() === 0) {
    const result = spawnSync('bash', [file, 'onzin'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 2);
  }
  const script = read('pve/db-local.sh');
  assert.match(script, /pct exec/);
  assert.match(script, /qm list/);
  assert.match(script, /APPS01_VMID/);
  assert.match(script, /APPS01_CTID/);
  assert.match(script, /systemd-run/);
});
