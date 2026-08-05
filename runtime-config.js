function parseConfigJson(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Configuration JSON must be text.');
  }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

const ANALYSIS_TIMEOUT_LIMITS = Object.freeze({
  analysisStallTimeoutSeconds: 30 * 60,
  analysisMaxTimeoutSeconds: 2 * 60 * 60,
  analysisPollIntervalSeconds: 60,
  analysisRequestTimeoutSeconds: 120,
});

function validateAnalysisTimeouts(config) {
  for (const [key, maximum] of Object.entries(ANALYSIS_TIMEOUT_LIMITS)) {
    if (
      !Number.isFinite(config[key])
      || config[key] <= 0
      || config[key] > maximum
    ) {
      throw new Error(
        'config.json ' + key + ' must be greater than 0 and no more than ' + maximum + '.'
      );
    }
  }
  if (config.analysisMaxTimeoutSeconds <= config.analysisStallTimeoutSeconds) {
    throw new Error(
      'config.json analysisMaxTimeoutSeconds must be greater than analysisStallTimeoutSeconds.'
    );
  }
  return config;
}
module.exports = {
  ANALYSIS_TIMEOUT_LIMITS,
  parseConfigJson,
  validateAnalysisTimeouts,
};
