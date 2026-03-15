/**
 * User Memory Service
 * Supports both Supabase and Appwrite via config.dbBackend
 */

import { config } from '../config/index.js';
import { getSupabase } from '../db/index.js';
import { dbLogger, aiLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { ID, Query } from 'node-appwrite';

// Lazy Appwrite import
let _aw: import('node-appwrite').Databases | null = null;
async function getAW() {
  if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); }
  return _aw;
}
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';

const COLL = { profiles: 'amina_user_profiles', memory: 'amina_user_memory', logs: 'amina_user_logs' } as const;

// ---------- Types ----------

export interface UserProfile {
  id: string; user_id: string; username?: string; first_name?: string; last_name?: string;
  language_code: string; total_messages: number; total_voice_messages: number; total_images: number;
  total_tokens_used: number; first_seen_at: string; last_seen_at: string; last_message_at?: string;
  preferences: Record<string, unknown>; created_at: string; updated_at: string;
}

export interface UserMemory {
  id: string; user_id: string; memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
  content: string; source?: string; confidence: number; created_at: string; updated_at: string;
  expires_at?: string; is_active: boolean; is_pinned: boolean;
}

export interface UserLog {
  id: string; user_id: string;
  event_type: 'message' | 'voice' | 'image' | 'command' | 'ai_response' | 'error' | 'memory_created' | 'memory_updated' | 'session_start' | 'session_end';
  content?: string; metadata: Record<string, unknown>; model?: string;
  tokens_prompt?: number; tokens_completion?: number; response_time_ms?: number; timestamp: string;
}

export interface TelegramUserInfo {
  id: number; username?: string; first_name?: string; last_name?: string; language_code?: string;
}

// ---------- Helpers ----------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

let tablesExist: boolean | null = null;
let tablesExistCheckedAt = 0;
async function checkTablesExist(): Promise<boolean> {
  if (useAW()) return true;
  if (tablesExist === true) return true;
  if (tablesExist === false && Date.now() - tablesExistCheckedAt < 60_000) return false;
  try {
    const { error } = await getSupabase().from('user_profiles').select('id').limit(1);
    tablesExist = !error || error.code !== '42P01';
    tablesExistCheckedAt = Date.now();
    if (!tablesExist) dbLogger.warn('User memory tables not found');
    return tablesExist;
  } catch { tablesExist = false; tablesExistCheckedAt = Date.now(); return false; }
}

function createEmptyProfile(userId: string, ti?: TelegramUserInfo): UserProfile {
  const now = new Date().toISOString();
  return { id: 'temp-' + userId, user_id: userId, username: ti?.username, first_name: ti?.first_name, last_name: ti?.last_name,
    language_code: ti?.language_code || 'ru', total_messages: 0, total_voice_messages: 0, total_images: 0,
    total_tokens_used: 0, first_seen_at: now, last_seen_at: now, preferences: {}, created_at: now, updated_at: now };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToProfile(d: any): UserProfile {
  return { id: d.$id ?? d.id, user_id: d.user_id, username: d.username, first_name: d.first_name, last_name: d.last_name,
    language_code: d.language_code || 'ru', total_messages: d.total_messages ?? 0, total_voice_messages: d.total_voice_messages ?? 0,
    total_images: d.total_images ?? 0, total_tokens_used: d.total_tokens_used ?? 0,
    first_seen_at: d.first_seen_at || d.$createdAt, last_seen_at: d.last_seen_at || d.$updatedAt, last_message_at: d.last_message_at,
    preferences: typeof d.preferences === 'string' ? parseJson(d.preferences, {}) : (d.preferences ?? {}),
    created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToMemory(d: any): UserMemory {
  return { id: d.$id ?? d.id, user_id: d.user_id, memory_type: d.memory_type, content: d.content, source: d.source,
    confidence: d.confidence ?? 1.0, created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt,
    expires_at: d.expires_at, is_active: d.is_active ?? true, is_pinned: d.is_pinned ?? false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToLog(d: any): UserLog {
  return { id: d.$id ?? d.id, user_id: d.user_id, event_type: d.event_type, content: d.content,
    metadata: typeof d.metadata === 'string' ? parseJson(d.metadata, {}) : (d.metadata ?? {}),
    model: d.model, tokens_prompt: d.tokens_prompt, tokens_completion: d.tokens_completion,
    response_time_ms: d.response_time_ms, timestamp: d.timestamp || d.$createdAt };
}

// ---------- User Profile Repository ----------

export const userProfileRepo = {
  async getOrCreate(userId: string, telegramInfo?: TelegramUserInfo): Promise<UserProfile> {
    if (!(await checkTablesExist())) return createEmptyProfile(userId, telegramInfo);
    try {
      if (useAW()) {
        const aw = await getAW();
        const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
        if (r.documents.length > 0) {
          const doc = r.documents[0]!;
          await aw.updateDocument(DB_ID(), COLL.profiles, doc.$id, {
            last_seen_at: new Date().toISOString(),
            ...(telegramInfo?.username && { username: telegramInfo.username }),
            ...(telegramInfo?.first_name && { first_name: telegramInfo.first_name }),
            ...(telegramInfo?.last_name && { last_name: telegramInfo.last_name }),
          });
          return docToProfile(doc);
        }
        const now = new Date().toISOString();
        const nd = await aw.createDocument(DB_ID(), COLL.profiles, ID.unique(), {
          user_id: userId, username: telegramInfo?.username || null, first_name: telegramInfo?.first_name || null,
          last_name: telegramInfo?.last_name || null, language_code: telegramInfo?.language_code || 'ru',
          total_messages: 0, total_voice_messages: 0, total_images: 0, total_tokens_used: 0,
          first_seen_at: now, last_seen_at: now, preferences: JSON.stringify({}), created_at: now, updated_at: now,
        });
        dbLogger.info({ userId }, 'New user profile created');
        return docToProfile(nd);
      } else {
        const sb = getSupabase();
        const { data: ex } = await sb.from('user_profiles').select('*').eq('user_id', userId).single();
        if (ex) {
          await sb.from('user_profiles').update({ last_seen_at: new Date().toISOString(),
            username: telegramInfo?.username || ex.username, first_name: telegramInfo?.first_name || ex.first_name,
            last_name: telegramInfo?.last_name || ex.last_name }).eq('user_id', userId);
          return ex as UserProfile;
        }
        const { data: np, error } = await sb.from('user_profiles').insert({ user_id: userId, username: telegramInfo?.username,
          first_name: telegramInfo?.first_name, last_name: telegramInfo?.last_name,
          language_code: telegramInfo?.language_code || 'ru' }).select().single();
        if (error) { dbLogger.error({ error, userId }, 'Failed to create user profile'); return createEmptyProfile(userId, telegramInfo); }
        dbLogger.info({ userId }, 'New user profile created');
        return np as UserProfile;
      }
    } catch (error) { dbLogger.error({ error, userId }, 'Error in getOrCreate profile'); return createEmptyProfile(userId, telegramInfo); }
  },

  async updateOnMessage(userId: string, messageType: 'message' | 'voice' | 'image', tokensUsed = 0, telegramInfo?: TelegramUserInfo): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      if (useAW()) {
        const aw = await getAW();
        const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
        const now = new Date().toISOString();
        if (r.documents.length > 0) {
          const doc = r.documents[0]!;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const u: any = { last_seen_at: now, last_message_at: now, updated_at: now };
          if (messageType === 'message') u.total_messages = (doc.total_messages ?? 0) + 1;
          else if (messageType === 'voice') u.total_voice_messages = (doc.total_voice_messages ?? 0) + 1;
          else if (messageType === 'image') u.total_images = (doc.total_images ?? 0) + 1;
          if (tokensUsed > 0) u.total_tokens_used = (doc.total_tokens_used ?? 0) + tokensUsed;
          if (telegramInfo?.username) u.username = telegramInfo.username;
          if (telegramInfo?.first_name) u.first_name = telegramInfo.first_name;
          await aw.updateDocument(DB_ID(), COLL.profiles, doc.$id, u);
        } else {
          await aw.createDocument(DB_ID(), COLL.profiles, ID.unique(), {
            user_id: userId, username: telegramInfo?.username || null, first_name: telegramInfo?.first_name || null,
            last_name: telegramInfo?.last_name || null, language_code: telegramInfo?.language_code || 'ru',
            total_messages: messageType === 'message' ? 1 : 0, total_voice_messages: messageType === 'voice' ? 1 : 0,
            total_images: messageType === 'image' ? 1 : 0, total_tokens_used: tokensUsed,
            first_seen_at: now, last_seen_at: now, last_message_at: now,
            preferences: JSON.stringify({}), created_at: now, updated_at: now,
          });
        }
      } else {
        const { error } = await getSupabase().rpc('update_user_profile_on_message', {
          p_user_id: userId, p_username: telegramInfo?.username, p_first_name: telegramInfo?.first_name,
          p_last_name: telegramInfo?.last_name, p_language_code: telegramInfo?.language_code,
          p_message_type: messageType, p_tokens_used: tokensUsed,
        });
        if (error) dbLogger.warn({ error, userId }, 'Failed to update user profile (RPC)');
      }
    } catch (error) { dbLogger.warn({ error, userId }, 'Error updating user profile'); }
  },

  async get(userId: string): Promise<UserProfile | null> {
    try {
      if (useAW()) {
        const aw = await getAW();
        const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
        return r.documents.length > 0 ? docToProfile(r.documents[0]) : null;
      } else {
        const { data, error } = await getSupabase().from('user_profiles').select('*').eq('user_id', userId).single();
        if (error && error.code !== 'PGRST116') dbLogger.error({ error, userId }, 'Failed to get user profile');
        return data as UserProfile | null;
      }
    } catch { return null; }
  },

  async getAll(limit = 100, offset = 0): Promise<UserProfile[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.profiles, [Query.orderDesc('last_seen_at'), Query.limit(limit), Query.offset(offset)]);
        return r.documents.map(docToProfile);
      } else {
        const { data, error } = await getSupabase().from('user_profiles').select('*').order('last_seen_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) { dbLogger.error({ error }, 'Failed to get profiles'); return []; }
        return (data ?? []) as UserProfile[];
      }
    } catch { return []; }
  },

  async getLastGreetingDate(userId: string): Promise<string | null> {
    if (!(await checkTablesExist())) return null;
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
        if (!r.documents.length) return null;
        return parseJson<Record<string, any>>(r.documents[0]!.preferences, {}).last_greeting_date ?? null;
      } else {
        const { data } = await getSupabase().from('user_profiles').select('preferences').eq('user_id', userId).single();
        return (data?.preferences as Record<string, unknown>)?.last_greeting_date as string | null ?? null;
      }
    } catch { return null; }
  },

  async setLastGreetingDate(userId: string, date: string): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      if (useAW()) {
        const aw = await getAW();
        const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
        if (!r.documents.length) return;
        const prefs = parseJson<Record<string, any>>(r.documents[0]!.preferences, {});
        prefs.last_greeting_date = date;
        await aw.updateDocument(DB_ID(), COLL.profiles, r.documents[0]!.$id, { preferences: JSON.stringify(prefs) });
      } else {
        const { error } = await getSupabase().rpc('set_user_preference', { p_user_id: userId, p_key: 'last_greeting_date', p_value: JSON.stringify(date) });
        if (error) {
          const { data } = await getSupabase().from('user_profiles').select('preferences').eq('user_id', userId).single();
          const prefs = (data?.preferences as Record<string, unknown>) ?? {};
          prefs.last_greeting_date = date;
          await getSupabase().from('user_profiles').update({ preferences: prefs }).eq('user_id', userId);
        }
      }
    } catch (error) { dbLogger.warn({ error, userId }, 'Failed to set last greeting date'); }
  },

  async getStats(userId: string): Promise<Record<string, unknown>> {
    try {
      if (useAW()) {
        const aw = await getAW();
        const [p, m, c] = await Promise.all([
          aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]),
          aw.listDocuments(DB_ID(), COLL.memory, [Query.equal('user_id', userId), Query.equal('is_active', true), Query.limit(1)]),
          aw.listDocuments(DB_ID(), 'amina_conversations', [Query.equal('user_id', userId), Query.limit(1)]),
        ]);
        return { profile: p.documents[0] ? docToProfile(p.documents[0]) : null, memory_count: m.total, conversation_count: c.total };
      } else {
        const { data, error } = await getSupabase().rpc('get_user_stats', { p_user_id: userId });
        if (error) { dbLogger.error({ error, userId }, 'Failed to get user stats'); return {}; }
        return data ?? {};
      }
    } catch { return {}; }
  },
};

// ---------- User Memory Repository ----------

export const userMemoryRepo = {
  async add(userId: string, memoryType: UserMemory['memory_type'], content: string,
    options: { source?: string; confidence?: number; isPinned?: boolean; expiresAt?: Date } = {}): Promise<UserMemory | null> {
    if (!(await checkTablesExist())) return null;
    try {
      if (useAW()) {
        const now = new Date().toISOString();
        const doc = await (await getAW()).createDocument(DB_ID(), COLL.memory, ID.unique(), {
          user_id: userId, memory_type: memoryType, content, source: options.source || 'message',
          confidence: options.confidence ?? 1.0, is_pinned: options.isPinned ?? false, is_active: true,
          expires_at: options.expiresAt?.toISOString() || null, created_at: now, updated_at: now,
        });
        dbLogger.info({ userId, memoryType }, 'User memory added');
        return docToMemory(doc);
      } else {
        const { data, error } = await getSupabase().from('user_memory').insert({
          user_id: userId, memory_type: memoryType, content, source: options.source || 'message',
          confidence: options.confidence ?? 1.0, is_pinned: options.isPinned ?? false,
          expires_at: options.expiresAt?.toISOString(),
        }).select().single();
        if (error) { dbLogger.warn({ error, userId }, 'Failed to add memory'); return null; }
        dbLogger.info({ userId, memoryType }, 'User memory added');
        return data as UserMemory;
      }
    } catch (error) { dbLogger.warn({ error, userId }, 'Error adding memory'); return null; }
  },

  async getAll(userId: string, limit = 50): Promise<UserMemory[]> {
    if (!(await checkTablesExist())) return [];
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
          Query.equal('user_id', userId), Query.equal('is_active', true),
          Query.orderDesc('is_pinned'), Query.orderDesc('created_at'), Query.limit(limit),
        ]);
        const now = new Date().toISOString();
        return r.documents.filter(d => !d.expires_at || d.expires_at > now).map(docToMemory);
      } else {
        const { data, error } = await getSupabase().from('user_memory').select('*')
          .eq('user_id', userId).eq('is_active', true).or('expires_at.is.null,expires_at.gt.now()')
          .order('is_pinned', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
        if (error) { dbLogger.warn({ error, userId }, 'Failed to get memory'); return []; }
        return (data ?? []) as UserMemory[];
      }
    } catch { return []; }
  },

  async getByType(userId: string, memoryType: UserMemory['memory_type']): Promise<UserMemory[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
          Query.equal('user_id', userId), Query.equal('memory_type', memoryType),
          Query.equal('is_active', true), Query.orderDesc('created_at'), Query.limit(100),
        ]);
        return r.documents.map(docToMemory);
      } else {
        const { data, error } = await getSupabase().from('user_memory').select('*')
          .eq('user_id', userId).eq('memory_type', memoryType).eq('is_active', true).order('created_at', { ascending: false });
        if (error) { dbLogger.error({ error, userId, memoryType }, 'Failed to get memory by type'); return []; }
        return (data ?? []) as UserMemory[];
      }
    } catch { return []; }
  },

  async getPinned(userId: string): Promise<UserMemory[]> {
    try {
      if (useAW()) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
          Query.equal('user_id', userId), Query.equal('is_pinned', true), Query.equal('is_active', true), Query.limit(100),
        ]);
        return r.documents.map(docToMemory);
      } else {
        const { data, error } = await getSupabase().from('user_memory').select('*')
          .eq('user_id', userId).eq('is_pinned', true).eq('is_active', true);
        if (error) { dbLogger.error({ error, userId }, 'Failed to get pinned memory'); return []; }
        return (data ?? []) as UserMemory[];
      }
    } catch { return []; }
  },

  async update(memoryId: string, updates: Partial<Pick<UserMemory, 'content' | 'confidence' | 'is_pinned' | 'is_active'>>): Promise<void> {
    try {
      if (useAW()) {
        await (await getAW()).updateDocument(DB_ID(), COLL.memory, memoryId, { ...updates, updated_at: new Date().toISOString() });
      } else {
        const { error } = await getSupabase().from('user_memory').update(updates).eq('id', memoryId);
        if (error) dbLogger.error({ error, memoryId }, 'Failed to update memory');
      }
    } catch (error) { dbLogger.error({ error, memoryId }, 'Failed to update memory'); }
  },

  async deactivate(memoryId: string): Promise<void> { await this.update(memoryId, { is_active: false }); },

  async getContextForPrompt(userId: string): Promise<string> {
    const memories = await this.getAll(userId, 30);
    if (!memories.length) return '';
    const grouped = { important: [] as string[], fact: [] as string[], preference: [] as string[], context: [] as string[], summary: [] as string[] };
    for (const m of memories) { const t = m.memory_type as keyof typeof grouped; if (grouped[t]) grouped[t].push(m.content); }
    const parts: string[] = [];
    if (grouped.important.length) parts.push(`ВАЖНО о пользователе:\n${grouped.important.map(m => `- ${m}`).join('\n')}`);
    if (grouped.fact.length) parts.push(`Факты о пользователе:\n${grouped.fact.map(m => `- ${m}`).join('\n')}`);
    if (grouped.preference.length) parts.push(`Предпочтения:\n${grouped.preference.map(m => `- ${m}`).join('\n')}`);
    if (grouped.context.length) parts.push(`Текущий контекст:\n${grouped.context.map(m => `- ${m}`).join('\n')}`);
    if (grouped.summary.length) parts.push(`Из предыдущих разговоров:\n${grouped.summary.slice(0, 3).map(m => `- ${m}`).join('\n')}`);
    return parts.join('\n\n');
  },
};

// ---------- User Logs Repository ----------

export const userLogsRepo = {
  async add(userId: string, eventType: UserLog['event_type'], content?: string, metadata: Record<string, unknown> = {},
    aiMetrics?: { model?: string; tokensPrompt?: number; tokensCompletion?: number; responseTimeMs?: number }): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      if (useAW()) {
        await (await getAW()).createDocument(DB_ID(), COLL.logs, ID.unique(), {
          user_id: userId, event_type: eventType, content: content || null, metadata: JSON.stringify(metadata),
          model: aiMetrics?.model || null, tokens_prompt: aiMetrics?.tokensPrompt ?? null,
          tokens_completion: aiMetrics?.tokensCompletion ?? null, response_time_ms: aiMetrics?.responseTimeMs ?? null,
          timestamp: new Date().toISOString(),
        });
      } else {
        const { error } = await getSupabase().from('user_logs').insert({
          user_id: userId, event_type: eventType, content, metadata,
          model: aiMetrics?.model, tokens_prompt: aiMetrics?.tokensPrompt,
          tokens_completion: aiMetrics?.tokensCompletion, response_time_ms: aiMetrics?.responseTimeMs,
        });
        if (error) dbLogger.warn({ error, userId, eventType }, 'Failed to add user log');
      }
    } catch { /* logging should not break the bot */ }
  },

  async getByUser(userId: string, options: { eventType?: UserLog['event_type']; from?: Date; to?: Date; limit?: number } = {}): Promise<UserLog[]> {
    if (!(await checkTablesExist())) return [];
    try {
      if (useAW()) {
        const q: string[] = [Query.equal('user_id', userId), Query.orderDesc('timestamp')];
        if (options.eventType) q.push(Query.equal('event_type', options.eventType));
        if (options.from) q.push(Query.greaterThanEqual('timestamp', options.from.toISOString()));
        if (options.to) q.push(Query.lessThanEqual('timestamp', options.to.toISOString()));
        q.push(Query.limit(options.limit || 100));
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.logs, q);
        return r.documents.map(docToLog);
      } else {
        let query = getSupabase().from('user_logs').select('*').eq('user_id', userId).order('timestamp', { ascending: false });
        if (options.eventType) query = query.eq('event_type', options.eventType);
        if (options.from) query = query.gte('timestamp', options.from.toISOString());
        if (options.to) query = query.lte('timestamp', options.to.toISOString());
        if (options.limit) query = query.limit(options.limit);
        const { data, error } = await query;
        if (error) { dbLogger.warn({ error, userId }, 'Failed to get user logs'); return []; }
        return (data ?? []) as UserLog[];
      }
    } catch { return []; }
  },

  async getMessageHistory(userId: string, limit = 100): Promise<UserLog[]> {
    return this.getByUser(userId, { eventType: 'message', limit });
  },

  async getEventStats(userId: string, days = 30): Promise<Record<string, number>> {
    try {
      const from = new Date(); from.setDate(from.getDate() - days);
      if (useAW()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const all: any[] = []; let offset = 0;
        while (offset < 5000) {
          const r = await (await getAW()).listDocuments(DB_ID(), COLL.logs, [
            Query.equal('user_id', userId), Query.greaterThanEqual('timestamp', from.toISOString()),
            Query.limit(100), Query.offset(offset),
          ]);
          all.push(...r.documents); if (r.documents.length < 100) break; offset += 100;
        }
        const s: Record<string, number> = {};
        for (const d of all) s[d.event_type] = (s[d.event_type] || 0) + 1;
        return s;
      } else {
        const { data, error } = await getSupabase().from('user_logs').select('event_type')
          .eq('user_id', userId).gte('timestamp', from.toISOString());
        if (error) { dbLogger.error({ error, userId }, 'Failed to get event stats'); return {}; }
        const s: Record<string, number> = {};
        for (const l of data ?? []) s[l.event_type] = (s[l.event_type] || 0) + 1;
        return s;
      }
    } catch { return {}; }
  },
};

// ---------- Memory Extraction Service ----------

export const memoryExtractor = {
  async extractFacts(userId: string, userMessage: string, aiResponse: string): Promise<void> {
    if (userMessage.length < 20) return;
    try {
      const prompt = `Проанализируй диалог и извлеки ТОЛЬКО явные факты о пользователе.
Сообщение пользователя: "${userMessage}"
Ответ ассистента: "${aiResponse}"
Извлеки факты в формате JSON массива. Каждый факт: {type: "fact"|"preference"|"context"|"important", content: "...", confidence: 0-1}
Если фактов нет, верни []. Верни ТОЛЬКО JSON.`;
      const response = await aiService.complete(prompt, 'telegram');
      const match = response.match(/\[\s*\{[\s\S]*?\}\s*\]/);
      if (!match) return;
      const facts = JSON.parse(match[0]) as Array<{ type: 'fact' | 'preference' | 'context' | 'important'; content: string; confidence: number }>;
      for (const f of facts) {
        if (f.content && f.confidence > 0.5) {
          await userMemoryRepo.add(userId, f.type, f.content, { source: 'inference', confidence: f.confidence });
          await userLogsRepo.add(userId, 'memory_created', f.content, { memory_type: f.type, confidence: f.confidence });
        }
      }
      if (facts.length > 0) { aiLogger.info({ userId, factsCount: facts.length }, 'Facts extracted'); memoryContextBuilder.invalidateCache(userId); }
    } catch (error) { aiLogger.error({ error, userId }, 'Failed to extract facts'); }
  },

  async summarizeConversation(userId: string, messages: Array<{ role: string; content: string }>): Promise<string | null> {
    if (messages.length < 4) return null;
    try {
      const text = messages.map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`).join('\n');
      const summary = await aiService.complete(`Создай краткое содержание (2-3 предложения):\n\n${text}\n\nКраткое содержание:`, 'telegram');
      await userMemoryRepo.add(userId, 'summary', summary.trim(), { source: 'summarization', confidence: 0.9 });
      return summary.trim();
    } catch (error) { aiLogger.error({ error, userId }, 'Failed to summarize'); return null; }
  },
};

// ---------- Memory Context Builder ----------

const memoryContextCache = new Map<string, { context: string; ts: number }>();

export const memoryContextBuilder = {
  async buildContext(userId: string, telegramInfo?: TelegramUserInfo): Promise<string> {
    const cached = memoryContextCache.get(userId);
    if (cached && Date.now() - cached.ts < 45_000) return cached.context;

    const [profile, memoryContext] = await Promise.all([
      userProfileRepo.getOrCreate(userId, telegramInfo),
      userMemoryRepo.getContextForPrompt(userId),
    ]);

    const userName = profile.first_name || profile.username || 'Пользователь';
    const parts: string[] = [`=== ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ===`, `Имя: ${userName}`];
    if (profile.total_messages > 0) {
      parts.push(`Общается с тобой с ${new Date(profile.first_seen_at).toLocaleDateString('ru-RU')}`);
      parts.push(`Всего сообщений: ${profile.total_messages}`);
    }
    if (memoryContext) { parts.push(`\n=== ЧТО ТЫ ЗНАЕШЬ О ${userName.toUpperCase()} ===`); parts.push(memoryContext); }
    parts.push(`\n=== ОБЯЗАТЕЛЬНЫЕ ИНСТРУКЦИИ ===`);
    parts.push(`ОБЯЗАТЕЛЬНО используй имя пользователя "${userName}" в ответе.`);
    parts.push(`Используй факты выше для персонализированных ответов.`);
    parts.push(`НИКОГДА не пиши [Имя] или [Name] — только реальное имя: ${userName}.`);
    parts.push(`НЕ пиши фразы вроде "Теперь я буду обращаться к тебе по имени" — ты УЖЕ его знаешь.`);

    const result = parts.join('\n');
    if (memoryContextCache.size >= 200) { const k = memoryContextCache.keys().next().value; if (k) memoryContextCache.delete(k); }
    memoryContextCache.set(userId, { context: result, ts: Date.now() });
    return result;
  },

  invalidateCache(userId: string): void { memoryContextCache.delete(userId); },
};
