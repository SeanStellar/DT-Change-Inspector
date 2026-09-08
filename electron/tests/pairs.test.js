'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { findPairs, maskPathForPair, swapPairFiles, uniqueDestination } = require('../core/pairs');

test('pairs exact before/after names and resolves mask aliases', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-pairs-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const mask = path.join(root, 'mask');
  await Promise.all([before, after, mask].map((directory) => fs.mkdir(directory)));
  await Promise.all([
    fs.writeFile(path.join(before, 'tile.png'), 'before'),
    fs.writeFile(path.join(after, 'tile.png'), 'after'),
    fs.writeFile(path.join(mask, 'tile_mask.png'), 'mask'),
    fs.writeFile(path.join(after, 'unpaired.png'), 'after'),
  ]);
  const pairs = await findPairs(before, after, mask);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].name, 'tile.png');
  assert.equal(path.basename(pairs[0].maskPath), 'tile_mask.png');
  assert.equal(maskPathForPair(mask, 'tile.jpg'), path.join(mask, 'tile.jpg'));

  const occupied = path.join(root, 'deleted.png');
  await fs.writeFile(occupied, 'x');
  assert.equal(path.basename(await uniqueDestination(occupied)), 'deleted_1.png');
});

test('swaps same-name A and B original files and cleans backups', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-swap-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const beforeDir = path.join(root, 'A');
  const afterDir = path.join(root, 'B');
  await Promise.all([fs.mkdir(beforeDir), fs.mkdir(afterDir)]);
  const beforePath = path.join(beforeDir, 'tile.jpg');
  const afterPath = path.join(afterDir, 'tile.jpg');
  await fs.writeFile(beforePath, 'original-A');
  await fs.writeFile(afterPath, 'original-B');

  await swapPairFiles(beforePath, afterPath);

  assert.equal(await fs.readFile(beforePath, 'utf8'), 'original-B');
  assert.equal(await fs.readFile(afterPath, 'utf8'), 'original-A');
  assert.deepEqual((await fs.readdir(beforeDir)).sort(), ['tile.jpg']);
  assert.deepEqual((await fs.readdir(afterDir)).sort(), ['tile.jpg']);
});
