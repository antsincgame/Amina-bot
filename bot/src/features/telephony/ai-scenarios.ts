import { settingsRepo } from '../../db/supabase.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiScenario,
} from '../../../../shared/types/telephony.js';
import { scenarioRepo } from './repository/scenario-repo.js';
import {
  previewTelephonyCall,
  startTelephonyCall,
  type StartTelephonyCallParams,
} from './service/call-launch-service.js';
import { cleanText } from './shared.js';

export { getDefaultTelephonyAiScenarios } from './scenario-compiler.js';

export async function getTelephonyOwnerTelegramId(): Promise<string | null> {
  const settings = await settingsRepo.getMany([
    'lirax_owner_chat_id',
    'lirax_admin_chat_id',
    'admin_chat_id',
  ]);

  return (
    cleanText(settings['lirax_owner_chat_id'])
    || cleanText(settings['lirax_admin_chat_id'])
    || cleanText(settings['admin_chat_id'])
    || null
  );
}

export async function isTelephonyOwner(telegramId: string): Promise<boolean> {
  const ownerId = await getTelephonyOwnerTelegramId();
  return !!ownerId && ownerId === telegramId;
}

export async function getTelephonyAiScenarios(): Promise<TelephonyAiScenario[]> {
  return scenarioRepo.getAll();
}

export async function saveTelephonyAiScenarios(
  scenarios: TelephonyAiScenario[],
): Promise<TelephonyAiScenario[]> {
  return scenarioRepo.saveAll(scenarios);
}

export async function previewTelephonyAiCall(
  scenarioId: string,
  task: string,
  phone: string,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan }> {
  return previewTelephonyCall(scenarioId, task, phone);
}

export async function startTelephonyAiCall(
  params: StartTelephonyCallParams,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan; result: { id: string; mode: string } }> {
  return startTelephonyCall(params);
}
