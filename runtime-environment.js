'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const WINDOWS_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

function registryPathFromOutput(output) {
  if (typeof output !== 'string') return '';
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i);
    if (match) return match[1].trim();
  }
  return '';
}

function readRegistryPath(key, runProcess) {
  try {
    const result = runProcess(
      'reg.exe',
      ['query', key, '/v', 'Path'],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    return result && result.status === 0
      ? registryPathFromOutput(result.stdout)
      : '';
  } catch {
    return '';
  }
}

function expandWindowsVariables(value, environment) {
  const lookup = new Map(
    Object.entries(environment).map(([key, entry]) => [key.toUpperCase(), entry])
  );
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const replacement = lookup.get(name.toUpperCase());
    return typeof replacement === 'string' ? replacement : match;
  });
}

function mergeWindowsPaths(values, environment = process.env) {
  const merged = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const expanded = expandWindowsVariables(value, environment);
    for (const rawEntry of expanded.split(path.win32.delimiter)) {
      const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
      if (!entry) continue;
      const key = path.win32.normalize(entry).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged.join(path.win32.delimiter);
}

function environmentPathKey(environment) {
  return Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') || 'Path';
}

function refreshWindowsPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;

  const environment = options.environment || process.env;
  const runProcess = options.runProcess || spawnSync;
  const pathKey = environmentPathKey(environment);
  const registryPaths = WINDOWS_PATH_KEYS.map((key) => readRegistryPath(key, runProcess));
  const merged = mergeWindowsPaths(
    [environment[pathKey] || '', ...registryPaths],
    environment
  );

  if (!merged || merged === environment[pathKey]) return false;

  for (const key of Object.keys(environment)) {
    if (key !== pathKey && key.toUpperCase() === 'PATH') delete environment[key];
  }
  environment[pathKey] = merged;
  return true;
}

module.exports = {
  WINDOWS_PATH_KEYS,
  mergeWindowsPaths,
  refreshWindowsPath,
  registryPathFromOutput,
};
