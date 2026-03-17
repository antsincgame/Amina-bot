/**
 * Scenario Repository — Appwrite backend
 */

import { config } from '../../../config/index.js';
import { settingsRepo } from '../../../db/index.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;
import type { TelephonyAiScenario } from '../../../../../shared/types/telephony.js';
import { getDefaultTelephonyAiScenarios, normalizeScenario } from '../scenario-compiler.js';
import { LEGACY_SCENARIOS_KEY, cleanText, safeJsonParse } from '../shared.js';
import { ensureTelephonyInfra } from './telephony-infra.js';

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() { if (!_aw) { const { getAppwrite } = await import('../../../db/appwrite.js'); _aw = getAppwrite(); } return _aw; }
const DB_ID = () => config.appwrite.databaseId;
const COLL = 'amina_tel_scenarios';

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

function docToScenario(d: AppwriteDoc, index: number): TelephonyAiScenario {
  const policy = typeof d.policy === 'string' ? safeJsonParse(d.policy) ?? {} : (d.policy ?? {});
  return normalizeScenario(
    {
      id: d.scenario_id ?? d.id ?? d.$id,
      name: d.name,
      enabled: d.enabled ?? true,
      callMode: d.call_mode,
      runtimeMode: d.runtime_mode ?? 'scripted',
      policyVersion: d.policy_version ?? 1,
      policy,
      goal: d.goal ?? '',
      systemPrompt: d.system_prompt ?? '',
      openingLine: d.opening_line ?? '',
      questionHint: d.question_hint ?? '',
      successCriteria: d.success_criteria ?? '',
      resultPrompt: d.result_prompt ?? '',
      maxSpeechChars: d.max_speech_chars ?? 420,
      createdAt: d.created_at || d.$createdAt,
      updatedAt: d.updated_at || d.$updatedAt,
    },
    index,
    d.updated_at || d.$updatedAt,
  );
}

function scenarioToAwDoc(scenario: TelephonyAiScenario) {
  return {
    scenario_id: scenario.id,
    name: scenario.name,
    enabled: scenario.enabled,
    call_mode: scenario.callMode,
    runtime_mode: scenario.runtimeMode ?? 'scripted',
    policy_version: scenario.policyVersion ?? 1,
    policy: JSON.stringify(scenario.policy ?? {}),
    goal: scenario.goal ?? '',
    system_prompt: scenario.systemPrompt ?? '',
    opening_line: scenario.openingLine ?? '',
    question_hint: scenario.questionHint ?? '',
    success_criteria: scenario.successCriteria ?? '',
    result_prompt: scenario.resultPrompt ?? '',
    max_speech_chars: scenario.maxSpeechChars ?? 420,
    created_at: scenario.createdAt || new Date().toISOString(),
    updated_at: scenario.updatedAt || new Date().toISOString(),
  };
}

async function loadLegacyScenarios(): Promise<TelephonyAiScenario[]> {
  const raw = await settingsRepo.get(LEGACY_SCENARIOS_KEY);
  if (!raw) return [];
  const parsed = safeJsonParse<unknown[]>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
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

    const aw = await getAW();
    const r = await aw.listDocuments(DB_ID(), COLL, [Query.orderAsc('created_at'), Query.limit(100)]);
    if (r.documents.length === 0) return bootstrapScenarios();
    return r.documents.map((d, i) => docToScenario(d, i));

  },

  async getById(id: string): Promise<TelephonyAiScenario | null> {
    const cleanId = cleanText(id);
    if (!cleanId) return null;
    const scenarios = await this.getAll();
    return scenarios.find((scenario) => scenario.id === cleanId) ?? null;
  },

  async saveAll(scenarios: TelephonyAiScenario[]): Promise<TelephonyAiScenario[]> {
    await ensureTelephonyInfra();

    const now = new Date().toISOString();
    const normalized = scenarios.map((scenario, index) => normalizeScenario(scenario, index, now));

    const aw = await getAW();
    // Get existing docs
    const existing = await aw.listDocuments(DB_ID(), COLL, [Query.limit(100)]);
    const existingMap = new Map<string, string>(); // scenario_id → $id
    for (const doc of existing.documents) {
      existingMap.set(doc.scenario_id, doc.$id);
    }

    const nextIds = new Set(normalized.map((s) => s.id));

    // Delete removed
    for (const [scenarioId, docId] of existingMap) {
      if (!nextIds.has(scenarioId)) {
        await aw.deleteDocument(DB_ID(), COLL, docId);
      }
    }

    // Upsert each (Appwrite has no native upsert)
    for (const scenario of normalized) {
      const awDoc = scenarioToAwDoc(scenario);
      const existingDocId = existingMap.get(scenario.id);
      if (existingDocId) {
        await aw.updateDocument(DB_ID(), COLL, existingDocId, awDoc);
      } else {
        await aw.createDocument(DB_ID(), COLL, ID.unique(), awDoc);
      }
    }

    return normalized;

  },
};
