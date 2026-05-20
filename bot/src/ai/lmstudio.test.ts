import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearLMStudioCache,
  getLMStudioConfig,
  recordHeartbeat,
  getHeartbeatAt,
  getHeartbeatUrl,
  getLMStudioHealthStatus,
  checkLMStudioHealth,
  checkLMStudioReachable,
  probeLMStudioDirect,
  probeLMStudioTunnelUrl,
  isLMStudioCircuitOpen,
  recordLMStudioFailure,
  recordLMStudioSuccess,
  getLMStudioCircuitStatus,
  getEffectiveLMStudioModel,
} from './lmstudio.js';

vi.mock('../db/index.js', () => {
  const store = new Map<string, string>();
  return {
    settingsRepo: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      getMany: vi.fn(async (keys: string[]) => {
        const result: Record<string, string> = {};
        for (const k of keys) {
          const v = store.get(k);
          if (v) result[k] = v;
        }
        return result;
      }),
      invalidateCache: vi.fn(),
      _store: store,
    },
  };
});

vi.mock('../config/logger.js', () => ({
  aiLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('lmstudio', () => {
  beforeEach(async () => {
    clearLMStudioCache();
    const { settingsRepo } = await import('../db/index.js');
    (settingsRepo as unknown as { _store: Map<string, string> })._store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getLMStudioConfig', () => {
    it('should return null when no URL is configured', async () => {
      const cfg = await getLMStudioConfig();
      expect(cfg).toBeNull();
    });

    it('should return config when URL is set', async () => {
      const { settingsRepo } = await import('../db/index.js');
      (settingsRepo as unknown as { _store: Map<string, string> })._store.set(
        'lmstudio_url',
        'https://test-tunnel.trycloudflare.com'
      );

      const cfg = await getLMStudioConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.url).toBe('https://test-tunnel.trycloudflare.com/v1');
      expect(cfg!.apiKey).toBe('lm-studio');
    });

    it('should append /v1 if not present', async () => {
      const { settingsRepo } = await import('../db/index.js');
      (settingsRepo as unknown as { _store: Map<string, string> })._store.set(
        'lmstudio_url',
        'https://example.com'
      );

      const cfg = await getLMStudioConfig();
      expect(cfg!.url).toBe('https://example.com/v1');
    });

    it('should not double-append /v1', async () => {
      const { settingsRepo } = await import('../db/index.js');
      (settingsRepo as unknown as { _store: Map<string, string> })._store.set(
        'lmstudio_url',
        'https://example.com/v1'
      );

      const cfg = await getLMStudioConfig();
      expect(cfg!.url).toBe('https://example.com/v1');
    });

    it('should use cached config on second call', async () => {
      const { settingsRepo } = await import('../db/index.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://cached.trycloudflare.com');

      const first = await getLMStudioConfig();
      store.set('lmstudio_url', 'https://changed.trycloudflare.com');
      const second = await getLMStudioConfig();

      expect(first!.url).toBe(second!.url);
    });
  });

  describe('recordHeartbeat / getHeartbeatAt', () => {
    it('should record and retrieve heartbeat timestamp', async () => {
      await recordHeartbeat();
      const at = await getHeartbeatAt();
      expect(at).not.toBeNull();
      const ts = new Date(at!).getTime();
      expect(Date.now() - ts).toBeLessThan(5000);
    });

    it('should return null when no heartbeat recorded', async () => {
      const at = await getHeartbeatAt();
      expect(at).toBeNull();
    });

    it('should store heartbeat url when provided', async () => {
      await recordHeartbeat('https://tunnel.trycloudflare.com');
      const url = await getHeartbeatUrl();
      expect(url).toBe('https://tunnel.trycloudflare.com');
    });
  });

  describe('getLMStudioHealthStatus', () => {
    it('should return healthy via heartbeat if recent', async () => {
      const { settingsRepo } = await import('../db/index.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://tunnel.trycloudflare.com');
      store.set('lmstudio_url_updated_at', new Date().toISOString());
      store.set('lmstudio_url_heartbeat_url', 'https://tunnel.trycloudflare.com');

      clearLMStudioCache();
      const cfg = await getLMStudioConfig();
      const status = await getLMStudioHealthStatus(cfg!);
      expect(status.healthy).toBe(true);
      expect(status.source).toBe('heartbeat');
    });

    it('should return unhealthy if heartbeat is stale', async () => {
      const { settingsRepo } = await import('../db/index.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://tunnel.trycloudflare.com');
      store.set(
        'lmstudio_url_updated_at',
        new Date(Date.now() - 300_000).toISOString()
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

      try {
        clearLMStudioCache();
        const cfg = await getLMStudioConfig();
        const status = await getLMStudioHealthStatus(cfg!);
        expect(status.healthy).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should ignore heartbeat when it belongs to another tunnel url', async () => {
      const { settingsRepo } = await import('../db/index.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://tunnel-a.trycloudflare.com');
      store.set('lmstudio_url_updated_at', new Date().toISOString());
      store.set('lmstudio_url_heartbeat_url', 'https://tunnel-b.trycloudflare.com');

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

      try {
        clearLMStudioCache();
        const cfg = await getLMStudioConfig();
        const status = await getLMStudioHealthStatus(cfg!);
        expect(status.healthy).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('probeLMStudioDirect', () => {
    it('should fall back to the OpenAI endpoint when native fetch fails', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('', { status: 200 }) as Response);

      const result = await probeLMStudioDirect({
        url: 'https://fallback.trycloudflare.com/v1',
        model: 'test',
        apiKey: 'lm-studio',
      });

      expect(result.healthy).toBe(true);
      expect(result.status).toBe(200);
      expect(result.endpoint).toBe('openai');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/models');
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/models');
    });
  });

  describe('checkLMStudioHealth', () => {
    it('should return healthy when native fetch fails but openai endpoint succeeds', async () => {
      const { settingsRepo } = await import('../db/index.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://fallback.trycloudflare.com');

      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('', { status: 200 }) as Response);

      clearLMStudioCache();
      const cfg = await getLMStudioConfig();
      const healthy = await checkLMStudioHealth(cfg!);

      expect(healthy).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkLMStudioReachable', () => {
    it('should return false when tunnel is not reachable', async () => {
      const cfg = {
        url: 'https://nonexistent-tunnel-12345.trycloudflare.com/v1',
        model: 'test',
        apiKey: 'lm-studio',
      };
      const reachable = await checkLMStudioReachable(cfg);
      expect(reachable).toBe(false);
    }, 25_000);
  });

  describe('probeLMStudioTunnelUrl', () => {
    it('should accept a protected LM Studio endpoint without sending Authorization', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('', { status: 401 }) as Response);

      const reachable = await probeLMStudioTunnelUrl('https://safe.trycloudflare.com');

      expect(reachable).toBe(true);
      expect(fetchMock).toHaveBeenCalled();

      const requestInit = fetchMock.mock.calls[0]?.[1];
      const headers = requestInit?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBeUndefined();
    });
  });

  describe('getEffectiveLMStudioModel', () => {
    it('возвращает заданную модель без обращения к /models', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const model = await getEffectiveLMStudioModel({ url: 'https://t.example/v1', model: 'qwen/qwen3-8b', apiKey: 'lm-studio' });
      expect(model).toBe('qwen/qwen3-8b');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('авто-выбирает первую загруженную модель, когда модель не задана', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'local/loaded-model' }, { id: 'local/other' }] }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const model = await getEffectiveLMStudioModel({ url: 'https://t.example/v1', model: '', apiKey: 'lm-studio' });
      expect(model).toBe('local/loaded-model');
    });

    it('возвращает пустую строку, если модель не задана и список получить не удалось', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('tunnel down'));
      vi.stubGlobal('fetch', fetchMock);
      const model = await getEffectiveLMStudioModel({ url: 'https://t.example/v1', model: '', apiKey: 'lm-studio' });
      expect(model).toBe('');
    });
  });

  describe('circuit breaker', () => {
    const CIRCUIT_COOLDOWN_MS = 3 * 60_000;
    const HALF_OPEN_PROBE_TIMEOUT_MS = 70_000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
      clearLMStudioCache(); // сбрасывает состояние брейкера в closed
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const trip = () => {
      for (let i = 0; i < 5; i++) recordLMStudioFailure();
    };

    it('открывается после порога ошибок и блокирует запросы', () => {
      expect(isLMStudioCircuitOpen()).toBe(false);
      trip();
      expect(isLMStudioCircuitOpen()).toBe(true);
      expect(getLMStudioCircuitStatus().state).toBe('open');
    });

    it('после cooldown пропускает ровно одну half-open пробу', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_COOLDOWN_MS);
      expect(isLMStudioCircuitOpen()).toBe(false); // проба №1 разрешена
      expect(getLMStudioCircuitStatus().state).toBe('half-open');
      expect(isLMStudioCircuitOpen()).toBe(true);  // вторая параллельная — заблокирована
    });

    it('освобождает «зависшую» half-open пробу по таймауту аренды (без record*)', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_COOLDOWN_MS);
      expect(isLMStudioCircuitOpen()).toBe(false); // выдали пробу
      expect(isLMStudioCircuitOpen()).toBe(true);  // ещё в аренде

      // Вызывающий код не вызвал recordSuccess/Failure (конфиг/health упал на пути).
      // Раньше флаг залипал навсегда. Теперь аренда истекает и выдаётся новая проба.
      vi.advanceTimersByTime(HALF_OPEN_PROBE_TIMEOUT_MS);
      expect(isLMStudioCircuitOpen()).toBe(false);
    });

    it('успех в half-open закрывает брейкер', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_COOLDOWN_MS);
      expect(isLMStudioCircuitOpen()).toBe(false);
      recordLMStudioSuccess();
      expect(getLMStudioCircuitStatus().state).toBe('closed');
      expect(isLMStudioCircuitOpen()).toBe(false);
    });

    it('неудача в half-open снова открывает брейкер', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_COOLDOWN_MS);
      expect(isLMStudioCircuitOpen()).toBe(false);
      recordLMStudioFailure();
      expect(getLMStudioCircuitStatus().state).toBe('open');
      expect(isLMStudioCircuitOpen()).toBe(true);
    });
  });
});
