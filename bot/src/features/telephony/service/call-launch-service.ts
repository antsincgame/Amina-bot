import { aiService } from '../../../ai/openrouter.js';
import { analyticsRepo } from '../../../db/supabase.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiScenario,
  TelephonyRuntimeMode,
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
  runtimeOverride?: TelephonyRuntimeMode;
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

async function buildPlanForScenario(
  scenario: TelephonyAiScenario,
  task: string,
  phone: string,
): Promise<TelephonyAiCallPlan> {
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
  return normalizePlan(scenario, rawPlan, task);
}

export async function previewTelephonyCall(
  scenarioId: string,
  task: string,
  phone: string,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan }> {
  const scenario = await resolveScenarioById(scenarioId);
  const plan = await buildPlanForScenario(scenario, task, phone);

  return { scenario, plan };
}

export async function startTelephonyCall(
  params: StartTelephonyCallParams,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan; result: TelephonyCallStartResult }> {
  const scenario = await resolveScenarioById(params.scenarioId);
  const effectiveScenario: TelephonyAiScenario = params.runtimeOverride
    ? {
        ...scenario,
        runtimeMode: params.runtimeOverride,
      }
    : scenario;
  const plan = params.plan
    ? normalizePlan(effectiveScenario, toPlanInput(params.plan), params.task)
    : await buildPlanForScenario(effectiveScenario, params.task, params.phone);

  const session = await callSessionRepo.create({
    ownerTelegramId: params.ownerTelegramId,
    initiatedBy: params.initiatedBy,
    scenarioId: effectiveScenario.id,
    scenarioName: effectiveScenario.name,
    scenarioGoal: effectiveScenario.goal,
    callMode: plan.callMode,
    runtimeMode: effectiveScenario.runtimeMode,
    policyVersion: effectiveScenario.policyVersion,
    provider: 'unknown',
    targetPhone: normalizePhone(params.phone),
    task: cleanText(params.task),
    summary: cleanText(plan.summary),
    successCriteria: effectiveScenario.successCriteria,
    resultPrompt: effectiveScenario.resultPrompt,
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
    scenarioId: effectiveScenario.id,
    plan,
    runtimeMode: effectiveScenario.runtimeMode,
    runtimeOverride: params.runtimeOverride ?? null,
    task: params.task,
  });
  await callEventRepo.record(session.id, 'provider_request_sent', {
    scenarioId: effectiveScenario.id,
    runtimeMode: effectiveScenario.runtimeMode,
    targetPhone: normalizePhone(params.phone),
  });

  let runtimeResult: CallRuntimeResult;
  try {
    runtimeResult = await startThroughRuntimeRouter({
      session,
      scenario: effectiveScenario,
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
    scenarioId: effectiveScenario.id,
    runtimeMode: effectiveScenario.runtimeMode,
    provider: runtimeResult.provider,
  }).catch(() => {});

  return {
    scenario: effectiveScenario,
    plan,
    result: {
      id: runtimeResult.requestId || updatedSession.id,
      mode: runtimeResult.requestMode,
    },
  };
}
