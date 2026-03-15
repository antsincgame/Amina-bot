/**
 * Voice Messages Repository — dual backend (Supabase + Appwrite)
 * DB metadata + file storage
 */

import { config } from '../config/index.js';
import { getSupabase } from '../db/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query } from 'node-appwrite';
import { Storage } from 'node-appwrite';

let _aw: import('node-appwrite').Databases | null = null;
let _awStorage: Storage | null = null;
async function getAW() { if (!_aw) { const { getAppwrite, getAppwriteClient } = await import('../db/appwrite.js'); _aw = getAppwrite(); _awStorage = new Storage(getAppwriteClient()); } return _aw; }
async function getAWStorage() { if (!_awStorage) await getAW(); return _awStorage!; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_voice_messages';
const BUCKET = 'voice-messages';
const AW_BUCKET = 'amina-voice-messages';

// Types
export interface VoiceMessage {
  id: string; user_id: string; file_path: string; duration: number; file_size: number;
  transcription: string | null; telegram_file_id: string | null; created_at: string;
}
export interface VoiceMessageWithUser extends VoiceMessage { username?: string; first_name?: string; }
export interface VoiceMessagesFilter { userId?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number; }
export interface VoiceMessagesStats { totalCount: number; totalSize: number; totalDuration: number; byUser: { user_id: string; count: number; totalDuration: number }[]; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToVoice(d: any): VoiceMessage {
  return { id: d.$id ?? d.id, user_id: d.user_id, file_path: d.file_path, duration: d.duration ?? 0,
    file_size: d.file_size ?? 0, transcription: d.transcription || null,
    telegram_file_id: d.telegram_file_id || null, created_at: d.created_at || d.$createdAt };
}

// Init
let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureVoiceMessagesInfra(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = doInit();
  try { await initPromise; } finally { initPromise = null; }
}

async function doInit(): Promise<void> {
  if (initialized) return;

  if (useAW()) {
    // Ensure Appwrite storage bucket
    try {
      const storage = await getAWStorage();
      try { await storage.getBucket(AW_BUCKET); }
      catch {
        await storage.createBucket(AW_BUCKET, 'Voice Messages');
        dbLogger.info('Created Appwrite voice-messages bucket');
      }
    } catch (err) { dbLogger.warn({ error: err }, 'Could not ensure Appwrite voice bucket'); }
  } else {
    const sb = getSupabase();
    try {
      const { data: buckets } = await sb.storage.listBuckets();
      if (!buckets?.some(b => b.name === BUCKET)) {
        const { error } = await sb.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 25 * 1024 * 1024 });
        if (error && !error.message?.includes('already exists')) dbLogger.warn({ error }, 'Failed to create voice bucket');
        else dbLogger.info('Created voice-messages storage bucket');
      }
    } catch (err) { dbLogger.warn({ error: err }, 'Could not ensure voice bucket'); }
    try {
      const { error } = await sb.from('voice_messages').select('id').limit(1);
      if (error?.message?.includes('does not exist')) dbLogger.warn('voice_messages table missing');
    } catch {}
  }
  initialized = true;
}

// Repository
export const voiceMessagesRepo = {
  async upload(audioBuffer: Buffer, filePath: string, userId: string, duration: number, telegramFileId?: string): Promise<VoiceMessage | null> {
    if (useAW()) {
      const aw = await getAW();
      const storage = await getAWStorage();
      const fileId = ID.unique();
      const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
      const file = new File([blob], filePath.split('/').pop() || 'voice.ogg', { type: 'audio/ogg' });
      await storage.createFile(AW_BUCKET, fileId, file);
      dbLogger.info({ filePath, userId, size: audioBuffer.length }, 'Voice uploaded to Appwrite storage');
      const now = new Date().toISOString();
      const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
        user_id: userId, file_path: fileId, duration, file_size: audioBuffer.length,
        transcription: null, telegram_file_id: telegramFileId || null, created_at: now,
      });
      dbLogger.info({ id: doc.$id, userId, duration }, 'Voice message saved');
      return docToVoice(doc);
    } else {
      const sb = getSupabase();
      const { error: uploadError } = await sb.storage.from(BUCKET).upload(filePath, audioBuffer, { contentType: 'audio/ogg', upsert: false });
      if (uploadError) { dbLogger.error({ error: uploadError, filePath, userId }, 'Failed to upload voice'); throw uploadError; }
      dbLogger.info({ filePath, userId, size: audioBuffer.length }, 'Voice uploaded to Supabase storage');
      const { data, error } = await sb.from('voice_messages').insert({
        user_id: userId, file_path: filePath, duration, file_size: audioBuffer.length, telegram_file_id: telegramFileId ?? null,
      }).select().single();
      if (error) {
        await sb.storage.from(BUCKET).remove([filePath]).catch(() => {});
        dbLogger.error({ error, userId }, 'Failed to save voice metadata'); throw error;
      }
      dbLogger.info({ id: data.id, userId, duration }, 'Voice message saved');
      return data as VoiceMessage;
    }
  },

  async updateTranscription(id: string, transcription: string): Promise<void> {
    try {
      if (useAW()) {
        await (await getAW()).updateDocument(DB_ID(), COLL, id, { transcription });
      } else {
        const { error } = await getSupabase().from('voice_messages').update({ transcription }).eq('id', id);
        if (error) dbLogger.warn({ error, id }, 'Failed to update transcription');
      }
    } catch (e) { dbLogger.warn({ error: e, id }, 'Failed to update transcription'); }
  },

  async list(filters: VoiceMessagesFilter = {}): Promise<{ data: VoiceMessageWithUser[]; total: number }> {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    try {
      if (useAW()) {
        const aw = await getAW();
        const q: string[] = [Query.orderDesc('created_at'), Query.limit(limit), Query.offset(offset)];
        if (filters.userId) q.push(Query.equal('user_id', filters.userId));
        if (filters.dateFrom) q.push(Query.greaterThanEqual('created_at', filters.dateFrom));
        if (filters.dateTo) q.push(Query.lessThanEqual('created_at', filters.dateTo));
        const r = await aw.listDocuments(DB_ID(), COLL, q);
        const voices = r.documents.map(docToVoice);
        // Enrich with user info
        const userIds = [...new Set(voices.map(v => v.user_id))];
        const userMap: Record<string, { username?: string; first_name?: string }> = {};
        if (userIds.length) {
          const pr = await aw.listDocuments(DB_ID(), 'amina_user_profiles', [Query.equal('user_id', userIds), Query.limit(100)]);
          for (const p of pr.documents) userMap[p.user_id] = { username: p.username, first_name: p.first_name };
        }
        return { data: voices.map(v => ({ ...v, ...userMap[v.user_id] })), total: r.total };
      } else {
        const sb = getSupabase();
        let cq = sb.from('voice_messages').select('*', { count: 'exact', head: true });
        if (filters.userId) cq = cq.eq('user_id', filters.userId);
        if (filters.dateFrom) cq = cq.gte('created_at', filters.dateFrom);
        if (filters.dateTo) cq = cq.lte('created_at', filters.dateTo);
        const { count } = await cq;
        let dq = sb.from('voice_messages').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (filters.userId) dq = dq.eq('user_id', filters.userId);
        if (filters.dateFrom) dq = dq.gte('created_at', filters.dateFrom);
        if (filters.dateTo) dq = dq.lte('created_at', filters.dateTo);
        const { data, error } = await dq;
        if (error) { dbLogger.error({ error }, 'Failed to list voice messages'); return { data: [], total: 0 }; }
        const voices = (data ?? []) as VoiceMessage[];
        const userIds = [...new Set(voices.map(v => v.user_id))];
        const userMap: Record<string, { username?: string; first_name?: string }> = {};
        if (userIds.length) {
          const { data: profiles } = await sb.from('user_profiles').select('user_id, username, first_name').in('user_id', userIds);
          for (const p of (profiles ?? []) as { user_id: string; username?: string; first_name?: string }[]) userMap[p.user_id] = { username: p.username, first_name: p.first_name };
        }
        return { data: voices.map(v => ({ ...v, ...userMap[v.user_id] })), total: count ?? 0 };
      }
    } catch { return { data: [], total: 0 }; }
  },

  async stats(): Promise<VoiceMessagesStats> {
    try {
      let rows: Array<{ user_id: string; file_size: number; duration: number }> = [];
      if (useAW()) {
        const all: any[] = []; let offset = 0;
        while (offset < 5000) {
          const r = await (await getAW()).listDocuments(DB_ID(), COLL, [Query.limit(100), Query.offset(offset)]);
          all.push(...r.documents); if (r.documents.length < 100) break; offset += 100;
        }
        rows = all.map(d => ({ user_id: d.user_id, file_size: d.file_size ?? 0, duration: d.duration ?? 0 }));
      } else {
        const { data, error } = await getSupabase().from('voice_messages').select('user_id, file_size, duration');
        if (error) { dbLogger.error({ error }, 'Failed to get voice stats'); return { totalCount: 0, totalSize: 0, totalDuration: 0, byUser: [] }; }
        rows = (data ?? []) as typeof rows;
      }
      const totalSize = rows.reduce((s, r) => s + r.file_size, 0);
      const totalDuration = rows.reduce((s, r) => s + r.duration, 0);
      const byUserMap = new Map<string, { count: number; totalDuration: number }>();
      for (const r of rows) { const e = byUserMap.get(r.user_id) ?? { count: 0, totalDuration: 0 }; e.count++; e.totalDuration += r.duration; byUserMap.set(r.user_id, e); }
      return { totalCount: rows.length, totalSize, totalDuration,
        byUser: Array.from(byUserMap.entries()).map(([user_id, v]) => ({ user_id, ...v })).sort((a, b) => b.count - a.count) };
    } catch { return { totalCount: 0, totalSize: 0, totalDuration: 0, byUser: [] }; }
  },

  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string | null> {
    try {
      if (useAW()) {
        // Appwrite: filePath is the fileId
        const storage = await getAWStorage();
        const result = storage.getFileView(AW_BUCKET, filePath);
        return result.toString();
      } else {
        const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(filePath, expiresIn);
        if (error) { dbLogger.error({ error, filePath }, 'Failed to create signed URL'); return null; }
        return data?.signedUrl ?? null;
      }
    } catch { return null; }
  },

  async downloadFile(filePath: string): Promise<Buffer | null> {
    try {
      if (useAW()) {
        const storage = await getAWStorage();
        const result = await storage.getFileDownload(AW_BUCKET, filePath);
        return Buffer.from(result);
      } else {
        const { data, error } = await getSupabase().storage.from(BUCKET).download(filePath);
        if (error) { dbLogger.error({ error, filePath }, 'Failed to download voice'); return null; }
        if (!data) return null;
        return Buffer.from(await data.arrayBuffer());
      }
    } catch { return null; }
  },

  async getById(id: string): Promise<VoiceMessage | null> {
    try {
      if (useAW()) {
        const doc = await (await getAW()).getDocument(DB_ID(), COLL, id);
        return docToVoice(doc);
      } else {
        const { data, error } = await getSupabase().from('voice_messages').select('*').eq('id', id).single();
        if (error) { if (error.code === 'PGRST116') return null; dbLogger.error({ error, id }, 'Failed to get voice message'); return null; }
        return data as VoiceMessage;
      }
    } catch { return null; }
  },

  async getFiltered(filters: VoiceMessagesFilter = {}): Promise<VoiceMessage[]> {
    try {
      if (useAW()) {
        const q: string[] = [Query.orderDesc('created_at')];
        if (filters.userId) q.push(Query.equal('user_id', filters.userId));
        if (filters.dateFrom) q.push(Query.greaterThanEqual('created_at', filters.dateFrom));
        if (filters.dateTo) q.push(Query.lessThanEqual('created_at', filters.dateTo));
        q.push(Query.limit(filters.limit || 100));
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, q);
        return r.documents.map(docToVoice);
      } else {
        let query = getSupabase().from('voice_messages').select('*').order('created_at', { ascending: false });
        if (filters.userId) query = query.eq('user_id', filters.userId);
        if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom);
        if (filters.dateTo) query = query.lte('created_at', filters.dateTo);
        if (filters.limit) query = query.limit(filters.limit);
        const { data, error } = await query;
        if (error) { dbLogger.error({ error }, 'Failed to get filtered voice messages'); return []; }
        return (data ?? []) as VoiceMessage[];
      }
    } catch { return []; }
  },
};
