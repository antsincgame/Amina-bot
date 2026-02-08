/**
 * News Parser — парсинг заголовков новостей с настроенных сайтов
 *
 * Используется в утреннем дайджесте для получения актуальных
 * городских новостей вместо Perplexity API.
 *
 * Стратегии парсинга (от самой надёжной к fallback):
 * 1. RSS/Atom фид — автообнаружение через <link> или стандартные пути
 * 2. Ссылки внутри h1-h3 заголовков (классический паттерн)
 * 3. Ссылки, оборачивающие h1-h3 (обратный паттерн)
 * 4. Standalone h2/h3 заголовки + ближайшая ссылка (grodnonews.by, newgrodno.by)
 * 5. Все ссылки с «глубоким» URL и текстом-заголовком (универсальный fallback)
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
const MAX_HEADLINES_PER_SITE = 15;
const MIN_TITLE_LENGTH = 15;
const MAX_TITLE_LENGTH = 300;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// RSS фид стандартные пути (порядок по популярности)
const RSS_PATHS = ['/feed', '/rss', '/rss.xml', '/feed/rss', '/atom.xml', '/feed/atom', '/index.xml'];

// Паттерны URL, характерные для новостных статей
const ARTICLE_URL_PATTERNS = [
  /\/\d{4}\/\d{2}\//, // /2026/02/
  /\/\d{4}\/\d{2}\/\d{2}\//, // /2026/02/08/
  /\/news\/\w+\//, // /news/category/
  /\/incidents\//, // /incidents/
  /\/society\//, // /society/
  /\/auto\//, // /auto/
  /\/sport\//, // /sport/
  /\/kultura\//, // /kultura/
  /\/ekonomika\//, // /ekonomika/
  /\.html$/,  // article.html
];

// Тексты/паттерны для фильтрации не-новостных ссылок
const SKIP_LINK_PATTERNS = [
  /читать далее/i,
  /подробнее/i,
  /все новости/i,
  /загрузить ещ[её]/i,
  /показать ещ[её]/i,
  /^все$/i,
  /^ещ[её]$/i,
  /^назад$/i,
  /^далее$/i,
  /^next$/i,
  /^prev$/i,
  /^главная$/i,
  /^home$/i,
];

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

// ===== Утилиты =====

/**
 * Нормализация URL: относительный → абсолютный
 */
function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return null;
    }
    const resolved = new URL(href, baseUrl);
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
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .trim();
}

/**
 * Проверка: URL похож на ссылку на статью (а не на категорию/тег)
 */
function isArticleUrl(url: string, siteOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    // Должен быть тот же домен (или субдомен)
    if (!parsed.hostname.endsWith(new URL(siteOrigin).hostname.replace(/^www\./, ''))) return false;
    // Путь должен иметь глубину >= 2 сегментов
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    // Проверяем паттерны статейных URL
    return ARTICLE_URL_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

/**
 * Проверка: текст не является навигационным/служебным
 */
function isSkipText(text: string): boolean {
  return SKIP_LINK_PATTERNS.some(p => p.test(text));
}

/**
 * Добавление заголовка в массив (с дедупликацией)
 */
function addHeadline(
  headlines: ParsedHeadline[],
  seenTitles: Set<string>,
  title: string,
  url: string,
): boolean {
  if (headlines.length >= MAX_HEADLINES_PER_SITE) return false;
  if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return false;
  if (isSkipText(title)) return false;

  const titleLower = title.toLowerCase();
  if (seenTitles.has(titleLower)) return false;

  seenTitles.add(titleLower);
  headlines.push({ title, url, source: '' });
  return true;
}

// ===== Fetch с таймаутом =====

async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== RSS/Atom парсинг =====

/**
 * Попытка спарсить RSS/Atom фид
 */
function parseRssFeed(xml: string, baseUrl: string): ParsedHeadline[] {
  const $ = load(xml, { xml: true });
  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();

  // RSS 2.0: <item><title>...</title><link>...</link></item>
  $('item').each((_i: number, el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $item = $(el);
    const title = cleanTitle($item.find('title').first().text());
    let link = $item.find('link').first().text().trim();

    // Atom-style link: <link href="..."/>
    if (!link) {
      link = $item.find('link').first().attr('href') ?? '';
    }

    const url = normalizeUrl(link, baseUrl);
    if (url) addHeadline(headlines, seenTitles, title, url);
  });

  // Atom: <entry><title>...</title><link href="..."/></entry>
  if (headlines.length === 0) {
    $('entry').each((_i: number, el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $entry = $(el);
      const title = cleanTitle($entry.find('title').first().text());
      const link = $entry.find('link[href]').first().attr('href') ?? '';
      const url = normalizeUrl(link, baseUrl);
      if (url) addHeadline(headlines, seenTitles, title, url);
    });
  }

  return headlines;
}

/**
 * Попытка найти и спарсить RSS фид для сайта
 */
async function tryRssFeed(siteUrl: string): Promise<ParsedHeadline[] | null> {
  const origin = new URL(siteUrl).origin;

  // 1. Попробовать стандартные пути RSS
  for (const path of RSS_PATHS) {
    try {
      const feedUrl = origin + path;
      const response = await fetchWithTimeout(feedUrl, 5000);
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();

      // Проверяем, что это XML/RSS, а не HTML
      if (
        contentType.includes('xml') ||
        contentType.includes('rss') ||
        contentType.includes('atom') ||
        text.trimStart().startsWith('<?xml') ||
        text.includes('<rss') ||
        text.includes('<feed')
      ) {
        const headlines = parseRssFeed(text, origin);
        if (headlines.length > 0) {
          appLogger.info({ feedUrl, count: headlines.length }, 'RSS feed parsed');
          return headlines;
        }
      }
    } catch {
      // Тихо пропускаем — пробуем следующий путь
    }
  }

  return null;
}

// ===== HTML парсинг (основной) =====

/**
 * Парсинг заголовков новостей с одного сайта
 */
export async function parseNewsFromSite(siteUrl: string): Promise<ParsedHeadline[]> {
  const origin = new URL(siteUrl).origin;

  // ===== Шаг 0: Проверить, является ли сам URL RSS-фидом =====
  // (например https://vc.ru/rss/ai — URL уже указывает на фид, а не на HTML-страницу)
  try {
    const directResponse = await fetchWithTimeout(siteUrl, 8000);
    if (directResponse.ok) {
      const contentType = directResponse.headers.get('content-type') ?? '';
      const bodyText = await directResponse.text();
      const isRss = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom') ||
        bodyText.trimStart().startsWith('<?xml') || bodyText.trimStart().startsWith('<rss') || bodyText.trimStart().startsWith('<feed');
      
      if (isRss) {
        const headlines = parseRssFeed(bodyText, origin);
        if (headlines.length > 0) {
          appLogger.info({ siteUrl, count: headlines.length }, 'Direct RSS feed parsed from URL');
          return headlines;
        }
      }
      
      // Если это НЕ RSS, bodyText содержит HTML — сохраним для дальнейшего парсинга
      if (!isRss) {
        // Переиспользуем загруженный HTML вместо повторной загрузки
        return parseHtmlContent(bodyText, siteUrl, origin);
      }
    }
  } catch (err) {
    appLogger.debug({ error: err, siteUrl }, 'Direct URL fetch failed, trying RSS paths');
  }

  // ===== Шаг 1: Попробовать стандартные RSS пути =====
  try {
    const rssHeadlines = await tryRssFeed(siteUrl);
    if (rssHeadlines && rssHeadlines.length > 0) {
      return rssHeadlines;
    }
  } catch (err) {
    appLogger.debug({ error: err, siteUrl }, 'RSS feed attempt failed, trying HTML');
  }

  // ===== Шаг 2: Загрузить HTML и парсить =====
  let html: string;
  try {
    const response = await fetchWithTimeout(siteUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (error) {
    const err = error as { name?: string; message?: string };
    if (err.name === 'AbortError') {
      appLogger.warn({ siteUrl }, 'News site parse timeout');
      throw new Error(`Таймаут при загрузке ${siteUrl} (>${FETCH_TIMEOUT_MS / 1000}с)`);
    }
    throw error;
  }

  // ===== Шаг 2а: Проверить autodiscovery RSS в HTML =====
  try {
    const $meta = load(html);
    const rssLink = $meta('link[type="application/rss+xml"]').attr('href')
      ?? $meta('link[type="application/atom+xml"]').attr('href');
    if (rssLink) {
      const feedUrl = normalizeUrl(rssLink, origin);
      if (feedUrl) {
        const rssResponse = await fetchWithTimeout(feedUrl, 5000);
        if (rssResponse.ok) {
          const feedXml = await rssResponse.text();
          const rssHeadlines = parseRssFeed(feedXml, origin);
          if (rssHeadlines.length > 0) {
            appLogger.info({ feedUrl, count: rssHeadlines.length }, 'RSS autodiscovery feed parsed');
            return rssHeadlines;
          }
        }
      }
    }
  } catch {
    // Продолжаем HTML парсинг
  }

  return parseHtmlContent(html, siteUrl, origin);
}

/**
 * Парсинг заголовков из HTML-контента
 */
function parseHtmlContent(html: string, siteUrl: string, origin: string): ParsedHeadline[] {
  // ===== Парсинг HTML структуры =====
  const $ = load(html);

  // Убираем навигацию, футер, скрипты, стили, рекламу
  $('nav, footer, script, style, noscript, iframe, .ad, .ads, .advertisement, .banner, .sidebar, .widget, .menu, .navigation, header').remove();

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();

  // --- Стратегия A: Ссылки внутри заголовков h1-h3 ---
  $('h1 a, h2 a, h3 a').each((_i: number, _el: AnyNode) => {
    const $el = $(_el);
    const title = cleanTitle($el.text());
    const href = $el.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      if (addHeadline(headlines, seenTitles, title, url)) {
        seenUrls.add(url);
      }
    }
  });

  // --- Стратегия B: Ссылки, оборачивающие заголовки h1-h3 ---
  $('a h1, a h2, a h3').each((_i: number, _el: AnyNode) => {
    const $heading = $(_el);
    const $link = $heading.closest('a');
    const title = cleanTitle($heading.text());
    const href = $link.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      if (addHeadline(headlines, seenTitles, title, url)) {
        seenUrls.add(url);
      }
    }
  });

  // --- Стратегия C: Standalone h2/h3 без ссылки → ищем ближайшую ссылку ---
  $('h2, h3').each((_i: number, _el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $heading = $(_el);
    const title = cleanTitle($heading.text());

    if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
    if (isSkipText(title)) return;
    if (seenTitles.has(title.toLowerCase())) return;

    // Уже нашли через стратегию A/B?
    const innerLink = $heading.find('a').attr('href');
    if (innerLink) return;

    // Ищем ссылку: ближайший родительский <a>
    const parentLink = $heading.closest('a').attr('href');
    if (parentLink) {
      const url = normalizeUrl(parentLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url)) {
          seenUrls.add(url);
        }
      }
      return;
    }

    // Ищем ссылку в соседних элементах
    const $parent = $heading.parent();
    const siblingLink = $parent.find('a').filter((_: number, a: AnyNode) => {
      const href = $(a).attr('href');
      if (!href) return false;
      const resolved = normalizeUrl(href, origin);
      return resolved !== null && !seenUrls.has(resolved);
    }).first().attr('href');

    if (siblingLink) {
      const url = normalizeUrl(siblingLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url)) {
          seenUrls.add(url);
        }
      }
      return;
    }

    // Проверяем родителя родителя
    const $grandParent = $parent.parent();
    const gpLink = $grandParent.find('a').filter((_: number, a: AnyNode) => {
      const href = $(a).attr('href');
      if (!href) return false;
      const resolved = normalizeUrl(href, origin);
      return resolved !== null && isArticleUrl(resolved, origin) && !seenUrls.has(resolved);
    }).first().attr('href');

    if (gpLink) {
      const url = normalizeUrl(gpLink, origin);
      if (url && !seenUrls.has(url)) {
        if (addHeadline(headlines, seenTitles, title, url)) {
          seenUrls.add(url);
        }
      }
    }
  });

  // --- Стратегия D: Все ссылки с «статейным» URL и длинным текстом ---
  if (headlines.length < 5) {
    $('a[href]').each((_i: number, _el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $el = $(_el);
      const title = cleanTitle($el.text());
      const href = $el.attr('href') ?? '';

      if (!title || title.length < 25 || title.length > MAX_TITLE_LENGTH) return;
      if (isSkipText(title)) return;

      const url = normalizeUrl(href, origin);
      if (!url || seenUrls.has(url)) return;

      if (!isArticleUrl(url, origin)) return;

      if (addHeadline(headlines, seenTitles, title, url)) {
        seenUrls.add(url);
      }
    });
  }

  appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed (HTML)');
  return headlines.slice(0, MAX_HEADLINES_PER_SITE);
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
