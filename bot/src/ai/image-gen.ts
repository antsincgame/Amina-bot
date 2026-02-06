/**
 * Image Generation Service
 * 
 * Генерация изображений через Hugging Face Inference API (FLUX.1-schnell)
 * Бесплатно, через hf-inference провайдер.
 */

// === ОПТИМИЗАЦИЯ: lazy import @huggingface/inference (~2MB) ===
// Загружается только при первом вызове generateImage()
import type { InferenceClient } from '@huggingface/inference';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/supabase.js';

let InferenceClientClass: typeof import('@huggingface/inference').InferenceClient | null = null;

async function getInferenceClientClass(): Promise<typeof import('@huggingface/inference').InferenceClient> {
  if (!InferenceClientClass) {
    const mod = await import('@huggingface/inference');
    InferenceClientClass = mod.InferenceClient;
  }
  return InferenceClientClass;
}

// --------------------------------------------
// Constants
// --------------------------------------------

const DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
/** Таймаут генерации (ms) — FLUX.1-schnell обычно укладывается в 30с */
const GENERATION_TIMEOUT_MS = 60_000;
/** Кеш HF-токена чтобы не дёргать БД на каждый запрос */
const HF_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 минут
/**
 * ВАЖНО: provider ОБЯЗАТЕЛЬНО "hf-inference".
 * Без этого библиотека v4.x автоматически выбирает провайдера "black-forest-labs"
 * и отправляет HF-токен как ключ BFL API (api.us1.bfl.ai) → гарантированный 401.
 */
const HF_PROVIDER = 'hf-inference' as const;

// Паттерны для детекции запроса на генерацию изображения
const IMAGE_GEN_PATTERNS = [
  /^(нарисуй|нарисуй мне|рисуй)\s+/i,
  /^(сгенерируй|сгенерируй мне|сгенерир)\s+/i,
  /^(создай|создай мне)\s+(картинк|изображени|рисунок|фото|арт)/i,
  /^(imagine|draw|generate|paint)\s+/i,
  /^\/imagine\s+/i,
];

// Промпт-улучшение для коротких запросов
const QUALITY_SUFFIX = ', high quality, detailed, 4k';

// --------------------------------------------
// HF Client (dynamic token from DB)
// --------------------------------------------

let hfClient: InferenceClient | null = null;
let currentHfToken: string = '';
let hfTokenCacheTime: number = 0;

/**
 * Получить HF токен из БД
 */
async function getHfToken(): Promise<string | null> {
  const now = Date.now();
  
  if (currentHfToken && now - hfTokenCacheTime < HF_TOKEN_CACHE_TTL) {
    return currentHfToken;
  }

  try {
    const token = await settingsRepo.get('hf_token');
    if (token) {
      currentHfToken = token;
      hfTokenCacheTime = now;
    }
    return token || null;
  } catch (error) {
    aiLogger.error({ error }, 'Failed to get HF token from DB');
    return currentHfToken || null;
  }
}

/**
 * Получить HF клиент
 */
async function getClient(): Promise<InferenceClient> {
  const token = await getHfToken();
  
  if (!token) {
    throw Object.assign(
      new Error('HF_TOKEN не настроен. Добавьте его в админке → API Ключи.'),
      { code: 'HF_NOT_CONFIGURED' }
    );
  }

  if (!hfClient || currentHfToken !== token) {
    const ClientClass = await getInferenceClientClass();
    hfClient = new ClientClass(token);
    currentHfToken = token;
  }

  return hfClient;
}

// --------------------------------------------
// Image Generation
// --------------------------------------------

export interface ImageGenResult {
  image: Buffer;
  model: string;
  prompt: string;
  generationTimeMs: number;
}

/**
 * Определяет, является ли сообщение запросом на генерацию изображения
 */
export function detectImageGenIntent(text: string): boolean {
  return IMAGE_GEN_PATTERNS.some(pattern => pattern.test(text.trim()));
}

/**
 * Извлечь промпт для генерации из текста пользователя
 * "нарисуй кота в космосе" → "кот в космосе"
 */
export function extractImagePrompt(text: string): string {
  let prompt = text.trim();
  
  // Убираем команду /imagine
  prompt = prompt.replace(/^\/imagine\s+/i, '');
  
  // Убираем русские глаголы-триггеры
  prompt = prompt.replace(
    /^(нарисуй|нарисуй мне|рисуй|сгенерируй|сгенерируй мне|создай|создай мне)\s+(картинку|изображение|рисунок|фото|арт)?\s*/i,
    ''
  );
  
  // Убираем английские триггеры
  prompt = prompt.replace(/^(imagine|draw|generate|paint)\s+/i, '');
  
  prompt = prompt.trim();
  
  // Если промпт короткий — добавляем суффикс качества
  if (prompt.length > 0 && prompt.length < 100) {
    prompt += QUALITY_SUFFIX;
  }
  
  return prompt;
}

/**
 * Генерирует изображение по текстовому описанию
 */
export async function generateImage(prompt: string): Promise<ImageGenResult> {
  const client = await getClient();
  const startTime = Date.now();

  aiLogger.info({ prompt, model: DEFAULT_MODEL }, 'Generating image via HF FLUX.1-schnell');

  try {
    // AbortController для таймаута — защита от зависших запросов
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

    let imageBlob: Blob;
    try {
      // InferenceClient не сохраняет overload-типы, поэтому cast необходим.
      // По умолчанию (без outputType) textToImage возвращает Blob.
      const result = await client.textToImage({
        model: DEFAULT_MODEL,
        inputs: prompt,
        provider: HF_PROVIDER,
        parameters: {
          num_inference_steps: 4,
        },
      });
      imageBlob = result as unknown as Blob;
    } finally {
      clearTimeout(timeoutId);
    }

    // Blob → Buffer (совместимо с Node.js 18+)
    const arrayBuffer = await imageBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const generationTimeMs = Date.now() - startTime;

    if (buffer.length === 0) {
      throw Object.assign(
        new Error('Модель вернула пустое изображение. Попробуй другой промпт.'),
        { code: 'HF_EMPTY_RESPONSE' }
      );
    }

    aiLogger.info(
      { 
        model: DEFAULT_MODEL, 
        sizeKB: Math.round(buffer.length / 1024),
        timeMs: generationTimeMs,
      },
      'Image generated successfully'
    );

    return {
      image: buffer,
      model: DEFAULT_MODEL,
      prompt,
      generationTimeMs,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string; name?: string };
    const generationTimeMs = Date.now() - startTime;
    
    aiLogger.error(
      { error: err.message, model: DEFAULT_MODEL, timeMs: generationTimeMs },
      'Image generation failed'
    );

    // Таймаут (AbortController)
    if (err.name === 'AbortError') {
      throw Object.assign(
        new Error('Генерация заняла слишком долго. Попробуй более простой промпт.'),
        { code: 'HF_TIMEOUT' }
      );
    }

    if (err.status === 401 || err.message?.includes('401')) {
      throw Object.assign(
        new Error('Неверный HF_TOKEN. Обновите в админке → API Ключи.'),
        { code: 'HF_AUTH_ERROR' }
      );
    }
    if (err.status === 429 || err.message?.includes('429')) {
      throw Object.assign(
        new Error('Слишком много запросов к Hugging Face. Подожди минуту.'),
        { code: 'HF_RATE_LIMIT' }
      );
    }
    if (err.status === 503 || err.message?.includes('503')) {
      throw Object.assign(
        new Error('Модель загружается на сервере. Попробуй через 30 секунд.'),
        { code: 'HF_MODEL_LOADING' }
      );
    }

    // Если ошибка уже наша — пробрасываем
    if ((error as { code?: string }).code?.startsWith('HF_')) {
      throw error;
    }
    
    throw Object.assign(
      new Error(
        `Не удалось сгенерировать изображение: ${err.message || 'неизвестная ошибка'}. Попробуй позже.`
      ),
      { code: 'HF_GENERATION_ERROR' }
    );
  }
}

/**
 * Проверить доступность генерации изображений
 */
export async function isImageGenAvailable(): Promise<boolean> {
  const token = await getHfToken();
  return !!token;
}
