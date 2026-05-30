-- ============================================================================
-- AAA HyperKernel — Supabase schema (shared memory for the whole app)
--
-- One workspace per business. Every agent and every screen reads/writes the
-- same tables, so the field app and office OS share one source of truth.
--
-- Apply:  supabase db push   (or paste into the Supabase SQL editor)
-- Auth:   RLS is ON. Rows are scoped to a workspace; only members of that
--         workspace can read/write. The claude-proxy edge function uses the
--         service-role key (bypasses RLS) for server-side agent logging.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---- workspaces & membership ----------------------------------------------
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'office' check (role in ('owner','office','tech')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- helper: is the current user a member of a workspace?
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

-- ---- core business entities ------------------------------------------------
create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  address       text,
  phone         text,
  email         text,
  gate_code     text,
  source        text,                 -- e.g. 'google_ads', 'referral'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  current_state text not null default 'QUOTE_OPEN'
                check (current_state in ('QUOTE_OPEN','SCHEDULED','IN_PROGRESS','CLOSED')),
  service_address text,
  scheduled_date  timestamptz,
  notes         text,
  latitude      double precision,
  longitude     double precision,
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.estimates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete cascade,
  type          text,
  severity      text check (severity in ('LOW','MEDIUM','HIGH')),
  confidence    int,
  est_time_mins int,
  quote_range   text,
  materials     jsonb default '[]'::jsonb,
  source        text default 'AI' check (source in ('AI','MANUAL')),
  created_at    timestamptz not null default now()
);

create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete cascade,
  storage_path  text,                 -- path in a Supabase Storage bucket
  tag           text,                 -- 'BEFORE' | 'AFTER' | ...
  created_at    timestamptz not null default now()
);

create table if not exists public.outcomes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete cascade,
  result        text not null check (result in ('won','lost','callback','review')),
  final_amount  numeric,
  notes         text,
  recorded_at   timestamptz not null default now()
);

create table if not exists public.reviews (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete cascade,
  rating        int check (rating between 1 and 5),
  channel       text,                 -- 'google' | 'sms' | ...
  text          text,
  created_at    timestamptz not null default now()
);

-- ---- AI operating-system memory -------------------------------------------
create table if not exists public.agent_logs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent         text not null,        -- 'sales','operations','supervisor',...
  level         text not null default 'info',
  message       text,
  context       jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.agent_decisions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent         text not null,
  job_id        uuid references public.jobs(id) on delete set null,
  decision      text not null,
  rationale     text,
  confidence    int,
  inputs        jsonb default '{}'::jsonb,
  outcome_id    uuid references public.outcomes(id) on delete set null, -- linked once known
  score         numeric,              -- supervisor accuracy score, filled later
  created_at    timestamptz not null default now()
);

create table if not exists public.kpi_snapshots (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  period        text not null,        -- 'day' | 'week' | 'month'
  metrics       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.ai_costs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete cascade,
  agent         text,
  model         text,
  input_tokens  int,
  output_tokens int,
  usd           numeric,
  created_at    timestamptz not null default now()
);

-- ---- indexes ---------------------------------------------------------------
create index if not exists idx_customers_ws on public.customers(workspace_id);
create index if not exists idx_jobs_ws_state on public.jobs(workspace_id, current_state);
create index if not exists idx_estimates_job on public.estimates(job_id);
create index if not exists idx_photos_job on public.photos(job_id);
create index if not exists idx_outcomes_job on public.outcomes(job_id);
create index if not exists idx_reviews_job on public.reviews(job_id);
create index if not exists idx_agent_decisions_ws on public.agent_decisions(workspace_id, agent);
create index if not exists idx_agent_logs_ws on public.agent_logs(workspace_id, created_at desc);

-- ---- external (client) ids for offline-first upsert ------------------------
-- The local-first clients mint string ids offline; we upsert cloud rows on
-- (workspace_id, client_id) so a record syncs to exactly one row, idempotently.
do $$
declare t text;
begin
  foreach t in array array['customers','jobs','estimates','outcomes','reviews','agent_logs','agent_decisions'] loop
    execute format('alter table public.%I add column if not exists client_id text;', t);
    execute format('create unique index if not exists uq_%1$s_client on public.%1$I(workspace_id, client_id);', t, t);
  end loop;
end $$;

-- ---- updated_at triggers ---------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_jobs_touch on public.jobs;
create trigger trg_jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ---- Row-Level Security ----------------------------------------------------
-- Every table is workspace-scoped. Enable RLS and allow only workspace members.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','jobs','estimates','photos','outcomes','reviews',
    'agent_logs','agent_decisions','kpi_snapshots','ai_costs'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($p$
      drop policy if exists ws_rw on public.%1$I;
      create policy ws_rw on public.%1$I
        using (public.is_member(workspace_id))
        with check (public.is_member(workspace_id));
    $p$, t);
  end loop;
end $$;

alter table public.workspaces enable row level security;
drop policy if exists ws_self on public.workspaces;
create policy ws_self on public.workspaces
  using (public.is_member(id)) with check (true);

alter table public.workspace_members enable row level security;
drop policy if exists wm_self on public.workspace_members;
create policy wm_self on public.workspace_members
  using (user_id = auth.uid() or public.is_member(workspace_id));

-- NOTE: server-side agents write via the claude-proxy edge function using the
-- service-role key, which bypasses RLS. Browser clients must be signed in
-- (Supabase Auth) and a member of the workspace. See SETUP.md.
