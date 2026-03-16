#!/usr/bin/env node
/**
 * Amina LM Studio Tunnel Supervisor
 * Standalone exe — just run it, it handles everything.
 *
 * 1. Reads config from .env or prompts interactively
 * 2. Downloads cloudflared if missing
 * 3. Waits for LM Studio on localhost
 * 4. Starts cloudflared quick tunnel
 * 5. Registers tunnel URL with Amina bot
 * 6. Monitors health, restarts on failure
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const os = require('os');

// ============================================
//  Colors
// ============================================
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const log = (msg) => console.log(`${C.green('[tunnel]')} ${msg}`);
const warn = (msg) => console.log(`${C.yellow('[tunnel]')} ${msg}`);
const err = (msg) => console.log(`${C.red('[tunnel]')} ${msg}`);
const dim = (msg) => console.log(`${C.dim('[tunnel]')} ${msg}`);

// ============================================
//  Config
// ============================================
const CONFIG = {
  botApiUrl: 'https://amina.vibecoding.by',
  tunnelToken: '',
  lmstudioPort: 1234,
  healthInterval: 30,
  tunnelUrlTimeout: 30,
  restartDelay: 5,
  startRetries: 3,
  unhealthyThreshold: 3,
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
  if (process.env.HEALTH_INTERVAL) CONFIG.healthInterval = parseInt(process.env.HEALTH_INTERVAL, 10);
}

// ============================================
//  Interactive setup
// ============================================
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function interactiveSetup() {
  console.log('');
  console.log(C.cyan('============================================'));
  console.log(C.cyan('  Amina LM Studio Tunnel - First Setup'));
  console.log(C.cyan('============================================'));
  console.log('');
  console.log('No .env file found. Let\'s configure the tunnel.\n');

  const token = await ask('Tunnel token (LMSTUDIO_TUNNEL_TOKEN): ');
  if (!token) { err('Token is required. Ask the bot administrator.'); process.exit(1); }
  const botUrl = (await ask(`Bot URL [${CONFIG.botApiUrl}]: `)) || CONFIG.botApiUrl;
  const port = (await ask(`LM Studio port [${CONFIG.lmstudioPort}]: `)) || String(CONFIG.lmstudioPort);

  const envContent = `BOT_API_URL=${botUrl}\nLMSTUDIO_TUNNEL_TOKEN=${token}\nLMSTUDIO_PORT=${port}\n`;
  const envPath = path.join(process.cwd(), '.env');
  fs.writeFileSync(envPath, envContent, 'utf8');
  log(`Config saved to ${envPath}\n`);
  CONFIG.botApiUrl = botUrl;
  CONFIG.tunnelToken = token;
  CONFIG.lmstudioPort = parseInt(port, 10);
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
  const candidates = ['cloudflared', 'cloudflared.exe',
    path.join(process.cwd(), 'cloudflared.exe'),
    path.join(path.dirname(process.execPath), 'cloudflared.exe'),
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
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
  if (cf) { log(`cloudflared: ${execSync(`"${cf}" --version`, {encoding:'utf8',timeout:5000}).trim().split('\n')[0]}`); return cf; }
  warn('cloudflared not found. Downloading...');
  const isWin = process.platform === 'win32';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const filename = isWin ? 'cloudflared.exe' : 'cloudflared';
  const dest = path.join(process.cwd(), filename);
  const dlUrl = isWin
    ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`
    : `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  try {
    await downloadFile(dlUrl, dest);
    if (!isWin) fs.chmodSync(dest, 0o755);
    log(`cloudflared saved to ${dest}`);
    return dest;
  } catch (e) {
    err(`Failed to download: ${e.message}`);
    err('Install manually: winget install Cloudflare.cloudflared');
    process.exit(1);
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
  log(`Waiting for LM Studio on port ${C.cyan(String(CONFIG.lmstudioPort))}...`);
  while (!shuttingDown) {
    if (await checkLMStudioOk()) { log('LM Studio is running'); return; }
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
    tunnelProcess = spawn(cfBin, ['tunnel', '--url', `http://localhost:${CONFIG.lmstudioPort}`, '--protocol', 'http2'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProcess.stdout.pipe(logStream);
    tunnelProcess.stderr.pipe(logStream);
    tunnelProcess.on('error', () => resolve(null));
    tunnelProcess.on('exit', () => { if (!currentUrl) resolve(null); });
    let elapsed = 0;
    const poll = setInterval(() => {
      elapsed++;
      if (elapsed > CONFIG.tunnelUrlTimeout) {
        clearInterval(poll);
        if (tunnelProcess && !tunnelProcess.killed) { tunnelProcess.kill(); tunnelProcess = null; }
        resolve(null);
        return;
      }
      try {
        const content = fs.readFileSync(tunnelLogFile, 'utf8');
        const match = content.match(/https:\/\/[a-zA-Z0-9]+-[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com/);
        if (match) { clearInterval(poll); resolve(match[0]); }
      } catch {}
    }, 1000);
  });
}

async function registerUrl(url) {
  const { status, body } = await httpPost(`${CONFIG.botApiUrl}/api/tunnel/register`, { url },
    { 'X-Amina-Tunnel-Token': CONFIG.tunnelToken });
  try { return (status === 200 || status === 201) && JSON.parse(body).success; } catch { return false; }
}

async function sendHeartbeat() {
  const { status } = await httpPost(`${CONFIG.botApiUrl}/api/tunnel/heartbeat`, { url: currentUrl },
    { 'X-Amina-Tunnel-Token': CONFIG.tunnelToken });
  if (status === 200 || status === 201) return 'ok';
  if (status === 0) return 'no_response';
  return 'unhealthy';
}

async function startTunnel(cfBin) {
  log(`Starting cloudflared tunnel -> localhost:${CONFIG.lmstudioPort}`);
  killAllCloudflared();
  await sleep(1000);
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
    log(`Tunnel URL: ${C.cyan(currentUrl)}`);
    log(`Registering with bot at ${CONFIG.botApiUrl}...`);
    if (await registerUrl(currentUrl)) log('Registered successfully');
    else warn('Registration failed. Will retry via heartbeat.');
    return true;
  }
  err(`Failed to start tunnel after ${CONFIG.startRetries} attempts`);
  return false;
}

async function monitorTunnel() {
  log(`Monitoring (health every ${CONFIG.healthInterval}s)...`);
  console.log('');
  log('=== Tunnel active ===');
  log(`  LM Studio:  http://localhost:${CONFIG.lmstudioPort}`);
  log(`  Tunnel URL:  ${C.cyan(currentUrl)}`);
  log(`  Bot API:     ${CONFIG.botApiUrl}`);
  log('  Press Ctrl+C to stop');
  console.log('');
  while (!shuttingDown) {
    await sleep(CONFIG.healthInterval * 1000);
    if (shuttingDown) return 0;
    const ts = new Date().toLocaleTimeString();
    if (!tunnelProcess || tunnelProcess.exitCode !== null) { warn('cloudflared died'); tunnelProcess = null; return 1; }
    if (!(await checkLMStudioOk())) { warn('LM Studio went offline'); if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill(); tunnelProcess = null; return 2; }
    const hb = await sendHeartbeat();
    if (hb === 'ok') { unhealthyCount = 0; dim(`${ts} tunnel: ok | lmstudio: ok | bot: ok`); }
    else if (hb === 'unhealthy') {
      unhealthyCount++;
      warn(`${ts} tunnel: ok | lmstudio: ok | bot: UNHEALTHY (${unhealthyCount}/${CONFIG.unhealthyThreshold})`);
      if (unhealthyCount >= CONFIG.unhealthyThreshold) { err('Restarting tunnel...'); if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill(); tunnelProcess = null; return 3; }
    } else { dim(`${ts} tunnel: ok | lmstudio: ok | bot: no response`); }
  }
  return 0;
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

  const envLoaded = loadEnvFile();
  applyConfig();
  if (!CONFIG.tunnelToken) {
    if (!envLoaded) await interactiveSetup();
    else { err('LMSTUDIO_TUNNEL_TOKEN not set in .env'); process.exit(1); }
  }

  const cfBin = await ensureCloudflared();

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
