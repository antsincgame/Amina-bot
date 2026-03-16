import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache, SingleCache } from './cache.js';
import {
  AppError,
  NotFoundError,
  ValidationError,
  DatabaseError,
  AIError,
  isAppError,
  getErrorCode,
  isNotFoundError,
  handleAIError,
  safeStringify,
} from './error-handler.js';

vi.mock('../config/logger.js', () => ({
  serverLogger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
  dbLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  aiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/constants.js', () => ({
  MAX_MESSAGE_LENGTH: 10_000,
  MAX_CONVERSATION_MESSAGES: 1000,
  VALIDATE_LIMIT_MIN: 1,
  VALIDATE_LIMIT_MAX: 1000,
}));

// Импорт validation после мока constants, чтобы zod подхватил правильно
const {
  validateUserId,
  validateMessageContent,
  validateChannel,
  validateEventType,
  validateLimit,
  checkArraySize,
  MAX_MESSAGE_LENGTH,
} = await import('./validation.js');

// ─── TTLCache ────────────────────────────────────────────────────────────────

describe('TTLCache — базовые CRUD операции', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('set/get — сохраняет и возвращает значение по ключу', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
  });

  it('get — возвращает null для отсутствующего ключа', () => {
    const c = new TTLCache<number>(60_000);
    expect(c.get('missing')).toBeNull();
  });

  it('has — true для существующего ключа', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v');
    expect(c.has('k')).toBe(true);
  });

  it('has — false для отсутствующего ключа', () => {
    const c = new TTLCache<string>(60_000);
    expect(c.has('nope')).toBe(false);
  });

  it('delete — удаляет конкретный ключ', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v');
    c.delete('k');
    expect(c.get('k')).toBeNull();
  });

  it('clear — удаляет все записи', () => {
    const c = new TTLCache<string>(60_000);
    c.set('a', '1');
    c.set('b', '2');
    c.clear();
    expect(c.size).toBe(0);
  });

  it('set без ключа — использует _default_', () => {
    const c = new TTLCache<number>(60_000);
    c.set(42);
    expect(c.get()).toBe(42);
  });

  it('get без ключа — возвращает _default_', () => {
    const c = new TTLCache<string>(60_000);
    c.set('hello');
    expect(c.get()).toBe('hello');
  });

  it('has без ключа — проверяет _default_', () => {
    const c = new TTLCache<string>(60_000);
    c.set('x');
    expect(c.has()).toBe(true);
  });

  it('delete без ключа — удаляет _default_', () => {
    const c = new TTLCache<string>(60_000);
    c.set('x');
    c.delete();
    expect(c.get()).toBeNull();
  });

  it('перезапись значения по тому же ключу', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v1');
    c.set('k', 'v2');
    expect(c.get('k')).toBe('v2');
  });

  it('size — отражает количество записей', () => {
    const c = new TTLCache<string>(60_000);
    expect(c.size).toBe(0);
    c.set('a', '1');
    expect(c.size).toBe(1);
    c.set('b', '2');
    expect(c.size).toBe(2);
  });

  it('size — уменьшается при удалении', () => {
    const c = new TTLCache<string>(60_000);
    c.set('a', '1');
    c.set('b', '2');
    c.delete('a');
    expect(c.size).toBe(1);
  });
});

describe('TTLCache — TTL истечение', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('значение доступно до истечения TTL', () => {
    const c = new TTLCache<string>(5000);
    c.set('k', 'v');
    vi.advanceTimersByTime(4999);
    expect(c.get('k')).toBe('v');
  });

  it('значение null после истечения TTL', () => {
    const c = new TTLCache<string>(5000);
    c.set('k', 'v');
    vi.advanceTimersByTime(5000);
    expect(c.get('k')).toBeNull();
  });

  it('has возвращает false после TTL', () => {
    const c = new TTLCache<string>(1000);
    c.set('k', 'v');
    vi.advanceTimersByTime(1001);
    expect(c.has('k')).toBe(false);
  });

  it('запись удаляется из кэша при чтении просроченной', () => {
    const c = new TTLCache<string>(1000);
    c.set('k', 'v');
    vi.advanceTimersByTime(1001);
    c.get('k');
    expect(c.size).toBe(0);
  });

  it('новое значение после истечения старого', () => {
    const c = new TTLCache<string>(1000);
    c.set('k', 'old');
    vi.advanceTimersByTime(1500);
    c.set('k', 'new');
    expect(c.get('k')).toBe('new');
  });

  it('разные ключи истекают независимо', () => {
    const c = new TTLCache<string>(2000);
    c.set('a', '1');
    vi.advanceTimersByTime(1000);
    c.set('b', '2');
    vi.advanceTimersByTime(1001);
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).toBe('2');
  });
});

describe('TTLCache — множественные ключи', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('хранит 10 ключей одновременно', () => {
    const c = new TTLCache<number>(60_000);
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
    for (let i = 0; i < 10; i++) expect(c.get(`k${i}`)).toBe(i);
  });

  it('удаление части ключей не влияет на остальные', () => {
    const c = new TTLCache<number>(60_000);
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
    for (let i = 0; i < 5; i++) c.delete(`k${i}`);
    for (let i = 5; i < 10; i++) expect(c.get(`k${i}`)).toBe(i);
    expect(c.size).toBe(5);
  });

  it('clear удаляет все 10 ключей', () => {
    const c = new TTLCache<number>(60_000);
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe('TTLCache — age', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('возвращает 0 сразу после set', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v');
    expect(c.age('k')).toBe(0);
  });

  it('возвращает корректный возраст в секундах', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', 'v');
    vi.advanceTimersByTime(3000);
    expect(c.age('k')).toBe(3);
  });

  it('возвращает -1 для отсутствующего ключа', () => {
    const c = new TTLCache<string>(60_000);
    expect(c.age('missing')).toBe(-1);
  });

  it('age без ключа проверяет _default_', () => {
    const c = new TTLCache<string>(60_000);
    c.set('val');
    vi.advanceTimersByTime(5000);
    expect(c.age()).toBe(5);
  });

  it('age возвращает -1 для пустого кэша без ключа', () => {
    const c = new TTLCache<string>(60_000);
    expect(c.age()).toBe(-1);
  });
});

describe('TTLCache — граничные случаи', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('пустой ключ допустим', () => {
    const c = new TTLCache<string>(60_000);
    c.set('', 'empty-key');
    expect(c.get('')).toBe('empty-key');
  });

  it('undefined как второй аргумент — перегрузка интерпретирует первый как значение для _default_', () => {
    const c = new TTLCache<string>(60_000);
    c.set('k', undefined as unknown as string);
    // maybeValue===undefined → перегрузка вызывает set(value) → сохраняет 'k' как значение _default_
    expect(c.get('k')).toBeNull();
    expect(c.get()).toBe('k');
  });

  it('null как значение', () => {
    const c = new TTLCache<null>(60_000);
    c.set('k', null);
    // null-значение всё равно вернётся как null (невозможно отличить от miss)
    expect(c.get('k')).toBeNull();
  });

  it('очень длинный TTL', () => {
    const c = new TTLCache<string>(Number.MAX_SAFE_INTEGER);
    c.set('k', 'v');
    vi.advanceTimersByTime(100_000);
    expect(c.get('k')).toBe('v');
  });

  it('TTL=1 истекает через 1ms', () => {
    const c = new TTLCache<string>(1);
    c.set('k', 'v');
    vi.advanceTimersByTime(1);
    expect(c.get('k')).toBeNull();
  });

  it('TTL=0 — значение немедленно просрочено', () => {
    const c = new TTLCache<string>(0);
    c.set('k', 'v');
    expect(c.get('k')).toBeNull();
  });

  it('объекты как значения', () => {
    const c = new TTLCache<{ a: number }>(60_000);
    const obj = { a: 1 };
    c.set('k', obj);
    expect(c.get('k')).toBe(obj);
  });

  it('массивы как значения', () => {
    const c = new TTLCache<number[]>(60_000);
    c.set('k', [1, 2, 3]);
    expect(c.get('k')).toEqual([1, 2, 3]);
  });

  it('boolean как значение', () => {
    const c = new TTLCache<boolean>(60_000);
    c.set('k', false);
    expect(c.get('k')).toBe(false);
  });
});

describe('TTLCache — быстрые циклы set/get', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('100 быстрых set/get по одному ключу', () => {
    const c = new TTLCache<number>(60_000);
    for (let i = 0; i < 100; i++) {
      c.set('k', i);
      expect(c.get('k')).toBe(i);
    }
  });

  it('100 разных ключей за 1ms', () => {
    const c = new TTLCache<number>(60_000);
    for (let i = 0; i < 100; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(100);
    for (let i = 0; i < 100; i++) expect(c.get(`k${i}`)).toBe(i);
  });
});

// ─── SingleCache ─────────────────────────────────────────────────────────────

describe('SingleCache — базовые операции', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('set/get — сохраняет и возвращает', () => {
    const c = new SingleCache<string>(60_000);
    c.set('hello');
    expect(c.get()).toBe('hello');
  });

  it('get — null когда пусто', () => {
    const c = new SingleCache<string>(60_000);
    expect(c.get()).toBeNull();
  });

  it('clear — обнуляет значение', () => {
    const c = new SingleCache<string>(60_000);
    c.set('val');
    c.clear();
    expect(c.get()).toBeNull();
  });

  it('перезапись значения', () => {
    const c = new SingleCache<string>(60_000);
    c.set('v1');
    c.set('v2');
    expect(c.get()).toBe('v2');
  });

  it('числовое значение', () => {
    const c = new SingleCache<number>(60_000);
    c.set(42);
    expect(c.get()).toBe(42);
  });

  it('объект как значение', () => {
    const c = new SingleCache<{ x: number }>(60_000);
    const o = { x: 1 };
    c.set(o);
    expect(c.get()).toBe(o);
  });

  it('false как значение', () => {
    const c = new SingleCache<boolean>(60_000);
    c.set(false);
    expect(c.get()).toBe(false);
  });

  it('0 как значение', () => {
    const c = new SingleCache<number>(60_000);
    c.set(0);
    expect(c.get()).toBe(0);
  });

  it('пустая строка как значение', () => {
    const c = new SingleCache<string>(60_000);
    c.set('');
    expect(c.get()).toBe('');
  });
});

describe('SingleCache — TTL', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('значение доступно до TTL', () => {
    const c = new SingleCache<string>(5000);
    c.set('v');
    vi.advanceTimersByTime(4999);
    expect(c.get()).toBe('v');
  });

  it('null после истечения TTL', () => {
    const c = new SingleCache<string>(5000);
    c.set('v');
    vi.advanceTimersByTime(5000);
    expect(c.get()).toBeNull();
  });

  it('перезапись обновляет таймер TTL', () => {
    const c = new SingleCache<string>(5000);
    c.set('old');
    vi.advanceTimersByTime(3000);
    c.set('new');
    vi.advanceTimersByTime(3000);
    expect(c.get()).toBe('new');
  });

  it('TTL=0 — немедленное истечение', () => {
    const c = new SingleCache<string>(0);
    c.set('v');
    expect(c.get()).toBeNull();
  });

  it('TTL=1 — истекает через 1ms', () => {
    const c = new SingleCache<string>(1);
    c.set('v');
    vi.advanceTimersByTime(1);
    expect(c.get()).toBeNull();
  });
});

describe('SingleCache — age', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('возвращает -1 когда пусто', () => {
    const c = new SingleCache<string>(60_000);
    expect(c.age()).toBe(-1);
  });

  it('возвращает 0 сразу после set', () => {
    const c = new SingleCache<string>(60_000);
    c.set('v');
    expect(c.age()).toBe(0);
  });

  it('возвращает корректный возраст', () => {
    const c = new SingleCache<string>(60_000);
    c.set('v');
    vi.advanceTimersByTime(7000);
    expect(c.age()).toBe(7);
  });

  it('возвращает -1 после clear', () => {
    const c = new SingleCache<string>(60_000);
    c.set('v');
    c.clear();
    expect(c.age()).toBe(-1);
  });

  it('age после перезаписи отражает время последнего set', () => {
    const c = new SingleCache<string>(60_000);
    c.set('v1');
    vi.advanceTimersByTime(5000);
    c.set('v2');
    expect(c.age()).toBe(0);
  });

  it('age учитывает null-значение — возвращает -1', () => {
    const c = new SingleCache<string>(1000);
    c.set('v');
    vi.advanceTimersByTime(1001);
    c.get(); // Внутреннее обнуление при expired
    expect(c.age()).toBe(-1);
  });
});

// ─── Rate Limiter ────────────────────────────────────────────────────────────

// Динамический импорт для чистого store
async function freshRateLimiter() {
  vi.resetModules();
  return await import('./rate-limiter.js');
}

describe('checkRateLimit — базовое поведение', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('первый запрос разрешён', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkRateLimit('user:1', 'api');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(59);
  });

  it('remaining уменьшается с каждым запросом', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('user:1', 'api');
    const r = rl.checkRateLimit('user:1', 'api');
    expect(r.remaining).toBe(58);
  });

  it('запрос отклонён при достижении лимита api(60)', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 60; i++) rl.checkRateLimit('user:1', 'api');
    const r = rl.checkRateLimit('user:1', 'api');
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('resetIn > 0 при отклонении', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 60; i++) rl.checkRateLimit('user:x', 'api');
    const r = rl.checkRateLimit('user:x', 'api');
    expect(r.resetIn).toBeGreaterThan(0);
  });

  it('окно сбрасывается после windowMs', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 60; i++) rl.checkRateLimit('user:1', 'api');
    vi.advanceTimersByTime(60_001);
    const r = rl.checkRateLimit('user:1', 'api');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(59);
  });

  it('разные ключи — независимые лимиты', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 60; i++) rl.checkRateLimit('user:A', 'api');
    const rA = rl.checkRateLimit('user:A', 'api');
    const rB = rl.checkRateLimit('user:B', 'api');
    expect(rA.allowed).toBe(false);
    expect(rB.allowed).toBe(true);
  });
});

describe('checkRateLimit — все типы лимитов', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  const typeMaxMap: Array<[string, number]> = [
    ['api', 60],
    ['chat', 30],
    ['telegram', 20],
    ['admin', 100],
    ['sensitive', 10],
    ['ip', 30],
  ];

  it.each(typeMaxMap)('тип %s — первый запрос remaining=%d-1', async (type, max) => {
    const rl = await freshRateLimiter();
    const r = rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(max - 1);
  });

  it.each(typeMaxMap)('тип %s — %d запросов исчерпывают лимит', async (type, max) => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < max; i++) rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    const r = rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    expect(r.allowed).toBe(false);
  });

  it.each(typeMaxMap)('тип %s — после сброса окна снова разрешён', async (type, max) => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < max; i++) rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    vi.advanceTimersByTime(60_001);
    const r = rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    expect(r.allowed).toBe(true);
  });

  it.each(typeMaxMap)('тип %s — remaining=0 при превышении', async (type, max) => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < max; i++) rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    const r = rl.checkRateLimit(`key:${type}`, type as import('./rate-limiter.js').RateLimitType);
    expect(r.remaining).toBe(0);
  });
});

describe('rateLimitHook — HTTP-хук', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  function createMockReqReply(ip = '1.2.3.4') {
    const headers: Record<string, string> = {};
    const request = { ip, headers: {} as Record<string, string | string[] | undefined> };
    const sendFn = vi.fn();
    const reply = {
      header: vi.fn((name: string, value: string) => { headers[name] = value; }),
      code: vi.fn(() => ({ send: sendFn })),
    };
    return { request, reply, headers, sendFn };
  }

  it('устанавливает X-RateLimit-Limit заголовок', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('api');
    const { request, reply, headers } = createMockReqReply();
    await hook(request, reply as never);
    expect(headers['X-RateLimit-Limit']).toBe('60');
  });

  it('устанавливает X-RateLimit-Remaining заголовок', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('api');
    const { request, reply, headers } = createMockReqReply();
    await hook(request, reply as never);
    expect(headers['X-RateLimit-Remaining']).toBe('59');
  });

  it('устанавливает X-RateLimit-Reset заголовок', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('api');
    const { request, reply, headers } = createMockReqReply();
    await hook(request, reply as never);
    expect(headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('возвращает 429 при превышении лимита', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('sensitive');
    const { request, reply, sendFn } = createMockReqReply();
    for (let i = 0; i < 10; i++) await hook(request, reply as never);
    await hook(request, reply as never);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(sendFn).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Too Many Requests' }));
  });

  it('устанавливает Retry-After при 429', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('sensitive');
    const { request, reply, headers } = createMockReqReply();
    for (let i = 0; i < 10; i++) await hook(request, reply as never);
    await hook(request, reply as never);
    expect(headers['Retry-After']).toBeDefined();
  });

  it.each([
    ['api', '60'],
    ['chat', '30'],
    ['telegram', '20'],
    ['admin', '100'],
    ['sensitive', '10'],
    ['ip', '30'],
  ] as const)('тип %s — X-RateLimit-Limit = %s', async (type, expectedLimit) => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook(type as import('./rate-limiter.js').RateLimitType);
    const { request, reply, headers } = createMockReqReply(`${type}.1.2.3`);
    await hook(request, reply as never);
    expect(headers['X-RateLimit-Limit']).toBe(expectedLimit);
  });

  it('x-forwarded-for используется как идентификатор', async () => {
    const rl = await freshRateLimiter();
    const hook = rl.rateLimitHook('api');
    const { request, reply } = createMockReqReply();
    request.headers['x-forwarded-for'] = '10.0.0.1, 10.0.0.2';
    await hook(request, reply as never);
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBeGreaterThan(0);
  });
});

describe('checkTelegramRateLimit', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('разрешает при первом запросе', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkTelegramRateLimit('123');
    expect(r.allowed).toBe(true);
  });

  it('нет message при разрешении', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkTelegramRateLimit('123');
    expect(r.message).toBeUndefined();
  });

  it('отклоняет при 20+ сообщениях', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 20; i++) rl.checkTelegramRateLimit('456');
    const r = rl.checkTelegramRateLimit('456');
    expect(r.allowed).toBe(false);
  });

  it('message на русском при отклонении', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 20; i++) rl.checkTelegramRateLimit('789');
    const r = rl.checkTelegramRateLimit('789');
    expect(r.message).toContain('Слишком много сообщений');
  });

  it('message содержит секунды', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 20; i++) rl.checkTelegramRateLimit('111');
    const r = rl.checkTelegramRateLimit('111');
    expect(r.message).toContain('секунд');
  });

  it('принимает число как userId', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkTelegramRateLimit(999);
    expect(r.allowed).toBe(true);
  });

  it('разные userId — независимые лимиты', async () => {
    const rl = await freshRateLimiter();
    for (let i = 0; i < 20; i++) rl.checkTelegramRateLimit('aaa');
    const ra = rl.checkTelegramRateLimit('aaa');
    const rb = rl.checkTelegramRateLimit('bbb');
    expect(ra.allowed).toBe(false);
    expect(rb.allowed).toBe(true);
  });
});

describe('cleanupRateLimitStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('удаляет просроченные записи', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('old:1', 'api');
    vi.advanceTimersByTime(200_000);
    rl.cleanupRateLimitStore();
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBe(0);
  });

  it('сохраняет активные записи', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('fresh:1', 'api');
    rl.cleanupRateLimitStore();
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBe(1);
  });

  it('удаляет только старые записи, свежие остаются', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('old:1', 'api');
    vi.advanceTimersByTime(200_000);
    rl.checkRateLimit('fresh:1', 'api');
    rl.cleanupRateLimitStore();
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBe(1);
  });
});

describe('getRateLimitStats', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('totalEntries отражает количество записей', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('api:1', 'api');
    rl.checkRateLimit('chat:1', 'chat');
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBe(2);
  });

  it('byType корректно считает по типам', async () => {
    const rl = await freshRateLimiter();
    rl.checkRateLimit('api:1', 'api');
    rl.checkRateLimit('api:2', 'api');
    rl.checkRateLimit('chat:1', 'chat');
    const stats = rl.getRateLimitStats();
    expect(stats.byType.api).toBe(2);
    expect(stats.byType.chat).toBe(1);
    expect(stats.byType.telegram).toBe(0);
  });

  it('пустой store — все нули', async () => {
    const rl = await freshRateLimiter();
    const stats = rl.getRateLimitStats();
    expect(stats.totalEntries).toBe(0);
    expect(Object.values(stats.byType).every(v => v === 0)).toBe(true);
  });
});

describe('createRateLimitKey', () => {
  afterEach(() => { vi.resetModules(); });

  it('формирует ключ type:identifier', async () => {
    const rl = await freshRateLimiter();
    expect(rl.createRateLimitKey('user123', 'api')).toBe('api:user123');
  });

  it.each([
    ['telegram', '456', 'telegram:456'],
    ['chat', 'u1', 'chat:u1'],
    ['admin', 'admin-ip', 'admin:admin-ip'],
    ['sensitive', 'x', 'sensitive:x'],
    ['ip', '10.0.0.1', 'ip:10.0.0.1'],
  ] as const)('тип=%s id=%s → %s', async (type, id, expected) => {
    const rl = await freshRateLimiter();
    expect(rl.createRateLimitKey(id, type as import('./rate-limiter.js').RateLimitType)).toBe(expected);
  });
});

describe('Rate Limiter — граничные случаи', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('пустой ключ допустим', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkRateLimit('', 'api');
    expect(r.allowed).toBe(true);
  });

  it('100 запросов за 1ms', async () => {
    const rl = await freshRateLimiter();
    let denied = 0;
    for (let i = 0; i < 100; i++) {
      const r = rl.checkRateLimit('rapid', 'api');
      if (!r.allowed) denied++;
    }
    expect(denied).toBe(40); // 60 разрешены, 40 отклонены
  });

  it('тип по умолчанию — api', async () => {
    const rl = await freshRateLimiter();
    const r = rl.checkRateLimit('user:default');
    expect(r.remaining).toBe(59);
  });
});

describe('startCleanupInterval / stopCleanupInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  it('startCleanupInterval не выбрасывает ошибку', async () => {
    const rl = await freshRateLimiter();
    expect(() => rl.startCleanupInterval()).not.toThrow();
    rl.stopCleanupInterval();
  });

  it('stopCleanupInterval не выбрасывает ошибку', async () => {
    const rl = await freshRateLimiter();
    expect(() => rl.stopCleanupInterval()).not.toThrow();
  });

  it('повторный startCleanupInterval безопасен', async () => {
    const rl = await freshRateLimiter();
    rl.startCleanupInterval();
    rl.startCleanupInterval();
    rl.stopCleanupInterval();
  });
});

// ─── Error Handler ───────────────────────────────────────────────────────────

describe('AppError', () => {
  it('хранит code и message', () => {
    const e = new AppError('ERR_CODE', 'msg');
    expect(e.code).toBe('ERR_CODE');
    expect(e.message).toBe('msg');
  });

  it('хранит originalError', () => {
    const orig = new Error('orig');
    const e = new AppError('CODE', 'msg', orig);
    expect(e.originalError).toBe(orig);
  });

  it('name = AppError', () => {
    expect(new AppError('C', 'M').name).toBe('AppError');
  });

  it('instanceof Error', () => {
    expect(new AppError('C', 'M')).toBeInstanceOf(Error);
  });

  it('instanceof AppError', () => {
    expect(new AppError('C', 'M')).toBeInstanceOf(AppError);
  });

  it('originalError по умолчанию undefined', () => {
    expect(new AppError('C', 'M').originalError).toBeUndefined();
  });
});

describe('NotFoundError', () => {
  it('name = NotFoundError', () => {
    expect(new NotFoundError('nf').name).toBe('NotFoundError');
  });

  it('instanceof Error', () => {
    expect(new NotFoundError('nf')).toBeInstanceOf(Error);
  });

  it('сохраняет message', () => {
    expect(new NotFoundError('msg').message).toBe('msg');
  });
});

describe('ValidationError', () => {
  it('name = ValidationError', () => {
    expect(new ValidationError('ve').name).toBe('ValidationError');
  });

  it('instanceof Error', () => {
    expect(new ValidationError('ve')).toBeInstanceOf(Error);
  });

  it('сохраняет message', () => {
    expect(new ValidationError('msg').message).toBe('msg');
  });
});

describe('DatabaseError', () => {
  it('name = DatabaseError', () => {
    expect(new DatabaseError('de').name).toBe('DatabaseError');
  });

  it('instanceof Error', () => {
    expect(new DatabaseError('de')).toBeInstanceOf(Error);
  });

  it('хранит originalError', () => {
    const orig = new Error('pg');
    const e = new DatabaseError('fail', orig);
    expect(e.originalError).toBe(orig);
  });

  it('originalError по умолчанию undefined', () => {
    expect(new DatabaseError('fail').originalError).toBeUndefined();
  });
});

describe('AIError', () => {
  it('name = AIError', () => {
    expect(new AIError('ai').name).toBe('AIError');
  });

  it('instanceof Error', () => {
    expect(new AIError('ai')).toBeInstanceOf(Error);
  });

  it('хранит originalError', () => {
    const orig = new Error('openai');
    const e = new AIError('fail', orig);
    expect(e.originalError).toBe(orig);
  });
});

describe('isAppError', () => {
  it('true для AppError', () => {
    expect(isAppError(new AppError('C', 'M'))).toBe(true);
  });

  it('false для обычного Error', () => {
    expect(isAppError(new Error('e'))).toBe(false);
  });

  it('false для NotFoundError', () => {
    expect(isAppError(new NotFoundError('nf'))).toBe(false);
  });

  it('false для null', () => {
    expect(isAppError(null)).toBe(false);
  });

  it('false для undefined', () => {
    expect(isAppError(undefined)).toBe(false);
  });

  it('false для строки', () => {
    expect(isAppError('error')).toBe(false);
  });

  it('false для объекта с полем code', () => {
    expect(isAppError({ code: 'ERR', message: 'msg' })).toBe(false);
  });
});

describe('getErrorCode', () => {
  it('извлекает code из AppError', () => {
    expect(getErrorCode(new AppError('MY_CODE', 'msg'))).toBe('MY_CODE');
  });

  it('undefined для обычного Error', () => {
    expect(getErrorCode(new Error('e'))).toBeUndefined();
  });

  it('извлекает code из объекта с полем code', () => {
    expect(getErrorCode({ code: 'OBJ_CODE' })).toBe('OBJ_CODE');
  });

  it('undefined для null', () => {
    expect(getErrorCode(null)).toBeUndefined();
  });

  it('undefined для строки', () => {
    expect(getErrorCode('err')).toBeUndefined();
  });

  it('преобразует числовой code в строку', () => {
    expect(getErrorCode({ code: 404 })).toBe('404');
  });
});

describe('isNotFoundError', () => {
  it('true для code=not_found', () => {
    expect(isNotFoundError({ code: 'not_found' })).toBe(true);
  });

  it('true для code=user_not_found', () => {
    expect(isNotFoundError({ code: 'user_not_found' })).toBe(true);
  });

  it('true для code=document_not_found', () => {
    expect(isNotFoundError({ code: 'document_not_found' })).toBe(true);
  });

  it('false для code=not_authorized', () => {
    expect(isNotFoundError({ code: 'not_authorized' })).toBe(false);
  });

  it('false для null', () => {
    expect(isNotFoundError(null)).toBe(false);
  });

  it('false для Error без code', () => {
    expect(isNotFoundError(new Error('not_found'))).toBe(false);
  });

  it('false для числового code', () => {
    expect(isNotFoundError({ code: 404 })).toBe(false);
  });

  it('false для пустого объекта', () => {
    expect(isNotFoundError({})).toBe(false);
  });
});

describe('handleAIError', () => {
  it('выбрасывает AIError из Error', () => {
    expect(() => handleAIError(new Error('fail'), { operation: 'test' }))
      .toThrow(AIError);
  });

  it('выбрасывает AIError из не-Error объекта', () => {
    expect(() => handleAIError('string error', { operation: 'test' }))
      .toThrow(AIError);
  });

  it('message содержит operation', () => {
    try {
      handleAIError(new Error('x'), { operation: 'generateText' });
    } catch (e) {
      expect((e as AIError).message).toContain('generateText');
    }
  });

  it('originalError ссылается на исходную ошибку', () => {
    const orig = new Error('orig');
    try {
      handleAIError(orig, { operation: 'op' });
    } catch (e) {
      expect((e as AIError).originalError).toBe(orig);
    }
  });

  it('never — после вызова код не выполняется', () => {
    let reached = false;
    try {
      handleAIError(new Error('e'), { operation: 'op' });
      reached = true;
    } catch {
      // expected
    }
    expect(reached).toBe(false);
  });
});

describe('safeStringify', () => {
  it('сериализует простой объект', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('обрабатывает циклические ссылки', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(safeStringify(obj)).toContain('[Circular]');
  });

  it('сериализует null', () => {
    expect(safeStringify(null)).toBe('null');
  });

  it('сериализует undefined как undefined', () => {
    expect(safeStringify(undefined)).toBeUndefined();
  });

  it('сериализует строку', () => {
    expect(safeStringify('hello')).toBe('"hello"');
  });

  it('сериализует число', () => {
    expect(safeStringify(42)).toBe('42');
  });

  it('сериализует массив', () => {
    expect(safeStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('сериализует вложенные объекты', () => {
    expect(safeStringify({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":1}}}');
  });

  it('обрабатывает глубоко вложенный объект (100 уровней)', () => {
    let obj: Record<string, unknown> = { val: 'leaf' };
    for (let i = 0; i < 100; i++) obj = { nested: obj };
    expect(() => safeStringify(obj)).not.toThrow();
  });

  it('сериализует массив с 10000 элементов', () => {
    const arr = Array.from({ length: 10000 }, (_, i) => i);
    const result = safeStringify(arr);
    expect(result).toBeDefined();
    expect(JSON.parse(result!)).toHaveLength(10000);
  });

  it('функция как значение удаляется', () => {
    const result = safeStringify({ fn: () => {} });
    expect(result).toBe('{}');
  });

  it('Symbol как значение удаляется', () => {
    const result = safeStringify({ s: Symbol('test') });
    expect(result).toBe('{}');
  });

  it('boolean сериализуется', () => {
    expect(safeStringify(true)).toBe('true');
    expect(safeStringify(false)).toBe('false');
  });

  it('пустой объект', () => {
    expect(safeStringify({})).toBe('{}');
  });

  it('пустой массив', () => {
    expect(safeStringify([])).toBe('[]');
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('validateUserId', () => {
  it('допускает числовую строку', () => {
    expect(validateUserId('12345')).toBe('12345');
  });

  it('допускает "unknown"', () => {
    expect(validateUserId('unknown')).toBe('unknown');
  });

  it('допускает "0"', () => {
    expect(validateUserId('0')).toBe('0');
  });

  it('допускает длинный числовой ID', () => {
    expect(validateUserId('999999999999')).toBe('999999999999');
  });

  it.each(['', 'abc', '12.34', '-1', '12 34', 'null', ' '])(
    'отклоняет невалидный userId: "%s"',
    (val) => {
      expect(() => validateUserId(val)).toThrow('Invalid user ID');
    },
  );

  it('отклоняет userId с пробелами', () => {
    expect(() => validateUserId(' 123 ')).toThrow();
  });

  it('отклоняет userId с буквами и цифрами', () => {
    expect(() => validateUserId('abc123')).toThrow();
  });
});

describe('validateMessageContent', () => {
  it('допускает обычный текст', () => {
    expect(validateMessageContent('Hello, world!')).toBe('Hello, world!');
  });

  it('допускает один символ', () => {
    expect(validateMessageContent('a')).toBe('a');
  });

  it('допускает текст ровно MAX_MESSAGE_LENGTH', () => {
    const text = 'x'.repeat(MAX_MESSAGE_LENGTH);
    expect(validateMessageContent(text)).toBe(text);
  });

  it('отклоняет пустую строку', () => {
    expect(() => validateMessageContent('')).toThrow('Invalid message content');
  });

  it('отклоняет текст длиннее MAX_MESSAGE_LENGTH', () => {
    const text = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() => validateMessageContent(text)).toThrow(`max ${MAX_MESSAGE_LENGTH}`);
  });

  it('допускает Unicode текст', () => {
    expect(validateMessageContent('Привет мир')).toBe('Привет мир');
  });

  it('допускает эмодзи', () => {
    expect(validateMessageContent('Hello 😀🎉')).toBe('Hello 😀🎉');
  });

  it('допускает многострочный текст', () => {
    expect(validateMessageContent('line1\nline2')).toBe('line1\nline2');
  });

  it('допускает текст с пробелами', () => {
    expect(validateMessageContent('  spaced  ')).toBe('  spaced  ');
  });

  it('отклоняет только пробелы (если zod trims)', () => {
    // Zod min(1) not met for whitespace-only if not trimmed; depends on schema
    // The schema uses min(1) without trim, so single space is valid
    expect(validateMessageContent(' ')).toBe(' ');
  });
});

describe('validateChannel', () => {
  it.each(['telegram', 'voice', 'admin', 'all'] as const)(
    'допускает канал "%s"',
    (ch) => {
      expect(validateChannel(ch)).toBe(ch);
    },
  );

  it.each(['email', 'sms', 'web', '', 'Telegram', 'VOICE'])(
    'отклоняет невалидный канал "%s"',
    (ch) => {
      expect(() => validateChannel(ch)).toThrow('Invalid channel');
    },
  );
});

describe('validateEventType', () => {
  const validTypes = [
    'message_received',
    'message_sent',
    'call_started',
    'call_ended',
    'ai_response',
    'error',
    'warning',
    'settings_updated',
    'prompt_updated',
    'rate_limit_exceeded',
    'api_request',
    'system_log',
  ];

  it.each(validTypes)('допускает тип "%s"', (t) => {
    expect(validateEventType(t)).toBe(t);
  });

  it.each(['unknown', '', 'Message_Received', 'click', 'login'])(
    'отклоняет невалидный тип "%s"',
    (t) => {
      expect(() => validateEventType(t)).toThrow('Invalid event type');
    },
  );
});

describe('validateLimit', () => {
  it('допускает значение в диапазоне', () => {
    expect(validateLimit(50)).toBe(50);
  });

  it('допускает min = 1 (по умолчанию)', () => {
    expect(validateLimit(1)).toBe(1);
  });

  it('допускает max = 1000 (по умолчанию)', () => {
    expect(validateLimit(1000)).toBe(1000);
  });

  it('отклоняет 0 (ниже min)', () => {
    expect(() => validateLimit(0)).toThrow('Limit must be between');
  });

  it('отклоняет 1001 (выше max)', () => {
    expect(() => validateLimit(1001)).toThrow('Limit must be between');
  });

  it('отклоняет NaN', () => {
    expect(() => validateLimit(NaN)).toThrow('Limit must be between');
  });

  it('отклоняет Infinity', () => {
    expect(() => validateLimit(Infinity)).toThrow('Limit must be between');
  });

  it('отклоняет -Infinity', () => {
    expect(() => validateLimit(-Infinity)).toThrow('Limit must be between');
  });

  it('отклоняет отрицательное число', () => {
    expect(() => validateLimit(-5)).toThrow('Limit must be between');
  });

  it('допускает пользовательский min/max', () => {
    expect(validateLimit(5, 1, 10)).toBe(5);
  });

  it('отклоняет ниже пользовательского min', () => {
    expect(() => validateLimit(0, 1, 10)).toThrow('Limit must be between 1 and 10');
  });

  it('отклоняет выше пользовательского max', () => {
    expect(() => validateLimit(11, 1, 10)).toThrow('Limit must be between 1 and 10');
  });

  it('допускает дробное значение в диапазоне', () => {
    expect(validateLimit(1.5)).toBe(1.5);
  });
});

describe('checkArraySize', () => {
  it('не бросает если массив в пределах лимита', () => {
    expect(() => checkArraySize([1, 2, 3], 5, 'too big')).not.toThrow();
  });

  it('не бросает если массив ровно на границе', () => {
    expect(() => checkArraySize([1, 2, 3], 3, 'too big')).not.toThrow();
  });

  it('бросает если массив превышает лимит', () => {
    expect(() => checkArraySize([1, 2, 3, 4], 3, 'too big')).toThrow('too big');
  });

  it('пустой массив всегда допустим', () => {
    expect(() => checkArraySize([], 0, 'err')).not.toThrow();
  });

  it('пользовательское сообщение ошибки', () => {
    expect(() => checkArraySize([1, 2], 1, 'Превышен лимит массива'))
      .toThrow('Превышен лимит массива');
  });

  it('массив из 100 элементов при лимите 50', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    expect(() => checkArraySize(arr, 50, 'overflow')).toThrow('overflow');
  });

  it('массив из 100 элементов при лимите 100', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    expect(() => checkArraySize(arr, 100, 'overflow')).not.toThrow();
  });

  it('массив из 101 элемента при лимите 100', () => {
    const arr = Array.from({ length: 101 }, (_, i) => i);
    expect(() => checkArraySize(arr, 100, 'overflow')).toThrow('overflow');
  });
});
