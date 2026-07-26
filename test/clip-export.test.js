const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  buildClipFilename,
  buildFfmpegArgs,
  findAvailableOutputPath,
  startClipBatchExport,
  startSingleClipExport,
  validateClipInterval,
  validateClipIntervals,
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

test('publishes a completed clip atomically after ffmpeg succeeds', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-export-run-test-'));
  try {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    const spawnProcess = (_command, args) => {
      queueMicrotask(() => {
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
    });
    const result = await run.completion;

    assert.equal(result.filename, 'car27_8.25s-22.75s.mp4');
    assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'encoded clip');
    assert.equal(fs.existsSync(run.partialPath), false);
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