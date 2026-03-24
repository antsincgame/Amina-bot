/**
 * Vibecoding News Relevance Filter — Strict Mode
 *
 * Трёхуровневая фильтрация + ранжирование:
 * 1. Быстрый keyword-scoring по title + description + articleExcerpt
 * 2. LLM-классификация ambiguous headlines с excerpt контекстом
 * 3. Ранжирование по score + лимит 20 новостей
 */

import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
import type { ParsedHeadline, NewsSourceTier } from '../../../shared/types/index.js';

const LLM_BATCH_SIZE = 10;
const LLM_MAX_TOKENS = 800;
const MAX_DIGEST_HEADLINES = 20;
const LLM_EXCERPT_LIMIT = 400;

const POSITIVE_KEYWORDS: readonly string[] = [
  'vibe coding', 'vibe-coding', 'vibecoding',
  'вайбкодинг', 'вайб кодинг', 'вайб-кодинг',
  'нейрокодинг', 'нейро кодинг', 'нейро-кодинг',
  'ии-разработка', 'ии разработка',
  'cursor ide', 'cursor ai', 'cursor editor',
  'windsurf', 'codeium',
  'copilot', 'github copilot',
  'claude code', 'claude dev',
  'aider', 'continue.dev',
  'bolt.new', 'v0.dev', 'v0 dev',
  'replit agent', 'replit ai',
  'devin', 'cognition ai',
  'sourcegraph cody', 'cody ai',
  'amazon q developer', 'amazon q',
  'gemini code assist',
  'tabnine', 'tab nine',
  'supermaven',
  'sweep ai', 'sweep.ai',
  'ai coding', 'ai-coding',
  'ai-assisted coding', 'ai assisted coding',
  'ai-assisted development', 'ai assisted development',
  'code generation', 'code completion',
  'ai pair programming', 'ai pair-programming',
  'llm coding', 'llm-coding',
  'no-code ai', 'low-code ai',
  'prompt-to-code', 'prompt to code',
  'natural language programming',
  'coding assistant', 'code assistant',
  'ai code review', 'ai code',
  'ai developer tool', 'ai dev tool',
  'ai ide', 'ai editor',
  'code generation model',
  'codex', 'starcoder', 'codellama', 'code llama',
  'deepseek coder', 'qwen coder',
] as const;

const NEGATIVE_KEYWORDS: readonly string[] = [
  'layoffs', 'layoff', 'уволен', 'увольнен',
  'funding round', 'acquisition', 'приобретен',
  'ipo', 'stock price', 'акции', 'инвестиц', 'сделк',
  'merger', 'lawsuit', 'иск', 'штраф',
  'regulation', 'регуляц', 'ethics debate',
  'bias', 'deepfake', 'surveillance', 'слежк',
  'copyright', 'авторск', 'ban', 'запрет',
  'safety concern', 'dangerous',
  'городск', 'муниципал', 'мэр ', 'администрац',
  'транспорт', 'дорож', 'благоустройств',
  'жкх', 'коммунальн',
] as const;

const TITLE_DESCRIPTION_POSITIVE_SCORE = 10;
const EXCERPT_POSITIVE_SCORE = 5;
const NEGATIVE_SCORE = -20;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const POSITIVE_REGEX = new RegExp(
  POSITIVE_KEYWORDS.map(escapeRegex).join('|'),
  'gi',
);

const NEGATIVE_REGEX = new RegExp(
  NEGATIVE_KEYWORDS.map(escapeRegex).join('|'),
  'gi',
);

interface ScoredHeadline {
  headline: ParsedHeadline;
  score: number;
}

export function scoreHeadlineRelevance(headline: ParsedHeadline): number {
  const titleDesc = `${headline.title} ${headline.description}`.toLowerCase();
  const excerpt = (headline.articleExcerpt ?? '').toLowerCase();
  let score = 0;

  POSITIVE_REGEX.lastIndex = 0;
  const titleDescPositiveMatches = titleDesc.match(POSITIVE_REGEX);
  if (titleDescPositiveMatches) {
    score += titleDescPositiveMatches.length * TITLE_DESCRIPTION_POSITIVE_SCORE;
  } else if (excerpt) {
    POSITIVE_REGEX.lastIndex = 0;
    const excerptPositiveMatches = excerpt.match(POSITIVE_REGEX);
    if (excerptPositiveMatches) {
      score += excerptPositiveMatches.length * EXCERPT_POSITIVE_SCORE;
    }
  }

  NEGATIVE_REGEX.lastIndex = 0;
  const allText = `${titleDesc} ${excerpt}`;
  const negativeMatches = allText.match(NEGATIVE_REGEX);
  if (negativeMatches) {
    score += negativeMatches.length * NEGATIVE_SCORE;
  }

  return score;
}

function buildClassificationPrompt(
  headlines: Array<{ index: number; title: string; description: string; excerpt: string }>,
): string {
  const lines = headlines
    .map(h => {
      const excerptPart = h.excerpt ? `\n   Excerpt: ${h.excerpt}` : '';
      return `${h.index}. ${h.title}${h.description ? ` — ${h.description}` : ''}${excerptPart}`;
    })
    .join('\n');

  return `Classify each headline. Is it **specifically** about:
- Vibecoding (AI-assisted code writing)
- AI coding tools (Cursor, Copilot, Claude Code, etc.)
- AI code generation breakthroughs
- Developer productivity with AI coding assistants

General AI news, business news, regulation, funding — answer false.
Only AI + coding/development specifically — answer true.

Answer JSON only: {"<number>": true/false, ...}

${lines}`;
}

async function classifyAmbiguousBatch(
  headlines: Array<{ index: number; headline: ParsedHeadline }>,
): Promise<Set<number>> {
  const keepIndices = new Set<number>();

  const prompt = buildClassificationPrompt(
    headlines.map(h => ({
      index: h.index,
      title: h.headline.title,
      description: h.headline.description,
      excerpt: (h.headline.articleExcerpt ?? '').slice(0, LLM_EXCERPT_LIMIT),
    })),
  );

  try {
    const response = await aiService.chat(
      [
        {
          role: 'system',
          content: 'You are a strict vibecoding news curator. Only approve headlines that are SPECIFICALLY about AI-assisted software development, AI coding tools, or AI code generation breakthroughs. General AI news, business, regulation = false. Answer JSON only: {"1": true, "5": false, ...}',
        },
        { role: 'user', content: prompt },
      ],
      'telegram',
      undefined,
      {
        promptMode: 'passthrough',
        maxTokens: LLM_MAX_TOKENS,
        temperature: 0,
        priority: 'background',
      },
    );

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appLogger.info('Vibecoding filter: LLM response contains no JSON, dropping all ambiguous headlines (fail-closed)');
      return keepIndices;
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, boolean>;

    for (const h of headlines) {
      const key = String(h.index);
      if (parsed[key] === true) {
        keepIndices.add(h.index);
      }
    }
  } catch (err) {
    appLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Vibecoding filter: LLM classification failed, dropping all ambiguous headlines (fail-closed)',
    );
  }

  return keepIndices;
}

const TIER_PRIORITY: Record<NewsSourceTier, number> = {
  tier1: 3,
  tier2: 2,
  tier3: 1,
};

export function rankAndLimitHeadlines(headlines: ScoredHeadline[], limit: number = MAX_DIGEST_HEADLINES): ParsedHeadline[] {
  return headlines
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const tierA = TIER_PRIORITY[a.headline.sourceTier ?? 'tier3'];
      const tierB = TIER_PRIORITY[b.headline.sourceTier ?? 'tier3'];
      return tierB - tierA;
    })
    .slice(0, limit)
    .map(item => item.headline);
}

export async function filterHeadlinesForVibecoding(headlines: ParsedHeadline[]): Promise<ParsedHeadline[]> {
  const scored: ScoredHeadline[] = [];
  const ambiguous: Array<{ index: number; headline: ParsedHeadline }> = [];
  let droppedCount = 0;

  for (let i = 0; i < headlines.length; i++) {
    const headline = headlines[i]!;
    const score = scoreHeadlineRelevance(headline);

    if (score > 0) {
      scored.push({ headline, score });
    } else if (score < 0) {
      droppedCount++;
    } else {
      if (!headline.articleExcerpt) {
        droppedCount++;
        continue;
      }
      ambiguous.push({ index: i, headline });
    }
  }

  if (ambiguous.length > 0) {
    appLogger.info(
      { ambiguous: ambiguous.length, batches: Math.ceil(ambiguous.length / LLM_BATCH_SIZE) },
      'Vibecoding filter: classifying ambiguous headlines with LLM (strict mode)',
    );

    for (let i = 0; i < ambiguous.length; i += LLM_BATCH_SIZE) {
      const batch = ambiguous.slice(i, i + LLM_BATCH_SIZE);
      const keepSet = await classifyAmbiguousBatch(batch);

      for (const item of batch) {
        if (keepSet.has(item.index)) {
          scored.push({ headline: item.headline, score: 1 });
        } else {
          droppedCount++;
        }
      }
    }
  }

  const result = rankAndLimitHeadlines(scored, MAX_DIGEST_HEADLINES);

  appLogger.info(
    {
      total: headlines.length,
      scoredPositive: scored.length,
      dropped: droppedCount,
      ambiguousClassified: ambiguous.length,
      finalCount: result.length,
      limit: MAX_DIGEST_HEADLINES,
    },
    'Vibecoding filter complete (strict mode)',
  );

  return result;
}
