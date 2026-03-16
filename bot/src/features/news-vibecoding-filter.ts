/**
 * Vibecoding News Relevance Filter
 *
 * Двухуровневая фильтрация новостных заголовков:
 * 1. Быстрый keyword-scoring (бесплатно, мгновенно)
 * 2. LLM-классификация неоднозначных заголовков (батчами по 20)
 */

import { aiService } from '../ai/openrouter.js';
import { appLogger } from '../config/logger.js';
import type { ParsedHeadline } from '../../../shared/types/index.js';

const LLM_BATCH_SIZE = 20;
const LLM_MAX_TOKENS = 512;

const POSITIVE_KEYWORDS: readonly string[] = [
  'vibe coding', 'vibecoding', 'вайбкодинг',
  'cursor', 'windsurf', 'bolt.new', 'lovable', 'v0',
  'replit agent', 'claude code', 'github copilot',
  'ai coding', 'ai-generated', 'no-code ai', 'built with ai',
  'ai agent', 'mcp', 'model context protocol',
  'prompt engineering', 'ai pair programming',
  'shipped in hours', 'built overnight', 'ai-assisted',
  'coding assistant', 'нейрокодинг', 'ии-разработка',
  'ai ide', 'cline', 'aider', 'continue.dev',
  'devin', 'opendevin', 'sweep ai',
  'tabnine', 'codeium', 'supermaven', 'llm coding',
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
] as const;

const POSITIVE_SCORE = 10;
const NEGATIVE_SCORE = -20;

export function scoreHeadlineRelevance(headline: ParsedHeadline): number {
  const text = `${headline.title} ${headline.description}`.toLowerCase();
  let score = 0;

  for (const keyword of POSITIVE_KEYWORDS) {
    if (text.includes(keyword)) {
      score += POSITIVE_SCORE;
    }
  }

  for (const keyword of NEGATIVE_KEYWORDS) {
    if (text.includes(keyword)) {
      score += NEGATIVE_SCORE;
    }
  }

  return score;
}

function buildClassificationPrompt(headlines: Array<{ index: number; title: string; description: string }>): string {
  const lines = headlines
    .map(h => `${h.index}. ${h.title}${h.description ? ` — ${h.description}` : ''}`)
    .join('\n');

  return `Classify each headline. Is it relevant to: AI-assisted software development, apps built with AI coding tools, AI coding breakthroughs, developer productivity with AI?
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
    })),
  );

  try {
    const response = await aiService.chat(
      [
        {
          role: 'system',
          content: 'You are a vibecoding news curator. For each headline, decide if it\'s relevant to: AI-assisted software development, apps built with AI coding tools, AI coding breakthroughs, developer productivity with AI. Answer JSON only: {"1": true, "5": false, ...}',
        },
        { role: 'user', content: prompt },
      ],
      'telegram',
      undefined,
      {
        promptMode: 'passthrough',
        maxTokens: LLM_MAX_TOKENS,
        temperature: 0,
      },
    );

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appLogger.warn('Vibecoding filter: LLM response contains no JSON, keeping all ambiguous headlines');
      for (const h of headlines) keepIndices.add(h.index);
      return keepIndices;
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, boolean>;

    for (const h of headlines) {
      const key = String(h.index);
      const verdict = parsed[key];
      if (verdict === true || verdict === undefined) {
        keepIndices.add(h.index);
      }
    }
  } catch (err) {
    appLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Vibecoding filter: LLM classification failed, keeping all ambiguous headlines (fail-open)',
    );
    for (const h of headlines) keepIndices.add(h.index);
  }

  return keepIndices;
}

export async function filterHeadlinesForVibecoding(headlines: ParsedHeadline[]): Promise<ParsedHeadline[]> {
  const kept: ParsedHeadline[] = [];
  const ambiguous: Array<{ index: number; headline: ParsedHeadline }> = [];
  let droppedCount = 0;

  for (let i = 0; i < headlines.length; i++) {
    const headline = headlines[i]!;
    const score = scoreHeadlineRelevance(headline);

    if (score > 0) {
      kept.push(headline);
    } else if (score < 0) {
      droppedCount++;
    } else {
      ambiguous.push({ index: i, headline });
    }
  }

  if (ambiguous.length > 0) {
    appLogger.info(
      { ambiguous: ambiguous.length, batches: Math.ceil(ambiguous.length / LLM_BATCH_SIZE) },
      'Vibecoding filter: classifying ambiguous headlines with LLM',
    );

    for (let i = 0; i < ambiguous.length; i += LLM_BATCH_SIZE) {
      const batch = ambiguous.slice(i, i + LLM_BATCH_SIZE);
      const keepSet = await classifyAmbiguousBatch(batch);

      for (const item of batch) {
        if (keepSet.has(item.index)) {
          kept.push(item.headline);
        } else {
          droppedCount++;
        }
      }
    }
  }

  appLogger.info(
    {
      total: headlines.length,
      kept: kept.length,
      dropped: droppedCount,
      ambiguousClassified: ambiguous.length,
    },
    'Vibecoding filter complete',
  );

  return kept;
}
