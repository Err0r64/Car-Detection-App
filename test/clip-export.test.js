const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  buildClipFilename,
  buildExportManifest,
  buildFfmpegArgs,
  findAvailableOutputPath,
  parseFfmpegTimestamp,
  startClipBatchExport,
  startSingleClipExport,
  validateClipInterval,
  validateClipIntervals,
  writeExportManifest,
} = require('../clip-export');

test('builds stable safe filenames without discarding fractional bounds', () => {
  assert.equal(
    buildClipFilename({ car_number: '', start_s: 12, end_s: 15 }),
    'carUNK_12s-15s.mp4'
  );
  assert.equal(
    buildClipFilename({ car_number: ' 29|33 ', start_s: 8.25, end_s: 22.75 }),
    'car29_33_8.25s-22.75s.mp4'
  );
  assert.equal(
    buildClipFilename({ car_number: '../../bad:name', start_s: 0.1004, end_s: 1.9996 }),
    'carbad_name_0.1s-2s.mp4'
  );
});

test('finds a collision-safe output filename', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-export-name-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'car27_8s-10s.mp4'), 'first');
    fs.writeFileSync(path.join(directory, 'car27_8s-10s_2.mp4'), 'second');
    assert.equal(
      findAvailableOutputPath(directory, 'car27_8s-10s.mp4'),
      path.join(directory, 'car27_8s-10s_3.mp4')
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('builds the CP1 H.264 command against the original source', () => {
  const args = buildFfmpegArgs(
    'C:\\video source\\original.mov',
    { start_s: 8.25, end_s: 22.75 },
    'C:\\exports\\clip.mp4'
  );

  assert.deepEqual(
    args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2),
    ['-ss', '8.25', '-to', '22.75', '-i', 'C:\\video source\\original.mov']
  );
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args[args.indexOf('-crf') + 1], '20');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
  assert.equal(args[args.indexOf('-stats_period') + 1], '0.25');
  assert.equal(args.includes('scale'), false);
  assert.equal(args.at(-1), 'C:\\exports\\clip.mp4');
});

test('rejects missing, non-finite, reversed, and negative intervals', () => {
  assert.match(validateClipInterval(null), /required/);
  assert.match(validateClipInterval({ start_s: 1, end_s: NaN }), /invalid timestamps/);
  assert.match(validateClipInterval({ start_s: 2, end_s: 2 }), /increasing/);
  assert.match(validateClipInterval({ start_s: -1, end_s: 2 }), /non-negative/);
  assert.equal(validateClipInterval({ start_s: 0.25, end_s: 1.75 }), null);
});

test('validates the complete batch before starting export', () => {
  assert.match(validateClipIntervals([]), /At least one interval/);
  assert.match(
    validateClipIntervals([
      { start_s: 1, end_s: 2 },
      { start_s: 3, end_s: 3 },
    ]),
    /Interval 2/
  );
  assert.equal(
    validateClipIntervals([
      { start_s: 1, end_s: 2 },
      { start_s: 3.25, end_s: 4.75 },
    ]),
    null
  );
});

test('runs batch clips sequentially and preserves their order', async () => {
  const starts = [];
  let activeRuns = 0;
  let maxActiveRuns = 0;
  const intervals = [
    { car_number: '27', start_s: 1, end_s: 2 },
    { car_number: '14', start_s: 3, end_s: 4 },
    { car_number: '', start_s: 5, end_s: 6 },
  ];
  const singleClipStarter = ({ interval }) => {
    starts.push(interval.car_number);
    activeRuns += 1;
    maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
    return {
      child: { carNumber: interval.car_number },
      completion: new Promise((resolve) => {
        setImmediate(() => {
          activeRuns -= 1;
          resolve({
            filename: buildClipFilename(interval),
            outputPath: buildClipFilename(interval),
            sizeBytes: 1,
          });
        });
      }),
    };
  };

  const run = startClipBatchExport({
    ffmpegPath: 'ffmpeg',
    sourcePath: 'original.mov',
    outputDirectory: 'exports',
    intervals,
    singleClipStarter,
  });
  const result = await run.completion;

  assert.deepEqual(starts, ['27', '14', '']);
  assert.equal(maxActiveRuns, 1);
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.clips.map((clip) => clip.filename),
    ['car27_1s-2s.mp4', 'car14_3s-4s.mp4', 'carUNK_5s-6s.mp4']
  );
  assert.equal(run.child, null);
});

test('parses ffmpeg progress timestamps', () => {
  assert.equal(parseFfmpegTimestamp('00:01:02.500000'), 62.5);
  assert.equal(parseFfmpegTimestamp('01:00:00.000000'), 3600);
  assert.equal(parseFfmpegTimestamp('invalid'), null);
});

test('continues after a clip failure and reports a mixed summary', async () => {
  const events = [];
  const starts = [];
  const intervals = [
    { car_number: '27', start_s: 1, end_s: 2 },
    { car_number: '14', start_s: 3, end_s: 4 },
    { car_number: '88', start_s: 5, end_s: 6 },
  ];
  const singleClipStarter = ({ interval, onProgress }) => {
    starts.push(interval.car_number);
    onProgress({ seconds: 0.5, fraction: 0.5 });
    return {
      child: { carNumber: interval.car_number },
      completion: interval.car_number === '14'
        ? Promise.reject(new Error('simulated encoder failure'))
        : Promise.resolve({
          filename: buildClipFilename(interval),
          outputPath: buildClipFilename(interval),
          sizeBytes: 1,
        }),
    };
  };

  const result = await startClipBatchExport({
    sourcePath: 'original.mov',
    outputDirectory: 'exports',
    intervals,
    singleClipStarter,
    onEvent: (event) => events.push(event),
  }).completion;

  assert.deepEqual(starts, ['27', '14', '88']);
  assert.equal(result.succeeded.length, 2);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /simulated encoder failure/);
  assert.equal(result.canceled, false);
  assert.equal(result.skipped, 0);
  assert.equal(events.filter((event) => event.event === 'progress').length, 3);
  assert.equal(events.at(-1).event, 'complete');
});

test('cancellation omits the in-flight clip and reports unattempted intervals', async () => {
  const starts = [];
  let rejectSecond;
  let signalSecondStarted;
  const secondStarted = new Promise((resolve) => { signalSecondStarted = resolve; });
  const intervals = [
    { car_number: '27', start_s: 1, end_s: 2 },
    { car_number: '14', start_s: 3, end_s: 4 },
    { car_number: '88', start_s: 5, end_s: 6 },
  ];
  const singleClipStarter = ({ interval }) => {
    starts.push(interval.car_number);
    if (interval.car_number === '14') {
      signalSecondStarted();
      return {
        child: { carNumber: interval.car_number },
        completion: new Promise((_resolve, reject) => { rejectSecond = reject; }),
      };
    }
    return {
      child: { carNumber: interval.car_number },
      completion: Promise.resolve({
        filename: buildClipFilename(interval),
        outputPath: buildClipFilename(interval),
        sizeBytes: 1,
      }),
    };
  };

  const run = startClipBatchExport({
    sourcePath: 'original.mov',
    outputDirectory: 'exports',
    intervals,
    singleClipStarter,
  });
  await secondStarted;
  assert.equal(run.requestCancel(), true);
  rejectSecond(new Error('process terminated'));
  const result = await run.completion;

  assert.deepEqual(starts, ['27', '14']);
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.canceled, true);
  assert.equal(result.skipped, 2);
});

test('writes a manifest mapping output filenames to interval fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-export-manifest-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'export_manifest.json'), 'old manifest');
    const interval = {
      car_number: '29|33',
      start_s: 1.25,
      end_s: 3.5,
      subject: true,
      confidence: 0.93,
      notes: 'Subject interval',
    };
    const summary = {
      total: 2,
      succeeded: [{
        filename: 'car29_33_1.25s-3.5s.mp4',
        outputPath: 'clip.mp4',
        sizeBytes: 42,
        interval,
      }],
      failed: [{
        filename: 'car14_4s-6s.mp4',
        interval: { ...interval, car_number: '14', start_s: 4, end_s: 6 },
        error: 'encoder failed',
      }],
      canceled: false,
      skipped: 0,
    };

    const built = buildExportManifest('original.mov', summary, '2026-07-26T00:00:00.000Z');
    assert.equal(built.clips['car29_33_1.25s-3.5s.mp4'].start_s, 1.25);
    assert.equal(built.failures[0].filename, 'car14_4s-6s.mp4');

    const result = writeExportManifest({
      outputDirectory: directory,
      sourcePath: 'original.mov',
      summary,
      randomId: () => 'manifest-test',
      exportedAt: '2026-07-26T00:00:00.000Z',
    });
    const saved = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(saved.succeeded, 1);
    assert.equal(saved.failed, 1);
    assert.equal(saved.clips['car29_33_1.25s-3.5s.mp4'].size_bytes, 42);
    assert.equal(fs.existsSync(path.join(directory, '.export_manifest.manifest-test.partial.json')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publishes a completed clip atomically after ffmpeg succeeds', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-export-run-test-'));
  try {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const progress = [];
    const spawnProcess = (_command, args) => {
      queueMicrotask(() => {
        child.stdout.end('out_time=00:00:07.250000\nprogress=continue\n');
        fs.writeFileSync(args.at(-1), 'encoded clip');
        child.emit('close', 0);
      });
      return child;
    };

    const run = startSingleClipExport({
      ffmpegPath: 'ffmpeg',
      sourcePath: 'original.mov',
      outputDirectory: directory,
      interval: { car_number: '27', start_s: 8.25, end_s: 22.75 },
      spawnProcess,
      randomId: () => 'test-run',
      onProgress: (event) => progress.push(event.fraction),
    });
    const result = await run.completion;

    assert.equal(result.filename, 'car27_8.25s-22.75s.mp4');
    assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'encoded clip');
    assert.equal(fs.existsSync(run.partialPath), false);
    assert.deepEqual(progress, [0.5, 1]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removes the partial file when ffmpeg fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-export-fail-test-'));
  try {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    const spawnProcess = (_command, args) => {
      queueMicrotask(() => {
        fs.writeFileSync(args.at(-1), 'partial clip');
        child.stderr.end('encoder failed\n');
        child.emit('close', 1);
      });
      return child;
    };

    const run = startSingleClipExport({
      ffmpegPath: 'ffmpeg',
      sourcePath: 'original.mov',
      outputDirectory: directory,
      interval: { car_number: '27', start_s: 1, end_s: 2 },
      spawnProcess,
      randomId: () => 'failed-run',
    });

    await assert.rejects(run.completion, /ffmpeg exited with code 1/);
    assert.equal(fs.existsSync(run.partialPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});