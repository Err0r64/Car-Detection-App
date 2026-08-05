const assert = require('assert/strict');
const test = require('node:test');

const { parseConfigJson, validateAnalysisTimeouts } = require('../runtime-config');

test('parses configuration JSON with or without a UTF-8 BOM', () => {
  const source = '{"useDevStub":true}';

  assert.deepEqual(parseConfigJson(source), { useDevStub: true });
  assert.deepEqual(parseConfigJson(`\uFEFF${source}`), { useDevStub: true });
});

test('still rejects malformed configuration JSON', () => {
  assert.throws(() => parseConfigJson('{invalid'), /JSON/);
});

test('validates cloud timeouts without requiring obsolete prompt settings', () => {
  const config = {
    analysisStallTimeoutSeconds: 300,
    analysisMaxTimeoutSeconds: 2700,
    analysisPollIntervalSeconds: 5,
    analysisRequestTimeoutSeconds: 30,
  };

  assert.equal(validateAnalysisTimeouts(config), config);
  assert.throws(
    () => validateAnalysisTimeouts({ ...config, analysisPollIntervalSeconds: 0 }),
    /analysisPollIntervalSeconds/
  );
});