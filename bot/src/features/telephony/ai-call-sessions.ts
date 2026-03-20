import { aiLogger } from '../../config/logger.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
} from '../../../../shared/types/telephony.js';
import { callEventRepo } from './repository/call-event-repo.js';
import { callSessionRepo } from './repository/call-session-repo.js';
import { enqueueRecordingProcessing } from './service/postcall-job-worker.js';
import { sendTelephonyOwnerMessage } from './service/notification-service.js';
import { cleanText, escapeHtml, normalizePhone } from './shared.js';

interface RegisterTelephonyAiCallSessionParams {
  ownerTelegramId: string;
  initiatedBy: string;
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan;
  phone: string;
  task: string;
  requestId: string | null;
  requestMode: string;
}

export async function registerTelephonyAiCallSession(
  params: RegisterTelephonyAiCallSessionParams,
): Promise<TelephonyAiCallSession> {
  const session = await callSessionRepo.create({
    ownerTelegramId: params.ownerTelegramId,
    initiatedBy: params.initiatedBy,
    scenarioId: params.scenario.id,
    scenarioName: params.scenario.name,
    scenarioGoal: params.scenario.goal,
    callMode: params.plan.callMode,
    runtimeMode: params.scenario.runtimeMode,
    policyVersion: params.scenario.policyVersion,
    provider: 'unknown',
    targetPhone: normalizePhone(params.phone),
    task: cleanText(params.task),
    summary: cleanText(params.plan.summary),
    successCriteria: params.scenario.successCriteria,
    resultPrompt: params.scenario.resultPrompt,
    requestId: cleanText(params.requestId),
    requestMode: cleanText(params.requestMode) || 'unknown',
    callId: null,
    recordLink: null,
    transcript: null,
    resultSummary: null,
    outcomeLabel: null,
    status: 'initiated',
  });

  await callEventRepo.record(session.id, 'call_started', {
    scenarioId: params.scenario.id,
    plan: params.plan,
  });
  return session;
}

export async function getTelephonyAiCallSessions(limit = 20): Promise<TelephonyAiCallSession[]> {
  return callSessionRepo.listRecent(limit);
}

export async function linkTelephonyAiSessionCallId(
  phone: string,
  callId: string,
): Promise<TelephonyAiCallSession | null> {
  const session = await callSessionRepo.findPendingByPhone(phone);
  if (!session) {
    return null;
  }

  const updatedSession = await callSessionRepo.update(session.id, {
    callId,
    status: 'linked',
  });
  await callEventRepo.record(updatedSession.id, 'call_linked', {
    phone: normalizePhone(phone),
    callId,
  });
  return updatedSession;
}

export async function failTelephonyAiCallByRequestId(
  requestId: string,
): Promise<TelephonyAiCallSession | null> {
  const session = await callSessionRepo.getByRequestId(requestId);
  if (!session) {
    return null;
  }

  const updatedSession = await callSessionRepo.update(session.id, { status: 'failed' });
  await callEventRepo.record(updatedSession.id, 'call_failed', {
    requestId: updatedSession.requestId,
  });
  await sendTelephonyOwnerMessage(
    updatedSession.ownerTelegramId,
    `📵 <b>AI-звонок не состоялся</b>\nСценарий: <b>${escapeHtml(updatedSession.scenarioName)}</b>\nНомер: <code>${escapeHtml(updatedSession.targetPhone)}</code>`,
  );

  return updatedSession;
}

export async function processTelephonyAiCallRecording(
  callId: string,
  recordLink: string,
): Promise<TelephonyAiCallSession | null> {
  const session = await callSessionRepo.getByCallId(callId);
  if (!session) {
    return null;
  }

  try {
    await callEventRepo.record(session.id, 'webhook_event_received', {
      cmd: 'record',
      callId,
      recordLink,
    });
    await enqueueRecordingProcessing(session.id, recordLink);
    return session;
  } catch (error) {
    aiLogger.error({ error, callId }, '[Telephony AI] Failed to process call recording');
    return null;
  }
}
