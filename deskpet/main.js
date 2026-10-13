'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { createWatcher, DATA_DIR } = require('./watcher');

const WIN_W = 240;
const WIN_H = 372;

let win = null;
let tray = null;
let stopWatcher = null;
let ignoreMouse = true;
let dragTimer = null;
let quitConfirmed = false;

/* ------------------------------------------------------------------ *
 * 位置记忆
 * ------------------------------------------------------------------ */

const posFile = () => path.join(app.getPath('userData'), 'pet-pos.json');

function loadPos() {
  try {
    const v = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
  } catch {
    /* 首次运行没有文件 */
  }
  return null;
}

function savePos() {
  if (!win || win.isDestroyed()) return;
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(posFile(), JSON.stringify({ x, y }));
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

/* ------------------------------------------------------------------ *
 * 无依赖的 PNG 生成（给托盘用图标）
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makeIcon(size, painter) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = painter(x, y);
      raw[o++] = px[0];
      raw[o++] = px[1];
      raw[o++] = px[2];
      raw[o++] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return nativeImage.createFromBuffer(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  );
}

function trayIcon() {
  // 优先用角色立绘本身当托盘图标，取不到再退回手绘小脸
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'pet-flat-idle.png'));
    if (!img.isEmpty()) return img.resize({ width: 32, height: 32, quality: 'best' });
  } catch {
    /* 读不到就走手绘兜底 */
  }
  return fallbackIcon();
}

function fallbackIcon() {
  const BERET = [247, 239, 230, 255];   // 贝雷帽白
  const BOW = [232, 97, 140, 255];     // 粉蝴蝶结
  const HAIR = [233, 161, 101, 255];   // 橙发
  const SKIN = [255, 226, 202, 255];
  const EYE = [74, 44, 51, 255];
  const SKIRT = [211, 193, 162, 255];
  const CLEAR = [0, 0, 0, 0];
  return makeIcon(16, (x, y) => {
    // 帽子
    if (y >= 1 && y <= 3 && x >= 2 && x <= 13) {
      if (x === 1 && y === 3) return BOW;
      return BERET;
    }
    // 脸 + 头发
    if (y >= 4 && y <= 9 && x >= 2 && x <= 13) {
      if (x === 2 || x === 13) return HAIR;
      if ((x === 5 || x === 10) && y >= 5 && y <= 6) return EYE;
      if (y === 9) return SKIRT; // 领口
      return SKIN;
    }
    // 裙子
    if (y >= 10 && y <= 12 && x >= 4 && x <= 11) return SKIRT;
    return CLEAR;
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function clampToDisplay(x, y) {
  const pt = { x, y };
  const area = screen.getDisplayNearestPoint(pt).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x - 80), area.x + area.width - 60)),
    y: Math.round(Math.min(Math.max(y, area.y - 20), area.y + area.height - 80))
  };
}

function createWindow() {
  const saved = loadPos();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认整窗穿透，鼠标移到桌宠身上再临时接管
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (!saved) {
      const area = screen.getPrimaryDisplay().workArea;
      win.setPosition(area.x + area.width - WIN_W - 40, area.y + area.height - WIN_H - 60);
    }
  });

  win.on('moved', savePos);
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('MiniMax Code 桌宠');
  refreshTrayMenu();
  tray.on('click', () => {
    if (win && !win.isDestroyed()) win.show();
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示桌宠', click: () => win && win.show() },
      {
        label: '回到右下角',
        click: () => {
          const area = screen.getPrimaryDisplay().workArea;
          win.setPosition(area.x + area.width - WIN_W - 40, area.y + area.height - WIN_H - 60);
          savePos();
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitConfirmed = true;
          app.quit();
        }
      }
    ])
  );
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function setIgnore(v) {
  if (!win || win.isDestroyed()) return;
  const next = !v; // hover=true -> 不穿透
  if (next === ignoreMouse) return;
  ignoreMouse = next;
  win.setIgnoreMouseEvents(ignoreMouse, { forward: true });
}

function startDrag() {
  if (!win || win.isDestroyed() || dragTimer) return;
  setIgnore(false); // 拖动期间必须能收到 mouseup
  const cur = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const ox = cur.x - wx;
  const oy = cur.y - wy;
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const p = clampToDisplay(c.x - ox, c.y - oy);
    win.setPosition(p.x, p.y);
  }, 16);
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  savePos();
}

ipcMain.on('pet:hover', (_e, hovering) => setIgnore(Boolean(hovering)));
ipcMain.on('pet:drag:start', startDrag);
ipcMain.on('pet:drag:end', stopDrag);
ipcMain.on('pet:menu', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '戳一下',
      click: () => win.webContents.send('pet:poke')
    },
    {
      label: '回到右下角',
      click: () => {
        const area = screen.getPrimaryDisplay().workArea;
        win.setPosition(area.x + area.width - WIN_W - 40, area.y + area.height - WIN_H - 60);
        savePos();
      }
    },
    { type: 'separator' },
    { label: '退出桌宠', click: () => { quitConfirmed = true; app.quit(); } }
  ]);
  menu.popup({ window: win });
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  createWindow();
  createTray();

  stopWatcher = createWatcher((payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('pet:state', payload);
  }, 1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', savePos);

app.on('window-all-closed', (e) => {
  // 桌宠常驻：关掉窗口不等于退出。只有托盘/右键菜单点了「退出」才真走。
  if (!quitConfirmed) e.preventDefault();
});

app.on('will-quit', () => {
  if (stopWatcher) stopWatcher();
  savePos();
});

process.on('uncaughtException', (err) => {
  console.error('[deskpet] uncaught:', err);
});

console.log('[deskpet] data dir:', DATA_DIR);