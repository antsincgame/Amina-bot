import { settingsRepo } from '../db/index.js';
import type { NotesSoftArchiveEntry } from '../../../shared/types/index.js';

const NOTES_SOFT_ARCHIVE_KEY = 'notes_soft_archive_registry';

interface NotesSoftArchiveRegistry {
  version: 1;
  entries: NotesSoftArchiveEntry[];
}

function parseRegistry(raw: string | null): NotesSoftArchiveRegistry {
  if (!raw) {
    return { version: 1, entries: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<NotesSoftArchiveRegistry>;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.filter((entry): entry is NotesSoftArchiveEntry =>
          Boolean(
            entry
            && typeof entry.noteId === 'string'
            && typeof entry.userId === 'string'
            && typeof entry.archivedAt === 'string'
            && typeof entry.archivedBy === 'string'
            && typeof entry.approvalNote === 'string',
          ),
        ),
      };
    }
  } catch {
    // fall through to empty registry
  }

  return { version: 1, entries: [] };
}

export async function getNotesSoftArchiveRegistry(): Promise<NotesSoftArchiveRegistry> {
  return parseRegistry(await settingsRepo.get(NOTES_SOFT_ARCHIVE_KEY));
}

export async function getNotesSoftArchiveMap(): Promise<Map<string, NotesSoftArchiveEntry>> {
  const registry = await getNotesSoftArchiveRegistry();
  return new Map(registry.entries.map((entry) => [entry.noteId, entry]));
}

export async function isNoteSoftArchived(noteId: string): Promise<boolean> {
  const registry = await getNotesSoftArchiveRegistry();
  return registry.entries.some((entry) => entry.noteId === noteId);
}

export async function softArchiveNotes(entries: NotesSoftArchiveEntry[]): Promise<void> {
  const registry = await getNotesSoftArchiveRegistry();
  const nextMap = new Map(registry.entries.map((entry) => [entry.noteId, entry]));
  for (const entry of entries) {
    nextMap.set(entry.noteId, entry);
  }

  const nextRegistry: NotesSoftArchiveRegistry = {
    version: 1,
    entries: [...nextMap.values()].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)),
  };
  await settingsRepo.set(NOTES_SOFT_ARCHIVE_KEY, JSON.stringify(nextRegistry));
}
