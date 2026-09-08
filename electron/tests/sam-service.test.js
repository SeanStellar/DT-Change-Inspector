'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decoderPrompts, fitImageToModel, restoreMask } = require('../core/sam-service');

test('fits a source image into the model canvas without changing aspect ratio', () => {
  assert.deepEqual(fitImageToModel({ width: 512, height: 512 }), {
    width: 1024, height: 1024, scale: 2,
  });
  assert.deepEqual(fitImageToModel({ width: 1024, height: 512 }), {
    width: 1024, height: 512, scale: 1,
  });
});

test('maps positive and negative source prompts into decoder coordinates', () => {
  const fit = { width: 1024, height: 1024, scale: 2 };
  const result = decoderPrompts([
    { x: 256, y: 256, positive: true },
    { x: 0, y: 0, positive: false },
  ], fit);
  assert.deepEqual([...result.coords], [512, 512, 0, 0]);
  assert.deepEqual([...result.labels], [1, 0]);
});

test('restores a fitted binary model mask to source dimensions', () => {
  const model = new Float32Array(4 * 4);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 2; x < 4; x += 1) model[y * 4 + x] = 1;
  }
  const restored = restoreMask(model, { width: 4, height: 4 }, { width: 2, height: 2 });
  assert.deepEqual([...restored], [0, 1, 0, 1]);
});
