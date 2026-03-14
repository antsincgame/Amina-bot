import { getSupabase } from '../../../db/index.js';
import type { TelephonyCallArtifact } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

interface TelephonyCallArtifactRow {
  id: string;
  session_id: string;
  artifact_type: TelephonyCallArtifact['artifactType'];
  status: TelephonyCallArtifact['status'];
  url: string | null;
  storage_path: string | null;
  content: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  archive_status: TelephonyCallArtifact['archiveStatus'];
  retention_until: string | null;
  version: number | null;
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
    storagePath: row.storage_path,
    content: row.content,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationMs: row.duration_ms,
    checksumSha256: row.checksum_sha256,
    archiveStatus: row.archive_status,
    retentionUntil: row.retention_until,
    version: row.version ?? 1,
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
          storage_path: updates.storagePath,
          content: updates.content,
          mime_type: updates.mimeType,
          size_bytes: updates.sizeBytes,
          duration_ms: updates.durationMs,
          checksum_sha256: updates.checksumSha256,
          archive_status: updates.archiveStatus,
          retention_until: updates.retentionUntil,
          version: updates.version ?? 1,
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

  async getBySessionAndType(
    sessionId: string,
    artifactType: TelephonyCallArtifact['artifactType'],
  ): Promise<TelephonyCallArtifact | null> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_call_artifacts')
      .select('*')
      .eq('session_id', sessionId)
      .eq('artifact_type', artifactType)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? mapRowToArtifact(data as TelephonyCallArtifactRow) : null;
  },
};
