const fs = require('fs');
const path = require('path');

const API_SCHEMA_VERSION = 1;
const CACHE_SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_LENGTH = 12_000;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

class PromptProfileValidationError extends Error {}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeServiceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PromptProfileValidationError('promptServiceUrl must be a non-empty URL.');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new PromptProfileValidationError('promptServiceUrl must be a valid URL.');
  }
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new PromptProfileValidationError(
      'promptServiceUrl must use HTTPS, except for a local development server.'
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PromptProfileValidationError(
      'promptServiceUrl must not contain credentials, a query, or a fragment.'
    );
  }
  return parsed.href.replace(/\/+$/, '');
}

function parseSemver(value, field) {
  if (typeof value !== 'string') {
    throw new PromptProfileValidationError(`${field} must be a semantic version.`);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new PromptProfileValidationError(`${field} must be a semantic version.`);
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) < Number(right[index]) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue, 'clientVersion');
  const right = parseSemver(rightValue, 'minimumClientVersion');
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function requireText(value, field, maximum, { allowEmpty = false, singleLine = false } = {}) {
  if (typeof value !== 'string') {
    throw new PromptProfileValidationError(`${field} must be a string.`);
  }
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!allowEmpty && !normalized) {
    throw new PromptProfileValidationError(`${field} must not be empty.`);
  }
  if (normalized.length > maximum) {
    throw new PromptProfileValidationError(`${field} is too long.`);
  }
  if (normalized.includes('\0') || (singleLine && /[\n\x00-\x1f]/.test(normalized))) {
    throw new PromptProfileValidationError(`${field} contains unsupported characters.`);
  }
  return normalized;
}

function validateProfileEnvelope(value, clientVersion) {
  parseSemver(clientVersion, 'clientVersion');
  if (!isPlainObject(value) || value.schemaVersion !== API_SCHEMA_VERSION) {
    throw new PromptProfileValidationError(
      `Prompt response schemaVersion must be ${API_SCHEMA_VERSION}.`
    );
  }
  const profile = value.profile;
  if (!isPlainObject(profile)) {
    throw new PromptProfileValidationError('Prompt response must contain a profile object.');
  }
  if (typeof profile.profileId !== 'string' || !PROFILE_ID_PATTERN.test(profile.profileId)) {
    throw new PromptProfileValidationError('profileId is invalid.');
  }
  if (!Number.isInteger(profile.version) || profile.version < 1) {
    throw new PromptProfileValidationError('profile version must be a positive integer.');
  }
  const minimumClientVersion = requireText(
    profile.minimumClientVersion,
    'minimumClientVersion',
    80,
    { singleLine: true }
  );
  parseSemver(minimumClientVersion, 'minimumClientVersion');
  if (compareSemver(clientVersion, minimumClientVersion) < 0) {
    throw new PromptProfileValidationError(
      `Prompt profile requires application version ${minimumClientVersion} or newer.`
    );
  }
  const publishedAt = requireText(profile.publishedAt, 'publishedAt', 80, { singleLine: true });
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new PromptProfileValidationError('publishedAt must be a timestamp.');
  }
  if (typeof profile.etag !== 'string' || !/^[a-f0-9]{64}$/.test(profile.etag)) {
    throw new PromptProfileValidationError('profile etag is invalid.');
  }
  return {
    schemaVersion: API_SCHEMA_VERSION,
    profile: {
      profileId: profile.profileId,
      version: profile.version,
      name: requireText(profile.name, 'name', 80, { singleLine: true }),
      instructions: requireText(
        profile.instructions,
        'instructions',
        MAX_INSTRUCTIONS_LENGTH
      ),
      releaseNotes: requireText(
        profile.releaseNotes,
        'releaseNotes',
        500,
        { allowEmpty: true }
      ),
      minimumClientVersion,
      publishedAt,
      etag: profile.etag,
    },
  };
}

function readCache(cachePath, serviceUrl, clientVersion, fsImpl = fs) {
  try {
    const cache = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
    if (
      !isPlainObject(cache)
      || cache.cacheSchemaVersion !== CACHE_SCHEMA_VERSION
      || cache.serviceUrl !== serviceUrl
      || typeof cache.etag !== 'string'
      || cache.etag.length > 256
    ) {
      return null;
    }
    return {
      etag: cache.etag,
      envelope: validateProfileEnvelope(cache.envelope, clientVersion),
    };
  } catch {
    return null;
  }
}

function writeCache(cachePath, serviceUrl, etag, envelope, fsImpl = fs) {
  const directory = path.dirname(cachePath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(
      temporaryPath,
      JSON.stringify({
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        serviceUrl,
        etag,
        envelope,
        cachedAt: new Date().toISOString(),
      }, null, 2) + '\n',
      'utf8'
    );
    fsImpl.renameSync(temporaryPath, cachePath);
  } catch (error) {
    try {
      fsImpl.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original cache if temporary cleanup also fails.
    }
    throw error;
  }
}

async function fetchActiveProfile({ serviceUrl, etag, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetchImpl(
      `${serviceUrl}/v1/prompt-profiles/active`,
      {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      }
    );
    if (response.status === 304) return { notModified: true };
    if (response.status !== 200) {
      throw new Error(`Prompt service returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new PromptProfileValidationError('Prompt service response is too large.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new PromptProfileValidationError('Prompt service response is too large.');
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new PromptProfileValidationError('Prompt service returned invalid JSON.');
    }
    return {
      notModified: false,
      envelope,
      etag: response.headers.get('etag'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePromptProfile(options) {
  const serviceUrl = normalizeServiceUrl(options.serviceUrl);
  const cachePath = options.cachePath;
  const clientVersion = options.clientVersion;
  const timeoutMs = options.timeoutMs;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof cachePath !== 'string' || !cachePath) throw new TypeError('cachePath is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number.');
  }

  const cached = readCache(cachePath, serviceUrl, clientVersion, fsImpl);
  try {
    const remote = await fetchActiveProfile({
      serviceUrl,
      etag: cached && cached.etag,
      timeoutMs,
      fetchImpl,
    });
    if (remote.notModified) {
      if (!cached) throw new Error('Prompt service returned 304 without a valid cache.');
      return {
        source: 'cache',
        envelope: cached.envelope,
        reason: 'Remote prompt profile is unchanged.',
      };
    }
    const envelope = validateProfileEnvelope(remote.envelope, clientVersion);
    const etag = remote.etag || `"${envelope.profile.etag}"`;
    let cacheWarning = null;
    try {
      writeCache(cachePath, serviceUrl, etag, envelope, fsImpl);
    } catch (error) {
      cacheWarning = `Could not update the prompt cache: ${error.message}`;
    }
    return {
      source: 'remote',
      envelope,
      reason: 'Downloaded the active prompt profile.',
      warning: cacheWarning,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached) {
      return {
        source: 'cache',
        envelope: cached.envelope,
        reason: `Prompt service unavailable or invalid; using cache. ${reason}`,
      };
    }
    return {
      source: 'built-in',
      envelope: null,
      reason: `Prompt service unavailable or invalid; using built-in prompt. ${reason}`,
    };
  }
}

module.exports = {
  API_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION,
  PromptProfileValidationError,
  compareSemver,
  normalizeServiceUrl,
  resolvePromptProfile,
  validateProfileEnvelope,
};
