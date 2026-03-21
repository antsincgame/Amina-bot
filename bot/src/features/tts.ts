/**
 * Text-to-Speech Service
 * 
 * Три движка:
 * 1. ElevenLabs (eleven_multilingual_v2) — премиальный мультиязычный голос, лучшее качество
 * 2. OpenAI TTS (tts-1-hd) — максимально естественный голос, платный ($0.015/1K символов)
 * 3. Edge TTS (Microsoft Neural) — бесплатный, качественный fallback
 * 
 * Выбор движка: настройка `tts_provider` в админке ('elevenlabs' | 'openai' | 'edge')
 * Голос ElevenLabs: настройка `elevenlabs_voice_id` (ID голоса из библиотеки ElevenLabs)
 * Голос OpenAI: настройка `openai_tts_voice` ('nova' | 'alloy' | 'echo' | 'fable' | 'onyx' | 'shimmer')
 * Голос Edge: настройка `voice_speaker` ('svetlana' | 'dmitry')
 * 
 * Цепочка fallback: ElevenLabs (main) → retry 2s → ElevenLabs Turbo v2.5 → OpenAI → Edge TTS
 * Поддержка длинных текстов — разбивает на чанки.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import OpenAI from 'openai';
import { settingsRepo } from '../db/index.js';
import { appLogger } from '../config/logger.js';

// ===== Типы =====

type TTSProvider = 'elevenlabs' | 'openai' | 'edge';
type OpenAIVoice = 'nova' | 'alloy' | 'echo' | 'fable' | 'onyx' | 'shimmer';

interface TTSConfig {
  enabled: boolean;
  provider: TTSProvider;
  // ElevenLabs
  elevenlabsApiKey: string | null;
  elevenlabsVoiceId: string;
  elevenlabsModelId: string;
  // OpenAI
  openaiApiKey: string | null;
  openaiVoice: OpenAIVoice;
  openaiModel: string;
  // Edge
  edgeVoice: string;
}

export interface TtsRuntimeProfile {
  enabled: boolean;
  provider: TTSProvider;
  elevenlabsVoiceId: string;
  elevenlabsModelId: string;
  openaiVoice: OpenAIVoice;
  openaiModel: string;
  edgeVoice: string;
}

// ===== Константы =====

const MAX_TEXT_LENGTH = 10_000;
const ELEVENLABS_CHUNK_SIZE = 5000; // ElevenLabs лимит ~5000 символов
const OPENAI_CHUNK_SIZE = 4000;     // OpenAI лимит 4096 символов
const EDGE_CHUNK_SIZE = 3000;       // Edge TTS чанк
const TTS_TIMEOUT_MS = 60_000;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';
const ELEVENLABS_TURBO_MODEL = 'eleven_turbo_v2_5';
const ELEVENLABS_RETRY_DELAY_MS = 2000;

// Edge TTS голоса
const EDGE_VOICES: Record<string, string> = {
  svetlana: 'ru-RU-SvetlanaNeural',
  dmitry: 'ru-RU-DmitryNeural',
  xenia: 'ru-RU-SvetlanaNeural',  // xenia = Silero voice, маппим на Svetlana
  aria: 'en-US-AriaNeural',
  guy: 'en-US-GuyNeural',
};

const EDGE_VOICES_BY_LANG: Record<string, string> = {
  ru: 'ru-RU-SvetlanaNeural',
  en: 'en-US-AriaNeural',
};

// ===== Кеш конфигурации (чтобы не читать БД на каждый запрос) =====

let configCache: { config: TTSConfig; ts: number } | null = null;
const CONFIG_TTL = 3 * 60 * 1000; // 3 минуты

async function getTTSConfig(): Promise<TTSConfig> {
  if (configCache && Date.now() - configCache.ts < CONFIG_TTL) {
    return configCache.config;
  }

  const settings = await settingsRepo.getMany([
    'tts_enabled',
    'tts_provider',
    'elevenlabs_api_key',
    'elevenlabs_voice_id',
    'elevenlabs_model_id',
    'openai_api_key',
    'openai_tts_voice',
    'openai_tts_model',
    'voice_speaker',
  ]);

  const VALID_TTS_PROVIDERS = new Set<TTSProvider>(['edge', 'elevenlabs', 'openai']);
  const resolvedProvider: TTSProvider = VALID_TTS_PROVIDERS.has(settings.tts_provider as TTSProvider)
    ? settings.tts_provider as TTSProvider
    : 'edge';

  const config: TTSConfig = {
    enabled: settings.tts_enabled !== 'false',
    provider: resolvedProvider,
    // ElevenLabs
    elevenlabsApiKey: settings.elevenlabs_api_key || null,
    elevenlabsVoiceId: settings.elevenlabs_voice_id || ELEVENLABS_DEFAULT_VOICE,
    elevenlabsModelId: settings.elevenlabs_model_id || ELEVENLABS_DEFAULT_MODEL,
    // OpenAI
    openaiApiKey: settings.openai_api_key || null,
    openaiVoice: (settings.openai_tts_voice as OpenAIVoice) || 'nova',
    openaiModel: settings.openai_tts_model || 'tts-1-hd',
    // Edge
    edgeVoice: EDGE_VOICES[settings.voice_speaker ?? 'svetlana'] ?? 'ru-RU-SvetlanaNeural',
  };

  // Авто-fallback при отсутствии ключей
  if (config.provider === 'elevenlabs' && !config.elevenlabsApiKey) {
    appLogger.warn('TTS: ElevenLabs selected but no API key, falling back to OpenAI/Edge');
    config.provider = config.openaiApiKey ? 'openai' : 'edge';
  }
  if (config.provider === 'openai' && !config.openaiApiKey) {
    appLogger.warn('TTS: OpenAI selected but no API key, falling back to Edge');
    config.provider = 'edge';
  }

  configCache = { config, ts: Date.now() };
  return config;
}

/** Сбросить кеш конфигурации (после изменения настроек) */
export function invalidateTTSConfig(): void {
  configCache = null;
}

export async function getTtsRuntimeProfile(): Promise<TtsRuntimeProfile> {
  const config = await getTTSConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    elevenlabsVoiceId: config.elevenlabsVoiceId,
    elevenlabsModelId: config.elevenlabsModelId,
    openaiVoice: config.openaiVoice,
    openaiModel: config.openaiModel,
    edgeVoice: config.edgeVoice,
  };
}

// ===== Главная функция =====

/**
 * Сгенерировать аудио из текста
 * Автоматически выбирает лучший доступный движок
 */
export async function textToSpeech(
  text: string,
  lang: 'ru' | 'en' = 'ru'
): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) return null;

  let cleanText = stripFormatting(text);
  if (cleanText.length > MAX_TEXT_LENGTH) {
    cleanText = cleanText.slice(0, MAX_TEXT_LENGTH);
    appLogger.info({ originalLength: text.length, truncatedTo: MAX_TEXT_LENGTH }, 'TTS: text truncated');
  }

  const config = await getTTSConfig();
  if (!config.enabled) {
    appLogger.info({ textLen: cleanText.length }, 'TTS: disabled by tts_enabled setting');
    return null;
  }

  // === ElevenLabs (премиум) ===
  if (config.provider === 'elevenlabs' && config.elevenlabsApiKey) {
    let authFailed = false;

    // 1) Основная модель
    try {
      const result = await elevenlabsTTS(cleanText, config);
      if (result) {
        appLogger.info({ provider: 'elevenlabs', textLen: cleanText.length, audioBytes: result.length }, 'TTS: ElevenLabs success');
        return result;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('401') || msg.includes('403') || msg.includes('missing_permissions')) {
        appLogger.error({ textLen: cleanText.length }, 'TTS: ElevenLabs auth failed (401/403) — skip retries, fallback to Edge');
        authFailed = true;
      } else {
        appLogger.warn({ error, textLen: cleanText.length }, 'TTS: ElevenLabs main model failed, retrying');
      }
    }

    if (!authFailed) {
      // 2) Retry основной модели через 1 секунду
      try {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await elevenlabsTTS(cleanText, config);
        if (result) {
          appLogger.info({ provider: 'elevenlabs', textLen: cleanText.length, audioBytes: result.length }, 'TTS: ElevenLabs retry success');
          return result;
        }
      } catch (error) {
        appLogger.warn({ error, textLen: cleanText.length }, 'TTS: ElevenLabs retry failed, trying turbo');
      }

      // 3) Cheap fallback — ElevenLabs Turbo v2.5
      try {
        const turboConfig: TTSConfig = { ...config, elevenlabsModelId: ELEVENLABS_TURBO_MODEL };
        const result = await elevenlabsTTS(cleanText, turboConfig);
        if (result) {
          appLogger.info({ provider: 'elevenlabs-turbo', textLen: cleanText.length, audioBytes: result.length }, 'TTS: ElevenLabs Turbo v2.5 success');
          return result;
        }
      } catch (error) {
        appLogger.warn({ error, textLen: cleanText.length }, 'TTS: ElevenLabs Turbo v2.5 failed, falling back to Edge');
      }
    }
  }

  // === OpenAI TTS (премиум fallback) ===
  if ((config.provider === 'openai' || config.provider === 'elevenlabs') && config.openaiApiKey) {
    try {
      const result = await openaiTTS(cleanText, config, lang);
      if (result) {
        appLogger.info({ provider: 'openai', textLen: cleanText.length, audioBytes: result.length }, 'TTS: OpenAI success');
        return result;
      }
    } catch (error) {
      appLogger.warn({ error, textLen: cleanText.length }, 'TTS: OpenAI failed, falling back to Edge');
    }
  }

  // === Edge TTS (бесплатный fallback) ===
  try {
    const voice: string = lang === 'en'
      ? EDGE_VOICES_BY_LANG.en!
      : config.edgeVoice;

    const result = await edgeTTS(cleanText, voice);
    if (result) {
      appLogger.info({ provider: 'edge', textLen: cleanText.length, audioBytes: result.length }, 'TTS: Edge success');
      return result;
    }
  } catch (error) {
    appLogger.error({ error, textLen: cleanText.length }, 'TTS: Edge failed');
  }

  return null;
}

// ===== ElevenLabs TTS =====

/**
 * Генерация через ElevenLabs API
 * Качество: eleven_multilingual_v2 — лучший мультиязычный голос (русский, англ. и др.)
 * Лимит: ~5000 символов на запрос
 */
async function elevenlabsTTS(
  text: string,
  config: TTSConfig,
): Promise<Buffer | null> {
  if (!config.elevenlabsApiKey) return null;

  // Один чанк
  if (text.length <= ELEVENLABS_CHUNK_SIZE) {
    return await generateElevenLabsChunk(text, config);
  }

  // Разбивка на чанки для длинного текста
  const chunks = splitTextIntoChunks(text, ELEVENLABS_CHUNK_SIZE);
  appLogger.info(
    { chunks: chunks.length, model: config.elevenlabsModelId, voice: config.elevenlabsVoiceId },
    'TTS: ElevenLabs multi-chunk'
  );

  const audioBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    const audio = await generateElevenLabsChunk(chunk, config);
    if (audio) audioBuffers.push(audio);
  }

  return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
}

async function generateElevenLabsChunk(
  text: string,
  config: TTSConfig,
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const url = `${ELEVENLABS_API_URL}/${config.elevenlabsVoiceId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabsApiKey!,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      signal: controller.signal,
      body: JSON.stringify({
        text,
        model_id: config.elevenlabsModelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      appLogger.error(
        { status: response.status, body: errorBody.substring(0, 200), textLen: text.length },
        'TTS: ElevenLabs API error'
      );
      throw new Error(`ElevenLabs API returned ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 100) {
      appLogger.warn({ textLen: text.length, audioBytes: buffer.length }, 'TTS: ElevenLabs returned too small audio');
      return null;
    }

    return buffer;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      appLogger.warn({ textLen: text.length }, 'TTS: ElevenLabs chunk timeout');
    } else {
      const errMsg = error instanceof Error ? error.message : String(error);
      appLogger.error({ error: errMsg, textLen: text.length }, 'TTS: ElevenLabs chunk failed');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== OpenAI TTS =====

/**
 * Генерация через OpenAI TTS API
 * Качество: tts-1-hd — самый натуральный голос
 * Лимит: 4096 символов на запрос
 */
async function openaiTTS(
  text: string,
  config: TTSConfig,
  lang: 'ru' | 'en'
): Promise<Buffer | null> {
  if (!config.openaiApiKey) return null;

  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  // Один чанк
  if (text.length <= OPENAI_CHUNK_SIZE) {
    return await generateOpenAIChunk(openai, text, config);
  }

  // Разбивка на чанки для длинного текста
  const chunks = splitTextIntoChunks(text, OPENAI_CHUNK_SIZE);
  appLogger.info({ chunks: chunks.length, model: config.openaiModel, voice: config.openaiVoice }, 'TTS: OpenAI multi-chunk');

  const audioBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    const audio = await generateOpenAIChunk(openai, chunk, config);
    if (audio) audioBuffers.push(audio);
  }

  return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
}

async function generateOpenAIChunk(
  openai: OpenAI,
  text: string,
  config: TTSConfig
): Promise<Buffer | null> {
  try {
    const response = await openai.audio.speech.create({
      model: config.openaiModel,
      input: text,
      voice: config.openaiVoice as 'nova' | 'alloy' | 'echo' | 'fable' | 'onyx' | 'shimmer',
      response_format: 'mp3',
      speed: 1.0,
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 100) {
      appLogger.warn({ textLen: text.length }, 'TTS: OpenAI returned too small audio');
      return null;
    }

    return buffer;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStatus = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined;
    appLogger.error({ error: errMsg, status: errStatus, textLen: text.length }, 'TTS: OpenAI chunk failed');
    throw error;
  }
}

// ===== Edge TTS (улучшенный) =====

/**
 * Генерация через Microsoft Edge TTS
 * Качество: 48kHz / 192kbps — максимум для Edge
 */
async function edgeTTS(text: string, voice: string): Promise<Buffer | null> {
  if (text.length <= EDGE_CHUNK_SIZE) {
    return await generateEdgeChunk(text, voice);
  }

  const chunks = splitTextIntoChunks(text, EDGE_CHUNK_SIZE);
  appLogger.info({ chunks: chunks.length, voice }, 'TTS: Edge multi-chunk');

  const audioBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    const audio = await generateEdgeChunk(chunk, voice);
    if (audio) audioBuffers.push(audio);
  }

  return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
}

async function generateEdgeChunk(text: string, voice: string): Promise<Buffer | null> {
  const tts = new MsEdgeTTS();

  // 24kHz / 96kbps — максимальное качество MP3 в Edge TTS
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        appLogger.warn({ textLen: text.length, partialChunks: chunks.length }, 'TTS: Edge chunk timeout — discarding partial audio');
        resolve(null);
      }
    }, 30_000);

    try {
      const { audioStream } = tts.toStream(text);

      audioStream.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      audioStream.on('end', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
        }
      });

      audioStream.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
        }
      });

      audioStream.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          appLogger.warn({ error: err.message, textLen: text.length }, 'TTS: Edge stream error');
          resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
        }
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        appLogger.warn({ error: err }, 'TTS: Edge toStream failed');
        resolve(null);
      }
    }
  });
}

// ===== Утилиты =====

/**
 * Разбивает текст на чанки по границам предложений
 */
function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;

    // Ищем конец предложения
    for (let i = maxChunkSize; i >= maxChunkSize * 0.5; i--) {
      const char = remaining[i];
      if (char === '.' || char === '!' || char === '?' || char === '\n') {
        splitIndex = i + 1;
        break;
      }
    }

    // По пробелу
    if (splitIndex === -1) {
      for (let i = maxChunkSize; i >= maxChunkSize * 0.7; i--) {
        if (remaining[i] === ' ') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    if (splitIndex === -1) splitIndex = maxChunkSize;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Убирает Markdown/HTML для чистого озвучивания
 */
function stripFormatting(text: string): string {
  let clean = text;

  // Убираем секцию "Источники" / "📚 Источники:" в конце (если осталась)
  clean = clean.replace(/\n*📚\s*Источники?:[\s\S]*$/i, '');
  clean = clean.replace(/\n*Источники?:\s*\n[\s\S]*$/i, '');
  // Вариант: "Источники:" без эмодзи
  clean = clean.replace(/\n*### 📚\s*Источники?:[\s\S]*$/i, '');

  // Строки "Хочешь узнать больше..." в конце — не озвучивать
  clean = clean.replace(/\n*Хочешь узнать больше[\s\S]*$/i, '');

  // Код блоки
  clean = clean.replace(/```[\s\S]*?```/g, ' код пропущен ');
  clean = clean.replace(/`([^`]+)`/g, '$1');

  // Markdown-ссылки [текст](url) → текст
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Перплексити-формат: текст1 (https://...)(https://...) → текст
  // Суперскрипт-цифры перед URL в скобках: "уведомлении1 (https://...)"
  clean = clean.replace(/(\S)\d{1,2}\s*\(https?:\/\/[^)]+\)(?:\(https?:\/\/[^)]+\))*/g, '$1');

  // Citation маркеры [1], [2], [1][3] и т.п. — убираем полностью
  clean = clean.replace(/\[(\d+)\]/g, '');

  // Оставшиеся голые URL в скобках: (https://...)
  clean = clean.replace(/\(https?:\/\/[^)]+\)/g, '');

  // Голые URL без скобок (http/https)
  clean = clean.replace(/https?:\/\/[^\s)>\]]+/g, '');

  // Нумерация строк формата "1. https://..." — полностью убрать
  clean = clean.replace(/^\d+\.\s*https?:\/\/\S+\s*$/gm, '');

  // Markdown форматирование
  clean = clean.replace(/\*\*(.+?)\*\*/g, '$1');
  clean = clean.replace(/\*(.+?)\*/g, '$1');
  clean = clean.replace(/__(.+?)__/g, '$1');
  clean = clean.replace(/_(.+?)_/g, '$1');
  clean = clean.replace(/~~(.+?)~~/g, '$1');
  clean = clean.replace(/^#{1,6}\s+/gm, '');

  // HTML
  clean = clean.replace(/<[^>]+>/g, '');
  clean = clean.replace(/&amp;/g, '&');
  clean = clean.replace(/&lt;/g, '<');
  clean = clean.replace(/&gt;/g, '>');

  // Оставшиеся скобки от ссылок: "(ссылка: )" и "[источник: ...]"
  clean = clean.replace(/\(ссылка:\s*\)/gi, '');
  clean = clean.replace(/\[источник:\s*[^\]]*\]/gi, '');
  clean = clean.replace(/\(источник:\s*[^)]*\)/gi, '');

  // Пустые скобки () которые остались после удаления URL
  clean = clean.replace(/\(\s*\)/g, '');

  // Строки вида "---" (горизонтальные разделители)
  clean = clean.replace(/^-{3,}$/gm, '');

  // Все эмодзи (включая модификаторы, ZWJ-последовательности, флаги)
  clean = clean.replace(/(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)[\u{1F3FB}-\u{1F3FF}]?(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)[\u{1F3FB}-\u{1F3FF}]?)*/gu, '');

  // Множественные пробелы и пустые строки
  clean = clean.replace(/\n{3,}/g, '\n\n');
  clean = clean.replace(/[ \t]{2,}/g, ' ');
  clean = clean.replace(/^\s+$/gm, '');

  return clean.trim();
}

/**
 * Определить язык текста
 */
export function detectLanguage(text: string): 'ru' | 'en' {
  const cyrillicCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  return cyrillicCount > latinCount ? 'ru' : 'en';
}
