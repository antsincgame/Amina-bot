/**
 * Database Logger — dual backend (Appwrite primary)
 * Записывает логи warn/error/fatal в БД
 */

import { config } from './index.js';
import { getSupabase } from '../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { SystemLog, LogLevel } from '../../../shared/types/index.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_system_logs';

let logQueue: Omit<SystemLog, 'id'>[] = [];
let flushTimeout: NodeJS.Timeout | null = null;

const CONFIG = {
  minLevel: 'warn' as LogLevel,
  flushInterval: 5000,
  maxQueueSize: 100,
  enabled: process.env.NODE_ENV !== 'test',
};

const LEVEL_VALUES: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

function shouldLogToDb(level: LogLevel): boolean {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[CONFIG.minLevel];
}

export function queueLog(log: Omit<SystemLog, 'id'>): void {
  if (!CONFIG.enabled || !shouldLogToDb(log.level)) return;
  logQueue.push(log);
  if (logQueue.length >= CONFIG.maxQueueSize) { flushLogs(); return; }
  if (!flushTimeout) flushTimeout = setTimeout(flushLogs, CONFIG.flushInterval);
}

export async function flushLogs(): Promise<void> {
  if (flushTimeout) { clearTimeout(flushTimeout); flushTimeout = null; }
  if (logQueue.length === 0) return;

  const logsToInsert = [...logQueue];
  logQueue = [];

  try {
    if (useAW()) {
      const aw = await getAW();
      // Batch insert — create docs one by one (Appwrite has no batch insert)
      const promises = logsToInsert.slice(0, 50).map(log =>
        aw.createDocument(DB_ID(), COLL, ID.unique(), {
          level: log.level,
          module: log.module,
          message: (log.message || '').slice(0, 10000),
          data: log.data ? JSON.stringify(log.data).slice(0, 100000) : null,
          error_stack: log.error_stack?.slice(0, 50000) || null,
          user_id: log.user_id || null,
          request_id: log.request_id || null,
          timestamp: log.timestamp || new Date().toISOString(),
        }).catch(() => {})
      );
      await Promise.allSettled(promises);
    } else {
      const { error } = await getSupabase().from('system_logs').insert(logsToInsert);
      if (error) {
        process.stderr.write(`[DB Logger] Failed to insert logs: ${error.message}\n`);
        logQueue = [...logsToInsert.slice(0, 50), ...logQueue.slice(0, 50)];
      }
    }
  } catch (err) {
    process.stderr.write(`[DB Logger] Exception during flush: ${err}\n`);
  }
}

export function createLogFromPino(pinoLog: Record<string, unknown>): Omit<SystemLog, 'id'> {
  const level = mapPinoLevel(pinoLog.level as number);
  const module = (pinoLog.module as string) || 'unknown';
  const msg = (pinoLog.msg as string) || '';

  let errorStack: string | undefined;
  if (pinoLog.err && typeof pinoLog.err === 'object') errorStack = (pinoLog.err as { stack?: string }).stack;
  if (pinoLog.error && typeof pinoLog.error === 'object') errorStack = errorStack || (pinoLog.error as { stack?: string }).stack;

  const data: Record<string, unknown> = {};
  const excludeKeys = ['level', 'time', 'pid', 'hostname', 'msg', 'module', 'err', 'error', 'v'];
  for (const [key, value] of Object.entries(pinoLog)) {
    if (!excludeKeys.includes(key)) data[key] = value;
  }

  return {
    level, module, message: msg,
    data: Object.keys(data).length > 0 ? data : undefined,
    error_stack: errorStack,
    user_id: pinoLog.userId as string | undefined,
    request_id: pinoLog.requestId as string | undefined,
    timestamp: new Date().toISOString(),
  };
}

function mapPinoLevel(level: number): LogLevel {
  if (level <= 10) return 'debug';
  if (level <= 20) return 'info';
  if (level <= 30) return 'warn';
  if (level <= 40) return 'error';
  return 'fatal';
}

export function logError(module: string, message: string, error?: Error | unknown, data?: Record<string, unknown>, userId?: string): void {
  queueLog({ level: 'error', module, message, data, error_stack: error instanceof Error ? error.stack : undefined, user_id: userId, timestamp: new Date().toISOString() });
}

export function logWarning(module: string, message: string, data?: Record<string, unknown>, userId?: string): void {
  queueLog({ level: 'warn', module, message, data, user_id: userId, timestamp: new Date().toISOString() });
}

export function logFatal(module: string, message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
  queueLog({ level: 'fatal', module, message, data, error_stack: error instanceof Error ? error.stack : undefined, timestamp: new Date().toISOString() });
  flushLogs();
}

export async function getLogs(params: { level?: LogLevel; module?: string; from?: Date; to?: Date; limit?: number }): Promise<SystemLog[]> {
  try {
    if (useAW()) {
      const queries: string[] = [Query.orderDesc('timestamp')];
      if (params.level) queries.push(Query.equal('level', params.level));
      if (params.module) queries.push(Query.equal('module', params.module));
      if (params.from) queries.push(Query.greaterThanEqual('timestamp', params.from.toISOString()));
      if (params.to) queries.push(Query.lessThanEqual('timestamp', params.to.toISOString()));
      queries.push(Query.limit(params.limit || 100));
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, queries);
      return r.documents.map((d: any) => ({
        id: d.$id, level: d.level, module: d.module, message: d.message,
        data: d.data ? JSON.parse(d.data) : undefined, error_stack: d.error_stack,
        user_id: d.user_id, request_id: d.request_id, timestamp: d.timestamp,
      }));
    } else {
      let query = getSupabase().from('system_logs').select('*').order('timestamp', { ascending: false });
      if (params.level) query = query.eq('level', params.level);
      if (params.module) query = query.eq('module', params.module);
      if (params.from) query = query.gte('timestamp', params.from.toISOString());
      if (params.to) query = query.lte('timestamp', params.to.toISOString());
      if (params.limit) query = query.limit(params.limit);
      const { data, error } = await query;
      if (error) { process.stderr.write(`[DB Logger] Failed to get logs: ${error.message}\n`); return []; }
      return (data ?? []) as SystemLog[];
    }
  } catch { return []; }
}

export async function getLogStats(from: Date, to: Date): Promise<{ total: number; byLevel: Record<LogLevel, number>; byModule: Record<string, number> }> {
  const empty = { total: 0, byLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } as Record<LogLevel, number>, byModule: {} as Record<string, number> };
  try {
    let logs: Array<{ level: string; module: string }> = [];
    if (useAW()) {
      const all: any[] = []; let offset = 0;
      while (offset < 5000) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
          Query.greaterThanEqual('timestamp', from.toISOString()),
          Query.lessThanEqual('timestamp', to.toISOString()),
          Query.limit(100), Query.offset(offset),
        ]);
        all.push(...r.documents); if (r.documents.length < 100) break; offset += 100;
      }
      logs = all.map(d => ({ level: d.level, module: d.module }));
    } else {
      const { data, error } = await getSupabase().from('system_logs').select('level, module')
        .gte('timestamp', from.toISOString()).lte('timestamp', to.toISOString());
      if (error) { process.stderr.write(`[DB Logger] Failed to get stats: ${error.message}\n`); return empty; }
      logs = (data ?? []) as Array<{ level: string; module: string }>;
    }
    const byLevel = { ...empty.byLevel };
    const byModule: Record<string, number> = {};
    for (const l of logs) { byLevel[l.level as LogLevel] = (byLevel[l.level as LogLevel] || 0) + 1; byModule[l.module] = (byModule[l.module] || 0) + 1; }
    return { total: logs.length, byLevel, byModule };
  } catch { return empty; }
}

process.on('beforeExit', () => { flushLogs(); });
process.on('SIGTERM', () => { flushLogs(); });
process.on('SIGINT', () => { flushLogs(); });
