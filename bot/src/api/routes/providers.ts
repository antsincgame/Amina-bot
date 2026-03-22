/**
 * Тесты соединений всех AI-провайдеров.
 * GET /api/providers/test — запускает проверку всех провайдеров параллельно.
 * Возвращает детальную диагностику: источник ключа, модель, ошибки, рекомендации.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { config, getApiKeys, clearApiKeysCache } from '../../config/index.js';
import { getProxyHeaders, getOpenRouterBaseUrl, getGroqBaseUrl } from '../../config/ai-proxy.js';
import { aiLogger } from '../../config/logger.js';
import { settingsRepo } from '../../db/index.js';
import { getProviderHealthStatus, resetProvider } from '../../ai/provider-health.js';

interface ProviderTestResult {
  provider: string;
  status: 'ok' | 'error' | 'skipped';
  latencyMs: number;
  model?: string;
  modelSource?: string;
  error?: string;
  detail?: string;
  keySource?: string;
  keyPreview?: string;
  diagnosis?: string;
}

function maskKey(key: string): string {
  if (!key) return '(пусто)';
  if (key.length <= 10) return key.slice(0, 3) + '***';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

async function getKeySource(dbKey: string, envValue: string | undefined): Promise<{ source: string; value: string }> {
  const dbValue = (await settingsRepo.get(dbKey).catch(() => null))?.trim();
  if (dbValue) return { source: `БД (${dbKey})`, value: dbValue };
  if (envValue?.trim()) return { source: 'env', value: envValue.trim() };
  return { source: 'не задан', value: '' };
}

function diagnoseError(err: unknown, provider: string): { error: string; diagnosis: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('401') || msg.includes('Unauthorized'))
    return { error: '401 Unauthorized', diagnosis: `API ключ ${provider} невалидный или протух. Обновите ключ в разделе API Keys.` };
  if (msg.includes('403') || msg.includes('Forbidden'))
    return { error: '403 Forbidden', diagnosis: `Доступ запрещён. Ключ ${provider} заблокирован или не имеет нужных прав.` };
  if (msg.includes('402') || msg.includes('Payment'))
    return { error: '402 Payment Required', diagnosis: `Закончились кредиты ${provider}. Пополните баланс.` };
  if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found'))
    return { error: '404 Model Not Found', diagnosis: `Модель не найдена. Смените модель в настройках — текущая могла быть удалена с ${provider}.` };
  if (msg.includes('429') || msg.includes('rate limit'))
    return { error: '429 Rate Limit', diagnosis: `Превышен лимит запросов ${provider}. Подождите минуту.` };
  if (msg.includes('502') || msg.includes('Bad Gateway'))
    return { error: '502 Bad Gateway', diagnosis: `${provider} временно недоступен. Попробуйте через минуту.` };
  if (msg.includes('503'))
    return { error: '503 Unavailable', diagnosis: `${provider} перегружен. Попробуйте позже.` };
  if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('ETIMEDOUT'))
    return { error: 'Timeout', diagnosis: `${provider} не ответил за 10 сек. Проблемы с сетью или перегрузка.` };
  if (msg.includes('ECONNREFUSED'))
    return { error: 'Connection refused', diagnosis: `Не удалось подключиться к ${provider}. Сервер выключен.` };
  if (msg.includes('DOCTYPE') || msg.includes('<html'))
    return { error: 'HTML вместо JSON', diagnosis: `${provider} вернул HTML страницу вместо API. Ключ невалидный или URL неверный.` };
  if (msg.includes('Empty response'))
    return { error: 'Пустой ответ', diagnosis: `${provider} вернул пустой ответ. Модель может не поддерживать данный запрос.` };
  return { error: msg.slice(0, 150), diagnosis: `Неизвестная ошибка ${provider}. Проверьте ключ и настройки.` };
}

async function resolveModel(dbKeys: string[], defaultModel: string): Promise<{ model: string; modelSource: string }> {
  for (const key of dbKeys) {
    const val = (await settingsRepo.get(key).catch(() => null))?.trim();
    if (val) return { model: val, modelSource: `БД (${key})` };
  }
  return { model: defaultModel, modelSource: 'default' };
}

async function testOpenRouter(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const keyInfo = await getKeySource('openrouter_api_key', process.env.OPENROUTER_API_KEY);
  const { model, modelSource } = await resolveModel(['custom_model_override', 'openrouter_model'], 'openrouter/free');
  try {
    const client = new OpenAI({
      apiKey, baseURL: getOpenRouterBaseUrl(), timeout: 10000,
      defaultHeaders: getProxyHeaders({ 'HTTP-Referer': config.botUrl, 'X-Title': 'Amina AI Bot' }),
    });
    const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 });
    const content = res.choices?.[0]?.message?.content ?? '';
    return { provider: 'openrouter', status: content.length > 0 ? 'ok' : 'error', latencyMs: Date.now() - start, model: res.model || model, modelSource, detail: content.slice(0, 50), keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  } catch (err) {
    const d = diagnoseError(err, 'OpenRouter');
    return { provider: 'openrouter', status: 'error', latencyMs: Date.now() - start, model, modelSource, ...d, keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  }
}

async function testCerebras(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const keyInfo = await getKeySource('cerebras_api_key', process.env.CEREBRAS_API_KEY);
  const { model, modelSource } = await resolveModel(['cerebras_model'], 'qwen-3-235b-a22b-instruct-2507');
  try {
    const client = new OpenAI({ apiKey, baseURL: config.cerebras.baseUrl, timeout: 10000, defaultHeaders: getProxyHeaders() });
    const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 });
    const content = res.choices?.[0]?.message?.content ?? '';
    return { provider: 'cerebras', status: content.length > 0 ? 'ok' : 'error', latencyMs: Date.now() - start, model: res.model || model, modelSource, detail: content.slice(0, 50), keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  } catch (err) {
    const d = diagnoseError(err, 'Cerebras');
    return { provider: 'cerebras', status: 'error', latencyMs: Date.now() - start, model, modelSource, ...d, keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  }
}

async function testGroqChat(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const keyInfo = await getKeySource('groq_api_key', process.env.GROQ_API_KEY);
  const { model, modelSource } = await resolveModel(['groq_model'], 'llama-3.3-70b-versatile');
  try {
    const client = new OpenAI({ apiKey, baseURL: getGroqBaseUrl(), timeout: 10000, defaultHeaders: getProxyHeaders() });
    const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 });
    const content = res.choices?.[0]?.message?.content ?? '';
    return { provider: 'groq_chat', status: content.length > 0 ? 'ok' : 'error', latencyMs: Date.now() - start, model: res.model || model, modelSource, detail: content.slice(0, 50), keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  } catch (err) {
    const d = diagnoseError(err, 'Groq');
    return { provider: 'groq_chat', status: 'error', latencyMs: Date.now() - start, model, modelSource, ...d, keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  }
}

async function testGroqWhisper(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const keyInfo = await getKeySource('groq_api_key', process.env.GROQ_API_KEY);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(`${getGroqBaseUrl()}/models`, { headers: { Authorization: `Bearer ${apiKey}`, ...getProxyHeaders() }, signal: controller.signal });
      if (resp.ok) return { provider: 'groq_whisper', status: 'ok', latencyMs: Date.now() - start, model: 'whisper-large-v3', detail: 'API доступен', keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
      throw new Error(`HTTP ${resp.status}`);
    } finally { clearTimeout(timeoutId); }
  } catch (err) {
    const d = diagnoseError(err, 'Groq Whisper');
    return { provider: 'groq_whisper', status: 'error', latencyMs: Date.now() - start, ...d, keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  }
}

async function testPerplexity(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const keyInfo = await getKeySource('perplexity_api_key', process.env.PERPLEXITY_API_KEY);
  const { model, modelSource } = await resolveModel(['perplexity_model'], 'sonar');
  try {
    const client = new OpenAI({ apiKey, baseURL: config.perplexity.baseUrl, timeout: 15000 });
    const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 });
    const content = res.choices?.[0]?.message?.content ?? '';
    return { provider: 'perplexity', status: content.length > 0 ? 'ok' : 'error', latencyMs: Date.now() - start, model: res.model || model, modelSource, detail: content.slice(0, 50), keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  } catch (err) {
    const d = diagnoseError(err, 'Perplexity');
    return { provider: 'perplexity', status: 'error', latencyMs: Date.now() - start, model, modelSource, ...d, keySource: keyInfo.source, keyPreview: maskKey(apiKey) };
  }
}

async function testVision(openrouterKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  const { model, modelSource } = await resolveModel(['vision_model_override', 'preferred_vision_model', 'effective_vision_model', 'vision_model'], 'google/gemma-3-27b-it:free');
  
  const isGroq = model.startsWith('groq:');
  const actualModel = isGroq ? model.replace('groq:', '') : model;
  
  try {
    let client: OpenAI;
    if (isGroq) {
      const keys = await getApiKeys();
      if (!keys.groq) return { provider: 'vision', status: 'error', latencyMs: 0, model, modelSource, diagnosis: 'Vision модель Groq, но Groq API ключ не задан.' };
      client = new OpenAI({ apiKey: keys.groq, baseURL: getGroqBaseUrl(), timeout: 15000, defaultHeaders: getProxyHeaders() });
    } else {
      client = new OpenAI({
        apiKey: openrouterKey, baseURL: getOpenRouterBaseUrl(), timeout: 15000,
        defaultHeaders: getProxyHeaders({ 'HTTP-Referer': config.botUrl, 'X-Title': 'Amina AI Bot' }),
      });
    }
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=';
    const res = await client.chat.completions.create({
      model: actualModel, messages: [{ role: 'user', content: [{ type: 'text', text: 'What color? One word.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }] }], max_tokens: 10,
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    return { provider: 'vision', status: content.length > 0 ? 'ok' : 'error', latencyMs: Date.now() - start, model: res.model || actualModel, modelSource, detail: content.slice(0, 50) };
  } catch (err) {
    const providerName = isGroq ? 'Vision (Groq)' : 'Vision (OpenRouter)';
    const d = diagnoseError(err, providerName);
    return { provider: 'vision', status: 'error', latencyMs: Date.now() - start, model: actualModel, modelSource, ...d };
  }
}

async function testAppwrite(): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    await settingsRepo.get('__healthcheck__');
    return { provider: 'appwrite', status: 'ok', latencyMs: Date.now() - start, detail: config.appwrite.endpoint };
  } catch (err) {
    const d = diagnoseError(err, 'Appwrite');
    return { provider: 'appwrite', status: 'error', latencyMs: Date.now() - start, ...d };
  }
}

export async function registerProvidersRoutes(server: FastifyInstance): Promise<void> {
  server.get('/providers/test', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Сбрасываем кэш ключей чтобы подхватить свежие из БД
    clearApiKeysCache();
    settingsRepo.invalidateCache();

    const keys = await getApiKeys();
    const perplexityKey = (await settingsRepo.get('perplexity_api_key'))?.trim() || config.perplexity.apiKey;
    const currentProvider = (await settingsRepo.get('ai_provider'))?.trim() || 'auto';

    const tests: Promise<ProviderTestResult>[] = [testAppwrite()];
    if (keys.openrouter) { tests.push(testOpenRouter(keys.openrouter)); }
    else { tests.push(Promise.resolve({ provider: 'openrouter', status: 'skipped' as const, latencyMs: 0, diagnosis: 'Ключ не задан. Укажите OPENROUTER_API_KEY в env или API Keys.' })); }
    // Vision тестируется всегда — может работать через Groq
    tests.push(testVision(keys.openrouter || ''));
    if (keys.cerebras) { tests.push(testCerebras(keys.cerebras)); }
    else { tests.push(Promise.resolve({ provider: 'cerebras', status: 'skipped' as const, latencyMs: 0, diagnosis: 'Ключ не задан. Получите бесплатно на cerebras.ai и укажите в API Keys.' })); }
    if (keys.groq) { tests.push(testGroqChat(keys.groq)); tests.push(testGroqWhisper(keys.groq)); }
    else { tests.push(Promise.resolve({ provider: 'groq_chat', status: 'skipped' as const, latencyMs: 0, diagnosis: 'Ключ не задан. Укажите GROQ_API_KEY.' })); tests.push(Promise.resolve({ provider: 'groq_whisper', status: 'skipped' as const, latencyMs: 0, diagnosis: 'Для Whisper нужен Groq ключ.' })); }
    if (perplexityKey) { tests.push(testPerplexity(perplexityKey)); }
    else { tests.push(Promise.resolve({ provider: 'perplexity', status: 'skipped' as const, latencyMs: 0, diagnosis: 'Ключ не задан. Укажите PERPLEXITY_API_KEY.' })); }

    const totalStart = Date.now();
    const results = await Promise.allSettled(tests);
    const totalMs = Date.now() - totalStart;
    const data = results.map(r => r.status === 'fulfilled' ? r.value : { provider: 'unknown', status: 'error' as const, latencyMs: 0, error: String(r.reason), diagnosis: 'Unexpected test error.' });

    aiLogger.info({ totalMs, results: data.map(d => `${d.provider}:${d.status}:${d.latencyMs}ms`) }, '🧪 Provider test');

    return reply.code(200).send({ success: true, data, currentProvider, totalMs, timestamp: new Date().toISOString() });
  });

  /**
   * POST /api/providers/test-model
   * Тестирует конкретную модель на конкретном провайдере.
   */
  server.post('/providers/test-model', async (request: FastifyRequest<{ Body: { provider: string; model: string } }>, reply: FastifyReply) => {
    const { provider, model } = request.body as { provider?: string; model?: string };
    if (!provider || !model) return reply.code(400).send({ success: false, error: 'provider and model required' });

    const start = Date.now();
    const keys = await getApiKeys();
    let apiKey: string | undefined;
    let baseURL: string;
    let extraHeaders: Record<string, string> = {};

    if (provider === 'openrouter') {
      apiKey = keys.openrouter; baseURL = getOpenRouterBaseUrl();
      extraHeaders = getProxyHeaders({ 'HTTP-Referer': config.botUrl, 'X-Title': 'Amina AI Bot' });
    } else if (provider === 'cerebras') {
      apiKey = keys.cerebras; baseURL = config.cerebras.baseUrl;
    } else if (provider === 'groq') {
      apiKey = keys.groq; baseURL = getGroqBaseUrl(); extraHeaders = getProxyHeaders();
    } else {
      return reply.code(400).send({ success: false, error: `Unknown provider: ${provider}` });
    }

    if (!apiKey) return reply.code(200).send({ success: false, status: 'error', error: `Нет API ключа для ${provider}`, latencyMs: 0 });

    try {
      const client = new OpenAI({ apiKey, baseURL, timeout: 12000, defaultHeaders: extraHeaders });
      const res = await client.chat.completions.create({ model: model.trim(), messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 });
      const content = res.choices?.[0]?.message?.content ?? '';
      const latencyMs = Date.now() - start;
      if (content.length > 0) return reply.code(200).send({ success: true, status: 'ok', model: res.model || model, latencyMs, detail: content.slice(0, 50) });
      return reply.code(200).send({ success: false, status: 'error', model, latencyMs, error: 'Пустой ответ' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const latencyMs = Date.now() - start;
      let diagnosis = msg.slice(0, 120);
      if (msg.includes('404') || msg.includes('not found')) diagnosis = `Модель ${model} не найдена на ${provider}.`;
      else if (msg.includes('401')) diagnosis = `Ключ ${provider} невалидный.`;
      else if (msg.includes('403')) diagnosis = `Доступ запрещён. Ключ ${provider} заблокирован.`;
      else if (msg.includes('429')) diagnosis = 'Лимит запросов. Подождите минуту.';
      else if (msg.includes('DOCTYPE') || msg.includes('<html')) diagnosis = `${provider} вернул HTML. Ключ невалидный.`;
      return reply.code(200).send({ success: false, status: 'error', model, latencyMs, error: diagnosis });
    }
  });

  /** GET /api/providers/health — circuit breaker и rate budget статус */
  server.get('/providers/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ success: true, data: getProviderHealthStatus() });
  });

  /** POST /api/providers/reset — сброс circuit breaker для провайдера */
  server.post('/providers/reset', async (request: FastifyRequest<{ Body: { provider: string } }>, reply: FastifyReply) => {
    const { provider } = request.body as { provider?: string };
    if (!provider) return reply.code(400).send({ success: false, error: 'provider required' });
    resetProvider(provider);
    return reply.code(200).send({ success: true, message: `Circuit breaker reset for ${provider}` });
  });
}
