#!/usr/bin/env node
/**
 * Render MCP Server
 * Manages Render.com services, deploys, and environment variables
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const RENDER_API_URL = 'https://api.render.com/v1';
const API_KEY = process.env.RENDER_API_KEY;

// API helper
async function renderApi(endpoint, options = {}) {
  if (!API_KEY) {
    throw new Error('RENDER_API_KEY environment variable is not set');
  }

  const response = await fetch(`${RENDER_API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Render API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Tool definitions
const tools = [
  {
    name: 'render_list_services',
    description: 'List all services in your Render account',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['web_service', 'static_site', 'private_service', 'background_worker', 'cron_job'],
          description: 'Filter by service type',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of services to return',
        },
      },
    },
  },
  {
    name: 'render_get_service',
    description: 'Get detailed information about a specific service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID (starts with srv-)' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'render_deploy_service',
    description: 'Trigger a new deployment for a service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        clear_cache: { type: 'boolean', description: 'Clear build cache' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'render_get_deploys',
    description: 'Get deployment history for a service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        limit: { type: 'number', description: 'Max deploys to return' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'render_get_env_vars',
    description: 'Get environment variables for a service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'render_set_env_vars',
    description: 'Set environment variables for a service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        env_vars: { 
          type: 'object', 
          description: 'Key-value pairs of env vars',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['service_id', 'env_vars'],
    },
  },
  {
    name: 'render_get_logs',
    description: 'Get logs from a service',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        limit: { type: 'number', description: 'Number of log lines' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'render_restart_service',
    description: 'Restart a service without redeploying',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
      },
      required: ['service_id'],
    },
  },
];

// Tool handlers
async function handleTool(name, args) {
  switch (name) {
    case 'render_list_services': {
      let url = '/services';
      const params = new URLSearchParams();
      if (args.type) params.set('type', args.type);
      if (args.limit) params.set('limit', String(args.limit));
      if (params.toString()) url += `?${params}`;
      return renderApi(url);
    }

    case 'render_get_service':
      return renderApi(`/services/${args.service_id}`);

    case 'render_deploy_service':
      return renderApi(`/services/${args.service_id}/deploys`, {
        method: 'POST',
        body: JSON.stringify({ clearCache: args.clear_cache ? 'clear' : 'do_not_clear' }),
      });

    case 'render_get_deploys': {
      let url = `/services/${args.service_id}/deploys`;
      if (args.limit) url += `?limit=${args.limit}`;
      return renderApi(url);
    }

    case 'render_get_env_vars':
      return renderApi(`/services/${args.service_id}/env-vars`);

    case 'render_set_env_vars': {
      const envVars = Object.entries(args.env_vars).map(([key, value]) => ({
        key,
        value,
      }));
      return renderApi(`/services/${args.service_id}/env-vars`, {
        method: 'PUT',
        body: JSON.stringify(envVars),
      });
    }

    case 'render_get_logs':
      // Note: Render logs require WebSocket, this is simplified
      return { message: 'Use Render Dashboard for real-time logs', service_id: args.service_id };

    case 'render_restart_service':
      return renderApi(`/services/${args.service_id}/restart`, { method: 'POST' });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create server
const server = new Server(
  { name: 'render', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Render MCP server started');
