import { aiService } from '../../../ai/openrouter.js';
import { analyticsRepo } from '../../../db/supabase.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiScenario,
} from '../../../../../shared/types/telephony.js';
import {
  buildPlanPrompt,
  normalizePlan,
  toPlanInput,
} from '../scenario-compiler.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { scenarioRepo } from '../repository/scenario-repo.js';
import { cleanText, extractJsonObject, normalizePhone, safeJsonParse } from '../shared.js';
import { startThroughRuntimeRouter } from './call-runtime-router.js';
import type { CallRuntimeResult } from './runtime-types.js';

const PLAN_MAX_TOKENS = 1200;
const PLAN_TEMPERATURE = 0.25;

export interface StartTelephonyCallParams {
  scenarioId: string;
  phone: string;
  task: string;
  ownerTelegramId: string;
  initiatedBy: string;
  plan?: TelephonyAiCallPlan;
}

export interface TelephonyCallStartResult {
  id: string;
  mode: string;
}

async function resolveScenarioById(scenarioId: string): Promise<TelephonyAiScenario> {
  const scenario = await scenarioRepo.getById(scenarioId);
  if (!scenario || !scenario.enabled) {
    throw new Error('Сценарий не найден или выключен');
  }

  return scenario;
}

export async function previewTelephonyCall(
  scenarioId: string,
  task: string,
  phone: string,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan }> {
  const scenario = await resolveScenarioById(scenarioId);
  const aiResult = await aiService.chat(
    buildPlanPrompt(scenario, task, phone),
    'voice',
    undefined,
    {
      promptMode: 'passthrough',
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
    },
  );

  const rawPlan = safeJsonParse<Record<string, unknown>>(extractJsonObject(aiResult.content) ?? '');
  const plan = normalizePlan(scenario, rawPlan, task);

  return { scenario, plan };
}

export async function startTelephonyCall(
  params: StartTelephonyCallParams,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan; result: TelephonyCallStartResult }> {
  const scenario = await resolveScenarioById(params.scenarioId);
  const plan = params.plan
    ? normalizePlan(scenario, toPlanInput(params.plan), params.task)
    : (await previewTelephonyCall(params.scenarioId, params.task, params.phone)).plan;

  const session = await callSessionRepo.create({
    ownerTelegramId: params.ownerTelegramId,
    initiatedBy: params.initiatedBy,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    scenarioGoal: scenario.goal,
    callMode: plan.callMode,
    runtimeMode: scenario.runtimeMode,
    policyVersion: scenario.policyVersion,
    provider: 'unknown',
    targetPhone: normalizePhone(params.phone),
    task: cleanText(params.task),
    summary: cleanText(plan.summary),
    successCriteria: scenario.successCriteria,
    resultPrompt: scenario.resultPrompt,
    requestId: null,
    requestMode: 'pending',
    callId: null,
    recordLink: null,
    transcript: null,
    resultSummary: null,
    outcomeLabel: null,
    status: 'initiated',
  });

  await callEventRepo.record(session.id, 'call_started', {
    scenarioId: scenario.id,
    plan,
    runtimeMode: scenario.runtimeMode,
    task: params.task,
  });

  let runtimeResult: CallRuntimeResult;
  try {
    runtimeResult = await startThroughRuntimeRouter({
      session,
      scenario,
      plan,
      phone: normalizePhone(params.phone),
      task: cleanText(params.task),
    });
  } catch (error) {
    await callSessionRepo.update(session.id, { status: 'failed' });
    await callEventRepo.record(session.id, 'call_failed', {
      stage: 'runtime_start',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const updatedSession = await callSessionRepo.update(session.id, {
    provider: runtimeResult.provider,
    requestId: runtimeResult.requestId,
    requestMode: runtimeResult.requestMode,
    callId: runtimeResult.callId,
  });

  await callEventRepo.record(updatedSession.id, 'runtime_selected', runtimeResult.metadata);
  if (runtimeResult.metadata.fallbackReason) {
    await callEventRepo.record(updatedSession.id, 'runtime_fallback', runtimeResult.metadata);
  }
  await callEventRepo.record(updatedSession.id, 'provider_request_accepted', {
    provider: runtimeResult.provider,
    requestId: runtimeResult.requestId,
    requestMode: runtimeResult.requestMode,
  });

  analyticsRepo.log('call_started', 'voice', {
    sessionId: updatedSession.id,
    scenarioId: scenario.id,
    runtimeMode: scenario.runtimeMode,
    provider: runtimeResult.provider,
  }).catch(() => {});

  return {
    scenario,
    plan,
    result: {
      id: runtimeResult.requestId || updatedSession.id,
      mode: runtimeResult.requestMode,
    },
  };
}
