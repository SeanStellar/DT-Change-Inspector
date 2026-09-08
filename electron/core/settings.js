'use strict';

const BLINK_INTERVALS = [150, 250, 350, 600, 1000];
const BLINK_INTERVAL_SET = new Set(BLINK_INTERVALS);

function normalizeBlinkInterval(value) {
  const interval = Number(value);
  return BLINK_INTERVAL_SET.has(interval) ? interval : 350;
}

module.exports = { BLINK_INTERVALS, normalizeBlinkInterval };
