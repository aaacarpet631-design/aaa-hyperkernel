import { OpenAIError } from './openai.mjs';
import { boundedFetch } from './agent-network.mjs';
import { OPEN_MODELS } from './agent-models.mjs';

// OpenRouter's native Chat Completions tool contract, including reasoning
// continuation. The API key stays on the server and is never a chat field.
export async function openRouterStep(run, tools, system, { env, fetchImpl = fetch }) {
  if (!OPEN_MODELS.includes(run.model)) throw new OpenAIError('UNSUPPORTED_MODEL');
  if (!env.OPENROUTER_API_KEY) throw new OpenAIError('AGENT_MODEL_NOT_CONFIGURED', 503);
  let url;
  try { url = new URL((env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/chat/completions'); }
  catch (_) { throw new OpenAIError('INVALID_AGENT_PROVIDER_CONFIG', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new OpenAIError('INVALID_AGENT_PROVIDER_CONFIG', 503);
  const payload = { model: run.model, messages: [{ role: 'system', content: system }, ...run.transcript],
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 8192,
    provider: { require_parameters: true, data_collection: 'deny' } };
  let response;
  try {
    response = await boundedFetch(fetchImpl, url.href, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'X-OpenRouter-Title': 'AAA HyperKernel' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(40000) });
  } catch (_) { throw new OpenAIError('AGENT_PROVIDER_UNAVAILABLE', 502); }
  if (!response.ok) {
    const code = response.status === 402 ? 'OPENROUTER_CREDITS_REQUIRED' : response.status === 401 ? 'INVALID_PROVIDER_KEY' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'AGENT_PROVIDER_ERROR';
    throw new OpenAIError(code, response.status === 429 ? 429 : 502);
  }
  let data;
  try { data = await response.json(); } catch (_) { throw new OpenAIError('INVALID_AGENT_RESPONSE', 502); }
  if (data.error) throw new OpenAIError('AGENT_PROVIDER_ERROR', 502);
  const choice = data.choices?.[0], message = choice?.message;
  if (!message || message.role !== 'assistant' || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new OpenAIError('PROVIDER_INCOMPLETE', 502);
  if (message.refusal) throw new OpenAIError('PROVIDER_REFUSAL', 422);
  const calls = (message.tool_calls || []).map(c => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments }));
  if (calls.length > 4 || new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => !c.id || typeof c.name !== 'string' || typeof c.arguments !== 'string' || c.arguments.length > 100000) ||
    (choice.finish_reason === 'tool_calls' && !calls.length) || (choice.finish_reason === 'stop' && calls.length)) throw new OpenAIError('INVALID_AGENT_RESPONSE', 502);
  const text = typeof message.content === 'string' ? message.content : '';
  if (!calls.length && !text) throw new OpenAIError('EMPTY_OUTPUT', 502);
  // Reasoning is retained privately for the model, never exposed in task cards.
  const output = { role: 'assistant', content: message.content || null };
  for (const key of ['tool_calls', 'reasoning_details', 'reasoning', 'reasoning_content']) if (message[key] != null) output[key] = message[key];
  return { output, calls, text, usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 } };
}
