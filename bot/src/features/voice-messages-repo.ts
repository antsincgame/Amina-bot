/**
 * Voice Messages Repository — Appwrite backend
 * DB metadata + file storage
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import { Storage } from 'node-appwrite';

let _aw: import('node-appwrite').Databases | null = null;
let _awStorage: Storage | null = null;
async function getAW() { if (!_aw) { const { getAppwrite, getAppwriteClient } = await import('../db/appwrite.js'); _aw = getAppwrite(); _awStorage = new Storage(getAppwriteClient()); } return _aw; }
async function getAWStorage() { if (!_awStorage) await getAW(); return _awStorage!; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_voice_messages';
const AW_BUCKET = 'amina-voice-messages';

// Types
export interface VoiceMessage {
  id: string; user_id: string; file_path: string; duration: number; file_size: number;
  transcription: string | null; telegram_file_id: string | null; created_at: string;
}
export interface VoiceMessageWithUser extends VoiceMessage { username?: string; first_name?: string; }
export interface VoiceMessagesFilter { userId?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number; }
export interface VoiceMessagesStats { totalCount: number; totalSize: number; totalDuration: number; byUser: { user_id: string; count: number; totalDuration: number }[]; }

let statsCache: { value: VoiceMessagesStats; ts: number } | null = null;
const STATS_CACHE_TTL_MS = 60_000;

function docToVoice(d: AppwriteDoc): VoiceMessage {
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
  try {
    const storage = await getAWStorage();
    try { await storage.getBucket(AW_BUCKET); }
    catch {
      await storage.createBucket(AW_BUCKET, 'Voice Messages');
      dbLogger.info('Created Appwrite voice-messages bucket');
    }
  } catch (err) { dbLogger.warn({ error: err }, 'Could not ensure Appwrite voice bucket'); }
  initialized = true;
}

// Repository
export const voiceMessagesRepo = {
  async upload(audioBuffer: Buffer, filePath: string, userId: string, duration: number, telegramFileId?: string): Promise<VoiceMessage | null> {
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
    statsCache = null;
    dbLogger.info({ id: doc.$id, userId, duration }, 'Voice message saved');
    return docToVoice(doc);
  },

  async updateTranscription(id: string, transcription: string): Promise<void> {
    try {
      await (await getAW()).updateDocument(DB_ID(), COLL, id, { transcription });
    } catch (e) { dbLogger.warn({ error: e, id }, 'Failed to update transcription'); }
  },

  async list(filters: VoiceMessagesFilter = {}): Promise<{ data: VoiceMessageWithUser[]; total: number }> {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    try {
      const aw = await getAW();
      const q: string[] = [Query.orderDesc('created_at'), Query.limit(limit), Query.offset(offset)];
      if (filters.userId) q.push(Query.equal('user_id', filters.userId));
      if (filters.dateFrom) q.push(Query.greaterThanEqual('created_at', filters.dateFrom));
      if (filters.dateTo) q.push(Query.lessThanEqual('created_at', filters.dateTo));
      const r = await aw.listDocuments(DB_ID(), COLL, q);
      const voices = r.documents.map(docToVoice);
      const userIds = [...new Set(voices.map(v => v.user_id))];
      const userMap: Record<string, { username?: string; first_name?: string }> = {};
      if (userIds.length) {
        const pr = await aw.listDocuments(DB_ID(), 'amina_user_profiles', [Query.equal('user_id', userIds), Query.limit(100)]);
        for (const p of pr.documents) userMap[p.user_id] = { username: p.username, first_name: p.first_name };
      }
      return { data: voices.map(v => ({ ...v, ...userMap[v.user_id] })), total: r.total };
    } catch { return { data: [], total: 0 }; }
  },

  async stats(): Promise<VoiceMessagesStats> {
    try {
      if (statsCache && Date.now() - statsCache.ts < STATS_CACHE_TTL_MS) {
        return statsCache.value;
      }

      const MAX_STATS_DOCS = 2000;
      let totalCount = 0;
      let totalSize = 0;
      let totalDuration = 0;
      const byUserMap = new Map<string, { count: number; totalDuration: number }>();
      let offset = 0;

      while (offset < MAX_STATS_DOCS) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL, [Query.limit(100), Query.offset(offset)]);
        for (const d of r.documents) {
          const fileSize = (d.file_size as number) ?? 0;
          const duration = (d.duration as number) ?? 0;
          const userId = d.user_id as string;
          totalCount++;
          totalSize += fileSize;
          totalDuration += duration;
          const entry = byUserMap.get(userId) ?? { count: 0, totalDuration: 0 };
          entry.count++;
          entry.totalDuration += duration;
          byUserMap.set(userId, entry);
        }
        if (r.documents.length < 100) break;
        offset += 100;
      }

      if (offset >= MAX_STATS_DOCS) {
        dbLogger.warn({ offset, MAX_STATS_DOCS }, 'Voice messages stats truncated — too many documents');
      }

      const stats: VoiceMessagesStats = {
        totalCount,
        totalSize,
        totalDuration,
        byUser: Array.from(byUserMap.entries())
          .map(([user_id, v]) => ({ user_id, ...v }))
          .sort((a, b) => b.count - a.count),
      };
      statsCache = { value: stats, ts: Date.now() };
      return stats;
    } catch (error) {
      dbLogger.warn({ error }, 'Failed to compute voice messages stats');
      return { totalCount: 0, totalSize: 0, totalDuration: 0, byUser: [] };
    }
  },

  async getSignedUrl(filePath: string, _expiresIn = 3600): Promise<string | null> {
    try {
      const storage = await getAWStorage();
      const result = storage.getFileView(AW_BUCKET, filePath);
      return result.toString();
    } catch { return null; }
  },

  async downloadFile(filePath: string): Promise<Buffer | null> {
    try {
      const storage = await getAWStorage();
      const result = await storage.getFileDownload(AW_BUCKET, filePath);
      return Buffer.from(result);
    } catch { return null; }
  },

  async getById(id: string): Promise<VoiceMessage | null> {
    try {
      const doc = await (await getAW()).getDocument(DB_ID(), COLL, id);
      return docToVoice(doc);
    } catch { return null; }
  },

  async getFiltered(filters: VoiceMessagesFilter = {}): Promise<VoiceMessage[]> {
    try {
      const q: string[] = [Query.orderDesc('created_at')];
      if (filters.userId) q.push(Query.equal('user_id', filters.userId));
      if (filters.dateFrom) q.push(Query.greaterThanEqual('created_at', filters.dateFrom));
      if (filters.dateTo) q.push(Query.lessThanEqual('created_at', filters.dateTo));
      q.push(Query.limit(filters.limit || 100));
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, q);
      return r.documents.map(docToVoice);
    } catch { return []; }
  },
};
