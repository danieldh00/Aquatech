// Beheer: elk formulier in beheer/index.html staat op zichzelf. Een <form> in een open <form> verdwijnt bij het
// inlezen door de browser, waardoor de velden bij het verkeerde formulier komen en de pagina een fout geeft.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../src/paths');

test('beheer/index.html: geen geneste formulieren en elk formulier wordt afgesloten', () => {
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'beheer', 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<(\/?)form\b[^>]*?(?:id="([^"]+)")?[^>]*>/g)];
  let open = null;
  for (const tag of tags) {
    if (tag[1] === '') {
      assert.strictEqual(open, null, `formulier ${tag[2] || '(zonder id)'} staat binnen formulier ${open}`);
      open = tag[2] || '(zonder id)';
    } else {
      assert.notStrictEqual(open, null, 'een </form> zonder openend formulier');
      open = null;
    }
  }
  assert.strictEqual(open, null, `formulier ${open} wordt niet afgesloten`);
});
