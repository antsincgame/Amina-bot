import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config/index.js';
import { registerTelegramWebhookRoute } from './webhook.js';

vi.mock('../config/logger.js', () => ({
  telegramLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const originalWebhookSecret = config.telegram.webhook.secret;

describe('registerTelegramWebhookRoute', () => {
  afterEach(() => {
    config.telegram.webhook.secret = originalWebhookSecret;
    vi.clearAllMocks();
  });

  it('should reject requests with an invalid secret token', async () => {
    config.telegram.webhook.secret = 'expected-secret';
    const handleUpdate = vi.fn();
    const app = Fastify();

    registerTelegramWebhookRoute(app, () => ({ handleUpdate }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: {
        'x-telegram-bot-api-secret-token': 'wrong-secret',
      },
      payload: { update_id: 1 },
    });

    expect(response.statusCode).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();

    await app.close();
  });

  it('should accept a valid webhook update and forward it to the bot', async () => {
    config.telegram.webhook.secret = 'expected-secret';
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const app = Fastify();

    registerTelegramWebhookRoute(app, () => ({ handleUpdate }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected-secret',
      },
      payload: { update_id: 7, message: { text: 'hi' } },
    });

    expect(response.statusCode).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('should return 503 until the bot is initialized', async () => {
    config.telegram.webhook.secret = 'expected-secret';
    const app = Fastify();

    registerTelegramWebhookRoute(app, () => null);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected-secret',
      },
      payload: { update_id: 9 },
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  it('should allow webhook requests when no secret is configured', async () => {
    config.telegram.webhook.secret = undefined;
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const app = Fastify();

    registerTelegramWebhookRoute(app, () => ({ handleUpdate }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      payload: { update_id: 11 },
    });

    expect(response.statusCode).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
