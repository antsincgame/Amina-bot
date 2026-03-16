import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeScenarioPolicy,
  normalizeScenario,
  getDefaultTelephonyAiScenarios,
  buildPlanPrompt,
  buildFallbackPlan,
  normalizePlan,
  toPlanInput,
} from './scenario-compiler.js';
import {
  cleanText,
  normalizePhone,
  slugify,
  truncateText,
  prefixRu,
  safeJsonParse,
  extractJsonObject,
  createDefaultScenarioPolicy,
  asRecord,
  escapeHtml,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_FALLBACK_MODE,
  DEFAULT_POLICY_VERSION,
} from './shared.js';
import type {
  TelephonyAiScenario,
  TelephonyAiScenarioPolicy,
} from '../../../../shared/types/telephony.js';

// ─── shared.ts — cleanText ──────────────────────────────────────────────────

describe('cleanText — очистка текста', () => {
  it('удаляет лишние пробелы', () => {
    expect(cleanText('hello   world')).toBe('hello world');
  });

  it('удаляет пробелы по краям', () => {
    expect(cleanText('  hello  ')).toBe('hello');
  });

  it('сворачивает табы и переводы строк', () => {
    expect(cleanText('hello\t\nworld')).toBe('hello world');
  });

  it('возвращает пустую строку для null', () => {
    expect(cleanText(null)).toBe('');
  });

  it('возвращает пустую строку для undefined', () => {
    expect(cleanText(undefined)).toBe('');
  });

  it('возвращает пустую строку для пустой строки', () => {
    expect(cleanText('')).toBe('');
  });

  it('оставляет нормальный текст без изменений', () => {
    expect(cleanText('normal text')).toBe('normal text');
  });

  it('обрабатывает строку только из пробелов', () => {
    expect(cleanText('     ')).toBe('');
  });

  it('обрабатывает множественные виды пробельных символов', () => {
    expect(cleanText('a \t\n\r b')).toBe('a b');
  });

  it('один символ без пробелов', () => {
    expect(cleanText('x')).toBe('x');
  });
});

// ─── shared.ts — normalizePhone ─────────────────────────────────────────────

describe('normalizePhone — нормализация телефонов', () => {
  it('удаляет пробелы', () => {
    expect(normalizePhone('+7 999 123 45 67')).toBe('+799912345 67'.replace(/ /g, ''));
    // More precise check:
    expect(normalizePhone('+7 999 123 45 67')).toBe('+79991234567');
  });

  it('удаляет дефисы', () => {
    expect(normalizePhone('+7-999-123-45-67')).toBe('+79991234567');
  });

  it('удаляет скобки', () => {
    expect(normalizePhone('+7(999)1234567')).toBe('+79991234567');
  });

  it('оставляет + и цифры', () => {
    expect(normalizePhone('+12345')).toBe('+12345');
  });

  it('чистое число без +', () => {
    expect(normalizePhone('79991234567')).toBe('79991234567');
  });

  it('пустая строка остаётся пустой', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('удаляет буквы', () => {
    expect(normalizePhone('+7abc999')).toBe('+7999');
  });

  it('удаляет точки', () => {
    expect(normalizePhone('+7.999.123')).toBe('+7999123');
  });

  it('составной номер с разными символами', () => {
    expect(normalizePhone('  +7 (999) 123-45-67  ')).toBe('+79991234567');
  });

  it('только нечисловые символы без +', () => {
    expect(normalizePhone('abc')).toBe('');
  });
});

// ─── shared.ts — escapeHtml ─────────────────────────────────────────────────

describe('escapeHtml — экранирование HTML', () => {
  it('экранирует &', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('экранирует <', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('экранирует >', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('экранирует все символы в одной строке', () => {
    expect(escapeHtml('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
  });

  it('не изменяет безопасный текст', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('пустая строка', () => {
    expect(escapeHtml('')).toBe('');
  });
});

// ─── shared.ts — slugify ────────────────────────────────────────────────────

describe('slugify — генерация slug', () => {
  it('латинский текст lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('удаляет спецсимволы', () => {
    expect(slugify('Hello! @World#')).toBe('hello-world');
  });

  it('кириллица → пустой slug → fallback', () => {
    const result = slugify('Подтверждение встречи');
    expect(result).toMatch(/^scenario-\d+$/);
  });

  it('пустая строка → fallback', () => {
    const result = slugify('');
    expect(result).toMatch(/^scenario-\d+$/);
  });

  it('только спецсимволы → fallback', () => {
    const result = slugify('!@#$%^&*()');
    expect(result).toMatch(/^scenario-\d+$/);
  });

  it('цифры сохраняются', () => {
    expect(slugify('step 1 done')).toBe('step-1-done');
  });

  it('убирает начальные и конечные дефисы', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('множественные дефисы сворачиваются', () => {
    expect(slugify('a   b   c')).toBe('a-b-c');
  });

  it('уже slug-совместимая строка', () => {
    expect(slugify('my-slug')).toBe('my-slug');
  });

  it('смешанный регистр', () => {
    expect(slugify('CamelCase')).toBe('camelcase');
  });
});

// ─── shared.ts — truncateText ───────────────────────────────────────────────

describe('truncateText — обрезка текста', () => {
  it('текст короче лимита — без изменений', () => {
    expect(truncateText('short', 100)).toBe('short');
  });

  it('текст ровно на лимите — без изменений', () => {
    const text = 'x'.repeat(50);
    expect(truncateText(text, 50)).toBe(text);
  });

  it('обрезает по границе предложения (точка)', () => {
    const text = 'Первое предложение. Второе предложение. Третье предложение длинное';
    const result = truncateText(text, 45);
    expect(result.endsWith('.')).toBe(true);
  });

  it('обрезает по границе предложения (восклицательный)', () => {
    const text = 'Привет! Как дела? Отлично! Потом ещё много текста для тестирования длины';
    const result = truncateText(text, 30);
    expect(result.endsWith('!') || result.endsWith('?') || result.endsWith('...')).toBe(true);
  });

  it('добавляет "..." если нет предложения', () => {
    const text = 'одно длинное слово без точек и знаков препинания которое продолжается';
    const result = truncateText(text, 30);
    expect(result.endsWith('...')).toBe(true);
  });

  it('пустая строка', () => {
    expect(truncateText('', 100)).toBe('');
  });

  it('maxLength=1 на длинном тексте', () => {
    const result = truncateText('hello world', 1);
    expect(result.length).toBeLessThanOrEqual(4); // 'h...'
  });

  it('сохраняет короткий текст без изменений', () => {
    expect(truncateText('hi', 10)).toBe('hi');
  });

  it('обрезает по пробелу если нет предложения рядом', () => {
    const text = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10';
    const result = truncateText(text, 25);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(28); // с учётом ...
  });
});

// ─── shared.ts — prefixRu ──────────────────────────────────────────────────

describe('prefixRu — добавление "ru " префикса', () => {
  it('добавляет "ru " к обычному тексту', () => {
    expect(prefixRu('hello')).toBe('ru hello');
  });

  it('не дублирует "ru " если уже есть', () => {
    expect(prefixRu('ru hello')).toBe('ru hello');
  });

  it('undefined для null', () => {
    expect(prefixRu(null)).toBeUndefined();
  });

  it('undefined для пустой строки', () => {
    expect(prefixRu('')).toBeUndefined();
  });

  it('undefined для строки только из пробелов', () => {
    expect(prefixRu('   ')).toBeUndefined();
  });

  it('нормализует пробелы перед добавлением', () => {
    expect(prefixRu('  hello   world  ')).toBe('ru hello world');
  });

  it('не считает "russian" как уже имеющий префикс', () => {
    expect(prefixRu('russian')).toBe('ru russian');
  });

  it('"ru" без пробела — не считается префиксом', () => {
    expect(prefixRu('ruby')).toBe('ru ruby');
  });

  it('"ru " с пробелом — считается', () => {
    expect(prefixRu('ru text')).toBe('ru text');
  });
});

// ─── shared.ts — safeJsonParse ──────────────────────────────────────────────

describe('safeJsonParse — безопасный парсинг JSON', () => {
  it('парсит валидный JSON объект', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('парсит JSON массив', () => {
    expect(safeJsonParse<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('парсит JSON строку', () => {
    expect(safeJsonParse<string>('"hello"')).toBe('hello');
  });

  it('парсит JSON число', () => {
    expect(safeJsonParse<number>('42')).toBe(42);
  });

  it('парсит null', () => {
    expect(safeJsonParse('null')).toBeNull();
  });

  it('парсит true/false', () => {
    expect(safeJsonParse<boolean>('true')).toBe(true);
    expect(safeJsonParse<boolean>('false')).toBe(false);
  });

  it('возвращает null для невалидного JSON', () => {
    expect(safeJsonParse('{invalid}')).toBeNull();
  });

  it('возвращает null для пустой строки', () => {
    expect(safeJsonParse('')).toBeNull();
  });

  it('возвращает null для обычного текста', () => {
    expect(safeJsonParse('hello world')).toBeNull();
  });

  it('парсит вложенный объект', () => {
    expect(safeJsonParse('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });
});

// ─── shared.ts — extractJsonObject ──────────────────────────────────────────

describe('extractJsonObject — извлечение JSON из текста', () => {
  it('извлекает JSON из текста с окружением', () => {
    const result = extractJsonObject('text before {"key":"value"} text after');
    expect(result).toBe('{"key":"value"}');
  });

  it('извлекает JSON без окружающего текста', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('null если нет JSON', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('null для пустой строки', () => {
    expect(extractJsonObject('')).toBeNull();
  });

  it('null если только открывающая скобка', () => {
    expect(extractJsonObject('{ incomplete')).toBeNull();
  });

  it('null если только закрывающая скобка', () => {
    expect(extractJsonObject('incomplete }')).toBeNull();
  });

  it('null если } перед {', () => {
    expect(extractJsonObject('} before {')).toBeNull();
  });

  it('обрабатывает вложенные фигурные скобки', () => {
    const result = extractJsonObject('before {"a":{"b":1}} after');
    expect(result).toBe('{"a":{"b":1}}');
  });

  it('множественные JSON — берёт от первого { до последнего }', () => {
    const result = extractJsonObject('{"a":1} text {"b":2}');
    expect(result).toBe('{"a":1} text {"b":2}');
  });

  it('с переводами строк', () => {
    const text = 'prefix\n{\n  "key": "value"\n}\nsuffix';
    const result = extractJsonObject(text);
    expect(result).toContain('"key"');
  });
});

// ─── shared.ts — createDefaultScenarioPolicy ────────────────────────────────

describe('createDefaultScenarioPolicy — политика по умолчанию', () => {
  it('возвращает объект с правильной структурой', () => {
    const p = createDefaultScenarioPolicy('goal');
    expect(p).toHaveProperty('allowedClaims');
    expect(p).toHaveProperty('requiredSlots');
    expect(p).toHaveProperty('exitConditions');
    expect(p).toHaveProperty('handoffRules');
    expect(p).toHaveProperty('maxSilenceMs');
    expect(p).toHaveProperty('maxTurns');
    expect(p).toHaveProperty('fallbackMode');
  });

  it('allowedClaims содержит goal', () => {
    const p = createDefaultScenarioPolicy('моя цель');
    expect(p.allowedClaims).toContain('моя цель');
  });

  it('allowedClaims пуст при пустом goal', () => {
    const p = createDefaultScenarioPolicy('');
    expect(p.allowedClaims).toEqual([]);
  });

  it('requiredSlots — пустой массив', () => {
    const p = createDefaultScenarioPolicy('goal');
    expect(p.requiredSlots).toEqual([]);
  });

  it('exitConditions — непустой массив', () => {
    const p = createDefaultScenarioPolicy('goal');
    expect(p.exitConditions.length).toBeGreaterThan(0);
  });

  it('handoffRules — непустой массив', () => {
    const p = createDefaultScenarioPolicy('goal');
    expect(p.handoffRules.length).toBeGreaterThan(0);
  });

  it('maxSilenceMs = 6000', () => {
    expect(createDefaultScenarioPolicy('g').maxSilenceMs).toBe(6000);
  });

  it('maxTurns = 6', () => {
    expect(createDefaultScenarioPolicy('g').maxTurns).toBe(6);
  });

  it('fallbackMode = scripted', () => {
    expect(createDefaultScenarioPolicy('g').fallbackMode).toBe('scripted');
  });

  it('cleanText применяется к goal', () => {
    const p = createDefaultScenarioPolicy('  spaced   goal  ');
    expect(p.allowedClaims[0]).toBe('spaced goal');
  });

  it('goal с переводами строк нормализуется', () => {
    const p = createDefaultScenarioPolicy('line1\n\tline2');
    expect(p.allowedClaims[0]).toBe('line1 line2');
  });
});

// ─── shared.ts — asRecord ───────────────────────────────────────────────────

describe('asRecord — приведение к Record', () => {
  it('объект → Record', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it('null → null', () => {
    expect(asRecord(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(asRecord(undefined)).toBeNull();
  });

  it('массив → null', () => {
    expect(asRecord([1, 2])).toBeNull();
  });

  it('строка → null', () => {
    expect(asRecord('string')).toBeNull();
  });

  it('число → null', () => {
    expect(asRecord(42)).toBeNull();
  });

  it('boolean → null', () => {
    expect(asRecord(true)).toBeNull();
  });

  it('пустой объект → пустой Record', () => {
    expect(asRecord({})).toEqual({});
  });
});

// ─── scenario-compiler.ts — normalizeScenarioPolicy ─────────────────────────

describe('normalizeScenarioPolicy — нормализация политики', () => {
  it('null input → fallback политика', () => {
    const p = normalizeScenarioPolicy(null, 'goal');
    expect(p.maxSilenceMs).toBe(6000);
    expect(p.maxTurns).toBe(6);
  });

  it('undefined input → fallback', () => {
    const p = normalizeScenarioPolicy(undefined, 'goal');
    expect(p.fallbackMode).toBe('scripted');
  });

  it('пустой объект → fallback', () => {
    const p = normalizeScenarioPolicy({}, 'goal');
    expect(p.maxTurns).toBe(6);
  });

  it('maxSilenceMs в допустимом диапазоне', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 5000 }, 'g');
    expect(p.maxSilenceMs).toBe(5000);
  });

  it('maxSilenceMs ниже 1000 → fallback', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 500 }, 'g');
    expect(p.maxSilenceMs).toBe(6000);
  });

  it('maxSilenceMs выше 30000 → fallback', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 50000 }, 'g');
    expect(p.maxSilenceMs).toBe(6000);
  });

  it('maxSilenceMs = 1000 (нижняя граница) — ОК', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 1000 }, 'g');
    expect(p.maxSilenceMs).toBe(1000);
  });

  it('maxSilenceMs = 30000 (верхняя граница) — ОК', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 30000 }, 'g');
    expect(p.maxSilenceMs).toBe(30000);
  });

  it('maxTurns в допустимом диапазоне', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 10 }, 'g');
    expect(p.maxTurns).toBe(10);
  });

  it('maxTurns ниже 1 → fallback', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 0 }, 'g');
    expect(p.maxTurns).toBe(6);
  });

  it('maxTurns выше 30 → fallback', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 50 }, 'g');
    expect(p.maxTurns).toBe(6);
  });

  it('maxTurns = 1 (нижняя граница) — ОК', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 1 }, 'g');
    expect(p.maxTurns).toBe(1);
  });

  it('maxTurns = 30 (верхняя граница) — ОК', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 30 }, 'g');
    expect(p.maxTurns).toBe(30);
  });

  it('fallbackMode = fail', () => {
    const p = normalizeScenarioPolicy({ fallbackMode: 'fail' }, 'g');
    expect(p.fallbackMode).toBe('fail');
  });

  it('fallbackMode = scripted', () => {
    const p = normalizeScenarioPolicy({ fallbackMode: 'scripted' }, 'g');
    expect(p.fallbackMode).toBe('scripted');
  });

  it('невалидный fallbackMode → scripted', () => {
    const p = normalizeScenarioPolicy({ fallbackMode: 'invalid' }, 'g');
    expect(p.fallbackMode).toBe('scripted');
  });

  it('allowedClaims из входа', () => {
    const p = normalizeScenarioPolicy({ allowedClaims: ['claim1', 'claim2'] }, 'g');
    expect(p.allowedClaims).toEqual(['claim1', 'claim2']);
  });

  it('пустой allowedClaims → fallback', () => {
    const p = normalizeScenarioPolicy({ allowedClaims: [] }, 'goal');
    expect(p.allowedClaims).toContain('goal');
  });

  it('requiredSlots из входа', () => {
    const p = normalizeScenarioPolicy({ requiredSlots: ['slot1'] }, 'g');
    expect(p.requiredSlots).toEqual(['slot1']);
  });

  it('exitConditions из входа', () => {
    const p = normalizeScenarioPolicy({ exitConditions: ['cond'] }, 'g');
    expect(p.exitConditions).toEqual(['cond']);
  });

  it('пустой exitConditions → fallback', () => {
    const p = normalizeScenarioPolicy({ exitConditions: [] }, 'g');
    expect(p.exitConditions.length).toBeGreaterThan(0);
  });

  it('handoffRules из входа', () => {
    const p = normalizeScenarioPolicy({ handoffRules: ['rule'] }, 'g');
    expect(p.handoffRules).toEqual(['rule']);
  });

  it('пустой handoffRules → fallback', () => {
    const p = normalizeScenarioPolicy({ handoffRules: [] }, 'g');
    expect(p.handoffRules.length).toBeGreaterThan(0);
  });

  it('NaN maxSilenceMs → fallback', () => {
    const p = normalizeScenarioPolicy({ maxSilenceMs: 'abc' }, 'g');
    expect(p.maxSilenceMs).toBe(6000);
  });

  it('NaN maxTurns → fallback', () => {
    const p = normalizeScenarioPolicy({ maxTurns: 'abc' }, 'g');
    expect(p.maxTurns).toBe(6);
  });

  it('строка input → fallback', () => {
    const p = normalizeScenarioPolicy('string', 'g');
    expect(p.maxTurns).toBe(6);
  });

  it('массив input → fallback', () => {
    const p = normalizeScenarioPolicy([1, 2], 'g');
    expect(p.maxTurns).toBe(6);
  });
});

// ─── scenario-compiler.ts — normalizeScenario ───────────────────────────────

describe('normalizeScenario — нормализация сценария', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('валидный сценарий проходит', () => {
    const s = normalizeScenario(
      { id: 'test', name: 'Test', goal: 'goal', callMode: 'ask_question', runtimeMode: 'scripted' },
      0,
      now,
    );
    expect(s.id).toBe('test');
    expect(s.name).toBe('Test');
  });

  it('отсутствующее имя → "Сценарий N"', () => {
    const s = normalizeScenario({}, 2, now);
    expect(s.name).toBe('Сценарий 3');
  });

  it('отсутствующий id → slug от имени', () => {
    const s = normalizeScenario({ name: 'My Scenario' }, 0, now);
    expect(s.id).toBe('my-scenario');
  });

  it('enabled по умолчанию true', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.enabled).toBe(true);
  });

  it('enabled=false сохраняется', () => {
    const s = normalizeScenario({ enabled: false }, 0, now);
    expect(s.enabled).toBe(false);
  });

  it('callMode=speech', () => {
    const s = normalizeScenario({ callMode: 'speech' }, 0, now);
    expect(s.callMode).toBe('speech');
  });

  it('callMode по умолчанию ask_question', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.callMode).toBe('ask_question');
  });

  it('невалидный callMode → ask_question', () => {
    const s = normalizeScenario({ callMode: 'invalid' as never }, 0, now);
    expect(s.callMode).toBe('ask_question');
  });

  it('runtimeMode=shadow', () => {
    const s = normalizeScenario({ runtimeMode: 'shadow' }, 0, now);
    expect(s.runtimeMode).toBe('shadow');
  });

  it('runtimeMode=hybrid', () => {
    const s = normalizeScenario({ runtimeMode: 'hybrid' }, 0, now);
    expect(s.runtimeMode).toBe('hybrid');
  });

  it('runtimeMode=realtime', () => {
    const s = normalizeScenario({ runtimeMode: 'realtime' }, 0, now);
    expect(s.runtimeMode).toBe('realtime');
  });

  it('невалидный runtimeMode → default (scripted)', () => {
    const s = normalizeScenario({ runtimeMode: 'invalid' as never }, 0, now);
    expect(s.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
  });

  it('policyVersion по умолчанию', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.policyVersion).toBe(DEFAULT_POLICY_VERSION);
  });

  it('policyVersion из входа', () => {
    const s = normalizeScenario({ policyVersion: 5 }, 0, now);
    expect(s.policyVersion).toBe(5);
  });

  it('невалидный policyVersion → default', () => {
    const s = normalizeScenario({ policyVersion: 0 }, 0, now);
    expect(s.policyVersion).toBe(DEFAULT_POLICY_VERSION);
  });

  it('maxSpeechChars по умолчанию 420', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.maxSpeechChars).toBe(420);
  });

  it('maxSpeechChars в диапазоне 140-900', () => {
    const s = normalizeScenario({ maxSpeechChars: 500 }, 0, now);
    expect(s.maxSpeechChars).toBe(500);
  });

  it('maxSpeechChars < 140 → default', () => {
    const s = normalizeScenario({ maxSpeechChars: 100 }, 0, now);
    expect(s.maxSpeechChars).toBe(420);
  });

  it('maxSpeechChars > 900 → default', () => {
    const s = normalizeScenario({ maxSpeechChars: 1000 }, 0, now);
    expect(s.maxSpeechChars).toBe(420);
  });

  it('updatedAt = now', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.updatedAt).toBe(now);
  });

  it('createdAt из входа если есть', () => {
    const s = normalizeScenario({ createdAt: '2020-01-01T00:00:00Z' }, 0, now);
    expect(s.createdAt).toBe('2020-01-01T00:00:00Z');
  });

  it('createdAt = now если пусто', () => {
    const s = normalizeScenario({}, 0, now);
    expect(s.createdAt).toBe(now);
  });

  it('policy нормализуется', () => {
    const s = normalizeScenario({ goal: 'test goal' }, 0, now);
    expect(s.policy.maxTurns).toBe(6);
    expect(s.policy.maxSilenceMs).toBe(6000);
  });

  it('goal очищается cleanText', () => {
    const s = normalizeScenario({ goal: '  spaced   goal  ' }, 0, now);
    expect(s.goal).toBe('spaced goal');
  });

  it('systemPrompt очищается cleanText', () => {
    const s = normalizeScenario({ systemPrompt: '  prompt  ' }, 0, now);
    expect(s.systemPrompt).toBe('prompt');
  });
});

// ─── scenario-compiler.ts — getDefaultTelephonyAiScenarios ──────────────────

describe('getDefaultTelephonyAiScenarios — стандартные сценарии', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('возвращает 4 сценария', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    expect(scenarios).toHaveLength(4);
  });

  it('каждый сценарий имеет id', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => expect(s.id).toBeTruthy());
  });

  it('каждый сценарий имеет name', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => expect(s.name).toBeTruthy());
  });

  it('каждый сценарий имеет goal', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => expect(s.goal).toBeTruthy());
  });

  it('каждый enabled', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => expect(s.enabled).toBe(true));
  });

  it('содержит freeform сценарий', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    const freeform = scenarios.find(s => s.id === 'freeform');
    expect(freeform).toBeDefined();
  });

  it('freeform — runtimeMode=realtime', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    const freeform = scenarios.find(s => s.id === 'freeform')!;
    expect(freeform.runtimeMode).toBe('realtime');
  });

  it('freeform — callMode=ask_question', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    const freeform = scenarios.find(s => s.id === 'freeform')!;
    expect(freeform.callMode).toBe('ask_question');
  });

  it('confirm-meeting присутствует', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    expect(scenarios.find(s => s.id === 'confirm-meeting')).toBeDefined();
  });

  it('collect-decision присутствует', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    expect(scenarios.find(s => s.id === 'collect-decision')).toBeDefined();
  });

  it('delivery-update присутствует', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    expect(scenarios.find(s => s.id === 'delivery-update')).toBeDefined();
  });

  it('каждый имеет валидный callMode', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => {
      expect(['speech', 'ask_question']).toContain(s.callMode);
    });
  });

  it('каждый имеет валидный runtimeMode', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => {
      expect(['scripted', 'shadow', 'hybrid', 'realtime']).toContain(s.runtimeMode);
    });
  });

  it('delivery-update — callMode=speech', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    const du = scenarios.find(s => s.id === 'delivery-update')!;
    expect(du.callMode).toBe('speech');
  });

  it('каждый имеет policy', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => {
      expect(s.policy).toBeDefined();
      expect(s.policy.maxTurns).toBeGreaterThan(0);
    });
  });

  it('каждый имеет createdAt и updatedAt', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => {
      expect(s.createdAt).toBeTruthy();
      expect(s.updatedAt).toBeTruthy();
    });
  });

  it('maxSpeechChars в допустимом диапазоне', () => {
    const scenarios = getDefaultTelephonyAiScenarios();
    scenarios.forEach(s => {
      expect(s.maxSpeechChars).toBeGreaterThanOrEqual(140);
      expect(s.maxSpeechChars).toBeLessThanOrEqual(900);
    });
  });
});

// ─── scenario-compiler.ts — buildPlanPrompt ─────────────────────────────────

describe('buildPlanPrompt — генерация промпта для плана', () => {
  const baseScenario: TelephonyAiScenario = {
    id: 'test',
    name: 'Test',
    enabled: true,
    callMode: 'ask_question',
    runtimeMode: 'scripted',
    policyVersion: 1,
    policy: createDefaultScenarioPolicy('goal'),
    goal: 'test goal',
    systemPrompt: 'be polite',
    openingLine: 'Hello',
    questionHint: 'ask yes/no',
    successCriteria: 'got answer',
    resultPrompt: 'summarize',
    maxSpeechChars: 420,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('возвращает массив из 2 сообщений', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs).toHaveLength(2);
  });

  it('первое сообщение — system', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs[0].role).toBe('system');
  });

  it('второе сообщение — user', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs[1].role).toBe('user');
  });

  it('system content содержит goal', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs[0].content).toContain('test goal');
  });

  it('system content содержит runtimeMode', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs[0].content).toContain('scripted');
  });

  it('user content содержит phone', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+79991234567');
    expect(msgs[1].content).toContain('+79991234567');
  });

  it('user content содержит task', () => {
    const msgs = buildPlanPrompt(baseScenario, 'my task here', '+79991234567');
    expect(msgs[1].content).toContain('my task here');
  });

  it('ask_question режим — промпт содержит askText', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+7');
    expect(msgs[0].content).toContain('askText');
  });

  it('speech режим — промпт содержит speechText', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const msgs = buildPlanPrompt(speechScenario, 'task', '+7');
    expect(msgs[0].content).toContain('speechText');
  });

  it('speech режим — НЕ содержит askText', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const msgs = buildPlanPrompt(speechScenario, 'task', '+7');
    expect(msgs[0].content).not.toContain('askText');
  });

  it('ask_question режим — НЕ содержит speechText (как ключ JSON)', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+7');
    // speechText не входит в JSON shape для ask_question
    expect(msgs[0].content).not.toContain('"speechText"');
  });

  it('содержит systemPrompt', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+7');
    expect(msgs[0].content).toContain('be polite');
  });

  it('содержит openingLine', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+7');
    expect(msgs[0].content).toContain('Hello');
  });

  it('содержит successCriteria', () => {
    const msgs = buildPlanPrompt(baseScenario, 'task', '+7');
    expect(msgs[0].content).toContain('got answer');
  });

  it('содержит maxSpeechChars для speech режима', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const, maxSpeechChars: 500 };
    const msgs = buildPlanPrompt(speechScenario, 'task', '+7');
    expect(msgs[0].content).toContain('500');
  });
});

// ─── scenario-compiler.ts — buildFallbackPlan ───────────────────────────────

describe('buildFallbackPlan — запасной план', () => {
  const baseScenario: TelephonyAiScenario = {
    id: 'test',
    name: 'Test',
    enabled: true,
    callMode: 'ask_question',
    runtimeMode: 'scripted',
    policyVersion: 1,
    policy: createDefaultScenarioPolicy('goal'),
    goal: 'goal',
    systemPrompt: '',
    openingLine: 'Здравствуйте.',
    questionHint: '',
    successCriteria: 'success',
    resultPrompt: '',
    maxSpeechChars: 420,
    createdAt: '',
    updatedAt: '',
  };

  it('ask_question — callMode = ask_question', () => {
    const plan = buildFallbackPlan(baseScenario, 'task');
    expect(plan.callMode).toBe('ask_question');
  });

  it('ask_question — speechText = null', () => {
    const plan = buildFallbackPlan(baseScenario, 'task');
    expect(plan.speechText).toBeNull();
  });

  it('ask_question — helloText не null', () => {
    const plan = buildFallbackPlan(baseScenario, 'task');
    expect(plan.helloText).toBeTruthy();
  });

  it('ask_question — askText содержит task', () => {
    const plan = buildFallbackPlan(baseScenario, 'Позвонить клиенту');
    expect(plan.askText).toContain('Позвонить клиенту');
  });

  it('speech — callMode = speech', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const plan = buildFallbackPlan(speechScenario, 'task');
    expect(plan.callMode).toBe('speech');
  });

  it('speech — helloText = null', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const plan = buildFallbackPlan(speechScenario, 'task');
    expect(plan.helloText).toBeNull();
  });

  it('speech — speechText не null', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const plan = buildFallbackPlan(speechScenario, 'task');
    expect(plan.speechText).toBeTruthy();
  });

  it('summary содержит усечённый task', () => {
    const plan = buildFallbackPlan(baseScenario, 'short task');
    expect(plan.summary).toContain('short task');
  });

  it('successHint из successCriteria', () => {
    const plan = buildFallbackPlan(baseScenario, 'task');
    expect(plan.successHint).toBe('success');
  });

  it('successHint fallback при пустом successCriteria', () => {
    const s = { ...baseScenario, successCriteria: '' };
    const plan = buildFallbackPlan(s, 'task');
    expect(plan.successHint).toBeTruthy();
  });
});

// ─── scenario-compiler.ts — normalizePlan ───────────────────────────────────

describe('normalizePlan — нормализация плана', () => {
  const baseScenario: TelephonyAiScenario = {
    id: 'test',
    name: 'Test',
    enabled: true,
    callMode: 'ask_question',
    runtimeMode: 'scripted',
    policyVersion: 1,
    policy: createDefaultScenarioPolicy('goal'),
    goal: 'goal',
    systemPrompt: '',
    openingLine: 'Hi',
    questionHint: '',
    successCriteria: 'success',
    resultPrompt: '',
    maxSpeechChars: 420,
    createdAt: '',
    updatedAt: '',
  };

  it('null rawPlan → fallback', () => {
    const plan = normalizePlan(baseScenario, null, 'task');
    expect(plan.callMode).toBe('ask_question');
  });

  it('ask_question — summary из rawPlan', () => {
    const plan = normalizePlan(baseScenario, { summary: 'custom summary' }, 'task');
    expect(plan.summary).toBe('custom summary');
  });

  it('ask_question — helloText из rawPlan', () => {
    const plan = normalizePlan(baseScenario, { helloText: 'привет' }, 'task');
    expect(plan.helloText).toBe('привет');
  });

  it('speech — speechText из rawPlan', () => {
    const speechScenario = { ...baseScenario, callMode: 'speech' as const };
    const plan = normalizePlan(speechScenario, { speechText: 'my speech' }, 'task');
    expect(plan.speechText).toBe('my speech');
  });

  it('невалидный summary → fallback summary', () => {
    const plan = normalizePlan(baseScenario, { summary: 123 }, 'task');
    expect(typeof plan.summary).toBe('string');
    expect(plan.summary.length).toBeGreaterThan(0);
  });

  it('пустой rawPlan → fallback значения', () => {
    const plan = normalizePlan(baseScenario, {}, 'task');
    expect(plan.helloText).toBeTruthy();
  });
});

// ─── scenario-compiler.ts — toPlanInput ─────────────────────────────────────

describe('toPlanInput — конвертация плана в Record', () => {
  it('все ключи присутствуют', () => {
    const plan = buildFallbackPlan(
      {
        id: 'x', name: 'X', enabled: true, callMode: 'ask_question',
        runtimeMode: 'scripted', policyVersion: 1,
        policy: createDefaultScenarioPolicy('g'), goal: 'g',
        systemPrompt: '', openingLine: 'Hi', questionHint: '',
        successCriteria: 'ok', resultPrompt: '', maxSpeechChars: 420,
        createdAt: '', updatedAt: '',
      },
      'task',
    );
    const input = toPlanInput(plan);
    expect(input).toHaveProperty('summary');
    expect(input).toHaveProperty('speechText');
    expect(input).toHaveProperty('helloText');
    expect(input).toHaveProperty('askText');
    expect(input).toHaveProperty('okText');
    expect(input).toHaveProperty('byeText');
    expect(input).toHaveProperty('successHint');
  });

  it('значения совпадают с оригиналом', () => {
    const plan = {
      summary: 'sum', callMode: 'ask_question' as const,
      speechText: null, helloText: 'hi', askText: 'ask',
      okText: 'ok', byeText: 'bye', successHint: 'hint',
    };
    const input = toPlanInput(plan);
    expect(input.summary).toBe('sum');
    expect(input.helloText).toBe('hi');
    expect(input.successHint).toBe('hint');
  });
});

// ─── shared.ts — константы ──────────────────────────────────────────────────

describe('Константы модуля shared', () => {
  it('DEFAULT_RUNTIME_MODE = scripted', () => {
    expect(DEFAULT_RUNTIME_MODE).toBe('scripted');
  });

  it('DEFAULT_FALLBACK_MODE = scripted', () => {
    expect(DEFAULT_FALLBACK_MODE).toBe('scripted');
  });

  it('DEFAULT_POLICY_VERSION = 1', () => {
    expect(DEFAULT_POLICY_VERSION).toBe(1);
  });
});
