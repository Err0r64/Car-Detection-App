const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PromptProfileValidationError,
  compareSemver,
  resolvePromptProfile,
  validateProfileEnvelope,
} = require('../prompt-profile-client');

const SERVICE_URL = 'https://prompt.example.test';

function profileEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: {
      profileId: 'motorsports-default',
      version: 2,
      name: 'Motorsports vehicle indexing',
      instructions: 'Report each physical vehicle separately.',
      releaseNotes: 'Validated profile.',
      minimumClientVersion: '0.1.0',
      publishedAt: '2026-08-03T03:17:16.697289Z',
      etag: 'a'.repeat(64),
      ...overrides,
    },
  };
}

function response(status, body = '', headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(name.toLowerCase()) ?? null;
      },
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function temporaryCache() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-profile-test-'));
  return {
    directory,
    cachePath: path.join(directory, 'prompt-profile-cache.json'),
  };
}

test('downloads, validates, and atomically caches the active profile', async () => {
  const temporary = temporaryCache();
  let request = null;
  try {
    const result = await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return response(200, profileEnvelope(), { ETag: '"remote-etag"' });
      },
    });

    assert.equal(result.source, 'remote');
    assert.equal(result.envelope.profile.version, 2);
    assert.equal(
      request.url,
      `${SERVICE_URL}/v1/prompt-profiles/active`
    );
    assert.equal(request.options.headers['If-None-Match'], undefined);
    const cached = JSON.parse(fs.readFileSync(temporary.cachePath, 'utf8'));
    assert.equal(cached.etag, '"remote-etag"');
    assert.equal(cached.envelope.profile.profileId, 'motorsports-default');
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('uses the cached profile when the ETag is unchanged', async () => {
  const temporary = temporaryCache();
  try {
    await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async () => response(200, profileEnvelope(), { ETag: '"version-2"' }),
    });
    let conditionalHeader = null;
    const result = await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async (_url, options) => {
        conditionalHeader = options.headers['If-None-Match'];
        return response(304);
      },
    });

    assert.equal(conditionalHeader, '"version-2"');
    assert.equal(result.source, 'cache');
    assert.equal(result.envelope.profile.version, 2);
    assert.match(result.reason, /unchanged/i);
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('uses the last valid cache when the service is unavailable', async () => {
  const temporary = temporaryCache();
  try {
    await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async () => response(200, profileEnvelope(), { ETag: '"version-2"' }),
    });
    const result = await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.envelope.profile.profileId, 'motorsports-default');
    assert.match(result.reason, /offline/);
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('falls back to the built-in prompt without a valid cache', async () => {
  const temporary = temporaryCache();
  try {
    const result = await resolvePromptProfile({
      serviceUrl: SERVICE_URL,
      cachePath: temporary.cachePath,
      clientVersion: '0.1.0',
      timeoutMs: 1000,
      fetchImpl: async () => response(200, { schemaVersion: 99 }),
    });

    assert.equal(result.source, 'built-in');
    assert.equal(result.envelope, null);
    assert.match(result.reason, /schemaVersion/);
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('rejects profiles that require a newer application version', () => {
  assert.throws(
    () => validateProfileEnvelope(
      profileEnvelope({ minimumClientVersion: '0.2.0' }),
      '0.1.0'
    ),
    PromptProfileValidationError
  );
  assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
});
