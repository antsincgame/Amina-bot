import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settingsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { config } from '../../config/index.js';
import { aiService } from '../../ai/openrouter.js';
import { requireAdminAuth, requireRealtimeBridgeAuth } from './middleware.js';
import {
  verifyWebhookToken,
  formatCallEvent,
  clearLiraXConfigCache,
  connectCall,
  getUsers as getLiraXUsers,
  getTelephonyUsers,
  addTelephonyUser,
  removeTelephonyUser,
  type LiraXEventPayload,
} from '../../features/telephony/lirax.js';
import {
  getTelephonyAiScenarios,
  saveTelephonyAiScenarios,
  previewTelephonyAiCall,
  startTelephonyAiCall,
  getTelephonyOwnerTelegramId,
} from '../../features/telephony/ai-scenarios.js';
import {
  getTelephonyAiCallSessions,
  linkTelephonyAiSessionCallId,
  failTelephonyAiCallByRequestId,
  processTelephonyAiCallRecording,
} from '../../features/telephony/ai-call-sessions.js';
import { getRealtimeBridgeStatus } from '../../features/telephony/service/realtime-bridge-config.js';
import { getTelephonyRuntimeConfig } from '../../features/telephony/service/telephony-runtime-config.js';
import { handleRealtimeBridgeEvent, respondToRealtimeBridge } from '../../features/telephony/service/realtime-bridge-service.js';
import { getTelephonySessionDetails } from '../../features/telephony/service/session-detail-service.js';
import type { TelephonyAiCallPlan, TelephonyAiScenario, TelephonyRuntimeMode } from '../../../../shared/types/telephony.js';
import type { AIMessage } from '../../../../shared/types/index.js';
import { buildPersonaSystemPrompt } from '../../ai/persona.js';
import { escapeHtml } from '../../features/telephony/shared.js';

export async function registerTelephonyRoutes(server: FastifyInstance): Promise<void> {
  // ============================================
  // LiraX Telephony Webhook
  // ============================================

  /**
   * POST /api/lirax (+ alias /api/telephony/webhook)
   */
  const liraxWebhookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const payload = request.body as Record<string, string>;
        const cmd = payload['cmd'];
        const incomingToken = payload['from_LiraX_token'] || payload['token'] || '';

        const tokenValid = await verifyWebhookToken(incomingToken);
        if (!tokenValid) {
          aiLogger.warn({ cmd, ip: request.ip }, '[LiraX webhook] Invalid token');
          return reply.code(401).send({ error: 'Invalid token' });
        }

        const { from_LiraX_token: _wht, ...safePayload } = payload;
        aiLogger.info({ cmd, payload: safePayload }, '[LiraX webhook] received');

        if (!cmd) {
          return reply.code(400).send({ error: 'Missing cmd' });
        }

        const sendTelegramNotification = async (text: string): Promise<void> => {
          const runtimeConfig = await getTelephonyRuntimeConfig();
          const adminChatId = runtimeConfig.adminChatId;
          if (!adminChatId) return;
          const token = config.telegram.token;
          if (!token) return;
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: adminChatId, text, parse_mode: 'HTML' }),
          }).catch((err) => aiLogger.warn({ err }, '[LiraX] Failed to send Telegram notification'));
        };

        switch (cmd) {
          case 'event': {
            const eventPayload = payload as unknown as LiraXEventPayload;
            const notifyEnabled = await settingsRepo.get('lirax_notify_calls');
            if (notifyEnabled !== 'false') {
              const message = formatCallEvent(eventPayload);
              await sendTelegramNotification(message);
            }

            if (eventPayload.type === 'out' && eventPayload.phone && eventPayload.callid) {
              await linkTelephonyAiSessionCallId(eventPayload.phone, eventPayload.callid);
            }
            break;
          }

          case 'record': {
            const recordLink = payload['record_link'];
            const callId = payload['callid'];
            if (recordLink) {
              const notifyEnabled = await settingsRepo.get('lirax_notify_records');
              if (notifyEnabled !== 'false') {
                await sendTelegramNotification(
                  `🎙 <b>Запись звонка готова</b>\n` +
                  `ID: <code>${escapeHtml(callId || '—')}</code>\n` +
                  `<a href="${escapeHtml(recordLink)}">Слушать запись</a>`,
                );
              }

              if (callId) {
                void processTelephonyAiCallRecording(callId, recordLink).catch((error) => {
                  aiLogger.error({ error, callId }, '[Telephony AI] Async record processing failed');
                });
              }
            }
            break;
          }

          case 'contact': {
            return reply.code(200).send({ contact_name: '', responsible: null });
          }

          case 'staton': {
            aiLogger.debug(
              { ext: payload['ext'], status: payload['status'] },
              '[LiraX] Operator status change',
            );
            break;
          }

          case 'makecall_finished': {
            const idMakecall = payload['id_makecall'];
            const success = payload['success'] === '1';
            aiLogger.info({ idMakecall, success }, '[LiraX] makeCall finished');

            if (!success) {
              if (idMakecall) {
                await failTelephonyAiCallByRequestId(idMakecall);
              }
              await sendTelegramNotification(
                `📵 <b>Звонок не состоялся</b>\n` +
                `ID: <code>${escapeHtml(idMakecall || '—')}</code>\n` +
                `Абонент не поднял трубку`,
              );
            }
            break;
          }

          case 'make2calls_finished': {
            const id = payload['id_make2calls'];
            const success = payload['success'] === '1';
            aiLogger.info({ id, success }, '[LiraX] make2Calls finished');
            if (!success && id) {
              await failTelephonyAiCallByRequestId(id);
            }
            break;
          }

          default:
            aiLogger.debug({ cmd }, '[LiraX webhook] Unhandled cmd');
        }

        return reply.code(200).send('OK');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, '[LiraX webhook] Error');
        return reply.code(500).send({ error: msg });
      }
  };

  server.post('/lirax', liraxWebhookHandler);
  server.post('/telephony/webhook', liraxWebhookHandler);

  /**
   * GET /api/lirax/status
   */
  server.get('/lirax/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const runtimeConfig = await getTelephonyRuntimeConfig();

      return reply.code(200).send({
        success: true,
        data: {
          configured: Boolean(runtimeConfig.liraxToken),
          url: runtimeConfig.liraxUrl,
          defaultExt: runtimeConfig.liraxDefaultExt || '—',
          operatorPhone: runtimeConfig.operatorPhone || '—',
          ownerChatId: runtimeConfig.ownerChatId || '—',
          webhookUrl: `${config.botUrl}/api/lirax`,
          hasWebhookToken: Boolean(runtimeConfig.liraxWebhookToken),
          sipServer: runtimeConfig.sipServer || '—',
          externalNumber: runtimeConfig.externalNumber || '—',
          hasSipCredentials: Boolean(runtimeConfig.sipServer && runtimeConfig.sipLogin && runtimeConfig.sipPassword),
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  /**
   * POST /api/lirax/reload-config
   */
  server.post('/lirax/reload-config', async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdminAuth(request, reply);
    if (!admin) {
      return;
    }

    clearLiraXConfigCache();
    aiLogger.info('LiraX config cache cleared via API');
    return reply.code(200).send({ success: true, message: 'LiraX config cache cleared' });
  });

  /**
   * GET /api/lirax/test-connection
   * Проверяет соединение с LiraX API — вызывает getUsers и возвращает результат.
   */
  server.get('/lirax/test-connection', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const runtimeConfig = await getTelephonyRuntimeConfig();
      if (!runtimeConfig.liraxToken) {
        return reply.code(200).send({
          success: false,
          error: 'LiraX API token не задан. Заполни настройки.',
        });
      }

      const startMs = Date.now();
      const users = await getLiraXUsers();
      const latencyMs = Date.now() - startMs;

      return reply.code(200).send({
        success: true,
        data: {
          connected: true,
          latencyMs,
          usersCount: users.length,
          users: users.map((u) => ({ id: u.id, name: u.Name, ext: u.ext, active: u.active })),
          apiUrl: runtimeConfig.liraxUrl,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      aiLogger.error({ error: msg }, '[LiraX] Test connection failed');
      return reply.code(200).send({
        success: false,
        error: msg,
        data: { connected: false },
      });
    }
  });

  /**
   * POST /api/lirax/test-call
   */
  server.post(
    '/lirax/test-call',
    async (
      request: FastifyRequest<{ Body: { phone: string; speech?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { phone, speech } = request.body as { phone: string; speech?: string };
        if (!phone) {
          return reply.code(400).send({ success: false, error: 'phone is required' });
        }

        const result = await connectCall(phone, speech);
        aiLogger.info({ phone, result }, '[LiraX] Test call initiated');

        return reply.code(200).send({ success: true, data: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, '[LiraX] Test call failed');
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  /**
   * GET /api/lirax/scenarios
   */
  server.get('/lirax/scenarios', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const scenarios = await getTelephonyAiScenarios();
      return reply.code(200).send({ success: true, data: scenarios });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  /**
   * POST /api/lirax/scenarios
   */
  server.post(
    '/lirax/scenarios',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const scenarios = request.body;
        if (!Array.isArray(scenarios)) {
          return reply.code(400).send({ success: false, error: 'Body must be an array' });
        }

        const saved = await saveTelephonyAiScenarios(scenarios as TelephonyAiScenario[]);
        aiLogger.info({ count: scenarios.length }, '[LiraX] Scenarios saved');

        return reply.code(200).send({ success: true, data: saved });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.get('/lirax/ai-calls/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const sessions = await getTelephonyAiCallSessions();
      return reply.code(200).send({ success: true, data: sessions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  server.get(
    '/lirax/ai-calls/sessions/:sessionId',
    async (
      request: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const details = await getTelephonySessionDetails(request.params.sessionId);
        if (!details) {
          return reply.code(404).send({ success: false, error: 'Session not found' });
        }

        return reply.code(200).send({ success: true, data: details });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.get('/telephony/realtime/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const status = await getRealtimeBridgeStatus();
      return reply.code(200).send({ success: true, data: status });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  server.post(
    '/lirax/ai-calls/preview',
    async (
      request: FastifyRequest<{ Body: { scenarioId: string; phone: string; task: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { scenarioId, phone, task } = request.body;
        if (!scenarioId || !phone || !task) {
          return reply
            .code(400)
            .send({ success: false, error: 'scenarioId, phone and task are required' });
        }

        const result = await previewTelephonyAiCall(scenarioId, task, phone);
        return reply.code(200).send({ success: true, data: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.post(
    '/lirax/ai-calls/start',
    async (
      request: FastifyRequest<{
        Body: {
          scenarioId: string;
          phone: string;
          task: string;
          ownerTelegramId?: string;
          plan?: TelephonyAiCallPlan;
          runtimeOverride?: TelephonyRuntimeMode;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { scenarioId, phone, task, ownerTelegramId, plan, runtimeOverride } = request.body;
        if (!scenarioId || !phone || !task) {
          return reply
            .code(400)
            .send({ success: false, error: 'scenarioId, phone and task are required' });
        }

        if (
          runtimeOverride
          && runtimeOverride !== 'scripted'
          && runtimeOverride !== 'hybrid'
          && runtimeOverride !== 'realtime'
        ) {
          return reply.code(400).send({ success: false, error: 'runtimeOverride is invalid' });
        }

        const effectiveOwnerId = ownerTelegramId?.trim() || await getTelephonyOwnerTelegramId();
        if (!effectiveOwnerId) {
          return reply
            .code(400)
            .send({ success: false, error: 'Set lirax_owner_chat_id or ownerTelegramId first' });
        }

        const result = await startTelephonyAiCall({
          scenarioId,
          phone,
          task,
          ownerTelegramId: effectiveOwnerId,
          initiatedBy: admin.email ?? admin.userId,
          plan,
          runtimeOverride,
        });

        return reply.code(200).send({ success: true, data: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.post(
    '/telephony/realtime/bridge/events',
    async (
      request: FastifyRequest<{ Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      try {
        if (!(await requireRealtimeBridgeAuth(request, reply))) {
          return;
        }

        const body = request.body ?? {};
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'].trim() : '';
        const eventType = typeof body['eventType'] === 'string' ? body['eventType'].trim() : '';
        if (!sessionId || !eventType) {
          return reply.code(400).send({ success: false, error: 'sessionId and eventType are required' });
        }

        const updatedSession = await handleRealtimeBridgeEvent({
          sessionId,
          eventType,
          providerEventId: typeof body['providerEventId'] === 'string' ? body['providerEventId'] : null,
          requestId: typeof body['requestId'] === 'string' ? body['requestId'] : null,
          callId: typeof body['callId'] === 'string' ? body['callId'] : null,
          transcript: typeof body['transcript'] === 'string' ? body['transcript'] : null,
          replyText: typeof body['replyText'] === 'string' ? body['replyText'] : null,
          confidence: typeof body['confidence'] === 'number' ? body['confidence'] : null,
          latencyMs: typeof body['latencyMs'] === 'number' ? body['latencyMs'] : null,
          shouldEndCall: body['shouldEndCall'] === true,
          shouldFallback: body['shouldFallback'] === true,
          fallbackReason: typeof body['fallbackReason'] === 'string' ? body['fallbackReason'] : null,
          recordingUrl: typeof body['recordingUrl'] === 'string' ? body['recordingUrl'] : null,
          recordingSignedUrl: typeof body['recordingSignedUrl'] === 'string' ? body['recordingSignedUrl'] : null,
          recordingStoragePath: typeof body['recordingStoragePath'] === 'string' ? body['recordingStoragePath'] : null,
          recordingMimeType: typeof body['recordingMimeType'] === 'string' ? body['recordingMimeType'] : null,
          recordingSizeBytes: typeof body['recordingSizeBytes'] === 'number' ? body['recordingSizeBytes'] : null,
          recordingDurationMs: typeof body['recordingDurationMs'] === 'number' ? body['recordingDurationMs'] : null,
          recordingChecksumSha256: typeof body['recordingChecksumSha256'] === 'string' ? body['recordingChecksumSha256'] : null,
          outcomeLabel: typeof body['outcomeLabel'] === 'string' ? body['outcomeLabel'] : null,
          resultSummary: typeof body['resultSummary'] === 'string' ? body['resultSummary'] : null,
          turnIndex: typeof body['turnIndex'] === 'number' ? body['turnIndex'] : null,
          metadata: typeof body['metadata'] === 'object' && body['metadata'] !== null && !Array.isArray(body['metadata'])
            ? body['metadata'] as Record<string, unknown>
            : {},
          error: typeof body['error'] === 'string' ? body['error'] : null,
        });

        return reply.code(200).send({ success: true, data: updatedSession });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, '[Realtime bridge] Event callback failed');
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.post(
    '/telephony/realtime/bridge/respond',
    async (
      request: FastifyRequest<{ Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      try {
        if (!(await requireRealtimeBridgeAuth(request, reply))) {
          return;
        }

        const body = request.body ?? {};
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'].trim() : '';
        const transcript = typeof body['transcript'] === 'string' ? body['transcript'] : '';
        const bootstrap = body['bootstrap'] === true;
        if (!sessionId || (!bootstrap && !transcript.trim())) {
          return reply.code(400).send({
            success: false,
            error: bootstrap
              ? 'sessionId is required for bootstrap respond'
              : 'sessionId and transcript are required',
          });
        }

        const result = await respondToRealtimeBridge({
          sessionId,
          transcript,
          bootstrap,
          isFinal: body['isFinal'] !== false,
          confidence: typeof body['confidence'] === 'number' ? body['confidence'] : null,
          latencyMs: typeof body['latencyMs'] === 'number' ? body['latencyMs'] : null,
          providerEventId: typeof body['providerEventId'] === 'string' ? body['providerEventId'] : null,
        });

        return reply.code(200).send({ success: true, data: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, '[Realtime bridge] Respond callback failed');
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  // ============================================
  // LiraX Telephony User Permissions
  // ============================================

  server.get('/lirax/users', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const admin = await requireAdminAuth(request, reply);
      if (!admin) {
        return;
      }

      const users = await getTelephonyUsers();
      return reply.code(200).send({ success: true, data: users });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  server.post(
    '/lirax/users',
    async (
      request: FastifyRequest<{ Body: { telegram_id: string; name: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { telegram_id, name } = request.body as { telegram_id: string; name: string };
        if (!telegram_id) {
          return reply.code(400).send({ success: false, error: 'telegram_id is required' });
        }
        const users = await addTelephonyUser(telegram_id, name || telegram_id);
        aiLogger.info({ telegram_id, name }, '[LiraX] Telephony user added');
        return reply.code(200).send({ success: true, data: users });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  server.delete(
    '/lirax/users/:telegramId',
    async (
      request: FastifyRequest<{ Params: { telegramId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { telegramId } = request.params;
        const users = await removeTelephonyUser(telegramId);
        aiLogger.info({ telegramId }, '[LiraX] Telephony user removed');
        return reply.code(200).send({ success: true, data: users });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  /**
   * POST /api/lirax/generate-prompt
   */
  server.post(
    '/lirax/generate-prompt',
    async (
      request: FastifyRequest<{ Body: { rule: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const admin = await requireAdminAuth(request, reply);
        if (!admin) {
          return;
        }

        const { rule } = request.body as { rule: string };
        if (!rule || typeof rule !== 'string') {
          return reply.code(400).send({ success: false, error: 'rule is required' });
        }

        const MAX_RULE_LENGTH = 2000;
        if (rule.length > MAX_RULE_LENGTH) {
          return reply.code(400).send({ success: false, error: `rule too long (max ${MAX_RULE_LENGTH} chars)` });
        }

        const INJECTION_PATTERNS = [
          /ignore\s+(all\s+)?instructions/i,
          /игнорируй\s+(все\s+)?инструкции/i,
          /system:\s+/i,
          /\[system\]/i,
          /<\|system\|>/i,
          /```[\s\S]*```/,
          /\bact\s+as\b/i,
          /\byou\s+are\s+now\b/i,
          /\bforget\s+(all|everything|previous)\b/i,
          /\bзабудь\s+(все|всё|предыдущие)\b/i,
        ];
        if (INJECTION_PATTERNS.some((pattern) => pattern.test(rule))) {
          return reply.code(400).send({ success: false, error: 'rule contains prohibited patterns' });
        }

        const systemPrompt = await buildPersonaSystemPrompt({
          channel: 'system',
          extraRules: [
            'Режим задачи: генерация конфигурации вызова LiraX API.',
            'Ответ должен быть строго в JSON без пояснений.',
          ],
        });
        const promptBody = `Пользователь описывает сценарий звонка на русском языке. Твоя задача — преобразовать его в конфигурацию вызова LiraX API.

Доступные команды LiraX:
1. makeCall — позвонить от менеджера клиенту (параметры: from (внутренний номер), to (номер телефона))
2. make2Calls — соединить двух абонентов с TTS (параметры: from, to1, to2, speech="ru Текст для озвучки", timeout, successtime)
3. AskQuestion — позвонить и задать вопрос с ожиданием ответа (параметры: from, to1, hello="ru Приветствие", ask="ru Вопрос", ok="ru да ок согласен", bye="ru До свидания")

Правила ответа:
- Ответ СТРОГО в формате JSON
- Поле "cmd" — имя команды
- Поле "params" — объект с параметрами (используй заглушку {{phone}} для номера клиента и {{ext}} для внутреннего номера оператора)
- Поле "description" — краткое описание что делает сценарий
- Текст speech/hello/ask/bye/ok всегда начинается с "ru " для русского языка
- Не добавляй ничего кроме JSON

Правило пользователя:
${rule}`;

        const messages: AIMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptBody },
        ];

        const aiResult = await aiService.chat(messages, 'voice', undefined, {
          promptMode: 'passthrough',
        });
        aiLogger.info({ rule }, '[LiraX] Prompt generated via LLM');

        return reply.code(200).send({
          success: true,
          data: { generatedPrompt: aiResult.content, model: aiResult.model },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.error({ error: msg }, '[LiraX] Generate prompt failed');
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );
}
