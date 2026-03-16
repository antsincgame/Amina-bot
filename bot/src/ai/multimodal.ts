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
  { id: 'allenai/molmo-2-8b:free', name: 'Molmo2 8B', description: 'AllenAI vision модель' },
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
      defaultHeaders: {
        'HTTP-Referer': config.botUrl,
        'X-Title': 'Amina AI Bot',
      },
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
    return null;
  }
  
  if (!groqClient || currentGroqKey !== apiKey) {
    groqClient = new OpenAI({
      apiKey: apiKey,
      baseURL: config.groq.baseUrl,
      timeout: 60000,
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
}

// Дефолтные модели
const DEFAULT_VISION_MODEL = 'allenai/molmo-2-8b:free';
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
const DEFAULT_VISION_PROMPT = 'Внимательно рассмотри изображение. Если на нём есть текст — прочитай его полностью и точно. Затем опиши что изображено: объекты, сцена, детали. Ответ структурируй: сначала текст (если есть), потом описание.';
const DEFAULT_VISION_MAX_TOKENS = 1024;

const getMultimodalConfig = async (): Promise<MultimodalConfig> => {
  const settings = await settingsRepo.getMany([
    'vision_model',
    'audio_model',
    'vision_model_override',
    'audio_model_override',
    'max_tokens',
    'vision_prompt',
    'vision_max_tokens',
  ]);

  // Vision model: override > setting > default
  let visionModel = DEFAULT_VISION_MODEL;
  let visionSource = 'default';
  if (settings['vision_model']?.trim()) {
    visionModel = settings['vision_model'].trim();
    visionSource = 'database';
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
  return {
    audioModel: config.audioModel,
    maxTokens: config.maxTokens,
  };
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

/**
 * Анализировать изображение с авто-recovery:
 * 1. Пробуем основную модель
 * 2. При ошибке — обновляем список бесплатных vision моделей
 * 3. Запускаем гонку всех бесплатных vision моделей
 * 4. Победитель сохраняется как новая основная модель
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

    aiLogger.info({ originalError: errorMessage }, '🔄 Vision: refreshing models + starting race');
  }

  // === ШАГ 2: Обновляем список бесплатных vision моделей ===
  const freshModels = await refreshFreeVisionModelsCache();
  const modelsToRace = freshModels
    .filter(m => m.id !== multiConfig.visionModel) // Исключаем упавшую
    .slice(0, 5); // Максимум 5 для гонки

  if (modelsToRace.length === 0) {
    throw new AppError('ALL_VISION_MODELS_FAILED', 'Нет доступных бесплатных vision моделей. Попробуйте позже.');
  }

  aiLogger.info(
    { count: modelsToRace.length, models: modelsToRace.map(m => m.id) },
    '🏁 Starting vision models race'
  );

  // === ШАГ 3: Гонка vision моделей ===
  let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    raceTimeoutId = setTimeout(() => {
      reject(new AppError('VISION_RACE_TIMEOUT', 'Превышено время ожидания ответа от vision моделей'));
    }, VISION_RACE_TIMEOUT_MS);
  });

  const racePromises = modelsToRace.map(async (m) => {
    try {
      const result = await tryVisionModel(m.id);
      aiLogger.debug({ model: m.id }, 'Vision model responded in race');
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      aiLogger.debug({ model: m.id, error: msg }, 'Vision model failed in race');
      throw error;
    }
  });

  try {
    const winner = await Promise.race([Promise.any(racePromises), timeoutPromise]);
    if (raceTimeoutId) clearTimeout(raceTimeoutId);

    aiLogger.info({ winner: winner.usedModel, tokens: winner.tokens_used }, '🏆 Vision race winner! Saving as default');

    lastVisionFallbackSwitch = {
      reason: `Vision race winner: ${winner.usedModel} (primary ${multiConfig.visionModel} failed)`,
      time: new Date(),
      fromModel: multiConfig.visionModel,
      toModel: winner.usedModel,
    };

    // Сохраняем победителя как новую основную vision модель
    settingsRepo.set('vision_model', winner.usedModel).catch(err => {
      aiLogger.warn({ error: err }, 'Failed to save vision race winner');
    });

    return winner;
  } catch (raceError) {
    if (raceTimeoutId) clearTimeout(raceTimeoutId);

    if (raceError instanceof AppError && raceError.code === 'VISION_RACE_TIMEOUT') {
      aiLogger.error({ timeoutMs: VISION_RACE_TIMEOUT_MS }, '⏰ Vision race timeout');
      throw raceError;
    }

    aiLogger.error({ count: modelsToRace.length }, '💀 All free vision models failed');
    throw new AppError('ALL_VISION_MODELS_FAILED', `Все ${modelsToRace.length} vision моделей недоступны. Попробуйте позже.`, raceError);
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

/**
 * Обработать изображение: анализ + отправка в основную LLM
 */
export async function processImageWithLLM(
  imageBase64: string,
  mimeType: string,
  userCaption?: string,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<AIResponse> {
  // Выбираем промпт для vision-модели в зависимости от намерения
  const isOcrRequest = userCaption ? detectOcrIntent(userCaption) : false;
  const visionPrompt = isOcrRequest
    ? OCR_VISION_PROMPT
    : (userCaption
        ? `Внимательно рассмотри изображение. Если на нём есть текст — прочитай его полностью. Затем ответь на вопрос пользователя: ${userCaption}`
        : undefined); // undefined → будет использован DEFAULT_VISION_PROMPT из настроек

  // 1. Анализируем изображение
  const analysis = await analyzeImage(imageBase64, mimeType, visionPrompt);

  // 2. Формируем контекст для основной LLM
  const descriptionBlock = `Результат анализа изображения:\n${analysis.description}`;
  const userBlock = userCaption
    ? `Вопрос или комментарий пользователя: ${userCaption}`
    : 'Пользователь прислал изображение без текста — расскажи что на нём.';
  const instruction = isOcrRequest
    ? 'Передай пользователю распознанный текст и/или перевод. Пиши чисто, без лишних слов про «vision» или «анализ».'
    : 'Дай ответ пользователю: опиши изображение или ответь на его вопрос. Пиши от себя, не упоминай «описание», «vision», «анализ».';

  const imageContext = `${descriptionBlock}\n\n${userBlock}\n\n${instruction}`;

  // 3. Отправляем в основную LLM
  const { aiService } = await import('./openrouter.js');
  
  const messages = [
    ...(chatHistory || []),
    { role: 'user' as const, content: imageContext },
  ];

  const response = await aiService.chat(messages, 'telegram');

  return response;
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

  // 2. Отправляем текст в основную LLM как обычное сообщение пользователя
  // LLM не должна упоминать что это было голосовое сообщение
  const { aiService } = await import('./openrouter.js');
  
  const messages = [
    ...(chatHistory || []),
    { role: 'user' as const, content: transcription.text },
  ];

  const response = await aiService.chat(messages, 'telegram');

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
