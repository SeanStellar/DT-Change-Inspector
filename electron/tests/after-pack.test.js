'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { pruneOnnxRuntimeBinaries, pruneSharpPackages } = require('../after-pack');

test('packaging keeps only Windows x64 Sharp native packages', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-after-pack-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePackages = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', '@img');
  await fs.mkdir(imagePackages, { recursive: true });
  await Promise.all(['colour', 'sharp-win32-x64', 'sharp-darwin-arm64', 'sharp-linux-x64', 'sharp-win32-arm64']
    .map((name) => fs.mkdir(path.join(imagePackages, name))));

  const removed = await pruneSharpPackages(root);
  const remaining = (await fs.readdir(imagePackages)).sort();

  assert.deepEqual(remaining, ['colour', 'sharp-win32-x64']);
  assert.deepEqual(removed.sort(), ['sharp-darwin-arm64', 'sharp-linux-x64', 'sharp-win32-arm64']);
});

test('packaging keeps only Windows x64 ONNX Runtime binaries', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-onnx-pack-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  for (const folder of ['darwin/arm64', 'linux/x64', 'win32/arm64', 'win32/x64']) {
    await fs.mkdir(path.join(runtimeRoot, folder), { recursive: true });
  }

  const removed = await pruneOnnxRuntimeBinaries(root);

  assert.deepEqual((await fs.readdir(runtimeRoot)).sort(), ['win32']);
  assert.deepEqual(await fs.readdir(path.join(runtimeRoot, 'win32')), ['x64']);
  assert.deepEqual(removed.sort(), ['darwin', 'linux', 'win32/arm64']);
});
