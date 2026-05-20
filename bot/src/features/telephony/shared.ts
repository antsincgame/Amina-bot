import type {
  TelephonyAiScenarioPolicy,
  TelephonyFallbackMode,
  TelephonyRuntimeMode,
} from '../../../../shared/types/telephony.js';

export const LEGACY_SCENARIOS_KEY = 'lirax_ai_scenarios';
export const LEGACY_SESSIONS_KEY = 'lirax_ai_call_sessions';

export const DEFAULT_RUNTIME_MODE: TelephonyRuntimeMode = 'scripted';
export const DEFAULT_FALLBACK_MODE: TelephonyFallbackMode = 'scripted';
export const DEFAULT_POLICY_VERSION = 1;

export function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `scenario-${Date.now()}`;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const sliced = value.slice(0, maxLength).trim();
  const lastSentenceIndex = Math.max(
    sliced.lastIndexOf('.'),
    sliced.lastIndexOf('!'),
    sliced.lastIndexOf('?'),
  );

  if (lastSentenceIndex >= Math.floor(maxLength * 0.6)) {
    return sliced.slice(0, lastSentenceIndex + 1).trim();
  }

  const lastSpaceIndex = sliced.lastIndexOf(' ');
  if (lastSpaceIndex > 0) {
    return `${sliced.slice(0, lastSpaceIndex).trim()}...`;
  }

  return `${sliced}...`;
}

export function prefixRu(text: string | null): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = cleanText(text);
  if (!normalized) {
    return undefined;
  }

  return normalized.startsWith('ru ') ? normalized : `ru ${normalized}`;
}

export function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function extractJsonObject(value: string): string | null {
  // Раньше брали первый '{' и ПОСЛЕДНИЙ '}'. Если модель добавляла прозу с '}'
  // после JSON или несколько JSON-блоков, срез захватывал мусор → parse падал и
  // терялся реальный outcome. Идём по глубине скобок (учитывая строки/экранирование)
  // и возвращаем первый сбалансированный объект.
  const start = value.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i++) {
    const ch = value[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }

  return null; // несбалансированный объект (например, обрезанный ответ модели)
}

export function createDefaultScenarioPolicy(goal: string): TelephonyAiScenarioPolicy {
  const cleanGoal = cleanText(goal);

  return {
    allowedClaims: cleanGoal ? [cleanGoal] : [],
    requiredSlots: [],
    exitConditions: [
      'Получен явный ответ собеседника',
      'Собеседник просит перезвонить позже',
      'Собеседник завершает разговор',
    ],
    handoffRules: [
      'Если собеседник требует живого владельца, инициируй fallback на scripted flow и отметь handoff',
    ],
    maxSilenceMs: 6000,
    maxTurns: 6,
    fallbackMode: DEFAULT_FALLBACK_MODE,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
