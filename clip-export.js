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

function parseFfmpegTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function buildFfmpegArgs(sourcePath, interval, outputPath) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-nostats',
    '-progress',
    'pipe:1',
    '-stats_period',
    '0.25',
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
    onProgress = null,
  } = options;

  const intervalError = validateClipInterval(interval);
  if (intervalError) throw new Error(intervalError);
  const filename = buildClipFilename(interval);
  const partialPath = path.join(
    outputDirectory,
    `.${path.basename(filename, '.mp4')}.${randomId()}.partial.mp4`
  );
  const args = buildFfmpegArgs(sourcePath, interval, partialPath);
  const clipDuration = interval.end_s - interval.start_s;

  const reportProgress = (encodedSeconds) => {
    if (typeof onProgress !== 'function') return;
    const seconds = Math.max(0, Math.min(encodedSeconds, clipDuration));
    try {
      onProgress({ seconds, fraction: Math.min(1, seconds / clipDuration) });
    } catch {
      // Renderer progress reporting must not interrupt ffmpeg lifecycle handling.
    }
  };

  let child;
  try {
    child = spawnProcess(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    removePartialFile(partialPath, fsImpl);
    throw error;
  }

  const completion = new Promise((resolve, reject) => {
    let settled = false;
    let stderrBuffer = '';
    let progressBuffer = '';
    let encodedSeconds = 0;
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

    const handleProgressLine = (line) => {
      const separator = line.indexOf('=');
      if (separator < 0) return;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === 'out_time') {
        const parsed = parseFfmpegTimestamp(value);
        if (parsed !== null) encodedSeconds = parsed;
      } else if (key === 'progress') {
        reportProgress(value === 'end' ? clipDuration : encodedSeconds);
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop();
        lines.forEach(handleProgressLine);
      });
    }

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
      if (progressBuffer.trim()) handleProgressLine(progressBuffer.trim());
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
        reportProgress(clipDuration);
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

function emitBatchEvent(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(event);
  } catch {
    // A destroyed renderer must not interrupt batch cleanup or later clips.
  }
}

function startClipBatchExport(options) {
  const {
    intervals,
    singleClipStarter = startSingleClipExport,
    onEvent = null,
    simulateFailureAtClip = null,
    ...singleClipOptions
  } = options;
  const intervalsError = validateClipIntervals(intervals);
  if (intervalsError) throw new Error(intervalsError);

  const intervalSnapshots = intervals.map((interval) => ({ ...interval }));
  const batch = {
    child: null,
    completion: null,
    cancelRequested: false,
    finished: false,
    requestCancel() {
      if (batch.finished || batch.cancelRequested) return false;
      batch.cancelRequested = true;
      emitBatchEvent(onEvent, { event: 'canceling' });
      return true;
    },
  };

  batch.completion = (async () => {
    const succeeded = [];
    const failed = [];
    const total = intervalSnapshots.length;
    emitBatchEvent(onEvent, { event: 'start', total });

    for (let index = 0; index < intervalSnapshots.length; index += 1) {
      if (batch.cancelRequested) break;
      const interval = intervalSnapshots[index];
      const clipNumber = index + 1;
      const intendedFilename = buildClipFilename(interval);
      const completedBefore = succeeded.length + failed.length;
      emitBatchEvent(onEvent, {
        event: 'clip-start',
        clipNumber,
        total,
        filename: intendedFilename,
        completed: completedBefore,
      });

      const clipOptions = { ...singleClipOptions, interval };
      if (clipNumber === simulateFailureAtClip) {
        clipOptions.outputDirectory = path.join(
          singleClipOptions.outputDirectory,
          `.missing-export-${crypto.randomUUID()}`
        );
      }
      clipOptions.onProgress = ({ seconds, fraction }) => {
        emitBatchEvent(onEvent, {
          event: 'progress',
          clipNumber,
          total,
          filename: intendedFilename,
          encodedSeconds: seconds,
          clipFraction: fraction,
          overallFraction: (completedBefore + fraction) / total,
          completed: completedBefore,
        });
      };

      try {
        const run = singleClipStarter(clipOptions);
        batch.child = run.child;
        const result = await run.completion;
        succeeded.push({ ...result, interval });
        emitBatchEvent(onEvent, {
          event: 'clip-success',
          clipNumber,
          total,
          filename: result.filename,
          completed: succeeded.length + failed.length,
        });
      } catch (error) {
        if (batch.cancelRequested) break;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ filename: intendedFilename, interval, error: message });
        emitBatchEvent(onEvent, {
          event: 'clip-failure',
          clipNumber,
          total,
          filename: intendedFilename,
          error: message,
          completed: succeeded.length + failed.length,
        });
      } finally {
        batch.child = null;
      }
    }

    const completed = succeeded.length + failed.length;
    const summary = {
      total,
      count: succeeded.length,
      clips: succeeded,
      succeeded,
      failed,
      canceled: batch.cancelRequested,
      completed,
      skipped: total - completed,
    };
    batch.finished = true;
    emitBatchEvent(onEvent, {
      event: 'complete',
      total,
      succeeded: succeeded.length,
      failed: failed.length,
      canceled: summary.canceled,
      completed,
      skipped: summary.skipped,
    });
    return summary;
  })().finally(() => {
    batch.child = null;
    batch.finished = true;
  });

  return batch;
}

function manifestIntervalFields(interval) {
  return {
    car_number: String(interval.car_number ?? ''),
    start_s: interval.start_s,
    end_s: interval.end_s,
    subject: interval.subject === true,
    confidence: interval.confidence ?? null,
    notes: String(interval.notes ?? ''),
  };
}

function buildExportManifest(sourcePath, summary, exportedAt = new Date().toISOString()) {
  const clips = {};
  for (const clip of summary.succeeded) {
    clips[clip.filename] = {
      ...manifestIntervalFields(clip.interval),
      size_bytes: clip.sizeBytes,
    };
  }
  return {
    version: 1,
    source_video: sourcePath,
    exported_at: exportedAt,
    canceled: summary.canceled,
    total_intervals: summary.total,
    succeeded: summary.succeeded.length,
    failed: summary.failed.length,
    skipped: summary.skipped,
    clips,
    failures: summary.failed.map((failure) => ({
      filename: failure.filename,
      ...manifestIntervalFields(failure.interval),
      error: failure.error,
    })),
  };
}

function writeExportManifest(options) {
  const {
    outputDirectory,
    sourcePath,
    summary,
    fsImpl = fs,
    randomId = () => crypto.randomUUID(),
    exportedAt,
  } = options;
  const manifest = buildExportManifest(sourcePath, summary, exportedAt);
  const manifestPath = path.join(outputDirectory, 'export_manifest.json');
  const partialPath = path.join(
    outputDirectory,
    `.export_manifest.${randomId()}.partial.json`
  );

  try {
    fsImpl.writeFileSync(partialPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (fsImpl.existsSync(manifestPath)) fsImpl.unlinkSync(manifestPath);
    fsImpl.renameSync(partialPath, manifestPath);
  } catch (error) {
    try {
      removePartialFile(partialPath, fsImpl);
    } catch (cleanupError) {
      error.message += ` Cleanup also failed: ${cleanupError.message}`;
    }
    throw error;
  }
  return { manifest, manifestPath };
}

module.exports = {
  buildClipFilename,
  buildExportManifest,
  buildFfmpegArgs,
  findAvailableOutputPath,
  formatTimestamp,
  parseFfmpegTimestamp,
  sanitizeCarNumber,
  startClipBatchExport,
  startSingleClipExport,
  validateClipInterval,
  validateClipIntervals,
  writeExportManifest,
};