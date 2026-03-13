import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedHeadline } from '../../../shared/types/index.js';

vi.mock('../config/logger.js', () => ({
  appLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  enrichParsedHeadlineDescriptions,
  isWeakHeadlineDescription,
} from './news-description-enrichment.js';

function buildHeadline(overrides: Partial<ParsedHeadline> = {}): ParsedHeadline {
  return {
    title: 'Ulysses Sequence Parallelism: Training with Million-Token Contexts',
    url: 'https://huggingface.co/blog/ulysses-sp',
    canonicalUrl: 'https://huggingface.co/blog/ulysses-sp',
    source: 'Hugging Face Blog',
    sourceDomain: 'huggingface.co',
    description: 'Hugging Face Blog: материал о новых AI-инструментах, моделях или продуктах для разработки.',
    fingerprint: 'hf-ulysses',
    alternateSources: [],
    category: 'ai_tech',
    language: 'en',
    ...overrides,
  };
}

describe('news-description-enrichment', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('считает category fallback слабым description', () => {
    expect(isWeakHeadlineDescription(buildHeadline())).toBe(true);
  });

  it('дотягивает содержательное описание со страницы статьи вместо общего шаблона', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null),
      },
      text: async () => `
        <html>
          <head>
            <meta name="description" content="We’re on a journey to advance and democratize artificial intelligence through open source and open science." />
            <meta property="og:description" content="We’re on a journey to advance and democratize artificial intelligence through open source and open science." />
          </head>
          <body>
            <main>
              <article>
                <p>Ulysses Sequence Parallelism provides an elegant way to distribute attention computation across multiple GPUs and makes million-token context training practical inside the Hugging Face ecosystem.</p>
                <p>This post explains how the approach works in Accelerate, Transformers Trainer and TRL.</p>
              </article>
            </main>
          </body>
        </html>
      `,
    });

    const [enrichedHeadline] = await enrichParsedHeadlineDescriptions([buildHeadline()]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(enrichedHeadline?.description).toContain('distribute attention computation across multiple GPUs');
    expect(enrichedHeadline?.description).not.toContain('материал о новых AI-инструментах');
    expect(enrichedHeadline?.description).not.toContain('We’re on a journey to advance');
  });

  it('не ходит в сеть, если description уже содержательный', async () => {
    const meaningfulHeadline = buildHeadline({
      description: 'Пост разбирает sequence parallelism Ulysses, распределение attention между GPU и практику обучения с контекстом до миллиона токенов.',
      language: 'ru',
    });

    const [enrichedHeadline] = await enrichParsedHeadlineDescriptions([meaningfulHeadline]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(enrichedHeadline).toEqual(meaningfulHeadline);
  });
});
