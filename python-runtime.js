'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const DEPENDENCY_CHECK = [
  'import sys',
  'print(sys.executable)',
  'import google.genai',
  'import jsonschema',
].join('; ');

function lines(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), '').trim())
    .filter(Boolean);
}

function pythonPathsFromOutput(output) {
  const paths = [];
  for (const line of lines(output)) {
    let candidate = null;
    for (let index = 0; index < line.length - 2; index += 1) {
      const code = line.charCodeAt(index);
      const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (
        isLetter
        && line[index + 1] === ':'
        && line[index + 2] === path.win32.sep
      ) {
        candidate = line.slice(index).trim();
        break;
      }
    }
    if (!candidate || !path.win32.isAbsolute(candidate)) continue;
    const executable = path.win32.basename(candidate).toLowerCase();
    if (executable === 'python.exe' || executable === 'python') paths.push(candidate);
  }
  return paths;
}

function runCandidate(candidate, runProcess) {
  let result;
  try {
    result = runProcess(
      candidate,
      ['-c', DEPENDENCY_CHECK],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (error) {
    return { ok: false, candidate, error };
  }

  const reportedPath = lines(result && result.stdout)[0];
  return {
    ok: Boolean(result && result.status === 0),
    candidate: reportedPath || candidate,
    error: result && result.error ? result.error : null,
  };
}

function discoverWindowsPythonPaths(runProcess) {
  const discovered = [];
  const commands = [
    ['py', ['-0p']],
    ['where.exe', ['python']],
  ];
  for (const [command, args] of commands) {
    try {
      const result = runProcess(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result && result.status === 0) {
        discovered.push(...pythonPathsFromOutput(result.stdout));
      }
    } catch {
      // Continue with the configured interpreter and any other discovery source.
    }
  }
  return discovered;
}

function candidateKey(candidate, platform) {
  const normalized = path.normalize(candidate);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolvePythonRuntime(configuredPath, options = {}) {
  if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
    throw new TypeError('configuredPath must be a non-empty string.');
  }

  const platform = options.platform || process.platform;
  const runProcess = options.runProcess || spawnSync;
  const attempted = [];
  const checked = new Set();

  const check = (candidate) => {
    const key = candidateKey(candidate, platform);
    if (checked.has(key)) return null;
    checked.add(key);

    const storeSegment = path.win32.join('microsoft', 'windowsapps');
    if (
      platform === 'win32'
      && candidate.toLowerCase().includes(storeSegment)
    ) {
      return null;
    }

    const result = runCandidate(candidate, runProcess);
    attempted.push(result.candidate);
    return result.ok ? result.candidate : null;
  };

  const configuredResult = check(configuredPath.trim());
  if (configuredResult) return { command: configuredResult, attempted };

  if (platform === 'win32' && !path.isAbsolute(configuredPath)) {
    for (const candidate of discoverWindowsPythonPaths(runProcess)) {
      const result = check(candidate);
      if (result) return { command: result, attempted };
    }
  }

  return { command: null, attempted };
}

module.exports = {
  DEPENDENCY_CHECK,
  pythonPathsFromOutput,
  resolvePythonRuntime,
};