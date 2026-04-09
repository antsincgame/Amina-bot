import { assertNewsSiteUrlIsSafe } from './news-host-validation.js';
import { USER_AGENT, MAX_FETCH_REDIRECTS } from './news-parser-constants.js';
import { FETCH_TIMEOUT_MS } from '../../config/constants.js';

export async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount += 1) {
    await assertNewsSiteUrlIsSafe(currentUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8',
          'Accept-Language': 'ja-JP,ja;q=0.95,ko-KR,ko;q=0.9,zh-CN,zh;q=0.9,en-US,en;q=0.7,ru-RU,ru;q=0.5',
        },
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect location is missing for news site: ${currentUrl}`);
      }

      if (redirectCount === MAX_FETCH_REDIRECTS) {
        throw new Error(`Too many redirects while fetching news site: ${url}`);
      }

      currentUrl = new URL(location, currentUrl).toString();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Too many redirects while fetching news site: ${url}`);
}

function createTimeoutError(scope: string, timeoutMs: number): Error {
  return new Error(`${scope} timed out after ${Math.ceil(timeoutMs / 1000)}s`);
}

export async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scope: string,
  abortController?: AbortController,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController?.abort();
        reject(createTimeoutError(scope, timeoutMs));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
