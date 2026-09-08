'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { eraseConnected, mergeBinaryMask, paintPolygon, replaceConnectedColor } = require('../core/mask-service');

async function pixel(filePath, x, y) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + 3)];
}

test('writes selected RGB only inside polygon and keeps background black', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-mask-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'mask.png');
  const sourceSize = { width: 80, height: 60 };
  await paintPolygon({
    targetPath: target,
    sourceSize,
    points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 45 }, { x: 10, y: 45 }],
    color: '#FFFFFF',
  });
  assert.deepEqual(await pixel(target, 30, 30), [255, 255, 255]);
  assert.deepEqual(await pixel(target, 2, 2), [0, 0, 0]);

  await paintPolygon({
    existingMask: target,
    targetPath: target,
    sourceSize,
    points: [{ x: 64, y: 12 }, { x: 75, y: 12 }, { x: 75, y: 25 }, { x: 64, y: 25 }],
    color: '#18C060',
  });
  assert.deepEqual(await pixel(target, 70, 18), [24, 192, 96]);
  assert.deepEqual(await pixel(target, 30, 30), [255, 255, 255]);
  assert.deepEqual(await pixel(target, 2, 2), [0, 0, 0]);
});

test('writes a new mask using the exact paired image filename', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-mask-name-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'tile.jpg');
  await paintPolygon({
    targetPath: target,
    sourceSize: { width: 24, height: 18 },
    points: [{ x: 3, y: 3 }, { x: 20, y: 3 }, { x: 20, y: 14 }, { x: 3, y: 14 }],
    color: '#18C060',
  });
  const metadata = await sharp(target).metadata();
  assert.equal(path.basename(target), 'tile.jpg');
  assert.equal(metadata.format, 'jpeg');
});

test('connected erase removes only the clicked exact RGB class', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-erase-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'mask.png');
  const sourceSize = { width: 40, height: 24 };
  const data = Buffer.alloc(sourceSize.width * sourceSize.height * 3);
  for (let y = 2; y < 20; y += 1) {
    for (let x = 2; x < 18; x += 1) {
      const offset = (y * sourceSize.width + x) * 3;
      data.set([200, 40, 20], offset);
    }
    for (let x = 20; x < 36; x += 1) {
      const offset = (y * sourceSize.width + x) * 3;
      data.set([20, 180, 80], offset);
    }
  }
  await sharp(data, { raw: { ...sourceSize, channels: 3 } }).png().toFile(target);
  const result = await eraseConnected({ maskPath: target, sourceSize, point: { x: 5, y: 5 } });
  assert.equal(result.deletedPixels, 16 * 18);
  assert.deepEqual(await pixel(target, 5, 5), [0, 0, 0]);
  assert.deepEqual(await pixel(target, 25, 5), [20, 180, 80]);
});

test('connected color replacement changes only the clicked component', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-replace-color-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'mask.png');
  const sourceSize = { width: 32, height: 20 };
  const data = Buffer.alloc(sourceSize.width * sourceSize.height * 3);
  const fill = (left, top, right, bottom, color) => {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) data.set(color, (y * sourceSize.width + x) * 3);
    }
  };
  fill(2, 2, 10, 10, [200, 40, 20]);
  fill(14, 2, 22, 10, [200, 40, 20]);
  fill(2, 12, 10, 18, [20, 180, 80]);
  await sharp(data, { raw: { ...sourceSize, channels: 3 } }).png().toFile(target);

  const result = await replaceConnectedColor({
    maskPath: target, sourceSize, point: { x: 5, y: 5 }, color: '#833DF5',
  });

  assert.equal(result.replacedPixels, 64);
  assert.equal(result.alreadySelected, false);
  assert.deepEqual(await pixel(target, 5, 5), [131, 61, 245]);
  assert.deepEqual(await pixel(target, 17, 5), [200, 40, 20]);
  assert.deepEqual(await pixel(target, 5, 15), [20, 180, 80]);

  const same = await replaceConnectedColor({ maskPath: target, sourceSize, point: { x: 5, y: 5 }, color: '#833DF5' });
  assert.equal(same.replacedPixels, 0);
  assert.equal(same.alreadySelected, true);

  const background = await replaceConnectedColor({ maskPath: target, sourceSize, point: { x: 30, y: 19 }, color: '#FFFFFF' });
  assert.equal(background.replacedPixels, 0);
  assert.equal(background.alreadySelected, false);
});

test('binary mask merge writes the active RGB and preserves existing labels', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-sam-merge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'tile.png');
  const sourceSize = { width: 4, height: 3 };
  const existing = Buffer.alloc(sourceSize.width * sourceSize.height * 3);
  existing.set([20, 180, 80], (1 * sourceSize.width + 0) * 3);
  await sharp(existing, { raw: { ...sourceSize, channels: 3 } }).png().toFile(target);

  const result = await mergeBinaryMask({
    existingMask: target,
    targetPath: target,
    sourceSize,
    mask: Uint8Array.from([
      0, 1, 1, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ]),
    maskSize: sourceSize,
    color: '#FFFFFF',
  });

  assert.equal(result.changedPixels, 3);
  assert.deepEqual(await pixel(target, 1, 0), [255, 255, 255]);
  assert.deepEqual(await pixel(target, 2, 1), [255, 255, 255]);
  assert.deepEqual(await pixel(target, 0, 1), [20, 180, 80]);
  assert.deepEqual(await pixel(target, 3, 2), [0, 0, 0]);
});
