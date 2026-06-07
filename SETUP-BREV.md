# AAA HyperKernel — Private GPU host on NVIDIA Brev (provisioning the P24 backend)

The **Governed Private GPU model provider** (P24) lets the app run an
OpenAI-compatible model on a GPU you own, behind the same server-side funnel as
every other provider. The app never sees the GPU URL or key — it POSTs the app
shape to a same-origin proxy (`/api/private-gpu`), and **that** proxy holds
`PRIVATE_GPU_MODEL_URL` / `PRIVATE_GPU_MODEL_KEY` and talks to the GPU server.

This guide covers the one piece P24 deliberately left out: **how to stand up the
GPU host** — using [NVIDIA **Brev**](https://developer.nvidia.com/brev), which
provisions a GPU instance, drops you into a shell, and gives you a reachable
host. The doc's contract (env vars, port, wire shape) is exactly what
`netlify/functions/private-gpu.mjs` and `functions/private-gpu-translate.js`
already expect — no app or proxy code changes.

## How it fits

```
AAA frontend → runtime gateway → AAA_GOVERNED_MODEL_ROUTER
            → private-gpu adapter → /api/private-gpu (server-side proxy)
            → http://<brev-host>:8000/v1/chat/completions   (this guide)
```

The proxy is the only thing that knows the GPU's URL + key. Port **8000** is
**not** public — only the backend's egress IP may reach it (see step 4).

## 0. Install the Brev CLI and sign in

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/brevdev/brev-cli/main/bin/install-latest.sh)"
brev login        # opens browser auth; ties the CLI to your NVIDIA/Brev account
brev refresh      # pull down current org + instance state
brev ls           # list your instances (status, GPU, public/SSH details)
```

## 1. Create a GPU instance

Pick a GPU sized to the model you intend to serve. A single L40S / A100-40GB
comfortably serves a 7–8B instruct model; larger models need more VRAM or
tensor-parallel across multiple GPUs.

```bash
# Create, then shell in (replace with a name you'll recognize in `brev ls`):
brev create aaa-gpu --gpu <type>      # e.g. L40S / A100 — see `brev create --help`
brev shell aaa-gpu                    # SSH into the instance
```

> If you provisioned the box elsewhere (another cloud, on-prem), skip Brev's
> create/shell and just make sure the box exposes step 2's endpoint to your
> backend's egress IP. The proxy doesn't care *how* the host exists.

## 2. Serve an OpenAI-compatible endpoint on port 8000

The proxy speaks **OpenAI `/v1/chat/completions`**. Anything that exposes that
shape works (vLLM, NVIDIA NIM, TGI, llama.cpp's server). vLLM is the simplest:

```bash
# inside `brev shell`
pip install vllm
export GPU_API_KEY="$(openssl rand -hex 24)"   # this becomes PRIVATE_GPU_MODEL_KEY
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Meta-Llama-3.1-8B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --api-key "$GPU_API_KEY"
```

Sanity-check it **on the box** before exposing it:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "authorization: Bearer $GPU_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"local-model","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":16}'
```

The `model` field is forwarded as-is; the proxy falls back to `PRIVATE_GPU_MODEL`
(or `local-model`) when the app doesn't pin one, so set the served name to match
whatever you launched vLLM with.

## 3. Get a backend-reachable URL

The proxy fetches `PRIVATE_GPU_MODEL_URL` server-side, so it needs an address
**your serverless backend** can reach — not your laptop.

- **Brev public/SSH host:** `brev ls` shows the instance's host. Use its public
  hostname/IP: `http://<host>:8000` (the proxy appends `/v1/chat/completions`).
- **No public IP / private subnet:** put the GPU and the backend in the same VPC,
  or front the box with your own TLS reverse proxy and use `https://<host>`.

`endpointFor()` accepts either the base (`http://host:8000`) or the full
`.../v1/chat/completions` URL — give it the base.

## 4. Lock the port to the backend only (required)

P24's threat model assumes **port 8000 is not public**. Restrict it to your
backend's egress IP. With Brev:

```bash
brev ls                       # note the instance / firewall context
# In Brev's instance settings (or the underlying cloud security group),
# allow inbound TCP 8000 ONLY from your backend egress CIDR; deny 0.0.0.0/0.
```

The `--api-key` is defense in depth, not the perimeter — keep the network rule.

## 5. Configure the proxy (server-side env)

Set these where your `/api/private-gpu` function runs. **Netlify** (same deploy
as the app — the function is served at `/api/private-gpu`):

```bash
PRIVATE_GPU_MODEL_URL=http://<brev-host>:8000     # base; proxy adds /v1/chat/completions
PRIVATE_GPU_MODEL_KEY=<the GPU_API_KEY from step 2> # stays server-side, never in the browser
PRIVATE_GPU_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct   # optional default served name
PRIVATE_GPU_TIMEOUT_MS=30000                       # optional (default 30s)
```

Same variables for the Firebase/Supabase variants if that's your backend. With
none set, the proxy returns `GPU_NOT_CONFIGURED` (503) and the app falls back —
it never fabricates output.

## 6. Enable the model (owner)

The GPU model auto-appears in the **Model Governance** panel as
`privategpu.local` ("Private GPU Model (OpenAI-compatible)"). An owner with
`MANAGE_MODEL_SETTINGS` flips it **Enable** there — gateway-audited and
provenance-linked like every other model. It is **off by default**.

To install the transport explicitly (e.g. a non-default proxy path):

```js
AAA_PRIVATE_GPU_TRANSPORT.install({ endpoint: '/api/private-gpu' });
```

## 7. Verify end-to-end

```js
// 1) proxy reachable + GPU answering:
await AAA_PRIVATE_GPU_SEND({
  taskType: 'advisory',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_tokens: 16
});
// → { ok:true, text:'OK', usage:{ input_tokens, output_tokens }, ... }

// 2) breaker / health (Reliability Command Center reads the same metric):
AAA_PRIVATE_GPU_TRANSPORT.health();   // { installed:true, breaker:'closed', healthy:true, ... }
```

A down or unreachable GPU surfaces as `GPU_TIMEOUT` / `GPU_UNAVAILABLE`, opens
the circuit breaker, drives `gpu_model_health` to critical in the Reliability
Command Center, and the router falls back — the app shows "AI model unavailable",
never fake output.

## Notes & honest limits

- **Cost = your GPU hours.** Brev bills the instance while it runs; `brev stop`
  / `brev delete` when idle. The proxy logs token counts but no USD rate.
- **Persistence.** A stopped/deleted Brev instance loses its host; re-provision
  and update `PRIVATE_GPU_MODEL_URL`. Pin a static IP / DNS if you want stability.
- **CI needs no GPU.** With nothing configured the adapter returns a deterministic
  offline stub, so the suite stays green without a GPU.
- **Keep the key server-side.** `PRIVATE_GPU_MODEL_KEY` lives only in the proxy
  env, exactly like `ANTHROPIC_API_KEY` / `NVIDIA_API_KEY` — never in the browser.
</content>
</invoke>
