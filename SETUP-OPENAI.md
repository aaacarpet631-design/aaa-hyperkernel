# GPT-6 Astra in AAA HyperKernel

This adds **GPT-6 Astra (`gpt-6-astra`)** as an owner-selectable model for advanced reasoning and carpet photo analysis. It uses the OpenAI Responses API and keeps the app's existing decision and estimate formats.

## What selecting it changes

| Setting in Cloud Settings | Behavior |
| --- | --- |
| Advanced reasoning → GPT-6 Astra | Premium tasks such as planning, synthesis, architecture, CEO/Supervisor decisions, and callers pinned to the current Opus model use Astra through `/api/openai`. |
| Photo analysis → GPT-6 Astra | The existing `/api/vision` route uses Astra for the structured repair estimate. |
| Routine tasks | Existing Haiku/Sonnet tiers continue through their current proxy. Keep their provider configured. |

Both selectors start with Claude Opus. Selecting Astra changes the settings on this device. Existing tenant model policies run before dispatch; they can deny Astra or substitute an allowed model. No deployment region is invented for Astra. A residency policy requires a verified deployment region to be registered through the existing tenant-policy mechanism.

The connection supplies the app's existing prompts and context. It does not import a ChatGPT conversation, its memories, or its tools. Owner review of estimates and proposed actions continues through the existing app flows.

## 1. Configure the Netlify functions

Set the following in the Netlify site's environment, with **Functions** scope, then deploy this branch after review. Do not put the OpenAI key in the browser, `AAA_ENV`, localStorage, GitHub, or chat.

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | An OpenAI project key with access to `gpt-6-astra`. |
| `OPENAI_AUTH_PROVIDER` | `firebase` for the app's Firebase sign-in; this is the default. |
| `FIREBASE_PROJECT_ID` | The same Firebase project ID configured in the app. |
| `FIREBASE_WEB_API_KEY` | That project's Firebase Web API key, also shown in Firebase project settings. |
| `OPENAI_ALLOWED_USER_IDS` | Comma-separated Firebase Authentication user UIDs permitted to use Astra. Start with the owner's UID from Firebase Authentication → Users. These are UIDs, not email addresses or workspace IDs. |

The Firebase Web API key is a public project identifier. It does not grant model access. The proxy validates the signed-in user's ID token through Firebase and checks the server-side UID allowlist. Missing configuration, invalid sessions, non-allowlisted users, and authentication outages stop the request before OpenAI is called. A browser's device-role setting cannot grant server access.

For an app using **Supabase Auth**, set `OPENAI_AUTH_PROVIDER=supabase`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY` instead of the Firebase variables. Put Supabase Auth user IDs in `OPENAI_ALLOWED_USER_IDS`. The proxy verifies the bearer session through the configured project's `/auth/v1/user` endpoint. Anonymous users are denied.

Optional server settings:

| Variable | Default | Allowed values |
| --- | --- | --- |
| `OPENAI_REASONING_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |
| `OPENAI_MAX_OUTPUT_TOKENS` | `8192` | Integer from 1024 to 32768 |

The output limit includes **reasoning and visible output together**. Legacy `max_tokens` values such as 700 describe short visible answers and are not reused as the entire reasoning budget. The server budget is authoritative. Provider calls time out after 45 seconds; incomplete output is surfaced as an error and is not automatically retried with its schema removed.

This integration adds Netlify functions. It does not deploy a Firebase or Supabase OpenAI function. The existing cloud data backend can continue to be Firebase or Supabase while the app uses the Netlify AI route.

## 2. Select Astra in the app

1. Sign in to the app with an allowlisted account.
2. Open **Command Center → Cloud Settings** as the owner.
3. Under **AI models**, choose **GPT-6 Astra** for **Advanced reasoning**, **Photo analysis**, or both.
4. Tap **Save**, then **Test AI connection**. With Astra selected for advanced reasoning, the test checks Astra and parses a CEO decision. The diagnostic displays the responding model.
5. For photos, capture or upload a carpet image and inspect the estimate. Review the result before applying it or sharing a quote.

The default OpenAI endpoint is `/api/openai`. An installation serving the frontend elsewhere can set the existing runtime config's `openaiProxyUrl` to the deployed Netlify endpoint and `visionEndpoint` to its `/api/vision` URL. The API key remains on Netlify.

If only the photo selector uses Astra, the general AI connection test still checks the current chat provider. Test a photo separately.

## Errors and rollback

| Error | Action |
| --- | --- |
| `OPENAI_AUTH_NOT_CONFIGURED` | Set the identity-provider configuration and UID allowlist on Netlify, then redeploy. |
| `SIGN_IN_REQUIRED` / `INVALID_SESSION` | Sign in again with the allowlisted account. |
| `OPENAI_ACCESS_DENIED` | Check the verified user's UID against the server allowlist. |
| `MISSING_OPENAI_API_KEY` / `PROVIDER_AUTH_FAILED` | Check the server key and the OpenAI project's model access. |
| `PROVIDER_RATE_LIMITED` | Check project usage limits and retry later. |
| `PROVIDER_INCOMPLETE` | Inspect the task/output budget. No partial decision is accepted. |
| `PROVIDER_REFUSAL` | Review the request. The app does not retry it without the schema. |
| `NO_ALLOWED_MODEL_FOR_TENANT` | Review the existing tenant model policy before changing model access. |

To revert, choose **Claude Opus** in the two selectors and save. The previous provider configuration remains in place. Remove the OpenAI allowlist or key to disable the OpenAI endpoints server-side.

The existing photo engine retains its manual-entry fallback when analysis is unavailable; its fallback has unknown confidence and no quote range. A fallback is not a successful Astra analysis.

## Validation

- `node test/run-one.js unit/openai.test.js`: 62 assertions covering request/response translation, server authentication, access denial, token handling, model routing, tenant policy, photo output, and provider failures. Provider and identity calls are mocked; no paid API call is made.
- `TZ=UTC npm test`: 3642 passed, zero failed across 182 suites; intelligence smoke also passed. The existing field-mode greeting test assumes UTC; the initial run in the host timezone failed those two pre-existing assertions.
- `npm run lint`: zero errors; existing warnings remain.
- `npm run build:check`: Netlify offline build and function bundling passed.
- Live credentials were unavailable during development. Account access, latency, cost, and estimate quality require a live check after deployment and configuration.
- The repository requests a Graphify refresh, but the Graphify CLI was unavailable in the development environment. Its generated graph was not refreshed.

Official references: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [model guidance](https://developers.openai.com/api/docs/guides/latest-model), [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Firebase Auth REST](https://firebase.google.com/docs/reference/rest/auth), [Supabase session verification](https://supabase.com/docs/reference/javascript/auth-getuser).
