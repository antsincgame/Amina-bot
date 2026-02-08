/**
 * Telegram Text Formatting Utilities
 * 
 * Все функции форматирования текста для Telegram:
 * - Markdown → HTML конвертер
 * - Разбивка длинных сообщений
 * - Экранирование спецсимволов
 * - Генерация контекста времени
 * - Детекция симуляции поиска
 */

import type { Context } from 'grammy';
import type { InlineKeyboard } from 'grammy';

// ============================================
// Constants
// ============================================

const MAX_MESSAGE_LENGTH = 4096; // Telegram limit

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// ============================================
// Markdown / HTML Conversion
// ============================================

/** Экранирование спецсимволов Markdown для Telegram */
export const escapeMarkdown = (text: string): string =>
  text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

/** Экранирование HTML-сущностей для safe text внутри Telegram HTML */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Конвертирует стандартный Markdown из LLM в Telegram HTML.
 * Telegram HTML поддерживает: <b>, <i>, <code>, <pre>, <a>, <s>.
 */
export const markdownToTelegramHtml = (text: string): string => {
  let html = text;

  // Экранируем HTML-сущности (до конвертации)
  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  // ``` code blocks ``` → <pre>
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre>$1</pre>');

  // `inline code` → <code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // **bold** → <b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // *italic* (но не внутри <b>)
  html = html.replace(/(?<![<\w])\*([^*]+?)\*(?![>\w])/g, '<i>$1</i>');

  // __bold__ → <b>
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');

  // _italic_ → <i>
  html = html.replace(/(?<![<\w])_([^_]+?)_(?![>\w])/g, '<i>$1</i>');

  // ~~strikethrough~~ → <s>
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html;
};

/** Удаляет Markdown-форматирование, оставляя чистый текст */
export const stripMarkdown = (text: string): string => {
  let clean = text;
  clean = clean.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');
  clean = clean.replace(/`([^`]+)`/g, '$1');
  clean = clean.replace(/\*\*(.+?)\*\*/g, '$1');
  clean = clean.replace(/(?<![<\w])\*([^*]+?)\*(?![>\w])/g, '$1');
  clean = clean.replace(/__(.+?)__/g, '$1');
  clean = clean.replace(/(?<![<\w])_([^_]+?)_(?![>\w])/g, '$1');
  clean = clean.replace(/~~(.+?)~~/g, '$1');
  clean = clean.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  clean = clean.replace(/^#{1,6}\s+/gm, '');
  return clean;
};

/** Удаляет HTML-теги и декодирует сущности */
export const stripHtml = (text: string): string => {
  let clean = text;
  clean = clean.replace(/<[^>]+>/g, '');
  clean = clean.replace(/&amp;/g, '&');
  clean = clean.replace(/&lt;/g, '<');
  clean = clean.replace(/&gt;/g, '>');
  clean = clean.replace(/&quot;/g, '"');
  clean = clean.replace(/&apos;/g, "'");
  return clean;
};

// ============================================
// Long Message Splitting
// ============================================

/** Разбивает длинный текст на чанки по лимиту Telegram (4096) */
export const splitIntoChunks = (text: string): string[] => {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  const paragraphs = text.split('\n\n');
  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > MAX_MESSAGE_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If single paragraph is too long, split by sentences
      if (paragraph.length > MAX_MESSAGE_LENGTH) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length + 1 > MAX_MESSAGE_LENGTH) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
};

/**
 * Отправляет длинное сообщение, разбивая на чанки.
 * Конвертирует Markdown → HTML, при ошибке fallback на plain text.
 */
export const sendLongMessage = async (
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> => {
  const htmlText = markdownToTelegramHtml(text);
  const chunks = splitIntoChunks(htmlText);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;
    const options: Record<string, unknown> = {};
    if (isLast && keyboard) {
      options.reply_markup = keyboard;
    }

    try {
      await ctx.reply(chunk, { ...options, parse_mode: 'HTML' });
    } catch {
      const plainChunk = stripHtml(chunk);
      await ctx.reply(plainChunk, options);
    }
  }
};

// ============================================
// Time Context
// ============================================

/**
 * Контекст времени суток + день недели + имя для system prompt.
 * TZ=Europe/Minsk → new Date() уже в минском времени.
 */
export const buildTimeContext = (firstName?: string): string => {
  const now = new Date();
  const hour = now.getHours();
  const day = WEEKDAYS_RU[now.getDay()] ?? 'неизвестно';
  const dateStr = now.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  let greeting = '';
  if (hour >= 5 && hour < 12) greeting = 'утро';
  else if (hour >= 12 && hour < 17) greeting = 'день';
  else if (hour >= 17 && hour < 22) greeting = 'вечер';
  else greeting = 'ночь';

  const nameStr = firstName ? `Имя пользователя: ${firstName}.` : '';

  return `[Контекст: ${dateStr}, ${day}, ${greeting} (${hour}:${String(now.getMinutes()).padStart(2, '0')} МСК). ${nameStr}]`;
};

// ============================================
// Search Simulation Detection
// ============================================

const SEARCH_SIMULATION_PATTERNS = [
  /🔍\s*ищу/i,
  /\*?\(?\*?поиск в интернете\*?\)?\*?/i,
  /сейчас я найду|сейчас найду|сейчас поищу/i,
  /ищу\.\.\./i,
  /ищу информацию/i,
  /выполняю поиск/i,
  /производится поиск/i,
  /подожди.*ищу|подожди.*поиск/i,
];

/**
 * Определяет, является ли ответ LLM симуляцией поиска
 * (частая проблема бесплатных моделей — они пишут "Ищу..." вместо ответа)
 */
export const looksLikeSearchSimulation = (text: string): boolean => {
  const matches = SEARCH_SIMULATION_PATTERNS.filter(p => p.test(text));
  if (matches.length >= 2) return true;
  if (matches.length >= 1 && text.length < 300) return true;
  return false;
};

// ============================================
// Search Refusal Detection
// ============================================

/**
 * Паттерны когда LLM ОТКАЗЫВАЕТСЯ использовать данные поиска
 * и говорит пользователю "не могу искать" / "нет доступа"
 */
const SEARCH_REFUSAL_PATTERNS = [
  /не могу выполнить поиск/i,
  /не могу искать/i,
  /нет доступа к.*интернет/i,
  /не имею доступа.*интернет/i,
  /не умею искать/i,
  /не могу.*актуальн.*данн/i,
  /у меня нет.*доступа.*новым данным/i,
  /не могу.*получить.*актуальн/i,
  /не имею возможности.*поиск/i,
  /я не могу.*найти.*интернет/i,
  /к сожалению.*не могу.*поиск/i,
  /i cannot.*search/i,
  /i don't have.*access.*internet/i,
];

/**
 * Определяет, отказалась ли LLM использовать данные поиска.
 * Если LLM говорит "не могу искать" когда данные БЫЛИ предоставлены — это ошибка.
 */
export const looksLikeSearchRefusal = (text: string): boolean => {
  return SEARCH_REFUSAL_PATTERNS.some(p => p.test(text));
};

// ============================================
// Error Messages
// ============================================

/** Форматирует сообщение об ошибке поиска для пользователя */
export const formatSearchError = (errorCode: string): string => {
  let msg = '😔 К сожалению, не удалось получить актуальные данные из интернета.';

  switch (errorCode) {
    case 'PERPLEXITY_NOT_CONFIGURED':
      msg += '\n\n_API ключ поиска не настроен. Обратитесь к администратору._';
      break;
    case 'PERPLEXITY_AUTH_ERROR':
      msg += '\n\n_Ошибка авторизации API поиска. Проверьте ключ в настройках._';
      break;
    case 'PERPLEXITY_PAYMENT_REQUIRED':
      msg += '\n\n_Исчерпан лимит API поиска. Пополните баланс Perplexity._';
      break;
    case 'PERPLEXITY_RATE_LIMIT':
      msg += '\n\n_Слишком много запросов. Попробуй через минуту._';
      break;
    case 'PERPLEXITY_TIMEOUT':
      msg += '\n\n_Сервис поиска не ответил вовремя. Попробуй через минуту._';
      break;
    default:
      msg += '\n\n_Попробуй через минуту или используй /search для прямого поиска._';
  }

  return msg;
};
