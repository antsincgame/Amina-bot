/**
 * Generic TTL Cache Utility
 * 
 * Заменяет 8+ дублированных кэшей по проекту единым паттерном:
 * - cachedFreeModels / freeModelsCacheTime / FREE_MODELS_CACHE_TTL
 * - cachedPerplexityKey / keyCacheLoadedAt / CACHE_TTL
 * - cachedApiKeys / API_KEYS_CACHE_TTL
 * - cachedFreeVisionModels / visionModelsCacheTime / VISION_MODELS_CACHE_TTL
 * - и т.д.
 */

/**
 * Простой in-memory кэш с TTL
 * 
 * @example
 * const modelsCache = new TTLCache<string[]>(5 * 60 * 1000); // 5 минут
 * 
 * const models = modelsCache.get('free');
 * if (!models) {
 *   const fresh = await fetchFreeModels();
 *   modelsCache.set('free', fresh);
 * }
 */
export class TTLCache<T> {
  private cache = new Map<string, { value: T; loadedAt: number }>();

  constructor(private ttlMs: number) {}

  /** Получить значение (или null если просрочено/отсутствует) */
  get(key: string = '_default_'): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt >= this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Установить значение */
  set(key: string, value: T): void;
  set(value: T): void;
  set(keyOrValue: string | T, maybeValue?: T): void {
    if (typeof keyOrValue === 'string' && maybeValue !== undefined) {
      this.cache.set(keyOrValue, { value: maybeValue, loadedAt: Date.now() });
    } else {
      this.cache.set('_default_', { value: keyOrValue as T, loadedAt: Date.now() });
    }
  }

  /** Проверить есть ли свежее значение */
  has(key: string = '_default_'): boolean {
    return this.get(key) !== null;
  }

  /** Удалить конкретный ключ */
  delete(key: string = '_default_'): void {
    this.cache.delete(key);
  }

  /** Очистить весь кэш */
  clear(): void {
    this.cache.clear();
  }

  /** Возраст записи в секундах (-1 если нет) */
  age(key: string = '_default_'): number {
    const entry = this.cache.get(key);
    if (!entry) return -1;
    return Math.round((Date.now() - entry.loadedAt) / 1000);
  }

  /** Количество записей */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Кэш для одного значения (без ключей)
 * Наиболее частый паттерн в проекте
 * 
 * @example
 * const apiKeyCache = new SingleCache<string>(60_000); // 1 минута
 * const key = apiKeyCache.get() ?? await loadKeyFromDB();
 */
export class SingleCache<T> {
  private value: T | null = null;
  private loadedAt = 0;

  constructor(private ttlMs: number) {}

  get(): T | null {
    if (this.value === null) return null;
    if (Date.now() - this.loadedAt >= this.ttlMs) {
      this.value = null;
      return null;
    }
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.loadedAt = Date.now();
  }

  clear(): void {
    this.value = null;
    this.loadedAt = 0;
  }

  /** Возраст в секундах (-1 если нет) */
  age(): number {
    if (this.value === null) return -1;
    return Math.round((Date.now() - this.loadedAt) / 1000);
  }
}
