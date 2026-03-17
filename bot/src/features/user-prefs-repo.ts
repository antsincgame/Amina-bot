/**
 * User Preferences Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_user_preferences';

export interface UserPreferences {
  id: string; user_id: string; chat_id: number; digest_enabled: boolean; digest_hour: number;
  digest_city: string; first_name: string | null; timezone: string; created_at: string; updated_at: string;
}

function docToPrefs(d: AppwriteDoc): UserPreferences {
  return { id: d.$id ?? d.id, user_id: d.user_id, chat_id: d.chat_id, digest_enabled: d.digest_enabled ?? false,
    digest_hour: d.digest_hour ?? 8, digest_city: d.digest_city || '', first_name: d.first_name || null,
    timezone: d.timezone || 'Europe/Moscow', created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt };
}

export const userPrefsRepo = {
  async getOrCreate(userId: string, chatId: number, firstName?: string): Promise<UserPreferences> {
    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
    if (r.documents.length > 0) {
      const doc = r.documents[0]!;
      if ((firstName && doc.first_name !== firstName) || doc.chat_id !== chatId) {
        try {
          await aw.updateDocument(DB_ID(), COLL, doc.$id, {
            first_name: firstName ?? doc.first_name, chat_id: chatId, updated_at: new Date().toISOString(),
          });
        } catch (err) { dbLogger.warn({ error: err, userId }, 'Failed to update prefs fields'); }
      }
      return docToPrefs(doc);
    }
    const now = new Date().toISOString();
    const nd = await aw.createDocument(DB_ID(), COLL, ID.unique(), {
      user_id: userId, chat_id: chatId, first_name: firstName || null,
      digest_enabled: false, digest_hour: 10, digest_city: null, timezone: null,
      created_at: now, updated_at: now,
    });
    return docToPrefs(nd);
  },

  async update(userId: string, updates: Partial<Pick<UserPreferences, 'digest_enabled' | 'digest_hour' | 'digest_city' | 'timezone'>>): Promise<void> {
    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
    if (r.documents.length > 0) {
      await aw.updateDocument(DB_ID(), COLL, r.documents[0]!.$id, { ...updates, updated_at: new Date().toISOString() });
    }
  },

  async toggleDigest(userId: string, chatId: number, enabled: boolean): Promise<void> {
    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
    if (r.documents.length > 0) {
      await aw.updateDocument(DB_ID(), COLL, r.documents[0]!.$id, { digest_enabled: enabled, updated_at: new Date().toISOString() });
    } else {
      const now = new Date().toISOString();
      await aw.createDocument(DB_ID(), COLL, ID.unique(), {
        user_id: userId, chat_id: chatId, digest_enabled: enabled, digest_hour: 10,
        digest_city: null, first_name: null, timezone: null, created_at: now, updated_at: now,
      });
    }
  },

  async getDigestUsers(hour: number): Promise<UserPreferences[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.equal('digest_enabled', true), Query.equal('digest_hour', hour), Query.limit(100),
      ]);
      return r.documents.map(docToPrefs);
    } catch { return []; }
  },

  async listDigestCities(limit = 20): Promise<string[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [
        Query.isNotNull('digest_city'), Query.orderDesc('updated_at'), Query.limit(limit),
      ]);
      const seen = new Set<string>();
      const cities: string[] = [];
      for (const d of r.documents) {
        const c = d.digest_city?.trim();
        if (c && !seen.has(c)) { seen.add(c); cities.push(c); }
      }
      return cities;
    } catch { return []; }
  },

  async get(userId: string): Promise<UserPreferences | null> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL, [Query.equal('user_id', userId), Query.limit(1)]);
      return r.documents.length > 0 ? docToPrefs(r.documents[0]!) : null;
    } catch { return null; }
  },
};
