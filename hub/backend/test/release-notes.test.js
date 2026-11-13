// Tests voor tools/release-notes.js: bestanden in changes/ worden versie, changelog en nieuws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../tools/release-notes');

const FRAGMENT = `---
titel: Dozen en pallets
---

## Nieuws
- [voorraad] Een doos kan in de wagen.
- Iedereen ziet dit 'punt'.

## Changelog
Technisch **verhaal**.
`;

/**
 * Maakt een tijdelijke map met package.json, changelog, releases.js en changes/.
 * @param {Object<string,string>} fragments Bestandsnaam -> inhoud.
 * @returns {object} Paden voor applyFragments.
 */
function makeWorkspace(fragments) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  fs.mkdirSync(path.join(root, 'changes'));
  for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(root, 'changes', name), text);
  fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "x",\n  "version": "1.2.8"\n}\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.8\n\nOud.\n');
  fs.writeFileSync(path.join(root, 'releases.js'), 'const RELEASES = [\n  {\n    version: \'1.2.8\',\n  },\n];\n');
  return {
    root,
    options: {
      date: '2026-11-12',
      directory: path.join(root, 'changes'),
      packageFile: path.join(root, 'package.json'),
      changelogFile: path.join(root, 'CHANGELOG.md'),
      releasesFile: path.join(root, 'releases.js'),
    },
  };
}

test('nextVersion: patch, na .9 de volgende minor, bump minor', () => {
  assert.strictEqual(tool.nextVersion('1.11.5'), '1.11.6');
  assert.strictEqual(tool.nextVersion('1.11.9'), '1.12.0');
  assert.strictEqual(tool.nextVersion('1.11.2', 'minor'), '1.12.0');
  assert.throws(() => tool.nextVersion('abc'));
});

test('parseFragment leest titel, punten met rechten en changelog', () => {
  const fragment = tool.parseFragment(FRAGMENT);
  assert.strictEqual(fragment.title, 'Dozen en pallets');
  assert.deepStrictEqual(fragment.items, [{ text: 'Een doos kan in de wagen.', rights: ['voorraad'] }, { text: "Iedereen ziet dit 'punt'.", rights: [] }]);
  assert.strictEqual(fragment.changelog, 'Technisch **verhaal**.');
  assert.throws(() => tool.parseFragment('geen kop'), /---/);
  assert.throws(() => tool.parseFragment('---\ntitel: x\n---\n## Nieuws\n- a\n'), /Changelog/);
  assert.throws(() => tool.parseFragment('---\ntitel: x\nbump: major\n---\n## Changelog\nx\n'), /major/);
  assert.deepStrictEqual(tool.parseFragment('---\ntitel: x\n---\n## Changelog\nx\n').items, []);
});

test('applyFragments geeft elke wijziging een eigen versie en ruimt op', () => {
  const { root, options } = makeWorkspace({ 'a.md': FRAGMENT, 'b.md': FRAGMENT.replace('Dozen en pallets', 'Tweede') });
  const versions = tool.applyFragments(options);
  assert.strictEqual(versions.length, 2);
  assert.deepStrictEqual(versions.map((version) => version.split('.').slice(0, 2).join('.')), ['1.2', '1.3']);
  assert.strictEqual(JSON.parse(fs.readFileSync(options.packageFile, 'utf8')).version, versions[1]);
  const changelog = fs.readFileSync(options.changelogFile, 'utf8');
  assert.ok(changelog.indexOf(`## ${versions[1]}`) < changelog.indexOf(`## ${versions[0]}`));
  assert.ok(changelog.indexOf(`## ${versions[0]}`) < changelog.indexOf('## 1.2.8'));
  const releases = fs.readFileSync(options.releasesFile, 'utf8');
  assert.match(releases, /for: \['voorraad'\]/);
  assert.ok(releases.includes("Iedereen ziet dit \\'punt\\'."));
  assert.ok(releases.indexOf(versions[1]) < releases.indexOf(versions[0]));
  const loaded = new Function(`${releases}; return RELEASES;`)();
  assert.strictEqual(loaded[0].version, versions[1]);
  assert.deepStrictEqual(fs.readdirSync(options.directory), []);
  assert.deepStrictEqual(tool.applyFragments(options), [], 'tweede keer is er niets te doen');
  fs.rmSync(root, { recursive: true });
});

test('applyFragments laat alles ongemoeid bij een kapot bestand', () => {
  const { root, options } = makeWorkspace({ 'goed.md': FRAGMENT, 'kapot.md': 'niets' });
  assert.throws(() => tool.applyFragments(options), /kapot\.md/);
  assert.strictEqual(JSON.parse(fs.readFileSync(options.packageFile, 'utf8')).version, '1.2.8');
  assert.strictEqual(fs.readdirSync(options.directory).length, 2);
  fs.rmSync(root, { recursive: true });
});

test('evaluatePullRequest: fragment verplicht, versie en releases.js verboden, label als uitzondering', () => {
  const app = { status: 'M', name: 'hub/backend/src/server.js' };
  const fragment = { status: 'A', name: 'changes/iets.md' };
  assert.deepStrictEqual(tool.evaluatePullRequest({ files: [app, fragment], versionLineChanged: false, labels: [] }), []);
  assert.strictEqual(tool.evaluatePullRequest({ files: [app], versionLineChanged: false, labels: [] }).length, 1);
  assert.deepStrictEqual(tool.evaluatePullRequest({ files: [app], versionLineChanged: false, labels: ['geen-releasenotes'] }), []);
  assert.deepStrictEqual(tool.evaluatePullRequest({ files: [{ status: 'M', name: 'README.md' }], versionLineChanged: false, labels: [] }), []);
  assert.strictEqual(tool.evaluatePullRequest({ files: [app, fragment, { status: 'M', name: 'hub/frontend/nieuws/releases.js' }], versionLineChanged: false, labels: [] }).length, 1);
  assert.strictEqual(tool.evaluatePullRequest({ files: [app, fragment], versionLineChanged: true, labels: ['geen-releasenotes'] }).length, 1);
  assert.strictEqual(tool.evaluatePullRequest({ files: [app, { status: 'D', name: 'changes/oud.md' }], versionLineChanged: false, labels: [] }).length, 1);
});

test('de bestanden in changes/ van de repository kloppen', () => {
  assert.deepStrictEqual(tool.checkFragments(), []);
});
