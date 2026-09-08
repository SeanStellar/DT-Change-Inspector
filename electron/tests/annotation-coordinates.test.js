'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { canvasPointToImage } = require('../core/annotation-coordinates');

const transform = {
  clip: { x: 0, y: 0, width: 200, height: 200 },
  left: 50,
  top: 25,
  displayWidth: 100,
  displayHeight: 150,
  sourceWidth: 1000,
  sourceHeight: 600,
};

test('coordinate helper exports to the renderer window even when CommonJS globals exist', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'annotation-coordinates.js'), 'utf8');
  const context = { window: {}, module: { exports: {} } };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.window.annotationCoordinates.canvasPointToImage, 'function');
  assert.equal(context.module.exports.canvasPointToImage, context.window.annotationCoordinates.canvasPointToImage);
});

test('coordinate helper and renderer binding coexist as classic scripts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'annotation-coordinates.js'), 'utf8');
  const context = { window: {}, module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.doesNotThrow(() => vm.runInContext(
    'const { canvasPointToImage } = window.annotationCoordinates;',
    context,
  ));
});

test('strict mapping accepts only points inside the displayed image', () => {
  assert.deepEqual(canvasPointToImage(transform, { x: 100, y: 100 }), { x: 500, y: 300 });
  assert.equal(canvasPointToImage(transform, { x: 20, y: 100 }), null);
  assert.equal(canvasPointToImage(transform, { x: 100, y: 10 }), null);
});

test('edge snapping clamps letterbox margins to image edges and corners', () => {
  assert.deepEqual(canvasPointToImage(transform, { x: 20, y: 100 }, true), { x: 0, y: 300 });
  assert.deepEqual(canvasPointToImage(transform, { x: 180, y: 100 }, true), { x: 999, y: 300 });
  assert.deepEqual(canvasPointToImage(transform, { x: 100, y: 10 }, true), { x: 500, y: 0 });
  assert.deepEqual(canvasPointToImage(transform, { x: 100, y: 190 }, true), { x: 500, y: 599 });
  assert.deepEqual(canvasPointToImage(transform, { x: 10, y: 5 }, true), { x: 0, y: 0 });
  assert.deepEqual(canvasPointToImage(transform, { x: 190, y: 195 }, true), { x: 999, y: 599 });
});

test('edge snapping never accepts points outside the active viewport clip', () => {
  assert.equal(canvasPointToImage(transform, { x: -1, y: 100 }, true), null);
  assert.equal(canvasPointToImage(transform, { x: 201, y: 100 }, true), null);
  assert.equal(canvasPointToImage(transform, { x: 100, y: -1 }, true), null);
  assert.equal(canvasPointToImage(transform, { x: 100, y: 201 }, true), null);
});
