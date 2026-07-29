const assert = require('assert/strict');
const test = require('node:test');

const { parseConfigJson } = require('../runtime-config');

test('parses configuration JSON with or without a UTF-8 BOM', () => {
  const source = '{"useDevStub":true}';

  assert.deepEqual(parseConfigJson(source), { useDevStub: true });
  assert.deepEqual(parseConfigJson(`\uFEFF${source}`), { useDevStub: true });
});

test('still rejects malformed configuration JSON', () => {
  assert.throws(() => parseConfigJson('{invalid'), /JSON/);
});
