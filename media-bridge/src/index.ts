/**
 * Amina Media Bridge — основной сервер
 *
 * HTTP API:
 *   GET  /health           — статус
 *   POST /                 — запуск сессии (от Amina bot)
 *   POST /session/:id/hangup — завершить звонок
 *
 * WebSocket:
 *   ws://host:PORT/audio   — аудио-стрим от FreeSWITCH (mod_audio_fork)
 *
 * ESL:
 *   Подключение к FreeSWITCH Event Socket для управления звонками
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { EslConnection } from './esl.js';
import { SessionManager, type BridgeSession } from './session-manager.js';
import { log } from './logger.js';

// ─── Конфигурация ───────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] || '3100', 10);
const ESL_HOST = process.env['ESL_HOST'] || '127.0.0.1';
const ESL_PORT = parseInt(process.env['ESL_PORT'] || '8022', 10);
const ESL_PASSWORD = process.env['ESL_PASSWORD'] || 'ClueCon';
const BRIDGE_TOKEN = process.env['BRIDGE_TOKEN'] || 'amina-bridge-secret';
const AMINA_BOT_URL = process.env['AMINA_BOT_URL'] || 'https://amina.vibecoding.by';

// ─── Менеджер сессий ────────────────────────────────────────

const sessions = new SessionManager();

// ─── ESL подключение ────────────────────────────────────────

const esl = new EslConnection(ESL_HOST, ESL_PORT, ESL_PASSWORD);

// ─── HTTP Сервер ────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function verifyAuth(req: IncomingMessage): boolean {
  const auth = req.headers['authorization'];
  if (!auth) return false;
  return auth === `Bearer ${BRIDGE_TOKEN}`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const method = req.method?.toUpperCase() || 'GET';

  // ── Health ──
  if (method === 'GET' && url.pathname === '/health') {
    const eslConnected = esl.isConnected();
    const activeSessions = sessions.count();

    json(res, 200, {
      status: eslConnected ? 'ok' : 'degraded',
      freeswitch: eslConnected ? 'connected' : 'disconnected',
      activeSessions,
      uptime: process.uptime(),
    });
    return;
  }

  // ── Запуск сессии (от Amina) ──
  if (method === 'POST' && url.pathname === '/') {
    if (!verifyAuth(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const session = sessions.create({
        sessionId: body.sessionId,
        phone: body.phone,
        task: body.task,
        scenario: body.scenario,
        plan: body.plan,
        initialAgentText: body.initialAgentText,
        callbacks: body.callbacks,
        voice: body.voice,
        speech: body.speech,
        telephony: body.telephony,
        latencyBudgetMs: body.latencyBudgetMs ?? 1800,
      });

      log.info(`Сессия создана: ${session.id} → ${session.phone}`);

      // Отправляем событие в Amina
      void notifyAmina(session, 'bridgeSessionStarted');

      json(res, 200, {
        requestId: session.id,
        bridgeSessionId: session.id,
        accepted: true,
        mode: 'realtime',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Ошибка создания сессии: ${msg}`);
      json(res, 400, { error: msg });
    }
    return;
  }

  // ── Статус сессии ──
  if (method === 'GET' && url.pathname.startsWith('/session/')) {
    const sessionId = url.pathname.split('/')[2];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      json(res, 404, { error: 'Session not found' });
      return;
    }
    json(res, 200, { session });
    return;
  }

  // ── Завершить звонок ──
  if (method === 'POST' && url.pathname.match(/^\/session\/[^/]+\/hangup$/)) {
    if (!verifyAuth(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    const sessionId = url.pathname.split('/')[2]!;
    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 404, { error: 'Session not found' });
      return;
    }

    if (session.fsUuid) {
      await esl.hangup(session.fsUuid);
    }
    sessions.complete(sessionId, 'hangup_by_bridge');
    void notifyAmina(session, 'callCompleted');

    json(res, 200, { success: true });
    return;
  }

  // ── Список активных сессий ──
  if (method === 'GET' && url.pathname === '/sessions') {
    json(res, 200, { sessions: sessions.list() });
    return;
  }

  json(res, 404, { error: 'Not found' });
}

// ─── Callbacks в Amina ──────────────────────────────────────

async function notifyAmina(session: BridgeSession, eventType: string, extra?: Record<string, unknown>): Promise<void> {
  const eventsUrl = session.callbacks?.eventsUrl;
  if (!eventsUrl) return;

  try {
    const response = await fetch(eventsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        eventType,
        requestId: session.id,
        ...extra,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.warn(`Amina callback ${eventType} вернул ${response.status}`);
    }
  } catch (error) {
    log.warn(`Amina callback ${eventType} не доставлен: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── WebSocket сервер для аудио ─────────────────────────────

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    log.error(`HTTP ошибка: ${error instanceof Error ? error.message : String(error)}`);
    json(res, 500, { error: 'Internal server error' });
  }
});

const wss = new WebSocketServer({ server, path: '/audio' });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const callUuid = url.searchParams.get('uuid') || 'unknown';

  log.info(`[WS] Аудио подключение: uuid=${callUuid}`);

  // Найти сессию по FreeSWITCH UUID
  const session = sessions.findByFsUuid(callUuid);
  if (session) {
    session.wsConnected = true;
    log.info(`[WS] Сессия ${session.id} привязана к uuid=${callUuid}`);
  }

  let audioChunks = 0;
  let totalBytes = 0;

  ws.on('message', (data: Buffer) => {
    audioChunks++;
    totalBytes += data.length;

    // Каждые 100 чанков — лог для отладки
    if (audioChunks % 100 === 0) {
      log.debug(`[WS] uuid=${callUuid}: ${audioChunks} чанков, ${(totalBytes / 1024).toFixed(1)}KB`);
    }

    // TODO (Сессия 3): VAD → Whisper STT → отправить в Amina respond callback
    // TODO (Сессия 3): Получить AI ответ → ElevenLabs TTS → отправить PCM обратно в ws
  });

  ws.on('close', () => {
    log.info(`[WS] Аудио отключение: uuid=${callUuid}, чанков=${audioChunks}, ${(totalBytes / 1024).toFixed(1)}KB`);
    if (session) {
      session.wsConnected = false;
      // Если звонок ещё активен — завершаем сессию
      if (session.status === 'active') {
        sessions.complete(session.id, 'ws_disconnected');
        void notifyAmina(session, 'callCompleted');
      }
    }
  });

  ws.on('error', (err) => {
    log.error(`[WS] Ошибка uuid=${callUuid}: ${err.message}`);
  });
});

// ─── ESL события от FreeSWITCH ─────────────────────────────

esl.on('channel_answer', (event) => {
  const uuid = event.uuid;
  const callerNumber = event.callerNumber;
  log.info(`[ESL] Звонок отвечен: uuid=${uuid}, caller=${callerNumber}`);

  // Привязать UUID к сессии по номеру телефона
  const session = sessions.findByPhone(callerNumber);
  if (session) {
    session.fsUuid = uuid;
    session.status = 'active';
    void notifyAmina(session, 'callConnected', { callId: uuid });
  }
});

esl.on('channel_hangup', (event) => {
  const uuid = event.uuid;
  const cause = event.hangupCause;
  log.info(`[ESL] Звонок завершён: uuid=${uuid}, cause=${cause}`);

  const session = sessions.findByFsUuid(uuid);
  if (session && session.status !== 'completed') {
    sessions.complete(session.id, cause || 'remote_hangup');
    void notifyAmina(session, 'callCompleted', { callId: uuid });
  }
});

// ─── Запуск ─────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  log.info(`═══════════════════════════════════════════════`);
  log.info(`  Amina Media Bridge v0.1.0`);
  log.info(`  HTTP/WS: http://0.0.0.0:${PORT}`);
  log.info(`  ESL: ${ESL_HOST}:${ESL_PORT}`);
  log.info(`  Amina: ${AMINA_BOT_URL}`);
  log.info(`═══════════════════════════════════════════════`);

  // Подключаемся к FreeSWITCH ESL
  esl.connect();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('Получен SIGTERM, завершение...');
  esl.disconnect();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('Получен SIGINT, завершение...');
  esl.disconnect();
  wss.close();
  server.close();
  process.exit(0);
});
