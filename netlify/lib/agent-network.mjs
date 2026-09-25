import { OpenAIError } from './openai.mjs';

// Bound streamed provider/MCP responses as well as Content-Length. A remote
// tool cannot make the function buffer arbitrary amounts of data.
export async function boundedFetch(fetchImpl, url, init, limit = 2000000) {
  const response = await fetchImpl(url, init);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new OpenAIError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new OpenAIError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    controller.enqueue(chunk);
  } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
