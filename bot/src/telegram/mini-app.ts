import { config } from '../config/index.js';

/**
 * Публичный HTTPS-URL мини-приложения Telegram (каталог /mini-app).
 * Без https:// Telegram Web App не откроется — в dev на http вернёт null.
 */
export const getMiniAppUrl = (): string | null => {
  const base = config.botUrl?.replace(/\/+$/, '').trim();
  if (!base || !base.toLowerCase().startsWith('https://')) {
    return null;
  }
  return `${base}/mini-app/index.html`;
};
