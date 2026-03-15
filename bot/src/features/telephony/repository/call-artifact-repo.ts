/**
 * Call Artifact Repository — dual backend (Appwrite primary)
 */

import { config } from '../../../config/index.js';
import { getSupabase } from '../../../db/index.js';
import { ID, Query } from 'node-appwrite';
import type { TelephonyCallArtifact } from '../../../../../shared/types/telephony.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const useAW = () => config.dbBackend === 'appwrite';
const COLL = 'amina_tel_artifacts';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToArtifact(d: any): TelephonyCallArtifact {
  const metadata = typeof d.metadata === 'string' ? (JSON.parse(d.metadata || '{}')) : (d.metadata ?? {});
  return {
    id: d.$id,
    sessionId: d.session_id,
    artifactType: d.artifact_type,
    status: d.status,
    url: d.url || null,
    storagePath: d.storage_path || null,
    content: d.content || null,
    mimeType: d.mime_type || null,
    sizeBytes: d.size_bytes ?? null,
    durationMs: d.duration_ms ?? null,
    checksumSha256: d.checksum_sha256 || null,
    archiveStatus: d.archive_status || null,
    retentionUntil: d.retention_until || null,
    version: d.version ?? 1,
    metadata,
    createdAt: d.created_at || d.$createdAt,
    updatedAt: d.updated_at || d.$updatedAt,
  };
}

export const callArtifactRepo = {
  async upsertForSession(
    sessionId: string,
    artifactType: TelephonyCallArtifact['artifactType'],
    updates: Omit<TelephonyCallArtifact, 'id' | 'sessionId' | 'artifactType' | 'createdAt' | 'updatedAt'>,
  ): Promise<TelephonyCallArtifact> {
    await ensureTelephonyInfra();

    const now = new Date().toISOString();

    if (useAW()) {
      const aw = await getAW();
      const payload = {
        session_id: sessionId,
        artifact_type: artifactType,
        status: updates.status,
        url: updates.url || null,
        storage_path: updates.storagePath || null,
        content: updates.content || null,
        mime_type: updates.mimeType || null,
        size_bytes: updates.sizeBytes ?? null,
        duration_ms: updates.durationMs ?? null,
        checksum_sha256: updates.checksumSha256 || null,
        archive_status: updates.archiveStatus || null,
        retention_until: updates.retentionUntil || null,
        version: updates.version ?? 1,
        metadata: JSON.stringify(updates.metadata ?? {}),
        updated_at: now,
      };

      // Find existing by session_id + artifact_type (unique constraint)
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId),
        Query.equal('artifact_type', artifactType),
        Query.limit(1),
      ]);

      if (r.documents.length > 0) {
        const doc = await aw.updateDocument(DB_ID(), COLL, r.documents[0]!.$id, payload);
        return docToArtifact(doc);
      } else {
        const doc = await aw.createDocument(DB_ID(), COLL, ID.unique(), { ...payload, created_at: now });
        return docToArtifact(doc);
      }
    } else {
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
            updated_at: now,
          },
          { onConflict: 'session_id,artifact_type' },
        )
        .select('*')
        .single();
      if (error) throw error;
      return mapRowToArtifact(data as TelephonyCallArtifactRow);
    }
  },

  async listBySession(sessionId: string): Promise<TelephonyCallArtifact[]> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId),
        Query.orderAsc('created_at'),
        Query.limit(100),
      ]);
      return r.documents.map(docToArtifact);
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_artifacts')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return ((data as TelephonyCallArtifactRow[] | null) ?? []).map(mapRowToArtifact);
    }
  },

  async getBySessionAndType(
    sessionId: string,
    artifactType: TelephonyCallArtifact['artifactType'],
  ): Promise<TelephonyCallArtifact | null> {
    await ensureTelephonyInfra();

    if (useAW()) {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL, [
        Query.equal('session_id', sessionId),
        Query.equal('artifact_type', artifactType),
        Query.limit(1),
      ]);
      return r.documents.length > 0 ? docToArtifact(r.documents[0]) : null;
    } else {
      const { data, error } = await getSupabase()
        .from('telephony_call_artifacts')
        .select('*')
        .eq('session_id', sessionId)
        .eq('artifact_type', artifactType)
        .maybeSingle();
      if (error) throw error;
      return data ? mapRowToArtifact(data as TelephonyCallArtifactRow) : null;
    }
  },
};
