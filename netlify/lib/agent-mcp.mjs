import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { OpenAIError } from './openai.mjs';
import { validateJson } from './request-policy.mjs';
import { boundedFetch } from './agent-network.mjs';

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const toolName = /^[a-zA-Z0-9_.:/-]{1,128}$/;

// URLs, credentials and access policy come ONLY from deployment configuration.
export function connections(env, userId) {
  let list;
  try { list = JSON.parse(env.AGENT_MCP_SERVERS || '[]'); } catch (_) { throw new OpenAIError('INVALID_MCP_CONFIG', 503); }
  if (!Array.isArray(list) || list.length > 8) throw new OpenAIError('INVALID_MCP_CONFIG', 503);
  const seen = new Set();
  return list.map(c => {
    let url;
    try { url = new URL(c.url); } catch (_) { throw new OpenAIError('INVALID_MCP_CONFIG', 503); }
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(c.id) || seen.has(c.id) || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      /(^localhost$|\.localhost$|\.local$|\.internal$|^[\d.]+$|:)/i.test(url.hostname) || !Array.isArray(c.users) || !c.users.length ||
      !/^[A-Z][A-Z0-9_]*$/.test(c.tokenEnv || '') ||
      !['readTools', 'reviewTools'].every(k => Array.isArray(c[k]) && c[k].length <= 40 && c[k].every(n => typeof n === 'string' && toolName.test(n))) ||
      c.readTools.some(n => c.reviewTools.includes(n))) throw new OpenAIError('INVALID_MCP_CONFIG', 503);
    seen.add(c.id);
    return { id: c.id, label: String(c.label || c.id).slice(0, 80), url: url.href, token: env[c.tokenEnv], readTools: c.readTools, reviewTools: c.reviewTools, users: c.users };
  }).filter(c => c.users.includes(userId));
}

export function connectionFor(env, userId, id) {
  const connection = connections(env, userId).find(c => c.id === id);
  if (!connection || !connection.token) throw new OpenAIError('CONNECTION_NOT_CONFIGURED', 503);
  return connection;
}

export function requiresReview(connection, name) {
  if (connection.readTools.includes(name)) return false;
  if (connection.reviewTools.includes(name)) return true;
  throw new OpenAIError('TOOL_NOT_ALLOWED', 403);
}

// SDK connect() resumes an existing transport session without re-initializing.
// Restore only the tool capability checks through its protected extension point;
// no private SDK fields or server-provided instructions are restored.
class TaskMcpClient extends Client {
  constructor(saved) { super({ name: 'aaa-hyperkernel', version: '1.0.0' }); this.savedCapabilities = saved?.capabilities; }
  assertCapabilityForMethod(method) {
    if (this.savedCapabilities && ['tools/list', 'tools/call'].includes(method)) {
      if (!this.savedCapabilities.tools) throw new OpenAIError('MCP_TOOLS_UNAVAILABLE', 502);
      return;
    }
    return super.assertCapabilityForMethod(method);
  }
}

export async function withMcp(connection, action, { fetchImpl = fetch, state = {} } = {}) {
  const target = new URL(connection.url);
  const fingerprint = createHash('sha256').update(connection.url + '\n' + connection.token).digest('hex');
  const saved = state.fingerprint === fingerprint && state.sessionId ? state : null;
  const timeout = AbortSignal.timeout(18000);
  const transport = new StreamableHTTPClientTransport(target, {
    ...(saved ? { sessionId: saved.sessionId } : {}),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    requestInit: { headers: { authorization: 'Bearer ' + connection.token } },
    fetch: (url, init) => {
      const next = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      if (next.origin !== target.origin || next.pathname !== target.pathname) throw new OpenAIError('MCP_DESTINATION_DENIED', 403);
      return boundedFetch(fetchImpl, url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
    }
  });
  if (saved) transport.setProtocolVersion(saved.protocolVersion);
  const client = new TaskMcpClient(saved);
  try {
    await client.connect(transport, { timeout: 12000 });
    if (transport.sessionId) Object.assign(state, { fingerprint, sessionId: transport.sessionId, protocolVersion: transport.protocolVersion, capabilities: client.getServerCapabilities() || saved?.capabilities });
    return await action(client);
  } catch (error) {
    if (error instanceof OpenAIError) throw error;
    throw new OpenAIError('MCP_UNAVAILABLE', 502); // Never reflect remote errors or tokens.
  } finally { await client.close().catch(() => {}); }
}

async function allowedTools(client, connection) {
  const allowed = new Set([...connection.readTools, ...connection.reviewTools]);
  const found = [], cursors = new Set();
  let cursor;
  for (let page = 0; page < 4; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
    found.push(...result.tools.filter(t => allowed.has(t.name)));
    if (!result.nextCursor || cursors.has(result.nextCursor)) break;
    cursor = result.nextCursor; cursors.add(cursor);
  }
  return found;
}

export async function discover(connection, options) {
  return withMcp(connection, async client => {
    const tools = await allowedTools(client, connection);
    return tools.map(t => ({ name: t.name, description: String(t.description || '').slice(0, 1000), inputSchema: t.inputSchema, requiresReview: requiresReview(connection, t.name) }));
  }, options);
}

export async function callConnected(connection, name, args, options) {
  requiresReview(connection, name);
  validateJson(args);
  return withMcp(connection, async client => {
    const tool = (await allowedTools(client, connection)).find(t => t.name === name);
    if (!tool) throw new OpenAIError('TOOL_NOT_AVAILABLE', 404);
    let valid;
    try { valid = ajv.compile(tool.inputSchema)(args); } catch (_) { throw new OpenAIError('INVALID_REMOTE_SCHEMA', 502); }
    if (!valid) throw new OpenAIError('INVALID_TOOL_ARGUMENTS');
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
    // Keep remote content inert and bounded. Do not follow resource links.
    const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    return { ok: !result.isError, text: text.slice(0, 24000), truncated: text.length > 24000 };
  }, options);
}
