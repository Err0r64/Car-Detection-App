'use strict';

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const localRoot = process.env.LOCALAPPDATA || os.tmpdir();
const outputDirectory = path.join(localRoot, 'CapstoneVideoEditorBuild');
const builderCli = path.join(
  projectRoot,
  'node_modules',
  'electron-builder',
  'cli.js'
);

const result = spawnSync(
  process.execPath,
  [
    builderCli,
    '--win',
    '--dir',
    `--config.directories.output=${outputDirectory}`,
  ],
  {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  }
);

if (result.error) {
  console.error(`Could not launch electron-builder: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status || 1;
} else {
  console.log(`Packaged application: ${path.join(outputDirectory, 'win-unpacked')}`);
}
