"""Lead OS Phase 1D agent integration package.

This package is intentionally framework-light so it can be mounted into the
Hermes/FastAPI Lead OS service without forcing a specific web stack.
"""

from .agent_auth import (
    AgentCredentialStore,
    AgentIdentity,
    ScopeDeniedError,
    default_agent_identities,
)
from .outcomes import OutcomeRegistry, OutcomeType, build_scorecards
from .supervisor import AgentAction, ApprovalStatus, SupervisorLedger, requires_approval

__all__ = [
    "AgentAction",
    "AgentCredentialStore",
    "AgentIdentity",
    "ApprovalStatus",
    "OutcomeRegistry",
    "OutcomeType",
    "ScopeDeniedError",
    "SupervisorLedger",
    "build_scorecards",
    "default_agent_identities",
    "requires_approval",
]
