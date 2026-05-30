# AAA HyperKernel — Backend Setup (Supabase shared memory + AI proxy)

The app runs fully **local-first with no setup**. Adding Supabase turns on
**shared memory** (one source of truth across the field app, office OS, and AI
agents) and the **server-side Claude proxy** (so the API key never lives in the
browser). Nothing here is required for the field app to work.

## 1. Create the database
1. Create a Supabase project → copy the **Project URL** and the **anon/public key**.
2. SQL editor → paste `supabase/schema.sql` → run. This creates all tables
   (customers, jobs, estimates, photos, outcomes, reviews, agent_logs,
   agent_decisions, kpi_snapshots, ai_costs) with Row-Level Security.
3. Create one workspace and note its id:
   ```sql
   insert into public.workspaces (name) values ('AAA Carpet') returning id;
   ```
   (After you add Supabase Auth, add yourself: `insert into public.workspace_members (workspace_id, user_id, role) values ('<ws-id>', '<your-auth-uid>', 'owner');`)

## 2. Deploy the Claude proxy
```bash
supabase functions deploy claude-proxy --no-verify-jwt
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically and
are used only for server-side cost logging into `ai_costs`.

## 3. Point the app at it
The app reads config from `window.AAA_ENV` (build-injected) **or** from
`localStorage["aaa:config"]`. No keys go in source. Two options:

**A. Quick (from the browser console on the deployed site):**
```js
AAA_CONFIG.set({
  supabaseUrl: 'https://YOURPROJECT.supabase.co',
  supabaseAnonKey: 'eyJ...anon...',
  workspaceId: '<ws-id from step 1>'
});
location.reload();
```

**B. Build-injected (recommended for production):** add a small inline script
before the app scripts in `index.html`:
```html
<script>window.AAA_ENV = { supabaseUrl: '...', supabaseAnonKey: '...', workspaceId: '...' };</script>
```
(Anon key + RLS is safe in the client; the service-role key is **never** used in the browser.)

## 4. Verify
```js
AAA_CONFIG.all();              // { supabaseConfigured: true, ... }
await AAA_DATA.mirrorToCloud(); // { ok:true, customers, jobs, estimates }
```
Once configured, the existing sync engine mirrors local jobs/customers/estimates
to Supabase automatically on its normal cycle.

## Security notes
- The **anon key** is public-safe **only because RLS is on**. Do not disable RLS.
- Browser clients should sign in via **Supabase Auth** and be a `workspace_members`
  row; until auth is wired, treat the deployment as single-tenant/owner-only.
- All model calls go through `claude-proxy` (server-side key). Never put
  `ANTHROPIC_API_KEY` in the browser.
- `ANTHROPIC_API_KEY` for the field **Vision** function still lives in Netlify
  env (`/api/vision`); the Supabase proxy is for the agent/office AI.
