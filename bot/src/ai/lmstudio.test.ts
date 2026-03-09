import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearLMStudioCache,
  getLMStudioConfig,
  recordHeartbeat,
  getHeartbeatAt,
  getLMStudioHealthStatus,
  checkLMStudioReachable,
} from './lmstudio.js';

vi.mock('../db/supabase.js', () => {
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
    const { settingsRepo } = await import('../db/supabase.js');
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
      const { settingsRepo } = await import('../db/supabase.js');
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
      const { settingsRepo } = await import('../db/supabase.js');
      (settingsRepo as unknown as { _store: Map<string, string> })._store.set(
        'lmstudio_url',
        'https://example.com'
      );

      const cfg = await getLMStudioConfig();
      expect(cfg!.url).toBe('https://example.com/v1');
    });

    it('should not double-append /v1', async () => {
      const { settingsRepo } = await import('../db/supabase.js');
      (settingsRepo as unknown as { _store: Map<string, string> })._store.set(
        'lmstudio_url',
        'https://example.com/v1'
      );

      const cfg = await getLMStudioConfig();
      expect(cfg!.url).toBe('https://example.com/v1');
    });

    it('should use cached config on second call', async () => {
      const { settingsRepo } = await import('../db/supabase.js');
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
  });

  describe('getLMStudioHealthStatus', () => {
    it('should return healthy via heartbeat if recent', async () => {
      const { settingsRepo } = await import('../db/supabase.js');
      const store = (settingsRepo as unknown as { _store: Map<string, string> })._store;
      store.set('lmstudio_url', 'https://tunnel.trycloudflare.com');
      store.set('lmstudio_url_updated_at', new Date().toISOString());

      clearLMStudioCache();
      const cfg = await getLMStudioConfig();
      const status = await getLMStudioHealthStatus(cfg!);
      expect(status.healthy).toBe(true);
      expect(status.source).toBe('heartbeat');
    });

    it('should return unhealthy if heartbeat is stale', async () => {
      const { settingsRepo } = await import('../db/supabase.js');
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
});
