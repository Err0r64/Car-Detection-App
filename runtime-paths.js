const path = require('path');

function runtimeRoot(options) {
  const {
    isPackaged,
    resourcesPath,
    appDirectory,
  } = options;
  return isPackaged ? resourcesPath : appDirectory;
}

function resolveRuntimePath(configuredPath, options) {
  if (path.isAbsolute(configuredPath)) return configuredPath;
  return path.join(runtimeRoot(options), configuredPath);
}

module.exports = {
  resolveRuntimePath,
  runtimeRoot,
};
