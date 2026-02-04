#!/usr/bin/env node
/**
 * Supabase MCP Server
 * Database operations, Auth, and Storage for Supabase
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return supabase;
}

// Whitelist of allowed tables (security)
const ALLOWED_TABLES = [
  'settings',
  'prompts',
  'conversations',
  'analytics',
];

// Validate table name against whitelist
function validateTable(table) {
  if (!table || typeof table !== 'string') {
    throw new Error('Invalid table name');
  }
  
  const sanitized = table.toLowerCase().trim();
  
  if (!ALLOWED_TABLES.includes(sanitized)) {
    throw new Error(
      `Table "${table}" not allowed. Allowed tables: ${ALLOWED_TABLES.join(', ')}`
    );
  }
  
  return sanitized;
}

// Validate column names (prevent SQL injection)
function validateColumns(columns) {
  if (!columns || columns === '*') return '*';
  
  const columnPattern = /^[a-zA-Z0-9_,\s\*]+$/;
  if (!columnPattern.test(columns)) {
    throw new Error('Invalid column names. Use only alphanumeric, underscore, comma, and spaces');
  }
  
  return columns;
}

// Tool definitions
const tools = [
  // Raw SQL removed for security - use supabase_rpc for custom queries
  {
    name: 'supabase_select',
    description: 'Select data from a table with filters',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        columns: { type: 'string', description: 'Columns to select (default: *)' },
        filter: { type: 'object', description: 'Filter conditions' },
        order: { 
          type: 'object', 
          properties: {
            column: { type: 'string' },
            ascending: { type: 'boolean' },
          },
        },
        limit: { type: 'number', description: 'Max rows to return' },
        offset: { type: 'number', description: 'Rows to skip' },
      },
      required: ['table'],
    },
  },
  {
    name: 'supabase_insert',
    description: 'Insert data into a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        data: { description: 'Data to insert (object or array)' },
        upsert: { type: 'boolean', description: 'Upsert mode' },
        on_conflict: { type: 'string', description: 'Conflict column for upsert' },
      },
      required: ['table', 'data'],
    },
  },
  {
    name: 'supabase_update',
    description: 'Update rows in a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        data: { type: 'object', description: 'Data to update' },
        filter: { type: 'object', description: 'Filter conditions (required)' },
      },
      required: ['table', 'data', 'filter'],
    },
  },
  {
    name: 'supabase_delete',
    description: 'Delete rows from a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name' },
        filter: { type: 'object', description: 'Filter conditions (required)' },
      },
      required: ['table', 'filter'],
    },
  },
  {
    name: 'supabase_list_tables',
    description: 'List all tables in the database',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Schema name (default: public)' },
      },
    },
  },
  {
    name: 'supabase_list_users',
    description: 'List users from Supabase Auth',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number' },
        per_page: { type: 'number', description: 'Users per page' },
      },
    },
  },
  {
    name: 'supabase_get_user',
    description: 'Get a specific user by ID',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User UUID' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'supabase_storage_list',
    description: 'List files in a storage bucket',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: 'Bucket name' },
        path: { type: 'string', description: 'Path within bucket' },
        limit: { type: 'number', description: 'Max files to return' },
      },
      required: ['bucket'],
    },
  },
  {
    name: 'supabase_rpc',
    description: 'Call a PostgreSQL function',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name' },
        params: { type: 'object', description: 'Function parameters' },
      },
      required: ['function_name'],
    },
  },
];

// Tool handlers
async function handleTool(name, args) {
  const sb = getSupabase();

  switch (name) {
    case 'supabase_select': {
      const table = validateTable(args.table);
      const columns = validateColumns(args.columns);
      
      let query = sb.from(table).select(columns || '*');
      
      if (args.filter) {
        for (const [key, value] of Object.entries(args.filter)) {
          query = query.eq(key, value);
        }
      }
      if (args.order) {
        query = query.order(args.order.column, { ascending: args.order.ascending ?? true });
      }
      if (args.limit) query = query.limit(args.limit);
      if (args.offset) query = query.range(args.offset, args.offset + (args.limit || 10) - 1);
      
      const { data, error } = await query;
      if (error) throw error;
      return { data, count: data?.length };
    }

    case 'supabase_insert': {
      const table = validateTable(args.table);
      let query = sb.from(table);
      
      if (args.upsert) {
        query = query.upsert(args.data, { onConflict: args.on_conflict });
      } else {
        query = query.insert(args.data);
      }
      
      const { data, error } = await query.select();
      if (error) throw error;
      return { data, inserted: data?.length };
    }

    case 'supabase_update': {
      const table = validateTable(args.table);
      let query = sb.from(table).update(args.data);
      
      for (const [key, value] of Object.entries(args.filter)) {
        query = query.eq(key, value);
      }
      
      const { data, error } = await query.select();
      if (error) throw error;
      return { data, updated: data?.length };
    }

    case 'supabase_delete': {
      const table = validateTable(args.table);
      let query = sb.from(table).delete();
      
      for (const [key, value] of Object.entries(args.filter)) {
        query = query.eq(key, value);
      }
      
      const { data, error } = await query.select();
      if (error) throw error;
      return { data, deleted: data?.length };
    }

    case 'supabase_list_tables': {
      const schema = args.schema || 'public';
      const { data, error } = await sb
        .from('information_schema.tables')
        .select('table_name, table_type')
        .eq('table_schema', schema);
      
      // Alternative: use pg_catalog
      if (error) {
        // Fallback to known tables
        return { 
          tables: ['settings', 'prompts', 'conversations', 'analytics'],
          note: 'Showing known project tables',
        };
      }
      return { tables: data };
    }

    case 'supabase_list_users': {
      const { data, error } = await sb.auth.admin.listUsers({
        page: args.page || 1,
        perPage: args.per_page || 50,
      });
      if (error) throw error;
      return { 
        users: data.users.map(u => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in: u.last_sign_in_at,
        })),
        total: data.users.length,
      };
    }

    case 'supabase_get_user': {
      const { data, error } = await sb.auth.admin.getUserById(args.user_id);
      if (error) throw error;
      return { user: data.user };
    }

    case 'supabase_storage_list': {
      const { data, error } = await sb.storage
        .from(args.bucket)
        .list(args.path || '', { limit: args.limit || 100 });
      if (error) throw error;
      return { files: data };
    }

    case 'supabase_rpc': {
      const { data, error } = await sb.rpc(args.function_name, args.params || {});
      if (error) throw error;
      return { data };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create server
const server = new Server(
  { name: 'supabase', version: '1.0.0' },
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
console.error('Supabase MCP server started');
