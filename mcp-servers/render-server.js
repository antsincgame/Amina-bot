#!/usr/bin/env node
/**
 * Render MCP Server
 * Улучшенная версия по образцу render-oss/render-mcp-server
 * https://github.com/render-oss/render-mcp-server
 *
 * Управление сервисами, деплоями, логами, метриками, Postgres, Key Value
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const RENDER_API_URL = 'https://api.render.com/v1';
const API_KEY = process.env.RENDER_API_KEY;

let selectedWorkspaceId = null;

async function renderApi(endpoint, options = {}) {
  if (!API_KEY) {
    throw new Error('RENDER_API_KEY environment variable is not set');
  }

  const response = await fetch(`${RENDER_API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const msg = data?.message || data?.error || text || response.statusText;
    throw new Error(`Render API error: ${response.status} - ${msg}`);
  }

  return data;
}

function buildQueryString(params) {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v != null && v !== '')
  );
  if (Object.keys(filtered).length === 0) return '';
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(filtered)) {
    if (Array.isArray(v)) {
      v.forEach((item) => searchParams.append(k, item));
    } else {
      searchParams.set(k, String(v));
    }
  }
  return '?' + searchParams.toString();
}

const tools = [
  {
    name: 'render_list_workspaces',
    description: 'List all workspaces you have access to',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render_select_workspace',
    description: 'Select workspace for subsequent operations (logs, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'string', description: 'Workspace/owner ID' },
      },
      required: ['owner_id'],
    },
  },
  {
    name: 'render_get_selected_workspace',
    description: 'Get currently selected workspace',
    inputSchema: { type: 'object', properties: {} },
  },
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
        limit: { type: 'number', description: 'Max services to return' },
        include_previews: {
          type: 'boolean',
          description: 'Include preview services',
        },
      },
    },
  },
  {
    name: 'render_get_service',
    description: 'Get detailed information about a specific service',
    inputSchema: {
      type: 'object',
      properties: { service_id: { type: 'string', description: 'Service ID (srv-...)' } },
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
    name: 'render_get_deploy',
    description: 'Get details about a specific deployment',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        deploy_id: { type: 'string', description: 'Deployment ID (dpl-...)' },
      },
      required: ['service_id', 'deploy_id'],
    },
  },
  {
    name: 'render_get_env_vars',
    description: 'Get environment variables for a service',
    inputSchema: {
      type: 'object',
      properties: { service_id: { type: 'string', description: 'Service ID' } },
      required: ['service_id'],
    },
  },
  {
    name: 'render_set_env_vars',
    description: 'Set environment variables (replaces all). For merge, use render_update_env_vars.',
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
    name: 'render_update_env_vars',
    description: 'Update environment variables. By default merges with existing. Set replace=true to replace all.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        env_vars: {
          type: 'array',
          description: 'List of {key, value} objects',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        replace: {
          type: 'boolean',
          description: 'Replace all env vars (default: false = merge)',
        },
      },
      required: ['service_id', 'env_vars'],
    },
  },
  {
    name: 'render_get_logs',
    description: 'Get logs from a service. Supports filtering by type, level, time range.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID' },
        resource: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource IDs (e.g. [service_id]). Required if no service_id.',
        },
        owner_id: { type: 'string', description: 'Workspace ID (uses selected if omitted)' },
        type: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter: app, request, build',
        },
        level: { type: 'array', items: { type: 'string' }, description: 'Filter by severity' },
        limit: { type: 'number', description: 'Max logs (1-100)' },
        start_time: { type: 'string', description: 'RFC3339 start time' },
        end_time: { type: 'string', description: 'RFC3339 end time' },
        direction: {
          type: 'string',
          enum: ['backward', 'forward'],
          description: 'backward = oldest first',
        },
      },
      required: [],
    },
  },
  {
    name: 'render_restart_service',
    description: 'Restart a service without redeploying',
    inputSchema: {
      type: 'object',
      properties: { service_id: { type: 'string', description: 'Service ID' } },
      required: ['service_id'],
    },
  },
  {
    name: 'render_create_web_service',
    description: 'Create a new web service',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique service name' },
        runtime: {
          type: 'string',
          enum: ['node', 'python', 'go', 'rust', 'ruby', 'elixir', 'docker'],
        },
        build_command: { type: 'string', description: 'Build command' },
        start_command: { type: 'string', description: 'Start command' },
        repo: { type: 'string', description: 'Git repo URL' },
        branch: { type: 'string', description: 'Branch to deploy' },
        plan: {
          type: 'string',
          enum: ['starter', 'standard', 'pro', 'pro_max', 'pro_plus', 'pro_ultra'],
        },
        region: {
          type: 'string',
          enum: ['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia'],
        },
        auto_deploy: { type: 'boolean', description: 'Auto deploy on push' },
        env_vars: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
        },
      },
      required: ['name', 'runtime', 'build_command', 'start_command'],
    },
  },
  {
    name: 'render_create_static_site',
    description: 'Create a new static site',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name' },
        build_command: { type: 'string', description: 'Build command' },
        publish_path: { type: 'string', description: 'Output directory (e.g. dist)' },
        repo: { type: 'string', description: 'Git repo URL' },
        branch: { type: 'string', description: 'Branch' },
        auto_deploy: { type: 'boolean' },
        env_vars: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
        },
      },
      required: ['name', 'build_command'],
    },
  },
  {
    name: 'render_create_cron_job',
    description: 'Create a new cron job',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name' },
        schedule: { type: 'string', description: 'Cron expression (e.g. 0 0 * * * for daily)' },
        runtime: {
          type: 'string',
          enum: ['node', 'python', 'go', 'rust', 'ruby', 'elixir', 'docker'],
        },
        build_command: { type: 'string' },
        start_command: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        plan: { type: 'string', enum: ['starter', 'standard', 'pro', 'pro_max', 'pro_plus', 'pro_ultra'] },
        region: { type: 'string', enum: ['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia'] },
        auto_deploy: { type: 'boolean' },
        env_vars: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
        },
      },
      required: ['name', 'schedule', 'runtime', 'build_command', 'start_command'],
    },
  },
  {
    name: 'render_list_postgres',
    description: 'List all PostgreSQL databases in your Render account',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render_get_postgres',
    description: 'Get details about a PostgreSQL database',
    inputSchema: {
      type: 'object',
      properties: { postgres_id: { type: 'string', description: 'Postgres ID (dpg-...)' } },
      required: ['postgres_id'],
    },
  },
  {
    name: 'render_query_postgres',
    description: 'Run a read-only SQL query against a Render Postgres database',
    inputSchema: {
      type: 'object',
      properties: {
        postgres_id: { type: 'string', description: 'Postgres instance ID' },
        sql: { type: 'string', description: 'SQL query (read-only)' },
      },
      required: ['postgres_id', 'sql'],
    },
  },
  {
    name: 'render_list_key_value',
    description: 'List all Key Value (Redis) instances in your Render account',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'render_get_key_value',
    description: 'Get details about a Key Value instance',
    inputSchema: {
      type: 'object',
      properties: { key_value_id: { type: 'string', description: 'Key Value instance ID' } },
      required: ['key_value_id'],
    },
  },
  {
    name: 'render_get_metrics',
    description: 'Get performance metrics for a service (CPU, memory, HTTP requests)',
    inputSchema: {
      type: 'object',
      properties: {
        resource_id: { type: 'string', description: 'Service or Postgres ID' },
        metric_types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['cpu_usage', 'memory_usage', 'http_request_count', 'http_latency', 'instance_count', 'bandwidth_usage'],
          },
          description: 'Metrics to fetch',
        },
        start_time: { type: 'string', description: 'RFC3339 start' },
        end_time: { type: 'string', description: 'RFC3339 end' },
        resolution: { type: 'number', description: 'Time resolution in seconds (min 30)' },
      },
      required: ['resource_id', 'metric_types'],
    },
  },
];

async function handleTool(name, args) {
  const a = args || {};

  switch (name) {
    case 'render_list_workspaces': {
      const data = await renderApi('/owners');
      return { workspaces: Array.isArray(data) ? data : data?.items ?? data };
    }

    case 'render_select_workspace': {
      selectedWorkspaceId = a.owner_id;
      return { selected_workspace_id: selectedWorkspaceId };
    }

    case 'render_get_selected_workspace': {
      return { selected_workspace_id: selectedWorkspaceId };
    }

    case 'render_list_services': {
      const params = {};
      if (a.type) params.type = a.type;
      if (a.limit) params.limit = a.limit;
      if (a.include_previews !== undefined) params.includePreviews = a.include_previews;
      const url = '/services' + buildQueryString(params);
      return renderApi(url);
    }

    case 'render_get_service':
      return renderApi(`/services/${a.service_id}`);

    case 'render_deploy_service':
      return renderApi(`/services/${a.service_id}/deploys`, {
        method: 'POST',
        body: JSON.stringify({ clearCache: a.clear_cache ? 'clear' : 'do_not_clear' }),
      });

    case 'render_get_deploys': {
      const qs = a.limit ? `?limit=${a.limit}` : '';
      return renderApi(`/services/${a.service_id}/deploys${qs}`);
    }

    case 'render_get_deploy':
      return renderApi(`/services/${a.service_id}/deploys/${a.deploy_id}`);

    case 'render_get_env_vars':
      return renderApi(`/services/${a.service_id}/env-vars`);

    case 'render_set_env_vars': {
      const envVars = Object.entries(a.env_vars || {}).map(([key, value]) => ({
        key,
        value: String(value),
      }));
      return renderApi(`/services/${a.service_id}/env-vars`, {
        method: 'PUT',
        body: JSON.stringify(envVars),
      });
    }

    case 'render_update_env_vars': {
      const envVars = Object.entries(
        Array.isArray(a.env_vars)
          ? Object.fromEntries(a.env_vars.map((e) => [e.key, e.value]))
          : a.env_vars
      ).map(([key, value]) => ({ key, value }));

      if (a.replace) {
        return renderApi(`/services/${a.service_id}/env-vars`, {
          method: 'PUT',
          body: JSON.stringify(envVars),
        });
      }
      return renderApi(`/services/${a.service_id}/env-vars`, {
        method: 'PATCH',
        body: JSON.stringify(envVars),
      });
    }

    case 'render_get_logs': {
      const resource = a.resource || (a.service_id ? [a.service_id] : null);
      const ownerId = a.owner_id || selectedWorkspaceId;

      if (!resource?.length) {
        throw new Error('Provide service_id or resource array');
      }
      if (!ownerId) {
        throw new Error('Provide owner_id or call render_select_workspace first');
      }

      const params = {
        ownerId,
        resource,
        limit: Math.min(100, Math.max(1, a.limit || 20)),
        direction: a.direction || 'backward',
      };
      if (a.type?.length) params.type = a.type;
      if (a.level?.length) params.level = a.level;
      if (a.start_time) params.startTime = a.start_time;
      if (a.end_time) params.endTime = a.end_time;

      const url = '/logs' + buildQueryString(params);
      return renderApi(url);
    }

    case 'render_restart_service':
      return renderApi(`/services/${a.service_id}/restart`, { method: 'POST' });

    case 'render_create_web_service': {
      const body = {
        name: a.name,
        runtime: a.runtime,
        buildCommand: a.build_command,
        startCommand: a.start_command,
        plan: a.plan || 'starter',
        region: a.region || 'frankfurt',
        autoDeploy: a.auto_deploy !== false,
      };
      if (a.repo) body.repo = a.repo;
      if (a.branch) body.branch = a.branch;
      if (a.env_vars?.length) {
        body.envVars = a.env_vars.map((e) => ({ key: e.key, value: e.value }));
      }
      return renderApi('/services', {
        method: 'POST',
        body: JSON.stringify({ type: 'web_service', ...body }),
      });
    }

    case 'render_create_static_site': {
      const body = {
        name: a.name,
        buildCommand: a.build_command,
        publishPath: a.publish_path || 'dist',
        autoDeploy: a.auto_deploy !== false,
      };
      if (a.repo) body.repo = a.repo;
      if (a.branch) body.branch = a.branch;
      if (a.env_vars?.length) {
        body.envVars = a.env_vars.map((e) => ({ key: e.key, value: e.value }));
      }
      return renderApi('/services', {
        method: 'POST',
        body: JSON.stringify({ type: 'static_site', ...body }),
      });
    }

    case 'render_create_cron_job': {
      const body = {
        name: a.name,
        schedule: a.schedule,
        runtime: a.runtime,
        buildCommand: a.build_command,
        startCommand: a.start_command,
        plan: a.plan || 'starter',
        region: a.region || 'frankfurt',
        autoDeploy: a.auto_deploy !== false,
      };
      if (a.repo) body.repo = a.repo;
      if (a.branch) body.branch = a.branch;
      if (a.env_vars?.length) {
        body.envVars = a.env_vars.map((e) => ({ key: e.key, value: e.value }));
      }
      return renderApi('/services', {
        method: 'POST',
        body: JSON.stringify({ type: 'cron_job', ...body }),
      });
    }

    case 'render_list_postgres':
      return renderApi('/postgres');

    case 'render_get_postgres':
      return renderApi(`/postgres/${a.postgres_id}`);

    case 'render_query_postgres':
      return renderApi(`/postgres/${a.postgres_id}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: a.sql }),
      });

    case 'render_list_key_value':
      return renderApi('/redis');

    case 'render_get_key_value':
      return renderApi(`/redis/${a.key_value_id}`);

    case 'render_get_metrics': {
      const params = {
        resourceId: a.resource_id,
        metricTypes: a.metric_types.join(','),
      };
      if (a.start_time) params.startTime = a.start_time;
      if (a.end_time) params.endTime = a.end_time;
      if (a.resolution) params.resolution = a.resolution;
      const url = '/metrics' + buildQueryString(params);
      return renderApi(url);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'render', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Render MCP server v2.0.0 started');
