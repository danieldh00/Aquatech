// Tests voor de sprekende artikelcodes (frontend/shared/article-code.js): bouwen, teruglezen, draadmaten en de volgorde van subartikelen.
const test = require('node:test');
const assert = require('node:assert/strict');
const ArticleCode = require('../../frontend/shared/article-code.js');

test('draadmaten in duimen worden cijfers', () => {
  const expected = { '1/2"': '12', '½': '12', '3/4"': '34', '¾"': '34', '1"': '1', '1 1/4"': '114', '1¼': '114', '1 1/2"': '112', '2"': '2', '34': '34', '': '' };
  for (const [input, code] of Object.entries(expected)) assert.equal(ArticleCode.threadCode(input).code, code, input);
  assert.ok(ArticleCode.threadCode('banaan').error);
  assert.ok(ArticleCode.threadCode('5/7"').error);
});

test('een code met en zonder merk wordt gebouwd en teruggelezen', () => {
  assert.equal(ArticleCode.buildCode({ brand: 'UD', kind: 'KBI', diameter: 20, thread: '12' }).code, 'UD.KBI.20.12');
  assert.equal(ArticleCode.buildCode({ kind: 'KBI', diameter: '20', thread: '12' }).code, 'KBI.20.12');
  assert.equal(ArticleCode.buildCode({ brand: 'UD', kind: 'KBI' }).code, 'UD.KBI');
  assert.deepEqual(ArticleCode.parseCode('UD.KBI.20.12'), { brand: 'UD', kind: 'KBI', diameter: '20', thread: '12' });
  assert.deepEqual(ArticleCode.parseCode('KBI.20.12'), { brand: '', kind: 'KBI', diameter: '20', thread: '12' });
  assert.deepEqual(ArticleCode.parseCode('KBI.20'), { brand: '', kind: 'KBI', diameter: '20', thread: '' });
  assert.deepEqual(ArticleCode.parseCode('UD.KBI-2'), { brand: 'UD', kind: 'KBI-2', diameter: '', thread: '' });
  assert.equal(ArticleCode.parseCode('12345'), null);
  assert.equal(ArticleCode.parseCode('a b'), null);
  assert.ok(ArticleCode.buildCode({ brand: '1X', kind: 'KBI' }).error);
  assert.ok(ArticleCode.buildCode({ kind: 'KBI', thread: '12' }).error);
});

test('subartikelen lopen op van klein naar groot: diameter, dan draadmaat', () => {
  const codes = ['UD.KBI.32.1', 'UD.KBI.20.112', 'UD.KBI.20.12', 'UD.KBI.20.34', 'UD.KBI.20.1', 'UD.KBI.110', 'UD.KBI.20.114', 'OUD-001'];
  const sorted = [...codes].sort(ArticleCode.compareCodes);
  assert.deepEqual(sorted, ['UD.KBI.20.12', 'UD.KBI.20.34', 'UD.KBI.20.1', 'UD.KBI.20.114', 'UD.KBI.20.112', 'UD.KBI.32.1', 'UD.KBI.110', 'OUD-001']);
});
