'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  findAvailableImportPath,
  importVideoFile,
  resolveProjectDirectory,
  validateProjectName,
} = require('../project-workspace');

test('validates project names for Windows-compatible folders', () => {
  assert.equal(validateProjectName('Race Weekend'), null);
  assert.match(validateProjectName(''), /Enter/);
  assert.match(validateProjectName('../escape'), /cannot contain/);
  assert.match(validateProjectName('bad.'), /end/);
  assert.match(validateProjectName('CON'), /reserved/);
});

test('resolves a project as a direct child of the configured root', () => {
  const root = path.resolve('C:/Projects');
  assert.equal(
    resolveProjectDirectory(root, 'Track Day'),
    path.join(root, 'Track Day')
  );
  assert.throws(() => resolveProjectDirectory('relative', 'Track Day'), /absolute/);
});

test('uses collision-safe names when importing videos', () => {
  const media = path.resolve('C:/Projects/Track Day/media');
  const occupied = new Set([
    path.join(media, 'race.mov'),
    path.join(media, 'race (2).mov'),
  ]);
  const result = findAvailableImportPath(media, 'race.mov', (candidate) => occupied.has(candidate));
  assert.equal(result, path.join(media, 'race (3).mov'));
});
test('copies imported videos into project media with collision-safe names', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apexiel-workspace-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const projectDirectory = path.join(temporaryRoot, 'Project');
  const sourceDirectory = path.join(temporaryRoot, 'Source');
  fs.mkdirSync(projectDirectory);
  fs.mkdirSync(sourceDirectory);
  const sourcePath = path.join(sourceDirectory, 'race.mov');
  fs.writeFileSync(sourcePath, 'video-content');

  const firstImport = await importVideoFile(projectDirectory, sourcePath);
  const secondImport = await importVideoFile(projectDirectory, sourcePath);

  assert.equal(firstImport, path.join(projectDirectory, 'media', 'race.mov'));
  assert.equal(secondImport, path.join(projectDirectory, 'media', 'race (2).mov'));
  assert.equal(fs.readFileSync(firstImport, 'utf8'), 'video-content');
  assert.equal(fs.readFileSync(secondImport, 'utf8'), 'video-content');
});