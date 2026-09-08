'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultLabelColor,
  isReservedShortcut,
  normalizeLabelDefinitions,
  normalizeShortcut,
} = require('../core/labels');

test('creates 256 unique non-black labels and preserves current configuration', () => {
  const labels = normalizeLabelDefinitions({
    0: { name: '房屋变化', color: '#FFFFFF', pinned: true, shortcut: 'F1' },
    72: { name: '垃圾', color: '#FBFB40', pinned: true, shortcut: 'Ctrl+Alt+2' },
  });
  assert.equal(Object.keys(labels).length, 256);
  assert.equal(labels[0].name, '房屋变化');
  assert.equal(labels[0].color, '#FFFFFF');
  assert.equal(labels[0].shortcut, 'F1');
  assert.equal(labels[72].shortcut, 'Ctrl+Alt+2');
  assert.equal(new Set(Object.values(labels).map((label) => label.color)).size, 256);
  assert.ok(!Object.values(labels).some((label) => label.color === '#000000'));
  assert.deepEqual(defaultLabelColor(0), [48, 48, 64]);
});

test('normalizes shortcuts and blocks application shortcuts', () => {
  assert.equal(normalizeShortcut('control+alt+f2'), 'Ctrl+Alt+F2');
  assert.equal(normalizeShortcut('shift+1'), 'Shift+1');
  assert.equal(isReservedShortcut('c'), true);
  assert.equal(isReservedShortcut('space'), true);
  assert.equal(isReservedShortcut('x'), true);
  assert.equal(isReservedShortcut('w'), true);
  assert.equal(isReservedShortcut('F3'), false);
});

test('repairs duplicate colors and duplicate shortcuts', () => {
  const labels = normalizeLabelDefinitions({
    1: { color: '#123456', shortcut: 'F4' },
    2: { color: '#123456', shortcut: 'F4' },
  });
  assert.equal(labels[1].color, '#123456');
  assert.notEqual(labels[2].color, '#123456');
  assert.equal(labels[1].shortcut, 'F4');
  assert.equal(labels[2].shortcut, '');
});
