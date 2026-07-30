'use strict';

const fs = require('fs');
const path = require('path');

const INVALID_PROJECT_NAME = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function cleanProjectName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateProjectName(value) {
  const name = cleanProjectName(value);
  if (!name) return 'Enter a project name.';
  if (name === '.' || name === '..') return 'Choose a different project name.';
  if (name.length > 100) return 'Project names must be 100 characters or fewer.';
  if (INVALID_PROJECT_NAME.test(name)) {
    return 'Project names cannot contain < > : " / \\ | ? * or control characters.';
  }
  if (/[. ]$/.test(name)) return 'Project names cannot end with a period or space.';
  if (RESERVED_WINDOWS_NAME.test(name)) return 'That name is reserved by Windows.';
  return null;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return comparablePath(left) === comparablePath(right);
}

function resolveProjectDirectory(projectsRoot, projectName) {
  const validationError = validateProjectName(projectName);
  if (validationError) throw new Error(validationError);
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
    throw new Error('The projects location must be an absolute path.');
  }

  const root = path.resolve(projectsRoot);
  const projectDirectory = path.resolve(root, cleanProjectName(projectName));
  if (!pathsEqual(path.dirname(projectDirectory), root)) {
    throw new Error('The project must be created directly inside the projects location.');
  }
  return projectDirectory;
}

function findAvailableImportPath(mediaDirectory, fileName, exists = fs.existsSync) {
  const safeName = path.basename(fileName);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('The imported video must have a valid filename.');
  }

  const parsed = path.parse(safeName);
  let candidate = path.join(mediaDirectory, safeName);
  let suffix = 2;
  while (exists(candidate)) {
    candidate = path.join(mediaDirectory, `${parsed.name} (${suffix})${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

async function importVideoFile(projectDirectory, sourcePath) {
  if (typeof projectDirectory !== 'string' || !path.isAbsolute(projectDirectory)) {
    throw new Error('The project directory must be an absolute path.');
  }
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new Error('The source video path must be absolute.');
  }

  const mediaDirectory = path.join(projectDirectory, 'media');
  await fs.promises.mkdir(mediaDirectory, { recursive: true });
  if (pathsEqual(path.dirname(sourcePath), mediaDirectory)) return sourcePath;

  const importedPath = findAvailableImportPath(mediaDirectory, path.basename(sourcePath));
  await fs.promises.copyFile(sourcePath, importedPath, fs.constants.COPYFILE_EXCL);
  return importedPath;
}

module.exports = {
  cleanProjectName,
  findAvailableImportPath,
  importVideoFile,
  pathsEqual,
  resolveProjectDirectory,
  validateProjectName,
};