import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { NEWS_HOST_VALIDATION_TTL_MS } from './news-parser-constants.js';

const validatedNewsHostCache = new Map<string, { safe: boolean; ts: number }>();

function isPrivateIpv4Address(hostname: string): boolean {
  if (/^0\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(hostname)) return true;
  if (/^198\.(1[89])\.\d+\.\d+$/.test(hostname)) return true;

  const privateRange = /^172\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!privateRange) return false;

  const secondOctet = Number(privateRange[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isPrivateIpv6Address(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fe90:')
    || normalized.startsWith('fea0:')
    || normalized.startsWith('feb0:');
}

export function getUnsafeNewsHostError(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) {
    return 'News site URL must include a hostname';
  }

  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized === '::'
  ) {
    return 'News site URL must not target a local or private host';
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4 && isPrivateIpv4Address(normalized)) {
    return 'News site URL must not target a local or private host';
  }

  if (ipVersion === 6 && isPrivateIpv6Address(normalized)) {
    return 'News site URL must not target a local or private host';
  }

  if (ipVersion === 0 && !normalized.includes('.')) {
    return 'News site URL must use a public hostname';
  }

  return null;
}

export async function assertNewsSiteUrlIsSafe(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid news site URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol in news site URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const syncValidationError = getUnsafeNewsHostError(hostname);
  if (syncValidationError) {
    throw new Error(syncValidationError);
  }

  const cached = validatedNewsHostCache.get(hostname);
  if (cached && Date.now() - cached.ts < NEWS_HOST_VALIDATION_TTL_MS) {
    if (!cached.safe) {
      throw new Error('News site URL must not resolve to a local or private host');
    }
    return;
  }

  if (isIP(hostname)) {
    validatedNewsHostCache.set(hostname, { safe: true, ts: Date.now() });
    return;
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error(`Unable to resolve news site host: ${hostname}`);
    }

    const resolvedPrivate = records.some((record) => getUnsafeNewsHostError(record.address));
    validatedNewsHostCache.set(hostname, { safe: !resolvedPrivate, ts: Date.now() });

    if (resolvedPrivate) {
      throw new Error('News site URL must not resolve to a local or private host');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('local or private host')) {
      throw error;
    }
    throw new Error(`Unable to resolve news site host: ${hostname}`);
  }
}
