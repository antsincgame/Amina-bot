/**
 * Text-to-Speech Service
 * 
 * Голосовые ответы через Microsoft Edge TTS (бесплатно, без API ключа).
 * Использует msedge-tts — Node.js пакет для Edge Read Aloud API.
 * 
 * Поддержка длинных текстов (до 10000 символов) — разбивает на чанки.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { appLogger } from '../config/logger.js';

// Голоса для разных языков
const VOICES = {
  ru: 'ru-RU-SvetlanaNeural',
  en: 'en-US-AriaNeural',
};

// Лимиты
const MAX_TEXT_LENGTH = 10_000;  // 10K символов ≈ 5-7 минут аудио
const CHUNK_SIZE = 3000;         // Чанк для одного запроса (Edge TTS поддерживает ~5000)
const TTS_TIMEOUT_MS = 60_000;   // 60 секунд на весь процесс

/**
 * Сгенерировать аудио из текста через Edge TTS
 * Возвращает Buffer с MP3 или null при ошибке
 */
export async function textToSpeech(
  text: string,
  lang: 'ru' | 'en' = 'ru'
): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) return null;

  // Очищаем текст от Markdown/HTML
  let cleanText = stripFormatting(text);
  
  // Обрезаем слишком длинный текст
  if (cleanText.length > MAX_TEXT_LENGTH) {
    cleanText = cleanText.slice(0, MAX_TEXT_LENGTH);
    appLogger.info({ originalLength: text.length, truncatedTo: MAX_TEXT_LENGTH }, 'TTS: text truncated');
  }

  const voice = VOICES[lang] || VOICES.ru;

  try {
    // Если текст короткий — один запрос
    if (cleanText.length <= CHUNK_SIZE) {
      return await generateAudio(cleanText, voice);
    }

    // Длинный текст — разбиваем на чанки и объединяем
    const chunks = splitTextIntoChunks(cleanText, CHUNK_SIZE);
    appLogger.info({ textLength: cleanText.length, chunks: chunks.length, voice }, 'TTS: generating multi-chunk audio');

    const audioBuffers: Buffer[] = [];
    for (const chunk of chunks) {
      const audio = await generateAudio(chunk, voice);
      if (audio) {
        audioBuffers.push(audio);
      }
    }

    if (audioBuffers.length === 0) return null;

    // Объединяем все чанки в один буфер
    return Buffer.concat(audioBuffers);
  } catch (error) {
    appLogger.error({ error, textLen: cleanText.length }, 'TTS generation failed');
    
    // Fallback: Google TTS для коротких текстов
    try {
      return await googleTtsFallback(cleanText.slice(0, 500), lang);
    } catch {
      return null;
    }
  }
}

/**
 * Генерация аудио для одного чанка через msedge-tts
 */
async function generateAudio(text: string, voice: string): Promise<Buffer | null> {
  const tts = new MsEdgeTTS();
  
  // Используем MP3 формат, 24kHz — хорошее качество для голосовых
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    // Таймаут на чанк (30 сек)
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        appLogger.warn({ textLen: text.length }, 'TTS chunk timeout');
        resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
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
          const result = chunks.length > 0 ? Buffer.concat(chunks) : null;
          if (result) {
            appLogger.debug({ textLen: text.length, audioBytes: result.length }, 'TTS chunk generated');
          }
          resolve(result);
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
          appLogger.warn({ error: err.message, textLen: text.length }, 'TTS stream error');
          resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
        }
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        appLogger.warn({ error: err }, 'TTS toStream failed');
        resolve(null);
      }
    }
  });
}

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

    // Ищем последнюю точку/!/?/перенос строки в пределах maxChunkSize
    let splitIndex = -1;
    
    // Ищем конец предложения
    for (let i = maxChunkSize; i >= maxChunkSize * 0.5; i--) {
      const char = remaining[i];
      if (char === '.' || char === '!' || char === '?' || char === '\n') {
        splitIndex = i + 1;
        break;
      }
    }

    // Если предложение не найдено — разбиваем по пробелу
    if (splitIndex === -1) {
      for (let i = maxChunkSize; i >= maxChunkSize * 0.7; i--) {
        if (remaining[i] === ' ') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    // Крайний случай — жёсткое разрезание
    if (splitIndex === -1) {
      splitIndex = maxChunkSize;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Fallback: Google Translate TTS
 * Разбивает длинный текст на чанки по 200 символов
 */
async function googleTtsFallback(text: string, lang: 'ru' | 'en' = 'ru'): Promise<Buffer | null> {
  const tl = lang === 'ru' ? 'ru' : 'en';
  const maxChars = 200;
  const chunks = splitTextIntoChunks(text, maxChars);
  const audioBuffers: Buffer[] = [];

  for (const chunk of chunks.slice(0, 10)) { // Макс 10 чанков
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${tl}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!response.ok) continue;
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 100) {
        audioBuffers.push(buffer);
      }
    } catch {
      continue;
    }
  }

  if (audioBuffers.length === 0) {
    appLogger.warn('Google TTS fallback failed');
    return null;
  }

  return Buffer.concat(audioBuffers);
}

/**
 * Убирает Markdown/HTML форматирование для чистого озвучивания
 */
function stripFormatting(text: string): string {
  let clean = text;
  // Убираем код блоки
  clean = clean.replace(/```[\s\S]*?```/g, ' код пропущен ');
  clean = clean.replace(/`([^`]+)`/g, '$1');
  // Убираем Markdown
  clean = clean.replace(/\*\*(.+?)\*\*/g, '$1');
  clean = clean.replace(/\*(.+?)\*/g, '$1');
  clean = clean.replace(/__(.+?)__/g, '$1');
  clean = clean.replace(/_(.+?)_/g, '$1');
  clean = clean.replace(/~~(.+?)~~/g, '$1');
  clean = clean.replace(/^#{1,6}\s+/gm, '');
  // Убираем ссылки
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Убираем HTML
  clean = clean.replace(/<[^>]+>/g, '');
  clean = clean.replace(/&amp;/g, '&');
  clean = clean.replace(/&lt;/g, '<');
  clean = clean.replace(/&gt;/g, '>');
  // Убираем лишние эмодзи в начале строк (часто мешают озвучке)
  clean = clean.replace(/^[📌✅☀️🌐🎨⏰🔊📋🧹🎛💬🤖📷🎤💡⚡🔍📚🌤🌍📰🔔🔕✨🎉]\s*/gm, '');
  // Убираем множественные пробелы и переносы
  clean = clean.replace(/\n{3,}/g, '\n\n');
  clean = clean.replace(/\s{2,}/g, ' ');
  return clean.trim();
}

/**
 * Определить язык текста (простая эвристика)
 */
export function detectLanguage(text: string): 'ru' | 'en' {
  const cyrillicCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  return cyrillicCount > latinCount ? 'ru' : 'en';
}
