// ============================================================================
// claude-proxy — Supabase Edge Function (Deno)
//
// The single, server-side funnel for every Claude call in the app. The
// Anthropic API key never reaches the browser. Token usage is logged to
// public.ai_costs for the Data Scientist / Accounting agents.
//
// Deploy:  supabase functions deploy claude-proxy --no-verify-jwt
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//          (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically)
//
// Request body: { system?, messages, model?, max_tokens?, agent?, workspace_id? }
// ============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-8";

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

async function logCost(usage: any, model: string, agent: string | undefined, workspaceId: string | undefined) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !usage) return;
  // Opus 4.8 pricing: $5 / 1M input, $25 / 1M output.
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const usd = (inTok * 5 + outTok * 25) / 1_000_000;
  try {
    await fetch(`${url}/rest/v1/ai_costs`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({
        workspace_id: workspaceId ?? null, agent: agent ?? null, model,
        input_tokens: inTok, output_tokens: outTok, usd,
      }),
    });
  } catch (_) { /* cost logging is best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "MISSING_API_KEY", message: "Set ANTHROPIC_API_KEY via supabase secrets." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json({ error: "NO_MESSAGES" }, 400);
  }

  const model = body.model || DEFAULT_MODEL;
  const payload: Record<string, unknown> = {
    model,
    max_tokens: body.max_tokens || 1024,
    messages: body.messages,
  };
  if (body.system) payload.system = body.system;
  if (body.output_config) payload.output_config = body.output_config;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: "ANTHROPIC_ERROR", detail: data }, res.status);

    await logCost(data.usage, model, body.agent, body.workspace_id);

    const text = Array.isArray(data.content)
      ? data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : "";
    return json({ ok: true, text, content: data.content, usage: data.usage, stop_reason: data.stop_reason });
  } catch (err) {
    return json({ ok: false, error: "PROXY_FAILED", message: String((err as Error)?.message || err) }, 502);
  }
});
