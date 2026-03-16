const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// Start tunnel (it launches HTTP dashboard on port 9876)
require('./tunnel.js');

let mainWindow = null;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: 'Amina Tunnel',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    icon: undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:9876');
  mainWindow.removeMenu();

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  // 16x16 green circle icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAiklEQVQ4T2NkoBAwUqifYdAYwMDAIMzAwHCHgYHhPzYH/GdgYLjDwMCgyMDA8B+bGkYGBoY7jIyMimfOnPmPrhkkeObMGUZGRkZFBmwuYGBgOMPAwKDIyMh4BpsaRgYGhjMMDAyKZ86c+Y+uBskFZ3C5AK8XiDEA2YuDJhcMmlQIj6EMDAwAjPY0EQMiVhUAAAAASUVORK5CYII='
  );
  tray = new Tray(icon);
  tray.setToolTip('Amina Tunnel');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { mainWindow.destroy(); app.quit(); } },
  ]));
  tray.on('double-click', () => mainWindow.show());
}

app.whenReady().then(() => {
  // Wait for dashboard server to start
  setTimeout(() => {
    createWindow();
    createTray();
  }, 1500);
});

app.on('window-all-closed', () => {
  // Keep running in tray
});
