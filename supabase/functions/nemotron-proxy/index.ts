// ============================================================================
// nemotron-proxy — Supabase Edge Function (Deno)
//
// NVIDIA-hosted Nemotron backend, a drop-in alternative to claude-proxy. Same
// server-side funnel and the same { ok, text, content, usage, stop_reason }
// response shape, so switching is just a client config flip
// (AAA_CONFIG.set({ aiProvider: 'nemotron' })). The NVIDIA key never reaches
// the browser; token usage is logged to public.ai_costs.
//
// Deploy:  supabase functions deploy nemotron-proxy --no-verify-jwt
// Secrets: supabase secrets set NVIDIA_API_KEY=nvapi-...
//          (optional) supabase secrets set NEMOTRON_MODEL=nvidia/<served-name>
//
// Request body: { system?, messages, model?, max_tokens?, agent?, workspace_id? }
//
// NOTE: the translation logic here is a Deno/TS port of
// functions/nemotron-translate.js (kept in sync with the Firebase/Netlify
// proxies, which share the JS module). Deno can't require() the CJS module, so
// the pure functions are mirrored below — change both together.
// ============================================================================

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("NEMOTRON_MODEL") ||
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function toOpenAIContent(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" && b.source) {
      const s = b.source;
      const url = s.type === "base64"
        ? `data:${s.media_type || "image/jpeg"};base64,${s.data || ""}`
        : (s.url || "");
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length && parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("");
  }
  return parts;
}

function resolveModel(requested: any): string {
  const m = typeof requested === "string" ? requested : "";
  if (/^nvidia\//i.test(m) || /nemotron/i.test(m)) return m;
  return DEFAULT_MODEL;
}

function toRequest(body: any): Record<string, unknown> {
  const messages: any[] = [];
  if (body.system) messages.push({ role: "system", content: String(body.system) });
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    if (!m || !m.role) continue;
    const role = m.role === "assistant" ? "assistant" : (m.role === "system" ? "system" : "user");
    messages.push({ role, content: toOpenAIContent(m.content) });
  }
  return {
    model: resolveModel(body.model),
    messages,
    max_tokens: body.max_tokens || 1024,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.6,
  };
}

function fromResponse(data: any) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = (choice && choice.message) ? choice.message : {};
  const text = typeof msg.content === "string" ? msg.content : "";
  const u = (data && data.usage) ? data.usage : {};
  const out: any = {
    ok: true,
    text,
    content: text ? [{ type: "text", text }] : [],
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
    stop_reason: choice ? choice.finish_reason : undefined,
  };
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    out.reasoning = msg.reasoning_content;
  }
  return out;
}

async function logCost(usage: any, model: string, agent: string | undefined, workspaceId: string | undefined) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !usage) return;
  // Hosted-Nemotron pricing varies by provider/contract; log token counts with
  // usd=0 rather than inventing a rate. Set it once you know your rate.
  try {
    await fetch(`${url}/rest/v1/ai_costs`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({
        workspace_id: workspaceId ?? null, agent: agent ?? null, model,
        input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, usd: 0,
      }),
    });
  } catch (_) { /* cost logging is best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  const apiKey = Deno.env.get("NVIDIA_API_KEY");
  if (!apiKey) return json({ ok: false, error: "MISSING_API_KEY", message: "Set NVIDIA_API_KEY via supabase secrets." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json({ ok: false, error: "NO_MESSAGES" }, 400);
  }

  const payload = toRequest(body);

  try {
    const res = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: "NVIDIA_ERROR", detail: data }, res.status);

    const out = fromResponse(data);
    await logCost(out.usage, payload.model as string, body.agent, body.workspace_id);
    return json(out);
  } catch (err) {
    return json({ ok: false, error: "PROXY_FAILED", message: String((err as Error)?.message || err) }, 502);
  }
});
