# Task assistant

The mobile Chat screen can now complete bounded tasks using real server-side tool calls. It shows progress, action receipts, downloadable files, saved results, and review controls for configured external actions. Business briefings remain available in the mode selector.

## Model choices

Reviewed September 22, 2026. These are three leading downloadable-weight models on the [Artificial Analysis open-model intelligence leaderboard](https://artificialanalysis.ai/models/open-source), available through one OpenRouter account. Benchmark leadership is a selection criterion, not a guarantee for every workload. OpenRouter routing and default reasoning settings may differ from the settings used in the leaderboard.

| Model | Exact API ID | Weight license |
| --- | --- | --- |
| [MiMo-V2.6-Pro](https://openrouter.ai/xiaomi/mimo-v2.6-pro) | `xiaomi/mimo-v2.6-pro` | [MIT](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL) |
| [GLM-5.3](https://openrouter.ai/z-ai/glm-5.3) | `z-ai/glm-5.3` | [Custom GLM-5.3 license](https://huggingface.co/zai-org/GLM-5.3/blob/main/LICENSE) |
| [Kimi K3](https://openrouter.ai/moonshotai/kimi-k3) | `moonshotai/kimi-k3` | [Custom Kimi K3 license](https://huggingface.co/moonshotai/Kimi-K3/blob/main/LICENSE) |

The UI calls these **open-weight choices** because downloadable weights do not make every license unrestricted open source. Hosted API inference is paid. No model weights are downloaded into the PWA.

Select a model in Chat. Missing credentials disable the corresponding options. An explicitly selected model is never silently replaced; an incompatible workspace policy returns an error. Automatic mode considers existing preferences and configured models. Existing GPT-6 Astra and Claude choices remain available with their own server credentials.

OpenRouter uses its native tool-calling conversation format and preserves private reasoning continuation between tool calls. It requests providers that support the parameters and disallow data collection. These routing filters are not a zero-retention guarantee. There is no automatic fallback to an unrelated model.

## Activation

1. Create or sign in to the app owner's [OpenRouter account](https://openrouter.ai/). The owner completes identity verification and accepts any account terms. Create a dedicated API key for this app with an account-appropriate spending limit. Adding credits requires a separate payment decision.
2. Store the key as the secret **`OPENROUTER_API_KEY`** in the intended Netlify project's environment, scoped to **Functions** and the intended deploy context. Do not put it in source code, app settings, chat messages, or a browser bundle. One key serves all three models. `OPENROUTER_BASE_URL` is optional; the default is `https://openrouter.ai/api/v1`.
3. Keep the app's existing server-verified identity setup. The task endpoint uses `APP_ALLOWED_USER_IDS` (comma-separated identity IDs) and `APP_AUTH_PROVIDER` (`firebase` or `supabase`). Existing `OPENAI_ALLOWED_USER_IDS` and `OPENAI_AUTH_PROVIDER` work as fallback settings. Firebase also needs `FIREBASE_PROJECT_ID` and `FIREBASE_WEB_API_KEY`; Supabase needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Browser role flags do not grant API access.
4. Build and deploy the reviewed branch to the intended project when hosting is active. Sign in through Cloud Settings, open Chat, and select the desired model. The capability panel reports configuration, not a successful live connection.
5. Run a small calculation/file task on each model before enabling additional connections. Confirm the result, receipt, download, and provider usage. A rejected key, missing credits, rate limit, refusal or incomplete response produces an error rather than fabricated success.

The existing OpenAI and Anthropic integrations use `OPENAI_API_KEY` / `OPENAI_BASE_URL` and `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`. The three open-weight choices use the separate OpenRouter endpoint, not an assumption that Netlify AI Gateway supports their IDs.

## Included tools and skills

| Tool | Result |
| --- | --- |
| `business_records` | Reads an optional user-selected snapshot of jobs, customers and outcomes; 100 records per collection, 20 per tool page. |
| `calculate` | Finite arithmetic without evaluating code. |
| `read_file` | Reads attached text/data/source files in 12,000-character pages. |
| `create_file` | Creates downloadable text, Markdown, CSV, JSON and source files. |
| `load_skill` | Loads one of the four bundled instruction files when needed. |
| `search_memory` | Retrieves this account/workspace's saved lessons and simulation records. |
| `remember_lesson` | Saves a candidate lesson with evidence, limitations and run provenance. |
| `simulate_ads` | Runs up to 100 reproducible synthetic scenarios and saves the assumptions and summary. |
| `research` | Calls a separately configured research service. |
| `discover_tools` | Discovers allowlisted schemas from a configured MCP connection. |
| `connected_tool` | Executes a discovered, permitted MCP tool; configured writes require exact-action review. |

The four bundled [Agent Skills](https://agentskills.io/specification) are business operations, research/documents, ads simulation, and software/browser workflows. Their `SKILL.md` files ship with the function and are loaded progressively. Tools use the official open-source [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [Ajv](https://github.com/ajv-validator/ajv) for protocol handling and argument validation.

Attachments are limited to three text/data/source files, 100 KB each and 200 KB total in the UI. Generated files are limited to eight per task and 80,000 characters each. PDF/Word/Excel parsing and arbitrary code execution require additional purpose-built services. Generated HTML and source files are downloaded as inert text; they are not run or deployed by this tool.

## External connections

Tools are available only when a real service is configured. Set `AIQ_RESEARCH_URL` to a trusted HTTPS service accepting `POST {"message":"query"}` and optionally set `AIQ_RESEARCH_TOKEN`. Its response should contain usable sources; the model is instructed not to invent citations.

For MCP, set `AGENT_MCP_SERVERS` to a JSON array with at most eight entries. Keep credentials in separate secret variables. Example configuration for the official [GitHub MCP server](https://github.com/github/github-mcp-server):

```json
[
  {
    "id": "github",
    "label": "GitHub",
    "url": "https://api.githubcopilot.com/mcp/",
    "tokenEnv": "AGENT_GITHUB_TOKEN",
    "users": ["REPLACE_WITH_OWNER_ID"],
    "readTools": ["get_file_contents"],
    "reviewTools": ["issue_write"]
  }
]
```

Use a token restricted to the intended repositories and permissions. Verify tool names against the deployed server's current catalog. The app permits only names present in both that catalog and these deployment-owned lists. Keep writes in `reviewTools`; remote tool annotations do not decide permission. Discovery and calls use authenticated Streamable HTTP, not local stdio servers. Connection URLs, tokens, users and tool policy cannot be supplied by the model or browser.

The official open-source [Playwright MCP server](https://github.com/microsoft/playwright-mcp) can supply browser actions through a separately hosted, authenticated service. Hosting that service is a separate setup step. Isolate its browser context per account/session, constrain network access, and put navigation/input/actions that can change external state in `reviewTools`. Do not expose a shared logged-in browser or an unprotected MCP port. Server session idle expiry is required: this client disconnects between steps, retains each task's session ID privately, and does not terminate it after every call.

MCP results currently consume bounded text blocks. Images, resource links and non-text blocks are not followed. No arbitrary URL fetch, shell, self-installation or unrestricted file-system tool is included.

## Learning and simulations

The assistant can choose `simulate_ads` itself during a user-started task. A seed makes all 100 cases reproducible. Each case independently varies CPC and conversion rate by ±20% and close rate by ±10%, then computes expected fractional jobs and contribution after ad spend. `profit_per_job` means contribution before ad spend, not revenue. This is sensitivity analysis under supplied assumptions, not a fitted auction model, observed campaign results or a probability forecast.

Memory persists in site-scoped Netlify Blobs across tasks and deploys, isolated by account and workspace. It retains the most recent 200 entries. Simulations save assumptions, summary and limitations automatically. Lessons remain unverified candidates with evidence; retrieving a lesson does not turn it into an instruction or a validated rule. This does not train model weights or automatically rewrite skills. There is no unattended recurring simulation scheduler in this change.

## Execution, review and storage

`POST /api/agent` supports capabilities, start, status, advance, approve, reject and cancel. The server owns the transcript, tools, call arguments, revisions and execution budget. Each request advances one model call or one tool action; the browser drives the loop and can pause/resume. Closing the app stops future steps, although an in-flight action may finish. Offline messages retain a stable task ID and wait for explicit queue replay.

Each run allows six model calls and twelve tool executions. A 60,000 reported-token threshold is checked between steps, so one response can overshoot it; it is not a dollar spending cap. Provider requests have a 40-second timeout. Use provider-side spending controls. Existing account rate limits also apply.

External review binds the displayed arguments to the authenticated account, run, call ID and revision. Review expires after ten minutes; approval authorizes execution for two minutes. Strong reads, conditional writes and leases prevent concurrent tabs from repeating an action. An interrupted or uncommitted external call is marked as having an unknown outcome and is not automatically retried; check the destination before starting another task.

Execution expires after 24 hours. This is not a data deletion schedule: stored run results, generated files and saved lessons remain until managed separately. Successful completion or cancellation discards attached input files, business snapshots and private provider transcripts from the stored run. Failed/limited/interrupted runs can retain working data. Chat history and results also persist in the app's local storage. No automated retention cleanup or memory-management UI is included.

## Verification

```sh
npm ci
npm test
npm run build:check
```

`test/agent/*.test.mjs` exercises the real runtime, tool execution, all three OpenRouter model contracts, native OpenAI/Anthropic tool loops, private reasoning continuation, account isolation, exact-action review, concurrency, uncertain outcomes, limits, reproducible 100-case simulations and durable candidate memory. The MCP transport tests use the official SDK against deterministic protocol fixtures. Provider responses are fixtures; these tests do not establish live model availability, quality or billing.

The optional `test/agent/chat-browser.mjs` exercises the real mobile DOM and runtime with fixture providers: downloads, reload persistence, approval/execution, escaped output, offline replay and a 393px viewport. Run with an installed Playwright package, or point `PLAYWRIGHT_MODULE` to its ESM entry and optionally `PLAYWRIGHT_EXECUTABLE` to Chromium. This browser check does not replace live deployment smoke testing.
