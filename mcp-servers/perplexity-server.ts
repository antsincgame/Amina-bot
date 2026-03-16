#!/usr/bin/env node
/**
 * Perplexity MCP Server
 * Web search and grounded answers via Perplexity Chat Completions API.
 * Uses the cheapest model (sonar) for internet search.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

/** Cheapest model for web search: Sonar ($1/1M input, $1/1M output) */
const DEFAULT_MODEL = 'sonar';

interface PerplexityChatArgs {
  message: string;
  system?: string;
  max_tokens?: number;
  model?: string;
}

interface PerplexityMessage {
  role: 'system' | 'user';
  content: string;
}

interface PerplexityUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: PerplexityUsage;
  citations?: string[];
  search_results?: unknown[];
}

interface PerplexityChatResult {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: string[];
  search_results?: unknown[];
}

async function perplexityChat(args: PerplexityChatArgs): Promise<PerplexityChatResult> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY must be set');
  }

  const model = args.model || DEFAULT_MODEL;
  const message = typeof args.message === 'string' ? args.message : '';
  const system = args.system;
  const maxTokens = Math.min(Math.max(Number(args.max_tokens) || 1024, 1), 4096);

  if (!message.trim()) {
    throw new Error('message is required');
  }

  const messages: PerplexityMessage[] = [];
  if (system && system.trim()) {
    messages.push({ role: 'system', content: system.trim() });
  }
  messages.push({ role: 'user', content: message.trim() });

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: false,
    search_mode: 'web',
    return_citations: true,
    return_related_questions: false,
  };

  const res = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMessage = `Perplexity API error ${res.status}: ${res.statusText}`;
    try {
      const errJson = JSON.parse(errText) as { error?: { message?: string } };
      if (errJson.error?.message) errMessage = errJson.error.message;
    } catch {
      if (errText) errMessage += ` - ${errText.slice(0, 500)}`;
    }
    throw new Error(errMessage);
  }

  const data = await res.json() as PerplexityResponse;
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const citations = data.citations ?? [];
  const searchResults = data.search_results ?? [];

  return {
    content,
    model: data.model ?? model,
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
    citations: citations.length ? citations : undefined,
    search_results: searchResults.length ? searchResults : undefined,
  };
}

const tools = [
  {
    name: 'perplexity_search',
    description:
      'Ask a question and get an answer with web search. Uses the cheapest Perplexity model (sonar) for internet search. Good for factual, up-to-date information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The question or search query to answer using web search',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt to guide the assistant',
        },
        max_tokens: {
          type: 'number',
          description: 'Max tokens in response (default 1024, max 4096)',
        },
        model: {
          type: 'string',
          description: `Model to use (default: ${DEFAULT_MODEL} - cheapest for search)`,
        },
      },
      required: ['message'],
    },
  },
];

const server = new Server(
  { name: 'perplexity', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'perplexity_search') {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await perplexityChat((args || {}) as PerplexityChatArgs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const err = error as Error;
    return {
      content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Perplexity MCP server started');
