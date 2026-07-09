"""Supervisor action ledger for Lead OS Phase 1D."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from .agent_auth import AgentIdentity


class _StringEnum(str, Enum):
    """Portable string enum for Python 3.10+ compatibility."""


class ApprovalStatus(_StringEnum):
    NOT_REQUIRED = "not_required"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    BLOCKED = "blocked"


class QueuePriority(_StringEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True)
class AgentAction:
    """Audit unit for an attempted or completed agent action."""

    id: str
    request_id: str
    agent_id: str
    agent_type: str
    action_type: str
    target_type: str
    target_id: str | None
    input_summary: str
    output_summary: str | None
    confidence_score: float | None
    risk_score: float | None
    business_impact_estimate: str | None
    approval_status: ApprovalStatus
    policy_flags: tuple[str, ...] = field(default_factory=tuple)
    error_code: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass(frozen=True)
class SupervisorQueueItem:
    """Projection item for human/supervisor review."""

    id: str
    agent_action_id: str
    priority: QueuePriority
    reason: str
    target_type: str
    target_id: str | None
    recommended_decision: str | None
    status: str = "open"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    resolved_at: str | None = None


class SupervisorLedger:
    """In-memory append-only supervisor ledger.

    The class is intentionally simple so it can be wrapped by SQLite/Postgres
    storage while preserving the same policy behavior.
    """

    def __init__(self) -> None:
        self._actions: list[AgentAction] = []
        self._queue: list[SupervisorQueueItem] = []

    @property
    def actions(self) -> tuple[AgentAction, ...]:
        return tuple(self._actions)

    @property
    def queue(self) -> tuple[SupervisorQueueItem, ...]:
        return tuple(self._queue)

    def record_action(
        self,
        *,
        request_id: str,
        agent: AgentIdentity,
        action_type: str,
        target_type: str,
        target_id: str | None,
        input_summary: str,
        output_summary: str | None = None,
        confidence_score: float | None = None,
        risk_score: float | None = None,
        business_impact_estimate: str | None = None,
        approval_status: ApprovalStatus = ApprovalStatus.NOT_REQUIRED,
        policy_flags: tuple[str, ...] = (),
        error_code: str | None = None,
    ) -> AgentAction:
        action = AgentAction(
            id=f"act_{uuid4().hex}",
            request_id=request_id,
            agent_id=agent.agent_id,
            agent_type=agent.agent_type,
            action_type=action_type,
            target_type=target_type,
            target_id=target_id,
            input_summary=input_summary,
            output_summary=output_summary,
            confidence_score=confidence_score,
            risk_score=risk_score,
            business_impact_estimate=business_impact_estimate,
            approval_status=approval_status,
            policy_flags=policy_flags,
            error_code=error_code,
        )
        self._actions.append(action)
        if approval_status in {ApprovalStatus.PENDING_APPROVAL, ApprovalStatus.BLOCKED}:
            self._queue.append(self._queue_item_for(action))
        return action

    def _queue_item_for(self, action: AgentAction) -> SupervisorQueueItem:
        priority = classify_priority(action)
        reason = queue_reason(action)
        recommended = "approve" if action.approval_status == ApprovalStatus.PENDING_APPROVAL else "reject"
        return SupervisorQueueItem(
            id=f"sq_{uuid4().hex}",
            agent_action_id=action.id,
            priority=priority,
            reason=reason,
            target_type=action.target_type,
            target_id=action.target_id,
            recommended_decision=recommended,
        )


def requires_approval(
    *,
    action_type: str,
    is_customer_visible: bool = False,
    uses_approved_template: bool = False,
    confidence_score: float | None = None,
    risk_score: float | None = None,
    policy_flags: tuple[str, ...] = (),
) -> ApprovalStatus:
    """Return the approval status required by Phase 1D policy."""

    hard_flags = {"legal_sensitive", "payment_dispute", "refund_promise", "warranty_promise"}
    if hard_flags.intersection(policy_flags):
        return ApprovalStatus.PENDING_APPROVAL

    if action_type in {"send_final_price", "discount_offer", "public_review_reply", "invoice_mutation"}:
        return ApprovalStatus.PENDING_APPROVAL

    if is_customer_visible and not uses_approved_template:
        return ApprovalStatus.PENDING_APPROVAL

    if confidence_score is not None and confidence_score < 0.60:
        return ApprovalStatus.PENDING_APPROVAL

    if risk_score is not None and risk_score > 0.50:
        return ApprovalStatus.PENDING_APPROVAL

    return ApprovalStatus.NOT_REQUIRED


def classify_priority(action: AgentAction) -> QueuePriority:
    flags = set(action.policy_flags)
    if "legal_sensitive" in flags or "payment_dispute" in flags:
        return QueuePriority.CRITICAL
    if action.error_code or action.approval_status == ApprovalStatus.BLOCKED:
        return QueuePriority.HIGH
    if action.risk_score is not None and action.risk_score > 0.50:
        return QueuePriority.HIGH
    if action.confidence_score is not None and action.confidence_score < 0.60:
        return QueuePriority.HIGH
    if action.action_type in {"send_final_price", "public_review_reply", "invoice_mutation"}:
        return QueuePriority.HIGH
    return QueuePriority.NORMAL


def queue_reason(action: AgentAction) -> str:
    if action.error_code:
        return f"Blocked or failed with {action.error_code}"
    if action.policy_flags:
        return "Policy flags: " + ", ".join(action.policy_flags)
    if action.risk_score is not None and action.risk_score > 0.50:
        return "High risk score requires human review"
    if action.confidence_score is not None and action.confidence_score < 0.60:
        return "Low confidence requires human review"
    if action.action_type == "send_final_price":
        return "Customer-visible final price requires approval"
    if action.action_type == "public_review_reply":
        return "Public review reply requires approval"
    if action.action_type == "invoice_mutation":
        return "Accounting mutation requires approval"
    return "Supervisor review required"
