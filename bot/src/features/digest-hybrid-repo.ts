/**
 * Digest Hybrid Repository — Appwrite backend
 */

import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import type { ParsedHeadline, ParsedHeadlineCategory, DigestPipelineMode } from '../../../shared/types/index.js';
import type { DigestSearchResult } from './digest-core.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL_CACHE = 'amina_digest_caches';
const COLL_DELIVERY = 'amina_digest_deliveries';

export type DigestDeliveryKind = 'manual' | 'scheduled' | 'api';
export type DigestDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface PreparedDigestCachePayload {
  version: string; city: string; generated_at: string; digest_date: string; source_hash: string;
  counts: { total: number; ai: number; community: number; asia: number; local: number; uncategorized: number; merged_duplicates: number };
  weather: DigestSearchResult | null; headlines: ParsedHeadline[];
  sections: Record<ParsedHeadlineCategory, ParsedHeadline[]>;
  local_section: string; uncategorized_section: string; ai_sections: string[]; asia_sections: string[];
}

export interface DigestCacheRecord {
  id: string; cache_key: string; pipeline: Exclude<DigestPipelineMode, 'legacy'>; digest_date: string;
  city: string; source_hash: string; payload: PreparedDigestCachePayload; last_error: string | null;
  expires_at: string | null; created_at: string; updated_at: string;
}

export interface DigestDeliveryRecord {
  id: string; delivery_key: string; pipeline: Exclude<DigestPipelineMode, 'legacy'>; delivery_kind: DigestDeliveryKind;
  user_id: string; chat_id: number; city: string; digest_date: string; cache_key: string;
  status: DigestDeliveryStatus; attempt_count: number; last_error: string | null;
  sent_at: string | null; created_at: string; updated_at: string;
}

interface UpsertDigestCacheInput {
  cache_key: string; digest_date: string; city: string; source_hash: string;
  payload: PreparedDigestCachePayload; expires_at: string; last_error?: string | null;
}

interface UpsertDigestDeliveryInput {
  delivery_key: string; delivery_kind: DigestDeliveryKind; user_id: string; chat_id: number;
  city: string; digest_date: string; cache_key: string; status: DigestDeliveryStatus;
  attempt_count?: number; last_error?: string | null; sent_at?: string | null;
}

const HYBRID_PIPELINE: Exclude<DigestPipelineMode, 'legacy'> = 'hybrid_appwrite';

function docToCache(d: AppwriteDoc): DigestCacheRecord {
  return {
    id: d.$id ?? d.id, cache_key: d.cache_key, pipeline: d.pipeline, digest_date: d.digest_date,
    city: d.city, source_hash: d.source_hash,
    payload: typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload,
    last_error: d.last_error, expires_at: d.expires_at,
    created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt,
  };
}

function docToDelivery(d: AppwriteDoc): DigestDeliveryRecord {
  return {
    id: d.$id ?? d.id, delivery_key: d.delivery_key, pipeline: d.pipeline, delivery_kind: d.delivery_kind,
    user_id: d.user_id, chat_id: d.chat_id, city: d.city, digest_date: d.digest_date, cache_key: d.cache_key,
    status: d.status, attempt_count: d.attempt_count ?? 0, last_error: d.last_error,
    sent_at: d.sent_at, created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt,
  };
}

export const digestCacheRepo = {
  async getByKey(cacheKey: string): Promise<DigestCacheRecord | null> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL_CACHE, [Query.equal('cache_key', cacheKey), Query.limit(1)]);
      return r.documents.length > 0 ? docToCache(r.documents[0]!) : null;
    } catch (e) { dbLogger.error({ error: e, cacheKey }, 'Failed to get digest cache'); throw e; }
  },

  async listRecentCities(limit = 20): Promise<string[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL_CACHE, [
        Query.equal('pipeline', HYBRID_PIPELINE), Query.orderDesc('updated_at'), Query.limit(limit),
      ]);
      const seen = new Set<string>(); const cities: string[] = [];
      for (const d of r.documents) { const c = d.city?.trim(); if (c && !seen.has(c)) { seen.add(c); cities.push(c); } }
      return cities;
    } catch (e) { dbLogger.error({ error: e }, 'Failed to list cities'); throw e; }
  },

  async getLatestByCity(city: string): Promise<DigestCacheRecord | null> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL_CACHE, [
        Query.equal('pipeline', HYBRID_PIPELINE), Query.equal('city', city),
        Query.orderDesc('digest_date'), Query.orderDesc('updated_at'), Query.limit(1),
      ]);
      return r.documents.length > 0 ? docToCache(r.documents[0]!) : null;
    } catch (e) { dbLogger.error({ error: e, city }, 'Failed to get latest cache'); throw e; }
  },

  async upsert(input: UpsertDigestCacheInput): Promise<DigestCacheRecord> {
    const now = new Date().toISOString();
    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL_CACHE, [Query.equal('cache_key', input.cache_key), Query.limit(1)]);
    const docData = {
      pipeline: HYBRID_PIPELINE, cache_key: input.cache_key, digest_date: input.digest_date,
      city: input.city, source_hash: input.source_hash, payload: JSON.stringify(input.payload),
      expires_at: input.expires_at, last_error: input.last_error ?? null, updated_at: now,
    };
    if (r.documents.length > 0) {
      const doc = await aw.updateDocument(DB_ID(), COLL_CACHE, r.documents[0]!.$id, docData);
      return docToCache(doc);
    } else {
      const doc = await aw.createDocument(DB_ID(), COLL_CACHE, ID.unique(), { ...docData, created_at: now });
      return docToCache(doc);
    }
  },
};

export const digestDeliveryRepo = {
  async getByKey(deliveryKey: string): Promise<DigestDeliveryRecord | null> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL_DELIVERY, [Query.equal('delivery_key', deliveryKey), Query.limit(1)]);
      return r.documents.length > 0 ? docToDelivery(r.documents[0]!) : null;
    } catch (e) { dbLogger.error({ error: e, deliveryKey }, 'Failed to get delivery'); throw e; }
  },

  async upsert(input: UpsertDigestDeliveryInput): Promise<DigestDeliveryRecord> {
    const now = new Date().toISOString();
    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL_DELIVERY, [Query.equal('delivery_key', input.delivery_key), Query.limit(1)]);
    const docData = {
      pipeline: HYBRID_PIPELINE, delivery_key: input.delivery_key, delivery_kind: input.delivery_kind,
      user_id: input.user_id, chat_id: input.chat_id, city: input.city, digest_date: input.digest_date,
      cache_key: input.cache_key, status: input.status, attempt_count: input.attempt_count ?? 0,
      last_error: input.last_error ?? null, sent_at: input.sent_at ?? null, updated_at: now,
    };
    if (r.documents.length > 0) {
      const doc = await aw.updateDocument(DB_ID(), COLL_DELIVERY, r.documents[0]!.$id, docData);
      return docToDelivery(doc);
    } else {
      const doc = await aw.createDocument(DB_ID(), COLL_DELIVERY, ID.unique(), { ...docData, created_at: now });
      return docToDelivery(doc);
    }
  },
};
