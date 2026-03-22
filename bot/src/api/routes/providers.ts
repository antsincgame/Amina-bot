/**
 * Тесты соединений всех AI-провайдеров.
 * GET /api/providers/test — запускает проверку всех провайдеров параллельно.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { config, getApiKeys } from '../../config/index.js';
import { getProxyHeaders, getOpenRouterBaseUrl, getGroqBaseUrl } from '../../config/ai-proxy.js';
import { aiLogger } from '../../config/logger.js';
import { settingsRepo } from '../../db/index.js';

interface ProviderTestResult {
  provider: string;
  status: 'ok' | 'error' | 'skipped';
  latencyMs: number;
  model?: string;
  error?: string;
  detail?: string;
}

async function testOpenRouter(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: getOpenRouterBaseUrl(),
      timeout: 10000,
      defaultHeaders: getProxyHeaders({
        'HTTP-Referer': config.botUrl,
        'X-Title': 'Amina AI Bot',
      }),
    });
    const model = (await settingsRepo.get('openrouter_model'))?.trim() || 'openrouter/free';
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 5,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      provider: 'openrouter',
      status: content.length > 0 ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      model: res.model || model,
      detail: content.slice(0, 50),
    };
  } catch (err) {
    return {
      provider: 'openrouter',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testCerebras(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: config.cerebras.baseUrl, timeout: 10000 });
    const model = (await settingsRepo.get('cerebras_model'))?.trim() || 'qwen-3-235b-a22b-instruct-2507';
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 5,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      provider: 'cerebras',
      status: content.length > 0 ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      model: res.model || model,
      detail: content.slice(0, 50),
    };
  } catch (err) {
    return {
      provider: 'cerebras',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testGroqChat(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: getGroqBaseUrl(), timeout: 10000, defaultHeaders: getProxyHeaders() });
    const model = (await settingsRepo.get('groq_model'))?.trim() || 'llama-3.3-70b-versatile';
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 5,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      provider: 'groq_chat',
      status: content.length > 0 ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      model: res.model || model,
      detail: content.slice(0, 50),
    };
  } catch (err) {
    return {
      provider: 'groq_chat',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testGroqWhisper(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    // Проверяем что Groq API доступен для аудио (создаём пустой запрос, ловим 400 вместо 401/500)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(`${getGroqBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...getProxyHeaders() },
        signal: controller.signal,
      });
      if (resp.ok) {
        return {
          provider: 'groq_whisper',
          status: 'ok',
          latencyMs: Date.now() - start,
          model: 'whisper-large-v3',
          detail: 'API доступен (models endpoint OK)',
        };
      }
      throw new Error(`HTTP ${resp.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    return {
      provider: 'groq_whisper',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testPerplexity(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: config.perplexity.baseUrl, timeout: 15000 });
    const model = (await settingsRepo.get('perplexity_model'))?.trim() || 'sonar';
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 10,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      provider: 'perplexity',
      status: content.length > 0 ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      model: res.model || model,
      detail: content.slice(0, 50),
    };
  } catch (err) {
    return {
      provider: 'perplexity',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testVision(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: getOpenRouterBaseUrl(),
      timeout: 15000,
      defaultHeaders: getProxyHeaders({
        'HTTP-Referer': config.botUrl,
        'X-Title': 'Amina AI Bot',
      }),
    });
    const settings = await settingsRepo.getMany(['vision_model_override', 'preferred_vision_model', 'effective_vision_model', 'vision_model']);
    // Приоритет: override > preferred > effective > legacy > default (как в multimodal.ts)
    const model = settings['vision_model_override']?.trim()
      || settings['preferred_vision_model']?.trim()
      || settings['effective_vision_model']?.trim()
      || settings['vision_model']?.trim()
      || 'google/gemma-3-27b-it:free';

    // Отправляем минимальный 1x1 png (43 bytes base64)
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const res = await client.chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this pixel? Answer in one word.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } },
        ],
      }],
      max_tokens: 10,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return {
      provider: 'vision',
      status: content.length > 0 ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      model: res.model || model,
      detail: content.slice(0, 50),
    };
  } catch (err) {
    return {
      provider: 'vision',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testAppwrite(): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    await settingsRepo.get('__healthcheck__');
    return {
      provider: 'appwrite',
      status: 'ok',
      latencyMs: Date.now() - start,
      detail: `${config.appwrite.endpoint}`,
    };
  } catch (err) {
    return {
      provider: 'appwrite',
      status: 'error',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerProvidersRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/providers/test
   * Тестирует все AI-провайдеры параллельно. Возвращает latency и статус каждого.
   */
  server.get('/providers/test', async (_request: FastifyRequest, reply: FastifyReply) => {
    const keys = await getApiKeys();
    const perplexityKey = (await settingsRepo.get('perplexity_api_key'))?.trim() || config.perplexity.apiKey;

    const tests: Promise<ProviderTestResult>[] = [
      testAppwrite(),
    ];

    if (keys.openrouter) {
      tests.push(testOpenRouter(keys.openrouter));
      tests.push(testVision(keys.openrouter));
    } else {
      tests.push(Promise.resolve({ provider: 'openrouter', status: 'skipped' as const, latencyMs: 0, error: 'Нет API ключа' }));
      tests.push(Promise.resolve({ provider: 'vision', status: 'skipped' as const, latencyMs: 0, error: 'Нет OpenRouter ключа' }));
    }

    if (keys.cerebras) {
      tests.push(testCerebras(keys.cerebras));
    } else {
      tests.push(Promise.resolve({ provider: 'cerebras', status: 'skipped' as const, latencyMs: 0, error: 'Нет API ключа' }));
    }

    if (keys.groq) {
      tests.push(testGroqChat(keys.groq));
      tests.push(testGroqWhisper(keys.groq));
    } else {
      tests.push(Promise.resolve({ provider: 'groq_chat', status: 'skipped' as const, latencyMs: 0, error: 'Нет API ключа' }));
      tests.push(Promise.resolve({ provider: 'groq_whisper', status: 'skipped' as const, latencyMs: 0, error: 'Нет API ключа' }));
    }

    if (perplexityKey) {
      tests.push(testPerplexity(perplexityKey));
    } else {
      tests.push(Promise.resolve({ provider: 'perplexity', status: 'skipped' as const, latencyMs: 0, error: 'Нет API ключа' }));
    }

    const totalStart = Date.now();
    const results = await Promise.allSettled(tests);
    const totalMs = Date.now() - totalStart;

    const data = results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { provider: 'unknown', status: 'error' as const, latencyMs: 0, error: String(r.reason) },
    );

    aiLogger.info({ totalMs, results: data.map(d => `${d.provider}:${d.status}:${d.latencyMs}ms`) }, '🧪 Provider connectivity test');

    return reply.code(200).send({
      success: true,
      data,
      totalMs,
      timestamp: new Date().toISOString(),
    });
  });
}
