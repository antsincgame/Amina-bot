/**
 * Unified DB layer — re-exports repos from the Appwrite backend.
 */

export {
  getAppwrite,
  getAppwriteClient,
  settingsRepo,
  promptsRepo,
  conversationsRepo,
  analyticsRepo,
} from './appwrite.js';
