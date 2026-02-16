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
  pubDate?: Date; // Дата публикации (из RSS/Atom)
}

// ===== Константы =====

const SETTINGS_KEY = 'digest_news_sites';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HEADLINES_PER_SITE = 15;
const MIN_TITLE_LENGTH = 15;
const MAX_TITLE_LENGTH = 300;

// Максимальный возраст новости в часах (новости старше отфильтровываются)
const MAX_NEWS_AGE_HOURS = 48;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// RSS фид стандартные пути (порядок по популярности)
const RSS_PATHS = ['/feed', '/rss', '/rss.xml', '/feed/rss', '/atom.xml', '/feed/atom', '/index.xml', '/rss/all', '/rss/new'];

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
  /\/\w+\/\d{5,}-/, // vc.ru-style: /ai/123456-article-slug
  /\/\w+\/\d{5,}$/, // vc.ru-style: /ai/123456 (без slug)
];

// Паттерны URL, которые указывают что ссылка — прямой RSS фид
const DIRECT_FEED_PATTERNS = [
  /\/rss\/?$/i,
  /\/rss\/\w+\/?$/i,
  /\/feed\/?$/i,
  /\/feed\/\w+\/?$/i,
  /\/atom\.xml$/i,
  /\/rss\.xml$/i,
  /\/index\.xml$/i,
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
    const originHost = new URL(siteOrigin).hostname.replace(/^www\./, '');
    // Должен быть тот же домен (или субдомен)
    if (!parsed.hostname.endsWith(originHost)) return false;
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
 * Парсинг даты публикации из RSS/Atom
 */
function parsePubDate(dateStr: string): Date | undefined {
  if (!dateStr || !dateStr.trim()) return undefined;
  try {
    const date = new Date(dateStr.trim());
    if (isNaN(date.getTime())) return undefined;
    return date;
  } catch {
    return undefined;
  }
}

/**
 * Проверка: новость не старше MAX_NEWS_AGE_HOURS часов
 */
function isNewsRecent(pubDate: Date | undefined): boolean {
  if (!pubDate) return true; // Если нет даты — пропускаем (не фильтруем)
  const now = new Date();
  const ageMs = now.getTime() - pubDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return ageHours <= MAX_NEWS_AGE_HOURS;
}

/**
 * Нормализация заголовка для дедупликации
 * Убирает пунктуацию, лишние пробелы, приводит к lowercase
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // Убираем всё кроме букв (включая кириллицу), цифр и пробелов
    .replace(/[^a-zа-яёїіє0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Добавление заголовка в массив (с дедупликацией)
 */
function addHeadline(
  headlines: ParsedHeadline[],
  seenTitles: Set<string>,
  title: string,
  url: string,
  pubDate?: Date,
): boolean {
  if (headlines.length >= MAX_HEADLINES_PER_SITE) return false;
  if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return false;
  if (isSkipText(title)) return false;
  
  // Фильтрация по дате (если есть)
  if (!isNewsRecent(pubDate)) return false;

  const titleNormalized = normalizeTitle(title);
  if (seenTitles.has(titleNormalized)) return false;

  seenTitles.add(titleNormalized);
  headlines.push({ title, url, source: '', pubDate });
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

  // RSS 2.0: <item><title>...</title><link>...</link><pubDate>...</pubDate></item>
  $('item').each((_i: number, el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $item = $(el);
    const title = cleanTitle($item.find('title').first().text());
    let link = $item.find('link').first().text().trim();

    // Atom-style link: <link href="..."/>
    if (!link) {
      link = $item.find('link').first().attr('href') ?? '';
    }

    // Парсим дату публикации (RSS 2.0: pubDate, Dublin Core: dc:date)
    const pubDateStr = $item.find('pubDate').first().text() 
      || $item.find('dc\\:date').first().text()
      || $item.find('date').first().text();
    const pubDate = parsePubDate(pubDateStr);

    const url = normalizeUrl(link, baseUrl);
    if (url) addHeadline(headlines, seenTitles, title, url, pubDate);
  });

  // Atom: <entry><title>...</title><link href="..."/><published>...</published></entry>
  if (headlines.length === 0) {
    $('entry').each((_i: number, el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $entry = $(el);
      const title = cleanTitle($entry.find('title').first().text());
      const link = $entry.find('link[href]').first().attr('href') ?? '';
      
      // Atom использует <published> или <updated>
      const pubDateStr = $entry.find('published').first().text()
        || $entry.find('updated').first().text();
      const pubDate = parsePubDate(pubDateStr);
      
      const url = normalizeUrl(link, baseUrl);
      if (url) addHeadline(headlines, seenTitles, title, url, pubDate);
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

/**
 * Проверить, является ли URL прямой ссылкой на RSS/Atom фид
 */
function isDirectFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return DIRECT_FEED_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

/**
 * Попытка скачать и спарсить URL как прямой RSS/Atom фид
 */
async function tryDirectFeed(feedUrl: string): Promise<ParsedHeadline[] | null> {
  try {
    const response = await fetchWithTimeout(feedUrl, 8000);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    // Проверяем что это XML/RSS
    if (
      contentType.includes('xml') ||
      contentType.includes('rss') ||
      contentType.includes('atom') ||
      contentType.includes('text/plain') ||
      text.trimStart().startsWith('<?xml') ||
      text.includes('<rss') ||
      text.includes('<feed')
    ) {
      const headlines = parseRssFeed(text, feedUrl);
      if (headlines.length > 0) {
        appLogger.info({ feedUrl, count: headlines.length }, 'Direct RSS feed parsed successfully');
        return headlines;
      }
    }

    // Некоторые сайты (vc.ru) отдают JSON-фид или HTML вместо RSS
    // Пробуем JSON Feed: { "version": "...", "items": [...] }
    if (contentType.includes('json') || text.trimStart().startsWith('{')) {
      try {
        const json = JSON.parse(text) as { items?: Array<{ title?: string; url?: string; external_url?: string }> };
        if (json.items && Array.isArray(json.items)) {
          const headlines: ParsedHeadline[] = [];
          const seenTitles = new Set<string>();
          for (const item of json.items) {
            if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
            const title = cleanTitle(item.title ?? '');
            const url = item.url ?? item.external_url ?? '';
            if (url) addHeadline(headlines, seenTitles, title, url);
          }
          if (headlines.length > 0) {
            appLogger.info({ feedUrl, count: headlines.length }, 'JSON Feed parsed successfully');
            return headlines;
          }
        }
      } catch {
        // не JSON — пропускаем
      }
    }
  } catch (err) {
    appLogger.debug({ error: err, feedUrl }, 'Direct feed fetch failed');
  }
  return null;
}

// ===== HTML парсинг (основной) =====

/**
 * Парсинг заголовков новостей с одного сайта.
 *
 * Порядок приоритетов:
 * 1. Прямой RSS URL (vc.ru/rss, /feed, etc.)
 * 2. URL возвращает RSS/XML напрямую
 * 3. RSS autodiscovery из HTML (<link type="application/rss+xml">)
 * 4. Стандартные RSS пути (/feed, /rss, /rss.xml, ...)
 * 5. HTML парсинг заголовков (fallback)
 */
export async function parseNewsFromSite(siteUrl: string): Promise<ParsedHeadline[]> {
  const origin = new URL(siteUrl).origin;

  // ===== Шаг 0: Если URL — прямая ссылка на RSS =====
  if (isDirectFeedUrl(siteUrl)) {
    appLogger.info({ siteUrl }, 'URL looks like direct RSS feed, trying direct parse');
    const directHeadlines = await tryDirectFeed(siteUrl);
    if (directHeadlines && directHeadlines.length > 0) {
      return directHeadlines;
    }
    appLogger.warn({ siteUrl }, 'Direct RSS feed URL returned no headlines, trying standard paths');
  }

  // ===== Шаг 1: Загрузить URL =====
  let pageBody: string | null = null;
  let pageIsRss = false;

  if (!isDirectFeedUrl(siteUrl)) {
    try {
      const directResponse = await fetchWithTimeout(siteUrl, 8000);
      if (directResponse.ok) {
        const contentType = directResponse.headers.get('content-type') ?? '';
        pageBody = await directResponse.text();
        pageIsRss = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom') ||
          pageBody.trimStart().startsWith('<?xml') || pageBody.trimStart().startsWith('<rss') || pageBody.trimStart().startsWith('<feed');

        // Если контент — RSS/XML, парсим сразу
        if (pageIsRss) {
          const headlines = parseRssFeed(pageBody, origin);
          if (headlines.length > 0) {
            appLogger.info({ siteUrl, count: headlines.length }, 'Direct RSS feed parsed from URL');
            return headlines;
          }
        }
      }
    } catch (err) {
      appLogger.debug({ error: err, siteUrl }, 'Direct URL fetch failed');
    }
  }

  // ===== Шаг 2: RSS autodiscovery из загруженного HTML =====
  if (pageBody && !pageIsRss) {
    try {
      const $meta = load(pageBody);
      const rssLink = $meta('link[type="application/rss+xml"]').attr('href')
        ?? $meta('link[type="application/atom+xml"]').attr('href');
      if (rssLink) {
        const feedUrl = normalizeUrl(rssLink, origin);
        if (feedUrl) {
          appLogger.info({ feedUrl, siteUrl }, 'Found RSS autodiscovery, fetching feed');
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
      // Продолжаем дальше
    }
  }

  // ===== Шаг 3: Стандартные RSS пути (/feed, /rss, /rss.xml, ...) =====
  try {
    const rssHeadlines = await tryRssFeed(siteUrl);
    if (rssHeadlines && rssHeadlines.length > 0) {
      return rssHeadlines;
    }
  } catch (err) {
    appLogger.debug({ error: err, siteUrl }, 'RSS feed attempt failed');
  }

  // ===== Шаг 4: HTML парсинг (последний вариант) =====
  // Используем уже загруженный HTML, если есть
  if (pageBody && !pageIsRss) {
    const htmlHeadlines = parseHtmlContent(pageBody, siteUrl, origin);
    if (htmlHeadlines.length > 0) {
      return htmlHeadlines;
    }
  }

  // Если HTML не был загружен ранее — загружаем сейчас
  if (!pageBody) {
    try {
      const response = await fetchWithTimeout(siteUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const html = await response.text();
      return parseHtmlContent(html, siteUrl, origin);
    } catch (error) {
      const err = error as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        appLogger.warn({ siteUrl }, 'News site parse timeout');
        throw new Error(`Таймаут при загрузке ${siteUrl} (>${FETCH_TIMEOUT_MS / 1000}с)`);
      }
      throw error;
    }
  }

  return [];
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
    if (seenTitles.has(normalizeTitle(title))) return;

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
 * Выполняет дедупликацию между источниками по нормализованному заголовку и URL.
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

  // === Дедупликация между источниками ===
  const allHeadlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>(); // Нормализованные заголовки
  const seenUrls = new Set<string>();   // URL (для ловли разных заголовков на одну статью)
  let duplicatesFiltered = 0;

  results.forEach((result, i) => {
    const site = enabledSites[i]!;
    if (result.status === 'fulfilled') {
      for (const headline of result.value) {
        const titleNorm = normalizeTitle(headline.title);
        const urlNorm = headline.url.toLowerCase();
        
        // Проверяем дубликаты по заголовку ИЛИ по URL
        if (seenTitles.has(titleNorm) || seenUrls.has(urlNorm)) {
          duplicatesFiltered++;
          continue;
        }
        
        seenTitles.add(titleNorm);
        seenUrls.add(urlNorm);
        allHeadlines.push(headline);
      }
    } else {
      appLogger.warn(
        { error: result.reason, siteName: site.name, siteUrl: site.url },
        'Failed to parse news site for digest',
      );
    }
  });

  if (duplicatesFiltered > 0) {
    appLogger.info({ duplicatesFiltered }, 'Cross-source duplicates filtered');
  }

  appLogger.info({ totalHeadlines: allHeadlines.length, sites: enabledSites.length }, 'News parsing complete');
  return allHeadlines;
}
