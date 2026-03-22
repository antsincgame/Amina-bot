/**
 * AI Proxy Helper
 * 
 * Routes AI API requests through Cloudflare Worker proxy
 * when AI_PROXY_URL is configured. Falls back to direct URLs otherwise.
 */

const PROXY_URL = process.env.AI_PROXY_URL?.replace(/\/+$/, '') || '';
const PROXY_SECRET = process.env.AI_PROXY_SECRET || '';

/** Whether proxy is configured */
export const isProxyEnabled = Boolean(PROXY_URL);

/**
 * Get base URL for a service, routing through proxy if configured.
 */
export function getProxyUrl(service: 'openrouter' | 'perplexity' | 'groq' | 'cerebras' | 'huggingface' | 'openrouter-raw'): string {
  const directUrls: Record<string, string> = {
    'openrouter': 'https://openrouter.ai/api',
    'openrouter-raw': 'https://openrouter.ai',
    'perplexity': 'https://api.perplexity.ai',
    'groq': 'https://api.groq.com/openai',
    'cerebras': 'https://api.cerebras.ai',
    'huggingface': 'https://api-inference.huggingface.co',
  };

  if (!PROXY_URL) return directUrls[service]!;
  return `${PROXY_URL}/${service}`;
}

/**
 * Get headers for proxied requests (adds X-Proxy-Token).
 */
export function getProxyHeaders(headers?: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  if (PROXY_URL && PROXY_SECRET) {
    result['X-Proxy-Token'] = PROXY_SECRET;
  }
  return result;
}

/**
 * Convenience: get OpenRouter v1 base URL
 */
export function getOpenRouterBaseUrl(): string {
  return `${getProxyUrl('openrouter')}/v1`;
}

/**
 * Convenience: get Groq v1 base URL
 */
export function getGroqBaseUrl(): string {
  return `${getProxyUrl('groq')}/v1`;
}

/**
 * Convenience: get Cerebras v1 base URL
 */
export function getCerebrasBaseUrl(): string {
  return `${getProxyUrl('cerebras')}/v1`;
}

/**
 * Convenience: get Perplexity base URL
 */
export function getPerplexityBaseUrl(): string {
  return getProxyUrl('perplexity');
}
