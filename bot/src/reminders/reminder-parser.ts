/**
 * Reminder Parser
 * 
 * 1. Regex-детекция намерения создать напоминание
 * 2. AI-извлечение задачи и времени из естественного языка
 */

import { aiService } from '../ai/openrouter.js';
import { aiLogger } from '../config/logger.js';

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
// AI Extraction
// --------------------------------------------

export interface ExtractedReminder {
  task: string;
  scheduled_at: string; // ISO 8601 with +03:00
  reply: string;        // Ответ пользователю
}

/**
 * Извлекает задачу и время из текста с помощью AI.
 * Возвращает null если AI не смог распарсить.
 */
export async function extractReminder(
  text: string,
  now: Date
): Promise<ExtractedReminder | null> {
  // Московское время
  const moscowTime = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', 'T') + '+03:00';
  const moscowReadable = now.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
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
      aiLogger.info({ text }, 'AI could not parse reminder from text');
      return null;
    }

    // Валидация даты
    const scheduledDate = new Date(parsed.scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
      aiLogger.warn({ scheduled_at: parsed.scheduled_at }, 'Invalid date from AI');
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
      { task: parsed.task, scheduled_at: parsed.scheduled_at },
      'Reminder extracted from text'
    );

    return {
      task: parsed.task,
      scheduled_at: parsed.scheduled_at,
      reply: parsed.reply,
    };
  } catch (error) {
    aiLogger.error({ error, text }, 'Failed to extract reminder');
    return null;
  }
}
