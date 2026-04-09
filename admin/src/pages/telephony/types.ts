import type { ReactNode } from 'react';
import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
  TelephonyCallArtifact,
  TelephonyCallEvent,
  TelephonyCallOutcome,
  TelephonyCallTurn,
} from '../../../../shared/types/telephony.js';

export interface LiraXStatus {
  configured: boolean;
  url: string;
  defaultExt: string;
  operatorPhone: string;
  ownerChatId: string;
  webhookUrl: string;
  hasWebhookToken: boolean;
  sipServer: string;
  externalNumber: string;
  hasSipCredentials: boolean;
}

export interface RealtimeBridgeStatus {
  enabled: boolean;
  configured: boolean;
  url: string;
  healthUrl: string;
  reachable: boolean | null;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  voiceProvider: string;
  voiceModel: string;
  speechModel: string;
  telephonyAiProvider: string;
  telephonyAiProviderSource: string;
  telephonyAiProviderReason: string;
  telephonyPreferredOpenrouterModel: string;
  telephonyPreferredOpenrouterModelSource: string;
  telephonyPreferredOpenrouterModelReason: string;
  telephonyEffectiveAiProvider: string;
  telephonyEffectiveAiProviderSource: string;
  telephonyEffectiveAiProviderReason: string;
  telephonyEffectiveModel: string;
  telephonyEffectiveModelSource: string;
  telephonyEffectiveModelReason: string;
  sipServer: string;
  externalNumber: string;
  hasSipCredentials: boolean;
}

export interface TelephonyUser {
  telegram_id: string;
  name: string;
  added_at: string;
}

export interface TelephonyAiPreviewResponse {
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan;
}

export interface TelephonyAiStartResponse extends TelephonyAiPreviewResponse {
  result: {
    id: string;
    mode: string;
  };
}

export interface TelephonySessionDetails {
  session: TelephonyAiCallSession;
  events: TelephonyCallEvent[];
  turns: TelephonyCallTurn[];
  artifacts: TelephonyCallArtifact[];
  outcome: TelephonyCallOutcome | null;
}

export interface SimpleModel {
  id: string;
  name: string;
}

export interface TestConnectionResult {
  connected: boolean;
  latencyMs?: number;
  usersCount?: number;
  users?: Array<{ id: string; name: string; ext: string; active: string }>;
  apiUrl?: string;
}

export interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}

export interface StatusRowProps {
  label: string;
  value: string;
  ok: boolean;
  mono?: boolean;
}

export interface ToggleButtonProps {
  active: boolean;
  label: string;
  iconOn: ReactNode;
  iconOff: ReactNode;
  onClick: () => void;
}

export interface PreviewRowProps {
  label: string;
  value: string;
}

export interface ScenarioEditorProps {
  scenario: TelephonyAiScenario;
  onUpdate: (id: string, field: keyof TelephonyAiScenario, value: string | boolean | number) => void;
  onPolicyUpdate: (
    id: string,
    field: keyof TelephonyAiScenario['policy'],
    value: string | number,
  ) => void;
  onRemove: (id: string) => void;
}

export interface SessionDetailPanelProps {
  details: TelephonySessionDetails;
}

export const DEFAULT_PREMIUM_MODELS: SimpleModel[] = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'google/gemini-pro', name: 'Gemini Pro' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
];
