import { FETCH_TIMEOUT_MS } from '../../../config/constants.js';
import type { TelephonyAiCallSession } from '../../../../../shared/types/telephony.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { cleanText } from '../shared.js';
import { handleRealtimeBridgeEvent, type RealtimeBridgeEventInput } from './realtime-bridge-service.js';
import type { CallRuntime, CallRuntimeContext, CallRuntimeResult } from './runtime-types.js';
import { getRealtimeBridgeConfig, getRealtimeBridgeRuntimeProfile } from './realtime-bridge-config.js';
import { finalizeTelephonyTranscript } from './telephony-session-finalizer.js';
import {
  buildInitialAgentReplyFromPlan,
  buildInitialAgentTurns,
  buildRealtimeBridgePlan,
  type TelephonyInitialAgentTurn,
} from './telephony-plan.js';

export interface RealtimeBridgeStartPayload {
  sessionId: string;
  ownerTelegramId: string;
  phone: string;
  task: string;
  scenario: {
    id: string;
    name: string;
    runtimeMode: CallRuntimeContext['scenario']['runtimeMode'];
    policyVersion: number;
    policy: CallRuntimeContext['scenario']['policy'];
    callMode: CallRuntimeContext['scenario']['callMode'];
  };
  plan: CallRuntimeContext['plan'];
  initialAgentText: string;
  initialAgentTurns: TelephonyInitialAgentTurn[];
  firstQuestionText: string | null;
  callbacks: {
    eventsUrl: string;
    respondUrl: string;
    bootstrapOnConnect: boolean;
  };
  voice: Awaited<ReturnType<typeof getRealtimeBridgeRuntimeProfile>>['voice'];
  speech: Awaited<ReturnType<typeof getRealtimeBridgeRuntimeProfile>>['speech'];
  archive: {
    enabled: boolean;
    retentionDays: number;
    storePartialTranscript: boolean;
  };
  latencyBudgetMs: number;
  telephony: {
    ai: {
      provider: string;
      openrouterModel: string | null;
    };
    sip: {
      server: string | null;
      login: string | null;
      password: string | null;
      externalNumber: string | null;
    };
  };
}

export interface MediaBridgeResponse {
  requestId?: string;
  callId?: string;
  mode?: string;
  bridgeSessionId?: string;
  accepted?: boolean;
}

export interface RealtimeRuntimeProvider {
  start(context: CallRuntimeContext): Promise<CallRuntimeResult>;
  receiveCallback(event: RealtimeBridgeEventInput): Promise<TelephonyAiCallSession>;
  finalize(
    sessionId: string,
    transcript: string,
    recordLink?: string | null,
  ): Promise<TelephonyAiCallSession>;
  fallback(
    sessionId: string,
    reason: string,
  ): Promise<TelephonyAiCallSession>;
}

export async function buildRealtimeBridgeStartPayload(
  context: CallRuntimeContext,
): Promise<RealtimeBridgeStartPayload> {
  const runtimeProfile = await getRealtimeBridgeRuntimeProfile();
  const initialAgentText = buildInitialAgentReplyFromPlan(context.plan, context.task);
  const providerPlan = buildRealtimeBridgePlan(context.plan, context.task);

  return {
    sessionId: context.session.id,
    ownerTelegramId: context.session.ownerTelegramId,
    phone: context.phone,
    task: context.task,
    scenario: {
      id: context.scenario.id,
      name: context.scenario.name,
      runtimeMode: context.scenario.runtimeMode,
      policyVersion: context.scenario.policyVersion,
      policy: context.scenario.policy,
      callMode: context.scenario.callMode,
    },
    plan: providerPlan,
    initialAgentText,
    initialAgentTurns: buildInitialAgentTurns(context.plan),
    firstQuestionText: cleanText(context.plan.askText) || null,
    callbacks: {
      ...runtimeProfile.callbacks,
      bootstrapOnConnect: true,
    },
    voice: runtimeProfile.voice,
    speech: runtimeProfile.speech,
    archive: {
      enabled: runtimeProfile.config.archiveRecordings,
      retentionDays: runtimeProfile.config.recordingRetentionDays,
      storePartialTranscript: runtimeProfile.config.storePartialTranscript,
    },
    latencyBudgetMs: runtimeProfile.config.latencyBudgetMs,
    telephony: {
      ai: {
        provider: runtimeProfile.config.aiProvider,
        openrouterModel: runtimeProfile.config.openrouterModel || null,
      },
      sip: {
        server: runtimeProfile.config.sipServer || null,
        login: runtimeProfile.config.sipLogin || null,
        password: runtimeProfile.config.sipPassword || null,
        externalNumber: runtimeProfile.config.externalNumber || null,
      },
    },
  };
}

async function startMediaBridgeSession(
  context: CallRuntimeContext,
): Promise<CallRuntimeResult> {
  const config = await getRealtimeBridgeConfig();
  if (!config.enabled || !config.url) {
    throw new Error('Realtime media bridge is not configured');
  }

  const startPayload = await buildRealtimeBridgeStartPayload(context);

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(startPayload),
  });

  if (!response.ok) {
    throw new Error(`Realtime media bridge error ${response.status}`);
  }

  const responsePayload = await response.json().catch(() => ({})) as MediaBridgeResponse;

  return {
    provider: 'media_bridge',
    requestId: responsePayload.requestId ?? context.session.requestId,
    requestMode: responsePayload.mode ?? 'realtime',
    callId: responsePayload.callId ?? null,
    metadata: {
      runtime: context.scenario.runtimeMode,
      bridgeUrl: config.url,
      bridgeSessionId: responsePayload.bridgeSessionId ?? responsePayload.requestId ?? null,
      archiveRecordings: config.archiveRecordings,
      storePartialTranscript: config.storePartialTranscript,
      latencyBudgetMs: config.latencyBudgetMs,
    },
  };
}

export const realtimeRuntime: CallRuntime = {
  async start(context: CallRuntimeContext): Promise<CallRuntimeResult> {
    return startMediaBridgeSession(context);
  },
};

export const realtimeRuntimeProvider: RealtimeRuntimeProvider = {
  start(context: CallRuntimeContext): Promise<CallRuntimeResult> {
    return startMediaBridgeSession(context);
  },

  receiveCallback(event: RealtimeBridgeEventInput): Promise<TelephonyAiCallSession> {
    return handleRealtimeBridgeEvent(event);
  },

  finalize(
    sessionId: string,
    transcript: string,
    recordLink?: string | null,
  ): Promise<TelephonyAiCallSession> {
    return finalizeTelephonyTranscript(sessionId, transcript, {
      recordLink,
      finalStatus: 'processed',
    });
  },

  async fallback(sessionId: string, reason: string): Promise<TelephonyAiCallSession> {
    const session = await callSessionRepo.update(sessionId, { status: 'fallback' });
    await callEventRepo.record(sessionId, 'fallback_triggered', {
      fallbackReason: reason,
      triggeredBy: 'realtime_runtime_provider',
    });
    return session;
  },
};

export async function isRealtimeBridgeAvailable(): Promise<boolean> {
  const config = await getRealtimeBridgeConfig();
  return Boolean(config.enabled && config.url);
}
