'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

test('desktop lifecycle and installer expose requested behavior', async () => {
  const [main, preload, installer, renderer, app] = await Promise.all([
    fs.readFile(path.join(root, 'electron', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'preload.js'), 'utf8'),
    fs.readFile(path.join(root, 'assets', 'installer.nsh'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(root, 'electron', 'renderer', 'app.js'), 'utf8'),
  ]);
  assert.match(main, /mainWindow\.maximize\(\)/);
  assert.match(main, /event\.preventDefault\(\)[\s\S]*mainWindow\.hide\(\)/);
  assert.match(main, /tray\.on\('click', showWindow\)/);
  assert.match(installer, /customPageAfterChangeDir/);
  assert.match(installer, /CreateShortCut/);
  assert.match(renderer, /id="label-shortcut"/);
  assert.match(renderer, /id="mask-opacity"[\s\S]*type="range"[\s\S]*min="0"[\s\S]*max="100"/);
  assert.match(renderer, /id="mask-opacity-value"/);
  assert.match(renderer, /id="blink-speed"[\s\S]*aria-label="闪烁速度"/);
  for (const interval of [150, 250, 350, 600, 1000]) {
    assert.match(renderer, new RegExp(`<option value="${interval}"`));
  }
  assert.match(renderer, /id="blink-button"[\s\S]*id="blink-speed"[\s\S]*id="compare-button"/);
  assert.ok(renderer.includes('<button id="replace-color-button" data-action="replace-color">替换颜色 [W]</button>'));
  assert.ok(renderer.includes('<button id="sam-button" data-action="sam">AI 圈选 [F]</button>'));
  assert.match(renderer, /id="swap-button"[\s\S]*data-action="swap"/);
  assert.match(renderer, /annotation-coordinates\.js[\s\S]*app\.js/);
  assert.match(preload, /swapPairFiles:[\s\S]*pair:swap-files/);
  assert.match(preload, /replaceConnectedColor:[\s\S]*mask:replace-connected-color/);
  assert.match(preload, /prepareSamImage:[\s\S]*sam:prepare-image/);
  assert.match(preload, /predictSamMask:[\s\S]*sam:predict/);
  assert.match(preload, /mergeBinaryMask:[\s\S]*mask:merge-binary/);
  assert.match(main, /ipcMain\.handle\('pair:swap-files'/);
  assert.match(main, /maskPathForPair\(value\.maskDir, value\.pairName\)/);
  assert.ok(main.includes("ipcMain.handle('mask:replace-connected-color'"));
  assert.ok(main.includes("ipcMain.handle('sam:prepare-image'"));
  assert.ok(main.includes("ipcMain.handle('sam:predict'"));
  assert.ok(main.includes("ipcMain.handle('mask:merge-binary'"));
  assert.match(main, /ELECTRON_SAM_SELF_TEST_IMAGE[\s\S]*foregroundPixels/);
  assert.match(main, /ELECTRON_SELF_TEST_OUTPUT[\s\S]*fs\.writeFile/);
  assert.equal(require('../../package.json').build.afterPack, 'electron/after-pack.js');
  assert.doesNotMatch(app, /RIGHT_DRAG_HOLD_MS/);
  assert.ok(app.includes("if (state.annotationMode && state.annotationAction !== 'replace') finishPolygon()"));
  assert.match(app, /canvas\.addEventListener\('pointerdown',[\s\S]*if \(event\.button === 1\)[\s\S]*state\.drag = \{ pointerId: event\.pointerId,[\s\S]*if \(event\.button !== 0 \|\| !state\.annotationMode\) return;/);
  assert.match(app, /canvas\.addEventListener\('pointermove',[\s\S]*if \(state\.drag\)[\s\S]*scheduleRender\(true\);[\s\S]*return;[\s\S]*if \(state\.annotationMode\)/);
  assert.match(app, /if \(erase\) resetAnnotation\(\);[\s\S]*else clearAnnotationDraft\(\);/);
  assert.match(app, /let renderSettleTimer = null;/);
  assert.match(app, /function scheduleRender\(fast = false\)[\s\S]*clearTimeout\(renderSettleTimer\);[\s\S]*renderSettleTimer = setTimeout/);
  assert.match(app, /async function drawMaskOverlay[\s\S]*if \(state\.fastRender\)[\s\S]*globalCompositeOperation = 'screen';[\s\S]*return;/);
  assert.match(app, /panBenchmarkReady = !panBenchmark \|\| panBenchmark\.p95Ms <= 16\.7/);
  assert.match(app, /function navigate\(delta\)[\s\S]*scheduleRender\(true\);/);
  assert.match(app, /async function yieldMaskRender\(renderId\)[\s\S]*requestAnimationFrame[\s\S]*renderId === state\.renderSequence/);
  assert.match(app, /for \(let startY = 0; startY < height; startY \+= MASK_ROWS_PER_CHUNK\)[\s\S]*await yieldMaskRender\(renderId\)/);
  assert.match(app, /pageSwitchBenchmarkReady[\s\S]*switchBlockingMs <= 16\.7[\s\S]*immediatePanBlockingMs <= 16\.7/);
  assert.match(app, /async function loadImagePreview\(url\)[\s\S]*createImageBitmap[\s\S]*resizeWidth[\s\S]*resizeHeight/);
  assert.match(app, /scheduleNearbyPrefetch[\s\S]*loadImagePreview\(url\)/);
  assert.match(app, /fastRender \? await loadImagePreview\([^)]+\) : [^;]+/);
  assert.match(app, /const NAVIGATION_RENDER_INTERVAL_MS = 100;/);
  assert.match(app, /function scheduleNavigationRender\(\)[\s\S]*clearTimeout\(navigationRenderTimer\)[\s\S]*setTimeout[\s\S]*scheduleRender\(true\)/);
  assert.match(app, /function navigate\(delta\)[\s\S]*updateStatus\(\);[\s\S]*scheduleNavigationRender\(\);/);
  assert.match(app, /rapidNavigationBenchmarkReady[\s\S]*p95BlockingMs <= 16\.7[\s\S]*renderedIndex === rapidNavigationBenchmark\.expectedIndex/);
  assert.doesNotMatch(app, /canvas\.addEventListener\('dblclick'/);
  assert.ok(app.includes('reset: resetView'));
  assert.match(app, /shortcut === 'R' \|\| shortcut === '0'/);
  assert.match(app, /state\.showMask = true/);
  assert.ok(app.includes('const fillAlpha = Math.round(255 * state.maskOpacity / 100)'));
  assert.ok(app.includes('imageData.data[offset + 3] = visible ? fillAlpha : 0'));
  assert.ok(app.includes('imageData.data[offset + 3] = 255'));
  assert.match(app, /maskOpacity\.addEventListener\('input',[\s\S]*scheduleRender\(\)/);
  assert.match(app, /maskOpacity\.addEventListener\('change',[\s\S]*api\.saveSettings/);
  assert.match(app, /function restartBlinkTimer\(\)/);
  assert.match(app, /setInterval\(togglePhase, state\.blinkIntervalMs\)/);
  assert.match(app, /blinkSpeed\.addEventListener\('change',[\s\S]*restartBlinkTimer\(\)[\s\S]*api\.saveSettings/);
  assert.match(app, /event\.target instanceof HTMLSelectElement/);
  assert.match(main, /blinkIntervalMs:[\s\S]*normalizeBlinkInterval/);
  assert.match(main, /maskOpacity:[\s\S]*Math\.min\(100,[\s\S]*Math\.max\(0/);
  assert.match(app, /state\.annotationTransformIndex = null/);
  assert.match(app, /async function swapCurrentPairFiles\(\)/);
  assert.match(app, /shortcut === 'X'/);
  assert.match(app, /api\.swapPairFiles\(pair\)/);
  assert.ok(app.includes("'W',"));
  assert.ok(app.includes("'replace-color': () => toggleAnnotation('replace')"));
  assert.ok(app.includes("state.annotationAction === 'replace'"));
  assert.ok(app.includes("state.annotationAction === 'sam'"));
  assert.ok(app.includes("'sam': () => toggleSamAnnotation()"));
  assert.ok(app.includes("shortcut === 'F'"));
  assert.ok(app.includes('async function updateSamPrediction('));
  assert.ok(app.includes('async function confirmSamMask('));
  assert.ok(app.includes("const cancelledSam = state.annotationMode && state.annotationAction === 'sam'"));
  assert.ok(app.includes('if (cancelledSam && state.busy) setBusy(false)'));
  assert.ok(app.includes("shortcut === 'W'"));
  assert.ok(app.includes('async function replaceConnectedColorAt('));
  assert.match(app, /const polygonMode = state\.annotationAction === 'add'[\s\S]*state\.eraseStyle === 'polygon'/);
  assert.match(app, /toImagePoint\(point, polygonMode\)/);
  assert.match(app, /toLockedImagePoint\(canvasPoint\(event\), true\)/);
  assert.match(app, /function toImagePoint\(point, clampToEdge = false\)/);
  assert.ok(app.indexOf('resetAnnotation()', app.indexOf('async function replaceConnectedColorAt(')) > 0);
  assert.match(app, /swapButtonReady/);
});
