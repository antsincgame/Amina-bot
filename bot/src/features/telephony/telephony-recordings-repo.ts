/**
 * Telephony Recordings Repository — dual backend (Supabase Storage + Appwrite Storage)
 */

import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import { dbLogger } from '../../config/logger.js';
import { getSupabase } from '../../db/index.js';
import { Storage } from 'node-appwrite';

const useAW = () => config.dbBackend === 'appwrite';

const BUCKET = 'telephony-recordings';
const AW_BUCKET = 'amina-tel-recordings';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;

let _awStorage: Storage | null = null;
async function getAWStorage() {
  if (!_awStorage) {
    const { getAppwriteClient } = await import('../../db/appwrite.js');
    _awStorage = new Storage(getAppwriteClient());
  }
  return _awStorage;
}

let initialized = false;
let initPromise: Promise<void> | null = null;

export interface TelephonyRecordingArchive {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  signedUrl: string | null;
}

function inferExtension(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav': case 'audio/x-wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4': case 'audio/aac': return 'm4a';
    case 'audio/webm': return 'webm';
    default: return 'bin';
  }
}

function buildStoragePath(sessionId: string, mimeType: string, recordedAt: Date): string {
  const year = String(recordedAt.getUTCFullYear());
  const month = String(recordedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(recordedAt.getUTCDate()).padStart(2, '0');
  const extension = inferExtension(mimeType);
  return `${year}/${month}/${day}/${sessionId}.${extension}`;
}

// For Appwrite: use flat fileId (no slashes allowed)
function buildAwFileId(sessionId: string, mimeType: string): string {
  const extension = inferExtension(mimeType);
  return `${sessionId}.${extension}`;
}

export async function ensureTelephonyRecordingsInfra(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (useAW()) {
        const storage = await getAWStorage();
        try { await storage.getBucket(AW_BUCKET); }
        catch {
          await storage.createBucket(AW_BUCKET, 'Telephony Recordings');
          dbLogger.info('Created Appwrite telephony recordings bucket');
        }
      } else {
        const sb = getSupabase();
        const { data: buckets, error } = await sb.storage.listBuckets();
        if (error) throw error;
        const bucketExists = (buckets ?? []).some((bucket) => bucket.name === BUCKET);
        if (!bucketExists) {
          const { error: createError } = await sb.storage.createBucket(BUCKET, {
            public: false,
            fileSizeLimit: 100 * 1024 * 1024,
          });
          if (createError && !createError.message?.includes('already exists')) throw createError;
        }
      }
      initialized = true;
    } catch (error) {
      dbLogger.warn({ error }, 'Failed to ensure telephony recordings bucket');
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export const telephonyRecordingsRepo = {
  async uploadFromBuffer(
    sessionId: string,
    buffer: Buffer,
    mimeType: string,
    recordedAt = new Date(),
  ): Promise<TelephonyRecordingArchive> {
    await ensureTelephonyRecordingsInfra();

    const checksumSha256 = createHash('sha256').update(buffer).digest('hex');

    if (useAW()) {
      const storage = await getAWStorage();
      const fileId = buildAwFileId(sessionId, mimeType);
      const blob = new Blob([buffer], { type: mimeType });
      const file = new File([blob], fileId, { type: mimeType });

      // Try delete old file first (upsert behavior)
      try { await storage.deleteFile(AW_BUCKET, fileId); } catch { /* ok */ }
      await storage.createFile(AW_BUCKET, fileId, file);

      const signedUrl = await this.createSignedUrl(fileId).catch(() => null);

      return {
        bucket: AW_BUCKET,
        path: fileId,
        mimeType,
        sizeBytes: buffer.length,
        checksumSha256,
        signedUrl,
      };
    } else {
      const storagePath = buildStoragePath(sessionId, mimeType, recordedAt);
      const sb = getSupabase();

      const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { upsert: true, contentType: mimeType });
      if (uploadError) throw uploadError;

      const signedUrl = await this.createSignedUrl(storagePath).catch(() => null);

      return {
        bucket: BUCKET,
        path: storagePath,
        mimeType,
        sizeBytes: buffer.length,
        checksumSha256,
        signedUrl,
      };
    }
  },

  async createSignedUrl(path: string, expiresInSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS): Promise<string | null> {
    if (!path) return null;
    await ensureTelephonyRecordingsInfra();

    if (useAW()) {
      const storage = await getAWStorage();
      // Appwrite: getFileView returns a public URL (server-side API key provides access)
      const result = storage.getFileView(AW_BUCKET, path);
      return result.toString();
    } else {
      const { data, error } = await getSupabase()
        .storage
        .from(BUCKET)
        .createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      return data?.signedUrl ?? null;
    }
  },

  async delete(path: string): Promise<void> {
    if (!path) return;
    await ensureTelephonyRecordingsInfra();

    if (useAW()) {
      const storage = await getAWStorage();
      await storage.deleteFile(AW_BUCKET, path);
    } else {
      const { error } = await getSupabase().storage.from(BUCKET).remove([path]);
      if (error) throw error;
    }
  },
};
