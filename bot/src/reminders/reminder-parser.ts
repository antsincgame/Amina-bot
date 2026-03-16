/**
 * Reminder Parser
 *
 * Стратегия: regex-first, AI-fallback
 * 1. Regex-детекция намерения создать напоминание
 * 2. Regex-парсинг 90% случаев (offset, day-of-week, date, time-of-day) — БЕЗ AI
 * 3. AI-извлечение для оставшихся сложных случаев — passthrough + max_tokens=256
 */

import { aiService } from '../ai/openrouter.js';
import { config } from '../config/index.js';
import { aiLogger } from '../config/logger.js';

// --------------------------------------------
// Constants
// --------------------------------------------

const MAX_AI_RETRIES = 1;
const AI_RETRY_DELAY_MS = 2000;
const MAX_MINUTES_RANGE = 1440; // 24 часа в минутах
const MAX_HOURS_RANGE = 72;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TASK_LENGTH = 3;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// --------------------------------------------
// Intent Detection (regex, без AI-вызова)
// --------------------------------------------

/**
 * Требуем наличие временного контекста для "напомни/напомнить" —
 * иначе "напомни что такое ООП" ложно перехватывается как создание напоминания.
 * Паттерны без временного контекста ("не забыть", "поставь напоминание") достаточно специфичны.
 */
const TIME_CONTEXT = '(?=.*(?:через|завтра|послезавтра|утром|вечером|днём|ночью|в\\s+\\d{1,2}[:.\\s]|в\\s+понедельник|в\\s+вторник|в\\s+среду|в\\s+четверг|в\\s+пятницу|в\\s+субботу|в\\s+воскресенье|минут|час|полчаса|полтора|сегодня|\\d{1,2}-го|in\\s+\\d+\\s*(?:min|hour|sec|day|week)|tomorrow|tonight|at\\s+\\d))';

const REMINDER_PATTERNS = [
  new RegExp(`напомни${TIME_CONTEXT}`, 'i'),
  new RegExp(`напомнить${TIME_CONTEXT}`, 'i'),
  new RegExp(`remind${TIME_CONTEXT}`, 'i'),
  /не забыть/i,
  /не забудь/i,
  /поставь.{0,20}напомин/i,
  /создай.{0,20}напомин/i,
  /через\s+\d+\s*(минут|час|дн|недел)/i,
  /через\s+(полчаса|полтора\s+часа)/i,
  /завтра\s+в\s+\d/i,
  /послезавтра\s+в\s+\d/i,
  /сегодня\s+(утром|днём|вечером|ночью)/i,
  /завтра\s+(утром|днём|вечером|ночью)/i,
  /\d{1,2}-го\s*(в\s+\d)?/i,
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
// Timezone-aware Date Helpers
// --------------------------------------------

const SERVER_TZ = config.server.timeZone;

function getTimeZoneOffsetString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const timeZoneName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = timeZoneName.match(/^GMT(?:(\+|-)(\d{1,2})(?::(\d{2}))?)?$/);

  if (!match || !match[1]) {
    return '+00:00';
  }

  const sign = match[1];
  const hours = (match[2] ?? '0').padStart(2, '0');
  const minutes = (match[3] ?? '0').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function formatLocalTime(date: Date): string {
  return date.toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SERVER_TZ,
  });
}

function formatLocalDate(date: Date): string {
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SERVER_TZ,
  });
}

function toLocalISO(date: Date): string {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: SERVER_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const localStr = fmt.format(date);
  return localStr.replace(' ', 'T') + getTimeZoneOffsetString(date, SERVER_TZ);
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sunday .. 6=Saturday
}

function getLocalParts(date: Date): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SERVER_TZ,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0';

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

function buildDateInServerTZ(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  now: Date,
): Date {
  const offset = getTimeZoneOffsetString(now, SERVER_TZ);
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  const mi = String(minute).padStart(2, '0');
  const s = String(second).padStart(2, '0');
  return new Date(`${year}-${m}-${d}T${h}:${mi}:${s}${offset}`);
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
    .replace(/через\s+(\d+\s*)?(минут[а-яё]*|час[а-яё]*|секунд[а-яё]*|дн[а-яё]*|дней|недел[а-яё]*|полчаса|полтора\s+часа)\s*/i, '')
    .replace(/(сегодня|завтра|послезавтра)\s*(утром|днём|вечером|ночью)?\s*/i, '')
    .replace(/в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\s*/i, '')
    .replace(/\d{1,2}-го\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)?\s*/i, '')
    .replace(/\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s*/i, '')
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

// Маппинг дней недели (русский → JS weekday 0=Sun..6=Sat)
const WEEKDAY_MAP: Record<string, number> = {
  'понедельник': 1,
  'вторник': 2,
  'среду': 3,
  'четверг': 4,
  'пятницу': 5,
  'субботу': 6,
  'воскресенье': 0,
};

// Маппинг месяцев (русский родительный падеж → 1-12)
const MONTH_MAP: Record<string, number> = {
  'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4,
  'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
  'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12,
};

interface AbsoluteTimeMatch {
  date: Date;
  label: string;
}

function parseOptionalTime(text: string): { hour: number; minute: number } | null {
  const timeMatch = text.match(/в\s+(\d{1,2})[:.]\s*(\d{2})/i);
  if (!timeMatch) return null;
  const hour = parseInt(timeMatch[1]!, 10);
  const minute = parseInt(timeMatch[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseAbsoluteTime(text: string, now: Date): AbsoluteTimeMatch | null {
  const local = getLocalParts(now);

  // "завтра [в HH:MM]" / "завтра утром/вечером/днём/ночью"
  const tomorrowMatch = text.match(/завтра\s*(?:(утром|днём|вечером|ночью)|(в\s+\d{1,2}[:.]\s*\d{2}))?/i);
  if (tomorrowMatch) {
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const tLocal = getLocalParts(tomorrow);
    const resolved = resolveTimeOfDay(tomorrowMatch[1], text, 9, 0);
    const date = buildDateInServerTZ(tLocal.year, tLocal.month, tLocal.day, resolved.hour, resolved.minute, 0, now);
    return { date, label: `завтра, в ${formatLocalTime(date)}` };
  }

  // "послезавтра [в HH:MM]"
  const dayAfterMatch = text.match(/послезавтра/i);
  if (dayAfterMatch) {
    const dayAfter = new Date(now.getTime() + 2 * DAY_MS);
    const daLocal = getLocalParts(dayAfter);
    const timeOverride = parseOptionalTime(text);
    const hour = timeOverride?.hour ?? 9;
    const minute = timeOverride?.minute ?? 0;
    const date = buildDateInServerTZ(daLocal.year, daLocal.month, daLocal.day, hour, minute, 0, now);
    return { date, label: `послезавтра, в ${formatLocalTime(date)}` };
  }

  // "сегодня утром/днём/вечером/ночью"
  const todayMatch = text.match(/сегодня\s+(утром|днём|вечером|ночью)/i);
  if (todayMatch) {
    const resolved = resolveTimeOfDay(todayMatch[1], text, local.hour, local.minute);
    const date = buildDateInServerTZ(local.year, local.month, local.day, resolved.hour, resolved.minute, 0, now);
    if (date.getTime() <= now.getTime()) {
      return null; // время уже прошло сегодня — пусть AI разберётся
    }
    return { date, label: `сегодня, в ${formatLocalTime(date)}` };
  }

  // "в понедельник/вторник/... [в HH:MM]"
  const weekdayMatch = text.match(/в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/i);
  if (weekdayMatch) {
    const targetDay = WEEKDAY_MAP[weekdayMatch[1]!.toLowerCase()];
    if (targetDay === undefined) return null;

    let daysAhead = targetDay - local.weekday;
    if (daysAhead <= 0) daysAhead += 7; // всегда СЛЕДУЮЩИЙ, не сегодня

    const target = new Date(now.getTime() + daysAhead * DAY_MS);
    const tLocal = getLocalParts(target);
    const timeOverride = parseOptionalTime(text);
    const hour = timeOverride?.hour ?? 9;
    const minute = timeOverride?.minute ?? 0;
    const date = buildDateInServerTZ(tLocal.year, tLocal.month, tLocal.day, hour, minute, 0, now);

    const dayNames: Record<number, string> = {
      0: 'воскресенье', 1: 'понедельник', 2: 'вторник', 3: 'среду',
      4: 'четверг', 5: 'пятницу', 6: 'субботу',
    };
    return { date, label: `в ${dayNames[targetDay]}, ${formatLocalDate(date)}` };
  }

  // "N-го [месяца] [в HH:MM]" или "N месяца [в HH:MM]"
  const dateMatch = text.match(/(\d{1,2})-?(?:го)?\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)?/i);
  if (dateMatch) {
    const dayNum = parseInt(dateMatch[1]!, 10);
    if (dayNum < 1 || dayNum > 31) return null;

    let month = dateMatch[2] ? MONTH_MAP[dateMatch[2].toLowerCase()]! : local.month;
    let year = local.year;

    // Если день уже прошёл в текущем месяце — берём следующий месяц (или следующий год)
    const timeOverride = parseOptionalTime(text);
    const hour = timeOverride?.hour ?? 9;
    const minute = timeOverride?.minute ?? 0;

    let date = buildDateInServerTZ(year, month, dayNum, hour, minute, 0, now);
    if (date.getTime() <= now.getTime()) {
      if (dateMatch[2]) {
        // Месяц указан явно — берём следующий год
        year += 1;
      } else {
        // Месяц не указан — берём следующий месяц
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      date = buildDateInServerTZ(year, month, dayNum, hour, minute, 0, now);
    }

    return { date, label: formatLocalDate(date) };
  }

  return null;
}

function resolveTimeOfDay(
  timeOfDay: string | undefined,
  fullText: string,
  defaultHour: number,
  defaultMinute: number,
): { hour: number; minute: number } {
  // Сначала проверяем явное время "в HH:MM"
  const explicit = parseOptionalTime(fullText);
  if (explicit) return explicit;

  // Время суток
  if (timeOfDay) {
    const lower = timeOfDay.toLowerCase();
    if (lower === 'утром') return { hour: 9, minute: 0 };
    if (lower === 'днём') return { hour: 14, minute: 0 };
    if (lower === 'вечером') return { hour: 19, minute: 0 };
    if (lower === 'ночью') return { hour: 23, minute: 0 };
  }

  return { hour: defaultHour, minute: defaultMinute };
}

interface RegexTimeMatch {
  offsetMs: number;
  label: string;
}

/**
 * Парсит простые относительные конструкции ("через N минут/часов", "через полчаса")
 */
function parseSimpleTime(text: string): RegexTimeMatch | null {
  // "через полтора часа" — проверяем ДО "через N час"
  if (/через\s+полтора\s+часа/i.test(text)) {
    return { offsetMs: 90 * MINUTE_MS, label: 'через 1.5 часа' };
  }

  // "через полчаса"
  if (/через\s+полчаса/i.test(text)) {
    return { offsetMs: 30 * MINUTE_MS, label: 'через 30 мин.' };
  }

  // "через N минут(у/ы)"
  const minuteMatch = text.match(/через\s+(\d+)\s*(минут[а-яё]*|мин)/i);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]!, 10);
    if (n >= 1 && n <= MAX_MINUTES_RANGE) {
      return { offsetMs: n * MINUTE_MS, label: `через ${n} мин.` };
    }
  }

  // "через N час(ов/а)"
  const hourMatch = text.match(/через\s+(\d+)\s*(час[а-яё]*)/i);
  if (hourMatch) {
    const n = parseInt(hourMatch[1]!, 10);
    if (n >= 1 && n <= MAX_HOURS_RANGE) {
      const hoursLabel = n === 1 ? 'час' : (n < 5 ? 'часа' : 'часов');
      return { offsetMs: n * HOUR_MS, label: `через ${n} ${hoursLabel}` };
    }
  }

  // "через минуту"
  if (/через\s+минут[уы]?\b/i.test(text) && !minuteMatch) {
    return { offsetMs: 1 * MINUTE_MS, label: 'через 1 мин.' };
  }

  return null;
}

/**
 * Парсить напоминание чистым regex'ом — без AI
 * Обрабатывает ~90% случаев: offset, day-of-week, date, time-of-day
 */
function parseReminderRegex(text: string, now: Date): ExtractedReminder | null {
  // 1. Относительное время ("через N минут/часов")
  const timeMatch = parseSimpleTime(text);
  if (timeMatch) {
    const task = extractTaskFromText(text);
    if (task.length < 2) return null;

    const scheduledDate = new Date(now.getTime() + timeMatch.offsetMs);
    const timeStr = formatLocalTime(scheduledDate);

    aiLogger.info(
      { task, offset: timeMatch.label, scheduledAt: toLocalISO(scheduledDate) },
      'Reminder parsed by regex (relative time)',
    );

    return {
      task,
      scheduled_at: toLocalISO(scheduledDate),
      reply: `Конечно! Напомню ${timeMatch.label}, в ${timeStr}. 📝`,
    };
  }

  // 2. Абсолютное время (завтра, день недели, дата, время суток)
  const absoluteMatch = parseAbsoluteTime(text, now);
  if (absoluteMatch) {
    const task = extractTaskFromText(text);
    if (task.length < 2) return null;

    aiLogger.info(
      { task, label: absoluteMatch.label, scheduledAt: toLocalISO(absoluteMatch.date) },
      'Reminder parsed by regex (absolute time)',
    );

    return {
      task,
      scheduled_at: toLocalISO(absoluteMatch.date),
      reply: `Конечно! Напомню ${absoluteMatch.label}. 📝`,
    };
  }

  return null;
}

// --------------------------------------------
// AI Extraction (fallback для сложных случаев)
// --------------------------------------------

export interface ExtractedReminder {
  task: string;
  scheduled_at: string; // ISO 8601 with server offset
  reply: string;        // Ответ пользователю
}

/**
 * Извлекает задачу и время из текста.
 *
 * Стратегия: regex-first, AI-fallback
 * 1. Regex парсит ~90% случаев (мгновенно, 100% надёжно)
 * 2. AI-fallback с passthrough mode + max_tokens=256 для экономии
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

  // Серверная TZ
  const localTime = toLocalISO(now);
  const offsetString = getTimeZoneOffsetString(now, SERVER_TZ);
  const localReadable = now.toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SERVER_TZ,
  });

  const systemPrompt = `Ты — парсер напоминаний. Извлеки из текста:
1. task — что напомнить (кратко)
2. scheduled_at — когда (ISO 8601)
3. reply — подтверждение пользователю

Сейчас: ${localReadable} (${localTime})

Правила:
- утро=09:00, вечер=19:00, обед=13:00
- "в понедельник" = ближайший (если сегодня — следующий)
- Часовой пояс: ${offsetString}
- reply: кратко, с временем

JSON (без markdown):
{"task":"...","scheduled_at":"YYYY-MM-DDTHH:MM:SS${offsetString}","reply":"..."}

Если невозможно:
{"task":null,"scheduled_at":null,"reply":null}`;

  for (let attempt = 1; attempt <= MAX_AI_RETRIES; attempt++) {
    try {
      const response = await aiService.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        'telegram',
        undefined,
        { promptMode: 'passthrough', maxTokens: 256 },
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
        return null;
      }

      // Валидация даты
      const scheduledDate = new Date(parsed.scheduled_at);
      if (isNaN(scheduledDate.getTime())) {
        aiLogger.warn({ scheduled_at: parsed.scheduled_at, attempt }, 'Invalid date from AI');
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

      aiLogger.error({ error, text }, 'All AI attempts failed for reminder extraction');
      throw error;
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
