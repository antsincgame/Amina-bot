/**
 * Multimodal AI Service
 * 
 * Обработка голосовых сообщений и изображений через OpenRouter
 */

import OpenAI from 'openai';
import { config } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { settingsRepo } from '../db/supabase.js';
import type { AIResponse } from '../../../shared/types/index.js';

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

// Vision модели (поддерживают анализ изображений)
// ВАЖНО: Проверены на OpenRouter 2026-02-04
export const VISION_MODELS = {
  free: [
    { id: 'allenai/molmo-2-8b:free', name: 'Molmo2 8B (free)', description: 'AllenAI vision модель, поддерживает фото и видео' },
  ],
  premium: [
    { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI мультимодальная модель' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Быстрая OpenAI vision модель' },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic vision модель' },
  ],
};

// Audio модели для транскрипции
export const AUDIO_MODELS = {
  free: [
    // Groq Whisper - БЕСПЛАТНО!
    { id: 'groq/whisper-large-v3', name: 'Groq Whisper Large V3 (FREE)', description: 'Бесплатная транскрипция через Groq' },
    { id: 'groq/whisper-large-v3-turbo', name: 'Groq Whisper Turbo (FREE)', description: 'Быстрая бесплатная транскрипция' },
    { id: 'groq/distil-whisper-large-v3-en', name: 'Groq Distil Whisper (FREE)', description: 'Облегчённая версия для английского' },
  ],
  premium: [
    { id: 'openai/gpt-audio', name: 'GPT Audio', description: 'OpenAI специализированная аудио модель' },
    { id: 'openai/gpt-audio-mini', name: 'GPT Audio Mini', description: 'Быстрая аудио модель' },
  ],
};

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
    throw new Error('OPENROUTER_API_KEY не задан. Укажите в Render или в админке.');
  }

  if (!openai || currentOpenRouterKey !== apiKey) {
    openai = new OpenAI({
      apiKey: apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 60000,
      defaultHeaders: {
        'HTTP-Referer': 'https://amina-bot.render.com',
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
  audioFallbackModel: string;
  maxTokens: number;
  visionPrompt: string;
  visionMaxTokens: number;
}

// Дефолтные модели
const DEFAULT_VISION_MODEL = 'allenai/molmo-2-8b:free';
// Используем Groq Whisper по умолчанию (бесплатно!)
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
// Дефолт fallback при Groq без ключа (настраивается в админке)
const DEFAULT_AUDIO_FALLBACK_MODEL = 'openai/gpt-audio-mini';

// Дефолтный промпт для описания изображений
const DEFAULT_VISION_PROMPT = 'Опиши подробно что изображено на этой картинке. Обрати внимание на детали, цвета, объекты и их расположение.';
const DEFAULT_VISION_MAX_TOKENS = 1024;

const getMultimodalConfig = async (): Promise<MultimodalConfig> => {
  const settings = await settingsRepo.getMany([
    'vision_model',
    'audio_model',
    'vision_model_override',
    'audio_model_override',
    'audio_fallback_model',
    'max_tokens',
    'vision_prompt',
    'vision_max_tokens',
  ]);

  // Vision model priority: override > setting > default
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

  // Audio model priority: override > setting > default
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

  // Fallback модель (OpenRouter) — когда Groq выбран, но GROQ_API_KEY не задан
  const audioFallbackModel =
    settings['audio_fallback_model']?.trim() || DEFAULT_AUDIO_FALLBACK_MODEL;

  // Vision prompt и max_tokens из админки
  const visionPrompt = settings['vision_prompt']?.trim() || DEFAULT_VISION_PROMPT;
  const visionMaxTokens = settings['vision_max_tokens'] 
    ? Number(settings['vision_max_tokens']) 
    : DEFAULT_VISION_MAX_TOKENS;

  aiLogger.debug({
    visionModel,
    visionSource,
    audioModel,
    audioSource,
    audioFallbackModel,
    visionPrompt: visionPrompt.substring(0, 50) + '...',
    visionMaxTokens,
  }, 'Multimodal config loaded');

  return {
    visionModel,
    audioModel,
    audioFallbackModel,
    maxTokens: settings['max_tokens'] ? Number(settings['max_tokens']) : 2048,
    visionPrompt,
    visionMaxTokens,
  };
};

// --------------------------------------------
// Vision Service
// --------------------------------------------

/**
 * Анализировать изображение и получить текстовое описание
 */
export async function analyzeImage(
  imageBase64: string,
  mimeType: string = 'image/jpeg',
  userPrompt?: string
): Promise<VisionAnalysisResult> {
  const config = await getMultimodalConfig();
  const client = await getClient();

  // Используем промпт из админки или переданный пользователем (caption от фото)
  const prompt = userPrompt || config.visionPrompt;

  aiLogger.info({ 
    model: config.visionModel, 
    maxTokens: config.visionMaxTokens,
    hasCustomPrompt: !!userPrompt,
  }, 'Analyzing image');

  try {
    const response = await client.chat.completions.create({
      model: config.visionModel,
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
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: config.visionMaxTokens, // Используем настройку из админки
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from vision model');
    }

    aiLogger.info(
      { model: response.model, tokens: response.usage?.total_tokens },
      'Image analysis complete'
    );

    return {
      description: content,
      model: response.model,
      tokens_used: response.usage?.total_tokens ?? 0,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    aiLogger.error({ error, model: config.visionModel }, 'Image analysis failed');
    
    if (err.status === 404) {
      const customError = new Error(`Vision модель "${config.visionModel}" не найдена на OpenRouter. Задайте другую в админке → Голос и Фото.`);
      (customError as any).code = 'VISION_MODEL_NOT_FOUND';
      throw customError;
    }
    if (err.status === 401) {
      const customError = new Error('Неверный API ключ OpenRouter');
      (customError as any).code = 'AUTH_ERROR';
      throw customError;
    }
    if (err.status === 503) {
      const customError = new Error('Сервис анализа изображений временно недоступен. Попробуй отправить фото через минуту.');
      (customError as any).code = 'VISION_SERVICE_UNAVAILABLE';
      throw customError;
    }
    throw error;
  }
}

/**
 * Анализировать изображение по URL
 */
export async function analyzeImageUrl(
  imageUrl: string,
  userPrompt?: string
): Promise<VisionAnalysisResult> {
  const config = await getMultimodalConfig();
  const client = await getClient();

  const prompt = userPrompt || 'Опиши что ты видишь на этом изображении. Будь кратким и информативным.';

  aiLogger.info({ model: config.visionModel, url: imageUrl }, 'Analyzing image from URL');

  try {
    const response = await client.chat.completions.create({
      model: config.visionModel,
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
      max_tokens: config.maxTokens,
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
 * Транскрибировать аудио в текст
 * Приоритет: Groq Whisper (бесплатно) → OpenRouter Audio (fallback)
 * 
 * Fallback срабатывает если:
 * - GROQ_API_KEY не задан
 * - Groq API вернул ошибку (401, 413, 429, 500 и др.)
 * - Файл слишком большой для Groq (>25MB)
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
  }, 'Transcribing audio');

  // Если выбрана Groq модель — пробуем бесплатный Groq Whisper
  if (multimodalConfig.audioModel.startsWith('groq/')) {
    const groq = await getGroqClient();
    
    // Проверка 1: есть ли ключ?
    if (!groq) {
      aiLogger.warn('Groq model selected but GROQ_API_KEY not set, falling back to OpenRouter');
    }
    // Проверка 2: размер файла в пределах лимита Groq?
    else if (audioBuffer.length > MAX_GROQ_FILE_SIZE) {
      aiLogger.warn({ sizeMB: fileSizeMB, limit: '25MB' }, 
        'File too large for Groq (>25MB), falling back to OpenRouter');
    }
    // Всё ок — пробуем Groq с fallback при ошибке
    else {
      try {
        return await transcribeAudioGroq(audioBuffer, 'voice.ogg');
      } catch (groqError: unknown) {
        const err = groqError as { status?: number; code?: string; message?: string };
        aiLogger.warn({ 
          error: err.message, 
          status: err.status,
          code: err.code,
        }, 'Groq transcription failed, falling back to OpenRouter');
        
        // НЕ пробрасываем ошибку — идём в fallback
      }
    }
  }

  // OpenRouter: никогда не отправлять groq/* — только модели OpenRouter
  const client = await getClient();
  let openRouterModel = multimodalConfig.audioModel.startsWith('groq/')
    ? (multimodalConfig.audioFallbackModel?.trim() || 'openai/gpt-audio-mini')
    : multimodalConfig.audioModel;
  if (openRouterModel.startsWith('groq/')) {
    openRouterModel = 'openai/gpt-audio-mini';
    aiLogger.warn('groq/* не поддерживается OpenRouter, используем openai/gpt-audio-mini');
  }
  
  aiLogger.info({ model: openRouterModel }, 'Using OpenRouter for audio transcription');

  try {
    // OpenRouter использует chat completions API для аудио
    const response = await client.chat.completions.create({
      model: openRouterModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Транскрибируй это аудио сообщение. Верни только текст того, что было сказано, без дополнительных комментариев.',
            },
            {
              type: 'input_audio' as any,
              input_audio: {
                data: audioBase64,
                format: getAudioFormatForOpenRouter(mimeType),
              },
            } as any,
          ],
        },
      ],
      max_tokens: multimodalConfig.maxTokens,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from audio model');
    }

    aiLogger.info(
      { model: response.model, textLength: content.length },
      'Audio transcription complete'
    );

    return {
      text: content.trim(),
      model: response.model,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    aiLogger.error({ error, model: openRouterModel }, 'Audio transcription failed');
    
    if (err.status === 404) {
      const customError = new Error(`Audio модель "${openRouterModel}" не найдена на OpenRouter. Задайте другую в админке → Голос и Фото.`);
      (customError as any).code = 'AUDIO_MODEL_NOT_FOUND';
      throw customError;
    }
    if (err.status === 401) {
      const customError = new Error('Неверный API ключ OpenRouter');
      (customError as any).code = 'AUTH_ERROR';
      throw customError;
    }
    if (err.status === 400) {
      const msg = err.message ?? '';
      if (msg.includes('input_audio')) {
        const customError = new Error(`Модель "${openRouterModel}" не поддерживает аудио. В админке выберите OpenRouter для аудио или настройте GROQ_API_KEY для Groq.`);
        (customError as any).code = 'AUDIO_NOT_SUPPORTED';
        throw customError;
      }
      if (msg.includes('not a valid model ID') || msg.includes('invalid model')) {
        const customError = new Error('Выбранная аудио модель недоступна на OpenRouter. В админке → Голос и Фото выберите «OpenRouter» или настройте Groq ключ.');
        (customError as any).code = 'AUDIO_MODEL_NOT_FOUND';
        throw customError;
      }
    }
    if (err.status === 429) {
      const customError = new Error('Превышен лимит запросов. Подождите минуту и попробуйте снова.');
      (customError as any).code = 'RATE_LIMIT';
      throw customError;
    }
    if (err.status === 503) {
      const customError = new Error('Сервис транскрипции временно недоступен. Попробуйте позже.');
      (customError as any).code = 'SERVER_ERROR';
      throw customError;
    }
    if (err.status && err.status >= 500) {
      const customError = new Error('Сервер AI временно недоступен. Попробуйте позже.');
      (customError as any).code = 'SERVER_ERROR';
      throw customError;
    }
    throw error;
  }
}

/**
 * Определить формат аудио для OpenRouter API
 */
function getAudioFormatForOpenRouter(mimeType: string): string {
  if (mimeType.includes('ogg') || mimeType.includes('opus')) return 'ogg';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('flac')) return 'flac';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'mp4';
  // Telegram отправляет OGG Opus
  return 'ogg';
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
export async function transcribeAudioGroq(
  audioBuffer: Buffer,
  filename: string = 'audio.ogg'
): Promise<AudioTranscriptionResult> {
  const groq = await getGroqClient();
  
  if (!groq) {
    throw new Error('GROQ_API_KEY не настроен. Задайте его в Render или в админке.');
  }

  const mimeType = getMimeTypeFromFilename(filename);
  aiLogger.info({ filename, size: audioBuffer.length, mimeType }, 'Transcribing audio via Groq Whisper (FREE)');

  try {
    // Создаём File-like объект с правильным MIME типом
    const file = new File([audioBuffer], filename, { type: mimeType });

    const response = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'ru',
    });

    // response - объект с text
    const text = response.text;

    aiLogger.info({ textLength: text.length }, 'Groq Whisper transcription complete (FREE)');

    return {
      text: text.trim(),
      model: 'groq/whisper-large-v3',
    };
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    aiLogger.error({ error }, 'Groq Whisper transcription failed');
    
    if (err.status === 401) {
      const customError = new Error('Неверный GROQ_API_KEY');
      (customError as any).code = 'GROQ_AUTH_ERROR';
      throw customError;
    }
    if (err.status === 413) {
      const customError = new Error('Файл слишком большой (максимум 25MB)');
      (customError as any).code = 'FILE_TOO_LARGE';
      throw customError;
    }
    throw error;
  }
}

/**
 * Альтернативный метод транскрипции через OpenAI Whisper API (платно)
 */
export async function transcribeAudioWhisper(
  audioBuffer: Buffer,
  filename: string = 'audio.ogg'
): Promise<AudioTranscriptionResult> {
  const client = await getClient();

  aiLogger.info({ filename }, 'Transcribing audio via OpenAI Whisper (paid)');

  try {
    // Создаём File-like объект
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

    const response = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru',
    });

    aiLogger.info({ textLength: response.text.length }, 'OpenAI Whisper transcription complete');

    return {
      text: response.text,
      model: 'openai/whisper-1',
    };
  } catch (error) {
    aiLogger.error({ error }, 'OpenAI Whisper transcription failed');
    throw error;
  }
}

// --------------------------------------------
// Combined Processing
// --------------------------------------------

/**
 * Обработать изображение: анализ + отправка в основную LLM
 */
export async function processImageWithLLM(
  imageBase64: string,
  mimeType: string,
  userCaption?: string,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<AIResponse> {
  // 1. Анализируем изображение
  const analysis = await analyzeImage(
    imageBase64,
    mimeType,
    userCaption || 'Опиши подробно что изображено на этой картинке.'
  );

  // 2. Формируем контекст для основной LLM: техническое описание от Vision + вопрос/подпись пользователя
  // Пользователь видит только финальный ответ LLM, не это сообщение
  const descriptionBlock = `Описание изображения (что на картинке):\n${analysis.description}`;
  const userBlock = userCaption
    ? `Вопрос или комментарий пользователя: ${userCaption}`
    : 'Пользователь не написал текст — опиши что на картинке.';
  const instruction = 'Дай ответ пользователю: опиши изображение или ответь на его вопрос. Пиши от себя, не упоминай «описание», «vision», «анализ».';

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
export async function processVoiceWithLLM(
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

export function getAllVisionModels() {
  return {
    free: VISION_MODELS.free,
    premium: VISION_MODELS.premium,
  };
}

export function getAllAudioModels() {
  return {
    free: AUDIO_MODELS.free,
    premium: AUDIO_MODELS.premium,
  };
}
