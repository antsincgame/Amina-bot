import { dbLogger } from '../../../config/logger.js';

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureTelephonyInfra(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = doEnsureTelephonyInfra();
  try { await initPromise; } finally { initPromise = null; }
}

async function doEnsureTelephonyInfra(): Promise<void> {
  if (initialized) return;
  // Appwrite: collections pre-created via setup-telephony-collections.mjs
  initialized = true;
  dbLogger.debug('Telephony infra ready (Appwrite collections)');
}
