export type TelephonyAiScenarioMode = 'speech' | 'ask_question';
export type TelephonyRuntimeMode = 'scripted' | 'hybrid' | 'realtime';
export type TelephonyFallbackMode = 'scripted' | 'fail';
export type TelephonyProvider = 'lirax' | 'media_bridge' | 'unknown';

export type TelephonyAiSessionStatus =
  | 'initiated'
  | 'queued'
  | 'dialing'
  | 'live'
  | 'linked'
  | 'recorded'
  | 'completed'
  | 'processed'
  | 'fallback'
  | 'cancelled'
  | 'failed';

export type TelephonyCallEventType =
  | 'call_started'
  | 'bridge_session_started'
  | 'call_dialing'
  | 'call_connected'
  | 'runtime_selected'
  | 'runtime_fallback'
  | 'fallback_triggered'
  | 'provider_request_sent'
  | 'provider_request_accepted'
  | 'webhook_event_received'
  | 'partial_transcript_updated'
  | 'transcript_finalized'
  | 'agent_turn_started'
  | 'agent_turn_completed'
  | 'recording_archived'
  | 'call_linked'
  | 'record_enqueued'
  | 'record_processed'
  | 'record_processing_failed'
  | 'call_cancelled'
  | 'call_failed'
  | 'call_completed';

export type TelephonyCallArtifactType =
  | 'recording'
  | 'transcript_partial'
  | 'transcript_final'
  | 'transcript'
  | 'summary'
  | 'analysis_report';

export type TelephonyCallArtifactStatus = 'pending' | 'ready' | 'failed';
export type TelephonyCallTurnSpeaker = 'agent' | 'customer' | 'system';
export type TelephonyCallTurnSource = 'script' | 'transcript' | 'summary' | 'shadow' | 'realtime';
export type TelephonyCallJobType = 'process_recording';
export type TelephonyCallJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface TelephonyAiScenarioPolicy {
  allowedClaims: string[];
  requiredSlots: string[];
  exitConditions: string[];
  handoffRules: string[];
  maxSilenceMs: number;
  maxTurns: number;
  fallbackMode: TelephonyFallbackMode;
}

export interface TelephonyAiScenario {
  id: string;
  name: string;
  enabled: boolean;
  callMode: TelephonyAiScenarioMode;
  runtimeMode: TelephonyRuntimeMode;
  policyVersion: number;
  policy: TelephonyAiScenarioPolicy;
  goal: string;
  systemPrompt: string;
  openingLine: string;
  questionHint: string;
  successCriteria: string;
  resultPrompt: string;
  maxSpeechChars: number;
  createdAt: string;
  updatedAt: string;
}

export interface TelephonyAiCallPlan {
  summary: string;
  callMode: TelephonyAiScenarioMode;
  speechText: string | null;
  helloText: string | null;
  askText: string | null;
  okText: string | null;
  byeText: string | null;
  successHint: string | null;
}

export interface TelephonyAiCallSession {
  id: string;
  ownerTelegramId: string;
  initiatedBy: string;
  scenarioId: string;
  scenarioName: string;
  scenarioGoal: string;
  callMode: TelephonyAiScenarioMode;
  runtimeMode: TelephonyRuntimeMode;
  policyVersion: number;
  provider: TelephonyProvider;
  targetPhone: string;
  task: string;
  summary: string;
  successCriteria: string;
  resultPrompt: string;
  requestId: string | null;
  requestMode: string;
  callId: string | null;
  recordLink: string | null;
  transcript: string | null;
  resultSummary: string | null;
  outcomeLabel: string | null;
  status: TelephonyAiSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TelephonyCallEvent {
  id: string;
  sessionId: string;
  eventType: TelephonyCallEventType | string;
  providerEventId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TelephonyCallTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  speaker: TelephonyCallTurnSpeaker;
  source: TelephonyCallTurnSource;
  content: string;
  confidence: number | null;
  createdAt: string;
}

export interface TelephonyCallArtifact {
  id: string;
  sessionId: string;
  artifactType: TelephonyCallArtifactType;
  status: TelephonyCallArtifactStatus;
  url: string | null;
  storagePath: string | null;
  content: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  checksumSha256: string | null;
  archiveStatus: 'pending' | 'archived' | 'failed' | null;
  retentionUntil: string | null;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TelephonyCallOutcome {
  id: string;
  sessionId: string;
  outcomeLabel: string;
  resultSummary: string;
  confidence: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TelephonyCallJob {
  id: string;
  sessionId: string;
  jobType: TelephonyCallJobType;
  status: TelephonyCallJobStatus;
  dedupeKey: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  lockedAt: string | null;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
