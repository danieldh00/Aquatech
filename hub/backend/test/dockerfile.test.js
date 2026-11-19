// Bewaakt dat het release-image slank blijft: geen tests of dev-tools in de eindstap,
// maar wel het hulpscript dat update.sh uit het image haalt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hubDir = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(hubDir, 'Dockerfile'), 'utf8');
const finalStage = dockerfile.split(/^FROM /m).pop();

test('eindstap kopieert alleen src en release-info, geen hele backendmap', () => {
  assert.doesNotMatch(finalStage, /^COPY backend \.\/?\s*$/m);
  assert.match(finalStage, /^COPY backend\/src \.\/src$/m);
  assert.match(finalStage, /^COPY backend\/tools\/release-info\.js \.\/tools\/release-info\.js$/m);
});

test('release-info.js heeft alleen bestanden die in het image zitten', () => {
  const source = fs.readFileSync(path.join(hubDir, 'backend', 'tools', 'release-info.js'), 'utf8');
  const requires = [...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]);
  for (const target of requires) {
    assert.doesNotMatch(target, /test|codestyle|bench/, `release-info gebruikt ${target}`);
  }
});

test('.dockerignore sluit de tests en node_modules uit', () => {
  const ignore = fs.readFileSync(path.join(hubDir, '.dockerignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('backend/test'));
  assert.ok(ignore.includes('backend/node_modules'));
});
