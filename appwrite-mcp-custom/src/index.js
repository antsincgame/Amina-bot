#!/usr/bin/env node
/**
 * Appwrite Admin MCP Server
 * Console-level access via raw REST API
 * Create projects, databases, collections, users, keys — everything
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ─── Config ───────────────────────────────────────────────
const ENDPOINT = process.env.APPWRITE_ENDPOINT || "https://appwrite.vibecoding.by/v1";
const EMAIL = process.env.APPWRITE_EMAIL;
const PASSWORD = process.env.APPWRITE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  process.stderr.write("ERROR: APPWRITE_EMAIL and APPWRITE_PASSWORD required\n");
  process.exit(1);
}

// ─── Session management ──────────────────────────────────
let sessionCookie = null;

function uid() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function resolveId(val) {
  return (!val || val === "unique()") ? uid() : val;
}

async function appwriteFetch(path, opts = {}) {
  const url = `${ENDPOINT}${path}`;
  const projectId = opts.projectId || "console";
  const headers = {
    "Content-Type": "application/json",
    "X-Appwrite-Project": projectId,
    "X-Appwrite-Response-Format": "1.6.0",
    ...(projectId !== "console" ? { "X-Appwrite-Mode": "admin" } : {}),
    ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    ...(opts.headers || {}),
  };

  const fetchOpts = { method: opts.method || "GET", headers };
  if (opts.body && fetchOpts.method !== "GET") {
    fetchOpts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, fetchOpts);

  // Capture session cookies
  const raw = res.headers.get("set-cookie") || "";
  if (raw) {
    const cookies = raw.split(/,(?=\s*a_session_)/).map(c => c.split(";")[0].trim()).filter(c => c.includes("a_session_"));
    if (cookies.length) sessionCookie = cookies.join("; ");
  }

  // Handle empty responses (204 No Content, DELETE)
  const text = await res.text();
  if (!text || text.trim() === "") {
    if (res.ok) return { success: true, status: res.status };
    throw new Error(`HTTP ${res.status}`);
  }

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(data.message || `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

async function ensureAuth() {
  if (sessionCookie) {
    try {
      await appwriteFetch("/account");
      return;
    } catch {
      sessionCookie = null;
    }
  }
  await appwriteFetch("/account/sessions/email", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  process.stderr.write("✓ Authenticated with Appwrite Console\n");
}

// Retry wrapper — re-auth on 401
async function withAuth(fn) {
  try {
    await ensureAuth();
    return await fn();
  } catch (e) {
    if (e.message && (e.message.includes("401") || e.message.includes("unauthorized") || e.message.includes("session"))) {
      sessionCookie = null;
      await ensureAuth();
      return await fn();
    }
    throw e;
  }
}

// ─── Tool definitions ─────────────────────────────────────
const TOOLS = [
  // ── Projects ──
  { name: "list_projects", description: "List all Appwrite projects", inputSchema: { type: "object", properties: {} } },
  { name: "create_project", description: "Create a new Appwrite project", inputSchema: {
    type: "object", required: ["projectId", "name", "teamId"],
    properties: { projectId: { type: "string" }, name: { type: "string" }, teamId: { type: "string", description: "Team ID" }, region: { type: "string" } },
  }},
  { name: "get_project", description: "Get project details by ID", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },
  { name: "update_project", description: "Update project name/description", inputSchema: {
    type: "object", required: ["projectId", "name"],
    properties: { projectId: { type: "string" }, name: { type: "string" }, description: { type: "string" } },
  }},
  { name: "delete_project", description: "Delete an Appwrite project permanently", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },

  // ── API Keys ──
  { name: "list_keys", description: "List API keys for a project", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },
  { name: "create_key", description: "Create API key with scopes", inputSchema: {
    type: "object", required: ["projectId", "name", "scopes"],
    properties: { projectId: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { type: "string" }, description: "e.g. databases.read, databases.write, users.read, users.write, collections.read, collections.write, documents.read, documents.write, files.read, files.write, buckets.read, buckets.write" } },
  }},
  { name: "delete_key", description: "Delete an API key", inputSchema: { type: "object", required: ["projectId", "keyId"], properties: { projectId: { type: "string" }, keyId: { type: "string" } } } },

  // ── Platforms ──
  { name: "list_platforms", description: "List platforms (web, mobile) for a project", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },
  { name: "create_platform", description: "Add a web/mobile platform to a project", inputSchema: {
    type: "object", required: ["projectId", "type", "name"],
    properties: { projectId: { type: "string" }, type: { type: "string", description: "web, flutter-web, flutter-ios, flutter-android, react-native-ios, react-native-android" }, name: { type: "string" }, hostname: { type: "string" } },
  }},
  { name: "delete_platform", description: "Delete a platform", inputSchema: { type: "object", required: ["projectId", "platformId"], properties: { projectId: { type: "string" }, platformId: { type: "string" } } } },

  // ── Databases ──
  { name: "list_databases", description: "List databases in a project", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },
  { name: "create_database", description: "Create a database", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "name"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, name: { type: "string" } },
  }},
  { name: "update_database", description: "Update database name", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "name"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, name: { type: "string" } },
  }},
  { name: "delete_database", description: "Delete a database", inputSchema: { type: "object", required: ["projectId", "databaseId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" } } } },

  // ── Collections ──
  { name: "list_collections", description: "List collections in a database", inputSchema: { type: "object", required: ["projectId", "databaseId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" } } } },
  { name: "create_collection", description: "Create a collection", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "name"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, name: { type: "string" }, permissions: { type: "array", items: { type: "string" } }, documentSecurity: { type: "boolean" } },
  }},
  { name: "update_collection", description: "Update collection name/permissions", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "name"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, name: { type: "string" }, permissions: { type: "array", items: { type: "string" } } },
  }},
  { name: "delete_collection", description: "Delete a collection", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" } } } },

  // ── Attributes ──
  { name: "list_attributes", description: "List all attributes in a collection", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" } } } },
  { name: "create_string_attribute", description: "Create a string attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "size", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, size: { type: "number" }, required: { type: "boolean" }, default: { type: "string" }, array: { type: "boolean" } },
  }},
  { name: "create_integer_attribute", description: "Create an integer attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" }, min: { type: "number" }, max: { type: "number" }, default: { type: "number" } },
  }},
  { name: "create_float_attribute", description: "Create a float attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" }, min: { type: "number" }, max: { type: "number" }, default: { type: "number" } },
  }},
  { name: "create_boolean_attribute", description: "Create a boolean attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" }, default: { type: "boolean" } },
  }},
  { name: "create_email_attribute", description: "Create an email attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" } },
  }},
  { name: "create_url_attribute", description: "Create a URL attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" } },
  }},
  { name: "create_datetime_attribute", description: "Create a datetime attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, required: { type: "boolean" } },
  }},
  { name: "create_enum_attribute", description: "Create an enum attribute", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "elements", "required"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, elements: { type: "array", items: { type: "string" } }, required: { type: "boolean" }, default: { type: "string" } },
  }},
  { name: "delete_attribute", description: "Delete an attribute", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId", "key"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" } } } },

  // ── Indexes ──
  { name: "list_indexes", description: "List indexes on a collection", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" } } } },
  { name: "create_index", description: "Create an index", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "key", "type", "attributes"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" }, type: { type: "string", description: "key, unique, fulltext" }, attributes: { type: "array", items: { type: "string" } }, orders: { type: "array", items: { type: "string" } } },
  }},
  { name: "delete_index", description: "Delete an index", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId", "key"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, key: { type: "string" } } } },

  // ── Documents ──
  { name: "list_documents", description: "List documents in a collection (max 100)", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } },
  }},
  { name: "create_document", description: "Create a document", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "documentId", "data"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, documentId: { type: "string" }, data: { type: "object" }, permissions: { type: "array", items: { type: "string" } } },
  }},
  { name: "get_document", description: "Get a single document by ID", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId", "documentId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, documentId: { type: "string" } } } },
  { name: "update_document", description: "Update a document", inputSchema: {
    type: "object", required: ["projectId", "databaseId", "collectionId", "documentId", "data"],
    properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, documentId: { type: "string" }, data: { type: "object" } },
  }},
  { name: "delete_document", description: "Delete a document", inputSchema: { type: "object", required: ["projectId", "databaseId", "collectionId", "documentId"], properties: { projectId: { type: "string" }, databaseId: { type: "string" }, collectionId: { type: "string" }, documentId: { type: "string" } } } },

  // ── Users ──
  { name: "list_users", description: "List users in a project", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" }, search: { type: "string" }, limit: { type: "number" } } } },
  { name: "create_user", description: "Create a user", inputSchema: {
    type: "object", required: ["projectId", "userId", "email", "password"],
    properties: { projectId: { type: "string" }, userId: { type: "string" }, email: { type: "string" }, password: { type: "string" }, name: { type: "string" } },
  }},
  { name: "get_user", description: "Get user by ID", inputSchema: { type: "object", required: ["projectId", "userId"], properties: { projectId: { type: "string" }, userId: { type: "string" } } } },
  { name: "delete_user", description: "Delete a user", inputSchema: { type: "object", required: ["projectId", "userId"], properties: { projectId: { type: "string" }, userId: { type: "string" } } } },

  // ── Storage ──
  { name: "list_buckets", description: "List storage buckets", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } },
  { name: "create_bucket", description: "Create a storage bucket", inputSchema: {
    type: "object", required: ["projectId", "bucketId", "name"],
    properties: { projectId: { type: "string" }, bucketId: { type: "string" }, name: { type: "string" }, permissions: { type: "array", items: { type: "string" } }, maximumFileSize: { type: "number" }, allowedFileExtensions: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" } },
  }},
  { name: "delete_bucket", description: "Delete a storage bucket", inputSchema: { type: "object", required: ["projectId", "bucketId"], properties: { projectId: { type: "string" }, bucketId: { type: "string" } } } },
];

// ─── Tool handler ─────────────────────────────────────────
async function handleTool(name, a) {
  return withAuth(async () => {
    const C = (path, opts) => appwriteFetch(path, opts);
    const P = (pid, path, opts) => appwriteFetch(path, { ...opts, projectId: pid });
    const db = (pid, p, o) => P(pid, `/databases${p}`, o);
    const col = (pid, did, p, o) => db(pid, `/${did}/collections${p}`, o);
    const attr = (pid, did, cid, p, o) => col(pid, did, `/${cid}/attributes${p}`, o);
    const doc = (pid, did, cid, p, o) => col(pid, did, `/${cid}/documents${p}`, o);
    const idx = (pid, did, cid, p, o) => col(pid, did, `/${cid}/indexes${p}`, o);

    switch (name) {
      // Projects
      case "list_projects": return C("/projects");
      case "create_project": return C("/projects", { method: "POST", body: { projectId: a.projectId, name: a.name, teamId: a.teamId, region: a.region || "default" } });
      case "get_project": return C(`/projects/${a.projectId}`);
      case "update_project": return C(`/projects/${a.projectId}`, { method: "PATCH", body: { name: a.name, description: a.description } });
      case "delete_project": return C(`/projects/${a.projectId}`, { method: "DELETE" });

      // Keys
      case "list_keys": return C(`/projects/${a.projectId}/keys`);
      case "create_key": return C(`/projects/${a.projectId}/keys`, { method: "POST", body: { name: a.name, scopes: a.scopes } });
      case "delete_key": return C(`/projects/${a.projectId}/keys/${a.keyId}`, { method: "DELETE" });

      // Platforms
      case "list_platforms": return C(`/projects/${a.projectId}/platforms`);
      case "create_platform": return C(`/projects/${a.projectId}/platforms`, { method: "POST", body: { type: a.type, name: a.name, hostname: a.hostname } });
      case "delete_platform": return C(`/projects/${a.projectId}/platforms/${a.platformId}`, { method: "DELETE" });

      // Databases
      case "list_databases": return db(a.projectId, "");
      case "create_database": return db(a.projectId, "", { method: "POST", body: { databaseId: resolveId(a.databaseId), name: a.name } });
      case "update_database": return db(a.projectId, `/${a.databaseId}`, { method: "PUT", body: { name: a.name } });
      case "delete_database": return db(a.projectId, `/${a.databaseId}`, { method: "DELETE" });

      // Collections
      case "list_collections": return col(a.projectId, a.databaseId, "");
      case "create_collection": return col(a.projectId, a.databaseId, "", { method: "POST", body: { collectionId: resolveId(a.collectionId), name: a.name, permissions: a.permissions, documentSecurity: a.documentSecurity } });
      case "update_collection": return col(a.projectId, a.databaseId, `/${a.collectionId}`, { method: "PUT", body: { name: a.name, permissions: a.permissions } });
      case "delete_collection": return col(a.projectId, a.databaseId, `/${a.collectionId}`, { method: "DELETE" });

      // Attributes
      case "list_attributes": return attr(a.projectId, a.databaseId, a.collectionId, "");
      case "create_string_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/string", { method: "POST", body: { key: a.key, size: a.size, required: a.required, default: a.default ?? null, array: a.array ?? false } });
      case "create_integer_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/integer", { method: "POST", body: { key: a.key, required: a.required, min: a.min, max: a.max, default: a.default ?? null } });
      case "create_float_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/float", { method: "POST", body: { key: a.key, required: a.required, min: a.min, max: a.max, default: a.default ?? null } });
      case "create_boolean_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/boolean", { method: "POST", body: { key: a.key, required: a.required, default: a.default ?? null } });
      case "create_email_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/email", { method: "POST", body: { key: a.key, required: a.required } });
      case "create_url_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/url", { method: "POST", body: { key: a.key, required: a.required } });
      case "create_datetime_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/datetime", { method: "POST", body: { key: a.key, required: a.required } });
      case "create_enum_attribute": return attr(a.projectId, a.databaseId, a.collectionId, "/enum", { method: "POST", body: { key: a.key, elements: a.elements, required: a.required, default: a.default ?? null } });
      case "delete_attribute": return attr(a.projectId, a.databaseId, a.collectionId, `/${a.key}`, { method: "DELETE" });

      // Indexes
      case "list_indexes": return idx(a.projectId, a.databaseId, a.collectionId, "");
      case "create_index": return idx(a.projectId, a.databaseId, a.collectionId, "", { method: "POST", body: { key: a.key, type: a.type, attributes: a.attributes, orders: a.orders } });
      case "delete_index": return idx(a.projectId, a.databaseId, a.collectionId, `/${a.key}`, { method: "DELETE" });

      // Documents
      case "list_documents": {
        const params = [];
        if (a.limit) params.push(`queries[]=${encodeURIComponent(`{"method":"limit","values":[${a.limit}]}`)}`);
        if (a.offset) params.push(`queries[]=${encodeURIComponent(`{"method":"offset","values":[${a.offset}]}`)}`);
        const qs = params.length ? `?${params.join("&")}` : "";
        return doc(a.projectId, a.databaseId, a.collectionId, qs);
      }
      case "create_document": return doc(a.projectId, a.databaseId, a.collectionId, "", { method: "POST", body: { documentId: resolveId(a.documentId), data: a.data, permissions: a.permissions } });
      case "get_document": return doc(a.projectId, a.databaseId, a.collectionId, `/${a.documentId}`);
      case "update_document": return doc(a.projectId, a.databaseId, a.collectionId, `/${a.documentId}`, { method: "PATCH", body: { data: a.data } });
      case "delete_document": return doc(a.projectId, a.databaseId, a.collectionId, `/${a.documentId}`, { method: "DELETE" });

      // Users
      case "list_users": {
        const params = [];
        if (a.search) params.push(`search=${encodeURIComponent(a.search)}`);
        if (a.limit) params.push(`queries[]=${encodeURIComponent(`{"method":"limit","values":[${a.limit}]}`)}`);
        const qs = params.length ? `?${params.join("&")}` : "";
        return P(a.projectId, `/users${qs}`);
      }
      case "create_user": return P(a.projectId, "/users", { method: "POST", body: { userId: resolveId(a.userId), email: a.email, password: a.password, name: a.name } });
      case "get_user": return P(a.projectId, `/users/${a.userId}`);
      case "delete_user": return P(a.projectId, `/users/${a.userId}`, { method: "DELETE" });

      // Storage
      case "list_buckets": return P(a.projectId, "/storage/buckets");
      case "create_bucket": return P(a.projectId, "/storage/buckets", { method: "POST", body: { bucketId: resolveId(a.bucketId), name: a.name, permissions: a.permissions, maximumFileSize: a.maximumFileSize, allowedFileExtensions: a.allowedFileExtensions, enabled: a.enabled ?? true } });
      case "delete_bucket": return P(a.projectId, `/storage/buckets/${a.bucketId}`, { method: "DELETE" });

      default: throw new Error(`Unknown tool: ${name}`);
    }
  });
}

// ─── MCP Server ───────────────────────────────────────────
const server = new Server(
  { name: "appwrite-mcp-admin", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
