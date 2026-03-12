import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import type { BotContext } from './bot.js';

type TelegramUpdateHandler = Pick<Bot<BotContext>, 'handleUpdate'>;

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

export function registerTelegramWebhookRoute(
  server: FastifyInstance,
  getBot: () => TelegramUpdateHandler | null,
): void {
  server.post(
    '/webhook/telegram',
    async (request: FastifyRequest<{ Body?: Update }>, reply: FastifyReply) => {
      const expectedSecret = config.telegram.webhook.secret?.trim();
      const providedSecret = readSecretHeader(request.headers['x-telegram-bot-api-secret-token']);

      if (expectedSecret && providedSecret !== expectedSecret) {
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

      try {
        await bot.handleUpdate(update as Update);
        return reply.code(200).send({ ok: true });
      } catch (error) {
        telegramLogger.error({ error }, 'Telegram webhook update failed');
        return reply.code(500).send({
          ok: false,
          error: 'Failed to process Telegram update',
        });
      }
    },
  );
}
