const fs = require('fs');
const { spawn } = require('child_process');

const ANALYSIS_STAGES = new Set([
  'proxy',
  'upload',
  'processing',
  'analyzing',
  'parsing',
]);
const ANALYSIS_EVENTS = new Set([
  'start',
  'progress',
  'complete',
  'token',
  'retry',
  'retry_start',
  'rate_limit',
  'done',
  'error',
]);

function validateProtocolEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'each line must contain a JSON object';
  }
  if (!ANALYSIS_STAGES.has(value.stage)) {
    return `unknown stage "${String(value.stage)}"`;
  }
  if (!ANALYSIS_EVENTS.has(value.event)) {
    return `unknown event "${String(value.event)}"`;
  }
  if (value.event === 'done' && value.stage !== 'parsing') {
    return 'done events must use the parsing stage';
  }
  if (value.event === 'error' && (
    typeof value.message !== 'string' || !value.message.trim()
  )) {
    return 'error events must include a message';
  }
  return null;
}

function formatAnalysisFailure(stage, message, lastStderr = '') {
  const normalizedStage = typeof stage === 'string' && stage ? stage : 'analysis';
  const normalizedMessage = typeof message === 'string' && message
    ? message
    : 'Analysis failed.';
  const detail = typeof lastStderr === 'string' ? lastStderr.trim() : '';
  const lines = [`${normalizedStage}: ${normalizedMessage}`];
  if (detail && !normalizedMessage.includes(detail)) lines.push(`Details: ${detail}`);
  return lines.join('\n');
}

function removeRunDirectory(directory, fsImpl = fs) {
  if (!directory) return null;
  try {
    fsImpl.rmSync(directory, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error;
  }
}

function terminateProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return null;

  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const killProcess = options.killProcess || process.kill.bind(process);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 2000;

  if (platform === 'win32') {
    try {
      child.kill('SIGTERM');
    } catch {
      // taskkill below is the process-tree fallback.
    }
    try {
      const killer = spawnProcess(
        'taskkill.exe',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      );
      if (killer && typeof killer.on === 'function') killer.on('error', () => {});
      if (killer && typeof killer.unref === 'function') killer.unref();
    } catch {
      // The direct termination attempt above is still effective for the parent.
    }
    return null;
  }

  try {
    killProcess(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return null;
    }
  }

  const forceTimer = setTimeoutFn(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      killProcess(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
    }
  }, graceMs);
  if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
  return forceTimer;
}

module.exports = {
  formatAnalysisFailure,
  removeRunDirectory,
  terminateProcessTree,
  validateProtocolEvent,
};
