import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { settingsRepo, analyticsRepo } from '../../db/index.js';
import { aiLogger } from '../../config/logger.js';
import { config } from '../../config/index.js';
import { LEADS_COMMENT_MAX_LENGTH } from '../../config/constants.js';
import {
  assertNewsSiteUrlIsSafe,
  getConfiguredSites,
  saveConfiguredSites,
  parseNewsFromSite,
  parseAllConfiguredSites,
  countMergedDuplicates,
  groupHeadlinesByCategory,
  getPresetSources,
  getPresetSourceCounts,
  mergeNewsSites,
  normalizeNewsSite,
  setNewsParsingKilled,
  isNewsParsingKilled,
  type NewsPresetGroup,
} from '../../features/news-parser.js';
import { localizeParsedHeadlines } from '../../features/news-localization.js';
import { aiService } from '../../ai/openrouter.js';
import { buildDigest } from '../../features/digest-scheduler.js';
import { buildHybridDigest, PreparedDigestUnavailableError } from '../../features/digest-hybrid.js';
import { markdownToTelegramHtml } from '../../telegram/format.js';
import { escapeHtmlSimple } from './middleware.js';
import type { DigestPipelineMode, NewsSite } from '../../../../shared/types/index.js';

const leadSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
  email: z.string().email().optional().or(z.literal('')),
  tariff: z.string().max(200).optional(),
  comment: z.string().max(LEADS_COMMENT_MAX_LENGTH).optional(),
  source: z.string().max(200).optional(),
});

export async function registerNewsRoutes(server: FastifyInstance): Promise<void> {
  // ====== NEWS SOURCES ======

  /**
   * GET /api/news-sites
   */
  server.get('/news-sites', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const sites = await getConfiguredSites();
      return reply.code(200).send({ success: true, data: sites });
    } catch (error) {
      aiLogger.error({ error }, 'Get news sites error');
      return reply.code(500).send({ success: false, error: 'Failed to fetch news sites' });
    }
  });

  /**
   * POST /api/news-sites
   */
  server.post(
    '/news-sites',
    async (
      request: FastifyRequest<{ Body: NewsSite[] }>,
      reply: FastifyReply,
    ) => {
      try {
        const sites = request.body;
        if (!Array.isArray(sites)) {
          return reply.code(400).send({ success: false, error: 'Body must be an array of sites' });
        }

        const normalized = sites.map(site => normalizeNewsSite(site));
        await Promise.all(normalized.map((site) => assertNewsSiteUrlIsSafe(site.url)));
        await saveConfiguredSites(normalized);
        settingsRepo.invalidateCache?.();

        aiLogger.info({ count: normalized.length }, 'News sites updated');
        return reply.code(200).send({ success: true, message: 'News sites saved', data: normalized });
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send({ success: false, error: error.message });
        }
        aiLogger.error({ error }, 'Save news sites error');
        return reply.code(500).send({ success: false, error: 'Failed to save news sites' });
      }
    },
  );

  /**
   * POST /api/news-sites/test
   */
  server.post(
    '/news-sites/test',
    async (
      request: FastifyRequest<{ Body: Partial<NewsSite> & { url?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const payload = request.body as Partial<NewsSite> & { url?: string };
        if (!payload?.url) {
          return reply.code(400).send({ success: false, error: 'URL is required' });
        }

        const testSite = normalizeNewsSite({
          name: payload.name?.trim() || 'Test source',
          url: payload.url,
          enabled: payload.enabled !== false,
          type: payload.type,
          category: payload.category,
          language: payload.language,
          tier: payload.tier,
          jsonMapping: payload.jsonMapping,
          htmlMapping: payload.htmlMapping,
          filterKeywords: payload.filterKeywords,
          autoMode: payload.autoMode,
        });
        await assertNewsSiteUrlIsSafe(testSite.url);

        const startTime = Date.now();
        const rawHeadlines = await parseNewsFromSite(testSite);
        const headlines = await localizeParsedHeadlines(rawHeadlines);
        const parseTimeMs = Date.now() - startTime;

        aiLogger.info({ url: testSite.url, headlinesFound: headlines.length, parseTimeMs }, 'News site test parse');

        return reply.code(200).send({
          success: true,
          data: {
            url: testSite.url,
            headlines,
            count: headlines.length,
            parseTimeMs,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.warn({ error: msg, url: (request.body as { url?: string })?.url }, 'News site test parse failed');
        return reply.code(200).send({
          success: false,
          error: msg,
          data: { url: (request.body as { url?: string })?.url, headlines: [], count: 0 },
        });
      }
    },
  );

  /**
   * GET /api/news-sites/presets
   */
  server.get('/news-sites/presets', async (_request: FastifyRequest, reply: FastifyReply) => {
    const counts = getPresetSourceCounts();
    return reply.code(200).send({
      success: true,
      data: {
        all: getPresetSources('all'),
        global: getPresetSources('global'),
        asia: getPresetSources('asia'),
      },
      count: counts.all,
      counts,
    });
  });

  /**
   * POST /api/news-sites/add-presets
   */
  server.post('/news-sites/add-presets', async (
    request: FastifyRequest<{ Body: { group?: NewsPresetGroup } }>,
    reply: FastifyReply,
  ) => {
    try {
      const requestedGroup = request.body?.group;
      const group: NewsPresetGroup =
        requestedGroup === 'asia' || requestedGroup === 'global' ? requestedGroup : 'all';
      const existing = await getConfiguredSites();
      const existingUrls = new Set(existing.map(site => site.url.trim().replace(/\/+$/, '').toLowerCase()));
      const presetSites = getPresetSources(group);
      const newSites = presetSites.filter(site => !existingUrls.has(site.url.trim().replace(/\/+$/, '').toLowerCase()));
      const merged = mergeNewsSites(existing, presetSites);

      await saveConfiguredSites(merged);
      settingsRepo.invalidateCache?.();

      aiLogger.info({ added: newSites.length, total: merged.length, group }, 'Preset news sources added');
      return reply.code(200).send({
        success: true,
        message: `Добавлено ${newSites.length} новых источников`,
        data: { added: newSites.length, total: merged.length, sites: merged, group },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Add preset sources error');
      return reply.code(500).send({ success: false, error: 'Failed to add preset sources' });
    }
  });

  /**
   * POST /api/news-sites/suggest-keywords
   * LLM-подбор ключевых слов для источника (Google AdWords-стиль)
   */
  server.post(
    '/news-sites/suggest-keywords',
    async (
      request: FastifyRequest<{ Body: { url: string; name: string; category?: string; language?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const suggestSchema = z.object({
          url: z.string().url(),
          name: z.string().min(1).max(500),
          category: z.string().max(50).optional(),
          language: z.string().max(10).optional(),
        });

        const parsed = suggestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' });
        }

        const { url, name, category, language } = parsed.data;

        const prompt = [
          'Ты — SEO-эксперт и специалист по AI/tech новостям.',
          `Источник: "${name || url}" (${url})`,
          category ? `Категория: ${category}` : '',
          language ? `Язык контента: ${language}` : '',
          '',
          'Подбери 10-15 ключевых слов для фильтрации релевантных новостей об AI-программировании, вайбкодинге и AI-инструментах разработки.',
          'Ключевые слова должны помочь отсеять нерелевантный контент и оставить только статьи про:',
          '- Вайбкодинг, AI-assisted coding, AI IDE',
          '- Конкретные инструменты: Cursor, Copilot, Claude Code, Windsurf, Bolt, v0, Replit',
          '- LLM для кода: CodeLlama, DeepSeek Coder, Qwen Coder, StarCoder',
          '- AI code generation, code completion, AI pair programming',
          '',
          'Верни ТОЛЬКО JSON массив строк, без пояснений:',
          '["keyword1", "keyword2", ...]',
        ].filter(Boolean).join('\n');

        const result = await aiService.chat(prompt, {
          temperature: 0.3,
          maxTokens: 500,
          priority: 'background',
        });

        const cleaned = result.content.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const keywords: string[] = JSON.parse(cleaned);

        if (!Array.isArray(keywords) || keywords.length === 0) {
          return reply.code(200).send({ success: false, error: 'LLM вернула пустой результат' });
        }

        return reply.code(200).send({
          success: true,
          data: { keywords: keywords.map(k => String(k).trim()).filter(Boolean) },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        aiLogger.warn({ error: msg }, 'Keyword suggestion failed');
        return reply.code(200).send({ success: false, error: msg });
      }
    },
  );

  /**
   * POST /api/news-sites/bulk-enable
   * Массовое включение/выключение источников по tier и/или category
   */
  server.post(
    '/news-sites/bulk-enable',
    async (
      request: FastifyRequest<{ Body: { tier?: string; category?: string; enabled: boolean } }>,
      reply: FastifyReply,
    ) => {
      try {
        const bulkSchema = z.object({
          tier: z.enum(['tier1', 'tier2', 'tier3']).optional(),
          category: z.enum(['ai_tech', 'city_local', 'community', 'asia_tech']).optional(),
          enabled: z.boolean(),
        });

        const parsed = bulkSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' });
        }

        const { tier, category, enabled } = parsed.data;
        const sites = await getConfiguredSites();
        let affected = 0;

        const updated = sites.map(site => {
          const matchTier = !tier || site.tier === tier;
          const matchCategory = !category || site.category === category;
          if (matchTier && matchCategory && site.enabled !== enabled) {
            affected++;
            return { ...site, enabled };
          }
          return site;
        });

        await saveConfiguredSites(updated);
        settingsRepo.invalidateCache?.();

        aiLogger.info({ tier, category, enabled, affected, total: updated.length }, 'Bulk enable/disable news sites');
        return reply.code(200).send({
          success: true,
          message: `${enabled ? 'Включено' : 'Выключено'} ${affected} источников`,
          data: { affected, total: updated.length },
        });
      } catch (error) {
        aiLogger.error({ error }, 'Bulk enable error');
        return reply.code(500).send({ success: false, error: 'Failed to bulk enable' });
      }
    },
  );

  // ====== NEWS PARSING KILL SWITCH ======

  server.get('/news/parsing-status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ success: true, killed: isNewsParsingKilled() });
  });

  server.post('/news/parsing-kill', async (_request: FastifyRequest, reply: FastifyReply) => {
    setNewsParsingKilled(true);
    return reply.code(200).send({ success: true, killed: true, message: 'News parsing stopped' });
  });

  server.post('/news/parsing-resume', async (_request: FastifyRequest, reply: FastifyReply) => {
    setNewsParsingKilled(false);
    return reply.code(200).send({ success: true, killed: false, message: 'News parsing resumed' });
  });

  // ====== HEALTH CHECK & MAINTENANCE ======

  /**
   * POST /api/news-sites/health-check
   * Проверяет доступность всех включённых источников
   */
  server.post(
    '/news-sites/health-check',
    async (
      request: FastifyRequest<{ Body: { timeout?: number } }>,
      reply: FastifyReply,
    ) => {
      try {
        const timeout = Math.min(request.body?.timeout ?? 8000, 15000);
        const sites = await getConfiguredSites();
        const enabledSites = sites.filter(s => s.enabled);

        const CONCURRENCY = 6;
        const statuses: Array<{
          url: string;
          name: string;
          status: 'ok' | 'timeout' | 'error' | 'redirect';
          httpCode?: number;
          responseTimeMs: number;
          error?: string;
        }> = [];

        for (let i = 0; i < enabledSites.length; i += CONCURRENCY) {
          const batch = enabledSites.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (site) => {
              const start = Date.now();
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeout);
              try {
                const res = await fetch(site.url, {
                  signal: controller.signal,
                  headers: { 'User-Agent': 'Amina-Bot/1.0 NewsParser' },
                  redirect: 'follow',
                });
                clearTimeout(timer);
                return {
                  url: site.url,
                  name: site.name,
                  status: (res.ok ? 'ok' : 'error') as const,
                  httpCode: res.status,
                  responseTimeMs: Date.now() - start,
                };
              } catch (err) {
                clearTimeout(timer);
                const isTimeout = (err as { name?: string }).name === 'AbortError';
                return {
                  url: site.url,
                  name: site.name,
                  status: (isTimeout ? 'timeout' : 'error') as const,
                  responseTimeMs: Date.now() - start,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );

          for (const result of results) {
            if (result.status === 'fulfilled') {
              statuses.push(result.value);
            }
          }
        }

        const healthy = statuses.filter(s => s.status === 'ok').length;
        const unhealthy = statuses.filter(s => s.status !== 'ok').length;

        return reply.code(200).send({
          success: true,
          timestamp: new Date().toISOString(),
          totalChecked: statuses.length,
          healthy,
          unhealthy,
          statuses: statuses.sort((a, b) => {
            if (a.status === 'ok' && b.status !== 'ok') return 1;
            if (a.status !== 'ok' && b.status === 'ok') return -1;
            return a.responseTimeMs - b.responseTimeMs;
          }),
        });
      } catch (error) {
        aiLogger.error({ error }, 'Health check error');
        return reply.code(500).send({ success: false, error: 'Health check failed' });
      }
    },
  );

  /**
   * POST /api/news-sites/cleanup-dead
   * Выключает недоступные источники (dry-run по умолчанию)
   */
  server.post(
    '/news-sites/cleanup-dead',
    async (
      request: FastifyRequest<{ Body: { dryRun?: boolean; timeout?: number } }>,
      reply: FastifyReply,
    ) => {
      try {
        const dryRun = request.body?.dryRun !== false;
        const timeout = Math.min(request.body?.timeout ?? 8000, 15000);
        const sites = await getConfiguredSites();
        const enabledSites = sites.filter(s => s.enabled);

        const deadSites: Array<{ url: string; name: string; reason: string }> = [];

        const CONCURRENCY = 6;
        for (let i = 0; i < enabledSites.length; i += CONCURRENCY) {
          const batch = enabledSites.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (site) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeout);
              try {
                const res = await fetch(site.url, {
                  signal: controller.signal,
                  headers: { 'User-Agent': 'Amina-Bot/1.0 NewsParser' },
                  redirect: 'follow',
                });
                clearTimeout(timer);
                if (!res.ok) {
                  return { url: site.url, name: site.name, reason: `HTTP ${res.status} ${res.statusText}` };
                }
                return null;
              } catch (err) {
                clearTimeout(timer);
                const isTimeout = (err as { name?: string }).name === 'AbortError';
                return {
                  url: site.url,
                  name: site.name,
                  reason: isTimeout ? `Timeout (${timeout}ms)` : (err instanceof Error ? err.message : String(err)),
                };
              }
            }),
          );

          for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
              deadSites.push(result.value);
            }
          }
        }

        if (!dryRun && deadSites.length > 0) {
          const deadUrls = new Set(deadSites.map(d => d.url));
          const updated = sites.map(site =>
            deadUrls.has(site.url) ? { ...site, enabled: false } : site,
          );
          await saveConfiguredSites(updated);
          settingsRepo.invalidateCache?.();
        }

        aiLogger.info({ dead: deadSites.length, dryRun }, 'News sites cleanup');
        return reply.code(200).send({
          success: true,
          dryRun,
          deadCount: deadSites.length,
          totalChecked: enabledSites.length,
          dead: deadSites,
        });
      } catch (error) {
        aiLogger.error({ error }, 'Cleanup dead sources error');
        return reply.code(500).send({ success: false, error: 'Cleanup failed' });
      }
    },
  );

  // ====== PUBLIC DIGEST & RAW NEWS ======

  /**
   * GET /api/debug/raw-news
   */
  server.get('/debug/raw-news', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const headlines = await parseAllConfiguredSites();
      const sections = groupHeadlinesByCategory(headlines);
      return reply.code(200).send({
        success: true,
        data: {
          total: headlines.length,
          byCategory: {
            ai_tech: sections.ai_tech.length,
            asia_tech: sections.asia_tech.length,
            community: sections.community.length,
            city_local: sections.city_local.length,
            uncategorized: sections.uncategorized.length,
          },
          mergedDuplicates: countMergedDuplicates(headlines),
          sections,
          headlines,
        },
      });
    } catch (error) {
      aiLogger.error({ error }, 'Raw news API error');
      return reply.code(500).send({ success: false, error: 'Failed to parse news' });
    }
  });

  /**
   * GET /api/digest/latest
   */
  server.get(
    '/digest/latest',
    async (
      request: FastifyRequest<{
        Querystring: { city?: string; firstName?: string; format?: string; pipeline?: string; refresh?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { city = '', firstName = 'Читатель', format = 'html', pipeline = 'hybrid', refresh = '0' } = request.query as {
        city?: string;
        firstName?: string;
        format?: string;
        pipeline?: string;
        refresh?: string;
      };
      try {
        const selectedPipeline: DigestPipelineMode =
          pipeline === 'hybrid' || pipeline === 'hybrid_appwrite'
            ? 'hybrid_appwrite'
            : 'legacy';
        const forceRefresh = refresh === '1' || refresh.toLowerCase() === 'true';

        let hybridResult = null;
        if (selectedPipeline === 'hybrid_appwrite') {
          hybridResult = await buildHybridDigest('public', firstName, city, {
            forceRefresh,
            searchMode: 'skip',
          });
        }
        const legacyDigestText = selectedPipeline === 'legacy'
          ? await buildDigest('public', firstName, city)
          : null;
        const digestText = hybridResult?.digestText ?? legacyDigestText ?? '';

        if (format === 'json') {
          const legacyHeadlines = selectedPipeline === 'legacy'
            ? await parseAllConfiguredSites()
            : [];
          const legacySections = selectedPipeline === 'legacy'
            ? groupHeadlinesByCategory(legacyHeadlines)
            : null;

          return reply.code(200).send({
            success: true,
            data: {
              content: digestText,
              format: 'markdown',
              city,
              firstName,
              pipeline: selectedPipeline,
              generatedAt: hybridResult?.payload.generated_at ?? new Date().toISOString(),
              digestDate: hybridResult?.payload.digest_date ?? new Date().toISOString().slice(0, 10),
              news: hybridResult
                ? {
                  mode: 'parser_only',
                  counts: hybridResult.payload.counts,
                  sections: hybridResult.payload.sections,
                  mergedDuplicates: hybridResult.payload.counts.merged_duplicates,
                }
                : {
                  mode: 'parser_only',
                  counts: {
                    total: legacyHeadlines.length,
                    ai: legacySections?.ai_tech.length ?? 0,
                    community: legacySections?.community.length ?? 0,
                    asia: legacySections?.asia_tech.length ?? 0,
                    local: legacySections?.city_local.length ?? 0,
                    uncategorized: legacySections?.uncategorized.length ?? 0,
                    merged_duplicates: countMergedDuplicates(legacyHeadlines),
                  },
                  sections: legacySections,
                  mergedDuplicates: countMergedDuplicates(legacyHeadlines),
                },
              weather: hybridResult?.payload.weather ?? null,
            },
          });
        }

        const htmlBody = markdownToTelegramHtml(digestText).replace(/\n/g, '<br>\n');
        const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Дайджест Амины — ${escapeHtmlSimple(city)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; margin: 20px; max-width: 800px; margin-left: auto; margin-right: auto; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2 { margin-top: 1.5em; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 1em; }
  </style>
</head>
<body>
  <div class="meta">Дайджест Амины · ${escapeHtmlSimple(city)} · ${selectedPipeline} · ${new Date().toLocaleDateString('ru-RU')}</div>
  <div>${htmlBody}</div>
</body>
</html>`;

        return reply.type('text/html').code(200).send(html);
      } catch (error) {
        if (error instanceof PreparedDigestUnavailableError) {
          aiLogger.warn({ error, city, format, pipeline }, 'Digest API: prepared cache is not available yet');
          if (format === 'json') {
            return reply.code(503).send({
              success: false,
              error: 'Digest is not prepared yet',
              code: 'DIGEST_NOT_PREPARED',
              data: {
                city,
                firstName,
                pipeline: pipeline === 'legacy' ? 'legacy' : 'hybrid_appwrite',
              },
            });
          }

          return reply
            .type('text/html')
            .code(503)
            .send('<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Дайджест готовится</title></head><body><p>Дайджест ещё подготавливается. Повтори запрос чуть позже.</p></body></html>');
        }

        aiLogger.error({ error }, 'Digest API error');
        return reply.code(500).send({ success: false, error: 'Failed to build digest' });
      }
    },
  );

  // ====== LEADS ======

  /**
   * POST /api/leads
   */
  server.post(
    '/leads',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = leadSchema.parse(request.body);

        const adminChatId = await settingsRepo.get('admin_chat_id');
        if (!adminChatId) {
          aiLogger.warn('Lead received but admin_chat_id not configured');
          return reply.code(200).send({
            success: true,
            warning: 'Lead accepted but admin notification not configured',
          });
        }

        const now = new Date().toLocaleString('ru-RU', { timeZone: config.server.timeZone });
        const lines = [
          '📩 <b>Новая заявка!</b>',
          '',
          `👤 <b>Имя:</b> ${escapeHtmlSimple(body.name)}`,
          `📞 <b>Телефон:</b> ${escapeHtmlSimple(body.phone)}`,
        ];
        if (body.email) lines.push(`✉️ <b>Email:</b> ${escapeHtmlSimple(body.email)}`);
        if (body.tariff) lines.push(`📦 <b>Тариф:</b> ${escapeHtmlSimple(body.tariff)}`);
        if (body.comment) lines.push(`💬 <b>Комментарий:</b> ${escapeHtmlSimple(body.comment)}`);
        if (body.source) lines.push(`🌐 <b>Источник:</b> ${escapeHtmlSimple(body.source)}`);
        lines.push(`🕐 ${now}`);

        const text = lines.join('\n');

        const token = config.telegram.token;
        const tgResponse = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: adminChatId,
              text,
              parse_mode: 'HTML',
            }),
          },
        );

        if (!tgResponse.ok) {
          const errBody = await tgResponse.text();
          aiLogger.error({ status: tgResponse.status, body: errBody }, 'Failed to send lead to Telegram');
          return reply.code(200).send({
            success: true,
            warning: 'Lead accepted but Telegram notification failed',
          });
        }

        aiLogger.info({ source: body.source, name: body.name }, '📩 Lead sent to admin');

        // Log to analytics (fire-and-forget)
        const { analyticsRepo: ar } = await import('../../db/index.js');
        ar.log('message_received', 'telegram', {
          event: 'lead_received',
          source: body.source,
          name: body.name,
          phone: body.phone,
        }).catch(() => {});

        return reply.code(200).send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid lead data',
            details: error.errors,
          });
        }
        aiLogger.error({ error }, 'Lead endpoint error');
        return reply.code(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    },
  );
}
