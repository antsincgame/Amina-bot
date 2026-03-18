import { settingsRepo } from '../db/appwrite.js';

const REMINDER_DELIVERY_REGISTRY_KEY = 'reminder_delivery_registry';
const MAX_REGISTRY_ENTRIES = 500;
const STALE_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface ReminderDeliveryRegistryEntry {
  reminderId: string;
  sentAt: string;
}

interface ReminderDeliveryRegistry {
  version: 1;
  entries: ReminderDeliveryRegistryEntry[];
}

const EMPTY_REGISTRY: ReminderDeliveryRegistry = {
  version: 1,
  entries: [],
};

function isReminderDeliveryRegistry(value: unknown): value is ReminderDeliveryRegistry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const registry = value as { version?: unknown; entries?: unknown };
  return registry.version === 1 && Array.isArray(registry.entries);
}

function parseIsoDate(value: string): number | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function pruneEntries(entries: ReminderDeliveryRegistryEntry[]): ReminderDeliveryRegistryEntry[] {
  const now = Date.now();

  return entries
    .filter((entry) => {
      if (!entry?.reminderId || !entry?.sentAt) {
        return false;
      }

      const sentAtTs = parseIsoDate(entry.sentAt);
      if (sentAtTs === null) {
        return false;
      }

      return now - sentAtTs <= STALE_ENTRY_TTL_MS;
    })
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
    .slice(0, MAX_REGISTRY_ENTRIES);
}

async function readRegistry(): Promise<ReminderDeliveryRegistry> {
  const raw = await settingsRepo.get(REMINDER_DELIVERY_REGISTRY_KEY);
  if (!raw) {
    return EMPTY_REGISTRY;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isReminderDeliveryRegistry(parsed)) {
      return EMPTY_REGISTRY;
    }

    return {
      version: 1,
      entries: pruneEntries(parsed.entries as ReminderDeliveryRegistryEntry[]),
    };
  } catch {
    return EMPTY_REGISTRY;
  }
}

async function writeRegistry(registry: ReminderDeliveryRegistry): Promise<void> {
  await settingsRepo.set(REMINDER_DELIVERY_REGISTRY_KEY, JSON.stringify(registry));
}

export async function getReminderDeliveryMap(): Promise<Map<string, ReminderDeliveryRegistryEntry>> {
  const registry = await readRegistry();
  return new Map(registry.entries.map((entry) => [entry.reminderId, entry]));
}

export async function markReminderSent(reminderId: string, sentAt: string): Promise<void> {
  const registry = await readRegistry();
  const remainingEntries = registry.entries.filter((entry) => entry.reminderId !== reminderId);
  const nextRegistry: ReminderDeliveryRegistry = {
    version: 1,
    entries: pruneEntries([{ reminderId, sentAt }, ...remainingEntries]),
  };

  await writeRegistry(nextRegistry);
}

export async function clearReminderSent(reminderId: string): Promise<void> {
  const registry = await readRegistry();
  const nextEntries = registry.entries.filter((entry) => entry.reminderId !== reminderId);
  if (nextEntries.length === registry.entries.length) {
    return;
  }

  await writeRegistry({
    version: 1,
    entries: nextEntries,
  });
}
