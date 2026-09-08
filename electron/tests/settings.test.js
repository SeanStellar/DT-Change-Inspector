'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BLINK_INTERVALS, normalizeBlinkInterval } = require('../core/settings');

test('normalizes blink speed to the five supported intervals', () => {
  assert.deepEqual(BLINK_INTERVALS, [150, 250, 350, 600, 1000]);
  for (const interval of BLINK_INTERVALS) {
    assert.equal(normalizeBlinkInterval(interval), interval);
    assert.equal(normalizeBlinkInterval(String(interval)), interval);
  }
  for (const invalid of [undefined, null, '', 0, 149, 351, 5000, 'fast']) {
    assert.equal(normalizeBlinkInterval(invalid), 350);
  }
});
