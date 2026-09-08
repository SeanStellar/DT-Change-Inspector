'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

function validateSize(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('无效的图像尺寸');
  }
  return { width, height };
}

function validateColor(color) {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color) || color.toUpperCase() === '#000000') {
    throw new Error('标签颜色必须是非黑色 RGB 颜色');
  }
  return color.toUpperCase();
}

function targetFormat(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  if (ext === '.webp') return 'webp';
  if (ext === '.bmp') return 'png';
  return 'png';
}

function encodeForTarget(pipeline, targetPath) {
  const format = targetFormat(targetPath);
  if (format === 'jpeg') return pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' });
  if (format === 'tiff') return pipeline.tiff({ compression: 'lzw' });
  if (format === 'webp') return pipeline.webp({ lossless: true });
  return pipeline.png({ compressionLevel: 1, adaptiveFiltering: false });
}

async function replaceAtomic(temporary, target) {
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  }
}

function temporaryPath(target) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `.${parsed.name}.masktool_tmp${parsed.ext || '.png'}`);
}

async function basePipeline(existingMask, size) {
  const { width, height } = validateSize(size);
  if (existingMask) {
    return sharp(existingMask)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest })
      .removeAlpha();
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });
}

async function paintPolygon({ existingMask, targetPath, sourceSize, points, color, erase = false }) {
  const { width, height } = validateSize(sourceSize);
  if (!Array.isArray(points) || points.length < 3) throw new Error('多边形至少需要 3 个点');
  const fill = erase ? '#000000' : validateColor(color);
  const normalizedPoints = points.map((point) => {
    const x = Math.max(0, Math.min(width - 1, Math.round(Number(point.x))));
    const y = Math.max(0, Math.min(height - 1, Math.round(Number(point.y))));
    return `${x},${y}`;
  }).join(' ');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<polygon points="${normalizedPoints}" fill="${fill}" shape-rendering="crispEdges"/></svg>`,
  );
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = temporaryPath(targetPath);
  try {
    const base = await basePipeline(existingMask, { width, height });
    const output = base.composite([{ input: svg, blend: 'over' }]);
    await encodeForTarget(output, targetPath).toFile(temporary);
    await replaceAtomic(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return targetPath;
}

async function loadRawMask(maskPath, sourceSize) {
  const { width, height } = validateSize(sourceSize);
  const { data, info } = await sharp(maskPath)
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info: { ...info, width, height, channels: 3 } };
}

function replaceConnectedRaw(data, width, height, startX, startY, replacement) {
  const x0 = Math.round(startX);
  const y0 = Math.round(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return { changedPixels: 0, alreadySelected: false };
  const start = (y0 * width + x0) * 3;
  const targetR = data[start];
  const targetG = data[start + 1];
  const targetB = data[start + 2];
  if (targetR === 0 && targetG === 0 && targetB === 0) return { changedPixels: 0, alreadySelected: false };
  if (targetR === replacement[0] && targetG === replacement[1] && targetB === replacement[2]) {
    return { changedPixels: 0, alreadySelected: true };
  }
  const matches = (x, y) => {
    const offset = (y * width + x) * 3;
    return data[offset] === targetR && data[offset + 1] === targetG && data[offset + 2] === targetB;
  };
  const replace = (x, y) => {
    const offset = (y * width + x) * 3;
    data[offset] = replacement[0];
    data[offset + 1] = replacement[1];
    data[offset + 2] = replacement[2];
  };
  const stack = [[x0, y0]];
  let deleted = 0;
  while (stack.length) {
    let [x, y] = stack.pop();
    while (x >= 0 && matches(x, y)) x -= 1;
    x += 1;
    let spanAbove = false;
    let spanBelow = false;
    while (x < width && matches(x, y)) {
      replace(x, y);
      deleted += 1;
      if (y > 0) {
        const above = matches(x, y - 1);
        if (above && !spanAbove) stack.push([x, y - 1]);
        spanAbove = above;
      }
      if (y + 1 < height) {
        const below = matches(x, y + 1);
        if (below && !spanBelow) stack.push([x, y + 1]);
        spanBelow = below;
      }
      x += 1;
    }
  }
  return { changedPixels: deleted, alreadySelected: false };
}

function eraseConnectedRaw(data, width, height, startX, startY) {
  return replaceConnectedRaw(data, width, height, startX, startY, [0, 0, 0]).changedPixels;
}

async function saveRawMask(data, info, targetPath) {
  const temporary = temporaryPath(targetPath);
  try {
    const pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } });
    await encodeForTarget(pipeline, targetPath).toFile(temporary);
    await replaceAtomic(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function eraseConnected({ maskPath, sourceSize, point }) {
  const { data, info } = await loadRawMask(maskPath, sourceSize);
  const deletedPixels = eraseConnectedRaw(data, info.width, info.height, point.x, point.y);
  if (deletedPixels) await saveRawMask(data, info, maskPath);
  return { maskPath, deletedPixels };
}

async function replaceConnectedColor({ maskPath, sourceSize, point, color }) {
  const normalized = validateColor(color);
  const replacement = [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16));
  const { data, info } = await loadRawMask(maskPath, sourceSize);
  const result = replaceConnectedRaw(data, info.width, info.height, point.x, point.y, replacement);
  if (result.changedPixels) await saveRawMask(data, info, maskPath);
  return { maskPath, replacedPixels: result.changedPixels, alreadySelected: result.alreadySelected };
}

async function mergeBinaryMask({ existingMask, targetPath, sourceSize, mask, maskSize, color }) {
  const { width, height } = validateSize(sourceSize);
  const sourceMaskSize = validateSize(maskSize);
  const normalized = validateColor(color);
  if (!mask || Number(mask.length) !== sourceMaskSize.width * sourceMaskSize.height) {
    throw new Error('SAM Mask 数据尺寸不匹配');
  }
  const replacement = [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16));
  const base = existingMask
    ? await loadRawMask(existingMask, { width, height })
    : { data: Buffer.alloc(width * height * 3), info: { width, height, channels: 3 } };
  let changedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const maskY = Math.min(sourceMaskSize.height - 1, Math.floor(y * sourceMaskSize.height / height));
    for (let x = 0; x < width; x += 1) {
      const maskX = Math.min(sourceMaskSize.width - 1, Math.floor(x * sourceMaskSize.width / width));
      if (!mask[maskY * sourceMaskSize.width + maskX]) continue;
      const offset = (y * width + x) * 3;
      if (base.data[offset] === replacement[0]
        && base.data[offset + 1] === replacement[1]
        && base.data[offset + 2] === replacement[2]) continue;
      base.data[offset] = replacement[0];
      base.data[offset + 1] = replacement[1];
      base.data[offset + 2] = replacement[2];
      changedPixels += 1;
    }
  }
  if (changedPixels || !existingMask) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await saveRawMask(base.data, base.info, targetPath);
  }
  return { maskPath: targetPath, changedPixels };
}

module.exports = {
  eraseConnected,
  eraseConnectedRaw,
  loadRawMask,
  mergeBinaryMask,
  paintPolygon,
  replaceConnectedColor,
  replaceConnectedRaw,
  saveRawMask,
  validateColor,
  validateSize,
};
