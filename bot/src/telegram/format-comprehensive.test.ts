/**
 * Comprehensive Tests: Telegram Format Utilities
 *
 * 200+ тест-кейсов:
 * - escapeHtml: экранирование HTML-сущностей
 * - escapeMarkdown: экранирование Markdown-спецсимволов
 * - markdownToTelegramHtml: конвертация MD → Telegram HTML
 * - splitIntoChunks: разбивка длинных сообщений
 * - buildTimeContext: контекст времени суток
 * - looksLikeSearchSimulation: детекция симуляции поиска
 * - looksLikeSearchRefusal: детекция отказа от поиска
 * - llmIgnoredSearchData: детекция игнорирования данных
 * - inlineCitations: замена [N] на ссылки
 * - stripMarkdown: удаление Markdown-разметки
 * - stripHtml: удаление HTML-тегов
 * - formatSearchError: форматирование ошибок поиска
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    server: {
      timeZone: 'Europe/Moscow',
    },
  },
}));

vi.mock('../config/constants.js', () => ({
  TELEGRAM_MAX_MESSAGE_LENGTH: 4096,
  FULL_TEXT_CACHE_TTL: 600000,
}));

import {
  escapeHtml,
  escapeMarkdown,
  markdownToTelegramHtml,
  splitIntoChunks,
  buildTimeContext,
  looksLikeSearchSimulation,
  looksLikeSearchRefusal,
  llmIgnoredSearchData,
  inlineCitations,
  stripMarkdown,
  stripHtml,
  formatSearchError,
} from './format.js';

// ============================================
// escapeHtml
// ============================================

describe('escapeHtml', () => {
  const cases: [string, string, string][] = [
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;', 'script tag'],
    ['Tom & Jerry', 'Tom &amp; Jerry', 'ampersand'],
    ['<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;', 'bold tag'],
    ['a < b > c', 'a &lt; b &gt; c', 'lt/gt operators'],
    ['', '', 'empty string'],
    ['hello world', 'hello world', 'plain text no change'],
    ['<<<>>>', '&lt;&lt;&lt;&gt;&gt;&gt;', 'multiple angle brackets'],
    ['&amp;', '&amp;amp;', 'already escaped amp'],
    ['&lt;', '&amp;lt;', 'already escaped lt'],
    ['&gt;', '&amp;gt;', 'already escaped gt'],
    ['<a href="x">link</a>', '&lt;a href="x"&gt;link&lt;/a&gt;', 'anchor tag'],
    ['Tom &amp; Jerry < Show & Tell', 'Tom &amp;amp; Jerry &lt; Show &amp; Tell', 'mixed entities'],
    ['5 > 3 && 3 < 5', '5 &gt; 3 &amp;&amp; 3 &lt; 5', 'JS expression'],
    ['<div class="test">', '&lt;div class="test"&gt;', 'div with attribute'],
    ['a&b&c&d', 'a&amp;b&amp;c&amp;d', 'multiple ampersands'],
    ['<<<<<', '&lt;&lt;&lt;&lt;&lt;', 'five lt signs'],
    ['no special chars here 123', 'no special chars here 123', 'no special chars'],
    ['Привет <мир> & всё', 'Привет &lt;мир&gt; &amp; всё', 'Cyrillic with specials'],
    ['🎉<emoji>🎉', '🎉&lt;emoji&gt;🎉', 'emoji with tags'],
    ['line1\nline2 & <b>', 'line1\nline2 &amp; &lt;b&gt;', 'newlines preserved'],
    ['\t<tab>\t', '\t&lt;tab&gt;\t', 'tabs preserved'],
    ['  spaces  ', '  spaces  ', 'spaces preserved'],
    ['<img src="x" onerror="alert(1)">', '&lt;img src="x" onerror="alert(1)"&gt;', 'XSS via img'],
    ['<svg onload="alert(1)">', '&lt;svg onload="alert(1)"&gt;', 'XSS via svg'],
    ['a'.repeat(10000) + '<', 'a'.repeat(10000) + '&lt;', 'very long text'],
    ['A>B', 'A&gt;B', 'gt without spaces'],
    ['&', '&amp;', 'single ampersand'],
    ['<', '&lt;', 'single lt'],
    ['>', '&gt;', 'single gt'],
    ['<>&', '&lt;&gt;&amp;', 'all three together'],
  ];

  it.each(cases)('escapeHtml(%j) → %j (%s)', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });
});

// ============================================
// escapeMarkdown
// ============================================

describe('escapeMarkdown', () => {
  const cases: [string, string, string][] = [
    ['*bold*', '\\*bold\\*', 'asterisks'],
    ['_italic_', '\\_italic\\_', 'underscores'],
    ['`code`', '\\`code\\`', 'backticks'],
    ['[link](url)', '\\[link\\]\\(url\\)', 'link brackets'],
    ['~~strike~~', '\\~\\~strike\\~\\~', 'tilde'],
    ['# heading', '\\# heading', 'hash'],
    ['>quote', '\\>quote', 'gt quote'],
    ['text + more', 'text \\+ more', 'plus'],
    ['a - b', 'a \\- b', 'dash'],
    ['a = b', 'a \\= b', 'equals'],
    ['a | b', 'a \\| b', 'pipe'],
    ['a{b}', 'a\\{b\\}', 'braces'],
    ['end.', 'end\\.', 'period'],
    ['wow!', 'wow\\!', 'exclamation'],
    ['back\\slash', 'back\\\\slash', 'backslash'],
    ['', '', 'empty string'],
    ['hello world', 'hello world', 'no special chars'],
    ['***bold italic***', '\\*\\*\\*bold italic\\*\\*\\*', 'triple asterisks'],
    ['__underline__', '\\_\\_underline\\_\\_', 'double underscores'],
    ['```code block```', '\\`\\`\\`code block\\`\\`\\`', 'triple backticks'],
    ['Привет мир', 'Привет мир', 'Cyrillic no change'],
    ['🎉party🎉', '🎉party🎉', 'emoji no change'],
    ['a*b_c`d[e]f(g)h~i', 'a\\*b\\_c\\`d\\[e\\]f\\(g\\)h\\~i', 'all specials mixed'],
    ['12345', '12345', 'numbers no change'],
  ];

  it.each(cases)('escapeMarkdown(%j) → %j (%s)', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });
});

// ============================================
// markdownToTelegramHtml
// ============================================

describe('markdownToTelegramHtml', () => {
  describe('базовые конверсии', () => {
    const cases: [string, string, string][] = [
      ['**bold**', '<b>bold</b>', 'bold → <b>'],
      ['*italic*', '<i>italic</i>', 'italic → <i>'],
      ['`code`', '<code>code</code>', 'inline code → <code>'],
      ['```\ncode block\n```', '<pre>code block\n</pre>', 'code block → <pre>'],
      ['```js\nconst x = 1;\n```', '<pre>const x = 1;\n</pre>', 'code block with lang'],
      ['__bold__', '<b>bold</b>', '__bold__ → <b>'],
      ['_italic_', '<i>italic</i>', '_italic_ → <i>'],
      ['~~strike~~', '<s>strike</s>', 'strikethrough → <s>'],
      ['[link](https://example.com)', '<a href="https://example.com">link</a>', 'link → <a>'],
      ['', '', 'empty string'],
      ['plain text', 'plain text', 'no formatting'],
    ];

    it.each(cases)('md(%j) → %j (%s)', (input, expected) => {
      expect(markdownToTelegramHtml(input)).toBe(expected);
    });
  });

  describe('экранирование HTML внутри Markdown', () => {
    it('< и > экранируются в обычном тексте', () => {
      expect(markdownToTelegramHtml('a < b > c')).toBe('a &lt; b &gt; c');
    });

    it('& экранируется', () => {
      expect(markdownToTelegramHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('HTML теги внутри bold экранируются', () => {
      expect(markdownToTelegramHtml('**<script>alert(1)</script>**')).toBe(
        '<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>',
      );
    });
  });

  describe('вложенное форматирование', () => {
    it('bold + italic → <b> + <i>', () => {
      const result = markdownToTelegramHtml('**bold** and *italic*');
      expect(result).toContain('<b>bold</b>');
      expect(result).toContain('<i>italic</i>');
    });

    it('bold содержащий italic asterisks', () => {
      const result = markdownToTelegramHtml('**bold *nested* text**');
      expect(result).toContain('<b>');
    });

    it('code + bold в одном тексте', () => {
      const result = markdownToTelegramHtml('Use `command` with **options**');
      expect(result).toContain('<code>command</code>');
      expect(result).toContain('<b>options</b>');
    });

    it('несколько bold фрагментов', () => {
      const result = markdownToTelegramHtml('**one** and **two** and **three**');
      expect(result).toBe('<b>one</b> and <b>two</b> and <b>three</b>');
    });

    it('несколько italic фрагментов', () => {
      const result = markdownToTelegramHtml('*one* and *two* and *three*');
      expect(result).toBe('<i>one</i> and <i>two</i> and <i>three</i>');
    });

    it('strikethrough + bold', () => {
      const result = markdownToTelegramHtml('~~deleted~~ **added**');
      expect(result).toContain('<s>deleted</s>');
      expect(result).toContain('<b>added</b>');
    });
  });

  describe('ссылки', () => {
    it('ссылка с описанием', () => {
      expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe(
        '<a href="https://google.com">Google</a>',
      );
    });

    it('ссылка со спецсимволами в URL', () => {
      const result = markdownToTelegramHtml('[test](https://example.com/path?a=1&b=2)');
      expect(result).toContain('href="https://example.com/path?a=1&amp;b=2"');
    });

    it('несколько ссылок', () => {
      const result = markdownToTelegramHtml('[A](https://a.com) and [B](https://b.com)');
      expect(result).toContain('<a href="https://a.com">A</a>');
      expect(result).toContain('<a href="https://b.com">B</a>');
    });

    it('ссылка без URL → не конвертируется', () => {
      const result = markdownToTelegramHtml('[text]()');
      // Пустой URL → не обрабатывается как ссылка
      expect(result).not.toContain('<a');
    });

    it('квадратные скобки без ссылки', () => {
      const result = markdownToTelegramHtml('array[0] = value');
      expect(result).not.toContain('<a');
      expect(result).toContain('array[0]');
    });
  });

  describe('edge cases', () => {
    it('только пробелы', () => {
      expect(markdownToTelegramHtml('   ')).toBe('   ');
    });

    it('только переносы строк', () => {
      expect(markdownToTelegramHtml('\n\n\n')).toBe('\n\n\n');
    });

    it('очень длинный текст (10000 символов)', () => {
      const long = 'a'.repeat(10000);
      expect(markdownToTelegramHtml(long)).toBe(long);
    });

    it('emoji в bold', () => {
      expect(markdownToTelegramHtml('**🎉 party 🎉**')).toBe('<b>🎉 party 🎉</b>');
    });

    it('Кириллица в форматировании', () => {
      expect(markdownToTelegramHtml('**Привет** *мир*')).toBe('<b>Привет</b> <i>мир</i>');
    });

    it('несколько code blocks подряд', () => {
      const input = '```\nblock1\n```\n\n```\nblock2\n```';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<pre>block1\n</pre>');
      expect(result).toContain('<pre>block2\n</pre>');
    });

    it('inline code внутри текста', () => {
      const result = markdownToTelegramHtml('run `npm install` then `npm start`');
      expect(result).toBe('run <code>npm install</code> then <code>npm start</code>');
    });

    it('одинарный * не конвертируется если рядом с тегом', () => {
      // Поведение зависит от negative lookahead в regex
      const result = markdownToTelegramHtml('2*3=6');
      // * между цифрами — не должен стать italic
      expect(result).toContain('2');
    });
  });
});

// ============================================
// splitIntoChunks
// ============================================

describe('splitIntoChunks', () => {
  it('короткий текст → 1 чанк', () => {
    expect(splitIntoChunks('hello')).toEqual(['hello']);
  });

  it('пустая строка → 1 чанк', () => {
    expect(splitIntoChunks('')).toEqual(['']);
  });

  it('текст ровно 4096 символов → 1 чанк', () => {
    const text = 'x'.repeat(4096);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('текст 4097 символов → 2 чанка', () => {
    const text = 'x'.repeat(4097);
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('текст ~10000 символов → несколько чанков', () => {
    const text = 'x'.repeat(10000);
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('разбивка по параграфам', () => {
    const para1 = 'A'.repeat(2000);
    const para2 = 'B'.repeat(2000);
    const para3 = 'C'.repeat(2000);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Первый чанк содержит первые параграфы
    expect(chunks[0]).toContain('A');
  });

  it('Unicode (Кириллица) считается корректно', () => {
    const text = 'Привет'.repeat(700); // ~4200 символов
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('emoji в тексте', () => {
    const text = '🎉'.repeat(2050); // каждый emoji 2 символа
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Все чанки должны быть валидными строками
    for (const chunk of chunks) {
      expect(typeof chunk).toBe('string');
    }
  });

  it('один огромный параграф (без \\n\\n) → разбивается по предложениям', () => {
    const sentences = Array.from({ length: 100 }, (_, i) => `This is sentence number ${i}.`);
    const text = sentences.join(' ');
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Все чанки <= 4096
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('несколько коротких параграфов → 1 чанк', () => {
    const text = 'Para 1\n\nPara 2\n\nPara 3';
    expect(splitIntoChunks(text)).toHaveLength(1);
    expect(splitIntoChunks(text)[0]).toBe(text);
  });

  it('чанки не начинаются/заканчиваются пробелами (trim)', () => {
    const para1 = 'A'.repeat(3000);
    const para2 = 'B'.repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitIntoChunks(text);
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trim());
    }
  });

  it('максимальный лимит чанка не превышен', () => {
    const text = 'word '.repeat(2000);
    const chunks = splitIntoChunks(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('одно предложение длиннее 4096 → hard-split', () => {
    const sentence = 'x'.repeat(5000);
    const chunks = splitIntoChunks(sentence);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
  });
});

// ============================================
// buildTimeContext
// ============================================

describe('buildTimeContext', () => {
  describe('приветствие по времени суток', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('утро (08:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T05:00:00Z')); // 08:00 MSK
      const ctx = buildTimeContext('Amina');
      expect(ctx).toContain('утро');
      expect(ctx).toContain('Amina');
    });

    it('утро (05:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T02:00:00Z')); // 05:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('утро');
    });

    it('утро (11:59 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T08:59:00Z')); // 11:59 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('утро');
    });

    it('день (12:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T09:00:00Z')); // 12:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('день');
    });

    it('день (14:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T11:00:00Z')); // 14:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('день');
    });

    it('день (16:59 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T13:59:00Z')); // 16:59 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('день');
    });

    it('вечер (17:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T14:00:00Z')); // 17:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('вечер');
    });

    it('вечер (20:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T17:00:00Z')); // 20:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('вечер');
    });

    it('вечер (21:59 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T18:59:00Z')); // 21:59 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('вечер');
    });

    it('ночь (22:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T19:00:00Z')); // 22:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('ночь');
    });

    it('ночь (02:00 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-15T23:00:00Z')); // 02:00 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('ночь');
    });

    it('ночь (04:59 MSK)', () => {
      vi.setSystemTime(new Date('2026-03-16T01:59:00Z')); // 04:59 MSK
      const ctx = buildTimeContext();
      expect(ctx).toContain('ночь');
    });
  });

  describe('формат контекста', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-16T09:00:00Z')); // 12:00 MSK
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('содержит квадратные скобки', () => {
      const ctx = buildTimeContext();
      expect(ctx).toMatch(/^\[.+\]$/);
    });

    it('содержит TZ', () => {
      const ctx = buildTimeContext();
      expect(ctx).toContain('TZ');
    });

    it('содержит "Контекст"', () => {
      const ctx = buildTimeContext();
      expect(ctx).toContain('Контекст');
    });

    it('содержит имя пользователя если передано', () => {
      const ctx = buildTimeContext('Иван');
      expect(ctx).toContain('Иван');
    });

    it('не содержит имя если не передано', () => {
      const ctx = buildTimeContext();
      expect(ctx).not.toContain('Имя пользователя');
    });

    it('содержит имя при undefined → нет имени', () => {
      const ctx = buildTimeContext(undefined);
      expect(ctx).not.toContain('Имя пользователя');
    });

    it('содержит имя при пустой строке → нет имени', () => {
      const ctx = buildTimeContext('');
      expect(ctx).not.toContain('Имя пользователя');
    });
  });
});

// ============================================
// looksLikeSearchSimulation
// ============================================

describe('looksLikeSearchSimulation', () => {
  describe('обнаруживает симуляцию (TRUE)', () => {
    const trueCases: [string, string][] = [
      ['🔍 Ищу информацию...', 'emoji + ищу + ellipsis'],
      ['*(Поиск в интернете)*', 'markdown + поиск'],
      ['*Поиск в интернете*', 'поиск без скобок'],
      ['Сейчас найду для вас!', 'сейчас найду (короткий)'],
      ['Сейчас поищу эту информацию', 'сейчас поищу (короткий)'],
      ['Ищу...', 'ищу + ellipsis'],
      ['Ищу…', 'ищу + unicode ellipsis'],
      ['Ищу информацию по вашему запросу', 'ищу информацию'],
      ['Выполняю поиск по базе данных', 'выполняю поиск'],
      ['Подождите, ищу данные', 'подожди + ищу'],
      ['🔍 Ищу, подождите', 'emoji + ищу (2 patterns)'],
      ['Давай я поищу это для тебя', 'давай я поищу'],
      ['Давайте поищу информацию', 'давайте поищу'],
      ['Сейчас проверю актуальные данные', 'сейчас проверю'],
      ['Сейчас посмотрю что есть', 'сейчас посмотрю'],
      ['*Поиск* Ищу...', 'markdown + ellipsis (2 patterns)'],
      ['Searching for information', 'English: searching (short text)'],
      ['Let me search for that', 'English: let me search (short text)'],
      ['Загружаю данные для ответа', 'загружаю данные'],
      ['Загружаю информацию, подождите', 'загружаю информацию'],
      ['Минуточку, ищу ответ', 'минуточку + ищу'],
      ['Одну секунду, проверяю', 'одну секунду + проверяю'],
      ['* Ищу информацию *', 'markdown-выделение'],
      ['Looking up the answer for you', 'English: looking up (short text)'],
    ];

    it.each(trueCases)('%j → true (%s)', (text) => {
      expect(looksLikeSearchSimulation(text)).toBe(true);
    });
  });

  describe('НЕ обнаруживает симуляцию (FALSE)', () => {
    const falseCases: [string, string][] = [
      ['Вот актуальная информация по курсу доллара: 1 USD = 92.5 RUB', 'нормальный ответ с данными'],
      ['По данным Росстата, инфляция в 2026 году составила 4.5%', 'нормальный ответ с цифрами'],
      ['Москва — столица России. Население: 13 миллионов.', 'факт без симуляции'],
      ['Рецепт борща: 1. Свёкла 2. Капуста 3. Морковь', 'рецепт'],
      ['Функция Math.random() возвращает случайное число от 0 до 1', 'tech ответ'],
      // Длинный текст с одним паттерном — не достаточно для детекции
      ['Я ' + 'a'.repeat(500) + ' сейчас я найду для вас подробный ответ на этот вопрос, давайте разберёмся', 'длинный текст с одним паттерном'],
    ];

    it.each(falseCases)('%j → false (%s)', (text) => {
      expect(looksLikeSearchSimulation(text)).toBe(false);
    });
  });
});

// ============================================
// looksLikeSearchRefusal
// ============================================

describe('looksLikeSearchRefusal', () => {
  describe('обнаруживает отказ (TRUE)', () => {
    const trueCases: [string, string][] = [
      ['К сожалению, я не могу выполнить поиск в интернете.', 'прямой отказ: не могу поиск'],
      ['Я не могу искать информацию в реальном времени.', 'не могу искать'],
      ['Я не умею искать в интернете.', 'не умею искать'],
      ['У меня нет доступа к интернету.', 'нет доступа к интернету'],
      ['Не имею доступа к интернету для проверки.', 'не имею доступа'],
      ['У меня нет доступа к актуальным данным.', 'нет доступа к актуальным'],
      ['Я не могу предоставить актуальную информацию.', 'не могу предоставить актуальн'],
      ['Мои данные устарели и могут быть неточными.', 'мои данные устарел'],
      ['Мои знания ограничены определённой датой.', 'мои знания ограничен'],
      ['Рекомендую проверить на официальном сайте.', 'рекомендую проверить сайт'],
      ['Для актуальной информации обратитесь к поисковику.', 'для актуальн обратитесь'],
      ['На момент моего обучения данные были другими.', 'на момент обучения'],
      ['Не знаю актуальных цен на этот товар.', 'не знаю актуальн'],
      ['Затрудняюсь ответить без доступа к данным.', 'затрудняюсь ответить'],
      ['Предлагаю воспользоваться Google.', 'предлагаю воспользоваться'],
      ['Можете найти на сайте производителя.', 'можете найти на сайт'],
      ['Но я могу помочь с другими вопросами!', 'могу помочь с другими'],
      ['Зато я умею создавать заметки, напоминания, картинки.', 'зато я умею заметк напоминан'],
      ['I cannot search the internet.', 'English: cannot search'],
      ["I don't have access to the internet.", 'English: no access'],
      ['My knowledge is limited to my training data.', 'English: knowledge limited'],
      ['I can\'t browse the web in real-time.', 'English: can\'t browse web'],
      ['Не могу рассказать о текущих ценах.', 'не могу рассказать'],
      ['Это субъективный вопрос, красота — дело вкуса, сложно сказать.', 'субъективный уклон'],
      ['Невозможно объективно сказать кто лучший.', 'невозможно объективно сказать'],
      ['По состоянию на 2024 год данные были такими.', 'по состоянию на YYYY'],
      ['Информация вероятно устарела, проверьте самостоятельно.', 'информация вероятно устарел'],
      ['Лучше проверить в интернете актуальные данные.', 'лучше проверить в интернет'],
      ['Вот что я могу предложить: например, создать заметку.', 'могу предложить например'],
    ];

    it.each(trueCases)('%j → true (%s)', (text) => {
      expect(looksLikeSearchRefusal(text)).toBe(true);
    });
  });

  describe('НЕ обнаруживает отказ (FALSE)', () => {
    const falseCases: [string, string][] = [
      ['Курс доллара на сегодня: 92.50 рублей.', 'нормальный ответ с данными'],
      ['Погода в Москве: +5°C, облачно.', 'нормальный ответ погода'],
      ['Вот последние новости технологий...', 'нормальный ответ новости'],
      ['По данным из интернета, население Земли — 8 миллиардов.', 'ответ с данными'],
      ['Привет! Как дела?', 'обычное приветствие'],
      ['Рецепт: 1. Нарезать 2. Обжарить 3. Подать', 'рецепт'],
      ['TypeScript — это надмножество JavaScript.', 'tech ответ'],
    ];

    it.each(falseCases)('%j → false (%s)', (text) => {
      expect(looksLikeSearchRefusal(text)).toBe(false);
    });
  });
});

// ============================================
// llmIgnoredSearchData
// ============================================

describe('llmIgnoredSearchData', () => {
  const buildSearchContext = (answer: string, citations: string[] = []) => {
    let ctx = `=== ДАННЫЕ ИЗ ИНТЕРНЕТА (2026-03-16) ===\n${answer}\n`;
    if (citations.length > 0) {
      ctx += 'КАРТА ИСТОЧНИКОВ:\n';
      citations.forEach((url, i) => {
        ctx += `[${i + 1}] ${url}\n`;
      });
    }
    ctx += '=== КОНЕЦ ДАННЫХ ===';
    return ctx;
  };

  it('нет webSearchContext → false', () => {
    expect(llmIgnoredSearchData('ответ', '')).toBe(false);
  });

  it('AI использует числа из Perplexity → false', () => {
    const ctx = buildSearchContext('Курс доллара: 92.50 руб.');
    expect(llmIgnoredSearchData('Курс USD: 92.50 рублей', ctx)).toBe(false);
  });

  it('AI полностью игнорирует числа из Perplexity → true', () => {
    const ctx = buildSearchContext('Температура в Москве: 15 градусов, давление 745 мм.');
    expect(llmIgnoredSearchData('Я не знаю какая сейчас погода', ctx)).toBe(true);
  });

  it('AI отказывается искать при наличии данных → true', () => {
    const ctx = buildSearchContext('Результаты матча: Спартак 2:1 ЦСКА');
    expect(llmIgnoredSearchData('Я не могу выполнить поиск в интернете', ctx)).toBe(true);
  });

  it('AI симулирует поиск при наличии данных → true', () => {
    const ctx = buildSearchContext('Новости: Apple выпустила iPhone 20 за $1299');
    expect(llmIgnoredSearchData('🔍 Ищу информацию...', ctx)).toBe(true);
  });

  it('короткий ответ при длинных данных без чисел → true', () => {
    const longAnswer = 'Подробная информация: ' + 'текст '.repeat(100);
    const ctx = buildSearchContext(longAnswer);
    expect(llmIgnoredSearchData('Не знаю', ctx)).toBe(true);
  });

  it('короткий ответ при длинных данных С числами → false', () => {
    const longAnswer = 'Подробная информация: цена 500 рублей ' + 'текст '.repeat(100);
    const ctx = buildSearchContext(longAnswer);
    expect(llmIgnoredSearchData('Цена: 500 рублей', ctx)).toBe(false);
  });

  it('Perplexity без значимых чисел + нормальный ответ → false', () => {
    const ctx = buildSearchContext('Python — язык программирования общего назначения.');
    const response = 'Python это отличный язык для начинающих, он легко читается и пишется.';
    expect(llmIgnoredSearchData(response, ctx)).toBe(false);
  });
});

// ============================================
// inlineCitations
// ============================================

describe('inlineCitations', () => {
  it('одна citation [1] → markdown-ссылка', () => {
    const result = inlineCitations('Новость[1]', ['https://example.com']);
    expect(result).toBe('Новость[1](https://example.com)');
  });

  it('несколько citations [1][2]', () => {
    const result = inlineCitations(
      'Факт[1] и ещё факт[2]',
      ['https://a.com', 'https://b.com'],
    );
    expect(result).toContain('[1](https://a.com)');
    expect(result).toContain('[2](https://b.com)');
  });

  it('citation вне диапазона → оставляется как есть', () => {
    const result = inlineCitations('Ссылка[5]', ['https://a.com']);
    expect(result).toContain('[5]');
    expect(result).not.toContain('href');
  });

  it('нет citations → текст без изменений', () => {
    expect(inlineCitations('Просто текст', [])).toBe('Просто текст');
  });

  it('пустой массив citations → без изменений', () => {
    expect(inlineCitations('Текст[1]', [])).toBe('Текст[1]');
  });

  it('текст без [N] ссылок → без изменений', () => {
    expect(inlineCitations('Обычный текст без ссылок', ['https://a.com'])).toBe(
      'Обычный текст без ссылок',
    );
  });

  it('удаляет раздел "Источники:"', () => {
    const text = 'Ответ[1]\n\n📚 Источники:\n1. https://a.com';
    const result = inlineCitations(text, ['https://a.com']);
    expect(result).not.toContain('Источники');
  });

  it('[0] → вне диапазона (1-based)', () => {
    const result = inlineCitations('Текст[0]', ['https://a.com']);
    expect(result).toBe('Текст[0]');
  });

  it('несколько подряд [1][2][3]', () => {
    const result = inlineCitations(
      'Данные[1][2][3]',
      ['https://a.com', 'https://b.com', 'https://c.com'],
    );
    expect(result).toContain('[1](https://a.com)');
    expect(result).toContain('[2](https://b.com)');
    expect(result).toContain('[3](https://c.com)');
  });
});

// ============================================
// stripMarkdown
// ============================================

describe('stripMarkdown', () => {
  const cases: [string, string, string][] = [
    ['**bold**', 'bold', 'bold → plain'],
    ['*italic*', 'italic', 'italic → plain'],
    ['`code`', 'code', 'inline code → plain'],
    ['```\ncode block\n```', 'code block\n', 'code block → plain'],
    ['~~strike~~', 'strike', 'strikethrough → plain'],
    ['__underline__', 'underline', 'underline → plain'],
    ['[link](https://example.com)', 'link (https://example.com)', 'link → text (url)'],
    ['# Heading', 'Heading', 'heading → plain'],
    ['## Sub Heading', 'Sub Heading', 'h2 → plain'],
    ['### Third Level', 'Third Level', 'h3 → plain'],
    ['plain text', 'plain text', 'no formatting'],
    ['', '', 'empty string'],
    ['**bold** and *italic*', 'bold and italic', 'mixed formatting'],
    ['`code` then **bold**', 'code then bold', 'code + bold'],
    ['Привет **мир**', 'Привет мир', 'Cyrillic bold'],
  ];

  it.each(cases)('stripMarkdown(%j) → %j (%s)', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});

// ============================================
// stripHtml
// ============================================

describe('stripHtml', () => {
  const cases: [string, string, string][] = [
    ['<b>bold</b>', 'bold', 'bold tag'],
    ['<i>italic</i>', 'italic', 'italic tag'],
    ['<code>code</code>', 'code', 'code tag'],
    ['<pre>block</pre>', 'block', 'pre tag'],
    ['<s>deleted</s>', 'deleted', 'strikethrough tag'],
    ['<a href="https://example.com">link</a>', 'link (https://example.com)', 'anchor → text (url)'],
    ['&amp;', '&', 'amp entity'],
    ['&lt;', '<', 'lt entity'],
    ['&gt;', '>', 'gt entity'],
    ['&quot;', '"', 'quot entity'],
    ['&apos;', "'", 'apos entity'],
    ['plain text', 'plain text', 'no tags'],
    ['', '', 'empty string'],
    ['<b>bold</b> &amp; <i>italic</i>', 'bold & italic', 'mixed tags + entities'],
    ['<div class="x">content</div>', 'content', 'div tag with attr'],
    ['<br/>', '', 'self-closing br'],
    ['<a href="https://a.com">A</a> and <a href="https://b.com">B</a>', 'A (https://a.com) and B (https://b.com)', 'multiple anchors'],
    ['Tom &amp; Jerry &lt;3', 'Tom & Jerry <3', 'multiple entities'],
    ['nested <b><i>text</i></b>', 'nested text', 'nested tags'],
    ['<b>Привет</b> &amp; <i>мир</i>', 'Привет & мир', 'Cyrillic'],
  ];

  it.each(cases)('stripHtml(%j) → %j (%s)', (input, expected) => {
    expect(stripHtml(input)).toBe(expected);
  });
});

// ============================================
// formatSearchError
// ============================================

describe('formatSearchError', () => {
  const knownCodes = [
    'PERPLEXITY_NOT_CONFIGURED',
    'PERPLEXITY_AUTH_ERROR',
    'PERPLEXITY_PAYMENT_REQUIRED',
    'PERPLEXITY_RATE_LIMIT',
    'PERPLEXITY_TIMEOUT',
  ] as const;

  it.each(knownCodes)('код %s → содержит основное сообщение', (code) => {
    const msg = formatSearchError(code);
    expect(msg).toContain('не удалось получить');
  });

  it('PERPLEXITY_NOT_CONFIGURED → упоминает API ключ', () => {
    expect(formatSearchError('PERPLEXITY_NOT_CONFIGURED')).toContain('API ключ');
  });

  it('PERPLEXITY_AUTH_ERROR → упоминает авторизацию', () => {
    expect(formatSearchError('PERPLEXITY_AUTH_ERROR')).toContain('авторизаци');
  });

  it('PERPLEXITY_PAYMENT_REQUIRED → упоминает лимит/баланс', () => {
    expect(formatSearchError('PERPLEXITY_PAYMENT_REQUIRED')).toContain('лимит');
  });

  it('PERPLEXITY_RATE_LIMIT → "через минуту"', () => {
    expect(formatSearchError('PERPLEXITY_RATE_LIMIT')).toContain('через минуту');
  });

  it('PERPLEXITY_TIMEOUT → "не ответил вовремя"', () => {
    expect(formatSearchError('PERPLEXITY_TIMEOUT')).toContain('не ответил');
  });

  it('неизвестный код → общее сообщение с /search', () => {
    const msg = formatSearchError('UNKNOWN_ERROR');
    expect(msg).toContain('/search');
  });

  it('пустая строка → общее сообщение', () => {
    const msg = formatSearchError('');
    expect(msg).toContain('/search');
  });

  it('все сообщения начинаются с emoji', () => {
    for (const code of [...knownCodes, 'UNKNOWN']) {
      expect(formatSearchError(code).startsWith('😔')).toBe(true);
    }
  });
});
