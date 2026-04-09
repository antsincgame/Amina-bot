import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ParsedHeadline, ParseOptions, HtmlFieldMapping } from './news-parser-types.js';
import {
  addHeadline,
  cleanTitle,
  cleanHtmlSnippet,
  normalizeUrl,
  normalizeTitle,
  isArticleUrl,
  isSkipText,
  parsePubDate,
} from './headline-utils.js';
import { MAX_HEADLINES_PER_SITE, MIN_TITLE_LENGTH, MAX_TITLE_LENGTH } from '../../config/constants.js';
import { parseGitHubTrending, parseTldrArchives } from './parse-html-special.js';
import { appLogger } from '../../config/logger.js';

function extractDescriptionFromContainer(
  $container: Cheerio<AnyNode>,
  titleText: string,
  selectors?: string[],
): string {
  if (selectors && selectors.length > 0) {
    for (const selector of selectors) {
      const text = cleanHtmlSnippet($container.find(selector).first().text());
      if (text) return text;
    }
  }

  const paragraphText = cleanHtmlSnippet($container.find('p').first().text());
  if (paragraphText && paragraphText !== titleText) {
    return paragraphText;
  }

  const containerText = cleanHtmlSnippet($container.text());
  if (!containerText) return '';
  if (containerText === titleText) return '';
  if (containerText.startsWith(titleText)) {
    return cleanTitle(containerText.slice(titleText.length));
  }
  return containerText;
}

export function parseHtmlWithMapping(
  html: string,
  siteUrl: string,
  origin: string,
  mapping: HtmlFieldMapping,
  options?: ParseOptions,
): ParsedHeadline[] {
  const $ = load(html);
  if (mapping.removeSelectors && mapping.removeSelectors.length > 0) {
    $(mapping.removeSelectors.join(',')).remove();
  }

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const itemSelectors = mapping.itemSelectors ?? [];

  const collectFromContainer = ($container: ReturnType<typeof $>) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;

    let linkNode = $container.is('a') ? $container : $container.find('a[href]').first();
    if (mapping.linkSelectors && mapping.linkSelectors.length > 0) {
      for (const selector of mapping.linkSelectors) {
        const candidate = $container.find(selector).first();
        if (candidate.length > 0) {
          linkNode = candidate;
          break;
        }
      }
    }

    let titleText = '';
    let titleNode: ReturnType<typeof $> | null = null;
    if (mapping.titleSelectors && mapping.titleSelectors.length > 0) {
      for (const selector of mapping.titleSelectors) {
        const candidate = $container.find(selector).first();
        const candidateText = cleanTitle(candidate.text());
        if (candidate.length > 0 && candidateText) {
          titleNode = candidate;
          titleText = candidateText;
          break;
        }
      }
    }

    if (!titleText) {
      titleText = cleanTitle(linkNode.first().text()) || cleanTitle($container.text());
    }

    const href = linkNode.attr('href') ?? titleNode?.closest('a').attr('href') ?? '';

    const url = normalizeUrl(href, origin);
    if (!url || seenUrls.has(url)) return;
    const description = extractDescriptionFromContainer($container, titleText, mapping.descriptionSelectors);

    let pubDate: Date | undefined;
    if (mapping.dateSelectors && mapping.dateSelectors.length > 0) {
      for (const selector of mapping.dateSelectors) {
        const dateNode = $container.find(selector).first();
        if (dateNode.length === 0) continue;
        const rawDate = mapping.dateAttribute
          ? String(dateNode.attr(mapping.dateAttribute) ?? dateNode.text())
          : String(dateNode.text());
        pubDate = parsePubDate(rawDate);
        if (pubDate) break;
      }
    }

    if (addHeadline(headlines, seenTitles, titleText, url, { ...options, pubDate, description })) {
      seenUrls.add(url);
    }
  };

  if (itemSelectors.length > 0) {
    for (const selector of itemSelectors) {
      $(selector).each((_i: number, el: AnyNode) => collectFromContainer($(el)));
      if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
    }
  }

  if (headlines.length === 0 && mapping.linkSelectors && mapping.linkSelectors.length > 0) {
    for (const selector of mapping.linkSelectors) {
      $(selector).each((_i: number, el: AnyNode) => collectFromContainer($(el)));
      if (headlines.length >= MAX_HEADLINES_PER_SITE) break;
    }
  }

  appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed (custom HTML mapping)');
  return headlines.slice(0, MAX_HEADLINES_PER_SITE);
}

export function parseHtmlContent(
  html: string,
  siteUrl: string,
  origin: string,
  options?: ParseOptions,
): ParsedHeadline[] {
  if (siteUrl.includes('github.com/trending')) {
    return parseGitHubTrending(html, options);
  }
  if (siteUrl.includes('tldr.tech')) {
    return parseTldrArchives(html, origin, options);
  }

  if (options?.htmlMapping) {
    const mappedHeadlines = parseHtmlWithMapping(html, siteUrl, origin, options.htmlMapping, options);
    if (mappedHeadlines.length > 0) {
      return mappedHeadlines;
    }
  }

  const $ = load(html);
  $('nav, footer, script, style, noscript, iframe, .ad, .ads, .advertisement, .banner, .sidebar, .widget, .menu, .navigation, header').remove();

  const headlines: ParsedHeadline[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const getContainerDescription = ($node: Cheerio<AnyNode>, title: string): string => {
    const $container = $node.closest('article, li, section, div');
    return extractDescriptionFromContainer($container.length > 0 ? $container : $node.parent(), title);
  };

  $('h1 a, h2 a, h3 a').each((_i: number, _el: AnyNode) => {
    const $el = $(_el);
    const title = cleanTitle($el.text());
    const href = $el.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      const description = getContainerDescription($el, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) {
        seenUrls.add(url);
      }
    }
  });

  $('a h1, a h2, a h3').each((_i: number, _el: AnyNode) => {
    const $heading = $(_el);
    const $link = $heading.closest('a');
    const title = cleanTitle($heading.text());
    const href = $link.attr('href');
    const url = normalizeUrl(href ?? '', origin);
    if (url && !seenUrls.has(url)) {
      const description = getContainerDescription($heading, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) {
        seenUrls.add(url);
      }
    }
  });

  $('h2, h3').each((_i: number, _el: AnyNode) => {
    if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
    const $heading = $(_el);
    const title = cleanTitle($heading.text());

    if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
    if (isSkipText(title)) return;
    if (seenTitles.has(normalizeTitle(title))) return;

    const innerLink = $heading.find('a').attr('href');
    if (innerLink) return;

    const parentLink = $heading.closest('a').attr('href');
    if (parentLink) {
      const url = normalizeUrl(parentLink, origin);
      if (url && !seenUrls.has(url)) {
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
      }
      return;
    }

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
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
      }
      return;
    }

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
        const description = getContainerDescription($heading, title);
        if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
      }
    }
  });

  if (headlines.length < MAX_HEADLINES_PER_SITE) {
    $('a[href]').each((_i: number, _el: AnyNode) => {
      if (headlines.length >= MAX_HEADLINES_PER_SITE) return;
      const $el = $(_el);
      const title = cleanTitle($el.text());
      const href = $el.attr('href') ?? '';

      if (!title || title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) return;
      if (isSkipText(title)) return;

      const url = normalizeUrl(href, origin);
      if (!url || seenUrls.has(url)) return;
      if (!isArticleUrl(url, origin)) return;

      const description = getContainerDescription($el, title);
      if (addHeadline(headlines, seenTitles, title, url, { ...options, description })) seenUrls.add(url);
    });
  }

  appLogger.info({ siteUrl, headlinesFound: headlines.length }, 'News site parsed (HTML)');
  return headlines.slice(0, MAX_HEADLINES_PER_SITE);
}
