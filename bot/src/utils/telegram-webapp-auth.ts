import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AUTH_AGE_SEC = 86_400;

function timingSafeCompareHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Валидация Telegram.WebApp.initData по алгоритму Bot API.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramWebAppInitData(initData: string, botToken: string): boolean {
  if (!initData?.trim() || !botToken?.trim()) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) return false;
  const authDate = Number.parseInt(authDateRaw, 10);
  if (Number.isNaN(authDate)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > MAX_AUTH_AGE_SEC) return false;

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return timingSafeCompareHex(calculated, hash);
}

export function parseTelegramUserIdFromInitData(initData: string): string | null {
  const params = new URLSearchParams(initData);
  const raw = params.get('user');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id !== 'number' && typeof parsed.id !== 'string') return null;
    const id = typeof parsed.id === 'number' ? parsed.id : Number.parseInt(String(parsed.id), 10);
    if (!Number.isFinite(id)) return null;
    return String(id);
  } catch {
    return null;
  }
}
