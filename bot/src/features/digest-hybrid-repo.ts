import { getSupabase } from '../db/supabase.js';
import { dbLogger } from '../config/logger.js';
import type { ParsedHeadline, ParsedHeadlineCategory, DigestPipelineMode } from '../../../shared/types/index.js';
import type { DigestSearchResult } from './digest-core.js';

export type DigestDeliveryKind = 'manual' | 'scheduled' | 'api';
export type DigestDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface PreparedDigestCachePayload {
  version: string;
  city: string;
  generated_at: string;
  digest_date: string;
  source_hash: string;
  counts: {
    total: number;
    ai: number;
    community: number;
    asia: number;
    local: number;
    uncategorized: number;
    merged_duplicates: number;
  };
  weather: DigestSearchResult | null;
  headlines: ParsedHeadline[];
  sections: Record<ParsedHeadlineCategory, ParsedHeadline[]>;
  local_section: string;
  uncategorized_section: string;
  ai_sections: string[];
  asia_sections: string[];
}

export interface DigestCacheRecord {
  id: string;
  cache_key: string;
  pipeline: Exclude<DigestPipelineMode, 'legacy'>;
  digest_date: string;
  city: string;
  source_hash: string;
  payload: PreparedDigestCachePayload;
  last_error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DigestDeliveryRecord {
  id: string;
  delivery_key: string;
  pipeline: Exclude<DigestPipelineMode, 'legacy'>;
  delivery_kind: DigestDeliveryKind;
  user_id: string;
  chat_id: number;
  city: string;
  digest_date: string;
  cache_key: string;
  status: DigestDeliveryStatus;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface UpsertDigestCacheInput {
  cache_key: string;
  digest_date: string;
  city: string;
  source_hash: string;
  payload: PreparedDigestCachePayload;
  expires_at: string;
  last_error?: string | null;
}

interface UpsertDigestDeliveryInput {
  delivery_key: string;
  delivery_kind: DigestDeliveryKind;
  user_id: string;
  chat_id: number;
  city: string;
  digest_date: string;
  cache_key: string;
  status: DigestDeliveryStatus;
  attempt_count?: number;
  last_error?: string | null;
  sent_at?: string | null;
}

const HYBRID_PIPELINE: Exclude<DigestPipelineMode, 'legacy'> = 'hybrid_supabase';

export const digestCacheRepo = {
  async getByKey(cacheKey: string): Promise<DigestCacheRecord | null> {
    const { data, error } = await getSupabase()
      .from('digest_caches')
      .select('*')
      .eq('cache_key', cacheKey)
      .maybeSingle();

    if (error) {
      dbLogger.error({ error, cacheKey }, 'Failed to get digest cache');
      throw error;
    }

    return (data as DigestCacheRecord | null) ?? null;
  },

  async listRecentCities(limit = 20): Promise<string[]> {
    const { data, error } = await getSupabase()
      .from('digest_caches')
      .select('city, updated_at')
      .eq('pipeline', HYBRID_PIPELINE)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      dbLogger.error({ error, limit }, 'Failed to list recent digest cache cities');
      throw error;
    }

    const seenCities = new Set<string>();
    const orderedCities: string[] = [];

    ((data as Array<{ city: string | null }> | null) ?? []).forEach(item => {
      const normalizedCity = item.city?.trim();
      if (!normalizedCity || seenCities.has(normalizedCity)) return;
      seenCities.add(normalizedCity);
      orderedCities.push(normalizedCity);
    });

    return orderedCities;
  },

  async getLatestByCity(city: string): Promise<DigestCacheRecord | null> {
    const { data, error } = await getSupabase()
      .from('digest_caches')
      .select('*')
      .eq('pipeline', HYBRID_PIPELINE)
      .eq('city', city)
      .order('digest_date', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      dbLogger.error({ error, city }, 'Failed to get latest digest cache by city');
      throw error;
    }

    return (data as DigestCacheRecord | null) ?? null;
  },

  async upsert(input: UpsertDigestCacheInput): Promise<DigestCacheRecord> {
    const { data, error } = await getSupabase()
      .from('digest_caches')
      .upsert(
        {
          pipeline: HYBRID_PIPELINE,
          cache_key: input.cache_key,
          digest_date: input.digest_date,
          city: input.city,
          source_hash: input.source_hash,
          payload: input.payload,
          expires_at: input.expires_at,
          last_error: input.last_error ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cache_key' },
      )
      .select('*')
      .single();

    if (error) {
      dbLogger.error({ error, cacheKey: input.cache_key }, 'Failed to upsert digest cache');
      throw error;
    }

    return data as DigestCacheRecord;
  },
};

export const digestDeliveryRepo = {
  async getByKey(deliveryKey: string): Promise<DigestDeliveryRecord | null> {
    const { data, error } = await getSupabase()
      .from('digest_deliveries')
      .select('*')
      .eq('delivery_key', deliveryKey)
      .maybeSingle();

    if (error) {
      dbLogger.error({ error, deliveryKey }, 'Failed to get digest delivery');
      throw error;
    }

    return (data as DigestDeliveryRecord | null) ?? null;
  },

  async upsert(input: UpsertDigestDeliveryInput): Promise<DigestDeliveryRecord> {
    const { data, error } = await getSupabase()
      .from('digest_deliveries')
      .upsert(
        {
          pipeline: HYBRID_PIPELINE,
          delivery_key: input.delivery_key,
          delivery_kind: input.delivery_kind,
          user_id: input.user_id,
          chat_id: input.chat_id,
          city: input.city,
          digest_date: input.digest_date,
          cache_key: input.cache_key,
          status: input.status,
          attempt_count: input.attempt_count ?? 0,
          last_error: input.last_error ?? null,
          sent_at: input.sent_at ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'delivery_key' },
      )
      .select('*')
      .single();

    if (error) {
      dbLogger.error({ error, deliveryKey: input.delivery_key }, 'Failed to upsert digest delivery');
      throw error;
    }

    return data as DigestDeliveryRecord;
  },
};
