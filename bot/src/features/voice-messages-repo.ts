/**
 * Voice Messages Repository
 * Сохранение голосовых сообщений в Supabase Storage + метаданные в БД
 */

import { getSupabase } from '../db/supabase.js';
import { dbLogger } from '../config/logger.js';

// --------------------------------------------
// Types
// --------------------------------------------

export interface VoiceMessage {
  id: string;
  user_id: string;
  file_path: string;
  duration: number;
  file_size: number;
  transcription: string | null;
  telegram_file_id: string | null;
  created_at: string;
}

export interface VoiceMessageWithUser extends VoiceMessage {
  username?: string;
  first_name?: string;
}

export interface VoiceMessagesFilter {
  userId?: string;
  dateFrom?: string;  // ISO date
  dateTo?: string;    // ISO date
  limit?: number;
  offset?: number;
}

export interface VoiceMessagesStats {
  totalCount: number;
  totalSize: number;
  totalDuration: number;
  byUser: { user_id: string; count: number; totalDuration: number }[];
}

// --------------------------------------------
// Storage bucket name
// --------------------------------------------

const BUCKET = 'voice-messages';

// --------------------------------------------
// Init: ensure table & bucket exist
// --------------------------------------------

let initialized = false;

export async function ensureVoiceMessagesInfra(): Promise<void> {
  if (initialized) return;

  const sb = getSupabase();

  // 1. Ensure storage bucket exists
  try {
    const { data: buckets } = await sb.storage.listBuckets();
    const exists = buckets?.some(b => b.name === BUCKET);
    if (!exists) {
      const { error } = await sb.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: 25 * 1024 * 1024, // 25MB
      });
      if (error) {
        if (!error.message?.includes('already exists')) {
          dbLogger.warn({ error }, 'Failed to create voice-messages bucket');
        }
      } else {
        dbLogger.info('Created voice-messages storage bucket');
      }
    }
  } catch (err) {
    dbLogger.warn({ error: err }, 'Could not ensure voice-messages bucket');
  }

  // 2. Ensure table exists — try a select
  try {
    const { error } = await sb.from('voice_messages').select('id').limit(1);
    if (error) {
      if (error.message?.includes('does not exist') || error.message?.includes('schema cache')) {
        dbLogger.warn('voice_messages table missing — attempting auto-create via RPC');
        // Try to create via RPC if available
        const createSQL = `
          CREATE TABLE IF NOT EXISTS voice_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            duration INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            transcription TEXT,
            telegram_file_id TEXT,
            created_at TIMESTAMPTZ DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_voice_messages_user ON voice_messages(user_id);
          CREATE INDEX IF NOT EXISTS idx_voice_messages_created ON voice_messages(created_at DESC);
        `;
        const { error: rpcError } = await sb.rpc('exec_sql', { sql: createSQL });
        if (rpcError) {
          dbLogger.warn({ error: rpcError }, 'Auto-create via RPC failed — please run migration manually');
          // Table will be created when SQL migration is run
        } else {
          dbLogger.info('voice_messages table auto-created');
        }
      }
    } else {
      dbLogger.debug('voice_messages table exists');
    }
  } catch {
    // Table might not exist yet — non-critical
  }

  initialized = true;
}

// --------------------------------------------
// Repository
// --------------------------------------------

export const voiceMessagesRepo = {
  /**
   * Загрузить аудиофайл в Storage и сохранить метаданные
   */
  async upload(
    audioBuffer: Buffer,
    filePath: string,
    userId: string,
    duration: number,
    telegramFileId?: string,
  ): Promise<VoiceMessage | null> {
    const sb = getSupabase();

    // Upload to storage
    const { error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(filePath, audioBuffer, {
        contentType: 'audio/ogg',
        upsert: false,
      });

    if (uploadError) {
      dbLogger.error({ error: uploadError, filePath, userId }, 'Failed to upload voice to storage');
      throw uploadError;
    }

    dbLogger.info({ filePath, userId, size: audioBuffer.length }, 'Voice file uploaded to storage');

    // Save metadata to DB
    const { data, error } = await sb
      .from('voice_messages')
      .insert({
        user_id: userId,
        file_path: filePath,
        duration,
        file_size: audioBuffer.length,
        telegram_file_id: telegramFileId ?? null,
      })
      .select()
      .single();

    if (error) {
      dbLogger.error({ error, userId }, 'Failed to save voice message metadata');
      // Try to delete uploaded file
      await sb.storage.from(BUCKET).remove([filePath]).catch(() => {});
      throw error;
    }

    dbLogger.info({ id: data.id, userId, duration }, 'Voice message saved');
    return data as VoiceMessage;
  },

  /**
   * Обновить транскрипцию для голосового сообщения
   */
  async updateTranscription(id: string, transcription: string): Promise<void> {
    const { error } = await getSupabase()
      .from('voice_messages')
      .update({ transcription })
      .eq('id', id);

    if (error) {
      dbLogger.warn({ error, id }, 'Failed to update voice transcription');
    }
  },

  /**
   * Список голосовых с фильтрами + JOIN с user_profiles
   */
  async list(filters: VoiceMessagesFilter = {}): Promise<{ data: VoiceMessageWithUser[]; total: number }> {
    const sb = getSupabase();
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    // Count
    let countQuery = sb.from('voice_messages').select('*', { count: 'exact', head: true });
    if (filters.userId) countQuery = countQuery.eq('user_id', filters.userId);
    if (filters.dateFrom) countQuery = countQuery.gte('created_at', filters.dateFrom);
    if (filters.dateTo) countQuery = countQuery.lte('created_at', filters.dateTo);

    const { count, error: countError } = await countQuery;
    if (countError) {
      dbLogger.error({ error: countError }, 'Failed to count voice messages');
    }

    // Data
    let query = sb
      .from('voice_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.userId) query = query.eq('user_id', filters.userId);
    if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom);
    if (filters.dateTo) query = query.lte('created_at', filters.dateTo);

    const { data, error } = await query;
    if (error) {
      dbLogger.error({ error }, 'Failed to list voice messages');
      return { data: [], total: 0 };
    }

    const voiceMessages = (data ?? []) as VoiceMessage[];

    // Enrich with user info
    const userIds = [...new Set(voiceMessages.map(v => v.user_id))];
    let userMap: Record<string, { username?: string; first_name?: string }> = {};

    if (userIds.length > 0) {
      const { data: profiles } = await sb
        .from('user_profiles')
        .select('user_id, username, first_name')
        .in('user_id', userIds);

      if (profiles) {
        for (const p of profiles as { user_id: string; username?: string; first_name?: string }[]) {
          userMap[p.user_id] = { username: p.username, first_name: p.first_name };
        }
      }
    }

    const enriched: VoiceMessageWithUser[] = voiceMessages.map(v => ({
      ...v,
      username: userMap[v.user_id]?.username,
      first_name: userMap[v.user_id]?.first_name,
    }));

    return { data: enriched, total: count ?? 0 };
  },

  /**
   * Статистика
   */
  async stats(): Promise<VoiceMessagesStats> {
    const sb = getSupabase();

    const { data, error } = await sb
      .from('voice_messages')
      .select('user_id, file_size, duration');

    if (error) {
      dbLogger.error({ error }, 'Failed to get voice messages stats');
      return { totalCount: 0, totalSize: 0, totalDuration: 0, byUser: [] };
    }

    const rows = (data ?? []) as { user_id: string; file_size: number; duration: number }[];
    const totalSize = rows.reduce((sum, r) => sum + (r.file_size ?? 0), 0);
    const totalDuration = rows.reduce((sum, r) => sum + (r.duration ?? 0), 0);

    // Group by user
    const byUserMap = new Map<string, { count: number; totalDuration: number }>();
    for (const r of rows) {
      const existing = byUserMap.get(r.user_id) ?? { count: 0, totalDuration: 0 };
      existing.count++;
      existing.totalDuration += r.duration ?? 0;
      byUserMap.set(r.user_id, existing);
    }

    const byUser = Array.from(byUserMap.entries())
      .map(([user_id, v]) => ({ user_id, ...v }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCount: rows.length,
      totalSize,
      totalDuration,
      byUser,
    };
  },

  /**
   * Скачать файл из Storage (signed URL)
   */
  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string | null> {
    const { data, error } = await getSupabase()
      .storage
      .from(BUCKET)
      .createSignedUrl(filePath, expiresIn);

    if (error) {
      dbLogger.error({ error, filePath }, 'Failed to create signed URL');
      return null;
    }

    return data?.signedUrl ?? null;
  },

  /**
   * Скачать файл из Storage (raw bytes)
   */
  async downloadFile(filePath: string): Promise<Buffer | null> {
    const { data, error } = await getSupabase()
      .storage
      .from(BUCKET)
      .download(filePath);

    if (error) {
      dbLogger.error({ error, filePath }, 'Failed to download voice file');
      return null;
    }

    if (!data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  },

  /**
   * Получить запись по ID
   */
  async getById(id: string): Promise<VoiceMessage | null> {
    const { data, error } = await getSupabase()
      .from('voice_messages')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      dbLogger.error({ error, id }, 'Failed to get voice message');
      return null;
    }

    return data as VoiceMessage;
  },

  /**
   * Получить все записи по фильтрам (для архива)
   */
  async getFiltered(filters: VoiceMessagesFilter = {}): Promise<VoiceMessage[]> {
    let query = getSupabase()
      .from('voice_messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters.userId) query = query.eq('user_id', filters.userId);
    if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom);
    if (filters.dateTo) query = query.lte('created_at', filters.dateTo);
    if (filters.limit) query = query.limit(filters.limit);

    const { data, error } = await query;
    if (error) {
      dbLogger.error({ error }, 'Failed to get filtered voice messages');
      return [];
    }

    return (data ?? []) as VoiceMessage[];
  },
};
