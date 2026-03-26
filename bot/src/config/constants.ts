/**
 * Священный модуль констант — единственный источник истины для magic numbers.
 * Все таймауты, лимиты, TTL вынесены сюда. Хардкод в коде запрещён.
 */

// ============================================
// Telegram API Limits (неизменяемые)
// ============================================
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

// ============================================
// AI / LLM Limits
// ============================================
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_CONVERSATION_MESSAGES = 1000;
export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_VISION_MAX_TOKENS = 1024;
export const MIN_CONTEXT_LENGTH = 4096;
export const MIN_VISION_CONTEXT_LENGTH = 2048;

// Perplexity
export const PERPLEXITY_DEFAULT_SEARCH_TOKENS = 1200;
export const PERPLEXITY_DEFAULT_NEWS_TOKENS = 2000;
export const PERPLEXITY_DEFAULT_DIGEST_TOKENS = 4000;
export const PERPLEXITY_MIN_TOKENS = 200;
export const PERPLEXITY_MAX_TOKENS = 8000;

// ============================================
// Timeouts (ms)
// ============================================
export const FETCH_TIMEOUT_MS = 15_000;
export const OPENROUTER_TIMEOUT_MS = 30_000;
export const OPENROUTER_RACE_TIMEOUT_MS = 15_000;
export const PERPLEXITY_TIMEOUT_MS = 30_000;
export const PERPLEXITY_DIGEST_TIMEOUT_MS = 35_000;
export const PERPLEXITY_ABORT_MS = 25_000;
export const GROQ_ABORT_MS = 5_000;
export const IMAGE_GEN_ABORT_MS = 4_000;
export const IMAGE_EDIT_ABORT_MS = 3_000;
export const VISION_RACE_TIMEOUT_MS = 20_000;
export const VISION_TIMEOUT_MS = 60_000;
export const LIRAX_FETCH_TIMEOUT_MS = 5_000;
export const LMSTUDIO_ABORT_MS = 5_000;
export const BUILD_DIGEST_TIMEOUT_MS = 90_000;

// Server (index.ts)
/**
 * Таймаут запроса на уровне Node/Fastify. Мини-апп (LLM + поиск + TTS) часто >28с;
 * иначе обрыв соединения даёт 502 на стороне прокси. Переопределение: REQUEST_TIMEOUT_MS.
 */
export const REQUEST_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.REQUEST_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) return fromEnv;
  return 90_000;
})();
/** Доп. запас сокета для длинного хендлера мини-аппа (не ниже REQUEST_TIMEOUT_MS). */
export const MINI_APP_REQUEST_TIMEOUT_MS = 120_000;
export const CONNECTION_TIMEOUT_MS = 5_000;
export const KEEP_ALIVE_TIMEOUT_MS = 30_000;
export const INIT_DELAY_MS = Number(process.env.INIT_DELAY_MS) || 5_000;
export const BODY_LIMIT_BYTES = 10_485_760; // 10MB
export const HEALTH_AI_TIMEOUT_MS = 8_000;

// ============================================
// Cache TTL (ms)
// ============================================
export const CACHE_TTL_5MIN = 5 * 60 * 1000;
export const CACHE_TTL_3MIN = 3 * 60 * 1000;
export const CACHE_TTL_30MIN = 30 * 60 * 1000;
export const CACHE_TTL_2MIN = 2 * 60 * 1000;
export const CACHE_TTL_60SEC = 60_000;
export const SETTINGS_CACHE_TTL = CACHE_TTL_5MIN;
export const PARSED_NEWS_CACHE_TTL = CACHE_TTL_2MIN;
export const DIGEST_CACHE_TTL = CACHE_TTL_30MIN;
export const HYBRID_DIGEST_CACHE_TTL = 90 * 60 * 1000;
export const HF_TOKEN_CACHE_TTL = CACHE_TTL_5MIN;
export const PROMPT_CACHE_TTL = CACHE_TTL_5MIN;
export const FULL_TEXT_CACHE_TTL = CACHE_TTL_30MIN;
export const DB_LOGGER_FLUSH_INTERVAL_MS = 5_000;

// ============================================
// Rate Limiting
// ============================================
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_CLEANUP_INTERVAL_MS = CACHE_TTL_5MIN;

// ============================================
// Reminders
// ============================================
export const AI_RETRY_DELAY_MS = 2_000;
export const MAX_MINUTES_RANGE = 1440;
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// ============================================
// News Parser
// ============================================
export const MAX_HEADLINES_PER_SITE = 200;
export const MIN_TITLE_LENGTH = 4;
export const MAX_TITLE_LENGTH = 800;
export const MAX_NEWS_AGE_HOURS = 336; // 14 days
export const NEWS_SITE_TIMEOUT_MS = 12_000;
export const NEWS_FEED_PROBE_TIMEOUT_MS = 5_000;
/** Максимум параллельных парсеров — снижает пик памяти при 88+ сайтах */
export const NEWS_PARSE_BATCH_SIZE = 12;

// ============================================
// TTS
// ============================================
export const ELEVENLABS_CHUNK_SIZE = 5000;
export const OPENAI_TTS_CHUNK_SIZE = 4000;
export const EDGE_TTS_CHUNK_SIZE = 3000;
export const TTS_CONFIG_TTL = CACHE_TTL_3MIN;

// ============================================
// Voice / Multimodal
// ============================================
export const VOICE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_IMAGE_BASE64_SIZE_BYTES = 7 * 1024 * 1024; // 7MB Gemini limit
export const MAX_GROQ_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// ============================================
// Validation
// ============================================
export const VALIDATE_LIMIT_MIN = 1;
export const VALIDATE_LIMIT_MAX = 1000;
export const LEADS_MESSAGE_MAX_LENGTH = 10_000;
export const LEADS_COMMENT_MAX_LENGTH = 2_000;

// ============================================
// Digest
// ============================================
export const DIGEST_MIDNIGHT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const DIGEST_TYPING_DELAY_MS = 1_500;

// ============================================
// Health / Ready
// ============================================
export const HEALTH_CACHE_TTL_MS = 60_000;
