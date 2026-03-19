import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const miniAppHtmlPath = join(dirname(fileURLToPath(import.meta.url)), 'mini-app-web.html');

/**
 * HTML Telegram Web App. Файл лежит рядом с этим модулем в `src/telegram/`,
 * чтобы Docker `COPY bot/` всегда включал его в образ (папка `public/` на сборках часто пустая/кеш).
 */
export const getMiniAppHtml = (): string => readFileSync(miniAppHtmlPath, 'utf-8');
