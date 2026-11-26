// Tests voor de vangrail: draaien met `node --test .claude/hooks/` (geen database nodig).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBash, checkFile } from './guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const edit = (oldText, newText) => [{ old: oldText, new: newText }];
const denied = (result) => result.deny.length > 0;

test('versie en releasebestanden zijn verboden', () => {
  assert.ok(denied(checkFile('hub/CHANGELOG.md', edit('a', 'b'))));
  assert.ok(denied(checkFile('hub/backend/package.json', edit('"version": "1.0.0"', '"version": "1.0.1"'))));
  assert.ok(!denied(checkFile('hub/backend/package.json', edit('"a": 1', '"a": 2'))));
  assert.ok(denied(checkFile('hub/frontend/nieuws/releases.js', edit("{ text: 'x' }", "{ text: 'y' }"))));
});

test('releases.js: alleen een doelgroep toevoegen mag', () => {
  const oud = "{ text: 'x' },";
  assert.ok(!denied(checkFile('hub/frontend/nieuws/releases.js', edit(oud, "{ text: 'x', for: ['voorraad'] },"))));
  assert.ok(denied(checkFile('hub/frontend/nieuws/releases.js', edit("{ text: 'x', for: ['a'] },", "{ text: 'x', for: ['b'] },"))));
});

test('SQLite, Vue, SELECT *, CDN en absolute URL\'s worden geblokkeerd', () => {
  assert.ok(denied(checkFile('hub/backend/src/platform/x.js', edit('', "const Database = require('better-sqlite3');"))));
  assert.ok(denied(checkFile('hub/backend/src/platform/x.js', edit('', 'db.all(`SELECT * FROM users`)'))));
  assert.ok(denied(checkFile('hub/backend/src/platform/x.js', edit('', 'db.all(`SELECT u.* FROM users u`)'))));
  assert.ok(denied(checkFile('hub/frontend/x/index.html', edit('', '<script src="https://cdn.example.com/a.js"></script>'))));
  assert.ok(denied(checkFile('hub/frontend/x/index.html', edit('', '<link rel="stylesheet" href="/css/app.css">'))));
  assert.ok(denied(checkFile('hub/frontend/x/index.html', edit('', '<script type="module" src="a.js"></script>'))));
  assert.ok(denied(checkFile('hub/frontend/x/app.js', edit('', 'import { createApp } from "vue";'))));
  assert.ok(!denied(checkFile('hub/frontend/x/index.html', edit('', '<script src="app.js?v=1"></script>'))));
});

test('bestaande overtredingen blokkeren niet (alleen nieuwe regels tellen)', () => {
  const oud = 'db.all(`SELECT * FROM users`);';
  assert.ok(!denied(checkFile('hub/backend/src/platform/x.js', edit(oud, `${oud}\n// opmerking`))));
});

test('voorraad, terugbetalen en overslaan van tests', () => {
  assert.ok(denied(checkFile('hub/backend/src/webshop/x.js', edit('', 'UPDATE stock_items SET on_hand = 1'))));
  assert.ok(!denied(checkFile('hub/backend/src/artikelen/stock.js', edit('', 'UPDATE stock_items SET on_hand = 1'))));
  assert.ok(denied(checkFile('hub/backend/src/webshop/x.js', edit('', 'await mollie.createRefund(a)'))));
  assert.ok(denied(checkFile('hub/backend/test/x.test.js', edit('', "test.skip('a', () => {})"))));
});

test('secrets en modelnamen', () => {
  assert.ok(denied(checkFile('docs/x.md', edit('', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'))));
  assert.ok(denied(checkFile('docs/x.md', edit('', 'gebruik claude-' + 'son' + 'net-5-5'))));
  assert.ok(!denied(checkFile('docs/x.md', edit('', 'gewone tekst'))));
});

test('CSV geeft een waarschuwing, geen blokkade', () => {
  const result = checkFile('hub/backend/src/verkoop/x.js', edit('', "res.type('text/csv')"));
  assert.equal(result.deny.length, 0);
  assert.equal(result.warn.length, 1);
});

test('werkflow en vangrails vragen bevestiging; master blokkeert bewerken', () => {
  assert.equal(checkFile('.github/workflows/claude-review.yml', edit('a', 'b')).ask.length, 1);
  assert.equal(checkFile('.claude/hooks/guard.mjs', edit('a', 'b')).ask.length, 1);
  assert.ok(denied(checkFile('docs/x.md', edit('a', 'b'), true)));
});

test('Bash: admin-merge, pkill, raw-URL, develop, force-push, master', () => {
  assert.ok(denied(checkBash('gh pr merge 12 --squash --admin')));
  assert.ok(!denied(checkBash('gh pr merge 12 --squash --auto')));
  assert.ok(denied(checkBash('pkill -f node')));
  assert.ok(!denied(checkBash('kill $(lsof -ti tcp:3300)')));
  assert.ok(denied(checkBash('curl https://raw.githubusercontent.com/danieldh00/Aquatech/master/a.sh')));
  assert.ok(!denied(checkBash(`curl https://raw.githubusercontent.com/danieldh00/Aquatech/${'a'.repeat(40)}/a.sh`)));
  assert.ok(denied(checkBash('git push origin develop')));
  assert.ok(denied(checkBash('git push --force origin claude/x')));
  assert.ok(!denied(checkBash('git push --force-with-lease -u origin claude/x')));
  assert.ok(denied(checkBash('git push origin HEAD:master')));
  assert.ok(denied(checkBash('git commit -m x', { branch: 'master' })));
  assert.ok(!denied(checkBash('git commit -m x', { branch: 'claude/x' })));
  assert.ok(denied(checkBash("sed -i 's/a/b/' hub/CHANGELOG.md")));
  assert.ok(!denied(checkBash('cat hub/CHANGELOG.md | head')));
  assert.ok(denied(checkBash('gh api -X PUT repos/o/r/branches/master/protection')));
});

test('Bash: omleiding naar releasebestanden, kopie ervan en push gevolgd door checkout', () => {
  assert.ok(denied(checkBash('echo x > hub/CHANGELOG.md')));
  assert.ok(denied(checkBash('echo x >> hub/CHANGELOG.md')));
  assert.ok(denied(checkBash('cp /tmp/a hub/frontend/nieuws/releases.js')));
  assert.ok(!denied(checkBash('cp hub/CHANGELOG.md /tmp/a')));
  assert.ok(!denied(checkBash('git push -u origin claude/x && git checkout master', { branch: 'claude/x' })));
  assert.ok(denied(checkBash('echo hoi; git push origin master', { branch: 'claude/x' })));
});

test('Bash: Co-Authored-By-regel met modelnaam mag, de rest niet', () => {
  const trailer = 'Co-Authored-By: Claude Son' + 'net 5.5 <noreply@anthropic.com>';
  assert.ok(!denied(checkBash(`git commit -m "fix\n\n${trailer}"`, { branch: 'claude/x' })));
  assert.ok(denied(checkBash('git commit -m "gemaakt met claude-' + 'opus-5-5"', { branch: 'claude/x' })));
});

test('Bash: Co-Authored-By op dezelfde regel als git commit mag', () => {
  const trailer = 'Co-Authored-By: Claude Hai' + 'ku 5.5 <noreply@anthropic.com>';
  assert.ok(!denied(checkBash(`git commit -m "Fix" -m "${trailer}"`, { branch: 'claude/x' })));
});

test('de hook draait ook via een symlink naar het project (geen fail-open)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hook-'));
  const link = join(directory, 'project');
  symlinkSync(root, link, 'dir');
  const call = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(link, 'hub/CHANGELOG.md'), old_string: 'a', new_string: 'b' } });
  const run = spawnSync('node', [join(link, '.claude/hooks/guard.mjs')], { input: call, env: { ...process.env, CLAUDE_PROJECT_DIR: link, AQUATECH_HOOKS_OFF: '' }, encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
});

test('Bash: waarschuwing zonder changes-fragment', () => {
  const result = checkBash('git push -u origin claude/x', { branch: 'claude/x', hubChangedWithoutFragment: true });
  assert.equal(result.warn.length, 1);
});
