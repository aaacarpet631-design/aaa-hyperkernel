# AAA HyperKernel — GPT‑Level LLM System Architecture

**Status: design of record. Implementation‑oriented. Honest about scope.**
Audience: engineering + owner. Scope: a governed business‑intelligence and agentic
execution layer for **AAA Carpet Repair, Installation & Sales** — not a frontier model.

Legend: **[BUILT]** exists in the repo today · **[PARTIAL]** scaffolding exists, needs
feeding/hardening · **[GAP]** to build · **[FUTURE]** later, only if evals demand it.

---

## 0. Feasibility & what "GPT‑level" means here

We are **not** training a frontier model, and we don't need to.

| Interpretation | Real requirement | AAA reality | Verdict |
|---|---|---|---|
| Train a GPT‑4‑class base | ~10²⁵–10²⁶ FLOPs, 15–25k H100s for months, 10–15T tokens, RLHF + safety org, **$50–100M+** | one carpet company; ~10³–10⁴ records; 0 GPUs; 0 ML researchers | ❌ off by 5–7 orders of magnitude |
| Train a small base | $0.5–5M + specialized team | same | ❌ wrong problem |
| Fine‑tune open 7–13B on AAA data | cheap compute, but needs clean labels + eval + privacy + serving | thin, PII‑heavy data | ⚠️ usually **loses to retrieval + prompts**; defer **[FUTURE]** |
| **Orchestrate hosted/open models + retrieval + governance** | engineering + data discipline + evals; ~$ hundreds/mo | **what HyperKernel already is** | ✅ **the plan** |

**Definition of "GPT‑level for AAA HyperKernel":** a governed, retrieval‑grounded,
tool‑using system that **matches or beats a senior AAA estimator/CSR's median quality
on AAA's real tasks**, at lower latency and cost, with **auditable, reversible decisions
and fail‑closed safety**. A business brain on rails — not a general model.

**The real constraints are not model capability** but: (1) **data volume & label quality**,
(2) **evaluation rigor**, (3) **complexity management**. ~70% of this architecture is
already built; the high‑leverage work is the **data spine + eval harness**, then a few
grounded prompts. Adding more subsystems is the main risk, not weak models.

---

## 1. Architecture diagram (text)

```
                         ┌──────────────────────── OBSERVABILITY & COST ─────────────────────────┐
                         │  provenance · latency/$ traces · reliability-center · daily ledger audit │
                         └───────────────────────────────────────────────────────────────────────┘
   INGRESS                NORMALIZE+REDACT            MEMORY (source of truth)         RETRIEVAL
 ┌──────────┐  raw   ┌───────────────────┐   clean  ┌────────────────────────────┐  ┌──────────────┐
 │ website  │──────▶ │ sensing-ingress   │ ───────▶ │ STRUCTURED (Supabase/PG)   │  │ retrieve()   │
 │ Telegram │        │  → PII VAULT       │          │  leads/quotes/jobs/cust/   │◀─│ hybrid:      │
 │ SMS/call │        │  → redaction gate  │          │  invoices/outcomes/crew    │  │ BM25+vector  │
 │ photos   │        │  → event-bus(log)  │          ├────────────────────────────┤  │ +recency     │
 │ QuickBooks│       └───────────────────┘          │ VECTOR (embeddings)        │  │ +rerank      │
 │ Google BP │                                       │  pricebook/SOPs/won-lost/  │  └──────┬───────┘
 │ reviews  │                                        │  reviews/photos(captions)  │         │ grounded context
 └──────────┘                                        ├────────────────────────────┤         ▼
                                                      │ MEMORY tiers: short/long/  │  ┌──────────────────────────┐
                                                      │ structured/outcome/agent/  │  │   AGENT RUNTIME           │
                                                      │ audit                      │  │  router → planner → tools │
                                                      └────────────────────────────┘  │  → specialists → execute  │
                                                                                       └─────────┬────────────────┘
                                                                                                 │ proposed action / draft
   ┌──────────────────────── GOVERNANCE (fail-closed) ───────────────────────────────────────┐  │
   │ content-safety → human approval (assisted-draft-queue) → prompt registry → model registry │◀─┘
   │ → immutable audit ledger → escalation/override(justified) → rollback                       │
   └──────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                   │ APPROVED only
                                                   ▼
                              EGRESS: transport (SMS/email/Telegram) · quote · schedule
                                                   │
                                                   ▼   real-world result
                              OUTCOME LEARNING ──▶ EVAL SUITE (golden set + live metrics) ──▶ prompt/model updates
```

Cross‑cutting: **API gateway → model router → providers (frontier / cheap / local) with
fallback + cost caps.**

---

## 2. Model strategy + routing matrix

Principle: **cheapest model that passes the task's eval bar; escalate on low confidence;
frontier only where it pays.** Every call carries provenance + a token budget.

| Task | Tier | Example model | Retrieval | Fine‑tune | Status |
|---|---|---|---|---|---|
| Customer message **safety** | Local/Cheap | nvidia/nemotron‑3‑content‑safety | no | no | [BUILT] |
| Follow‑up / review‑request **draft** | Cheap | Haiku / 4o‑mini / Flash | yes | no | [BUILT] |
| **Estimate / quote reasoning** | Frontier (cheap fallback) | Sonnet/GPT‑4‑class → Haiku | **yes** | no | [PARTIAL] |
| **Photo → scope** (vision) | Frontier vision | Claude/GPT/Gemini vision | yes | no | [PARTIAL] |
| Job‑notes extraction | Cheap | mini/Flash, JSON‑schema | no | no | [BUILT] |
| Routing / planning | Cheap→Frontier | mini route, Sonnet hard plans | yes | no | [BUILT] |
| Marketing / SEO draft | Cheap | mini/Flash | yes | no | [PARTIAL] |
| Embeddings (all retrieval) | Local/Cheap | bge/e5/nomic or hosted | — | n/a | [PARTIAL] |
| Owner Q&A copilot | Frontier | Sonnet/GPT‑4‑class | **yes** | no | [BUILT] |
| Long‑run autonomous work | ❌ none | — | — | — | **forbidden** |

**Local models** (Termux/phone or small GPU box): embeddings, safety classifier, a
lights‑on fallback for offline degrade. **Never** the margin‑sensitive estimate path.

---

## 3. AAA Business Brain (company‑specific intelligence)

A unified read model over 11 domains + derived intelligence. Primitives exist; the
**[GAP]** is one coherent `BusinessBrain.context(entity)` the agents query.

| Domain | Source (built) | Derived intelligence |
|---|---|---|
| leads | `AAA_LEADS` | stage velocity, stall risk, source ROI |
| quotes | `quote-store`, `measurement-to-quote` | win‑probability, margin band |
| jobs | jobs, scheduling | profit vs estimate, callback risk |
| customers | `customer-store` | LTV, repeat propensity, sentiment |
| photos | vision HUD | scope tags, before/after evidence |
| reviews | review‑request engine | sentiment, response‑needed |
| pricing | rate card, pricing‑optimizer | margin floor, elasticity |
| outcomes | `outcome-learning-store`, scorecards | win/loss drivers, agent accuracy |
| crew capacity | crew/tool stores, scheduling | utilization, conflict, bottleneck |
| marketing | marketing‑intel | channel CAC vs LTV |
| margins | accounting, QBO | true job costing, margin alerts |

Much of the resolver already lives in `business-digital-twin` / `financial-intelligence`
/ `ai-operations-center`. **Action: expose one grounded‑context function; stop scattering reads.**

---

## 4. Memory system

| Tier | Purpose | Store | Status |
|---|---|---|---|
| Short‑term | in‑session conversation | runtime context | [BUILT] |
| Long‑term vector | semantic recall | `vector-memory` | [PARTIAL] (underfed) |
| Structured business | facts/relationships | Supabase/PG + `knowledge-graph` | [BUILT] |
| Outcome learning | what worked/failed | `outcome-learning-store`, scorecards | [BUILT] |
| Agent memory | per‑agent track record/tuning | agent‑registry, calibration | [BUILT] |
| Audit memory | immutable decision trail | hash‑chained ledger | [BUILT] |

**[GAP]: memory hygiene** — write policies (what gets embedded, dedupe, TTL/retention
from the privacy module) and a single retrieval entrypoint.

---

## 5. RAG / retrieval

**Hybrid** (BM25 + vector + recency + light rerank) over a governed corpus. Store exists;
**indexed content is the [GAP].**

| Corpus | Index unit | Priority |
|---|---|---|
| price book / rate card | service + rate + modifiers | **P0** |
| won/lost quotes | quote + outcome + reason | **P0** |
| prior estimates | estimate + final + variance | P0 |
| SOPs | chunked procedures | P1 |
| job photos | vision **captions** (not pixels) | P1 |
| reviews | review + sentiment | P1 |
| customer history | per‑customer rollup | P1 |
| service / marketing pages | page/campaign + performance | P2 |
| governance decisions | case + verdict + reason | P2 |

Rules: results carry **citations**; agents must ground claims; an **un‑grounded price/margin
claim is a governance block**. **Retrieval is always preferred over fine‑tuning** for AAA facts.

---

## 6. Tool‑using agent runtime

`agent-os` already provides this (governed prompts, model routing, decision logging, RBAC
runtime gateway). Contract:

```
plan → per step: choose tool (schema-validated) → execute → observe → reflect
       risky action?  → governance: content-safety + human approval + audit
       low confidence? → escalate to specialist or frontier model
       done → record decision + outcome → eval picks it up
```

- Tools = typed, RBAC‑gated functions; **AI recommends, humans commit** [BUILT].
- Specialists via delegate / agent‑council [BUILT].
- Every action logged; risky actions fail‑closed; outcomes feed scorecards [BUILT].
- **Hard rule:** no autonomous customer send, price finalization, or accounting mutation.

---

## 7. Evaluation system *(the most important [GAP])*

`agent-evaluation-lab` exists; it needs a **golden set with human references.**

| Benchmark | Metric | Method |
|---|---|---|
| Estimate accuracy | MAPE est vs final $ | backtest closed jobs |
| Close‑rate lift | win‑rate with/without AI | A/B over leads |
| Follow‑up quality | 1–5 rubric, reply‑rate | graded + live |
| Review‑request quality | response‑rate, rating | live |
| Message safety | % unsafe caught / false‑block | adversarial set |
| Margin protection | % below‑floor quotes blocked | rule check |
| Hallucination resistance | groundedness / unsupported rate | grounded eval |
| Tool‑call correctness | valid‑schema + right‑tool | trace replay |
| Routing accuracy | optimal‑tier rate | labeled router decisions |

**Release gate:** a prompt/model version ships only if it **beats the active version on the
golden set.** The mechanism (prompt registry + canary) is [BUILT]; the **scoreboard is the [GAP].**

---

## 8. Safety & governance — **[BUILT], your strongest layer**

- Fail‑closed customer messaging → content‑safety → assisted‑draft queue → human approve
- Human approval for risky actions (runtime gateway, owner‑only override)
- Immutable audit ledger (FNV + SHA‑256 chain + HMAC signatures + server re‑verify + daily sweep)
- Prompt registry (versioned, staging→prod canary, rollback) · Model registry + provenance
- Content‑safety classifier · Override **with mandatory justification** · Supervisor review queue
- **Only safety [GAP]: eval‑driven release gating** — don't promote a regressing prompt (wire §7 into the registry's approve step).

---

## 9. Data pipeline

```
website/Telegram/SMS/call/photos/QBO/GBP/reviews
   → adapters → sensing-ingress → PII VAULT (encrypt) → redaction gate
        ├─ PII-free → event-bus (hash-chained) → STRUCTURED → embeddings → VECTOR
        └─ PII (vaulted, consented)            → OUTCOME capture → EVAL feature store
```

**Non‑negotiable:** redaction/consent happens **before** any model/prompt/log/embedding/eval.
Privacy module (vault/retention/erasure) is the chokepoint [BUILT].
**[GAP] adapters:** phone‑call transcription, Google Business Profile, ads.

---

## 10. Training / fine‑tuning decision ladder

Climb only as far as evals force you:

1. **Prompt engineering** — default [BUILT via registry]
2. **Retrieval** — all AAA‑specific facts; preferred over training
3. **Embeddings tuning** — chunking/hybrid weights before touching a model
4. **Eval‑driven prompt updates** — the main loop (golden set → registry → canary)
5. **Synthetic data** — only to grow the eval set / stress safety
6. **SFT (LoRA, small open model)** **[FUTURE]** — only if evals show a persistent gap; **de‑identified, consented, aggregated data — never raw PII**
7. **Preference tuning (DPO)** **[FUTURE]** — needs graded‑pair volume you won't have soon

**Privacy gate on any FT:** documented consent, redaction, retention, erasure path **first.**
**Default recommendation: no fine‑tuning this year.**

---

## 11. Deployment architecture

| Component | Choice | Status |
|---|---|---|
| API gateway | Netlify/Supabase functions (server‑side keys) | [BUILT] |
| Model router | `AAA_MODEL_ROUTER` + provenance | [BUILT] |
| Inference providers | Anthropic/OpenAI/Google + Nemotron + private GPU + local | [PARTIAL] |
| Vector DB | pgvector (Supabase) or local | [PARTIAL] |
| Postgres/Supabase | structured + governance_store + RLS | [BUILT] |
| Job queue | durable queue (cron + transport queue today) | **[GAP]** |
| Event bus | hash‑chained `AAA_EVENT_BUS` | [BUILT] |
| Observability | provenance + reliability‑center + ledger audit | [BUILT] |
| Rate limits / cost caps | per‑task budgets + daily cap | **[GAP]** (enforce) |
| Fallback models | router fallback chain | [BUILT] |

---

## 12. Cost tiers (~20–60 AI tasks/day)

| Tier | Runs | $/task | Monthly |
|---|---|---|---|
| T0 Local | embeddings, safety, lights‑on fallback | ~$0 | hardware |
| T1 Cheap API | drafts, extraction, routing, marketing | $0.001–0.02 | $20–150 |
| T2 Frontier | estimates, vision scope, owner copilot | $0.03–0.30 | $80–500 |
| Embeddings | one‑time + deltas | — | $10–50 |
| **Total realistic** | governed mix, cheap‑first | — | **~$150–700/mo** |

Controls: cheap‑first + confidence escalation, hard daily cap, per‑task token budget, cache.

---

## 13. Roadmap

- **MVP (30 days):** golden eval set (50–100 graded real tasks); retrieval over price book +
  won/lost quotes + SOPs; one grounded **estimate‑assist** behind governance/canary;
  fail‑closed messaging verified E2E; cost caps on; provenance dashboards. *DoD: one task
  measurably better than baseline, fully audited.*
- **90 days:** RAG over customer history + reviews + photo captions; close‑rate A/B on
  follow‑ups; eval‑gated prompt releases; phone transcription + GBP ingestion; reliability dashboards.
- **6 months:** Business Brain context API; margin‑protection guardrail in quote path;
  marketing CAC↔LTV loop; adversarial safety set; **[FUTURE]** consider one narrow LoRA only if evals demand.
- **12 months:** owner copilot over whole business; predictive scheduling/capacity; full
  outcome‑learning loop (still human‑approved); multi‑device governance at scale.

---

## 14. Risks

1. **Over‑engineering** (top) — freeze new subsystems; consolidate.
2. **No eval scoreboard** — golden set is task #1.
3. **Thin/dirty data** — outcome‑labeling discipline.
4. **PII leakage** into prompts/logs/embeddings/training — redaction chokepoint enforced + tested.
5. **Cost runaway** — cheap‑first + hard caps.
6. **Margin erosion** from un‑grounded prices — grounded + margin‑floor block.
7. **Adoption** — one‑tap flows; AI drafts, human sends.
8. **Duplicate/competing subsystems** post‑merge — architecture ownership + naming discipline.

---

## 15. First 10 engineering tasks (sequenced)

1. **Golden eval set** — 50–100 anonymized real tasks with human references; into `agent-evaluation-lab`.
2. **Outcome labeling spine** — every lead/quote/job writes clean won/lost/$ to `outcome-learning-store`.
3. **Retrieval spine v1** — embed price book + won/lost quotes + SOPs; one `retrieve()` with citations.
4. **Model routing matrix in code** — finalize tiers + fallback + **per‑task token budget + daily cap**; provenance.
5. **Fail‑closed messaging E2E test** — adversarial text → content‑safety → assisted‑draft → human approve.
6. **PII redaction gate** on `sensing-ingress` before any model/prompt/log/embedding.
7. **RAG eval** — hit‑rate + groundedness + hallucination metric.
8. **Estimate‑assist v1** — grounded prompt graded vs golden set; ship behind canary.
9. **Eval‑gated release** — wire scoreboard into prompt‑registry approve/activate.
10. **Observability** — per‑call latency/$/outcome traces → reliability‑center; daily ledger audit alerting.

---

## 16. Definition of Done — measurable

"GPT‑level for AAA" holds when, on AAA's golden set + live metrics:

- estimate MAPE ≤ target (e.g. ≤10–15%), beating unaided baseline;
- close‑rate lifts a statistically‑real margin on AI‑drafted follow‑ups (A/B);
- message safety ≥99% unsafe caught, low false‑block, **zero** un‑approved sends;
- groundedness ≥ target on price/margin claims; un‑grounded claims blocked;
- tool‑call correctness + routing accuracy above thresholds;
- 100% below‑floor quotes flagged before send;
- every customer/money decision auditable (ledger verifies) and reversible (rollback);
- cost within envelope; cheap models handle the majority of calls;
- a senior AAA estimator agrees median output is "as good as or better than mine, faster."

---

# 17. Governed Web Search (addendum)

The system can search the web **safely** and use current information when needed — as a
**governed tool with zero new autonomy.**

### 17.0 Two honest notes
- Not a web crawler: a **server‑side tool** (`/api/web-search`) calling a provider API
  (Tavily / Brave Search API / Serper, or Perplexity for pre‑synthesized cited answers);
  keys stay server‑side like the existing proxies.
- **Rule #0 — dominant risk is prompt injection.** Web pages are untrusted attacker‑controlled
  input. **Web content is DATA, never INSTRUCTIONS** — it can never trigger a tool call,
  change a price, or send a message. It inherits the fail‑closed "AI recommends, human commits" rule.

### 17.1 `web_search` tool **[GAP]** (plugs into [BUILT] gateway/provenance/ledger/queue)
```
web_search(query, { reason, freshness?, domains?, maxResults=5, read=false })
  → provider SERP → [optional] compliant fetch/read (robots.txt + ToS + size cap → extract → summarize)
  → normalize → rank → cite → { results[], synthesis?, citations[], searchId }
```
Capabilities: market/competitor/local‑SEO research, GBP/regulation/compliance guidance
(prefer official sources), product/vendor & current pricing/trends, code/library/API docs.

### 17.2 When agents MUST search
A cheap freshness classifier forces search when info may be **outdated**, **current facts**
are needed, **local competitors** are analyzed, **product pricing** may have changed,
**legal/compliance** or **GBP policy** is involved, **API docs** may have changed, or
**marketing/SEO** depends on current results. It must **not** search for stable internal
facts (AAA's own prices/history → use retrieval §5). Results cached with **topic TTL**.

### 17.3 Source schema (every result)
```
{ title, url, sourceDomain, publishDate|null, fetchedAt, summary,
  sourceType: official|vendor|news|forum|blog|ad|unknown, isSponsored,
  factVsOpinion: fact|opinion|mixed,
  relevanceScore, authorityScore, recencyScore, confidence }   // all 0..1
```

### 17.4 Ranker + citation
Rank = `relevance × authority × recency × cross‑source‑agreement`; official up‑weighted,
sponsored/stale flagged. `confidence` rises only with **≥2 agreeing sources**.
**Any web‑derived claim that is un‑cited or single‑source is a governance BLOCK.**

### 17.5 Safety rules
Untrusted‑content quarantine (Rule #0) · multi‑source corroboration · prefer official ·
flag outdated · detect & down‑rank ads/sponsored · separate fact/opinion · respect
robots.txt + ToS (no prohibited scraping, skip paywalls) · **summarize, never copy long
verbatim** (copyright) · content‑safety on any customer‑facing output.

### 17.6 Pipeline
```
Request → Intent+Freshness classifier [GAP] → (no → answer from memory/RAG [BUILT])
   → web_search (gateway-gated) → provider SERP → compliant fetch/read [GAP]
   → Source Ranker [GAP] → Citation Builder [GAP] → LLM reasoning (grounded, untrusted-data) [BUILT]
   → Final answer WITH sources → risky use? → Human Approval (assisted-draft queue) [BUILT]
   → Audit Log (immutable ledger) [BUILT] → Eval (search metrics)
```

### 17.7 AAA use cases
Houston competitor analysis · service‑area keyword research · Google Ads trend research ·
local‑SEO content planning · flooring material pricing · QuickBooks/API docs · GBP policy
lookup · vendor comparison · customer‑FAQ updates · market‑opportunity research. Each is a
**recommendation to a human**, never an auto‑action.

### 17.8 Governance log (→ immutable ledger), PII‑screened first
```
{ searchId, agentId, query, reason, freshness,
  sourcesReturned:[{url,domain,confidence}], sourcesUsed:[url],
  finalRecommendation, provider, costUsd, latencyMs, fetchedAt }
```
**No customer PII in queries sent to third‑party providers** (privacy gate on query/reason).

### 17.9 Human approval (fail‑closed) before web output is used to
change **prices** · publish **website content** · send **customer‑facing claims** ·
change **ads budget** · make **legal/compliance** decisions — each routes to the existing
assisted‑draft/approval queue with cited sources attached. Low‑risk research returns to the
agent directly, still cited + logged.

### 17.10 Cost & rate controls
Per‑day query cap · cache (topic TTL) · read top‑N only · cheap model to summarize, frontier
to synthesize · cost in the search log. Envelope ~**$10–60/mo**.

### 17.11 Risks
Prompt injection (top) → Rule #0 · over‑trusted single source → ≥2‑source + citation block ·
PII in third‑party queries → privacy gate · copyright/ToS/robots → compliant fetch + summarize ·
cost runaway → caps + cache · stale cache → topic TTL + recency flags · SEO advice on spam/ads → ad detection + approval.

### 17.12 Definition of Done (web‑capable)
Decides when search is needed (freshness accuracy ≥ target) · searches **compliantly**
(robots/ToS, no PII in queries) · ranks sources · **cites every web‑derived claim** (un‑cited ≈ 0) ·
shows multi‑source corroboration for price/competitor/compliance · logs every search to the
verifiable ledger · escalates every risky use to human approval (**zero** web‑driven auto‑actions) ·
**passes an injection adversarial test** (no tool call/state change triggered by page text).

### 17.13 First web‑search tasks (sequenced)
1. Provider + `/api/web-search` function (server‑side key) → normalize to §17.3.
2. Compliant fetch/read (robots + ToS + size cap + extractive summary; block long verbatim).
3. `web_search` tool registration in `agent-os`, RBAC‑gated; provenance + ledger event.
4. Freshness classifier + topic‑TTL cache.
5. Ranker + citation builder (**block un‑cited claims**).
6. **Injection adversarial test** — prove Rule #0 holds *(the gate that makes it shippable)*.
7. PII query gate (screen query/reason before provider + logging).
8. Human‑approval wiring (price/website/customer/ads/legal → assisted‑draft with sources).
9. Search eval metrics → `agent-evaluation-lab`.
10. Cost caps + dashboard → reliability‑center.

**Build‑first for web search:** tasks **1–3 + 6** = the minimum viable governed web tool that
returns cited, schema‑normalized results and **provably can't be hijacked or auto‑act.**

---

*End of design of record. No runtime code is implied by this document; each [GAP]/[FUTURE]
item requires its own approved implementation slice.*
