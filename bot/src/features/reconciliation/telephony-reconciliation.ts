import { settingsRepo } from '../../db/index.js';
import type {
  ReconciliationBatchPreview,
  ReconciliationCounts,
  ReconciliationSummary,
  TelephonyReconciliationDetail,
  TelephonyReconciliationItem,
} from '../../../../shared/types/index.js';
import type { TelephonyAiCallSession } from '../../../../shared/types/telephony.js';
import { callSessionRepo } from '../telephony/repository/call-session-repo.js';
import { LEGACY_SESSIONS_KEY, normalizePhone, safeJsonParse } from '../telephony/shared.js';
import { getTelephonySessionDetails } from '../telephony/service/session-detail-service.js';

const DEFAULT_LIMIT = 100;
const PHONE_WINDOW_MS = 45 * 60 * 1000;

function buildCounts<T extends { status: 'safe' | 'review' | 'block' }>(items: T[]): ReconciliationCounts {
  return items.reduce<ReconciliationCounts>(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] += 1;
      return acc;
    },
    { total: 0, safe: 0, review: 0, block: 0 },
  );
}

function buildSummary(items: TelephonyReconciliationItem[]): ReconciliationSummary {
  return { domain: 'telephony', ...buildCounts(items) };
}

function isWithinPhoneWindow(leftIso: string, rightIso: string): boolean {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return false;
  }
  return Math.abs(left - right) <= PHONE_WINDOW_MS;
}

async function getLegacySessions(): Promise<TelephonyAiCallSession[]> {
  const raw = await settingsRepo.get(LEGACY_SESSIONS_KEY);
  const parsed = raw ? safeJsonParse<TelephonyAiCallSession[]>(raw) : null;
  return Array.isArray(parsed) ? parsed : [];
}

function matchLegacySessions(
  session: TelephonyAiCallSession,
  legacySessions: TelephonyAiCallSession[],
): TelephonyAiCallSession[] {
  const normalizedPhone = normalizePhone(session.targetPhone);
  return legacySessions.filter((legacy) => {
    if (legacy.requestId && session.requestId && legacy.requestId === session.requestId) {
      return true;
    }
    if (legacy.callId && session.callId && legacy.callId === session.callId) {
      return true;
    }
    return normalizePhone(legacy.targetPhone) === normalizedPhone
      && isWithinPhoneWindow(legacy.createdAt, session.createdAt);
  });
}

async function buildItem(
  session: TelephonyAiCallSession,
  legacySessions: TelephonyAiCallSession[],
): Promise<TelephonyReconciliationDetail> {
  const details = await getTelephonySessionDetails(session.id);
  const matchedLegacySessions = matchLegacySessions(session, legacySessions);
  const reasons: string[] = [];
  const stopPoints: string[] = [];
  const exactRequestIdMatch = matchedLegacySessions.some((entry) => entry.requestId && entry.requestId === session.requestId);
  const exactCallIdMatch = matchedLegacySessions.some((entry) => entry.callId && entry.callId === session.callId);
  const phoneWindowMatch = matchedLegacySessions.some((entry) => normalizePhone(entry.targetPhone) === normalizePhone(session.targetPhone));

  if (!details) {
    reasons.push('Не удалось собрать live detail для session.');
    return {
      sessionId: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      scenarioName: session.scenarioName,
      targetPhone: session.targetPhone,
      status: 'block',
      sessionStatus: session.status,
      reasons,
      stopPoints: ['Перед любой remediation нужно восстановить detail model session.'],
      turnsCount: 0,
      artifactsCount: 0,
      eventsCount: 0,
      hasOutcome: false,
      legacyMatches: matchedLegacySessions.length,
      exactMatches: Number(exactRequestIdMatch) + Number(exactCallIdMatch),
      matchSignals: {
        requestId: exactRequestIdMatch,
        callId: exactCallIdMatch,
        phoneWindow: phoneWindowMatch,
      },
      transcriptPresent: Boolean(session.transcript),
      resultSummaryPresent: Boolean(session.resultSummary),
      callId: session.callId,
      requestId: session.requestId,
      legacySessionIds: matchedLegacySessions.map((entry) => entry.id),
    };
  }

  if (matchedLegacySessions.length > 1) {
    reasons.push('Найдено несколько legacy-кандидатов для одной session.');
    stopPoints.push('Перед merge нужен ручной выбор единственного historical source.');
  }
  if (!session.requestId && !session.callId && phoneWindowMatch) {
    reasons.push('Есть только слабый матч по номеру и временному окну.');
    stopPoints.push('Нельзя связывать session с legacy без owner review.');
  }
  if (details.turns.length > 0) {
    stopPoints.push('В session уже есть turns: replaceForSession() нельзя вызывать без preview.');
  }
  if (details.artifacts.length > 0) {
    stopPoints.push('В session уже есть artifacts: upsert может потерять lineage.');
  }
  if (details.outcome) {
    stopPoints.push('Outcome уже сохранён: historical overwrite запрещён без явного approve.');
  }
  if (!details.outcome && session.status === 'processed') {
    reasons.push('Session processed, но outcome отсутствует.');
  }
  if (!session.transcript && details.artifacts.some((artifact) => artifact.artifactType === 'transcript_partial')) {
    reasons.push('Есть partial transcript без финального transcript.');
  }

  let status: TelephonyReconciliationDetail['status'] = 'safe';
  if (matchedLegacySessions.length > 1 || (!exactRequestIdMatch && !exactCallIdMatch && phoneWindowMatch)) {
    status = 'review';
  }
  if (reasons.length > 0 && stopPoints.length > 2) {
    status = 'block';
  }

  if (matchedLegacySessions.length === 0 && session.status === 'initiated') {
    reasons.push('Legacy match не найден, session выглядит как isolated runtime record.');
    status = 'review';
  }

  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    scenarioName: session.scenarioName,
    targetPhone: session.targetPhone,
    status,
    sessionStatus: session.status,
    reasons,
    stopPoints,
    turnsCount: details.turns.length,
    artifactsCount: details.artifacts.length,
    eventsCount: details.events.length,
    hasOutcome: Boolean(details.outcome),
    legacyMatches: matchedLegacySessions.length,
    exactMatches: Number(exactRequestIdMatch) + Number(exactCallIdMatch),
    matchSignals: {
      requestId: exactRequestIdMatch,
      callId: exactCallIdMatch,
      phoneWindow: phoneWindowMatch,
    },
    transcriptPresent: Boolean(session.transcript),
    resultSummaryPresent: Boolean(session.resultSummary),
    callId: session.callId,
    requestId: session.requestId,
    legacySessionIds: matchedLegacySessions.map((entry) => entry.id),
  };
}

export async function listTelephonyReconciliation(limit = DEFAULT_LIMIT): Promise<{
  summary: ReconciliationSummary;
  items: TelephonyReconciliationItem[];
}> {
  const [sessions, legacySessions] = await Promise.all([
    callSessionRepo.listRecent(limit),
    getLegacySessions(),
  ]);
  const items = await Promise.all(sessions.map((session) => buildItem(session, legacySessions)));
  return { summary: buildSummary(items), items };
}

export async function getTelephonyReconciliationDetail(
  sessionId: string,
): Promise<TelephonyReconciliationDetail | null> {
  const [session, legacySessions] = await Promise.all([
    callSessionRepo.getById(sessionId),
    getLegacySessions(),
  ]);
  if (!session) {
    return null;
  }
  return buildItem(session, legacySessions);
}

export async function previewTelephonyReconciliationBatch(
  sessionIds: string[],
): Promise<ReconciliationBatchPreview<TelephonyReconciliationDetail>> {
  const details = await Promise.all(sessionIds.map((sessionId) => getTelephonyReconciliationDetail(sessionId)));
  const items = details.filter((item): item is TelephonyReconciliationDetail => item !== null);
  return {
    ids: sessionIds,
    counts: buildCounts(items),
    items,
  };
}
