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

/** 
 * Fallback модели (в порядке приоритета)
 * ВАЖНО: ТОЛЬКО модели доступные через hf-inference провайдер (проверено 2026-03-03)
 * Список: https://huggingface.co/api/models?pipeline_tag=text-to-image&inference_provider=hf-inference
 * FLUX.1-dev УДАЛЁН — недоступен через hf-inference с 2026-02
 */
const FALLBACK_MODELS = [
  'black-forest-labs/FLUX.1-schnell',              // Основная (4 шага, Apache 2.0)
  'stabilityai/stable-diffusion-xl-base-1.0',      // Fallback 1 (SDXL, проверенная)
  'stabilityai/stable-diffusion-3-medium-diffusers', // Fallback 2 (SD3)
];

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

/** Cached token from DB (separate from currentHfToken which tracks the client's token) */
let cachedHfToken: string | null = null;

/**
 * Получить HF токен из БД (с кэшированием)
 */
async function getHfToken(): Promise<string | null> {
  const now = Date.now();
  
  // Кэш валиден — возвращаем (включая currentHfToken от клиента)
  if (cachedHfToken && now - hfTokenCacheTime < HF_TOKEN_CACHE_TTL) {
    return cachedHfToken;
  }

  try {
    const token = await settingsRepo.get('hf_token');
    if (token) {
      cachedHfToken = token;
      hfTokenCacheTime = now;
      return token;
    }
    return null;
  } catch (error) {
    aiLogger.error({ error }, 'Failed to get HF token from DB');
    return cachedHfToken || currentHfToken || null;
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
  translatedPrompt: string;
  generationTimeMs: number;
}

/**
 * Определяет, является ли сообщение запросом на генерацию изображения (regex)
 */
export function detectImageGenIntent(text: string): boolean {
  return IMAGE_GEN_PATTERNS.some(pattern => pattern.test(text.trim()));
}

// =============================================
// Groq-классификатор намерения на картинку
// =============================================

/** Groq API endpoint (OpenAI-compatible) */
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
/** Модели Groq для классификации (быстрые, бесплатные) */
const GROQ_CLASSIFY_MODELS = [
  'llama-3.1-8b-instant',    // ~100ms, 30 RPM free
  'gemma2-9b-it',            // ~200ms, 30 RPM free
  'llama-3.3-70b-versatile', // ~500ms, smart fallback
];

/**
 * Groq-классификация: является ли текст запросом на генерацию изображения.
 * 
 * Используется как fallback когда regex не сработал.
 * Groq отвечает за ~100-300ms — почти незаметно для пользователя.
 * БЕЗ пре-фильтра — Groq достаточно быстрый чтобы проверять каждое сообщение.
 * 
 * Возвращает промпт для генерации (на английском) или null.
 */
export async function classifyImageIntentGroq(text: string): Promise<string | null> {
  // Слишком короткие сообщения — точно не запрос на картинку
  if (text.trim().length < 4) return null;

  try {
    const keys = await getApiKeys();
    if (!keys.groq) {
      aiLogger.debug('Groq API key not configured, skipping image intent classification');
      return null;
    }

    const classifyPrompt = `Определи, просит ли пользователь СОЗДАТЬ/НАРИСОВАТЬ/СГЕНЕРИРОВАТЬ изображение, картинку, арт, фото.

Сообщение пользователя: "${text.substring(0, 400)}"

ВАЖНО: Если пользователь хочет КАРТИНКУ (в любой формулировке) — ответь JSON:
{"image": true, "prompt": "English description for image generation"}

Если НЕ хочет картинку — ответь JSON: {"image": false}

Примеры ЗАПРОСОВ на картинку:
- "нарисуй кота" → {"image": true, "prompt": "cat, cute, detailed"}
- "хочу картинку с закатом" → {"image": true, "prompt": "beautiful sunset landscape"}
- "мир это матрица нарисуй" → {"image": true, "prompt": "matrix digital world, green code rain, futuristic"}
- "покажи мне как выглядит киберпанк город" → {"image": true, "prompt": "cyberpunk city at night, neon lights, futuristic"}
- "можешь нарисовать единорога" → {"image": true, "prompt": "unicorn, magical, fantasy art"}
- "сделай картинку космоса" → {"image": true, "prompt": "outer space, stars, galaxies, nebula"}
- "нарисовала бы ты мне котика" → {"image": true, "prompt": "cute kitten, adorable"}
- "а изобрази-ка мне дракона" → {"image": true, "prompt": "dragon, fantasy, epic"}

НЕ запросы на картинку:
- "расскажи о картинах Моне" → {"image": false}
- "что такое матрица" → {"image": false}
- "привет как дела" → {"image": false}
- "какая погода" → {"image": false}

Ответь СТРОГО одним JSON без текста.`;

    for (const model of GROQ_CLASSIFY_MODELS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        try {
          const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${keys.groq}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: 'You are an intent classifier. Respond with JSON only. No extra text.' },
                { role: 'user', content: classifyPrompt },
              ],
              max_tokens: 150,
              temperature: 0.05,
            }),
          });

          if (!response.ok) {
            aiLogger.debug({ model, status: response.status }, 'Groq classify: model failed, trying next');
            continue;
          }

          const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content?.trim();
          if (!content) continue;

          // Извлекаем JSON из ответа
          const jsonMatch = content.match(/\{[\s\S]*?\}/);
          if (!jsonMatch) {
            aiLogger.debug({ model, raw: content.substring(0, 100) }, 'Groq classify: no JSON in response');
            continue;
          }

          const parsed = JSON.parse(jsonMatch[0]) as { image?: boolean; prompt?: string };

          if (parsed.image && parsed.prompt) {
            aiLogger.info(
              { model, text: text.substring(0, 80), prompt: parsed.prompt },
              '🎨 Groq detected image intent!'
            );
            let prompt = parsed.prompt.trim();
            if (prompt.length > 0 && prompt.length < 100) {
              prompt += QUALITY_SUFFIX;
            }
            return prompt;
          }

          // Groq сказала "не картинка" — доверяем
          aiLogger.debug({ model, text: text.substring(0, 60) }, 'Groq: not an image request');
          return null;
        } catch (modelError) {
          const err = modelError as { name?: string; message?: string };
          if (err.name === 'AbortError') {
            aiLogger.warn({ model, text: text.substring(0, 60) }, 'Groq image classify timed out');
            continue;
          }
          aiLogger.debug({ model, error: err.message }, 'Groq classify model error, trying next');
          continue;
        } finally {
          clearTimeout(timeoutId);
        }
      }

    aiLogger.warn('All Groq classify models failed');
    return null;
  } catch (error) {
    aiLogger.warn({ error }, 'Groq image intent classification failed');
    return null;
  }
}

/**
 * Классификация намерения РЕДАКТИРОВАТЬ изображение через Groq.
 * Возвращает true, если пользователь хочет изменить картинку.
 */
export async function classifyImageEditIntentGroq(text: string): Promise<boolean> {
  try {
    const keys = await getApiKeys();
    if (!keys.groq) return false;

    const classifyPrompt = `Определи, просит ли пользователь ОТРЕДАКТИРОВАТЬ/ИЗМЕНИТЬ существующее изображение.
Учитывай контекст: пользователь либо отправил фото с подписью, либо ответил на фото.

Сообщение пользователя: "${text.substring(0, 400)}"

ВАЖНО: Если пользователь хочет ИЗМЕНИТЬ картинку (убрать фон, сделать ярче, добавить что-то, стилизовать и т.д.) — ответь JSON: {"edit": true}
Если это просто описание картинки или вопрос о ней — ответь JSON: {"edit": false}

Примеры ЗАПРОСОВ на редактирование:
- "убери фон" → {"edit": true}
- "сделай ярче" → {"edit": true}
- "добавь кота на плечо" → {"edit": true}
- "стилизуй под аниме" → {"edit": true}
- "обрежь края" → {"edit": true}
- "перекрась машину в красный" → {"edit": true}

НЕ запросы на редактирование:
- "что на этой картинке?" → {"edit": false}
- "красивое фото" → {"edit": false}
- "кто это нарисовал?" → {"edit": false}
- "привет" → {"edit": false}

Ответь СТРОГО одним JSON без текста.`;

    for (const model of GROQ_CLASSIFY_MODELS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${keys.groq}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You are an intent classifier. Respond with JSON only.' },
              { role: 'user', content: classifyPrompt },
            ],
            max_tokens: 50,
            temperature: 0,
          }),
        });

        if (!response.ok) continue;
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) continue;

        const jsonMatch = content.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) continue;

        const parsed = JSON.parse(jsonMatch[0]) as { edit?: boolean };
        if (parsed.edit === true) {
          aiLogger.info({ model, text: text.substring(0, 60) }, '✏️ Groq detected image edit intent!');
          return true;
        }
        return false;
      } catch {
        continue;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } catch (error) {
    aiLogger.warn({ error }, 'Groq image edit intent classification failed');
  }
  return false;
}

/**
 * Проверяет, содержит ли ОТВЕТ AI паттерны, указывающие на нераспознанный запрос на картинку.
 * Используется как post-AI safety net: если AI говорит о картинках/imagine — значит
 * пользователь хотел картинку, но pre-AI детекция не сработала.
 */
export function isAIResponseAboutImages(aiResponseText: string): boolean {
  return /(?:не умею создавать картин|\/imagine\s|хочешь картинку|генераци\w* изображен|нарисую.*напиши|используй команду.*imagine|отдельная система генерации|не могу создавать картинки|не умею рисовать|не могу рисовать|я не создаю изображен)/i.test(aiResponseText);
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
  
  if (!prompt) {
    return 'abstract colorful art' + QUALITY_SUFFIX;
  }

  if (prompt.length < 100) {
    prompt += QUALITY_SUFFIX;
  }
  
  return prompt;
}

// --------------------------------------------
// Prompt Translation (Russian → English via основная LLM)
// --------------------------------------------

/** Проверка: содержит ли текст кириллицу */
function hasCyrillic(text: string): boolean {
  return /[а-яёА-ЯЁ]/.test(text);
}

/**
 * Переводит промпт на английский через основную LLM (OpenRouter).
 * Если промпт уже на английском — возвращает как есть.
 * При ошибке — возвращает оригинал (лучше русский промпт, чем ничего).
 */
async function translatePromptToEnglish(prompt: string): Promise<string> {
  // Уже на английском — не трогаем
  if (!hasCyrillic(prompt)) {
    aiLogger.debug({ prompt: prompt.substring(0, 60) }, 'Prompt already in English, skipping translation');
    return prompt;
  }

  try {
    const { aiService } = await import('./openrouter.js');

    const response = await aiService.complete(
      'You are a prompt translator for AI image generation. Translate the following Russian image description to English. Output ONLY the English translation. Make it vivid and descriptive. Keep it concise (under 200 chars). Do NOT add quotes or explanations.\n\nTranslate: ' + prompt,
      'telegram',
    );

    const translated = response?.trim();

    if (translated && translated.length > 3 && translated.length < 500) {
      aiLogger.info(
        { original: prompt.substring(0, 60), translated: translated.substring(0, 80) },
        '🌐 Prompt translated to English via main LLM'
      );
      return translated;
    }

    return prompt;
  } catch (error) {
    aiLogger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Prompt translation failed, using original');
    return prompt;
  }
}

// --------------------------------------------
// Image Generation
// --------------------------------------------

/**
 * Попытка генерации с одной моделью
 */
async function tryGenerateWithModel(
  client: InferenceClient,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<Buffer> {
  aiLogger.info({ model, prompt: prompt.substring(0, 60) }, 'Attempting image generation');
  
  let genTimeoutId: ReturnType<typeof setTimeout> | undefined;
  
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      genTimeoutId = setTimeout(() => {
        reject(Object.assign(
          new Error(`Model ${model} timeout`),
          { code: 'HF_TIMEOUT', name: 'AbortError' }
        ));
      }, timeoutMs);
    });

    // Определяем параметры в зависимости от модели
    const isFLUX = model.includes('FLUX');
    const isSD3 = model.includes('stable-diffusion-3');
    
    const parameters = isFLUX
      ? { num_inference_steps: 4 }       // FLUX быстрый (4 шага)
      : isSD3
      ? { num_inference_steps: 28 }      // SD3 (28 шагов рекомендовано)
      : { num_inference_steps: 25 };     // SDXL (25 шагов)

    const imageBlob = await Promise.race([
      client.textToImage({
        model,
        inputs: prompt,
        provider: HF_PROVIDER,
        parameters,
      }) as unknown as Promise<Blob>,
      timeoutPromise,
    ]);

    const arrayBuffer = await imageBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      throw Object.assign(
        new Error(`Model ${model} returned empty image`),
        { code: 'HF_EMPTY_RESPONSE' }
      );
    }

    aiLogger.info({ model, sizeKB: Math.round(buffer.length / 1024) }, 'Image generated successfully');
    return buffer;
  } finally {
    if (genTimeoutId) clearTimeout(genTimeoutId);
  }
}

// --------------------------------------------
// OpenRouter Image Generation (Fallback)
// --------------------------------------------

/**
 * Дефолтная модель OpenRouter для генерации изображений.
 * Gemini 3.1 Flash Image Preview — самая дешёвая ($0.0015/1K токенов)
 * Если недоступна — fallback на Gemini 2.5 Flash Image
 */
const DEFAULT_OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const OPENROUTER_IMAGE_FALLBACK_MODELS = [
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image-preview',
];
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Получить модель OpenRouter для генерации изображений из настроек
 */
async function getOpenRouterImageModel(): Promise<string> {
  try {
    const model = await settingsRepo.get('openrouter_image_model');
    if (model && model.trim().length > 0) {
      return model.trim();
    }
  } catch (error) {
    aiLogger.debug({ error }, 'Failed to get openrouter_image_model from settings, using default');
  }
  return DEFAULT_OPENROUTER_IMAGE_MODEL;
}

/**
 * Запрос генерации к OpenRouter с указанной моделью.
 * Возвращает Buffer изображения или кидает ошибку.
 */
async function fetchOpenRouterImage(
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    aiLogger.info({ model, prompt: prompt.substring(0, 60) }, 'Attempting generation via OpenRouter');

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/antsincgame/Amina-bot',
        'X-Title': 'Amina Telegram Bot',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
        stream: false,
        image_config: {
          aspect_ratio: '1:1',
          image_size: '1K',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      aiLogger.warn({ model, status: response.status, error: errorText.substring(0, 200) }, 'OpenRouter image API error');
      throw Object.assign(
        new Error(`OpenRouter API error: ${response.status} ${errorText.substring(0, 200)}`),
        { code: 'OPENROUTER_API_ERROR', status: response.status }
      );
    }

    const data = await response.json() as OpenRouterImageResponse;
    const buffer = parseOpenRouterImageResponse(data);

    aiLogger.info({ model, sizeKB: Math.round(buffer.length / 1024) }, '✅ OpenRouter image generated successfully');
    return buffer;
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string; code?: string };
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`OpenRouter generation timeout (model: ${model})`), { code: 'OPENROUTER_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Генерация через OpenRouter с fallback по нескольким моделям.
 * Сначала пробует настроенную модель, затем — OPENROUTER_IMAGE_FALLBACK_MODELS.
 */
async function tryGenerateViaOpenRouter(prompt: string, timeoutMs: number): Promise<{ buffer: Buffer; model: string }> {
  const keys = await getApiKeys();
  const openrouterApiKey = keys.openrouter;

  if (!openrouterApiKey) {
    aiLogger.warn('OpenRouter API key not configured, cannot fallback');
    throw new Error('OpenRouter API key not configured');
  }

  const configuredModel = await getOpenRouterImageModel();
  const modelsToTry = [configuredModel, ...OPENROUTER_IMAGE_FALLBACK_MODELS.filter(m => m !== configuredModel)];

  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      const buffer = await fetchOpenRouterImage(openrouterApiKey, model, prompt, timeoutMs);
      return { buffer, model };
    } catch (error: unknown) {
      const err = error as { code?: string; status?: number; message?: string };
      lastError = error as Error;

      if (err.code === 'OPENROUTER_TIMEOUT') throw error;
      if (err.status === 401 || err.status === 403) throw error;
      if (err.status === 429) throw error;

      aiLogger.warn({ model, error: err.message, code: err.code }, 'OpenRouter model failed, trying next');
      continue;
    }
  }

  throw lastError ?? new Error('All OpenRouter image models failed');
}

/**
 * Генерирует изображение по текстовому описанию с fallback на альтернативные модели.
 * Автоматически переводит русский промпт на английский для лучшего результата.
 * 
 * Стратегия fallback:
 * 1. HuggingFace (4 модели: FLUX, SD3, SDXL) - БЕСПЛАТНО (если есть токен)
 * 2. OpenRouter (Gemini 2.5 Flash Image) - $0.04 за картинку
 */
export async function generateImage(prompt: string): Promise<ImageGenResult> {
  const startTime = Date.now();

  // Переводим промпт на английский если он на русском
  const translatedPrompt = await translatePromptToEnglish(prompt);

  aiLogger.info({ 
    originalPrompt: prompt, 
    translatedPrompt, 
    primaryModel: FALLBACK_MODELS[0],
    fallbackCount: FALLBACK_MODELS.length - 1,
  }, 'Starting image generation with fallback support');

  let lastError: Error | null = null;
  let skippedHF = false;

  // ===== ЭТАП 1: Пробуем HuggingFace модели =====
  try {
    const client = await getClient();
    aiLogger.info({ modelsCount: FALLBACK_MODELS.length }, 'HF client initialized, trying models');

    for (let i = 0; i < FALLBACK_MODELS.length; i++) {
      const model = FALLBACK_MODELS[i]!;
      const isFallback = i > 0;
      
      if (isFallback) {
        aiLogger.info({ model, attemptNumber: i + 1 }, 'Primary model failed, trying fallback model');
      }

      try {
        const buffer = await tryGenerateWithModel(client, model, translatedPrompt, GENERATION_TIMEOUT_MS);
        const generationTimeMs = Date.now() - startTime;

        if (isFallback) {
          aiLogger.info({ 
            model, 
            attemptNumber: i + 1,
            timeMs: generationTimeMs,
          }, '✅ Fallback model succeeded!');
        }

        return {
          image: buffer,
          model,
          prompt,
          translatedPrompt,
          generationTimeMs,
        };
      } catch (error: unknown) {
        const err = error as { status?: number; message?: string; name?: string; code?: string };
        lastError = err as Error;
        
        const timeElapsed = Date.now() - startTime;
        
        aiLogger.warn({ 
          model, 
          attemptNumber: i + 1,
          error: err.message,
          status: err.status,
          code: err.code,
          timeElapsed,
        }, `Model ${model} failed${i < FALLBACK_MODELS.length - 1 ? ', trying next' : ', exhausted HF models'}`);

        if (err.status === 401 || err.code === 'HF_AUTH_ERROR') {
          aiLogger.warn('HF auth error - will skip to OpenRouter fallback');
          skippedHF = true;
          break;
        }

        if (err.message?.includes('Credit balance is depleted') || err.message?.includes('purchase pre-paid credits')) {
          aiLogger.warn('HF credits depleted - skipping to OpenRouter fallback');
          skippedHF = true;
          break;
        }

        if (err.message?.includes('Rate limit') || err.status === 429) {
          aiLogger.warn('HF rate limited - skipping to OpenRouter fallback');
          skippedHF = true;
          break;
        }

        continue;
      }
    }
  } catch (clientError: unknown) {
    const err = clientError as { code?: string; message?: string };
    aiLogger.warn({ error: err.message, code: err.code }, 'Failed to initialize HF client, skipping to OpenRouter');
    lastError = err as Error;
    skippedHF = true;
  }

  // ===== ЭТАП 2: Все HF модели упали или пропущены → пробуем OpenRouter =====
  aiLogger.info({ 
    reason: skippedHF ? 'HF_SKIP' : 'HF_ALL_FAILED',
    triedHFModels: skippedHF ? 'skipped' : FALLBACK_MODELS.length,
  }, 'Attempting OpenRouter as final fallback');

  try {
    const orResult = await tryGenerateViaOpenRouter(translatedPrompt, GENERATION_TIMEOUT_MS);
    const generationTimeMs = Date.now() - startTime;

    aiLogger.info({ 
      model: orResult.model,
      timeMs: generationTimeMs,
      hfAttempted: !skippedHF,
    }, '✅ OpenRouter fallback succeeded!');

    return {
      image: orResult.buffer,
      model: orResult.model,
      prompt,
      translatedPrompt,
      generationTimeMs,
    };
  } catch (orError: unknown) {
    const err = orError as { code?: string; message?: string };
    aiLogger.error({ 
      error: err.message,
      code: err.code,
      triedHF: !skippedHF,
      triedOpenRouter: true,
    }, 'OpenRouter fallback also failed');
    
    lastError = err as Error;
  }

  // ===== ВСЕ ПРОВАЙДЕРЫ УПАЛИ =====
  const generationTimeMs = Date.now() - startTime;
  const err = lastError as { status?: number; message?: string; name?: string; code?: string } | null;
  
  aiLogger.error(
    { 
      triedProviders: skippedHF ? ['OpenRouter'] : ['HuggingFace', 'OpenRouter'],
      triedHFModels: skippedHF ? 0 : FALLBACK_MODELS.length,
      lastError: err?.message,
      timeMs: generationTimeMs,
    },
    'All image generation providers failed'
  );

  // Таймаут
  if (err?.name === 'AbortError' || err?.code === 'HF_TIMEOUT' || err?.code === 'OPENROUTER_TIMEOUT') {
    throw Object.assign(
      new Error('Генерация заняла слишком долго. Попробуй более простой промпт.'),
      { code: 'TIMEOUT' }
    );
  }

  // Rate limit (любой провайдер)
  if (err?.status === 429 || err?.message?.includes('429')) {
    throw Object.assign(
      new Error('Слишком много запросов к AI сервисам. Подожди минуту.'),
      { code: 'RATE_LIMIT' }
    );
  }

  // Model loading (HF)
  if (err?.status === 503 || err?.message?.includes('503')) {
    throw Object.assign(
      new Error('Модели загружаются на сервере. Попробуй через 30 секунд.'),
      { code: 'MODEL_LOADING' }
    );
  }

  // Generic error
  const providerList = skippedHF ? 'OpenRouter' : `HuggingFace (${FALLBACK_MODELS.length} моделей) + OpenRouter`;
  throw Object.assign(
    new Error(
      `Не удалось сгенерировать изображение (попробовано: ${providerList}): ${err?.message || 'неизвестная ошибка'}. Попробуй позже.`
    ),
    { code: 'GENERATION_ERROR' }
  );
}

/**
 * Проверить доступность генерации изображений
 */
export async function isImageGenAvailable(): Promise<boolean> {
  const token = await getHfToken();
  if (token) return true;
  const { getApiKeys } = await import('../config/index.js');
  const keys = await getApiKeys();
  return !!keys.openrouter;
}

// ============================================
// Image Editing (input image + text → output image)
// ============================================

const IMAGE_EDIT_PATTERNS = [
  /\b(измени|отредактируй|исправь|переделай|перерисуй|поменяй|смени|замени|подправь)\b/i,
  /\b(убери|удали|уберите|удалите|вырежи|вырежьте)\b/i,
  /\b(добавь|добавьте|вставь|вставьте|дорисуй|нарисуй|напиши)\b/i,
  /\b(сделай|сделайте)\b/i,
  /\b(обрежь|поверни|отзеркаль|переверни|увеличь|уменьши|растяни|сожми|разверни)\b/i,
  /\b(перекрась|покрась|раскрась|закрась)\b/i,
  /\b(фон|задний план|бэкграунд)\b/i,
  /\b(стилизуй|стилизовать|в стиле|как у|эффект)\b/i,
  /\b(улучши|улучшить|апскейл|upscale|качество)\b/i,
  /\b(ярче|темнее|контрастнее|чётче|четче|резче|светлее|теплее|холоднее)\b/i,
  /\b(edit|modify|change|fix|remove|add|replace|crop|rotate|flip|enhance|brighten|darken|style)\b/i,
  /\b(make|remove|background|text|color)\b/i,
];

/**
 * Определяет, является ли текст запросом на редактирование изображения.
 * Используется для caption к фото и для reply-сообщений.
 */
export function detectImageEditIntent(text: string): boolean {
  if (!text || text.trim().length < 3) return false;
  return IMAGE_EDIT_PATTERNS.some(p => p.test(text.trim()));
}

/**
 * Извлечь чистый промпт редактирования из текста.
 * "пожалуйста, убери фон на этой картинке" → "убери фон"
 */
export function extractEditPrompt(text: string): string {
  let prompt = text.trim();
  // Убираем только вводные слова, сохраняя саму инструкцию (глагол + объект)
  prompt = prompt.replace(/^(пожалуйста\s*,?\s*|ну\s+|а\s+|эй\s*,?\s*|слушай\s*,?\s*|амина\s*,?\s*)/i, '');
  prompt = prompt.replace(/^(можешь|сможешь|попробуй|могла бы|хочу|нужно|надо)\s+/i, '');
  prompt = prompt.replace(/\s*(на\s+этой\s+картинке|на\s+этом\s+фото|на\s+фото|на\s+картинке|на\s+изображении|this\s+image|this\s+photo)[.!?]?\s*$/i, '');
  prompt = prompt.replace(/[,\s]*(пожалуйста|плиз|please)[.!?]*$/i, '');
  prompt = prompt.replace(/[.!?]+$/, '');
  return prompt.trim() || text.trim();
}

/**
 * Переводит промпт редактирования на английский.
 * Отличается от translatePromptToEnglish: специализирован для edit-инструкций.
 */
async function translateEditPromptToEnglish(prompt: string): Promise<string> {
  if (!hasCyrillic(prompt)) return prompt;

  try {
    const { aiService } = await import('./openrouter.js');
    const response = await aiService.complete(
      'You are a specialized translator for AI image editing instructions.\n' +
      'Translate the Russian editing instruction to English.\n\n' +
      'RULES:\n' +
      '1. Preserve imperative mood ("remove", "add", "make brighter" — NOT "please remove")\n' +
      '2. Keep spatial references accurate ("left", "right", "center", "top", "bottom")\n' +
      '3. Preserve color names and style references ("Van Gogh style", "anime style")\n' +
      '4. For compound instructions, translate ALL parts\n' +
      '5. Output ONLY the English translation, nothing else\n\n' +
      'Translate: ' + prompt,
      'telegram',
    );
    const translated = response?.trim();
    if (translated && translated.length > 2 && translated.length < 500) {
      aiLogger.info(
        { original: prompt.substring(0, 60), translated: translated.substring(0, 80) },
        'Edit prompt translated to English'
      );
      return translated;
    }
    return prompt;
  } catch {
    aiLogger.warn('Edit prompt translation failed, using original');
    return prompt;
  }
}

interface OpenRouterImageChoice {
  message?: {
    content?: string | Array<{ type?: string; image_url?: { url?: string }; imageUrl?: { url?: string } }>;
    images?: Array<{
      image_url?: { url?: string };
      imageUrl?: { url?: string };
    }>;
  };
}

interface OpenRouterImageResponse {
  choices?: OpenRouterImageChoice[];
}

/**
 * Извлекает base64 data URL из ответа OpenRouter.
 * Поддерживает несколько форматов:
 * 1. message.images[].image_url.url (snake_case — raw API)
 * 2. message.images[].imageUrl.url (camelCase — SDK)
 * 3. message.content[] multipart с image_url блоками
 */
function extractImageUrlFromResponse(data: OpenRouterImageResponse): string | null {
  const message = data.choices?.[0]?.message;
  if (!message) return null;

  if (message.images && message.images.length > 0) {
    const img = message.images[0];
    if (!img) return null;
    const url = img.image_url?.url ?? img.imageUrl?.url;
    if (url) return url;
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url ?? part.imageUrl?.url;
        if (url) return url;
      }
    }
  }

  if (typeof message.content === 'string' && message.content.startsWith('data:image/')) {
    return message.content;
  }

  return null;
}

/**
 * Парсинг base64-изображения из ответа OpenRouter.
 * Вынесено из tryGenerateViaOpenRouter для переиспользования в editImage.
 */
function parseOpenRouterImageResponse(data: OpenRouterImageResponse): Buffer {
  const imageUrl = extractImageUrlFromResponse(data);

  if (!imageUrl) {
    aiLogger.error({ 
      hasChoices: !!data.choices?.length,
      hasMessage: !!data.choices?.[0]?.message,
      hasImages: !!data.choices?.[0]?.message?.images?.length,
      contentType: typeof data.choices?.[0]?.message?.content,
      rawKeys: data.choices?.[0]?.message ? Object.keys(data.choices[0].message) : [],
    }, 'OpenRouter response missing image — dumping structure for debug');
    throw Object.assign(new Error('OpenRouter response missing image URL'), { code: 'OPENROUTER_NO_IMAGE' });
  }

  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    throw Object.assign(
      new Error('OpenRouter returned URL instead of base64 — external URL fetching not implemented'),
      { code: 'OPENROUTER_EXTERNAL_URL' }
    );
  }

  if (!imageUrl.startsWith('data:image/')) {
    throw Object.assign(new Error('OpenRouter returned invalid image format'), { code: 'OPENROUTER_INVALID_FORMAT' });
  }

  const base64Match = imageUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (!base64Match?.[1]) {
    throw Object.assign(new Error('Failed to parse OpenRouter base64 image'), { code: 'OPENROUTER_PARSE_ERROR' });
  }
  const buffer = Buffer.from(base64Match[1], 'base64');
  if (buffer.length === 0) {
    throw Object.assign(new Error('OpenRouter returned empty image'), { code: 'OPENROUTER_EMPTY_IMAGE' });
  }
  return buffer;
}

const MAX_IMAGE_BASE64_SIZE = 7 * 1024 * 1024; // 7MB Gemini limit

/**
 * Редактирует изображение по текстовому описанию через OpenRouter Gemini.
 * Принимает base64-изображение + промпт редактирования, возвращает новое изображение.
 */
export async function editImage(
  imageBase64: string,
  mimeType: string,
  editPrompt: string,
): Promise<ImageGenResult> {
  const startTime = Date.now();

  if (imageBase64.length > MAX_IMAGE_BASE64_SIZE) {
    throw Object.assign(
      new Error('Изображение слишком большое для редактирования (макс. 7 МБ). Попробуй сжать или обрезать.'),
      { code: 'IMAGE_TOO_LARGE' }
    );
  }

  const cleanPrompt = extractEditPrompt(editPrompt);
  const translatedPrompt = await translateEditPromptToEnglish(cleanPrompt);

  const keys = await getApiKeys();
  if (!keys.openrouter) {
    throw Object.assign(
      new Error('OpenRouter API key не настроен. Настройте его в админке для редактирования изображений.'),
      { code: 'OPENROUTER_NOT_CONFIGURED' }
    );
  }

  const model = await getOpenRouterImageModel();
  aiLogger.info({ model, prompt: translatedPrompt.substring(0, 80) }, 'Starting image edit via OpenRouter');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keys.openrouter}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/antsincgame/Amina-bot',
        'X-Title': 'Amina Telegram Bot',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a professional image editor. Apply this edit precisely:\n\n` +
                `INSTRUCTION: ${translatedPrompt}\n\n` +
                `RULES:\n` +
                `- Make ONLY the requested change, preserve everything else\n` +
                `- Maintain the original resolution, composition, and quality\n` +
                `- If removing an object, fill the area naturally with the surrounding context\n` +
                `- If changing colors/style, keep the subject recognizable\n` +
                `- Return ONLY the edited image, no text`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
          ],
        }],
        modalities: ['text', 'image'],
        image_config: {
          image_size: '1K',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw Object.assign(
        new Error(`OpenRouter API error: ${response.status} ${errorText.substring(0, 200)}`),
        { code: 'OPENROUTER_API_ERROR', status: response.status }
      );
    }

    const data = await response.json() as OpenRouterImageResponse;
    const buffer = parseOpenRouterImageResponse(data);
    const generationTimeMs = Date.now() - startTime;

    aiLogger.info({ model, sizeKB: Math.round(buffer.length / 1024), timeMs: generationTimeMs }, 'Image edited successfully');

    return {
      image: buffer,
      model,
      prompt: editPrompt,
      translatedPrompt,
      generationTimeMs,
    };
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string; code?: string; status?: number };
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('Редактирование заняло слишком долго. Попробуй ещё раз.'), { code: 'TIMEOUT' });
    }
    if (err.status === 429) {
      throw Object.assign(new Error('Слишком много запросов. Подожди минуту.'), { code: 'RATE_LIMIT' });
    }
    if (err.code && err.code.startsWith('OPENROUTER_')) throw error;
    throw Object.assign(
      new Error(`Не удалось отредактировать изображение: ${err.message || 'неизвестная ошибка'}. Попробуй позже.`),
      { code: 'EDIT_ERROR' }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
