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

// --------------------------------------------
// Intent Detection (regex, без AI-вызова)
// --------------------------------------------

const REMINDER_PATTERNS = [
  /напомни/i,
  /напоминани/i,
  /напомнить/i,
  /remind/i,
  /не забыть/i,
  /не забудь/i,
  /поставь.{0,20}напомин/i,
  /создай.{0,20}напомин/i,
  /через\s+\d+\s*(минут|час|дн|недел)/i,
  /завтра\s+в\s+\d/i,
  /послезавтра\s+в\s+\d/i,
  /в\s+\d{1,2}[:.]\d{2}\s+(сделать|купить|позвонить|написать|проверить|отправить|забрать|встретить|оплатить)/i,
];

/**
 * Быстрая проверка: похоже ли сообщение на запрос напоминания?
 * Без вызова AI, чистый regex.
 */
export function detectReminderIntent(text: string): boolean {
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
  if (task.length < 3) {
    task = text.replace(/^(напомни|напомнить)\s*(мне|нам)?\s*/i, '').trim();
  }

  // Первая буква заглавная
  return task.charAt(0).toUpperCase() + task.slice(1);
}

/**
 * Форматировать время для пользователя.
 * TZ=Europe/Moscow → toLocaleString уже в московском времени.
 */
function formatMoscowTime(date: Date): string {
  return date.toLocaleString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Форматировать ISO 8601 с московским часовым поясом (+03:00).
 * TZ=Europe/Moscow → toLocaleString('sv-SE') отдаёт YYYY-MM-DD HH:mm:ss.
 */
function toMoscowISO(date: Date): string {
  const moscowStr = date.toLocaleString('sv-SE');
  return moscowStr.replace(' ', 'T') + '+03:00';
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
    const n = parseInt(minuteMatch[1], 10);
    if (n >= 1 && n <= 1440) { // от 1 мин до 24 часов
      return { offsetMs: n * MINUTE_MS, label: `через ${n} мин.` };
    }
  }

  // "через N час(ов/а)"
  const hourMatch = text.match(/через\s+(\d+)\s*(час\w*)/i);
  if (hourMatch) {
    const n = parseInt(hourMatch[1], 10);
    if (n >= 1 && n <= 72) {
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
  const timeStr = formatMoscowTime(scheduledDate);

  aiLogger.info(
    { task, offset: timeMatch.label, scheduledAt: toMoscowISO(scheduledDate) },
    'Reminder parsed by regex (no AI needed)'
  );

  return {
    task,
    scheduled_at: toMoscowISO(scheduledDate),
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

  // TZ=Europe/Moscow → toLocaleString уже в московском времени
  const moscowTime = now.toLocaleString('sv-SE').replace(' ', 'T') + '+03:00';
  const moscowReadable = now.toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const systemPrompt = `Ты — парсер напоминаний. Твоя задача — извлечь из текста пользователя:
1. task — что нужно напомнить (кратко, 1-2 предложения)
2. scheduled_at — когда напомнить (ISO 8601, часовой пояс +03:00 Москва)
3. reply — дружелюбный ответ пользователю с подтверждением

Текущее время (Москва): ${moscowReadable}
ISO: ${moscowTime}

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

      // Максимум 1 год вперёд
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      if (scheduledDate.getTime() > now.getTime() + oneYearMs) {
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
