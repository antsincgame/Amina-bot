/**
 * Reminder Parser
 * 
 * Стратегия: regex-first, AI-fallback
 * 1. Regex-детекция намерения создать напоминание
 * 2. Regex-парсинг простых случаев ("через N минут/часов") — БЕЗ AI
 * 3. AI-извлечение для сложных случаев — с retry
 */

import { aiService } from '../ai/openrouter.js';
import { aiLogger } from '../config/logger.js';

// --------------------------------------------
// Constants
// --------------------------------------------

const MAX_AI_RETRIES = 2;
const AI_RETRY_DELAY_MS = 2000;
const MAX_MINUTES_RANGE = 1440; // 24 часа в минутах
const MAX_HOURS_RANGE = 72;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TASK_LENGTH = 3;

// --------------------------------------------
// Intent Detection (regex, без AI-вызова)
// --------------------------------------------

/**
 * Требуем наличие временного контекста для "напомни/напомнить" — 
 * иначе "напомни что такое ООП" ложно перехватывается как создание напоминания.
 * Паттерны без временного контекста ("не забыть", "поставь напоминание") достаточно специфичны.
 */
const TIME_CONTEXT = '(?=.*(?:через|завтра|послезавтра|утром|вечером|днём|ночью|в\\s+\\d{1,2}[:.\\s]|в\\s+понедельник|в\\s+вторник|в\\s+среду|в\\s+четверг|в\\s+пятницу|в\\s+субботу|в\\s+воскресенье|минут|час|in\\s+\\d+\\s*(?:min|hour|sec|day|week)|tomorrow|tonight|at\\s+\\d))';

const REMINDER_PATTERNS = [
  new RegExp(`напомни${TIME_CONTEXT}`, 'i'),
  new RegExp(`напомнить${TIME_CONTEXT}`, 'i'),
  new RegExp(`remind${TIME_CONTEXT}`, 'i'),
  /не забыть/i,
  /не забудь/i,
  /поставь.{0,20}напомин/i,
  /создай.{0,20}напомин/i,
  /через\s+\d+\s*(минут|час|дн|недел)/i,
  /завтра\s+в\s+\d/i,
  /послезавтра\s+в\s+\d/i,
  /в\s+\d{1,2}[:.]\d{2}\s+(сделать|купить|позвонить|написать|проверить|отправить|забрать|встретить|оплатить)/i,
];

/** Запросы на ПРОСМОТР напоминаний (не создание) */
const REMINDER_LIST_PATTERNS = [
  /\b(список|покажи|предоставь|выведи|открой|просмотр)\b.{0,15}(напомин|remind)/i,
  /\b(мои|все|активн|текущ)\b.{0,10}(напомин|remind)/i,
  /\b(напомин|remind).{0,10}(список|все|мои|покажи|сколько|какие|есть)\b/i,
  /^(напоминания|reminders)$/i,
  /\bwhat.{0,10}remind/i,
  /\bshow.{0,10}remind/i,
];

/**
 * Проверка: пользователь хочет ПОСМОТРЕТЬ список напоминаний (а не создать)?
 */
export function detectReminderListIntent(text: string): boolean {
  return REMINDER_LIST_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Быстрая проверка: похоже ли сообщение на запрос СОЗДАНИЯ напоминания?
 * Без вызова AI, чистый regex.
 * Исключает запросы на просмотр списка напоминаний.
 */
export function detectReminderIntent(text: string): boolean {
  if (detectReminderListIntent(text)) return false;
  return REMINDER_PATTERNS.some(pattern => pattern.test(text));
}

// --------------------------------------------
// Regex Parser (без AI, мгновенный)
// --------------------------------------------

/**
 * Извлечь задачу из текста, убрав временные конструкции
 */
function extractTaskFromText(text: string): string {
  let task = text
    // Убираем конструкцию "напомни мне/нам/..."
    .replace(/^(напомни|напомнить|напоминание|не забыть|не забудь)\s*(мне|нам|себе)?\s*/i, '')
    // Убираем временные фразы
    .replace(/через\s+\d+\s*(минут\w*|час\w*|секунд\w*|дн\w*|дней|недел\w*)\s*/i, '')
    .replace(/завтра\s*(в\s+\d{1,2}[:.]\d{2})?\s*/i, '')
    .replace(/послезавтра\s*(в\s+\d{1,2}[:.]\d{2})?\s*/i, '')
    .replace(/в\s+\d{1,2}[:.]\d{2}\s*/i, '')
    // Убираем лишние слова-связки в начале
    .replace(/^(что\s+нужно|что\s+надо|о\s+том\s+что(бы)?|что(бы)?)\s*/i, '')
    .replace(/^(про|о|об)\s+/i, '')
    .trim();

  // Если ничего не осталось — берём оригинал без "напомни"
  if (task.length < MIN_TASK_LENGTH) {
    task = text.replace(/^(напомни|напомнить)\s*(мне|нам)?\s*/i, '').trim();
  }

  // Первая буква заглавная
  return task.charAt(0).toUpperCase() + task.slice(1);
}

/**
 * Форматировать время для пользователя.
 * TZ=Europe/Minsk → toLocaleString уже в минском времени (UTC+3).
 */
function formatMinskTime(date: Date): string {
  return date.toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Форматировать ISO 8601 с минским часовым поясом (+03:00).
 * Явно указываем timeZone: 'Europe/Minsk' для надёжности (не зависим от TZ env).
 */
function toMinskISO(date: Date): string {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Minsk',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const minskStr = fmt.format(date);
  return minskStr.replace(' ', 'T') + '+03:00';
}

interface RegexTimeMatch {
  offsetMs: number;
  label: string; // "через 15 минут", "через 2 часа" и т.д.
}

/**
 * Парсит простые временные конструкции regex'ом
 * Возвращает null если конструкция сложная (нужен AI)
 */
function parseSimpleTime(text: string): RegexTimeMatch | null {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;

  // "через N минут(у/ы)"
  const minuteMatch = text.match(/через\s+(\d+)\s*(минут\w*|мин)/i);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]!, 10);
    if (n >= 1 && n <= MAX_MINUTES_RANGE) {
      return { offsetMs: n * MINUTE_MS, label: `через ${n} мин.` };
    }
  }

  // "через N час(ов/а)"
  const hourMatch = text.match(/через\s+(\d+)\s*(час\w*)/i);
  if (hourMatch) {
    const n = parseInt(hourMatch[1]!, 10);
    if (n >= 1 && n <= MAX_HOURS_RANGE) {
      const hoursLabel = n === 1 ? 'час' : (n < 5 ? 'часа' : 'часов');
      return { offsetMs: n * HOUR_MS, label: `через ${n} ${hoursLabel}` };
    }
  }

  // "через полчаса"
  if (/через\s+полчаса/i.test(text)) {
    return { offsetMs: 30 * MINUTE_MS, label: 'через 30 мин.' };
  }

  // "через полтора часа"
  if (/через\s+полтора\s+часа/i.test(text)) {
    return { offsetMs: 90 * MINUTE_MS, label: 'через 1.5 часа' };
  }

  // "через минуту"
  if (/через\s+минут[уы]?\b/i.test(text) && !minuteMatch) {
    return { offsetMs: 1 * MINUTE_MS, label: 'через 1 мин.' };
  }

  return null;
}

/**
 * Парсить напоминание чистым regex'ом — без AI
 * Работает для простых случаев: "напомни через 15 минут проверить X"
 */
function parseReminderRegex(text: string, now: Date): ExtractedReminder | null {
  const timeMatch = parseSimpleTime(text);
  if (!timeMatch) return null;

  const task = extractTaskFromText(text);
  if (task.length < 2) return null;

  const scheduledDate = new Date(now.getTime() + timeMatch.offsetMs);
  const timeStr = formatMinskTime(scheduledDate);

  aiLogger.info(
    { task, offset: timeMatch.label, scheduledAt: toMinskISO(scheduledDate) },
    'Reminder parsed by regex (no AI needed)'
  );

  return {
    task,
    scheduled_at: toMinskISO(scheduledDate),
    reply: `Конечно! Напомню ${timeMatch.label}, в ${timeStr}. 📝`,
  };
}

// --------------------------------------------
// AI Extraction (fallback для сложных случаев)
// --------------------------------------------

export interface ExtractedReminder {
  task: string;
  scheduled_at: string; // ISO 8601 with +03:00
  reply: string;        // Ответ пользователю
}

/**
 * Извлекает задачу и время из текста.
 * 
 * Стратегия: regex-first, AI-fallback с retry
 * 1. Пробуем распарсить regex'ом (мгновенно, 100% надёжно)
 * 2. Если regex не справился — вызываем AI (с retry)
 */
export async function extractReminder(
  text: string,
  now: Date
): Promise<ExtractedReminder | null> {
  // ========= ЭТАП 1: Regex (мгновенно, без AI) =========
  const regexResult = parseReminderRegex(text, now);
  if (regexResult) {
    return regexResult;
  }

  // ========= ЭТАП 2: AI с retry (для сложных случаев) =========
  aiLogger.debug({ text }, 'Regex could not parse reminder, trying AI');

  // TZ=Europe/Minsk → toLocaleString уже в минском времени
  const minskTime = now.toLocaleString('sv-SE').replace(' ', 'T') + '+03:00';
  const minskReadable = now.toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const systemPrompt = `Ты — парсер напоминаний. Твоя задача — извлечь из текста пользователя:
1. task — что нужно напомнить (кратко, 1-2 предложения)
2. scheduled_at — когда напомнить (ISO 8601, часовой пояс +03:00 Минск)
3. reply — дружелюбный ответ пользователю с подтверждением

Текущее время (Минск): ${minskReadable}
ISO: ${minskTime}

Правила:
- Если время не указано явно — используй разумное значение (утро=09:00, вечер=19:00, обед=13:00)
- "через 2 часа" = текущее время + 2 часа
- "завтра" = следующий день
- "послезавтра" = через 2 дня
- "в понедельник" = ближайший понедельник (если сегодня понедельник — следующий)
- Всегда используй часовой пояс +03:00
- reply должен быть кратким и содержать время в человекочитаемом формате

Верни ТОЛЬКО валидный JSON (без markdown):
{"task":"...","scheduled_at":"YYYY-MM-DDTHH:MM:SS+03:00","reply":"..."}

Если не удаётся определить время — верни:
{"task":null,"scheduled_at":null,"reply":null}`;

  // Retry loop — бесплатные модели нестабильны
  for (let attempt = 1; attempt <= MAX_AI_RETRIES; attempt++) {
    try {
      const response = await aiService.chat(
        [{ role: 'user', content: text }],
        'telegram',
        systemPrompt
      );

      // Извлекаем JSON из ответа (AI может обернуть в ```json ... ```)
      let jsonStr = response.content.trim();
      
      // Убираем markdown code blocks если есть
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr) as {
        task: string | null;
        scheduled_at: string | null;
        reply: string | null;
      };

      // Проверяем что AI смог распарсить
      if (!parsed.task || !parsed.scheduled_at || !parsed.reply) {
        aiLogger.info({ text, attempt }, 'AI could not parse reminder from text');
        return null; // AI сказал "не могу" — не ретраим
      }

      // Валидация даты
      const scheduledDate = new Date(parsed.scheduled_at);
      if (isNaN(scheduledDate.getTime())) {
        aiLogger.warn({ scheduled_at: parsed.scheduled_at, attempt }, 'Invalid date from AI');
        // Может быть баг модели — ретраим
        if (attempt < MAX_AI_RETRIES) {
          await sleep(AI_RETRY_DELAY_MS);
          continue;
        }
        return null;
      }

      // Проверяем что дата в будущем (с допуском 30 секунд)
      if (scheduledDate.getTime() < now.getTime() - 30_000) {
        aiLogger.warn({ scheduled_at: parsed.scheduled_at, now: now.toISOString() }, 'Reminder date is in the past');
        return null;
      }

      if (scheduledDate.getTime() > now.getTime() + ONE_YEAR_MS) {
        aiLogger.warn({ scheduled_at: parsed.scheduled_at }, 'Reminder date too far in the future');
        return null;
      }

      aiLogger.info(
        { task: parsed.task, scheduled_at: parsed.scheduled_at, attempt },
        'Reminder extracted from text via AI'
      );

      return {
        task: parsed.task,
        scheduled_at: parsed.scheduled_at,
        reply: parsed.reply,
      };
    } catch (error) {
      aiLogger.warn({ error, text, attempt, maxRetries: MAX_AI_RETRIES }, 'AI reminder extraction attempt failed');
      
      if (attempt < MAX_AI_RETRIES) {
        await sleep(AI_RETRY_DELAY_MS);
        continue;
      }
      
      // Все попытки исчерпаны — пробуем regex fallback для "через N минут"
      aiLogger.error({ error, text }, 'All AI attempts failed for reminder extraction');
      throw error; // Пробрасываем наверх — bot.ts покажет честное сообщение
    }
  }

  return null;
}

// --------------------------------------------
// Utilities
// --------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
