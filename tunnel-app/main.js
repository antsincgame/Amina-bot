const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
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
  // For portable exe, process.execPath points to the exe
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  mainWindow.loadURL('http://127.0.0.1:9876');
  mainWindow.removeMenu();

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
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
    { label: 'Quit', click: () => { mainWindow.destroy(); app.quit(); } },
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

app.whenReady().then(() => {
  setTimeout(() => {
    createWindow();
    createTray();
  }, 1500);
});

app.on('window-all-closed', () => {
  // Keep running in tray
});
