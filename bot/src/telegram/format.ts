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

import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { config } from '../config/index.js';
import { TELEGRAM_MAX_MESSAGE_LENGTH, FULL_TEXT_CACHE_TTL } from '../config/constants.js';

const MAX_MESSAGE_LENGTH = TELEGRAM_MAX_MESSAGE_LENGTH;
const LINK_PLACEHOLDER_PREFIX = '%%TG_LINK_';

interface ExtractedMarkdownLink {
  placeholder: string;
  label: string;
  url: string;
}

function escapeHtmlAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_\[\]()~>#+\-=|{}.!])/g, '$1');
}

function readBalancedSegment(
  text: string,
  startIndex: number,
  openChar: string,
  closeChar: string,
): { value: string; endIndex: number } | null {
  if (text[startIndex] !== openChar) return null;

  let depth = 1;
  let value = '';

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const currentChar = text[index]!;

    if (currentChar === '\\' && index + 1 < text.length) {
      value += currentChar + text[index + 1]!;
      index += 1;
      continue;
    }

    if (currentChar === openChar) {
      depth += 1;
      value += currentChar;
      continue;
    }

    if (currentChar === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return { value, endIndex: index + 1 };
      }
      value += currentChar;
      continue;
    }

    value += currentChar;
  }

  return null;
}

function extractMarkdownLinks(text: string): { text: string; links: ExtractedMarkdownLink[] } {
  const links: ExtractedMarkdownLink[] = [];
  let normalizedText = '';

  for (let index = 0; index < text.length; index += 1) {
    const currentChar = text[index]!;

    if (currentChar !== '[') {
      normalizedText += currentChar;
      continue;
    }

    const labelSegment = readBalancedSegment(text, index, '[', ']');
    if (!labelSegment || text[labelSegment.endIndex] !== '(') {
      normalizedText += currentChar;
      continue;
    }

    const urlSegment = readBalancedSegment(text, labelSegment.endIndex, '(', ')');
    if (!urlSegment) {
      normalizedText += currentChar;
      continue;
    }

    const label = labelSegment.value;
    const url = urlSegment.value.trim();
    if (!label || !url) {
      normalizedText += currentChar;
      continue;
    }

    const placeholder = `${LINK_PLACEHOLDER_PREFIX}${links.length}%%`;
    links.push({ placeholder, label, url });
    normalizedText += placeholder;
    index = urlSegment.endIndex - 1;
  }

  return { text: normalizedText, links };
}

function restoreMarkdownLinks(
  text: string,
  links: ExtractedMarkdownLink[],
  render: (link: ExtractedMarkdownLink) => string,
): string {
  return links.reduce(
    (result, link) => result.split(link.placeholder).join(render(link)),
    text,
  );
}

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
  const extracted = extractMarkdownLinks(text);
  let html = extracted.text;

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

  return restoreMarkdownLinks(html, extracted.links, (link) =>
    `<a href="${escapeHtmlAttribute(unescapeMarkdownText(link.url).trim())}">${escapeHtml(unescapeMarkdownText(link.label))}</a>`,
  );
};

/** Удаляет Markdown-форматирование, оставляя чистый текст */
export const stripMarkdown = (text: string): string => {
  const extracted = extractMarkdownLinks(text);
  let clean = extracted.text;
  clean = clean.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1');
  clean = clean.replace(/`([^`]+)`/g, '$1');
  clean = clean.replace(/\*\*(.+?)\*\*/g, '$1');
  clean = clean.replace(/(?<![<\w])\*([^*]+?)\*(?![>\w])/g, '$1');
  clean = clean.replace(/__(.+?)__/g, '$1');
  clean = clean.replace(/(?<![<\w])_([^_]+?)_(?![>\w])/g, '$1');
  clean = clean.replace(/~~(.+?)~~/g, '$1');
  clean = clean.replace(/^#{1,6}\s+/gm, '');
  return restoreMarkdownLinks(clean, extracted.links, (link) =>
    `${unescapeMarkdownText(link.label)} (${unescapeMarkdownText(link.url).trim()})`,
  );
};

/** Удаляет HTML-теги и декодирует сущности */
export const stripHtml = (text: string): string => {
  let clean = text;
  clean = clean.replace(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi, (_match, doubleQuotedUrl, singleQuotedUrl, label) => {
    const href = typeof doubleQuotedUrl === 'string' && doubleQuotedUrl
      ? doubleQuotedUrl
      : typeof singleQuotedUrl === 'string'
        ? singleQuotedUrl
        : '';
    return `${label} (${href})`;
  });
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
          // If a single sentence exceeds the limit, hard-split by character count
          if (sentence.length > MAX_MESSAGE_LENGTH) {
            if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = ''; }
            for (let j = 0; j < sentence.length; j += MAX_MESSAGE_LENGTH) {
              chunks.push(sentence.slice(j, j + MAX_MESSAGE_LENGTH));
            }
          } else if (currentChunk.length + sentence.length + 1 > MAX_MESSAGE_LENGTH) {
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

// ---- Кэш полного текста для озвучки (все длинные сообщения) ----
const fullTextCache = new Map<string, { text: string; createdAt: number }>();
const FULL_TEXT_CACHE_TTL_MS = FULL_TEXT_CACHE_TTL;
const MAX_CACHE_SIZE = 100; // Максимум 100 записей
let nextFullTextId = 1;

/** Сохранить полный текст сообщения и вернуть ID для озвучки */
export function cacheFullText(text: string): string {
  const now = Date.now();
  // Очистка устаревших записей
  for (const [key, val] of fullTextCache) {
    if (now - val.createdAt > FULL_TEXT_CACHE_TTL_MS) fullTextCache.delete(key);
  }
  // Ограничение размера: удаляем старейшие если превышен лимит
  if (fullTextCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = fullTextCache.keys().next().value;
    if (oldestKey) fullTextCache.delete(oldestKey);
  }
  const id = String(nextFullTextId++);
  fullTextCache.set(id, { text, createdAt: now });
  return id;
}

/** Получить полный текст по ID */
export function getFullText(id: string): string | null {
  const entry = fullTextCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > FULL_TEXT_CACHE_TTL_MS) {
    fullTextCache.delete(id);
    return null;
  }
  return entry.text;
}

/**
 * Отправляет длинное сообщение, разбивая на чанки.
 * Конвертирует Markdown → HTML, при ошибке fallback на plain text.
 * 
 * Если сообщение разбивается на несколько чанков И есть keyboard с кнопкой озвучки,
 * полный текст кэшируется и кнопка заменяется на read_aloud_full:ID
 * для озвучки ВСЕГО текста целиком.
 */
export const sendLongMessage = async (
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> => {
  const htmlText = markdownToTelegramHtml(text);
  const chunks = splitIntoChunks(htmlText);
  const isMultiChunk = chunks.length > 1;

  // Для многочастных сообщений: кэшируем полный текст и подменяем кнопку озвучки
  let effectiveKeyboard = keyboard;
  if (isMultiChunk && keyboard) {
    const fullTextId = cacheFullText(text);
    // Создаём новую клавиатуру, заменяя read_aloud на read_aloud_full:ID
    effectiveKeyboard = new InlineKeyboard();
    // Копируем кнопки, заменяя callback_data 'read_aloud' → 'read_aloud_full:ID'
    try {
      const rawRows = (keyboard as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard;
      if (rawRows && Array.isArray(rawRows)) {
        for (let ri = 0; ri < rawRows.length; ri++) {
          const row = rawRows[ri]!;
          for (const btn of row) {
            if (btn.callback_data === 'read_aloud') {
              effectiveKeyboard.text(btn.text, `read_aloud_full:${fullTextId}`);
            } else if (btn.callback_data) {
              effectiveKeyboard.text(btn.text, btn.callback_data);
            }
          }
          if (ri < rawRows.length - 1) effectiveKeyboard.row();
        }
      } else {
        effectiveKeyboard = keyboard;
      }
    } catch {
      effectiveKeyboard = keyboard;
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const isLast = i === chunks.length - 1;
    const options: Record<string, unknown> = {};
    if (isLast && effectiveKeyboard) {
      options.reply_markup = effectiveKeyboard;
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
 * Использует серверную TZ (из env.TZ).
 */
export const buildTimeContext = (firstName?: string): string => {
  const now = new Date();
  const TZ = config.server.timeZone;

  const dateFmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(now);

  const weekday = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    weekday: 'short',
  }).format(now);

  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ,
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);

  const nameStr = firstName ? ` ${firstName}` : '';

  return `[${dateFmt}, ${weekday}, ${time}.${nameStr}]`;
};

// ============================================
// Citation Inlining — [1] → clickable links
// ============================================

/**
 * Заменяет ссылки вида [1], [2][3] на кликабельные Markdown-ссылки.
 * Perplexity возвращает [N] как ссылки на citations[] массив.
 * 
 * Пример: "Новость о ИИ[1][3]" + citations = ["https://a.com", ..., "https://c.com"]
 *  → "Новость о ИИ [📎](https://a.com) [📎](https://c.com)"
 */
export const inlineCitations = (text: string, citations: string[]): string => {
  if (!citations || citations.length === 0) return text;
  
  // Заменяем [N] на кликабельные ссылки
  let result = text.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const index = parseInt(numStr, 10) - 1; // citations 0-based, references 1-based
    if (index >= 0 && index < citations.length) {
      const url = citations[index]!;
      return `[${numStr}](${url})`;
    }
    return match; // Если номер вне диапазона — оставляем как есть
  });
  
  // Убираем раздел "📚 Источники:" если он есть — ссылки уже инлайн
  result = result.replace(/\n*📚\s*Источники:[\s\S]*$/, '');
  
  return result;
};

// ============================================
// Search Simulation Detection
// ============================================

const SEARCH_SIMULATION_PATTERNS = [
  /🔍\s*ищу/i,
  /\*?\(?\*?поиск в интернете\*?\)?\*?/i,
  /сейчас я найду|сейчас найду|сейчас поищу/i,
  /ищу[.…]{1,3}/i,     // "Ищу..." и "Ищу…" (Unicode ellipsis)
  /ищу информацию/i,
  /выполняю поиск/i,
  /производится поиск/i,
  /подожди.*ищу|подожди.*поиск/i,
  // Новые паттерны симуляции (бесплатные LLM изобретательны)
  /давай(?:те)?\s+(?:я\s+)?(?:по)?ищу/i,       // "давай я поищу", "давайте поищу"
  /сейчас\s+(?:я\s+)?(?:проверю|посмотрю|узнаю)/i, // "сейчас проверю", "сейчас посмотрю"
  /\*\s*(?:Поиск|Ищу|Проверяю|Загружаю)\s*/i,   // *Поиск*, *Ищу*, markdown-выделение
  /searching|looking\s+up|let\s+me\s+(?:search|find|check)/i, // English simulation
  /загружаю\s+(?:данные|информацию|результаты)/i,
  /минуточку.*(?:ищу|проверяю|смотрю)/i,
  /одну\s+секунду.*(?:ищу|проверяю)/i,
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
  // Прямые отказы
  /не могу выполнить поиск/i,
  /не могу искать/i,
  /не умею искать/i,
  /не имею возможности.*поиск/i,
  /я не могу.*найти.*интернет/i,
  /к сожалению.*не могу.*поиск/i,

  // Отказы через "нет доступа"
  /нет доступа к.*интернет/i,
  /не имею доступа.*интернет/i,
  /у меня нет.*доступа.*(?:новым|актуальн|свежим)/i,
  /нет доступа.*(?:к\s+)?(?:сети|данным|информации)/i,

  // Отказы через "не могу + актуальность"
  /не могу.*(?:актуальн|свежи|реальн).*данн/i,
  /не могу.*получить.*(?:актуальн|свежи|реальн)/i,
  /не (?:могу|в\s*состоянии).*предоставить.*(?:актуальн|точн|свежи)/i,

  // "Нет данных / информации" — мягкие отказы
  /(?:у меня|я)\s+не\s+(?:обладаю|располагаю|владею).*(?:данн|информац|сведен)/i,
  /(?:у меня|мне)\s+(?:нет|недоступн).*(?:актуальн|свежи|новейш).*(?:данн|информац)/i,
  /не\s+(?:располагаю|обладаю)\s+(?:актуальн|свежи)/i,

  // "Мои данные устарели / ограничены"
  /мои\s+(?:данные|знания|сведения).*(?:устарел|ограничен|обрыва)/i,
  /информация.*(?:может быть|вероятно)\s+(?:устарел|неточн)/i,
  /данные.*(?:обучен|тренировк).*(?:закончил|ограничен)/i,

  // "Рекомендую проверить / обратитесь к"
  /рекомендую.*(?:проверить|обратиться|посетить|уточнить).*(?:сайт|источник|поисков)/i,
  /(?:для|за)\s+(?:актуальн|точн|свежи).*(?:обратитесь|проверьте|посетите|уточните)/i,
  /(?:лучше|советую).*(?:проверить|уточнить).*(?:в\s+интернет|на\s+сайт|в\s+поисков)/i,

  // "На момент обучения / по состоянию на"
  /на\s+момент\s+(?:моего\s+)?обучения/i,
  /по\s+состоянию\s+на\s+\d/i,
  /мои\s+(?:данные|знания)\s+(?:актуальны|обновлены)\s+до/i,

  // "Не могу ответить точно / не знаю актуального"
  /не\s+(?:знаю|могу\s+сказать)\s+(?:точн|актуальн)/i,
  /затрудняюсь\s+(?:ответить|предоставить|назвать)/i,

  // "Предлагаю воспользоваться / можете найти"
  /предлагаю\s+(?:воспользоваться|обратиться|использовать)/i,
  /можете\s+(?:найти|узнать|проверить).*(?:на\s+сайт|в\s+интернет|в\s+поисков|через\s+Google)/i,

  // "Отвлечение / перенаправление на свои возможности" — LLM вместо ответа перечисляет что она умеет
  /(?:но\s+)?(?:я\s+)?могу\s+помочь\s+с\s+(?:другими|иными)/i,
  /(?:я\s+)?могу\s+(?:помочь|подсказать).*(?:например|напр\.)/i,
  /вот\s+(?:что|чем)\s+(?:я\s+)?могу\s+(?:помочь|предложить)/i,
  /(?:зато|но|однако)\s+(?:я\s+)?(?:умею|могу).*(?:заметк|напоминан|картинк|поиск)/i,
  /(?:создать\s+)?заметку.*напоминание.*картинк/i,  // перечисление возможностей бота

  // "Не могу [действие] потому что не знаю [критерии/контекст]" — LLM уклоняется от ответа
  /не\s+(?:могу|знаю).*(?:потому\s+что|так\s+как|поскольку).*не\s+знаю/i,
  /не\s+(?:могу|в\s+состоянии).*(?:рассказать|найти|перечислить|назвать|подобрать)/i,
  /не\s+знаю.*(?:критери|имеешь\s+в\s+виду|что\s+именно)/i,

  // Субъективный уклон вместо ответа
  /(?:красота|красив).*субъективн.*(?:понятие|критерий|дело\s+вкуса)/i,
  /(?:зависит\s+от|дело\s+вкуса|каждому\s+своё).*(?:не\s+могу|сложно|трудно)\s+(?:сказать|назвать|ответить)/i,
  /(?:невозможно|нельзя)\s+(?:объективно|однозначно)\s+(?:сказать|определить|назвать|ответить)/i,

  // English refusals
  /i cannot.*search/i,
  /i don't have.*access.*internet/i,
  /i (?:can't|cannot|don't).*(?:browse|access).*(?:web|internet|real.?time)/i,
  /my (?:knowledge|data|training).*(?:cutoff|limited|outdated)/i,
];

/**
 * Определяет, отказалась ли LLM использовать данные поиска.
 * Если LLM говорит "не могу искать" когда данные БЫЛИ предоставлены — это ошибка.
 */
export const looksLikeSearchRefusal = (text: string): boolean => {
  return SEARCH_REFUSAL_PATTERNS.some(p => p.test(text));
};

// ============================================
// Search Data Extraction & Ignore Detection
// ============================================

/**
 * Извлекает сырой ответ Perplexity из webSearchContext.
 * webSearchContext имеет формат:
 *   === ДАННЫЕ ИЗ ИНТЕРНЕТА (date) ===
 *   {ответ Perplexity}
 *   КАРТА ИСТОЧНИКОВ: ...
 *   === КОНЕЦ ДАННЫХ ===
 *   ИНСТРУКЦИЯ ПО ДАННЫМ ИЗ ИНТЕРНЕТА: ...
 */
export function extractPerplexityAnswer(webSearchContext: string): string | null {
  if (!webSearchContext) return null;

  // Извлекаем текст между маркерами
  const startMarker = /=== ДАННЫЕ ИЗ ИНТЕРНЕТА.*?===\n?/;
  const endMarker = /\n*(?:КАРТА ИСТОЧНИКОВ:|=== КОНЕЦ ДАННЫХ ===)/;

  const startMatch = startMarker.exec(webSearchContext);
  if (!startMatch) return null;

  const afterStart = webSearchContext.substring(startMatch.index + startMatch[0].length);
  const endMatch = endMarker.exec(afterStart);
  
  const answer = endMatch ? afterStart.substring(0, endMatch.index).trim() : afterStart.trim();
  return answer.length > 20 ? answer : null;
}

/**
 * Извлекает ссылки-источники из webSearchContext.
 */
export function extractPerplexityCitations(webSearchContext: string): string[] {
  if (!webSearchContext) return [];
  const citations: string[] = [];
  const citationRegex = /\[(\d+)\]\s+(https?:\/\/\S+)/g;
  let match;
  while ((match = citationRegex.exec(webSearchContext)) !== null) {
    citations.push(match[2]!);
  }
  return citations;
}

/**
 * Определяет, проигнорировала ли LLM предоставленные данные из интернета.
 * 
 * Стратегия: вместо поиска конкретных паттернов отказа (их слишком много),
 * проверяем ПОЗИТИВНЫЙ сигнал — использовала ли LLM хоть какие-то факты из данных.
 * 
 * Если данные из Perplexity содержали числа (цены, курсы, температуры),
 * но в ответе LLM НИ ОДНОГО числа из данных нет — значит она их проигнорировала.
 */
export function llmIgnoredSearchData(aiResponse: string, webSearchContext: string): boolean {
  if (!webSearchContext) return false;

  const perplexityAnswer = extractPerplexityAnswer(webSearchContext);
  if (!perplexityAnswer) return false;

  // === Быстрая проверка: если ответ — прямой отказ или симуляция, сразу true ===
  if (looksLikeSearchRefusal(aiResponse) || looksLikeSearchSimulation(aiResponse)) {
    return true;
  }

  // === Проверка по числам: извлекаем числа из Perplexity ответа ===
  // Если Perplexity дал конкретные числа (цены, курсы, даты), а LLM их не использовала
  const numbersInPerplexity = extractSignificantNumbers(perplexityAnswer);
  if (numbersInPerplexity.length > 0) {
    const numbersInResponse = extractSignificantNumbers(aiResponse);
    // Если хотя бы одно значимое число из Perplexity есть в ответе — LLM использовала данные
    const hasOverlap = numbersInPerplexity.some(n => numbersInResponse.includes(n));
    if (!hasOverlap) {
      return true;  // Ни одного числа из Perplexity — проигнорировала
    }
  }

  // === Проверка по ключевым словам: если ответ подозрительно общий ===
  // Короткий ответ при длинных данных — подозрительно
  if (aiResponse.length < 150 && perplexityAnswer.length > 300) {
    // Проверяем — содержит ли ответ хоть что-то конкретное
    const hasConcreteInfo = /\d/.test(aiResponse) || /https?:\/\//.test(aiResponse);
    if (!hasConcreteInfo) {
      return true;
    }
  }

  return false;
}

/** Извлекает значимые числа (> 1 символа) из текста, нормализуя разделители */
function extractSignificantNumbers(text: string): string[] {
  // Ищем числа с разделителями: "2,87", "2.87", "1200", "48%"
  const numberPattern = /\d[\d.,\s]*\d/g;
  const numbers: string[] = [];
  let match;
  while ((match = numberPattern.exec(text)) !== null) {
    // Нормализуем: убираем пробелы, заменяем запятые на точки
    const normalized = match[0].replace(/\s/g, '').replace(/,/g, '.');
    if (normalized.length >= 2) {
      numbers.push(normalized);
    }
  }
  return numbers;
}

/**
 * Форматирует извлечённые данные Perplexity для показа пользователю.
 * Используется когда LLM проигнорировала данные — показываем напрямую.
 */
export function formatPerplexityFallback(webSearchContext: string): string | null {
  const answer = extractPerplexityAnswer(webSearchContext);
  if (!answer) return null;

  let result = answer;

  // Добавляем источники
  const citations = extractPerplexityCitations(webSearchContext);
  if (citations.length > 0) {
    result += '\n\n📚 Источники:\n';
    citations.slice(0, 5).forEach((url, i) => {
      result += `${i + 1}. ${url.length > 70 ? url.substring(0, 67) + '...' : url}\n`;
    });
  }

  return result;
}

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
