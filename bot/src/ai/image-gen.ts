/**
 * Image Generation Service
 * 
 * Генерация изображений через Hugging Face Inference API (FLUX.1-schnell)
 * Бесплатно, с очередью.
 */

import { InferenceClient } from '@huggingface/inference';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/supabase.js';

// --------------------------------------------
// Constants
// --------------------------------------------

const DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
const GENERATION_TIMEOUT_MS = 60_000; // 60 секунд (генерация может быть долгой)
const HF_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 минут

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
    hfClient = new InferenceClient(token);
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
    const imageBlob = await client.textToImage({
      model: DEFAULT_MODEL,
      inputs: prompt,
      parameters: {
        num_inference_steps: 4, // schnell = быстрая модель, 4 шагов достаточно
      },
    });

    const buffer = Buffer.from(await imageBlob.arrayBuffer());
    const generationTimeMs = Date.now() - startTime;

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
    const err = error as { status?: number; message?: string };
    const generationTimeMs = Date.now() - startTime;
    
    aiLogger.error(
      { error, model: DEFAULT_MODEL, timeMs: generationTimeMs },
      'Image generation failed'
    );

    if (err.status === 401) {
      throw Object.assign(
        new Error('Неверный HF_TOKEN. Обновите в админке → API Ключи.'),
        { code: 'HF_AUTH_ERROR' }
      );
    }
    if (err.status === 429) {
      throw Object.assign(
        new Error('Слишком много запросов к Hugging Face. Подожди минуту.'),
        { code: 'HF_RATE_LIMIT' }
      );
    }
    if (err.status === 503) {
      throw Object.assign(
        new Error('Модель загружается на сервере. Попробуй через 30 секунд.'),
        { code: 'HF_MODEL_LOADING' }
      );
    }
    
    throw Object.assign(
      new Error('Не удалось сгенерировать изображение. Попробуй позже.'),
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
