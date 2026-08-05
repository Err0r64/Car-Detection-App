const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  BASIC_RUNTIME_CHECK,
  DEPENDENCY_CHECK,
  pythonPathsFromOutput,
  resolvePythonRuntime,
} = require('../python-runtime');

const newline = String.fromCharCode(10);
const driveRoot = 'C:' + path.win32.sep;
const python314 = path.win32.join(driveRoot, 'Program Files', 'Python314', 'python.exe');
const python39 = path.win32.join(
  driveRoot,
  'Users',
  'tester',
  'AppData',
  'Local',
  'Programs',
  'Python',
  'Python39',
  'python.exe'
);
const storePython = path.win32.join(
  driveRoot,
  'Users',
  'tester',
  'AppData',
  'Local',
  'Microsoft',
  'WindowsApps',
  'python.exe'
);

test('extracts interpreter paths from py launcher and where output', () => {
  const output = [
    ' -V:3.14 *        ' + python314,
    python39,
    storePython,
  ].join(newline);

  assert.deepEqual(
    pythonPathsFromOutput(output),
    [python314, python39, storePython]
  );
});

test('falls back to an installed Python that has pipeline dependencies', () => {
  const calls = [];
  const runProcess = (command, args) => {
    calls.push([command, args]);
    if (command === 'python') {
      assert.equal(args[1], DEPENDENCY_CHECK);
      return { status: 1, stdout: python39 + newline };
    }
    if (command === 'py') {
      return {
        status: 0,
        stdout: ' -V:3.14 *        ' + python314 + newline
          + ' -V:3.9            ' + python39 + newline,
      };
    }
    if (command === 'where.exe') {
      return { status: 0, stdout: python39 + newline + storePython + newline };
    }
    if (command === python314) {
      return { status: 0, stdout: python314 + newline };
    }
    if (command === python39) {
      return { status: 1, stdout: python39 + newline };
    }
    throw new Error('Unexpected command: ' + command);
  };

  const result = resolvePythonRuntime('python', {
    platform: 'win32',
    runProcess,
  });

  assert.equal(result.command, python314);
  assert.deepEqual(result.attempted, [python39, python314]);
  assert.equal(calls.some(([command]) => command === storePython), false);
});

test('cloud proxy mode only requires a working Python interpreter', () => {
  const result = resolvePythonRuntime('python', {
    platform: 'linux',
    dependencyCheck: BASIC_RUNTIME_CHECK,
    runProcess: (_command, args) => {
      assert.equal(args[1], BASIC_RUNTIME_CHECK);
      return { status: 0, stdout: '/usr/bin/python3\n' };
    },
  });

  assert.equal(result.command, '/usr/bin/python3');
});
test('does not override an explicitly configured absolute interpreter', () => {
  const calls = [];
  const result = resolvePythonRuntime(python39, {
    platform: 'win32',
    runProcess: (command) => {
      calls.push(command);
      return { status: 1, stdout: python39 + newline };
    },
  });

  assert.equal(result.command, null);
  assert.deepEqual(result.attempted, [python39]);
  assert.deepEqual(calls, [python39]);
});