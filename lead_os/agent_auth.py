"""Agent authentication and scope enforcement for Lead OS Phase 1D.

The module has no FastAPI dependency on purpose. Framework adapters can call
``resolve`` and ``require_scope`` from route dependencies or middleware.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
from typing import Iterable, Mapping


class AgentAuthError(Exception):
    """Base class for agent authentication failures."""


class AgentNotFoundError(AgentAuthError):
    """Raised when an API key does not map to a known agent."""


class AgentDisabledError(AgentAuthError):
    """Raised when a known agent is not active."""


class ScopeDeniedError(AgentAuthError):
    """Raised when an agent lacks a required scope."""

    def __init__(self, agent_id: str, required_scope: str) -> None:
        super().__init__(f"Agent {agent_id!r} lacks required scope {required_scope!r}")
        self.agent_id = agent_id
        self.required_scope = required_scope


@dataclass(frozen=True)
class AgentIdentity:
    """Resolved agent identity used by API routes and supervisor logging."""

    agent_id: str
    agent_type: str
    display_name: str
    scopes: frozenset[str]
    status: str = "active"
    metadata: Mapping[str, str] = field(default_factory=dict)

    def has_scope(self, required_scope: str) -> bool:
        return required_scope in self.scopes or "*" in self.scopes

    def require_scope(self, required_scope: str) -> None:
        if not self.has_scope(required_scope):
            raise ScopeDeniedError(self.agent_id, required_scope)


@dataclass(frozen=True)
class AgentCredential:
    """Stored credential record.

    ``key_hash`` is a SHA-256 hex digest in this first implementation. A
    deployment with stronger password hashing can keep this interface and swap
    the backing implementation later.
    """

    key_hash: str
    identity: AgentIdentity


class AgentCredentialStore:
    """In-memory credential registry with hashed key lookup.

    This is production-safe as a contract but intentionally storage-neutral.
    Hermes can hydrate it from SQLite/Postgres/secrets storage at process start,
    or replace the class with a DB-backed implementation using the same methods.
    """

    def __init__(self, credentials: Iterable[AgentCredential] | None = None) -> None:
        self._by_hash: dict[str, AgentIdentity] = {}
        for credential in credentials or []:
            self._by_hash[credential.key_hash] = credential.identity

    @staticmethod
    def hash_key(raw_key: str) -> str:
        if not raw_key:
            raise ValueError("raw_key is required")
        return sha256(raw_key.encode("utf-8")).hexdigest()

    def add_plaintext_key(self, raw_key: str, identity: AgentIdentity) -> None:
        """Add a key for tests, local dev, or bootstrap scripts.

        Do not persist plaintext keys. This helper immediately hashes the key.
        """

        self._by_hash[self.hash_key(raw_key)] = identity

    def resolve(self, raw_key: str) -> AgentIdentity:
        key_hash = self.hash_key(raw_key)
        for stored_hash, identity in self._by_hash.items():
            if compare_digest(stored_hash, key_hash):
                if identity.status != "active":
                    raise AgentDisabledError(f"Agent {identity.agent_id!r} is {identity.status!r}")
                return identity
        raise AgentNotFoundError("Unknown agent API key")

    def require_scope(self, raw_key: str, required_scope: str) -> AgentIdentity:
        identity = self.resolve(raw_key)
        identity.require_scope(required_scope)
        return identity


def default_agent_identities() -> list[AgentIdentity]:
    """Return the Phase 1D default least-privilege agent identities."""

    return [
        AgentIdentity(
            agent_id="sales-agent-v1",
            agent_type="sales",
            display_name="Sales Agent",
            scopes=frozenset(
                {
                    "customers:read",
                    "customers:write_note",
                    "leads:read",
                    "tasks:read",
                    "tasks:create",
                    "tasks:update_status",
                    "estimates:read",
                    "messages:create_template_followup",
                    "messages:create_custom_draft",
                }
            ),
        ),
        AgentIdentity(
            agent_id="estimator-agent-v1",
            agent_type="estimator",
            display_name="Estimator Agent",
            scopes=frozenset(
                {
                    "customers:read",
                    "leads:read",
                    "estimates:read",
                    "estimates:create_draft",
                    "estimates:request_approval",
                    "jobs:read",
                    "tasks:create",
                }
            ),
        ),
        AgentIdentity(
            agent_id="follow-up-agent-v1",
            agent_type="follow_up",
            display_name="Follow-Up Agent",
            scopes=frozenset(
                {
                    "customers:read",
                    "leads:read",
                    "tasks:read",
                    "tasks:create",
                    "tasks:update_status",
                    "messages:create_template_followup",
                    "messages:create_custom_draft",
                }
            ),
        ),
        AgentIdentity(
            agent_id="review-agent-v1",
            agent_type="review",
            display_name="Review Agent",
            scopes=frozenset(
                {
                    "customers:read",
                    "jobs:read",
                    "reviews:request",
                    "reviews:draft_reply",
                    "tasks:create",
                }
            ),
        ),
        AgentIdentity(
            agent_id="accounting-agent-v1",
            agent_type="accounting",
            display_name="Accounting Agent",
            scopes=frozenset(
                {
                    "customers:read",
                    "jobs:read",
                    "estimates:read",
                    "accounting:read",
                    "accounting:sync_suggestion",
                }
            ),
        ),
        AgentIdentity(
            agent_id="supervisor-agent-v1",
            agent_type="supervisor",
            display_name="Supervisor Agent",
            scopes=frozenset(
                {
                    "supervisor:read_queue",
                    "supervisor:approve_action",
                    "supervisor:reject_action",
                    "customers:read",
                    "leads:read",
                    "estimates:read",
                    "jobs:read",
                    "tasks:read",
                    "accounting:read",
                }
            ),
        ),
    ]
