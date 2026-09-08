'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, Tray } = require('electron');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

const { normalizeLabelDefinitions } = require('./core/labels');
const { findPairs, maskPathForPair, pathExists, swapPairFiles, uniqueDestination } = require('./core/pairs');
const { eraseConnected, mergeBinaryMask, paintPolygon, replaceConnectedColor } = require('./core/mask-service');
const { SamService } = require('./core/sam-service');
const { normalizeBlinkInterval } = require('./core/settings');

const APP_NAME = '双时相变化检查工具';
const ROOT = path.resolve(__dirname, '..');
const LABELS_FILENAME = 'mask_labels.json';
const SETTINGS_FILENAME = 'settings.json';
const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'], ['.bmp', 'image/bmp'], ['.webp', 'image/webp'],
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;
let tray = null;
let quitting = false;
let lastDeleted = null;
let samService = null;

function samModelPaths() {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(__dirname, 'models');
  return {
    encoder: path.join(directory, 'mobilesam.encoder.onnx'),
    decoder: path.join(directory, 'mobilesam.decoder.quant.onnx'),
  };
}

function getSamService() {
  if (!samService) samService = new SamService(samModelPaths());
  return samService;
}

function programDirectory() {
  return app.isPackaged ? path.dirname(process.execPath) : ROOT;
}

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function legacySettingsPath() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), APP_NAME, SETTINGS_FILENAME);
}

function programLabelPath() {
  return path.join(programDirectory(), LABELS_FILENAME);
}

function fallbackLabelPath() {
  return path.join(app.getPath('userData'), LABELS_FILENAME);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  }
}

async function fileStamp(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${Math.round(stat.mtimeMs)}-${stat.size}`;
  } catch {
    return Date.now().toString();
  }
}

async function imageUrl(filePath, cacheToken = '') {
  if (!filePath) return null;
  const token = Buffer.from(path.resolve(filePath), 'utf8').toString('base64url');
  const stamp = `${await fileStamp(filePath)}${cacheToken ? `-${cacheToken}` : ''}`;
  return `local-image://file/${token}?v=${encodeURIComponent(stamp)}`;
}

async function serializePair(pair, cacheToken = '') {
  return {
    ...pair,
    beforeUrl: await imageUrl(pair.beforePath, cacheToken),
    afterUrl: await imageUrl(pair.afterPath, cacheToken),
    maskUrl: pair.maskPath ? await imageUrl(pair.maskPath) : null,
  };
}

async function loadSettings() {
  let value = await readJson(settingsPath());
  if (!value) value = await readJson(legacySettingsPath(), {});
  const maskOpacity = Number(value?.maskOpacity);
  return {
    beforeDir: typeof value?.before_dir === 'string' ? value.before_dir : (value?.beforeDir || ''),
    afterDir: typeof value?.after_dir === 'string' ? value.after_dir : (value?.afterDir || ''),
    maskDir: typeof value?.mask_dir === 'string' ? value.mask_dir : (value?.maskDir || ''),
    maskOpacity: Number.isFinite(maskOpacity) ? Math.min(100, Math.max(0, Math.round(maskOpacity))) : 46,
    blinkIntervalMs: normalizeBlinkInterval(value?.blinkIntervalMs),
  };
}

async function saveSettings(value) {
  const maskOpacity = Number(value?.maskOpacity);
  const normalized = {
    beforeDir: String(value?.beforeDir || ''),
    afterDir: String(value?.afterDir || ''),
    maskDir: String(value?.maskDir || ''),
    maskOpacity: Number.isFinite(maskOpacity) ? Math.min(100, Math.max(0, Math.round(maskOpacity))) : 46,
    blinkIntervalMs: normalizeBlinkInterval(value?.blinkIntervalMs),
  };
  await writeJsonAtomic(settingsPath(), normalized);
  return normalized;
}

async function loadLabels() {
  const sourcePath = (await pathExists(programLabelPath())) ? programLabelPath() : fallbackLabelPath();
  const data = await readJson(sourcePath, {});
  const labels = normalizeLabelDefinitions(data?.labels);
  const active = Number(data?.active_label_id ?? data?.activeLabelId ?? 1);
  return {
    activeLabelId: Number.isInteger(active) && active >= 0 && active <= 255 ? active : 1,
    labels,
    sourcePath,
  };
}

async function saveLabels(payload) {
  const labels = normalizeLabelDefinitions(payload?.labels);
  const active = Number(payload?.activeLabelId);
  const value = {
    version: 3,
    label_range: [0, 255],
    mask_encoding: 'RGB stores selected label color',
    active_label_id: Number.isInteger(active) && active >= 0 && active <= 255 ? active : 1,
    labels,
  };
  try {
    await writeJsonAtomic(programLabelPath(), value);
    return { ...value, sourcePath: programLabelPath() };
  } catch {
    await writeJsonAtomic(fallbackLabelPath(), value);
    return { ...value, sourcePath: fallbackLabelPath() };
  }
}

async function moveFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, destination);
    await fs.rm(source);
  }
}

async function deletePairToRecycle({ pair, beforeDir, afterDir, maskDir }) {
  const commonParent = path.dirname(beforeDir) === path.dirname(afterDir)
    ? path.dirname(beforeDir)
    : programDirectory();
  const deletedRoot = path.join(commonParent, 'deleted_pairs');
  const moves = [
    [pair.beforePath, await uniqueDestination(path.join(deletedRoot, path.basename(beforeDir), path.basename(pair.beforePath)))],
    [pair.afterPath, await uniqueDestination(path.join(deletedRoot, path.basename(afterDir), path.basename(pair.afterPath)))],
  ];
  if (pair.maskPath && await pathExists(pair.maskPath)) {
    moves.push([
      pair.maskPath,
      await uniqueDestination(path.join(deletedRoot, path.basename(maskDir || 'mask'), path.basename(pair.maskPath))),
    ]);
  }
  const completed = [];
  try {
    for (const [source, destination] of moves) {
      await moveFile(source, destination);
      completed.push([source, destination]);
    }
  } catch (error) {
    for (const [source, destination] of completed.reverse()) {
      if (await pathExists(destination)) await moveFile(destination, source).catch(() => {});
    }
    throw error;
  }
  lastDeleted = { pair, moves: moves.map(([source, destination]) => [destination, source]) };
  return { deleted: true };
}

async function undoDelete() {
  if (!lastDeleted) return null;
  for (const [source, destination] of lastDeleted.moves) await moveFile(source, destination);
  const pair = lastDeleted.pair;
  lastDeleted = null;
  return serializePair(pair);
}

async function permanentDelete(pair) {
  for (const filePath of [pair.beforePath, pair.afterPath, pair.maskPath].filter(Boolean)) {
    await fs.rm(filePath, { force: true });
  }
  return { deleted: true };
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.maximize();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(programDirectory(), 'assets', 'icon.ico');
  const fallback = path.join(__dirname, '..', 'assets', 'icon.ico');
  const icon = nativeImage.createFromPath(app.isPackaged ? iconPath : fallback);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示程序', click: showWindow },
    { type: 'separator' },
    {
      label: '彻底退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#111315',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--self-test')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        mainWindow.maximize();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const result = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          let attempts = 0;
          const timer = setInterval(async () => {
            attempts += 1;
            const value = await window.__APP_SELF_TEST__();
            if (value.ok || attempts >= 40) {
              clearInterval(timer);
              resolve(value);
            }
          }, 100);
        })`);
        const renderTestSettings = process.env.ELECTRON_RENDER_TEST_SETTINGS
          ? JSON.parse(process.env.ELECTRON_RENDER_TEST_SETTINGS)
          : null;
        if (renderTestSettings) {
          result.renderTest = await mainWindow.webContents.executeJavaScript(
            `window.__APP_RENDER_TEST__(${JSON.stringify(renderTestSettings)})`,
          );
          result.ok = result.ok && result.renderTest.ok;
        }
        result.windowMaximized = mainWindow.isMaximized();
        result.ok = result.ok && result.windowMaximized;
        if (process.env.ELECTRON_SAM_SELF_TEST_IMAGE) {
          const startedAt = Date.now();
          const prediction = await getSamService().predict({
            imagePath: process.env.ELECTRON_SAM_SELF_TEST_IMAGE,
            points: [{ x: 256, y: 256, positive: true }],
          });
          result.sam = {
            foregroundPixels: prediction.mask.reduce((sum, value) => sum + value, 0),
            score: prediction.score,
            elapsedMs: Date.now() - startedAt,
          };
          result.ok = result.ok && result.sam.foregroundPixels > 0;
        }
        process.stdout.write(`ELECTRON_SELF_TEST=${JSON.stringify(result)}\n`);
        if (process.env.ELECTRON_SELF_TEST_OUTPUT) {
          await fs.writeFile(process.env.ELECTRON_SELF_TEST_OUTPUT, JSON.stringify(result, null, 2), 'utf8');
        }
        quitting = true;
        app.exit(result.ok ? 0 : 1);
      } catch (error) {
        process.stderr.write(`ELECTRON_SELF_TEST_ERROR=${error.stack || error.message}\n`);
        quitting = true;
        app.exit(1);
      }
    });
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    if (!process.argv.includes('--self-test')) mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle('dialog:choose-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件夹',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('settings:load', loadSettings);
  ipcMain.handle('settings:save', (_event, value) => saveSettings(value));
  ipcMain.handle('labels:load', loadLabels);
  ipcMain.handle('labels:save', (_event, value) => saveLabels(value));
  ipcMain.handle('pairs:load', async (_event, value) => {
    const pairs = await findPairs(value.beforeDir, value.afterDir, value.maskDir);
    return Promise.all(pairs.map(serializePair));
  });
  ipcMain.handle('image:metadata', async (_event, filePath) => {
    const metadata = await sharp(filePath).metadata();
    return { width: metadata.width, height: metadata.height };
  });
  ipcMain.handle('image:url', (_event, filePath) => imageUrl(filePath));
  ipcMain.handle('sam:prepare-image', (_event, value) => getSamService().prepareImage(value.imagePath));
  ipcMain.handle('sam:predict', (_event, value) => getSamService().predict(value));
  ipcMain.handle('mask:paint-polygon', async (_event, value) => {
    const targetPath = value.maskPath || maskPathForPair(value.maskDir, value.pairName);
    await paintPolygon({
      existingMask: value.maskPath || null,
      targetPath,
      sourceSize: value.sourceSize,
      points: value.points,
      color: value.color,
      erase: Boolean(value.erase),
    });
    return { maskPath: targetPath, maskUrl: await imageUrl(targetPath) };
  });
  ipcMain.handle('mask:erase-connected', async (_event, value) => {
    const result = await eraseConnected(value);
    return { ...result, maskUrl: await imageUrl(value.maskPath) };
  });
  ipcMain.handle('mask:replace-connected-color', async (_event, value) => {
    const result = await replaceConnectedColor(value);
    return { ...result, maskUrl: await imageUrl(value.maskPath) };
  });
  ipcMain.handle('mask:merge-binary', async (_event, value) => {
    const targetPath = value.maskPath || maskPathForPair(value.maskDir, value.pairName);
    const result = await mergeBinaryMask({
      existingMask: value.maskPath || null,
      targetPath,
      sourceSize: value.sourceSize,
      mask: value.mask,
      maskSize: value.maskSize,
      color: value.color,
    });
    return { ...result, maskUrl: await imageUrl(targetPath) };
  });
  ipcMain.handle('pair:delete', (_event, value) => deletePairToRecycle(value));
  ipcMain.handle('pair:undo-delete', undoDelete);
  ipcMain.handle('pair:permanent-delete', (_event, pair) => permanentDelete(pair));
  ipcMain.handle('pair:swap-files', async (_event, pair) => {
    await swapPairFiles(pair.beforePath, pair.afterPath);
    return serializePair(pair, `swap-${Date.now()}`);
  });
  ipcMain.handle('app:show', () => showWindow());
  ipcMain.handle('app:version', () => app.getVersion());
}

async function registerImageProtocol() {
  protocol.handle('local-image', async (request) => {
    try {
      const url = new URL(request.url);
      const token = url.pathname.replace(/^\//, '');
      const filePath = Buffer.from(token, 'base64url').toString('utf8');
      const extension = path.extname(filePath).toLowerCase();
      const metadata = await sharp(filePath).metadata();
      const actualMime = IMAGE_MIME.get(`.${metadata.format}`) || IMAGE_MIME.get(extension) || 'application/octet-stream';
      const requiresConversion = ['.tif', '.tiff'].includes(extension);
      const body = requiresConversion
        ? await sharp(filePath).png({ compressionLevel: 1 }).toBuffer()
        : Readable.toWeb(createReadStream(filePath));
      const contentLength = requiresConversion ? body.length : (await fs.stat(filePath)).size;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': requiresConversion ? 'image/png' : actualMime,
          'Content-Length': String(contentLength),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.dualtemporal.changeinspector');
    await registerImageProtocol();
    registerIpc();
    createWindow();
    if (!process.argv.includes('--self-test')) createTray();
  });
}

app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

module.exports = {
  imageUrl,
  loadLabels,
  loadSettings,
  programDirectory,
  serializePair,
};
