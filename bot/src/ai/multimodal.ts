/**
 * Multimodal AI Service
 * 
 * Обработка голосовых сообщений и изображений через OpenRouter
 */

import OpenAI from 'openai';
import { config } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/index.js';
import { getProxyHeaders } from '../config/ai-proxy.js';

import { AppError } from '../utils/error-handler.js';
import type { AIResponse } from '../../../shared/types/index.js';
import { SingleCache } from '../utils/cache.js';

// --------------------------------------------
// Types
// --------------------------------------------

export interface VisionAnalysisResult {
  description: string;
  model: string;
  tokens_used: number;
}

export interface AudioTranscriptionResult {
  text: string;
  model: string;
  duration_seconds?: number;
}

// --------------------------------------------
// Model Lists
// --------------------------------------------

// Статический fallback vision моделей (если API недоступен)
const STATIC_FREE_VISION_MODELS = [
  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', description: 'Google Gemma 3 vision (бесплатная)' },
  { id: 'google/gemma-3-12b-it:free', name: 'Gemma 3 12B', description: 'Google Gemma 3 12B vision (бесплатная)' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct:free', name: 'Mistral Small 3.1', description: 'Mistral vision модель (бесплатная)' },
  { id: 'nvidia/nemotron-nano-12b-v2-vl:free', name: 'Nemotron Nano VL', description: 'NVIDIA Nemotron vision (бесплатная)' },
  { id: 'xiaomi/mimo-v2-pro', name: 'MiMo V2 Pro', description: 'Xiaomi MiMo V2 Pro vision' },
];

// Кэш динамических бесплатных vision моделей
const visionModelsCache = new SingleCache<Array<{ id: string; name: string; description: string }>>(5 * 60 * 1000);

/**
 * Динамически получает список БЕСПЛАТНЫХ vision моделей от OpenRouter
 */
async function fetchFreeVisionModels(): Promise<Array<{ id: string; name: string; description: string }>> {
  const cached = visionModelsCache.get();
  if (cached) return cached;

  try {
    const keys = await getApiKeys();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let response: Response;
    try {
      response = await fetch(`${config.ai.baseUrl}/models`, {
        headers: getProxyHeaders({ 'Authorization': `Bearer ${keys.openrouter}` }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);

    const data = await response.json() as {
      data: Array<{
        id: string;
        name: string;
        description?: string;
        pricing: { prompt: string; completion: string };
        architecture?: { input_modalities?: string[] };
        context_length?: number;
      }>;
    };

    // Фильтруем: бесплатные + поддерживают image input
    const freeVision = data.data
      .filter(m => m.pricing.prompt === '0' && m.pricing.completion === '0')
      .filter(m => m.architecture?.input_modalities?.includes('image'))
      .filter(m => (m.context_length || 0) >= 2048)
      .map(m => ({
        id: m.id,
        name: m.name || m.id.split('/').pop() || m.id,
        description: m.description || 'Бесплатная vision модель',
      }));

    if (freeVision.length > 0) {
      visionModelsCache.set(freeVision);
      aiLogger.info({ count: freeVision.length }, '🆓👁️ Fetched free vision models');
      return freeVision;
    }

    throw new Error('No free vision models found');
  } catch (error) {
    aiLogger.warn({ error }, 'Failed to fetch free vision models, using static list');
    return STATIC_FREE_VISION_MODELS;
  }
}

/** Принудительно обновить кэш vision моделей */
export async function refreshFreeVisionModelsCache(): Promise<Array<{ id: string; name: string; description: string }>> {
  visionModelsCache.clear();
  return await fetchFreeVisionModels();
}

/** Получить бесплатные vision модели (для API и админки) */
export async function getFreeVisionModels(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    return await fetchFreeVisionModels();
  } catch {
    return STATIC_FREE_VISION_MODELS;
  }
}

// Audio модели для транскрипции (только бесплатные Groq)
export const AUDIO_MODELS = {
  free: [
    { id: 'groq/whisper-large-v3', name: 'Groq Whisper Large V3 (FREE)', description: 'Бесплатная транскрипция через Groq' },
    { id: 'groq/whisper-large-v3-turbo', name: 'Groq Whisper Turbo (FREE)', description: 'Быстрая бесплатная транскрипция' },
    { id: 'groq/distil-whisper-large-v3-en', name: 'Groq Distil Whisper (FREE)', description: 'Облегчённая версия для английского' },
  ],
};

// Таймаут для гонки vision моделей
const VISION_RACE_TIMEOUT_MS = 20000;

// --------------------------------------------
// OpenRouter Client (dynamic API key)
// --------------------------------------------

import { getApiKeys } from '../config/index.js';
import { respondWithAminaCore } from './amina-core-runtime.js';

let openai: OpenAI | null = null;
let currentOpenRouterKey: string = '';

const getClient = async (): Promise<OpenAI> => {
  const keys = await getApiKeys();
  const apiKey = keys.openrouter;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY не задан. Укажите в переменных окружения или в админке.');
  }

  if (!openai || currentOpenRouterKey !== apiKey) {
    openai = new OpenAI({
      apiKey: apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 60000,
      defaultHeaders: getProxyHeaders({
        'HTTP-Referer': config.botUrl,
        'X-Title': 'Amina AI Bot',
      }),
    });
    currentOpenRouterKey = apiKey;
  }
  return openai;
};

// --------------------------------------------
// Groq Client (dynamic API key)
// --------------------------------------------

let groqClient: OpenAI | null = null;
let currentGroqKey: string = '';

const getGroqClient = async (): Promise<OpenAI | null> => {
  const keys = await getApiKeys();
  const apiKey = keys.groq;

  if (!apiKey) {
    aiLogger.warn('Groq API key not found in env or database — voice transcription unavailable');
    return null;
  }
  
  if (!groqClient || currentGroqKey !== apiKey) {
    groqClient = new OpenAI({
      apiKey: apiKey,
      baseURL: config.groq.baseUrl,
      timeout: 60000,
      defaultHeaders: getProxyHeaders(),
    });
    currentGroqKey = apiKey;
  }
  return groqClient;
};

// --------------------------------------------
// Configuration from Database
// --------------------------------------------

interface MultimodalConfig {
  visionModel: string;
  audioModel: string;
  maxTokens: number;
  visionPrompt: string;
  visionMaxTokens: number;
}

export interface SpeechRecognitionRuntimeProfile {
  audioModel: string;
  maxTokens: number;
  source: string;
}

// Дефолтные модели
const DEFAULT_VISION_MODEL = 'google/gemma-3-27b-it:free';
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
const DEFAULT_VISION_PROMPT = 'Внимательно рассмотри изображение. Если на нём есть текст — прочитай его полностью и точно. Затем опиши что изображено: объекты, сцена, детали. Ответ структурируй: сначала текст (если есть), потом описание.';
const DEFAULT_VISION_MAX_TOKENS = 1024;

const getMultimodalConfig = async (): Promise<MultimodalConfig> => {
  const settings = await settingsRepo.getMany([
    'preferred_vision_model',
    'effective_vision_model',
    'vision_model',
    'audio_model',
    'vision_model_override',
    'audio_model_override',
    'max_tokens',
    'vision_prompt',
    'vision_max_tokens',
  ]);

  // Vision model: explicit override > preferred admin choice > effective runtime state > legacy key > default
  // ВАЖНО: preferred_vision_model (ручной выбор) ДОЛЖЕН быть приоритетнее effective_vision_model (fallback)
  let visionModel = DEFAULT_VISION_MODEL;
  let visionSource = 'default';
  if (settings['vision_model']?.trim()) {
    visionModel = settings['vision_model'].trim();
    visionSource = 'database';
  }
  if (settings['effective_vision_model']?.trim()) {
    visionModel = settings['effective_vision_model'].trim();
    visionSource = 'effective';
  }
  if (settings['preferred_vision_model']?.trim()) {
    visionModel = settings['preferred_vision_model'].trim();
    visionSource = 'preferred';
  }
  if (settings['vision_model_override']?.trim()) {
    visionModel = settings['vision_model_override'].trim();
    visionSource = 'override';
  }

  // Audio: override > setting > default
  let audioModel = DEFAULT_AUDIO_MODEL;
  let audioSource = 'default';
  if (settings['audio_model']?.trim()) {
    audioModel = settings['audio_model'].trim();
    audioSource = 'database';
  }
  if (settings['audio_model_override']?.trim()) {
    audioModel = settings['audio_model_override'].trim();
    audioSource = 'override';
  }

  const visionPrompt = settings['vision_prompt']?.trim() || DEFAULT_VISION_PROMPT;
  const parsedMaxTokens = Number(settings['vision_max_tokens']);
  const visionMaxTokens = (Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0)
    ? parsedMaxTokens
    : DEFAULT_VISION_MAX_TOKENS;

  aiLogger.debug({
    visionModel, visionSource,
    audioModel, audioSource,
    visionPrompt: visionPrompt.substring(0, 50) + '...',
    visionMaxTokens,
  }, 'Multimodal config loaded');

  return {
    visionModel,
    audioModel,
    maxTokens: settings['max_tokens'] ? Number(settings['max_tokens']) : 2048,
    visionPrompt,
    visionMaxTokens,
  };
};

export async function getSpeechRecognitionRuntimeProfile(): Promise<SpeechRecognitionRuntimeProfile> {
  const config = await getMultimodalConfig();
  const state = await getAudioModelState();
  return {
    audioModel: config.audioModel,
    maxTokens: config.maxTokens,
    source: state.source,
  };
}

export async function getAudioModelState(): Promise<{
  preferredModel: string;
  effectiveModel: string;
  overrideModel: string;
  source: string;
}> {
  const settings = await settingsRepo.getMany([
    'audio_model',
    'audio_model_override',
  ]);
  const preferredModel = settings['audio_model']?.trim() || DEFAULT_AUDIO_MODEL;
  const overrideModel = settings['audio_model_override']?.trim() || '';
  const effectiveModel = overrideModel || preferredModel;
  const source = overrideModel
    ? 'override'
    : settings['audio_model']?.trim()
      ? 'preferred'
      : 'default';

  return { preferredModel, effectiveModel, overrideModel, source };
}

// --------------------------------------------
// Vision Service
// --------------------------------------------

// Ошибки при которых запускаем гонку vision моделей
const VISION_RACE_ERROR_PATTERNS = [
  'Provider returned error', 'Empty response', 'No endpoints found',
  '503', '502', '500', '400', '402', 'Payment Required',
  'temporarily unavailable', 'overloaded', '404', 'not found',
];

// Трекер последнего переключения vision модели
let lastVisionFallbackSwitch: {
  reason: string | null;
  time: Date | null;
  fromModel: string | null;
  toModel: string | null;
} = { reason: null, time: null, fromModel: null, toModel: null };

/** Получить статус fallback vision модели */
export function getVisionFallbackStatus() {
  return { ...lastVisionFallbackSwitch };
}

export async function getVisionModelState(): Promise<{
  preferredModel: string;
  effectiveModel: string;
  overrideModel: string;
  source: string;
}> {
  const settings = await settingsRepo.getMany([
    'preferred_vision_model',
    'effective_vision_model',
    'vision_model',
    'vision_model_override',
  ]);
  const preferredModel = settings['preferred_vision_model']?.trim()
    || settings['vision_model']?.trim()
    || DEFAULT_VISION_MODEL;
  const effectiveModel = settings['vision_model_override']?.trim()
    || settings['effective_vision_model']?.trim()
    || preferredModel;
  const overrideModel = settings['vision_model_override']?.trim() || '';
  const source = overrideModel
    ? 'override'
    : settings['effective_vision_model']?.trim()
      ? 'effective'
      : settings['preferred_vision_model']?.trim()
        ? 'preferred'
        : settings['vision_model']?.trim()
          ? 'legacy'
          : 'default';

  return { preferredModel, effectiveModel, overrideModel, source };
}

/**
 * Анализировать изображение с авто-recovery:
 * 1. Пробуем основную модель
 * 2. При ошибке — обновляем список бесплатных vision моделей
 * 3. Последовательно пробуем бесплатные vision модели без fan-out шторма
 * 4. Победитель сохраняется как effective runtime модель
 * 5. Всё прозрачно для пользователя — контекст сохраняется
 */
export async function analyzeImage(
  imageBase64: string,
  mimeType: string = 'image/jpeg',
  userPrompt?: string
): Promise<VisionAnalysisResult> {
  const multiConfig = await getMultimodalConfig();
  const client = await getClient();
  const prompt = userPrompt || multiConfig.visionPrompt;

  // Хелпер: запрос к одной vision модели
  const tryVisionModel = async (model: string): Promise<VisionAnalysisResult & { usedModel: string }> => {
    const response = await client.chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      }],
      max_tokens: multiConfig.visionMaxTokens,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from vision model');

    return {
      description: content,
      model: response.model,
      tokens_used: response.usage?.total_tokens ?? 0,
      usedModel: model,
    };
  };

  // === ШАГ 1: Пробуем основную модель ===
  aiLogger.info({ model: multiConfig.visionModel, hasCustomPrompt: !!userPrompt }, 'Trying primary vision model');

  try {
    const result = await tryVisionModel(multiConfig.visionModel);
    aiLogger.info({ model: result.model, tokens: result.tokens_used }, 'Primary vision model OK');
    return result;
  } catch (primaryError) {
    const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    aiLogger.warn({ error: errorMessage, model: multiConfig.visionModel }, 'Primary vision model failed');

    // Критические ошибки — НЕ делаем fallback
    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      throw new AppError('AUTH_ERROR', 'Неверный API ключ OpenRouter', primaryError);
    }

    const needsRace = VISION_RACE_ERROR_PATTERNS.some(p => errorMessage.toLowerCase().includes(p.toLowerCase()));
    if (!needsRace) {
      if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
        throw new AppError('RATE_LIMIT', 'Превышен лимит запросов для vision. Подождите минуту.', primaryError);
      }
      throw primaryError;
    }

  aiLogger.info({ originalError: errorMessage }, '🔄 Vision: refreshing models + starting sequential fallback');

    // Авто-очистка мёртвой модели из БД (404 = модель удалена с OpenRouter)
    if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
      const deadModel = multiConfig.visionModel;
      aiLogger.warn({ model: deadModel }, '🗑️ Vision model returned 404 — clearing from DB settings');
      try {
        const keysToCheck = ['preferred_vision_model', 'effective_vision_model', 'vision_model', 'vision_model_override'];
        for (const key of keysToCheck) {
          const val = await settingsRepo.get(key);
          if (val?.trim() === deadModel) {
            await settingsRepo.set(key, '');
            aiLogger.info({ key, clearedModel: deadModel }, 'Cleared dead vision model from settings');
          }
        }
        settingsRepo.invalidateCache?.();
      } catch (clearErr) {
        aiLogger.warn({ error: clearErr }, 'Failed to clear dead vision model from DB (non-critical)');
      }
    }
  }

  // === ШАГ 2: Обновляем список бесплатных vision моделей ===
  const freshModels = await refreshFreeVisionModelsCache();
  const modelsToTry = freshModels
    .filter(m => m.id !== multiConfig.visionModel) // Исключаем упавшую
    .slice(0, 3); // Максимум 3 для снижения пикового fan-out

  if (modelsToTry.length === 0) {
    throw new AppError('ALL_VISION_MODELS_FAILED', 'Нет доступных бесплатных vision моделей. Попробуйте позже.');
  }

  aiLogger.info(
    { count: modelsToTry.length, models: modelsToTry.map(m => m.id) },
    '🪜 Starting sequential vision fallback'
  );

  const tryVisionModelWithTimeout = async (model: string): Promise<VisionAnalysisResult & { usedModel: string }> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new AppError('VISION_RACE_TIMEOUT', `Превышено время ожидания ответа от vision модели ${model}`));
        }, VISION_RACE_TIMEOUT_MS);
      });

      const result = await Promise.race([
        tryVisionModel(model),
        timeoutPromise,
      ]);
      aiLogger.debug({ model }, 'Vision model succeeded in sequential fallback');
      return result;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  try {
    let winner: VisionAnalysisResult & { usedModel: string } | null = null;
    let lastError: unknown;

    for (const model of modelsToTry) {
      try {
        winner = await tryVisionModelWithTimeout(model.id);
        break;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        aiLogger.warn({ model: model.id, error: msg }, 'Vision model failed in sequential fallback');
      }
    }

    if (!winner) {
      throw new AppError(
        'ALL_VISION_MODELS_FAILED',
        `Все ${modelsToTry.length} vision моделей недоступны. Попробуйте позже.`,
        lastError,
      );
    }

    aiLogger.info({ winner: winner.usedModel, tokens: winner.tokens_used }, '🏆 Vision sequential fallback winner! Saving as effective model');

    lastVisionFallbackSwitch = {
      reason: `Vision sequential fallback winner: ${winner.usedModel} (primary ${multiConfig.visionModel} failed)`,
      time: new Date(),
      fromModel: multiConfig.visionModel,
      toModel: winner.usedModel,
    };

    // Сохраняем победителя отдельно как effective runtime модель, не трогая ручной выбор администратора.
    settingsRepo.set('effective_vision_model', winner.usedModel).catch(err => {
      aiLogger.warn({ error: err }, 'Failed to save effective vision fallback winner');
    });

    return winner;
  } catch (raceError) {
    if (raceError instanceof AppError && raceError.code === 'VISION_RACE_TIMEOUT') {
      aiLogger.error({ timeoutMs: VISION_RACE_TIMEOUT_MS }, '⏰ Vision sequential fallback timeout');
      throw raceError;
    }

    aiLogger.error({ count: modelsToTry.length }, '💀 All free vision models failed');
    throw new AppError('ALL_VISION_MODELS_FAILED', `Все ${modelsToTry.length} vision моделей недоступны. Попробуйте позже.`, raceError);
  }
}

/**
 * Анализировать изображение по URL
 */
async function analyzeImageUrl(
  imageUrl: string,
  userPrompt?: string
): Promise<VisionAnalysisResult> {
  const multiConfig = await getMultimodalConfig();
  const client = await getClient();

  const prompt = userPrompt || 'Опиши что ты видишь на этом изображении. Будь кратким и информативным.';

  aiLogger.info({ model: multiConfig.visionModel, url: imageUrl }, 'Analyzing image from URL');

  try {
    const response = await client.chat.completions.create({
      model: multiConfig.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      max_tokens: multiConfig.maxTokens,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from vision model');
    }

    return {
      description: content,
      model: response.model,
      tokens_used: response.usage?.total_tokens ?? 0,
    };
  } catch (error) {
    aiLogger.error({ error }, 'Image URL analysis failed');
    throw error;
  }
}

// --------------------------------------------
// Audio Service
// --------------------------------------------

// Константы для валидации
const MAX_GROQ_FILE_SIZE = 25 * 1024 * 1024; // 25MB лимит Groq

/**
 * Транскрибировать аудио в текст через Groq Whisper (бесплатно)
 * Groq — единственный провайдер для аудио (бесплатный)
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string = 'audio/ogg'
): Promise<AudioTranscriptionResult> {
  const multimodalConfig = await getMultimodalConfig();
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const fileSizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);

  aiLogger.info({ 
    model: multimodalConfig.audioModel, 
    size: audioBuffer.length,
    sizeMB: fileSizeMB,
  }, 'Transcribing audio via Groq');

  const groq = await getGroqClient();
  
  if (!groq) {
    throw new AppError('GROQ_AUTH_ERROR', 'GROQ_API_KEY не настроен. Задайте его в переменных окружения или в админке для транскрипции голоса.');
  }

  if (audioBuffer.length > MAX_GROQ_FILE_SIZE) {
    throw new AppError('FILE_TOO_LARGE', `Файл слишком большой (${fileSizeMB}MB, максимум 25MB)`);
  }

  const ext = mimeType.split('/').pop() || 'ogg';
  const filename = `voice.${ext === 'mpeg' ? 'mp3' : ext}`;
  return await transcribeAudioGroq(audioBuffer, filename, multimodalConfig.audioModel);
}

/**
 * Определить MIME тип по расширению файла
 */
function getMimeTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    'ogg': 'audio/ogg',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'm4a': 'audio/m4a',
    'webm': 'audio/webm',
    'mp4': 'audio/mp4',
    'mpeg': 'audio/mpeg',
    'mpga': 'audio/mpeg',
  };
  return mimeMap[ext || 'ogg'] || 'audio/ogg';
}

/**
 * Транскрипция через Groq Whisper (БЕСПЛАТНО!)
 * Поддерживает: mp3, mp4, wav, flac, mpeg, mpga, m4a, ogg, webm
 * Лимит: 25MB
 */
async function transcribeAudioGroq(
  audioBuffer: Buffer,
  filename: string = 'audio.ogg',
  modelOverride?: string,
): Promise<AudioTranscriptionResult> {
  const groq = await getGroqClient();
  
  if (!groq) {
    throw new Error('GROQ_API_KEY не настроен. Задайте его в переменных окружения или в админке.');
  }

  const mimeType = getMimeTypeFromFilename(filename);
  aiLogger.info({ filename, size: audioBuffer.length, mimeType }, 'Transcribing audio via Groq Whisper (FREE)');

  try {
    const file = new File([audioBuffer], filename, { type: mimeType });

    const rawModel = modelOverride || 'whisper-large-v3';
    const whisperModel = rawModel.replace(/^groq\//, '');

    aiLogger.debug({ whisperModel, rawModel }, 'Sending to Groq Whisper API');

    const response = await groq.audio.transcriptions.create({
      file,
      model: whisperModel,
    });

    const text = response.text;

    aiLogger.info({ textLength: text.length, model: whisperModel }, 'Groq Whisper transcription complete (FREE)');

    return {
      text: text.trim(),
      model: `groq/${whisperModel}`,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    aiLogger.error({ error }, 'Groq Whisper transcription failed');
    
    if (err.status === 401) {
      throw new AppError('GROQ_AUTH_ERROR', 'Неверный GROQ_API_KEY', error);
    }
    if (err.status === 413) {
      throw new AppError('FILE_TOO_LARGE', 'Файл слишком большой (максимум 25MB)', error);
    }
    throw error;
  }
}

// --------------------------------------------
// Combined Processing
// --------------------------------------------

// OCR-ориентированные паттерны в подписи пользователя
const OCR_CAPTION_PATTERNS = [
  /прочитай|read|прочти|распознай|что написано|что тут написано|что здесь написано/i,
  /текст|text|надпись|надписи|слова|слово/i,
  /переведи|translate|перевод|перепиши|перепечатай/i,
  /скриншот|screenshot|снимок экрана/i,
  /распознать|ocr/i,
];

/**
 * Определяет, хочет ли пользователь OCR/распознавание текста
 */
function detectOcrIntent(caption: string): boolean {
  return OCR_CAPTION_PATTERNS.some(p => p.test(caption));
}

const OCR_VISION_PROMPT = 'Прочитай весь текст на изображении дословно и точно, ничего не пропуская. Если текст на иностранном языке — сначала процитируй оригинал, затем переведи на русский. Если текста нет — опиши что изображено.';

const OCR_RESPONSE_SYSTEM_PROMPT = [
  'Ты обрабатываешь изображение в строгом OCR/analysis режиме.',
  'Отвечай только по содержимому изображения и по прямому запросу пользователя.',
  'Запрещено рассказывать о себе, своей роли, возможностях, памяти, настройках, личности или отношениях с пользователем.',
  'Запрещено добавлять приветствия, флирт, самопрезентацию, рекламу команд и любые посторонние отступления.',
  'Если на изображении есть текст, сначала приведи распознанный текст аккуратно и без выдумок.',
  'Если пользователь просит проверить решение, разберись по шагам и прямо скажи, где верно, а где ошибка.',
  'Если часть текста не читается, честно отметь неразборчивые места.',
  'Ответ должен быть утилитарным, точным и сфокусированным только на изображении.',
].join('\n');

function buildImageTaskInstruction(userCaption: string | undefined, isOcrRequest: boolean): string {
  if (isOcrRequest) {
    if (userCaption?.trim()) {
      return [
        'Задача пользователя:',
        userCaption.trim(),
        '',
        'Сначала извлеки текст с изображения. Затем выполни только этот запрос пользователя по извлечённому содержимому.',
      ].join('\n');
    }

    return 'Сначала извлеки текст с изображения. Затем кратко поясни содержимое без посторонних отступлений.';
  }

  if (userCaption?.trim()) {
    return [
      'Задача пользователя:',
      userCaption.trim(),
      '',
      'Ответь только по изображению и по запросу пользователя. Не уходи в посторонние темы.',
    ].join('\n');
  }

  return 'Опиши только то, что действительно видно на изображении. Не добавляй посторонние темы.';
}

/**
 * Обработать изображение: ПРЯМОЙ ПРОБРОС в vision модель.
 * Одноступенчатый пайплайн: vision модель видит картинку + получает системный промпт Амины.
 * Двухступенчатый fallback (описание → LLM) используется только при ошибке.
 * Общий таймаут 45 секунд на весь пайплайн.
 */
export async function processImageWithLLM(
  imageBase64: string,
  mimeType: string,
  userCaption?: string,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<AIResponse> {
  const startTime = Date.now();
  const isOcrRequest = userCaption ? detectOcrIntent(userCaption) : false;
  const multiConfig = await getMultimodalConfig();

  // === ОДНОСТУПЕНЧАТЫЙ ПАЙПЛАЙН: vision модель видит картинку напрямую ===
  try {
    const result = await directVisionResponse(
      imageBase64, mimeType, userCaption, isOcrRequest,
      multiConfig, chatHistory,
    );
    aiLogger.info({ model: result.model, tokens: result.tokens_used.total, pipelineMs: Date.now() - startTime }, 'Direct vision pipeline OK');
    return result;
  } catch (directError) {
    const msg = directError instanceof Error ? directError.message : String(directError);
    aiLogger.warn({ error: msg, elapsedMs: Date.now() - startTime }, 'Direct vision pipeline failed — falling back to 2-step');

    // Авто-сброс мёртвой vision модели при 404 (удалена с OpenRouter)
    if (msg.includes('404') || msg.includes('not found') || msg.includes('Not Found')) {
      aiLogger.warn({ model: multiConfig.visionModel }, '⚠️ Vision model 404 — clearing preferred_vision_model');
      settingsRepo.set('preferred_vision_model', '').catch(() => {});
      settingsRepo.set('effective_vision_model', '').catch(() => {});
    }
  }

  // === GROQ VISION FALLBACK: Groq поддерживает vision модели ===
  if (Date.now() - startTime < 30_000) {
    try {
      const result = await groqVisionFallback(imageBase64, mimeType, userCaption, isOcrRequest, chatHistory);
      aiLogger.info({ model: result.model, tokens: result.tokens_used.total, pipelineMs: Date.now() - startTime }, 'Groq vision fallback OK');
      return result;
    } catch (groqError) {
      const groqMsg = groqError instanceof Error ? groqError.message : String(groqError);
      aiLogger.warn({ error: groqMsg, elapsedMs: Date.now() - startTime }, 'Groq vision fallback failed — falling back to 2-step');
    }
  }

  // Если уже прошло >35 секунд, не пробуем двухступенчатый fallback — сразу кидаем ошибку
  if (Date.now() - startTime > 35_000) {
    throw new AppError('VISION_RACE_TIMEOUT', 'Vision: прямой запрос не успел, таймаут пайплайна.');
  }

  // === ДВУХСТУПЕНЧАТЫЙ FALLBACK: описание → основная LLM ===
  const visionPrompt = isOcrRequest
    ? OCR_VISION_PROMPT
    : (userCaption
        ? `Внимательно рассмотри изображение. Если на нём есть текст — прочитай его полностью. Затем ответь на вопрос пользователя: ${userCaption}`
        : undefined);

  const analysis = await analyzeImage(imageBase64, mimeType, visionPrompt);

  const imageTask = buildImageTaskInstruction(userCaption, isOcrRequest);
  const imageContext = [
    'Результат анализа изображения:',
    analysis.description,
    '',
    imageTask,
  ].join('\n');

  const useStrictImageMode = isOcrRequest;

  const { response } = useStrictImageMode
    ? await respondWithAminaCore({
        channel: 'system',
        userText: userCaption || 'Пользователь прислал изображение.',
        messages: [{ role: 'user', content: imageContext }],
        includeTime: false,
        includeMemory: false,
        includeSearch: false,
        extraRules: [
          'Режим OCR/изображения: не говори о себе и не выходи за пределы содержимого изображения.',
          'Никакой самопрезентации, только текст, разбор или описание по делу.',
        ],
        systemInstruction: OCR_RESPONSE_SYSTEM_PROMPT,
        options: {
          promptMode: 'passthrough',
          fallbackStrategy: 'sequential',
          fallbackModelLimit: 3,
          temperature: 0.2,
        },
      })
    : await respondWithAminaCore({
        channel: 'telegram',
        userText: userCaption || 'Пользователь прислал изображение.',
        messages: [
          ...(chatHistory || []),
          { role: 'user', content: imageContext },
        ],
        includeMemory: false,
        includeSearch: false,
        options: {
          fallbackStrategy: 'sequential',
          fallbackModelLimit: 3,
        },
      });

  return response;
}

/**
 * Прямой одноступенчатый запрос: vision модель получает изображение + системный промпт.
 * Модель ВИДИТ картинку и отвечает сразу — нет потери качества через текстовое описание.
 */
async function directVisionResponse(
  imageBase64: string,
  mimeType: string,
  userCaption: string | undefined,
  isOcrRequest: boolean,
  multiConfig: MultimodalConfig,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[],
): Promise<AIResponse> {
  const client = await getClient();

  // Системный промпт с персоной (dynamic import — избегаем circular dep)
  const { buildPersonaSystemPrompt } = await import('./persona.js');
  const personaPrompt = await buildPersonaSystemPrompt({
    channel: isOcrRequest ? 'system' : 'telegram',
    modelId: multiConfig.visionModel,
  });

  const systemContent = isOcrRequest
    ? [OCR_RESPONSE_SYSTEM_PROMPT, personaPrompt].filter(Boolean).join('\n\n')
    : personaPrompt;

  // User content с картинкой
  const userTextPart = isOcrRequest
    ? (userCaption || 'Прочитай текст на изображении и опиши содержимое.')
    : (userCaption || 'Опиши что ты видишь на этом изображении.');

  // Формируем messages
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
  ];

  // Добавляем релевантную историю (только последние 4 текстовых сообщения)
  if (chatHistory && chatHistory.length > 0) {
    const recentHistory = chatHistory.slice(-4);
    for (const msg of recentHistory) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // Мультимодальное сообщение с картинкой
  messages.push({
    role: 'user',
    content: [
      { type: 'text' as const, text: userTextPart },
      { type: 'image_url' as const, image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    ],
  });

  aiLogger.info({
    model: multiConfig.visionModel,
    isOcr: isOcrRequest,
    hasCaption: !!userCaption,
    historyLen: chatHistory?.length ?? 0,
  }, 'Direct vision: sending image to vision model');

  // Таймаут 30 секунд для прямого vision запроса
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await client.chat.completions.create(
      {
        model: multiConfig.visionModel,
        messages,
        max_tokens: Math.max(multiConfig.visionMaxTokens, 2048),
        temperature: isOcrRequest ? 0.2 : 0.7,
      },
      { signal: controller.signal },
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from direct vision');

    return {
      content,
      model: response.model || multiConfig.visionModel,
      tokens_used: {
        prompt: response.usage?.prompt_tokens ?? 0,
        completion: response.usage?.completion_tokens ?? 0,
        total: response.usage?.total_tokens ?? 0,
      },
      finish_reason: response.choices[0]?.finish_reason ?? 'unknown',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Groq vision модели (поддерживают image_url)
const GROQ_VISION_MODELS = [
  'llama-3.2-11b-vision-preview',   // быстрая
  'llama-3.2-90b-vision-preview',   // качественная
];

/**
 * Vision через Groq — fallback когда OpenRouter лимитирован.
 * Groq поддерживает vision модели (llama-3.2-*-vision-preview).
 */
async function groqVisionFallback(
  imageBase64: string,
  mimeType: string,
  userCaption: string | undefined,
  isOcrRequest: boolean,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[],
): Promise<AIResponse> {
  const keys = await getApiKeys();
  if (!keys.groq) throw new Error('Groq API key not configured');

  const { getGroqBaseUrl } = await import('../config/ai-proxy.js');
  const groqClient = new OpenAI({
    apiKey: keys.groq,
    baseURL: getGroqBaseUrl(),
    timeout: 20000,
    defaultHeaders: getProxyHeaders(),
  });

  const { buildPersonaSystemPrompt } = await import('./persona.js');
  const personaPrompt = await buildPersonaSystemPrompt({
    channel: isOcrRequest ? 'system' : 'telegram',
  });

  const systemContent = isOcrRequest
    ? [OCR_RESPONSE_SYSTEM_PROMPT, personaPrompt].filter(Boolean).join('\n\n')
    : personaPrompt;

  const userTextPart = isOcrRequest
    ? (userCaption || 'Прочитай текст на изображении и опиши содержимое.')
    : (userCaption || 'Опиши что ты видишь на этом изображении.');

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
  ];

  if (chatHistory && chatHistory.length > 0) {
    for (const msg of chatHistory.slice(-4)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  messages.push({
    role: 'user',
    content: [
      { type: 'text' as const, text: userTextPart },
      { type: 'image_url' as const, image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    ],
  });

  // Пробуем модели последовательно (быстрая → качественная)
  for (const model of GROQ_VISION_MODELS) {
    try {
      aiLogger.info({ model, provider: 'groq' }, 'Trying Groq vision model');
      const response = await groqClient.chat.completions.create({
        model,
        messages,
        max_tokens: 2048,
        temperature: isOcrRequest ? 0.2 : 0.7,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) continue;

      return {
        content,
        model: `groq/${response.model || model}`,
        tokens_used: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        finish_reason: response.choices[0]?.finish_reason ?? 'unknown',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      aiLogger.warn({ model, error: errMsg }, 'Groq vision model failed');
    }
  }

  throw new Error('All Groq vision models failed');
}

/**
 * Обработать голосовое сообщение: транскрипция + отправка в основную LLM
 * Транскрипция скрыта от пользователя — он видит только ответ LLM
 */
async function processVoiceWithLLM(
  audioBase64: string,
  mimeType: string,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<{ transcription: string; response: AIResponse }> {
  // 1. Транскрибируем аудио (пользователь НЕ видит этот шаг)
  const transcription = await transcribeAudio(audioBase64, mimeType);

  // 2. Отправляем текст в основной Amina Core Runtime как обычное сообщение пользователя
  // LLM не должна упоминать что это было голосовое сообщение
  const messages = [
    ...(chatHistory || []),
    { role: 'user' as const, content: transcription.text },
  ];

  const { response } = await respondWithAminaCore({
    channel: 'telegram',
    userText: transcription.text,
    messages,
    includeMemory: false,
    includeSearch: false,
  });

  return {
    transcription: transcription.text,
    response,
  };
}

// --------------------------------------------
// Model Lists Export
// --------------------------------------------

export function getAllAudioModels() {
  return {
    free: AUDIO_MODELS.free,
  };
}
