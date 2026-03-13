import { settingsRepo, getSupabase } from '../../../db/supabase.js';
import type { TelephonyAiScenario } from '../../../../../shared/types/telephony.js';
import { getDefaultTelephonyAiScenarios, normalizeScenario } from '../scenario-compiler.js';
import { LEGACY_SCENARIOS_KEY, cleanText, safeJsonParse } from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

interface TelephonyScenarioRow {
  id: string;
  name: string;
  enabled: boolean;
  call_mode: TelephonyAiScenario['callMode'];
  runtime_mode: TelephonyAiScenario['runtimeMode'];
  policy_version: number;
  policy: TelephonyAiScenario['policy'];
  goal: string;
  system_prompt: string;
  opening_line: string;
  question_hint: string;
  success_criteria: string;
  result_prompt: string;
  max_speech_chars: number;
  created_at: string;
  updated_at: string;
}

function mapRowToScenario(row: TelephonyScenarioRow, index: number): TelephonyAiScenario {
  return normalizeScenario(
    {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      callMode: row.call_mode,
      runtimeMode: row.runtime_mode,
      policyVersion: row.policy_version,
      policy: row.policy,
      goal: row.goal,
      systemPrompt: row.system_prompt,
      openingLine: row.opening_line,
      questionHint: row.question_hint,
      successCriteria: row.success_criteria,
      resultPrompt: row.result_prompt,
      maxSpeechChars: row.max_speech_chars,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    index,
    row.updated_at,
  );
}

function mapScenarioToRow(scenario: TelephonyAiScenario): TelephonyScenarioRow {
  return {
    id: scenario.id,
    name: scenario.name,
    enabled: scenario.enabled,
    call_mode: scenario.callMode,
    runtime_mode: scenario.runtimeMode,
    policy_version: scenario.policyVersion,
    policy: scenario.policy,
    goal: scenario.goal,
    system_prompt: scenario.systemPrompt,
    opening_line: scenario.openingLine,
    question_hint: scenario.questionHint,
    success_criteria: scenario.successCriteria,
    result_prompt: scenario.resultPrompt,
    max_speech_chars: scenario.maxSpeechChars,
    created_at: scenario.createdAt,
    updated_at: scenario.updatedAt,
  };
}

async function loadLegacyScenarios(): Promise<TelephonyAiScenario[]> {
  const raw = await settingsRepo.get(LEGACY_SCENARIOS_KEY);
  if (!raw) {
    return [];
  }

  const parsed = safeJsonParse<unknown[]>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  return parsed.map((item, index) => normalizeScenario((item ?? {}) as Partial<TelephonyAiScenario>, index, now));
}

async function bootstrapScenarios(): Promise<TelephonyAiScenario[]> {
  const legacy = await loadLegacyScenarios();
  const scenarios = legacy.length > 0 ? legacy : getDefaultTelephonyAiScenarios();
  await scenarioRepo.saveAll(scenarios);
  return scenarios;
}

export const scenarioRepo = {
  async getAll(): Promise<TelephonyAiScenario[]> {
    await ensureTelephonyInfra();

    const { data, error } = await getSupabase()
      .from('telephony_scenarios')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    const rows = (data as TelephonyScenarioRow[] | null) ?? [];
    if (rows.length === 0) {
      return bootstrapScenarios();
    }

    return rows.map((row, index) => mapRowToScenario(row, index));
  },

  async getById(id: string): Promise<TelephonyAiScenario | null> {
    const cleanId = cleanText(id);
    if (!cleanId) {
      return null;
    }

    const scenarios = await this.getAll();
    return scenarios.find((scenario) => scenario.id === cleanId) ?? null;
  },

  async saveAll(scenarios: TelephonyAiScenario[]): Promise<TelephonyAiScenario[]> {
    await ensureTelephonyInfra();

    const now = new Date().toISOString();
    const normalized = scenarios.map((scenario, index) => normalizeScenario(scenario, index, now));
    const rows = normalized.map(mapScenarioToRow);

    const sb = getSupabase();
    const { data: existingRows, error: existingError } = await sb
      .from('telephony_scenarios')
      .select('id');

    if (existingError) {
      throw existingError;
    }

    const existingIds = new Set(
      ((existingRows as Array<{ id: string }> | null) ?? []).map((row) => row.id),
    );
    const nextIds = new Set(normalized.map((scenario) => scenario.id));

    for (const existingId of existingIds) {
      if (!nextIds.has(existingId)) {
        const { error } = await sb.from('telephony_scenarios').delete().eq('id', existingId);
        if (error) {
          throw error;
        }
      }
    }

    if (rows.length > 0) {
      const { error } = await sb
        .from('telephony_scenarios')
        .upsert(rows, { onConflict: 'id' });

      if (error) {
        throw error;
      }
    }

    return normalized;
  },
};
