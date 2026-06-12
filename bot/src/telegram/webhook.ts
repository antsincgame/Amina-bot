import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import type { BotContext } from './bot.js';

/** Сравнение секрета вебхука за постоянное время — не сливает длину/префикс через тайминг. */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type TelegramUpdateHandler = Pick<Bot<BotContext>, 'handleUpdate'>;
const PROCESSED_UPDATE_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;
const processingUpdateIds = new Set<number>();
const completedUpdateIds = new Map<number, number>();

let webhookCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startWebhookCleanup(): void {
  if (webhookCleanupTimer) return;
  webhookCleanupTimer = setInterval(() => {
    const now = Date.now();
    cleanupCompletedUpdates(now);
  }, CLEANUP_INTERVAL_MS);
  webhookCleanupTimer.unref();
}

export function stopWebhookCleanup(): void {
  if (webhookCleanupTimer) {
    clearInterval(webhookCleanupTimer);
    webhookCleanupTimer = null;
  }
}

function readSecretHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    return readSecretHeader(value[0]);
  }

  return null;
}

function readUpdateId(update: Update): number | null {
  return typeof update.update_id === 'number' ? update.update_id : null;
}

function cleanupCompletedUpdates(now: number): void {
  completedUpdateIds.forEach((processedAt, updateId) => {
    if (now - processedAt > PROCESSED_UPDATE_TTL_MS) {
      completedUpdateIds.delete(updateId);
    }
  });
}

function hasRecentUpdate(updateId: number): boolean {
  const now = Date.now();
  cleanupCompletedUpdates(now);

  if (processingUpdateIds.has(updateId)) {
    return true;
  }

  const processedAt = completedUpdateIds.get(updateId);
  return typeof processedAt === 'number' && now - processedAt <= PROCESSED_UPDATE_TTL_MS;
}

function markUpdateStarted(updateId: number | null): void {
  if (updateId === null) return;
  cleanupCompletedUpdates(Date.now());
  processingUpdateIds.add(updateId);
}

function markUpdateCompleted(updateId: number | null): void {
  if (updateId === null) return;
  processingUpdateIds.delete(updateId);
  completedUpdateIds.set(updateId, Date.now());
}

function markUpdateFailed(updateId: number | null): void {
  if (updateId === null) return;
  processingUpdateIds.delete(updateId);
}

function processWebhookUpdate(
  bot: TelegramUpdateHandler,
  update: Update,
  updateId: number | null,
): void {
  setImmediate(() => {
    Promise.resolve()
      .then(() => bot.handleUpdate(update))
      .then(() => {
        markUpdateCompleted(updateId);
      })
      .catch((error: unknown) => {
        markUpdateFailed(updateId);
        telegramLogger.error({
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          updateId,
        }, 'Telegram webhook update failed');
      });
  });
}

export function registerTelegramWebhookRoute(
  server: FastifyInstance,
  getBot: () => TelegramUpdateHandler | null,
): void {
  startWebhookCleanup();
  server.post(
    '/webhook/telegram',
    async (request: FastifyRequest<{ Body?: Update }>, reply: FastifyReply) => {
      const expectedSecret = config.telegram.webhook.secret?.trim();
      const providedSecret = readSecretHeader(request.headers['x-telegram-bot-api-secret-token']);

      if (expectedSecret && !secretsMatch(providedSecret, expectedSecret)) {
        return reply.code(401).send({
          ok: false,
          error: 'Invalid Telegram webhook secret',
        });
      }

      const bot = getBot();
      if (!bot) {
        return reply.code(503).send({
          ok: false,
          error: 'Telegram bot is not initialized yet',
        });
      }

      const update = request.body;
      if (!update || typeof update !== 'object') {
        return reply.code(400).send({
          ok: false,
          error: 'Telegram update payload is required',
        });
      }

      const telegramUpdate = update as Update;
      const updateId = readUpdateId(telegramUpdate);

      if (updateId !== null && hasRecentUpdate(updateId)) {
        telegramLogger.warn({ updateId }, 'Duplicate Telegram webhook update skipped');
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      markUpdateStarted(updateId);
      reply.code(200).send({ ok: true });
      processWebhookUpdate(bot, telegramUpdate, updateId);
    },
  );
}
