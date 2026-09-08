'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');

const { eraseConnected, paintPolygon } = require('./core/mask-service');

async function timed(label, callback) {
  const started = performance.now();
  await callback();
  const elapsed = performance.now() - started;
  console.log(`${label}: ${elapsed.toFixed(1)} ms`);
  return elapsed;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-temporal-performance-'));
  try {
    const largeMask = path.join(root, 'large-mask.png');
    const sourceSize = { width: 6000, height: 4000 };
    await timed('6000x4000 新建并保存彩色多边形 Mask', () => paintPolygon({
      targetPath: largeMask,
      sourceSize,
      points: [
        { x: 300, y: 300 }, { x: 5400, y: 480 },
        { x: 5200, y: 3300 }, { x: 450, y: 3500 },
      ],
      color: '#FFFFFF',
    }));
    await timed('6000x4000 追加第二种颜色', () => paintPolygon({
      existingMask: largeMask,
      targetPath: largeMask,
      sourceSize,
      points: [
        { x: 800, y: 800 }, { x: 2500, y: 900 },
        { x: 2300, y: 2200 }, { x: 900, y: 2100 },
      ],
      color: '#18C060',
    }));

    const eraseMask = path.join(root, 'erase-mask.png');
    const eraseSize = { width: 1500, height: 1500 };
    await sharp({
      create: { width: eraseSize.width, height: eraseSize.height, channels: 3, background: '#33AA66' },
    }).png({ compressionLevel: 1 }).toFile(eraseMask);
    await timed('1500x1500 大面积同色连通区删除并保存', () => eraseConnected({
      maskPath: eraseMask,
      sourceSize: eraseSize,
      point: { x: 10, y: 10 },
    }));
    const memory = process.memoryUsage();
    console.log(`峰值测试后 RSS: ${(memory.rss / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
