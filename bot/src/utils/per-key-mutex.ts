/**
 * Per-key in-process mutex.
 *
 * Защищает read-modify-write секции от lost-update race в одном процессе.
 * Multi-worker race не покрывает — для этого нужен серверный механизм
 * (уникальные индексы Appwrite + retry на 409).
 *
 * Использование:
 *   await withPerKeyLock('user:123', async () => {
 *     const doc = await read();
 *     await write({ ...doc, counter: doc.counter + 1 });
 *   });
 */

const LOCKS = new Map<string, Promise<void>>();

export async function withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  // В Map кладём именно нашу done-метку, чтобы потом по идентичности снять её.
  const chained = previous.then(() => done);
  LOCKS.set(key, chained);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (LOCKS.get(key) === chained) {
      LOCKS.delete(key);
    }
  }
}

/** Текущее число живых блокировок — для тестов и диагностики. */
export function activeLockCount(): number {
  return LOCKS.size;
}
