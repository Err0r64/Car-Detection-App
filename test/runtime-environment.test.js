'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  WINDOWS_PATH_KEYS,
  mergeWindowsPaths,
  refreshWindowsPath,
  registryPathFromOutput,
} = require('../runtime-environment');

test('extracts Path from Windows registry output', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    C:\\Tools;%LOCALAPPDATA%\\Programs\\Bin',
    '',
  ].join('\r\n');

  assert.equal(
    registryPathFromOutput(output),
    'C:\\Tools;%LOCALAPPDATA%\\Programs\\Bin'
  );
});

test('merges Windows paths with expansion and case-insensitive deduplication', () => {
  const environment = {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  };

  assert.equal(
    mergeWindowsPaths(
      [
        'C:\\Windows;C:\\Tools',
        'c:\\tools;%LOCALAPPDATA%\\Programs\\Bin',
      ],
      environment
    ),
    [
      'C:\\Windows',
      'C:\\Tools',
      'C:\\Users\\tester\\AppData\\Local\\Programs\\Bin',
    ].join(path.win32.delimiter)
  );
});

test('refreshes a stale process Path from machine and user registry values', () => {
  const environment = {
    Path: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  };
  const values = new Map([
    [WINDOWS_PATH_KEYS[0], 'C:\\Windows;C:\\MachineTools'],
    [WINDOWS_PATH_KEYS[1], '%LOCALAPPDATA%\\UserTools'],
  ]);
  const calls = [];

  const changed = refreshWindowsPath({
    platform: 'win32',
    environment,
    runProcess: (command, args) => {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: '    Path    REG_EXPAND_SZ    ' + values.get(args[1]) + '\r\n',
      };
    },
  });

  assert.equal(changed, true);
  assert.equal(
    environment.Path,
    [
      'C:\\Windows',
      'C:\\MachineTools',
      'C:\\Users\\tester\\AppData\\Local\\UserTools',
    ].join(path.win32.delimiter)
  );
  assert.deepEqual(
    calls.map(([, args]) => args[1]),
    WINDOWS_PATH_KEYS
  );
});

test('does not query the registry outside Windows', () => {
  const environment = { PATH: '/usr/bin' };
  const changed = refreshWindowsPath({
    platform: 'linux',
    environment,
    runProcess: () => {
      throw new Error('registry should not be queried');
    },
  });

  assert.equal(changed, false);
  assert.equal(environment.PATH, '/usr/bin');
});
