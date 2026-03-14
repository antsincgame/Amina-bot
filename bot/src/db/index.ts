/**
 * Unified DB layer — re-exports repos from the active backend.
 *
 * Usage:
 *   import { settingsRepo, promptsRepo } from '../db/index.js';
 *
 * For raw Supabase access (legacy repos not yet migrated):
 *   import { getSupabase } from '../db/index.js';
 */

import { config } from '../config/index.js';

// Raw Supabase client — always available for repos not yet migrated (P1/P2)
export { getSupabase } from './supabase.js';

// Pick active backend via top-level await (ESM, ES2022)
const mod = config.dbBackend === 'appwrite'
  ? await import('./appwrite.js')
  : await import('./supabase.js');

export const settingsRepo = mod.settingsRepo;
export const promptsRepo = mod.promptsRepo;
export const conversationsRepo = mod.conversationsRepo;
export const analyticsRepo = mod.analyticsRepo;
