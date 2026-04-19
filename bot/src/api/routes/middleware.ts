import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/index.js';
import { serverLogger } from '../../config/logger.js';
import { rateLimitHook } from '../../utils/rate-limiter.js';
import { isRealtimeBridgeTokenValid } from '../../features/telephony/service/realtime-bridge-config.js';
import { settingsRepo } from '../../db/index.js';
import {
  clearLMStudioCache,
  recordHeartbeat,
} from '../../ai/lmstudio.js';

// --------------------------------------------
// Shared Auth Helpers
// --------------------------------------------

const TUNNEL_AUTH_HEADER = 'x-amina-tunnel-token';

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    return readHeaderValue(value[0]);
  }

  return null;
}

function readTunnelToken(request: FastifyRequest): string | null {
  const explicitToken = readHeaderValue(request.headers[TUNNEL_AUTH_HEADER]);
  if (explicitToken) {
    return explicitToken;
  }

  const authorization = readHeaderValue(request.headers.authorization);
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim() || null;
}

export function getBearerToken(request: FastifyRequest): string | null {
  const authorization = readHeaderValue(request.headers.authorization);
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim() || null;
}

export async function requireAdminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; email: string | null } | null> {
  const token = getBearerToken(request);
  if (!token) {
    await reply.code(401).send({ success: false, error: 'Admin authorization required' });
    return null;
  }

  // Validate Appwrite JWT
  try {
    const { Client: AWClient, Account: AWAccount } = await import('node-appwrite');
    const client = new AWClient()
      .setEndpoint(config.appwrite.endpoint)
      .setProject(config.appwrite.projectId)
      .setJWT(token);
    const acc = new AWAccount(client);
    const user = await acc.get();
    return { userId: user.$id, email: user.email ?? null };
  } catch (err) {
    // Раньше любая ошибка тихо превращалась в 403 — сложно отличить протухший JWT от
    // недоступности Appwrite. Логируем причину (без токена) и ставим внятный код.
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.warn({ error: message }, 'requireAdminAuth: token validation failed');
    await reply.code(403).send({ success: false, error: 'Invalid admin session' });
    return null;
  }
}

export async function requireRealtimeBridgeAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const token = getBearerToken(request);
  if (!token) {
    await reply.code(401).send({ success: false, error: 'Bridge token is required' });
    return false;
  }

  if (!(await isRealtimeBridgeTokenValid(token))) {
    await reply.code(403).send({ success: false, error: 'Invalid bridge token' });
    return false;
  }

  return true;
}

// --------------------------------------------
// Admin Guard
// --------------------------------------------

const ADMIN_GUARDED_API_ROUTES = [
  /^\/chat(?:\/|$)/,
  /^\/conversations(?:\/|$)/,
  /^\/settings(?:\/|$)/,
  /^\/prompts(?:\/|$)/,
  /^\/logs(?:\/|$)/,
  /^\/analytics(?:\/|$)/,
  /^\/models(?:\/|$)/,
  /^\/websearch(?:\/|$)/,
  /^\/users(?:\/|$)/,
  /^\/news-sites(?:\/|$)/,
  /^\/voice-messages(?:\/|$)/,
  /^\/lmstudio(?:\/|$)/,
  /^\/self-core(?:\/|$)/,
  /^\/reconciliation(?:\/|$)/,
  /^\/providers(?:\/|$)/,
  /^\/debug\/raw-news$/,
] as const;

function isAdminGuardedApiRoute(routePath: string): boolean {
  return ADMIN_GUARDED_API_ROUTES.some((pattern) => pattern.test(routePath));
}

// --------------------------------------------
// Tunnel Auth Helpers
// --------------------------------------------

export function getTunnelAuthFailure(request: FastifyRequest): { statusCode: number; error: string } | null {
  if (!config.tunnel.token) {
    return {
      statusCode: 503,
      error: 'LMSTUDIO_TUNNEL_TOKEN is not configured on the server',
    };
  }

  const token = readTunnelToken(request);
  if (!token) {
    return { statusCode: 401, error: 'Tunnel token is required' };
  }

  if (token !== config.tunnel.token) {
    return { statusCode: 403, error: 'Invalid tunnel token' };
  }

  return null;
}

export function getTunnelUrlValidationError(tunnelUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(tunnelUrl);
  } catch {
    return 'url must be a valid absolute URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'url must start with https://';
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(hostname)
    || /^10\.\d+\.\d+\.\d+$/.test(hostname)
    || /^192\.168\.\d+\.\d+$/.test(hostname)
  ) {
    return 'url must not target a local or private host';
  }

  const privateRange = /^172\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (privateRange) {
    const secondOctet = Number(privateRange[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return 'url must not target a local or private host';
    }
  }

  return null;
}

export function normalizeTunnelBaseUrl(tunnelUrl: string): string {
  return tunnelUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export async function persistRegisteredTunnelUrl(tunnelUrl: string): Promise<void> {
  await settingsRepo.set('lmstudio_url', tunnelUrl);
  await recordHeartbeat(tunnelUrl);
  clearLMStudioCache();
  settingsRepo.invalidateCache?.();
}

// --------------------------------------------
// Shared HTML helpers
// --------------------------------------------

/** HTML escape for lead messages (independent of telegram/format.ts) */
export function escapeHtmlSimple(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --------------------------------------------
// Register Middleware Hooks
// --------------------------------------------

export async function registerMiddleware(apiServer: FastifyInstance): Promise<void> {
  apiServer.addHook('preHandler', rateLimitHook('api'));
  apiServer.addHook('preHandler', async (request, reply) => {
    const routePath = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (!isAdminGuardedApiRoute(routePath)) {
      return;
    }

    const admin = await requireAdminAuth(request, reply);
    if (!admin) {
      return reply;
    }
  });
}
