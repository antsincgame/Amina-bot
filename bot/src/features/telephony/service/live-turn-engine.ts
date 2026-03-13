import { aiService } from '../../../ai/openrouter.js';
import type { TelephonyCallTurn } from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { assembleConversationContext } from './conversation-context-assembler.js';
import { cleanText, extractJsonObject, safeJsonParse, truncateText } from '../shared.js';
import { buildInitialAgentReplyFromPlan } from './telephony-plan.js';

const LIVE_TURN_MAX_TOKENS = 500;
const LIVE_TURN_TEMPERATURE = 0.35;

interface LiveTurnModelResponse {
  replyText?: string;
  shouldEndCall?: boolean;
  shouldFallback?: boolean;
  fallbackReason?: string | null;
  outcomeLabel?: string;
  resultSummary?: string;
}

export interface LiveTurnEngineRequest {
  sessionId: string;
  transcript: string;
  isFinal: boolean;
  bootstrap?: boolean;
  confidence?: number | null;
  latencyMs?: number | null;
  providerEventId?: string | null;
}

export interface LiveTurnEngineResult {
  replyText: string;
  shouldEndCall: boolean;
  shouldFallback: boolean;
  fallbackReason: string | null;
  outcomeLabel: string;
  resultSummary: string;
  customerTurn: TelephonyCallTurn | null;
  agentTurn: TelephonyCallTurn | null;
}

function buildFallbackReply(transcript: string): string {
  const cleanTranscript = cleanText(transcript).toLowerCase();
  if (!cleanTranscript) {
    return 'Повторите, пожалуйста, ещё раз.';
  }

  if (cleanTranscript.includes('неудобно') || cleanTranscript.includes('позже')) {
    return 'Поняла вас. Уточните, пожалуйста, когда будет удобно созвониться повторно.';
  }

  if (cleanTranscript.includes('да') || cleanTranscript.includes('подтверж')) {
    return 'Отлично, спасибо. Я зафиксировала подтверждение.';
  }

  if (cleanTranscript.includes('нет') || cleanTranscript.includes('отказ')) {
    return 'Поняла. Спасибо за ответ, я передам владельцу.';
  }

  return 'Спасибо, я зафиксировала ваш ответ.';
}

function normalizeModelResponse(
  raw: LiveTurnModelResponse | null,
  transcript: string,
): Omit<LiveTurnEngineResult, 'customerTurn' | 'agentTurn'> {
  const replyText = cleanText(raw?.replyText) || buildFallbackReply(transcript);
  const shouldEndCall = raw?.shouldEndCall === true;
  const shouldFallback = raw?.shouldFallback === true;
  const fallbackReason = cleanText(raw?.fallbackReason || null) || null;
  const outcomeLabel = cleanText(raw?.outcomeLabel || 'неясно') || 'неясно';
  const resultSummary = cleanText(raw?.resultSummary || truncateText(transcript, 220)) || truncateText(transcript, 220);

  return {
    replyText,
    shouldEndCall,
    shouldFallback,
    fallbackReason,
    outcomeLabel,
    resultSummary,
  };
}

async function storeTranscriptProgress(input: LiveTurnEngineRequest, transcript: string): Promise<void> {
  if (!transcript) {
    return;
  }

  await callArtifactRepo.upsertForSession(input.sessionId, 'transcript_partial', {
    status: 'ready',
    url: null,
    storagePath: null,
    content: transcript,
    mimeType: 'text/plain',
    sizeBytes: transcript.length,
    durationMs: null,
    checksumSha256: null,
    archiveStatus: null,
    retentionUntil: null,
    version: 1,
    metadata: {
      isFinal: input.isFinal,
      confidence: input.confidence ?? null,
      latencyMs: input.latencyMs ?? null,
      providerEventId: input.providerEventId ?? null,
    },
  });

  await callEventRepo.record(input.sessionId, 'partial_transcript_updated', {
    transcript,
    isFinal: input.isFinal,
    confidence: input.confidence ?? null,
    latencyMs: input.latencyMs ?? null,
  }, input.providerEventId);
}

function shouldBootstrapTurn(
  input: LiveTurnEngineRequest,
  transcript: string,
  agentTurnCount: number,
  totalTurnCount: number,
): boolean {
  return (input.bootstrap === true || !transcript) && agentTurnCount === 0 && totalTurnCount === 0;
}

async function appendCustomerTurn(
  input: LiveTurnEngineRequest,
  transcript: string,
): Promise<TelephonyCallTurn | null> {
  if (!input.isFinal || !transcript) {
    return null;
  }

  return callTurnRepo.appendForSession(input.sessionId, {
    speaker: 'customer',
    source: 'realtime',
    content: transcript,
    confidence: input.confidence ?? null,
  });
}

async function createBootstrapAgentTurn(input: LiveTurnEngineRequest, assembly: Awaited<ReturnType<typeof assembleConversationContext>>): Promise<LiveTurnEngineResult> {
  const replyText = buildInitialAgentReplyFromPlan(assembly.plan, assembly.session.task)
    || 'Здравствуйте. Уточню один важный момент по звонку.';
  const shouldEndCall = assembly.plan?.callMode === 'speech';

  await callEventRepo.record(input.sessionId, 'agent_turn_started', {
    isFinal: input.isFinal,
    transcript: null,
    bootstrap: true,
  }, input.providerEventId);

  const agentTurn = await callTurnRepo.appendForSession(input.sessionId, {
    speaker: 'agent',
    source: 'realtime',
    content: replyText,
    confidence: null,
  });

  await callEventRepo.record(input.sessionId, 'agent_turn_completed', {
    replyText,
    bootstrap: true,
    shouldEndCall,
    shouldFallback: false,
    fallbackReason: null,
    outcomeLabel: 'неясно',
  }, input.providerEventId);

  return {
    replyText,
    shouldEndCall,
    shouldFallback: false,
    fallbackReason: null,
    outcomeLabel: 'неясно',
    resultSummary: assembly.plan?.summary || assembly.session.summary || truncateText(assembly.session.task, 220),
    customerTurn: null,
    agentTurn,
  };
}

export async function generateLiveAgentTurn(
  input: LiveTurnEngineRequest,
): Promise<LiveTurnEngineResult> {
  const transcript = cleanText(input.transcript);
  const assembly = await assembleConversationContext(input.sessionId, transcript);
  const agentTurnCount = assembly.turns.filter((turn) => turn.speaker === 'agent').length;

  await storeTranscriptProgress(input, transcript);

  if (shouldBootstrapTurn(input, transcript, agentTurnCount, assembly.turns.length)) {
    return createBootstrapAgentTurn(input, assembly);
  }

  const maxTurnsReached = agentTurnCount >= assembly.scenario.policy.maxTurns;
  if (maxTurnsReached) {
    const customerTurn = await appendCustomerTurn(input, transcript);

    const agentTurn = await callTurnRepo.appendForSession(input.sessionId, {
      speaker: 'agent',
      source: 'realtime',
      content: 'Благодарю, у меня уже достаточно информации. Я передам итог владельцу. До свидания.',
      confidence: null,
    });

    await callEventRepo.record(input.sessionId, 'agent_turn_completed', {
      replyText: agentTurn.content,
      maxTurnsReached: true,
      shouldEndCall: true,
    });

    return {
      replyText: agentTurn.content,
      shouldEndCall: true,
      shouldFallback: false,
      fallbackReason: null,
      outcomeLabel: 'неясно',
      resultSummary: 'Достигнут лимит ходов realtime-сценария.',
      customerTurn,
      agentTurn,
    };
  }

  await callEventRepo.record(input.sessionId, 'agent_turn_started', {
    isFinal: input.isFinal,
    transcript,
  }, input.providerEventId);

  const aiResult = await aiService.chat(
    assembly.messages,
    'voice',
    undefined,
    {
      promptMode: 'passthrough',
      maxTokens: LIVE_TURN_MAX_TOKENS,
      temperature: LIVE_TURN_TEMPERATURE,
    },
  );

  const parsed = safeJsonParse<LiveTurnModelResponse>(extractJsonObject(aiResult.content) ?? '');
  const normalized = normalizeModelResponse(parsed, transcript);

  const customerTurn = await appendCustomerTurn(input, transcript);

  const agentTurn = await callTurnRepo.appendForSession(input.sessionId, {
    speaker: 'agent',
    source: 'realtime',
    content: normalized.replyText,
    confidence: null,
  });

  await callEventRepo.record(input.sessionId, 'agent_turn_completed', {
    replyText: normalized.replyText,
    shouldEndCall: normalized.shouldEndCall,
    shouldFallback: normalized.shouldFallback,
    fallbackReason: normalized.fallbackReason,
    outcomeLabel: normalized.outcomeLabel,
  }, input.providerEventId);

  if (normalized.shouldFallback) {
    await callEventRepo.record(input.sessionId, 'fallback_triggered', {
      fallbackReason: normalized.fallbackReason,
      triggeredBy: 'live_turn_engine',
    }, input.providerEventId);
  }

  return {
    ...normalized,
    customerTurn,
    agentTurn,
  };
}
