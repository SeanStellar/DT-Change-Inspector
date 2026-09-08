'use strict';

const api = window.desktopAPI;
const { canvasPointToImage } = window.annotationCoordinates;
const canvas = document.getElementById('image-canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const annotationCanvas = document.getElementById('annotation-canvas');
const annotationCtx = annotationCanvas.getContext('2d', { alpha: true, desynchronized: true });
const viewer = document.getElementById('viewer');
const emptyState = document.getElementById('empty-state');
const busyIndicator = document.getElementById('busy-indicator');
const statusBar = document.getElementById('status-bar');
const toast = document.getElementById('toast');
const pathPanel = document.querySelector('.path-panel');
const pathPanelToggle = document.getElementById('path-panel-toggle');
const labelPanel = document.getElementById('label-panel');
const labelList = document.getElementById('label-list');
const maskScratch = document.createElement('canvas');
const maskScratchContext = maskScratch.getContext('2d', { willReadFrequently: true });
const samScratch = document.createElement('canvas');
const samScratchContext = samScratch.getContext('2d');
const MASK_ROWS_PER_CHUNK = 192;
const PREVIEW_MAX_DIMENSION = 1920;
const NAVIGATION_RENDER_INTERVAL_MS = 100;

const elements = {
  beforePath: document.getElementById('before-path'),
  afterPath: document.getElementById('after-path'),
  maskPath: document.getElementById('mask-path'),
  labelId: document.getElementById('label-id'),
  labelName: document.getElementById('label-name'),
  labelColor: document.getElementById('label-color'),
  labelShortcut: document.getElementById('label-shortcut'),
  captureShortcut: document.getElementById('capture-shortcut'),
  pinLabel: document.getElementById('pin-label'),
  maskOpacity: document.getElementById('mask-opacity'),
  maskOpacityValue: document.getElementById('mask-opacity-value'),
  blinkSpeed: document.getElementById('blink-speed'),
};

const buttons = Object.fromEntries(
  [...document.querySelectorAll('[data-action]')].map((button) => [button.dataset.action, button]),
);

const state = {
  settings: { beforeDir: '', afterDir: '', maskDir: '' },
  pairs: [],
  index: 0,
  mode: 'after',
  viewMode: 'single',
  blinking: false,
  blinkTimer: null,
  blinkIntervalMs: 350,
  showMask: true,
  maskOpacity: 46,
  annotationMode: false,
  annotationAction: 'add',
  eraseStyle: 'single',
  annotationPoints: [],
  annotationCursor: null,
  annotationTransformIndex: null,
  samMask: null,
  samScore: 0,
  samRequestId: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  drag: null,
  fastRender: false,
  busy: false,
  transforms: [],
  labels: {},
  activeLabelId: 1,
  selectedLabelId: 1,
  capturingShortcut: false,
  capturedShortcut: '',
  renderSequence: 0,
  lastRenderedIndex: null,
  lastRenderError: '',
  lastDeletedIndex: null,
};

const imageCache = new Map();
let toastTimer = null;
let renderFrame = null;
let renderSettleTimer = null;
let navigationRenderTimer = null;
let prefetchHandle = null;

function normalizeShortcut(value) {
  if (typeof value !== 'string') return '';
  const aliases = new Map([
    ['CONTROL', 'Ctrl'], ['CTRL', 'Ctrl'], ['ALT', 'Alt'], ['SHIFT', 'Shift'],
    ['META', 'Meta'], ['COMMAND', 'Meta'], ['CMD', 'Meta'], ['SPACE', 'Space'],
    ['SPACEBAR', 'Space'], ['ESC', 'Escape'], ['DEL', 'Delete'], ['RETURN', 'Enter'],
    ['ARROWLEFT', 'ArrowLeft'], ['ARROWRIGHT', 'ArrowRight'],
    ['ARROWUP', 'ArrowUp'], ['ARROWDOWN', 'ArrowDown'],
  ]);
  const modifiers = [];
  let key = '';
  for (const raw of value.split('+').map((part) => part.trim()).filter(Boolean)) {
    const normalized = aliases.get(raw.toUpperCase())
      || (raw.length === 1 || /^f\d{1,2}$/i.test(raw) ? raw.toUpperCase() : raw);
    if (['Ctrl', 'Alt', 'Shift', 'Meta'].includes(normalized)) {
      if (!modifiers.includes(normalized)) modifiers.push(normalized);
    } else key = normalized;
  }
  if (!key) return '';
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, key].join('+');
}

function eventToShortcut(event) {
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

const reservedShortcuts = new Set([
  'A', 'D', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'B', 'V', 'W', 'X', 'S', 'C', 'Q', 'E', 'F',
  'Delete', 'Shift+Delete', 'U', 'Ctrl+Z', 'R', '0', '+', '=', '-', 'Enter', 'Escape', 'Backspace', 'Shift+E',
].map(normalizeShortcut));

function currentPair() {
  return state.pairs[state.index] || null;
}

function currentLabel() {
  return state.labels[state.activeLabelId] || { name: `标签 ${state.activeLabelId}`, color: '#FFFFFF', shortcut: '' };
}

function setStatus(message) {
  statusBar.textContent = message;
}

function showToast(message, duration = 2600) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

function setBusy(busy, message = '处理中…') {
  state.busy = busy;
  busyIndicator.textContent = message;
  busyIndicator.hidden = !busy;
  updateButtons();
}

function contrastingColor(hex) {
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 145 ? '#111111' : '#FFFFFF';
}

function setButtonState(button, active, tone) {
  if (!button) return;
  button.classList.toggle('active', active);
  if (active && tone) button.dataset.tone = tone;
  else delete button.dataset.tone;
}

function updateButtons() {
  setButtonState(buttons.mask, state.showMask, 'blue');
  setButtonState(buttons.annotate, state.annotationMode && state.annotationAction === 'add', 'green');
  setButtonState(buttons.erase, state.annotationMode && state.annotationAction === 'erase', 'orange');
  setButtonState(buttons['replace-color'], state.annotationMode && state.annotationAction === 'replace', 'teal');
  setButtonState(buttons.sam, state.annotationMode && state.annotationAction === 'sam', 'green');
  buttons.erase.textContent = state.annotationMode && state.annotationAction === 'erase'
    ? (state.eraseStyle === 'polygon' ? '区域删标注 [E]' : '单删标注 [E]')
    : '删标注 [E]';
  setButtonState(buttons.blink, state.blinking, 'amber');
  setButtonState(buttons.compare, state.viewMode === 'compare', 'purple');
  setButtonState(buttons.phase, true, state.mode === 'after' ? 'blue' : 'purple');
  buttons.phase.textContent = `时相 ${state.mode === 'after' ? 'B' : 'A'} [空格]`;
  const label = currentLabel();
  buttons.labels.textContent = `标签 ${String(state.activeLabelId).padStart(3, '0')} [C]`;
  buttons.labels.style.background = label.color;
  buttons.labels.style.color = contrastingColor(label.color);
  buttons.labels.style.boxShadow = labelPanel.hidden ? '' : 'inset 0 0 0 2px #ffffff';
  canvas.classList.toggle('annotating', state.annotationMode);
  for (const button of Object.values(buttons)) button.disabled = state.busy && !['mask', 'phase', 'labels'].includes(button.dataset.action);
}

function syncPathInputs() {
  elements.beforePath.value = state.settings.beforeDir || '';
  elements.afterPath.value = state.settings.afterDir || '';
  elements.maskPath.value = state.settings.maskDir || '';
  updatePathPresentations();
}

function updatePathPresentation(input) {
  input.title = input.value || '尚未选择目录';
  if (document.activeElement !== input) {
    requestAnimationFrame(() => { input.scrollLeft = input.scrollWidth; });
  }
}

function updatePathPresentations() {
  for (const input of [elements.beforePath, elements.afterPath, elements.maskPath]) {
    updatePathPresentation(input);
  }
}

function setPathPanelExpanded(expanded) {
  pathPanel.classList.toggle('expanded', expanded);
  pathPanelToggle.setAttribute('aria-expanded', String(expanded));
  pathPanelToggle.textContent = expanded ? '收起' : '展开';
  updatePathPresentations();
}

function readPathInputs() {
  state.settings = {
    beforeDir: elements.beforePath.value.trim(),
    afterDir: elements.afterPath.value.trim(),
    maskDir: elements.maskPath.value.trim(),
    maskOpacity: state.maskOpacity,
    blinkIntervalMs: state.blinkIntervalMs,
  };
  return state.settings;
}

function loadImage(url) {
  if (!url) return Promise.reject(new Error('图像路径为空'));
  if (imageCache.has(url)) {
    const cached = imageCache.get(url);
    imageCache.delete(url);
    imageCache.set(url, cached);
    return cached;
  }
  imageCache.set(url, new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => {
        imageCache.delete(url);
        reject(new Error(`无法载入图像: ${url}`));
      };
      image.src = url;
  }));
  while (imageCache.size > 9) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  return imageCache.get(url);
}

async function loadImagePreview(url) {
  const image = await loadImage(url);
  if (!image.previewBitmapPromise) {
    const scale = Math.min(1, PREVIEW_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const resizeWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const resizeHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    image.previewBitmapPromise = createImageBitmap(image, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'medium',
    }).catch(() => image);
  }
  return image.previewBitmapPromise;
}

function scheduleNearbyPrefetch() {
  if (!state.pairs.length || state.busy) return;
  if (prefetchHandle !== null) cancelIdleCallback(prefetchHandle);
  const index = state.index;
  prefetchHandle = requestIdleCallback(() => {
    prefetchHandle = null;
    if (index !== state.index || state.busy) return;
    for (const delta of [-1, 1]) {
      const pair = state.pairs[(index + delta + state.pairs.length) % state.pairs.length];
      if (!pair) continue;
      const urls = state.viewMode === 'compare'
        ? [pair.beforeUrl, pair.afterUrl]
        : [state.mode === 'after' ? pair.afterUrl : pair.beforeUrl];
      if (state.showMask && pair.maskUrl) urls.push(pair.maskUrl);
      for (const url of urls) loadImagePreview(url).catch(() => {});
    }
  }, { timeout: 350 });
}

function resizeCanvas() {
  const width = Math.max(1, Math.round(viewer.clientWidth));
  const height = Math.max(1, Math.round(viewer.clientHeight));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (annotationCanvas.width !== width || annotationCanvas.height !== height) {
    annotationCanvas.width = width;
    annotationCanvas.height = height;
  }
}

function createTransform(image, clip, commonFit = null) {
  const fit = commonFit ?? Math.min(clip.width / image.naturalWidth, clip.height / image.naturalHeight);
  const scale = Math.max(0.02, fit * state.zoom);
  const displayWidth = Math.max(1, image.naturalWidth * scale);
  const displayHeight = Math.max(1, image.naturalHeight * scale);
  const centerX = clip.x + clip.width / 2 + state.panX;
  const centerY = clip.y + clip.height / 2 + state.panY;
  return {
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    displayWidth,
    displayHeight,
    centerX,
    centerY,
    left: centerX - displayWidth / 2,
    top: centerY - displayHeight / 2,
    clip,
  };
}

function drawImageInTransform(image, transform) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(transform.clip.x, transform.clip.y, transform.clip.width, transform.clip.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = !state.fastRender;
  ctx.imageSmoothingQuality = state.fastRender ? 'low' : 'high';
  ctx.drawImage(image, transform.left, transform.top, transform.displayWidth, transform.displayHeight);
  ctx.restore();
}

function sameColor(pixels, leftOffset, rightOffset) {
  return pixels[leftOffset] === pixels[rightOffset]
    && pixels[leftOffset + 1] === pixels[rightOffset + 1]
    && pixels[leftOffset + 2] === pixels[rightOffset + 2];
}

async function yieldMaskRender(renderId) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return renderId === state.renderSequence;
}

async function drawMaskOverlay(maskImage, transform, renderId) {
  if (renderId !== state.renderSequence) return;
  if (state.fastRender) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(transform.clip.x, transform.clip.y, transform.clip.width, transform.clip.height);
    ctx.clip();
    ctx.globalAlpha = state.maskOpacity / 100;
    ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(maskImage, transform.left, transform.top, transform.displayWidth, transform.displayHeight);
    ctx.restore();
    return;
  }
  const left = Math.max(transform.left, transform.clip.x);
  const top = Math.max(transform.top, transform.clip.y);
  const right = Math.min(transform.left + transform.displayWidth, transform.clip.x + transform.clip.width);
  const bottom = Math.min(transform.top + transform.displayHeight, transform.clip.y + transform.clip.height);
  const width = Math.max(0, Math.ceil(right - left));
  const height = Math.max(0, Math.ceil(bottom - top));
  if (!width || !height || renderId !== state.renderSequence) return;

  maskScratch.width = width;
  maskScratch.height = height;
  maskScratchContext.clearRect(0, 0, width, height);
  maskScratchContext.imageSmoothingEnabled = false;
  const sourceX = (left - transform.left) * maskImage.naturalWidth / transform.displayWidth;
  const sourceY = (top - transform.top) * maskImage.naturalHeight / transform.displayHeight;
  const sourceWidth = width * maskImage.naturalWidth / transform.displayWidth;
  const sourceHeight = height * maskImage.naturalHeight / transform.displayHeight;
  maskScratchContext.drawImage(maskImage, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  const imageData = maskScratchContext.getImageData(0, 0, width, height);
  const original = new Uint8ClampedArray(imageData.data);
  const foreground = new Uint8Array(width * height);
  const edges = new Uint8Array(width * height);
  const fillAlpha = Math.round(255 * state.maskOpacity / 100);

  for (let startY = 0; startY < height; startY += MASK_ROWS_PER_CHUNK) {
    const endPixel = Math.min(height, startY + MASK_ROWS_PER_CHUNK) * width;
    for (let pixel = startY * width; pixel < endPixel; pixel += 1) {
      const offset = pixel * 4;
      const visible = original[offset] !== 0 || original[offset + 1] !== 0 || original[offset + 2] !== 0;
      foreground[pixel] = visible ? 1 : 0;
      imageData.data[offset + 3] = visible ? fillAlpha : 0;
    }
    if (endPixel < foreground.length && !await yieldMaskRender(renderId)) return;
  }

  for (let startY = 0; startY < height; startY += MASK_ROWS_PER_CHUNK) {
    const endY = Math.min(height, startY + MASK_ROWS_PER_CHUNK);
    for (let y = startY; y < endY; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        if (!foreground[pixel]) continue;
        const offset = pixel * 4;
        let boundary = false;
        if (x > 0) {
          const neighbor = pixel - 1;
          boundary ||= !foreground[neighbor] || !sameColor(original, offset, neighbor * 4);
        }
        if (!boundary && x + 1 < width) {
          const neighbor = pixel + 1;
          boundary ||= !foreground[neighbor] || !sameColor(original, offset, neighbor * 4);
        }
        if (!boundary && y > 0) {
          const neighbor = pixel - width;
          boundary ||= !foreground[neighbor] || !sameColor(original, offset, neighbor * 4);
        }
        if (!boundary && y + 1 < height) {
          const neighbor = pixel + width;
          boundary ||= !foreground[neighbor] || !sameColor(original, offset, neighbor * 4);
        }
        if (boundary) edges[pixel] = 1;
      }
    }
    if (endY < height && !await yieldMaskRender(renderId)) return;
  }
  for (let startY = 0; startY < height; startY += MASK_ROWS_PER_CHUNK) {
    const endY = Math.min(height, startY + MASK_ROWS_PER_CHUNK);
    for (let y = startY; y < endY; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!edges[y * width + x]) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const offset = (yy * width + xx) * 4;
            imageData.data[offset] = 255;
            imageData.data[offset + 1] = 0;
            imageData.data[offset + 2] = 0;
            imageData.data[offset + 3] = 255;
          }
        }
      }
    }
    if (endY < height && !await yieldMaskRender(renderId)) return;
  }

  if (renderId !== state.renderSequence) return;
  maskScratchContext.putImageData(imageData, 0, 0);
  if (renderId === state.renderSequence) ctx.drawImage(maskScratch, Math.round(left), Math.round(top));
}

function drawAnnotationPreview() {
  annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  if (!state.annotationMode || !state.annotationPoints.length) return;
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  if (!transform) return;
  if (state.annotationAction === 'sam') {
    drawSamPreview(transform);
    return;
  }
  const points = state.annotationPoints.map((point) => ({
    x: transform.left + point.x * transform.displayWidth / transform.sourceWidth,
    y: transform.top + point.y * transform.displayHeight / transform.sourceHeight,
  }));
  const cursor = state.annotationCursor ? {
    x: transform.left + state.annotationCursor.x * transform.displayWidth / transform.sourceWidth,
    y: transform.top + state.annotationCursor.y * transform.displayHeight / transform.sourceHeight,
  } : null;
  const color = state.annotationAction === 'erase' ? '#ff5c35' : currentLabel().color;
  annotationCtx.save();
  annotationCtx.beginPath();
  annotationCtx.rect(transform.clip.x, transform.clip.y, transform.clip.width, transform.clip.height);
  annotationCtx.clip();
  annotationCtx.strokeStyle = color;
  annotationCtx.fillStyle = '#ffffff';
  annotationCtx.lineWidth = 2;
  if (points.length >= 2) {
    annotationCtx.beginPath();
    annotationCtx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) annotationCtx.lineTo(point.x, point.y);
    annotationCtx.stroke();
  }
  if (cursor) {
    const lastPoint = points[points.length - 1];
    annotationCtx.beginPath();
    annotationCtx.moveTo(lastPoint.x, lastPoint.y);
    annotationCtx.lineTo(cursor.x, cursor.y);
    annotationCtx.strokeStyle = 'rgba(0, 0, 0, 0.88)';
    annotationCtx.lineWidth = 4;
    annotationCtx.setLineDash([7, 5]);
    annotationCtx.stroke();
    annotationCtx.beginPath();
    annotationCtx.moveTo(lastPoint.x, lastPoint.y);
    annotationCtx.lineTo(cursor.x, cursor.y);
    annotationCtx.strokeStyle = '#ffffff';
    annotationCtx.lineWidth = 2;
    annotationCtx.setLineDash([7, 5]);
    annotationCtx.stroke();
    annotationCtx.setLineDash([]);
  }
  for (const point of points) {
    annotationCtx.beginPath();
    annotationCtx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    annotationCtx.fill();
    annotationCtx.strokeStyle = color;
    annotationCtx.lineWidth = 2;
    annotationCtx.stroke();
  }
  annotationCtx.restore();
}

function drawSamPreview(transform) {
  if (state.samMask) {
    samScratch.width = transform.sourceWidth;
    samScratch.height = transform.sourceHeight;
    const pixels = samScratchContext.createImageData(transform.sourceWidth, transform.sourceHeight);
    const label = currentLabel();
    const red = parseInt(label.color.slice(1, 3), 16);
    const green = parseInt(label.color.slice(3, 5), 16);
    const blue = parseInt(label.color.slice(5, 7), 16);
    for (let pixel = 0; pixel < state.samMask.length; pixel += 1) {
      if (!state.samMask[pixel]) continue;
      const offset = pixel * 4;
      pixels.data[offset] = red;
      pixels.data[offset + 1] = green;
      pixels.data[offset + 2] = blue;
      pixels.data[offset + 3] = 118;
    }
    samScratchContext.putImageData(pixels, 0, 0);
    annotationCtx.save();
    annotationCtx.beginPath();
    annotationCtx.rect(transform.clip.x, transform.clip.y, transform.clip.width, transform.clip.height);
    annotationCtx.clip();
    annotationCtx.imageSmoothingEnabled = false;
    annotationCtx.drawImage(samScratch, transform.left, transform.top, transform.displayWidth, transform.displayHeight);
    annotationCtx.restore();
  }
  annotationCtx.save();
  annotationCtx.beginPath();
  annotationCtx.rect(transform.clip.x, transform.clip.y, transform.clip.width, transform.clip.height);
  annotationCtx.clip();
  for (const point of state.annotationPoints) {
    const x = transform.left + point.x * transform.displayWidth / transform.sourceWidth;
    const y = transform.top + point.y * transform.displayHeight / transform.sourceHeight;
    annotationCtx.beginPath();
    annotationCtx.arc(x, y, 6, 0, Math.PI * 2);
    annotationCtx.fillStyle = point.positive === false ? '#ff4f67' : '#39e58c';
    annotationCtx.fill();
    annotationCtx.strokeStyle = '#ffffff';
    annotationCtx.lineWidth = 2;
    annotationCtx.stroke();
    annotationCtx.fillStyle = '#07111f';
    annotationCtx.font = 'bold 12px sans-serif';
    annotationCtx.textAlign = 'center';
    annotationCtx.textBaseline = 'middle';
    annotationCtx.fillText(point.positive === false ? '−' : '+', x, y);
  }
  annotationCtx.restore();
}

function updateStatus() {
  const pair = currentPair();
  if (!pair) {
    setStatus('目录不存在或没有同名配对图片，请重新选择 A 和 B 目录。');
    return;
  }
  const label = currentLabel();
  const view = state.viewMode === 'compare' ? '左右对比 A｜B' : (state.mode === 'after' ? 'B' : 'A');
  const mask = state.showMask ? (pair.maskPath ? `MASK ON: ${pair.maskPath.split(/[\\/]/).pop()}` : 'NO MASK') : 'MASK OFF';
  let annotation = '';
  if (state.annotationMode) {
    if (state.annotationAction === 'sam') {
      const score = state.samMask ? `，置信度 ${Math.round(state.samScore * 100)}%` : '';
      annotation = ` | AI 圈选：左键目标点，Shift+左键/右键排除点，Enter确认${score}`;
    } else if (state.annotationAction === 'replace') {
      annotation = ` | 替换颜色：点击已有标注区域，替换为 ${label.name} ${label.color}，成功后自动退出`;
    } else if (state.annotationAction === 'erase') {
      annotation = state.eraseStyle === 'polygon'
        ? ` | 区域删除：左键连续加点，短按右键/Enter删除区域`
        : ` | 单删标注：左键删除一个连通标注，再按 E 切换区域删除`;
    } else annotation = ` | ${label.name}：左键加点，短按右键/Enter保存`;
    annotation += state.annotationAction === 'replace'
      ? '，按 W/Esc 取消'
      : `，Backspace撤回，Esc取消，点数 ${state.annotationPoints.length}`;
  }
  setStatus(`${state.index + 1}/${state.pairs.length} | ${view} | ${pair.name} | ${mask} | 标签 ${String(state.activeLabelId).padStart(3, '0')}：${label.name} ${label.color}${annotation}`);
}

async function render() {
  resizeCanvas();
  const renderId = ++state.renderSequence;
  const renderIndex = state.index;
  const fastRender = state.fastRender;
  state.lastRenderError = '';
  ctx.fillStyle = '#111315';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  state.transforms = [];
  const pair = currentPair();
  emptyState.hidden = Boolean(pair);
  if (!pair) {
    updateButtons();
    updateStatus();
    return;
  }
  try {
    const maskPromise = state.showMask && pair.maskUrl
      ? (fastRender ? loadImagePreview(pair.maskUrl) : loadImage(pair.maskUrl))
      : null;
    if (state.viewMode === 'compare') {
      const [before, after] = await Promise.all([loadImage(pair.beforeUrl), loadImage(pair.afterUrl)]);
      const [beforeDrawable, afterDrawable] = fastRender
        ? await Promise.all([loadImagePreview(pair.beforeUrl), loadImagePreview(pair.afterUrl)])
        : [before, after];
      if (renderId !== state.renderSequence) return;
      const half = canvas.width / 2;
      const leftClip = { x: 0, y: 0, width: half, height: canvas.height };
      const rightClip = { x: half, y: 0, width: canvas.width - half, height: canvas.height };
      const commonFit = Math.min(
        leftClip.width / before.naturalWidth,
        leftClip.height / before.naturalHeight,
        rightClip.width / after.naturalWidth,
        rightClip.height / after.naturalHeight,
      );
      state.transforms = [createTransform(before, leftClip, commonFit), createTransform(after, rightClip, commonFit)];
      drawImageInTransform(beforeDrawable, state.transforms[0]);
      drawImageInTransform(afterDrawable, state.transforms[1]);
      if (maskPromise) {
        const mask = await maskPromise;
        await drawMaskOverlay(mask, state.transforms[0], renderId);
        await drawMaskOverlay(mask, state.transforms[1], renderId);
      }
      ctx.strokeStyle = '#3c4043';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(half, 0); ctx.lineTo(half, canvas.height); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 16px "Microsoft YaHei UI"';
      ctx.fillText('A', 14, 25); ctx.fillText('B', half + 14, 25);
    } else {
      const imageUrl = state.mode === 'after' ? pair.afterUrl : pair.beforeUrl;
      const image = await loadImage(imageUrl);
      const drawable = fastRender ? await loadImagePreview(imageUrl) : image;
      if (renderId !== state.renderSequence) return;
      const clip = { x: 0, y: 0, width: canvas.width, height: canvas.height };
      state.transforms = [createTransform(image, clip)];
      drawImageInTransform(drawable, state.transforms[0]);
      if (maskPromise) await drawMaskOverlay(await maskPromise, state.transforms[0], renderId);
    }
    if (renderId !== state.renderSequence) return;
    drawAnnotationPreview();
    state.lastRenderedIndex = renderIndex;
    if (!state.fastRender) scheduleNearbyPrefetch();
  } catch (error) {
    state.lastRenderError = error?.message || String(error);
    setStatus(`图像显示失败：${state.lastRenderError}`);
  }
  updateButtons();
  if (!state.lastRenderError) updateStatus();
}

function scheduleRender(fast = false) {
  clearTimeout(navigationRenderTimer);
  navigationRenderTimer = null;
  state.fastRender = fast;
  cancelAnimationFrame(renderFrame);
  clearTimeout(renderSettleTimer);
  renderSettleTimer = null;
  renderFrame = requestAnimationFrame(() => render());
  if (fast) {
    renderSettleTimer = setTimeout(() => {
      renderSettleTimer = null;
      state.fastRender = false;
      render();
    }, 90);
  }
}

function scheduleNavigationRender() {
  clearTimeout(navigationRenderTimer);
  navigationRenderTimer = setTimeout(() => {
    navigationRenderTimer = null;
    scheduleRender(true);
  }, NAVIGATION_RENDER_INTERVAL_MS);
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.drag = null;
  scheduleRender();
}

function clearAnnotationDraft() {
  state.annotationPoints = [];
  state.annotationCursor = null;
  state.annotationTransformIndex = null;
  drawAnnotationPreview();
}

function resetAnnotation() {
  const cancelledSam = state.annotationMode && state.annotationAction === 'sam';
  state.samRequestId += 1;
  state.annotationMode = false;
  state.annotationAction = 'add';
  state.eraseStyle = 'single';
  clearAnnotationDraft();
  state.samMask = null;
  state.samScore = 0;
  if (cancelledSam && state.busy) setBusy(false);
}

async function loadWorkspace() {
  if (state.busy) return;
  readPathInputs();
  await api.saveSettings(state.settings);
  if (!state.settings.beforeDir || !state.settings.afterDir) {
    showToast('请先选择 A 和 B 文件夹');
    return;
  }
  setBusy(true, '正在读取配对图片…');
  try {
    state.pairs = await api.loadPairs(state.settings);
    state.index = 0;
    imageCache.clear();
    resetAnnotation();
    state.zoom = 1; state.panX = 0; state.panY = 0;
    showToast(`已载入 ${state.pairs.length} 组同名图片`);
    if (state.pairs.length) setPathPanelExpanded(false);
  } catch (error) {
    state.pairs = [];
    showToast(`载入失败：${error.message}`, 4200);
  } finally {
    setBusy(false);
    await render();
  }
}

async function chooseDirectory(kind) {
  const input = elements[`${kind}Path`];
  const names = { before: '选择 A 图片目录', after: '选择 B 图片目录', mask: '选择 Mask 图片目录' };
  const selected = await api.chooseDirectory({ title: names[kind], defaultPath: input.value.trim() });
  if (selected) {
    input.value = selected;
    updatePathPresentation(input);
  }
}

function navigate(delta) {
  if (!state.pairs.length || state.busy) return;
  state.index = (state.index + delta + state.pairs.length) % state.pairs.length;
  resetAnnotation();
  state.zoom = 1; state.panX = 0; state.panY = 0;
  updateStatus();
  scheduleNavigationRender();
}

function togglePhase() {
  if (!state.pairs.length) return;
  state.mode = state.mode === 'after' ? 'before' : 'after';
  scheduleRender();
  if (state.annotationMode && state.annotationAction === 'sam' && state.annotationPoints.length) {
    state.samMask = null;
    updateSamPrediction();
  }
}

function restartBlinkTimer() {
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  if (state.blinking) state.blinkTimer = setInterval(togglePhase, state.blinkIntervalMs);
}

function toggleBlink() {
  state.blinking = !state.blinking;
  if (state.blinking) {
    if (state.viewMode === 'compare') state.viewMode = 'single';
  }
  restartBlinkTimer();
  updateButtons();
  scheduleRender();
}

function toggleCompare() {
  if (!state.pairs.length || state.busy) return;
  state.viewMode = state.viewMode === 'single' ? 'compare' : 'single';
  if (state.viewMode === 'compare' && state.blinking) toggleBlink();
  resetAnnotation();
  scheduleRender();
}

function toggleAnnotation(action, requestedEraseStyle = null) {
  if (!state.pairs.length || state.busy) return;
  if (['erase', 'replace'].includes(action) && !currentPair().maskPath) {
    showToast(`当前图片没有 Mask，无法${action === 'replace' ? '替换颜色' : '删除标注区域'}`);
    return;
  }
  if (state.annotationMode && state.annotationAction === action) {
    if (action === 'erase' && state.eraseStyle === 'single' && requestedEraseStyle !== 'single') {
      state.eraseStyle = 'polygon';
      state.annotationPoints = [];
      state.annotationCursor = null;
      state.annotationTransformIndex = null;
      showToast('已切换为区域删除：左键连续打点，短按右键完成');
    } else resetAnnotation();
  } else {
    state.annotationMode = true;
    state.annotationAction = action;
    state.eraseStyle = action === 'erase' ? (requestedEraseStyle || 'single') : 'single';
    state.annotationPoints = [];
    state.annotationCursor = null;
    state.annotationTransformIndex = null;
    if (action === 'replace') showToast(`替换颜色：点击已有标注区域，替换为 ${currentLabel().name}`);
    if (action === 'erase' && state.eraseStyle === 'polygon') {
      showToast('区域删除：左键连续打点，短按右键完成');
    }
  }
  updateButtons();
  scheduleRender();
}

function samImagePath() {
  const pair = currentPair();
  if (!pair) return null;
  if (state.viewMode === 'compare') return state.annotationTransformIndex === 0 ? pair.beforePath : pair.afterPath;
  return state.mode === 'after' ? pair.afterPath : pair.beforePath;
}

function toggleSamAnnotation() {
  if (!state.pairs.length || state.busy) return;
  if (state.annotationMode && state.annotationAction === 'sam') {
    resetAnnotation();
  } else {
    if (state.blinking) toggleBlink();
    resetAnnotation();
    state.annotationMode = true;
    state.annotationAction = 'sam';
    showToast('AI 圈选：左键点目标，Shift+左键或右键点不要的区域');
  }
  updateButtons();
  scheduleRender();
}

async function updateSamPrediction() {
  if (!state.annotationMode || state.annotationAction !== 'sam' || !state.annotationPoints.length) return;
  const imagePath = samImagePath();
  if (!imagePath) return;
  const requestId = ++state.samRequestId;
  setBusy(true, 'SAM 正在识别点击区域…');
  try {
    await api.prepareSamImage({ imagePath });
    const result = await api.predictSamMask({ imagePath, points: state.annotationPoints });
    if (requestId !== state.samRequestId) return;
    state.samMask = result.mask;
    state.samScore = result.score;
    drawAnnotationPreview();
    updateStatus();
  } catch (error) {
    if (requestId === state.samRequestId) {
      state.samMask = null;
      showToast(`SAM 圈选失败：${error.message}；仍可使用 Q 多边形标注`, 5200);
    }
  } finally {
    if (requestId === state.samRequestId) setBusy(false);
  }
}

async function confirmSamMask() {
  if (!state.samMask || state.busy) {
    showToast('请先点击目标并等待 SAM 生成候选区域');
    return;
  }
  const pair = currentPair();
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  if (!pair || !transform) return;
  if (!pair.maskPath && !state.settings.maskDir) {
    showToast('请先选择 Mask 保存目录');
    return;
  }
  setBusy(true, '正在写入 SAM 圈选区域…');
  try {
    const result = await api.mergeBinaryMask({
      pairName: pair.name,
      maskPath: pair.maskPath,
      maskDir: state.settings.maskDir,
      sourceSize: { width: transform.sourceWidth, height: transform.sourceHeight },
      mask: state.samMask,
      maskSize: { width: transform.sourceWidth, height: transform.sourceHeight },
      color: currentLabel().color,
    });
    const previousMaskUrl = pair.maskUrl;
    pair.maskPath = result.maskPath;
    pair.maskUrl = result.maskUrl;
    imageCache.delete(previousMaskUrl);
    state.showMask = true;
    resetAnnotation();
    showToast(`SAM 已写入 ${result.changedPixels.toLocaleString()} 个 ${currentLabel().name} 像素`);
  } catch (error) {
    showToast(`SAM Mask 保存失败：${error.message}`, 4800);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
  };
}

function toImagePoint(point, clampToEdge = false) {
  const transformLocked = state.annotationTransformIndex != null && state.annotationPoints.length > 0;
  const candidates = !transformLocked
    ? state.transforms.map((transform, index) => [transform, index])
    : [[state.transforms[state.annotationTransformIndex], state.annotationTransformIndex]];
  for (const [transform, index] of candidates) {
    const imagePoint = canvasPointToImage(transform, point, clampToEdge);
    if (!imagePoint) continue;
    state.annotationTransformIndex = index;
    return imagePoint;
  }
  return null;
}

function toLockedImagePoint(point, clampToEdge = false) {
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  return canvasPointToImage(transform, point, clampToEdge);
}

async function eraseConnectedAt(point) {
  const pair = currentPair();
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  if (!pair?.maskPath || !transform) return;
  setBusy(true, '正在删除同色连通区域…');
  try {
    const result = await api.eraseConnected({
      maskPath: pair.maskPath,
      sourceSize: { width: transform.sourceWidth, height: transform.sourceHeight },
      point,
    });
    if (result.deletedPixels) {
      const previousMaskUrl = pair.maskUrl;
      pair.maskUrl = result.maskUrl;
      imageCache.delete(previousMaskUrl);
      state.showMask = true;
      resetAnnotation();
      showToast(`已删除 ${result.deletedPixels.toLocaleString()} 个 Mask 像素`);
    } else {
      state.annotationTransformIndex = null;
      showToast('点击位置是黑色背景，没有可删除标注');
    }
  } catch (error) {
    showToast(`删除标注失败：${error.message}`, 4200);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

async function replaceConnectedColorAt(point) {
  const pair = currentPair();
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  if (!pair?.maskPath || !transform) return;
  const label = currentLabel();
  setBusy(true, `正在替换为 ${label.name}…`);
  try {
    const result = await api.replaceConnectedColor({
      maskPath: pair.maskPath,
      sourceSize: { width: transform.sourceWidth, height: transform.sourceHeight },
      point,
      color: label.color,
    });
    if (result.replacedPixels || result.alreadySelected) {
      const previousMaskUrl = pair.maskUrl;
      pair.maskUrl = result.maskUrl;
      imageCache.delete(previousMaskUrl);
      state.showMask = true;
      resetAnnotation();
      showToast(result.alreadySelected
        ? `该区域已经是 ${label.name} ${label.color}`
        : `已将 ${result.replacedPixels.toLocaleString()} 个 Mask 像素替换为 ${label.name}`);
    } else {
      state.annotationTransformIndex = null;
      showToast('点击位置是黑色背景，请点击已有标注区域');
    }
  } catch (error) {
    showToast(`替换颜色失败：${error.message}`, 4200);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

async function finishPolygon() {
  if (state.annotationAction === 'erase' && state.eraseStyle !== 'polygon') {
    showToast('单删模式请用左键点击一个标注；再按 E 可切换区域删除');
    return;
  }
  if (!state.annotationMode || state.annotationPoints.length < 3 || state.busy) {
    if (state.annotationMode) showToast('多边形至少需要 3 个点');
    return;
  }
  const pair = currentPair();
  const transform = state.transforms[state.annotationTransformIndex ?? 0];
  if (!pair || !transform) return;
  if (!pair.maskPath && !state.settings.maskDir) {
    showToast('请先选择 Mask 保存目录');
    return;
  }
  const points = [...state.annotationPoints];
  const erase = state.annotationAction === 'erase';
  setBusy(true, erase ? '正在删除多边形标注…' : '正在保存彩色标注…');
  try {
    const result = await api.paintPolygon({
      pairName: pair.name,
      maskPath: pair.maskPath,
      maskDir: state.settings.maskDir,
      sourceSize: { width: transform.sourceWidth, height: transform.sourceHeight },
      points,
      color: currentLabel().color,
      erase,
    });
    const previousMaskUrl = pair.maskUrl;
    pair.maskPath = result.maskPath;
    pair.maskUrl = result.maskUrl;
    imageCache.delete(previousMaskUrl);
    state.showMask = true;
    if (erase) resetAnnotation();
    else clearAnnotationDraft();
    showToast(erase ? '多边形标注已删除' : `已写入 ${currentLabel().name} ${currentLabel().color}`);
  } catch (error) {
    showToast(`Mask 保存失败：${error.message}`, 4500);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

async function deleteCurrentPair() {
  const pair = currentPair();
  if (!pair || state.busy) return;
  setBusy(true, '正在移动当前图片组…');
  try {
    await api.deletePair({ pair, ...state.settings });
    state.lastDeletedIndex = state.index;
    state.pairs.splice(state.index, 1);
    state.index = Math.min(state.index, Math.max(0, state.pairs.length - 1));
    imageCache.clear();
    resetAnnotation();
    showToast(`已移动到 deleted_pairs：${pair.name}`);
  } catch (error) {
    showToast(`删除移动失败：${error.message}`, 4500);
  } finally {
    setBusy(false);
    resetView();
  }
}

async function undoDelete() {
  if (state.busy) return;
  setBusy(true, '正在撤销删除…');
  try {
    const pair = await api.undoDelete();
    if (!pair) showToast('没有可撤销的删除');
    else {
      const insertAt = Math.min(state.lastDeletedIndex ?? state.pairs.length, state.pairs.length);
      state.pairs.splice(insertAt, 0, pair);
      state.index = insertAt;
      state.lastDeletedIndex = null;
      showToast(`已恢复：${pair.name}`);
    }
  } catch (error) {
    showToast(`撤销删除失败：${error.message}`, 4500);
  } finally {
    setBusy(false);
    resetView();
  }
}

async function permanentDeleteCurrent() {
  const pair = currentPair();
  if (!pair || state.busy) return;
  const files = [pair.beforePath, pair.afterPath, pair.maskPath].filter(Boolean).join('\n');
  if (!window.confirm(`将永久删除这组文件，无法撤销：\n\n${pair.name}\n\n${files}\n\n确定继续吗？`)) return;
  setBusy(true, '正在彻底删除…');
  try {
    await api.permanentDelete(pair);
    state.pairs.splice(state.index, 1);
    state.index = Math.min(state.index, Math.max(0, state.pairs.length - 1));
    imageCache.clear();
    resetAnnotation();
    showToast(`已彻底删除：${pair.name}`);
  } catch (error) {
    showToast(`彻底删除失败：${error.message}`, 4500);
  } finally {
    setBusy(false);
    resetView();
  }
}

async function swapCurrentPairFiles() {
  const pair = currentPair();
  if (!pair || state.busy) return;
  if (state.annotationMode && state.annotationPoints.length) {
    showToast('请先保存或取消当前多边形，再互换 A、B 原始文件');
    return;
  }
  setBusy(true, '正在互换 A、B 原始文件…');
  try {
    const updated = await api.swapPairFiles(pair);
    imageCache.clear();
    Object.assign(pair, updated);
    resetAnnotation();
    showToast(`A、B 原始文件已互换：${pair.name}`);
  } catch (error) {
    showToast(`互换失败：${error.message}`, 5200);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

function sortedLabelIds() {
  return Array.from({ length: 256 }, (_, index) => index).sort((left, right) => {
    const pinDiff = Number(Boolean(state.labels[right]?.pinned)) - Number(Boolean(state.labels[left]?.pinned));
    return pinDiff || left - right;
  });
}

function selectLabelEditor(labelId, scroll = false) {
  const id = Math.max(0, Math.min(255, Number(labelId) || 0));
  state.selectedLabelId = id;
  const label = state.labels[id];
  elements.labelId.value = id;
  elements.labelName.value = label.name;
  elements.labelColor.value = label.color;
  state.capturedShortcut = label.shortcut || '';
  elements.labelShortcut.value = state.capturedShortcut;
  elements.pinLabel.textContent = label.pinned ? '取消置顶' : '置顶标签';
  for (const row of labelList.children) row.classList.toggle('selected', Number(row.dataset.id) === id);
  if (scroll) labelList.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
}

function renderLabelList() {
  labelList.replaceChildren();
  for (const id of sortedLabelIds()) {
    const label = state.labels[id];
    const row = document.createElement('div');
    row.className = 'label-row';
    row.dataset.id = id;
    row.style.background = label.color;
    row.style.color = contrastingColor(label.color);
    row.innerHTML = `<span>${id === state.activeLabelId ? '▶' : ''}${label.pinned ? '★' : ''}</span>`
      + `<strong>${String(id).padStart(3, '0')}</strong><span></span><span></span><span class="shortcut"></span>`;
    row.children[2].textContent = label.name;
    row.children[3].textContent = label.color;
    row.children[4].textContent = label.shortcut ? `[${label.shortcut}]` : '';
    row.addEventListener('click', () => selectLabelEditor(id));
    row.addEventListener('dblclick', () => saveLabel(true));
    labelList.appendChild(row);
  }
  selectLabelEditor(state.selectedLabelId, true);
}

function toggleLabelPanel(force) {
  const shouldShow = force ?? labelPanel.hidden;
  labelPanel.hidden = !shouldShow;
  if (shouldShow) {
    state.selectedLabelId = state.activeLabelId;
    renderLabelList();
    labelPanel.focus?.();
  } else {
    state.capturingShortcut = false;
    elements.captureShortcut.classList.remove('capturing');
    elements.captureShortcut.textContent = '录入快捷键';
    canvas.focus();
  }
  updateButtons();
}

async function persistLabels() {
  const saved = await api.saveLabels({ activeLabelId: state.activeLabelId, labels: state.labels });
  state.labels = saved.labels;
}

async function setActiveLabel(labelId, announce = true) {
  state.activeLabelId = Number(labelId);
  state.selectedLabelId = state.activeLabelId;
  await persistLabels();
  updateButtons();
  updateStatus();
  if (!labelPanel.hidden) renderLabelList();
  if (announce) showToast(`当前标签：${String(state.activeLabelId).padStart(3, '0')} ${currentLabel().name} ${currentLabel().color}`);
  scheduleRender();
}

async function saveLabel(useLabel) {
  const id = state.selectedLabelId;
  const name = elements.labelName.value.trim().slice(0, 64) || `标签 ${id}`;
  const color = elements.labelColor.value.toUpperCase();
  const shortcut = normalizeShortcut(state.capturedShortcut);
  if (color === '#000000') {
    showToast('黑色用于未标注背景，请选择其他颜色');
    return;
  }
  for (const [otherId, other] of Object.entries(state.labels)) {
    if (Number(otherId) !== id && other.color.toUpperCase() === color) {
      showToast(`该颜色已被标签 ${String(otherId).padStart(3, '0')}“${other.name}”使用`);
      return;
    }
    if (shortcut && Number(otherId) !== id && normalizeShortcut(other.shortcut) === shortcut) {
      showToast(`快捷键 ${shortcut} 已被标签 ${String(otherId).padStart(3, '0')} 使用`);
      return;
    }
  }
  if (shortcut && reservedShortcuts.has(shortcut)) {
    showToast(`${shortcut} 是软件功能快捷键，不能分配给标签`);
    return;
  }
  state.labels[id] = { ...state.labels[id], name, color, shortcut };
  if (useLabel) state.activeLabelId = id;
  await persistLabels();
  renderLabelList();
  updateButtons();
  scheduleRender();
  showToast(`已保存标签 ${String(id).padStart(3, '0')}${useLabel ? ' 并设为当前' : ''}`);
}

async function togglePin() {
  const label = state.labels[state.selectedLabelId];
  label.pinned = !label.pinned;
  await persistLabels();
  renderLabelList();
  showToast(label.pinned ? '标签已置顶' : '已取消置顶');
}

function beginShortcutCapture() {
  state.capturingShortcut = true;
  elements.captureShortcut.classList.add('capturing');
  elements.captureShortcut.textContent = '请按快捷键…';
  elements.labelShortcut.value = '';
  window.focus();
}

async function handleAction(action) {
  const handlers = {
    mask: () => { state.showMask = !state.showMask; scheduleRender(); },
    labels: () => toggleLabelPanel(),
    annotate: () => toggleAnnotation('add'),
    erase: () => toggleAnnotation('erase'),
    'replace-color': () => toggleAnnotation('replace'),
    'sam': () => toggleSamAnnotation(),
    prev: () => navigate(-1),
    next: () => navigate(1),
    phase: togglePhase,
    blink: toggleBlink,
    compare: toggleCompare,
    delete: deleteCurrentPair,
    'permanent-delete': permanentDeleteCurrent,
    undo: undoDelete,
    reset: resetView,
    swap: swapCurrentPairFiles,
  };
  await handlers[action]?.();
}

canvas.addEventListener('pointerdown', async (event) => {
  if (state.busy) return;
  canvas.focus();
  const point = canvasPoint(event);
  if (event.button === 1) {
    event.preventDefault();
    state.drag = { pointerId: event.pointerId, x: point.x, y: point.y, panX: state.panX, panY: state.panY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
    return;
  }
  if (event.button !== 0 || !state.annotationMode) return;
  if (state.annotationAction === 'sam') {
    const imagePoint = toImagePoint(point, false);
    if (!imagePoint) { showToast('点击位置在图像外'); return; }
    state.annotationPoints.push({ ...imagePoint, positive: !event.shiftKey });
    state.samMask = null;
    drawAnnotationPreview();
    updateStatus();
    await updateSamPrediction();
    return;
  }
  if (state.annotationAction === 'erase' && event.shiftKey && !state.annotationPoints.length) {
    state.eraseStyle = 'polygon';
    updateButtons();
  }
  const polygonMode = state.annotationAction === 'add'
    || (state.annotationAction === 'erase' && state.eraseStyle === 'polygon');
  const imagePoint = toImagePoint(point, polygonMode);
  if (!imagePoint) {
    showToast('点击位置在图像外');
    return;
  }
  if (state.annotationAction === 'erase' && state.eraseStyle === 'single' && !state.annotationPoints.length) {
    await eraseConnectedAt(imagePoint);
    return;
  }
  if (state.annotationAction === 'replace') {
    await replaceConnectedColorAt(imagePoint);
    return;
  }
  state.annotationPoints.push(imagePoint);
  state.annotationCursor = imagePoint;
  drawAnnotationPreview();
  updateStatus();
});

canvas.addEventListener('pointermove', (event) => {
  if (state.drag) {
    if (event.pointerId !== state.drag.pointerId) return;
    const point = canvasPoint(event);
    state.panX = state.drag.panX + point.x - state.drag.x;
    state.panY = state.drag.panY + point.y - state.drag.y;
    scheduleRender(true);
    return;
  }
  if (state.annotationMode) {
    const polygonMode = state.annotationAction === 'add'
      || (state.annotationAction === 'erase' && state.eraseStyle === 'polygon');
    const nextCursor = state.annotationPoints.length && polygonMode
      ? toLockedImagePoint(canvasPoint(event), true)
      : null;
    state.annotationCursor = nextCursor;
    drawAnnotationPreview();
    return;
  }
});

canvas.addEventListener('pointerleave', () => {
  if (!state.annotationMode || !state.annotationCursor) return;
  state.annotationCursor = null;
  drawAnnotationPreview();
});

canvas.addEventListener('pointerup', (event) => {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  canvas.releasePointerCapture?.(event.pointerId);
  state.drag = null;
  canvas.classList.remove('dragging');
  state.fastRender = false;
  scheduleRender();
});

canvas.addEventListener('pointercancel', (event) => {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  canvas.releasePointerCapture?.(event.pointerId);
  state.drag = null;
  canvas.classList.remove('dragging');
  state.fastRender = false;
  scheduleRender();
});

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (state.annotationMode && state.annotationAction === 'sam') {
    const imagePoint = toImagePoint(canvasPoint(event), false);
    if (!imagePoint) { showToast('点击位置在图像外'); return; }
    state.annotationPoints.push({ ...imagePoint, positive: false });
    state.samMask = null;
    drawAnnotationPreview();
    updateStatus();
    updateSamPrediction();
  } else if (state.annotationMode && state.annotationAction !== 'replace') finishPolygon();
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  state.zoom = Math.max(0.05, Math.min(20, state.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
  scheduleRender(true);
}, { passive: false });

window.addEventListener('keydown', async (event) => {
  if (state.capturingShortcut) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      state.capturingShortcut = false;
      state.capturedShortcut = state.labels[state.selectedLabelId].shortcut || '';
      elements.labelShortcut.value = state.capturedShortcut;
      elements.captureShortcut.classList.remove('capturing');
      elements.captureShortcut.textContent = '录入快捷键';
      return;
    }
    const captured = eventToShortcut(event);
    if (!captured) return;
    if (reservedShortcuts.has(captured)) {
      showToast(`${captured} 是软件功能快捷键，请换一个组合`);
      return;
    }
    state.capturedShortcut = captured;
    elements.labelShortcut.value = captured;
    state.capturingShortcut = false;
    elements.captureShortcut.classList.remove('capturing');
    elements.captureShortcut.textContent = '录入快捷键';
    showToast(`已录入 ${captured}，点击保存后生效`);
    return;
  }

  const shortcut = eventToShortcut(event);
  if (!labelPanel.hidden && shortcut === 'C') {
    event.preventDefault();
    toggleLabelPanel(false);
    return;
  }
  const editable = event.target instanceof HTMLInputElement
    || event.target instanceof HTMLTextAreaElement
    || event.target instanceof HTMLSelectElement;
  if (editable) return;

  const matchedLabel = Object.entries(state.labels).find(([, label]) => label.shortcut && normalizeShortcut(label.shortcut) === shortcut);
  if (matchedLabel) {
    event.preventDefault();
    await setActiveLabel(Number(matchedLabel[0]));
    return;
  }

  const key = event.key;
  if (key === 'ArrowRight' || shortcut === 'D') { event.preventDefault(); navigate(1); return; }
  if (key === 'ArrowLeft' || shortcut === 'A') { event.preventDefault(); navigate(-1); return; }

  if (state.annotationMode) {
    if (key === ' ' || key === 'Tab') { event.preventDefault(); togglePhase(); return; }
    if (key === 'Enter' && state.annotationAction === 'sam') { event.preventDefault(); await confirmSamMask(); return; }
    if (key === 'Enter' && state.annotationAction !== 'replace') { event.preventDefault(); await finishPolygon(); return; }
    if (key === 'Backspace') {
      event.preventDefault();
      state.annotationPoints.pop();
      if (state.annotationAction === 'sam') {
        state.samMask = null;
        if (state.annotationPoints.length) await updateSamPrediction();
      }
      if (!state.annotationPoints.length) state.annotationCursor = null;
      drawAnnotationPreview();
      updateStatus();
      return;
    }
    if (key === 'Escape') { event.preventDefault(); resetAnnotation(); scheduleRender(); return; }
    if (shortcut === 'Q') { event.preventDefault(); toggleAnnotation('add'); return; }
    if (shortcut === 'Shift+E') { event.preventDefault(); toggleAnnotation('erase', 'polygon'); return; }
    if (shortcut === 'E') { event.preventDefault(); toggleAnnotation('erase'); return; }
    if (shortcut === 'W') { event.preventDefault(); toggleAnnotation('replace'); return; }
    if (shortcut === 'F') { event.preventDefault(); toggleSamAnnotation(); return; }
    if (shortcut === 'X') { event.preventDefault(); await swapCurrentPairFiles(); return; }
    if (shortcut === 'S') { event.preventDefault(); state.showMask = !state.showMask; scheduleRender(); return; }
    if (shortcut === 'C') { event.preventDefault(); toggleLabelPanel(); return; }
    return;
  }

  if (key === ' ' || key === 'Tab') { event.preventDefault(); togglePhase(); }
  else if (shortcut === 'B') toggleBlink();
  else if (shortcut === 'V') toggleCompare();
  else if (shortcut === 'X') await swapCurrentPairFiles();
  else if (shortcut === 'S') { state.showMask = !state.showMask; scheduleRender(); }
  else if (shortcut === 'C') toggleLabelPanel();
  else if (shortcut === 'Q') toggleAnnotation('add');
  else if (shortcut === 'Shift+E') toggleAnnotation('erase', 'polygon');
  else if (shortcut === 'E') toggleAnnotation('erase');
  else if (shortcut === 'W') toggleAnnotation('replace');
  else if (shortcut === 'F') toggleSamAnnotation();
  else if (key === 'Delete' && event.shiftKey) await permanentDeleteCurrent();
  else if (key === 'Delete') await deleteCurrentPair();
  else if (shortcut === 'U' || (event.ctrlKey && key.toLowerCase() === 'z')) await undoDelete();
  else if (key === '+' || key === '=') { state.zoom = Math.min(20, state.zoom * 1.2); scheduleRender(true); }
  else if (key === '-') { state.zoom = Math.max(0.05, state.zoom / 1.2); scheduleRender(true); }
  else if (shortcut === 'R' || shortcut === '0') resetView();
});

for (const button of Object.values(buttons)) button.addEventListener('click', () => handleAction(button.dataset.action));
elements.maskOpacity.addEventListener('input', () => {
  state.maskOpacity = Number(elements.maskOpacity.value);
  elements.maskOpacityValue.value = `${state.maskOpacity}%`;
  scheduleRender();
});
elements.maskOpacity.addEventListener('change', () => {
  state.settings.maskOpacity = state.maskOpacity;
  api.saveSettings(state.settings).catch((error) => showToast(`透明度保存失败：${error.message}`));
});
elements.blinkSpeed.addEventListener('change', () => {
  state.blinkIntervalMs = Number(elements.blinkSpeed.value);
  state.settings.blinkIntervalMs = state.blinkIntervalMs;
  restartBlinkTimer();
  const speedName = elements.blinkSpeed.selectedOptions[0]?.textContent || `${state.blinkIntervalMs}ms`;
  showToast(`闪烁速度：${speedName}`);
  api.saveSettings(state.settings).catch((error) => showToast(`闪烁速度保存失败：${error.message}`));
});
for (const button of document.querySelectorAll('[data-load]')) button.addEventListener('click', loadWorkspace);
for (const button of document.querySelectorAll('[data-choose]')) button.addEventListener('click', () => chooseDirectory(button.dataset.choose));
pathPanelToggle.addEventListener('click', () => setPathPanelExpanded(!pathPanel.classList.contains('expanded')));
for (const input of [elements.beforePath, elements.afterPath, elements.maskPath]) {
  input.addEventListener('input', () => updatePathPresentation(input));
  input.addEventListener('blur', () => updatePathPresentation(input));
}
document.getElementById('label-panel-close').addEventListener('click', () => toggleLabelPanel(false));
document.getElementById('close-label').addEventListener('click', () => toggleLabelPanel(false));
document.getElementById('label-jump').addEventListener('click', () => selectLabelEditor(elements.labelId.value, true));
elements.labelId.addEventListener('change', () => selectLabelEditor(elements.labelId.value, true));
document.getElementById('save-label').addEventListener('click', () => saveLabel(false));
document.getElementById('save-use-label').addEventListener('click', () => saveLabel(true));
elements.pinLabel.addEventListener('click', togglePin);
elements.captureShortcut.addEventListener('click', beginShortcutCapture);
document.getElementById('clear-shortcut').addEventListener('click', () => {
  state.capturedShortcut = '';
  elements.labelShortcut.value = '';
});

new ResizeObserver(() => scheduleRender()).observe(viewer);

async function initialize() {
  try {
    const [settings, labelData, version] = await Promise.all([
      api.loadSettings(), api.loadLabels(), api.appVersion(),
    ]);
    state.settings = settings;
    state.maskOpacity = settings.maskOpacity;
    state.blinkIntervalMs = settings.blinkIntervalMs;
    elements.maskOpacity.value = String(state.maskOpacity);
    elements.maskOpacityValue.value = `${state.maskOpacity}%`;
    elements.blinkSpeed.value = String(state.blinkIntervalMs);
    state.labels = labelData.labels;
    state.activeLabelId = labelData.activeLabelId;
    state.selectedLabelId = state.activeLabelId;
    syncPathInputs();
    updateButtons();
    setStatus(`Electron ${version} 已就绪 | 请选择目录或点击载入`);
    if (settings.beforeDir && settings.afterDir) await loadWorkspace();
    else render();
  } catch (error) {
    setStatus(`程序初始化失败：${error.message}`);
  }
}

window.__APP_SELF_TEST__ = async () => {
  const required = ['image-canvas', 'annotation-canvas', 'label-panel', 'label-shortcut', 'mask-button', 'mask-opacity', 'blink-speed', 'replace-color-button', 'swap-button', 'status-bar', 'path-panel-toggle'];
  const domReady = required.every((id) => document.getElementById(id));
  const labelsReady = Object.keys(state.labels).length === 256;
  const wasExpanded = pathPanel.classList.contains('expanded');
  pathPanelToggle.click();
  const pathToggleReady = pathPanel.classList.contains('expanded') !== wasExpanded;
  setPathPanelExpanded(wasExpanded);
  const swapButtonReady = buttons.swap?.dataset.action === 'swap';
  const blinkSpeedReady = [...elements.blinkSpeed.options].map((option) => Number(option.value)).join(',')
    === '150,250,350,600,1000' && Number(elements.blinkSpeed.value) === state.blinkIntervalMs;
  return {
    ok: domReady && labelsReady && pathToggleReady && swapButtonReady && blinkSpeedReady,
    domReady,
    labelsReady,
    pathToggleReady,
    swapButtonReady,
    blinkSpeedReady,
  };
};

window.__APP_RENDER_TEST__ = async (settings) => {
  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  elements.beforePath.value = settings?.beforeDir || '';
  elements.afterPath.value = settings?.afterDir || '';
  elements.maskPath.value = settings?.maskDir || '';
  await loadWorkspace();
  const iterations = Math.min(state.pairs.length, Math.max(1, Number(settings?.iterations) || 1));
  const navigationStarted = performance.now();
  for (let index = 1; index < iterations; index += 1) {
    state.index = index;
    await render();
  }
  const navigationMs = performance.now() - navigationStarted;
  state.viewMode = 'compare';
  state.annotationPoints = [];
  state.annotationTransformIndex = 0;
  await render();
  const afterTransform = state.transforms[1];
  const afterPoint = afterTransform
    ? toImagePoint({ x: afterTransform.centerX, y: afterTransform.centerY })
    : null;
  const afterRoutingReady = Boolean(afterPoint) && state.annotationTransformIndex === 1;
  let auxiliaryLineReady = false;
  let auxiliaryLineAverageMs = null;
  if (afterTransform) {
    const center = { x: afterTransform.sourceWidth * 0.45, y: afterTransform.sourceHeight * 0.5 };
    state.annotationMode = true;
    state.annotationAction = 'add';
    state.annotationTransformIndex = 1;
    state.annotationPoints = [center];
    state.annotationCursor = { x: afterTransform.sourceWidth * 0.6, y: afterTransform.sourceHeight * 0.5 };
    drawAnnotationPreview();
    const startX = Math.round(afterTransform.left + center.x * afterTransform.displayWidth / afterTransform.sourceWidth);
    const endX = Math.round(afterTransform.left + state.annotationCursor.x * afterTransform.displayWidth / afterTransform.sourceWidth);
    const lineY = Math.round(afterTransform.top + center.y * afterTransform.displayHeight / afterTransform.sourceHeight);
    const sampleX = Math.max(0, Math.min(annotationCanvas.width - 1, Math.min(startX, endX)));
    const sampleWidth = Math.max(1, Math.min(annotationCanvas.width - sampleX, Math.abs(endX - startX) + 1));
    const previewPixels = annotationCtx.getImageData(sampleX, Math.max(0, lineY - 3), sampleWidth, 7).data;
    for (let offset = 3; offset < previewPixels.length; offset += 4) {
      if (previewPixels[offset] > 0) { auxiliaryLineReady = true; break; }
    }
    const previewIterations = 300;
    const previewStarted = performance.now();
    for (let index = 0; index < previewIterations; index += 1) {
      state.annotationCursor.x = afterTransform.sourceWidth * (0.5 + (index % 100) / 500);
      drawAnnotationPreview();
    }
    auxiliaryLineAverageMs = Math.round(((performance.now() - previewStarted) / previewIterations) * 1000) / 1000;
    resetAnnotation();
  }
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const step = Math.max(4, Math.floor((canvas.width * canvas.height) / 12000)) * 4;
  let sampled = 0;
  let nonBackground = 0;
  for (let offset = 0; offset < pixels.length; offset += step) {
    sampled += 1;
    if (Math.abs(pixels[offset] - 17) + Math.abs(pixels[offset + 1] - 19) + Math.abs(pixels[offset + 2] - 21) > 18) {
      nonBackground += 1;
    }
  }
  let interaction = null;
  if (settings?.interactionTest && afterTransform) {
    const sourceWidth = afterTransform.sourceWidth;
    const sourceHeight = afterTransform.sourceHeight;
    const polygon = [
      { x: sourceWidth * 0.38, y: sourceHeight * 0.38 },
      { x: sourceWidth * 0.62, y: sourceHeight * 0.38 },
      { x: sourceWidth * 0.62, y: sourceHeight * 0.62 },
      { x: sourceWidth * 0.38, y: sourceHeight * 0.62 },
    ];

    state.showMask = false;
    state.annotationMode = true;
    state.annotationAction = 'add';
    state.annotationTransformIndex = 1;
    state.annotationPoints = polygon;
    await finishPolygon();
    const addAutoMask = state.showMask && state.annotationMode && state.annotationAction === 'add'
      && !state.annotationPoints.length && Boolean(currentPair()?.maskPath);

    state.showMask = false;
    state.annotationMode = true;
    state.annotationAction = 'erase';
    state.eraseStyle = 'single';
    state.annotationTransformIndex = 1;
    await eraseConnectedAt({ x: sourceWidth / 2, y: sourceHeight / 2 });
    const singleEraseAutoMask = state.showMask && !state.annotationMode;

    state.annotationMode = true;
    state.annotationAction = 'add';
    state.annotationTransformIndex = 1;
    state.annotationPoints = polygon;
    await finishPolygon();
    state.showMask = false;
    state.annotationMode = true;
    state.annotationAction = 'erase';
    state.eraseStyle = 'polygon';
    state.annotationTransformIndex = 1;
    state.annotationPoints = polygon;
    await finishPolygon();
    const polygonEraseAutoMask = state.showMask && !state.annotationMode;

    state.annotationMode = false;
    state.eraseStyle = 'single';
    toggleAnnotation('erase');
    const singleModeReady = state.annotationMode && state.eraseStyle === 'single';
    toggleAnnotation('erase');
    const polygonModeReady = state.annotationMode && state.eraseStyle === 'polygon';
    resetAnnotation();

    interaction = {
      ok: addAutoMask && singleEraseAutoMask && polygonEraseAutoMask
        && singleModeReady && polygonModeReady,
      addAutoMask,
      singleEraseAutoMask,
      polygonEraseAutoMask,
      singleModeReady,
      polygonModeReady,
    };
  }
  let panBenchmark = null;
  const panIterations = Math.max(0, Number(settings?.panIterations) || 0);
  if (panIterations) {
    resetAnnotation();
    state.viewMode = 'single';
    state.mode = 'after';
    state.showMask = true;
    state.zoom = Math.max(1, Number(settings?.panZoom) || 4);
    state.panX = 0;
    state.panY = 0;
    state.fastRender = false;
    await render();
    const transform = state.transforms[0];
    state.annotationMode = true;
    state.annotationAction = 'add';
    state.annotationTransformIndex = 0;
    state.annotationPoints = [
      { x: transform.sourceWidth * 0.4, y: transform.sourceHeight * 0.4 },
      { x: transform.sourceWidth * 0.6, y: transform.sourceHeight * 0.4 },
      { x: transform.sourceWidth * 0.6, y: transform.sourceHeight * 0.6 },
    ];
    for (let index = 0; index < 3; index += 1) {
      state.panX = index * 18;
      state.panY = index * 14;
      state.fastRender = true;
      await render();
    }
    const samples = [];
    for (let index = 0; index < panIterations; index += 1) {
      state.panX = (index % 12) * 18 - 99;
      state.panY = (index % 8) * 14 - 49;
      state.fastRender = true;
      const started = performance.now();
      await render();
      samples.push(performance.now() - started);
    }
    state.fastRender = false;
    await render();
    samples.sort((left, right) => left - right);
    const total = samples.reduce((sum, value) => sum + value, 0);
    panBenchmark = {
      iterations: panIterations,
      zoom: state.zoom,
      averageMs: Math.round(total / samples.length * 10) / 10,
      p95Ms: Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] * 10) / 10,
      maxMs: Math.round(samples[samples.length - 1] * 10) / 10,
    };
    resetAnnotation();
  }
  let pageSwitchBenchmark = null;
  if (settings?.pageSwitchBenchmark && state.pairs.length > 1) {
    resetAnnotation();
    state.index = 0;
    state.viewMode = 'single';
    state.mode = 'after';
    state.showMask = true;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.fastRender = false;
    await render();
    const target = state.pairs[1];
    await Promise.all([target.afterUrl, target.maskUrl].filter(Boolean).map((url) => loadImagePreview(url)));
    const cadenceStarted = performance.now();
    await waitFrame();
    await waitFrame();
    const idleFrameCadenceMs = performance.now() - cadenceStarted;
    const switchStarted = performance.now();
    navigate(1);
    await waitFrame();
    await waitFrame();
    const switchReadyMs = performance.now() - switchStarted;
    state.zoom = Math.max(1, Number(settings?.panZoom) || 4);
    state.panX = 72;
    state.panY = 42;
    const panStarted = performance.now();
    scheduleRender(true);
    await waitFrame();
    await waitFrame();
    const immediatePanMs = performance.now() - panStarted;
    clearTimeout(renderSettleTimer);
    renderSettleTimer = null;
    state.fastRender = false;
    await render();
    pageSwitchBenchmark = {
      idleFrameCadenceMs: Math.round(idleFrameCadenceMs * 10) / 10,
      switchReadyMs: Math.round(switchReadyMs * 10) / 10,
      immediatePanMs: Math.round(immediatePanMs * 10) / 10,
      switchBlockingMs: Math.round(Math.max(0, switchReadyMs - idleFrameCadenceMs) * 10) / 10,
      immediatePanBlockingMs: Math.round(Math.max(0, immediatePanMs - idleFrameCadenceMs) * 10) / 10,
    };
  }
  let rapidNavigationBenchmark = null;
  const rapidNavigationSteps = Math.max(0, Number(settings?.rapidNavigationSteps) || 0);
  if (rapidNavigationSteps && state.pairs.length > 2) {
    resetAnnotation();
    state.index = 0;
    state.viewMode = 'single';
    state.mode = 'after';
    state.showMask = true;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.fastRender = false;
    await render();
    const idleSamples = [];
    for (let index = 0; index < 8; index += 1) {
      const started = performance.now();
      await waitFrame();
      idleSamples.push(performance.now() - started);
    }
    idleSamples.sort((left, right) => left - right);
    const idleFrameMs = idleSamples[Math.floor(idleSamples.length / 2)];
    const frameSamples = [];
    for (let index = 0; index < rapidNavigationSteps; index += 1) {
      const started = performance.now();
      navigate(1);
      await waitFrame();
      frameSamples.push(performance.now() - started);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitFrame();
    await waitFrame();
    frameSamples.sort((left, right) => left - right);
    const p95FrameMs = frameSamples[Math.min(frameSamples.length - 1, Math.floor(frameSamples.length * 0.95))];
    rapidNavigationBenchmark = {
      steps: rapidNavigationSteps,
      idleFrameMs: Math.round(idleFrameMs * 10) / 10,
      p95FrameMs: Math.round(p95FrameMs * 10) / 10,
      p95BlockingMs: Math.round(Math.max(0, p95FrameMs - idleFrameMs) * 10) / 10,
      finalIndex: state.index,
      renderedIndex: state.lastRenderedIndex,
      expectedIndex: rapidNavigationSteps % state.pairs.length,
    };
  }
  const panBenchmarkReady = !panBenchmark || panBenchmark.p95Ms <= 16.7;
  const pageSwitchBenchmarkReady = !pageSwitchBenchmark
    || (pageSwitchBenchmark.switchBlockingMs <= 16.7 && pageSwitchBenchmark.immediatePanBlockingMs <= 16.7);
  const rapidNavigationBenchmarkReady = !rapidNavigationBenchmark
    || (rapidNavigationBenchmark.p95BlockingMs <= 16.7
      && rapidNavigationBenchmark.finalIndex === rapidNavigationBenchmark.expectedIndex
      && rapidNavigationBenchmark.renderedIndex === rapidNavigationBenchmark.expectedIndex);
  const ok = state.pairs.length > 0 && !state.lastRenderError
    && nonBackground > sampled * 0.01 && afterRoutingReady && auxiliaryLineReady
    && (!interaction || interaction.ok) && panBenchmarkReady
    && pageSwitchBenchmarkReady && rapidNavigationBenchmarkReady;
  return {
    ok,
    pairs: state.pairs.length,
    current: currentPair()?.name || '',
    error: state.lastRenderError,
    canvas: `${canvas.width}x${canvas.height}`,
    nonBackground,
    sampled,
    iterations,
    navigationMs: Math.round(navigationMs * 10) / 10,
    averageNavigationMs: Math.round((navigationMs / Math.max(1, iterations - 1)) * 10) / 10,
    afterRoutingReady,
    auxiliaryLineReady,
    auxiliaryLineAverageMs,
    interaction,
    panBenchmark,
    panBenchmarkReady,
    pageSwitchBenchmark,
    pageSwitchBenchmarkReady,
    rapidNavigationBenchmark,
    rapidNavigationBenchmarkReady,
  };
};

initialize();
