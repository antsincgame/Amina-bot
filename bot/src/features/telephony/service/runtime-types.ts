import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
  TelephonyProvider,
} from '../../../../../shared/types/telephony.js';

export interface CallRuntimeContext {
  session: TelephonyAiCallSession;
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan;
  phone: string;
  task: string;
}

export interface CallRuntimeResult {
  provider: TelephonyProvider;
  requestId: string | null;
  requestMode: string;
  callId: string | null;
  metadata: Record<string, unknown>;
}

export interface CallRuntime {
  start(context: CallRuntimeContext): Promise<CallRuntimeResult>;
}
