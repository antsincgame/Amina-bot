const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

const APP_NAME = 'AminaTunnel';

// Start tunnel (it launches HTTP dashboard on port 9876)
require('./tunnel.js');

let mainWindow = null;
let tray = null;

// ============================================
//  Autostart (Windows registry)
// ============================================
function getExePath() {
  // Electron portable sets PORTABLE_EXECUTABLE_FILE to the actual exe
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portablePath) return `"${portablePath}"`;
  return `"${process.execPath}"`;
}

function isAutoStartEnabled() {
  try {
    const out = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${APP_NAME}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return out.includes(APP_NAME);
  } catch {
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    if (enabled) {
      execSync(
        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${APP_NAME}" /t REG_SZ /d ${getExePath()} /f`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(
        `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${APP_NAME}" /f`,
        { stdio: 'pipe' }
      );
    }
    return true;
  } catch {
    return false;
  }
}

// Expose autostart API via HTTP (dashboard uses it)
const http = require('http');
const autostartServer = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/api/autostart' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: isAutoStartEnabled() }));
    return;
  }
  if (req.url === '/api/autostart' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        const ok = setAutoStart(!!enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: isAutoStartEnabled(), ok }));
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
autostartServer.listen(9877, '127.0.0.1');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: 'Amina Tunnel',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.removeMenu();

  // Retry loading in case dashboard server isn't ready yet
  const loadDashboard = () => {
    mainWindow.loadURL('http://127.0.0.1:9876').catch(() => {
      setTimeout(loadDashboard, 1000);
    });
  };
  loadDashboard();

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function updateTrayMenu() {
  const autoStart = isAutoStartEnabled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Autostart with Windows', type: 'checkbox', checked: autoStart, click: (item) => {
      setAutoStart(item.checked);
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; mainWindow.destroy(); app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAiklEQVQ4T2NkoBAwUqifYdAYwMDAIMzAwHCHgYHhPzYH/GdgYLjDwMCgyMDA8B+bGkYGBoY7jIyMimfOnPmPrhkkeObMGUZGRkZFBmwuYGBgOMPAwKDIyMh4BpsaRgYGhjMMDAyKZ86c+Y+uBskFZ3C5AK8XiDEA2YuDJhcMmlQIj6EMDAwAjPY0EQMiVhUAAAAASUVORK5CYII='
  );
  tray = new Tray(icon);
  tray.setToolTip('Amina Tunnel');
  updateTrayMenu();
  tray.on('double-click', () => mainWindow.show());
}

app.isQuitting = false;

app.whenReady().then(() => {
  setTimeout(() => {
    createWindow();
    createTray();
  }, 1500);
});

app.on('window-all-closed', () => {
  // Keep running in tray
});
