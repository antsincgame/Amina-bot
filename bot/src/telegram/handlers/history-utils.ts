import { telegramLogger } from '../../config/logger.js';
import { looksLikeSearchSimulation } from '../format.js';
import type { AIMessage } from '../../../../shared/types/index.js';

export const MAX_CITATIONS_DISPLAY = 5;
export const MAX_URL_DISPLAY_LENGTH = 70;
export const MIN_SEARCH_ANSWER_LENGTH = 30;
export const MIN_FORCE_ANSWER_LENGTH = 50;
export const AUTO_SUMMARY_INTERVAL = 20;
export const MAX_NOTE_PREVIEW_LENGTH = 120;

export function formatCitationsBlock(citations: string[]): string {
  if (citations.length === 0) return '';
  return '\n\n📚 Источники:\n' + citations.slice(0, MAX_CITATIONS_DISPLAY)
    .map((url, i) => `${i + 1}. ${url.length > MAX_URL_DISPLAY_LENGTH ? url.substring(0, MAX_URL_DISPLAY_LENGTH - 3) + '...' : url}`)
    .join('\n') + '\n';
}

/**
 * Removes past Q+A pairs where the user's question is similar to the current one.
 * Prevents weak models from copying their own previous answers verbatim.
 */
export const deduplicateSimilarQuestions = (
  history: AIMessage[],
  currentQuestion: string,
): AIMessage[] => {
  const currentNorm = currentQuestion.toLowerCase().trim().replace(/[?!.,\s]+/g, ' ');
  if (currentNorm.length < 5) return history;

  const indicesToRemove = new Set<number>();

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg || msg.role !== 'user') continue;
    const pastNorm = msg.content.toLowerCase().trim().replace(/[?!.,\s]+/g, ' ');
    const isSimilar =
      pastNorm === currentNorm ||
      currentNorm.includes(pastNorm) ||
      pastNorm.includes(currentNorm);
    if (isSimilar) {
      indicesToRemove.add(i);
      if (i + 1 < history.length && history[i + 1]?.role === 'assistant') {
        indicesToRemove.add(i + 1);
      }
    }
  }

  if (indicesToRemove.size > 0) {
    telegramLogger.debug({ removed: indicesToRemove.size }, 'Deduped similar Q&A from history');
  }
  return history.filter((_, idx) => !indicesToRemove.has(idx));
};

export const sanitizeMessageHistory = (history: AIMessage[]): AIMessage[] => {
  if (history.length === 0) return history;

  // Remove search simulations
  let cleaned = history.filter(m => !(m.role === 'assistant' && looksLikeSearchSimulation(m.content)));

  // Detect context poisoning (same response 2+ times)
  const assistantResponses = cleaned.filter(m => m.role === 'assistant');
  const responseCounts = new Map<string, number>();
  for (const msg of assistantResponses) {
    const key = msg.content.substring(0, 100);
    responseCounts.set(key, (responseCounts.get(key) || 0) + 1);
  }

  const poisonedPrefixes = new Set<string>();
  for (const [prefix, count] of responseCounts) {
    if (count >= 2) poisonedPrefixes.add(prefix);
  }

  if (poisonedPrefixes.size > 0) {
    telegramLogger.warn({ poisonedCount: poisonedPrefixes.size, historyBefore: cleaned.length }, 'Context poisoning detected');
    const seen = new Set<string>();
    cleaned = cleaned.filter(m => {
      if (m.role !== 'assistant') return true;
      const prefix = m.content.substring(0, 100);
      if (poisonedPrefixes.has(prefix)) {
        if (seen.has(prefix)) return false;
        seen.add(prefix);
      }
      return true;
    });
    telegramLogger.info({ historyAfter: cleaned.length }, 'History sanitized');
  }

  return cleaned;
};
