-- Lead OS Phase 1D — Agent Integration Persistence
-- Safe to run multiple times. Designed for SQLite-backed MVP deployments.

create table if not exists agent_credentials (
    key_hash text primary key,
    agent_id text not null,
    agent_type text not null,
    display_name text not null,
    scopes_json text not null,
    status text not null,
    metadata_json text not null default '{}',
    created_at text not null default (datetime('now'))
);

create table if not exists agent_actions (
    id text primary key,
    request_id text not null,
    agent_id text not null,
    agent_type text not null,
    action_type text not null,
    target_type text not null,
    target_id text,
    input_summary text not null,
    output_summary text,
    confidence_score real,
    risk_score real,
    business_impact_estimate text,
    approval_status text not null,
    policy_flags_json text not null default '[]',
    error_code text,
    created_at text not null
);

create table if not exists supervisor_queue (
    id text primary key,
    agent_action_id text not null,
    priority text not null,
    reason text not null,
    target_type text not null,
    target_id text,
    recommended_decision text,
    status text not null,
    created_at text not null,
    resolved_at text,
    foreign key(agent_action_id) references agent_actions(id)
);

create table if not exists outcomes (
    id text primary key,
    outcome_type text not null,
    customer_id text,
    lead_id text,
    estimate_id text,
    job_id text,
    revenue_cents integer,
    margin_cents integer,
    review_score integer,
    complaint_flag integer not null default 0,
    callback_flag integer not null default 0,
    source_event_id text,
    created_at text not null
);

create table if not exists agent_action_outcomes (
    agent_action_id text not null,
    outcome_id text not null,
    influence_type text not null,
    weight real not null default 1.0,
    primary key (agent_action_id, outcome_id),
    foreign key(agent_action_id) references agent_actions(id),
    foreign key(outcome_id) references outcomes(id)
);

create index if not exists idx_agent_actions_agent_id on agent_actions(agent_id);
create index if not exists idx_agent_actions_target on agent_actions(target_type, target_id);
create index if not exists idx_supervisor_queue_status on supervisor_queue(status, priority);
create index if not exists idx_outcomes_lead on outcomes(lead_id);
create index if not exists idx_outcomes_job on outcomes(job_id);
