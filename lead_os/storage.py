"""SQLite persistence for Lead OS Phase 1D.

This storage layer is deliberately small and explicit. It gives the Phase 1D
core durable tables without requiring the existing Hermes/FastAPI MVP to be
refactored before route wiring begins.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable, Optional

from .agent_auth import AgentCredential, AgentCredentialStore, AgentIdentity
from .outcomes import AgentActionOutcomeLink, Outcome, OutcomeRegistry, OutcomeType
from .supervisor import AgentAction, ApprovalStatus, QueuePriority, SupervisorQueueItem


SCHEMA_SQL = """
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
"""


class LeadOsSQLiteStore:
    """Durable SQLite store for Phase 1D core objects."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("pragma foreign_keys = on")
        self.migrate()

    def close(self) -> None:
        self._conn.close()

    def migrate(self) -> None:
        self._conn.executescript(SCHEMA_SQL)
        self._conn.commit()

    def save_credential(self, *, raw_key: str, identity: AgentIdentity) -> str:
        key_hash = AgentCredentialStore.hash_key(raw_key)
        self._conn.execute(
            """
            insert or replace into agent_credentials
            (key_hash, agent_id, agent_type, display_name, scopes_json, status, metadata_json)
            values (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                key_hash,
                identity.agent_id,
                identity.agent_type,
                identity.display_name,
                json.dumps(sorted(identity.scopes)),
                identity.status,
                json.dumps(dict(identity.metadata)),
            ),
        )
        self._conn.commit()
        return key_hash

    def load_credential_store(self) -> AgentCredentialStore:
        credentials: list[AgentCredential] = []
        rows = self._conn.execute("select * from agent_credentials").fetchall()
        for row in rows:
            identity = AgentIdentity(
                agent_id=row["agent_id"],
                agent_type=row["agent_type"],
                display_name=row["display_name"],
                scopes=frozenset(json.loads(row["scopes_json"])),
                status=row["status"],
                metadata=json.loads(row["metadata_json"]),
            )
            credentials.append(AgentCredential(key_hash=row["key_hash"], identity=identity))
        return AgentCredentialStore(credentials)

    def save_agent_action(self, action: AgentAction) -> None:
        self._conn.execute(
            """
            insert or replace into agent_actions
            (id, request_id, agent_id, agent_type, action_type, target_type, target_id,
             input_summary, output_summary, confidence_score, risk_score,
             business_impact_estimate, approval_status, policy_flags_json, error_code, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                action.id,
                action.request_id,
                action.agent_id,
                action.agent_type,
                action.action_type,
                action.target_type,
                action.target_id,
                action.input_summary,
                action.output_summary,
                action.confidence_score,
                action.risk_score,
                action.business_impact_estimate,
                action.approval_status.value,
                json.dumps(list(action.policy_flags)),
                action.error_code,
                action.created_at,
            ),
        )
        self._conn.commit()

    def save_supervisor_queue_item(self, item: SupervisorQueueItem) -> None:
        self._conn.execute(
            """
            insert or replace into supervisor_queue
            (id, agent_action_id, priority, reason, target_type, target_id,
             recommended_decision, status, created_at, resolved_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.id,
                item.agent_action_id,
                item.priority.value,
                item.reason,
                item.target_type,
                item.target_id,
                item.recommended_decision,
                item.status,
                item.created_at,
                item.resolved_at,
            ),
        )
        self._conn.commit()

    def save_supervisor_snapshot(self, actions: Iterable[AgentAction], queue: Iterable[SupervisorQueueItem]) -> None:
        for action in actions:
            self.save_agent_action(action)
        for item in queue:
            self.save_supervisor_queue_item(item)

    def load_agent_actions(self) -> tuple[AgentAction, ...]:
        rows = self._conn.execute("select * from agent_actions order by created_at, id").fetchall()
        return tuple(_action_from_row(row) for row in rows)

    def load_supervisor_queue(self, *, status: Optional[str] = None) -> tuple[SupervisorQueueItem, ...]:
        if status is None:
            rows = self._conn.execute("select * from supervisor_queue order by created_at, id").fetchall()
        else:
            rows = self._conn.execute(
                "select * from supervisor_queue where status = ? order by created_at, id",
                (status,),
            ).fetchall()
        return tuple(_queue_item_from_row(row) for row in rows)

    def save_outcome(self, outcome: Outcome) -> None:
        self._conn.execute(
            """
            insert or replace into outcomes
            (id, outcome_type, customer_id, lead_id, estimate_id, job_id, revenue_cents,
             margin_cents, review_score, complaint_flag, callback_flag, source_event_id, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                outcome.id,
                outcome.outcome_type.value,
                outcome.customer_id,
                outcome.lead_id,
                outcome.estimate_id,
                outcome.job_id,
                outcome.revenue_cents,
                outcome.margin_cents,
                outcome.review_score,
                int(outcome.complaint_flag),
                int(outcome.callback_flag),
                outcome.source_event_id,
                outcome.created_at,
            ),
        )
        self._conn.commit()

    def save_action_outcome_link(self, link: AgentActionOutcomeLink) -> None:
        self._conn.execute(
            """
            insert or replace into agent_action_outcomes
            (agent_action_id, outcome_id, influence_type, weight)
            values (?, ?, ?, ?)
            """,
            (link.agent_action_id, link.outcome_id, link.influence_type, link.weight),
        )
        self._conn.commit()

    def save_outcome_registry(self, registry: OutcomeRegistry) -> None:
        for outcome in registry.outcomes:
            self.save_outcome(outcome)
        for link in registry.links:
            self.save_action_outcome_link(link)

    def load_outcome_registry(self) -> OutcomeRegistry:
        registry = OutcomeRegistry()
        outcome_rows = self._conn.execute("select * from outcomes order by created_at, id").fetchall()
        for row in outcome_rows:
            registry._outcomes.append(_outcome_from_row(row))  # noqa: SLF001 - storage adapter hydrates registry state.
        link_rows = self._conn.execute("select * from agent_action_outcomes order by agent_action_id, outcome_id").fetchall()
        for row in link_rows:
            registry._links.append(  # noqa: SLF001 - storage adapter hydrates registry state.
                AgentActionOutcomeLink(
                    agent_action_id=row["agent_action_id"],
                    outcome_id=row["outcome_id"],
                    influence_type=row["influence_type"],
                    weight=row["weight"],
                )
            )
        return registry


def _action_from_row(row: sqlite3.Row) -> AgentAction:
    return AgentAction(
        id=row["id"],
        request_id=row["request_id"],
        agent_id=row["agent_id"],
        agent_type=row["agent_type"],
        action_type=row["action_type"],
        target_type=row["target_type"],
        target_id=row["target_id"],
        input_summary=row["input_summary"],
        output_summary=row["output_summary"],
        confidence_score=row["confidence_score"],
        risk_score=row["risk_score"],
        business_impact_estimate=row["business_impact_estimate"],
        approval_status=ApprovalStatus(row["approval_status"]),
        policy_flags=tuple(json.loads(row["policy_flags_json"])),
        error_code=row["error_code"],
        created_at=row["created_at"],
    )


def _queue_item_from_row(row: sqlite3.Row) -> SupervisorQueueItem:
    return SupervisorQueueItem(
        id=row["id"],
        agent_action_id=row["agent_action_id"],
        priority=QueuePriority(row["priority"]),
        reason=row["reason"],
        target_type=row["target_type"],
        target_id=row["target_id"],
        recommended_decision=row["recommended_decision"],
        status=row["status"],
        created_at=row["created_at"],
        resolved_at=row["resolved_at"],
    )


def _outcome_from_row(row: sqlite3.Row) -> Outcome:
    return Outcome(
        id=row["id"],
        outcome_type=OutcomeType(row["outcome_type"]),
        customer_id=row["customer_id"],
        lead_id=row["lead_id"],
        estimate_id=row["estimate_id"],
        job_id=row["job_id"],
        revenue_cents=row["revenue_cents"],
        margin_cents=row["margin_cents"],
        review_score=row["review_score"],
        complaint_flag=bool(row["complaint_flag"]),
        callback_flag=bool(row["callback_flag"]),
        source_event_id=row["source_event_id"],
        created_at=row["created_at"],
    )
