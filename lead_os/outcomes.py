"""Outcome registry and scorecards for Lead OS Phase 1D."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from .supervisor import AgentAction, ApprovalStatus


class _StringEnum(str, Enum):
    """Portable string enum for Python 3.10+ compatibility."""


class OutcomeType(_StringEnum):
    LEAD_WON = "LEAD_WON"
    LEAD_LOST = "LEAD_LOST"
    JOB_COMPLETED = "JOB_COMPLETED"
    REVENUE_RECORDED = "REVENUE_RECORDED"
    MARGIN_RECORDED = "MARGIN_RECORDED"
    REVIEW_RECEIVED = "REVIEW_RECEIVED"
    CUSTOMER_COMPLAINT = "CUSTOMER_COMPLAINT"
    REFUND_OR_CALLBACK = "REFUND_OR_CALLBACK"
    AD_CONVERSION = "AD_CONVERSION"


@dataclass(frozen=True)
class Outcome:
    id: str
    outcome_type: OutcomeType
    customer_id: str | None = None
    lead_id: str | None = None
    estimate_id: str | None = None
    job_id: str | None = None
    revenue_cents: int | None = None
    margin_cents: int | None = None
    review_score: int | None = None
    complaint_flag: bool = False
    callback_flag: bool = False
    source_event_id: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass(frozen=True)
class AgentActionOutcomeLink:
    agent_action_id: str
    outcome_id: str
    influence_type: str
    weight: float = 1.0


@dataclass(frozen=True)
class AgentScorecard:
    agent_id: str
    actions_attempted: int
    actions_completed: int
    blocked_actions: int
    approval_rate: float
    human_override_rate: float
    revenue_influenced_cents: int
    margin_influenced_cents: int
    wins_influenced: int
    losses_influenced: int
    average_confidence: float | None
    average_risk: float | None
    review_requests_sent: int
    reviews_received: int
    complaints_linked: int
    callbacks_linked: int


class OutcomeRegistry:
    """Append-only outcome registry with weighted action attribution."""

    def __init__(self) -> None:
        self._outcomes: list[Outcome] = []
        self._links: list[AgentActionOutcomeLink] = []

    @property
    def outcomes(self) -> tuple[Outcome, ...]:
        return tuple(self._outcomes)

    @property
    def links(self) -> tuple[AgentActionOutcomeLink, ...]:
        return tuple(self._links)

    def record_outcome(
        self,
        *,
        outcome_type: OutcomeType,
        customer_id: str | None = None,
        lead_id: str | None = None,
        estimate_id: str | None = None,
        job_id: str | None = None,
        revenue_cents: int | None = None,
        margin_cents: int | None = None,
        review_score: int | None = None,
        complaint_flag: bool = False,
        callback_flag: bool = False,
        source_event_id: str | None = None,
    ) -> Outcome:
        if revenue_cents is not None and revenue_cents < 0:
            raise ValueError("revenue_cents cannot be negative")
        if margin_cents is not None and margin_cents < 0:
            raise ValueError("margin_cents cannot be negative")
        if review_score is not None and not 1 <= review_score <= 5:
            raise ValueError("review_score must be between 1 and 5")

        outcome = Outcome(
            id=f"out_{uuid4().hex}",
            outcome_type=outcome_type,
            customer_id=customer_id,
            lead_id=lead_id,
            estimate_id=estimate_id,
            job_id=job_id,
            revenue_cents=revenue_cents,
            margin_cents=margin_cents,
            review_score=review_score,
            complaint_flag=complaint_flag,
            callback_flag=callback_flag,
            source_event_id=source_event_id,
        )
        self._outcomes.append(outcome)
        return outcome

    def link_action(
        self,
        *,
        agent_action_id: str,
        outcome_id: str,
        influence_type: str,
        weight: float = 1.0,
    ) -> AgentActionOutcomeLink:
        if weight <= 0:
            raise ValueError("weight must be positive")
        if not any(outcome.id == outcome_id for outcome in self._outcomes):
            raise ValueError(f"unknown outcome_id {outcome_id!r}")
        link = AgentActionOutcomeLink(
            agent_action_id=agent_action_id,
            outcome_id=outcome_id,
            influence_type=influence_type,
            weight=weight,
        )
        self._links.append(link)
        return link


def build_scorecards(actions: tuple[AgentAction, ...], registry: OutcomeRegistry) -> dict[str, AgentScorecard]:
    """Build scorecards from agent actions and linked outcomes."""

    actions_by_agent: dict[str, list[AgentAction]] = defaultdict(list)
    actions_by_id = {action.id: action for action in actions}
    outcomes_by_id = {outcome.id: outcome for outcome in registry.outcomes}
    linked_outcomes_by_agent: dict[str, list[tuple[Outcome, float]]] = defaultdict(list)

    for action in actions:
        actions_by_agent[action.agent_id].append(action)

    for link in registry.links:
        action = actions_by_id.get(link.agent_action_id)
        outcome = outcomes_by_id.get(link.outcome_id)
        if action is None or outcome is None:
            continue
        linked_outcomes_by_agent[action.agent_id].append((outcome, link.weight))

    scorecards: dict[str, AgentScorecard] = {}
    for agent_id, agent_actions in actions_by_agent.items():
        completed = [a for a in agent_actions if a.error_code is None and a.approval_status != ApprovalStatus.BLOCKED]
        blocked = [a for a in agent_actions if a.approval_status == ApprovalStatus.BLOCKED or a.error_code]
        approved_or_not_required = [
            a for a in agent_actions if a.approval_status in {ApprovalStatus.APPROVED, ApprovalStatus.NOT_REQUIRED}
        ]
        pending_or_rejected = [
            a for a in agent_actions if a.approval_status in {ApprovalStatus.PENDING_APPROVAL, ApprovalStatus.REJECTED}
        ]
        confidence_values = [a.confidence_score for a in agent_actions if a.confidence_score is not None]
        risk_values = [a.risk_score for a in agent_actions if a.risk_score is not None]
        linked = linked_outcomes_by_agent.get(agent_id, [])

        scorecards[agent_id] = AgentScorecard(
            agent_id=agent_id,
            actions_attempted=len(agent_actions),
            actions_completed=len(completed),
            blocked_actions=len(blocked),
            approval_rate=_safe_ratio(len(approved_or_not_required), len(agent_actions)),
            human_override_rate=_safe_ratio(len(pending_or_rejected), len(agent_actions)),
            revenue_influenced_cents=sum(_weighted_int(o.revenue_cents, w) for o, w in linked),
            margin_influenced_cents=sum(_weighted_int(o.margin_cents, w) for o, w in linked),
            wins_influenced=sum(1 for o, _ in linked if o.outcome_type == OutcomeType.LEAD_WON),
            losses_influenced=sum(1 for o, _ in linked if o.outcome_type == OutcomeType.LEAD_LOST),
            average_confidence=_average(confidence_values),
            average_risk=_average(risk_values),
            review_requests_sent=sum(1 for a in agent_actions if a.action_type == "request_review"),
            reviews_received=sum(1 for o, _ in linked if o.outcome_type == OutcomeType.REVIEW_RECEIVED),
            complaints_linked=sum(1 for o, _ in linked if o.complaint_flag or o.outcome_type == OutcomeType.CUSTOMER_COMPLAINT),
            callbacks_linked=sum(1 for o, _ in linked if o.callback_flag or o.outcome_type == OutcomeType.REFUND_OR_CALLBACK),
        )

    return scorecards


def _safe_ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


def _average(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _weighted_int(value: int | None, weight: float) -> int:
    if value is None:
        return 0
    return int(value * weight)
