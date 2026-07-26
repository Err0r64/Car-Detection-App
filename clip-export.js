const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_CAR_TOKEN_LENGTH = 48;
const TIMESTAMP_DECIMALS = 3;

function formatTimestamp(value) {
  if (!Number.isFinite(value)) throw new Error('Clip timestamps must be finite numbers.');
  const rounded = Math.round(value * (10 ** TIMESTAMP_DECIMALS)) / (10 ** TIMESTAMP_DECIMALS);
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function sanitizeCarNumber(value) {
  const token = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_CAR_TOKEN_LENGTH)
    .replace(/_+$/g, '');
  return token || 'UNK';
}

function buildClipFilename(interval) {
  return [
    `car${sanitizeCarNumber(interval.car_number)}`,
    `${formatTimestamp(interval.start_s)}s-${formatTimestamp(interval.end_s)}s.mp4`,
  ].join('_');
}

function validateClipInterval(interval) {
  if (!interval || typeof interval !== 'object' || Array.isArray(interval)) {
    return 'A selected interval is required.';
  }
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s)) {
    return 'The selected interval has invalid timestamps.';
  }
  if (interval.start_s < 0 || interval.start_s >= interval.end_s) {
    return 'The selected interval must have increasing non-negative bounds.';
  }
  return null;
}

function validateClipIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return 'At least one interval is required for export.';
  }
  for (let index = 0; index < intervals.length; index += 1) {
    const error = validateClipInterval(intervals[index]);
    if (error) return `Interval ${index + 1}: ${error}`;
  }
  return null;
}

function findAvailableOutputPath(outputDirectory, filename, fsImpl = fs) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(outputDirectory, filename);
  let suffix = 2;
  while (fsImpl.existsSync(candidate)) {
    candidate = path.join(outputDirectory, `${stem}_${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

function buildFfmpegArgs(sourcePath, interval, outputPath) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-ss',
    formatTimestamp(interval.start_s),
    '-to',
    formatTimestamp(interval.end_s),
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-sn',
    '-dn',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

function removePartialFile(partialPath, fsImpl) {
  try {
    fsImpl.unlinkSync(partialPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function startSingleClipExport(options) {
  const {
    ffmpegPath,
    sourcePath,
    outputDirectory,
    interval,
    fsImpl = fs,
    spawnProcess = spawn,
    randomId = () => crypto.randomUUID(),
  } = options;

  const intervalError = validateClipInterval(interval);
  if (intervalError) throw new Error(intervalError);
  const filename = buildClipFilename(interval);
  const partialPath = path.join(
    outputDirectory,
    `.${path.basename(filename, '.mp4')}.${randomId()}.partial.mp4`
  );
  const args = buildFfmpegArgs(sourcePath, interval, partialPath);

  let child;
  try {
    child = spawnProcess(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    removePartialFile(partialPath, fsImpl);
    throw error;
  }

  const completion = new Promise((resolve, reject) => {
    let settled = false;
    let stderrBuffer = '';
    let lastStderr = '';

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        removePartialFile(partialPath, fsImpl);
      } catch (cleanupError) {
        error.message += ` Cleanup also failed: ${cleanupError.message}`;
      }
      reject(error);
    };

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop();
        for (const line of lines) {
          if (line.trim()) lastStderr = line.trim();
        }
      });
    }

    child.on('error', (error) => {
      fail(new Error(`Could not launch ffmpeg: ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      if (stderrBuffer.trim()) lastStderr = stderrBuffer.trim();
      if (code !== 0) {
        const detail = lastStderr ? ` ${lastStderr}` : '';
        fail(new Error(`ffmpeg exited with code ${code}.${detail}`));
        return;
      }

      try {
        const stat = fsImpl.statSync(partialPath);
        if (!stat.isFile() || stat.size <= 0) {
          throw new Error('ffmpeg did not produce a non-empty clip.');
        }
        const outputPath = findAvailableOutputPath(outputDirectory, filename, fsImpl);
        fsImpl.renameSync(partialPath, outputPath);
        settled = true;
        resolve({
          filename: path.basename(outputPath),
          outputPath,
          sizeBytes: stat.size,
        });
      } catch (error) {
        fail(error);
      }
    });
  });

  return { child, partialPath, completion, args };
}

function startClipBatchExport(options) {
  const {
    intervals,
    singleClipStarter = startSingleClipExport,
    ...singleClipOptions
  } = options;
  const intervalsError = validateClipIntervals(intervals);
  if (intervalsError) throw new Error(intervalsError);

  const intervalSnapshots = intervals.map((interval) => ({ ...interval }));
  const batch = { child: null, completion: null };
  batch.completion = (async () => {
    const clips = [];
    for (const interval of intervalSnapshots) {
      const run = singleClipStarter({ ...singleClipOptions, interval });
      batch.child = run.child;
      const result = await run.completion;
      clips.push({ ...result, interval });
    }
    return { clips, count: clips.length };
  })().finally(() => {
    batch.child = null;
  });

  return batch;
}

module.exports = {
  buildClipFilename,
  buildFfmpegArgs,
  findAvailableOutputPath,
  formatTimestamp,
  sanitizeCarNumber,
  startClipBatchExport,
  startSingleClipExport,
  validateClipInterval,
  validateClipIntervals,
};
