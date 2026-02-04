/**
 * Rate Limiter - ограничение частоты запросов
 * 
 * Использует sliding window алгоритм для точного подсчёта
 */

import { serverLogger } from '../config/logger.js';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  windowMs: number;      // Окно времени в миллисекундах
  maxRequests: number;   // Максимум запросов в окне
}

// Хранилище для rate limiting (в памяти)
// В production можно заменить на Redis
const rateLimitStore = new Map<string, RateLimitEntry>();

// Конфигурации для разных типов лимитов
export const RATE_LIMIT_CONFIGS = {
  // API endpoints
  api: {
    windowMs: 60 * 1000,  // 1 минута
    maxRequests: 60,       // 60 запросов в минуту
  },
  // Chat API (более строгий)
  chat: {
    windowMs: 60 * 1000,  // 1 минута
    maxRequests: 30,       // 30 сообщений в минуту
  },
  // Telegram messages per user
  telegram: {
    windowMs: 60 * 1000,  // 1 минута
    maxRequests: 20,       // 20 сообщений в минуту
  },
  // Admin panel
  admin: {
    windowMs: 60 * 1000,  // 1 минута
    maxRequests: 100,      // 100 запросов в минуту
  },
} as const;

export type RateLimitType = keyof typeof RATE_LIMIT_CONFIGS;

/**
 * Проверить и обновить rate limit для ключа
 * @returns true если запрос разрешён, false если превышен лимит
 */
export function checkRateLimit(
  key: string,
  type: RateLimitType = 'api'
): { allowed: boolean; remaining: number; resetIn: number } {
  const config = RATE_LIMIT_CONFIGS[type];
  const now = Date.now();
  
  // Получить или создать запись
  let entry = rateLimitStore.get(key);
  
  if (!entry || now - entry.windowStart >= config.windowMs) {
    // Новое окно
    entry = { count: 1, windowStart: now };
    rateLimitStore.set(key, entry);
    
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetIn: config.windowMs,
    };
  }
  
  // Проверить лимит
  if (entry.count >= config.maxRequests) {
    const resetIn = config.windowMs - (now - entry.windowStart);
    
    serverLogger.warn({
      key,
      type,
      count: entry.count,
      maxRequests: config.maxRequests,
      resetIn,
    }, 'Rate limit exceeded');
    
    return {
      allowed: false,
      remaining: 0,
      resetIn,
    };
  }
  
  // Увеличить счётчик
  entry.count++;
  
  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetIn: config.windowMs - (now - entry.windowStart),
  };
}

/**
 * Создать ключ для rate limiting
 */
export function createRateLimitKey(
  identifier: string,
  type: RateLimitType
): string {
  return `${type}:${identifier}`;
}

/**
 * Очистить устаревшие записи (вызывать периодически)
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, entry] of rateLimitStore.entries()) {
    // Найти максимальное окно
    const maxWindow = Math.max(
      ...Object.values(RATE_LIMIT_CONFIGS).map(c => c.windowMs)
    );
    
    if (now - entry.windowStart > maxWindow * 2) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    serverLogger.debug({ cleaned }, 'Rate limit store cleanup');
  }
}

// Запустить очистку каждые 5 минут
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

/**
 * Fastify hook для rate limiting
 */
export function rateLimitHook(type: RateLimitType = 'api') {
  return async (request: { ip: string; headers: Record<string, string | string[] | undefined> }, reply: { code: (code: number) => { send: (body: unknown) => void }; header: (name: string, value: string) => void }) => {
    // Получить идентификатор клиента
    const clientId = 
      request.headers['x-forwarded-for']?.toString().split(',')[0] ||
      request.ip ||
      'unknown';
    
    const key = createRateLimitKey(clientId, type);
    const result = checkRateLimit(key, type);
    
    // Добавить заголовки rate limit
    reply.header('X-RateLimit-Limit', RATE_LIMIT_CONFIGS[type].maxRequests.toString());
    reply.header('X-RateLimit-Remaining', result.remaining.toString());
    reply.header('X-RateLimit-Reset', Math.ceil(result.resetIn / 1000).toString());
    
    if (!result.allowed) {
      reply.header('Retry-After', Math.ceil(result.resetIn / 1000).toString());
      return reply.code(429).send({
        success: false,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.ceil(result.resetIn / 1000)} seconds.`,
        retryAfter: Math.ceil(result.resetIn / 1000),
      });
    }
  };
}

/**
 * Проверить rate limit для Telegram пользователя
 */
export function checkTelegramRateLimit(userId: string | number): {
  allowed: boolean;
  message?: string;
} {
  const key = createRateLimitKey(String(userId), 'telegram');
  const result = checkRateLimit(key, 'telegram');
  
  if (!result.allowed) {
    return {
      allowed: false,
      message: `⏳ Слишком много сообщений. Подожди ${Math.ceil(result.resetIn / 1000)} секунд.`,
    };
  }
  
  return { allowed: true };
}

/**
 * Получить статистику rate limiting
 */
export function getRateLimitStats(): {
  totalEntries: number;
  byType: Record<RateLimitType, number>;
} {
  const byType: Record<RateLimitType, number> = {
    api: 0,
    chat: 0,
    telegram: 0,
    admin: 0,
  };
  
  for (const key of rateLimitStore.keys()) {
    const type = key.split(':')[0] as RateLimitType;
    if (type in byType) {
      byType[type]++;
    }
  }
  
  return {
    totalEntries: rateLimitStore.size,
    byType,
  };
}
