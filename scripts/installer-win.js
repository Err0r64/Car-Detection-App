'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageMetadata = require(path.join(projectRoot, 'package.json'));
const localRoot = process.env.LOCALAPPDATA || os.tmpdir();
const buildDirectory = path.join(localRoot, 'CapstoneVideoEditorInstaller');
const releaseDirectory = path.join(projectRoot, 'dist', 'installer');
const artifactName = 'Capstone Video Editor-Setup-' + packageMetadata.version + '-x64.exe';
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
    'nsis',
    '--x64',
    '--config.directories.output=' + buildDirectory,
  ],
  {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  }
);

if (result.error) {
  console.error('Could not launch electron-builder: ' + result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);

const builtArtifact = path.join(buildDirectory, artifactName);
if (!fs.existsSync(builtArtifact)) {
  console.error('Installer build completed without the expected artifact: ' + builtArtifact);
  process.exit(1);
}

fs.mkdirSync(releaseDirectory, { recursive: true });
const releaseArtifact = path.join(releaseDirectory, artifactName);
fs.copyFileSync(builtArtifact, releaseArtifact);

const digest = crypto
  .createHash('sha256')
  .update(fs.readFileSync(releaseArtifact))
  .digest('hex');
const checksumPath = releaseArtifact + '.sha256.txt';
fs.writeFileSync(checksumPath, digest + '  ' + artifactName + os.EOL, 'utf8');

const sizeMb = (fs.statSync(releaseArtifact).size / (1024 * 1024)).toFixed(1);
console.log('Tester installer: ' + releaseArtifact);
console.log('Installer size: ' + sizeMb + ' MB');
console.log('SHA-256: ' + digest);
console.log('Checksum file: ' + checksumPath);
