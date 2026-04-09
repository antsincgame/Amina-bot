import { fetchBotApi } from '../../api/appwrite';
import {
  fetchOpenRouterModels,
  filterPremiumModels,
  transformToSimpleModel,
} from '../../api/openrouter';
import type { TelephonyAiCallPlan, TelephonyAiCallSession, TelephonyAiScenario, TelephonyRuntimeMode } from '../../../../shared/types/telephony.js';
import type {
  LiraXStatus,
  RealtimeBridgeStatus,
  SimpleModel,
  TelephonyUser,
  TelephonyAiPreviewResponse,
  TelephonyAiStartResponse,
  TelephonySessionDetails,
  TestConnectionResult,
} from './types';

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => ({ error: 'Unknown error' }));
  if (!response.ok) {
    throw new Error((json as { error?: string }).error || 'Request failed');
  }

  return json as T;
}

export async function fetchPremiumOpenRouterModels(): Promise<SimpleModel[]> {
  const response = await fetchOpenRouterModels(undefined, 300);
  return filterPremiumModels(response.models)
    .slice(0, 25)
    .map(transformToSimpleModel);
}

export async function fetchLiraXStatus(): Promise<LiraXStatus> {
  const response = await fetchBotApi('/api/lirax/status');
  const json = await readJson<{ data: LiraXStatus }>(response);
  return json.data;
}

export async function testLiraXConnection(): Promise<TestConnectionResult> {
  const response = await fetchBotApi('/api/lirax/test-connection');
  const json = await readJson<{ success: boolean; data: TestConnectionResult; error?: string }>(response);
  if (!json.success) {
    throw new Error(json.error || 'Неизвестная ошибка');
  }
  return json.data;
}

export async function fetchScenarios(): Promise<TelephonyAiScenario[]> {
  const response = await fetchBotApi('/api/lirax/scenarios');
  const json = await readJson<{ data: TelephonyAiScenario[] }>(response);
  return json.data ?? [];
}

export async function saveScenarios(scenarios: TelephonyAiScenario[]): Promise<TelephonyAiScenario[]> {
  const response = await fetchBotApi('/api/lirax/scenarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenarios),
  });
  const json = await readJson<{ data: TelephonyAiScenario[] }>(response);
  return json.data ?? [];
}

export async function fetchTelephonyUsers(): Promise<TelephonyUser[]> {
  const response = await fetchBotApi('/api/lirax/users');
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

export async function addTelephonyUserApi(telegramId: string, name: string): Promise<TelephonyUser[]> {
  const response = await fetchBotApi('/api/lirax/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_id: telegramId, name }),
  });
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

export async function removeTelephonyUserApi(telegramId: string): Promise<TelephonyUser[]> {
  const response = await fetchBotApi(`/api/lirax/users/${telegramId}`, {
    method: 'DELETE',
  });
  const json = await readJson<{ data: TelephonyUser[] }>(response);
  return json.data ?? [];
}

export async function previewAiCall(
  scenarioId: string,
  phone: string,
  task: string,
): Promise<TelephonyAiPreviewResponse> {
  const response = await fetchBotApi('/api/lirax/ai-calls/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId, phone, task }),
  });
  const json = await readJson<{ data: TelephonyAiPreviewResponse }>(response);
  return json.data;
}

export async function startAiCall(
  scenarioId: string,
  phone: string,
  task: string,
  plan?: TelephonyAiCallPlan,
  runtimeOverride?: TelephonyRuntimeMode | '',
): Promise<TelephonyAiStartResponse> {
  const response = await fetchBotApi('/api/lirax/ai-calls/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarioId,
      phone,
      task,
      plan,
      runtimeOverride: runtimeOverride || undefined,
    }),
  });
  const json = await readJson<{ data: TelephonyAiStartResponse }>(response);
  return json.data;
}

export async function fetchAiSessions(): Promise<TelephonyAiCallSession[]> {
  const response = await fetchBotApi('/api/lirax/ai-calls/sessions');
  const json = await readJson<{ data: TelephonyAiCallSession[] }>(response);
  return json.data ?? [];
}

export async function fetchRealtimeStatus(): Promise<RealtimeBridgeStatus> {
  const response = await fetchBotApi('/api/telephony/realtime/status');
  const json = await readJson<{ data: RealtimeBridgeStatus }>(response);
  return json.data;
}

export async function fetchSessionDetails(sessionId: string): Promise<TelephonySessionDetails> {
  const response = await fetchBotApi(`/api/lirax/ai-calls/sessions/${sessionId}`);
  const json = await readJson<{ data: TelephonySessionDetails }>(response);
  return json.data;
}
