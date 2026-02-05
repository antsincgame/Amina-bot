/**
 * Text-to-Speech Service
 * 
 * Голосовые ответы через Edge TTS (бесплатно, без API ключа).
 * Используется Microsoft Edge Read Aloud API.
 */

import { appLogger } from '../config/logger.js';

// Edge TTS endpoint (free, no auth)
const EDGE_TTS_URL = 'https://api.edge-tts.com/tts';

// Голоса для разных языков
const VOICES = {
  ru: 'ru-RU-SvetlanaNeural',
  en: 'en-US-AriaNeural',
};

const MAX_TEXT_LENGTH = 2000;
const TTS_TIMEOUT_MS = 15_000;

/**
 * Сгенерировать аудио из текста через Edge TTS
 * Возвращает Buffer с MP3 или null при ошибке
 */
export async function textToSpeech(
  text: string,
  lang: 'ru' | 'en' = 'ru'
): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) return null;

  // Обрезаем слишком длинный текст
  const cleanText = text.slice(0, MAX_TEXT_LENGTH).trim();
  const voice = VOICES[lang] || VOICES.ru;

  try {
    // Используем edge-tts через subprocess (pip package)
    // Если его нет — используем fallback через fetch к внешнему API
    const result = await edgeTtsFetch(cleanText, voice);
    return result;
  } catch (error) {
    appLogger.error({ error, textLen: cleanText.length }, 'TTS generation failed');
    return null;
  }
}

/**
 * Edge TTS через subprocess (python edge-tts)
 */
async function edgeTtsFetch(text: string, voice: string): Promise<Buffer | null> {
  // Используем публичный Edge TTS сервис через POST
  // Endpoint: Microsoft Cognitive Services TTS
  const ssml = `
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ru-RU">
  <voice name="${voice}">
    <prosody rate="0%">${escapeXml(text)}</prosody>
  </voice>
</speak>`.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const response = await fetch(
      'https://eastus.api.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
          'User-Agent': 'Mozilla/5.0',
        },
        body: ssml,
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      // Fallback: попробуем через бесплатный Google TTS
      return await googleTtsFallback(text);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    // Fallback
    return await googleTtsFallback(text);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback: Google Translate TTS (ограничение ~200 символов)
 */
async function googleTtsFallback(text: string): Promise<Buffer | null> {
  const shortText = text.slice(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=${encodeURIComponent(shortText)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Проверяем минимальный размер (не пустой ответ)
    if (buffer.length < 100) return null;

    return buffer;
  } catch {
    appLogger.warn('Google TTS fallback also failed');
    return null;
  }
}

/**
 * Экранировать XML спецсимволы
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Определить язык текста (простая эвристика)
 */
export function detectLanguage(text: string): 'ru' | 'en' {
  const cyrillicCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  return cyrillicCount > latinCount ? 'ru' : 'en';
}
