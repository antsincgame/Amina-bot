import type {
  TelephonyAiCallSession,
  TelephonyAiSessionStatus,
  TelephonyCallEventType,
  TelephonyCallTurn,
} from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { cleanText } from '../shared.js';
import { enqueueRecordingProcessing } from './postcall-job-worker.js';
import { getRealtimeBridgeConfig } from './realtime-bridge-config.js';
import { finalizeTelephonyTranscript } from './telephony-session-finalizer.js';
import { generateLiveAgentTurn } from './live-turn-engine.js';

type RealtimeBridgeEventAlias =
  | 'bridgeSessionStarted'
  | 'callDialing'
  | 'callConnected'
  | 'partialTranscriptUpdated'
  | 'transcriptFinalized'
  | 'agentTurnStarted'
  | 'agentTurnCompleted'
  | 'fallbackTriggered'
  | 'recordingArchived'
  | 'callCompleted'
  | 'callFailed'
  | 'callCancelled';

export interface RealtimeBridgeEventInput {
  sessionId: string;
  eventType: RealtimeBridgeEventAlias | TelephonyCallEventType | string;
  providerEventId?: string | null;
  requestId?: string | null;
  callId?: string | null;
  transcript?: string | null;
  replyText?: string | null;
  confidence?: number | null;
  latencyMs?: number | null;
  shouldEndCall?: boolean;
  shouldFallback?: boolean;
  fallbackReason?: string | null;
  recordingUrl?: string | null;
  recordingSignedUrl?: string | null;
  recordingStoragePath?: string | null;
  recordingMimeType?: string | null;
  recordingSizeBytes?: number | null;
  recordingDurationMs?: number | null;
  recordingChecksumSha256?: string | null;
  outcomeLabel?: string | null;
  resultSummary?: string | null;
  turnIndex?: number | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface RealtimeBridgeRespondInput {
  sessionId: string;
  transcript: string;
  bootstrap?: boolean;
  isFinal?: boolean;
  confidence?: number | null;
  latencyMs?: number | null;
  providerEventId?: string | null;
}

export interface RealtimeBridgeRespondResult {
  replyText: string;
  shouldEndCall: boolean;
  shouldFallback: boolean;
  fallbackReason: string | null;
  outcomeLabel: string;
  resultSummary: string;
}

function normalizeEventType(eventType: string): TelephonyCallEventType | string {
  switch (eventType) {
    case 'bridgeSessionStarted':
    case 'bridge_session_started':
      return 'bridge_session_started';
    case 'callDialing':
    case 'call_dialing':
      return 'call_dialing';
    case 'callConnected':
    case 'call_connected':
      return 'call_connected';
    case 'partialTranscriptUpdated':
    case 'partial_transcript_updated':
      return 'partial_transcript_updated';
    case 'transcriptFinalized':
    case 'transcript_finalized':
      return 'transcript_finalized';
    case 'agentTurnStarted':
    case 'agent_turn_started':
      return 'agent_turn_started';
    case 'agentTurnCompleted':
    case 'agent_turn_completed':
      return 'agent_turn_completed';
    case 'fallbackTriggered':
    case 'fallback_triggered':
      return 'fallback_triggered';
    case 'recordingArchived':
    case 'recording_archived':
      return 'recording_archived';
    case 'callCompleted':
    case 'call_completed':
      return 'call_completed';
    case 'callFailed':
    case 'call_failed':
      return 'call_failed';
    case 'callCancelled':
    case 'call_cancelled':
      return 'call_cancelled';
    default:
      return eventType;
  }
}

function buildRetentionUntil(retentionDays: number): string {
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Допустимые переходы состояний session-level.
 * Ключ = текущий статус, значение = набор статусов, в которые можно перейти.
 * Терминальные (processed, failed, cancelled) не принимают новых переходов.
 */
const SESSION_VALID_TRANSITIONS: Partial<Record<TelephonyAiSessionStatus, ReadonlySet<TelephonyAiSessionStatus>>> = {
  initiated: new Set(['queued', 'dialing', 'failed', 'cancelled']),
  queued: new Set(['dialing', 'live', 'fallback', 'failed', 'cancelled']),
  dialing: new Set(['live', 'fallback', 'failed', 'cancelled']),
  live: new Set(['linked', 'fallback', 'recorded', 'completed', 'failed', 'cancelled']),
  linked: new Set(['live', 'fallback', 'recorded', 'completed', 'failed', 'cancelled']),
  recorded: new Set(['completed', 'processed', 'failed']),
  completed: new Set(['processed', 'failed']),
  fallback: new Set(['completed', 'processed', 'failed', 'cancelled']),
};

function isValidTransition(from: TelephonyAiSessionStatus, to: TelephonyAiSessionStatus): boolean {
  if (from === to) {
    return true;
  }
  return SESSION_VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/** In-memory dedup set для providerEventId в рамках текущего процесса */
const processedProviderEvents = new Set<string>();

function isEventAlreadyProcessed(providerEventId: string | null | undefined): boolean {
  if (!providerEventId) {
    return false;
  }
  return processedProviderEvents.has(providerEventId);
}

function markEventProcessed(providerEventId: string | null | undefined): void {
  if (!providerEventId) {
    return;
  }
  processedProviderEvents.add(providerEventId);
  if (processedProviderEvents.size > 10_000) {
    const [first] = processedProviderEvents;
    if (first) {
      processedProviderEvents.delete(first);
    }
  }
}

async function updateRecordingArtifact(
  sessionId: string,
  event: RealtimeBridgeEventInput,
): Promise<void> {
  const recordingUrl = cleanText(event.recordingSignedUrl || event.recordingUrl);
  if (!recordingUrl && !cleanText(event.recordingStoragePath)) {
    return;
  }

  const config = await getRealtimeBridgeConfig();
  await callArtifactRepo.upsertForSession(sessionId, 'recording', {
    status: 'ready',
    url: recordingUrl || null,
    storagePath: cleanText(event.recordingStoragePath) || null,
    content: null,
    mimeType: cleanText(event.recordingMimeType) || null,
    sizeBytes: Number.isFinite(Number(event.recordingSizeBytes)) ? Number(event.recordingSizeBytes) : null,
    durationMs: Number.isFinite(Number(event.recordingDurationMs)) ? Number(event.recordingDurationMs) : null,
    checksumSha256: cleanText(event.recordingChecksumSha256) || null,
    archiveStatus: cleanText(event.recordingStoragePath) ? 'archived' : 'pending',
    retentionUntil: buildRetentionUntil(config.recordingRetentionDays),
    version: 1,
    metadata: {
      sourceUrl: cleanText(event.recordingUrl) || null,
      providerSignedUrl: cleanText(event.recordingSignedUrl) || null,
    },
  });
}

async function appendBridgeAgentTurn(
  sessionId: string,
  event: RealtimeBridgeEventInput,
): Promise<TelephonyCallTurn | null> {
  const replyText = cleanText(event.replyText);
  const rawTurnIndex = Number(event.turnIndex);
  if (!replyText || !Number.isFinite(rawTurnIndex) || rawTurnIndex <= 0) {
    return null;
  }

  return callTurnRepo.upsertForSession(sessionId, {
    turnIndex: rawTurnIndex,
    speaker: 'agent',
    source: 'realtime',
    content: replyText,
    confidence: null,
  });
}

const TERMINAL_STATUSES = new Set<TelephonyAiSessionStatus>(['processed', 'failed', 'cancelled']);

async function applySessionState(
  session: TelephonyAiCallSession,
  eventType: TelephonyCallEventType | string,
  event: RealtimeBridgeEventInput,
): Promise<TelephonyAiCallSession> {
  let nextStatus: TelephonyAiSessionStatus | undefined;

  switch (eventType) {
    case 'bridge_session_started':
      nextStatus = 'queued';
      break;
    case 'call_dialing':
      nextStatus = 'dialing';
      break;
    case 'call_connected':
      nextStatus = 'live';
      break;
    case 'fallback_triggered':
      nextStatus = 'fallback';
      break;
    case 'call_completed':
      nextStatus = 'completed';
      break;
    case 'call_cancelled':
      nextStatus = 'cancelled';
      break;
    case 'call_failed':
      nextStatus = 'failed';
      break;
    default:
      nextStatus = undefined;
  }

  if (!nextStatus && !event.requestId && !event.callId) {
    return session;
  }

  // Не переписываем терминальные статусы
  if (TERMINAL_STATUSES.has(session.status)) {
    if (nextStatus && nextStatus !== session.status) {
      return session;
    }
  }

  // Проверяем допустимость перехода через state-machine
  const safeNextStatus = (nextStatus && isValidTransition(session.status, nextStatus))
    ? nextStatus
    : session.status;

  return callSessionRepo.update(session.id, {
    requestId: cleanText(event.requestId) || session.requestId,
    callId: cleanText(event.callId) || session.callId,
    provider: 'media_bridge',
    status: safeNextStatus,
  });
}

export async function handleRealtimeBridgeEvent(
  event: RealtimeBridgeEventInput,
): Promise<TelephonyAiCallSession> {
  if (!event.sessionId || typeof event.sessionId !== 'string') {
    throw new Error('Bridge event: отсутствует sessionId');
  }
  if (!event.eventType || typeof event.eventType !== 'string') {
    throw new Error('Bridge event: отсутствует eventType');
  }

  // Idempotency: дубликат по providerEventId → возвращаем текущую сессию без обработки
  if (event.providerEventId && isEventAlreadyProcessed(event.providerEventId)) {
    const session = await callSessionRepo.getById(event.sessionId);
    if (session) {
      return session;
    }
  }

  const session = await callSessionRepo.getById(event.sessionId);
  if (!session) {
    throw new Error('Сессия realtime bridge не найдена');
  }

  const normalizedType = normalizeEventType(cleanText(event.eventType));
  const payload = {
    ...event.metadata,
    requestId: cleanText(event.requestId) || null,
    callId: cleanText(event.callId) || null,
    transcript: cleanText(event.transcript) || null,
    replyText: cleanText(event.replyText) || null,
    confidence: event.confidence ?? null,
    latencyMs: event.latencyMs ?? null,
    shouldEndCall: event.shouldEndCall === true,
    shouldFallback: event.shouldFallback === true,
    fallbackReason: cleanText(event.fallbackReason) || null,
    recordingUrl: cleanText(event.recordingUrl) || null,
    recordingSignedUrl: cleanText(event.recordingSignedUrl) || null,
    recordingStoragePath: cleanText(event.recordingStoragePath) || null,
    outcomeLabel: cleanText(event.outcomeLabel) || null,
    resultSummary: cleanText(event.resultSummary) || null,
    error: cleanText(event.error) || null,
    turnIndex: Number.isFinite(Number(event.turnIndex)) ? Number(event.turnIndex) : null,
  };

  const updatedSession = await applySessionState(session, normalizedType, event);
  await callEventRepo.record(updatedSession.id, normalizedType, payload, event.providerEventId);
  markEventProcessed(event.providerEventId);

  if (normalizedType === 'partial_transcript_updated') {
    const bridgeConfig = await getRealtimeBridgeConfig();
    if (bridgeConfig.storePartialTranscript) {
      await callArtifactRepo.upsertForSession(updatedSession.id, 'transcript_partial', {
        status: 'ready',
        url: null,
        storagePath: null,
        content: cleanText(event.transcript),
        mimeType: 'text/plain',
        sizeBytes: cleanText(event.transcript).length,
        durationMs: null,
        checksumSha256: null,
        archiveStatus: null,
        retentionUntil: null,
        version: 1,
        metadata: {
          confidence: event.confidence ?? null,
          latencyMs: event.latencyMs ?? null,
        },
      });
    }
  }

  if (normalizedType === 'agent_turn_completed') {
    await appendBridgeAgentTurn(updatedSession.id, event);
  }

  if (normalizedType === 'recording_archived') {
    await updateRecordingArtifact(updatedSession.id, event);
  }

  const transcript = cleanText(event.transcript);
  if (normalizedType === 'transcript_finalized' && transcript) {
    return finalizeTelephonyTranscript(updatedSession.id, transcript, {
      recordLink: cleanText(event.recordingSignedUrl || event.recordingUrl) || updatedSession.recordLink,
      finalStatus: 'processed',
      transcriptMetadata: {
        confidence: event.confidence ?? null,
        latencyMs: event.latencyMs ?? null,
      },
    });
  }

  if (normalizedType === 'call_completed') {
    if (transcript) {
      await updateRecordingArtifact(updatedSession.id, event);
      return finalizeTelephonyTranscript(updatedSession.id, transcript, {
        recordLink: cleanText(event.recordingSignedUrl || event.recordingUrl) || updatedSession.recordLink,
        finalStatus: 'processed',
        transcriptMetadata: {
          confidence: event.confidence ?? null,
          latencyMs: event.latencyMs ?? null,
        },
      });
    }

    const recordingUrl = cleanText(event.recordingUrl);
    if (recordingUrl) {
      await enqueueRecordingProcessing(updatedSession.id, recordingUrl);
    }
  }

  if (normalizedType === 'call_failed') {
    await callArtifactRepo.upsertForSession(updatedSession.id, 'analysis_report', {
      status: 'failed',
      url: cleanText(event.recordingUrl) || null,
      storagePath: null,
      content: cleanText(event.error) || 'Realtime bridge завершил звонок ошибкой',
      mimeType: 'text/plain',
      sizeBytes: null,
      durationMs: null,
      checksumSha256: null,
      archiveStatus: 'failed',
      retentionUntil: null,
      version: 1,
      metadata: {},
    });
  }

  return updatedSession;
}

export async function respondToRealtimeBridge(
  input: RealtimeBridgeRespondInput,
): Promise<RealtimeBridgeRespondResult> {
  const bridgeConfig = await getRealtimeBridgeConfig();
  if (
    Number.isFinite(Number(input.latencyMs))
    && Number(input.latencyMs) > bridgeConfig.latencyBudgetMs
  ) {
    const fallbackReason = `Latency budget exceeded: ${Number(input.latencyMs)}ms > ${bridgeConfig.latencyBudgetMs}ms`;
    await callSessionRepo.update(input.sessionId, { status: 'fallback' });
    await callEventRepo.record(input.sessionId, 'fallback_triggered', {
      fallbackReason,
      triggeredBy: 'latency_budget',
    }, input.providerEventId);

    return {
      replyText: '',
      shouldEndCall: false,
      shouldFallback: true,
      fallbackReason,
      outcomeLabel: 'неясно',
      resultSummary: 'Realtime session exceeded latency budget and requested fallback.',
    };
  }

  const result = await generateLiveAgentTurn({
    sessionId: input.sessionId,
    transcript: input.transcript,
    bootstrap: input.bootstrap === true,
    isFinal: input.isFinal !== false,
    confidence: input.confidence ?? null,
    latencyMs: input.latencyMs ?? null,
    providerEventId: input.providerEventId ?? null,
  });

  if (result.shouldFallback) {
    await callSessionRepo.update(input.sessionId, { status: 'fallback' });
  }

  return {
    replyText: result.replyText,
    shouldEndCall: result.shouldEndCall,
    shouldFallback: result.shouldFallback,
    fallbackReason: result.fallbackReason,
    outcomeLabel: result.outcomeLabel,
    resultSummary: result.resultSummary,
  };
}
