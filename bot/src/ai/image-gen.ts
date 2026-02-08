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
import { getApiKeys } from '../config/index.js';

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
// ВАЖНО: не используем ^, чтобы ловить "пожалуйста, нарисуй..." из голоса
const IMAGE_GEN_PATTERNS = [
  // Русские глаголы рисования (с/без ^ для гибкости)
  /\b(нарисуй|нарисуй мне|нарисуй-ка|рисуй|нарисовать|порисуй)\s+/i,
  /\b(сгенерируй|сгенерируй мне|сгенерировать|сгенерир)\b/i,
  // "создай/сделай картинку/изображение/рисунок"
  /\b(создай|создай мне|сделай|сделай мне)\s+(картинк|изображени|рисунок|фото|арт|иллюстрац|пикч)/i,
  // "хочу картинку", "покажи картинку", "сможешь нарисовать"
  /\b(хочу|покажи|покажи мне|давай)\s+(картинк|изображени|рисунок|фото|арт)/i,
  /\b(можешь|сможешь|попробуй|могла бы)\s+(нарисовать|нарисуй|сгенерировать|создать|сделать)\b/i,
  // Английские
  /\b(imagine|draw|generate|paint|create)\s+(a |an |the |me )?(picture|image|photo|art|illustration)/i,
  /\b(draw|paint|generate|imagine)\s+/i,
  // Команда
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
 * НЕ обновляет currentHfToken — это делает только getClient()
 */
async function getHfToken(): Promise<string | null> {
  const now = Date.now();
  
  if (currentHfToken && now - hfTokenCacheTime < HF_TOKEN_CACHE_TTL) {
    return currentHfToken;
  }

  try {
    const token = await settingsRepo.get('hf_token');
    if (token) {
      hfTokenCacheTime = now;
      return token;
    }
    return null;
  } catch (error) {
    aiLogger.error({ error }, 'Failed to get HF token from DB');
    return currentHfToken || null;
  }
}

/**
 * Получить HF клиент
 * Пересоздаёт клиент если токен изменился
 */
async function getClient(): Promise<InferenceClient> {
  const token = await getHfToken();
  
  if (!token) {
    throw Object.assign(
      new Error('HF_TOKEN не настроен. Добавьте его в админке → API Ключи.'),
      { code: 'HF_NOT_CONFIGURED' }
    );
  }

  // Пересоздаём клиент если токен изменился
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
 * Определяет, является ли сообщение запросом на генерацию изображения (regex)
 */
export function detectImageGenIntent(text: string): boolean {
  return IMAGE_GEN_PATTERNS.some(pattern => pattern.test(text.trim()));
}

// Модели для LLM-классификации (бесплатные, быстрые)
const CLASSIFY_MODELS = [
  'meta-llama/llama-3.2-3b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
];

// Быстрый пре-фильтр: слова-маркеры (нечёткие), чтобы не вызывать LLM на каждом сообщении
const IMAGE_HINT_WORDS = /(?:рисун|картин|изображен|нарисуй|нарисова|рисуй|рисовать|генерир|генераци|сгенер|imagine|draw|paint|picture|image|photo|арт|иллюстрац|фото|покажи|визуализ|пикч|портрет|скетч|пейзаж|аниме|стиль|коллаж|обои|аватар|мем|комикс|создай.*картин|сделай.*картин|хочу.*картин)/i;

/**
 * LLM-классификация: является ли текст запросом на генерацию изображения.
 * Используется как fallback когда regex не сработал.
 * Сначала проверяет наличие слов-маркеров, затем вызывает LLM.
 * Возвращает промпт для генерации или null если не запрос на картинку.
 */
export async function detectImageIntentLLM(text: string): Promise<string | null> {
  // Быстрый пре-фильтр: если нет ни одного слова-маркера — не тратим LLM
  if (!IMAGE_HINT_WORDS.test(text)) {
    return null;
  }

  try {
    const keys = await getApiKeys();
    if (!keys.openrouter) return null;

    const classifyPrompt = `Определи, просит ли пользователь СОЗДАТЬ/НАРИСОВАТЬ/СГЕНЕРИРОВАТЬ изображение или картинку.

Сообщение: "${text.substring(0, 300)}"

Если пользователь хочет КАРТИНКУ — ответь JSON: {"image": true, "prompt": "описание для генерации на английском"}
Если НЕ хочет картинку — ответь JSON: {"image": false}

Примеры запросов на картинку:
- "нарисуй кота" → {"image": true, "prompt": "cat"}
- "хочу картинку с закатом" → {"image": true, "prompt": "sunset landscape"}
- "мир это матрица, покажи" → {"image": true, "prompt": "matrix digital world, green code"}
- "сделай арт киберпанк города" → {"image": true, "prompt": "cyberpunk city art"}
- "можешь нарисовать единорога?" → {"image": true, "prompt": "unicorn, magical"}

НЕ запросы на картинку:
- "расскажи о картинах Моне" → {"image": false}
- "что такое матрица?" → {"image": false}

Ответь ТОЛЬКО JSON, без текста.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      for (const model of CLASSIFY_MODELS) {
        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${keys.openrouter}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: 'Ты — классификатор намерений. Отвечай ТОЛЬКО JSON.' },
                { role: 'user', content: classifyPrompt },
              ],
              max_tokens: 150,
              temperature: 0.1,
            }),
          });

          if (!response.ok) continue;

          const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content?.trim();
          if (!content) continue;

          // Извлекаем JSON из ответа
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;

          const parsed = JSON.parse(jsonMatch[0]) as { image?: boolean; prompt?: string };
          
          if (parsed.image && parsed.prompt) {
            aiLogger.info({ model, text: text.substring(0, 60), prompt: parsed.prompt }, 'LLM detected image intent');
            let prompt = parsed.prompt.trim();
            if (prompt.length > 0 && prompt.length < 100) {
              prompt += QUALITY_SUFFIX;
            }
            return prompt;
          }

          // LLM сказала "не картинка" — доверяем
          aiLogger.debug({ model, text: text.substring(0, 60) }, 'LLM: not an image request');
          return null;
        } catch (modelError) {
          const err = modelError as { name?: string };
          if (err.name === 'AbortError') {
            aiLogger.warn({ text: text.substring(0, 60) }, 'LLM image intent detection timed out');
            return null;
          }
          // Попробуем следующую модель
          continue;
        }
      }

      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    aiLogger.warn({ error }, 'LLM image intent detection failed');
    return null;
  }
}

/**
 * Извлечь промпт для генерации из текста пользователя
 * "пожалуйста, нарисуй кота в космосе" → "кот в космосе"
 * "можешь нарисовать красивый закат?" → "красивый закат"
 */
export function extractImagePrompt(text: string): string {
  let prompt = text.trim();
  
  // Убираем команду /imagine
  prompt = prompt.replace(/^\/imagine\s+/i, '');
  
  // Убираем вежливые префиксы (пожалуйста, ну, а можешь и т.д.)
  prompt = prompt.replace(
    /^(пожалуйста\s*,?\s*|ну\s+|а\s+|эй\s*,?\s*|слушай\s*,?\s*|амина\s*,?\s*)/i,
    ''
  );
  
  // Убираем "можешь/сможешь + глагол" конструкции
  prompt = prompt.replace(
    /^(можешь|сможешь|попробуй|могла бы|попробуй|давай)\s+(нарисовать|нарисуй|сгенерировать|создать|сделать)\s*/i,
    ''
  );
  
  // Убираем "хочу/покажи + существительное"
  prompt = prompt.replace(
    /^(хочу|покажи|покажи мне|давай)\s+(картинку|изображение|рисунок|фото|арт)\s*/i,
    ''
  );
  
  // Убираем русские глаголы-триггеры
  prompt = prompt.replace(
    /^(нарисуй|нарисуй мне|нарисуй-ка|рисуй|нарисовать|порисуй|сгенерируй|сгенерируй мне|сгенерировать|создай|создай мне|сделай|сделай мне)\s+(картинку|изображение|рисунок|фото|арт|иллюстрацию|пикчу)?\s*/i,
    ''
  );
  
  // Убираем английские триггеры
  prompt = prompt.replace(/^(imagine|draw|generate|paint|create)\s+(a |an |the |me )?(picture |image |photo |art |illustration )?(of\s+)?/i, '');
  
  // Убираем финальные вежливости ("пожалуйста", "?", ".")
  prompt = prompt.replace(/[,\s]*(пожалуйста|плиз|please)[.!?]*$/i, '');
  prompt = prompt.replace(/[.!?]+$/, '');
  
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
    // Promise.race для таймаута — HF InferenceClient не поддерживает AbortSignal
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(Object.assign(
          new Error('Генерация заняла слишком долго. Попробуй более простой промпт.'),
          { code: 'HF_TIMEOUT', name: 'AbortError' }
        ));
      }, GENERATION_TIMEOUT_MS);
    });

    // InferenceClient не сохраняет overload-типы, поэтому cast необходим.
    // По умолчанию (без outputType) textToImage возвращает Blob.
    const imageBlob = await Promise.race([
      client.textToImage({
        model: DEFAULT_MODEL,
        inputs: prompt,
        provider: HF_PROVIDER,
        parameters: {
          num_inference_steps: 4,
        },
      }) as unknown as Promise<Blob>,
      timeoutPromise,
    ]);

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
