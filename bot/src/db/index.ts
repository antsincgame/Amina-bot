/**
 * Unified DB layer — re-exports repos from the active backend.
 *
 * Usage:
 *   import { settingsRepo, promptsRepo, conversationsRepo, analyticsRepo } from '../db/index.js';
 *
 * For raw Supabase access (legacy repos not yet migrated):
 *   import { getSupabase } from '../db/index.js';
 */

import { config } from '../config/index.js';

// Raw Supabase client — always available for repos not yet migrated (P1/P2)
export { getSupabase } from './supabase.js';

// --- Backend selection (lazy, no top-level await) ---

import * as supabaseModule from './supabase.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _appwriteModule: any = null;

async function getAppwriteModule() {
  if (!_appwriteModule) {
    _appwriteModule = await import('./appwrite.js');
  }
  return _appwriteModule;
}

const useAppwrite = config.dbBackend === 'appwrite';

/**
 * Creates a proxy that delegates every method call to the correct backend.
 * For supabase: direct sync call. For appwrite: lazy import then call.
 */
function createProxy<T extends object>(supaRepo: T, repoName: string): T {
  if (!useAppwrite) return supaRepo;

  return new Proxy(supaRepo, {
    get(_target, prop) {
      if (typeof (supaRepo as any)[prop] !== 'function') {
        return (supaRepo as any)[prop];
      }
      return (...args: any[]) =>
        getAppwriteModule().then((m: any) => m[repoName][prop](...args));
    },
  }) as T;
}

export const settingsRepo = createProxy(supabaseModule.settingsRepo, 'settingsRepo');
export const promptsRepo = createProxy(supabaseModule.promptsRepo, 'promptsRepo');
export const conversationsRepo = createProxy(supabaseModule.conversationsRepo, 'conversationsRepo');
export const analyticsRepo = createProxy(supabaseModule.analyticsRepo, 'analyticsRepo');
