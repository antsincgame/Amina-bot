export type ReconciliationStatus = 'safe' | 'review' | 'block';
export type ReconciliationDomain = 'telephony' | 'notes';
export type ReconciliationLogEventType =
  | 'message'
  | 'voice'
  | 'image'
  | 'command'
  | 'ai_response'
  | 'error'
  | 'memory_created'
  | 'memory_updated'
  | 'session_start'
  | 'session_end';

export interface ReconciliationCounts {
  total: number;
  safe: number;
  review: number;
  block: number;
}

export interface ReconciliationSummary extends ReconciliationCounts {
  domain: ReconciliationDomain;
}

export interface TelephonyMatchSignals {
  requestId: boolean;
  callId: boolean;
  phoneWindow: boolean;
}

export interface TelephonyReconciliationItem {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  scenarioName: string;
  targetPhone: string;
  status: ReconciliationStatus;
  sessionStatus: string;
  reasons: string[];
  stopPoints: string[];
  turnsCount: number;
  artifactsCount: number;
  eventsCount: number;
  hasOutcome: boolean;
  legacyMatches: number;
  exactMatches: number;
  matchSignals: TelephonyMatchSignals;
}

export interface TelephonyReconciliationDetail extends TelephonyReconciliationItem {
  transcriptPresent: boolean;
  resultSummaryPresent: boolean;
  callId: string | null;
  requestId: string | null;
  legacySessionIds: string[];
}

export interface NotesArtifactFlags {
  hasMarkdown: boolean;
  hasCodeFence: boolean;
  hasJsonLike: boolean;
  hasCitationMarkers: boolean;
  hasUrls: boolean;
  hasSearchChatter: boolean;
  hasToolishPrefixes: boolean;
  looksLikeGreetingOnly: boolean;
}

export interface NotesReconciliationItem {
  noteId: string;
  userId: string;
  createdAt: string;
  status: ReconciliationStatus;
  reasons: string[];
  preview: string;
  suggestedAction: 'keep' | 'soft_archive' | 'review';
  score: number;
  archiveState: 'active' | 'soft_archived';
  archivedAt: string | null;
  flags: NotesArtifactFlags;
}

export interface NotesNearbyLog {
  id: string;
  eventType: ReconciliationLogEventType;
  timestamp: string;
  preview: string;
}

export interface NotesReconciliationDetail extends NotesReconciliationItem {
  content: string;
  cleanPreview: string;
  nearbyLogs: NotesNearbyLog[];
}

export interface ReconciliationBatchPreview<TItem> {
  ids: string[];
  counts: ReconciliationCounts;
  items: TItem[];
  snapshotToken?: string;
}

export interface ReconciliationApplyContract {
  previewOnly: boolean;
  approvalRequired: boolean;
  staleCheck: string;
  auditTrail: string[];
  telephonyAllowedActions: string[];
  notesAllowedActions: string[];
}

export interface NotesSoftArchiveEntry {
  noteId: string;
  userId: string;
  archivedAt: string;
  archivedBy: string;
  approvalNote: string;
}

export interface NotesApplyResultItem {
  noteId: string;
  action: 'soft_archived' | 'already_archived' | 'skipped';
  message: string;
}

export interface NotesApplyBatchResult {
  counts: ReconciliationCounts;
  results: NotesApplyResultItem[];
}
