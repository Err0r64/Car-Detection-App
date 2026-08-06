'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  CloudAnalysisClient,
  CloudAnalysisError,
  createGcloudIdentityToken,
  normalizeAnalysisServiceUrl,
  runCloudAnalysisJob,
  validateIdentityToken,
} = require('../cloud-analysis-client');

const TOKEN = 'header.payload.signature-long-enough';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

function job(state, extra = {}) {
  return {
    schemaVersion: 1,
    job: {
      jobId: JOB_ID,
      clientRequestId: JOB_ID,
      state,
      sourceDurationS: 15,
      proxy: {
        sizeBytes: 11,
        sha256: 'a'.repeat(64),
        contentType: 'video/mp4',
        sha256Verified: state === 'completed',
      },
      ...extra,
    },
  };
}

test('normalizes HTTPS service URLs and validates identity tokens', () => {
  assert.equal(
    normalizeAnalysisServiceUrl('https://analysis.example.test/'),
    'https://analysis.example.test'
  );
  assert.equal(
    normalizeAnalysisServiceUrl('http://localhost:8080/'),
    'http://localhost:8080'
  );
  assert.throws(() => normalizeAnalysisServiceUrl('http://analysis.example.test'));
  assert.equal(validateIdentityToken(TOKEN), TOKEN);
  assert.throws(() => validateIdentityToken('not-a-token'));
});

test('gets a short-lived identity token from the gcloud CLI', async () => {
  const calls = [];
  const tokenPromise = createGcloudIdentityToken({
    platform: 'linux',
    gcloudPath: '/opt/google-cloud-sdk/bin/gcloud',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end(`${TOKEN}\n`);
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  });

  assert.equal(await tokenPromise, TOKEN);
  assert.equal(calls[0].command, '/opt/google-cloud-sdk/bin/gcloud');
  assert.deepEqual(calls[0].args, ['auth', 'print-identity-token']);
});

test('quotes explicit Windows gcloud paths without breaking PATH commands', async () => {
  const invocations = [];
  const run = (gcloudPath) => createGcloudIdentityToken({
    platform: 'win32',
    gcloudPath,
    spawnProcess(command, args) {
      invocations.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.end(`${TOKEN}\n`);
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  });

  await run('gcloud.cmd');
  await run('C:\\Program Files\\Google\\Cloud SDK\\gcloud.cmd');
  assert.equal(invocations[0].args[3], 'gcloud.cmd auth print-identity-token');
  assert.equal(
    invocations[1].args[3],
    '""C:\\Program Files\\Google\\Cloud SDK\\gcloud.cmd" auth print-identity-token"'
  );
});
test('runs the cloud job contract without sending auth to signed storage', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-analysis-client-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const proxyPath = path.join(directory, 'proxy.mp4');
  fs.writeFileSync(proxyPath, 'proxy-video');

  const calls = [];
  let pollCount = 0;
  const fetchImpl = async (urlValue, options) => {
    const url = new URL(urlValue);
    const body = options.body && typeof options.body === 'string'
      ? JSON.parse(options.body)
      : null;
    calls.push({ url, options, body });
    if (url.hostname === 'storage.example.test') {
      for await (const _chunk of options.body) {
        // Consume the upload stream.
      }
      return new Response(null, { status: 200 });
    }
    if (options.method === 'POST' && url.pathname === '/v1/analysis/jobs') {
      return Response.json({
        ...job('awaiting_upload'),
        upload: {
          url: 'https://storage.example.test/signed-upload',
          method: 'PUT',
          requiredHeaders: { 'x-goog-meta-analysis-job': JOB_ID },
          expiresAt: '2026-08-04T00:00:00Z',
        },
      }, { status: 201 });
    }
    if (options.method === 'POST' && url.pathname.endsWith('/upload-complete')) {
      return Response.json(job('queued', {
        analysis: { attempts: 0 },
      }));
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    pollCount += 1;
    if (pollCount === 1) {
      return Response.json(job('queued', {
        analysis: {
          attempts: 1,
          retry: {
            stage: 'analyzing',
            code: 'provider_unavailable',
            message: 'Gemini is temporarily unavailable.',
          },
        },
      }));
    }
    if (pollCount === 2) {
      return Response.json(job('processing', {
        analysis: { attempts: 2, retry: null },
      }));
    }
    return Response.json(job('completed', {
      analysis: {
        attempts: 2,
        model: 'gemini-3.6-flash',
        prompt: { profileId: 'motorsports-default', version: 2, etag: 'etag' },
        inputTokens: 100,
        outputTokens: 25,
      },
      results: {
        detections: [{
          start_s: 1.25,
          end_s: 2.5,
          subject: true,
          car_number: '27',
          notes: 'Red car',
          confidence: 0.9,
        }],
      },
    }));
  };

  const events = [];
  const client = new CloudAnalysisClient({
    serviceUrl: 'https://analysis.example.test',
    identityToken: TOKEN,
    fetchImpl,
  });
  const result = await runCloudAnalysisJob({
    client,
    jobId: JOB_ID,
    proxyPath,
    sourceDurationS: 15,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.results.detections.length, 1);
  assert.equal(result.analysis.model, 'gemini-3.6-flash');
  const serviceCalls = calls.filter((call) => call.url.hostname === 'analysis.example.test');
  assert.ok(serviceCalls.length >= 4);
  assert.ok(serviceCalls.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  const upload = calls.find((call) => call.url.hostname === 'storage.example.test');
  assert.equal(upload.options.headers.Authorization, undefined);
  assert.equal(upload.options.headers['Content-Type'], 'video/mp4');
  assert.equal(serviceCalls[0].body.proxySizeBytes, 11);
  assert.equal(serviceCalls[0].body.proxySha256.length, 64);
  assert.ok(events.some((event) => event.stage === 'upload' && event.event === 'complete'));
  assert.ok(events.some((event) => event.stage === 'analyzing' && event.event === 'retry'));
  assert.ok(events.some((event) => event.stage === 'analyzing' && event.event === 'token'));
  assert.equal(calls.at(-1).options.method, 'DELETE');
});

test('reports durable cloud retry metadata before completion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-analysis-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const proxyPath = path.join(directory, 'proxy.mp4');
  fs.writeFileSync(proxyPath, 'proxy');

  const events = [];
  const calls = [];
  const client = {
    async createJob() {
      calls.push('create');
      return { job: {}, upload: {} };
    },
    async uploadProxy() {
      calls.push('upload');
    },
    async confirmUpload() {
      calls.push('confirm');
      return {
        state: 'queued',
        analysis: {
          attempts: 1,
          retry: {
            stage: 'analyzing',
            code: 'provider_unavailable',
            message: 'Gemini is temporarily unavailable.',
          },
        },
      };
    },
    async getJob() {
      calls.push('poll');
      return {
        state: 'completed',
        analysis: { attempts: 2, outputTokens: 8 },
        results: { detections: [] },
      };
    },
    async deleteJob() {
      calls.push('delete');
      return true;
    },
  };

  await runCloudAnalysisJob({
    client,
    jobId: JOB_ID,
    proxyPath,
    sourceDurationS: 15,
    pollIntervalMs: 1,
    onEvent: (event) => events.push(event),
  });

  const retry = events.find((event) => event.event === 'retry');
  assert.deepEqual(retry, {
    stage: 'analyzing',
    event: 'retry',
    attempt: 2,
    maxAttempts: 3,
    retryStage: 'analyzing',
    code: 'provider_unavailable',
    message: 'Gemini is temporarily unavailable.',
  });
  assert.deepEqual(calls, ['create', 'upload', 'confirm', 'poll', 'delete']);
});

test('maps a remotely canceled job and still requests cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-analysis-canceled-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const proxyPath = path.join(directory, 'proxy.mp4');
  fs.writeFileSync(proxyPath, 'proxy');

  const calls = [];
  const client = {
    async createJob() {
      calls.push('create');
      return { job: {}, upload: {} };
    },
    async uploadProxy() {
      calls.push('upload');
    },
    async confirmUpload() {
      calls.push('confirm');
      return { state: 'canceled', analysis: { attempts: 1 } };
    },
    async deleteJob() {
      calls.push('delete');
      return true;
    },
  };

  await assert.rejects(
    runCloudAnalysisJob({
      client,
      jobId: JOB_ID,
      proxyPath,
      sourceDurationS: 15,
      pollIntervalMs: 1,
    }),
    (error) => error instanceof CloudAnalysisError && error.code === 'canceled'
  );
  assert.deepEqual(calls, ['create', 'upload', 'confirm', 'delete']);
});

test('maps a failed remote job and still deletes it', async () => {
  const calls = [];
  const client = {
    async createJob() {
      calls.push('create');
      return { job: {}, upload: {} };
    },
    async uploadProxy() {
      calls.push('upload');
    },
    async confirmUpload() {
      calls.push('confirm');
      return {
        state: 'failed',
        error: { stage: 'analyzing', code: 'provider_error', message: 'Analysis failed.' },
      };
    },
    async deleteJob() {
      calls.push('delete');
      return true;
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-analysis-error-'));
  const proxyPath = path.join(directory, 'proxy.mp4');
  fs.writeFileSync(proxyPath, 'proxy');
  try {
    await assert.rejects(
      runCloudAnalysisJob({
        client,
        jobId: JOB_ID,
        proxyPath,
        sourceDurationS: 15,
        pollIntervalMs: 1,
      }),
      (error) => error instanceof CloudAnalysisError
        && error.stage === 'analyzing'
        && error.code === 'provider_error'
    );
    assert.deepEqual(calls, ['create', 'upload', 'confirm', 'delete']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
