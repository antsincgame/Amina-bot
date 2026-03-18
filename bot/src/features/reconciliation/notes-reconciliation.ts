import type {
  NotesNearbyLog,
  NotesApplyResultItem,
  NotesReconciliationDetail,
  NotesReconciliationItem,
  ReconciliationBatchPreview,
  ReconciliationCounts,
  ReconciliationSummary,
} from '../../../../shared/types/index.js';
import { userLogsRepo } from '../../memory/user-memory.js';
import { getNotesSoftArchiveMap, softArchiveNotes } from '../notes-soft-archive.js';
import { notesRepo } from '../notes-repo.js';
import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 120;
const PREVIEW_LENGTH = 180;
const CLEAN_PREVIEW_LENGTH = 220;

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

function buildSummary(items: NotesReconciliationItem[]): ReconciliationSummary {
  return { domain: 'notes', ...buildCounts(items) };
}

function trimPreview(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}...` : value;
}

function cleanArtifactPreview(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '[code removed]')
    .replace(/\[(\d+)\]/g, '')
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inspectNote(content: string): NotesReconciliationItem['flags'] {
  return {
    hasMarkdown: /(^|\n)\s*[-*]\s+\S|\*\*|__|`[^`]+`/.test(content),
    hasCodeFence: /```[\s\S]*```/.test(content),
    hasJsonLike: /[\[{]\s*"[\w-]+"\s*:/.test(content),
    hasCitationMarkers: /\[(\d+)\]|📚\s*Источники|Источники?:/i.test(content),
    hasUrls: /https?:\/\/[^\s]+/i.test(content),
    hasSearchChatter: /сейчас\s+(я\s+)?(найду|поищу|посмотрю)|🔍\s*Ищу|хочешь узнать больше/i.test(content),
    hasToolishPrefixes: /^(assistant|tool|response|result)\s*:/im.test(content),
    looksLikeGreetingOnly: /^(привет|здравствуй|здравствуйте)[^.!?\n]{0,80}$/i.test(content.trim()),
  };
}

function buildItem(
  note: { id: string; user_id: string; content: string; created_at: string },
  archivedAt: string | null,
): NotesReconciliationItem {
  const flags = inspectNote(note.content);
  const reasons: string[] = [];
  let score = 0;

  if (flags.hasCodeFence) {
    reasons.push('Есть code fence или блочный технический вывод.');
    score += 3;
  }
  if (flags.hasJsonLike) {
    reasons.push('Контент похож на raw JSON/tool output.');
    score += 2;
  }
  if (flags.hasCitationMarkers || flags.hasUrls) {
    reasons.push('Есть web-search хвост: источники, ссылки или citation markers.');
    score += 2;
  }
  if (flags.hasSearchChatter || flags.hasToolishPrefixes) {
    reasons.push('Есть служебный chatter вместо нормализованной заметки.');
    score += 1;
  }
  if (flags.hasMarkdown) {
    reasons.push('Контент содержит markdown-артефакты.');
    score += 1;
  }
  if (flags.looksLikeGreetingOnly) {
    reasons.push('Заметка выглядит как приветствие или обрывок ответа.');
    score += 2;
  }

  let status: NotesReconciliationItem['status'] = 'safe';
  let suggestedAction: NotesReconciliationItem['suggestedAction'] = 'keep';
  if (score >= 5) {
    status = 'block';
    suggestedAction = 'soft_archive';
  } else if (score >= 2) {
    status = 'review';
    suggestedAction = 'review';
  }

  return {
    noteId: note.id,
    userId: note.user_id,
    createdAt: note.created_at,
    status,
    reasons,
    preview: trimPreview(note.content, PREVIEW_LENGTH),
    suggestedAction,
    score,
    archiveState: archivedAt ? 'soft_archived' : 'active',
    archivedAt,
    flags,
  };
}

function buildSnapshotToken(items: Array<{ noteId: string; createdAt: string; archiveState: string; score: number }>): string {
  const payload = items
    .map((item) => `${item.noteId}:${item.createdAt}:${item.archiveState}:${item.score}`)
    .sort()
    .join('|');
  return createHash('sha256').update(payload).digest('hex');
}

async function getNearbyLogs(userId: string, noteCreatedAt: string): Promise<NotesNearbyLog[]> {
  const baseTime = new Date(noteCreatedAt);
  if (Number.isNaN(baseTime.getTime())) {
    return [];
  }
  const from = new Date(baseTime.getTime() - 20 * 60 * 1000);
  const to = new Date(baseTime.getTime() + 5 * 60 * 1000);
  const logs = await userLogsRepo.getByUser(userId, { from, to, limit: 8 });
  return logs.map((log) => ({
    id: log.id,
    eventType: log.event_type,
    timestamp: log.timestamp,
    preview: trimPreview(log.content ?? '', 140),
  }));
}

export async function listNotesReconciliation(limit = DEFAULT_LIMIT): Promise<{
  summary: ReconciliationSummary;
  items: NotesReconciliationItem[];
}> {
  const [notes, archiveMap] = await Promise.all([
    notesRepo.listRecent(limit, 0, { includeArchived: true }),
    getNotesSoftArchiveMap(),
  ]);
  const items = notes.map((note) => buildItem(note, archiveMap.get(note.id)?.archivedAt ?? null));
  return { summary: buildSummary(items), items };
}

export async function getNotesReconciliationDetail(noteId: string): Promise<NotesReconciliationDetail | null> {
  const [note, archiveMap] = await Promise.all([
    notesRepo.getById(noteId),
    getNotesSoftArchiveMap(),
  ]);
  if (!note) {
    return null;
  }
  const item = buildItem(note, archiveMap.get(note.id)?.archivedAt ?? null);
  const nearbyLogs = await getNearbyLogs(note.user_id, note.created_at);
  return {
    ...item,
    content: note.content,
    cleanPreview: trimPreview(cleanArtifactPreview(note.content), CLEAN_PREVIEW_LENGTH),
    nearbyLogs,
  };
}

export async function previewNotesReconciliationBatch(
  noteIds: string[],
): Promise<ReconciliationBatchPreview<NotesReconciliationDetail>> {
  const details = await Promise.all(noteIds.map((noteId) => getNotesReconciliationDetail(noteId)));
  const items = details.filter((item): item is NotesReconciliationDetail => item !== null);
  return {
    ids: noteIds,
    counts: buildCounts(items),
    items,
    snapshotToken: buildSnapshotToken(items),
  };
}

export async function applyNotesSoftArchiveBatch(input: {
  noteIds: string[];
  snapshotToken: string;
  approvedBy: string;
  approvalNote: string;
}): Promise<{
  counts: ReconciliationCounts;
  results: NotesApplyResultItem[];
}> {
  const preview = await previewNotesReconciliationBatch(input.noteIds);
  if (preview.snapshotToken !== input.snapshotToken) {
    throw new Error('Preview устарел. Открой новый batch preview перед apply.');
  }

  const now = new Date().toISOString();
  const results: NotesApplyResultItem[] = [];
  const toArchive = preview.items
    .filter((item) => item.suggestedAction === 'soft_archive')
    .filter((item) => item.archiveState !== 'soft_archived');

  for (const item of preview.items) {
    if (item.archiveState === 'soft_archived') {
      results.push({
        noteId: item.noteId,
        action: 'already_archived',
        message: 'Уже soft-archived ранее.',
      });
      continue;
    }
    if (item.suggestedAction !== 'soft_archive') {
      results.push({
        noteId: item.noteId,
        action: 'skipped',
        message: 'Пропущено: note не помечена как obvious artifact.',
      });
    }
  }

  if (toArchive.length > 0) {
    await softArchiveNotes(toArchive.map((item) => ({
      noteId: item.noteId,
      userId: item.userId,
      archivedAt: now,
      archivedBy: input.approvedBy,
      approvalNote: input.approvalNote,
    })));

    for (const item of toArchive) {
      results.push({
        noteId: item.noteId,
        action: 'soft_archived',
        message: 'Запись скрыта из обычных notes list и сохранена в historical storage.',
      });
      void userLogsRepo.add(item.userId, 'command', 'note_soft_archived', {
        noteId: item.noteId,
        approvedBy: input.approvedBy,
        approvalNote: input.approvalNote,
      });
    }
  }

  return {
    counts: buildCounts(preview.items),
    results,
  };
}
