/**
 * News Parser — парсинг заголовков новостей с настроенных сайтов
 *
 * Используется в утреннем дайджесте для получения актуальных
 * городских новостей вместо Perplexity API.
 *
 * Стратегия парсинга (универсальная):
 * 1. Fetch HTML главной страницы
 * 2. Cheerio: извлечь заголовки из h1-h3 / article / a
 * 3. Фильтрация по длине (15-300 символов)
 * 4. Нормализация URL (относительные → абсолютные)
 * 5. Дедупликация, лимит 10 на сайт
 */

import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { settingsRepo } from '../db/supabase.js';
import { appLogger } from '../config/logger.js';

// ===== Типы =====

export interface NewsSite {
  name: string;
  url: string;
  enabled: boolean;
}

export interface ParsedHeadline {
  title: string;
  url: string;
  source: string;
}

// ===== Константы =====

const SETTINGS_KEY = 'digest_news_sites';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HEADLINES_PER_SITE = 10;
const MIN_TITLE_LENGTH = 15;
const MAX_TITLE_LENGTH = 300;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===== Получение списка сайтов из настроек =====

/**
 * Получить список настроенных новостных сайтов
 */
export async function getConfiguredSites(): Promise<NewsSite[]> {
  try {
    const raw = await settingsRepo.get(SETTINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is NewsSite =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as NewsSite).name === 'string' &&
        typeof (s as NewsSite).url === 'string' &&
        typeof (s as NewsSite).enabled === 'boolean',
    );
  } catch (err) {
    appLogger.warn({ error: err }, 'Failed to parse digest_news_sites setting');
    return [];
  }
}

/**
 * Сохранить список новостных сайтов
 */
export async function saveConfiguredSites(sites: NewsSite[]): Promise<void> {
  await settingsRepo.set(SETTINGS_KEY, JSON.stringify(sites));
}

// ===== Парсинг HTML =====

/**
 * Нормализация URL: относительный → абсолютный
 */
function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return null;
    }
    const resolved = new URL(href, baseUrl);
    // Только http/https
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Очистка текста заголовка
 */
function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')       // нормализация пробелов
    .replace(/[\n\r\t]/g, ' ')  // убрать переносы
    .trim();
}

/**
 * Парсинг заголовков новостей с одного сайта
 */
export async function parseNewsFromSite(siteUrl: string): Promise<ParsedHeadline[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(siteUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const $ = load(html);

    // Убираем навигацию, футер, скрипты, стили, рекламу
    $('nav, footer, script, style, noscript, iframe, .ad, .ads, .advertisement, .banner, .sidebar, .widget, .menu, .navigation').remove();

    const headlines: ParsedHeadline[] = [];
    const seenTitles = new Set<string>();
    const baseUrl = new URL(siteUrl).origin;

    // Стратегия 1: заголовки внутри article, section, .news, .post
    const articleSelectors = [
      'article h1 a, article h2 a, article h3 a',
      'section h1 a, section h2 a, section h3 a',
      '.news-item a, .news-list a, .post-item a',
      '.article-title a, .news-title a, .entry-title a',
      '.item-title a, .card-title a, .story-title a',
    ];

    for (const selector of articleSelectors) {
      $(selector).each((_i: number, el: AnyNode) => {
        if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
        const $el = $(el);
        const title = cleanTitle($el.text());
        const href = $el.attr('href');

        if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
        const titleLower = title.toLowerCase();
        if (seenTitles.has(titleLower)) return;

        const url = normalizeUrl(href ?? '', baseUrl);
        if (!url) return;

        seenTitles.add(titleLower);
        headlines.push({ title, url, source: '' });
      });
    }

    // Стратегия 2: любые h1-h3 с ссылками (если стратегия 1 дала мало)
    if (headlines.length < 3) {
      $('h1 a, h2 a, h3 a').each((_i: number, el: AnyNode) => {
        if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
        const $el = $(el);
        const title = cleanTitle($el.text());
        const href = $el.attr('href');

        if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
        const titleLower = title.toLowerCase();
        if (seenTitles.has(titleLower)) return;

        const url = normalizeUrl(href ?? '', baseUrl);
        if (!url) return;

        seenTitles.add(titleLower);
        headlines.push({ title, url, source: '' });
      });
    }

    // Стратегия 3: ссылки внутри h1-h3 (текст в h-элементе, ссылка оборачивает)
    if (headlines.length < 3) {
      $('a h1, a h2, a h3').each((_i: number, el: AnyNode) => {
        if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
        const $heading = $(el);
        const $link = $heading.closest('a');
        const title = cleanTitle($heading.text());
        const href = $link.attr('href');

        if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
        const titleLower = title.toLowerCase();
        if (seenTitles.has(titleLower)) return;

        const url = normalizeUrl(href ?? '', baseUrl);
        if (!url) return;

        seenTitles.add(titleLower);
        headlines.push({ title, url, source: '' });
      });
    }

    // Стратегия 4: ссылки с длинным текстом внутри article/main (fallback)
    if (headlines.length < 3) {
      $('main a, article a, .content a, .news a, .posts a').each((_i: number, el: AnyNode) => {
        if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
        const $el = $(el);
        const title = cleanTitle($el.text());
        const href = $el.attr('href');

        // Более строгий фильтр: только длинные тексты (вероятные заголовки)
        if (!title || title.length < 30 || title.length > MAX_TITLE_LENGTH) return;
        const titleLower = title.toLowerCase();
        if (seenTitles.has(titleLower)) return;

        const url = normalizeUrl(href ?? '', baseUrl);
        if (!url) return;

        seenTitles.add(titleLower);
        headlines.push({ title, url, source: '' });
      });
    }

    appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed');
    return headlines.slice(0, MAX_HEADLINES_PER_SITE);
  } catch (error) {
    const err = error as { name?: string; message?: string };
    if (err.name === 'AbortError') {
      appLogger.warn({ siteUrl }, 'News site parse timeout');
      throw new Error(`Таймаут при загрузке ${siteUrl} (>${FETCH_TIMEOUT_MS / 1000}с)`);
    }
    appLogger.warn({ error, siteUrl }, 'Failed to parse news site');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== Парсинг всех настроенных сайтов =====

/**
 * Спарсить заголовки со ВСЕХ включённых сайтов (параллельно)
 * Возвращает массив заголовков с указанием источника.
 */
export async function parseAllConfiguredSites(): Promise<ParsedHeadline[]> {
  const sites = await getConfiguredSites();
  const enabledSites = sites.filter(s => s.enabled);

  if (enabledSites.length === 0) {
    appLogger.debug('No enabled news sites configured — skipping parse');
    return [];
  }

  appLogger.info({ count: enabledSites.length }, 'Parsing news from configured sites');

  const results = await Promise.allSettled(
    enabledSites.map(async (site) => {
      const headlines = await parseNewsFromSite(site.url);
      // Добавляем имя источника
      return headlines.map(h => ({ ...h, source: site.name }));
    }),
  );

  const allHeadlines: ParsedHeadline[] = [];

  results.forEach((result, i) => {
    const site = enabledSites[i]!;
    if (result.status === 'fulfilled') {
      allHeadlines.push(...result.value);
    } else {
      appLogger.warn(
        { error: result.reason, siteName: site.name, siteUrl: site.url },
        'Failed to parse news site for digest',
      );
    }
  });

  appLogger.info({ totalHeadlines: allHeadlines.length, sites: enabledSites.length }, 'News parsing complete');
  return allHeadlines;
}
