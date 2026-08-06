'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { Transform } = require('stream');

const JOB_STATES = new Set([
  'awaiting_upload',
  'uploaded',
  'queued',
  'processing',
  'completed',
  'failed',
  'canceled',
]);
const MAX_ERROR_TEXT = 500;

class CloudAnalysisError extends Error {
  constructor(stage, message, options = {}) {
    super(message);
    this.name = 'CloudAnalysisError';
    this.stage = stage;
    this.code = options.code || 'cloud_analysis_error';
    this.statusCode = options.statusCode || null;
  }
}

function normalizeAnalysisServiceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('analysisServiceUrl must be a non-empty URL.');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('analysisServiceUrl must be a valid URL.');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new TypeError('analysisServiceUrl must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('analysisServiceUrl cannot contain credentials, a query, or a fragment.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateIdentityToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (
    token.length < 20
    || token.length > 16 * 1024
    || /\s/.test(token)
    || token.split('.').length !== 3
  ) {
    throw new CloudAnalysisError(
      'authentication',
      'Google Cloud did not return a valid identity token.',
      { code: 'invalid_identity_token' }
    );
  }
  return token;
}

function createGcloudIdentityToken(options = {}) {
  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const gcloudPath = options.gcloudPath || (platform === 'win32' ? 'gcloud.cmd' : 'gcloud');
  const timeoutMs = options.timeoutMs || 30_000;
  const signal = options.signal;

  if (typeof gcloudPath !== 'string' || !gcloudPath.trim()) {
    return Promise.reject(new TypeError('gcloudPath must be a non-empty string.'));
  }
  if (platform === 'win32' && /["&|<>\r\n]/.test(gcloudPath)) {
    return Promise.reject(new TypeError('gcloudPath contains unsupported shell characters.'));
  }

  const command = platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : gcloudPath;
  const windowsInvocation = /\s/.test(gcloudPath)
    ? `""${gcloudPath}" auth print-identity-token"`
    : `${gcloudPath} auth print-identity-token`;
  const args = platform === 'win32'
    ? ['/d', '/s', '/c', windowsInvocation]
    : ['auth', 'print-identity-token'];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new CloudAnalysisError(
        'authentication',
        `Could not start Google Cloud authentication: ${error.message}`,
        { code: 'gcloud_unavailable' }
      ));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      callback();
    };
    const terminate = () => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
    };
    const abort = () => {
      terminate();
      finish(() => reject(new CloudAnalysisError(
        'authentication',
        'Analysis authentication was canceled.',
        { code: 'canceled' }
      )));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(() => reject(new CloudAnalysisError(
        'authentication',
        'Google Cloud authentication timed out.',
        { code: 'authentication_timeout' }
      )));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 16 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_ERROR_TEXT) stderr += chunk;
    });
    child.on('error', (error) => {
      finish(() => reject(new CloudAnalysisError(
        'authentication',
        `Could not run Google Cloud authentication: ${error.message}`,
        { code: 'gcloud_unavailable' }
      )));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
          reject(new CloudAnalysisError(
            'authentication',
            detail || 'Google Cloud authentication failed. Run gcloud auth login and try again.',
            { code: 'gcloud_authentication_failed' }
          ));
          return;
        }
        try {
          resolve(validateIdentityToken(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

function abortError(stage) {
  return new CloudAnalysisError(stage, 'Analysis was canceled.', { code: 'canceled' });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError('analysis'));
      return;
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError('analysis'));
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abort);
    },
  };
}

async function responseError(response, stage) {
  let detail = '';
  try {
    const body = await response.json();
    if (body && typeof body.detail === 'string') detail = body.detail.trim();
  } catch {
    // Use the bounded status-based message below.
  }
  if (response.status === 401 || response.status === 403) {
    return new CloudAnalysisError(
      'authentication',
      'The desktop identity is not authorized to use the analysis service.',
      { code: 'analysis_not_authorized', statusCode: response.status }
    );
  }
  return new CloudAnalysisError(
    stage,
    (detail || `The analysis service returned HTTP ${response.status}.`).slice(0, MAX_ERROR_TEXT),
    { code: 'analysis_service_error', statusCode: response.status }
  );
}

function validateJobEnvelope(value, expectedJobId = null) {
  const job = value && value.schemaVersion === 1 ? value.job : null;
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new CloudAnalysisError('parsing', 'The analysis service returned an invalid job.', {
      code: 'invalid_job_response',
    });
  }
  if (typeof job.jobId !== 'string' || (expectedJobId && job.jobId !== expectedJobId)) {
    throw new CloudAnalysisError('parsing', 'The analysis service returned the wrong job.', {
      code: 'invalid_job_response',
    });
  }
  if (!JOB_STATES.has(job.state)) {
    throw new CloudAnalysisError('parsing', 'The analysis service returned an invalid job state.', {
      code: 'invalid_job_response',
    });
  }
  if (!job.proxy || typeof job.proxy !== 'object') {
    throw new CloudAnalysisError('parsing', 'The analysis service omitted proxy metadata.', {
      code: 'invalid_job_response',
    });
  }
  if (job.analysis !== undefined) {
    const analysis = job.analysis;
    if (
      !analysis
      || typeof analysis !== 'object'
      || !Number.isInteger(analysis.attempts)
      || analysis.attempts < 0
    ) {
      throw new CloudAnalysisError('parsing', 'The analysis service returned invalid attempt metadata.', {
        code: 'invalid_job_response',
      });
    }
    if (analysis.retry !== null && analysis.retry !== undefined) {
      const retry = analysis.retry;
      if (
        !retry
        || typeof retry !== 'object'
        || typeof retry.stage !== 'string'
        || typeof retry.code !== 'string'
        || typeof retry.message !== 'string'
      ) {
        throw new CloudAnalysisError('parsing', 'The analysis service returned invalid retry metadata.', {
          code: 'invalid_job_response',
        });
      }
    }
  }
  if (job.state === 'completed') {
    if (!job.results || !Array.isArray(job.results.detections)) {
      throw new CloudAnalysisError('parsing', 'The analysis service omitted detection results.', {
        code: 'invalid_job_response',
      });
    }
  }
  if (job.state === 'failed') {
    if (!job.error || typeof job.error.message !== 'string') {
      throw new CloudAnalysisError('parsing', 'The analysis service omitted failure details.', {
        code: 'invalid_job_response',
      });
    }
  }
  return job;
}

function validateUploadGrant(value) {
  const upload = value && value.upload;
  if (!upload || upload.method !== 'PUT' || typeof upload.url !== 'string') {
    throw new CloudAnalysisError('upload', 'The analysis service returned an invalid upload grant.', {
      code: 'invalid_upload_grant',
    });
  }
  let parsed;
  try {
    parsed = new URL(upload.url);
  } catch {
    throw new CloudAnalysisError('upload', 'The analysis service returned an invalid upload URL.', {
      code: 'invalid_upload_grant',
    });
  }
  const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new CloudAnalysisError('upload', 'The proxy upload URL must use HTTPS.', {
      code: 'invalid_upload_grant',
    });
  }
  const requiredHeaders = upload.requiredHeaders;
  if (!requiredHeaders || typeof requiredHeaders !== 'object' || Array.isArray(requiredHeaders)) {
    throw new CloudAnalysisError('upload', 'The upload grant omitted required headers.', {
      code: 'invalid_upload_grant',
    });
  }
  for (const name of Object.keys(requiredHeaders)) {
    if (name.toLowerCase() === 'authorization') {
      throw new CloudAnalysisError('upload', 'The upload grant requested an unsafe header.', {
        code: 'invalid_upload_grant',
      });
    }
  }
  return { url: parsed.toString(), requiredHeaders: { ...requiredHeaders } };
}

async function hashProxyFile(filePath, options = {}) {
  const signal = options.signal;
  const onProgress = options.onProgress || (() => {});
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new CloudAnalysisError('upload', 'The generated proxy is empty or missing.', {
      code: 'invalid_proxy',
    });
  }
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  let bytesRead = 0;
  return new Promise((resolve, reject) => {
    const abort = () => stream.destroy(abortError('upload'));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytesRead += chunk.length;
      onProgress(bytesRead, stat.size);
    });
    stream.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', abort);
      reject(error instanceof CloudAnalysisError
        ? error
        : new CloudAnalysisError('upload', `Could not read the proxy: ${error.message}`, {
          code: 'proxy_read_failed',
        }));
    });
    stream.on('end', () => {
      if (signal) signal.removeEventListener('abort', abort);
      resolve({ sha256: hash.digest('hex'), sizeBytes: stat.size });
    });
  });
}

class CloudAnalysisClient {
  constructor(options) {
    this.serviceUrl = normalizeAnalysisServiceUrl(options.serviceUrl);
    this.identityToken = validateIdentityToken(options.identityToken);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    if (typeof this.fetch !== 'function') throw new TypeError('A fetch implementation is required.');
  }

  async request(pathname, options = {}) {
    const url = new URL(pathname, `${this.serviceUrl}/`);
    if (url.origin !== new URL(this.serviceUrl).origin) {
      throw new CloudAnalysisError('authentication', 'Refusing to send credentials to another origin.', {
        code: 'unsafe_request_origin',
      });
    }
    const scoped = requestSignal(options.signal, this.requestTimeoutMs);
    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${this.identityToken}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        signal: scoped.signal,
      });
      if (!response.ok) throw await responseError(response, options.stage || 'analysis');
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof CloudAnalysisError) throw error;
      if (scoped.signal.aborted) {
        if (options.signal && options.signal.aborted) throw abortError(options.stage || 'analysis');
        throw new CloudAnalysisError(
          options.stage || 'analysis',
          'The analysis service request timed out.',
          { code: 'analysis_request_timeout' }
        );
      }
      throw new CloudAnalysisError(
        options.stage || 'analysis',
        `Could not reach the analysis service: ${error.message}`,
        { code: 'analysis_service_unavailable' }
      );
    } finally {
      scoped.cleanup();
    }
  }

  async createJob(metadata, signal) {
    const envelope = await this.request('/v1/analysis/jobs', {
      method: 'POST',
      stage: 'upload',
      signal,
      body: {
        schemaVersion: 1,
        clientRequestId: metadata.jobId,
        sourceDurationS: metadata.sourceDurationS,
        proxySizeBytes: metadata.proxySizeBytes,
        proxySha256: metadata.proxySha256,
        proxyContentType: 'video/mp4',
      },
    });
    const job = validateJobEnvelope(envelope, metadata.jobId);
    return { job, upload: validateUploadGrant(envelope) };
  }

  async uploadProxy(grant, proxyPath, options = {}) {
    const stat = await fs.promises.stat(proxyPath);
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        this.bytesSent = (this.bytesSent || 0) + chunk.length;
        if (options.onProgress) options.onProgress(this.bytesSent, stat.size);
        callback(null, chunk);
      },
    });
    const source = fs.createReadStream(proxyPath);
    source.on('error', (error) => progress.destroy(error));
    source.pipe(progress);
    const scoped = requestSignal(options.signal, options.timeoutMs || 30 * 60 * 1000);
    try {
      const response = await this.fetch(grant.url, {
        method: 'PUT',
        headers: {
          ...grant.requiredHeaders,
          'Content-Type': 'video/mp4',
          'Content-Length': String(stat.size),
        },
        body: progress,
        duplex: 'half',
        redirect: 'error',
        signal: scoped.signal,
      });
      if (!response.ok) throw await responseError(response, 'upload');
    } catch (error) {
      source.destroy();
      progress.destroy();
      if (error instanceof CloudAnalysisError) throw error;
      if (scoped.signal.aborted) {
        if (options.signal && options.signal.aborted) throw abortError('upload');
        throw new CloudAnalysisError('upload', 'The proxy upload timed out.', {
          code: 'proxy_upload_timeout',
        });
      }
      throw new CloudAnalysisError('upload', `Could not upload the proxy: ${error.message}`, {
        code: 'proxy_upload_failed',
      });
    } finally {
      scoped.cleanup();
    }
  }

  async confirmUpload(jobId, signal) {
    const envelope = await this.request(`/v1/analysis/jobs/${jobId}/upload-complete`, {
      method: 'POST',
      stage: 'processing',
      signal,
    });
    return validateJobEnvelope(envelope, jobId);
  }

  async getJob(jobId, signal) {
    const envelope = await this.request(`/v1/analysis/jobs/${jobId}`, {
      stage: 'analysis',
      signal,
    });
    return validateJobEnvelope(envelope, jobId);
  }

  async deleteJob(jobId) {
    try {
      await this.request(`/v1/analysis/jobs/${jobId}`, {
        method: 'DELETE',
        stage: 'cleanup',
      });
      return true;
    } catch (error) {
      if (error instanceof CloudAnalysisError && error.statusCode === 404) return true;
      return false;
    }
  }
}

async function runCloudAnalysisJob(options) {
  const client = options.client;
  const signal = options.signal;
  const onEvent = options.onEvent || (() => {});
  const onActivity = options.onActivity || (() => {});
  const pollIntervalMs = options.pollIntervalMs || 5_000;
  const metadata = await hashProxyFile(options.proxyPath, {
    signal,
    onProgress: onActivity,
  });
  onActivity();
  let created = false;
  let lastState = null;
  let lastAttempts = 0;
  try {
    onEvent({ stage: 'upload', event: 'start' });
    const response = await client.createJob({
      jobId: options.jobId,
      sourceDurationS: options.sourceDurationS,
      proxySizeBytes: metadata.sizeBytes,
      proxySha256: metadata.sha256,
    }, signal);
    created = true;
    onActivity();
    await client.uploadProxy(response.upload, options.proxyPath, {
      signal,
      onProgress: (sent, total) => {
        onActivity();
        onEvent({
          stage: 'upload',
          event: 'progress',
          progress: total > 0 ? sent / total : 0,
        });
      },
    });
    onEvent({ stage: 'upload', event: 'complete', progress: 1 });
    let job = await client.confirmUpload(options.jobId, signal);
    onActivity();

    while (true) {
      if (job.state !== lastState) {
        if (job.state === 'queued' || job.state === 'uploaded') {
          onEvent({ stage: 'processing', event: 'start' });
        } else if (job.state === 'processing') {
          onEvent({ stage: 'analyzing', event: 'start' });
        }
        lastState = job.state;
      }
      const attempts = job.analysis && Number.isInteger(job.analysis.attempts)
        ? job.analysis.attempts
        : 0;
      if (attempts > lastAttempts && job.state === 'queued') {
        const retry = job.analysis && job.analysis.retry;
        onEvent({
          stage: 'analyzing',
          event: 'retry',
          attempt: attempts + 1,
          maxAttempts: 3,
          retryStage: retry ? retry.stage : 'analysis',
          code: retry ? retry.code : 'remote_retry',
          message: retry ? retry.message : 'Cloud analysis will retry.',
        });
      }
      lastAttempts = Math.max(lastAttempts, attempts);

      if (job.state === 'completed') {
        onEvent({ stage: 'parsing', event: 'start' });
        if (job.analysis && Number.isFinite(job.analysis.outputTokens)) {
          onEvent({
            stage: 'analyzing',
            event: 'token',
            outputTokens: job.analysis.outputTokens,
          });
        }
        return {
          results: { detections: job.results.detections },
          analysis: job.analysis || null,
          proxy: job.proxy,
        };
      }
      if (job.state === 'failed') {
        throw new CloudAnalysisError(
          job.error.stage || 'analysis',
          job.error.message,
          { code: job.error.code || 'remote_analysis_failed' }
        );
      }
      if (job.state === 'canceled') {
        throw abortError('analysis');
      }
      await delay(pollIntervalMs, signal);
      job = await client.getJob(options.jobId, signal);
      onActivity();
    }
  } finally {
    if (created) {
      await client.deleteJob(options.jobId);
    }
  }
}

module.exports = {
  CloudAnalysisClient,
  CloudAnalysisError,
  createGcloudIdentityToken,
  hashProxyFile,
  normalizeAnalysisServiceUrl,
  runCloudAnalysisJob,
  validateIdentityToken,
  validateJobEnvelope,
};
