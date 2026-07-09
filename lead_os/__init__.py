"""Lead OS Phase 1D agent integration package.

This package is intentionally framework-light so it can be mounted into the
Hermes/FastAPI Lead OS service without forcing a specific web stack.
"""

from .agent_auth import AgentCredentialStore, AgentIdentity, ScopeDeniedError
from .supervisor import AgentAction, SupervisorLedger

__all__ = [
    "AgentAction",
    "AgentCredentialStore",
    "AgentIdentity",
    "ScopeDeniedError",
    "SupervisorLedger",
]
