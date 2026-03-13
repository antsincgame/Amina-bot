import { getSupabase } from '../../../db/supabase.js';
import type { TelephonyCallArtifact } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

interface TelephonyCallArtifactRow {
  id: string;
  session_id: string;
  artifact_type: TelephonyCallArtifact['artifactType'];
  status: TelephonyCallArtifact['status'];
  url: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapRowToArtifact(row: TelephonyCallArtifactRow): TelephonyCallArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    artifactType: row.artifact_type,
    status: row.status,
    url: row.url,
    content: row.content,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const callArtifactRepo = {
  async upsertForSession(
    sessionId: string,
    artifactType: TelephonyCallArtifact['artifactType'],
    updates: Omit<TelephonyCallArtifact, 'id' | 'sessionId' | 'artifactType' | 'createdAt' | 'updatedAt'>,
  ): Promise<TelephonyCallArtifact> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_artifacts')
      .upsert(
        {
          session_id: sessionId,
          artifact_type: artifactType,
          status: updates.status,
          url: updates.url,
          content: updates.content,
          metadata: updates.metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'session_id,artifact_type' },
      )
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return mapRowToArtifact(data as TelephonyCallArtifactRow);
  },

  async listBySession(sessionId: string): Promise<TelephonyCallArtifact[]> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_artifacts')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    return ((data as TelephonyCallArtifactRow[] | null) ?? []).map(mapRowToArtifact);
  },
};
