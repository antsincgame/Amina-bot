#!/usr/bin/env node
/**
 * Amina LM Studio Tunnel Supervisor
 * Standalone exe with web dashboard UI.
 *
 * 1. Reads config from .env or uses hardcoded defaults
 * 2. Opens dashboard in browser
 * 3. Downloads cloudflared if missing
 * 4. Waits for LM Studio on localhost
 * 5. Starts cloudflared quick tunnel
 * 6. Registers tunnel URL with Amina bot
 * 7. Monitors health, restarts on failure
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

// ============================================
//  Colors (console)
// ============================================
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ============================================
//  Log system with buffer for UI
// ============================================
const MAX_LOG_BUFFER = 200;
const logBuffer = [];
const sseClients = [];

function pushLog(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
}

const log = (msg) => { console.log(`${C.green('[tunnel]')} ${msg}`); pushLog('info', msg); };
const warn = (msg) => { console.log(`${C.yellow('[tunnel]')} ${msg}`); pushLog('warn', msg); };
const err = (msg) => { console.log(`${C.red('[tunnel]')} ${msg}`); pushLog('error', msg); };
const dim = (msg) => { console.log(`${C.dim('[tunnel]')} ${msg}`); pushLog('dim', msg); };

// ============================================
//  Config
// ============================================
const CONFIG = {
  botApiUrl: 'https://amina.vibecoding.by',
  tunnelToken: 'g2xTd4FohTJnkw6zjcs7rg9M1pOaHd-XdEeuVW2OtrA',
  lmstudioPort: 1234,
  dashboardPort: 9876,
  healthInterval: 30,
  tunnelUrlTimeout: 45,
  restartDelay: 5,
  startRetries: 5,
  unhealthyThreshold: 3,
};

// ============================================
//  State for UI
// ============================================
const STATE = {
  phase: 'starting',
  lmstudio: false,
  tunnel: false,
  tunnelUrl: '',
  botRegistered: false,
  lastHeartbeat: null,
  startedAt: new Date().toISOString(),
  cloudflaredVersion: '',
  error: null,
};

let tunnelProcess = null;
let tunnelLogFile = null;
let currentUrl = '';
let unhealthyCount = 0;
let shuttingDown = false;

// ============================================
//  .env loader
// ============================================
function loadEnvFile() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(process.execPath), '.env'),
    path.join(__dirname, '.env'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
          value = value.slice(1, -1);
        if (!process.env[key]) process.env[key] = value;
      }
      log(`Loaded config from ${envPath}`);
      return true;
    }
  }
  return false;
}

function applyConfig() {
  if (process.env.BOT_API_URL) CONFIG.botApiUrl = process.env.BOT_API_URL;
  if (process.env.LMSTUDIO_TUNNEL_TOKEN) CONFIG.tunnelToken = process.env.LMSTUDIO_TUNNEL_TOKEN;
  if (process.env.LMSTUDIO_PORT) CONFIG.lmstudioPort = parseInt(process.env.LMSTUDIO_PORT, 10);
  if (process.env.DASHBOARD_PORT) CONFIG.dashboardPort = parseInt(process.env.DASHBOARD_PORT, 10);
  if (process.env.HEALTH_INTERVAL) CONFIG.healthInterval = parseInt(process.env.HEALTH_INTERVAL, 10);
}

// ============================================
//  HTTP helpers
// ============================================
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

function httpPost(url, data, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(data);
    const opts = {
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = mod.request(opts, (res) => {
      let r = '';
      res.on('data', (c) => { r += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: r }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(body);
    req.end();
  });
}

// ============================================
//  Cloudflared
// ============================================
function findCloudflared() {
  const candidates = [
    'cloudflared', 'cloudflared.exe',
    path.join(process.cwd(), 'cloudflared.exe'),
    path.join(path.dirname(process.execPath), 'cloudflared.exe'),
    path.join(os.homedir(), 'cloudflared.exe'),
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cloudflared', 'cloudflared.exe'),
  ];
  for (const bin of candidates) {
    try { execSync(`"${bin}" --version`, { stdio: 'pipe', timeout: 5000 }); return bin; } catch { continue; }
  }
  return null;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const download = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return download(res.headers.location, redirects + 1);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        let dl = 0; const total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (c) => { dl += c.length; if (total > 0) process.stdout.write(`\r  Downloading... ${Math.floor(dl/total*100)}% (${(dl/1048576).toFixed(1)}MB)`); });
        res.pipe(file);
        file.on('finish', () => { file.close(); console.log(''); resolve(); });
      }).on('error', reject);
    };
    download(url);
  });
}

async function ensureCloudflared() {
  let cf = findCloudflared();
  if (cf) {
    const ver = execSync(`"${cf}" --version`, {encoding:'utf8',timeout:5000}).trim().split('\n')[0];
    STATE.cloudflaredVersion = ver;
    log(`cloudflared: ${ver}`);
    return cf;
  }
  warn('cloudflared not found. Downloading...');
  const isWin = process.platform === 'win32';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const filename = isWin ? 'cloudflared.exe' : 'cloudflared';
  const dest = path.join(os.homedir(), filename);
  const dlUrl = isWin
    ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`
    : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  try {
    await downloadFile(dlUrl, dest);
    if (!isWin) fs.chmodSync(dest, 0o755);
    log(`cloudflared saved to ${dest}`);
    const ver = execSync(`"${dest}" --version`, {encoding:'utf8',timeout:5000}).trim().split('\n')[0];
    STATE.cloudflaredVersion = ver;
    return dest;
  } catch (e) {
    err(`Failed to download: ${e.message}`);
    err('Install manually: winget install Cloudflare.cloudflared');
    STATE.phase = 'error';
    STATE.error = 'Failed to download cloudflared';
    return null;
  }
}

function killAllCloudflared() {
  try {
    if (process.platform === 'win32') execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'pipe' });
    else execSync('pkill -f "cloudflared tunnel" 2>/dev/null || true', { stdio: 'pipe' });
  } catch {}
}

// ============================================
//  LM Studio health
// ============================================
async function checkLMStudioOk() {
  for (const ep of ['/api/v1/models', '/v1/models']) {
    const { status } = await httpGet(`http://localhost:${CONFIG.lmstudioPort}${ep}`, 5000);
    if (status === 200) return true;
  }
  return false;
}

async function waitForLMStudio() {
  STATE.phase = 'waiting_lmstudio';
  STATE.lmstudio = false;
  log(`Waiting for LM Studio on port ${CONFIG.lmstudioPort}...`);
  while (!shuttingDown) {
    if (await checkLMStudioOk()) {
      STATE.lmstudio = true;
      log('LM Studio is running');
      return;
    }
    await sleep(3000);
  }
}

// ============================================
//  Tunnel lifecycle
// ============================================
async function startSingleAttempt(cfBin) {
  tunnelLogFile = path.join(os.tmpdir(), `amina-tunnel-${Date.now()}.log`);
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(tunnelLogFile);
    let resolved = false;
    let foundUrl = '';
    
    // Try without --protocol flag first (more compatible)
    tunnelProcess = spawn(cfBin, ['tunnel', '--url', `http://localhost:${CONFIG.lmstudioPort}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    
    // URL patterns cloudflared can output
    const urlRegex = /https:\/\/[-a-zA-Z0-9]+[-a-zA-Z0-9.]*\.trycloudflare\.com/;
    
    // Capture output directly (more reliable than file reading)
    const handleData = (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      const match = text.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        foundUrl = match[0];
        resolve(foundUrl);
      }
    };
    
    tunnelProcess.stdout.on('data', handleData);
    tunnelProcess.stderr.on('data', handleData);
    
    tunnelProcess.on('error', (e) => {
      err(`cloudflared process error: ${e.message}`);
      if (!resolved) { resolved = true; resolve(null); }
    });
    
    tunnelProcess.on('exit', (code) => {
      if (!resolved) {
        // Process exited before we got URL — read log file as fallback
        try {
          const content = fs.readFileSync(tunnelLogFile, 'utf8');
          const match = content.match(urlRegex);
          if (match) { resolved = true; resolve(match[0]); return; }
          // Show last lines for debugging
          const lines = content.trim().split('\n').slice(-5);
          if (lines.length > 0) {
            warn(`cloudflared exited (code ${code}). Last output:`);
            lines.forEach(l => dim(`  ${l.trim()}`));
          }
        } catch {}
        resolved = true;
        resolve(null);
      }
    });
    
    // Timeout — also try file-based extraction as fallback
    let elapsed = 0;
    const poll = setInterval(() => {
      elapsed++;
      if (resolved) { clearInterval(poll); return; }
      if (elapsed > CONFIG.tunnelUrlTimeout) {
        clearInterval(poll);
        if (!resolved) {
          // Last attempt from file
          try {
            const content = fs.readFileSync(tunnelLogFile, 'utf8');
            const match = content.match(urlRegex);
            if (match) { resolved = true; resolve(match[0]); return; }
            warn(`Timeout (${CONFIG.tunnelUrlTimeout}s). cloudflared log:`);
            const lines = content.trim().split('\n').slice(-8);
            lines.forEach(l => dim(`  ${l.trim()}`));
          } catch {}
          if (tunnelProcess && !tunnelProcess.killed) { tunnelProcess.kill(); tunnelProcess = null; }
          resolved = true;
          resolve(null);
        }
        return;
      }
      // Periodic file check as backup
      if (elapsed % 5 === 0 && !resolved) {
        try {
          const content = fs.readFileSync(tunnelLogFile, 'utf8');
          const match = content.match(urlRegex);
          if (match) { clearInterval(poll); resolved = true; resolve(match[0]); }
        } catch {}
      }
    }, 1000);
  });
}

async function registerUrl(url) {
  const { status, body } = await httpPost(`${CONFIG.botApiUrl}/api/tunnel/register`, { url },
    { 'X-Amina-Tunnel-Token': CONFIG.tunnelToken });
  try {
    const json = JSON.parse(body);
    if ((status === 200 || status === 201) && json.success) return true;
    if (json.error) warn(`Bot registration error: ${json.error}`);
    return false;
  } catch { return false; }
}

async function sendHeartbeat() {
  const { status, body } = await httpPost(`${CONFIG.botApiUrl}/api/tunnel/heartbeat`, { url: currentUrl },
    { 'X-Amina-Tunnel-Token': CONFIG.tunnelToken });
  if (status === 200 || status === 201) {
    try { if (JSON.parse(body).success) return 'ok'; } catch {}
    return 'ok';
  }
  if (status === 0) return 'no_response';
  try { const json = JSON.parse(body); if (json.error) warn(`Heartbeat error: ${json.error}`); } catch {}
  return 'unhealthy';
}

async function startTunnel(cfBin) {
  STATE.phase = 'starting_tunnel';
  STATE.tunnel = false;
  STATE.tunnelUrl = '';
  STATE.botRegistered = false;
  log(`Starting cloudflared tunnel -> localhost:${CONFIG.lmstudioPort}`);
  killAllCloudflared();
  await sleep(2000); // Wait for port to free up
  for (let attempt = 1; attempt <= CONFIG.startRetries; attempt++) {
    if (shuttingDown) return false;
    log(`Attempt ${attempt}/${CONFIG.startRetries}...`);
    const url = await startSingleAttempt(cfBin);
    if (!url) {
      warn('Failed to extract tunnel URL');
      killAllCloudflared();
      if (attempt < CONFIG.startRetries) { warn(`Retrying in ${CONFIG.restartDelay}s...`); await sleep(CONFIG.restartDelay * 1000); }
      continue;
    }
    currentUrl = url; unhealthyCount = 0;
    STATE.tunnel = true;
    STATE.tunnelUrl = currentUrl;
    log(`Tunnel URL: ${currentUrl}`);
    log(`Registering with bot at ${CONFIG.botApiUrl}...`);
    if (await registerUrl(currentUrl)) {
      STATE.botRegistered = true;
      log('Registered successfully');
    } else {
      warn('Registration failed. Will retry via heartbeat.');
    }
    STATE.phase = 'connected';
    return true;
  }
  err(`Failed to start tunnel after ${CONFIG.startRetries} attempts`);
  STATE.phase = 'error';
  STATE.error = 'Failed to start tunnel';
  return false;
}

async function monitorTunnel() {
  log(`Monitoring (health every ${CONFIG.healthInterval}s)...`);
  while (!shuttingDown) {
    await sleep(CONFIG.healthInterval * 1000);
    if (shuttingDown) return 0;
    const ts = new Date().toLocaleTimeString();
    if (!tunnelProcess || tunnelProcess.exitCode !== null) {
      warn('cloudflared died');
      tunnelProcess = null; STATE.tunnel = false; STATE.phase = 'error';
      return 1;
    }
    const lmOk = await checkLMStudioOk();
    STATE.lmstudio = lmOk;
    if (!lmOk) {
      warn('LM Studio went offline');
      if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill();
      tunnelProcess = null; STATE.tunnel = false;
      return 2;
    }
    const hb = await sendHeartbeat();
    STATE.lastHeartbeat = new Date().toISOString();
    if (hb === 'ok') {
      unhealthyCount = 0; STATE.botRegistered = true;
      dim(`${ts} tunnel: ok | lmstudio: ok | bot: ok`);
    } else if (hb === 'unhealthy') {
      unhealthyCount++; STATE.botRegistered = false;
      warn(`${ts} tunnel: ok | lmstudio: ok | bot: UNHEALTHY (${unhealthyCount}/${CONFIG.unhealthyThreshold})`);
      if (unhealthyCount >= CONFIG.unhealthyThreshold) {
        err('Restarting tunnel...');
        if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill();
        tunnelProcess = null; STATE.tunnel = false;
        return 3;
      }
    } else {
      dim(`${ts} tunnel: ok | lmstudio: ok | bot: no response`);
    }
  }
  return 0;
}

// ============================================
//  Dashboard HTML
// ============================================
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amina Tunnel</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a26;--border:#2a2a3a;
    --text:#e0e0e8;--text2:#8888a0;
    --cyan:#00e5ff;--green:#00e676;--red:#ff5252;--yellow:#ffd740;--purple:#b388ff;
  }
  body{background:var(--bg);color:var(--text);font-family:'Outfit',sans-serif;min-height:100vh}
  .bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:linear-gradient(rgba(0,229,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,.03) 1px,transparent 1px);
    background-size:40px 40px}
  .container{max-width:900px;margin:0 auto;padding:30px 20px;position:relative;z-index:1}
  .header{text-align:center;margin-bottom:36px}
  .header h1{font-family:'JetBrains Mono',monospace;font-size:28px;font-weight:700;letter-spacing:2px;
    background:linear-gradient(135deg,var(--cyan),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
  .header .sub{color:var(--text2);font-size:14px;font-weight:300}
  .phase-bar{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:28px;padding:14px;
    background:var(--bg2);border:1px solid var(--border);border-radius:12px}
  .phase-dot{width:12px;height:12px;border-radius:50%;animation:pulse 2s infinite}
  .phase-dot.green{background:var(--green);box-shadow:0 0 20px rgba(0,230,118,.3)}
  .phase-dot.yellow{background:var(--yellow);box-shadow:0 0 20px rgba(255,215,64,.3)}
  .phase-dot.red{background:var(--red);box-shadow:0 0 20px rgba(255,82,82,.3)}
  .phase-dot.cyan{background:var(--cyan);box-shadow:0 0 20px rgba(0,229,255,.3);animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .phase-text{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:500}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
  @media(max-width:700px){.cards{grid-template-columns:1fr}}
  .card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px;position:relative;
    overflow:hidden;transition:border-color .3s,box-shadow .3s}
  .card:hover{border-color:var(--cyan);box-shadow:0 0 30px rgba(0,229,255,.08)}
  .card .label{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text2);margin-bottom:10px;font-weight:600}
  .card .value{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600}
  .card .icon{position:absolute;top:16px;right:16px;font-size:20px;opacity:.6}
  .sb{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace}
  .sb.on{background:rgba(0,230,118,.12);color:var(--green);border:1px solid rgba(0,230,118,.25)}
  .sb.off{background:rgba(255,82,82,.12);color:var(--red);border:1px solid rgba(255,82,82,.25)}
  .sb.wait{background:rgba(255,215,64,.12);color:var(--yellow);border:1px solid rgba(255,215,64,.25)}
  .sb .d{width:7px;height:7px;border-radius:50%}
  .sb.on .d{background:var(--green)}.sb.off .d{background:var(--red)}.sb.wait .d{background:var(--yellow);animation:pulse 1.5s infinite}
  .url-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:28px;
    display:flex;align-items:center;gap:14px}
  .url-card .label{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text2);font-weight:600;white-space:nowrap}
  .url-card .url{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--cyan);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .url-card .url a{color:var(--cyan);text-decoration:none}
  .url-card .url a:hover{text-decoration:underline}
  .cbtn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;
    cursor:pointer;font-size:12px;font-family:'JetBrains Mono',monospace;transition:all .2s}
  .cbtn:hover{border-color:var(--cyan);color:var(--cyan)}
  .log-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .log-header h2{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--text2);font-weight:500;text-transform:uppercase;letter-spacing:1.5px}
  .log-box{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px;height:320px;
    overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.8}
  .log-box::-webkit-scrollbar{width:6px}.log-box::-webkit-scrollbar-track{background:transparent}
  .log-box::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
  .ll{display:flex;gap:10px}.lt{color:var(--text2);flex-shrink:0}
  .lm{white-space:pre-wrap;word-break:break-all}
  .lm.info{color:var(--green)}.lm.warn{color:var(--yellow)}.lm.error{color:var(--red)}.lm.dim{color:var(--text2)}
  .footer{text-align:center;padding:20px 0;color:var(--text2);font-size:12px}
  .footer a{color:var(--cyan);text-decoration:none}
  .settings-bar{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:20px;
    display:flex;align-items:center;justify-content:space-between}
  .setting-item{display:flex;align-items:center;gap:12px}
  .setting-label{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--text2)}
  .toggle{position:relative;width:44px;height:24px;display:inline-block}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;cursor:pointer;inset:0;background:var(--bg3);border:1px solid var(--border);border-radius:24px;transition:.3s}
  .slider:before{content:'';position:absolute;height:18px;width:18px;left:2px;bottom:2px;background:var(--text2);border-radius:50%;transition:.3s}
  .toggle input:checked+.slider{background:rgba(0,229,255,.2);border-color:var(--cyan)}
  .toggle input:checked+.slider:before{transform:translateX(20px);background:var(--cyan)}
</style>
</head>
<body>
<div class="bg-grid"></div>
<div class="container">
  <div class="header">
    <h1>AMINA TUNNEL</h1>
    <div class="sub">LM Studio &rarr; Cloudflare &rarr; Amina Bot</div>
  </div>
  <div class="phase-bar">
    <div class="phase-dot cyan" id="pd"></div>
    <div class="phase-text" id="pt">Запуск...</div>
  </div>
  <div class="cards">
    <div class="card">
      <div class="label">LM Studio</div><div class="icon">&#129504;</div>
      <div class="value" id="lm"></div>
    </div>
    <div class="card">
      <div class="label">Cloudflare Tunnel</div><div class="icon">&#127760;</div>
      <div class="value" id="cf"></div>
    </div>
    <div class="card">
      <div class="label">Amina Bot</div><div class="icon">&#129302;</div>
      <div class="value" id="bot"></div>
    </div>
  </div>
  <div class="url-card" id="uc" style="display:none">
    <div class="label">Tunnel URL</div>
    <div class="url" id="tu"></div>
    <button class="cbtn" onclick="copyUrl()">Copy</button>
  </div>
  <div class="log-header"><h2>Live Log</h2></div>
  <div class="log-box" id="lb"></div>
  <div class="settings-bar">
    <div class="setting-item">
      <span class="setting-label">Автозапуск с Windows</span>
      <label class="toggle"><input type="checkbox" id="as" onchange="toggleAutostart(this.checked)"><span class="slider"></span></label>
    </div>
  </div>
  <div class="footer">Amina LM Studio Tunnel &middot; <a href="https://amina.vibecoding.by" target="_blank">amina.vibecoding.by</a></div>
</div>
<script>
const PM={starting:{d:'cyan',t:'Запуск...'},waiting_lmstudio:{d:'yellow',t:'Ожидание LM Studio...'},
  starting_tunnel:{d:'cyan',t:'Подключение туннеля...'},connected:{d:'green',t:'Подключено'},error:{d:'red',t:'Ошибка'}};
function B(s,t){const c=s==='on'?'on':s==='off'?'off':'wait';return '<span class="sb '+c+'"><span class="d"></span> '+t+'</span>';}
function U(s){
  const p=PM[s.phase]||PM.starting;
  document.getElementById('pd').className='phase-dot '+p.d;
  document.getElementById('pt').textContent=p.t;
  document.getElementById('lm').innerHTML=s.lmstudio?B('on','Online'):B('off','Offline');
  document.getElementById('cf').innerHTML=s.tunnel?B('on','Active'):s.phase==='starting_tunnel'?B('wait','Starting...'):B('off','Inactive');
  document.getElementById('bot').innerHTML=s.botRegistered?B('on','Registered'):s.phase==='connected'?B('wait','Pending...'):B('off','Not connected');
  const uc=document.getElementById('uc');
  if(s.tunnelUrl){uc.style.display='flex';document.getElementById('tu').innerHTML='<a href="'+s.tunnelUrl+'" target="_blank">'+s.tunnelUrl+'</a>';}
  else{uc.style.display='none';}
}
function copyUrl(){const u=document.getElementById('tu').textContent;navigator.clipboard.writeText(u).then(()=>{const b=document.querySelector('.cbtn');b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',1500);});}
const lb=document.getElementById('lb');let as=true;
lb.addEventListener('scroll',()=>{as=lb.scrollTop+lb.clientHeight>=lb.scrollHeight-30;});
function A(e){const d=document.createElement('div');d.className='ll';const t=new Date(e.ts).toLocaleTimeString();
  d.innerHTML='<span class="lt">'+t+'</span><span class="lm '+e.level+'">'+e.msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span>';
  lb.appendChild(d);if(lb.children.length>200)lb.removeChild(lb.firstChild);if(as)lb.scrollTop=lb.scrollHeight;}
async function poll(){try{const r=await fetch('/api/state');U(await r.json());}catch{}}
setInterval(poll,2000);poll();
const sse=new EventSource('/api/logs/stream');
sse.onmessage=(e)=>{try{A(JSON.parse(e.data));}catch{}};
(async()=>{try{const r=await fetch('/api/logs');(await r.json()).forEach(A);}catch{}})();
async function toggleAutostart(enabled){
  try{await fetch('http://127.0.0.1:9877/api/autostart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  }catch{document.getElementById('as').checked=!enabled;}
}
(async()=>{try{const r=await fetch('http://127.0.0.1:9877/api/autostart');const d=await r.json();document.getElementById('as').checked=d.enabled;}catch{}})();
</script>
</body>
</html>`;
}

// ============================================
//  Dashboard server
// ============================================
function startDashboard() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(STATE));
      return;
    }
    if (req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logBuffer));
      return;
    }
    if (req.url === '/api/logs/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      sseClients.push(res);
      req.on('close', () => { const i = sseClients.indexOf(res); if (i !== -1) sseClients.splice(i, 1); });
      return;
    }
    res.writeHead(404); res.end('Not found');
  });
  server.listen(CONFIG.dashboardPort, '127.0.0.1', () => {
    log(`Dashboard: http://localhost:${CONFIG.dashboardPort}`);
  });
  return server;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'pipe' });
    else if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'pipe' });
    else execSync(`xdg-open "${url}"`, { stdio: 'pipe' });
  } catch {}
}

// ============================================
//  Utils & Main
// ============================================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cleanup() {
  shuttingDown = true; log('Shutting down...');
  if (tunnelProcess && tunnelProcess.exitCode === null) { tunnelProcess.kill(); log('cloudflared stopped'); }
  if (tunnelLogFile && fs.existsSync(tunnelLogFile)) try { fs.unlinkSync(tunnelLogFile); } catch {}
  process.exit(0);
}

async function main() {
  console.log('');
  console.log(C.cyan('============================================'));
  console.log(C.cyan('  Amina LM Studio Tunnel Supervisor'));
  console.log(C.cyan('============================================'));
  console.log('');
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  loadEnvFile();
  applyConfig();

  if (!CONFIG.tunnelToken) {
    err('LMSTUDIO_TUNNEL_TOKEN not set');
    STATE.phase = 'error'; STATE.error = 'No tunnel token';
    process.exit(1);
  }

  // Start dashboard & open browser
  startDashboard();
  if (!process.versions.electron) {
    setTimeout(() => openBrowser(`http://localhost:${CONFIG.dashboardPort}`), 1000);
  }

  const cfBin = await ensureCloudflared();
  if (!cfBin) { await sleep(30000); process.exit(1); }

  while (!shuttingDown) {
    await waitForLMStudio();
    if (shuttingDown) break;
    if (await startTunnel(cfBin)) {
      const reason = await monitorTunnel();
      if (reason === 0) return;
      if (reason === 2) { log('LM Studio offline - waiting...'); continue; }
      if (reason === 3) { warn('Tunnel URL expired - getting new one...'); await sleep(CONFIG.restartDelay * 1000); continue; }
      warn(`Tunnel crashed - restarting in ${CONFIG.restartDelay}s...`);
      await sleep(CONFIG.restartDelay * 1000);
    } else { warn(`Retrying in ${CONFIG.restartDelay}s...`); await sleep(CONFIG.restartDelay * 1000); }
  }
}

main().catch((e) => { err(`Fatal: ${e.message}`); process.exit(1); });
