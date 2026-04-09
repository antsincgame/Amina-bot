import type {
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
  HtmlFieldMapping,
} from '../../../../shared/types/index.js';

export type { NewsSite, ParsedHeadline } from '../../../../shared/types/index.js';

export type {
  ParsedHeadlineCategory,
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
  JsonFieldMapping,
  HtmlFieldMapping,
} from '../../../../shared/types/index.js';

export type NewsPresetGroup = 'all' | 'global' | 'asia';

export interface ParseOptions {
  category?: NewsSourceCategory;
  language?: NewsSourceLanguage;
  filterKeywords?: string[];
  htmlMapping?: HtmlFieldMapping;
  source?: string;
  sourceUrl?: string;
  sourceTier?: NewsSourceTier;
}
