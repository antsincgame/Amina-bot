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

// Audio модели (поддерживают аудио вход)
// ВАЖНО: Бесплатных audio моделей на OpenRouter нет!
// Используем самую дешёвую платную как fallback
export const AUDIO_MODELS = {
  free: [
    // Нет бесплатных audio моделей на OpenRouter
    // Используем дешёвую платную как "условно бесплатную"
    { id: 'openai/gpt-audio-mini', name: 'GPT Audio Mini (дешёвая)', description: '$0.60/M токенов - самая дешёвая audio модель' },
  ],
  premium: [
    { id: 'openai/gpt-audio', name: 'GPT Audio', description: 'OpenAI специализированная аудио модель' },
    { id: 'openai/gpt-audio-mini', name: 'GPT Audio Mini', description: 'Быстрая аудио модель' },
  ],
};

// --------------------------------------------
// OpenRouter Client
// --------------------------------------------

let openai: OpenAI | null = null;

const getClient = (): OpenAI => {
  if (!openai) {
    openai = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL: config.ai.baseUrl,
      timeout: 60000, // 60 second timeout for multimodal
      defaultHeaders: {
        'HTTP-Referer': 'https://amina-bot.render.com',
        'X-Title': 'Amina AI Bot',
      },
    });
  }
  return openai;
};

// --------------------------------------------
// Configuration from Database
// --------------------------------------------

interface MultimodalConfig {
  visionModel: string;
  audioModel: string;
  maxTokens: number;
}

// Дефолтные модели (проверены на OpenRouter)
const DEFAULT_VISION_MODEL = 'allenai/molmo-2-8b:free';
const DEFAULT_AUDIO_MODEL = 'openai/gpt-audio-mini';

const getMultimodalConfig = async (): Promise<MultimodalConfig> => {
  const settings = await settingsRepo.getMany([
    'vision_model',
    'audio_model',
    'vision_model_override',
    'audio_model_override',
    'max_tokens',
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

  aiLogger.debug({
    visionModel,
    visionSource,
    audioModel,
    audioSource,
  }, 'Multimodal config loaded');

  return {
    visionModel,
    audioModel,
    maxTokens: settings['max_tokens'] ? Number(settings['max_tokens']) : 2048,
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
  const client = getClient();

  const prompt = userPrompt || 'Опиши что ты видишь на этом изображении. Будь кратким и информативным.';

  aiLogger.info({ model: config.visionModel }, 'Analyzing image');

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
      max_tokens: config.maxTokens,
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
    
    // Создаём понятную ошибку
    if (err.status === 404) {
      const customError = new Error(`Vision модель "${config.visionModel}" не найдена на OpenRouter. Измените в настройках.`);
      (customError as any).code = 'VISION_MODEL_NOT_FOUND';
      throw customError;
    }
    if (err.status === 401) {
      const customError = new Error('Неверный API ключ OpenRouter');
      (customError as any).code = 'AUTH_ERROR';
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
  const client = getClient();

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

/**
 * Транскрибировать аудио в текст
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string = 'audio/ogg'
): Promise<AudioTranscriptionResult> {
  const config = await getMultimodalConfig();
  const client = getClient();

  aiLogger.info({ model: config.audioModel }, 'Transcribing audio');

  try {
    // OpenRouter использует chat completions API для аудио
    const response = await client.chat.completions.create({
      model: config.audioModel,
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
                format: mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'wav',
              },
            } as any,
          ],
        },
      ],
      max_tokens: config.maxTokens,
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
    aiLogger.error({ error, model: config.audioModel }, 'Audio transcription failed');
    
    // Создаём понятную ошибку
    if (err.status === 404) {
      const customError = new Error(`Audio модель "${config.audioModel}" не найдена на OpenRouter. Измените в настройках.`);
      (customError as any).code = 'AUDIO_MODEL_NOT_FOUND';
      throw customError;
    }
    if (err.status === 401) {
      const customError = new Error('Неверный API ключ OpenRouter');
      (customError as any).code = 'AUTH_ERROR';
      throw customError;
    }
    if (err.status === 400 && err.message?.includes('input_audio')) {
      const customError = new Error(`Модель "${config.audioModel}" не поддерживает аудио вход. Выберите другую модель.`);
      (customError as any).code = 'AUDIO_NOT_SUPPORTED';
      throw customError;
    }
    throw error;
  }
}

/**
 * Альтернативный метод транскрипции через Whisper API
 * (если модель не поддерживает input_audio)
 */
export async function transcribeAudioWhisper(
  audioBuffer: Buffer,
  filename: string = 'audio.ogg'
): Promise<AudioTranscriptionResult> {
  const client = getClient();

  aiLogger.info({ filename }, 'Transcribing audio via Whisper');

  try {
    // Создаём File-like объект
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

    const response = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru',
    });

    aiLogger.info({ textLength: response.text.length }, 'Whisper transcription complete');

    return {
      text: response.text,
      model: 'whisper-1',
    };
  } catch (error) {
    aiLogger.error({ error }, 'Whisper transcription failed');
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

  // 2. Формируем сообщение для основной LLM
  const imageContext = userCaption
    ? `[Пользователь отправил изображение с подписью: "${userCaption}"]\n\nОписание изображения: ${analysis.description}`
    : `[Пользователь отправил изображение]\n\nОписание изображения: ${analysis.description}`;

  // 3. Импортируем основной AI сервис и отправляем
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
 */
export async function processVoiceWithLLM(
  audioBase64: string,
  mimeType: string,
  chatHistory?: { role: 'user' | 'assistant' | 'system'; content: string }[]
): Promise<{ transcription: string; response: AIResponse }> {
  // 1. Транскрибируем аудио
  const transcription = await transcribeAudio(audioBase64, mimeType);

  // 2. Отправляем текст в основную LLM
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
