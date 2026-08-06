const assert = require('assert/strict');
const path = require('path');
const test = require('node:test');

const {
  resolveRuntimePath,
  runtimeRoot,
} = require('../runtime-paths');

test('uses the source directory when Electron is not packaged', () => {
  const options = {
    isPackaged: false,
    resourcesPath: path.join(
      '/Applications',
      'Capstone Video Editor.app',
      'Contents',
      'Resources'
    ),
    appDirectory: path.join('/Users', 'developer', 'capstone-video-editor'),
  };

  assert.equal(runtimeRoot(options), options.appDirectory);
  assert.equal(
    resolveRuntimePath(path.join('pipeline', 'analyze.py'), options),
    path.join(options.appDirectory, 'pipeline', 'analyze.py')
  );
});

test('uses the external resources directory in packaged Electron builds', () => {
  const options = {
    isPackaged: true,
    resourcesPath: path.join(
      '/Applications',
      'Capstone Video Editor.app',
      'Contents',
      'Resources'
    ),
    appDirectory: path.join(
      '/Applications',
      'Capstone Video Editor.app',
      'Contents',
      'Resources',
      'app.asar'
    ),
  };

  assert.equal(runtimeRoot(options), options.resourcesPath);
  assert.equal(
    resolveRuntimePath(path.join('stub', 'fake_analysis.py'), options),
    path.join(options.resourcesPath, 'stub', 'fake_analysis.py')
  );
});

test('preserves absolute configured paths', () => {
  const configuredPath = path.resolve('custom', 'analyze.py');

  assert.equal(
    resolveRuntimePath(configuredPath, {
      isPackaged: true,
      resourcesPath: 'ignored',
      appDirectory: 'ignored',
    }),
    configuredPath
  );
});
