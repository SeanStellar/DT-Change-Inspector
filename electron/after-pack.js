'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const WINDOWS_X64_SHARP_PACKAGES = new Set(['colour', 'sharp-win32-x64']);

async function pruneSharpPackages(appOutDir) {
  const imagePackages = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@img',
  );
  let entries;
  try {
    entries = await fs.readdir(imagePackages, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const removed = [];
  for (const entry of entries) {
    if (WINDOWS_X64_SHARP_PACKAGES.has(entry.name)) continue;
    await fs.rm(path.join(imagePackages, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function pruneOnnxRuntimeBinaries(appOutDir) {
  const runtimeRoot = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
  );
  const keep = path.join(runtimeRoot, 'win32', 'x64');
  let entries;
  try {
    entries = await fs.readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const platform of entries) {
    if (!platform.isDirectory()) continue;
    const platformPath = path.join(runtimeRoot, platform.name);
    if (platform.name !== 'win32') {
      await fs.rm(platformPath, { recursive: true, force: true });
      removed.push(platform.name);
      continue;
    }
    for (const architecture of await fs.readdir(platformPath, { withFileTypes: true })) {
      if (!architecture.isDirectory() || path.join(platformPath, architecture.name) === keep) continue;
      await fs.rm(path.join(platformPath, architecture.name), { recursive: true, force: true });
      removed.push(`${platform.name}/${architecture.name}`);
    }
  }
  return removed;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== 1) return;
  const removed = await pruneSharpPackages(context.appOutDir);
  if (removed.length) {
    console.log(`  • pruned non-Windows Sharp packages  count=${removed.length}`);
  }
  const removedOnnx = await pruneOnnxRuntimeBinaries(context.appOutDir);
  if (removedOnnx.length) console.log(`  • pruned non-Windows ONNX Runtime binaries  count=${removedOnnx.length}`);
};

module.exports.pruneSharpPackages = pruneSharpPackages;
module.exports.WINDOWS_X64_SHARP_PACKAGES = WINDOWS_X64_SHARP_PACKAGES;
module.exports.pruneOnnxRuntimeBinaries = pruneOnnxRuntimeBinaries;
