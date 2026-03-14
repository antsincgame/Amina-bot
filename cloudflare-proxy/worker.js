/**
 * Amina AI Proxy — Cloudflare Worker
 * 
 * Routes:
 *   /openrouter/*  → https://openrouter.ai/api/*
 *   /perplexity/*  → https://api.perplexity.ai/*
 *   /groq/*        → https://api.groq.com/openai/*
 *   /huggingface/* → https://api-inference.huggingface.co/*
 *   /openrouter-raw/* → https://openrouter.ai/*  (for /api/v1/models etc)
 * 
 * Auth: X-Proxy-Token header must match PROXY_SECRET env var
 */

const ROUTES = {
  '/openrouter/': 'https://openrouter.ai/api/',
  '/openrouter-raw/': 'https://openrouter.ai/',
  '/perplexity/': 'https://api.perplexity.ai/',
  '/groq/': 'https://api.groq.com/openai/',
  '/huggingface/': 'https://api-inference.huggingface.co/',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Health check
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'amina-ai-proxy' });
    }

    // Auth check
    const proxyToken = request.headers.get('X-Proxy-Token');
    if (env.PROXY_SECRET && proxyToken !== env.PROXY_SECRET) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find matching route
    let targetBase = null;
    let prefix = null;
    for (const [p, target] of Object.entries(ROUTES)) {
      if (url.pathname.startsWith(p)) {
        prefix = p;
        targetBase = target;
        break;
      }
    }

    if (!targetBase) {
      return Response.json(
        { error: 'Unknown route', routes: Object.keys(ROUTES) },
        { status: 404 }
      );
    }

    // Build target URL
    const remainingPath = url.pathname.slice(prefix.length);
    const targetUrl = targetBase + remainingPath + url.search;

    // Forward request, strip proxy headers
    const headers = new Headers(request.headers);
    headers.delete('X-Proxy-Token');
    headers.delete('host');

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      });

      // Return response with CORS
      const respHeaders = new Headers(response.headers);
      respHeaders.set('Access-Control-Allow-Origin', '*');
      respHeaders.set('X-Proxied-To', new URL(targetBase).hostname);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return Response.json(
        { error: 'Proxy error', message: err.message },
        { status: 502 }
      );
    }
  },
};
