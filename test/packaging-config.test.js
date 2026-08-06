'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const configPath = path.join(__dirname, '..', 'electron-builder.yml');
const builderConfig = fs.readFileSync(configPath, 'utf8');
const packageMetadata = require('../package.json');

test('packaging includes every main-process runtime module', () => {
  const requiredModules = [
    'analysis-lifecycle.js',
    'clip-export.js',
    'cloud-analysis-client.js',
    'project-workspace.js',
    'python-runtime.js',
    'runtime-config.js',
    'runtime-environment.js',
    'runtime-paths.js',
  ];

  for (const moduleName of requiredModules) {
    assert.ok(
      builderConfig.includes('  - ' + moduleName),
      moduleName + ' must be included in the packaged ASAR'
    );
  }
});

test('tester installer is an assisted per-user x64 NSIS build', () => {
  assert.ok(builderConfig.includes('\nwin:\n'));
  assert.ok(builderConfig.includes('target: nsis'));
  assert.ok(builderConfig.includes('        - x64'));
  assert.ok(builderConfig.includes('  oneClick: false'));
  assert.ok(builderConfig.includes('  perMachine: false'));
  assert.ok(builderConfig.includes('  allowToChangeInstallationDirectory: true'));
});

test('macOS packaging produces an unsigned DMG and an unpacked diagnostic app', () => {
  assert.ok(builderConfig.includes('\nmac:\n'));
  assert.ok(builderConfig.includes('    - target: dmg'));
  assert.ok(builderConfig.includes('  identity: null'));
  assert.ok(builderConfig.includes('\ndmg:\n'));
  assert.equal(packageMetadata.scripts['pack:mac'], 'electron-builder --mac --dir');
  assert.equal(packageMetadata.scripts['installer:mac'], 'electron-builder --mac dmg');
});
