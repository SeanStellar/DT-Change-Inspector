'use strict';

const LABEL_MIN = 0;
const LABEL_MAX = 255;
const LABEL_COUNT = 256;

function defaultLabelColor(labelId) {
  if (!Number.isInteger(labelId) || labelId < LABEL_MIN || labelId > LABEL_MAX) {
    throw new RangeError('标签编号必须在 0 到 255 之间');
  }
  const code = (labelId * 73) % LABEL_COUNT;
  return [
    48 + (code & 0b111) * 29,
    48 + ((code >> 3) & 0b111) * 29,
    64 + ((code >> 6) & 0b11) * 60,
  ];
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function normalizeColor(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
    const normalized = value.toUpperCase();
    if (normalized !== '#000000') return normalized;
  }
  return fallback;
}

function normalizeShortcut(value) {
  if (typeof value !== 'string') return '';
  const aliases = new Map([
    ['CONTROL', 'Ctrl'], ['CTRL', 'Ctrl'], ['ALT', 'Alt'], ['SHIFT', 'Shift'],
    ['META', 'Meta'], ['COMMAND', 'Meta'], ['CMD', 'Meta'], ['SPACE', 'Space'],
    ['SPACEBAR', 'Space'], ['ESC', 'Escape'], ['DEL', 'Delete'], ['RETURN', 'Enter'],
    ['ARROWLEFT', 'ArrowLeft'], ['ARROWRIGHT', 'ArrowRight'],
    ['ARROWUP', 'ArrowUp'], ['ARROWDOWN', 'ArrowDown'],
  ]);
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const raw of parts) {
    const upper = raw.toUpperCase();
    const normalized = aliases.get(upper)
      || (raw.length === 1 || /^f\d{1,2}$/i.test(raw) ? raw.toUpperCase() : raw);
    if (['Ctrl', 'Alt', 'Shift', 'Meta'].includes(normalized)) {
      if (!modifiers.includes(normalized)) modifiers.push(normalized);
    } else {
      key = normalized;
    }
  }
  if (!key) return '';
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, key].join('+');
}

const RESERVED_SHORTCUTS = new Set([
  'A', 'D', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'B', 'V', 'W', 'X', 'S', 'C', 'Q', 'E',
  'Delete', 'Shift+Delete', 'U', 'Ctrl+Z', 'R', '0', '+', '=', '-', 'Enter', 'Escape',
  'Backspace',
].map(normalizeShortcut));

function isReservedShortcut(value) {
  return RESERVED_SHORTCUTS.has(normalizeShortcut(value));
}

function normalizeLabelDefinitions(rawLabels) {
  const raw = rawLabels && typeof rawLabels === 'object' ? rawLabels : {};
  const legacy256 = (raw['256'] || raw[256]) && !(raw['0'] || raw[0]);
  const labels = {};
  const usedColors = new Set();
  const usedShortcuts = new Set();
  for (let labelId = LABEL_MIN; labelId <= LABEL_MAX; labelId += 1) {
    const sourceId = legacy256 && labelId === 0 ? 256 : labelId;
    const source = raw[String(sourceId)] || raw[sourceId] || {};
    let color = normalizeColor(source.color, rgbToHex(defaultLabelColor(labelId)));
    if (usedColors.has(color)) {
      for (let offset = 0; offset < LABEL_COUNT; offset += 1) {
        const fallback = rgbToHex(defaultLabelColor((labelId + offset) % LABEL_COUNT));
        if (!usedColors.has(fallback)) {
          color = fallback;
          break;
        }
      }
    }
    usedColors.add(color);
    let shortcut = normalizeShortcut(source.shortcut || '');
    if (isReservedShortcut(shortcut) || usedShortcuts.has(shortcut)) shortcut = '';
    if (shortcut) usedShortcuts.add(shortcut);
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim().slice(0, 64)
      : `标签 ${labelId}`;
    labels[labelId] = { name, color, pinned: Boolean(source.pinned), shortcut };
  }
  return labels;
}

function eventToShortcut(event) {
  if (!event || !event.key) return '';
  let key = event.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && key !== 'Shift') parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) parts.push(key);
  return normalizeShortcut(parts.join('+'));
}

module.exports = {
  LABEL_MIN,
  LABEL_MAX,
  LABEL_COUNT,
  RESERVED_SHORTCUTS,
  defaultLabelColor,
  eventToShortcut,
  isReservedShortcut,
  normalizeColor,
  normalizeLabelDefinitions,
  normalizeShortcut,
  rgbToHex,
};
