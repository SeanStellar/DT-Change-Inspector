'use strict';

const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);

async function imageFiles(directory) {
  if (!directory) return [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function findPairs(beforeDir, afterDir, maskDir) {
  const [beforeFiles, afterFiles, maskFiles] = await Promise.all([
    imageFiles(beforeDir), imageFiles(afterDir), imageFiles(maskDir),
  ]);
  const before = new Map(beforeFiles.map((file) => [path.basename(file), file]));
  const after = new Map(afterFiles.map((file) => [path.basename(file), file]));
  const maskByName = new Map(maskFiles.map((file) => [path.basename(file), file]));
  const maskByStem = new Map();
  for (const file of maskFiles.sort()) {
    const stem = path.parse(file).name;
    if (!maskByStem.has(stem)) maskByStem.set(stem, file);
  }

  const names = [...after.keys()].filter((name) => before.has(name)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return names.map((name) => {
    const stem = path.parse(name).name;
    let maskPath = maskByName.get(name) || null;
    if (!maskPath) {
      const aliases = [stem, `${stem}_mask`, `${stem}-mask`, `${stem}_label`, `${stem}-label`, `mask_${stem}`];
      for (const alias of aliases) {
        if (maskByStem.has(alias)) {
          maskPath = maskByStem.get(alias);
          break;
        }
      }
    }
    return { name, beforePath: before.get(name), afterPath: after.get(name), maskPath };
  });
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function maskPathForPair(maskDir, pairName) {
  if (!maskDir) throw new Error('Mask 保存目录不能为空');
  return path.join(maskDir, path.basename(pairName));
}

async function uniqueDestination(targetPath) {
  if (!(await pathExists(targetPath))) return targetPath;
  const parsed = path.parse(targetPath);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error('无法创建唯一删除目标路径');
}

async function swapPairFiles(beforePath, afterPath) {
  if (!beforePath || !afterPath) throw new Error('A、B 文件路径不能为空');
  const resolvedBefore = path.resolve(beforePath);
  const resolvedAfter = path.resolve(afterPath);
  if (resolvedBefore.toLowerCase() === resolvedAfter.toLowerCase()) {
    throw new Error('A、B 指向同一个文件，无法互换');
  }
  if (path.basename(resolvedBefore) !== path.basename(resolvedAfter)) {
    throw new Error('只能互换文件名完全相同的 A、B 文件');
  }

  const [beforeStat, afterStat] = await Promise.all([fs.stat(resolvedBefore), fs.stat(resolvedAfter)]);
  if (!beforeStat.isFile() || !afterStat.isFile()) throw new Error('A、B 路径必须都是文件');

  const token = `${process.pid}-${randomUUID()}`;
  const beforeBackup = path.join(path.dirname(resolvedBefore), `.${path.basename(resolvedBefore)}.${token}.swap-backup`);
  const afterBackup = path.join(path.dirname(resolvedAfter), `.${path.basename(resolvedAfter)}.${token}.swap-backup`);
  let backupsReady = false;
  try {
    await fs.copyFile(resolvedBefore, beforeBackup, constants.COPYFILE_EXCL);
    await fs.copyFile(resolvedAfter, afterBackup, constants.COPYFILE_EXCL);
    backupsReady = true;

    await fs.copyFile(afterBackup, resolvedBefore);
    await fs.utimes(resolvedBefore, afterStat.atime, afterStat.mtime);
    await fs.copyFile(beforeBackup, resolvedAfter);
    await fs.utimes(resolvedAfter, beforeStat.atime, beforeStat.mtime);
  } catch (error) {
    const rollbackErrors = [];
    if (backupsReady) {
      try {
        await fs.copyFile(beforeBackup, resolvedBefore);
        await fs.utimes(resolvedBefore, beforeStat.atime, beforeStat.mtime);
      } catch (rollbackError) {
        rollbackErrors.push(`恢复 A 失败：${rollbackError.message}`);
      }
      try {
        await fs.copyFile(afterBackup, resolvedAfter);
        await fs.utimes(resolvedAfter, afterStat.atime, afterStat.mtime);
      } catch (rollbackError) {
        rollbackErrors.push(`恢复 B 失败：${rollbackError.message}`);
      }
    }
    const suffix = rollbackErrors.length ? `；${rollbackErrors.join('；')}` : '';
    throw new Error(`A、B 原始文件互换失败：${error.message}${suffix}`);
  } finally {
    await Promise.all([
      fs.rm(beforeBackup, { force: true }).catch(() => {}),
      fs.rm(afterBackup, { force: true }).catch(() => {}),
    ]);
  }
  return { beforePath: resolvedBefore, afterPath: resolvedAfter };
}

module.exports = { IMAGE_EXTENSIONS, findPairs, imageFiles, maskPathForPair, pathExists, swapPairFiles, uniqueDestination };
