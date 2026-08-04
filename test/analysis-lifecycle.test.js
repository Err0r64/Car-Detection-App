const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAnalysisWatchdog,
  formatAnalysisFailure,
  removeRunDirectory,
  terminateProcessTree,
  validateProtocolEvent,
} = require('../analysis-lifecycle');

test('validates the frozen JSONL protocol stages and events', () => {
  assert.equal(validateProtocolEvent({ stage: 'proxy', event: 'start' }), null);
  assert.equal(validateProtocolEvent({ stage: 'analyzing', event: 'retry' }), null);
  assert.equal(validateProtocolEvent({ stage: 'parsing', event: 'done' }), null);
  assert.match(validateProtocolEvent(null), /JSON object/);
  assert.match(validateProtocolEvent({ stage: 'unknown', event: 'start' }), /unknown stage/);
  assert.match(validateProtocolEvent({ stage: 'proxy', event: 'unknown' }), /unknown event/);
  assert.match(
    validateProtocolEvent({ stage: 'proxy', event: 'done' }),
    /parsing stage/
  );
  assert.match(
    validateProtocolEvent({ stage: 'upload', event: 'error' }),
    /include a message/
  );
});

test('formats failures with the active stage and final stderr detail', () => {
  assert.equal(
    formatAnalysisFailure('upload', 'Gemini request failed', 'connection refused'),
    'upload: Gemini request failed\nDetails: connection refused'
  );
  assert.equal(
    formatAnalysisFailure('processing', 'processing service unavailable', 'service unavailable'),
    'processing: processing service unavailable'
  );
});

test('recursively removes an analysis run directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-lifecycle-test-'));
  const nested = path.join(directory, 'raw');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'response.txt'), 'test');

  assert.equal(removeRunDirectory(directory), null);
  assert.equal(fs.existsSync(directory), false);
});

test('uses taskkill for the complete process tree on Windows', () => {
  const calls = [];
  let unrefCalled = false;
  const child = {
    pid: 321,
    kill: (signal) => calls.push(['child.kill', signal]),
  };
  const spawnProcess = (command, args, options) => {
    calls.push(['spawn', command, args, options]);
    return { unref: () => { unrefCalled = true; } };
  };

  const timer = terminateProcessTree(child, { platform: 'win32', spawnProcess });

  assert.equal(timer, null);
  assert.deepEqual(calls[0], ['child.kill', 'SIGTERM']);
  assert.equal(calls[1][0], 'spawn');
  assert.equal(calls[1][1], 'taskkill.exe');
  assert.deepEqual(calls[1][2], ['/pid', '321', '/T', '/F']);
  assert.equal(unrefCalled, true);
});

test('terminates a POSIX process group and escalates after the grace period', () => {
  const signals = [];
  let forceKill;
  let timerUnrefCalled = false;
  const child = {
    pid: 654,
    exitCode: null,
    signalCode: null,
    kill: (signal) => signals.push(['child', signal]),
  };
  const timer = { unref: () => { timerUnrefCalled = true; } };

  const returnedTimer = terminateProcessTree(child, {
    platform: 'linux',
    graceMs: 25,
    killProcess: (pid, signal) => signals.push([pid, signal]),
    setTimeoutFn: (callback, delay) => {
      assert.equal(delay, 25);
      forceKill = callback;
      return timer;
    },
  });

  assert.equal(returnedTimer, timer);
  assert.equal(timerUnrefCalled, true);
  assert.deepEqual(signals, [[-654, 'SIGTERM']]);
  forceKill();
  assert.deepEqual(signals, [[-654, 'SIGTERM'], [-654, 'SIGKILL']]);
});

test('analysis watchdog resets its stall timer when progress arrives', () => {
  const timers = [];
  const cleared = [];
  const events = [];
  const setTimeoutFn = (callback, delay) => {
    const timer = {
      callback,
      delay,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      },
    };
    timers.push(timer);
    return timer;
  };

  const watchdog = createAnalysisWatchdog({
    stallMs: 100,
    maxMs: 500,
    onStall: () => events.push('stall'),
    onMax: () => events.push('max'),
    setTimeoutFn,
    clearTimeoutFn: (timer) => cleared.push(timer),
  });

  watchdog.start();
  assert.equal(timers.length, 2);
  assert.equal(timers[0].delay, 100);
  assert.equal(timers[1].delay, 500);
  assert.equal(timers.every((timer) => timer.unrefCalled), true);

  watchdog.touch();
  assert.equal(cleared.includes(timers[0]), true);
  assert.equal(timers[2].delay, 100);

  timers[2].callback();
  assert.deepEqual(events, ['stall']);

  watchdog.stop();
  timers[1].callback();
  assert.deepEqual(events, ['stall']);
});

test('analysis watchdog requires a larger maximum duration', () => {
  assert.throws(
    () => createAnalysisWatchdog({
      stallMs: 100,
      maxMs: 100,
      onStall() {},
      onMax() {},
    }),
    /greater than stallMs/
  );
});
