/**
 * Database Logger - записывает логи warn/error/fatal в Supabase
 * 
 * Интегрируется с pino для автоматической записи важных логов в БД
 */

import { getSupabase } from '../db/supabase.js';
import type { SystemLog, LogLevel } from '../../../shared/types/index.js';

// Очередь логов для batch insert
let logQueue: Omit<SystemLog, 'id'>[] = [];
let flushTimeout: NodeJS.Timeout | null = null;

// Конфигурация
const CONFIG = {
  // Минимальный уровень для записи в БД
  minLevel: 'warn' as LogLevel,
  // Интервал flush в мс
  flushInterval: 5000,
  // Максимальный размер очереди
  maxQueueSize: 100,
  // Включить логирование в БД
  enabled: process.env.NODE_ENV !== 'test',
};

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/**
 * Проверить, нужно ли логировать этот уровень в БД
 */
function shouldLogToDb(level: LogLevel): boolean {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[CONFIG.minLevel];
}

/**
 * Добавить лог в очередь
 */
export function queueLog(log: Omit<SystemLog, 'id'>): void {
  if (!CONFIG.enabled) return;
  if (!shouldLogToDb(log.level)) return;

  logQueue.push(log);

  // Если очередь переполнена - сразу flush
  if (logQueue.length >= CONFIG.maxQueueSize) {
    flushLogs();
    return;
  }

  // Запланировать flush если ещё не запланирован
  if (!flushTimeout) {
    flushTimeout = setTimeout(flushLogs, CONFIG.flushInterval);
  }
}

/**
 * Записать все логи из очереди в БД
 */
export async function flushLogs(): Promise<void> {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  if (logQueue.length === 0) return;

  const logsToInsert = [...logQueue];
  logQueue = [];

  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('system_logs')
      .insert(logsToInsert);

    if (error) {
      // Не можем залогировать в БД - выводим в консоль
      console.error('[DB Logger] Failed to insert logs:', error.message);
      // Возвращаем логи обратно в очередь (до лимита)
      logQueue = [...logsToInsert.slice(0, 50), ...logQueue.slice(0, 50)];
    }
  } catch (err) {
    console.error('[DB Logger] Exception during flush:', err);
  }
}

/**
 * Создать лог из pino объекта (экспорт для тестов)
 */
export function createLogFromPino(
  pinoLog: Record<string, unknown>
): Omit<SystemLog, 'id'> {
  const level = mapPinoLevel(pinoLog.level as number);
  const module = (pinoLog.module as string) || 'unknown';
  const msg = (pinoLog.msg as string) || '';
  
  // Извлечь error stack если есть
  let errorStack: string | undefined;
  if (pinoLog.err && typeof pinoLog.err === 'object') {
    const err = pinoLog.err as { stack?: string; message?: string };
    errorStack = err.stack;
  }
  if (pinoLog.error && typeof pinoLog.error === 'object') {
    const err = pinoLog.error as { stack?: string };
    errorStack = errorStack || err.stack;
  }

  // Собрать дополнительные данные
  const data: Record<string, unknown> = {};
  const excludeKeys = ['level', 'time', 'pid', 'hostname', 'msg', 'module', 'err', 'error', 'v'];
  
  for (const [key, value] of Object.entries(pinoLog)) {
    if (!excludeKeys.includes(key)) {
      data[key] = value;
    }
  }

  return {
    level,
    module,
    message: msg,
    data: Object.keys(data).length > 0 ? data : undefined,
    error_stack: errorStack,
    user_id: pinoLog.userId as string | undefined,
    request_id: pinoLog.requestId as string | undefined,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Маппинг pino level numbers в наши уровни
 */
function mapPinoLevel(level: number): LogLevel {
  if (level <= 10) return 'debug';
  if (level <= 20) return 'info';
  if (level <= 30) return 'warn';
  if (level <= 40) return 'error';
  return 'fatal';
}

/**
 * Прямой метод для логирования ошибки в БД
 */
export function logError(
  module: string,
  message: string,
  error?: Error | unknown,
  data?: Record<string, unknown>,
  userId?: string
): void {
  const log: Omit<SystemLog, 'id'> = {
    level: 'error',
    module,
    message,
    data,
    error_stack: error instanceof Error ? error.stack : undefined,
    user_id: userId,
    timestamp: new Date().toISOString(),
  };

  queueLog(log);
}

/**
 * Прямой метод для логирования предупреждения в БД
 */
export function logWarning(
  module: string,
  message: string,
  data?: Record<string, unknown>,
  userId?: string
): void {
  const log: Omit<SystemLog, 'id'> = {
    level: 'warn',
    module,
    message,
    data,
    user_id: userId,
    timestamp: new Date().toISOString(),
  };

  queueLog(log);
}

/**
 * Прямой метод для логирования fatal ошибки в БД
 */
export function logFatal(
  module: string,
  message: string,
  error?: Error | unknown,
  data?: Record<string, unknown>
): void {
  const log: Omit<SystemLog, 'id'> = {
    level: 'fatal',
    module,
    message,
    data,
    error_stack: error instanceof Error ? error.stack : undefined,
    timestamp: new Date().toISOString(),
  };

  queueLog(log);
  
  // Fatal - сразу flush
  flushLogs();
}

/**
 * Получить логи из БД
 */
export async function getLogs(params: {
  level?: LogLevel;
  module?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<SystemLog[]> {
  const supabase = getSupabase();
  
  let query = supabase
    .from('system_logs')
    .select('*')
    .order('timestamp', { ascending: false });

  if (params.level) {
    query = query.eq('level', params.level);
  }
  if (params.module) {
    query = query.eq('module', params.module);
  }
  if (params.from) {
    query = query.gte('timestamp', params.from.toISOString());
  }
  if (params.to) {
    query = query.lte('timestamp', params.to.toISOString());
  }
  if (params.limit) {
    query = query.limit(params.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[DB Logger] Failed to get logs:', error.message);
    return [];
  }

  return (data ?? []) as SystemLog[];
}

/**
 * Получить статистику логов
 */
export async function getLogStats(from: Date, to: Date): Promise<{
  total: number;
  byLevel: Record<LogLevel, number>;
  byModule: Record<string, number>;
}> {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('system_logs')
    .select('level, module')
    .gte('timestamp', from.toISOString())
    .lte('timestamp', to.toISOString());

  if (error) {
    console.error('[DB Logger] Failed to get log stats:', error.message);
    return {
      total: 0,
      byLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
      byModule: {},
    };
  }

  const logs = data ?? [];
  const byLevel: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
  const byModule: Record<string, number> = {};

  for (const log of logs) {
    const level = log.level as LogLevel;
    const module = log.module as string;
    
    byLevel[level] = (byLevel[level] || 0) + 1;
    byModule[module] = (byModule[module] || 0) + 1;
  }

  return {
    total: logs.length,
    byLevel,
    byModule,
  };
}

// Flush при завершении процесса
process.on('beforeExit', () => {
  flushLogs();
});

process.on('SIGTERM', () => {
  flushLogs();
});

process.on('SIGINT', () => {
  flushLogs();
});
