const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const virtualEnvironmentDirectory = path.join(projectRoot, '.venv');
const virtualEnvironmentPython = path.join(
  virtualEnvironmentDirectory,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const requirementsPath = path.join(projectRoot, 'pipeline', 'requirements.txt');

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function findSystemPython() {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', prefixArgs: ['-3'] },
        { command: 'python', prefixArgs: [] },
      ]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ];

  return candidates.find(({ command, prefixArgs }) =>
    commandSucceeds(command, [...prefixArgs, '--version'])
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

function ffmpegInstallHint() {
  if (process.platform === 'darwin') {
    return 'Install FFmpeg and ffprobe (for example, with `brew install ffmpeg`) and run setup again.';
  }
  if (process.platform === 'win32') {
    return 'Install FFmpeg and ensure both ffmpeg.exe and ffprobe.exe are on PATH, then run setup again.';
  }
  return 'Install FFmpeg and ffprobe with your system package manager, then run setup again.';
}

function verifyFfmpegTools() {
  const missing = ['ffmpeg', 'ffprobe'].filter((command) =>
    !commandSucceeds(command, ['-version'])
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required command${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.\n`
      + ffmpegInstallHint()
    );
  }
}

function main() {
  const systemPython = findSystemPython();
  if (!systemPython) {
    throw new Error(
      process.platform === 'win32'
        ? 'Python 3 was not found. Install Python 3 with the py launcher or add python.exe to PATH.'
        : 'Python 3 was not found. Install Python 3 and ensure python3 is on PATH.'
    );
  }

  verifyFfmpegTools();
  console.log('FFmpeg and ffprobe are ready.');

  if (!fs.existsSync(virtualEnvironmentPython)) {
    console.log(`Creating Python virtual environment at ${virtualEnvironmentDirectory}`);
    run(systemPython.command, [
      ...systemPython.prefixArgs,
      '-m',
      'venv',
      virtualEnvironmentDirectory,
    ]);
  } else {
    console.log(`Using existing Python virtual environment at ${virtualEnvironmentDirectory}`);
  }

  console.log('Installing Python pipeline requirements');
  run(virtualEnvironmentPython, ['-m', 'pip', 'install', '-r', requirementsPath]);

  console.log('Verifying Python pipeline imports');
  run(virtualEnvironmentPython, [
    '-c',
    'from google import genai; import jsonschema; print("Python pipeline dependencies are ready.")',
  ]);

  console.log('Setup complete. Start the application with `npm start`.');
}

try {
  main();
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}
