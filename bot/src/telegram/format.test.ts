/**
 * Tests for Telegram Format Utilities
 * 
 * Покрытие:
 * - looksLikeSearchSimulation: все паттерны симуляции
 * - looksLikeSearchRefusal: паттерны отказа
 * - markdownToTelegramHtml: MD→HTML конвертация
 * - splitIntoChunks: разбивка длинных сообщений
 * - escapeMarkdown / escapeHtml: экранирование
 * - buildTimeContext: контекст времени
 * - inlineCitations: замена [N] на ссылки
 */

import { describe, it, expect, vi } from 'vitest';
import { InlineKeyboard } from 'grammy';

import {
  looksLikeSearchSimulation,
  looksLikeSearchRefusal,
  markdownToTelegramHtml,
  splitIntoChunks,
  escapeMarkdown,
  escapeHtml,
  stripMarkdown,
  stripHtml,
  inlineCitations,
  buildTimeContext,
  sendLongMessage,
} from './format.js';

// ============================================
// looksLikeSearchSimulation
// ============================================

describe('looksLikeSearchSimulation', () => {
  // === Должен обнаружить ===
  it('should detect emoji + "ищу"', () => {
    expect(looksLikeSearchSimulation('🔍 Ищу информацию...')).toBe(true);
  });

  it('should detect "поиск в интернете"', () => {
    expect(looksLikeSearchSimulation('*(Поиск в интернете)*')).toBe(true);
    expect(looksLikeSearchSimulation('*Поиск в интернете*')).toBe(true);
  });

  it('should detect "сейчас найду/поищу"', () => {
    expect(looksLikeSearchSimulation('Сейчас найду для вас!')).toBe(true);
    expect(looksLikeSearchSimulation('Сейчас поищу эту информацию')).toBe(true);
  });

  it('should detect "ищу..." with ellipsis', () => {
    expect(looksLikeSearchSimulation('Ищу...')).toBe(true);
    expect(looksLikeSearchSimulation('Ищу…')).toBe(true); // Unicode ellipsis
  });

  it('should detect "выполняю/производится поиск"', () => {
    expect(looksLikeSearchSimulation('Выполняю поиск по вашему запросу')).toBe(true);
    expect(looksLikeSearchSimulation('Производится поиск...')).toBe(true);
  });

  it('should detect "подожди + ищу"', () => {
    expect(looksLikeSearchSimulation('Подожди, ищу информацию...')).toBe(true);
    expect(looksLikeSearchSimulation('Подожди минутку, поиск...')).toBe(true);
  });

  it('should detect "давай поищу"', () => {
    expect(looksLikeSearchSimulation('Давай я поищу для тебя!')).toBe(true);
    expect(looksLikeSearchSimulation('Давайте поищу информацию')).toBe(true);
  });

  it('should detect "сейчас проверю/посмотрю"', () => {
    expect(looksLikeSearchSimulation('Сейчас проверю данные...')).toBe(true);
    expect(looksLikeSearchSimulation('Сейчас я посмотрю...')).toBe(true);
  });

  it('should detect markdown-formatted simulation', () => {
    expect(looksLikeSearchSimulation('* Поиск актуальных данных *')).toBe(true);
    expect(looksLikeSearchSimulation('* Ищу в интернете *')).toBe(true);
  });

  it('should detect English simulation patterns', () => {
    expect(looksLikeSearchSimulation('Let me search for that...')).toBe(true);
    expect(looksLikeSearchSimulation('Searching for information...')).toBe(true);
    expect(looksLikeSearchSimulation('Looking up the latest data')).toBe(true);
  });

  it('should detect "загружаю данные"', () => {
    expect(looksLikeSearchSimulation('Загружаю данные из интернета...')).toBe(true);
  });

  it('should detect combined patterns (≥2 matches)', () => {
    const text = 'Ищу информацию о курсе доллара. Выполняю поиск в интернете. Подождите, данные загружаются.';
    expect(looksLikeSearchSimulation(text)).toBe(true);
  });

  // === НЕ должен ложно срабатывать ===
  it('should NOT flag normal responses mentioning search', () => {
    // Длинный нормальный ответ где слово "ищу" в другом контексте
    expect(looksLikeSearchSimulation(
      'Поисковые системы вроде Google работают так: когда вы вводите запрос, система ищет совпадения в индексе. ' +
      'Это огромная база данных, которая содержит миллиарды веб-страниц. Результаты ранжируются по релевантности ' +
      'с учётом множества факторов: ключевые слова, авторитетность сайта, свежесть контента и поведение пользователей.'
    )).toBe(false);
  });

  it('should NOT flag factual answers', () => {
    expect(looksLikeSearchSimulation(
      'Курс доллара к рублю на 9 февраля 2026 года составляет 92,45 рублей по данным ЦБ РФ.'
    )).toBe(false);
  });

  it('should NOT flag code examples', () => {
    expect(looksLikeSearchSimulation(
      'Вот пример функции поиска:\n```\nfunction search(arr, target) {\n  return arr.find(x => x === target);\n}\n```'
    )).toBe(false);
  });

  it('should NOT flag creative responses', () => {
    expect(looksLikeSearchSimulation(
      'Жил-был программист, который искал баг в коде. Он проверял строку за строкой...'
    )).toBe(false);
  });
});

// ============================================
// looksLikeSearchRefusal
// ============================================

describe('looksLikeSearchRefusal', () => {
  it('should detect "не могу выполнить поиск"', () => {
    expect(looksLikeSearchRefusal('К сожалению, я не могу выполнить поиск в интернете.')).toBe(true);
  });

  it('should detect "нет доступа к интернету"', () => {
    expect(looksLikeSearchRefusal('У меня нет доступа к интернету для поиска.')).toBe(true);
  });

  it('should detect "не умею искать"', () => {
    expect(looksLikeSearchRefusal('Я не умею искать в интернете, но могу рассказать что знаю.')).toBe(true);
  });

  it('should detect English refusal', () => {
    expect(looksLikeSearchRefusal("I cannot search the internet for current data")).toBe(true);
    expect(looksLikeSearchRefusal("I don't have access to the internet")).toBe(true);
  });

  it('should NOT flag normal responses', () => {
    expect(looksLikeSearchRefusal('Вот информация о Python...')).toBe(false);
    expect(looksLikeSearchRefusal('Привет! Чем могу помочь?')).toBe(false);
  });
});

// ============================================
// markdownToTelegramHtml
// ============================================

describe('markdownToTelegramHtml', () => {
  it('should convert **bold** to <b>', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>');
  });

  it('should convert *italic* to <i>', () => {
    expect(markdownToTelegramHtml('*hello*')).toBe('<i>hello</i>');
  });

  it('should convert `code` to <code>', () => {
    expect(markdownToTelegramHtml('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('should convert code blocks to <pre>', () => {
    expect(markdownToTelegramHtml('```js\nconsole.log("hi")\n```')).toContain('<pre>');
  });

  it('should convert [text](url) to <a>', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe('<a href="https://example.com">click</a>');
  });

  it('should preserve digest links with markdown-like CJK titles', () => {
    const markdown = '**417. [### Korean Translation 구현할까요? 아니요 ... `text - 새로운 코드만`](https://example.com/417)**';
    const html = markdownToTelegramHtml(markdown);

    expect(html).toContain('<b>417. <a href="https://example.com/417">### Korean Translation 구현할까요? 아니요 ... `text - 새로운 코드만`</a></b>');
    expect(html).not.toContain('<code>');
  });

  it('should support nested brackets inside link labels', () => {
    const markdown = '[[단독] page-agent - 코드 1줄로 웹페이지에 AI 에이전트 추가하기](https://example.com/page-agent)';
    const html = markdownToTelegramHtml(markdown);

    expect(html).toBe('<a href="https://example.com/page-agent">[단독] page-agent - 코드 1줄로 웹페이지에 AI 에이전트 추가하기</a>');
  });

  it('should escape HTML entities', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toContain('&lt;');
    expect(markdownToTelegramHtml('a < b & c > d')).toContain('&amp;');
    expect(markdownToTelegramHtml('a < b & c > d')).toContain('&gt;');
  });

  it('should convert ~~strikethrough~~ to <s>', () => {
    expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
  });
});

// ============================================
// splitIntoChunks
// ============================================

describe('splitIntoChunks', () => {
  it('should not split short messages', () => {
    const chunks = splitIntoChunks('Short message');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short message');
  });

  it('should split messages exceeding 4096 chars by paragraphs', () => {
    // Реалистичный текст с параграфами (каждый ~100 символов)
    const paragraphs = Array(80).fill('Это длинный абзац текста с информацией. Он содержит несколько предложений для реалистичности тестирования.');
    const longText = paragraphs.join('\n\n');
    const chunks = splitIntoChunks(longText);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be ≤ 4096
    chunks.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    });
  });

  it('should split by sentence boundaries within long paragraphs', () => {
    // Один длинный параграф с предложениями
    const sentences = Array(200).fill('Предложение с фактами. ');
    const longText = sentences.join('');
    const chunks = splitIntoChunks(longText);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    });
  });

  it('should handle single very long paragraph', () => {
    const text = 'Word. '.repeat(1000); // ~6000 chars
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should preserve complete HTML links when splitting many linked paragraphs', () => {
    const paragraph = '<b>1. <a href="https://example.com/news/1">AI headline</a></b>\nИсточник: Source · Категория: AI/Tech\nОписание: Структурированная новость.';
    const html = Array.from({ length: 120 }, () => paragraph).join('\n\n');

    const chunks = splitIntoChunks(html);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => {
      const openingLinks = (chunk.match(/<a href=/g) ?? []).length;
      const closingLinks = (chunk.match(/<\/a>/g) ?? []).length;
      expect(openingLinks).toBe(closingLinks);
    });
  });
});

describe('sendLongMessage', () => {
  it('should replace save_to_notes with save_to_notes_full for multi-chunk replies', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = { reply } as unknown as Parameters<typeof sendLongMessage>[0];
    const longText = Array.from(
      { length: 140 },
      (_, index) => `Абзац ${index + 1}: ` + 'контекст '.repeat(30),
    ).join('\n\n');
    const keyboard = new InlineKeyboard()
      .text('📌 В заметки', 'save_to_notes')
      .text('🔊 Озвучить', 'read_aloud');

    await sendLongMessage(ctx, longText, keyboard);

    const lastCall = reply.mock.calls.at(-1);
    const options = lastCall?.[1] as {
      reply_markup?: {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      };
    };
    const callbackData = (options.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);

    expect(callbackData.some((value) => value?.startsWith('save_to_notes_full:'))).toBe(true);
    expect(callbackData.some((value) => value?.startsWith('read_aloud_full:'))).toBe(true);
  });
});

// ============================================
// escapeMarkdown / escapeHtml
// ============================================

describe('escapeMarkdown', () => {
  it('should escape Markdown special characters', () => {
    expect(escapeMarkdown('*bold* and _italic_')).toBe('\\*bold\\* and \\_italic\\_');
  });

  it('should escape brackets', () => {
    expect(escapeMarkdown('[link](url)')).toContain('\\[');
  });

  it('should escape reminder task with Telegram markdown symbols', () => {
    expect(escapeMarkdown('Оплатить _счёт_ [сегодня] (важно)!'))
      .toBe('Оплатить \\_счёт\\_ \\[сегодня\\] \\(важно\\)\\!');
  });
});

describe('escapeHtml', () => {
  it('should escape & < >', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

// ============================================
// stripMarkdown / stripHtml
// ============================================

describe('stripMarkdown', () => {
  it('should remove bold/italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  it('should remove code blocks', () => {
    expect(stripMarkdown('```js\ncode\n```')).toContain('code');
    expect(stripMarkdown('```js\ncode\n```')).not.toContain('```');
  });

  it('should convert links to text + url', () => {
    expect(stripMarkdown('[click](https://example.com)')).toBe('click (https://example.com)');
  });

  it('should keep url when markdown link label has nested brackets', () => {
    expect(stripMarkdown('**[[단독] page-agent](https://example.com/page-agent)**'))
      .toBe('[단독] page-agent (https://example.com/page-agent)');
  });
});

describe('stripHtml', () => {
  it('should remove HTML tags', () => {
    expect(stripHtml('<b>bold</b> text')).toBe('bold text');
  });

  it('should decode HTML entities', () => {
    expect(stripHtml('a &amp; b &lt; c')).toBe('a & b < c');
  });

  it('should preserve href when stripping html links', () => {
    expect(stripHtml('<b>1. <a href="https://example.com/news">AI headline</a></b>'))
      .toBe('1. AI headline (https://example.com/news)');
  });
});

// ============================================
// inlineCitations
// ============================================

describe('inlineCitations', () => {
  it('should replace [N] with markdown links', () => {
    const text = 'Факт из источника[1] и другой факт[2].';
    const citations = ['https://a.com', 'https://b.com'];
    const result = inlineCitations(text, citations);
    expect(result).toContain('[1](https://a.com)');
    expect(result).toContain('[2](https://b.com)');
  });

  it('should leave [N] as-is when out of range', () => {
    const text = 'Факт[5].';
    const citations = ['https://a.com'];
    const result = inlineCitations(text, citations);
    expect(result).toBe('Факт[5].');
  });

  it('should remove "📚 Источники:" section', () => {
    const text = 'Факт[1].\n\n📚 Источники:\n1. https://a.com';
    const citations = ['https://a.com'];
    const result = inlineCitations(text, citations);
    expect(result).not.toContain('📚 Источники:');
  });

  it('should handle empty citations', () => {
    expect(inlineCitations('text', [])).toBe('text');
    expect(inlineCitations('text', undefined as unknown as string[])).toBe('text');
  });
});

// ============================================
// buildTimeContext
// ============================================

describe('buildTimeContext', () => {
  it('should include date and time', () => {
    const ctx = buildTimeContext('Дмитрий');
    expect(ctx).toContain('Контекст:');
    expect(ctx).toContain('TZ');
    expect(ctx).toContain('Дмитрий');
  });

  it('should work without name', () => {
    const ctx = buildTimeContext();
    expect(ctx).toContain('Контекст:');
    expect(ctx).not.toContain('undefined');
  });

  it('should include day of week', () => {
    const ctx = buildTimeContext();
    // Should contain one of the Russian weekday names
    const weekdays = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
    expect(weekdays.some(day => ctx.includes(day))).toBe(true);
  });
});
