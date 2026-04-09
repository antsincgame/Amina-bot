import type {
  NewsSourceType,
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
} from '../../../../shared/types/index.js';
import { Rss, Code, Globe2 } from 'lucide-react';

export const TYPE_LABELS: Record<NewsSourceType, { label: string; icon: typeof Rss }> = {
  rss: { label: 'RSS', icon: Rss },
  json_api: { label: 'JSON API', icon: Code },
  html_scrape: { label: 'HTML', icon: Globe2 },
};

export const CATEGORY_LABELS: Record<NewsSourceCategory, { label: string; color: string }> = {
  ai_tech: { label: 'AI/Tech', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  city_local: { label: 'Город', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  community: { label: 'Сообщество', color: 'text-green-400 bg-green-400/10 border-green-400/20' },
  asia_tech: { label: 'Азия', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
};

export const UNCATEGORIZED_BADGE = {
  label: 'Без категории',
  color: 'text-gray-300 bg-gray-500/10 border-gray-500/20',
};

export const LANGUAGE_FLAGS: Record<NewsSourceLanguage, string> = {
  ru: '🇷🇺',
  en: '🇬🇧',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
};

export const TIER_LABELS: Record<NewsSourceTier, string> = {
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  tier3: 'Tier 3',
};

export const DEFAULT_VIBECODING_KEYWORDS = [
  'vibecoding', 'vibe coding', 'вайбкодинг',
  'ai coding', 'ai-assisted coding',
  'cursor', 'copilot', 'claude code',
  'windsurf', 'codeium', 'bolt.new', 'v0.dev',
  'replit agent', 'devin', 'aider',
  'code generation', 'ai ide',
  'deepseek coder', 'qwen coder',
];

export const TRANSLATION_PROVIDERS = [
  { value: 'auto', label: '⚡ Auto', desc: 'Cerebras → Groq → OpenRouter', accent: 'rgb(251, 191, 36)' },
  { value: 'cerebras', label: '🧠 Cerebras', desc: 'Быстрый inference', accent: 'rgb(74, 222, 128)' },
  { value: 'groq', label: '🔥 Groq', desc: 'Llama 3.3 70B', accent: 'rgb(96, 165, 250)' },
  { value: 'openrouter', label: '🌐 OpenRouter', desc: 'Claude / GPT fallback', accent: 'rgb(168, 85, 247)' },
];
